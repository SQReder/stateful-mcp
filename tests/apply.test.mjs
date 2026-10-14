import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fixture, PASSING, FAILING, BASE } from './git-fixture.mjs';

// The fixture declares no test runner, so applying a candidate with a test file notes the skipped run.
const NO_RUNNER = 'tests_skipped: no vitest or jest declared in package.json of . or its parents';

test('approved compilable candidate is committed alone with a trailer, and a repeat neither reruns tsc nor commits', async (t) => {
  const f = await fixture(t);
  const store = f.open(), id = await f.session(store), c = await f.candidate(store, id, PASSING), before = f.head();
  const result = await store.candidateApply(id, c);
  assert.deepEqual(result, { status: 'committed', diagnostics: [NO_RUNNER], changedFiles: ['value.test.ts'] });
  const commit = f.committed(before);
  assert.deepEqual(commit.files, ['value.test.ts']);
  assert.equal(commit.blob, PASSING);
  assert.equal(commit.message.trim(), `test: Add tests\n\nStateful-Worker-Candidate: ${c}`);
  assert.deepEqual(f.dirty(), []);
  assert.equal(store.status(id).phase, 'committed');
  const after = f.head();
  // A rerun of tsc would fail without its config, so an unchanged result proves the stored result was reused.
  renameSync(join(f.root, 'tsconfig.json'), join(f.root, 'moved.json'));
  assert.deepEqual(await store.candidateApply(id, c), result);
  assert.equal(f.head(), after);
  assert.equal(readFileSync(f.target, 'utf8'), PASSING);
});

test('the raw commit subject is the session commitType and the first line of the objective, trimmed to 72 characters', async (t) => {
  const f = await fixture(t);
  const store = f.open(), id = await f.session(store, { objective: `  Cover ${'x'.repeat(100)}\nDetails on the next line` });
  const c = await f.candidate(store, id, PASSING), before = f.head();
  assert.equal((await store.candidateApply(id, c)).status, 'committed');
  assert.equal(f.committed(before).message.split('\n')[0], `test: Cover ${'x'.repeat(66)}`);
  // An emoji on the cut is kept or dropped whole, never split into a replacement character.
  const g = await fixture(t);
  const other = g.open(), otherId = await g.session(other, { objective: `${'x'.repeat(71)}🙂 tail` });
  const d = await g.candidate(other, otherId, PASSING), start = g.head();
  assert.equal((await other.candidateApply(otherId, d)).status, 'committed');
  assert.equal(g.committed(start).message.split('\n')[0], `test: ${'x'.repeat(71)}🙂`);
});

test('an unchanged candidate file edited while tsc runs stops the commit, since the commit would not contain what was checked', async (t) => {
  const f = await fixture(t);
  const store = f.open(), { id, c, before } = await feature(f, store, { files: [{ path: 'source.ts', content: SOURCE }, { path: 'value.test.ts', content: PASSING }] });
  const running = store.candidateApply(id, c);
  while (store.status(id).phase !== 'validating') await new Promise(resolve => setImmediate(resolve));
  writeFileSync(join(f.root, 'source.ts'), 'export const value = 2;\n'); // tsc runs for far longer than this
  const result = await running;
  assert.equal(result.status, 'error');
  assert.match(result.diagnostics.join('\n'), /unexpected_changes.*source\.ts/);
  assert.equal(f.head(), before);
});

test('the session commitType names the raw commit subject', async (t) => {
  const f = await fixture(t, { base: BASE });
  const store = f.open(), id = await f.session(store, { commitType: 'fix' }), c = await f.candidate(store, id, PASSING), before = f.head();
  assert.equal((await store.candidateApply(id, c)).status, 'committed');
  assert.equal(f.committed(before).message.trim(), `fix: Add tests\n\nStateful-Worker-Candidate: ${c}`);
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
    assert.match(commit.message, /^test: Add tests\n/);
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

test('tsc errors only in other files are reported but do not block the commit; errors in the target still fail it', async (t) => {
  const f = await fixture(t, { base: BASE });
  // Pre-existing errors elsewhere in the repository, as in a large monorepo.
  writeFileSync(join(f.root, 'legacy.ts'), 'export const legacy: string = 1;\n');
  f.run('add', 'legacy.ts'); f.run('commit', '-q', '-m', 'legacy with a type error');
  const store = f.open(), id = await f.session(store);
  const good = await f.candidate(store, id, PASSING), before = f.head();
  const passed = await store.candidateApply(id, good);
  assert.equal(passed.status, 'committed', passed.diagnostics.join('\n'));
  assert.match(passed.diagnostics.join('\n'), /typecheck_errors_outside_target[\s\S]*legacy\.ts/);
  assert.deepEqual(f.committed(before).files, ['value.test.ts']);

  const g = await fixture(t, { base: BASE });
  writeFileSync(join(g.root, 'legacy.ts'), 'export const legacy: string = 1;\n');
  g.run('add', 'legacy.ts'); g.run('commit', '-q', '-m', 'legacy with a type error');
  const other = g.open(), otherId = await g.session(other);
  const bad = await g.candidate(other, otherId, FAILING);
  const failed = await other.candidateApply(otherId, bad);
  assert.equal(failed.status, 'validation_failed');
  assert.match(failed.diagnostics.join('\n'), /value\.test\.ts\(\d+,\d+\): error TS2322/);
  assert.equal(readFileSync(g.target, 'utf8'), BASE);
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

// Multi-file candidates: a feature in the existing source.ts with a new test in value.test.ts.
const SOURCE = 'export const value = 1;\n';
const DOUBLE = 'export const value = 1;\nexport const double = (x: number): number => x * 2;\n';
const DOUBLE_TEST = 'import { double } from "./source.js";\nconst checked: number = double(2);\nexport { checked };\n';
const FEATURE = { files: [{ path: 'source.ts', content: DOUBLE }, { path: 'value.test.ts', content: DOUBLE_TEST }] };
const source = (f) => readFileSync(join(f.root, 'source.ts'), 'utf8');
async function feature(f, store, reply = FEATURE, extra = {}) {
  const id = await f.session(store, { allowedPaths: ['source.ts', 'value.test.ts'], ...extra });
  return { id, c: await f.candidate(store, id, reply), before: f.head() };
}

test('a feature candidate that edits a module and adds a test is one commit of exactly both files under the objective subject', async (t) => {
  const f = await fixture(t);
  const store = f.open();
  const { id, c, before } = await feature(f, store, { files: [{ path: 'source.ts', edits: [{ search: 'export const value = 1;', replace: DOUBLE }] }, { path: 'value.test.ts', content: DOUBLE_TEST }] },
    { objective: 'Add double helper', commitType: 'feat' });
  const result = await store.candidateApply(id, c);
  assert.deepEqual(result, { status: 'committed', diagnostics: [NO_RUNNER], changedFiles: ['source.ts', 'value.test.ts'] });
  const commit = f.committed(before);
  assert.deepEqual(commit.files, ['source.ts', 'value.test.ts']);
  assert.equal(f.run('show', 'HEAD:source.ts'), DOUBLE);
  assert.equal(commit.blob, DOUBLE_TEST);
  assert.equal(commit.message.trim(), `feat: Add double helper\n\nStateful-Worker-Candidate: ${c}`);
  assert.deepEqual(f.dirty(), []);
  assert.deepEqual(store.status(id).details.candidates[0].applyResult.changedFiles, ['source.ts', 'value.test.ts']);
});

test('one file breaking the typecheck restores every file of the candidate, deletes the new one and commits nothing', async (t) => {
  const f = await fixture(t);
  const store = f.open();
  const { id, c, before } = await feature(f, store, { files: [{ path: 'source.ts', content: DOUBLE }, { path: 'value.test.ts', content: DOUBLE_TEST.replace('checked: number', 'checked: string') }] });
  const result = await store.candidateApply(id, c);
  assert.equal(result.status, 'validation_failed');
  assert.match(result.diagnostics.join('\n'), /value\.test\.ts\(\d+,\d+\): error TS2322/);
  assert.equal(f.head(), before);
  assert.equal(source(f), SOURCE);
  assert.equal(existsSync(f.target), false);
  assert.deepEqual(f.dirty(), []);
  assert.equal(store.status(id).phase, 'restored');
});

test('a dirty or externally changed second target is a conflict naming only it, and nothing is written', async (t) => {
  const f = await fixture(t, { base: BASE });
  const store = f.open(), { id, c } = await feature(f, store), draft = 'export const draft = 1;\n';
  writeFileSync(f.target, draft);
  const dirty = await store.candidateApply(id, c);
  assert.equal(dirty.status, 'conflict');
  assert.match(dirty.diagnostics.join('\n'), /target_dirty.*value\.test\.ts/);
  assert.doesNotMatch(dirty.diagnostics.join('\n'), /source\.ts/);
  assert.equal(source(f), SOURCE);
  f.run('commit', '-q', '-am', 'external target edit');
  const changed = await store.candidateApply(id, c);
  assert.equal(changed.status, 'conflict');
  assert.match(changed.diagnostics.join('\n'), /target_changed.*value\.test\.ts/);
  assert.doesNotMatch(changed.diagnostics.join('\n'), /source\.ts/);
  assert.equal(source(f), SOURCE);
  assert.equal(readFileSync(f.target, 'utf8'), draft);
  assert.deepEqual(f.dirty(), []);
});

test('a file left at its base is neither written nor committed, and a candidate of only such files is no_changes', async (t) => {
  const f = await fixture(t);
  const store = f.open(), { id, c: same } = await feature(f, store, { files: [{ path: 'source.ts', content: SOURCE }] });
  assert.deepEqual(await store.candidateApply(id, same), { status: 'no_changes', diagnostics: [], changedFiles: [] });
  const c = await f.candidate(store, id, { files: [{ path: 'source.ts', content: SOURCE }, { path: 'value.test.ts', content: PASSING }] }), before = f.head();
  assert.deepEqual(await store.candidateApply(id, c), { status: 'committed', diagnostics: [NO_RUNNER], changedFiles: ['value.test.ts'] });
  assert.deepEqual(f.committed(before).files, ['value.test.ts']);
  assert.deepEqual(f.dirty(), []);
});

test('a non-TypeScript file is committed without the inclusion gate, while a TypeScript file outside the program is named', async (t) => {
  const f = await fixture(t);
  const store = f.open(), data = '{ "value": 1 }\n';
  const { id, c, before } = await feature(f, store, { files: [{ path: 'data.json', content: data }, { path: 'value.test.ts', content: PASSING }] }, { allowedPaths: ['data.json', 'value.test.ts'] });
  const result = await store.candidateApply(id, c);
  assert.equal(result.status, 'committed', result.diagnostics.join('\n'));
  assert.deepEqual(f.committed(before).files, ['data.json', 'value.test.ts']);
  assert.equal(f.run('show', 'HEAD:data.json'), data);

  const g = await fixture(t);
  const other = g.open('tsconfig.src.json'), { id: otherId, c: d } = await feature(g, other);
  const missing = await other.candidateApply(otherId, d);
  assert.equal(missing.status, 'error');
  assert.match(missing.diagnostics.join('\n'), /target_not_in_typecheck: .* does not include value\.test\.ts;/);
  assert.equal(source(g), SOURCE);
  assert.equal(existsSync(g.target), false);
  assert.deepEqual(g.dirty(), []);
});

test('hooks that add a third file or drop a candidate file from a multi-file commit are scope violations, and the commit stays', async (t) => {
  for (const [hook, files] of [['echo extra > extra.txt && git add extra.txt', ['extra.txt', 'source.ts', 'value.test.ts']], ['git rm -q --cached value.test.ts', ['source.ts']]]) {
    const f = await fixture(t);
    f.hook(hook);
    const store = f.open(), { id, c, before } = await feature(f, store);
    const result = await store.candidateApply(id, c);
    assert.equal(result.status, 'error', hook);
    assert.match(result.diagnostics.join('\n'), /commit_scope_violation/, hook);
    assert.equal(f.run('rev-parse', 'HEAD^').trim(), before, hook);
    assert.deepEqual(f.run('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').trim().split('\n'), files, hook); // committed() would read the dropped file
    assert.deepEqual(await store.candidateApply(id, c), result, hook);
  }
});

test('a refused multi-file commit unstages and restores every file, and the candidate can be applied again', async (t) => {
  const f = await fixture(t);
  f.hook('echo rejected by hook >&2; exit 1');
  const store = f.open(), { id, c, before } = await feature(f, store);
  const result = await store.candidateApply(id, c);
  assert.match(result.diagnostics.join('\n'), /commit_failed[\s\S]*rejected by hook/);
  assert.equal(f.head(), before);
  assert.equal(source(f), SOURCE);
  assert.equal(existsSync(f.target), false);
  assert.deepEqual(f.dirty(), []);
  f.unhook();
  assert.equal((await store.candidateApply(id, c)).status, 'committed');
  assert.deepEqual(f.committed(before).files, ['source.ts', 'value.test.ts']);
});

test('crash while committing a multi-file candidate keeps its exact trailer commit, and without a commit unstages and restores every file', async (t) => {
  // [name, paths of the trailer commit (null: staged, no commit), expected phase, stored status]
  for (const [name, paths, phase, stored] of [
    ['own commit of both files', ['source.ts', 'value.test.ts'], 'committed', 'committed'],
    ['own commit missing a file', ['value.test.ts'], 'error', 'error'],
    ['staged, no commit', null, 'restored', undefined],
  ]) {
    const f = await fixture(t);
    let store = f.open();
    const { id, c, before } = await feature(f, store);
    store.close();
    writeFileSync(join(f.root, 'source.ts'), DOUBLE);
    writeFileSync(f.target, DOUBLE_TEST);
    f.run('add', '--', 'source.ts', 'value.test.ts');
    if (paths) f.run('commit', '-q', '-m', 'feat: interrupted', '-m', `Stateful-Worker-Candidate: ${c}`, '--', ...paths);
    const after = f.head();
    f.journal(id, { candidateId: c, phase: 'committing', head: before });
    store = f.open();
    const status = store.status(id), applyResult = status.details.candidates[0].applyResult;
    assert.equal(status.phase, phase, name);
    assert.equal(status.details.errors.at(-1).code, 'apply_interrupted', name);
    assert.equal(applyResult?.status, stored, name);
    assert.equal(f.head(), after, name);
    if (phase === 'committed') {
      assert.deepEqual(applyResult.changedFiles, ['source.ts', 'value.test.ts'], name);
      assert.deepEqual(f.dirty(), [], name);
    } else if (phase === 'error') {
      assert.match(applyResult.diagnostics.join('\n'), /committed_unverified.*value\.test\.ts/, name);
      assert.equal(source(f), DOUBLE, name); // HEAD moved: files are never restored
    } else {
      assert.equal(source(f), SOURCE, name);
      assert.equal(existsSync(f.target), false, name);
      assert.deepEqual(f.dirty(), [], name);
    }
  }
});
