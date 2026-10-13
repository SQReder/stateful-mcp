import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fixture, PASSING, FAILING, BASE } from './git-fixture.mjs';

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

test('unstaged and untracked work elsewhere stays out of the commit, while a dirty target or a staged change is a conflict', async (t) => {
  const f = await fixture(t, { base: BASE });
  const store = f.open(), id = await f.session(store);
  const c = await f.candidate(store, id, PASSING), before = f.head();
  writeFileSync(join(f.root, 'value.test.ts'), 'export const draft = 1;\n');
  const dirtyTarget = await store.candidateApply(id, c);
  assert.equal(dirtyTarget.status, 'conflict');
  assert.match(dirtyTarget.diagnostics.join('\n'), /target_dirty/);
  assert.equal(readFileSync(f.target, 'utf8'), 'export const draft = 1;\n');
  writeFileSync(f.target, BASE);
  writeFileSync(join(f.root, 'tsconfig.src.json'), '{"extends":"./tsconfig.json","include":["source.ts"],"files":[]}');
  f.run('add', 'tsconfig.src.json');
  const staged = await store.candidateApply(id, c);
  assert.equal(staged.status, 'conflict');
  assert.match(staged.diagnostics.join('\n'), /index_not_clean.*tsconfig\.src\.json/);
  f.run('restore', '--staged', 'tsconfig.src.json'); // the change stays, unstaged
  writeFileSync(join(f.root, 'notes.txt'), 'unrelated work');
  assert.equal((await store.candidateApply(id, c)).status, 'committed');
  assert.deepEqual(f.committed(before).files, ['value.test.ts']);
  assert.deepEqual(f.dirty().sort(), [' M tsconfig.src.json', '?? notes.txt']);
});

test('tsc errors only outside the target, e.g. in unfinished work, do not burn the candidate', async (t) => {
  const f = await fixture(t, { base: BASE });
  const store = f.open(), id = await f.session(store);
  const c = await f.candidate(store, id, PASSING), before = f.head();
  writeFileSync(join(f.root, 'wip.ts'), 'export const unfinished: string = 1;\n'); // included by tsconfig.json
  const elsewhere = await store.candidateApply(id, c);
  assert.equal(elsewhere.status, 'error');
  assert.match(elsewhere.diagnostics.join('\n'), /typecheck_failed_elsewhere[\s\S]*wip\.ts/);
  assert.equal(readFileSync(f.target, 'utf8'), BASE);
  assert.equal(f.head(), before);
  assert.equal(store.status(id).details.candidates[0].applyResult, undefined);
  rmSync(join(f.root, 'wip.ts'));
  assert.equal((await store.candidateApply(id, c)).status, 'committed');
});

test('uncommitted files in the typechecked program are reported on success and never burn the candidate on failure', async (t) => {
  for (const [wip, status, code] of [
    ['export const value = 1;\nexport const extra = 2;\n', 'committed', /validated_with_uncommitted.*source\.ts/],
    ["export const value = 'one';\n", 'error', /typecheck_failed_with_uncommitted.*source\.ts/],
  ]) {
    const f = await fixture(t, { base: BASE });
    writeFileSync(join(f.root, 'source.ts'), wip); // unfinished work in the module under test, snapshotted by context_set
    const store = f.open(), id = await f.session(store), c = await f.candidate(store, id, PASSING);
    const result = await store.candidateApply(id, c);
    assert.equal(result.status, status, result.diagnostics.join('\n'));
    assert.match(result.diagnostics.join('\n'), code);
    assert.equal(readFileSync(join(f.root, 'source.ts'), 'utf8'), wip);
    if (status === 'error') assert.equal(store.status(id).details.candidates[0].applyResult, undefined);
  }
});

test('a file staged while tsc runs keeps the commit from happening instead of joining it', async (t) => {
  const f = await fixture(t, { base: BASE });
  writeFileSync(join(f.root, 'notes.txt'), 'unrelated work');
  const store = f.open(), id = await f.session(store), c = await f.candidate(store, id, PASSING), before = f.head();
  const running = store.candidateApply(id, c);
  while (store.status(id).phase !== 'validating') await new Promise(resolve => setImmediate(resolve));
  f.run('add', 'notes.txt'); // tsc runs for far longer than this
  const result = await running;
  assert.equal(result.status, 'conflict');
  assert.match(result.diagnostics.join('\n'), /index_not_clean.*notes\.txt/);
  assert.equal(f.head(), before);
  assert.equal(readFileSync(f.target, 'utf8'), BASE);
  assert.deepEqual(f.dirty(), ['A  notes.txt']);
});

test('external target and context edits are conflicts without writes', async (t) => {
  const f = await fixture(t, { base: BASE });
  const store = f.open(), id = await f.session(store);
  const c = await f.candidate(store, id, PASSING);
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
