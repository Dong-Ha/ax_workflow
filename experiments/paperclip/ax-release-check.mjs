import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await files(join(directory, entry.name), relative));
    else if (entry.isFile()) result.push(relative);
    else throw new Error('Release assets must be regular files');
  }
  return result.sort();
}

export async function readReleaseAssetHashes(releasePath) {
  const dist = join(releasePath, 'dist');
  const distInfo = await lstat(dist);
  if (!distInfo.isDirectory()) throw new Error('Release assets must be regular files');
  const assets = await files(dist);
  if (!assets.includes('index.html') || !assets.some(file => file.endsWith('.js'))) throw new Error('Release is missing built application assets');
  const entries = [];
  for (const file of assets) entries.push([file, hash(await readFile(join(dist, file)))]);
  return Object.fromEntries(entries);
}

function validateSourceHashes(sourceHashes) {
  if (!sourceHashes || typeof sourceHashes !== 'object' || Array.isArray(sourceHashes)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(sourceHashes))) {
    throw new Error('Release source hash manifest is invalid');
  }
  const entries = Object.entries(sourceHashes);
  const serverEntries = [];
  for (const [file, value] of entries) {
    if (typeof file !== 'string' || !file || posix.isAbsolute(file) || file.includes('\\')
      || file.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Release source hash manifest path is invalid');
    }
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
      throw new Error('Release source hash manifest is invalid');
    }
    if (file.startsWith('server/')) serverEntries.push([file.slice('server/'.length), value.toLowerCase()]);
  }
  if (!serverEntries.length || serverEntries.some(([file]) => !file)) {
    throw new Error('Release source hash manifest has no server files');
  }
  return Object.fromEntries(serverEntries);
}

async function regularTreeFiles(directory, prefix = '') {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Release runtime tree must contain only regular files and directories');
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = join(directory, entry.name);
    const childInfo = await lstat(absolute);
    if (childInfo.isSymbolicLink()) throw new Error('Release runtime tree must contain only regular files and directories');
    if (childInfo.isDirectory()) result.push(...await regularTreeFiles(absolute, relative));
    else if (childInfo.isFile()) result.push(relative);
    else throw new Error('Release runtime tree must contain only regular files and directories');
  }
  return result.sort();
}

export async function verifyReleaseRuntime(releasePath, sourceHashes) {
  const expected = validateSourceHashes(sourceHashes);
  const releaseInfo = await lstat(releasePath);
  if (!releaseInfo.isDirectory() || releaseInfo.isSymbolicLink()) throw new Error('Release root must be a regular directory');
  const serverRoot = join(releasePath, 'server');
  const actualFiles = await regularTreeFiles(serverRoot);
  const expectedFiles = Object.keys(expected).sort();
  if (actualFiles.length !== expectedFiles.length || actualFiles.some((file, index) => file !== expectedFiles[index])) {
    throw new Error('Release runtime manifest does not match package files');
  }
  const checks = [];
  for (const file of actualFiles) {
    const sha256 = hash(await readFile(join(serverRoot, file)));
    if (sha256 !== expected[file]) throw new Error(`Release runtime file changed after approval: server/${file}`);
    checks.push({ file: `server/${file}`, sha256, status: 'pass' });
  }
  return { verdict: 'pass', checks };
}

function validateExpectedAssetHashes(expectedAssetHashes, diskHashes) {
  if (!expectedAssetHashes || typeof expectedAssetHashes !== 'object' || Array.isArray(expectedAssetHashes)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(expectedAssetHashes))) {
    throw new Error('Release asset hash manifest is invalid');
  }
  const expectedFiles = Object.keys(expectedAssetHashes).sort();
  const diskFiles = Object.keys(diskHashes);
  if (expectedFiles.length !== diskFiles.length || expectedFiles.some((file, index) => file !== diskFiles[index])) {
    throw new Error('Release asset hash manifest does not match package files');
  }
  const normalized = [];
  for (const file of expectedFiles) {
    const expected = expectedAssetHashes[file];
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) throw new Error('Release asset hash manifest is invalid');
    const value = expected.toLowerCase();
    normalized.push([file, value]);
    if (diskHashes[file] !== value) throw new Error(`Release package asset changed after approval: ${file}`);
  }
  return Object.fromEntries(normalized);
}

// Exercise the real release server: browser scenarios mock APIs and static files.
export async function verifyReleaseDelivery(releasePath, address, request = fetch, expectedAssetHashes = undefined) {
  const origin = new URL(address);
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Release verification requires a loopback origin');
  const diskHashes = await readReleaseAssetHashes(releasePath);
  const expectedHashes = expectedAssetHashes == null ? diskHashes : validateExpectedAssetHashes(expectedAssetHashes, diskHashes);
  const assets = Object.keys(diskHashes);
  const checks = [];
  for (const file of assets) {
    const pathname = file.split('/').map(encodeURIComponent).join('/');
    const response = await request(new URL(pathname, origin), { redirect: 'error', signal: AbortSignal.timeout(10000) });
    const expected = expectedHashes[file];
    if (!response.ok || hash(new Uint8Array(await response.arrayBuffer())) !== expected) throw new Error(`Release delivery mismatch: ${file}`);
    checks.push({ asset: file, sha256: expected, status: 'pass' });
  }
  const home = await request(origin, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!home.ok || hash(new Uint8Array(await home.arrayBuffer())) !== expectedHashes['index.html']) throw new Error('Release entry page does not match the approved package');
  return { verdict: 'pass', url: origin.origin, checks };
}
