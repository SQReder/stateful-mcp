import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
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
// The tool is also declared in the committed root package.json, since postprocess runs only declared tools.
function tool(f, name, transform, { exit = 0, extra = '' } = {}) {
  const manifest = join(f.root, 'package.json');
  const pkg = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : { private: true };
  writeFileSync(manifest, JSON.stringify({ ...pkg, devDependencies: { ...pkg.devDependencies, [name]: '*' } }));
  f.run('add', 'package.json'); f.run('commit', '-q', '-m', `declare ${name}`);
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
  for (const config of ['prettier,black', 'black']) {
    store = f.open('tsconfig.json', config);
    await assert.rejects(store.postprocess(id), { code: 'configuration_error' });
    store.close();
  }
  store = f.open('tsconfig.json', 'prettier');
  writeFileSync(f.target, `${PASSING}// developer draft\n`);
  const dirty = await store.postprocess(id);
  assert.equal(dirty.status, 'conflict');
  assert.match(dirty.diagnostics.join('\n'), /target_dirty/);
  writeFileSync(f.target, PASSING);
  writeFileSync(join(f.root, 'notes.txt'), 'unrelated work');
  f.run('add', 'notes.txt');
  const staged = await store.postprocess(id);
  assert.equal(staged.status, 'conflict');
  assert.match(staged.diagnostics.join('\n'), /index_not_clean.*notes\.txt/);
  f.run('rm', '-q', '--cached', 'notes.txt');
  rmSync(join(f.root, 'notes.txt'));
  writeFileSync(join(f.root, 'source.ts'), 'export const value = 2;\n');
  f.run('commit', '-q', '-am', 'developer commit');
  const moved = await store.postprocess(id);
  assert.equal(moved.status, 'conflict');
  assert.match(moved.diagnostics.join('\n'), /head_moved/);
  assert.equal(readFileSync(f.target, 'utf8'), PASSING);
  assert.deepEqual(f.dirty(), []);
});

test('a recorded raw commit that is not the candidate\'s own commit is never formatted', async (t) => {
  const { f, store, id } = await rawCommit(t, { prettier: [QUOTES] });
  store.close();
  writeFileSync(join(f.root, 'source.ts'), 'export const value = 2;\n');
  f.run('commit', '-q', '-am', 'developer commit');
  const developer = f.head();
  // Simulates the race the SHA capture closes: rawCommit pointing at a developer commit made during the apply.
  const db = new DatabaseSync(join(f.root, '.stateful-worker', 'state.sqlite'));
  const state = JSON.parse(db.prepare('SELECT state FROM sessions WHERE id = ?').get(id).state);
  state.candidates[0].rawCommit = developer;
  db.prepare('UPDATE sessions SET state = ? WHERE id = ?').run(JSON.stringify(state), id);
  db.close();
  const result = await f.open('tsconfig.json', 'prettier').postprocess(id);
  assert.equal(result.status, 'error');
  assert.match(result.diagnostics.join('\n'), /raw_commit_mismatch/);
  assert.equal(f.head(), developer);
  assert.equal(readFileSync(join(f.root, 'source.ts'), 'utf8'), 'export const value = 2;\n');
  assert.deepEqual(f.dirty(), []);
});

test('a hook that refuses the style commit leaves the raw commit and file as they were, and postprocess can run again', async (t) => {
  const { f, store, id, raw } = await rawCommit(t, { prettier: [QUOTES] });
  f.hook('echo style refused >&2; exit 1');
  const refused = await store.postprocess(id);
  assert.equal(refused.status, 'failed');
  assert.match(refused.diagnostics.join('\n'), /commit_failed[\s\S]*style refused/);
  assert.equal(f.head(), raw);
  assert.equal(readFileSync(f.target, 'utf8'), PASSING);
  assert.deepEqual(f.dirty(), []);
  f.unhook();
  assert.equal((await store.postprocess(id)).status, 'committed');
  assert.equal(f.committed(raw).blob, FORMATTED);
});

test('in a monorepo the orchestrator picks the package tsconfig, and postprocess runs the tools from that package', async (t) => {
  const f = await fixture(t);
  const pkg = join(f.root, 'packages', 'a');
  mkdirSync(pkg, { recursive: true });
  mkdirSync(join(f.root, 'packages', 'b'));
  writeFileSync(join(pkg, 'tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.json', include: ['*.ts'] }));
  writeFileSync(join(pkg, 'source.ts'), 'export const value = 1;\n');
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'a', dependencies: {} })); // declares no tools itself
  f.run('add', '.'); f.run('commit', '-q', '-m', 'package a');
  // The fake formatter records its working directory, proving tools run in the package (where ESLint looks up its config).
  // It is declared only in the root package.json, as hoisted monorepo tooling usually is.
  tool(f, 'prettier', "s => s + '// cwd ' + require('node:path').basename(process.cwd()) + '\\n'");
  const store = f.open('tsconfig.json'); // default WORKER_POSTPROCESS: eslint, then prettier
  const id = store.start({ objective: 'Add tests', allowedPaths: ['packages/a/value.test.ts'] }).sessionId;
  store.contextSet(id, { files: ['packages/a/source.ts'], brief: 'Test the value', acceptanceCriteria: ['Value is a number'] });
  const c = await f.candidate(store, id, { path: 'packages/a/value.test.ts', content: PASSING });
  const rootConfig = await store.candidateApply(id, c);
  assert.equal(rootConfig.status, 'error');
  assert.match(rootConfig.diagnostics.join('\n'), /target_not_in_typecheck/); // the default root tsconfig does not cover the package
  await assert.rejects(store.candidateApply(id, c, '../outside.json'), { code: 'invalid_path' });
  await assert.rejects(store.candidateApply(id, c, 'packages/a/source.ts'), { code: 'invalid_path' });
  const raw = f.head();
  assert.equal((await store.candidateApply(id, c, 'packages/a/tsconfig.json')).status, 'committed');
  const wrongPackage = await store.postprocess(id, 'packages/b');
  assert.equal(wrongPackage.status, 'error');
  assert.match(wrongPackage.diagnostics.join('\n'), /outside_package_dir/);
  const result = await store.postprocess(id);
  assert.equal(result.status, 'committed', result.diagnostics.join('\n'));
  assert.match(result.diagnostics.join('\n'), /tool_skipped: eslint/); // no package declares eslint: not an error
  assert.equal(f.run('show', 'HEAD:packages/a/value.test.ts'), `${PASSING}// cwd a\n`);
  assert.equal(f.run('rev-list', '--count', `${raw}..HEAD`).trim(), '2');
  assert.deepEqual(f.dirty(), []);
});

test('without declared tools postprocess has nothing to do, and a declared but missing tool is an error', async (t) => {
  const bare = await rawCommit(t, {}, undefined);
  const nothing = await bare.store.postprocess(bare.id);
  assert.equal(nothing.status, 'no_changes');
  assert.match(nothing.diagnostics.join('\n'), /tool_skipped: eslint[\s\S]*tool_skipped: prettier/);
  assert.equal(bare.f.head(), bare.raw);

  const { f, store, id, raw } = await rawCommit(t, { prettier: [QUOTES] });
  rmSync(join(f.root, 'node_modules', 'prettier'), { recursive: true }); // declared in package.json, not installed
  const missing = await store.postprocess(id);
  assert.equal(missing.status, 'error');
  assert.match(missing.diagnostics.join('\n'), /tool_not_found: prettier/);
  assert.equal(f.head(), raw);
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

  // Crash while committing before Git created the commit: the staged formatted file is unstaged and returned to the raw commit.
  const staged = await rawCommit(t, { prettier: [QUOTES] });
  staged.store.close();
  writeFileSync(staged.f.target, FORMATTED);
  staged.f.run('add', '--', 'value.test.ts');
  staged.f.journal(staged.id, { candidateId: staged.c, phase: 'postprocess_committing', formatted: { 'value.test.ts': sha256(FORMATTED) } });
  const reopened = staged.f.open('tsconfig.json', 'prettier');
  assert.equal(reopened.status(staged.id).phase, 'postprocess_failed');
  assert.equal(readFileSync(staged.f.target, 'utf8'), PASSING);
  assert.deepEqual(staged.f.dirty(), []);
  assert.equal(staged.f.head(), staged.raw);

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
