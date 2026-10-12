import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../dist/sessions.js';

export const PASSING = 'import { value } from "./source.js";\nconst checked: number = value;\nexport { checked };\n';
export const FAILING = 'import { value } from "./source.js";\nconst checked: string = value;\nexport { checked };\n';
export const BASE = 'export {};\n';

// Disposable Git workspace with a tiny TS project; typescript resolves through a junction to this repo's install.
export async function fixture(t, { base = null, git = true } = {}) {
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
  const open = (tsconfig = 'tsconfig.json', postprocess) => { const store = new SessionStore(root, config, tsconfig, postprocess); stores.push(store); return store; };
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
