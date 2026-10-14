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

test('three turns retain history across restart, select the latest candidate, and replace snapshots explicitly', async (t) => {
  const f = await fixture(t);
  let store = f.open();
  const id = start(store);
  assert.equal(store.contextSet(id, context).contextRevision, 1);
  const first = await store.workerChat(id, 'first-request');
  assert.equal(store.candidateRead(id, first.candidateId).artifacts[0].diff,
    '--- /dev/null\n+++ b/value.test.ts\n@@ -0,0 +1,1 @@\n+reply-1\n\\ No newline at end of file\n');
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

test('candidate versions and rejection feedback survive restart with immutable generation-time diffs', async (t) => {
  const f = await fixture(t);
  let store = f.open();
  const id = start(store);
  writeFileSync(join(f.root, 'value.test.ts'), 'old line\n');
  store.contextSet(id, context);
  const first = await store.workerChat(id, 'Generate first version');
  assert.ok(first.candidateId);
  // The reviewer gets readable code at once; the raw JSON reply would only duplicate it.
  assert.deepEqual(first.artifacts, [{ path: 'value.test.ts', content: 'reply-1' }]);
  assert.equal(first.responsePreview, undefined);
  const firstPrompt = JSON.parse(f.requests[0].messages.at(-1).content);
  assert.deepEqual(firstPrompt.acceptanceCriteria, context.acceptanceCriteria);
  assert.match(firstPrompt.outputContract.instruction, /exactly the listed acceptance criteria/i);
  const code = store.candidateRead(id, first.candidateId);
  assert.equal(code.artifacts[0].content, 'reply-1');
  assert.equal(code.artifacts[0].diff, '--- a/value.test.ts\n+++ b/value.test.ts\n@@ -1,1 +1,1 @@\n-old line\n+reply-1\n\\ No newline at end of file\n');
  const findings = [{ severity: 'major', message: 'Assert the observable value' }];
  store.candidateReview(id, first.candidateId, 'reject', findings);
  const second = await store.workerChat(id, 'Revise the tests');
  assert.notEqual(first.candidateId, second.candidateId);
  const prompt = JSON.parse(f.requests[1].messages.at(-1).content);
  assert.deepEqual(prompt.openFeedback, findings);
  assert.equal(f.requests[1].messages.at(-1).content.split('reply-1').length - 1, 1);
  assert.equal(prompt.lastSuccessfulExchange, undefined);
  assert.deepEqual(store.candidateReview(id, second.candidateId, 'approve', []), { state: 'approved' });
  assert.equal(store.status(id).phase, 'approved');
  assert.equal(readFileSync(join(f.root, 'value.test.ts'), 'utf8'), 'old line\n');
  writeFileSync(join(f.root, 'value.test.ts'), 'external edit');
  assert.deepEqual(store.candidateRead(id, first.candidateId).artifacts, code.artifacts);
  store.close(); store = f.open();
  assert.equal(store.status(id).details.candidates.length, 2);
  assert.equal(store.status(id).details.candidates[0].state, 'rejected');
  assert.deepEqual(store.status(id).details.candidates[0].findings, findings);
  store.candidateReview(id, first.candidateId, 'reject', [{ severity: 'minor', message: 'Additional review note' }]);
  store.close(); store = f.open();
  assert.deepEqual(store.candidateRead(id, first.candidateId).reviews[0].findings, findings);
  assert.equal(store.candidateRead(id, first.candidateId).reviews.length, 2);
  assert.deepEqual(store.candidateRead(id, first.candidateId).artifacts, code.artifacts);
  const third = await store.workerChat(id, 'Old-version review must not reach the approved latest code');
  const afterOldReview = JSON.parse(f.requests[2].messages.at(-1).content);
  assert.deepEqual(afterOldReview.openFeedback, []);
  assert.deepEqual(afterOldReview.currentCandidate.files, [{ path: 'value.test.ts', content: 'reply-2' }]);
  const latestFindings = [{ severity: 'major', message: 'Cover the negative input' }];
  store.candidateReview(id, third.candidateId, 'reject', latestFindings);
  store.candidateReview(id, first.candidateId, 'reject', [{ severity: 'minor', message: 'Late note on the first version' }]);
  assert.equal(store.status(id).phase, 'needs_revision');
  await store.workerChat(id, 'Revise the latest version');
  const afterLatestReject = JSON.parse(f.requests[3].messages.at(-1).content);
  assert.deepEqual(afterLatestReject.openFeedback, latestFindings);
  assert.deepEqual(afterLatestReject.currentCandidate.files, [{ path: 'value.test.ts', content: 'reply-3' }]);
  store.contextSet(id, context);
  assert.throws(() => store.candidateReview(id, second.candidateId, 'approve', []), /stale/i);
  assert.equal(store.candidateRead(id, second.candidateId).state, 'stale');
  assert.notEqual(store.status(id).phase, 'approved');
});

test('existing I1 session records gain candidate fields without losing revision or history', async (t) => {
  const f = await fixture(t);
  let store = f.open();
  const id = start(store);
  store.contextSet(id, context);
  const legacy = store.status(id).details;
  delete legacy.candidates;
  store.close();
  const db = new DatabaseSync(join(f.root, '.stateful-worker', 'state.sqlite'));
  db.prepare('UPDATE sessions SET state = ? WHERE id = ?').run(JSON.stringify(legacy), id);
  db.close(); store = f.open();
  assert.equal(store.status(id).contextRevision, 1);
  assert.equal(store.status(id).details.candidates.length, 0);
  assert.ok((await store.workerChat(id, 'Generate candidate')).candidateId);
});

test('plain/malformed/path-mismatched/blank responses preserve raw history without creating candidates', async (t) => {
  for (const raw of ['plain answer', JSON.stringify({ path: '../other.test.ts', content: 'code' }), JSON.stringify({ path: 'value.test.ts', content: '  \n' }), JSON.stringify({ path: 'value.test.ts', content: 'я'.repeat(96001) })]) {
    const f = await fixture(t, res => res.end(JSON.stringify({ choices: [{ message: { content: raw }, finish_reason: 'stop' }] })));
    const store = f.open(), id = start(store);
    store.contextSet(id, context);
    const result = await store.workerChat(id, 'request');
    assert.equal(result.candidateId, undefined);
    assert.equal(result.candidateDiagnostics.length, 1);
    assert.equal(result.responsePreview, raw);
    assert.equal(store.status(id).details.candidates.length, 0);
    assert.equal(store.status(id).details.turns.at(-1).text, raw);
    assert.equal(store.status(id).details.errors.length, 1);
  }
});

test('truncated or tool-call output cannot become a candidate', async (t) => {
  for (const extra of [{ finish_reason: 'length' }, { finish_reason: 'stop', tool_calls: [{}] }]) {
    const f = await fixture(t, res => res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ path: 'value.test.ts', content: 'code' }), ...(extra.tool_calls ? { tool_calls: extra.tool_calls } : {}) }, finish_reason: extra.finish_reason }] })));
    const store = f.open(), id = start(store);
    store.contextSet(id, context);
    await assert.rejects(store.workerChat(id, 'request'), /incomplete|tool call/i);
    assert.equal(store.status(id).details.candidates.length, 0);
  }
});

test('sessions are isolated and budget failures make no backend request or partial context update', async (t) => {
  const f = await fixture(t);
  const store = f.open();
  const a = start(store), b = start(store);
  store.contextSet(a, context);
  store.contextSet(b, { ...context, brief: 'Other isolated brief' });
  assert.throws(() => store.contextSet(a, { ...context, acceptanceCriteria: [] }), /acceptance criteria/i);
  const warning = store.contextSet(a, { ...context, brief: 'x'.repeat(145000) });
  assert.equal(warning.warnings.length, 1);
  assert.throws(() => store.contextSet(a, { ...context, brief: 'x'.repeat(200000) }), /budget/i);
  assert.equal(store.status(a).contextRevision, 2);
  await assert.rejects(store.workerChat(b, 'x'.repeat(200000)), /budget/i);
  assert.equal(f.requests.length, 0);
  assert.equal(store.status(b).details.brief, 'Other isolated brief');
  assert.equal(store.status(b).details.errors.at(-1).code, 'budget_exceeded');
  writeFileSync(join(f.root, 'large.ts'), 'x'.repeat(200000));
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
  // 1-8 distinct workspace paths of any kind; duplicates are caught after normalising separators.
  for (const allowedPaths of [[], ['../value.test.ts'], Array.from({ length: 9 }, (_, index) => `f${index}.ts`), ['a.ts', 'a.ts'], ['dir/a.ts', 'dir\\a.ts']]) {
    assert.throws(() => store.start({ objective: 'test', allowedPaths }), /path/i);
  }
  assert.ok(store.start({ objective: 'test', allowedPaths: ['bad.ts', 'dir/b.test.ts'] }).sessionId);
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

// Replies in order; objects are sent as their JSON.
const say = (...replies) => {
  const queue = replies.map(reply => typeof reply === 'string' ? reply : JSON.stringify(reply));
  return res => res.end(JSON.stringify({ choices: [{ message: { content: queue.shift() ?? 'no reply' }, finish_reason: 'stop' }] }));
};
const promptOf = (f, index = -1) => JSON.parse(f.requests.at(index).messages.at(-1).content);
const LINES = Array.from({ length: 10 }, (_, index) => `const a${index + 1} = ${index + 1};`).join('\n') + '\n';
const CALC = 'export function calc(x: number) {\n  const a = 1;\n  return x + a;\n}\n// marker\n// marker\n';
// A session whose targets are the given files (content, or null for a new file), with calc.ts also selected as context.
function targets(f, files, extra = {}) {
  for (const [path, content] of Object.entries(files)) if (content !== null) writeFileSync(join(f.root, path), content);
  const store = f.open(), id = store.start({ objective: 'Add feature', allowedPaths: Object.keys(files), ...extra }).sessionId;
  store.contextSet(id, { ...context, files: existsSync(join(f.root, 'calc.ts')) ? ['calc.ts', 'source.ts'] : ['source.ts'] });
  return { store, id };
}

test('a multi-file candidate edits an existing target and creates a new one, with artifacts, minimal diffs and stored bases', async (t) => {
  const edits = [{ search: 'const a5 = 5;\n', replace: 'const a5 = 50;\n' }];
  const f = await fixture(t, say({ files: [{ path: 'calc.ts', edits }, { path: 'calc.test.ts', content: 'test();\n' }] }));
  const { store, id } = targets(f, { 'calc.ts': LINES, 'calc.test.ts': null }, { commitType: 'feat' });
  const result = await store.workerChat(id, 'Implement');
  assert.deepEqual(result.artifacts, [{ path: 'calc.ts', content: LINES.replace('a5 = 5', 'a5 = 50'), edits }, { path: 'calc.test.ts', content: 'test();\n' }]);
  const prompt = promptOf(f);
  assert.deepEqual(prompt.targets, [{ path: 'calc.ts', content: LINES }, { path: 'calc.test.ts', new: true }]);
  assert.deepEqual(prompt.context.map(snapshot => snapshot.path), ['source.ts']); // a target is not sent twice
  assert.match(prompt.outputContract.instruction, /not to currentCandidate/);
  assert.deepEqual(store.candidateRead(id, result.candidateId).artifacts.map(artifact => artifact.diff), [
    '--- a/calc.ts\n+++ b/calc.ts\n@@ -2,7 +2,7 @@\n const a2 = 2;\n const a3 = 3;\n const a4 = 4;\n-const a5 = 5;\n+const a5 = 50;\n const a6 = 6;\n const a7 = 7;\n const a8 = 8;\n',
    '--- /dev/null\n+++ b/calc.test.ts\n@@ -0,0 +1,1 @@\n+test();\n']);
  const { details } = store.status(id);
  assert.equal(details.commitType, 'feat');
  assert.equal(details.candidates[0].files[0].base.content, LINES);
  assert.equal(details.candidates[0].files[1].base, null);
  // F1 never writes: applying a multi-file candidate is refused before anything is touched.
  store.candidateReview(id, result.candidateId, 'approve', []);
  await assert.rejects(store.candidateApply(id, result.candidateId), { code: 'multi_file_apply_unsupported' });
  assert.equal(readFileSync(join(f.root, 'calc.ts'), 'utf8'), LINES);
  assert.equal(existsSync(join(f.root, 'calc.test.ts')), false);
});

test('edits apply in order, each to the text left by the previous ones, and distant changes get separate hunks', async (t) => {
  const f = await fixture(t, say({ files: [{ path: 'calc.ts', edits: [
    { search: 'const a2 = 2;', replace: 'const a2 = 20;' },
    { search: 'const a2 = 20;\n', replace: 'const a2 = 22;\nconst extra = 0;\n' },
    { search: 'const a10 = 10;', replace: 'const a10 = 100;' }] }] }));
  const { store, id } = targets(f, { 'calc.ts': LINES });
  const result = await store.workerChat(id, 'Implement');
  assert.equal(result.artifacts[0].content, LINES.replace('a2 = 2;', 'a2 = 22;\nconst extra = 0;').replace('a10 = 10', 'a10 = 100'));
  assert.equal(store.candidateRead(id, result.candidateId).artifacts[0].diff, '--- a/calc.ts\n+++ b/calc.ts\n'
    + '@@ -1,5 +1,6 @@\n const a1 = 1;\n-const a2 = 2;\n+const a2 = 22;\n+const extra = 0;\n const a3 = 3;\n const a4 = 4;\n const a5 = 5;\n'
    + '@@ -7,4 +8,4 @@\n const a7 = 7;\n const a8 = 8;\n const a9 = 9;\n-const a10 = 10;\n+const a10 = 100;\n');
});

test('any failing edit or file means no candidate; every problem is reported and reaches the next prompt until a valid reply', async (t) => {
  const f = await fixture(t, say({ files: [
    { path: 'calc.ts', edits: [
      { search: '  const a = 1', replace: '  const a = 2' }, // not whole lines
      { search: 'const a = 1;', replace: 'const a = 2;' }, // indentation differs
      { search: '// marker', replace: '// m' },
      { search: 'x\n'.repeat(13), replace: '' },
      { search: '}', replace: '  // rest of the code\n}' },
      { search: '  return x + a;', replace: '  return x - a;' }] }, // valid on its own
    { path: 'other.ts', content: 'export {};\n' },
    { path: 'calc.test.ts', edits: [{ search: 'a', replace: 'b' }] }] },
  { files: [{ path: 'calc.ts', edits: [{ search: '  const a = 1;', replace: '  const a = 2;' }] }] }));
  const { store, id } = targets(f, { 'calc.ts': CALC, 'calc.test.ts': null });
  const failed = await store.workerChat(id, 'Implement');
  assert.equal(failed.candidateId, undefined);
  assert.equal(failed.artifacts, undefined);
  assert.equal(store.status(id).details.candidates.length, 0);
  const problems = failed.candidateDiagnostics;
  assert.deepEqual(problems.map(({ code, path, edit }) => [code, path, edit]), [
    ['search_not_found', 'calc.ts', 0], ['search_not_found', 'calc.ts', 1], ['search_ambiguous', 'calc.ts', 2], ['search_too_long', 'calc.ts', 3],
    ['placeholder', 'calc.ts', 4], ['invalid_path', 'other.ts', undefined], ['invalid_candidate', 'calc.test.ts', undefined]]);
  assert.match(problems[0].message, /^calc\.ts edits\[0\]: .*search line 1 vs line 2 "  const a = 1;", first difference at column 14 \(search has end of line, file has ";"\)/);
  assert.match(problems[1].message, /only in indentation\/whitespace from lines 2-2, which are exactly: "  const a = 1;"/);
  assert.ok(problems.slice(0, 2).every(problem => problem.message.includes('complete "content"')));
  assert.match(problems[2].message, /matches 2 times \(lines 5, 6\)/);
  assert.equal(readFileSync(join(f.root, 'calc.ts'), 'utf8'), CALC);
  const fixed = await store.workerChat(id, 'Fix the reported problems');
  assert.deepEqual(promptOf(f).previousReplyProblems, problems);
  assert.equal(fixed.artifacts[0].content, CALC.replace('a = 1', 'a = 2'));
  await store.workerChat(id, 'Next');
  assert.equal(promptOf(f).previousReplyProblems, undefined);
});

test('CRLF bases stay CRLF through edits and content, a BOM is kept, and mixed line endings refuse edits but take content', async (t) => {
  const mixed = { path: 'mixed.ts', edits: [{ search: 'b', replace: 'B' }] };
  const f = await fixture(t, say({ files: [mixed] }, { files: [
    { path: 'crlf.ts', edits: [{ search: 'b\r\n', replace: 'B\nB2\n' }] },
    { path: 'whole.ts', content: 'p\nq\n' },
    { path: 'bom.ts', edits: [{ search: 'const a = 1;', replace: 'const a = 2;' }] },
    { path: 'mixed.ts', content: 'm\n' }] }));
  const { store, id } = targets(f, { 'crlf.ts': 'a\r\nb\r\nc\r\n', 'whole.ts': 'x\r\ny\r\n', 'bom.ts': '﻿const a = 1;\n', 'mixed.ts': 'a\r\nb\nc\r\n' });
  const refused = await store.workerChat(id, 'Implement');
  assert.deepEqual(refused.candidateDiagnostics.map(problem => problem.code), ['mixed_line_endings']);
  assert.match(refused.candidateDiagnostics[0].message, /"content"/);
  const result = await store.workerChat(id, 'Use content for mixed.ts');
  assert.deepEqual(result.artifacts.map(artifact => artifact.content), ['a\r\nB\r\nB2\r\nc\r\n', 'p\r\nq\r\n', '﻿const a = 2;\n', 'm\n']);
  assert.match(store.candidateRead(id, result.candidateId).artifacts[0].diff, /^@@ -1,3 \+1,4 @@\n a\r\n-b\r\n\+B\r\n\+B2\r\n c\r\n$/m);
});

test('placeholders and line-number prefixes are refused, while spread syntax and numeric keys are code', async (t) => {
  const f = await fixture(t, say({ files: [
    { path: 'calc.ts', edits: [{ search: '  const a = 1;', replace: '2 |   const a = 2;\n3 |   return x;' }] },
    { path: 'a.ts', content: 'test(1);\n// ...\n' },
    { path: 'b.ts', content: 'test(1);\n…\n' },
    { path: 'c.ts', content: '/* rest of the file */\n' },
    { path: 'd.ts', content: 'describe(() => {\n  // ... existing code ...\n});\n' },
    { path: 'e.ts', content: 'it();\n// other tests unchanged\n' }] },
  { files: [{ path: 'a.ts', content: 'const f = (...args: number[]) => Math.max(...args);\nconst all = [\n  ...items,\n];\nconst names = {\n  1: \'one\',\n};\n// returns unchanged input\n// value stays unchanged\n' }] }));
  const { store, id } = targets(f, { 'calc.ts': CALC, 'a.ts': null, 'b.ts': null, 'c.ts': null, 'd.ts': null, 'e.ts': null });
  const refused = await store.workerChat(id, 'Implement');
  assert.deepEqual(refused.candidateDiagnostics.map(problem => [problem.code, problem.path]),
    [['line_numbers', 'calc.ts'], ['placeholder', 'a.ts'], ['placeholder', 'b.ts'], ['placeholder', 'c.ts'], ['placeholder', 'd.ts'], ['placeholder', 'e.ts']]);
  assert.ok((await store.workerChat(id, 'Write complete code')).candidateId);
});

test('one outer fence around the whole reply is stripped, text around it is not, and the legacy path/content shape still works', async (t) => {
  const legacy = JSON.stringify({ path: 'value.test.ts', content: 'legacy();\n' });
  const f = await fixture(t, say(`\`\`\`json\n${JSON.stringify({ files: [{ path: 'value.test.ts', content: 'fenced();\n' }] })}\n\`\`\``,
    `Here it is:\n\`\`\`json\n${legacy}\n\`\`\``, `\`\`\`\n${legacy}\n\`\`\``));
  const store = f.open(), id = start(store);
  store.contextSet(id, context);
  assert.equal((await store.workerChat(id, 'one')).artifacts[0].content, 'fenced();\n');
  assert.deepEqual((await store.workerChat(id, 'two')).candidateDiagnostics.map(problem => problem.code), ['invalid_candidate']);
  assert.deepEqual((await store.workerChat(id, 'three')).artifacts, [{ path: 'value.test.ts', content: 'legacy();\n' }]);
  assert.equal(store.status(id).details.commitType, 'test');
});

test('an I2-era stored candidate with top-level path/content is read, reviewed and shown to the worker as files', async (t) => {
  const f = await fixture(t);
  let store = f.open();
  const id = start(store);
  writeFileSync(join(f.root, 'value.test.ts'), 'old line\n');
  store.contextSet(id, context);
  const { candidateId } = await store.workerChat(id, 'first');
  const legacy = store.status(id).details;
  const [{ files: [file], ...candidate }] = legacy.candidates;
  legacy.candidates = [{ ...candidate, path: file.path, content: file.content, base: file.base, diff: file.diff }];
  delete legacy.commitType;
  store.close();
  const db = new DatabaseSync(join(f.root, '.stateful-worker', 'state.sqlite'));
  db.prepare('UPDATE sessions SET state = ? WHERE id = ?').run(JSON.stringify(legacy), id);
  db.close(); store = f.open();
  const read = store.candidateRead(id, candidateId);
  assert.deepEqual(read.artifacts, [{ path: 'value.test.ts', content: 'reply-1', diff: file.diff }]);
  assert.equal(store.status(id).details.commitType, 'test');
  store.candidateReview(id, candidateId, 'reject', [{ severity: 'major', message: 'More cases' }]);
  await store.workerChat(id, 'second');
  assert.deepEqual(promptOf(f).currentCandidate.files, [{ path: 'value.test.ts', content: 'reply-1' }]);
});

test('target snapshots count towards the input budget', async (t) => {
  const f = await fixture(t), store = f.open();
  writeFileSync(join(f.root, 'big.ts'), 'x'.repeat(150000));
  const brief = 'y'.repeat(60000);
  const small = store.start({ objective: 'Edit', allowedPaths: ['value.test.ts'] }).sessionId;
  assert.equal(store.contextSet(small, { ...context, brief }).contextRevision, 1);
  const big = store.start({ objective: 'Edit', allowedPaths: ['big.ts'] }).sessionId;
  assert.throws(() => store.contextSet(big, { ...context, brief }), { code: 'budget_exceeded' });
});
