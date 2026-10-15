import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runnerSource = path.join(root, 'tests/ifpmic-source-upload.mjs');
const evidencePath = path.join(root, 'workflow-artifacts/verification/V0/negative-fixtures.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const reportCases = [];

test('source upload child runner passes a valid isolated source fixture', async t => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const result = await runFixture(fixture.root);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = await readReport(fixture.root);
  assert.equal(report.verdict, 'pass');
  assert.deepEqual(report.checks.map(check => check.verdict), ['pass', 'pass']);
  record('valid-fixture', 'runner exits 0 and reports pass', result, report);
});

test('source upload child runner rejects a controlled manifest ZIP hash mutation', async t => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  fixture.manifest.source_files.zip.sha256 = '0'.repeat(64);
  await saveManifest(fixture);
  const result = await runFixture(fixture.root);
  const report = await readReport(fixture.root);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(report.verdict, 'fail');
  assert.equal(report.checks[0].verdict, 'fail');
  record('manifest-hash-mutation', 'runner exits 1 and reports first check fail', result, report);
});

test('source upload child runner rejects changed imported disk bytes', async t => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const rel = Object.keys(fixture.manifest.imported_files)[0];
  await writeFile(path.join(fixture.root, 'docs/ifpmic/design-v1', rel), Buffer.from('controlled mutation'));
  const result = await runFixture(fixture.root);
  const report = await readReport(fixture.root);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(report.verdict, 'fail');
  assert.equal(report.checks[0].verdict, 'pass');
  assert.equal(report.checks[1].verdict, 'fail');
  record('imported-byte-mutation', 'runner exits 1 and reports imported-file check fail', result, report);
});

test('source upload child runner rejects a missing imported file', async t => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const rel = Object.keys(fixture.manifest.imported_files)[0];
  await rm(path.join(fixture.root, 'docs/ifpmic/design-v1', rel));
  const result = await runFixture(fixture.root);
  const report = await readReport(fixture.root);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(report.verdict, 'fail');
  assert.equal(report.checks[0].verdict, 'pass');
  assert.equal(report.checks[1].verdict, 'fail');
  record('missing-imported-file', 'runner exits 1 and reports imported-file check fail', result, report);
});

test('negative fixture evidence includes actual child-run outcomes and zero network calls', async () => {
  assert.equal(reportCases.length, 4, 'the isolated source runner scenarios must all have executed');
  const evidence = {
    kind: 'ifpmic-source-upload-negative-fixtures',
    runner: 'copied tests/ifpmic-source-upload.mjs executed as a child in isolated temporary roots',
    networkCalls: 0,
    cases: reportCases,
  };
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  const persisted = JSON.parse(await readFile(evidencePath, 'utf8'));
  assert.deepEqual(persisted, evidence);
});

async function createFixture() {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'ifpmic-source-negative-'));
  const paths = Array.from({ length: 17 }, (_, i) => `specs/fixture-${String(i + 1).padStart(2, '0')}.txt`);
  const imported = Object.fromEntries(paths.map(rel => [rel, Buffer.from(`fixture payload for ${rel}`)]));
  const docx = Buffer.from('synthetic DOCX fixture bytes');
  const members = new Map([
    ...Object.entries(imported).map(([rel, bytes]) => [`IFPMIC_AX_Design_v1/${rel}`, bytes]),
    ['IFPMIC_AX_Design_v1/IFPMIC_AX_Design_v1.docx', docx],
  ]);
  const zip = makeStoredZip(members);
  const sourceFiles = path.join(fixtureRoot, 'docs/ifpmic/design-v1');
  await mkdir(path.join(fixtureRoot, 'tests'), { recursive: true });
  await mkdir(sourceFiles, { recursive: true });
  for (const [rel, bytes] of Object.entries(imported)) {
    const target = path.join(sourceFiles, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  await writeFile(path.join(fixtureRoot, 'IFPMIC_AX_Design_Package_v1.zip'), zip);
  await writeFile(path.join(fixtureRoot, 'IFPMIC_AX_Design_v1.docx'), docx);
  await copyFile(runnerSource, path.join(fixtureRoot, 'tests/ifpmic-source-upload.mjs'));
  const manifest = {
    source_files: {
      zip: { path: 'IFPMIC_AX_Design_Package_v1.zip', sha256: hash(zip) },
      docx: {
        path: 'IFPMIC_AX_Design_v1.docx',
        sha256: hash(docx),
        zip_member: 'IFPMIC_AX_Design_v1/IFPMIC_AX_Design_v1.docx',
        zip_member_sha256: hash(docx),
      },
    },
    imported_files: Object.fromEntries(Object.entries(imported).map(([rel, bytes]) => [rel, hash(bytes)])),
  };
  const fixture = { root: fixtureRoot, manifest };
  await saveManifest(fixture);
  return fixture;
}

async function saveManifest(fixture) {
  const file = path.join(fixture.root, 'docs/ifpmic/source-manifest.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(fixture.manifest, null, 2)}\n`);
}

function makeStoredZip(members) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, data] of members) {
    const filename = Buffer.from(name, 'utf8');
    const checksum = crc32(data) >>> 0;
    const local = Buffer.alloc(30 + filename.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    filename.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + filename.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(localOffset, 42);
    filename.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.size, 8);
  end.writeUInt16LE(members.size, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function runFixture(fixtureRoot) {
  const fetchTrap = 'data:text/javascript,globalThis.fetch=()=>{throw new Error(%22NETWORK_TRAP_REACHED%22)}';
  const runner = path.join(fixtureRoot, 'tests/ifpmic-source-upload.mjs');
  const child = spawnSync(process.execPath, ['--import', fetchTrap, runner], {
    cwd: fixtureRoot,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, IFPMIC_PAPERCLIP_URL: '' },
  });
  assert.notEqual(child.error?.code, 'ETIMEDOUT', 'source runner child timed out');
  assert.doesNotMatch(`${child.stdout}\n${child.stderr}`, /NETWORK_TRAP_REACHED/);
  return child;
}

async function readReport(fixtureRoot) {
  return JSON.parse(await readFile(path.join(fixtureRoot, 'workflow-artifacts/verification/V0/source-upload.json'), 'utf8'));
}

function record(name, expected, result, report) {
  reportCases.push({
    name,
    expected,
    actual: {
      exitCode: result.status,
      verdict: report.verdict,
      checkVerdicts: report.checks.map(check => check.verdict),
      networkCalls: 0,
    },
  });
}
