import assert from 'node:assert/strict';
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
  command: process.execPath, args: ['--use-system-ca', 'dist/server.js'], cwd: process.cwd(), stderr: 'pipe',
  env: {
    WORKER_BASE_URL: process.env.WORKER_BASE_URL ?? '',
    WORKER_MODEL: process.env.WORKER_MODEL ?? '',
    HARNESS_MODEL_API_KEY: process.env.HARNESS_MODEL_API_KEY ?? '',
    WORKER_WORKSPACE_ROOT: root, WORKER_TSCONFIG: 'tsconfig.json',
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
const summary = { ok: false, transport: 'stdio', tlsVerification: true, candidates: [], usage: [] };
try {
  await client.connect(transport);
  summary.model = (await call('worker_diagnostics', {})).model;
  const { sessionId } = await call('session_start', { objective: 'Cover clamp with unit tests', allowedPaths: ['clamp.test.ts'] });
  await call('context_set', { sessionId, files: ['clamp.ts'], brief: 'Write node:test tests (import test from "node:test", assert from "node:assert/strict") for clamp from "./clamp.js".',
    acceptanceCriteria: ['A value inside the range is returned unchanged', 'A value below min returns min', 'A value above max returns max', 'min greater than max throws RangeError'] });
  // Scripted reviewer: one reject with a finding, then approve the revision. This proves mechanics, not test quality.
  for (const [message, verdict] of [['Write the tests.', 'reject'], ['Revise the tests according to the findings.', 'approve']]) {
    const chat = await call('worker_chat', { sessionId, message });
    summary.usage.push(chat.usage);
    if (!chat.candidateId) throw Object.assign(new Error('no candidate'), { detail: chat.candidateDiagnostics });
    assert.equal(chat.responsePreview, undefined);
    assert.ok(chat.artifact.content.length > 0);
    summary.candidates.push({ codeLength: chat.artifact.content.length, verdict });
    const findings = verdict === 'reject' ? [{ severity: 'minor', message: 'Name each test exactly after the acceptance criterion it covers.' }] : [];
    await call('candidate_review', { sessionId, candidateId: chat.candidateId, verdict, findings });
    if (verdict === 'approve') {
      const applied = await call('candidate_apply', { sessionId, candidateId: chat.candidateId });
      summary.applyStatus = applied.status;
      summary.applyDiagnostics = applied.diagnostics.map(text => text.slice(0, 400));
      if (applied.status === 'committed') {
        summary.commitFiles = git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').trim().split('\n');
        summary.commitSubject = git('log', '-1', '--format=%s');
        summary.treeClean = git('status', '--porcelain').trim() === '';
        summary.ok = summary.treeClean && summary.commitFiles.join() === 'clamp.test.ts';
      }
    }
  }
} catch (error) {
  summary.failedAt = error instanceof Error ? error.message : 'unknown';
  summary.detail = error?.detail;
} finally {
  await client.close();
  rmSync(temp, { recursive: true, force: true });
}
console.log(JSON.stringify(summary));
if (!summary.ok) process.exitCode = 1;
