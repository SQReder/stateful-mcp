import { execFile, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, openSync, fstatSync, readSync, closeSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, parse } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chat, type WorkerConfig } from './worker.js';
import { z } from 'zod';

// The corporate window is 96K tokens; 64K input is the user's safe ceiling, leaving room for the output reserve.
const HARD_BUDGET = 64_000, WARNING_BUDGET = 48_000, OUTPUT_RESERVE = 8192;
// shortcut: ~3 UTF-8 bytes per token is conservative for code and Cyrillic; replace with the endpoint tokenizer when known.
const BYTES_PER_TOKEN = 3, MAX_FILE_BYTES = HARD_BUDGET * BYTES_PER_TOKEN;
const estimateTokens = (bytes: number): number => Math.ceil(bytes / BYTES_PER_TOKEN);
// shortcut: one fixed timeout for git and tsc; make it configurable when real projects need longer typechecks.
const COMMAND_TIMEOUT_MS = 300_000, COMMAND_OUTPUT_LIMIT = 16 * 1024 * 1024, DIAGNOSTIC_LIMIT = 8000;
const STORE_DIR = '.stateful-worker';
// tsc must not write: --noEmit alone still writes .tsbuildinfo for incremental/composite projects (verified on TS 7.0.2).
const TYPECHECK_FLAGS = ['--noEmit', '--incremental', 'false', '--composite', 'false'];
// Recovery finds the raw commit of an interrupted apply by this trailer instead of exposing SHAs.
const CANDIDATE_TRAILER = 'Stateful-Worker-Candidate', POSTPROCESS_TRAILER = 'Stateful-Worker-Postprocess';
// Trusted fix tools and their arguments; WORKER_POSTPROCESS only picks from these and sets the run order.
const POSTPROCESS_ARGS: Record<string, string[]> = { prettier: ['--write'], eslint: ['--fix'] };
type ApplyPhase = 'applying' | 'validating' | 'committing' | 'committed' | 'restored' | 'conflict' | 'error'
  | 'postprocessing' | 'postprocess_validating' | 'postprocess_committing' | 'postprocessed' | 'postprocess_failed';
type Result<Status extends string> = { status: Status; diagnostics: string[]; changedFiles: string[]; hooksModified?: true };
export type ApplyResult = Result<'committed' | 'validation_failed' | 'conflict' | 'no_changes' | 'error'>;
export type PostprocessResult = Result<'committed' | 'no_changes' | 'failed' | 'conflict' | 'error'>;
interface CommandResult { code: number | string; stdout: string; stderr: string }
interface Snapshot { path: string; content: string; contentHash: string; estimatedTokens: number }
interface Turn { role: 'supervisor' | 'worker'; text: string; contextRevision: number }
interface StoredError { code: string; message: string; contextRevision: number }
export interface ReviewFinding { severity: 'blocker' | 'major' | 'minor'; message: string; location?: string }
interface Candidate {
  readonly id: string; readonly path: string; readonly content: string; readonly diff: string;
  readonly contextRevision: number; readonly base: Snapshot | null;
  state: 'draft' | 'approved' | 'rejected'; findings: ReviewFinding[];
  reviews: Array<{ verdict: 'approve' | 'reject'; findings: ReviewFinding[]; contextRevision: number }>;
  applyResult?: ApplyResult;
  rawCommit?: string; // internal: postprocess runs only directly on this commit
  postprocessResult?: PostprocessResult;
}
const artifactSchema = z.object({ path: z.string(), content: z.string().refine(value => value.trim().length > 0) }).strict();
interface Session {
  id: string; workspaceRoot: string; objective: string; allowedPaths: string[];
  brief: string; acceptanceCriteria: string[]; contextRevision: number;
  context: Snapshot[]; turns: Turn[]; errors: StoredError[]; pending: boolean; candidates: Candidate[];
  // formatted: content hashes of postprocessed raw paths; only files still holding them are restored.
  apply?: { candidateId: string; phase: ApplyPhase; head?: string; formatted?: Record<string, string> };
}
interface ContextInput { files: string[]; brief: string; acceptanceCriteria: string[] }
export class SessionError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
const POSTPROCESS_BUSY: string[] = ['postprocessing', 'postprocess_validating', 'postprocess_committing'];
const BUSY = ['applying', 'validating', 'committing', ...POSTPROCESS_BUSY], BUSY_PHASES = `(${BUSY.map(phase => `'${phase}'`).join(', ')})`;
const applying = (state: Session): boolean => BUSY.includes(state.apply?.phase ?? '');
// Windows env names are case-insensitive, so the key must be dropped under any spelling.
const commandEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'HARNESS_MODEL_API_KEY'));
const outcome = <Status extends string>(status: Status, ...diagnostics: string[]): Result<Status> => ({ status, diagnostics, changedFiles: [] });
const capped = (label: string, text: string): string => text.length <= DIAGNOSTIC_LIMIT ? `${label}: ${text}`
  : `${label} (truncated to first ${DIAGNOSTIC_LIMIT} of ${text.length} chars): ${text.slice(0, DIAGNOSTIC_LIMIT)}`;
const commandDiagnostics = (result: CommandResult): string[] => [`exit code: ${result.code}`, capped('stdout', result.stdout), capped('stderr', result.stderr)];
const samePath = (first: string, second: string): boolean => process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
/** Paths of `git status --porcelain=v1 -z` output outside the store directory. */
const statusPaths = (stdout: string): string[] => {
  const fields = stdout.split('\0'), paths: string[] = [];
  for (let index = 0; index < fields.length; index++) {
    if (!fields[index]) continue;
    paths.push(fields[index].slice(3));
    if (/^([RC].|.[RC])/.test(fields[index])) paths.push(fields[++index]); // rename/copy entries carry the source path as the next field
  }
  return paths.filter(path => path !== STORE_DIR && !path.startsWith(`${STORE_DIR}/`));
};

export class SessionStore {
  private readonly db: DatabaseSync;
  private readonly root: string;
  private closed = false;
  private applyRunning = false;
  constructor(workspaceRoot: string, private readonly config: WorkerConfig, private readonly tsconfig?: string, private readonly postprocessTools?: string) {
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
      for (const row of this.db.prepare(`SELECT state FROM sessions WHERE json_extract(state, '$.apply.phase') IN ${BUSY_PHASES}`).all()) {
        const state: Session = JSON.parse(String(row.state)), apply = state.apply!, candidate = this.candidate(state, apply.candidateId);
        if (POSTPROCESS_BUSY.includes(apply.phase)) {
          apply.phase = this.recoverPostprocess(apply, candidate);
          const outcomes = { postprocessed: 'its commit exists and was kept without re-verification', postprocess_failed: 'raw paths are at the raw commit and postprocess can run again',
            conflict: 'files may be partially formatted or changed externally, or HEAD moved to an unrecognised commit or Git failed, so files were left untouched' };
          this.recordError(state, new SessionError('postprocess_interrupted', `Previous postprocess was interrupted; ${outcomes[apply.phase as keyof typeof outcomes]}.`));
          continue;
        }
        apply.phase = apply.phase === 'committing' ? this.recoverCommit(candidate, apply.head ?? '') : this.restore(candidate);
        const outcomes = { committed: 'its commit exists and was kept', error: 'its commit exists but differs from the candidate; it was kept unverified',
          restored: 'target is at its base', conflict: 'the target changed externally, HEAD moved to an unrecognised commit or Git failed, so files were left untouched' };
        this.recordError(state, new SessionError('apply_interrupted', `Previous apply was interrupted; ${outcomes[apply.phase as keyof typeof outcomes]}; validation was not replayed.`));
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
    state.candidates ??= [];
    if (state.workspaceRoot !== this.root) throw new SessionError('workspace_mismatch', 'Session belongs to another workspace.');
    return state;
  }
  private ready(id: string): Session {
    const state = this.load(id);
    if (state.pending || applying(state)) throw new SessionError('session_busy', 'Session is busy with an inference or apply.');
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
    const latest = state.candidates.at(-1);
    return JSON.stringify({ objective: state.objective, brief: state.brief,
      acceptanceCriteria: state.acceptanceCriteria, allowedPaths: state.allowedPaths,
      contextRevision: state.contextRevision, context: state.context,
      ...(latest ? { currentCandidate: { path: latest.path, content: latest.content, contextRevision: latest.contextRevision }, previousRequest: exchange[0]?.text }
        : { lastSuccessfulExchange: exchange }),
      // Feedback must describe the code sent as currentCandidate, so it comes only from the latest candidate.
      openFeedback: latest?.state === 'rejected' ? latest.findings : [],
      outputContract: { instruction: 'Return exactly one JSON object with path and content; no Markdown or additional fields. Content must be the complete test file. Implement exactly the listed acceptance criteria: do not add, drop or change any.', path: state.allowedPaths[0].replaceAll('\\', '/') },
      currentMessage: message });
  }
  private targetBase(path: string): Snapshot | null {
    const full = this.safePath(path, false);
    if (!lstatSync(full, { throwIfNoEntry: false })) return null;
    const stat = statSync(full, { bigint: true });
    if (!stat.isFile()) throw new SessionError('invalid_path', 'Target base must be a regular file.');
    if (stat.size > BigInt(MAX_FILE_BYTES)) throw new SessionError('budget_exceeded', 'Target base exceeds the snapshot budget.');
    return this.readSnapshot(path, full, stat);
  }
  private replacementDiff(path: string, base: string | null, content: string): string {
    if (base === content) return '';
    const split = (text: string): string[] => text ? text.split('\n').slice(0, text.endsWith('\n') ? -1 : undefined) : [];
    const before = split(base ?? ''), after = split(content);
    const block = (lines: string[], text: string, sign: string): string => lines.map((line, index) =>
      `${sign}${line}\n${index === lines.length - 1 && !text.endsWith('\n') ? '\\ No newline at end of file\n' : ''}`).join('');
    return `--- ${base === null ? '/dev/null' : `a/${path}`}\n+++ b/${path}\n@@ -${before.length ? 1 : 0},${before.length} +${after.length ? 1 : 0},${after.length} @@\n`
      + block(before, base ?? '', '-') + block(after, content, '+');
  }
  private addCandidate(state: Session, response: string, base: Snapshot | null): string {
    let value: unknown;
    try { value = JSON.parse(response); } catch { throw new SessionError('invalid_candidate', 'Reply is not a single JSON artifact; no candidate created.'); }
    const parsed = artifactSchema.safeParse(value);
    if (!parsed.success) throw new SessionError('invalid_candidate', 'Artifact must contain only path and nonblank complete content; no candidate created.');
    const path = state.allowedPaths[0].replaceAll('\\', '/');
    if (parsed.data.path !== path) throw new SessionError('invalid_candidate_path', 'Artifact path differs from the allowed target; no candidate created.');
    // Apply and restore compare files through budget-limited reads, so a larger candidate could never be recognised and restored.
    if (Buffer.byteLength(parsed.data.content, 'utf8') > MAX_FILE_BYTES) throw new SessionError('invalid_candidate', `Artifact exceeds ${MAX_FILE_BYTES} bytes; no candidate created.`);
    const id = randomUUID();
    state.candidates.push({ id, path, content: parsed.data.content, base,
      diff: this.replacementDiff(path, base?.content ?? null, parsed.data.content), contextRevision: state.contextRevision,
      state: 'draft', findings: [], reviews: [] });
    return id;
  }
  private candidate(state: Session, id: string): Candidate {
    const candidate = state.candidates.find(candidate => candidate.id === id);
    if (!candidate) throw new SessionError('candidate_not_found', 'Candidate not found in this session.');
    return candidate;
  }
  candidateRead(id: string, candidateId: string): { artifacts: Array<{ path: string; content: string; diff: string }>; contextRevision: number; currentContextRevision: number; state: string; findings: ReviewFinding[]; reviews: Candidate['reviews'] } {
    const state = this.load(id), candidate = this.candidate(state, candidateId);
    return { artifacts: [{ path: candidate.path, content: candidate.content, diff: candidate.diff }],
      contextRevision: candidate.contextRevision, currentContextRevision: state.contextRevision,
      state: candidate.contextRevision === state.contextRevision ? candidate.state : 'stale', findings: candidate.findings, reviews: candidate.reviews };
  }
  candidateReview(id: string, candidateId: string, verdict: 'approve' | 'reject', findings: ReviewFinding[]): { state: 'approved' | 'rejected' } {
    const state = this.ready(id), candidate = this.candidate(state, candidateId);
    if (candidate.contextRevision !== state.contextRevision) throw new SessionError('stale_candidate', 'Candidate is stale; generate a new version on the current revision.');
    if (candidate.state === 'rejected' && verdict === 'approve') throw new SessionError('candidate_rejected', 'Generate and review a new candidate after rejection.');
    candidate.state = verdict === 'approve' ? 'approved' : 'rejected';
    candidate.findings = findings;
    candidate.reviews.push({ verdict, findings, contextRevision: state.contextRevision });
    this.save(state);
    return { state: candidate.state };
  }
  private matches(path: string, expected: string | null): boolean {
    // Unreadable, oversized or unsafe files never match: they are treated as foreign and left untouched.
    try { return (this.targetBase(path)?.content ?? null) === expected; } catch { return false; }
  }
  private restore(candidate: Candidate): 'restored' | 'conflict' {
    const base = candidate.base?.content ?? null;
    if (!this.matches(candidate.path, candidate.content)) return this.matches(candidate.path, base) ? 'restored' : 'conflict';
    // shortcut: compare-then-write leaves a small race with external editors; Git status checks catch most of it.
    const full = this.safePath(candidate.path, false);
    if (base === null) unlinkSync(full); else writeFileSync(full, base);
    return 'restored';
  }
  private run(file: string, args: string[]): Promise<CommandResult> {
    return new Promise(resolve => execFile(file, args, { cwd: this.root, env: commandEnv(), timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_OUTPUT_LIMIT, windowsHide: true },
      (error, stdout, stderr) => resolve({ code: !error ? 0 : error.killed ? `killed (${error.signal ?? 'timeout or output limit'})` : error.code ?? 'failed', stdout, stderr })));
  }
  /** Unstages only the target; a new file is dropped from the index, since `restore --staged` fails for paths absent from HEAD. */
  private unstageArgs(candidate: Candidate): string[] {
    return candidate.base === null ? ['--literal-pathspecs', 'rm', '--cached', '--quiet', '--ignore-unmatch', '--', candidate.path]
      : ['--literal-pathspecs', 'restore', '--staged', '--', candidate.path];
  }
  /** Sync Git for the constructor and exception paths. */
  private git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.root, env: commandEnv(), encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_OUTPUT_LIMIT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  /** Sync because the constructor and the exception path need it. Once HEAD has moved, files are never restored: they may be committed. */
  private recoverCommit(candidate: Candidate, head: string): 'committed' | 'restored' | 'conflict' | 'error' {
    try {
      const current = this.git('rev-parse', 'HEAD').trim();
      if (current !== head) {
        const ours = this.git('rev-parse', 'HEAD^').trim() === head && this.git('log', '-1', '--format=%B', 'HEAD').includes(`${CANDIDATE_TRAILER}: ${candidate.id}`);
        if (!ours) return 'conflict';
        const files = this.git('diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD').split('\0').filter(Boolean);
        // The candidate passed the typecheck before the commit, so an exact single-file match is verified; anything else is not.
        if (files.length === 1 && samePath(files[0], candidate.path) && this.git('show', `HEAD:${files[0]}`) === candidate.content) {
          candidate.applyResult = { status: 'committed', diagnostics: ['recovered_after_crash: the apply was interrupted after Git created its commit; the commit holds exactly the candidate and was kept.'], changedFiles: [candidate.path] };
          candidate.rawCommit = current;
          return 'committed';
        }
        candidate.applyResult = { status: 'error', diagnostics: [`committed_unverified: the apply was interrupted after Git created its commit, which differs from the candidate or touches other paths; it was kept and not typechecked: ${files.join(', ') || 'no paths'}`], changedFiles: files };
        return 'error';
      }
      this.git(...this.unstageArgs(candidate));
    } catch { return 'conflict'; }
    return this.restore(candidate);
  }
  /** Returns formatted raw paths to the raw commit while HEAD is still on it and they hold the recorded content; returns the paths left untouched. */
  private unformat(formatted: Record<string, string>, raw: string | undefined): string[] {
    return Object.keys(formatted).filter(path => {
      try {
        if (this.git('rev-parse', 'HEAD').trim() !== raw || this.targetBase(path)?.contentHash !== formatted[path]) return true;
        // shortcut: compare-then-write leaves the same small race with external editors as restore().
        writeFileSync(this.safePath(path, false), this.git('show', `HEAD:${path}`));
        return false;
      } catch { return true; } // unreadable files or failing Git count as foreign: left untouched
    });
  }
  /** Sync like recoverCommit. A trailer commit on the raw commit is kept; otherwise files are restored only by the unformat rule. */
  private recoverPostprocess(apply: NonNullable<Session['apply']>, candidate: Candidate): 'postprocessed' | 'postprocess_failed' | 'conflict' {
    const formatted = apply.formatted ?? {};
    try {
      // Tools may have written without recorded hashes: only a clean tree is known to be untouched.
      if (apply.phase === 'postprocessing') return statusPaths(this.git('status', '--porcelain=v1', '-z', '--untracked-files=all')).length ? 'conflict' : 'postprocess_failed';
      if (apply.phase === 'postprocess_committing') {
        if (this.git('rev-parse', 'HEAD').trim() !== candidate.rawCommit) {
          const ours = this.git('rev-parse', 'HEAD^').trim() === candidate.rawCommit && this.git('log', '-1', '--format=%B', 'HEAD').includes(`${POSTPROCESS_TRAILER}: ${candidate.id}`);
          if (!ours) return 'conflict';
          const files = this.git('diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD').split('\0').filter(Boolean);
          candidate.postprocessResult = { status: 'committed', diagnostics: ['recovered_after_crash: the postprocess was interrupted after Git created its commit; the files passed the typecheck before committing and the commit was kept, but hook changes, if any, were not re-verified.'], changedFiles: files };
          return 'postprocessed';
        }
        this.git('--literal-pathspecs', 'restore', '--staged', '--', ...Object.keys(formatted));
      }
    } catch { return 'conflict'; }
    return this.unformat(formatted, candidate.rawCommit).length ? 'conflict' : 'postprocess_failed';
  }
  /** Runs tsc only when the trusted config includes the target; a typecheck without the target is not validation. */
  private async typecheck(tsc: string, tsconfig: string, full: string): Promise<{ listed: CommandResult; checked?: CommandResult }> {
    const listed = await this.run(process.execPath, [tsc, '--listFilesOnly', '-p', tsconfig]), target = realpathSync(full);
    const included = listed.code === 0 && listed.stdout.split(/\r?\n/).some(line => line.trim() && samePath(basename(line.trim()), basename(target)) && samePath(realpathSync(line.trim()), target));
    return { listed, checked: included ? await this.run(process.execPath, [tsc, ...TYPECHECK_FLAGS, '-p', tsconfig]) : undefined };
  }
  /** Judges the commit just made on `head` from the expected files; nothing here reverts it, since history is never rewritten. */
  private async committedResult(head: string, expected: Array<{ path: string; content: string }>, tsc: string, tsconfig: string, full: string): Promise<Result<'committed' | 'error'>> {
    const parent = await this.run('git', ['rev-parse', '--verify', 'HEAD^']), paths = expected.map(file => file.path);
    const files = (await this.run('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD'])).stdout.split('\0').filter(Boolean);
    if (parent.stdout.trim() !== head || !files.length || files.some(file => !paths.some(path => samePath(path, file)))) {
      return { status: 'error', diagnostics: [`commit_scope_violation: HEAD is not a commit of only the expected paths on the pre-commit HEAD; nothing was reverted: ${files.join(', ') || 'no paths'}`], changedFiles: files };
    }
    const left = await this.changedPaths() ?? ['(Git status unavailable)'];
    const leftDiagnostics = left.length ? [`hooks_left_changes: hooks left uncommitted changes that were not touched: ${left.join(', ')}`] : [];
    // Plain blob bytes as UTF-8: with core.autocrlf the blob is normalized, so a CRLF file shows as modified rather than slipping through.
    // Git's own spelling: tree lookups are case-sensitive even on Windows.
    const blobs = await Promise.all(expected.map(file => this.run('git', ['show', `HEAD:${files.find(path => samePath(path, file.path)) ?? file.path}`])));
    const modified = expected.filter((file, index) => blobs[index].code !== 0 || blobs[index].stdout !== file.content);
    if (!modified.length) return { status: 'committed', diagnostics: leftDiagnostics, changedFiles: paths };
    const diff = capped('hooks_modified: hooks changed committed files; diff expected -> committed',
      modified.map(file => this.replacementDiff(file.path, file.content, blobs[expected.indexOf(file)].stdout)).join(''));
    if (modified.some(file => blobs[expected.indexOf(file)].code !== 0) || left.length) {
      return { status: 'error', diagnostics: ['committed_unverified: hooks changed or removed committed files and the worktree differs from HEAD, so the commit was not typechecked; nothing was reverted.', diff, ...leftDiagnostics], changedFiles: paths };
    }
    const { listed, checked } = await this.typecheck(tsc, tsconfig, full);
    if (checked?.code === 0) return { status: 'committed', diagnostics: [diff], changedFiles: paths, hooksModified: true };
    return { status: 'error', diagnostics: ['hooks_broke_typecheck: the hook-modified commit fails the typecheck; it stays in history and nothing was reverted.', ...commandDiagnostics(checked ?? listed), diff], changedFiles: paths };
  }
  /** Changed paths outside the store directory, or null when the workspace is not the root of a usable Git repository. */
  private async changedPaths(): Promise<string[] | null> {
    const top = await this.run('git', ['rev-parse', '--show-toplevel']);
    if (top.code !== 0 || !samePath(realpathSync(top.stdout.trim()), this.root)) return null;
    const status = await this.run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    return status.code === 0 ? statusPaths(status.stdout) : null;
  }
  async candidateApply(id: string, candidateId: string): Promise<ApplyResult> {
    const approved = (): { state: Session; candidate: Candidate } => {
      const state = this.ready(id), candidate = this.candidate(state, candidateId);
      if (candidate.contextRevision !== state.contextRevision) throw new SessionError('stale_candidate', 'Candidate is stale; generate and review a new version on the current revision.');
      if (candidate.state !== 'approved') throw new SessionError('candidate_not_approved', 'Only an approved candidate can be applied; review this exact version first.');
      return { state, candidate };
    };
    let { state, candidate } = approved();
    // Only final outcomes are stored (a completed failed typecheck or an existing commit), so a repeat never touches Git or tsc.
    if (candidate.applyResult) return candidate.applyResult;
    this.assertNoWriter();
    const tsconfig = this.trustedTsconfig();
    this.applyRunning = true;
    try {
      const dirty = await this.changedPaths();
      if (!dirty) return outcome('error', 'git_unavailable: the workspace must be the root of a Git repository and git must be runnable.');
      if (dirty.length) return outcome('conflict', `dirty_worktree: commit or remove changes first: ${dirty.join(', ')}`);
      ({ state, candidate } = approved()); // re-read: the session may have changed while Git ran
      const changedContext = state.context.filter(snapshot => !this.matches(snapshot.path, snapshot.content)).map(snapshot => snapshot.path);
      if (changedContext.length) return outcome('conflict', `context_changed: refresh context and regenerate: ${changedContext.join(', ')}`);
      const base = candidate.base?.content ?? null;
      if (!this.matches(candidate.path, base)) return outcome('conflict', `target_changed: ${candidate.path} differs from the generation-time base.`);
      const full = this.safePath(candidate.path, false);
      if (!statSync(dirname(full), { throwIfNoEntry: false })?.isDirectory()) return outcome('error', `missing_directory: parent of ${candidate.path} must already exist.`);
      if (candidate.content === base) return outcome('no_changes');
      const tsc = this.tscPath();
      if (!tsc) return outcome('error', 'typescript_not_found: the workspace must resolve its own typescript package.');
      const journal = (phase: ApplyPhase, head?: string): void => { state.apply = { candidateId, phase, head }; this.save(state); };
      // Set before staging and never cleared: the exception path must not trust the in-memory phase, which journal() changes before saving.
      let committingHead: string | undefined;
      journal('applying');
      try {
        writeFileSync(full, candidate.content, { flag: base === null ? 'wx' : 'w' });
        journal('validating');
        const { listed, checked } = await this.typecheck(tsc, tsconfig, full);
        let failure: ApplyResult, final = false;
        if (!checked) {
          failure = outcome('error', `target_not_in_typecheck: tsc --listFilesOnly -p ${this.tsconfig} does not include ${candidate.path}; a typecheck without the target is not validation.`, ...(listed.code === 0 ? [] : commandDiagnostics(listed)));
        } else if (checked.code === 0) {
          const changed = await this.changedPaths() ?? [];
          const foreign = changed.filter(path => !samePath(path, candidate.path));
          if (foreign.length || !changed.length) {
            journal('error');
            return { status: 'error', diagnostics: [`unexpected_changes: validation passed but the worktree has changes besides the target; nothing was reverted: ${foreign.join(', ') || 'Git status unavailable'}`], changedFiles: changed };
          }
          const head = await this.run('git', ['rev-parse', '--verify', 'HEAD']);
          if (head.code !== 0) {
            failure = outcome('error', 'head_unavailable: the repository needs an initial commit to commit the candidate on.', ...commandDiagnostics(head));
          } else {
            committingHead = head.stdout.trim();
            journal('committing', committingHead);
            const added = await this.run('git', ['--literal-pathspecs', 'add', '--', candidate.path]);
            const commit = added.code !== 0 ? added
              : await this.run('git', ['commit', '-m', `test: ${base === null ? 'add' : 'update'} ${candidate.path}`, '-m', `${CANDIDATE_TRAILER}: ${candidateId}`]);
            // A killed or timed-out git (e.g. a slow post-commit hook) may still have created the commit: HEAD decides, not the exit code.
            const moved = commit.code !== 0 && added.code === 0 && (await this.run('git', ['rev-parse', '--verify', 'HEAD'])).stdout.trim() !== committingHead;
            if (commit.code === 0 || moved) {
              // Every post-commit outcome is final: the commit stays in history and a retry must not commit again.
              const judged = await this.committedResult(committingHead, [candidate], tsc, tsconfig, full);
              if (judged.status === 'committed') candidate.rawCommit = (await this.run('git', ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
              candidate.applyResult = moved ? { ...judged, diagnostics: ['commit_exit_nonzero: git reported a failure after creating the commit; the commit was kept.', ...commandDiagnostics(commit), ...judged.diagnostics] } : judged;
              journal(candidate.applyResult.status === 'committed' ? 'committed' : 'error');
              return candidate.applyResult;
            }
            const unstaged = await this.run('git', this.unstageArgs(candidate));
            failure = outcome('error', 'commit_failed: Git or a hook refused the commit; the target was unstaged and the candidate can be applied again.', ...commandDiagnostics(commit),
              ...(unstaged.code === 0 ? [] : [`unstage_failed: ${candidate.path} may still be staged.`, ...commandDiagnostics(unstaged)]));
          }
        } else {
          // Only a real tsc exit code judges the candidate; a timeout, kill or spawn failure must not burn an approved candidate.
          final = typeof checked.code === 'number';
          failure = final ? outcome('validation_failed', ...commandDiagnostics(checked))
            : outcome('error', 'typecheck_not_completed: tsc did not finish; the candidate can be applied again.', ...commandDiagnostics(checked));
        }
        const restored = this.restore(candidate) === 'restored';
        if (!restored) failure = outcome('conflict', ...failure.diagnostics, `restore_conflict: ${candidate.path} changed during validation and was left untouched.`);
        if (final) candidate.applyResult = failure; // a completed typecheck is final for this immutable candidate
        journal(!restored ? 'conflict' : failure.status === 'error' ? 'error' : 'restored');
        return failure;
      } catch (error: unknown) {
        const phase = committingHead !== undefined ? this.recoverCommit(candidate, committingHead) : this.restore(candidate);
        journal(phase === 'restored' ? 'error' : phase);
        throw error;
      }
    } finally { this.applyRunning = false; }
  }
  /** Single writer per workspace: one apply or postprocess at a time, also across sessions. */
  private assertNoWriter(): void {
    if (this.applyRunning || this.db.prepare(`SELECT 1 FROM sessions WHERE json_extract(state, '$.apply.phase') IN ${BUSY_PHASES}`).get()) {
      throw new SessionError('apply_busy', 'Another apply or postprocess is in progress in this workspace.');
    }
  }
  private trustedTsconfig(): string {
    if (!this.tsconfig?.trim()) throw new SessionError('configuration_error', 'Missing WORKER_TSCONFIG: candidate_apply and postprocess need a trusted workspace-relative tsconfig.');
    return this.safePath(this.tsconfig, true);
  }
  private tscPath(): string | undefined {
    try { return join(dirname(createRequire(join(this.root, 'package.json')).resolve('typescript/package.json')), 'bin', 'tsc'); } catch { return undefined; }
  }
  /** The package's own bin entry, resolved from the workspace like typescript; walks up node_modules when `exports` hides package.json. */
  private packageBin(name: string): string | undefined {
    try {
      let manifest: string;
      try { manifest = createRequire(join(this.root, 'package.json')).resolve(`${name}/package.json`); } catch {
        let dir = this.root;
        while (!existsSync(manifest = join(dir, 'node_modules', name, 'package.json')) && dirname(dir) !== dir) dir = dirname(dir);
      }
      const bin: unknown = JSON.parse(readFileSync(manifest, 'utf8')).bin;
      const entry = typeof bin === 'string' ? bin : typeof bin === 'object' && bin ? (bin as Record<string, unknown>)[name] : undefined;
      return typeof entry === 'string' ? join(dirname(manifest), entry) : undefined;
    } catch { return undefined; }
  }
  /** Runs the trusted fix tools on the raw commit's paths only and commits their changes separately after a passing typecheck. */
  async postprocess(id: string): Promise<PostprocessResult> {
    const committed = (): { state: Session; candidate: Candidate; raw: string } => {
      const state = this.ready(id), candidate = state.apply && this.candidate(state, state.apply.candidateId);
      if (candidate?.applyResult?.status !== 'committed' || !candidate.rawCommit) {
        throw new SessionError('no_raw_commit', 'postprocess needs a raw commit: the latest candidate_apply of this session must have returned committed.');
      }
      return { state, candidate, raw: candidate.rawCommit };
    };
    let { state, candidate, raw } = committed();
    // Only final outcomes are stored, so a repeat never runs tools, tsc or Git.
    if (candidate.postprocessResult) return candidate.postprocessResult;
    this.assertNoWriter();
    const names = (this.postprocessTools ?? '').split(',').map(name => name.trim()).filter(Boolean);
    if (!names.length || names.some(name => !Object.hasOwn(POSTPROCESS_ARGS, name))) {
      throw new SessionError('configuration_error', `WORKER_POSTPROCESS must list trusted tools in run order, from: ${Object.keys(POSTPROCESS_ARGS).join(', ')}.`);
    }
    const tsconfig = this.trustedTsconfig();
    this.applyRunning = true;
    try {
      const dirty = await this.changedPaths();
      if (!dirty) return outcome('error', 'git_unavailable: the workspace must be the root of a Git repository and git must be runnable.');
      ({ state, candidate, raw } = committed()); // re-read: the session may have changed while Git ran
      if ((await this.run('git', ['rev-parse', '--verify', 'HEAD'])).stdout.trim() !== raw) {
        return outcome('conflict', 'head_moved: postprocess runs only directly on top of the raw commit, and HEAD has moved since candidate_apply.');
      }
      if (dirty.length) return outcome('conflict', `dirty_worktree: commit or remove changes first: ${dirty.join(', ')}`);
      const paths = (await this.run('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', raw])).stdout.split('\0').filter(Boolean);
      const missing = paths.filter(path => { try { return !statSync(this.safePath(path, true)).isFile(); } catch { return true; } });
      if (!paths.length || missing.length) return outcome('error', `raw_paths_unavailable: every path of the raw commit must be a regular file: ${missing.join(', ') || 'no paths'}`);
      const tools = names.map(name => ({ name, bin: this.packageBin(name) ?? '' }));
      const unresolved = tools.filter(tool => !tool.bin).map(tool => tool.name);
      if (unresolved.length) return outcome('error', `tool_not_found: the workspace must resolve its own ${unresolved.join(', ')} package with a bin entry.`);
      const tsc = this.tscPath();
      if (!tsc) return outcome('error', 'typescript_not_found: the workspace must resolve its own typescript package.');
      const journal = (phase: ApplyPhase, formatted?: Record<string, string>): void => { state.apply = { candidateId: candidate.id, phase, formatted }; this.save(state); };
      const final = (result: PostprocessResult, phase: ApplyPhase): PostprocessResult => { candidate.postprocessResult = result; journal(phase); return result; };
      journal('postprocessing');
      try {
        const notes: string[] = [];
        let failure: string[] | undefined;
        for (const { name, bin } of tools) {
          const ran = await this.run(process.execPath, [bin, ...POSTPROCESS_ARGS[name], '--', ...paths]);
          if (ran.code === 0) continue;
          // eslint exits 1 when it applied its fixes but problems it cannot fix remain; the typecheck still judges the result.
          if (name === 'eslint' && ran.code === 1) { notes.push(capped('lint_problems_remain: eslint applied its fixes; remaining problems', ran.stdout || ran.stderr)); continue; }
          failure = [`tool_failed: ${name} did not complete; nothing was committed.`, ...commandDiagnostics(ran)];
          break;
        }
        const changed = await this.changedPaths();
        if (!changed) { journal('error'); return outcome('error', 'git_unavailable: Git status failed after the tools ran; files were left untouched.'); }
        const foreign = changed.filter(path => !paths.some(rawPath => samePath(rawPath, path)));
        if (foreign.length) return final({ status: 'error', diagnostics: [`postprocess_scope_violation: tools changed paths outside the raw commit; nothing was reverted: ${foreign.join(', ')}`], changedFiles: changed }, 'error');
        const touched = paths.filter(rawPath => changed.some(path => samePath(rawPath, path)));
        if (!touched.length) {
          if (!failure) return final(outcome('no_changes', ...notes), 'postprocessed');
          journal('postprocess_failed');
          return outcome('failed', ...failure, ...notes);
        }
        const after = touched.map(path => {
          const file = this.targetBase(path);
          if (!file) throw new SessionError('postprocess_removed_file', `A postprocess tool removed ${path}; files were left untouched.`);
          return file;
        });
        const formatted = Object.fromEntries(after.map(file => [file.path, file.contentHash]));
        journal('postprocess_validating', formatted);
        let completed = false;
        if (!failure) {
          const full = this.safePath(candidate.path, false), { listed, checked } = await this.typecheck(tsc, tsconfig, full);
          if (checked?.code === 0) {
            journal('postprocess_committing', formatted);
            const added = await this.run('git', ['--literal-pathspecs', 'add', '--', ...touched]);
            const commit = added.code !== 0 ? added
              : await this.run('git', ['commit', '-m', `style: format ${candidate.path}`, '-m', `${POSTPROCESS_TRAILER}: ${candidate.id}`]);
            // As in candidateApply: HEAD, not the exit code, decides whether a commit exists.
            const moved = commit.code !== 0 && added.code === 0 && (await this.run('git', ['rev-parse', '--verify', 'HEAD'])).stdout.trim() !== raw;
            if (commit.code === 0 || moved) {
              const judged = await this.committedResult(raw, after, tsc, tsconfig, full);
              const prefix = moved ? ['commit_exit_nonzero: git reported a failure after creating the commit; the commit was kept.', ...commandDiagnostics(commit)] : [];
              return final({ ...judged, diagnostics: [...prefix, ...judged.diagnostics, ...notes] }, judged.status === 'committed' ? 'postprocessed' : 'error');
            }
            const unstaged = await this.run('git', ['--literal-pathspecs', 'restore', '--staged', '--', ...touched]);
            failure = ['commit_failed: Git or a hook refused the postprocess commit; the raw commit stays and postprocess can run again.', ...commandDiagnostics(commit),
              ...(unstaged.code === 0 ? [] : [`unstage_failed: ${touched.join(', ')} may still be staged.`, ...commandDiagnostics(unstaged)])];
          } else if (!checked) {
            failure = [`target_not_in_typecheck: tsc --listFilesOnly -p ${this.tsconfig} does not include ${candidate.path}; a typecheck without the target is not validation.`, ...(listed.code === 0 ? [] : commandDiagnostics(listed))];
          } else {
            // Only a real tsc exit code judges the formatting; a timeout or kill stays retryable.
            completed = typeof checked.code === 'number';
            failure = [completed ? 'postprocess_broke_typecheck: the formatted files fail the typecheck; nothing was committed and the raw commit stays.'
              : 'typecheck_not_completed: tsc did not finish; postprocess can run again.', ...commandDiagnostics(checked)];
          }
        }
        const left = this.unformat(formatted, raw);
        const result = left.length ? outcome('conflict', ...failure, ...notes, `restore_conflict: ${left.join(', ')} changed during postprocess and was left untouched.`)
          : outcome('failed', ...failure, ...notes);
        if (completed) candidate.postprocessResult = result; // a completed typecheck is final for this raw commit
        journal(left.length ? 'conflict' : 'postprocess_failed');
        return result;
      } catch (error: unknown) {
        journal(this.recoverPostprocess(state.apply!, candidate));
        throw error;
      }
    } finally { this.applyRunning = false; }
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
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = readSync(fd, buffer, length, buffer.length - length, null);
        if (read === 0) break;
        length += read;
      }
      if (length > MAX_FILE_BYTES) throw new SessionError('budget_exceeded', 'Context file grew beyond the input budget while reading.');
      this.safePath(path, true);
      const after = fstatSync(fd, { bigint: true });
      // shortcut: these checks detect observed races, native handle containment is needed for hostile path remapping.
      if (!this.sameFile(opened, after) || !this.sameFile(after, statSync(full, { bigint: true }))) {
        throw new SessionError('context_changed', 'Context path or content changed while reading the snapshot.');
      }
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
      return { path: path.replaceAll('\\', '/'), content, contentHash: createHash('sha256').update(content).digest('hex'), estimatedTokens: estimateTokens(length) };
    } finally { closeSync(fd); }
  }
  private budget(prompt: string): { estimatedInputTokens: number; warnings: string[]; estimateMethod: string } {
    const estimatedInputTokens = estimateTokens(Buffer.byteLength(prompt, 'utf8')) + 256;
    if (estimatedInputTokens > HARD_BUDGET) throw new SessionError('budget_exceeded', `Estimated input exceeds the ${HARD_BUDGET}-token input budget; replace the context explicitly.`);
    return { estimatedInputTokens, warnings: estimatedInputTokens >= WARNING_BUDGET ? [`Estimated input exceeds ${WARNING_BUDGET} tokens; tokenizer error is unknown.`] : [],
      estimateMethod: 'conservative_utf8_bytes_div_3_plus_256_not_exact_tokenizer' };
  }
  start(input: { objective: string; allowedPaths: string[]; acceptanceCriteria?: string[] }): { sessionId: string } {
    if (input.allowedPaths.length !== 1 || !/\.test\.tsx?$/.test(input.allowedPaths[0])) {
      throw new SessionError('invalid_path', 'Pilot requires exactly one .test.ts(x) target path.');
    }
    this.safePath(input.allowedPaths[0], false);
    const state: Session = { id: randomUUID(), workspaceRoot: this.root, ...input,
      brief: '', acceptanceCriteria: input.acceptanceCriteria ?? [], contextRevision: 0,
      context: [], turns: [], errors: [], pending: false, candidates: [] };
    this.budget(this.prompt(state));
    this.save(state);
    return { sessionId: state.id };
  }
  contextSet(id: string, input: ContextInput): { contextRevision: number; estimatedInputTokens: number; warnings: string[]; estimateMethod: string } {
    const state = this.ready(id);
    try {
      if (!input.brief.trim() || input.files.length === 0) throw new SessionError('context_not_ready', 'Provide a nonempty brief and source file list.');
      // The supervising role owns the design: the worker implements an agreed list and never invents its own.
      if (!input.acceptanceCriteria.some(item => item.trim())) throw new SessionError('context_not_ready', 'Provide the agreed acceptance criteria (one scenario per item) before inference.');
      let bytes = Buffer.byteLength(input.brief + state.objective + input.acceptanceCriteria.join(''), 'utf8');
      const files = input.files.map(path => {
        const full = this.safePath(path, true), stat = statSync(full, { bigint: true });
        if (!stat.isFile()) throw new SessionError('invalid_path', 'Context path must be a regular file.');
        if (stat.size > BigInt(MAX_FILE_BYTES)) throw new SessionError('budget_exceeded', 'Context file size exceeds the input budget before reading.');
        bytes += Number(stat.size);
        if (estimateTokens(bytes) > HARD_BUDGET) throw new SessionError('budget_exceeded', 'Context file size exceeds the input budget before reading.');
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
  async workerChat(id: string, message: string): Promise<{ candidateId?: string; artifact?: { path: string; content: string }; candidateDiagnostics?: Array<{ code: string; message: string }>; responsePreview?: string; finishReason: 'stop'; usage: { inputTokens: number | null; outputTokens: number | null }; estimatedInputTokens: number; warnings: string[]; estimateMethod: string }> {
    const state = this.ready(id);
    try {
      if (!state.contextRevision || !state.brief.trim() || !state.context.length) throw new SessionError('context_not_ready', 'Set context before inference.');
      const prompt = this.prompt(state, message), budget = this.budget(prompt);
      const base = this.targetBase(state.allowedPaths[0]);
      state.pending = true;
      state.turns.push({ role: 'supervisor', text: message, contextRevision: state.contextRevision });
      this.save(state);
      const response = await chat(this.config, prompt, OUTPUT_RESERVE);
      if (!response.ok) throw new SessionError(response.error.code, response.error.message);
      state.pending = false;
      state.turns.push({ role: 'worker', text: response.text, contextRevision: state.contextRevision });
      let candidateId: string | undefined, candidateDiagnostics: Array<{ code: string; message: string }> | undefined;
      try { candidateId = this.addCandidate(state, response.text, base); } catch (error: unknown) {
        if (!(error instanceof SessionError)) throw error;
        candidateDiagnostics = [{ code: error.code, message: error.message }];
        state.errors.push({ ...candidateDiagnostics[0], contextRevision: state.contextRevision });
      }
      this.save(state);
      // A candidate is returned as readable code; the raw JSON reply stays in turns and is shown only when it failed to parse.
      const created = candidateId ? this.candidate(state, candidateId) : undefined;
      return { ...(created ? { candidateId, artifact: { path: created.path, content: created.content } } : { candidateDiagnostics, responsePreview: response.text }),
        finishReason: response.finishReason,
        usage: response.usage ?? { inputTokens: null, outputTokens: null }, ...budget };
    } catch (error: unknown) {
      state.pending = false;
      const safe = error instanceof SessionError ? error : new SessionError('inference_failed', 'Inference could not complete; no automatic replay.');
      if (safe.code !== 'storage_error') this.recordError(state, safe);
      throw safe;
    }
  }
  status(id: string): { phase: string; contextRevision: number; latestCandidateId?: string; pendingAction?: string; details: Session } {
    const state = this.load(id);
    const latest = state.candidates.at(-1), current = latest?.contextRevision === state.contextRevision ? latest : undefined;
    const reviewPhase = current ? ({ approved: 'approved', rejected: 'needs_revision', draft: 'review' } as const)[current.state] : 'draft';
    return { phase: state.pending ? 'chatting' : state.apply && (applying(state) || state.apply.candidateId === current?.id) ? state.apply.phase : reviewPhase,
      contextRevision: state.contextRevision, ...(latest ? { latestCandidateId: latest.id } : {}),
      ...(state.pending ? { pendingAction: 'wait_for_inference' } : applying(state) ? { pendingAction: 'wait_for_apply' } : {}), details: state };
  }
}
