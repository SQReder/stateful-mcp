import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { SessionError, SessionStore } from './sessions.js';
import { chat, ConfigurationError, readConfig } from './worker.js';

const server = new McpServer({ name: 'stateful-coding-worker', version: '0.1.0' });
let sessions: SessionStore | undefined;
process.once('exit', () => sessions?.close());

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
    return result({ configured: true, model: config.model, timeoutMs: config.timeoutMs, stage: 'I1' });
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
      const root = process.env.WORKER_WORKSPACE_ROOT;
      if (!root) throw new ConfigurationError('Missing WORKER_WORKSPACE_ROOT.');
      sessions = new SessionStore(root, readConfig());
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
  description: 'Explicitly replace selected source snapshots and brief; increments revision, checks estimated budget without truncation.',
  inputSchema: z.object({ sessionId: text, files: z.array(text).min(1), brief: text, acceptanceCriteria: z.array(text) }).strict(),
}, ({ sessionId, ...input }) => sessionResult(store => store.contextSet(sessionId, input)));

server.registerTool('worker_chat', {
  description: 'One inference using selected context and the last successful exchange. The reply is stored as text. Never applies code.',
  inputSchema: z.object({ sessionId: text, message: text }).strict(),
}, ({ sessionId, message }) => sessionResult(store => store.workerChat(sessionId, message)));

server.registerTool('session_status', {
  description: 'Compact session status; includeDetails explicitly reveals full stored brief, snapshots, turns and errors.',
  inputSchema: z.object({ sessionId: text, includeDetails: z.boolean().optional() }).strict(),
  annotations: { readOnlyHint: true, openWorldHint: false },
}, ({ sessionId, includeDetails }) => sessionResult(store => {
  const status = store.status(sessionId), { details, ...summary } = status;
  return { ...summary, turnCount: details.turns.length, errorsCount: details.errors.length, ...(includeDetails ? { details } : {}) };
}));

await server.connect(new StdioServerTransport());
