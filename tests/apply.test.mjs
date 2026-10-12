import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../dist/sessions.js';

const PASSING = 'import { value } from "./source.js";\nconst checked: number = value;\nexport { checked };\n';
const FAILING = 'import { value } from "./source.js";\nconst checked: string = value;\nexport { checked };\n';
const BASE = 'export {};\n';

// Disposable Git workspace with a tiny TS project; typescript resolves through a junction to this repo's install.
async function fixture(t, { base = null, git = true } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'worker-apply-'));
  const root = join(temp, 'workspace');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(resolve('node_modules', 'typescript'), join(root, 'node_modules', 'typescript'), 'junction');
  // incremental proves validation flags suppress .tsbuildinfo writes: any new file would make the tree dirty.
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', types: [], incremental: true }, include: ['*.ts'] }));
  writeFileSync(join(root, 'tsconfig.src.json'), JSON.stringify({ extends: './tsconfig.json', include: ['source.ts'] }));
  writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  if (base !== null) writeFileSync(join(root, 'value.test.ts'), base);
  const run = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const hooks = join(temp, 'no-hooks');
  // Git for Windows runs hooks through its bundled sh by the shebang; the mode makes them executable elsewhere.
  const hook = (body) => { mkdirSync(hooks, { recursive: true }); writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\n${body}\n`, { mode: 0o755 }); };
  const unhook = () => rmSync(join(hooks, 'pre-commit'));
  const head = () => run('rev-parse', 'HEAD').trim();
  if (git) {
    run('init', '-q');
    for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false'], ['core.hooksPath', hooks]]) run('config', key, value);
    run('add', '.'); run('commit', '-q', '-m', 'initial');
  }
  const replies = [];
  const backend = createServer(async (req, res) => {
    for await (const _ of req);
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ path: 'value.test.ts', content: replies.shift() }) }, finish_reason: 'stop' }] }));
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const config = { baseUrl: `http://127.0.0.1:${backend.address().port}/v1`, model: 'fake', apiKey: 'fake', timeoutMs: 1000 };
  const stores = [];
  const open = (tsconfig = 'tsconfig.json') => { const store = new SessionStore(root, config, tsconfig); stores.push(store); return store; };
  t.after(() => { stores.forEach(store => store.close()); backend.closeAllConnections(); backend.close(); rmSync(temp, { recursive: true }); });
  const target = join(root, 'value.test.ts');
  // .stateful-worker is deliberately not ignored by .gitignore: the clean check must skip it itself.
  const dirty = () => run('status', '--porcelain=v1', '--untracked-files=all').split('\n').filter(line => line && !line.includes('.stateful-worker/'));
  async function candidate(store, id, content, verdict = 'approve') {
    replies.push(content);
    const { candidateId } = await store.workerChat(id, 'Generate tests');
    if (verdict) store.candidateReview(id, candidateId, verdict, []);
    return candidateId;
  }
  async function session(store) {
    const id = store.start({ objective: 'Add tests', allowedPaths: ['value.test.ts'] }).sessionId;
    store.contextSet(id, { files: ['source.ts'], brief: 'Test the value', acceptanceCriteria: ['Value is a number'] });
    return id;
  }
  // The commit under test must be HEAD and a direct child of the pre-apply HEAD.
  const committed = (before) => {
    assert.equal(run('rev-parse', 'HEAD^').trim(), before);
    return { files: run('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').trim().split('\n'), blob: run('show', 'HEAD:value.test.ts'), message: run('log', '-1', '--format=%B') };
  };
  const journal = (id, apply) => {
    const db = new DatabaseSync(join(root, '.stateful-worker', 'state.sqlite'));
    const state = JSON.parse(db.prepare('SELECT state FROM sessions WHERE id = ?').get(id).state);
    db.prepare('UPDATE sessions SET state = ? WHERE id = ?').run(JSON.stringify({ ...state, apply }), id);
    db.close();
  };
  return { temp, root, config, target, run, dirty, open, candidate, session, hook, unhook, head, committed, journal };
}

test('approved compilable candidate is committed alone with a trailer, and a repeat neither reruns tsc nor commits', async (t) => {
  const f = await fixture(t);
  const store = f.open(), id = await f.session(store), c = await f.candidate(store, id, PASSING), before = f.head();
  const result = await store.candidateApply(id, c);
  assert.deepEqual(result, { status: 'committed', diagnostics: [], changedFiles: ['value.test.ts'] });
  const commit = f.committed(before);
  assert.deepEqual(commit.files, ['value.test.ts']);
  assert.equal(commit.blob, PASSING);
  assert.equal(commit.message.trim(), `test: add value.test.ts\n\nStateful-Worker-Candidate: ${c}`);
  assert.deepEqual(f.dirty(), []);
  assert.equal(store.status(id).phase, 'committed');
  const after = f.head();
  // A rerun of tsc would fail without its config, so an unchanged result proves the stored result was reused.
  renameSync(join(f.root, 'tsconfig.json'), join(f.root, 'moved.json'));
  assert.deepEqual(await store.candidateApply(id, c), result);
  assert.equal(f.head(), after);
  assert.equal(readFileSync(f.target, 'utf8'), PASSING);
});

test('hooks that reformat the target commit with a diff, but a hook that breaks the typecheck keeps the commit as an error', async (t) => {
  for (const [line, status] of [['// formatted by hook', 'committed'], ['const broken: string = 1;', 'error']]) {
    const f = await fixture(t, { base: BASE });
    f.hook(`printf '%s\\n' '${line}' >> value.test.ts && git add value.test.ts`);
    const store = f.open(), id = await f.session(store), c = await f.candidate(store, id, PASSING), before = f.head();
    const result = await store.candidateApply(id, c);
    assert.equal(result.status, status, result.diagnostics.join('\n'));
    const commit = f.committed(before);
    assert.equal(commit.blob, `${PASSING}${line}\n`);
    assert.match(commit.message, /^test: update value\.test\.ts/);
    assert.deepEqual(f.dirty(), []);
    if (status === 'committed') {
      assert.equal(result.hooksModified, true);
      assert.ok(result.diagnostics.some(text => text.includes(`+${line}`) && text.includes('--- a/value.test.ts')), result.diagnostics.join('\n'));
    } else {
      assert.match(result.diagnostics.join('\n'), /hooks_broke_typecheck[\s\S]*TS2322/);
    }
    assert.equal(store.status(id).details.candidates[0].applyResult.status, status);
    assert.deepEqual(await store.candidateApply(id, c), result);
    assert.equal(f.run('rev-list', '--count', 'HEAD').trim(), '2');
  }
});

test('a rejecting hook leaves HEAD, index and target as before, and the same candidate commits once the hook is gone', async (t) => {
  const f = await fixture(t);
  f.hook('echo rejected by hook >&2; exit 1');
  const store = f.open(), id = await f.session(store), c = await f.candidate(store, id, PASSING), before = f.head();
  const result = await store.candidateApply(id, c);
  assert.equal(result.status, 'error');
  assert.match(result.diagnostics.join('\n'), /commit_failed[\s\S]*rejected by hook/);
  assert.equal(f.head(), before);
  assert.equal(existsSync(f.target), false);
  assert.deepEqual(f.dirty(), []);
  f.unhook();
  assert.equal((await store.candidateApply(id, c)).status, 'committed');
  assert.deepEqual(f.committed(before).files, ['value.test.ts']);
});

test('a hook that stages another file is a scope violation and the commit stays', async (t) => {
  const f = await fixture(t);
  f.hook('echo extra > extra.txt && git add extra.txt');
  const store = f.open(), id = await f.session(store), c = await f.candidate(store, id, PASSING), before = f.head();
  const result = await store.candidateApply(id, c);
  assert.equal(result.status, 'error');
  assert.match(result.diagnostics.join('\n'), /commit_scope_violation.*extra\.txt/);
  assert.deepEqual(f.committed(before).files.sort(), ['extra.txt', 'value.test.ts']);
  assert.deepEqual(await store.candidateApply(id, c), result);
});

test('crash while committing keeps any commit made after the pre-apply HEAD and restores only when HEAD did not move', async (t) => {
  const cases = [
    // [name, file content, staged, commit message trailer?, expected phase, stored status, file kept]
    ['own commit', PASSING, true, true, 'committed', 'committed', true],
    ['own commit changed by a hook', `${PASSING}// hook\n`, true, true, 'error', 'error', true],
    ['developer commit without trailer', PASSING, true, false, 'conflict', undefined, true],
    ['staged, no commit', PASSING, true, null, 'restored', undefined, false],
    ['written, crash before git add', PASSING, false, null, 'restored', undefined, false],
  ];
  for (const [name, content, staged, trailer, phase, stored, kept] of cases) {
    const f = await fixture(t);
    let store = f.open();
    const id = await f.session(store), c = await f.candidate(store, id, PASSING), before = f.head();
    store.close();
    writeFileSync(f.target, content);
    if (staged) f.run('add', '--', 'value.test.ts');
    if (trailer !== null) f.run('commit', '-q', '-m', 'test: add value.test.ts', ...(trailer ? ['-m', `Stateful-Worker-Candidate: ${c}`] : []));
    const after = f.head();
    f.journal(id, { candidateId: c, phase: 'committing', head: before });
    store = f.open();
    const status = store.status(id);
    assert.equal(status.phase, phase, name);
    assert.equal(status.details.errors.at(-1).code, 'apply_interrupted', name);
    assert.equal(status.details.candidates[0].applyResult?.status, stored, name);
    assert.equal(f.head(), after, name);
    assert.deepEqual(f.dirty(), [], name);
    assert.equal(existsSync(f.target) ? readFileSync(f.target, 'utf8') : null, kept ? content : null, name);
    if (stored) {
      assert.match(status.details.candidates[0].applyResult.diagnostics.join('\n'), stored === 'committed' ? /recovered_after_crash/ : /committed_unverified/, name);
      assert.equal((await store.candidateApply(id, c)).status, stored, name);
      assert.equal(f.head(), after, name);
    }
  }
});

test('non-compiling candidate returns tsc diagnostics and restores the base byte-for-byte or removes a new file', async (t) => {
  for (const base of [BASE, null]) {
    const f = await fixture(t, { base });
    const store = f.open(), id = await f.session(store), c = await f.candidate(store, id, FAILING), before = f.head();
    const result = await store.candidateApply(id, c);
    assert.equal(result.status, 'validation_failed');
    assert.equal(f.head(), before);
    assert.deepEqual(result.changedFiles, []);
    assert.ok(result.diagnostics.some(line => line.includes('TS2322')), result.diagnostics.join('\n'));
    assert.ok(result.diagnostics.some(line => /exit code: 2|exit code: 1/.test(line)));
    assert.equal(base === null ? existsSync(f.target) : readFileSync(f.target, 'utf8'), base === null ? false : base);
    assert.deepEqual(f.dirty(), []);
    assert.equal(store.status(id).phase, 'restored');
    assert.equal(store.status(id).details.candidates[0].applyResult.status, 'validation_failed');
    assert.deepEqual(await store.candidateApply(id, c), result);
    const fixed = await f.candidate(store, id, PASSING, null);
    await assert.rejects(store.candidateApply(id, fixed), /approved/i);
    store.candidateReview(id, fixed, 'approve', []);
    assert.equal((await store.candidateApply(id, fixed)).status, 'committed');
  }
});

test('draft, rejected, stale and not-the-approved candidates are refused without writes', async (t) => {
  const f = await fixture(t);
  const store = f.open(), id = await f.session(store);
  const draft = await f.candidate(store, id, PASSING, null);
  await assert.rejects(store.candidateApply(id, draft), /approved/i);
  const rejected = await f.candidate(store, id, PASSING, 'reject');
  await assert.rejects(store.candidateApply(id, rejected), /approved/i);
  const c3 = await f.candidate(store, id, PASSING);
  const c4 = await f.candidate(store, id, FAILING, null);
  await assert.rejects(store.candidateApply(id, c4), /approved/i);
  store.contextSet(id, { files: ['source.ts'], brief: 'Changed brief', acceptanceCriteria: ['Value is a number'] });
  await assert.rejects(store.candidateApply(id, c3), /stale/i);
  await assert.rejects(store.candidateApply(id, 'missing'), /not found/i);
  const current = await f.candidate(store, id, PASSING);
  store.close();
  await assert.rejects(f.open('').candidateApply(id, current), /WORKER_TSCONFIG/);
  assert.equal(existsSync(f.target), false);
  assert.deepEqual(f.dirty(), []);
});

test('external target/context edits and unrelated dirty files are conflicts without writes', async (t) => {
  const f = await fixture(t, { base: BASE });
  const store = f.open(), id = await f.session(store);
  const c = await f.candidate(store, id, PASSING);
  writeFileSync(join(f.root, 'notes.txt'), 'unrelated work');
  assert.equal((await store.candidateApply(id, c)).status, 'conflict');
  assert.equal(readFileSync(f.target, 'utf8'), BASE);
  rmSync(join(f.root, 'notes.txt'));
  writeFileSync(f.target, 'export const external = 1;\n');
  f.run('commit', '-q', '-am', 'external target edit');
  const targetConflict = await store.candidateApply(id, c);
  assert.equal(targetConflict.status, 'conflict');
  assert.equal(readFileSync(f.target, 'utf8'), 'export const external = 1;\n');
  const second = await f.candidate(store, id, PASSING);
  writeFileSync(join(f.root, 'source.ts'), 'export const value = 2;\n');
  f.run('commit', '-q', '-am', 'external source edit');
  assert.equal((await store.candidateApply(id, second)).status, 'conflict');
  assert.equal(readFileSync(f.target, 'utf8'), 'export const external = 1;\n');
  assert.deepEqual(f.dirty(), []);
});

test('typecheck that does not include the target or a non-Git workspace is an error, file restored', async (t) => {
  const f = await fixture(t);
  const store = f.open('tsconfig.src.json'), id = await f.session(store), c = await f.candidate(store, id, PASSING);
  const result = await store.candidateApply(id, c);
  assert.equal(result.status, 'error');
  assert.match(result.diagnostics.join('\n'), /target_not_in_typecheck/);
  assert.equal(existsSync(f.target), false);
  assert.deepEqual(f.dirty(), []);
  const plain = await fixture(t, { git: false });
  const other = plain.open(), otherId = await plain.session(other), otherC = await plain.candidate(other, otherId, PASSING);
  const notGit = await other.candidateApply(otherId, otherC);
  assert.equal(notGit.status, 'error');
  assert.match(notGit.diagnostics.join('\n'), /git_unavailable/);
  assert.equal(existsSync(plain.target), false);
});

test('a running apply blocks chat, context and review in its session and any second apply in the workspace', async (t) => {
  const f = await fixture(t);
  const store = f.open(), id = await f.session(store), other = await f.session(store);
  const c = await f.candidate(store, id, PASSING), otherC = await f.candidate(store, other, PASSING);
  const running = store.candidateApply(id, c);
  await assert.rejects(store.candidateApply(other, otherC), { code: 'apply_busy' });
  // The journal phase stays validating for both tsc runs, which take far longer than an event-loop turn.
  while (store.status(id).phase !== 'validating') await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => store.contextSet(id, { files: ['source.ts'], brief: 'Late change', acceptanceCriteria: ['Value is a number'] }), /busy/i);
  assert.throws(() => store.candidateReview(id, c, 'reject', []), /busy/i);
  await assert.rejects(store.workerChat(id, 'Late request'), /busy/i);
  await assert.rejects(store.candidateApply(other, otherC), { code: 'apply_busy' });
  f.hook('sleep 1'); // keeps the commit running long enough to observe the committing phase
  while (store.status(id).phase !== 'committing') await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.status(id).pendingAction, 'wait_for_apply');
  assert.throws(() => store.candidateReview(id, c, 'reject', []), /busy/i);
  await assert.rejects(store.candidateApply(other, otherC), { code: 'apply_busy' });
  assert.equal((await running).status, 'committed');
});

test('crash after the write restores the base on restart, but externally changed targets stay untouched as conflict', async (t) => {
  const external = 'export const external = 3;\n';
  for (const [base, written, expected] of [[BASE, PASSING, BASE], [null, PASSING, null], [BASE, external, external]]) {
    const f = await fixture(t, { base });
    let store = f.open();
    const id = await f.session(store), c = await f.candidate(store, id, PASSING);
    const state = store.status(id).details;
    state.apply = { candidateId: c, phase: 'validating' };
    store.close();
    const db = new DatabaseSync(join(f.root, '.stateful-worker', 'state.sqlite'));
    db.prepare('UPDATE sessions SET state = ? WHERE id = ?').run(JSON.stringify(state), id);
    db.close();
    writeFileSync(f.target, written);
    store = f.open();
    assert.equal(existsSync(f.target) ? readFileSync(f.target, 'utf8') : null, expected);
    const status = store.status(id);
    assert.equal(status.phase, written === PASSING ? 'restored' : 'conflict');
    assert.equal(status.details.errors.at(-1).code, 'apply_interrupted');
  }
});
