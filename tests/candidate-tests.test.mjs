import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, PASSING, BASE } from './git-fixture.mjs';

const SOURCE = 'export const value = 1;\n';
const DOUBLE = 'export const value = 1;\nexport const double = (x: number): number => x * 2;\n';
const DOUBLE_TEST = 'import { double } from "./source.js";\nconst checked: number = double(2);\nexport { checked };\n';
const NO_RUNNER = 'tests_skipped: no vitest or jest declared in package.json of . or its parents';

// Fake test runner: logs each call to runner.log outside the workspace, exits 9 on an unexpected argv prefix or env,
// and fails with output when a given test file, read relative to its working directory, contains FAIL_ME.
// vitest uses a string bin, jest an object bin.
function runner(f, name, extra = '') {
  const prefix = name === 'vitest' ? ['run'] : ['--ci', '--runTestsByPath'];
  f.tool(name, `const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), prefix = ${JSON.stringify(prefix)}, files = args.slice(prefix.length);
fs.appendFileSync(${JSON.stringify(join(f.temp, 'runner.log'))}, JSON.stringify({ runner: '${name}', cwd: path.basename(process.cwd()), files }) + '\\n');
if (process.env.CI !== '1' || process.env.FORCE_COLOR !== '0' || prefix.some((arg, index) => args[index] !== arg)) process.exit(9);
${extra}
const failing = files.filter(file => fs.readFileSync(file, 'utf8').includes('FAIL_ME'));
if (failing.length) { console.log('FAIL ' + failing.join(' ')); process.exit(1); }
`, { objectBin: name === 'jest' });
}
const calls = (f) => {
  const log = join(f.temp, 'runner.log');
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
};
async function feature(f, store, files, allowedPaths = files.map(file => file.path)) {
  const id = await f.session(store, { allowedPaths });
  return { id, c: await f.candidate(store, id, { files }), before: f.head() };
}

test('passing tests run every test file of the candidate, changed or not, with vitest and the commit notes tests_passed', async (t) => {
  const f = await fixture(t, { base: BASE });
  runner(f, 'vitest');
  const store = f.open(), { id, c, before } = await feature(f, store, [{ path: 'value.test.ts', content: BASE }, { path: 'other.spec.ts', content: PASSING }]);
  const result = await store.candidateApply(id, c);
  assert.deepEqual(result, { status: 'committed', diagnostics: ['tests_passed: vitest ran 2 test file(s)'], changedFiles: ['other.spec.ts'] });
  assert.deepEqual(f.committed(before).files, ['other.spec.ts']);
  assert.deepEqual(calls(f).map(call => ({ ...call, files: call.files.sort() })), [{ runner: 'vitest', cwd: 'workspace', files: ['other.spec.ts', 'value.test.ts'] }]);
  assert.deepEqual(f.dirty(), []);
});

test('failing tests restore every file and commit nothing, and the same candidate commits once the tests pass', async (t) => {
  const f = await fixture(t);
  runner(f, 'vitest');
  const store = f.open(), { id, c, before } = await feature(f, store, [{ path: 'source.ts', content: DOUBLE }, { path: 'value.test.ts', content: `${DOUBLE_TEST}// FAIL_ME\n` }]);
  const result = await store.candidateApply(id, c);
  assert.equal(result.status, 'error');
  assert.match(result.diagnostics.join('\n'), /tests_failed[\s\S]*exit code: 1[\s\S]*FAIL value\.test\.ts/);
  assert.equal(f.head(), before);
  assert.equal(readFileSync(join(f.root, 'source.ts'), 'utf8'), SOURCE);
  assert.equal(existsSync(f.target), false);
  assert.deepEqual(f.dirty(), []);
  assert.equal(store.status(id).details.candidates[0].applyResult, undefined); // not final: flakes and unfinished work happen
  writeFileSync(join(f.root, 'node_modules', 'vitest', 'cli.cjs'), 'process.exit(0);\n');
  const retried = await store.candidateApply(id, c);
  assert.equal(retried.status, 'committed', retried.diagnostics.join('\n'));
  assert.deepEqual(f.committed(before).files, ['source.ts', 'value.test.ts']);
});

test('vitest is preferred when both runners are declared', async (t) => {
  const f = await fixture(t);
  runner(f, 'jest');
  runner(f, 'vitest');
  const store = f.open(), id = await f.session(store), c = await f.candidate(store, id, PASSING);
  assert.equal((await store.candidateApply(id, c)).status, 'committed');
  assert.deepEqual(calls(f).map(call => call.runner), ['vitest']);
});

test('without test files or a declared runner nothing runs and the commit notes tests_skipped', async (t) => {
  const f = await fixture(t);
  runner(f, 'vitest');
  const store = f.open(), { id, c } = await feature(f, store, [{ path: 'source.ts', content: DOUBLE }]);
  assert.deepEqual(await store.candidateApply(id, c), { status: 'committed', diagnostics: ['tests_skipped: no test files in the candidate'], changedFiles: ['source.ts'] });
  assert.deepEqual(calls(f), []);

  const g = await fixture(t);
  const other = g.open(), otherId = await g.session(other), d = await g.candidate(other, otherId, PASSING);
  assert.deepEqual(await other.candidateApply(otherId, d), { status: 'committed', diagnostics: [NO_RUNNER], changedFiles: ['value.test.ts'] });
});

test('a declared but uninstalled runner is test_runner_not_found, files restored and nothing committed', async (t) => {
  const f = await fixture(t);
  runner(f, 'vitest');
  rmSync(join(f.root, 'node_modules', 'vitest'), { recursive: true });
  const store = f.open(), id = await f.session(store), c = await f.candidate(store, id, PASSING), before = f.head();
  const result = await store.candidateApply(id, c);
  assert.equal(result.status, 'error');
  assert.match(result.diagnostics.join('\n'), /test_runner_not_found: vitest/);
  assert.equal(f.head(), before);
  assert.equal(existsSync(f.target), false);
  assert.deepEqual(f.dirty(), []);
  assert.equal(store.status(id).details.candidates[0].applyResult, undefined);
});

test('files written by the test run are unexpected changes and nothing is reverted or committed', async (t) => {
  const f = await fixture(t);
  runner(f, 'vitest', "fs.writeFileSync('value.test.ts.snap', 'snapshot\\n');");
  const store = f.open(), id = await f.session(store), c = await f.candidate(store, id, PASSING), before = f.head();
  const result = await store.candidateApply(id, c);
  assert.equal(result.status, 'error');
  assert.match(result.diagnostics.join('\n'), /unexpected_changes.*value\.test\.ts\.snap/);
  assert.equal(f.head(), before);
  assert.equal(readFileSync(f.target, 'utf8'), PASSING);
  assert.deepEqual(f.dirty().sort(), ['?? value.test.ts', '?? value.test.ts.snap']);
});

test('in a monorepo jest declared only at the root runs from the package with package-relative paths, and a test outside packageDir is refused unwritten', async (t) => {
  const f = await fixture(t);
  const pkg = join(f.root, 'packages', 'a');
  mkdirSync(pkg, { recursive: true });
  mkdirSync(join(f.root, 'packages', 'b'));
  writeFileSync(join(pkg, 'tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.json', include: ['*.ts'] }));
  writeFileSync(join(pkg, 'source.ts'), SOURCE);
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'a', dependencies: {} })); // declares no runner itself
  f.run('add', '.'); f.run('commit', '-q', '-m', 'package a');
  runner(f, 'jest');
  const store = f.open('packages/a/tsconfig.json');
  const id = store.start({ objective: 'Add tests', allowedPaths: ['packages/a/value.test.ts'] }).sessionId;
  store.contextSet(id, { files: ['packages/a/source.ts'], brief: 'Test the value', acceptanceCriteria: ['Value is a number'] });
  const c = await f.candidate(store, id, { path: 'packages/a/value.test.ts', content: PASSING }), before = f.head();
  const outside = await store.candidateApply(id, c, undefined, 'packages/b');
  assert.equal(outside.status, 'error');
  assert.match(outside.diagnostics.join('\n'), /outside_package_dir: packages\/a\/value\.test\.ts/);
  assert.equal(existsSync(join(pkg, 'value.test.ts')), false);
  assert.deepEqual(calls(f), []);
  await assert.rejects(store.candidateApply(id, c, undefined, '../outside'), { code: 'invalid_path' });
  const result = await store.candidateApply(id, c);
  assert.equal(result.status, 'committed', result.diagnostics.join('\n'));
  assert.deepEqual(result.diagnostics, ['tests_passed: jest ran 1 test file(s)']);
  assert.deepEqual(calls(f), [{ runner: 'jest', cwd: 'a', files: ['value.test.ts'] }]);
  assert.equal(f.run('rev-parse', 'HEAD^').trim(), before);
  assert.equal(f.run('show', 'HEAD:packages/a/value.test.ts'), PASSING); // committed() reads the root target
  assert.deepEqual(f.dirty(), []);
});

test('a test file whose package-relative path starts with "-" is refused before any write, since a runner would read it as an option', async (t) => {
  const f = await fixture(t);
  runner(f, 'vitest');
  const store = f.open(), { id, c, before } = await feature(f, store, [{ path: '-x.test.ts', content: PASSING }]);
  const result = await store.candidateApply(id, c);
  assert.equal(result.status, 'error');
  assert.match(result.diagnostics.join('\n'), /invalid_test_path: -x\.test\.ts/);
  assert.equal(existsSync(join(f.root, '-x.test.ts')), false);
  assert.equal(f.head(), before);
  assert.deepEqual(calls(f), []);
});
