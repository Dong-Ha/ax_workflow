import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { initStore } from '../runtime/ifpmic/index.mjs';
import { cloneProfile, stableProfileText } from './helpers/ifpmic-profile-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'scripts/ifpmic-profile.mjs');
const preload = path.join(root, 'tests/helpers/ifpmic-profile-side-effects.mjs');
const canonical = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
const sha = value => createHash('sha256').update(value).digest('hex');
const sourcePins = {
  workflow_source_sha256: 'bab40a7abb3929896add1ef2cd074893dd2a7de14d200a5d6cea4b7a77eb0e89',
  state_source_sha256: '0248e130017043539319c56af854f5388a95d33e7e687902a3438fdff414244a',
  agent_source_sha256: 'ca6d4bea7abf0fffe7354c482af0d521c3a2e367217a69923a4bfe43fa27ab64',
};
const bundleSha = sha(canonical(sourcePins));
function expectedSnapshot(profile, profileVersion) {
  const payload = {
    format: 'ifpmic.profile-snapshot.v1', canonicalization: 'ifpmic-json-v1',
    project_id: profile.project_id, profile_version: profileVersion,
    workflow: {
      workflow_id: 'ifpmic-sw-v1', schema_version: '1.0.0',
      source_sha256: sourcePins.workflow_source_sha256,
      state_source_sha256: sourcePins.state_source_sha256,
      agent_source_sha256: sourcePins.agent_source_sha256,
      bundle_sha256: bundleSha,
    },
    profile_sha256: sha(canonical(profile)), profile,
  };
  return { snapshot_id: sha(canonical(payload)), payload };
}

function runCli(args, { cwd, ledgerPath, extraEnv = {} }) {
  const importOption = `--import=${pathToFileURL(preload).href}`;
  const env = {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, importOption].filter(Boolean).join(' '),
    B01_TEST_EFFECT_LEDGER: ledgerPath,
    ...extraEnv,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

async function withWorkspace(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ifpmic-profile-cli-'));
  const fixturePath = path.join(directory, 'profile.json');
  const sourceRoot = path.join(directory, 'store');
  const ledgerPath = path.join(directory, 'effects.json');
  await writeFile(fixturePath, stableProfileText());
  await initStore(sourceRoot);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, fixturePath, sourceRoot, ledgerPath };
}

function assertOneLineJson(result, exitCode, expected) {
  assert.equal(result.code, exitCode, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.endsWith('\n'), true);
  assert.equal(result.stdout.trimEnd().includes('\n'), false);
  assert.deepEqual(JSON.parse(result.stdout), expected);
}

async function assertNoForbiddenEffects(ledgerPath) {
  assert.deepEqual(JSON.parse(await readFile(ledgerPath, 'utf8')), []);
}

test('CLI default validates the original disabled mock without emitting source or performing effects', async t => {
  const workspace = await withWorkspace(t);
  const result = await runCli([], workspace);
  const dto = JSON.parse(result.stdout);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  assert.equal(dto.schema_valid, true);
  assert.equal(dto.configuration.mode, 'mock');
  assert.equal(dto.configuration.enabled, false);
  assert.equal(dto.approval, 'not_evaluated');
  assert.equal(dto.operational_validation, 'not_checked');
  assert.doesNotMatch(result.stdout, /CONFIGURE|ifpmic-pilot|APPROVED_BEDROCK_PROFILE|\/home\/dongha/);
  await assertNoForbiddenEffects(workspace.ledgerPath);
});

test('CLI accepts a configured real profile but reports no operational or approval result', async t => {
  const workspace = await withWorkspace(t);
  const result = await runCli(['--profile', workspace.fixturePath, '--require-real-config'], workspace);
  const dto = JSON.parse(result.stdout);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(dto.schema_valid, true);
  assert.deepEqual(dto.configuration, { mode: 'real', enabled: true, complete: true, unresolved_paths: [] });
  assert.equal(dto.operational_validation, 'not_checked');
  assert.equal(dto.approval, 'not_evaluated');
  assert.doesNotMatch(result.stdout, /model-fixture-01|provider-profile-fixture-01|release-repository-fixture/);
  await assertNoForbiddenEffects(workspace.ledgerPath);
});

test('CLI require-real-config returns validation DTO and exit 2 for mock, disabled, and unresolved real profiles', async t => {
  const workspace = await withWorkspace(t);
  const defaultMock = await runCli(['--require-real-config'], workspace);
  const mockDto = JSON.parse(defaultMock.stdout);
  assert.equal(defaultMock.code, 2);
  assert.equal(mockDto.schema_valid, true);
  assert.equal(mockDto.configuration.mode, 'mock');
  assert.equal(mockDto.approval, 'not_evaluated');

  const disabled = cloneProfile();
  disabled.enabled = false;
  const disabledPath = path.join(workspace.directory, 'disabled.json');
  await writeFile(disabledPath, JSON.stringify(disabled));
  const disabledResult = await runCli(['--profile', disabledPath, '--require-real-config'], workspace);
  assert.equal(disabledResult.code, 2);
  assert.equal(JSON.parse(disabledResult.stdout).configuration.enabled, false);

  const incomplete = cloneProfile();
  incomplete.quality.sam.thresholds_ref = 'CONFIGURE';
  const incompletePath = path.join(workspace.directory, 'incomplete.json');
  await writeFile(incompletePath, JSON.stringify(incomplete));
  const incompleteResult = await runCli(['--profile', incompletePath, '--require-real-config'], workspace);
  assert.equal(incompleteResult.code, 2);
  assert.equal(JSON.parse(incompleteResult.stdout).configuration.complete, false);
  for (const result of [defaultMock, disabledResult, incompleteResult]) {
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /CONFIGURE|provider-profile-fixture-01/);
  }
  await assertNoForbiddenEffects(workspace.ledgerPath);
});

test('CLI validation errors do not echo invalid values, source paths, or secret sentinels', async t => {
  const workspace = await withWorkspace(t);
  const invalidPath = path.join(workspace.directory, 'invalid.json');
  await writeFile(invalidPath, JSON.stringify({ ...cloneProfile(), unexpected_private_key: 'B01_PROFILE_SECRET_SENTINEL' }));
  const result = await runCli(['--profile', invalidPath], workspace);
  const dto = JSON.parse(result.stdout);
  assert.equal(result.code, 2);
  assert.equal(result.stderr, '');
  assert.equal(dto.schema_valid, false);
  assert.equal(dto.configuration, null);
  assert.ok(dto.issues.some(issue => issue.code === 'SCHEMA_INVALID'));
  assert.doesNotMatch(result.stdout, /B01_PROFILE_SECRET_SENTINEL|unexpected_private_key|invalid\.json|\/tmp\//);
  await assertNoForbiddenEffects(workspace.ledgerPath);
});

test('CLI rejects malformed UTF-8 distinctly and hides decoder/path details', async t => {
  const workspace = await withWorkspace(t);
  const invalidUtf8 = path.join(workspace.directory, 'invalid-utf8.json');
  await writeFile(invalidUtf8, Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d]));
  const result = await runCli(['--profile', invalidUtf8], workspace);
  assertOneLineJson(result, 2, { error: { code: 'INPUT_ENCODING' } });
  assert.doesNotMatch(result.stdout, /invalid-utf8|tmp|0xff|decode|UTF-8/i);
  await assertNoForbiddenEffects(workspace.ledgerPath);
});

test('CLI rejects profile files over the UTF-8 byte limit without echoing contents', async t => {
  const workspace = await withWorkspace(t);
  const oversized = path.join(workspace.directory, 'oversized-private-profile.json');
  const secret = 'B01_OVERSIZED_SECRET_SENTINEL';
  await writeFile(oversized, Buffer.concat([
    Buffer.from('{"secret":"' + secret + '","padding":"', 'utf8'),
    Buffer.alloc(1024 * 1024, 0x61),
    Buffer.from('"}', 'utf8'),
  ]));
  const result = await runCli(['--profile', oversized], workspace);
  const dto = JSON.parse(result.stdout);
  assert.equal(result.code, 2);
  assert.equal(result.stderr, '');
  assert.equal(dto.schema_valid, false);
  assert.equal(dto.configuration, null);
  assert.ok(dto.issues.some(issue => issue.code === 'INPUT_TOO_LARGE'));
  assert.doesNotMatch(result.stdout, /B01_OVERSIZED_SECRET_SENTINEL|oversized-private-profile|\/tmp\//u);
  await assertNoForbiddenEffects(workspace.ledgerPath);
});

test('CLI profile read failures use fixed PROFILE_IO and exit 3 without leaking the file name', async t => {
  const workspace = await withWorkspace(t);
  const missing = path.join(workspace.directory, 'MISSING_PROFILE_SENTINEL.json');
  const result = await runCli(['--profile', missing], workspace);
  assertOneLineJson(result, 3, { error: { code: 'PROFILE_IO' } });
  assert.doesNotMatch(result.stdout, /MISSING_PROFILE_SENTINEL|tmp|ENOENT/);
  await assertNoForbiddenEffects(workspace.ledgerPath);
});

test('CLI usage errors are exact one-line DTOs with exit 2 and empty stderr', async t => {
  const workspace = await withWorkspace(t);
  const cases = [
    ['--unknown'],
    ['--profile', workspace.fixturePath, '--profile', workspace.fixturePath],
    ['--snapshot', '--read', '--store', workspace.sourceRoot, '--project-id', 'tc-fixed-project', '--profile-version', 'v1'],
    ['--snapshot', '--profile-version', 'v1'],
    ['--read', '--store', workspace.sourceRoot, '--profile-version', 'v1'],
    ['--init-store', '--store', workspace.sourceRoot, '--profile', workspace.fixturePath],
    ['--require-real-config', '--read', '--store', workspace.sourceRoot, '--project-id', 'tc-fixed-project', '--profile-version', 'v1'],
  ];
  for (const args of cases) {
    const result = await runCli(args, workspace);
    assertOneLineJson(result, 2, { error: { code: 'CLI_USAGE' } });
  }
  await assertNoForbiddenEffects(workspace.ledgerPath);
});

test('CLI init, snapshot, and read write only to the explicit local store and return hashes only', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ifpmic-profile-cli-explicit-'));
  const fixturePath = path.join(directory, 'real-profile.json');
  const store = path.join(directory, 'explicit-store');
  const ledgerPath = path.join(directory, 'effects.json');
  await writeFile(fixturePath, stableProfileText());
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = { cwd: directory, ledgerPath };
  const init = await runCli(['--init-store', '--store', store], context);
  assertOneLineJson(init, 0, { initialized: true });
  assert.equal((await lstat(store)).isDirectory(), true);
  assert.equal((await lstat(store)).mode & 0o077, 0);

  const snapshot = await runCli(['--snapshot', '--profile', fixturePath, '--profile-version', 'cli-v1', '--store', store, '--require-real-config'], context);
  assert.equal(snapshot.code, 0, snapshot.stderr || snapshot.stdout);
  assert.equal(snapshot.stderr, '');
  const output = JSON.parse(snapshot.stdout);
  assert.deepEqual(Object.keys(output).sort(), ['bundle_sha256', 'profile_sha256', 'snapshot_id']);
  const independentlyExpected = expectedSnapshot(JSON.parse(stableProfileText()), 'cli-v1');
  assert.deepEqual(output, {
    snapshot_id: independentlyExpected.snapshot_id,
    profile_sha256: independentlyExpected.payload.profile_sha256,
    bundle_sha256: independentlyExpected.payload.workflow.bundle_sha256,
  });
  assert.doesNotMatch(snapshot.stdout, /tc-fixed-project|model-fixture-01|profile_version|payload/);

  const read = await runCli(['--read', '--project-id', 'tc-fixed-project', '--profile-version', 'cli-v1', '--store', store], context);
  assert.deepEqual(JSON.parse(read.stdout), output);
  assert.equal(read.code, 0);
  assert.equal(read.stderr, '');
  const key = sha(canonical(['tc-fixed-project', 'cli-v1']));
  const storedBytes = await readFile(path.join(store, `${key}.snapshot.json`));
  assert.equal(storedBytes.toString('utf8'), `${canonical(independentlyExpected)}\n`);
  assert.deepEqual((await readdir(directory)).sort(), ['effects.json', 'explicit-store', 'real-profile.json']);
  await assertNoForbiddenEffects(ledgerPath);
});

test('CLI init rejects an unprovisioned parent and snapshot rejects a non-directory store with exit 3', async t => {
  const workspace = await withWorkspace(t);
  const absent = path.join(workspace.directory, 'absent-parent', 'new-store');
  const initResult = await runCli(['--init-store', '--store', absent], workspace);
  assertOneLineJson(initResult, 3, { error: { code: 'STORE_INVALID' } });
  const fileRoot = path.join(workspace.directory, 'not-a-directory');
  await writeFile(fileRoot, 'file');
  const snapshotResult = await runCli(['--snapshot', '--profile', workspace.fixturePath, '--profile-version', 'cli-v1', '--store', fileRoot], workspace);
  assertOneLineJson(snapshotResult, 3, { error: { code: 'STORE_INVALID' } });
  assert.doesNotMatch(initResult.stdout + snapshotResult.stdout, /absent-parent|not-a-directory|\/tmp\//);
  await assertNoForbiddenEffects(workspace.ledgerPath);
});

test('CLI/runtime source has no network or child-process imports and runtime guards observe zero calls', async t => {
  const files = [
    'scripts/ifpmic-profile.mjs',
    'runtime/ifpmic/index.mjs',
    'runtime/ifpmic/profile.mjs',
    'runtime/ifpmic/snapshot.mjs',
    'runtime/ifpmic/store.mjs',
  ];
  for (const file of files) {
    const source = await readFile(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()\s*['"](?:node:)?(?:child_process|http|https|net|tls|worker_threads)['"]/u, file);
    assert.doesNotMatch(source, /\bfetch\s*\(/u, file);
  }
  const workspace = await withWorkspace(t);
  const result = await runCli([], workspace);
  assert.equal(result.code, 0);
  await assertNoForbiddenEffects(workspace.ledgerPath);
});
