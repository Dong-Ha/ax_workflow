import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createSnapshot, initStore, publishSnapshot, readSnapshot } from '../runtime/ifpmic/index.mjs';
import { cloneProfile, stableProfileText, validProfile } from './helpers/ifpmic-profile-fixtures.mjs';

const workerPath = fileURLToPath(new URL('./helpers/ifpmic-profile-store-worker.mjs', import.meta.url));
const maxRecordBytes = 2 * 1024 * 1024;

async function context(t) {
  const parent = await fs.mkdtemp(join(tmpdir(), 'ifpmic-store-test-'));
  const root = join(parent, 'store');
  await fs.mkdir(root, { mode: 0o700 });
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return { parent, root };
}

async function writeFixture(parent, name, record) {
  const path = join(parent, `${name}.json`);
  await fs.writeFile(path, JSON.stringify({ record }), { mode: 0o600 });
  return path;
}

function startWorker(root, fixturePath, mode = 'publish') {
  const child = fork(workerPath, [root, fixturePath, mode], {
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '';
  let stderr = '';
  const exitPromise = once(child, 'exit');
  const closePromise = once(child, 'close');
  const messages = [];
  const waiters = [];
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.on('message', message => {
    messages.push(message);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].event === message?.event) {
        const [waiter] = waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  return {
    child,
    send: message => child.send(message),
    waitForEvent(event, timeoutMs = 10_000) {
      const found = messages.find(message => message?.event === event);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const waiter = { event, resolve, reject };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Worker did not emit ${event}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    async finish() {
      const [code, signal] = await exitPromise;
      await closePromise;
      let result;
      try { result = JSON.parse(stdout.trim().split('\n').at(-1)); }
      catch { result = null; }
      return { code, signal, result, stdout, stderr };
    },
  };
}

async function createRecord(profile = validProfile, profileVersion = 'store-v1') {
  return createSnapshot({ profileText: stableProfileText(profile), profileVersion });
}

function canonicalForTest(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalForTest).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalForTest(value[key])}`).join(',')}}`;
}

async function snapshotFiles(root) {
  return (await fs.readdir(root)).filter(name => name.endsWith('.snapshot.json'));
}

async function finalPath(root) {
  const files = await snapshotFiles(root);
  assert.equal(files.length, 1);
  return join(root, files[0]);
}

test('P3 independent processes race identical and conflicting payloads for one profile identity', async t => {
  const { parent, root } = await context(t);
  const first = await createRecord(validProfile, 'process-race-v1');
  const changed = cloneProfile();
  changed.build.timeout_minutes += 1;
  const second = await createRecord(changed, 'process-race-v1');

  const identicalPath = await writeFixture(parent, 'same', first);
  const sameA = startWorker(root, identicalPath, 'barrier-publish');
  const sameB = startWorker(root, identicalPath, 'barrier-publish');
  assert.notEqual(sameA.child.pid, sameB.child.pid);
  await Promise.all([sameA.waitForEvent('ready'), sameB.waitForEvent('ready')]);
  sameA.send({ event: 'publish-now' });
  sameB.send({ event: 'publish-now' });
  const sameResults = await Promise.all([sameA.finish(), sameB.finish()]);
  assert.deepEqual(sameResults.map(result => result.code), [0, 0]);
  assert.deepEqual(sameResults.map(result => result.result?.snapshot_id), [first.snapshot_id, first.snapshot_id]);
  assert.equal((await snapshotFiles(root)).length, 1);
  assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(await finalPath(root))).mode & 0o777, 0o600);

  await fs.rm(await finalPath(root));
  const firstPath = await writeFixture(parent, 'different-a', first);
  const secondPath = await writeFixture(parent, 'different-b', second);
  const differentA = startWorker(root, firstPath, 'barrier-publish');
  const differentB = startWorker(root, secondPath, 'barrier-publish');
  assert.notEqual(differentA.child.pid, differentB.child.pid);
  await Promise.all([differentA.waitForEvent('ready'), differentB.waitForEvent('ready')]);
  differentA.send({ event: 'publish-now' });
  differentB.send({ event: 'publish-now' });
  const differentResults = await Promise.all([differentA.finish(), differentB.finish()]);
  assert.equal(differentResults.filter(result => result.code === 0).length, 1);
  assert.equal(differentResults.filter(result => result.result?.error === 'PROFILE_VERSION_CONFLICT').length, 1);
  const stored = await readSnapshot(root, { projectId: validProfile.project_id, profileVersion: 'process-race-v1' });
  assert.ok([first.snapshot_id, second.snapshot_id].includes(stored.snapshot_id));
  assert.equal((await snapshotFiles(root)).length, 1);
});

test('P3 an EEXIST contender directory-syncs before success while the winning process is paused', async t => {
  const { parent, root } = await context(t);
  const record = await createRecord(validProfile, 'sync-contender-v1');
  const fixturePath = await writeFixture(parent, 'contender', record);
  const winner = startWorker(root, fixturePath, 'pause-after-link');
  await winner.waitForEvent('linked-before-dir-sync');

  const contender = startWorker(root, fixturePath, 'observe-dir-sync');
  await contender.waitForEvent('directory-sync-complete');
  winner.send({ event: 'resume' });
  const [winnerResult, contenderResult] = await Promise.all([winner.finish(), contender.finish()]);
  assert.equal(winnerResult.code, 0, winnerResult.stderr);
  assert.equal(contenderResult.code, 0, contenderResult.stderr);
  assert.equal(winnerResult.result?.snapshot_id, record.snapshot_id);
  assert.equal(contenderResult.result?.snapshot_id, record.snapshot_id);
  assert.equal((await snapshotFiles(root)).length, 1);
});

test('P3 pre-link failures leave no final record; ambiguous link and directory-sync failures preserve and retry it', async t => {
  const { root } = await context(t);
  const record = await createRecord(validProfile, 'fault-injection-v1');

  for (const stage of ['write', 'file-sync', 'close']) {
    const io = {
      ...fs,
      open: async (path, ...args) => {
        const handle = await fs.open(path, ...args);
        if (!path.endsWith('.tmp')) return handle;
        const wrapper = {
          writeFile: handle.writeFile.bind(handle),
          sync: handle.sync.bind(handle),
          close: handle.close.bind(handle),
          stat: handle.stat.bind(handle),
          readFile: handle.readFile.bind(handle),
        };
        if (stage === 'write') wrapper.writeFile = async () => { throw Object.assign(new Error('private-write-sentinel'), { code: 'EIO' }); };
        if (stage === 'file-sync') wrapper.sync = async () => { throw Object.assign(new Error('private-sync-sentinel'), { code: 'EIO' }); };
        if (stage === 'close') {
          let firstClose = true;
          wrapper.close = async () => {
            if (firstClose) { firstClose = false; throw Object.assign(new Error('private-close-sentinel'), { code: 'EIO' }); }
            await handle.close();
          };
        }
        return wrapper;
      },
    };
    await assert.rejects(publishSnapshot(root, record, { io }), error => error.code === 'STORE_IO' && error.message === 'STORE_IO');
    assert.deepEqual(await fs.readdir(root), [], `${stage} failure must leave no final or owned temp`);
  }

  for (const stage of ['link-after', 'directory-sync']) {
    const io = {
      ...fs,
      link: async (from, to) => {
        await fs.link(from, to);
        if (stage === 'link-after') throw Object.assign(new Error('private-link-sentinel'), { code: 'EIO' });
      },
      open: async (path, ...args) => {
        const handle = await fs.open(path, ...args);
        if (stage !== 'directory-sync' || path !== root) return handle;
        return {
          writeFile: handle.writeFile.bind(handle),
          close: handle.close.bind(handle),
          stat: handle.stat.bind(handle),
          readFile: handle.readFile.bind(handle),
          sync: async () => { throw Object.assign(new Error('private-dir-sync-sentinel'), { code: 'EIO' }); },
        };
      },
    };
    await assert.rejects(publishSnapshot(root, record, { io }), error => error.code === 'PUBLICATION_UNCERTAIN' && error.message === 'PUBLICATION_UNCERTAIN');
    const path = await finalPath(root);
    const beforeRetry = await fs.readFile(path);
    const retried = await publishSnapshot(root, record);
    assert.equal(retried.snapshot_id, record.snapshot_id);
    assert.deepEqual(await fs.readFile(path), beforeRetry, `${stage} retry must not replace final bytes`);
    await fs.rm(path);
  }

  const linkBefore = { ...fs, link: async () => { throw Object.assign(new Error('private-link-before-sentinel'), { code: 'EIO' }); } };
  await assert.rejects(publishSnapshot(root, record, { io: linkBefore }), error => error.code === 'PUBLICATION_UNCERTAIN');
  assert.deepEqual(await snapshotFiles(root), []);
  const afterLinkRetry = await publishSnapshot(root, record);
  assert.equal(afterLinkRetry.snapshot_id, record.snapshot_id);

  const path = await finalPath(root);
  const beforeEqualRetry = await fs.readFile(path);
  const equalRetrySyncFailure = {
    ...fs,
    open: async (openPath, ...args) => {
      const handle = await fs.open(openPath, ...args);
      if (openPath !== root) return handle;
      return {
        writeFile: handle.writeFile.bind(handle), close: handle.close.bind(handle),
        stat: handle.stat.bind(handle), readFile: handle.readFile.bind(handle),
        sync: async () => { throw Object.assign(new Error('private-equal-dir-sync-sentinel'), { code: 'EIO' }); },
      };
    },
  };
  await assert.rejects(publishSnapshot(root, record, { io: equalRetrySyncFailure }), error => error.code === 'PUBLICATION_UNCERTAIN');
  assert.deepEqual(await fs.readFile(path), beforeEqualRetry, 'failed EEXIST directory sync retains the existing final');
  assert.equal((await readSnapshot(root, { projectId: validProfile.project_id, profileVersion: 'fault-injection-v1' })).snapshot_id, record.snapshot_id);
});

test('P3 publication captures a mutable caller record synchronously before its first filesystem await', async t => {
  const { root } = await context(t);
  const original = await createRecord(validProfile, 'capture-before-await-v1');
  const callerRecord = structuredClone(original);
  const pending = publishSnapshot(root, callerRecord);
  callerRecord.payload.profile.release.version = 'mutated-after-call';
  const published = await pending;
  assert.equal(published.snapshot_id, original.snapshot_id);
  assert.equal(published.payload.profile.release.version, validProfile.release.version);
  const readBack = await readSnapshot(root, { projectId: validProfile.project_id, profileVersion: 'capture-before-await-v1' });
  assert.equal(readBack.snapshot_id, original.snapshot_id);
  assert.equal(readBack.payload.profile.release.version, validProfile.release.version);
});

test('P3 initStore sync failure is retryable and creates a private root; cleanup unlink failure cannot roll back a final', async t => {
  const { parent } = await context(t);
  const root = join(parent, 'initialized-store');
  const failParentSync = {
    ...fs,
    open: async (path, ...args) => {
      const handle = await fs.open(path, ...args);
      if (path !== parent) return handle;
      return {
        sync: async () => { throw Object.assign(new Error('private-parent-sync-sentinel'), { code: 'EIO' }); },
        close: handle.close.bind(handle),
      };
    },
  };
  await assert.rejects(initStore(root, { io: failParentSync }), error => error.code === 'STORE_IO');
  assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
  assert.deepEqual(await initStore(root), { initialized: true });

  const record = await createRecord(validProfile, 'unlink-failure-v1');
  const ignoreCleanupFailure = { ...fs, unlink: async () => { throw Object.assign(new Error('private-unlink-sentinel'), { code: 'EIO' }); } };
  const result = await publishSnapshot(root, record, { io: ignoreCleanupFailure });
  assert.equal(result.snapshot_id, record.snapshot_id);
  const path = await finalPath(root);
  assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
  assert.equal((await readSnapshot(root, { projectId: validProfile.project_id, profileVersion: 'unlink-failure-v1' })).snapshot_id, record.snapshot_id);
  assert.equal((await fs.readdir(root)).filter(name => name.endsWith('.tmp')).length, 1, 'failed cleanup may leave an ignored temp link');
});

test('P3 an exactly 2 MiB canonical snapshot record can be published and read', async t => {
  const { root } = await context(t);
  const small = await createRecord(validProfile, 'x');
  const initialBytes = Buffer.byteLength(`${canonicalForTest(small)}\n`, 'utf8');
  const version = `x${'a'.repeat(maxRecordBytes - initialBytes)}`;
  const exact = await createRecord(validProfile, version);
  assert.equal(Buffer.byteLength(`${canonicalForTest(exact)}\n`, 'utf8'), maxRecordBytes);
  const published = await publishSnapshot(root, exact);
  assert.equal(published.snapshot_id, exact.snapshot_id);
  const path = await finalPath(root);
  assert.equal((await fs.stat(path)).size, maxRecordBytes);
  assert.equal((await readSnapshot(root, { projectId: validProfile.project_id, profileVersion: version })).snapshot_id, exact.snapshot_id);
});

test('P3 process death before link leaves an ignored orphan; retry can publish the same immutable record', async t => {
  const { parent, root } = await context(t);
  const record = await createRecord(validProfile, 'kill-before-link-v1');
  const fixturePath = await writeFixture(parent, 'kill-before-link', record);
  const worker = startWorker(root, fixturePath, 'pause-before-link');
  await worker.waitForEvent('before-link');
  worker.child.kill('SIGKILL');
  const killed = await worker.finish();
  assert.equal(killed.signal, 'SIGKILL');
  assert.deepEqual(await snapshotFiles(root), []);
  const orphanNames = (await fs.readdir(root)).filter(name => name.endsWith('.tmp'));
  assert.equal(orphanNames.length, 1);
  const retried = await publishSnapshot(root, record);
  assert.equal(retried.snapshot_id, record.snapshot_id);
  assert.equal((await fs.readdir(root)).filter(name => name.endsWith('.tmp')).length, 1, 'another process orphan is ignored, not adopted or removed');
});

test('P3 process death after link and after directory sync is recovered by verified idempotent retry', async t => {
  for (const [mode, event, version] of [
    ['pause-after-link', 'linked-before-dir-sync', 'kill-after-link-v1'],
    ['pause-after-dir-sync', 'directory-synced-before-response', 'kill-after-sync-v1'],
  ]) {
    await t.test(`crash window ${mode}`, async t => {
      const { parent, root } = await context(t);
      const record = await createRecord(validProfile, version);
      const fixturePath = await writeFixture(parent, mode, record);
      const worker = startWorker(root, fixturePath, mode);
      await worker.waitForEvent(event);
      worker.child.kill('SIGKILL');
      const killed = await worker.finish();
      assert.equal(killed.signal, 'SIGKILL');
      const path = await finalPath(root);
      const completeBytes = await fs.readFile(path);
      const retried = await publishSnapshot(root, record);
      assert.equal(retried.snapshot_id, record.snapshot_id);
      assert.deepEqual(await fs.readFile(path), completeBytes, 'retry verifies the existing complete record without replacement');
    });
  }
});

test('P3 read and publish reject symlink roots, symlink finals, corrupt, identity-mismatched, and oversized records', async t => {
  const { parent, root } = await context(t);
  const other = join(parent, 'other');
  await fs.mkdir(other);
  const rootLink = join(parent, 'store-link');
  await fs.symlink(root, rootLink, 'dir');
  await assert.rejects(readSnapshot(rootLink, { projectId: validProfile.project_id, profileVersion: 'absent' }), error => error.code === 'STORE_INVALID');

  const record = await createRecord(validProfile, 'tamper-v1');
  await publishSnapshot(root, record);
  const path = await finalPath(root);

  const originalBytes = await fs.readFile(path);
  await fs.writeFile(path, '{broken json\n');
  const corruptBytes = await fs.readFile(path);
  await assert.rejects(readSnapshot(root, { projectId: validProfile.project_id, profileVersion: 'tamper-v1' }), error => error.code === 'SNAPSHOT_CORRUPT');
  await assert.rejects(publishSnapshot(root, record), error => error.code === 'SNAPSHOT_CORRUPT');
  assert.deepEqual(await fs.readFile(path), corruptBytes, 'corrupt final is never overwritten');

  await fs.writeFile(path, originalBytes);
  const tampered = JSON.parse(originalBytes.toString('utf8'));
  tampered.payload.profile.build.timeout_minutes += 1;
  await fs.writeFile(path, `${canonicalForTest(tampered)}\n`);
  await assert.rejects(readSnapshot(root, { projectId: validProfile.project_id, profileVersion: 'tamper-v1' }), error => error.code === 'SNAPSHOT_CORRUPT');

  const foreignProfile = cloneProfile();
  foreignProfile.project_id = 'another-project-fixture';
  const foreign = await createRecord(foreignProfile, 'tamper-v1');
  await fs.writeFile(path, `${canonicalForTest(foreign)}\n`);
  await assert.rejects(readSnapshot(root, { projectId: validProfile.project_id, profileVersion: 'tamper-v1' }), error => error.code === 'SNAPSHOT_CORRUPT');

  await fs.writeFile(path, Buffer.alloc(maxRecordBytes + 1, 0x20));
  await assert.rejects(readSnapshot(root, { projectId: validProfile.project_id, profileVersion: 'tamper-v1' }), error => error.code === 'SNAPSHOT_CORRUPT');

  const target = join(other, 'target.json');
  await fs.writeFile(target, originalBytes);
  await fs.rm(path);
  await fs.symlink(target, path);
  await assert.rejects(readSnapshot(root, { projectId: validProfile.project_id, profileVersion: 'tamper-v1' }), error => error.code === 'SNAPSHOT_CORRUPT');
  await assert.rejects(publishSnapshot(root, record), error => error.code === 'SNAPSHOT_CORRUPT');
});

test('P3 malformed caller records reject before any storage I/O and never evaluate accessors', async t => {
  const cases = [
    ['sparse-array', record => { record.payload.extra = Array(2); }],
    ['array-extra-property', record => { record.payload.profile.source.driver_paths.extra = 'ignored-by-JSON'; }],
    ['symbol', record => { record[Symbol('private')] = 'sentinel'; }],
    ['cycle', record => { record.payload.cycle = record; }],
    ['exotic-object', record => { record.payload.extra = new Date(0); }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async t => {
      const { root } = await context(t);
      const record = structuredClone(await createRecord(validProfile, `invalid-record-${name}`));
      mutate(record);
      await assert.rejects(publishSnapshot(root, record), error => error.code === 'SNAPSHOT_CORRUPT' && error.message === 'SNAPSHOT_CORRUPT');
      assert.deepEqual(await fs.readdir(root), [], 'invalid input must be rejected before creating a temp or final file');
    });
  }

  await t.test('accessor-is-not-evaluated', async t => {
    const { root } = await context(t);
    const record = structuredClone(await createRecord(validProfile, 'invalid-record-accessor'));
    let accessed = false;
    Object.defineProperty(record.payload.profile.release, 'version', {
      enumerable: true,
      configurable: true,
      get() { accessed = true; return 'secret-sentinel'; },
    });
    await assert.rejects(publishSnapshot(root, record), error => error.code === 'SNAPSHOT_CORRUPT');
    assert.equal(accessed, false);
    assert.deepEqual(await fs.readdir(root), []);
  });
});
