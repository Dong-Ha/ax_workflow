import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { symlink } from 'node:fs/promises';
import {
  validateProfileText,
  getWorkflow,
  createSnapshot,
} from '../runtime/ifpmic/index.mjs';
import {
  cloneProfile,
  schemaMutationCases,
  stableProfileText,
} from './helpers/ifpmic-profile-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const original = path.join(root, 'docs/ifpmic/design-v1/specs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
const deepFrozen = value => value === null || typeof value !== 'object' ||
  (Object.isFrozen(value) && Object.values(value).every(deepFrozen));
const stableIssues = result => result.issues.map(issue => ({ code: issue.code, path: issue.path }));
const pinnedSource = Object.freeze({
  workflow_source_sha256: 'bab40a7abb3929896add1ef2cd074893dd2a7de14d200a5d6cea4b7a77eb0e89',
  state_source_sha256: '0248e130017043539319c56af854f5388a95d33e7e687902a3438fdff414244a',
  agent_source_sha256: 'ca6d4bea7abf0fffe7354c482af0d521c3a2e367217a69923a4bfe43fa27ab64',
});
const pinnedBundleHash = sha(Buffer.from(canonical(pinnedSource), 'utf8'));
const independentSnapshot = (profile, profileVersion) => {
  const payload = {
    format: 'ifpmic.profile-snapshot.v1',
    canonicalization: 'ifpmic-json-v1',
    project_id: profile.project_id,
    profile_version: profileVersion,
    workflow: {
      workflow_id: 'ifpmic-sw-v1',
      schema_version: '1.0.0',
      source_sha256: pinnedSource.workflow_source_sha256,
      state_source_sha256: pinnedSource.state_source_sha256,
      agent_source_sha256: pinnedSource.agent_source_sha256,
      bundle_sha256: pinnedBundleHash,
    },
    profile_sha256: sha(Buffer.from(canonical(profile), 'utf8')),
    profile,
  };
  return { snapshot_id: sha(Buffer.from(canonical(payload), 'utf8')), payload };
};
const pointer = dotted => dotted ? `/${dotted.split('.').join('/')}` : '';
const exampleUnresolvedPaths = [
  'build.artifact_patterns', 'build.kernel_config_digest', 'build.profile_ref', 'build.toolchain_digest',
  'device.adb_serial', 'device.board_id', 'device.boot_identity_method', 'device.bridge_id', 'device.device_id',
  'device.fastboot_serial', 'device.flash_profile_ref', 'device.sqe_expected_cases', 'device.sqe_script_ref',
  'quality.sam.parser_version', 'quality.sam.program_ref', 'quality.sam.rule_version', 'quality.sam.thresholds_ref',
  'quality.static.parser_version', 'quality.static.program_ref', 'quality.static.rule_version', 'quality.static.thresholds_ref',
  'quality.tem.parser_version', 'quality.tem.program_ref', 'quality.tem.rule_version', 'quality.tem.thresholds_ref',
  'release.repository_ref', 'release.reviewers', 'release.target_ref', 'release.version',
  'runtimes.model_id', 'runtimes.provider_profile_ref', 'runtimes.versions.claude_code', 'runtimes.versions.opencode',
  'source.base_ref', 'source.driver_paths', 'source.repository_ref', 'source.test_paths',
].map(pointer).sort();
const profileShape = [
  ['schema_version', 'const'], ['project_id', 'string'], ['mode', 'enum'], ['enabled', 'boolean'],
  ['source', 'object'], ['source.repository_ref', 'string'], ['source.base_ref', 'string'],
  ['source.driver_paths', 'array'], ['source.test_paths', 'array'],
  ['runtimes', 'object'], ['runtimes.primary', 'const'], ['runtimes.secondary', 'const'],
  ['runtimes.provider_profile_ref', 'string'], ['runtimes.model_id', 'string'], ['runtimes.versions', 'object'],
  ['runtimes.versions.claude_code', 'string'], ['runtimes.versions.opencode', 'string'],
  ['build', 'object'], ['build.profile_ref', 'string'], ['build.toolchain_digest', 'string'],
  ['build.kernel_config_digest', 'string'], ['build.timeout_minutes', 'positive_integer'], ['build.artifact_patterns', 'array'],
  ['quality', 'object'], ['quality.sam', 'object'], ['quality.tem', 'object'], ['quality.static', 'object'],
  ...['sam', 'tem', 'static'].flatMap(tool => ['program_ref', 'parser_version', 'rule_version', 'thresholds_ref']
    .map(field => [`quality.${tool}.${field}`, 'string'])),
  ['device', 'object'], ...['bridge_id', 'device_id', 'adb_serial', 'fastboot_serial', 'board_id', 'flash_profile_ref', 'boot_identity_method', 'sqe_script_ref']
    .map(field => [`device.${field}`, 'string']), ['device.sqe_expected_cases', 'array'],
  ['release', 'object'], ['release.mode', 'enum'], ['release.repository_ref', 'string'],
  ['release.target_ref', 'string'], ['release.version', 'string'], ['release.reviewers', 'array'],
  ['approval', 'object'], ['approval.plan_required', 'literal_true'], ['approval.release_required', 'literal_true'],
  ['approval.require_distinct_approver', 'boolean'], ['validation', 'string'],
];
const objectPaths = [
  '', 'source', 'runtimes', 'runtimes.versions', 'build', 'quality', 'quality.sam', 'quality.tem',
  'quality.static', 'device', 'release', 'approval',
];
const getParent = (value, dotted) => {
  const bits = dotted.split('.');
  const key = bits.pop();
  return { parent: bits.reduce((at, part) => at[part], value), key };
};
const assertRejectedSchema = (profile, label, expectedPointer, allowParentPath) => {
  const result = validateProfileText(JSON.stringify(profile));
  assert.equal(result.schema_valid, false, label);
  assert.equal(result.configuration, null, label);
  assert.ok(result.issues.some(issue => issue.code === 'SCHEMA_INVALID'), label);
  if (!expectedPointer) return;
  assert.ok(result.issues.some(issue => issue.code === 'SCHEMA_INVALID' && (
    issue.path === expectedPointer || (allowParentPath && expectedPointer.startsWith(`${issue.path}/`))
  )), `${label}: expected known path ${expectedPointer}, got ${JSON.stringify(stableIssues(result))}`);
};

test('legacy source example is structurally valid but remains disabled mock and unresolved', async () => {
  const text = await readFile(path.join(original, 'project-profile.example.json'), 'utf8');
  const result = validateProfileText(text);
  assert.deepEqual(result, {
    schema_valid: true,
    issues: [],
    configuration: {
      mode: 'mock',
      enabled: false,
      complete: false,
      unresolved_paths: exampleUnresolvedPaths,
    },
    operational_validation: 'not_checked',
    approval: 'not_evaluated',
  });
});

test('independent fully specified real fixture is complete but never operationally approved', () => {
  const result = validateProfileText(stableProfileText());
  assert.deepEqual(result, {
    schema_valid: true,
    issues: [],
    configuration: { mode: 'real', enabled: true, complete: true, unresolved_paths: [] },
    operational_validation: 'not_checked',
    approval: 'not_evaluated',
  });
});

test('schema rejects missing, null, extra, wrong type, enum, and numeric boundary in each profile section', () => {
  assert.equal(schemaMutationCases.length, 24, 'the independent mutation matrix remains fixed');
  for (const scenario of schemaMutationCases) {
    const profile = cloneProfile();
    scenario.mutate(profile);
    const input = JSON.stringify(profile);
    const result = validateProfileText(input);
    assert.equal(result.schema_valid, false, scenario.id);
    assert.equal(result.configuration, null, scenario.id);
    assert.equal(result.operational_validation, 'not_checked', scenario.id);
    assert.equal(result.approval, 'not_evaluated', scenario.id);
    assert.ok(result.issues.some(issue => issue.code === 'SCHEMA_INVALID'), scenario.id);
    assert.ok(result.issues.every(issue =>
      issue.code === 'SCHEMA_INVALID' && typeof issue.path === 'string' && issue.path.startsWith('/')) ||
      result.issues.every(issue => issue.code === 'SCHEMA_INVALID' && issue.path === ''), scenario.id);
    if (scenario.path) {
      assert.ok(result.issues.some(issue => issue.path === scenario.path || scenario.path.startsWith(`${issue.path}/`)),
        `${scenario.id}: issue path should locate the invalid known schema field; got ${JSON.stringify(stableIssues(result))}`);
    }
    assert.doesNotMatch(JSON.stringify(result), /PROFILE_SENTINEL_MUST_NOT_LEAK|provider-profile-fixture|fixture-boot-identity/);
  }
});

test('every required field independently rejects missing, null, and wrong JSON types', () => {
  assert.equal(profileShape.length, 60, 'literal schema inventory is pinned independently');
  for (const [dotted, kind] of profileShape) {
    const expectedPointer = pointer(dotted);
    const deletion = cloneProfile();
    const { parent, key } = getParent(deletion, dotted);
    delete parent[key];
    assertRejectedSchema(deletion, `${dotted} missing`, expectedPointer, true);

    const withNull = cloneProfile();
    getParent(withNull, dotted).parent[key] = null;
    assertRejectedSchema(withNull, `${dotted} null`, expectedPointer, false);

    const wrongType = cloneProfile();
    const bad = kind === 'object' ? [] : kind === 'array' ? {} : kind === 'boolean' || kind === 'literal_true' ? 'true' : kind === 'positive_integer' ? '45' : 42;
    getParent(wrongType, dotted).parent[key] = bad;
    assertRejectedSchema(wrongType, `${dotted} wrong type`, expectedPointer, false);
  }
});

test('every object rejects an unknown additional property without exposing its key or value', () => {
  assert.equal(objectPaths.length, 12);
  for (const dotted of objectPaths) {
    const profile = cloneProfile();
    const target = dotted ? dotted.split('.').reduce((at, part) => at[part], profile) : profile;
    target.B01_UNKNOWN_FIELD_SENTINEL = 'B01_UNKNOWN_VALUE_SENTINEL';
    const result = validateProfileText(JSON.stringify(profile));
    assert.equal(result.schema_valid, false, dotted || 'root');
    assert.equal(result.configuration, null, dotted || 'root');
    assert.ok(result.issues.some(issue => issue.code === 'SCHEMA_INVALID'), dotted || 'root');
    assert.doesNotMatch(JSON.stringify(result), /B01_UNKNOWN_(FIELD|VALUE)_SENTINEL/);
  }
});

test('all four release modes share the same fixed completeness policy', () => {
  const modes = ['team_github_tag', 'shared_gerrit_change', 'shared_github_pr', 'shared_github_commit'];
  const emptyArrayCases = [
    ['/source/driver_paths', profile => { profile.source.driver_paths = []; }],
    ['/source/test_paths', profile => { profile.source.test_paths = []; }],
    ['/build/artifact_patterns', profile => { profile.build.artifact_patterns = []; }],
    ['/device/sqe_expected_cases', profile => { profile.device.sqe_expected_cases = []; }],
    ['/release/reviewers', profile => { profile.release.reviewers = []; }],
  ];
  for (const mode of modes) {
    for (const [unresolvedPath, empty] of emptyArrayCases) {
      const profile = cloneProfile();
      profile.release.mode = mode;
      empty(profile);
      const result = validateProfileText(JSON.stringify(profile));
      assert.equal(result.schema_valid, true, `${mode} ${unresolvedPath}`);
      assert.equal(result.configuration.mode, 'real', mode);
      assert.equal(result.configuration.complete, false, `${mode} ${unresolvedPath}`);
      assert.deepEqual(result.configuration.unresolved_paths, [unresolvedPath], `${mode} ${unresolvedPath}`);
      assert.equal(result.approval, 'not_evaluated', mode);
    }
  }
});

test('mock enabled and marker-free input still does not grant real authorization', () => {
  const profile = cloneProfile();
  profile.mode = 'mock';
  profile.enabled = true;
  const result = validateProfileText(JSON.stringify(profile));
  assert.equal(result.schema_valid, true);
  assert.deepEqual(result.configuration, { mode: 'mock', enabled: true, complete: true, unresolved_paths: [] });
  assert.equal(result.operational_validation, 'not_checked');
  assert.equal(result.approval, 'not_evaluated');
});

test('placeholder matching is case-sensitive and excludes validation/project_id text', () => {
  const profile = cloneProfile();
  profile.project_id = 'CONFIGURE';
  profile.validation = 'APPROVED_BEDROCK_PROFILE';
  profile.source.repository_ref = 'configure';
  const result = validateProfileText(JSON.stringify(profile));
  assert.equal(result.configuration.complete, true);
  assert.deepEqual(result.configuration.unresolved_paths, []);
});

test('each fixed marker is detected in configured string fields, but not in exempt text fields', () => {
  const markerFields = [
    ['CONFIGURE', profile => { profile.source.repository_ref = 'prefix-CONFIGURE-suffix'; }, '/source/repository_ref'],
    ['APPROVED_BEDROCK_PROFILE', profile => { profile.runtimes.provider_profile_ref = 'prefix-APPROVED_BEDROCK_PROFILE-suffix'; }, '/runtimes/provider_profile_ref'],
    ['PIN_AFTER_COMPATIBILITY_TEST', profile => { profile.runtimes.versions.opencode = 'prefix-PIN_AFTER_COMPATIBILITY_TEST-suffix'; }, '/runtimes/versions/opencode'],
    ['INTERNAL_EXISTING_RULES', profile => { profile.quality.tem.thresholds_ref = 'prefix-INTERNAL_EXISTING_RULES-suffix'; }, '/quality/tem/thresholds_ref'],
  ];
  for (const [marker, mutate, expectedPath] of markerFields) {
    const profile = cloneProfile();
    mutate(profile);
    const result = validateProfileText(JSON.stringify(profile));
    assert.equal(result.schema_valid, true, marker);
    assert.equal(result.configuration.complete, false, marker);
    assert.deepEqual(result.configuration.unresolved_paths, [expectedPath], marker);
  }
});

test('strings are not normalized; empty and control-character values follow the fixed string contract', () => {
  const spaced = cloneProfile();
  spaced.source.repository_ref = ' ';
  spaced.source.base_ref = ' ref with surrounding space ';
  assert.equal(validateProfileText(JSON.stringify(spaced)).schema_valid, true);
  for (const controlChar of ['\u0000', '\u0009', '\u000a', '\u007f']) {
    const control = cloneProfile();
    control.source.base_ref = `ref${controlChar}value`;
    const rejected = validateProfileText(JSON.stringify(control));
    assert.equal(rejected.schema_valid, false, `U+${controlChar.charCodeAt(0).toString(16)}`);
    assert.ok(rejected.issues.some(issue => issue.path === '/source/base_ref'));
  }
  const empty = cloneProfile();
  empty.runtimes.model_id = '';
  assert.equal(validateProfileText(JSON.stringify(empty)).schema_valid, false);
});

test('JSON parser errors have fixed codes, stable ordering, and no raw input in the DTO', () => {
  const cases = [
    { name: 'wrong-input-type', value: { secret: 'PROFILE_SENTINEL' }, code: 'INPUT_TYPE' },
    { name: 'invalid-json', value: '{"project_id":', code: 'JSON_INVALID' },
    { name: 'duplicate-key', value: '{"x":1,"x":2}', code: 'JSON_DUPLICATE_KEY' },
    { name: 'escaped-duplicate-key', value: '{"x":1,"\\u0078":2}', code: 'JSON_DUPLICATE_KEY' },
    { name: 'non-finite-number', value: '{"x":NaN}', code: 'JSON_INVALID' },
    { name: 'root-array', value: '[]', code: 'PROFILE_ROOT_INVALID' },
    { name: 'root-null', value: 'null', code: 'PROFILE_ROOT_INVALID' },
  ];
  for (const scenario of cases) {
    const result = validateProfileText(scenario.value);
    assert.equal(result.schema_valid, false, scenario.name);
    assert.equal(result.configuration, null, scenario.name);
    assert.ok(result.issues.some(issue => issue.code === scenario.code), scenario.name);
    assert.deepEqual(result.issues, [...result.issues].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    assert.doesNotMatch(JSON.stringify(result), /PROFILE_SENTINEL|NaN|project_id/);
  }
});

test('JSON depth boundary accepts depth 64 for parsing and rejects depth 65 before schema', () => {
  const nested = depth => `${'{"x":'.repeat(depth)}0${'}'.repeat(depth)}`;
  const accepted = validateProfileText(nested(64));
  assert.equal(accepted.issues.some(issue => issue.code === 'JSON_DEPTH_EXCEEDED'), false);
  const rejected = validateProfileText(nested(65));
  assert.deepEqual(stableIssues(rejected), [{ code: 'JSON_DEPTH_EXCEEDED', path: '' }]);
});

test('UTF-8 byte-size boundary is exact and oversized input is rejected without echoing it', () => {
  const max = 1024 * 1024;
  const prefix = '{"x":"';
  const suffix = '"}';
  const exact = `${prefix}${'é'.repeat(Math.floor((max - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) / 2))}${suffix}`;
  const exactPad = exact + ' '.repeat(max - Buffer.byteLength(exact));
  assert.equal(Buffer.byteLength(exactPad), max);
  const atLimit = validateProfileText(exactPad);
  assert.equal(atLimit.issues.some(issue => issue.code === 'INPUT_TOO_LARGE'), false);
  const tooLarge = validateProfileText(`${exactPad} `);
  assert.deepEqual(stableIssues(tooLarge), [{ code: 'INPUT_TOO_LARGE', path: '' }]);
  assert.doesNotMatch(JSON.stringify(tooLarge), /é{20}/);
});

test('workflow registry returns only fixed contract bundle and immutable registry reference', async () => {
  const expected = {
    workflow_id: 'ifpmic-sw-v1',
    schema_version: '1.0.0',
    source_sha256: 'bab40a7abb3929896add1ef2cd074893dd2a7de14d200a5d6cea4b7a77eb0e89',
    state_source_sha256: '0248e130017043539319c56af854f5388a95d33e7e687902a3438fdff414244a',
    agent_source_sha256: 'ca6d4bea7abf0fffe7354c482af0d521c3a2e367217a69923a4bfe43fa27ab64',
    bundle_sha256: '83146f468cc425fc5851e179a24781ed4ca62babb5d219b2a95f153d8a0bf873',
  };
  const registry = getWorkflow();
  assert.deepEqual(registry.reference, expected);
  assert.deepEqual(Object.keys(registry.contracts).sort(), ['agent', 'state', 'workflow']);
  assert.ok(deepFrozen(registry));
  assert.throws(() => getWorkflow('not-registered'), error => error.code === 'WORKFLOW_UNKNOWN' && error.message === 'WORKFLOW_UNKNOWN' && !error.stack.includes('not-registered'));
  assert.deepEqual(registry.contracts, {
    workflow: await readJson('workflow.v1.json'),
    state: await readJson('state-contract.json'),
    agent: await readJson('agent-contract.json'),
  });
  assert.doesNotMatch(JSON.stringify(registry), /B01_TC_SENTINEL_CREDENTIAL_VALUE/);
  const sources = [
    ['workflow.v1.json', expected.source_sha256],
    ['state-contract.json', expected.state_source_sha256],
    ['agent-contract.json', expected.agent_source_sha256],
  ];
  for (const [name, expectedHash] of sources) {
    assert.equal(await sha(await readFile(path.join(original, name))), expectedHash, name);
  }
});

test('workflow registry detects a changed source pin in an isolated copied module tree', async t => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'ifpmic-profile-registry-pin-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const runtimeDir = path.join(tempRoot, 'runtime/ifpmic');
  const specsDir = path.join(tempRoot, 'docs/ifpmic/design-v1/specs');
  const qaDir = path.join(tempRoot, 'docs/ifpmic/design-v1/qa');
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(specsDir, { recursive: true });
  await mkdir(qaDir, { recursive: true });
  await symlink(path.join(root, 'node_modules'), path.join(tempRoot, 'node_modules'), 'dir');
  for (const module of ['index.mjs', 'profile.mjs', 'snapshot.mjs', 'store.mjs']) {
    await copyFile(path.join(root, 'runtime/ifpmic', module), path.join(runtimeDir, module));
  }
  for (const file of ['workflow.v1.json', 'state-contract.json', 'agent-contract.json']) {
    await copyFile(path.join(original, file), path.join(specsDir, file));
  }
  await copyFile(path.join(root, 'docs/ifpmic/design-v1/qa/package-manifest.json'), path.join(qaDir, 'package-manifest.json'));
  await writeFile(path.join(specsDir, 'state-contract.json'), '\n');
  const isolatedUrl = pathToFileURL(path.join(runtimeDir, 'index.mjs'));
  isolatedUrl.searchParams.set('isolated', String(Date.now()));
  const isolated = await import(isolatedUrl.href);
  assert.throws(() => isolated.getWorkflow(), error => error.code === 'CONTRACT_MISMATCH' && error.message === 'CONTRACT_MISMATCH');
});

const readJson = async name => JSON.parse(await readFile(path.join(original, name), 'utf8'));

test('snapshot captures input synchronously, canonical key order, detached deep-frozen payload', async () => {
  const originalText = stableProfileText();
  const profileVersion = 'v-test-01';
  const first = createSnapshot({ profileText: originalText, profileVersion });
  const parsed = JSON.parse(originalText);
  const reverseKeys = value => {
    if (Array.isArray(value)) return value.map(reverseKeys);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reverseKeys(nested)]));
    return value;
  };
  const reorderedText = JSON.stringify(reverseKeys(parsed));
  const reordered = createSnapshot({ profileText: reorderedText, profileVersion });
  assert.equal(first.snapshot_id, reordered.snapshot_id);
  assert.deepEqual(first, reordered);
  assert.equal(first.payload.profile.project_id, 'tc-fixed-project');
  assert.equal(first.payload.workflow.state_source_sha256, '0248e130017043539319c56af854f5388a95d33e7e687902a3438fdff414244a');
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.payload) && Object.isFrozen(first.payload.profile.source));
  const arrayReordered = cloneProfile();
  arrayReordered.source.driver_paths.reverse();
  const reorderedArray = createSnapshot({ profileText: JSON.stringify(arrayReordered), profileVersion });
  assert.notEqual(reorderedArray.snapshot_id, first.snapshot_id);
  assert.throws(() => createSnapshot({ profileText: '{"mode":"mock"}', profileVersion }), error => error.code === 'PROFILE_INVALID');
  assert.throws(() => createSnapshot({ profileText: originalText, profileVersion: '' }), error => error.code === 'PROFILE_VERSION_INVALID' && error.message === 'PROFILE_VERSION_INVALID');
  assert.throws(() => createSnapshot({ profileText: originalText, profileVersion: 'bad\u0000version' }), error => error.code === 'PROFILE_VERSION_INVALID' && error.message === 'PROFILE_VERSION_INVALID');
});

test('snapshot identity changes with project, profile version, or business content', () => {
  const profile = cloneProfile();
  const base = createSnapshot({ profileText: JSON.stringify(profile), profileVersion: 'same-version' });
  const newVersion = createSnapshot({ profileText: JSON.stringify(profile), profileVersion: 'new-version' });
  assert.notEqual(base.snapshot_id, newVersion.snapshot_id);
  const newProject = cloneProfile();
  newProject.project_id = 'tc-another-project';
  const projectSnapshot = createSnapshot({ profileText: JSON.stringify(newProject), profileVersion: 'same-version' });
  assert.notEqual(base.snapshot_id, projectSnapshot.snapshot_id);
  const changedBusinessValue = cloneProfile();
  changedBusinessValue.release.target_ref = 'refs/tags/v9.9.9';
  const changedSnapshot = createSnapshot({ profileText: JSON.stringify(changedBusinessValue), profileVersion: 'same-version' });
  assert.notEqual(base.snapshot_id, changedSnapshot.snapshot_id);
});

test('snapshot digest matches a fixed independently computed canonical fixture vector', () => {
  const record = createSnapshot({ profileText: stableProfileText(), profileVersion: 'vector-v1' });
  const profileHash = sha(Buffer.from(canonical(JSON.parse(stableProfileText())), 'utf8'));
  const source = {
    workflow_source_sha256: 'bab40a7abb3929896add1ef2cd074893dd2a7de14d200a5d6cea4b7a77eb0e89',
    state_source_sha256: '0248e130017043539319c56af854f5388a95d33e7e687902a3438fdff414244a',
    agent_source_sha256: 'ca6d4bea7abf0fffe7354c482af0d521c3a2e367217a69923a4bfe43fa27ab64',
  };
  const bundleHash = sha(Buffer.from(canonical(source), 'utf8'));
  const expectedPayload = {
    format: 'ifpmic.profile-snapshot.v1',
    canonicalization: 'ifpmic-json-v1',
    project_id: 'tc-fixed-project',
    profile_version: 'vector-v1',
    workflow: {
      workflow_id: 'ifpmic-sw-v1',
      schema_version: '1.0.0',
      source_sha256: source.workflow_source_sha256,
      state_source_sha256: source.state_source_sha256,
      agent_source_sha256: source.agent_source_sha256,
      bundle_sha256: bundleHash,
    },
    profile_sha256: profileHash,
    profile: JSON.parse(stableProfileText()),
  };
  assert.deepEqual(record.payload, expectedPayload);
  assert.equal(record.payload.canonicalization, 'ifpmic-json-v1');
  assert.equal(record.payload.format, 'ifpmic.profile-snapshot.v1');
  assert.equal(profileHash, '8d6632e906c695020020b37c7c970f7dbd1515a5b5de27c60487198656d139a7');
  assert.equal(bundleHash, '83146f468cc425fc5851e179a24781ed4ca62babb5d219b2a95f153d8a0bf873');
  assert.equal(record.snapshot_id, '0e2e6287ec5cfc0a089ac3badaeedc5215e3e5349a4157e8e9df41c346f1d2bf');
  assert.equal(record.snapshot_id, sha(Buffer.from(canonical(expectedPayload), 'utf8')));
});

test('createSnapshot accepts canonical record bytes exactly at 2 MiB and rejects one byte over', () => {
  const profile = cloneProfile();
  const limit = 2 * 1024 * 1024;
  const emptyVersion = independentSnapshot(profile, '');
  const emptyRecordBytes = Buffer.byteLength(`${canonical(emptyVersion)}\n`, 'utf8');
  const exactVersionLength = limit - emptyRecordBytes;
  assert.ok(exactVersionLength > 0);
  const exactVersion = 'v'.repeat(exactVersionLength);
  const expectedExact = independentSnapshot(profile, exactVersion);
  assert.equal(Buffer.byteLength(`${canonical(expectedExact)}\n`, 'utf8'), limit);
  const actualExact = createSnapshot({ profileText: JSON.stringify(profile), profileVersion: exactVersion });
  assert.deepEqual(actualExact, expectedExact);
  assert.equal(Buffer.byteLength(`${canonical(actualExact)}\n`, 'utf8'), limit);
  const oneByteOver = `${exactVersion}v`;
  assert.equal(Buffer.byteLength(`${canonical(independentSnapshot(profile, oneByteOver))}\n`, 'utf8'), limit + 1);
  assert.throws(
    () => createSnapshot({ profileText: JSON.stringify(profile), profileVersion: oneByteOver }),
    error => error.code === 'PROFILE_VERSION_INVALID' && error.message === 'PROFILE_VERSION_INVALID',
  );
});
