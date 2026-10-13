import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['candidate_apply', 'candidate_read', 'candidate_review', 'context_set', 'postprocess', 'session_start', 'session_status', 'worker_chat', 'worker_diagnostics', 'worker_instruct']);
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

// The workspace is the Git repository the server starts in; the ceiling keeps Git from finding a repository above the temp dir.
const server = (cwd, env) => new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.js')], cwd, stderr: 'pipe',
  env: { GIT_CEILING_DIRECTORIES: tmpdir(), WORKER_MODEL: 'fake', HARNESS_MODEL_API_KEY: 'fake', WORKER_BASE_URL: 'http://127.0.0.1:9/v1', ...env } });

test('outside a Git repository the server still answers diagnostics, but session tools refuse to pick a workspace', async (t) => {
  const plain = mkdtempSync(join(tmpdir(), 'worker-plain-'));
  const client = new Client({ name: 'plain-test', version: '1.0.0' });
  t.after(async () => { await client.close(); rmSync(plain, { recursive: true }); });
  const transport = server(plain);
  transport.stderr?.resume();
  await client.connect(transport);
  const diagnostics = await client.callTool({ name: 'worker_diagnostics', arguments: {} });
  assert.equal(diagnostics.structuredContent.workspaceRoot, undefined);
  assert.match(diagnostics.structuredContent.workspaceError, /Git repository/);
  const started = await client.callTool({ name: 'session_start', arguments: { objective: 'Tests', allowedPaths: ['value.test.ts'] } });
  assert.equal(started.isError, true);
  assert.equal(started.structuredContent.error.code, 'configuration_error');
});

test('MCP crash recovers a pending turn without replay and status is compact by default', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'worker-crash-'));
  const root = join(temp, 'project'), nested = join(root, 'src');
  mkdirSync(nested, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, 'source.ts'), 'export const value = 1;');
  let arrived;
  const requestArrived = new Promise(resolve => { arrived = resolve; });
  let requests = 0;
  const backend = createServer((_req, _res) => { requests++; arrived(); });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    backend.closeAllConnections(); backend.close(); rmSync(temp, { recursive: true });
  });
  async function connect() {
    // Started in a subdirectory: the workspace is still the repository's top level.
    const transport = server(nested, { WORKER_BASE_URL: `http://127.0.0.1:${backend.address().port}/v1` });
    transport.stderr?.resume();
    const client = new Client({ name: 'crash-test', version: '1.0.0' });
    await client.connect(transport); clients.push(client); return { client, transport };
  }
  const first = await connect();
  const diagnostics = await first.client.callTool({ name: 'worker_diagnostics', arguments: {} });
  assert.equal(realpathSync.native(diagnostics.structuredContent.workspaceRoot).toLowerCase(), realpathSync.native(root).toLowerCase());
  const started = await first.client.callTool({ name: 'session_start', arguments: { objective: 'Tests', allowedPaths: ['value.test.ts'] } });
  const sessionId = started.structuredContent.sessionId;
  await first.client.callTool({ name: 'context_set', arguments: { sessionId, files: ['source.ts'], brief: 'Test value', acceptanceCriteria: ['Value is a number'] } });
  const pending = first.client.callTool({ name: 'worker_chat', arguments: { sessionId, message: 'Generate tests' } }).catch(() => undefined);
  await requestArrived;
  process.kill(first.transport.pid, 'SIGKILL');
  await pending; await first.client.close();
  const second = await connect();
  const compact = await second.client.callTool({ name: 'session_status', arguments: { sessionId } });
  assert.equal(compact.structuredContent.details, undefined);
  assert.equal(compact.structuredContent.turnCount, 1);
  assert.equal(compact.structuredContent.errorsCount, 1);
  assert.equal(compact.structuredContent.pendingAction, undefined);
  const full = await second.client.callTool({ name: 'session_status', arguments: { sessionId, includeDetails: true } });
  assert.equal(full.structuredContent.details.errors.at(-1).code, 'interrupted');
  assert.equal(full.structuredContent.details.context[0].content, 'export const value = 1;');
  assert.equal(requests, 1);
});
