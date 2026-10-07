import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeWorkflowTask, assertImprovementInput, atomicJSON, definition, hydrateWorkflowDefinition, nextAfter, persistDeliveryEvidence, releaseAssetBaseline, releaseDeliveryRecord, releaseSourceBaseline, startVerifiedRelease, trackedTasks, transitions, validateDeliveryReview, validateQAReport, validateWorkflowDefinition, Workflow } from '../experiments/paperclip/ax-controller.mjs';

function approvalState(workspace = '/tmp/synthetic-approval-revalidation') {
  const current = state(workspace);
  current.cursor = 'approval';
  current.tasks = [
    { stage: 'system', issueId: 'issue-system-anchor', identifier: 'AX-SYS', runId: 'run-system-anchor', result: { verdict: 'pass' }, consumed: true },
    { stage: 'approval', issueId: 'issue-approval-primary', identifier: 'AX-APP', agentId: current.agents.product, runId: 'run-approval-failed', consumed: false, result: null },
  ];
  return current;
}

function approvalRevalidationMock(current, { loseCreateResponse = false, prelinked = false } = {}) {
  const calls = [];
  const createdByKey = new Map();
  const links = [];
  let lostResponse = false;
  let dependencies = [{ id: 'issue-existing-pm' }];
  const request = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (path === '/issues/issue-approval-primary' && method === 'GET') return {
      id: 'issue-approval-primary', status: 'in_progress', blockedBy: dependencies,
      executionBlocker: { recoveryActionId: 'approval-action', runId: 'run-approval-failed', agentId: current.agents.product },
    };
    if (path === '/heartbeat-runs/run-approval-failed') return { status: 'failed' };
    if (path === '/issues/issue-system-anchor') return { id: 'issue-system-anchor', status: 'done' };
    if (path === '/heartbeat-runs/run-system-anchor') return { status: 'succeeded' };
    if (path === `/companies/${current.companyId}/live-runs`) return [];
    if (path === `/companies/${current.companyId}/issues` && method === 'POST') {
      let issue = createdByKey.get(body.idempotencyKey);
      if (!issue) {
        issue = { id: 'issue-qa-supplemental', identifier: 'AX-QA-2' };
        createdByKey.set(body.idempotencyKey, issue);
        if (prelinked || loseCreateResponse) links.push({ issueId: issue.id, role: 'work' });
      }
      if (loseCreateResponse && !lostResponse) { lostResponse = true; throw new Error('synthetic create response lost after remote commit'); }
      return issue;
    }
    if (path === `/cases/${current.caseId}`) return { case: { id: current.caseId }, links: structuredClone(links) };
    if (path === `/cases/${current.caseId}/issue-links` && method === 'POST') { links.push({ issueId: body.issueId, role: body.role }); return { id: 'synthetic-link' }; }
    if (path === '/issues/issue-approval-primary' && method === 'PATCH') { dependencies = body.blockedByIssueIds.map(id => ({ id })); return { id: 'issue-approval-primary' }; }
    throw new Error(`Unexpected mock request: ${method} ${path}`);
  };
  return { request, calls, createdByKey, links };
}

test('verified release runtime gate runs before launch and rejects runtime or source tampering', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ax-start-verified-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releasePath = join(root, 'release');
  const serverPath = join(releasePath, 'server/index.mjs');
  await mkdir(join(releasePath, 'server'), { recursive: true });
  const source = 'export const synthetic = true;\n';
  await writeFile(serverPath, source);
  const sourceHashes = { 'server/index.mjs': createHash('sha256').update(source).digest('hex') };
  const release = { path: releasePath, workflowId: 'synthetic-verified-workflow', sourceHashes,
    digest: createHash('sha256').update(JSON.stringify(sourceHashes)).digest('hex') };
  const starts = [];
  const started = await startVerifiedRelease(release, 4321, { start: async (...args) => { starts.push(args); return { owned: true }; } });
  assert.deepEqual(starts, [[releasePath, 4321]]);
  assert.deepEqual(started, { owned: true });

  await writeFile(serverPath, `${source}// synthetic mutation\n`);
  const beforeRejectedMutation = starts.length;
  await assert.rejects(startVerifiedRelease(release, 4321, { start: async (...args) => { starts.push(args); } }), /changed after approval/);
  assert.equal(starts.length, beforeRejectedMutation, 'tampered runtime must be rejected before launch');

  let runtimeChecks = 0;
  const tamperedSourceBaseline = { ...release, digest: 'f'.repeat(64) };
  const beforeRejectedSource = starts.length;
  await assert.rejects(startVerifiedRelease(tamperedSourceBaseline, 4321, {
    verifyRuntime: async () => { runtimeChecks++; },
    start: async (...args) => { starts.push(args); },
  }), /source fingerprint changed/);
  assert.equal(runtimeChecks, 0, 'invalid fingerprint must reject before runtime inspection');
  assert.equal(starts.length, beforeRejectedSource, 'invalid fingerprint must reject before launch');
});

test('release source baseline requires immutable workflow identity and canonical SHA-256 source map', () => {
  const sources = { 'App.tsx': 'a'.repeat(64), 'src/view.ts': 'b'.repeat(64) };
  const digest = createHash('sha256').update(JSON.stringify(sources)).digest('hex');
  const release = { workflowId: 'workflow-reviewed', sourceHashes: sources, digest };
  assert.equal(releaseSourceBaseline(release), sources);

  assert.throws(() => releaseSourceBaseline({ ...release, digest: 'c'.repeat(64) }), /source fingerprint changed/);
  assert.throws(() => releaseSourceBaseline({ ...release, sourceHashes: { ...sources, 'App.tsx': 'c'.repeat(64) } }), /source fingerprint changed/);
  assert.throws(() => releaseSourceBaseline({ ...release, workflowId: '' }), /source fingerprint changed/);
  assert.throws(() => releaseSourceBaseline({ ...release, sourceHashes: [] }), /source fingerprint changed/);
  assert.throws(() => releaseSourceBaseline({ ...release, sourceHashes: new Map(Object.entries(sources)) }), /source fingerprint changed/);
  assert.throws(() => releaseSourceBaseline({ ...release, sourceHashes: { 'App.tsx': 'not-a-sha256' } }), /source fingerprint changed/);
});

test('supplemental system QA is linked behind the successful system issue and preserves the primary cursor', async () => {
  const current = approvalState();
  const primary = structuredClone(current.tasks);
  const mock = approvalRevalidationMock(current);
  const workflow = new Workflow(current, { request: mock.request, save: async () => {} });
  const task = await workflow.approvalRevalidation('Recheck the reviewed system evidence before releasing the pending approval.');
  assert.equal(task.stage, 'system');
  assert.equal(task.purpose, 'approval-revalidation');
  assert.equal(task.agentId, current.agents.test, 'QA assignee comes from the pinned system-stage team');
  const create = mock.calls.find(call => call.method === 'POST' && call.path.endsWith('/issues'));
  assert.deepEqual(create.body.blockedByIssueIds, ['issue-system-anchor']);
  assert.ok(task.reason);
  const update = mock.calls.find(call => call.path === '/issues/issue-approval-primary' && call.method === 'PATCH');
  assert.deepEqual(update.body.blockedByIssueIds, ['issue-existing-pm', 'issue-system-anchor', task.issueId]);
  assert.deepEqual(current.tasks, primary);
  assert.equal(current.cursor, 'approval');
  assert.deepEqual(trackedTasks(current), [...current.tasks, task]);
  assert.equal(current.activeSupplementalTaskId, task.issueId);
  assert.equal(activeWorkflowTask(current), task);

  const missingAgent = approvalState();
  delete missingAgent.agents.test;
  const missingAgentMock = approvalRevalidationMock(missingAgent);
  const missingAgentWorkflow = new Workflow(missingAgent, { request: missingAgentMock.request, save: async () => {} });
  await assert.rejects(missingAgentWorkflow.approvalRevalidation('Require the configured test team before creating any supplemental work.'), /Pinned system team has no assigned agent/);
  assert.deepEqual(missingAgentMock.calls, [], 'missing pinned QA agent must fail before API access');
});

test('lost supplemental issue response reuses its idempotency key and avoids duplicate native links', async () => {
  const current = approvalState();
  const primary = structuredClone(current.tasks);
  const mock = approvalRevalidationMock(current, { loseCreateResponse: true });
  let persisted = structuredClone(current);
  const save = async value => { persisted = structuredClone(value); };
  const initial = new Workflow(current, { request: mock.request, save });
  await assert.rejects(initial.approvalRevalidation('Review the successful system evidence before resuming product approval.'), /response lost/);
  const pending = persisted.pendingSupplementalTask;
  assert.equal(pending.approvalIssueId, 'issue-approval-primary');
  assert.ok(pending.payload.idempotencyKey);

  const restartedState = structuredClone(persisted);
  const restarted = new Workflow(restartedState, { request: mock.request, save });
  const task = await restarted.approvalRevalidation('Review the successful system evidence before resuming product approval.');
  const createCalls = mock.calls.filter(call => call.method === 'POST' && call.path.endsWith('/issues'));
  assert.equal(createCalls.length, 2);
  assert.equal(createCalls[0].body.idempotencyKey, createCalls[1].body.idempotencyKey);
  assert.equal(createCalls[0].body.idempotencyKey, pending.payload.idempotencyKey);
  assert.equal(task.issueId, 'issue-qa-supplemental');
  assert.equal(restartedState.supplementalTasks.length, 1);
  assert.equal(restartedState.pendingSupplementalTask, undefined);
  assert.equal(mock.calls.filter(call => call.path.endsWith('/issue-links') && call.method === 'POST').length, 0,
    'existing native link discovered after response loss must not be duplicated');
  assert.deepEqual(restartedState.tasks, primary);
  assert.equal(restartedState.cursor, 'approval');
});

test('primary approval recovery waits for supplemental QA native pass, issue completion, matching provenance, and unchanged system report', async t => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'ax-approval-revalidation-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const checks = [
    'file tests/agent-filter.test.mjs', 'file tests/agent-filter.browser.mjs', 'npm test',
    'npm run build', 'node tests/agent-filter.browser.mjs',
  ].map(command => ({ command, status: 'pass' }));
  const makeSupplemental = overrides => ({ stage: 'system', purpose: 'approval-revalidation', approvalIssueId: 'issue-approval-primary',
    issueId: 'issue-qa-supplemental', identifier: 'AX-QA-2', agentId: 'agent-qa', runId: 'run-qa-supplemental', consumed: true,
    result: { runId: 'run-qa-supplemental', issueId: 'issue-qa-supplemental', verdict: 'pass', agentVerdict: 'pass', findings: [], checks }, ...overrides });
  let attemptNumber = 0;
  const attempt = async ({ supplemental, qaRunStatus = 'succeeded', qaIssueStatus = 'done', reportMode = 'matching' } = {}) => {
    const workspace = join(workspaceRoot, `attempt-${++attemptNumber}`);
    await mkdir(join(workspace, 'workflow-artifacts'), { recursive: true });
    const current = approvalState(workspace);
    current.supplementalTasks = [supplemental ?? makeSupplemental()];
    current.activeSupplementalTaskId = current.supplementalTasks[0].issueId;
    const report = structuredClone(current.supplementalTasks[0].result);
    if (reportMode === 'stale') report.runId = 'old-verified-run';
    if (reportMode === 'modified') report.checks.reverse();
    if (reportMode !== 'missing') await writeFile(join(workspace, 'workflow-artifacts/system.json'), JSON.stringify(report));
    const calls = [];
    const request = async (path, method = 'GET') => {
      calls.push({ path, method });
      if (path === '/heartbeat-runs/run-qa-supplemental') return { status: qaRunStatus };
      if (path === '/issues/issue-qa-supplemental') return { id: 'issue-qa-supplemental', status: qaIssueStatus };
      if (path === '/issues/issue-approval-primary') return { id: 'issue-approval-primary', status: 'in_progress', executionBlocker: { recoveryActionId: 'approval-action', runId: 'run-approval-failed', agentId: 'agent-product' } };
      if (path === '/heartbeat-runs/run-approval-failed') return { status: 'failed' };
      if (path === '/agents/agent-product' && method === 'PATCH') return { id: 'agent-product' };
      if (path === '/issues/issue-approval-primary/recovery-actions/resolve') return { resolved: true };
      if (path === '/issues/issue-approval-primary/runs') return [{ runId: 'run-approval-retry', agentId: 'agent-product', retryOfRunId: 'run-approval-failed' }];
      if (path === '/heartbeat-runs/run-approval-retry') return { status: 'running', contextSnapshot: { recoveryActionId: 'approval-action', previousRunId: 'run-approval-failed' } };
      throw new Error(`Unexpected recovery request: ${method} ${path}`);
    };
    const workflow = new Workflow(current, { request, save: async () => {}, now: () => 0, sleep: async () => {} });
    return { current, workflow, calls };
  };

  for (const invalid of [
    { supplemental: makeSupplemental({ consumed: false }) },
    { supplemental: makeSupplemental({ result: { runId: 'run-qa-supplemental', issueId: 'issue-qa-supplemental', verdict: 'fail', agentVerdict: 'fail', findings: ['Synthetic QA failure.'], checks } }) },
    { supplemental: makeSupplemental({ result: { runId: 'stale-run', issueId: 'issue-qa-supplemental', verdict: 'pass', agentVerdict: 'pass', findings: [], checks } }) },
    { supplemental: makeSupplemental({ result: { runId: 'run-qa-supplemental', issueId: 'stale-issue', verdict: 'pass', agentVerdict: 'pass', findings: [], checks } }) },
    { qaRunStatus: 'failed' },
    { qaIssueStatus: 'in_progress' },
    { reportMode: 'missing' },
    { reportMode: 'stale' },
    { reportMode: 'modified' },
  ]) {
    const f = await attempt(invalid);
    await assert.rejects(f.workflow.recover({ actionOutcome: 'not_performed', outcomeEvidence: 'Reviewed the approval blocker and supplemental QA recovery evidence.' }));
    assert.ok(!f.calls.some(call => call.path.endsWith('/recovery-actions/resolve')), 'invalid supplemental evidence must block primary approval recovery');
    assert.equal(f.current.pendingRecovery, undefined);
  }

  const passing = await attempt();
  const resumed = await passing.workflow.recover({ actionOutcome: 'not_performed', outcomeEvidence: 'Reviewed the approved synthetic QA pass and confirmed no side effect was performed.' });
  assert.equal(resumed.runId, 'run-approval-retry');
  assert.ok(passing.calls.some(call => call.path.endsWith('/recovery-actions/resolve')));
});

test('recorded release asset fingerprint rejects damaged metadata and preserves legacy releases', () => {
  assert.equal(releaseAssetBaseline({ digest: 'legacy-source' }), undefined);
  const canonical = { 'assets/app.js': 'a'.repeat(64), 'index.html': 'b'.repeat(64) };
  const assetDigest = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  const assetHashes = { 'index.html': canonical['index.html'], 'assets/app.js': canonical['assets/app.js'] };
  assert.equal(releaseAssetBaseline({ assetHashes, assetDigest }), assetHashes);
  assert.throws(() => releaseAssetBaseline({ assetHashes: { ...assetHashes, 'assets/app.js': 'c'.repeat(64) }, assetDigest }), /fingerprint changed/);
  assert.throws(() => releaseAssetBaseline({ assetHashes }), /fingerprint changed/);
  assert.throws(() => releaseAssetBaseline({ assetDigest }), /malformed/);
  assert.throws(() => releaseAssetBaseline({ assetHashes: [], assetDigest }), /malformed/);
});

test('delivery record binds verified asset bytes to the correct workflow and source fingerprint', () => {
  const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const sourceHashes = { 'App.tsx': 'a'.repeat(64), 'server/api.mjs': 'b'.repeat(64) };
  const assetHashes = { 'assets/app.js': 'c'.repeat(64), 'index.html': 'd'.repeat(64) };
  const legacy = { workflowId: 'recorded-flow', digest: sha(sourceHashes), sourceHashes, url: 'http://127.0.0.1:3201' };
  const delivery = { verdict: 'pass', url: legacy.url, checks: Object.entries(assetHashes).map(([asset, sha256]) => ({ asset, sha256, status: 'pass' })) };
  const record = releaseDeliveryRecord(legacy, delivery);
  assert.equal(record.workflowId, legacy.workflowId);
  assert.equal(record.releaseDigest, legacy.digest);
  assert.equal(record.assetDigest, sha(assetHashes));
  assert.equal(record.assetBaseline, 'verification-time');
  assert.ok(Number.isFinite(Date.parse(record.verifiedAt)));
  const packaged = { ...legacy, assetHashes, assetDigest: sha(assetHashes) };
  assert.equal(releaseDeliveryRecord(packaged, delivery).assetBaseline, 'packaging-time');
  assert.throws(() => releaseDeliveryRecord({ ...legacy, sourceHashes: { ...sourceHashes, 'App.tsx': 'e'.repeat(64) } }, delivery), /source fingerprint changed/);
  assert.throws(() => releaseDeliveryRecord(legacy, { ...delivery, url: 'http://127.0.0.1:3200' }), /evidence is invalid/);
  assert.throws(() => releaseDeliveryRecord(packaged, { ...delivery, checks: delivery.checks.slice(1) }), /assets differ/);
  assert.throws(() => releaseDeliveryRecord(legacy, { ...delivery, checks: [...delivery.checks, delivery.checks[0]] }), /evidence is invalid/);
});

test('repeated delivery verification preserves protected bytes and rejects changed evidence during active execution', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'ax-delivery-evidence-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, 'workflow-artifacts'));
  const sourceHashes = { 'App.tsx': 'a'.repeat(64) };
  const candidate = { workflowId: 'protected-flow', sourceHashes, digest: createHash('sha256').update(JSON.stringify(sourceHashes)).digest('hex'), url: 'http://127.0.0.1:3201' };
  const delivery = { verdict: 'pass', url: candidate.url, checks: [{ asset: 'index.html', sha256: 'b'.repeat(64), status: 'pass' }] };
  const fixture = { workspace, companyId: 'company-1', candidate, events: [] };
  let liveQueries = 0;
  const first = await persistDeliveryEvidence(fixture, delivery, { request: async () => { liveQueries++; return []; }, save: async () => {} });
  const file = join(workspace, 'workflow-artifacts/release-delivery.json');
  const before = await readFile(file);
  const beforeStat = await stat(file, { bigint: true });
  const repeated = await persistDeliveryEvidence(fixture, delivery, { request: async () => { throw new Error('Identical protected evidence must not require a live-run query'); }, save: async () => {} });
  assert.deepEqual(await readFile(file), before);
  const afterStat = await stat(file, { bigint: true });
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.mtimeNs, beforeStat.mtimeNs);
  assert.equal(afterStat.ctimeNs, beforeStat.ctimeNs);
  assert.equal(repeated.verifiedAt, first.verifiedAt);
  assert.equal(liveQueries, 1);
  assert.equal(fixture.events.at(-1).reusedEvidence, true);
  const changed = { ...delivery, checks: [{ ...delivery.checks[0], sha256: 'c'.repeat(64) }] };
  await assert.rejects(persistDeliveryEvidence(fixture, changed, { request: async () => [{ status: 'running' }], save: async () => {} }), /Cannot change protected delivery evidence/);
  assert.deepEqual(await readFile(file), before);
  await writeFile(file, JSON.stringify({ ...first, verifiedAt: 'invalid-timestamp' }));
  await assert.rejects(persistDeliveryEvidence(fixture, delivery, { request: async () => [{ status: 'queued' }], save: async () => {} }), /Cannot change protected delivery evidence/);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).verifiedAt, 'invalid-timestamp');
});

function state(workspace) {
  return { companyId: 'company-1', projectId: 'project-1', pipelineId: 'pipeline-1', caseId: 'case-1', workspace,
    agents: { product: 'agent-product', development: 'agent-dev', test: 'agent-qa', operations: 'agent-ops' },
    tasks: [], cursor: 'requirements', retryStage: null, attempts: {}, events: [], complete: false };
}

function nativePipeline(flow) {
  const stages = flow.stages.map((stage, index) => ({ id: `native-${stage.key}`, key: stage.key, kind: 'working', position: (index + 1) * 100 }));
  const base = flow.stages.length * 100;
  return { stages: [...stages,
    { id: 'native-fix', key: 'fix', kind: 'working', position: base + 100 },
    { id: 'native-done', key: 'done', kind: 'done', position: base + 200 },
    { id: 'native-cancelled', key: 'cancelled', kind: 'cancelled', position: base + 300 },
  ] };
}

function paperclip(state, { verdicts = {}, completeIssues = true, runStatuses = ['succeeded'], startTime = 0, sleep } = {}) {
  const calls = [];
  const issues = new Map();
  const runs = new Map();
  const issuesByIdempotencyKey = new Map();
  const links = [];
  const verdictIndex = new Map();
  let issueNumber = 0;
  let runNumber = 0;
  let clock = startTime;
  const now = () => clock;
  const pause = sleep ?? (async ms => { clock += ms; });
  const request = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (path === `/companies/${state.companyId}/issues` && method === 'POST') {
      assert.equal(body.allowDuplicate, true);
      assert.ok(body.idempotencyKey, 'issue creation includes a stable idempotency key');
      const prior = issuesByIdempotencyKey.get(body.idempotencyKey);
      if (prior) return { id: prior.id, identifier: prior.identifier };
      const id = `issue-${++issueNumber}`;
      const issue = { id, identifier: `AX-${issueNumber}`, status: body.status, body };
      issues.set(id, issue);
      issuesByIdempotencyKey.set(body.idempotencyKey, issue);
      return { id, identifier: issue.identifier };
    }
    if (path === `/cases/${state.caseId}/issue-links` && method === 'POST') {
      assert.ok(issues.has(body.issueId), 'links reference a created issue');
      links.push({ issueId: body.issueId, role: body.role });
      return { id: `link-${body.issueId}` };
    }
    if (path === `/cases/${state.caseId}`) return { case: { stageId: state.cursor, version: 1 }, links: structuredClone(links) };
    if (path === `/pipelines/${state.pipelineId}`) return { stages: [...definition.stages, definition.rework, { key: 'done' }, { key: 'cancelled' }].map(s => ({ id: s.key, key: s.key })) };
    if (path === `/cases/${state.caseId}/transition` && method === 'POST') {
      state.cursor = body.toStageKey;
      return { case: { version: 2 } };
    }
    if (path === '/issues' || path.startsWith('/issues/')) {
      const id = path.slice('/issues/'.length);
      const issue = issues.get(id);
      assert.ok(issue, `known issue requested: ${id}`);
      if (method === 'GET') return { id, status: issue.status };
      return issue;
    }
    if (path.startsWith('/agents/') && method === 'PATCH') return { id: path.split('/')[2] };
    if (path.endsWith('/wakeup') && method === 'POST') {
      const id = `run-${++runNumber}`;
      runs.set(id, { statusIndex: 0, issueId: body.payload.issueId, stage: state.tasks.find(t => t.issueId === body.payload.issueId)?.stage });
      return { id };
    }
    if (path.startsWith('/heartbeat-runs/') && path.endsWith('/cancel')) return { status: 'cancelled' };
    if (path.startsWith('/heartbeat-runs/')) {
      const id = path.slice('/heartbeat-runs/'.length);
      const run = runs.get(id);
      assert.ok(run, `known run requested: ${id}`);
      const status = runStatuses[Math.min(run.statusIndex++, runStatuses.length - 1)];
      if (status === 'succeeded' && completeIssues) {
        const issue = issues.get(run.issueId);
        issue.status = 'done';
        if (new Set(['smoke', 'system', 'acceptance']).has(run.stage)) {
          const artifact = join(state.workspace, 'workflow-artifacts', `${run.stage}.json`);
          const configured = verdicts[`${run.stage}:${issue.id}`] ?? verdicts[run.stage] ?? 'pass';
          const index = verdictIndex.get(run.stage) ?? 0;
          const verdict = Array.isArray(configured) ? configured[Math.min(index, configured.length - 1)] : configured;
          verdictIndex.set(run.stage, index + 1);
          const checks = [
            { command: 'file tests/agent-filter.test.mjs', status: 'pass' },
            { command: 'file tests/agent-filter.browser.mjs', status: 'pass' },
            { command: 'npm test', status: 'pass' },
            { command: 'npm run build', status: 'pass' },
            { command: 'node tests/agent-filter.browser.mjs', status: 'pass' },
          ];
          await writeFile(artifact, JSON.stringify({ verdict, agentVerdict: verdict, findings: verdict === 'pass' ? [] : ['Synthetic finding.'], checks, runId: id, issueId: issue.id }));
        }
      }
      return { status };
    }
    throw new Error(`Unexpected mock Paperclip request: ${method} ${path}`);
  };
  return { request, calls, issues, runs, links, issuesByIdempotencyKey, now, sleep: pause, get wakeups() { return runNumber; } };
}

async function fixture(options = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'ax-workflow-test-'));
  await mkdir(join(workspace, 'workflow-artifacts'));
  const current = state(workspace);
  const mock = paperclip(current, options);
  const workflow = new Workflow(current, { request: mock.request, save: async () => {}, sleep: mock.sleep, now: mock.now });
  return { workspace, state: current, workflow, ...mock, close: () => rm(workspace, { recursive: true, force: true }) };
}

async function execute(f, stage, verdict) {
  const task = await f.workflow.task(stage);
  if (verdict) {
    const path = join(f.workspace, 'workflow-artifacts', `${stage}.json`);
    await writeFile(path, JSON.stringify({ verdict }));
  }
  const result = await f.workflow.execute(task, 'http://127.0.0.1:3200');
  return { task, result };
}

async function completedFixFixture(t, runStatus = 'succeeded') {
  const f = await fixture({ runStatuses: [runStatus] });
  t.after(f.close);
  f.state.cursor = 'fix';
  f.state.retryStage = 'system';
  const task = await f.workflow.task('fix');
  f.issues.get(task.issueId).status = 'done';
  task.runId = 'run-reviewed-fix';
  f.runs.set(task.runId, { statusIndex: 0, issueId: task.issueId, stage: 'fix' });
  return { f, task };
}

function recoveryFixture({ blocker = {}, previousStatus = 'failed', candidates = [], runs = {}, loseFirstResolve = false, stage = 'implement' } = {}) {
  const current = state('/tmp/synthetic-recovery-workspace');
  const team = ['acceptance', 'delivery-review'].includes(stage) ? 'product' : 'development';
  const task = { stage, issueId: 'issue-recovery', agentId: current.agents[team], runId: 'run-failed', runHistory: [], consumed: false };
  current.tasks.push(task);
  const calls = [];
  const resolveBodies = [];
  let time = 0;
  let persisted = structuredClone(current);
  let didLoseResolve = false;
  const request = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (path === `/issues/${task.issueId}`) return { id: task.issueId, status: 'in_progress', executionBlocker: {
      recoveryActionId: 'action-1', runId: task.runId, agentId: task.agentId, ...blocker,
    } };
    if (path === `/heartbeat-runs/${task.runId}`) return { status: previousStatus };
    if (path === `/agents/${task.agentId}` && method === 'PATCH') return { id: task.agentId };
    if (path === `/issues/${task.issueId}/recovery-actions/resolve` && method === 'POST') {
      if (loseFirstResolve && !didLoseResolve) assert.ok(persisted.pendingRecovery, 'journal is saved before posting recovery resolution');
      resolveBodies.push(structuredClone(body));
      if (loseFirstResolve && !didLoseResolve) {
        didLoseResolve = true;
        return Promise.reject(new Error('synthetic recovery response lost after server commit'));
      }
      return { resolved: true };
    }
    if (path === `/issues/${task.issueId}/runs`) return candidates;
    if (path.startsWith('/heartbeat-runs/')) return runs[path.slice('/heartbeat-runs/'.length)] ?? { status: 'running', contextSnapshot: {} };
    if (path.endsWith('/wakeup')) throw new Error('Recovery must not call generic wakeup');
    throw new Error(`Unexpected recovery mock request: ${method} ${path}`);
  };
  const save = async value => { persisted = structuredClone(value); };
  const workflow = new Workflow(current, { request, save, now: () => time, sleep: async ms => { time += ms; } });
  return { current, task, workflow, calls, resolveBodies, get persisted() { return persisted; }, set persisted(value) { persisted = value; } };
}

test('stage map exposes sequential transitions and QA repair routes', () => {
  assert.equal(nextAfter('requirements'), 'design');
  assert.equal(nextAfter('acceptance'), 'delivery-review');
  assert.equal(nextAfter('delivery-review'), 'done');
  assert.throws(() => nextAfter('missing'), /Unknown workflow stage/);
  const edges = transitions();
  assert.ok(edges.some(edge => edge.fromStageKey === 'acceptance' && edge.toStageKey === 'fix'));
  assert.ok(edges.some(edge => edge.fromStageKey === 'fix' && edge.toStageKey === 'system'));
});

test('legacy workflow definition hydrates once, pins old task metadata, and reconciles its pending terminal transition', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'ax-definition-hydrate-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const historical = structuredClone(definition);
  historical.stages = historical.stages.filter(stage => stage.key !== 'delivery-review');
  historical.description = 'Pinned historical workflow description.';
  const oldAcceptance = historical.stages.find(stage => stage.key === 'acceptance');
  oldAcceptance.phase = 'Historical online phase';
  oldAcceptance.name = 'Historical acceptance label';
  oldAcceptance.team = 'product';
  const flowPath = join(workspace, 'experiments/paperclip/ax-workflow.json');
  await mkdir(join(workspace, 'experiments/paperclip'), { recursive: true });
  await writeFile(flowPath, JSON.stringify(historical));

  const current = state(workspace);
  current.cursor = 'acceptance';
  current.pendingMove = { from: 'acceptance', to: 'done', reason: 'historical acceptance verified' };
  let remoteStage = 'acceptance';
  let readCount = 0;
  let saveCount = 0;
  const calls = [];
  const request = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (path === '/pipelines/pipeline-1') return nativePipeline(historical);
    if (path === '/cases/case-1') return { case: { stageId: `native-${remoteStage}`, version: 7 }, links: [] };
    if (path === '/cases/case-1/transition') { remoteStage = body.toStageKey; return { case: { version: 8 } }; }
    throw new Error(`Unexpected hydration request: ${path}`);
  };
  const readDefinition = async path => { readCount++; assert.equal(path, flowPath); return JSON.parse(await readFile(path, 'utf8')); };
  const save = async () => { saveCount++; };
  const hydrated = await hydrateWorkflowDefinition(current, { request, save, readDefinition });
  assert.equal(hydrated.stages.some(stage => stage.key === 'delivery-review'), false);
  assert.equal(nextAfter('acceptance', hydrated), 'done');
  assert.equal(current.workflowDefinitionDigest, createHash('sha256').update(JSON.stringify(historical)).digest('hex'));
  assert.equal(current.events.at(-1).type, 'workflow-definition-restored');
  assert.equal(readCount, 1);
  assert.equal(saveCount, 1);

  await hydrateWorkflowDefinition(current, {
    request, save,
    readDefinition: async () => { throw new Error('pinned workflows must not be reconstructed'); },
  });
  assert.equal(readCount, 1);
  assert.equal(saveCount, 1);

  const restarted = new Workflow(current, { request, save });
  await restarted.reconcile();
  assert.equal(current.cursor, 'done');
  assert.equal(remoteStage, 'done');
  assert.equal(calls.filter(call => call.path.endsWith('/transition')).length, 1);

  const taskState = structuredClone(current);
  taskState.cursor = 'acceptance';
  taskState.pendingMove = null;
  taskState.tasks = [];
  const taskMock = paperclip(taskState);
  const task = await new Workflow(taskState, { request: taskMock.request, save }).task('acceptance');
  const payload = taskMock.calls.find(call => call.method === 'POST' && call.path.endsWith('/issues')).body;
  assert.equal(task.agentId, taskState.agents.product);
  assert.equal(payload.title, 'Historical online phase · Historical acceptance label');
  assert.match(payload.description, /^Pinned historical workflow description\./);
});

test('workflow snapshot rejects native order, membership, kind, saved-reference, and fingerprint drift', async () => {
  const flow = structuredClone(definition);
  const validPipeline = nativePipeline(flow);
  assert.equal(validateWorkflowDefinition(flow, validPipeline), flow);

  const reordered = nativePipeline(flow);
  [reordered.stages[0].position, reordered.stages[1].position] = [reordered.stages[1].position, reordered.stages[0].position];
  assert.throws(() => validateWorkflowDefinition(flow, reordered), /Native stage order/);

  const missing = nativePipeline(flow);
  missing.stages.splice(2, 1);
  assert.throws(() => validateWorkflowDefinition(flow, missing), /Native pipeline differs/);

  const unknown = nativePipeline(flow);
  unknown.stages[0].key = 'unregistered-stage';
  assert.throws(() => validateWorkflowDefinition(flow, unknown), /Native pipeline differs/);

  const changedKind = nativePipeline(flow);
  changedKind.stages.find(stage => stage.key === 'design').kind = 'done';
  assert.throws(() => validateWorkflowDefinition(flow, changedKind), /Native stage order/);

  assert.throws(() => validateWorkflowDefinition(flow, validPipeline, { cursor: 'unregistered-stage', tasks: [] }), /Saved execution references/);

  const workspace = await mkdtemp(join(tmpdir(), 'ax-definition-tamper-'));
  try {
    const pinned = structuredClone(flow);
    const stateWithPinned = { ...state(workspace), workflowDefinition: pinned, workflowDefinitionDigest: '0'.repeat(64) };
    await assert.rejects(hydrateWorkflowDefinition(stateWithPinned, {
      request: async () => validPipeline,
      readDefinition: async () => { throw new Error('must not read history when a pinned snapshot exists'); },
    }), /snapshot fingerprint changed/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('atomicJSON creates private, parseable JSON through an atomic replacement', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ax-atomic-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  await atomicJSON(path, { cursor: 'smoke', tasks: [] });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { cursor: 'smoke', tasks: [] });
  assert.deepEqual(await readdir(dir), ['state.json']);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('task creation links issues and chains each issue behind its predecessor', async t => {
  const f = await fixture();
  t.after(f.close);
  const first = await f.workflow.task('requirements');
  const second = await f.workflow.task('design');
  assert.equal(first.agentId, f.state.agents.product);
  assert.equal(second.agentId, f.state.agents.development);
  const created = f.calls.filter(c => c.method === 'POST' && c.path.endsWith('/issues'));
  assert.deepEqual(created[0].body.blockedByIssueIds, []);
  assert.deepEqual(created[1].body.blockedByIssueIds, [first.issueId]);
  assert.deepEqual(f.calls.filter(c => c.path.endsWith('/issue-links')).map(c => c.body.issueId), [first.issueId, second.issueId]);
});

test('lost issue-create response reuses persisted idempotency key and links the single created issue', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'ax-task-recovery-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const current = state(workspace);
  const mock = paperclip(current);
  let lostResponse = true;
  const request = async (...args) => {
    const result = await mock.request(...args);
    if (args[0] === `/companies/${current.companyId}/issues` && args[1] === 'POST' && lostResponse) {
      lostResponse = false;
      throw new Error('synthetic response lost after server create');
    }
    return result;
  };
  let persisted = structuredClone(current);
  const save = async value => { persisted = structuredClone(value); };
  const first = new Workflow(current, { request, save });
  await assert.rejects(first.task('requirements'), /response lost/);
  const pendingKey = persisted.pendingTask.payload.idempotencyKey;
  assert.equal(persisted.tasks.length, 0);
  const restarted = new Workflow(persisted, { request, save });
  const recovered = await restarted.task('requirements');
  assert.equal(persisted.tasks.length, 1);
  assert.equal(persisted.tasks[0].issueId, 'issue-1');
  assert.equal(persisted.pendingTask, null);
  const postPayloads = mock.calls.filter(call => call.path === `/companies/${current.companyId}/issues`).map(call => call.body);
  assert.equal(postPayloads.length, 2);
  assert.ok(postPayloads.every(payload => payload.idempotencyKey === pendingKey && payload.allowDuplicate === true));
  assert.equal(mock.issues.size, 1);
  assert.equal(recovered.issueId, 'issue-1');
  assert.equal(mock.links.length, 1);
  recovered.linked = false;
  await restarted.task('requirements');
  assert.equal(mock.links.length, 1, 'existing active case link is not duplicated');
});

test('code-review revision requires a fix stage, unfinished task, completed run, and concrete feedback', async t => {
  const consumed = await completedFixFixture(t);
  consumed.task.consumed = true;
  await assert.rejects(consumed.f.workflow.requestRevision('Please make the reviewed code change.'), /unfinished fix stage/);

  const wrongStage = await completedFixFixture(t);
  wrongStage.f.state.cursor = 'system';
  await assert.rejects(wrongStage.f.workflow.requestRevision('Please make the reviewed code change.'), /unfinished fix stage/);

  const noRun = await completedFixFixture(t);
  noRun.task.runId = null;
  await assert.rejects(noRun.f.workflow.requestRevision('Please make the reviewed code change.'), /completed development execution/);

  const activeRun = await completedFixFixture(t, 'running');
  await assert.rejects(activeRun.f.workflow.requestRevision('Please make the reviewed code change.'), /completed development execution/);

  const shortFeedback = await completedFixFixture(t);
  await assert.rejects(shortFeedback.f.workflow.requestRevision('too short'), /20 to 600 characters/);
  await assert.rejects(shortFeedback.f.workflow.requestRevision('x'.repeat(601)), /20 to 600 characters/);
});

test('reviewed fix execution is verified without transitioning, then revision creates chained fix and returns to QA', async t => {
  const { f, task } = await completedFixFixture(t);
  let persisted;
  f.workflow.save = async value => { persisted = structuredClone(value); };
  const reason = 'Preserve the selected-session detail reset and keep its existing assertions.';
  await f.workflow.requestRevision(` ${reason} `);
  assert.equal(task.consumed, true);
  assert.equal(task.result.verdict, 'pass');
  assert.equal(f.state.cursor, 'fix');
  assert.equal(persisted.reviewReason, reason);
  assert.equal(f.state.events.at(-1).type, 'code-review-revision');
  assert.ok(!f.calls.some(call => call.path.endsWith('/transition')));

  const revision = await f.workflow.task('fix');
  const createCall = f.calls.filter(call => call.path === `/companies/${f.state.companyId}/issues`).at(-1);
  assert.equal(revision.stage, 'fix');
  assert.deepEqual(createCall.body.blockedByIssueIds, [task.issueId]);
  assert.match(createCall.body.description, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(f.state.reviewReason, undefined);
  assert.equal(persisted.reviewReason, undefined);

  f.issues.get(revision.issueId).status = 'done';
  revision.runId = 'run-revised-fix';
  f.runs.set(revision.runId, { statusIndex: 0, issueId: revision.issueId, stage: 'fix' });
  await f.workflow.execute(revision, 'http://127.0.0.1:3200');
  await f.workflow.advance(revision);
  assert.equal(f.state.cursor, 'system');
  assert.equal(revision.consumed, true);
});

test('QA fail routes through fix and the same QA stage must pass on a new issue', async t => {
  const f = await fixture({ verdicts: { smoke: ['fail', 'pass'] } });
  t.after(f.close);
  const failed = await execute(f, 'smoke');
  assert.equal(failed.result.verdict, 'fail');
  await f.workflow.advance(failed.task);
  assert.equal(f.state.cursor, 'fix');
  const repair = await execute(f, 'fix');
  await f.workflow.advance(repair.task);
  assert.equal(f.state.cursor, 'smoke');
  const retest = await execute(f, 'smoke', 'pass');
  assert.notEqual(retest.task.issueId, failed.task.issueId);
  await f.workflow.advance(retest.task);
  assert.equal(f.state.cursor, 'system');
});

test('acceptance failure returns to system QA and traverses approval and release again', async t => {
  const f = await fixture({ verdicts: { acceptance: ['fail', 'pass'] } });
  t.after(f.close);
  const first = await execute(f, 'acceptance');
  await f.workflow.advance(first.task);
  const fix = await execute(f, 'fix');
  await f.workflow.advance(fix.task);
  assert.equal(f.state.cursor, 'system');
  for (const stage of ['system', 'approval', 'release', 'acceptance']) {
    const { task } = await execute(f, stage, stage === 'acceptance' ? 'pass' : undefined);
    await f.workflow.advance(task);
  }
  assert.deepEqual(f.state.tasks.map(task => task.stage), ['acceptance', 'fix', 'system', 'approval', 'release', 'acceptance']);
  assert.equal(f.state.cursor, 'delivery-review');
});

test('final product review approves only the current independently verified acceptance and candidate', async t => {
  const f = await fixture();
  t.after(f.close);
  const accepted = await execute(f, 'acceptance');
  await f.workflow.advance(accepted.task);
  assert.equal(f.state.cursor, 'delivery-review');
  f.state.candidate = { digest: 'a'.repeat(64) };
  const report = { accepted: true, reason: 'Reviewed the actual passing acceptance and delivered assets.', releaseDigest: f.state.candidate.digest, acceptanceRunId: accepted.task.runId, acceptanceIssueId: accepted.task.issueId };
  assert.equal(validateDeliveryReview(report, f.state).verdict, 'pass');
  for (const invalid of [{ ...report, accepted: false }, { ...report, reason: ' ' }, { ...report, releaseDigest: 'b'.repeat(64) }, { ...report, acceptanceRunId: 'older-run' }, { ...report, acceptanceIssueId: 'older-issue' }, { ...report, privateOutput: 'unsupported' }]) {
    assert.throws(() => validateDeliveryReview(invalid, f.state), /current verified release/);
  }
  const original = accepted.task.result;
  accepted.task.result = { ...original, checks: original.checks.slice(1) };
  assert.throws(() => validateDeliveryReview(report, f.state), /missing independent checks/);
  accepted.task.result = original;
  await writeFile(join(f.workspace, 'workflow-artifacts/delivery-review.json'), JSON.stringify(report));
  const review = await execute(f, 'delivery-review');
  const payload = f.calls.filter(call => call.path === `/companies/${f.state.companyId}/issues`).at(-1).body;
  assert.equal(payload.assigneeAgentId, f.state.agents.product);
  assert.deepEqual(payload.blockedByIssueIds, [accepted.task.issueId]);
  assert.equal(review.result.accepted, true);
  await f.workflow.advance(review.task);
  assert.equal(f.state.cursor, 'done');
});

test('three repair attempts are allowed and the next failed QA leaves workflow incomplete', async t => {
  const f = await fixture({ verdicts: { smoke: 'fail' } });
  t.after(f.close);
  for (let attempt = 1; attempt <= definition.rework.maxAttempts; attempt++) {
    const { task } = await execute(f, 'smoke');
    await f.workflow.advance(task);
    assert.equal(f.state.attempts.smoke, attempt);
    const repair = await execute(f, 'fix');
    await f.workflow.advance(repair.task);
  }
  const fourth = await execute(f, 'smoke');
  await assert.rejects(f.workflow.advance(fourth.task), /Rework limit reached/);
  assert.equal(f.state.complete, false);
  assert.equal(f.state.attempts.smoke, definition.rework.maxAttempts + 1);
});

test('cannot advance QA without a verified verdict', async t => {
  const f = await fixture({ verdicts: { smoke: 'unknown' } });
  t.after(f.close);
  const task = await f.workflow.task('smoke');
  await assert.rejects(f.workflow.advance(task), /No verified task result/);
  await assert.rejects(f.workflow.execute(task, 'http://127.0.0.1:3200'), /Invalid stage verdict/);
  await assert.rejects(f.workflow.advance(task), /No verified task result/);
});

test('controller rejects stale, incomplete, or contradictory QA provenance and checks', () => {
  const task = { runId: 'run-current', issueId: 'issue-current' };
  const mandatory = [
    'file tests/agent-filter.test.mjs', 'file tests/agent-filter.browser.mjs', 'npm test',
    'npm run build', 'node tests/agent-filter.browser.mjs',
  ];
  const report = { runId: task.runId, issueId: task.issueId, verdict: 'pass', agentVerdict: 'pass', findings: [], checks: mandatory.map(command => ({ command, status: 'pass' })) };
  assert.equal(validateQAReport(report, task), report);
  assert.throws(() => validateQAReport({ ...report, runId: 'run-stale' }, task), /does not belong/);
  assert.throws(() => validateQAReport({ ...report, issueId: 'issue-stale' }, task), /does not belong/);
  assert.throws(() => validateQAReport({ ...report, checks: report.checks.slice(1) }, task), /missing independent checks/);
  assert.throws(() => validateQAReport({ ...report, checks: report.checks.map((check, index) => index === 2 ? { ...check, status: 'fail' } : check) }, task), /contradicts independent checks/);
  assert.throws(() => validateQAReport({ ...report, verdict: 'fail' }, task), /contradicts independent checks/);
  assert.throws(() => validateQAReport({ ...report, findings: ['reported failure'] }, task), /contradicts independent checks/);
});

test('graph-verified follow-up QA requires the canonical graph verification check', () => {
  const task = { runId: 'run-graph', issueId: 'issue-graph', graphVerification: true };
  const mandatory = [
    'file tests/agent-filter.test.mjs', 'file tests/agent-filter.browser.mjs', 'npm test',
    'npm run build', 'node tests/agent-filter.browser.mjs', 'node experiments/paperclip/verify-agent-filter.mjs',
  ];
  const report = { runId: task.runId, issueId: task.issueId, verdict: 'pass', agentVerdict: 'pass', findings: [], checks: mandatory.map(command => ({ command, status: 'pass' })) };
  assert.equal(validateQAReport(report, task), report);
  assert.throws(() => validateQAReport({ ...report, checks: report.checks.slice(0, -1) }, task), /missing independent checks/);
  assert.throws(() => validateQAReport({ ...report, checks: report.checks.map(check => check.command === mandatory.at(-1) ? { ...check, status: 'fail' } : check) }, task), /contradicts independent checks/);
});

test('topology-verified QA requires the canonical topology check and rejects its failure', () => {
  const task = { runId: 'run-topology', issueId: 'issue-topology', topologyVerification: true };
  const mandatory = [
    'file tests/agent-filter.test.mjs', 'file tests/agent-filter.browser.mjs', 'npm test',
    'npm run build', 'node tests/agent-filter.browser.mjs', 'node experiments/paperclip/verify-agent-topology.mjs',
  ];
  const report = { runId: task.runId, issueId: task.issueId, verdict: 'pass', agentVerdict: 'pass', findings: [], checks: mandatory.map(command => ({ command, status: 'pass' })) };
  assert.equal(validateQAReport(report, task), report);
  assert.throws(() => validateQAReport({ ...report, checks: report.checks.slice(0, -1) }, task), /missing independent checks/);
  assert.throws(() => validateQAReport({ ...report, checks: report.checks.map(check => check.command === mandatory.at(-1) ? { ...check, status: 'fail' } : check) }, task), /contradicts independent checks/);
});

test('navigation-verified QA requires the canonical navigation check and rejects its failure', () => {
  const task = { runId: 'run-navigation', issueId: 'issue-navigation', navigationVerification: true };
  const mandatory = [
    'file tests/agent-filter.test.mjs', 'file tests/agent-filter.browser.mjs', 'npm test',
    'npm run build', 'node tests/agent-filter.browser.mjs', 'node experiments/paperclip/verify-agent-navigation.mjs',
  ];
  const report = { runId: task.runId, issueId: task.issueId, verdict: 'pass', agentVerdict: 'pass', findings: [], checks: mandatory.map(command => ({ command, status: 'pass' })) };
  assert.equal(validateQAReport(report, task), report);
  assert.throws(() => validateQAReport({ ...report, checks: report.checks.slice(0, -1) }, task), /missing independent checks/);
  assert.throws(() => validateQAReport({ ...report, checks: report.checks.map(check => check.command === mandatory.at(-1) ? { ...check, status: 'fail' } : check) }, task), /contradicts independent checks/);
});

test('improvement requires accepted current source and a completed idle acceptance issue', async () => {
  const qaChecks = [
    'file tests/agent-filter.test.mjs', 'file tests/agent-filter.browser.mjs', 'npm test',
    'npm run build', 'node tests/agent-filter.browser.mjs',
  ].map(command => ({ command, status: 'pass' }));
  const digest = 'a'.repeat(64);
  const acceptanceTask = { stage: 'acceptance', issueId: 'issue-acceptance', runId: 'run-acceptance', result: {
    verdict: 'pass', agentVerdict: 'pass', findings: [], checks: qaChecks, runId: 'run-acceptance', issueId: 'issue-acceptance',
  } };
  const reviewTask = { stage: 'delivery-review', issueId: 'issue-delivery-review', runId: 'run-delivery-review', result: {
    verdict: 'pass', accepted: true, reason: 'Native package delivery and online acceptance match.',
    releaseDigest: digest, acceptanceRunId: 'run-acceptance', acceptanceIssueId: 'issue-acceptance',
  } };
  const accepted = { id: 'workflow-parent', complete: true, cursor: 'done', workspace: '/tmp/accepted-workspace', companyId: 'company-parent', caseId: 'case-parent', pipelineId: 'pipeline-parent',
    tasks: [acceptanceTask, reviewTask],
    candidate: { digest, sourceHashes: { 'App.tsx': 'accepted-src-hash', 'server/adapter.mjs': 'ignored-server-hash' } } };
  const calls = [];
  const request = ({ caseStage = 'done', deliveryStatus = 'done' } = {}) => async path => {
    calls.push(path);
    if (path === '/issues/issue-acceptance') return { status: 'done' };
    if (path === '/issues/issue-delivery-review') return { status: deliveryStatus };
    if (path === '/cases/case-parent') return { case: { stageId: `stage-${caseStage}` } };
    if (path === '/pipelines/pipeline-parent') return { stages: [
      { id: 'stage-done', key: 'done', kind: 'done' },
      { id: 'stage-acceptance', key: 'acceptance', kind: 'working' },
    ] };
    if (path === '/companies/company-parent/live-runs') return [];
    throw new Error(`Unexpected request: ${path}`);
  };
  const readFingerprint = async path => {
    assert.ok(path.endsWith('/src'));
    return { 'App.tsx': 'accepted-src-hash' };
  };
  const reason = 'Add a compact export action to the AX dashboard and verify the generated file.';
  assert.equal(await assertImprovementInput(accepted, `  ${reason}  `, { request: request(), readFingerprint }), reason);
  assert.deepEqual(calls, ['/issues/issue-acceptance', '/issues/issue-delivery-review', '/cases/case-parent', '/pipelines/pipeline-parent', '/companies/company-parent/live-runs']);

  const legacyAccepted = { ...accepted, tasks: [acceptanceTask] };
  assert.equal(await assertImprovementInput(legacyAccepted, reason, { request: request(), readFingerprint }), reason, 'legacy accepted workflow without a delivery-review task remains supported');

  await assert.rejects(assertImprovementInput({ ...accepted, complete: false }, reason, { request: request(), readFingerprint }), /Finish acceptance/);
  await assert.rejects(assertImprovementInput({ ...accepted, cursor: 'acceptance' }, reason, { request: request(), readFingerprint }), /Finish acceptance/);
  await assert.rejects(assertImprovementInput({ ...accepted, candidate: { sourceHashes: accepted.candidate.sourceHashes }, tasks: [{ ...acceptanceTask, result: { ...acceptanceTask.result, verdict: 'fail' } }] }, reason, { request: request(), readFingerprint }), /Finish acceptance/);
  await assert.rejects(assertImprovementInput({ ...accepted, tasks: [{ ...acceptanceTask, result: { ...acceptanceTask.result, runId: 'stale-run' } }, reviewTask] }, reason, { request: request(), readFingerprint }), /does not belong/);
  await assert.rejects(assertImprovementInput({ ...accepted, tasks: [{ ...acceptanceTask, result: { ...acceptanceTask.result, verdict: 'pass' } }] }, reason, { request: request(), readFingerprint: async () => ({ 'App.tsx': 'stale-src-hash' }) }), /accepted feature/);
  await assert.rejects(assertImprovementInput(accepted, 'too short', { request: request(), readFingerprint }), /20 to 600 characters/);

  await assert.rejects(assertImprovementInput(accepted, reason, { readFingerprint, request: request({ caseStage: 'acceptance' }) }), /native case is no longer done/);
  await assert.rejects(assertImprovementInput(accepted, reason, { readFingerprint, request: request({ deliveryStatus: 'open' }) }), /delivery review is no longer complete/);
  await assert.rejects(assertImprovementInput({ ...accepted, tasks: [acceptanceTask, { ...reviewTask, result: { ...reviewTask.result, accepted: false } }] }, reason, { readFingerprint, request: request() }), /does not approve the current verified release/);
  await assert.rejects(assertImprovementInput({ ...accepted, tasks: [acceptanceTask, { ...reviewTask, result: { ...reviewTask.result, releaseDigest: 'b'.repeat(64) } }] }, reason, { readFingerprint, request: request() }), /does not approve the current verified release/);
  await assert.rejects(assertImprovementInput(accepted, reason, { readFingerprint, request: async path => path.endsWith('/live-runs') ? [{ status: 'queued' }] : request()(path) }), /still active/);
  await assert.rejects(assertImprovementInput(accepted, reason, { readFingerprint, request: async path => path.endsWith('/live-runs') ? [{ status: 'running' }] : request()(path) }), /still active/);
});

test('first improvement task is blocked by the final review issue, with acceptance fallback for legacy state', async t => {
  const f = await fixture();
  t.after(f.close);
  f.state.parentAcceptanceIssue = 'issue-old-acceptance';
  f.state.parentFinalIssue = 'issue-final-delivery-review';
  const task = await f.workflow.task('requirements');
  const issueCreate = f.calls.find(call => call.path === `/companies/${f.state.companyId}/issues` && call.method === 'POST');
  assert.deepEqual(issueCreate.body.blockedByIssueIds, ['issue-final-delivery-review']);
  assert.equal(task.stage, 'requirements');

  const legacy = await fixture();
  t.after(legacy.close);
  legacy.state.parentAcceptanceIssue = 'issue-old-acceptance';
  const legacyTask = await legacy.workflow.task('requirements');
  const legacyCreate = legacy.calls.find(call => call.path === `/companies/${legacy.state.companyId}/issues` && call.method === 'POST');
  assert.deepEqual(legacyCreate.body.blockedByIssueIds, ['issue-old-acceptance']);
  assert.equal(legacyTask.stage, 'requirements');
});

test('pending transition recovers after API failure while remote remains at the old stage', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'ax-reconcile-before-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const current = state(workspace);
  current.cursor = 'smoke';
  const mock = paperclip(current);
  let transitionCalls = 0;
  let succeededTransitions = 0;
  const request = async (...args) => {
    if (args[0].endsWith('/transition')) {
      transitionCalls++;
      if (transitionCalls === 1) throw new Error('synthetic pre-commit API failure');
      succeededTransitions++;
    }
    return mock.request(...args);
  };
  let persisted = structuredClone(current);
  const save = async value => { persisted = structuredClone(value); };
  const first = new Workflow(current, { request, save });
  await assert.rejects(first.advance({ stage: 'smoke', result: { verdict: 'fail' }, consumed: false }), /pre-commit API failure/);
  assert.equal(persisted.pendingMove.to, 'fix');
  assert.equal(current.cursor, 'smoke');
  const restarted = new Workflow(persisted, { request, save });
  await restarted.reconcile();
  assert.equal(persisted.cursor, 'fix');
  assert.equal(persisted.pendingMove, null);
  assert.equal(transitionCalls, 2);
  assert.equal(succeededTransitions, 1);
});

test('pending transition recovery observes remote target and avoids repeating a committed transition', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'ax-reconcile-after-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const current = state(workspace);
  current.cursor = 'implement';
  const mock = paperclip(current);
  let transitionCalls = 0;
  const request = async (...args) => {
    if (args[0].endsWith('/transition')) transitionCalls++;
    return mock.request(...args);
  };
  let saveCount = 0;
  let persisted = structuredClone(current);
  const save = async value => {
    saveCount++;
    if (saveCount === 2) throw new Error('synthetic post-commit checkpoint failure');
    persisted = structuredClone(value);
  };
  const first = new Workflow(current, { request, save });
  await assert.rejects(first.advance({ stage: 'implement', result: { verdict: 'pass' }, consumed: false }), /post-commit checkpoint failure/);
  assert.equal(current.cursor, 'environment');
  assert.equal(persisted.cursor, 'implement');
  assert.equal(persisted.pendingMove.to, 'environment');
  const restarted = new Workflow(persisted, { request, save: async value => { persisted = structuredClone(value); } });
  await restarted.reconcile();
  assert.equal(persisted.cursor, 'environment');
  assert.equal(persisted.pendingMove, null);
  assert.equal(transitionCalls, 1);
});

test('successful agent run is rejected when its Paperclip issue remains incomplete', async t => {
  const f = await fixture({ completeIssues: false });
  t.after(f.close);
  const task = await f.workflow.task('implement');
  await assert.rejects(f.workflow.execute(task, 'http://127.0.0.1:3200'), /Successful run did not complete its issue/);
  assert.equal(f.state.tasks[0].result, null);
});

test('an existing live run id is polled without waking a duplicate agent run', async t => {
  const f = await fixture();
  t.after(f.close);
  const task = await f.workflow.task('implement');
  f.runs.set('already-live', { statusIndex: 0, issueId: task.issueId, stage: task.stage });
  task.runId = 'already-live';
  const result = await f.workflow.execute(task, 'http://127.0.0.1:3200');
  assert.deepEqual(result, { verdict: 'pass' });
  assert.equal(f.wakeups, 0);
  assert.ok(f.calls.some(call => call.path === '/heartbeat-runs/already-live'));
});

test('skipped wakeup reconciliation keeps old executionRunId out of runId and requires retry', async t => {
  const f = await fixture();
  t.after(f.close);
  const task = await f.workflow.task('implement');
  const receipt = { status: 'skipped', reason: 'execution_reconciliation_required', issueId: task.issueId, executionRunId: 'old-failed-run' };
  const request = f.workflow.request;
  f.workflow.request = async (path, method, body) => {
    if (path.endsWith('/wakeup')) {
      f.calls.push({ path, method, body });
      return receipt;
    }
    return request(path, method, body);
  };
  await assert.rejects(f.workflow.execute(task, 'http://127.0.0.1:3200'), /execution_reconciliation_required/);
  assert.notEqual(task.runId, receipt.executionRunId);
  assert.deepEqual(task.wakeReceipt, receipt);
  assert.deepEqual(f.state.events.at(-1), {
    at: new Date(f.now()).toISOString(), type: 'run-skipped', stage: 'implement', ...receipt,
  });
  assert.ok(!f.calls.some(call => call.path === '/heartbeat-runs/old-failed-run'));
  assert.ok(f.calls.some(call => call.path === `/agents/${task.agentId}` && call.method === 'PATCH' && call.body.runtimeConfig?.heartbeat?.wakeOnDemand === false));
});

test('recovery resumes a response-lost action with the same identity and adopts only its matching native continuation', async () => {
  const actionOutcome = 'not_performed';
  const outcomeEvidence = 'Reviewed the synthetic task and confirmed no changes were applied.';
  const fixture = recoveryFixture({
    loseFirstResolve: true,
    candidates: [
      { runId: 'wrong-agent', agentId: 'unrelated-agent', retryOfRunId: 'run-failed' },
      { runId: 'wrong-parent', agentId: 'agent-dev', retryOfRunId: 'different-run' },
      { runId: 'wrong-context', agentId: 'agent-dev', retryOfRunId: 'run-failed' },
      { runId: 'native-resume', agentId: 'agent-dev', retryOfRunId: 'run-failed' },
    ],
    runs: {
      'wrong-context': { status: 'running', contextSnapshot: { recoveryActionId: 'another-action', previousRunId: 'run-failed' } },
      'native-resume': { status: 'succeeded', contextSnapshot: { recoveryActionId: 'action-1', previousRunId: 'run-failed' } },
    },
  });
  await assert.rejects(fixture.workflow.recover({ actionOutcome, outcomeEvidence }), /response lost/);
  const journal = fixture.persisted.pendingRecovery;
  assert.deepEqual(journal, { actionId: 'action-1', runId: 'run-failed', actionOutcome, evidence: outcomeEvidence });
  const restartedState = fixture.persisted;
  const restarted = new Workflow(restartedState, { request: fixture.workflow.request, save: async value => { fixture.persisted = structuredClone(value); }, now: () => 0, sleep: async () => {} });
  const adopted = await restarted.recover();
  assert.equal(adopted.runId, 'native-resume');
  assert.deepEqual(adopted.runHistory, ['run-failed']);
  assert.equal(restartedState.pendingRecovery, undefined);
  assert.equal(fixture.resolveBodies.length, 2);
  assert.deepEqual(fixture.resolveBodies[0], fixture.resolveBodies[1]);
  assert.equal(fixture.resolveBodies[0].executionReconciliation.providerStopped, true);
  assert.ok(!fixture.calls.some(call => call.path.endsWith('/wakeup')));
  const candidateHeartbeatReads = fixture.calls.filter(call => call.path.startsWith('/heartbeat-runs/')).map(call => call.path);
  assert.deepEqual(candidateHeartbeatReads, ['/heartbeat-runs/run-failed', '/heartbeat-runs/wrong-context', '/heartbeat-runs/native-resume']);
});

test('delivery-review recovery configures the native verifier with the release-review loopback URL', async () => {
  const fixture = recoveryFixture({
    stage: 'delivery-review',
    candidates: [{ runId: 'native-review-resume', agentId: 'agent-product', retryOfRunId: 'run-failed' }],
    runs: { 'native-review-resume': { status: 'succeeded', contextSnapshot: { recoveryActionId: 'action-1', previousRunId: 'run-failed' } } },
  });
  const adopted = await fixture.workflow.recover({ actionOutcome: 'not_performed', outcomeEvidence: 'Reviewed the synthetic release review recovery with no local changes applied.' });
  assert.equal(adopted.runId, 'native-review-resume');
  const configuration = fixture.calls.find(call => call.path === '/agents/agent-product' && call.method === 'PATCH');
  assert.equal(configuration.body.adapterConfig.env.AX_VERIFY_URL, 'http://127.0.0.1:3201');
  assert.ok(!fixture.calls.some(call => call.path.endsWith('/wakeup')));
});

test('recovery rejects blockers with mismatched run or agent identity', async () => {
  for (const blocker of [{ runId: 'untracked-run' }, { agentId: 'unrelated-agent' }]) {
    const fixture = recoveryFixture({ blocker });
    await assert.rejects(fixture.workflow.recover({ actionOutcome: 'not_performed', outcomeEvidence: 'Reviewed synthetic execution evidence.' }), /blocker does not match/);
    assert.ok(!fixture.calls.some(call => call.path.endsWith('/recovery-actions/resolve')));
  }
});

test('recovery refuses an active provider run and preserves its journal when no continuation arrives', async () => {
  const active = recoveryFixture({ previousStatus: 'running' });
  await assert.rejects(active.workflow.recover({ actionOutcome: 'mixed', outcomeEvidence: 'Reviewed synthetic provider process state.' }), /confirmed terminal provider run/);
  assert.ok(!active.calls.some(call => call.path.endsWith('/recovery-actions/resolve')));
  assert.equal(active.current.pendingRecovery, undefined);

  const timedOut = recoveryFixture({ candidates: [] });
  await assert.rejects(timedOut.workflow.recover({ actionOutcome: 'completed', outcomeEvidence: 'Reviewed the completed synthetic recovery action.' }), /not yet delivered/);
  assert.equal(timedOut.current.pendingRecovery.actionId, 'action-1');
  assert.ok(timedOut.persisted.pendingRecovery, 'saved recovery plan remains available after polling timeout');
});

test('run timeout cancels the tracked run using injected clock and sleep', async t => {
  const f = await fixture({ runStatuses: ['running'] });
  t.after(f.close);
  const task = await f.workflow.task('implement');
  await assert.rejects(f.workflow.execute(task, 'http://127.0.0.1:3200'), /Stage execution timed out/);
  assert.ok(f.calls.some(call => call.path === `/heartbeat-runs/${task.runId}/cancel` && call.method === 'POST'));
  assert.equal(f.state.tasks[0].result, null);
});
