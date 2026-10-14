import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Disposable Git project: a module, a tsconfig that includes tests, and this repo's typescript and Node types.
const temp = mkdtempSync(join(tmpdir(), 'worker-e2e-'));
const root = join(temp, 'workspace');
mkdirSync(join(root, 'node_modules', '@types'), { recursive: true });
symlinkSync(resolve('node_modules', 'typescript'), join(root, 'node_modules', 'typescript'), 'junction');
symlinkSync(resolve('node_modules', '@types', 'node'), join(root, 'node_modules', '@types', 'node'), 'junction');
writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', types: ['node'] }, include: ['*.ts'] }));
writeFileSync(join(root, 'clamp.ts'), 'export function clamp(value: number, min: number, max: number): number {\n  if (min > max) throw new RangeError(\'min must not exceed max\');\n  return Math.min(Math.max(value, min), max);\n}\n');
writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
git('init', '-q');
for (const [key, value] of [['user.name', 'E2E'], ['user.email', 'e2e@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', join(temp, 'no-hooks')]]) git('config', key, value);
git('add', '.'); git('commit', '-q', '-m', 'initial');

const client = new Client({ name: 'live-e2e', version: '1.0.0' });
const transport = new StdioClientTransport({
  // Started inside the project, as Kilo would: the server derives its workspace from this cwd.
  command: process.execPath, args: ['--use-system-ca', resolve('dist/server.js')], cwd: root, stderr: 'pipe',
  env: {
    WORKER_BASE_URL: process.env.WORKER_BASE_URL ?? '',
    WORKER_MODEL: process.env.WORKER_MODEL ?? '',
    HARNESS_MODEL_API_KEY: process.env.HARNESS_MODEL_API_KEY ?? '',
    WORKER_TSCONFIG: 'tsconfig.json',
    ...(process.env.WORKER_TIMEOUT_MS ? { WORKER_TIMEOUT_MS: process.env.WORKER_TIMEOUT_MS } : {}),
    ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
  },
});
transport.stderr?.resume();
const call = async (name, args) => {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw Object.assign(new Error(name), { detail: response.structuredContent.error ?? response.structuredContent });
  return response.structuredContent;
};
// A reply the server could not turn into a candidate is retried, as the role would do: its problems reach the worker automatically.
const MAX_ATTEMPTS = 3;
const NODE_TEST = 'Use node:test (import test from "node:test") and node:assert/strict.';

const scenarios = [
  { name: 'tests', expected: ['clamp.test.ts'],
    start: { objective: 'Cover clamp with unit tests', allowedPaths: ['clamp.test.ts'] },
    context: { files: ['clamp.ts'], brief: `Write tests in clamp.test.ts for clamp from "./clamp.js". ${NODE_TEST}`,
      acceptanceCriteria: ['A value inside the range is returned unchanged', 'A value below min returns min', 'A value above max returns max', 'min greater than max throws RangeError'] } },
  { name: 'feature', expected: ['clamp.ts', 'wrap.test.ts'],
    start: { objective: 'Add wrap to the clamp module', allowedPaths: ['clamp.ts', 'wrap.test.ts'], commitType: 'feat' },
    context: { files: ['clamp.ts'], brief: 'Add an exported function wrap(value: number, min: number, max: number): number to clamp.ts that wraps value into [min, max). '
      + `Keep clamp unchanged and change clamp.ts with edits, not whole content. Write tests for wrap in the new file wrap.test.ts, importing from "./clamp.js". ${NODE_TEST}`,
      acceptanceCriteria: ['wrap(5, 0, 10) returns 5', 'wrap(12, 0, 10) returns 2', 'wrap(-1, 0, 10) returns 9', 'min greater than or equal to max throws RangeError'] } },
];

async function run({ name, start, context, expected }) {
  const result = { name, attempts: 0, invalidReplies: [], candidates: [], usage: [] };
  const { sessionId } = await call('session_start', start);
  await call('context_set', { sessionId, ...context });
  // Scripted reviewer: one reject with a finding, then approve the revision. This proves mechanics, not code quality.
  for (const [message, verdict] of [['Implement the acceptance criteria.', 'reject'], ['Revise according to the findings.', 'approve']]) {
    let chat;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !chat?.candidateId; attempt++) {
      result.attempts++;
      chat = await call('worker_chat', { sessionId, message: attempt ? 'Fix exactly the problems reported for your previous reply.' : message });
      result.usage.push(chat.usage);
      if (!chat.candidateId) result.invalidReplies.push(chat.candidateDiagnostics.map(problem => problem.code));
    }
    if (!chat.candidateId) throw Object.assign(new Error(`${name}: no candidate after ${MAX_ATTEMPTS} attempts`), { detail: result.invalidReplies });
    result.candidates.push({ verdict, files: chat.artifacts.map(({ path, content, edits }) => ({ path, bytes: content.length, edits: edits?.length ?? 0 })) });
    const findings = verdict === 'reject' ? [{ severity: 'minor', message: 'Name each test exactly after the acceptance criterion it covers.' }] : [];
    await call('candidate_review', { sessionId, candidateId: chat.candidateId, verdict, findings });
    if (verdict === 'approve') {
      const applied = await call('candidate_apply', { sessionId, candidateId: chat.candidateId });
      result.applyStatus = applied.status;
      result.applyDiagnostics = applied.diagnostics.map(text => text.slice(0, 400));
      if (applied.status === 'committed') {
        result.commitFiles = git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').trim().split('\n');
        result.commitSubject = git('log', '-1', '--format=%s').trim();
        // The MCP store is untracked here on purpose: the clean check of candidate_apply skips it too.
        result.dirtyPaths = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(line => line && !line.includes('.stateful-worker/'));
        result.ok = result.dirtyPaths.length === 0 && result.commitFiles.join() === expected.join();
      }
    }
  }
  return result;
}

const summary = { ok: false, transport: 'stdio', tlsVerification: true, scenarios: [] };
try {
  await client.connect(transport);
  summary.model = (await call('worker_diagnostics', {})).model;
  for (const scenario of scenarios) summary.scenarios.push(await run(scenario));
  summary.ok = summary.scenarios.every(scenario => scenario.ok);
} catch (error) {
  summary.failedAt = error instanceof Error ? error.message : 'unknown';
  summary.detail = error?.detail;
} finally {
  await client.close();
  rmSync(temp, { recursive: true, force: true });
}
console.log(JSON.stringify(summary));
if (!summary.ok) process.exitCode = 1;
