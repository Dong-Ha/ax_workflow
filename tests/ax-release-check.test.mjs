import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readReleaseAssetHashes, verifyReleaseDelivery, verifyReleaseRuntime } from '../experiments/paperclip/ax-release-check.mjs';

async function releaseFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ax-release-check-'));
  const dist = join(root, 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body>approved</body></html>');
  await writeFile(join(dist, 'assets/app.js'), 'console.log("approved build");\n');
  await writeFile(join(dist, 'assets/app.css'), 'body { color: #123; }\n');
  const serverState = { overrides: new Map(), requests: [] };
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    serverState.requests.push(pathname);
    const override = serverState.overrides.get(pathname);
    if (override?.redirect) {
      response.writeHead(302, { Location: override.redirect });
      response.end();
      return;
    }
    if (override?.status) {
      response.writeHead(override.status);
      response.end('synthetic missing asset');
      return;
    }
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    try {
      const bytes = override?.bytes ?? await readFile(join(dist, relative));
      response.writeHead(200, { 'Content-Type': relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : 'text/html' });
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  t.after(() => rm(root, { recursive: true, force: true }));
  const address = `http://127.0.0.1:${server.address().port}/`;
  return { root, dist, address, serverState };
}

async function runtimeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ax-release-runtime-'));
  const server = join(root, 'server');
  await mkdir(join(server, 'nested'), { recursive: true });
  await writeFile(join(server, 'index.mjs'), 'export const ready = true;\n');
  await writeFile(join(server, 'nested/store.mjs'), 'export const store = true;\n');
  const sourceHashes = {
    'App.tsx': 'a'.repeat(64),
    'server/index.mjs': createHash('sha256').update(await readFile(join(server, 'index.mjs'))).digest('hex'),
    'server/nested/store.mjs': createHash('sha256').update(await readFile(join(server, 'nested/store.mjs'))).digest('hex'),
  };
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, server, sourceHashes };
}

test('verifies every exact packaged runtime file against the source fingerprint', async t => {
  const fixture = await runtimeFixture(t);
  const result = await verifyReleaseRuntime(fixture.root, fixture.sourceHashes);
  assert.equal(result.verdict, 'pass');
  assert.deepEqual(result.checks.map(check => check.file), ['server/index.mjs', 'server/nested/store.mjs']);
  assert.ok(result.checks.every(check => check.status === 'pass' && /^[a-f0-9]{64}$/.test(check.sha256)));
});

test('rejects runtime content changes, missing files, and added files', async t => {
  const changed = await runtimeFixture(t);
  await writeFile(join(changed.server, 'index.mjs'), 'export const ready = false;\n');
  await assert.rejects(verifyReleaseRuntime(changed.root, changed.sourceHashes), /changed after approval/);

  const missing = await runtimeFixture(t);
  await rm(join(missing.server, 'nested/store.mjs'));
  await assert.rejects(verifyReleaseRuntime(missing.root, missing.sourceHashes), /manifest does not match package files/);

  const extra = await runtimeFixture(t);
  await writeFile(join(extra.server, 'extra.mjs'), 'export {};\n');
  await assert.rejects(verifyReleaseRuntime(extra.root, extra.sourceHashes), /manifest does not match package files/);
});

test('rejects malformed maps, missing server baselines, unsafe paths, and malformed hashes', async t => {
  const fixture = await runtimeFixture(t);
  await assert.rejects(verifyReleaseRuntime(fixture.root, null), /manifest is invalid/);
  await assert.rejects(verifyReleaseRuntime(fixture.root, Object.create({ inherited: 'a'.repeat(64) })), /manifest is invalid/);
  await assert.rejects(verifyReleaseRuntime(fixture.root, { 'App.tsx': 'a'.repeat(64) }), /no server files/);
  for (const file of ['server/../outside', 'server//empty', 'server\\bad', '/server/absolute']) {
    await assert.rejects(verifyReleaseRuntime(fixture.root, { ...fixture.sourceHashes, [file]: 'a'.repeat(64) }), /path is invalid/);
  }
  await assert.rejects(verifyReleaseRuntime(fixture.root, { ...fixture.sourceHashes, 'server/index.mjs': 'not-a-hash' }), /manifest is invalid/);
});

test('rejects symlink release roots, runtime roots, nested directories, and files', async t => {
  const rootFixture = await runtimeFixture(t);
  const rootLink = `${rootFixture.root}-root-link`;
  await symlink(rootFixture.root, rootLink, 'dir');
  t.after(() => rm(rootLink, { force: true }));
  await assert.rejects(verifyReleaseRuntime(rootLink, rootFixture.sourceHashes), /Release root/);

  const serverFixture = await runtimeFixture(t);
  const rootWithServerLink = `${serverFixture.root}-linked-server-root`;
  await mkdir(rootWithServerLink);
  await symlink(serverFixture.server, join(rootWithServerLink, 'server'), 'dir');
  t.after(() => rm(rootWithServerLink, { recursive: true, force: true }));
  await assert.rejects(verifyReleaseRuntime(rootWithServerLink, serverFixture.sourceHashes), /regular files and directories/);

  const directoryFixture = await runtimeFixture(t);
  await symlink(join(directoryFixture.server, 'nested'), join(directoryFixture.server, 'nested-link'), 'dir');
  await assert.rejects(verifyReleaseRuntime(directoryFixture.root, directoryFixture.sourceHashes), /regular files and directories/);

  const fileFixture = await runtimeFixture(t);
  await symlink(join(fileFixture.server, 'index.mjs'), join(fileFixture.server, 'linked-file.mjs'), 'file');
  await assert.rejects(verifyReleaseRuntime(fileFixture.root, fileFixture.sourceHashes), /regular files and directories/);
});

test('uses own entries for prototype-like runtime filenames', async t => {
  const fixture = await runtimeFixture(t);
  const bytes = 'prototype-shaped file';
  await writeFile(join(fixture.server, '__proto__'), bytes);
  const sourceHashes = Object.fromEntries([
    ...Object.entries(fixture.sourceHashes),
    ['server/__proto__', createHash('sha256').update(bytes).digest('hex')],
  ]);
  const result = await verifyReleaseRuntime(fixture.root, sourceHashes);
  assert.deepEqual(result.checks.map(check => check.file), ['server/__proto__', 'server/index.mjs', 'server/nested/store.mjs']);
});

test('verifies every built asset and the root entry from the actual loopback release server', async t => {
  const fixture = await releaseFixture(t);
  const result = await verifyReleaseDelivery(fixture.root, fixture.address);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.url, new URL(fixture.address).origin);
  assert.deepEqual(result.checks.map(check => check.asset), ['assets/app.css', 'assets/app.js', 'index.html']);
  assert.ok(result.checks.every(check => check.status === 'pass' && /^[a-f0-9]{64}$/.test(check.sha256)));
  assert.deepEqual(fixture.serverState.requests, ['/assets/app.css', '/assets/app.js', '/index.html', '/']);
});

test('reads a canonical sorted asset hash map and verifies disk and HTTP against the recorded map', async t => {
  const fixture = await releaseFixture(t);
  const hashes = await readReleaseAssetHashes(fixture.root);
  assert.deepEqual(Object.keys(hashes), ['assets/app.css', 'assets/app.js', 'index.html']);
  assert.ok(Object.values(hashes).every(value => /^[a-f0-9]{64}$/.test(value)));
  const result = await verifyReleaseDelivery(fixture.root, fixture.address, fetch, hashes);
  assert.equal(result.verdict, 'pass');
  assert.deepEqual(result.checks.map(check => [check.asset, check.sha256]), Object.entries(hashes));
});

test('asset maps retain a regular __proto__ filename as an own hash entry and verify its response', async t => {
  const fixture = await releaseFixture(t);
  const bytes = 'synthetic prototype-named asset';
  await writeFile(join(fixture.dist, '__proto__'), bytes);
  const hashes = await readReleaseAssetHashes(fixture.root);
  assert.equal(Object.hasOwn(hashes, '__proto__'), true);
  assert.equal(hashes.__proto__, createHash('sha256').update(bytes).digest('hex'));
  const result = await verifyReleaseDelivery(fixture.root, fixture.address, fetch, hashes);
  assert.deepEqual(result.checks.find(check => check.asset === '__proto__'), {
    asset: '__proto__', sha256: hashes.__proto__, status: 'pass',
  });
});

test('recorded asset hashes reject post-approval JS or entry-page mutation before any HTTP request', async t => {
  for (const asset of ['assets/app.js', 'index.html']) {
    const fixture = await releaseFixture(t);
    const approvedHashes = await readReleaseAssetHashes(fixture.root);
    await writeFile(join(fixture.dist, asset), `mutated after approval: ${asset}`);
    let requestCount = 0;
    const request = async (...args) => { requestCount += 1; return fetch(...args); };
    await assert.rejects(verifyReleaseDelivery(fixture.root, fixture.address, request, approvedHashes), /changed after approval/);
    assert.equal(requestCount, 0, 'disk integrity is checked before making release HTTP requests');
  }
});

test('recorded asset hash map must contain the exact package paths and valid SHA-256 values', async t => {
  const fixture = await releaseFixture(t);
  const hashes = await readReleaseAssetHashes(fixture.root);
  let requestCount = 0;
  const request = async (...args) => { requestCount += 1; return fetch(...args); };
  const missing = { ...hashes };
  delete missing['assets/app.css'];
  await assert.rejects(verifyReleaseDelivery(fixture.root, fixture.address, request, missing), /manifest does not match package files/);
  await assert.rejects(verifyReleaseDelivery(fixture.root, fixture.address, request, { ...hashes, extra: '0'.repeat(64) }), /manifest does not match package files/);
  await assert.rejects(verifyReleaseDelivery(fixture.root, fixture.address, request, { ...hashes, 'assets/app.js': 'not-a-sha256' }), /manifest is invalid/);
  assert.equal(requestCount, 0);
});

test('legacy verification without a recorded map retains disk-based delivery behavior and report shape', async t => {
  const fixture = await releaseFixture(t);
  const result = await verifyReleaseDelivery(fixture.root, fixture.address, fetch, null);
  assert.deepEqual(Object.keys(result).sort(), ['checks', 'url', 'verdict']);
  assert.ok(result.checks.every(check => Object.keys(check).sort().join(',') === 'asset,sha256,status'));
});

test('rejects a served asset whose bytes differ from the approved dist package', async t => {
  const fixture = await releaseFixture(t);
  fixture.serverState.overrides.set('/assets/app.js', { bytes: Buffer.from('tampered javascript') });
  await assert.rejects(verifyReleaseDelivery(fixture.root, fixture.address), /delivery mismatch: assets\/app\.js/);
});

test('rejects a missing asset even when it exists in the local release package', async t => {
  const fixture = await releaseFixture(t);
  fixture.serverState.overrides.set('/assets/app.css', { status: 404 });
  await assert.rejects(verifyReleaseDelivery(fixture.root, fixture.address), /delivery mismatch: assets\/app\.css/);
});

test('rejects an entry page served at the root when its bytes differ from the approved package', async t => {
  const fixture = await releaseFixture(t);
  fixture.serverState.overrides.set('/', { bytes: Buffer.from('<!doctype html><title>wrong release</title>') });
  await assert.rejects(verifyReleaseDelivery(fixture.root, fixture.address), /entry page does not match/);
});

test('rejects asset redirects instead of silently verifying a different URL', async t => {
  const fixture = await releaseFixture(t);
  fixture.serverState.overrides.set('/assets/app.js', { redirect: 'http://127.0.0.1:9/not-the-release' });
  await assert.rejects(verifyReleaseDelivery(fixture.root, fixture.address), error => error instanceof TypeError && error.cause?.message === 'unexpected redirect');
});

test('rejects non-loopback, non-HTTP, and path-qualified verification origins', async t => {
  const fixture = await releaseFixture(t);
  await assert.rejects(verifyReleaseDelivery(fixture.root, 'https://127.0.0.1:3201'), /loopback origin/);
  await assert.rejects(verifyReleaseDelivery(fixture.root, 'http://example.com'), /loopback origin/);
  await assert.rejects(verifyReleaseDelivery(fixture.root, `${fixture.address}subpath/`), /loopback origin/);
});

test('rejects a package without an index page and JavaScript entry asset', async t => {
  const fixture = await releaseFixture(t);
  await rm(join(fixture.dist, 'assets/app.js'));
  await assert.rejects(verifyReleaseDelivery(fixture.root, fixture.address), /missing built application assets/);
});
