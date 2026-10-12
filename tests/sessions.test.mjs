import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionStore } from '../dist/sessions.js';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

async function fixture(t, handler) {
  const temp = mkdtempSync(join(tmpdir(), 'worker-session-'));
  const root = join(temp, 'workspace');
  mkdirSync(root);
  writeFileSync(join(root, 'source.ts'), 'export const value = 1;');
  const requests = [];
  const backend = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    requests.push(JSON.parse(body));
    if (handler) return handler(res);
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ path: 'value.test.ts', content: `reply-${requests.length}` }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 123, completion_tokens: 7 } }));
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const config = { baseUrl: `http://127.0.0.1:${backend.address().port}/v1`, model: 'fake', apiKey: 'fake', timeoutMs: 1000 };
  const stores = [];
  const open = () => { const store = new SessionStore(root, config); stores.push(store); return store; };
  t.after(() => { stores.forEach(store => store.close()); backend.closeAllConnections(); backend.close(); rmSync(temp, { recursive: true }); });
  return { temp, root, config, requests, open };
}

const context = { files: ['source.ts'], brief: 'Test the exported value', acceptanceCriteria: ['Check observable value'] };
const start = store => store.start({ objective: 'Add tests', allowedPaths: ['value.test.ts'] }).sessionId;

test('missing backend token usage stays unknown, distinct from the input estimate', async (t) => {
  const f = await fixture(t, res => res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })));
  const store = f.open(), id = start(store);
  store.contextSet(id, context);
  const result = await store.workerChat(id, 'request');
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null });
  assert.ok(result.estimatedInputTokens > 0);
  assert.ok(result.estimateMethod.includes('not_exact'));
});

test('three turns retain history across restart, replay the last successful exchange, and replace snapshots explicitly', async (t) => {
  const f = await fixture(t);
  let store = f.open();
  const id = start(store);
  assert.equal(store.contextSet(id, context).contextRevision, 1);
  const first = await store.workerChat(id, 'first-request');
  assert.deepEqual(first.usage, { inputTokens: 123, outputTokens: 7 });
  writeFileSync(join(f.root, 'source.ts'), 'export const value = 2;');
  await store.workerChat(id, 'second-request');
  assert.ok(f.requests[1].messages.at(-1).content.includes('value = 1'));
  assert.ok(f.requests[1].messages.at(-1).content.includes('reply-1'));
  assert.equal(store.contextSet(id, context).contextRevision, 2);
  await store.workerChat(id, 'third-request');
  const prompt = f.requests[2].messages.at(-1).content;
  assert.ok(prompt.includes('value = 2'));
  assert.ok(prompt.includes('reply-2'));
  assert.equal(prompt.includes('reply-1'), false);
  assert.equal(f.requests.length, 3);
  assert.ok(f.requests.every(request => request.max_tokens === 8192 && !('tools' in request)));
  store.close();
  store = f.open();
  const status = store.status(id);
  assert.equal(status.contextRevision, 2);
  assert.equal(status.details.brief, context.brief);
  assert.equal(status.details.turns.length, 6);
  assert.equal(status.details.context[0].content, 'export const value = 2;');
  assert.match(status.details.context[0].contentHash, /^[a-f0-9]{64}$/);
  assert.equal(readFileSync(join(f.root, 'source.ts'), 'utf8'), 'export const value = 2;');
});

test('truncated or tool-call output is rejected', async (t) => {
  for (const extra of [{ finish_reason: 'length' }, { finish_reason: 'stop', tool_calls: [{}] }]) {
    const f = await fixture(t, res => res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ path: 'value.test.ts', content: 'code' }), ...(extra.tool_calls ? { tool_calls: extra.tool_calls } : {}) }, finish_reason: extra.finish_reason }] })));
    const store = f.open(), id = start(store);
    store.contextSet(id, context);
    await assert.rejects(store.workerChat(id, 'request'), /incomplete|tool call/i);
  }
});

test('sessions are isolated and budget failures make no backend request or partial context update', async (t) => {
  const f = await fixture(t);
  const store = f.open();
  const a = start(store), b = start(store);
  store.contextSet(a, context);
  store.contextSet(b, { ...context, brief: 'Other isolated brief' });
  const warning = store.contextSet(a, { ...context, brief: 'x'.repeat(25000) });
  assert.equal(warning.warnings.length, 1);
  assert.throws(() => store.contextSet(a, { ...context, brief: 'x'.repeat(33000) }), /budget/i);
  assert.equal(store.status(a).contextRevision, 2);
  await assert.rejects(store.workerChat(b, 'x'.repeat(33000)), /budget/i);
  assert.equal(f.requests.length, 0);
  assert.equal(store.status(b).details.brief, 'Other isolated brief');
  assert.equal(store.status(b).details.errors.at(-1).code, 'budget_exceeded');
  writeFileSync(join(f.root, 'large.ts'), 'x'.repeat(33000));
  assert.throws(() => store.contextSet(b, { ...context, files: ['large.ts'] }), /budget/i);
  assert.equal(store.status(b).contextRevision, 1);
});

test('context and allowed targets reject traversal, drive/UNC paths and symlink ancestors', async (t) => {
  const f = await fixture(t);
  const store = f.open();
  const id = start(store);
  for (const path of ['../source.ts', '..\\source.ts', 'C:\\secret.ts', '\\\\host\\share\\secret.ts', 'source.ts:stream']) {
    assert.throws(() => store.contextSet(id, { ...context, files: [path] }), /path/i);
  }
  for (const allowedPaths of [['../value.test.ts'], ['bad.ts'], ['a.test.ts', 'b.test.ts']]) {
    assert.throws(() => store.start({ objective: 'test', allowedPaths }), /path|one|test/i);
  }
  const outside = join(f.temp, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.ts'), 'outside');
  symlinkSync(outside, join(f.root, 'linked'), 'junction');
  assert.throws(() => store.contextSet(id, { ...context, files: ['linked/secret.ts'] }), /symlink/i);
  assert.throws(() => store.start({ objective: 'test', allowedPaths: ['linked/value.test.ts'] }), /symlink/i);
  symlinkSync(join(f.temp, 'missing'), join(f.root, 'dangling'), 'junction');
  assert.throws(() => store.start({ objective: 'test', allowedPaths: ['dangling/value.test.ts'] }), /symlink/i);
});

test('storage rejects a second process/store and symlink ancestors without external writes', async (t) => {
  const f = await fixture(t);
  const first = f.open(), id = start(first);
  assert.throws(() => new SessionStore(f.root, f.config), /exclusive session storage/i);
  assert.equal(first.status(id).contextRevision, 0);
  first.close();
  assert.equal(f.open().status(id).contextRevision, 0);
  const other = await fixture(t);
  const outside = join(other.temp, 'state-outside');
  mkdirSync(outside);
  symlinkSync(outside, join(other.root, '.stateful-worker'), 'junction');
  assert.throws(() => other.open(), /symlink storage/i);
  assert.equal(existsSync(join(outside, 'state.sqlite')), false);
});

test('session storage cannot be redirected outside its dedicated workspace directory', async (t) => {
  const f = await fixture(t);
  const external = join(f.temp, 'external.sqlite');
  const store = new SessionStore(f.root, f.config, external);
  try {
    assert.equal(existsSync(external), false);
    assert.equal(existsSync(join(f.root, '.stateful-worker', 'state.sqlite')), true);
  } finally { store.close(); }
});

test('source ancestor switched between validation and open cannot enter a snapshot', async (t) => {
  const f = await fixture(t), store = f.open(), id = start(store);
  store.contextSet(id, context);
  const selected = join(f.root, 'selected'), outside = join(f.temp, 'external');
  mkdirSync(selected); mkdirSync(outside);
  const source = join(selected, 'source.ts');
  writeFileSync(source, 'trusted-source');
  writeFileSync(join(outside, 'source.ts'), 'external-private-source');
  const original = fs.statSync;
  let swapped = false;
  fs.statSync = (path, ...args) => {
    const stat = original(path, ...args);
    if (path === source && !swapped) {
      swapped = true;
      fs.renameSync(selected, join(f.root, 'original-selected'));
      symlinkSync(outside, selected, 'junction');
    }
    return stat;
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => store.contextSet(id, { ...context, files: ['selected/source.ts'] }), /changed|symlink|snapshot|path/i);
  } finally { fs.statSync = original; syncBuiltinESMExports(); }
  assert.equal(swapped, true);
  const status = store.status(id);
  assert.equal(status.contextRevision, 1);
  assert.equal(status.details.context[0].content, 'export const value = 1;');
  assert.equal(JSON.stringify(status).includes('external-private-source'), false);
  assert.equal(f.requests.length, 0);
});

test('backend errors are durable and pending chat blocks another chat/context update', async (t) => {
  let release;
  const arrived = new Promise(resolve => { release = resolve; });
  let response;
  const f = await fixture(t, res => { response = res; release(); });
  let store = f.open();
  const id = start(store);
  store.contextSet(id, context);
  const pending = store.workerChat(id, 'request');
  await arrived;
  assert.throws(() => store.contextSet(id, context), /busy/i);
  await assert.rejects(store.workerChat(id, 'duplicate'), /busy/i);
  response.writeHead(503); response.end('private-backend-body');
  await assert.rejects(pending, /HTTP 503/);
  store.close(); store = f.open();
  const status = store.status(id);
  assert.equal(status.details.errors.at(-1).code, 'http_error');
  assert.equal(JSON.stringify(status).includes('private-backend-body'), false);
  assert.equal(status.pendingAction, undefined);
  assert.equal(f.requests.length, 1);
});
