import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { chat, readConfig } from '../dist/worker.js';

const secret = 'fake-secret-never-log';
const prompt = 'fake-private-context';

async function backend(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: 'fake-model', apiKey: secret, timeoutMs: 500,
  };
}

test('single chat request carries Bearer auth and no tools', async (t) => {
  let requests = 0;
  const config = await backend(t, async (req, res) => {
    requests++;
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    assert.equal(input.model, 'fake-model');
    assert.equal(input.stream, false);
    assert.equal(input.messages.at(-1).content, prompt);
    assert.equal('tools' in input, false);
    assert.equal('tool_calls' in input, false);
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  });
  assert.deepEqual(await chat(config, prompt), { ok: true, text: 'ok', finishReason: 'stop' });
  assert.equal(requests, 1);
});

for (const status of [401, 403, 429, 500, 503]) {
  test(`HTTP ${status} returns sanitized diagnostics without retry`, async (t) => {
    let requests = 0;
    const config = await backend(t, (_req, res) => {
      requests++;
      res.writeHead(status);
      res.end(`${secret} ${prompt}`);
    });
    const result = await chat(config, prompt);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'http_error');
    assert.equal(result.error.status, status);
    assert.equal(requests, 1);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(JSON.stringify(result).includes(prompt), false);
  });
}

for (const body of [
  'not json', '{}',
  JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }),
  JSON.stringify({ choices: [{ message: { content: 'ok', tool_calls: {} }, finish_reason: 'stop' }] }),
  JSON.stringify({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }),
  JSON.stringify({ choices: [{ message: { content: 'ok', tool_calls: [{}] }, finish_reason: 'stop' }] }),
]) {
  test(`malformed or incomplete backend response is rejected: ${body}`, async (t) => {
    const config = await backend(t, (_req, res) => res.end(body));
    const result = await chat(config, prompt);
    assert.equal(result.ok, false);
    assert.ok(['malformed_response', 'incomplete_response'].includes(result.error.code));
  });
}

test('null and empty tool-call markers mean no calls', async (t) => {
  for (const markers of [{ tool_calls: null }, { tool_calls: [], function_call: null }]) {
    const config = await backend(t, (_req, res) => res.end(JSON.stringify({
      choices: [{ message: { content: 'ok', ...markers }, finish_reason: 'stop' }],
    })));
    assert.deepEqual(await chat(config, prompt), { ok: true, text: 'ok', finishReason: 'stop' });
  }
});

test('timeout covers a stalled response body', async (t) => {
  const config = await backend(t, (_req, res) => {
    res.writeHead(200);
    res.write('{');
  });
  config.timeoutMs = 40;
  const result = await chat(config, prompt);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'timeout');
});

test('connection failure is safe and redirects are not followed', async (t) => {
  const config = await backend(t, (_req, res) => {
    res.writeHead(302, { location: 'http://127.0.0.1:1/private' });
    res.end();
  });
  assert.equal((await chat(config, prompt)).error.code, 'connection_error');
  config.baseUrl = 'http://127.0.0.1:1/v1';
  const result = await chat(config, prompt);
  assert.equal(result.error.code, 'connection_error');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('configuration fails safely for missing auth and unsafe URL', () => {
  const env = { WORKER_BASE_URL: 'https://localhost:8317/v1', WORKER_MODEL: 'gpt-6-luna' };
  assert.throws(() => readConfig(env), /HARNESS_MODEL_API_KEY/);
  env.HARNESS_MODEL_API_KEY = secret;
  assert.equal(readConfig(env).model, 'gpt-6-luna');
  env.WORKER_BASE_URL = `https://user:${secret}@localhost/v1`;
  assert.throws(() => readConfig(env), /WORKER_BASE_URL/);
});
