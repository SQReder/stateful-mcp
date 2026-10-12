import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'i0-live-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath, args: ['--use-system-ca', 'dist/server.js'], cwd: process.cwd(), stderr: 'pipe',
  env: {
    WORKER_BASE_URL: process.env.WORKER_BASE_URL ?? '',
    WORKER_MODEL: process.env.WORKER_MODEL ?? '',
    HARNESS_MODEL_API_KEY: process.env.HARNESS_MODEL_API_KEY ?? '',
    ...(process.env.WORKER_TIMEOUT_MS ? { WORKER_TIMEOUT_MS: process.env.WORKER_TIMEOUT_MS } : {}),
    ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
  },
});
transport.stderr?.resume();
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some(tool => tool.name === 'worker_instruct'));
  const diagnostics = await client.callTool({ name: 'worker_diagnostics', arguments: {} });
  if (diagnostics.isError) {
    console.log(JSON.stringify({ ok: false, error: diagnostics.structuredContent.error }));
    process.exitCode = 1;
  } else {
    const response = await client.callTool({ name: 'worker_instruct', arguments: { message: 'Reply with the single word READY.' } });
    if (response.isError) {
      console.log(JSON.stringify({ ok: false, error: response.structuredContent.error }));
      process.exitCode = 1;
    } else {
      assert.equal(response.structuredContent.ok, true);
      assert.equal(response.structuredContent.finishReason, 'stop');
      assert.ok(response.structuredContent.text.length > 0);
      console.log(JSON.stringify({ ok: true, transport: 'stdio', tlsVerification: true,
        model: diagnostics.structuredContent.model, replyLength: response.structuredContent.text.length }));
    }
  }
} catch {
  console.error('MCP live smoke failed before a valid result; inspect local configuration and transport.');
  process.exitCode = 1;
} finally {
  await client.close();
}
