import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, PASSING } from './git-fixture.mjs';

const FORMATTED = PASSING.replaceAll('"', "'");
const QUOTES = `s => s.replaceAll('"', "'")`;
const SAME = 's => s';
const BREAK = "s => s + 'const broken: string = 1;\\n'";
const LINT = "s => s + '// eslint after ' + (s.includes(\"'\") ? 'prettier' : 'raw') + '\\n'";
const FLAGS = { prettier: '--write', eslint: '--fix' };
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// Fake CLI in the workspace's node_modules: checks its fix flag, rewrites the files after `--`, then exits.
// prettier uses a string bin; eslint an object bin behind `exports`, which hides package.json from require.resolve.
function tool(f, name, transform, { exit = 0, extra = '' } = {}) {
  const dir = join(f.root, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(name === 'prettier' ? { name, bin: 'cli.cjs' } : { name, bin: { [name]: 'cli.cjs' }, exports: { '.': './cli.cjs' } }));
  writeFileSync(join(dir, 'cli.cjs'), `const fs = require('node:fs');
if (!process.argv.includes('${FLAGS[name]}')) process.exit(9);
for (const file of process.argv.slice(process.argv.indexOf('--') + 1)) fs.writeFileSync(file, (${transform})(fs.readFileSync(file, 'utf8')));
${extra}
process.exit(${exit});
`);
}

// A raw commit of PASSING made by candidate_apply, with postprocess configured as given.
async function rawCommit(t, tools, config = Object.keys(tools).join(',')) {
  const f = await fixture(t);
  for (const [name, [transform, options]] of Object.entries(tools)) tool(f, name, transform, options);
  const store = f.open('tsconfig.json', config), id = await f.session(store), c = await f.candidate(store, id, PASSING);
  assert.equal((await store.candidateApply(id, c)).status, 'committed');
  return { f, store, id, c, raw: f.head() };
}

test('formatted raw paths that pass the typecheck get a separate style commit on the raw commit, and a repeat commits nothing', async (t) => {
  const { f, store, id, c, raw } = await rawCommit(t, { prettier: [QUOTES] });
  const result = await store.postprocess(id);
  assert.deepEqual(result, { status: 'committed', diagnostics: [], changedFiles: ['value.test.ts'] });
  const commit = f.committed(raw);
  assert.deepEqual(commit.files, ['value.test.ts']);
  assert.equal(commit.blob, FORMATTED);
  assert.equal(commit.message.trim(), `style: format value.test.ts\n\nStateful-Worker-Postprocess: ${c}`);
  assert.equal(f.run('show', `${raw}:value.test.ts`), PASSING);
  assert.deepEqual(f.dirty(), []);
  assert.equal(store.status(id).phase, 'postprocessed');
  const after = f.head();
  rmSync(join(f.root, 'node_modules', 'prettier'), { recursive: true }); // a rerun would fail without the tool
  assert.deepEqual(await store.postprocess(id), result);
  assert.equal(f.head(), after);
});

test('a formatter without changes returns no_changes and commits nothing', async (t) => {
  const { f, store, id, raw } = await rawCommit(t, { prettier: [SAME] });
  assert.deepEqual(await store.postprocess(id), { status: 'no_changes', diagnostics: [], changedFiles: [] });
  assert.equal(f.head(), raw);
  assert.deepEqual(f.dirty(), []);
});

test('a formatter that breaks the typecheck fails without a second commit and returns the file to the raw commit', async (t) => {
  const { f, store, id, raw } = await rawCommit(t, { prettier: [BREAK] });
  const result = await store.postprocess(id);
  assert.equal(result.status, 'failed');
  assert.match(result.diagnostics.join('\n'), /postprocess_broke_typecheck[\s\S]*TS2322/);
  assert.equal(f.head(), raw);
  assert.equal(readFileSync(f.target, 'utf8'), PASSING);
  assert.deepEqual(f.dirty(), []);
  assert.equal(store.status(id).details.candidates[0].postprocessResult.status, 'failed');
  assert.deepEqual(await store.postprocess(id), result);
});

test('a tool that changes a path outside the raw commit is a scope violation and nothing is reverted or committed', async (t) => {
  const { f, store, id, raw } = await rawCommit(t, { prettier: [QUOTES, { extra: "fs.appendFileSync('source.ts', '// touched\\n');" }] });
  const result = await store.postprocess(id);
  assert.equal(result.status, 'error');
  assert.match(result.diagnostics.join('\n'), /postprocess_scope_violation.*source\.ts/);
  assert.equal(f.head(), raw);
  assert.equal(readFileSync(f.target, 'utf8'), FORMATTED);
  assert.deepEqual(f.dirty().sort(), [' M source.ts', ' M value.test.ts']);
});

test('postprocess is refused without a raw commit or trusted tool list, and is a conflict on a dirty tree or moved HEAD', async (t) => {
  const f = await fixture(t);
  tool(f, 'prettier', QUOTES);
  let store = f.open('tsconfig.json', 'prettier');
  const id = await f.session(store);
  await assert.rejects(store.postprocess(id), { code: 'no_raw_commit' });
  const c = await f.candidate(store, id, PASSING);
  assert.equal((await store.candidateApply(id, c)).status, 'committed');
  store.close();
  for (const config of [undefined, ' ', 'prettier,black']) {
    store = f.open('tsconfig.json', config);
    await assert.rejects(store.postprocess(id), { code: 'configuration_error' });
    store.close();
  }
  store = f.open('tsconfig.json', 'prettier');
  writeFileSync(join(f.root, 'notes.txt'), 'unrelated work');
  const dirty = await store.postprocess(id);
  assert.equal(dirty.status, 'conflict');
  assert.match(dirty.diagnostics.join('\n'), /dirty_worktree.*notes\.txt/);
  rmSync(join(f.root, 'notes.txt'));
  writeFileSync(join(f.root, 'source.ts'), 'export const value = 2;\n');
  f.run('commit', '-q', '-am', 'developer commit');
  const moved = await store.postprocess(id);
  assert.equal(moved.status, 'conflict');
  assert.match(moved.diagnostics.join('\n'), /head_moved/);
  assert.equal(readFileSync(f.target, 'utf8'), PASSING);
  assert.deepEqual(f.dirty(), []);
});

test('eslint exit 1 keeps its fixes after prettier with lint_problems_remain; exit 2 returns the file to the raw commit', async (t) => {
  const lint = await rawCommit(t, { prettier: [QUOTES], eslint: [LINT, { exit: 1, extra: "console.log('1 problem remains');" }] });
  const result = await lint.store.postprocess(lint.id);
  assert.equal(result.status, 'committed', result.diagnostics.join('\n'));
  assert.match(result.diagnostics.join('\n'), /lint_problems_remain[\s\S]*1 problem remains/);
  assert.equal(lint.f.committed(lint.raw).blob, `${FORMATTED}// eslint after prettier\n`); // WORKER_POSTPROCESS order is run order

  const broken = await rawCommit(t, { prettier: [QUOTES], eslint: [LINT, { exit: 2 }] });
  const failed = await broken.store.postprocess(broken.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.diagnostics.join('\n'), /tool_failed: eslint/);
  assert.equal(broken.f.head(), broken.raw);
  assert.equal(readFileSync(broken.f.target, 'utf8'), PASSING);
  assert.deepEqual(broken.f.dirty(), []);
  assert.equal(broken.store.status(broken.id).details.candidates[0].postprocessResult, undefined); // a tool failure is retryable
});

test('crash recovery returns formatted files to the raw commit unless changed, and keeps an existing postprocess commit', async (t) => {
  const external = 'export const external = 1;\n';
  for (const [written, phase] of [[FORMATTED, 'postprocess_failed'], [external, 'conflict']]) {
    let { f, store, id, c } = await rawCommit(t, { prettier: [QUOTES] });
    store.close();
    writeFileSync(f.target, written);
    f.journal(id, { candidateId: c, phase: 'postprocess_validating', formatted: { 'value.test.ts': sha256(FORMATTED) } });
    store = f.open('tsconfig.json', 'prettier');
    assert.equal(readFileSync(f.target, 'utf8'), written === FORMATTED ? PASSING : external);
    const status = store.status(id);
    assert.equal(status.phase, phase);
    assert.equal(status.details.errors.at(-1).code, 'postprocess_interrupted');
    if (written === FORMATTED) assert.equal((await store.postprocess(id)).status, 'committed');
  }

  let { f, store, id, c, raw } = await rawCommit(t, { prettier: [QUOTES] });
  store.close();
  writeFileSync(f.target, FORMATTED);
  f.run('commit', '-q', '-am', 'style: format value.test.ts', '-m', `Stateful-Worker-Postprocess: ${c}`);
  const after = f.head();
  f.journal(id, { candidateId: c, phase: 'postprocess_committing', formatted: { 'value.test.ts': sha256(FORMATTED) } });
  store = f.open('tsconfig.json', 'prettier');
  const status = store.status(id);
  assert.equal(status.phase, 'postprocessed');
  assert.equal(status.details.errors.at(-1).code, 'postprocess_interrupted');
  assert.match(status.details.candidates[0].postprocessResult.diagnostics.join('\n'), /recovered_after_crash/);
  assert.equal((await store.postprocess(id)).status, 'committed');
  assert.equal(f.head(), after);
  assert.equal(f.run('rev-list', '--count', `${raw}..HEAD`).trim(), '1');
});
