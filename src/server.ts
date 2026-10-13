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
    return result({ configured: true, model: config.model, timeoutMs: config.timeoutMs, stage: 'I4',
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
  description: 'Start a durable session for one allowed test file; does not write source files.',
  inputSchema: z.object({ objective: text, allowedPaths: z.array(text).length(1), acceptanceCriteria: z.array(text).optional() }).strict(),
}, input => sessionResult(store => store.start(input)));

server.registerTool('context_set', {
  description: 'Explicitly replace selected source snapshots, brief and the agreed acceptance criteria (one scenario per item; the worker implements exactly this list); increments revision, checks estimated budget without truncation.',
  inputSchema: z.object({ sessionId: text, files: z.array(text).min(1), brief: text, acceptanceCriteria: z.array(text).min(1) }).strict(),
}, ({ sessionId, ...input }) => sessionResult(store => store.contextSet(sessionId, input)));

server.registerTool('worker_chat', {
  description: 'One inference using selected context, latest candidate once and its findings if it was rejected. Requests one JSON path/content artifact and returns a new candidate as candidateId plus artifact {path, content}, ready for review without candidate_read; invalid replies return responsePreview and candidate diagnostics. Never applies code.',
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
  description: 'Read one immutable full-code candidate with its generation-time unified replacement diff and review history; for older versions, diffs or after a restart. Not needed right after worker_chat, which already returns the code. Does not read current source files.',
  inputSchema: z.object({ sessionId: text, candidateId: text }).strict(),
  annotations: { readOnlyHint: true, openWorldHint: false },
}, ({ sessionId, candidateId }) => sessionResult(store => store.candidateRead(sessionId, candidateId)));

server.registerTool('candidate_review', {
  description: 'Explicitly approve or reject one candidate on the current context revision; append findings to review history. Findings of a rejected latest candidate are sent with it to the next worker_chat.',
  inputSchema: z.object({ sessionId: text, candidateId: text, verdict: z.enum(['approve', 'reject']),
    findings: z.array(z.object({ severity: z.enum(['blocker', 'major', 'minor']), message: text, location: text.optional() }).strict()) }).strict(),
}, ({ sessionId, candidateId, verdict, findings }) => sessionResult(store => store.candidateReview(sessionId, candidateId, verdict, findings)));

server.registerTool('candidate_apply', {
  description: 'Write one approved, current-revision candidate into a clean Git workspace and typecheck it with the workspace tsc and trusted WORKER_TSCONFIG (must include the target). '
    + 'On success stages only the target and creates one local commit with Git hooks enabled (no push). '
    + 'Returns status committed (hooksModified: true plus a candidate->committed diff when hooks changed the file and it passed the typecheck again), validation_failed (diagnostics, file restored), conflict (dirty tree, changed snapshots/target or external edit; nothing overwritten), no_changes or error. '
    + 'Error commit_failed (e.g. a hook refused) restores the file and may be retried; commit_scope_violation and hooks_broke_typecheck keep the commit and are final. '
    + 'Session/candidate refusals (not approved, stale, busy, missing configuration) are tool errors with a code and write nothing. A failed typecheck is final: generate and review a new one. Repeating a finished apply returns the stored result without a new commit.',
  inputSchema: z.object({ sessionId: text, candidateId: text }).strict(),
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ sessionId, candidateId }) => sessionResult(store => store.candidateApply(sessionId, candidateId)));

server.registerTool('postprocess', {
  description: 'After candidate_apply returned committed and directly on top of that raw commit in a clean tree: run the trusted WORKER_POSTPROCESS tools (prettier --write, eslint --fix, in configured order) on the raw commit\'s paths only, re-run the typecheck and create a separate style commit with Git hooks enabled (no push). '
    + 'Returns status committed, no_changes, failed (tool or typecheck failure; files returned to the raw commit, which always stays), conflict (moved HEAD, dirty tree or files changed meanwhile; nothing overwritten) or error (e.g. postprocess_scope_violation when a tool touched other paths; nothing reverted). '
    + 'eslint exit 1 keeps its fixes and adds lint_problems_remain. Repeating a finished postprocess returns the stored result; commit_failed and tool failures can be retried.',
  inputSchema: z.object({ sessionId: text }).strict(),
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ sessionId }) => sessionResult(store => store.postprocess(sessionId)));

await server.connect(new StdioServerTransport());
