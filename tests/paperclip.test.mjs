import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = path.join(repoRoot, 'experiments/paperclip/stage-agent.mjs');

async function makeMockPaperclip({ blockerStatus = null, checkoutStatus = 200 } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: request.method, url: request.url, body });

    if (request.method === 'GET' && request.url === '/api/issues/test-issue') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: 'test-issue',
        title: 'Local test issue',
        description: 'Only synthetic test content.',
        blockedBy: blockerStatus ? [{ id: 'dependency', status: blockerStatus }] : [],
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/issues/test-issue/checkout') {
      response.writeHead(checkoutStatus, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(checkoutStatus === 200 ? { status: 'in_progress' } : { error: 'conflict' }));
      return;
    }
    if (request.method === 'PATCH' && request.url === '/api/issues/test-issue') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'test-issue' }));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'unexpected local test route' }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    requests,
    apiUrl: `http://127.0.0.1:${address.port}/api`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function runWorker({ stage, mode, workspace, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      workerPath, '--stage', stage, '--mode', mode, '--workspace', workspace,
    ], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function setup(t, { blockerStatus = null, checkoutStatus = 200 } = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'ax-paperclip-test-'));
  const workspace = path.join(tempRoot, 'workspace');
  await mkdir(workspace, { recursive: true });
  const paperclip = await makeMockPaperclip({ blockerStatus, checkoutStatus });
  t.after(async () => {
    await paperclip.close();
    await rm(tempRoot, { recursive: true, force: true });
  });
  const env = {
    PATH: process.env.PATH,
    HOME: tempRoot,
    PAPERCLIP_API_URL: paperclip.apiUrl,
    PAPERCLIP_API_KEY: 'local-test-token-only',
    PAPERCLIP_AGENT_ID: 'test-agent',
    PAPERCLIP_RUN_ID: 'test-run',
    AX_PAPERCLIP_ISSUE_ID: 'test-issue',
  };
  return { tempRoot, workspace, paperclip, env };
}

test('unresolved dependency exits before checkout or workspace writes', async (t) => {
  const { workspace, paperclip, env } = await setup(t, { blockerStatus: 'in_progress' });
  const result = await runWorker({ stage: 'planner', mode: 'smoke', workspace, env });

  assert.equal(result.code, 1, result.stderr || result.stdout);
  assert.deepEqual(paperclip.requests.map(({ method }) => method), ['GET']);
  assert.equal(paperclip.requests.some(({ method }) => method === 'PATCH'), false);
  await assert.rejects(readFile(path.join(workspace, 'requirements.md')));
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /local-test-token-only/);
});

test('checkout conflict exits without mutating the issue', async (t) => {
  const { workspace, paperclip, env } = await setup(t, { checkoutStatus: 409 });
  const result = await runWorker({ stage: 'planner', mode: 'smoke', workspace, env });

  assert.equal(result.code, 1, result.stderr || result.stdout);
  assert.deepEqual(paperclip.requests.map(({ method }) => method), ['GET', 'POST']);
  assert.equal(paperclip.requests.some(({ method }) => method === 'PATCH'), false);
  await assert.rejects(readFile(path.join(workspace, 'requirements.md')));
});

test('failed reviewer verification marks issue blocked and exits nonzero', async (t) => {
  const { tempRoot, workspace, paperclip, env } = await setup(t);
  const fakeBin = path.join(tempRoot, 'bin');
  await mkdir(fakeBin, { recursive: true });
  const fakeCodex = path.join(fakeBin, 'codex');
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const cwd = process.cwd();
await mkdir(path.join(cwd, 'test'), { recursive: true });
await writeFile(path.join(cwd, 'requirements.md'), '# synthetic requirements\\n');
await writeFile(path.join(cwd, 'slugify.mjs'), 'export function slugify(value) { return String(value); }\\n');
await writeFile(path.join(cwd, 'test/slugify.test.mjs'), "import test from 'node:test'; test('intentional failure', () => { throw new Error('synthetic failure'); });\\n");
await writeFile(path.join(cwd, 'report.md'), '# Synthetic report\\n');
const outputIndex = process.argv.indexOf('-o');
if (outputIndex >= 0) await writeFile(process.argv[outputIndex + 1], 'Synthetic final status only.\\n');
`);
  await chmod(fakeCodex, 0o755);
  env.PATH = `${fakeBin}${path.delimiter}${env.PATH}`;

  const result = await runWorker({ stage: 'reviewer', mode: 'codex', workspace, env });
  const patches = paperclip.requests
    .filter(({ method }) => method === 'PATCH')
    .map(({ body }) => JSON.parse(body));

  assert.equal(result.code, 1, result.stderr || result.stdout);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].status, 'blocked');
  assert.match(patches[0].comment, /Stage reviewer failed/);
  assert.equal(patches.some(({ status }) => status === 'done'), false);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /local-test-token-only|Synthetic final status/);
});
