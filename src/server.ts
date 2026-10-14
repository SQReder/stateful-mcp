import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { SessionError, SessionStore } from './sessions.js';
import { chat, ConfigurationError, readConfig } from './worker.js';

const server = new McpServer({ name: 'stateful-coding-worker', version: '0.1.0' });
let sessions: SessionStore | undefined;
process.once('exit', () => sessions?.close());

// The project is the Git repository the MCP process starts in, computed once at launch; it is never configured or a tool argument.
// Outside a repository there is no safe place for the store, so session tools refuse instead of guessing.
const workspace: { root: string } | { error: string } = (() => {
  try {
    return { root: execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() };
  } catch {
    return { error: `Start the MCP server inside the project's Git repository; ${process.cwd()} is not in one.` };
  }
})();

function result(value: Record<string, unknown>, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError };
}

server.registerTool('worker_diagnostics', {
  description: 'Check local worker configuration without contacting the model or exposing credentials.',
  inputSchema: z.object({}).strict(),
  annotations: { readOnlyHint: true, openWorldHint: false },
}, () => {
  try {
    const config = readConfig();
    return result({ configured: true, model: config.model, timeoutMs: config.timeoutMs, stage: 'F3',
      ...('root' in workspace ? { workspaceRoot: workspace.root } : { workspaceError: workspace.error }) });
  } catch (error: unknown) {
    if (!(error instanceof ConfigurationError)) throw error;
    return result({ configured: false, error: { code: 'configuration_error', message: error.message } }, true);
  }
});

server.registerTool('worker_instruct', {
  description: 'Make exactly one stateless text-only model request without project access. Use worker_chat for a persisted session.',
  inputSchema: z.object({ message: z.string().refine(value => value.trim().length > 0, 'Message must not be blank.') }).strict(),
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ message }) => {
  try {
    const response = await chat(readConfig(), message);
    return result(response, !response.ok);
  } catch (error: unknown) {
    if (!(error instanceof ConfigurationError)) throw error;
    return result({ ok: false, error: { code: 'configuration_error', message: error.message } }, true);
  }
});

async function sessionResult(operation: (store: SessionStore) => Record<string, unknown> | Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    if (!sessions) {
      if ('error' in workspace) throw new ConfigurationError(workspace.error);
      sessions = new SessionStore(workspace.root, readConfig(), process.env.WORKER_TSCONFIG, process.env.WORKER_POSTPROCESS);
    }
    return result(await operation(sessions));
  } catch (error: unknown) {
    const known = error instanceof SessionError || error instanceof ConfigurationError;
    return result({ error: { code: error instanceof SessionError ? error.code : known ? 'configuration_error' : 'session_operation_failed',
      message: known ? error.message : 'Session operation failed; check trusted workspace/storage configuration.' } }, true);
  }
}

const text = z.string().refine(value => value.trim().length > 0, 'Must not be blank.');
server.registerTool('session_start', {
  description: 'Start a durable session for 1-8 distinct workspace-relative target files (existing or new) the worker may change; does not write source files. '
    + 'Existing targets are sent to the worker whole on every turn and count towards the input budget. commitType (test, feat or fix; default test) prefixes the raw commit subject.',
  inputSchema: z.object({ objective: text, allowedPaths: z.array(text).min(1).max(8), acceptanceCriteria: z.array(text).optional(), commitType: z.enum(['test', 'feat', 'fix']).optional() }).strict(),
}, input => sessionResult(store => store.start(input)));

server.registerTool('context_set', {
  description: 'Explicitly replace selected source snapshots, brief and the agreed acceptance criteria (one scenario per item; the worker implements exactly this list); increments revision, checks estimated budget without truncation.',
  inputSchema: z.object({ sessionId: text, files: z.array(text).min(1), brief: text, acceptanceCriteria: z.array(text).min(1) }).strict(),
}, ({ sessionId, ...input }) => sessionResult(store => store.contextSet(sessionId, input)));

server.registerTool('worker_chat', {
  description: 'One inference using selected context, the current target files, latest candidate once and its findings if it was rejected. '
    + 'The worker returns search/replace edits for existing targets or complete content; a valid reply becomes a new candidate returned as candidateId plus artifacts [{path, content (resulting full file), edits?}], ready for review without candidate_read. '
    + 'If any edit or file is invalid, no candidate is created: the reply returns responsePreview and candidateDiagnostics (code, path, edit index, hint), which are also sent to the worker on the next worker_chat. Never applies code.',
  inputSchema: z.object({ sessionId: text, message: text }).strict(),
}, ({ sessionId, message }) => sessionResult(store => store.workerChat(sessionId, message)));

server.registerTool('session_status', {
  description: 'Compact session status; includeDetails explicitly reveals full stored brief, snapshots, turns and errors.',
  inputSchema: z.object({ sessionId: text, includeDetails: z.boolean().optional() }).strict(),
  annotations: { readOnlyHint: true, openWorldHint: false },
}, ({ sessionId, includeDetails }) => sessionResult(store => {
  const status = store.status(sessionId), { details, ...summary } = status;
  return { ...summary, turnCount: details.turns.length, errorsCount: details.errors.length, candidateCount: details.candidates.length, ...(includeDetails ? { details } : {}) };
}));

server.registerTool('candidate_read', {
  description: 'Read one immutable candidate as artifacts [{path, content, diff, edits?}] (resulting full files with minimal unified diffs from their generation-time bases) and its review history; for older versions, diffs or after a restart. Not needed right after worker_chat, which already returns the code. Does not read current source files.',
  inputSchema: z.object({ sessionId: text, candidateId: text }).strict(),
  annotations: { readOnlyHint: true, openWorldHint: false },
}, ({ sessionId, candidateId }) => sessionResult(store => store.candidateRead(sessionId, candidateId)));

server.registerTool('candidate_review', {
  description: 'Explicitly approve or reject one candidate on the current context revision; append findings to review history. Findings of a rejected latest candidate are sent with it to the next worker_chat.',
  inputSchema: z.object({ sessionId: text, candidateId: text, verdict: z.enum(['approve', 'reject']),
    findings: z.array(z.object({ severity: z.enum(['blocker', 'major', 'minor']), message: text, location: text.optional() }).strict()) }).strict(),
}, ({ sessionId, candidateId, verdict, findings }) => sessionResult(store => store.candidateReview(sessionId, candidateId, verdict, findings)));

server.registerTool('candidate_apply', {
  description: 'Write one approved, current-revision candidate (all its files that differ from their bases) into the Git workspace and typecheck it with the tsc nearest to the chosen tsconfig. '
    + 'tsconfig: workspace-relative .json of the targets\' package (needed in monorepos); default WORKER_TSCONFIG. It must include every TypeScript file of the candidate, otherwise error target_not_in_typecheck, which can be retried with another tsconfig. '
    + 'After a passing typecheck runs every test file of the candidate (*.test.* / *.spec.*, JS or TS) with the package\'s runner, without a shell, from packageDir with CI=1: vitest run if declared in package.json of packageDir or a parent, else jest --ci --runTestsByPath. '
    + 'packageDir: workspace-relative directory of the tests\' package; default: the directory of the tsconfig. Test files outside it give error outside_package_dir before anything is written. '
    + 'The run is judged from the runner\'s JSON report for the candidate\'s own test files: diagnostics note tests_passed (plus tests_failed_elsewhere when other tests matched by the filter failed), or tests_skipped when the candidate has no test files or no runner is declared. '
    + 'Error tests_failed (candidate tests failed, runner output included), tests_not_run (the runner did not run a candidate test; check include/testMatch), tests_not_completed (timeout or kill) or test_runner_not_found (declared, not installed) restores the files and is not final: the same candidate may be applied again or a new one generated. '
    + 'Files the test run writes (snapshots, coverage) or candidate files it rewrites give error unexpected_changes; nothing is reverted. '
    + 'On success stages only the candidate files and creates one local commit "<commitType>: <objective>" with Git hooks enabled (no push). '
    + 'Returns status committed (hooksModified: true plus a candidate->committed diff when hooks changed files and they passed the typecheck again), validation_failed (diagnostics, files restored), conflict (dirty or changed targets, changed snapshots or external edits; nothing overwritten), no_changes or error. '
    + 'Error commit_failed (e.g. a hook refused) restores the files and may be retried; commit_scope_violation and hooks_broke_typecheck keep the commit and are final. '
    + 'Session/candidate refusals (not approved, stale, busy, missing configuration) are tool errors with a code and write nothing. A failed typecheck is final: generate and review a new one. Repeating a finished apply returns the stored result without a new commit.',
  inputSchema: z.object({ sessionId: text, candidateId: text, tsconfig: text.optional(), packageDir: text.optional() }).strict(),
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ sessionId, candidateId, tsconfig, packageDir }) => sessionResult(store => store.candidateApply(sessionId, candidateId, tsconfig, packageDir)));

server.registerTool('postprocess', {
  description: 'After candidate_apply returned committed and directly on top of that raw commit in a clean tree: run eslint --fix and prettier --write (order from WORKER_POSTPROCESS, default eslint then prettier) on the raw commit\'s paths only, re-run the typecheck and create a separate style commit with Git hooks enabled (no push). '
    + 'A tool runs only if package.json of packageDir or a parent declares it (any ESLint/Prettier version); undeclared tools are skipped with tool_skipped, declared but uninstalled ones give tool_not_found. '
    + 'Returns status committed, no_changes, failed (tool or typecheck failure; files returned to the raw commit, which always stays), conflict (moved HEAD, dirty tree or files changed meanwhile; nothing overwritten) or error (e.g. postprocess_scope_violation when a tool touched other paths; nothing reverted). '
    + 'eslint exit 1 keeps its fixes and adds lint_problems_remain. Repeating a finished postprocess returns the stored result; commit_failed and tool failures can be retried. '
    + 'packageDir: workspace-relative directory of the target\'s package where the tools run and resolve (ESLint finds its config from there); default: the directory of the tsconfig used by candidate_apply. The typecheck reuses that tsconfig.',
  inputSchema: z.object({ sessionId: text, packageDir: text.optional() }).strict(),
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ sessionId, packageDir }) => sessionResult(store => store.postprocess(sessionId, packageDir)));

await server.connect(new StdioServerTransport());
