import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('stdio discovery, validated arguments, errors and subsequent success', async (t) => {
  let requests = 0;
  const backend = createServer((_req, res) => {
    requests++;
    if (requests === 1) {
      res.writeHead(503);
      res.end('fake-private-secret');
    } else {
      res.end(JSON.stringify({ choices: [{ message: { content: 'ready' }, finish_reason: 'stop' }] }));
    }
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  t.after(() => { backend.closeAllConnections(); backend.close(); });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['dist/server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: {
      WORKER_BASE_URL: `http://127.0.0.1:${backend.address().port}/v1`,
      WORKER_MODEL: 'fake-model', HARNESS_MODEL_API_KEY: 'fake-private-secret',
    },
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'i0-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['worker_diagnostics', 'worker_instruct']);
  const diagnostics = await client.callTool({ name: 'worker_diagnostics', arguments: {} });
  assert.equal(diagnostics.structuredContent.configured, true);
  assert.equal(requests, 0);
  for (const args of [{}, { message: ' ' }, { message: 42 }, { message: 'ok', endpoint: 'https://other.invalid' }]) {
    const invalid = await client.callTool({ name: 'worker_instruct', arguments: args });
    assert.equal(invalid.isError, true);
  }
  assert.equal(requests, 0);
  const failed = await client.callTool({ name: 'worker_instruct', arguments: { message: 'ping' } });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.error.status, 503);
  assert.equal(JSON.stringify(failed).includes('fake-private-secret'), false);
  const passed = await client.callTool({ name: 'worker_instruct', arguments: { message: 'ping' } });
  assert.equal(passed.isError, false);
  assert.equal(passed.structuredContent.text, 'ready');
  assert.equal(requests, 2);
  assert.equal(stderr, '');
});
