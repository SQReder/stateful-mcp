import { execFile, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, openSync, fstatSync, readSync, closeSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MAX_SEARCH_LINES, parseCandidate, unifiedDiff, type CandidateFile, type Problem, type Snapshot } from './candidates.js';
import { chat, type WorkerConfig } from './worker.js';

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
// The same arguments work for ESLint 8 and 9 and any Prettier; a tool runs only where package.json declares it.
const POSTPROCESS_ARGS: Record<string, string[]> = { prettier: ['--write'], eslint: ['--fix'] };
const DEFAULT_POSTPROCESS = 'eslint,prettier'; // lint fixes first, formatting last
type ApplyPhase = 'applying' | 'validating' | 'committing' | 'committed' | 'restored' | 'conflict' | 'error'
  | 'postprocessing' | 'postprocess_validating' | 'postprocess_committing' | 'postprocessed' | 'postprocess_failed';
type Result<Status extends string> = { status: Status; diagnostics: string[]; changedFiles: string[]; hooksModified?: true };
export type ApplyResult = Result<'committed' | 'validation_failed' | 'conflict' | 'no_changes' | 'error'>;
export type PostprocessResult = Result<'committed' | 'no_changes' | 'failed' | 'conflict' | 'error'>;
interface CommandResult { code: number | string; stdout: string; stderr: string }
export type CommitType = 'test' | 'feat' | 'fix';
const MAX_ALLOWED_PATHS = 8;
// problems: why this worker reply made no candidate; the next prompt repeats them to the worker.
interface Turn { role: 'supervisor' | 'worker'; text: string; contextRevision: number; problems?: Problem[] }
interface StoredError { code: string; message: string; contextRevision: number }
export interface ReviewFinding { severity: 'blocker' | 'major' | 'minor'; message: string; location?: string }
interface Candidate {
  readonly id: string; readonly files: CandidateFile[]; readonly contextRevision: number;
  state: 'draft' | 'approved' | 'rejected'; findings: ReviewFinding[];
  reviews: Array<{ verdict: 'approve' | 'reject'; findings: ReviewFinding[]; contextRevision: number }>;
  applyResult?: ApplyResult;
  rawCommit?: string; // internal: postprocess runs only directly on this commit
  tsconfig?: string; // internal: the tsconfig the raw commit was validated with; postprocess reuses it
  postprocessResult?: PostprocessResult;
}
interface Session {
  id: string; workspaceRoot: string; objective: string; allowedPaths: string[]; commitType: CommitType;
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
// Windows env names are case-insensitive, so the key and every overridden name must be dropped under any spelling.
const commandEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !['HARNESS_MODEL_API_KEY', ...Object.keys(extra)].includes(name.toUpperCase()))), ...extra });
// In CI neither vitest nor jest writes new snapshots or watches; colour codes would only clutter the diagnostics.
const TEST_ENV = { CI: '1', FORCE_COLOR: '0' };
const outcome = <Status extends string>(status: Status, ...diagnostics: string[]): Result<Status> => ({ status, diagnostics, changedFiles: [] });
const capped = (label: string, text: string): string => text.length <= DIAGNOSTIC_LIMIT ? `${label}: ${text}`
  : `${label} (truncated to first ${DIAGNOSTIC_LIMIT} of ${text.length} chars): ${text.slice(0, DIAGNOSTIC_LIMIT)}`;
const commandDiagnostics = (result: CommandResult): string[] => [`exit code: ${result.code}`, capped('stdout', result.stdout), capped('stderr', result.stderr)];
const slash = (path: string): string => path.replaceAll('\\', '/');
/** The files apply writes and commits: a file whose content equals its base cannot change, so it is left out altogether. */
const changes = (candidate: Candidate): CandidateFile[] => candidate.files.filter(file => file.content !== (file.base?.content ?? null));
// Files the typecheck must include; others, such as .json, are written and committed without being part of the program.
const TYPESCRIPT = /\.(?:ts|tsx|mts|cts)$/i;
// Test files the apply runs with the package's runner: *.test.* and *.spec.* with a JS or TS extension.
const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const MAX_SUBJECT_OBJECTIVE = 72;
/** Sessions stored before multi-file candidates: the commit type defaults to test and a single-file candidate moves into `files`. */
const upgrade = (state: Session): Session => {
  state.commitType ??= 'test';
  state.candidates = (state.candidates ?? []).map(candidate => {
    if ('files' in candidate) return candidate;
    const { path, content, base, diff, ...rest } = candidate as Omit<Candidate, 'files'> & Omit<CandidateFile, 'edits'>;
    return { ...rest, files: [{ path, base, content, diff }] };
  });
  return state;
};
const samePath = (first: string, second: string): boolean => process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
/**
 * Whether tsc output reports an error in one of the workspace-relative `paths`. tsc runs from the workspace root and prints
 * `path(line,col): error`; errors only in other files come from other, possibly unfinished, work in the developer's tree.
 */
const reportsErrorIn = (result: CommandResult, paths: string[]): boolean => `${result.stdout}\n${result.stderr}`.replaceAll('\\', '/').split(/\r?\n/)
  .some(line => paths.some(path => line[path.length] === '(' && samePath(line.slice(0, path.length), path)));
/**
 * The given files typecheck although others in the program do not (pre-existing errors in a monorepo, unfinished work): tsc finished
 * with real `error TS…` diagnostics and none in `paths`. A failure without diagnostics, such as a crash, never counts as a pass.
 * Assumption: a test file's own errors are reported in the test file, not through global augmentations elsewhere.
 */
const errorsOnlyElsewhere = (result: CommandResult, paths: string[]): boolean =>
  typeof result.code === 'number' && /error TS\d+/.test(`${result.stdout}\n${result.stderr}`) && !reportsErrorIn(result, paths);
const outsideNote = (result: CommandResult): string[] => result.code === 0 ? []
  : [capped('typecheck_errors_outside_target: tsc reports errors only in other files; they were ignored', result.stdout || result.stderr)];
/** File results of a jest-style JSON test report, or undefined when it is missing or unreadable; the report file is removed. */
const readTestReport = (file: string): Array<{ name: string; status: string }> | undefined => {
  try {
    const report: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const entries = (report as { testResults?: unknown })?.testResults;
    if (!Array.isArray(entries)) return undefined;
    return entries.filter((entry): entry is { name: string; status: string } => typeof entry?.name === 'string' && typeof entry?.status === 'string');
  } catch { return undefined; } finally { rmSync(file, { force: true }); }
};
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
        const state = upgrade(JSON.parse(String(row.state))), apply = state.apply!, candidate = this.candidate(state, apply.candidateId);
        if (POSTPROCESS_BUSY.includes(apply.phase)) {
          apply.phase = this.recoverPostprocess(apply, candidate);
          const outcomes = { postprocessed: 'its commit exists and was kept without re-verification', postprocess_failed: 'raw paths are at the raw commit and postprocess can run again',
            conflict: 'files may be partially formatted or changed externally, or HEAD moved to an unrecognised commit or Git failed, so files were left untouched' };
          this.recordError(state, new SessionError('postprocess_interrupted', `Previous postprocess was interrupted; ${outcomes[apply.phase as keyof typeof outcomes]}.`));
          continue;
        }
        apply.phase = apply.phase === 'committing' ? this.recoverCommit(candidate, apply.head ?? '') : this.restoreAll(changes(candidate)).length ? 'conflict' : 'restored';
        const outcomes = { committed: 'its commit exists and was kept', error: 'its commit exists but differs from the candidate; it was kept unverified',
          restored: 'targets are at their bases', conflict: 'a target changed externally, HEAD moved to an unrecognised commit or Git failed, so the affected files were left untouched' };
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
    const state = upgrade(JSON.parse(String(row.state)));
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
  /** The allowed files as they are now (null: new file): shown to the worker and kept as the bases its edits apply to. */
  private targets(state: Session): Array<{ path: string; base: Snapshot | null }> {
    return state.allowedPaths.map(path => ({ path: slash(path), base: this.targetBase(path) }));
  }
  private prompt(state: Session, message = '', targets = this.targets(state)): string {
    const last = state.turns.findLastIndex(turn => turn.role === 'worker');
    const exchange = last < 0 ? [] : state.turns.slice(last - 1, last + 1);
    const latest = state.candidates.at(-1), problems = state.turns[last]?.problems;
    return JSON.stringify({ objective: state.objective, brief: state.brief,
      acceptanceCriteria: state.acceptanceCriteria, allowedPaths: targets.map(target => target.path), contextRevision: state.contextRevision,
      // Without a BOM: edits match the text after it, and the BOM is kept on write.
      targets: targets.map(({ path, base }) => base ? { path, content: base.content.replace(/^﻿/, '') } : { path, new: true }),
      // Targets are sent whole, so a context snapshot of the same file would only duplicate them.
      context: state.context.filter(snapshot => !targets.some(target => samePath(target.path, snapshot.path))),
      // As the worker wrote it: its edits refer to the bases of its own generation, not to the current targets.
      ...(latest ? { currentCandidate: { files: latest.files.map(({ path, edits, content }) => edits ? { path, edits } : { path, content }), contextRevision: latest.contextRevision }, previousRequest: exchange[0]?.text }
        : { lastSuccessfulExchange: exchange }),
      // A reply that made no candidate gets its exact problems back; without them the worker repeats the same mistake. With a
      // candidate shown, that reply is not in the exchange above, so it comes along: the problems refer to its edits.
      ...(problems ? { previousReplyProblems: problems, ...(latest ? { previousReply: state.turns[last].text } : {}) } : {}),
      // Feedback must describe the code sent as currentCandidate, so it comes only from the latest candidate.
      openFeedback: latest?.state === 'rejected' ? latest.findings : [],
      outputContract: { instruction: 'Return exactly one JSON object in the format below and nothing else: no Markdown, no other fields. '
        + 'List the files you change; each path must be one of allowedPaths, at most once. An existing target takes "edits" or its complete "content"; a new target (new: true) takes its complete "content". '
        + 'Edits apply to the target snapshots shown in targets, not to currentCandidate: every reply is a complete candidate, so repeat each change you still want. '
        + `Each "search" is 1-${MAX_SEARCH_LINES} complete consecutive lines copied exactly from the target (same indentation, no line numbers) and must occur exactly once; edits of a file apply in order, each to the text left by the previous ones. `
        + 'If edits do not fit, give the complete "content" of the file instead. Never use placeholders such as "..." or "// rest of the code"; write complete code. '
        + 'Implement exactly the listed acceptance criteria: do not add, drop or change any.',
      format: '{"files":[{"path":"<existing target>","edits":[{"search":"<exact lines>","replace":"<new lines>"}]},{"path":"<target>","content":"<complete file>"}]}' },
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
  private candidate(state: Session, id: string): Candidate {
    const candidate = state.candidates.find(candidate => candidate.id === id);
    if (!candidate) throw new SessionError('candidate_not_found', 'Candidate not found in this session.');
    return candidate;
  }
  candidateRead(id: string, candidateId: string): { artifacts: Array<Omit<CandidateFile, 'base'>>; contextRevision: number; currentContextRevision: number; state: string; findings: ReviewFinding[]; reviews: Candidate['reviews'] } {
    const state = this.load(id), candidate = this.candidate(state, candidateId);
    return { artifacts: candidate.files.map(({ path, content, diff, edits }) => ({ path, content, diff, ...(edits ? { edits } : {}) })),
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
  private restore(file: CandidateFile): 'restored' | 'conflict' {
    const base = file.base?.content ?? null;
    if (!this.matches(file.path, file.content)) return this.matches(file.path, base) ? 'restored' : 'conflict';
    // shortcut: compare-then-write leaves a small race with external editors; Git status checks catch most of it.
    const full = this.safePath(file.path, false);
    if (base === null) unlinkSync(full); else writeFileSync(full, base);
    return 'restored';
  }
  /** Restores every file by the restore() rule; returns the paths left untouched, while the others are still restored. */
  private restoreAll(files: CandidateFile[]): string[] {
    return files.filter(file => { try { return this.restore(file) === 'conflict'; } catch { return true; } }).map(file => file.path);
  }
  private run(file: string, args: string[], cwd = this.root, env: Record<string, string> = {}): Promise<CommandResult> {
    return new Promise(resolve => execFile(file, args, { cwd, env: commandEnv(env), timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_OUTPUT_LIMIT, windowsHide: true },
      (error, stdout, stderr) => resolve({ code: !error ? 0 : error.killed ? `killed (${error.signal ?? 'timeout or output limit'})` : error.code ?? 'failed', stdout, stderr })));
  }
  /** Unstages only this file; a new file is dropped from the index, since `restore --staged` fails for paths absent from HEAD. */
  private unstageArgs(file: CandidateFile): string[] {
    return file.base === null ? ['--literal-pathspecs', 'rm', '--cached', '--quiet', '--ignore-unmatch', '--', file.path]
      : ['--literal-pathspecs', 'restore', '--staged', '--', file.path];
  }
  /** Sync Git for the constructor and exception paths. */
  private git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.root, env: commandEnv(), encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_OUTPUT_LIMIT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  /** Sync because the constructor and the exception path need it. Once HEAD has moved, files are never restored: they may be committed. */
  private recoverCommit(candidate: Candidate, head: string): 'committed' | 'restored' | 'conflict' | 'error' {
    const written = changes(candidate);
    try {
      const current = this.git('rev-parse', 'HEAD').trim();
      if (current !== head) {
        const ours = this.git('rev-parse', 'HEAD^').trim() === head && this.git('log', '-1', '--format=%B', 'HEAD').includes(`${CANDIDATE_TRAILER}: ${candidate.id}`);
        if (!ours) return 'conflict';
        const files = this.git('diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD').split('\0').filter(Boolean);
        // The candidate passed the typecheck before the commit, so an exact match of its written files is verified; anything else is not.
        // The count check matters on Windows, as in committedResult; blobs are read by Git's own spelling.
        const exact = files.length === written.length && written.every(file => {
          const name = files.find(path => samePath(path, file.path));
          return name !== undefined && this.git('show', `HEAD:${name}`) === file.content;
        });
        if (exact) {
          candidate.applyResult = { status: 'committed', diagnostics: ['recovered_after_crash: the apply was interrupted after Git created its commit; the commit holds exactly the candidate and was kept.'], changedFiles: written.map(file => file.path) };
          candidate.rawCommit = current;
          return 'committed';
        }
        candidate.applyResult = { status: 'error', diagnostics: [`committed_unverified: the apply was interrupted after Git created its commit, which differs from the candidate or touches other paths; it was kept and not typechecked: ${files.join(', ') || 'no paths'}`], changedFiles: files };
        return 'error';
      }
      for (const file of written) this.git(...this.unstageArgs(file));
    } catch { return 'conflict'; }
    return this.restoreAll(written).length ? 'conflict' : 'restored';
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
      // Tools may have written without recorded hashes: only an unchanged target is known to be untouched.
      if (apply.phase === 'postprocessing') {
        return statusPaths(this.git('status', '--porcelain=v1', '-z', '--untracked-files=all')).some(path => changes(candidate).some(file => samePath(path, file.path))) ? 'conflict' : 'postprocess_failed';
      }
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
  /**
   * Runs tsc only when the trusted config includes every TypeScript file of the workspace-relative `paths`: a typecheck without them
   * is not validation. `missing` names those it lacks; a failed listing proves nothing, so then every path is missing.
   */
  private async typecheck(tsc: string, tsconfig: string, paths: string[]): Promise<{ listed: CommandResult; missing: string[]; checked?: CommandResult }> {
    const listed = await this.run(process.execPath, [tsc, '--listFilesOnly', '-p', tsconfig]);
    const program = listed.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const missing = listed.code !== 0 ? paths : paths.filter(path => TYPESCRIPT.test(path)).filter(path => {
      const target = realpathSync(this.safePath(path, false));
      return !program.some(line => samePath(basename(line), basename(target)) && samePath(realpathSync(line), target));
    });
    return { listed, missing, checked: missing.length ? undefined : await this.run(process.execPath, [tsc, ...TYPECHECK_FLAGS, '-p', tsconfig]) };
  }
  /**
   * Judges `commit`, the commit just made on `head`, from the expected files; nothing here reverts it, since history is never rewritten.
   * Uses the SHA, not the symbolic HEAD: the developer may commit while the typecheck below runs. A re-typecheck after hook changes
   * requires and judges the `required` paths, as the check before the commit did.
   */
  private async committedResult(head: string, commit: string, expected: Array<{ path: string; content: string }>, baseline: string[], tsc: string, tsconfig: string, required: string[]): Promise<Result<'committed' | 'error'>> {
    const parent = await this.run('git', ['rev-parse', '--verify', `${commit}^`]), paths = expected.map(file => file.path);
    const files = (await this.run('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commit])).stdout.split('\0').filter(Boolean);
    // Exactly the expected paths, no fewer and no more. The count check matters on Windows: case variants of one path would each pass samePath.
    if (parent.stdout.trim() !== head || files.length !== paths.length || files.some(file => !paths.some(path => samePath(path, file)))) {
      return { status: 'error', diagnostics: [`commit_scope_violation: HEAD is not a commit of only the expected paths on the pre-commit HEAD; nothing was reverted: ${files.join(', ') || 'no paths'}`], changedFiles: files };
    }
    // Only changes that were not there before the commit can come from hooks; the developer's other work is not counted.
    const left = (await this.changedPaths() ?? ['(Git status unavailable)']).filter(path => !baseline.some(before => samePath(before, path)));
    const leftDiagnostics = left.length ? [`hooks_left_changes: hooks left uncommitted changes that were not touched: ${left.join(', ')}`] : [];
    // Plain blob bytes as UTF-8: with core.autocrlf the blob is normalized, so a CRLF file shows as modified rather than slipping through.
    // Git's own spelling: tree lookups are case-sensitive even on Windows.
    const blobs = await Promise.all(expected.map(file => this.run('git', ['show', `${commit}:${files.find(path => samePath(path, file.path)) ?? file.path}`])));
    const modified = expected.filter((file, index) => blobs[index].code !== 0 || blobs[index].stdout !== file.content);
    if (!modified.length) return { status: 'committed', diagnostics: leftDiagnostics, changedFiles: paths };
    const diff = capped('hooks_modified: hooks changed committed files; diff expected -> committed',
      modified.map(file => unifiedDiff(file.path, file.content, blobs[expected.indexOf(file)].stdout)).join(''));
    if (modified.some(file => blobs[expected.indexOf(file)].code !== 0) || left.length) {
      return { status: 'error', diagnostics: ['committed_unverified: hooks changed or removed committed files and the worktree differs from HEAD, so the commit was not typechecked; nothing was reverted.', diff, ...leftDiagnostics], changedFiles: paths };
    }
    // Only the typecheck is repeated, never the tests: hooks must not change behaviour.
    const { listed, checked } = await this.typecheck(tsc, tsconfig, required);
    // Errors only in other files are not the hooks' doing: the committed files themselves still typecheck.
    if (checked && (checked.code === 0 || errorsOnlyElsewhere(checked, required))) {
      return { status: 'committed', diagnostics: [diff, ...outsideNote(checked)], changedFiles: paths, hooksModified: true };
    }
    return { status: 'error', diagnostics: ['hooks_broke_typecheck: the hook-modified commit fails the typecheck; it stays in history and nothing was reverted.', ...commandDiagnostics(checked ?? listed), diff], changedFiles: paths };
  }
  /**
   * Refuses when the index holds anything: the commit takes the whole index, and hooks like lint-staged act on staged files,
   * so the developer's staged work would end up in the commit. Unstaged and untracked work may stay.
   */
  private async stagedConflict(): Promise<Result<'conflict' | 'error'> | undefined> {
    const paths = await this.staged();
    if (!paths) return outcome('error', 'git_unavailable: could not read the Git index.');
    return paths.length ? outcome('conflict', `index_not_clean: unstage or commit staged changes first; the commit would include them: ${paths.join(', ')}`) : undefined;
  }
  /** Staged paths outside the store directory, or null when the index cannot be read. */
  private async staged(): Promise<string[] | null> {
    const staged = await this.run('git', ['diff', '--cached', '--name-only', '-z']);
    return staged.code === 0 ? staged.stdout.split('\0').filter(path => path && path !== STORE_DIR && !path.startsWith(`${STORE_DIR}/`)) : null;
  }
  /**
   * Why the index does not hold exactly `own`, checked right before a commit: anything staged meanwhile would ride along in it,
   * and an own file no longer staged would miss it. Empty when the index is as expected.
   */
  private async indexMismatch(own: string[]): Promise<string[]> {
    const index = await this.staged();
    if (!index) return ['(Git index unreadable)'];
    return [...index.filter(path => !own.some(mine => samePath(mine, path))),
      ...own.filter(mine => !index.some(path => samePath(mine, path))).map(mine => `${mine} (not staged)`)];
  }
  /** Uncommitted paths (from `baseline`) inside the typechecked program, besides `own`: the check saw them, the commit will not include them. */
  private dirtyInProgram(listed: CommandResult, baseline: string[], own: string[]): string[] {
    const program = listed.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => resolve(line));
    return baseline.filter(path => !own.some(mine => samePath(mine, path)) && program.some(file => samePath(file, resolve(this.root, path))));
  }
  /** Changed paths outside the store directory, or null when the workspace is not the root of a usable Git repository. */
  private async changedPaths(): Promise<string[] | null> {
    const top = await this.run('git', ['rev-parse', '--show-toplevel']);
    if (top.code !== 0 || !samePath(realpathSync(top.stdout.trim()), this.root)) return null;
    const status = await this.run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    return status.code === 0 ? statusPaths(status.stdout) : null;
  }
  async candidateApply(id: string, candidateId: string, tsconfigPath?: string, packageDir?: string): Promise<ApplyResult> {
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
    const config = this.tsconfigFile(tsconfigPath ?? this.tsconfig), tsconfig = config.full, pkg = this.packageDirectory(packageDir, config.path);
    // Every candidate file is checked and judges the typecheck; only the changed ones are written and committed.
    const paths = candidate.files.map(file => file.path), written = changes(candidate), writtenPaths = written.map(file => file.path);
    // The runner only finds tests inside its package, and the tests run from it.
    const testPaths = this.inPackage(pkg, paths.filter(path => TEST_FILE.test(path)));
    if (testPaths.outside.length) return outcome('error', `outside_package_dir: ${testPaths.outside.join(', ')} is not inside ${pkg.rel}; pass the tests' package as packageDir.`);
    // vitest takes no `--` before its file filters, so a path starting with "-" would be read as a runner option.
    const optionLike = testPaths.relative.filter(path => path.startsWith('-'));
    if (optionLike.length) return outcome('error', `invalid_test_path: ${optionLike.join(', ')} would be read as a test runner option; rename the test file.`);
    this.applyRunning = true;
    try {
      // Other unstaged or untracked work may stay: only the targets must be untouched and the index empty.
      const baseline = await this.changedPaths();
      if (!baseline) return outcome('error', 'git_unavailable: the workspace must be the root of a Git repository and git must be runnable.');
      const dirty = paths.filter(path => baseline.some(before => samePath(before, path)));
      if (dirty.length) return outcome('conflict', `target_dirty: commit or remove the uncommitted changes in these targets first: ${dirty.join(', ')}`);
      const staged = await this.stagedConflict();
      if (staged) return staged;
      ({ state, candidate } = approved()); // re-read: the session may have changed while Git ran
      const changedContext = state.context.filter(snapshot => !this.matches(snapshot.path, snapshot.content)).map(snapshot => snapshot.path);
      if (changedContext.length) return outcome('conflict', `context_changed: refresh context and regenerate: ${changedContext.join(', ')}`);
      const changedTargets = candidate.files.filter(file => !this.matches(file.path, file.base?.content ?? null)).map(file => file.path);
      if (changedTargets.length) return outcome('conflict', `target_changed: these targets differ from their generation-time bases: ${changedTargets.join(', ')}`);
      const homeless = paths.filter(path => !statSync(dirname(this.safePath(path, false)), { throwIfNoEntry: false })?.isDirectory());
      if (homeless.length) return outcome('error', `missing_directory: the parent directory must already exist for: ${homeless.join(', ')}`);
      if (!written.length) return outcome('no_changes');
      const tsc = this.tscPath(dirname(tsconfig));
      if (!tsc) return outcome('error', `typescript_not_found: no typescript package resolves from ${config.path}.`);
      const journal = (phase: ApplyPhase, head?: string): void => { state.apply = { candidateId, phase, head }; this.save(state); };
      // Set before staging and never cleared: the exception path must not trust the in-memory phase, which journal() changes before saving.
      let committingHead: string | undefined;
      journal('applying');
      try {
        for (const file of written) writeFileSync(this.safePath(file.path, false), file.content, { flag: file.base === null ? 'wx' : 'w' });
        journal('validating');
        const { listed, missing, checked } = await this.typecheck(tsc, tsconfig, paths);
        // The check sees the developer's uncommitted files, the commit does not: say so on success, and never burn the candidate on failure.
        const uncommitted = this.dirtyInProgram(listed, baseline, paths);
        const uncommittedNote = uncommitted.length ? [`validated_with_uncommitted: the typecheck included uncommitted files, so the raw commit may not compile without them: ${uncommitted.join(', ')}`] : [];
        let failure: ApplyResult, final = false;
        const typechecked = checked && (checked.code === 0 || errorsOnlyElsewhere(checked, paths));
        // Tests run only after a passing typecheck and before the change check, which then also catches files they write.
        const tested = typechecked ? await this.runTests(testPaths.relative, pkg) : undefined;
        if (!checked) {
          failure = outcome('error', `target_not_in_typecheck: tsc --listFilesOnly -p ${config.path} does not include ${missing.join(', ')}; a typecheck without the candidate's TypeScript files is not validation. Apply again with the tsconfig of the targets' package.`, ...(listed.code === 0 ? [] : commandDiagnostics(listed)));
        } else if (tested?.failure) {
          // Never final: a flake or unfinished work elsewhere may cause it, so the supervisor decides. Files the failed run left behind
          // are named now: on a retry they would already be in the baseline and pass unnoticed.
          const leftovers = (await this.changedPaths() ?? []).filter(path => !writtenPaths.some(mine => samePath(mine, path)) && !baseline.some(before => samePath(before, path)));
          failure = leftovers.length ? { ...tested.failure, diagnostics: [...tested.failure.diagnostics, `test_left_changes: the failed test run left these changes, which were not reverted: ${leftovers.join(', ')}`] } : tested.failure;
        } else if (typechecked) {
          // Passed: the candidate files have no type errors. Errors only in other files (user decision: pre-existing or unfinished work
          // in a monorepo) are reported, not blocking. New changes besides the targets (paths not dirty before) mean validation wrote files,
          // and every written file must show as changed (one ignored by Git would silently miss the commit).
          const status = await this.changedPaths(), changed = status ?? [];
          // Only written files may change: an unchanged candidate file edited meanwhile was typechecked but would miss the commit.
          const foreign = changed.filter(path => !writtenPaths.some(mine => samePath(mine, path)) && !baseline.some(before => samePath(before, path)));
          const unseen = writtenPaths.filter(mine => !changed.some(path => samePath(mine, path)));
          // A test run may rewrite a candidate file; the commit would then hold code that was neither reviewed nor checked.
          const rewritten = written.filter(file => !this.matches(file.path, file.content)).map(file => file.path);
          if (foreign.length || unseen.length || rewritten.length) {
            journal('error');
            const found = status ? [...foreign, ...unseen.map(path => `${path} (shows no change)`), ...rewritten.map(path => `${path} (no longer the candidate's content)`)].join(', ') : 'Git status unavailable';
            return { status: 'error', diagnostics: [`unexpected_changes: validation passed but new changes besides the targets appeared or a written target shows no change; nothing was reverted: ${found}`], changedFiles: changed };
          }
          const head = await this.run('git', ['rev-parse', '--verify', 'HEAD']);
          if (head.code !== 0) {
            failure = outcome('error', 'head_unavailable: the repository needs an initial commit to commit the candidate on.', ...commandDiagnostics(head));
          } else {
            committingHead = head.stdout.trim();
            candidate.tsconfig = config.path; // saved with the journal, so a commit recovered after a crash keeps it too
            journal('committing', committingHead);
            const added = await this.run('git', ['--literal-pathspecs', 'add', '--', ...writtenPaths]);
            const sneaked = added.code === 0 ? await this.indexMismatch(writtenPaths) : [];
            // Cut by code points: a UTF-16 cut could split an emoji into a lone surrogate, which becomes U+FFFD in the commit.
            const objective = Array.from(state.objective.trim().split(/\r?\n/)[0]).slice(0, MAX_SUBJECT_OBJECTIVE).join('').trimEnd();
            const commit = added.code !== 0 ? added : sneaked.length ? undefined
              // A plain commit of the index, which holds only the written files (checked above). A pathspec commit would run hooks on a
              // temporary index, so changes re-staged by hooks such as lint-staged would miss the real index.
              : await this.run('git', ['commit', '-m', `${state.commitType}: ${objective}`, '-m', `${CANDIDATE_TRAILER}: ${candidateId}`]);
            // A killed or timed-out git (e.g. a slow post-commit hook) may still have created the commit: HEAD decides, not the exit code.
            // Captured at once: later checks and postprocess must judge this commit even if the developer commits meanwhile.
            const created = commit && added.code === 0 ? (await this.run('git', ['rev-parse', '--verify', 'HEAD'])).stdout.trim() : committingHead;
            const moved = commit !== undefined && commit.code !== 0 && created !== committingHead;
            if (commit && (commit.code === 0 || moved)) {
              // Every post-commit outcome is final: the commit stays in history and a retry must not commit again.
              const judged = await this.committedResult(committingHead, created, written, baseline, tsc, tsconfig, paths);
              if (judged.status === 'committed') candidate.rawCommit = created;
              const prefix = moved ? ['commit_exit_nonzero: git reported a failure after creating the commit; the commit was kept.', ...commandDiagnostics(commit)] : [];
              candidate.applyResult = { ...judged, diagnostics: [...prefix, ...judged.diagnostics, ...uncommittedNote, ...outsideNote(checked), ...tested?.notes ?? []] };
              journal(candidate.applyResult.status === 'committed' ? 'committed' : 'error');
              return candidate.applyResult;
            }
            const unstageNotes: string[] = [];
            for (const file of written) {
              const unstaged = await this.run('git', this.unstageArgs(file));
              if (unstaged.code !== 0) unstageNotes.push(`unstage_failed: ${file.path} may still be staged.`, ...commandDiagnostics(unstaged));
            }
            failure = commit ? outcome('error', 'commit_failed: Git or a hook refused the commit; the candidate files were unstaged and the candidate can be applied again.', ...commandDiagnostics(commit), ...unstageNotes)
              : outcome('conflict', `index_not_clean: the index changed during the apply and does not hold exactly the candidate files: ${sneaked.join(', ')}; other staged paths stay staged, the candidate files were unstaged, and the candidate can be applied again.`, ...unstageNotes);
          }
        } else {
          // Only real tsc errors in the candidate files judge the candidate. A timeout, kill or failure without diagnostics must not burn it.
          const completed = typeof checked.code === 'number', inTarget = completed && reportsErrorIn(checked, paths);
          // Errors in the candidate files are its fault only when no uncommitted file in the program could cause them.
          final = inTarget && !uncommitted.length;
          failure = final ? outcome('validation_failed', ...commandDiagnostics(checked))
            : inTarget ? outcome('error', `typecheck_failed_with_uncommitted: tsc reports errors in the candidate files while the program includes uncommitted files that may cause them (${uncommitted.join(', ')}); finish or commit that work, then apply the same candidate again.`, ...commandDiagnostics(checked))
            : completed ? outcome('error', 'typecheck_unrecognized: tsc failed without error diagnostics (e.g. it crashed), so the candidate cannot be judged; the candidate can be applied again.', ...commandDiagnostics(checked))
            : outcome('error', 'typecheck_not_completed: tsc did not finish; the candidate can be applied again.', ...commandDiagnostics(checked));
        }
        const left = this.restoreAll(written);
        if (left.length) failure = outcome('conflict', ...failure.diagnostics, `restore_conflict: ${left.join(', ')} changed during validation and was left untouched.`);
        if (final) candidate.applyResult = failure; // a completed typecheck is final for this immutable candidate
        journal(left.length ? 'conflict' : failure.status === 'error' ? 'error' : 'restored');
        return failure;
      } catch (error: unknown) {
        const phase = committingHead !== undefined ? this.recoverCommit(candidate, committingHead) : this.restoreAll(written).length ? 'conflict' : 'restored';
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
  /**
   * The validation tsconfig: chosen by the orchestrator per apply (one per package in a monorepo) or WORKER_TSCONFIG by default.
   * It is a workspace JSON file, never a command; the --listFilesOnly gate still proves it includes the target.
   */
  private tsconfigFile(path: string | undefined): { path: string; full: string } {
    if (!path?.trim()) throw new SessionError('configuration_error', 'No tsconfig: pass tsconfig (the target package\'s config) or set WORKER_TSCONFIG.');
    if (!/\.json$/i.test(path)) throw new SessionError('invalid_path', 'tsconfig must be a workspace-relative .json file.');
    const full = this.safePath(path, true);
    if (!statSync(full).isFile()) throw new SessionError('invalid_path', 'tsconfig must be a regular file.');
    return { path: path.replaceAll('\\', '/'), full };
  }
  /** The compiler nearest to `dir`, so a package's own typescript wins over a hoisted one. */
  private tscPath(dir: string): string | undefined {
    try { return join(dirname(createRequire(join(dir, 'package.json')).resolve('typescript/package.json')), 'bin', 'tsc'); } catch { return undefined; }
  }
  /** Whether package.json in `dir` or a parent up to the workspace root lists `name` in dependencies or devDependencies. */
  private declared(name: string, dir: string): boolean {
    for (let current = dir; ; current = dirname(current)) {
      const manifest = join(current, 'package.json');
      if (existsSync(manifest)) {
        let parsed: Record<string, Record<string, string> | undefined>;
        try { parsed = JSON.parse(readFileSync(manifest, 'utf8')); } catch {
          throw new SessionError('invalid_package_json', `${relative(this.root, manifest) || 'package.json'} is not valid JSON; cannot tell which tools or test runner the package uses.`);
        }
        if (parsed.dependencies?.[name] || parsed.devDependencies?.[name]) return true;
      }
      if (samePath(current, this.root) || dirname(current) === current) return false;
    }
  }
  /** The package's own bin entry, resolved from `dir` like typescript; walks up node_modules when `exports` hides package.json. */
  private packageBin(name: string, dir: string): string | undefined {
    try {
      let manifest: string;
      try { manifest = createRequire(join(dir, 'package.json')).resolve(`${name}/package.json`); } catch {
        while (!existsSync(manifest = join(dir, 'node_modules', name, 'package.json')) && dirname(dir) !== dir) dir = dirname(dir);
      }
      const bin: unknown = JSON.parse(readFileSync(manifest, 'utf8')).bin;
      const entry = typeof bin === 'string' ? bin : typeof bin === 'object' && bin ? (bin as Record<string, unknown>)[name] : undefined;
      return typeof entry === 'string' ? join(dirname(manifest), entry) : undefined;
    } catch { return undefined; }
  }
  /**
   * The package directory tools and test runners run in and resolve from: `packageDir` or, by default, the directory of the tsconfig
   * used, which is the package in a monorepo.
   */
  private packageDirectory(packageDir: string | undefined, tsconfigPath: string): { rel: string; full: string } {
    const rel = packageDir ?? dirname(tsconfigPath);
    const full = ['.', ''].includes(rel) ? this.root : this.safePath(rel, true);
    if (!statSync(full).isDirectory()) throw new SessionError('invalid_path', 'packageDir must be a workspace directory.');
    return { rel, full };
  }
  /** Workspace-relative `paths` relative to the package directory, and those outside it. */
  private inPackage(pkg: { full: string }, paths: string[]): { relative: string[]; outside: string[] } {
    const inner = paths.map(path => relative(pkg.full, join(this.root, path)));
    return { relative: inner, outside: paths.filter((_, index) => inner[index].startsWith('..') || isAbsolute(inner[index])) };
  }
  /**
   * Runs the candidate's test files (`tests`, relative to the package) with the package's runner, without a shell, from the package
   * directory. A failure is never final.
   * Postprocess and the hook re-typecheck do not run tests again: formatting and hooks must not change behaviour.
   */
  private async runTests(tests: string[], pkg: { rel: string; full: string }): Promise<{ notes: string[]; failure?: ApplyResult }> {
    if (!tests.length) return { notes: ['tests_skipped: no test files in the candidate'] };
    const runner = ['vitest', 'jest'].find(name => this.declared(name, pkg.full));
    if (!runner) return { notes: [`tests_skipped: no vitest or jest declared in package.json of ${pkg.rel} or its parents`] };
    const bin = this.packageBin(runner, pkg.full);
    if (!bin) return { notes: [], failure: outcome('error', `test_runner_not_found: ${runner} is declared in package.json but no package with a bin entry resolves from ${pkg.rel}; install dependencies, then apply the same candidate again.`) };
    // Both runners write a jest-style JSON report ({ testResults: [{ name, status }] }) to a file outside the workspace, so the run is
    // judged by the candidate's own test files: vitest treats paths as substring filters and may run others, which may fail on their own.
    const report = join(tmpdir(), `stateful-worker-tests-${randomUUID()}.json`);
    const args = runner === 'vitest' ? ['run', '--reporter=json', `--outputFile=${report}`] : ['--ci', '--json', `--outputFile=${report}`, '--runTestsByPath'];
    const ran = await this.run(process.execPath, [bin, ...args, ...tests.map(slash)], pkg.full, TEST_ENV);
    const results = readTestReport(report);
    const fail = (message: string): { notes: string[]; failure: ApplyResult } => ({ notes: [], failure: outcome('error',
      `${message} Nothing was committed; the same candidate can be applied again, or a new one generated.`, ...commandDiagnostics(ran)) });
    if (typeof ran.code !== 'number') return fail(`tests_not_completed: ${runner} did not finish.`);
    if (!results) {
      // Unreadable report: fall back to the exit code, which cannot tell the candidate's tests from others.
      return ran.code === 0 ? { notes: [`tests_passed: ${runner} exited 0 (no readable report)`] } : fail(`tests_failed: ${runner} failed and its report could not be read.`);
    }
    const own = tests.map(test => resolve(pkg.full, test));
    const result = (file: string): { name: string; status: string } | undefined => results.find(entry => samePath(resolve(pkg.full, entry.name), file));
    const failed = own.filter(file => result(file)?.status === 'failed'), notRun = own.filter(file => !result(file));
    const rel = (files: string[]): string => files.map(file => slash(relative(pkg.full, file))).join(', ');
    if (failed.length) return fail(`tests_failed: ${runner} reports failing candidate tests: ${rel(failed)}.`);
    if (notRun.length) return fail(`tests_not_run: ${runner} did not run ${rel(notRun)}; check the runner's include/testMatch configuration.`);
    const others = results.filter(entry => entry.status === 'failed' && !own.some(file => samePath(resolve(pkg.full, entry.name), file)));
    return { notes: [`tests_passed: ${runner} ran ${own.length} candidate test file(s)`,
      ...(others.length ? [`tests_failed_elsewhere: other test files run by the filter failed and were ignored: ${others.map(entry => entry.name).join(', ')}`] : [])] };
  }
  /** Runs the trusted fix tools on the raw commit's paths only and commits their changes separately after a passing typecheck. */
  async postprocess(id: string, packageDir?: string): Promise<PostprocessResult> {
    const committed = (): { state: Session; candidate: Candidate; raw: string } => {
      const state = this.ready(id), candidate = state.apply && this.candidate(state, state.apply.candidateId);
      if (candidate?.applyResult?.status !== 'committed' || !candidate.rawCommit) {
        throw new SessionError('no_raw_commit', 'postprocess needs a raw commit: the latest candidate_apply of this session must have returned committed.');
      }
      return { state, candidate, raw: candidate.rawCommit };
    };
    let { state, candidate, raw } = committed();
    const rawFiles = changes(candidate).map(file => file.path); // what candidate_apply committed
    // Only final outcomes are stored, so a repeat never runs tools, tsc or Git.
    if (candidate.postprocessResult) return candidate.postprocessResult;
    this.assertNoWriter();
    const names = (this.postprocessTools?.trim() || DEFAULT_POSTPROCESS).split(',').map(name => name.trim()).filter(Boolean);
    if (names.some(name => !Object.hasOwn(POSTPROCESS_ARGS, name))) {
      throw new SessionError('configuration_error', `WORKER_POSTPROCESS may list only these tools, in run order: ${Object.keys(POSTPROCESS_ARGS).join(', ')}.`);
    }
    const config = this.tsconfigFile(candidate.tsconfig ?? this.tsconfig), tsconfig = config.full;
    // Tools run in the package directory: ESLint flat config is looked up from the working directory, and binaries resolve from there.
    // Postprocess never runs tests: formatting must not change behaviour, and candidate_apply ran them on the raw candidate.
    const pkg = this.packageDirectory(packageDir, config.path), packageRel = pkg.rel, packageFull = pkg.full;
    this.applyRunning = true;
    try {
      // Other uncommitted work may stay, as in candidate_apply: only the raw commit's files must be untouched.
      const baseline = await this.changedPaths();
      if (!baseline) return outcome('error', 'git_unavailable: the workspace must be the root of a Git repository and git must be runnable.');
      if ((await this.run('git', ['rev-parse', '--verify', 'HEAD'])).stdout.trim() !== raw) {
        return outcome('conflict', 'head_moved: postprocess runs only directly on top of the raw commit, and HEAD has moved since candidate_apply.');
      }
      const dirty = rawFiles.filter(path => baseline.some(before => samePath(before, path)));
      if (dirty.length) return outcome('conflict', `target_dirty: commit or remove the uncommitted changes in these targets first: ${dirty.join(', ')}`);
      const staged = await this.stagedConflict();
      if (staged) return staged;
      const paths = (await this.run('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', raw])).stdout.split('\0').filter(Boolean);
      const missing = paths.filter(path => { try { return !statSync(this.safePath(path, true)).isFile(); } catch { return true; } });
      if (!paths.length || missing.length) return outcome('error', `raw_paths_unavailable: every path of the raw commit must be a regular file: ${missing.join(', ') || 'no paths'}`);
      // Defence in depth: never format a commit that is not this candidate's raw commit of exactly its files.
      const rawMessage = (await this.run('git', ['log', '-1', '--format=%B', raw])).stdout;
      if (paths.length !== rawFiles.length || paths.some(path => !rawFiles.some(file => samePath(file, path))) || !rawMessage.includes(`${CANDIDATE_TRAILER}: ${candidate.id}`)) {
        return outcome('error', `raw_commit_mismatch: the recorded raw commit is not a commit of exactly this candidate's files; nothing was changed: ${paths.join(', ') || 'no paths'}`);
      }
      // ESLint ignores files outside its base directory, which would silently look like no_changes.
      const { relative: toolPaths, outside } = this.inPackage(pkg, paths);
      if (outside.length) {
        return outcome('error', `outside_package_dir: ${outside.join(', ')} is not inside ${packageRel}; pass the targets' package as packageDir.`);
      }
      // A package without a linter or formatter is normal: such steps are skipped, but a declared tool that is not installed is an error.
      const skipped = names.filter(name => !this.declared(name, packageFull));
      const tools = names.filter(name => !skipped.includes(name)).map(name => ({ name, bin: this.packageBin(name, packageFull) ?? '' }));
      const unresolved = tools.filter(tool => !tool.bin).map(tool => tool.name);
      if (unresolved.length) return outcome('error', `tool_not_found: ${unresolved.join(', ')} is declared in package.json but no package with a bin entry resolves from ${packageRel}; install dependencies first.`);
      const tsc = this.tscPath(dirname(tsconfig));
      if (!tsc) return outcome('error', `typescript_not_found: no typescript package resolves from ${config.path}.`);
      const journal = (phase: ApplyPhase, formatted?: Record<string, string>): void => { state.apply = { candidateId: candidate.id, phase, formatted }; this.save(state); };
      const final = (result: PostprocessResult, phase: ApplyPhase): PostprocessResult => { candidate.postprocessResult = result; journal(phase); return result; };
      // Re-read after the last await, so the busy journal saved next cannot overwrite a concurrent context_set, review or chat.
      ({ state, candidate } = committed());
      journal('postprocessing');
      try {
        const notes = skipped.map(name => `tool_skipped: ${name} is not declared in package.json of ${packageRel} or its parents.`);
        let failure: string[] | undefined;
        for (const { name, bin } of tools) {
          const ran = await this.run(process.execPath, [bin, ...POSTPROCESS_ARGS[name], '--', ...toolPaths], packageFull);
          if (ran.code === 0) continue;
          // eslint exits 1 when it applied its fixes but problems it cannot fix remain; the typecheck still judges the result.
          if (name === 'eslint' && ran.code === 1) { notes.push(capped('lint_problems_remain: eslint applied its fixes; remaining problems', ran.stdout || ran.stderr)); continue; }
          failure = [`tool_failed: ${name} did not complete; nothing was committed.`, ...commandDiagnostics(ran)];
          break;
        }
        const changed = await this.changedPaths();
        if (!changed) { journal('error'); return outcome('error', 'git_unavailable: Git status failed after the tools ran; files were left untouched.'); }
        const foreign = changed.filter(path => !paths.some(rawPath => samePath(rawPath, path)) && !baseline.some(before => samePath(before, path)));
        if (foreign.length) return final({ status: 'error', diagnostics: [`postprocess_scope_violation: tools changed paths outside the raw commit; nothing was reverted: ${foreign.join(', ')}`], changedFiles: foreign }, 'error');
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
          // All raw paths are required and judged, not only the touched ones: formatting one file can break another that imports it.
          const { listed, missing, checked } = await this.typecheck(tsc, tsconfig, paths);
          const uncommitted = this.dirtyInProgram(listed, baseline, paths); // as in candidateApply
          // As in candidateApply: errors only in other files are reported, not blocking.
          if (checked && (checked.code === 0 || errorsOnlyElsewhere(checked, paths))) {
            journal('postprocess_committing', formatted);
            const added = await this.run('git', ['--literal-pathspecs', 'add', '--', ...touched]);
            const sneaked = added.code === 0 ? await this.indexMismatch(touched) : []; // as in candidateApply
            const commit = added.code !== 0 ? added : sneaked.length ? undefined
              : await this.run('git', ['commit', '-m', `style: format ${touched.length === 1 ? touched[0] : `${touched.length} files`}`, '-m', `${POSTPROCESS_TRAILER}: ${candidate.id}`]);
            // As in candidateApply: HEAD, not the exit code, decides whether a commit exists.
            const created = commit && added.code === 0 ? (await this.run('git', ['rev-parse', '--verify', 'HEAD'])).stdout.trim() : raw;
            const moved = commit !== undefined && commit.code !== 0 && created !== raw;
            if (commit && (commit.code === 0 || moved)) {
              const judged = await this.committedResult(raw, created, after, baseline, tsc, tsconfig, paths);
              const prefix = moved ? ['commit_exit_nonzero: git reported a failure after creating the commit; the commit was kept.', ...commandDiagnostics(commit)] : [];
              const uncommittedNote = uncommitted.length ? [`validated_with_uncommitted: the typecheck included uncommitted files: ${uncommitted.join(', ')}`] : [];
              return final({ ...judged, diagnostics: [...prefix, ...judged.diagnostics, ...notes, ...uncommittedNote, ...outsideNote(checked)] }, judged.status === 'committed' ? 'postprocessed' : 'error');
            }
            const unstaged = await this.run('git', ['--literal-pathspecs', 'restore', '--staged', '--', ...touched]);
            const unstageNotes = unstaged.code === 0 ? [] : [`unstage_failed: ${touched.join(', ')} may still be staged.`, ...commandDiagnostics(unstaged)];
            failure = commit ? ['commit_failed: Git or a hook refused the postprocess commit; the raw commit stays and postprocess can run again.', ...commandDiagnostics(commit), ...unstageNotes]
              : [`index_not_clean: the index changed during postprocess and does not hold exactly the formatted files: ${sneaked.join(', ')}; other staged paths stay staged and postprocess can run again.`, ...unstageNotes];
          } else if (!checked) {
            failure = [`target_not_in_typecheck: tsc --listFilesOnly -p ${config.path} does not include ${missing.join(', ')}; a typecheck without the raw commit's TypeScript files is not validation.`, ...(listed.code === 0 ? [] : commandDiagnostics(listed))];
          } else {
            // Only real tsc errors in the raw commit's files, with no uncommitted file in the program to blame, judge the formatting.
            const inTouched = typeof checked.code === 'number' && reportsErrorIn(checked, paths);
            completed = inTouched && !uncommitted.length;
            failure = [completed ? 'postprocess_broke_typecheck: the formatted files fail the typecheck; nothing was committed and the raw commit stays.'
              : inTouched ? `typecheck_failed_with_uncommitted: the formatted files fail the typecheck while the program includes uncommitted files that may cause it (${uncommitted.join(', ')}); finish or commit that work and run postprocess again.`
              : typeof checked.code === 'number' ? 'typecheck_unrecognized: tsc failed without error diagnostics (e.g. it crashed); postprocess can run again.'
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
  start(input: { objective: string; allowedPaths: string[]; acceptanceCriteria?: string[]; commitType?: CommitType }): { sessionId: string } {
    if (!input.allowedPaths.length || input.allowedPaths.length > MAX_ALLOWED_PATHS) throw new SessionError('invalid_path', `Give 1-${MAX_ALLOWED_PATHS} allowed target paths.`);
    input.allowedPaths.forEach(path => this.safePath(path, false));
    const allowedPaths = input.allowedPaths.map(slash);
    if (allowedPaths.some((path, index) => allowedPaths.findIndex(other => samePath(other, path)) !== index)) throw new SessionError('invalid_path', 'Allowed target paths must be distinct.');
    const state: Session = { id: randomUUID(), workspaceRoot: this.root, objective: input.objective, allowedPaths, commitType: input.commitType ?? 'test',
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
  async workerChat(id: string, message: string): Promise<{ candidateId?: string; artifacts?: Array<Pick<CandidateFile, 'path' | 'content' | 'edits'>>; candidateDiagnostics?: Problem[]; responsePreview?: string; finishReason: 'stop'; usage: { inputTokens: number | null; outputTokens: number | null }; estimatedInputTokens: number; warnings: string[]; estimateMethod: string }> {
    const state = this.ready(id);
    try {
      if (!state.contextRevision || !state.brief.trim() || !state.context.length) throw new SessionError('context_not_ready', 'Set context before inference.');
      // Read once: the worker's edits must apply to exactly the snapshots it was shown.
      const targets = this.targets(state), prompt = this.prompt(state, message, targets), budget = this.budget(prompt);
      state.pending = true;
      state.turns.push({ role: 'supervisor', text: message, contextRevision: state.contextRevision });
      this.save(state);
      const response = await chat(this.config, prompt, OUTPUT_RESERVE);
      if (!response.ok) throw new SessionError(response.error.code, response.error.message);
      state.pending = false;
      const parsed = parseCandidate(response.text, targets, MAX_FILE_BYTES), problems = 'problems' in parsed ? parsed.problems : undefined;
      state.turns.push({ role: 'worker', text: response.text, contextRevision: state.contextRevision, ...(problems ? { problems } : {}) });
      let created: Candidate | undefined;
      if ('files' in parsed) state.candidates.push(created = { id: randomUUID(), files: parsed.files, contextRevision: state.contextRevision, state: 'draft', findings: [], reviews: [] });
      for (const problem of problems ?? []) state.errors.push({ code: problem.code, message: problem.message, contextRevision: state.contextRevision });
      this.save(state);
      // A candidate is returned as readable code; the raw JSON reply stays in turns and is shown only when it failed to parse.
      return { ...(created ? { candidateId: created.id, artifacts: created.files.map(({ path, content, edits }) => ({ path, content, ...(edits ? { edits } : {}) })) }
        : { candidateDiagnostics: problems, responsePreview: response.text }),
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
