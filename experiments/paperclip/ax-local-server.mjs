import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ownedServers = new Set();
const DEFAULT_PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const START_TIMEOUT_MS = 20_000;
const TERM_GRACE_MS = 2_000;
const CLOSE_TIMEOUT_MS = 5_000;

function cleanChildEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('PAPERCLIP_') && !key.startsWith('AX_PAPERCLIP_')));
  return { ...env, ...extra };
}

function validatePort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid AX server port');
}

async function assertPortFree(port) {
  await new Promise((resolvePromise, reject) => {
    // A closed port can silently drop connection attempts under host forwarding.
    // Binding checks availability without treating that network behavior as a listener.
    const probe = net.createServer(socket => socket.destroy());
    probe.once('error', () => reject(new Error(`AX port ${port} is occupied or unavailable`)));
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolvePromise()));
  });
}

function makeCloseWait(child) {
  let resolveClosed;
  const promise = new Promise((resolvePromise) => { resolveClosed = resolvePromise; });
  let closed = false;
  child.once('close', (code, signal) => {
    closed = true;
    resolveClosed({ code, signal });
  });
  return { promise, get closed() { return closed; } };
}

async function stopRecord(record) {
  if (record.stopPromise) return record.stopPromise;
  record.stopPromise = (async () => {
    const { child, closed } = record;
    if (!closed.closed) {
      try { child.kill('SIGTERM'); } catch { /* Close may already be underway. */ }
      let timer;
      const termResult = await Promise.race([
        closed.promise.then((result) => ({ result })),
        new Promise((resolvePromise) => { timer = setTimeout(() => resolvePromise(null), TERM_GRACE_MS); }),
      ]);
      clearTimeout(timer);
      if (!termResult) {
        try { child.kill('SIGKILL'); } catch { /* The process may have exited between checks. */ }
      }
    }
    let closeTimer;
    const result = closed.closed
      ? await closed.promise
      : await Promise.race([
        closed.promise,
        new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error('AX server did not close after termination')), CLOSE_TIMEOUT_MS); }),
      ]);
    clearTimeout(closeTimer);
    ownedServers.delete(record);
    return result;
  })().catch((error) => {
    ownedServers.delete(record);
    throw error;
  });
  return record.stopPromise;
}

export async function stopOwnedServers() {
  const results = await Promise.allSettled([...ownedServers].map(stopRecord));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw new Error('One or more owned AX servers did not stop cleanly');
}

export async function startAX(workspace, port, { projectRoot } = {}) {
  validatePort(port);
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) throw new Error('Workspace must be an absolute path');
  const cwd = resolve(workspace);
  const root = projectRoot === undefined ? DEFAULT_PROJECT_ROOT : projectRoot;
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('Project root must be an absolute path');
  await assertPortFree(port);

  let child;
  let record;
  try {
    child = spawn(process.execPath, ['server/index.mjs'], {
      cwd,
      env: cleanChildEnv({ PORT: String(port), AX_PROJECT_ROOT: resolve(root) }),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const closed = makeCloseWait(child);
    record = { child, closed, stopPromise: null };
    ownedServers.add(record);

    let spawnError = null;
    child.once('error', (error) => { spawnError = error; });
    let stdoutBuffer = '';
    let gotReadyReceipt = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (gotReadyReceipt) return;
      stdoutBuffer = (stdoutBuffer + chunk).slice(-8192);
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      const expected = `AX 관제 페이지: http://127.0.0.1:${port}`;
      if (lines.some((line) => line === expected)) gotReadyReceipt = true;
    });

    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (spawnError) throw new Error('AX verification server failed to spawn');
      if (closed.closed) throw new Error('AX verification server exited before becoming ready');
      if (gotReadyReceipt) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(750) });
          if (response.ok && !closed.closed && child.exitCode === null && child.signalCode === null) return { url, child, stop: () => stopRecord(record) };
        } catch { /* Only accept HTTP readiness from this process after its exact stdout receipt. */ }
      }
      await delay(100);
    }
    throw new Error('AX verification server did not become ready');
  } catch (error) {
    if (record) {
      try { await stopRecord(record); } catch { /* Preserve the startup failure. */ }
    } else if (child) {
      try { child.kill('SIGTERM'); } catch { /* Spawn may have failed before a process existed. */ }
    }
    throw error;
  }
}
