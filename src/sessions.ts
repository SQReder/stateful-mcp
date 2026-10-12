import { randomUUID, createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, statSync, openSync, fstatSync, readSync, closeSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, relative, parse } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chat, type WorkerConfig } from './worker.js';

const HARD_BUDGET = 32_000, WARNING_BUDGET = 24_000, OUTPUT_RESERVE = 8192;
interface Snapshot { path: string; content: string; contentHash: string; estimatedTokens: number }
interface Turn { role: 'supervisor' | 'worker'; text: string; contextRevision: number }
interface StoredError { code: string; message: string; contextRevision: number }
interface Session {
  id: string; workspaceRoot: string; objective: string; allowedPaths: string[];
  brief: string; acceptanceCriteria: string[]; contextRevision: number;
  context: Snapshot[]; turns: Turn[]; errors: StoredError[]; pending: boolean;
}
interface ContextInput { files: string[]; brief: string; acceptanceCriteria: string[] }
export class SessionError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export class SessionStore {
  private readonly db: DatabaseSync;
  private readonly root: string;
  private closed = false;
  constructor(workspaceRoot: string, private readonly config: WorkerConfig) {
    if (!isAbsolute(workspaceRoot)) throw new SessionError('configuration_error', 'Workspace path must be absolute.');
    let database: DatabaseSync | undefined;
    try {
      this.root = realpathSync(workspaceRoot);
      const statePath = join(this.root, '.stateful-worker', 'state.sqlite');
      let ancestor = parse(statePath).root;
      for (const part of relative(ancestor, statePath).split(/[\\/]/)) {
        ancestor = join(ancestor, part);
        if (lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new SessionError('invalid_path', 'Symlink storage paths are forbidden.');
      }
      mkdirSync(dirname(statePath), { recursive: true });
      this.db = database = new DatabaseSync(statePath, { timeout: 100 });
      this.db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
      for (const row of this.db.prepare("SELECT state FROM sessions WHERE json_extract(state, '$.pending') = 1").all()) {
        const state: Session = JSON.parse(String(row.state));
        state.pending = false;
        this.recordError(state, new SessionError('interrupted', 'Previous inference was interrupted; no request was replayed.'));
      }
    } catch (error: unknown) {
      database?.close();
      if (error instanceof SessionError) throw error;
      throw new SessionError('storage_unavailable', 'Could not open exclusive session storage; check paths, permissions and other MCP processes.');
    }
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
  private save(state: Session): void {
    try {
      this.db.prepare('INSERT OR REPLACE INTO sessions (id, state) VALUES (?, ?)').run(state.id, JSON.stringify(state));
    } catch {
      throw new SessionError('storage_error', 'Session persistence failed; operation stopped without replay.');
    }
  }
  private load(id: string): Session {
    const row = this.db.prepare('SELECT state FROM sessions WHERE id = ?').get(id);
    if (!row) throw new SessionError('session_not_found', 'Session not found.');
    const state: Session = JSON.parse(String(row.state));
    if (state.workspaceRoot !== this.root) throw new SessionError('workspace_mismatch', 'Session belongs to another workspace.');
    return state;
  }
  private ready(id: string): Session {
    const state = this.load(id);
    if (state.pending) throw new SessionError('session_busy', 'Session is busy with an inference.');
    return state;
  }
  private recordError(state: Session, error: SessionError): void {
    state.errors.push({ code: error.code, message: error.message, contextRevision: state.contextRevision });
    this.save(state);
  }
  private safePath(path: string, mustExist: boolean): string {
    const parts = path.split(/[\\/]/);
    if (!path || /[\0\r\n\t]/.test(path) || isAbsolute(path) || path.includes(':') || parts.some(part => !part || part === '.' || part === '..')) {
      throw new SessionError('invalid_path', 'Use a workspace-relative path without traversal, drive or UNC prefixes.');
    }
    let full = this.root;
    for (const part of parts) {
      full = join(full, part);
      const stat = lstatSync(full, { throwIfNoEntry: false });
      if (!stat) {
        if (mustExist) throw new SessionError('invalid_path', 'Context path does not exist.');
        continue;
      }
      if (stat.isSymbolicLink()) throw new SessionError('invalid_path', 'Symlink paths are forbidden.');
      const resolved = relative(this.root, realpathSync(full));
      if (resolved.startsWith('..') || isAbsolute(resolved)) throw new SessionError('invalid_path', 'Path escapes the workspace.');
    }
    return full;
  }
  private prompt(state: Session, message = ''): string {
    const last = state.turns.findLastIndex(turn => turn.role === 'worker');
    const exchange = last < 0 ? [] : state.turns.slice(last - 1, last + 1);
    return JSON.stringify({ objective: state.objective, brief: state.brief,
      acceptanceCriteria: state.acceptanceCriteria, allowedPaths: state.allowedPaths,
      contextRevision: state.contextRevision, context: state.context,
      lastSuccessfulExchange: exchange,
      currentMessage: message });
  }
  private sameFile(first: BigIntStats, second: BigIntStats): boolean {
    return first.dev === second.dev && first.ino === second.ino && first.size === second.size
      && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs;
  }
  private readSnapshot(path: string, full: string, expected: BigIntStats): Snapshot {
    const fd = openSync(full, 'r');
    try {
      const opened = fstatSync(fd, { bigint: true });
      this.safePath(path, true);
      if (!this.sameFile(expected, opened) || !this.sameFile(opened, statSync(full, { bigint: true }))) {
        throw new SessionError('context_changed', 'Context path changed before snapshot reading.');
      }
      const buffer = Buffer.alloc(HARD_BUDGET + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = readSync(fd, buffer, length, buffer.length - length, null);
        if (read === 0) break;
        length += read;
      }
      if (length > HARD_BUDGET) throw new SessionError('budget_exceeded', 'Context file grew beyond the input budget while reading.');
      this.safePath(path, true);
      const after = fstatSync(fd, { bigint: true });
      // shortcut: these checks detect observed races, native handle containment is needed for hostile path remapping.
      if (!this.sameFile(opened, after) || !this.sameFile(after, statSync(full, { bigint: true }))) {
        throw new SessionError('context_changed', 'Context path or content changed while reading the snapshot.');
      }
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
      return { path: path.replaceAll('\\', '/'), content, contentHash: createHash('sha256').update(content).digest('hex'), estimatedTokens: length };
    } finally { closeSync(fd); }
  }
  private budget(prompt: string): { estimatedInputTokens: number; warnings: string[]; estimateMethod: string } {
    // shortcut: UTF-8 bytes plus framing are a conservative heuristic, replace when the endpoint tokenizer is known.
    const estimatedInputTokens = Buffer.byteLength(prompt, 'utf8') + 256;
    if (estimatedInputTokens > HARD_BUDGET) throw new SessionError('budget_exceeded', 'Estimated input budget exceeds 32000; replace the context explicitly.');
    return { estimatedInputTokens, warnings: estimatedInputTokens >= WARNING_BUDGET ? ['Estimated input exceeds 24000; tokenizer error is unknown.'] : [],
      estimateMethod: 'conservative_utf8_bytes_plus_256_not_exact_tokenizer' };
  }
  start(input: { objective: string; allowedPaths: string[]; acceptanceCriteria?: string[] }): { sessionId: string } {
    if (input.allowedPaths.length !== 1 || !/\.test\.tsx?$/.test(input.allowedPaths[0])) {
      throw new SessionError('invalid_path', 'Pilot requires exactly one .test.ts(x) target path.');
    }
    this.safePath(input.allowedPaths[0], false);
    const state: Session = { id: randomUUID(), workspaceRoot: this.root, ...input,
      brief: '', acceptanceCriteria: input.acceptanceCriteria ?? [], contextRevision: 0,
      context: [], turns: [], errors: [], pending: false };
    this.budget(this.prompt(state));
    this.save(state);
    return { sessionId: state.id };
  }
  contextSet(id: string, input: ContextInput): { contextRevision: number; estimatedInputTokens: number; warnings: string[]; estimateMethod: string } {
    const state = this.ready(id);
    try {
      if (!input.brief.trim() || input.files.length === 0) throw new SessionError('context_not_ready', 'Provide a nonempty brief and source file list.');
      let bytes = Buffer.byteLength(input.brief + state.objective + input.acceptanceCriteria.join(''), 'utf8');
      const files = input.files.map(path => {
        const full = this.safePath(path, true), stat = statSync(full, { bigint: true });
        if (!stat.isFile()) throw new SessionError('invalid_path', 'Context path must be a regular file.');
        if (stat.size > BigInt(HARD_BUDGET)) throw new SessionError('budget_exceeded', 'Context file size exceeds the input budget before reading.');
        bytes += Number(stat.size);
        if (bytes > HARD_BUDGET) throw new SessionError('budget_exceeded', 'Context file size exceeds the input budget before reading.');
        return { path, full, stat };
      });
      const context = files.map(({ path, full, stat }) => this.readSnapshot(path, full, stat));
      const next = { ...state, brief: input.brief, acceptanceCriteria: input.acceptanceCriteria,
        context, contextRevision: state.contextRevision + 1 };
      const budget = this.budget(this.prompt(next));
      this.save(next);
      return { contextRevision: next.contextRevision, ...budget };
    } catch (error: unknown) {
      const safe = error instanceof SessionError ? error : new SessionError('context_read_failed', 'Could not read a complete UTF-8 context snapshot.');
      if (safe.code !== 'storage_error') this.recordError(state, safe);
      throw safe;
    }
  }
  async workerChat(id: string, message: string): Promise<{ responsePreview: string; finishReason: 'stop'; usage: { inputTokens: number | null; outputTokens: number | null }; estimatedInputTokens: number; warnings: string[]; estimateMethod: string }> {
    const state = this.ready(id);
    try {
      if (!state.contextRevision || !state.brief.trim() || !state.context.length) throw new SessionError('context_not_ready', 'Set context before inference.');
      const prompt = this.prompt(state, message), budget = this.budget(prompt);
      state.pending = true;
      state.turns.push({ role: 'supervisor', text: message, contextRevision: state.contextRevision });
      this.save(state);
      const response = await chat(this.config, prompt, OUTPUT_RESERVE);
      if (!response.ok) throw new SessionError(response.error.code, response.error.message);
      state.pending = false;
      state.turns.push({ role: 'worker', text: response.text, contextRevision: state.contextRevision });
      this.save(state);
      return { responsePreview: response.text, finishReason: response.finishReason,
        usage: response.usage ?? { inputTokens: null, outputTokens: null }, ...budget };
    } catch (error: unknown) {
      state.pending = false;
      const safe = error instanceof SessionError ? error : new SessionError('inference_failed', 'Inference could not complete; no automatic replay.');
      if (safe.code !== 'storage_error') this.recordError(state, safe);
      throw safe;
    }
  }
  status(id: string): { phase: string; contextRevision: number; pendingAction?: string; details: Session } {
    const state = this.load(id);
    return { phase: state.pending ? 'chatting' : state.contextRevision ? 'ready' : 'draft', contextRevision: state.contextRevision,
      ...(state.pending ? { pendingAction: 'wait_for_inference' } : {}), details: state };
  }
}
