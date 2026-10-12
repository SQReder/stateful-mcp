import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { chat, ConfigurationError, readConfig } from './worker.js';

const server = new McpServer({ name: 'stateful-coding-worker', version: '0.1.0' });

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
    return result({ configured: true, model: config.model, timeoutMs: config.timeoutMs, stage: 'I0' });
  } catch (error: unknown) {
    if (!(error instanceof ConfigurationError)) throw error;
    return result({ configured: false, error: { code: 'configuration_error', message: error.message } }, true);
  }
});

server.registerTool('worker_instruct', {
  description: 'Make exactly one text-only model request. Does not read or write project files; sessions are not implemented in I0.',
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

await server.connect(new StdioServerTransport());
