import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { symlink } from 'node:fs/promises';
import {
  VALID_STAGES, STAGE_OUTPUTS, assertBlockersDone, sanitizedChildEnv, validTopologyVerificationReport, validNavigationVerificationReport,
  taskPrompt, snapshotWorkspace, snapshotStageOutputStats, verifyFreshStageOutputs,
  prohibitedWorkspaceChanges, verifyWorkspaceChanges, verifyArtifacts, runProcess, shutdownOwnedChildGroups,
  normalizeQaFindings, normalizeUnverifiedChecks, fileVersion, fileVersionChanged, browserFailureNames, runQaCommands,
  implementationValidationPath, runImplementationValidations, main,
} from '../experiments/paperclip/ax-stage-agent.mjs';

const ISSUE_ID = '123e4567-e89b-42d3-a456-426614174000';
const testEnvironment = new WeakMap();

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ax-stage-agent-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeArtifacts(workspace, stage) {
  const requiredChecks = [
    'file tests/agent-filter.test.mjs', 'file tests/agent-filter.browser.mjs', 'npm test',
    'npm run build', 'node tests/agent-filter.browser.mjs',
  ].map(command => ({ command, status: 'pass' }));
  for (const relative of STAGE_OUTPUTS[stage]) {
    const file = join(workspace, relative);
    await mkdir(join(file, '..'), { recursive: true });
    if (relative.endsWith('.json')) {
      const value = relative.endsWith('approval.json')
        ? { approved: true, reason: 'Reviewed synthetic QA evidence.' }
        : relative.endsWith('system.json')
          ? { verdict: 'pass', checks: requiredChecks }
          : { verdict: 'pass', findings: [], agentVerdict: 'pass', checks: requiredChecks, runId: 'synthetic-run', issueId: ISSUE_ID };
      await writeFile(file, JSON.stringify(value));
    } else await writeFile(file, `Synthetic ${stage} artifact.\n`);
  }
}

async function mockPaperclip(t, { checkoutStatus = 200, blockerStatus = 'done' } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === `/api/issues/${ISSUE_ID}`) {
      res.end(JSON.stringify({ id: ISSUE_ID, title: 'Synthetic QA', description: 'Temporary test issue.', blockedBy: blockerStatus ? [{ id: 'blocker', status: blockerStatus }] : [] }));
    } else if (req.method === 'POST' && req.url === `/api/issues/${ISSUE_ID}/checkout`) {
      res.statusCode = checkoutStatus;
      res.end(JSON.stringify(checkoutStatus === 200 ? { status: 'in_progress' } : { error: 'synthetic conflict' }));
    } else if (req.method === 'PATCH' && req.url === `/api/issues/${ISSUE_ID}`) {
      res.end(JSON.stringify({ id: ISSUE_ID }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'unexpected synthetic route' }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { requests, apiUrl: `http://127.0.0.1:${server.address().port}/api` };
}

function setupEnv(t, updates) {
  let state = testEnvironment.get(t);
  if (!state) {
    state = new Map();
    testEnvironment.set(t, state);
    t.after(() => {
      for (const [key, value] of state) value === undefined ? delete process.env[key] : process.env[key] = value;
      process.exitCode = 0;
    });
  }
  for (const key of Object.keys(updates)) if (!state.has(key)) state.set(key, process.env[key]);
  Object.assign(process.env, updates);
}

async function qaFixture(t, browserProgram = 'process.exit(0);') {
  const workspace = await tempDir(t);
  const bin = join(workspace, 'bin');
  await mkdir(join(workspace, 'workflow-artifacts'), { recursive: true });
  await mkdir(join(workspace, 'tests'), { recursive: true });
  await mkdir(bin);
  await writeFile(join(workspace, 'tests/agent-filter.test.mjs'), '// synthetic QA test');
  await writeFile(join(workspace, 'tests/agent-filter.browser.mjs'), browserProgram);
  const npm = join(bin, 'npm');
  await writeFile(npm, '#!/bin/sh\nexit 0\n');
  await chmod(npm, 0o755);
  setupEnv(t, { PATH: `${bin}:${process.env.PATH ?? ''}`, PAPERCLIP_RUN_ID: 'synthetic-qa-run', AX_VERIFY_FILTER_GRAPH: '0', AX_VERIFY_TOPOLOGY: '0', AX_VERIFY_NAVIGATION: '0' });
  await writeFile(join(workspace, 'workflow-artifacts/smoke.json'), JSON.stringify({ verdict: 'pass', findings: [] }));
  return workspace;
}

function makeTopologyCase(shape, size) {
  return {
    shape, size, verdict: 'pass', failureCodes: [], unexpectedRequestCount: 0, pageErrorCount: 0,
    initialRenderMs: 100, initialCardCount: size, searchMs: 25,
    matchSummary: `일치 1 / 전체 ${size}`, visibleCardCount: shape === 'chain' ? size : 2,
    contextCardCount: shape === 'chain' ? size - 1 : 1, selectionGuidance: true, selectionDetail: true,
  };
}

function makeNavigationCase(name) {
  return { name, verdict: 'pass', failureCodes: [], unexpectedRequestCount: 0, pageErrorCount: 0, checkCount: 4 };
}

test('stage definitions are registered against the available product, development, QA, and operations teams', async t => {
  const { definition: workflow } = await import('../experiments/paperclip/ax-controller.mjs');
  const teamKeys = new Set(workflow.teams.map(team => team.key));
  const expected = new Set(['requirements', 'design', 'test-plan', 'implement', 'environment', 'smoke', 'system', 'approval', 'release', 'acceptance', 'delivery-review', 'fix']);
  assert.deepEqual(new Set(VALID_STAGES), expected);
  for (const stage of [...workflow.stages, workflow.rework]) {
    assert.ok(VALID_STAGES.has(stage.key), `${stage.key} is accepted by the worker`);
    assert.ok(teamKeys.has(stage.team), `${stage.key} is assigned to a registered team`);
    assert.ok(STAGE_OUTPUTS[stage.key]?.length, `${stage.key} declares required artifacts`);
  }
  assert.deepEqual(STAGE_OUTPUTS['delivery-review'], ['workflow-artifacts/delivery-review.json', 'workflow-artifacts/delivery-review.md']);
  const reviewPrompt = taskPrompt('delivery-review', { title: 'Review native online release', description: 'Synthetic review.' }, '/tmp/review-workspace');
  for (const input of ['acceptance.json', 'approval.json', 'deployment.json', 'release-delivery.json']) assert.ok(reviewPrompt.includes(input));
  assert.match(reviewPrompt, /Do not edit source, tests, or prior artifacts/);
});

test('child environments remove Paperclip and credential variables but preserve AX_VERIFY_URL', t => {
  const vars = {
    PAPERCLIP_API_URL: 'http://127.0.0.1:1/api', PAPERCLIP_API_KEY: 'dummy-paperclip-key',
    PAPERCLIP_AGENT_ID: 'dummy-agent', AX_PAPERCLIP_URL: 'http://127.0.0.1:2',
    AX_VERIFY_URL: 'http://127.0.0.1:3200', AX_VERIFY_FILTER_GRAPH: '1', AX_VERIFY_TOPOLOGY: '1', AX_VERIFY_NAVIGATION: '1', DEMO_TOKEN: 'dummy-token', OTHER_SECRET: 'dummy-secret',
  };
  const previous = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  Object.assign(process.env, vars);
  const child = sanitizedChildEnv();
  assert.equal(child.AX_VERIFY_URL, vars.AX_VERIFY_URL);
  assert.equal(child.AX_VERIFY_FILTER_GRAPH, undefined, 'wrapper-only graph verification flag excluded');
  assert.equal(child.AX_VERIFY_TOPOLOGY, undefined, 'wrapper-only topology verification flag excluded');
  assert.equal(child.AX_VERIFY_NAVIGATION, undefined, 'wrapper-only navigation verification flag excluded');
  for (const key of Object.keys(vars).filter(key => !['AX_VERIFY_URL', 'AX_VERIFY_FILTER_GRAPH', 'AX_VERIFY_TOPOLOGY', 'AX_VERIFY_NAVIGATION'].includes(key))) assert.equal(child[key], undefined, `${key} excluded`);
});

test('unresolved Paperclip blockers reject a task before worker execution', async () => {
  await assert.rejects(assertBlockersDone({ blockedBy: [{ id: 'synthetic-blocker', status: 'in_progress' }] }), /unresolved blockers/);
  await assert.doesNotReject(assertBlockersDone({ blockedBy: [{ id: 'synthetic-blocker', status: 'done' }] }));
});

test('requirements stage requires nonempty specifications', async t => {
  const workspace = await tempDir(t);
  await mkdir(join(workspace, 'workflow-artifacts'));
  await writeArtifacts(workspace, 'requirements');
  await verifyArtifacts('requirements', workspace);
  await writeFile(join(workspace, 'workflow-artifacts/requirements.md'), '  \n');
  await assert.rejects(verifyArtifacts('requirements', workspace), /missing or empty/);
});

test('approval rejects denial, failed system verdicts, and incomplete independent checks', async t => {
  const workspace = await tempDir(t);
  await mkdir(join(workspace, 'workflow-artifacts'));
  await writeArtifacts(workspace, 'approval');
  const approvalPath = join(workspace, 'workflow-artifacts/approval.json');
  const systemPath = join(workspace, 'workflow-artifacts/system.json');
  await writeFile(approvalPath, JSON.stringify({ approved: false, reason: 'Synthetic rejection.' }));
  await assert.rejects(verifyArtifacts('approval', workspace), /Approval was not granted/);
  await writeFile(approvalPath, JSON.stringify({ approved: true, reason: 'Reviewed.' }));
  await writeFile(systemPath, JSON.stringify({ verdict: 'fail', checks: [{ status: 'fail' }] }));
  await assert.rejects(verifyArtifacts('approval', workspace), /System QA did not pass/);
  await writeFile(systemPath, JSON.stringify({ verdict: 'pass', checks: [{ status: 'pass' }, { status: 'fail' }] }));
  await assert.rejects(verifyArtifacts('approval', workspace), /System QA did not pass/);
  const requiredChecks = [
    'file tests/agent-filter.test.mjs', 'file tests/agent-filter.browser.mjs', 'npm test',
    'npm run build', 'node tests/agent-filter.browser.mjs',
  ].map(command => ({ command, status: 'pass' }));
  await writeFile(systemPath, JSON.stringify({ verdict: 'pass', checks: [] }));
  await assert.rejects(verifyArtifacts('approval', workspace), /System QA did not pass/);
  await writeFile(systemPath, JSON.stringify({ verdict: 'pass', checks: requiredChecks }));
  await verifyArtifacts('approval', workspace);
});

test('delivery review accepts only the approved, passing native release with matching acceptance provenance and digest', async t => {
  setupEnv(t, { AX_VERIFY_FILTER_GRAPH: '0', AX_VERIFY_TOPOLOGY: '0', AX_VERIFY_NAVIGATION: '0' });
  const checks = [
    'file tests/agent-filter.test.mjs', 'file tests/agent-filter.browser.mjs', 'npm test',
    'npm run build', 'node tests/agent-filter.browser.mjs',
  ].map(command => ({ command, status: 'pass' }));
  const digest = 'a'.repeat(64);
  const assetChecks = [{ asset: 'index.html', sha256: 'b'.repeat(64), status: 'pass' }];
  const assetDigest = createHash('sha256').update(JSON.stringify({ 'index.html': 'b'.repeat(64) })).digest('hex');
  const writeFixture = async (mutate = () => {}) => {
    const workspace = await tempDir(t);
    await mkdir(join(workspace, 'workflow-artifacts'), { recursive: true });
    await writeArtifacts(workspace, 'delivery-review');
    const values = {
      acceptance: { verdict: 'pass', agentVerdict: 'pass', findings: [], checks: structuredClone(checks), runId: 'acceptance-run-1', issueId: 'acceptance-issue-1' },
      approval: { approved: true, reason: 'Product review passed.' },
      deployment: { workflowId: 'workflow-1', digest },
      delivery: { verdict: 'pass', workflowId: 'workflow-1', releaseDigest: digest, assetDigest,
        assetBaseline: 'verification-time', verifiedAt: '2026-10-08T01:02:03.000Z', checks: structuredClone(assetChecks) },
      review: { accepted: true, reason: 'The delivered package matches the reviewed release.', releaseDigest: digest, acceptanceRunId: 'acceptance-run-1', acceptanceIssueId: 'acceptance-issue-1' },
    };
    mutate(values);
    for (const [name, file] of Object.entries({
      acceptance: 'acceptance.json', approval: 'approval.json', deployment: 'deployment.json',
      delivery: 'release-delivery.json', review: 'delivery-review.json',
    })) await writeFile(join(workspace, `workflow-artifacts/${file}`), JSON.stringify(values[name]));
    return workspace;
  };

  const accepted = await writeFixture();
  await verifyArtifacts('delivery-review', accepted, { runId: 'review-run', issueId: 'review-issue' });

  const denied = await writeFixture(values => { values.review.accepted = false; });
  await assert.rejects(verifyArtifacts('delivery-review', denied), /Delivery review was not accepted/);

  const unapproved = await writeFixture(values => { values.approval.approved = false; });
  await assert.rejects(verifyArtifacts('delivery-review', unapproved), /Product release approval is missing/);

  const failedAcceptance = await writeFixture(values => { values.acceptance.verdict = 'fail'; });
  await assert.rejects(verifyArtifacts('delivery-review', failedAcceptance), /Online acceptance evidence is missing or failed/);

  const mismatchedAcceptance = await writeFixture(values => { values.review.acceptanceRunId = 'stale-acceptance-run'; });
  await assert.rejects(verifyArtifacts('delivery-review', mismatchedAcceptance), /acceptance provenance does not match/);
  const mismatchedAcceptanceIssue = await writeFixture(values => { values.review.acceptanceIssueId = 'stale-acceptance-issue'; });
  await assert.rejects(verifyArtifacts('delivery-review', mismatchedAcceptanceIssue), /acceptance provenance does not match/);

  const mismatchedDigest = await writeFixture(values => { values.review.releaseDigest = 'c'.repeat(64); });
  await assert.rejects(verifyArtifacts('delivery-review', mismatchedDigest), /digest does not match/);

  for (const mutate of [
    values => { delete values.deployment.workflowId; },
    values => { values.delivery.workflowId = 'other-workflow'; },
    values => { values.delivery.releaseDigest = 'c'.repeat(64); },
    values => { values.delivery.assetDigest = 'c'.repeat(64); },
    values => { values.delivery.verifiedAt = 'not-a-date'; },
    values => { delete values.delivery.verifiedAt; },
    values => { values.delivery.checks[0].sha256 = 'bad-hash'; },
  ]) {
    const mismatchedProvenance = await writeFixture(mutate);
    await assert.rejects(verifyArtifacts('delivery-review', mismatchedProvenance), /Release delivery (checks are missing or failed|provenance does not match)/);
  }

  const recordedBaseline = await writeFixture(values => {
    values.deployment.assetDigest = assetDigest;
    values.delivery.assetBaseline = 'packaging-time';
  });
  await verifyArtifacts('delivery-review', recordedBaseline);
  const wrongBaseline = await writeFixture(values => {
    values.deployment.assetDigest = assetDigest;
    values.delivery.assetBaseline = 'verification-time';
  });
  await assert.rejects(verifyArtifacts('delivery-review', wrongBaseline), /Release delivery provenance does not match/);

  const failedAcceptanceCheck = await writeFixture(values => { values.acceptance.checks[2].status = 'fail'; });
  await assert.rejects(verifyArtifacts('delivery-review', failedAcceptanceCheck), /Online acceptance evidence is missing or failed/);

  const failedDeliveryCheck = await writeFixture(values => { values.delivery.checks[0].status = 'fail'; });
  await assert.rejects(verifyArtifacts('delivery-review', failedDeliveryCheck), /Release delivery checks are missing or failed/);

  const missingGraphCheck = await writeFixture();
  setupEnv(t, { AX_VERIFY_FILTER_GRAPH: '1', AX_VERIFY_TOPOLOGY: '1', AX_VERIFY_NAVIGATION: '0' });
  await assert.rejects(verifyArtifacts('delivery-review', missingGraphCheck), /Online acceptance evidence is missing or failed/);
  const graphAndTopology = JSON.parse(await readFile(join(missingGraphCheck, 'workflow-artifacts/acceptance.json'), 'utf8'));
  graphAndTopology.checks.push(
    { command: 'node experiments/paperclip/verify-agent-filter.mjs', status: 'pass' },
    { command: 'node experiments/paperclip/verify-agent-topology.mjs', status: 'pass' },
  );
  await writeFile(join(missingGraphCheck, 'workflow-artifacts/acceptance.json'), JSON.stringify(graphAndTopology));
  await verifyArtifacts('delivery-review', missingGraphCheck);

  setupEnv(t, { AX_VERIFY_FILTER_GRAPH: '0', AX_VERIFY_TOPOLOGY: '0', AX_VERIFY_NAVIGATION: '1' });
  await assert.rejects(verifyArtifacts('delivery-review', missingGraphCheck), /Online acceptance evidence is missing or failed/);
  graphAndTopology.checks.push({ command: 'node experiments/paperclip/verify-agent-navigation.mjs', status: 'pass' });
  await writeFile(join(missingGraphCheck, 'workflow-artifacts/acceptance.json'), JSON.stringify(graphAndTopology));
  await verifyArtifacts('delivery-review', missingGraphCheck);
});

test('QA report with fail verdict is a valid report and stays a failure', async t => {
  const workspace = await tempDir(t);
  await mkdir(join(workspace, 'workflow-artifacts'));
  await writeArtifacts(workspace, 'smoke');
  await writeFile(join(workspace, 'workflow-artifacts/smoke.json'), JSON.stringify({ verdict: 'fail', agentVerdict: 'fail', findings: ['Synthetic expected failure.'], checks: [], runId: 'synthetic-run', issueId: ISSUE_ID }));
  await verifyArtifacts('smoke', workspace);
  assert.equal(JSON.parse(await readFile(join(workspace, 'workflow-artifacts/smoke.json'), 'utf8')).verdict, 'fail');
});

test('QA findings accept normalized title and summary fields, bound text, and reject unsupported object fields', () => {
  const normalized = normalizeQaFindings([{ title: '  Browser\n  state ', summary: ' Selected detail is stale.  ' }]);
  assert.deepEqual(normalized, { findings: ['Browser state: Selected detail is stale.'], valid: true });
  const bounded = normalizeQaFindings(['x'.repeat(500)]);
  assert.equal(bounded.valid, true);
  assert.equal(bounded.findings[0].length, 240);
  assert.deepEqual(normalizeQaFindings([{ title: 'Synthetic issue', raw: 'DUMMY_SECRET_MARKER' }]), { findings: [], valid: false });
  assert.deepEqual(normalizeQaFindings([{ title: ' ', summary: 'empty title' }]), { findings: ['empty title'], valid: false });
  assert.deepEqual(normalizeQaFindings({ title: 'not an array' }), { findings: [], valid: false });
});

test('unverified check summaries normalize safely and reject malformed values', () => {
  assert.deepEqual(normalizeUnverifiedChecks(['  Browser\n launch blocked by sandbox  ', 'No provider session available']), {
    checks: ['Browser launch blocked by sandbox', 'No provider session available'], valid: true,
  });
  assert.equal(normalizeUnverifiedChecks(['x'.repeat(500)]).checks[0].length, 240);
  assert.equal(normalizeUnverifiedChecks(Array.from({ length: 11 }, () => 'unverified')).valid, false);
  assert.equal(normalizeUnverifiedChecks([{ check: 'secret details' }]).valid, false);
  assert.equal(normalizeUnverifiedChecks(['   ']).valid, false);
});

test('file version freshness detects newly written evidence and ignores an unchanged stale file', async t => {
  const workspace = await tempDir(t);
  const relative = 'workflow-artifacts/agent-filter-browser-results.json';
  await mkdir(join(workspace, 'workflow-artifacts'));
  const beforeMissing = await fileVersion(workspace, relative);
  assert.equal(beforeMissing, null);
  await writeFile(join(workspace, relative), '{"verdict":"fail"}');
  const first = await fileVersion(workspace, relative);
  assert.equal(fileVersionChanged(beforeMissing, first), true);
  assert.equal(fileVersionChanged(first, await fileVersion(workspace, relative)), false);
  await writeFile(join(workspace, relative), '{"verdict":"pass"}');
  const future = new Date(Date.now() + 5000);
  await utimes(join(workspace, relative), future, future);
  assert.equal(fileVersionChanged(first, await fileVersion(workspace, relative)), true);
});

test('browser results expose only bounded failed scenario names and reject unknown shapes', () => {
  const valid = browserFailureNames({
    verdict: 'fail', screenshotSaved: true,
    results: [
      { name: 'Passing scenario', verdict: 'pass' },
      { name: '  Provider reset  ', verdict: 'fail', finding: 'DUMMY_RAW_FINDING_MARKER' },
      { name: 'N'.repeat(500), verdict: 'fail' },
    ],
  });
  assert.deepEqual(valid, { names: ['Provider reset', 'N'.repeat(240)], valid: true });
  assert.deepEqual(browserFailureNames({ verdict: 'fail', screenshotSaved: true, results: [], raw: 'extra' }), { names: [], valid: false });
  assert.deepEqual(browserFailureNames({ verdict: 'pass', screenshotSaved: true, results: [{ name: 'bad', verdict: 'unknown' }] }), { names: [], valid: false });
  assert.deepEqual(browserFailureNames({ verdict: 'fail', screenshotSaved: false, results: [] }), { names: ['Browser suite reported failure'], valid: true });
});

test('filter verification report accepts only the complete canonical synthetic QA summary', async () => {
  const { validFilterVerificationReport } = await import('../experiments/paperclip/ax-stage-agent.mjs');
  const valid = {
    seed: '0x7a5b3c1d',
    synthetic: { cases: 500, mismatches: 0, duplicateIdCases: 2, missingParentEdges: 3, explicitCycleGraphs: 4, graphEdges: 10 },
    chainAllMatch: [100, 1000, 3000].map(size => ({ size, runs: 7, medianMs: 1.5 })),
  };
  assert.equal(validFilterVerificationReport(valid), true);
  assert.equal(validFilterVerificationReport({ ...valid, seed: 'stale' }), false);
  assert.equal(validFilterVerificationReport({ ...valid, synthetic: { ...valid.synthetic, mismatches: 1 } }), false);
  assert.equal(validFilterVerificationReport({ ...valid, extra: 'DUMMY_RAW_MARKER' }), false);
  assert.equal(validFilterVerificationReport(null), false);
});

test('topology verifier report requires all six passing chain and star measurements for the workspace build', async t => {
  const workspace = await tempDir(t);
  const valid = {
    schemaVersion: 1, suite: 'offline synthetic agent topology verifier', verdict: 'pass',
    buildRoot: join(workspace, 'dist'), generatedAt: '2026-10-08T00:00:00.000Z',
    requestPolicy: 'synthetic API and build assets locally fulfilled; all other requests aborted',
    cases: [...[100, 1000, 3000].map(size => makeTopologyCase('chain', size)), ...[100, 1000, 3000].map(size => makeTopologyCase('star', size))],
  };
  assert.equal(validTopologyVerificationReport(valid, workspace), true);
  assert.equal(validTopologyVerificationReport({ ...valid, buildRoot: join(workspace, 'other-dist') }, workspace), false);
  assert.equal(validTopologyVerificationReport({ ...valid, cases: valid.cases.slice(0, 5) }, workspace), false);
  assert.equal(validTopologyVerificationReport({ ...valid, cases: valid.cases.map((item, index) => index ? item : { ...item, visibleCardCount: 1 }) }, workspace), false);
  assert.equal(validTopologyVerificationReport({ ...valid, cases: valid.cases.map((item, index) => index ? item : { ...item, failureCodes: ['page-error'] }) }, workspace), false);
  assert.equal(validTopologyVerificationReport({ ...valid, extra: 'DUMMY_RAW_MARKER' }, workspace), false);
});

test('navigation verifier report requires the exact six ordered offline interaction cases', async t => {
  const workspace = await tempDir(t);
  const names = ['deep-desktop', 'deep-mobile', 'next-previous-wrap', 'filter-cursor-reset', 'scope-cursor-reset', 'hidden-selection-retained'];
  const valid = {
    schemaVersion: 1, suite: 'offline synthetic match navigation verifier', verdict: 'pass',
    buildRoot: join(workspace, 'dist'), generatedAt: '2026-10-08T00:00:00.000Z',
    requestPolicy: 'synthetic API and build assets locally fulfilled; all other requests aborted',
    cases: names.map(makeNavigationCase),
  };
  assert.equal(validNavigationVerificationReport(valid, workspace), true);
  assert.equal(validNavigationVerificationReport({ ...valid, cases: valid.cases.slice(1) }, workspace), false);
  assert.equal(validNavigationVerificationReport({ ...valid, cases: valid.cases.map((item, index) => index ? item : { ...item, name: 'unexpected-case' }) }, workspace), false);
  assert.equal(validNavigationVerificationReport({ ...valid, cases: valid.cases.map((item, index) => index ? item : { ...item, checkCount: 3 }) }, workspace), false);
  assert.equal(validNavigationVerificationReport({ ...valid, cases: valid.cases.map((item, index) => index ? item : { ...item, failureCodes: ['navigation-failed'] }) }, workspace), false);
  assert.equal(validNavigationVerificationReport({ ...valid, buildRoot: join(workspace, 'different-dist') }, workspace), false);
});

test('malformed agent findings cannot produce a passing QA result', async t => {
  const workspace = await qaFixture(t);
  await writeFile(join(workspace, 'workflow-artifacts/smoke.json'), JSON.stringify({
    verdict: 'pass', findings: [{ title: 'Synthetic failure', raw: 'DUMMY_SECRET_MARKER' }],
  }));
  const result = await runQaCommands('smoke', workspace, { runId: 'qa-run', issueId: ISSUE_ID });
  assert.equal(result.agentVerdict, 'fail');
  assert.equal(result.verdict, 'fail');
  assert.ok(result.findings.includes('QA report findings are malformed or contain unsupported fields'));
  assert.ok(!JSON.stringify(result).includes('DUMMY_SECRET_MARKER'));
});

test('valid unverified checks are preserved separately while independent passing checks can pass QA', async t => {
  const workspace = await qaFixture(t);
  const unverified = ['Browser launch was blocked by the agent sandbox.'];
  await writeFile(join(workspace, 'workflow-artifacts/smoke.json'), JSON.stringify({ verdict: 'pass', findings: [], unverifiedChecks: unverified }));
  const result = await runQaCommands('smoke', workspace, { runId: 'qa-run', issueId: ISSUE_ID });
  assert.equal(result.agentVerdict, 'pass');
  assert.equal(result.verdict, 'pass');
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.agentUnverifiedChecks, unverified);
  assert.ok(result.checks.every(check => check.status === 'pass'));
});

test('malformed unverified checks force a failed QA verdict', async t => {
  const workspace = await qaFixture(t);
  await writeFile(join(workspace, 'workflow-artifacts/smoke.json'), JSON.stringify({ verdict: 'pass', findings: [], unverifiedChecks: { secret: 'DUMMY_DETAIL' } }));
  const result = await runQaCommands('smoke', workspace, { runId: 'qa-run', issueId: ISSUE_ID });
  assert.equal(result.agentVerdict, 'fail');
  assert.equal(result.verdict, 'fail');
  assert.ok(result.findings.includes('QA report unverifiedChecks are malformed'));
  assert.deepEqual(result.agentUnverifiedChecks, []);
  assert.ok(!JSON.stringify(result).includes('DUMMY_DETAIL'));
});

test('a real normalized product finding keeps QA failed even when every independent check passes', async t => {
  const workspace = await qaFixture(t);
  await writeFile(join(workspace, 'workflow-artifacts/smoke.json'), JSON.stringify({
    verdict: 'pass', findings: [{ title: 'Selected detail remains stale', summary: 'After switching sessions.' }], unverifiedChecks: [],
  }));
  const result = await runQaCommands('smoke', workspace, { runId: 'qa-run', issueId: ISSUE_ID });
  assert.equal(result.verdict, 'fail');
  assert.deepEqual(result.findings, ['Selected detail remains stale: After switching sessions.']);
  assert.ok(result.checks.every(check => check.status === 'pass'));
});

test('implementation validation runs npm test and build separately, records both outcomes, and captures no output', async t => {
  const workspace = await tempDir(t);
  const bin = join(workspace, 'bin');
  const commandLog = join(workspace, 'npm-commands.txt');
  await mkdir(bin);
  const npm = join(bin, 'npm');
  await writeFile(npm, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$VALIDATION_LOG"\nprintf '%s\\n' 'DUMMY_RAW_VALIDATION_OUTPUT'\nif [ "$1" = test ]; then exit 1; fi\nexit 0\n`);
  await chmod(npm, 0o755);
  setupEnv(t, { PATH: `${bin}:${process.env.PATH ?? ''}`, VALIDATION_LOG: commandLog });
  await assert.rejects(runImplementationValidations('implement', workspace, { runId: 'validation-run', issueId: ISSUE_ID }), /Independent implement validation failed/);
  const report = JSON.parse(await readFile(join(workspace, implementationValidationPath('implement')), 'utf8'));
  assert.deepEqual(report, {
    runId: 'validation-run', issueId: ISSUE_ID, verdict: 'fail',
    checks: [{ command: 'npm test', status: 'fail' }, { command: 'npm run build', status: 'pass' }],
  });
  assert.deepEqual((await readFile(commandLog, 'utf8')).trim().split('\n'), ['test', 'run build']);
  assert.ok(!JSON.stringify(report).includes('DUMMY_RAW_VALIDATION_OUTPUT'));
});

test('implementation validation artifacts require matching run and issue provenance and all passing commands', async t => {
  const workspace = await tempDir(t);
  await writeArtifacts(workspace, 'implement');
  const reportPath = join(workspace, implementationValidationPath('implement'));
  await mkdir(join(workspace, 'workflow-artifacts'), { recursive: true });
  const valid = { runId: 'validation-run', issueId: ISSUE_ID, verdict: 'pass', checks: [
    { command: 'npm test', status: 'pass' }, { command: 'npm run build', status: 'pass' },
  ] };
  await writeFile(reportPath, JSON.stringify(valid));
  await verifyArtifacts('implement', workspace, { runId: 'validation-run', issueId: ISSUE_ID });
  await assert.rejects(verifyArtifacts('implement', workspace, { runId: 'different-run', issueId: ISSUE_ID }), /validation report is missing or failed/);
  await assert.rejects(verifyArtifacts('implement', workspace, { runId: 'validation-run', issueId: 'different-issue' }), /validation report is missing or failed/);
  await writeFile(reportPath, JSON.stringify({ ...valid, checks: valid.checks.map((check, index) => index ? { ...check, status: 'fail' } : check) }));
  await assert.rejects(verifyArtifacts('implement', workspace, { runId: 'validation-run', issueId: ISSUE_ID }), /validation report is missing or failed/);
});

test('unchanged stale browser evidence is ignored, while fresh malformed evidence fails QA', async t => {
  const staleWorkspace = await qaFixture(t);
  const stalePath = join(staleWorkspace, 'workflow-artifacts/agent-filter-browser-results.json');
  await writeFile(stalePath, JSON.stringify({ verdict: 'fail', screenshotSaved: true, results: [{ name: 'Old failure', verdict: 'fail' }] }));
  const stale = await runQaCommands('smoke', staleWorkspace, { runId: 'qa-run', issueId: ISSUE_ID });
  assert.equal(stale.verdict, 'pass');
  assert.deepEqual(stale.findings, []);

  const malformedWorkspace = await qaFixture(t, `import { writeFileSync } from 'node:fs';\nwriteFileSync('workflow-artifacts/agent-filter-browser-results.json', JSON.stringify({ verdict: 'pass', screenshotSaved: true, results: [], extra: 'DUMMY_RAW_MARKER' }));\n`);
  const malformed = await runQaCommands('smoke', malformedWorkspace, { runId: 'qa-run', issueId: ISSUE_ID });
  assert.equal(malformed.verdict, 'fail');
  assert.ok(malformed.findings.includes('Browser result artifact is malformed'));
  assert.ok(!JSON.stringify(malformed).includes('DUMMY_RAW_MARKER'));
});

test('fresh failed browser scenario records only its bounded name, never the raw finding', async t => {
  const rawMarker = 'DUMMY_BROWSER_FINDING_SECRET';
  const report = { verdict: 'fail', screenshotSaved: true, results: [{ name: 'Provider/session reset', verdict: 'fail', finding: rawMarker }] };
  const browserProgram = `import { writeFileSync } from 'node:fs';\nwriteFileSync('workflow-artifacts/agent-filter-browser-results.json', JSON.stringify(${JSON.stringify(report)}));\n`;
  const workspace = await qaFixture(t, browserProgram);
  const result = await runQaCommands('smoke', workspace, { runId: 'qa-run', issueId: ISSUE_ID });
  assert.equal(result.verdict, 'fail');
  assert.ok(result.findings.includes('Browser failure scenario: Provider/session reset'));
  assert.ok(!JSON.stringify(result).includes(rawMarker));
});

test('graph verification is an independent fresh QA gate only when enabled', async t => {
  const validReport = {
    seed: '0x7a5b3c1d',
    synthetic: { cases: 500, mismatches: 0, duplicateIdCases: 2, missingParentEdges: 3, explicitCycleGraphs: 4, graphEdges: 10 },
    chainAllMatch: [100, 1000, 3000].map(size => ({ size, runs: 7, medianMs: 1.5 })),
  };
  const createGraphWorkspace = async script => {
    const workspace = await qaFixture(t);
    await mkdir(join(workspace, 'experiments/paperclip'), { recursive: true });
    await writeFile(join(workspace, 'experiments/paperclip/verify-agent-filter.mjs'), script);
    return workspace;
  };
  const writeReportScript = report => `import { writeFileSync } from 'node:fs';\nconst output = process.argv[process.argv.indexOf('--output') + 1];\nwriteFileSync(output, JSON.stringify(${JSON.stringify(report)}));\n`;

  const validWorkspace = await createGraphWorkspace(writeReportScript(validReport));
  await writeFile(join(validWorkspace, 'workflow-artifacts/filter-verification.json'), JSON.stringify({ ...validReport, synthetic: { ...validReport.synthetic, cases: 1 } }));
  const staleWorkspace = await createGraphWorkspace('process.exit(0);\n');
  await writeFile(join(staleWorkspace, 'workflow-artifacts/filter-verification.json'), JSON.stringify(validReport));
  const malformedWorkspace = await createGraphWorkspace(writeReportScript({ ...validReport, seed: 'stale-seed' }));
  const nonzeroWorkspace = await createGraphWorkspace(`${writeReportScript(validReport)}process.exit(9);\n`);
  setupEnv(t, { AX_VERIFY_FILTER_GRAPH: '1' });
  const valid = await runQaCommands('smoke', validWorkspace, { runId: 'graph-run', issueId: ISSUE_ID });
  const graphCheck = valid.checks.find(check => check.command === 'node experiments/paperclip/verify-agent-filter.mjs');
  assert.equal(graphCheck.status, 'pass');
  assert.equal(valid.verdict, 'pass');

  const stale = await runQaCommands('smoke', staleWorkspace, { runId: 'graph-run', issueId: ISSUE_ID });
  assert.equal(stale.checks.find(check => check.command === 'node experiments/paperclip/verify-agent-filter.mjs').status, 'fail');
  assert.ok(stale.findings.includes('Filter graph verification report was not freshly written'));
  assert.equal(stale.verdict, 'fail');

  const malformed = await runQaCommands('smoke', malformedWorkspace, { runId: 'graph-run', issueId: ISSUE_ID });
  assert.equal(malformed.checks.find(check => check.command === 'node experiments/paperclip/verify-agent-filter.mjs').status, 'fail');
  assert.ok(malformed.findings.includes('Filter graph verification report is malformed or has mismatches'));
  assert.equal(malformed.verdict, 'fail');

  const nonzero = await runQaCommands('smoke', nonzeroWorkspace, { runId: 'graph-run', issueId: ISSUE_ID });
  assert.equal(nonzero.checks.find(check => check.command === 'node experiments/paperclip/verify-agent-filter.mjs').status, 'fail');
  assert.ok(nonzero.findings.includes('node experiments/paperclip/verify-agent-filter.mjs failed'));
  assert.equal(nonzero.verdict, 'fail');

  const disabledWorkspace = await qaFixture(t);
  setupEnv(t, { AX_VERIFY_FILTER_GRAPH: '0' });
  const disabled = await runQaCommands('smoke', disabledWorkspace, { runId: 'plain-run', issueId: ISSUE_ID });
  assert.equal(disabled.checks.some(check => check.command === 'node experiments/paperclip/verify-agent-filter.mjs'), false);
  assert.equal(disabled.verdict, 'pass');
});

test('topology verification is a fresh six-case QA gate only when enabled', async t => {
  const reportFor = buildRoot => ({
    schemaVersion: 1, suite: 'offline synthetic agent topology verifier', verdict: 'pass', buildRoot,
    generatedAt: '2026-10-08T00:00:00.000Z',
    requestPolicy: 'synthetic API and build assets locally fulfilled; all other requests aborted',
    cases: [...[100, 1000, 3000].map(size => makeTopologyCase('chain', size)), ...[100, 1000, 3000].map(size => makeTopologyCase('star', size))],
  });
  const createWorkspace = async reportMode => {
    const workspace = await qaFixture(t);
    await mkdir(join(workspace, 'experiments/paperclip'), { recursive: true });
    let script = 'process.exit(0);\n';
    if (reportMode === 'valid' || reportMode === 'mismatch') {
      const report = reportFor(join(workspace, 'dist'));
      if (reportMode === 'mismatch') report.cases[0].contextCardCount = 0;
      script = `import { writeFileSync } from 'node:fs';\nconst args=process.argv;\nconst root=args[args.indexOf('--build-root')+1];\nconst output=args[args.indexOf('--output')+1];\nconst report=${JSON.stringify(report)};\nreport.buildRoot=root;\nwriteFileSync(output,JSON.stringify(report));\n`;
    } else if (reportMode === 'nonzero') {
      const report = reportFor(join(workspace, 'dist'));
      script = `import { writeFileSync } from 'node:fs';\nconst args=process.argv;\nconst root=args[args.indexOf('--build-root')+1];\nconst output=args[args.indexOf('--output')+1];\nconst report=${JSON.stringify(report)};\nreport.buildRoot=root;\nwriteFileSync(output,JSON.stringify(report));\nprocess.exit(9);\n`;
    }
    await writeFile(join(workspace, 'experiments/paperclip/verify-agent-topology.mjs'), script);
    return workspace;
  };

  const validWorkspace = await createWorkspace('valid');
  await writeFile(join(validWorkspace, 'workflow-artifacts/topology-verification.json'), JSON.stringify({ verdict: 'pass', cases: [] }));
  const staleWorkspace = await createWorkspace('stale');
  await writeFile(join(staleWorkspace, 'workflow-artifacts/topology-verification.json'), JSON.stringify(reportFor(join(staleWorkspace, 'dist'))));
  const mismatchWorkspace = await createWorkspace('mismatch');
  const nonzeroWorkspace = await createWorkspace('nonzero');
  const disabledWorkspace = await qaFixture(t);
  setupEnv(t, { AX_VERIFY_TOPOLOGY: '1' });

  const valid = await runQaCommands('smoke', validWorkspace, { runId: 'topology-run', issueId: ISSUE_ID });
  assert.equal(valid.checks.find(check => check.command === 'node experiments/paperclip/verify-agent-topology.mjs').status, 'pass');
  assert.equal(valid.verdict, 'pass');

  const stale = await runQaCommands('smoke', staleWorkspace, { runId: 'topology-run', issueId: ISSUE_ID });
  assert.equal(stale.checks.find(check => check.command === 'node experiments/paperclip/verify-agent-topology.mjs').status, 'fail');
  assert.ok(stale.findings.includes('Topology verification report was not freshly written'));
  assert.equal(stale.verdict, 'fail');

  const mismatch = await runQaCommands('smoke', mismatchWorkspace, { runId: 'topology-run', issueId: ISSUE_ID });
  assert.equal(mismatch.checks.find(check => check.command === 'node experiments/paperclip/verify-agent-topology.mjs').status, 'fail');
  assert.ok(mismatch.findings.includes('Topology verification report is malformed or has mismatches'));
  assert.equal(mismatch.verdict, 'fail');

  const nonzero = await runQaCommands('smoke', nonzeroWorkspace, { runId: 'topology-run', issueId: ISSUE_ID });
  assert.equal(nonzero.checks.find(check => check.command === 'node experiments/paperclip/verify-agent-topology.mjs').status, 'fail');
  assert.ok(nonzero.findings.includes('node experiments/paperclip/verify-agent-topology.mjs failed'));
  assert.equal(nonzero.verdict, 'fail');

  setupEnv(t, { AX_VERIFY_TOPOLOGY: '0' });
  const disabled = await runQaCommands('smoke', disabledWorkspace, { runId: 'plain-run', issueId: ISSUE_ID });
  assert.equal(disabled.checks.some(check => check.command === 'node experiments/paperclip/verify-agent-topology.mjs'), false);
  assert.equal(disabled.verdict, 'pass');
});

test('navigation verification is a fresh six-case QA gate only when enabled', async t => {
  const names = ['deep-desktop', 'deep-mobile', 'next-previous-wrap', 'filter-cursor-reset', 'scope-cursor-reset', 'hidden-selection-retained'];
  const reportFor = buildRoot => ({
    schemaVersion: 1, suite: 'offline synthetic match navigation verifier', verdict: 'pass', buildRoot,
    generatedAt: '2026-10-08T00:00:00.000Z',
    requestPolicy: 'synthetic API and build assets locally fulfilled; all other requests aborted',
    cases: names.map(makeNavigationCase),
  });
  const createWorkspace = async reportMode => {
    const workspace = await qaFixture(t);
    await mkdir(join(workspace, 'experiments/paperclip'), { recursive: true });
    let script = 'process.exit(0);\n';
    if (['valid', 'malformed', 'nonzero'].includes(reportMode)) {
      const report = reportFor(join(workspace, 'dist'));
      if (reportMode === 'malformed') report.cases[2].name = 'wrong-case';
      script = `import { writeFileSync } from 'node:fs';\nconst args=process.argv;\nconst root=args[args.indexOf('--build-root')+1];\nconst output=args[args.indexOf('--output')+1];\nconst report=${JSON.stringify(report)};\nreport.buildRoot=root;\nwriteFileSync(output,JSON.stringify(report));\n${reportMode === 'nonzero' ? 'process.exit(7);\n' : ''}`;
    }
    await writeFile(join(workspace, 'experiments/paperclip/verify-agent-navigation.mjs'), script);
    return workspace;
  };

  const validWorkspace = await createWorkspace('valid');
  await writeFile(join(validWorkspace, 'workflow-artifacts/navigation-verification.json'), JSON.stringify({ verdict: 'pass', cases: [] }));
  const staleWorkspace = await createWorkspace('stale');
  await writeFile(join(staleWorkspace, 'workflow-artifacts/navigation-verification.json'), JSON.stringify(reportFor(join(staleWorkspace, 'dist'))));
  const malformedWorkspace = await createWorkspace('malformed');
  const failedCommandWorkspace = await createWorkspace('nonzero');
  const disabledWorkspace = await qaFixture(t);
  setupEnv(t, { AX_VERIFY_NAVIGATION: '1' });

  const valid = await runQaCommands('smoke', validWorkspace, { runId: 'navigation-run', issueId: ISSUE_ID });
  assert.equal(valid.checks.find(check => check.command === 'node experiments/paperclip/verify-agent-navigation.mjs').status, 'pass');
  assert.equal(valid.verdict, 'pass');

  const stale = await runQaCommands('smoke', staleWorkspace, { runId: 'navigation-run', issueId: ISSUE_ID });
  assert.equal(stale.checks.find(check => check.command === 'node experiments/paperclip/verify-agent-navigation.mjs').status, 'fail');
  assert.ok(stale.findings.includes('Match navigation verification report was not freshly written'));
  assert.equal(stale.verdict, 'fail');

  const malformed = await runQaCommands('smoke', malformedWorkspace, { runId: 'navigation-run', issueId: ISSUE_ID });
  assert.equal(malformed.checks.find(check => check.command === 'node experiments/paperclip/verify-agent-navigation.mjs').status, 'fail');
  assert.ok(malformed.findings.includes('Match navigation verification report is malformed or has mismatches'));
  assert.equal(malformed.verdict, 'fail');

  const failedCommand = await runQaCommands('smoke', failedCommandWorkspace, { runId: 'navigation-run', issueId: ISSUE_ID });
  assert.equal(failedCommand.checks.find(check => check.command === 'node experiments/paperclip/verify-agent-navigation.mjs').status, 'fail');
  assert.ok(failedCommand.findings.includes('node experiments/paperclip/verify-agent-navigation.mjs failed'));
  assert.equal(failedCommand.verdict, 'fail');

  setupEnv(t, { AX_VERIFY_NAVIGATION: '0' });
  const disabled = await runQaCommands('smoke', disabledWorkspace, { runId: 'plain-run', issueId: ISSUE_ID });
  assert.equal(disabled.checks.some(check => check.command === 'node experiments/paperclip/verify-agent-navigation.mjs'), false);
  assert.equal(disabled.verdict, 'pass');
});

test('freshness helper rejects pre-existing outputs and accepts outputs changed after the snapshot', async t => {
  const workspace = await tempDir(t);
  await mkdir(join(workspace, 'workflow-artifacts'));
  await writeArtifacts(workspace, 'requirements');
  const before = await snapshotStageOutputStats('requirements', workspace);
  await assert.rejects(verifyFreshStageOutputs('requirements', before, workspace), /stale/);
  for (const relative of STAGE_OUTPUTS.requirements) {
    const file = join(workspace, relative);
    await writeFile(file, 'Updated synthetic output.\n');
    const future = new Date(Date.now() + 5000);
    await utimes(file, future, future);
  }
  await verifyFreshStageOutputs('requirements', before, workspace);
});

test('worker prompt includes the isolated workspace and topology follow-up QA restrictions', t => {
  setupEnv(t, { AX_VERIFY_FILTER_GRAPH: '0', AX_VERIFY_TOPOLOGY: '1' });
  const prompt = taskPrompt('smoke', { title: 'Synthetic issue', description: 'Safe fixture only.' }, '/tmp/synthetic-workspace');
  assert.match(prompt, /Never write outside the supplied workspace/);
  assert.match(prompt, /Stage: smoke/);
  assert.match(prompt, /Do not change server code or adapters/);
  assert.match(prompt, /requirements-amendment\.md, requirements\.md, prototype\.md, design\.md, test-plan\.md, and improvement-request\.md/);
  assert.match(prompt, /inProgress, completed, failed, interrupted, and unknown/);
  assert.match(prompt, /Never infer that unknown means waiting/);
  assert.match(prompt, /상태 미확인/);
  assert.match(prompt, /AX_VERIFY_TOPOLOGY=1 requires the independent synthetic topology verification check/);
  assert.match(prompt, /do not edit tests or product source in this follow-up QA run/);
  assert.match(prompt, /topology-verification\.json artifact/);
});

test('source boundary allows only stage-owned files and rejects server, config, and unrelated test edits', async t => {
  setupEnv(t, { AX_VERIFY_FILTER_GRAPH: '0' });
  const workspace = await tempDir(t);
  for (const dir of ['src', 'server', 'tests']) await mkdir(join(workspace, dir));
  await writeFile(join(workspace, 'src/App.tsx'), 'synthetic app');
  await writeFile(join(workspace, 'server/index.mjs'), 'synthetic server');
  await writeFile(join(workspace, 'tests/store.test.mjs'), 'synthetic test');
  await writeFile(join(workspace, 'tests/agent-filter.test.mjs'), 'old filter test');
  await writeFile(join(workspace, 'package.json'), '{}');
  const before = await snapshotWorkspace(workspace);
  await writeFile(join(workspace, 'src/App.tsx'), 'updated synthetic app');
  await writeFile(join(workspace, 'tests/agent-filter.test.mjs'), 'updated filter test');
  await writeFile(join(workspace, 'tests/agent-filter.browser.mjs'), 'new browser test');
  await writeFile(join(workspace, 'tests/store.test.mjs'), 'tampered unrelated test');
  await writeFile(join(workspace, 'server/index.mjs'), 'tampered server');
  await writeFile(join(workspace, 'package.json'), '{"tampered":true}');
  await assert.rejects(verifyWorkspaceChanges('smoke', before, workspace), /protected workspace paths/);
  assert.deepEqual(prohibitedWorkspaceChanges('smoke', ['tests/agent-filter.test.mjs', 'tests/agent-filter.browser.mjs']), []);
  assert.deepEqual(prohibitedWorkspaceChanges('implement', ['src/App.tsx', 'src/styles.css', 'tests/agent-filter.test.mjs']), []);
  assert.deepEqual(prohibitedWorkspaceChanges('system', ['src/App.tsx', 'tests/agent-filter.test.mjs', 'server/index.mjs', 'package.json']), ['src/App.tsx', 'tests/agent-filter.test.mjs', 'server/index.mjs', 'package.json']);
});

test('approval and fix cannot rewrite prior specs, QA, review, verification, validation, or controller artifacts', async t => {
  const protectedFiles = [
    'requirements.md', 'prototype.md', 'smoke.json', 'system.json', 'acceptance.json',
    'operator-review-AX-1.md', 'verified-AX-1.json', 'controller-output.json',
    'implementation-validation.json', 'fix-validation.json', 'requirements-amendment.md',
  ];
  for (const stage of ['approval', 'fix']) {
    const workspace = await tempDir(t);
    const artifacts = join(workspace, 'workflow-artifacts');
    await mkdir(artifacts, { recursive: true });
    for (const relative of protectedFiles) await writeFile(join(artifacts, relative), `Original ${relative}.\n`);
    const before = await snapshotWorkspace(workspace);
    for (const relative of protectedFiles) await writeFile(join(artifacts, relative), `Changed ${relative}.\n`);
    await assert.rejects(verifyWorkspaceChanges(stage, before, workspace), /protected workspace paths/);
  }
});

test('stage-owned validation and report outputs may change, new debug artifacts are allowed, and release preserves deployment plan', async t => {
  assert.ok(STAGE_OUTPUTS.release.includes('workflow-artifacts/release-plan.md'));
  assert.ok(!STAGE_OUTPUTS.release.includes('workflow-artifacts/deployment-plan.md'));
  const ownedCases = [
    { stage: 'implement', files: ['implementation.md', 'implementation-validation.json'] },
    { stage: 'fix', files: ['fix.md', 'fix-validation.json'] },
    { stage: 'approval', files: ['approval.json', 'release-notes.md'] },
    { stage: 'release', files: ['release-plan.md', 'release-checklist.md'] },
    { stage: 'smoke', files: ['smoke.json', 'smoke.md', 'agent-filter-browser-results.json', 'agent-filter-smoke.png'] },
  ];
  for (const { stage, files } of ownedCases) {
    const workspace = await tempDir(t);
    const artifacts = join(workspace, 'workflow-artifacts');
    await mkdir(artifacts, { recursive: true });
    for (const file of files) await writeFile(join(artifacts, file), `Before ${file}.\n`);
    if (stage === 'release') await writeFile(join(artifacts, 'deployment-plan.md'), 'Environment-owned plan.\n');
    const before = await snapshotWorkspace(workspace);
    for (const file of files) await writeFile(join(artifacts, file), `Updated ${file}.\n`);
    await verifyWorkspaceChanges(stage, before, workspace);
    if (stage === 'release') {
      await writeFile(join(artifacts, 'deployment-plan.md'), 'Release attempted to rewrite environment plan.\n');
      await assert.rejects(verifyWorkspaceChanges(stage, before, workspace), /protected workspace paths/, 'release cannot rewrite the environment stage deployment plan');
    }
  }

  const debugWorkspace = await tempDir(t);
  await mkdir(join(debugWorkspace, 'workflow-artifacts'));
  const beforeDebug = await snapshotWorkspace(debugWorkspace);
  await writeFile(join(debugWorkspace, 'workflow-artifacts/debug-diagnostic.json'), '{"summary":"synthetic"}');
  await verifyWorkspaceChanges('implement', beforeDebug, debugWorkspace);
});

test('existing browser evidence and screenshot are mutable only by QA stages', async t => {
  setupEnv(t, { AX_VERIFY_TOPOLOGY: '0' });
  const workspace = await tempDir(t);
  const artifacts = join(workspace, 'workflow-artifacts');
  await mkdir(artifacts, { recursive: true });
  const browserResult = join(artifacts, 'agent-filter-browser-results.json');
  const screenshot = join(artifacts, 'agent-filter-smoke.png');
  const topologyReport = join(artifacts, 'topology-verification.json');
  await writeFile(browserResult, '{"verdict":"pass"}');
  await writeFile(screenshot, 'synthetic screenshot bytes');
  await writeFile(topologyReport, '{"verdict":"pass"}');
  const before = await snapshotWorkspace(workspace);
  await writeFile(browserResult, '{"verdict":"fail"}');
  await writeFile(screenshot, 'updated synthetic screenshot bytes');
  await writeFile(topologyReport, '{"verdict":"fail"}');
  await assert.rejects(verifyWorkspaceChanges('implement', before, workspace), /protected workspace paths/);
  await assert.rejects(verifyWorkspaceChanges('smoke', before, workspace), /protected workspace paths/);
  setupEnv(t, { AX_VERIFY_TOPOLOGY: '1' });
  await verifyWorkspaceChanges('smoke', before, workspace);
});

test('existing graph and topology reports are mutable only by their enabled QA gates', async t => {
  setupEnv(t, { AX_VERIFY_FILTER_GRAPH: '0', AX_VERIFY_TOPOLOGY: '0', AX_VERIFY_NAVIGATION: '0' });
  const graphWorkspace = await tempDir(t);
  await mkdir(join(graphWorkspace, 'workflow-artifacts'), { recursive: true });
  const graphPath = join(graphWorkspace, 'workflow-artifacts/filter-verification.json');
  await writeFile(graphPath, '{"old":true}');
  const graphBefore = await snapshotWorkspace(graphWorkspace);
  await writeFile(graphPath, '{"new":true}');
  setupEnv(t, { AX_VERIFY_FILTER_GRAPH: '1', AX_VERIFY_TOPOLOGY: '0', AX_VERIFY_NAVIGATION: '0' });
  await verifyWorkspaceChanges('smoke', graphBefore, graphWorkspace);
  await assert.rejects(verifyWorkspaceChanges('implement', graphBefore, graphWorkspace), /protected workspace paths/);

  const topologyWorkspace = await tempDir(t);
  await mkdir(join(topologyWorkspace, 'workflow-artifacts'), { recursive: true });
  const topologyPath = join(topologyWorkspace, 'workflow-artifacts/topology-verification.json');
  await writeFile(topologyPath, '{"old":true}');
  const topologyBefore = await snapshotWorkspace(topologyWorkspace);
  await writeFile(topologyPath, '{"new":true}');
  setupEnv(t, { AX_VERIFY_FILTER_GRAPH: '0', AX_VERIFY_TOPOLOGY: '1', AX_VERIFY_NAVIGATION: '0' });
  await verifyWorkspaceChanges('acceptance', topologyBefore, topologyWorkspace);
  await assert.rejects(verifyWorkspaceChanges('fix', topologyBefore, topologyWorkspace), /protected workspace paths/);

  const navigationWorkspace = await tempDir(t);
  await mkdir(join(navigationWorkspace, 'workflow-artifacts'), { recursive: true });
  const navigationPath = join(navigationWorkspace, 'workflow-artifacts/navigation-verification.json');
  await writeFile(navigationPath, '{"old":true}');
  const navigationBefore = await snapshotWorkspace(navigationWorkspace);
  await writeFile(navigationPath, '{"new":true}');
  setupEnv(t, { AX_VERIFY_FILTER_GRAPH: '0', AX_VERIFY_TOPOLOGY: '0', AX_VERIFY_NAVIGATION: '1' });
  await verifyWorkspaceChanges('system', navigationBefore, navigationWorkspace);
  await assert.rejects(verifyWorkspaceChanges('implement', navigationBefore, navigationWorkspace), /protected workspace paths/);

  const disabledWorkspace = await tempDir(t);
  await mkdir(join(disabledWorkspace, 'workflow-artifacts'), { recursive: true });
  const disabledPath = join(disabledWorkspace, 'workflow-artifacts/filter-verification.json');
  const disabledNavigationPath = join(disabledWorkspace, 'workflow-artifacts/navigation-verification.json');
  await writeFile(disabledPath, '{"old":true}');
  await writeFile(disabledNavigationPath, '{"old":true}');
  const disabledBefore = await snapshotWorkspace(disabledWorkspace);
  await writeFile(disabledPath, '{"new":true}');
  await writeFile(disabledNavigationPath, '{"new":true}');
  setupEnv(t, { AX_VERIFY_FILTER_GRAPH: '0', AX_VERIFY_TOPOLOGY: '0', AX_VERIFY_NAVIGATION: '0' });
  await assert.rejects(verifyWorkspaceChanges('smoke', disabledBefore, disabledWorkspace), /protected workspace paths/);
});

test('requirements amendment remains protected in every workflow stage', async t => {
  const stages = ['requirements', 'design', 'test-plan', 'implement', 'smoke', 'fix', 'system', 'environment', 'approval', 'release', 'acceptance'];
  for (const stage of stages) {
    const workspace = await tempDir(t);
    const artifacts = join(workspace, 'workflow-artifacts');
    await mkdir(artifacts, { recursive: true });
    const amendment = join(artifacts, 'requirements-amendment.md');
    await writeFile(amendment, 'Reviewed amendment v1.\n');
    const before = await snapshotWorkspace(workspace);
    await writeFile(amendment, 'Changed amendment.\n');
    await assert.rejects(verifyWorkspaceChanges(stage, before, workspace), /protected workspace paths/, `${stage} cannot change the amendment`);
  }
});

test('artifact symlinks are rejected by the protected workspace snapshot', async t => {
  const workspace = await tempDir(t);
  const artifacts = join(workspace, 'workflow-artifacts');
  await mkdir(artifacts);
  await writeFile(join(workspace, 'dummy-artifact-target'), 'synthetic only');
  await symlink(join(workspace, 'dummy-artifact-target'), join(artifacts, 'linked-report.json'));
  await assert.rejects(snapshotWorkspace(workspace), /Symlink is forbidden in protected workspace path/);
});

test('smoke QA rejects inserting into an existing test and accepts genuine EOF-only appended coverage', async t => {
  setupEnv(t, { AX_VERIFY_FILTER_GRAPH: '0' });
  const insertedWorkspace = await tempDir(t);
  await mkdir(join(insertedWorkspace, 'tests'));
  const testPath = join(insertedWorkspace, 'tests/agent-filter.test.mjs');
  const oldContents = 'import test from \'node:test\';\n\ntest(\'original assertion\', () => {});\n';
  await writeFile(testPath, oldContents);
  const beforeInsertion = await snapshotWorkspace(insertedWorkspace);
  await writeFile(testPath, oldContents.replace("test('original assertion'", "test('inserted assertion', () => {});\n\ntest('original assertion'"));
  await assert.rejects(verifyWorkspaceChanges('smoke', beforeInsertion, insertedWorkspace), /may only append tests/);

  const appendWorkspace = await tempDir(t);
  await mkdir(join(appendWorkspace, 'tests'));
  const appendPath = join(appendWorkspace, 'tests/agent-filter.test.mjs');
  await writeFile(appendPath, oldContents);
  const beforeAppend = await snapshotWorkspace(appendWorkspace);
  await writeFile(appendPath, `${oldContents}\ntest('new EOF coverage', () => {});\n`);
  await verifyWorkspaceChanges('smoke', beforeAppend, appendWorkspace);
});

test('root-wide snapshot rejects edits to existing and newly added root files, including docs and experiments', async t => {
  const workspace = await tempDir(t);
  await mkdir(join(workspace, 'experiments/paperclip'), { recursive: true });
  await mkdir(join(workspace, '.git'));
  await mkdir(join(workspace, 'node_modules'));
  await mkdir(join(workspace, 'dist'));
  await mkdir(join(workspace, 'workflow-artifacts'));
  await writeFile(join(workspace, 'README.md'), 'Before.\n');
  await writeFile(join(workspace, 'AGENTS.md'), 'Before.\n');
  await writeFile(join(workspace, 'experiments/paperclip/FLOW.md'), 'Before.\n');
  await writeFile(join(workspace, '.git/ignored'), 'Ignored metadata.\n');
  await writeFile(join(workspace, 'node_modules/ignored'), 'Ignored dependencies.\n');
  await writeFile(join(workspace, 'dist/ignored'), 'Ignored build.\n');
  await writeFile(join(workspace, 'workflow-artifacts/ignored'), 'Stage outputs.\n');
  const before = await snapshotWorkspace(workspace);
  assert.ok(before.has('README.md'));
  assert.ok(before.has('AGENTS.md'));
  assert.ok(before.has('experiments/paperclip/FLOW.md'));
  assert.ok(![...before.keys()].some(path => path.startsWith('node_modules/')));
  assert.ok(![...before.keys()].some(path => path.startsWith('.git/')));
  assert.ok(![...before.keys()].some(path => path.startsWith('dist/')));
  assert.ok(before.has('workflow-artifacts/ignored'));
  await writeFile(join(workspace, 'README.md'), 'Changed docs.\n');
  await writeFile(join(workspace, 'AGENTS.md'), 'Changed instructions.\n');
  await writeFile(join(workspace, 'experiments/paperclip/FLOW.md'), 'Changed workflow.\n');
  await writeFile(join(workspace, 'new-root-file.txt'), 'New root artifact.\n');
  await assert.rejects(verifyWorkspaceChanges('implement', before, workspace), /protected workspace paths/);
});

test('root-wide snapshot rejects symlinks without following the target', async t => {
  const workspace = await tempDir(t);
  const target = join(await tempDir(t), 'dummy-target.txt');
  await writeFile(target, 'synthetic target only');
  await symlink(target, join(workspace, 'linked-file'));
  await assert.rejects(snapshotWorkspace(workspace), /Symlink is forbidden in protected workspace path/);
});

test('shutdownOwnedChildGroups waits for and terminates only a synthetic worker process group', { skip: process.platform === 'win32' }, async t => {
  const pending = runProcess('sh', ['-c', 'sleep 60 & wait'], { cwd: tmpdir(), timeoutMs: 30_000 });
  t.after(() => shutdownOwnedChildGroups());
  // Give the owned shell a chance to start its child before exercising shutdown.
  await new Promise(resolve => setTimeout(resolve, 30));
  await shutdownOwnedChildGroups();
  await assert.rejects(pending, /cancelled/);
});

test('relative workspace fails before any Paperclip request', async t => {
  const previous = { url: process.env.PAPERCLIP_API_URL, key: process.env.PAPERCLIP_API_KEY, agent: process.env.PAPERCLIP_AGENT_ID, run: process.env.PAPERCLIP_RUN_ID };
  t.after(() => {
    for (const [key, value] of Object.entries({ PAPERCLIP_API_URL: previous.url, PAPERCLIP_API_KEY: previous.key, PAPERCLIP_AGENT_ID: previous.agent, PAPERCLIP_RUN_ID: previous.run })) value === undefined ? delete process.env[key] : process.env[key] = value;
    process.exitCode = 0;
  });
  delete process.env.PAPERCLIP_API_URL;
  await assert.rejects(main(['--stage', 'requirements', '--workspace', 'relative-workspace', '--issue', ISSUE_ID]), /absolute path/);
});

test('checkout conflict does not run a worker or PATCH the issue', async t => {
  const apiMock = await mockPaperclip(t, { checkoutStatus: 409, blockerStatus: null });
  const workspace = await tempDir(t);
  setupEnv(t, { PAPERCLIP_API_URL: apiMock.apiUrl, PAPERCLIP_API_KEY: 'dummy-key', PAPERCLIP_AGENT_ID: 'dummy-agent', PAPERCLIP_RUN_ID: 'dummy-run' });
  const output = [];
  const oldError = console.error;
  console.error = (...args) => output.push(args.join(' '));
  t.after(() => { console.error = oldError; });
  const result = await main(['--stage', 'smoke', '--workspace', workspace, '--issue', ISSUE_ID]);
  assert.equal(result.verdict, 'blocked');
  assert.deepEqual(apiMock.requests.map(r => `${r.method} ${r.url}`), [`GET /api/issues/${ISSUE_ID}`, `POST /api/issues/${ISSUE_ID}/checkout`]);
  assert.ok(!output.join('\n').includes('dummy-key'));
});

test('QA fail verdict completes its issue as done while keeping secrets and child output out of logs', { skip: process.platform === 'win32' }, async t => {
  const apiMock = await mockPaperclip(t, { blockerStatus: null });
  const workspace = await tempDir(t);
  const bin = join(workspace, 'bin');
  await mkdir(bin);
  await mkdir(join(workspace, 'workflow-artifacts'));
  await mkdir(join(workspace, 'tests'));
  await writeFile(join(workspace, 'tests/agent-filter.test.mjs'), '// synthetic');
  await writeFile(join(workspace, 'tests/agent-filter.browser.mjs'), 'process.exit(0);');
  const marker = 'RAW_CHILD_OUTPUT_MARKER';
  await writeFile(join(bin, 'codex'), `#!/bin/sh\nprintf '%s\\n' '${marker}'\ncat > workflow-artifacts/smoke.json <<'EOF'\n{"verdict":"fail","findings":["Synthetic test finding."]}\nEOF\nprintf '%s\\n' 'QA checked synthetic fixtures.' > workflow-artifacts/smoke.md\n`);
  await writeFile(join(bin, 'npm'), '#!/bin/sh\nexit 0\n');
  await chmod(join(bin, 'codex'), 0o755);
  await chmod(join(bin, 'npm'), 0o755);
  setupEnv(t, { PAPERCLIP_API_URL: apiMock.apiUrl, PAPERCLIP_API_KEY: 'dummy-secret-marker', PAPERCLIP_AGENT_ID: 'dummy-agent', PAPERCLIP_RUN_ID: 'dummy-run', AX_VERIFY_URL: 'http://127.0.0.1:3200', PATH: `${bin}:${process.env.PATH ?? ''}` });
  const output = [];
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (...args) => output.push(args.join(' '));
  console.error = (...args) => output.push(args.join(' '));
  t.after(() => { console.log = oldLog; console.error = oldError; });
  const result = await main(['--stage', 'smoke', '--workspace', workspace, '--issue', ISSUE_ID]);
  assert.deepEqual(result, { stage: 'smoke', issueId: ISSUE_ID, verdict: 'fail' });
  const patch = apiMock.requests.find(r => r.method === 'PATCH');
  assert.equal(patch.body.status, 'done');
  assert.match(patch.body.comment, /QA verdict fail/);
  assert.ok(!JSON.stringify(apiMock.requests.map(r => r.body)).includes('dummy-secret-marker'));
  assert.ok(!output.join('\n').includes('dummy-secret-marker'));
  assert.ok(!output.join('\n').includes(marker));
});
