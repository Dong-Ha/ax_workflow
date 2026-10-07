import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startAX, stopOwnedServers } from '../experiments/paperclip/ax-local-server.mjs';

async function workspace(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'ax-local-server-test-'));
  await mkdir(join(root, 'server'));
  await writeFile(join(root, 'server/index.mjs'), source);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function strangerServer() {
  let requests = 0;
  const server = createServer((request, response) => { requests += 1; response.writeHead(200); response.end('stranger remains alive'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, port: server.address().port, get requests() { return requests; }, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

const reportingServer = `
import http from 'node:http';
const port = Number(process.env.PORT);
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({
    projectRoot: process.env.AX_PROJECT_ROOT,
    leakedPaperclipEnv: Object.keys(process.env).filter((key) => key.startsWith('PAPERCLIP_') || key.startsWith('AX_PAPERCLIP_')),
  }));
});
server.listen(port, '127.0.0.1', () => console.log('AX 관제 페이지: http://127.0.0.1:' + port));
`;

test('occupied port is rejected while the unrelated listener remains alive', async t => {
  const root = await workspace(t, reportingServer);
  const stranger = await strangerServer();
  t.after(stranger.close);
  await assert.rejects(startAX(root, stranger.port, { projectRoot: root }), /port .* occupied/);
  assert.equal(stranger.requests, 0, 'the occupied port probe must not send an HTTP request to the unrelated listener');
  const response = await fetch(`http://127.0.0.1:${stranger.port}`);
  assert.equal(stranger.requests, 1);
  assert.equal(await response.text(), 'stranger remains alive');
});

test('HTTP readiness without the exact startup receipt is rejected and its child is cleaned up', { timeout: 25_000 }, async t => {
  const root = await workspace(t, `
import http from 'node:http';
const port = Number(process.env.PORT);
const server = http.createServer((request, response) => { response.writeHead(200); response.end('fake ready'); });
server.listen(port, '127.0.0.1', () => console.log('AX 관제 페이지: http://localhost:' + port));
`);
  const port = await freePort();
  await assert.rejects(startAX(root, port, { projectRoot: root }), /did not become ready/);
  await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) }));
});

test('exact receipt followed by HTTP success accepts the owned server with isolated project root and environment', async t => {
  const root = await workspace(t, reportingServer);
  const projectRoot = await mkdtemp(join(tmpdir(), 'ax-project-root-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const keys = ['PAPERCLIP_API_KEY', 'PAPERCLIP_API_URL', 'AX_PAPERCLIP_URL'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    PAPERCLIP_API_KEY: 'DUMMY_TEST_API_KEY',
    PAPERCLIP_API_URL: 'http://127.0.0.1:1/api',
    AX_PAPERCLIP_URL: 'http://127.0.0.1:2',
  });
  t.after(() => { for (const key of keys) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key]; });
  const port = await freePort();
  const started = await startAX(root, port, { projectRoot });
  t.after(() => started.stop());
  assert.equal(started.url, `http://127.0.0.1:${port}`);
  const response = await fetch(started.url);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { projectRoot, leakedPaperclipEnv: [] });
  await started.stop();
  assert.ok(started.child.exitCode !== null || started.child.signalCode !== null);
});

test('server exiting before its exact receipt is reported as startup failure', async t => {
  const root = await workspace(t, `console.log('booting synthetic server'); process.exit(19);`);
  const port = await freePort();
  await assert.rejects(startAX(root, port, { projectRoot: root }), /exited before becoming ready/);
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(port, '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
});

test('concurrent stop calls are idempotent and escalate a TERM-ignoring owned server to KILL', async t => {
  const root = await workspace(t, `
import http from 'node:http';
const port = Number(process.env.PORT);
process.on('SIGTERM', () => {});
const server = http.createServer((request, response) => { response.writeHead(200); response.end('alive'); });
server.listen(port, '127.0.0.1', () => console.log('AX 관제 페이지: http://127.0.0.1:' + port));
`);
  const started = await startAX(root, await freePort(), { projectRoot: root });
  t.after(() => started.stop());
  const began = Date.now();
  await Promise.all([started.stop(), started.stop()]);
  const elapsed = Date.now() - began;
  assert.ok(elapsed >= 1_800, `TERM grace elapsed before KILL escalation (${elapsed}ms)`);
  assert.ok(elapsed < 5_000, `owned server stop is bounded (${elapsed}ms)`);
  assert.equal(started.child.signalCode, 'SIGKILL');
});

test('stopOwnedServers stops registered AX servers without affecting an unrelated listener', async t => {
  const root = await workspace(t, reportingServer);
  const started = await startAX(root, await freePort(), { projectRoot: root });
  t.after(() => started.stop());
  const stranger = await strangerServer();
  t.after(stranger.close);
  await stopOwnedServers();
  assert.ok(started.child.exitCode !== null || started.child.signalCode !== null);
  const response = await fetch(`http://127.0.0.1:${stranger.port}`);
  assert.equal(await response.text(), 'stranger remains alive');
});

test('controller SIGTERM handler stops an owned AX server and exits 143 without workflow state ownership', { skip: process.platform === 'win32' }, async t => {
  const root = await workspace(t, reportingServer);
  const port = await freePort();
  const controllerUrl = pathToFileURL(fileURLToPath(new URL('../experiments/paperclip/ax-controller.mjs', import.meta.url))).href;
  const localServerUrl = pathToFileURL(fileURLToPath(new URL('../experiments/paperclip/ax-local-server.mjs', import.meta.url))).href;
  const source = `
import { installShutdownHandlers } from ${JSON.stringify(controllerUrl)};
import { startAX } from ${JSON.stringify(localServerUrl)};
installShutdownHandlers();
await startAX(${JSON.stringify(root)}, ${port}, { projectRoot: ${JSON.stringify(root)} });
console.log('HARNESS_READY');
setInterval(() => {}, 1000);
`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('close', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
  let output = '';
  let errorOutput = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { errorOutput += chunk; });
  const ready = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Controller harness did not start: ${output} ${errorOutput}`)), 10_000);
    const poll = () => {
      if (output.includes('HARNESS_READY')) { clearTimeout(deadline); resolve(); }
      else if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(deadline); reject(new Error(`Controller harness exited early: ${output} ${errorOutput}`)); }
      else setTimeout(poll, 20);
    };
    poll();
  });
  await ready;
  assert.equal((await fetch(`http://127.0.0.1:${port}`)).status, 200);
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  child.kill('SIGTERM');
  assert.deepEqual(await closed, { code: 143, signal: null });
  assert.ok(!errorOutput.includes('Controller stopped; verify the tracked Paperclip run'));
  await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) }));
});
