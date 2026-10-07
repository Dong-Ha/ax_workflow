import { createHash, randomUUID } from 'node:crypto';
import { access, cp, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readReleaseAssetHashes, verifyReleaseDelivery, verifyReleaseRuntime } from './ax-release-check.mjs';
import { runProcess, shutdownOwnedChildGroups, STAGE_OUTPUTS } from './ax-stage-agent.mjs';
import { startAX, stopOwnedServers } from './ax-local-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const lab = join(root, '.paperclip-lab');
const stateFile = join(lab, 'state-ax.json');
export const definition = JSON.parse(await readFile(new URL('./ax-workflow.json', import.meta.url), 'utf8'));
const version = '2026.1005.0';
const qaStages = new Set(['smoke', 'system', 'acceptance']);
let shutdownRequested = false;
let ownsLock = false;
let ownsWorkflow = false;
const base = new URL(process.env.AX_PAPERCLIP_URL || 'http://127.0.0.1:3100');
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname) || base.username || base.password || base.pathname !== '/') throw new Error('Use a loopback Paperclip URL');
const heartbeat = enabled => ({ heartbeat: { enabled: false, wakeOnDemand: enabled, maxConcurrentRuns: 1 } });
export async function atomicJSON(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}
export async function api(path, method = 'GET', payload) {
  const response = await fetch(new URL(`/api${path}`, base), {
    method, headers: { 'Content-Type': 'application/json', Origin: base.origin },
    body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Paperclip ${method} ${path}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}
export function command(program, args, cwd = root) {
  return runProcess(program, args, { cwd, timeoutMs: 180000 });
}
async function fingerprint(dir, prefix = '') {
  const hashes = {};
  for (const item of (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) Object.assign(hashes, await fingerprint(join(dir, item.name), relative));
    else if (item.isFile()) hashes[relative] = createHash('sha256').update(await readFile(join(dir, item.name))).digest('hex');
    else throw new Error(`Unsupported workspace entry: ${relative}`);
  }
  return hashes;
}
export function nextAfter(stage, flow = definition) {
  const index = flow.stages.findIndex(s => s.key === stage);
  if (index < 0) throw new Error('Unknown workflow stage');
  return flow.stages[index + 1]?.key ?? 'done';
}
const definitionDigest = flow => createHash('sha256').update(JSON.stringify(flow)).digest('hex');
export function releaseAssetBaseline(release) {
  if (!Object.hasOwn(release, 'assetHashes') && !Object.hasOwn(release, 'assetDigest')) return undefined;
  const hashes = release.assetHashes;
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(hashes))) throw new Error('Release asset baseline is malformed');
  const canonical = Object.fromEntries(Object.keys(hashes).sort().map(key => [key, hashes[key]]));
  const digest = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  if (release.assetDigest !== digest) throw new Error('Release asset baseline fingerprint changed');
  return hashes;
}
export function releaseSourceBaseline(release) {
  const sources = release.sourceHashes;
  if (typeof release.workflowId !== 'string' || !release.workflowId
    || !sources || typeof sources !== 'object' || Array.isArray(sources) || !Object.keys(sources).length
    || ![Object.prototype, null].includes(Object.getPrototypeOf(sources))
    || Object.values(sources).some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    || createHash('sha256').update(JSON.stringify(sources)).digest('hex') !== release.digest) throw new Error('Release source fingerprint changed');
  return sources;
}
export async function startVerifiedRelease(release, port, { start = startAX, verifyRuntime = verifyReleaseRuntime } = {}) {
  await verifyRuntime(release.path, releaseSourceBaseline(release));
  return start(release.path, port);
}
export function releaseDeliveryRecord(release, delivery) {
  releaseSourceBaseline(release);
  if (!delivery || delivery.verdict !== 'pass' || delivery.url !== release.url
    || !Array.isArray(delivery.checks) || !delivery.checks.length
    || delivery.checks.some(check => check.status !== 'pass' || typeof check.asset !== 'string' || !check.asset || !/^[a-f0-9]{64}$/.test(check.sha256 ?? ''))
    || new Set(delivery.checks.map(check => check.asset)).size !== delivery.checks.length) throw new Error('Release delivery evidence is invalid');
  const observed = Object.fromEntries([...delivery.checks].sort((a, b) => a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0).map(check => [check.asset, check.sha256]));
  const assetDigest = createHash('sha256').update(JSON.stringify(observed)).digest('hex');
  const baseline = releaseAssetBaseline(release);
  if (baseline && assetDigest !== release.assetDigest) throw new Error('Delivered assets differ from the recorded package');
  return { ...delivery, workflowId: release.workflowId, releaseDigest: release.digest, assetDigest,
    assetBaseline: baseline ? 'packaging-time' : 'verification-time', verifiedAt: new Date().toISOString() };
}
export async function persistDeliveryEvidence(state, delivery, { request = api, save = value => atomicJSON(stateFile, value) } = {}) {
  const record = releaseDeliveryRecord(state.candidate, delivery);
  const file = join(state.workspace, 'workflow-artifacts/release-delivery.json');
  let previous;
  try { previous = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { verifiedAt: nextTime, ...nextSemantic } = record;
  const { verifiedAt: previousTime, ...previousSemantic } = previous ?? {};
  const reuse = Number.isFinite(Date.parse(previousTime ?? '')) && isDeepStrictEqual(previousSemantic, nextSemantic);
  if (!reuse) {
    const active = await request(`/companies/${state.companyId}/live-runs`);
    if (active.some(run => ['queued', 'running'].includes(run.status))) throw new Error('Cannot change protected delivery evidence while an agent is active');
    await atomicJSON(file, record);
  }
  state.events.push({ at: nextTime, type: 'release-delivery-verified', releaseDigest: record.releaseDigest,
    assetDigest: record.assetDigest, assetBaseline: record.assetBaseline, reusedEvidence: reuse });
  await save(state);
  return reuse ? previous : record;
}
export function validateWorkflowDefinition(flow, pipeline, state = null) {
  if (flow?.schemaVersion !== 1 || !Array.isArray(flow.stages) || !flow.stages.length || !Array.isArray(flow.teams)
    || flow.rework?.key !== 'fix' || !Number.isSafeInteger(flow.rework.maxAttempts) || flow.rework.maxAttempts < 1) throw new Error('Unsupported workflow definition snapshot');
  const teams = new Set(flow.teams.map(team => team.key));
  const keys = flow.stages.map(stage => stage.key);
  if (teams.size !== flow.teams.length || new Set(keys).size !== keys.length || keys.some(key => !STAGE_OUTPUTS[key] || ['fix', 'done', 'cancelled'].includes(key))
    || [...flow.stages, flow.rework].some(stage => !teams.has(stage.team))) throw new Error('Invalid workflow definition stages or teams');
  const expected = [...keys, 'fix', 'done', 'cancelled'];
  const native = pipeline?.stages;
  if (!Array.isArray(native) || native.length !== expected.length || new Set(native.map(stage => stage.key)).size !== native.length
    || native.some(stage => !expected.includes(stage.key) || !Number.isFinite(stage.position))
    || !native.some(stage => stage.key === 'fix' && stage.kind === 'working')
    || !native.some(stage => stage.key === 'done' && stage.kind === 'done')
    || !native.some(stage => stage.key === 'cancelled' && stage.kind === 'cancelled')) throw new Error('Native pipeline differs from the pinned workflow');
  const ordered = native.filter(stage => stage.kind === 'working' && stage.key !== 'fix').sort((a, b) => a.position - b.position).map(stage => stage.key);
  if (JSON.stringify(ordered) !== JSON.stringify(keys)) throw new Error('Native stage order differs from the pinned workflow');
  const referenced = state ? [state.cursor, ...state.tasks.map(task => task.stage), state.retryStage, state.pendingTask?.stage, state.pendingMove?.from, state.pendingMove?.to].filter(Boolean) : [];
  if (referenced.some(key => !expected.includes(key))) throw new Error('Saved execution references an unregistered stage');
  return flow;
}
export async function hydrateWorkflowDefinition(state, { request = api, save = value => atomicJSON(stateFile, value), readDefinition = async file => JSON.parse(await readFile(file, 'utf8')) } = {}) {
  const pipeline = await request(`/pipelines/${state.pipelineId}`);
  if (state.workflowDefinition) {
    if (state.workflowDefinitionDigest !== definitionDigest(state.workflowDefinition)) throw new Error('Workflow definition snapshot fingerprint changed');
    validateWorkflowDefinition(state.workflowDefinition, pipeline, state);
    return state.workflowDefinition;
  }
  const historical = await readDefinition(join(state.workspace, 'experiments/paperclip/ax-workflow.json'));
  validateWorkflowDefinition(historical, pipeline, state);
  state.workflowDefinition = structuredClone(historical);
  state.workflowDefinitionDigest = definitionDigest(historical);
  state.events.push({ at: new Date().toISOString(), type: 'workflow-definition-restored', source: 'isolated-workspace-copy', digest: state.workflowDefinitionDigest });
  await save(state);
  return state.workflowDefinition;
}
export function validateQAReport(report, task) {
  if (!report || report.runId !== task.runId || report.issueId !== task.issueId) throw new Error('QA report does not belong to this task run');
  const mandatory = ['file tests/agent-filter.test.mjs', 'file tests/agent-filter.browser.mjs', 'npm test', 'npm run build', 'node tests/agent-filter.browser.mjs'];
  if (task.graphVerification) mandatory.push('node experiments/paperclip/verify-agent-filter.mjs');
  if (task.topologyVerification) mandatory.push('node experiments/paperclip/verify-agent-topology.mjs');
  if (task.navigationVerification) mandatory.push('node experiments/paperclip/verify-agent-navigation.mjs');
  if (!Array.isArray(report.checks) || mandatory.some(command => !report.checks.some(check => check.command === command))) throw new Error('QA report is missing independent checks');
  if (!Array.isArray(report.findings) || report.findings.some(f => typeof f !== 'string') || !['pass', 'fail'].includes(report.agentVerdict) || !['pass', 'fail'].includes(report.verdict)) throw new Error('Invalid stage verdict');
  const passed = report.agentVerdict === 'pass' && report.findings.length === 0 && report.checks.every(check => check.status === 'pass');
  if ((report.verdict === 'pass') !== passed) throw new Error('QA verdict contradicts independent checks');
  return report;
}
export function validateDeliveryReview(report, state) {
  const acceptance = state.tasks.findLast(task => task.stage === 'acceptance');
  const keys = ['accepted', 'reason', 'releaseDigest', 'acceptanceRunId', 'acceptanceIssueId'];
  if (!acceptance || acceptance.result?.verdict !== 'pass' || !/^[a-f0-9]{64}$/.test(state.candidate?.digest ?? '')) throw new Error('Delivery review requires an accepted QA result and release candidate');
  validateQAReport(acceptance.result, acceptance);
  if (!report || typeof report !== 'object' || Array.isArray(report) || Object.keys(report).length !== keys.length || Object.keys(report).some(key => !keys.includes(key))
    || report.accepted !== true || typeof report.reason !== 'string' || !report.reason.trim() || report.reason.length > 1000
    || report.releaseDigest !== state.candidate.digest || report.acceptanceRunId !== acceptance.runId || report.acceptanceIssueId !== acceptance.issueId) throw new Error('Delivery review does not approve the current verified release');
  return { verdict: 'pass', ...report };
}
export async function assertImprovementInput(parent, reason, { request = api, readFingerprint = fingerprint } = {}) {
  if (typeof reason !== 'string' || reason.trim().length < 20 || reason.length > 600) throw new Error('Improvement requires 20 to 600 characters of concrete feedback');
  const acceptance = parent?.tasks?.findLast(t => t.stage === 'acceptance');
  if (parent?.complete !== true || parent.cursor !== 'done' || acceptance?.result?.verdict !== 'pass' || !parent.candidate?.sourceHashes) throw new Error('Finish acceptance before starting an improvement');
  const expected = Object.fromEntries(Object.entries(parent.candidate.sourceHashes).filter(([file]) => !file.startsWith('server/')));
  if (!Object.keys(expected).length || JSON.stringify(await readFingerprint(join(root, 'src'))) !== JSON.stringify(expected) || JSON.stringify(await readFingerprint(join(parent.workspace, 'src'))) !== JSON.stringify(expected)) throw new Error('Apply the accepted feature and review other source changes before improving it');
  if ((await request(`/issues/${acceptance.issueId}`)).status !== 'done') throw new Error('The previous acceptance issue is no longer complete');
  const finalTask = parent.tasks.at(-1);
  if (finalTask.stage === 'delivery-review') {
    validateDeliveryReview(Object.fromEntries(['accepted', 'reason', 'releaseDigest', 'acceptanceRunId', 'acceptanceIssueId'].map(key => [key, finalTask.result?.[key]])), parent);
    if ((await request(`/issues/${finalTask.issueId}`)).status !== 'done') throw new Error('The previous delivery review is no longer complete');
  }
  const detail = await request(`/cases/${parent.caseId}`);
  const pipeline = await request(`/pipelines/${parent.pipelineId}`);
  if (!pipeline.stages?.some(stage => stage.id === detail.case?.stageId && stage.key === 'done' && stage.kind === 'done')) throw new Error('The previous native case is no longer done');
  if ((await request(`/companies/${parent.companyId}/live-runs`)).some(r => ['queued', 'running'].includes(r.status))) throw new Error('An agent run is still active');
  return reason.trim();
}
export function transitions() {
  return [...definition.stages.flatMap(stage => [
    { fromStageKey: stage.key, toStageKey: nextAfter(stage.key) },
    { fromStageKey: stage.key, toStageKey: 'cancelled' },
    ...(qaStages.has(stage.key) ? [{ fromStageKey: stage.key, toStageKey: 'fix' }] : []),
  ]), ...['smoke', 'system', 'cancelled'].map(key => ({ fromStageKey: 'fix', toStageKey: key }))];
}
async function health() {
  const result = await api('/health');
  if (result.version !== version || result.deploymentMode !== 'local_trusted') throw new Error(`Expected local_trusted Paperclip ${version}`);
}
async function seed(fresh, followup = null) {
  await health();
  if (!fresh) {
    try { return JSON.parse(await readFile(stateFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const suffix = Date.now().toString(36);
  const workspace = join(lab, 'workspaces', `ax-${suffix}`);
  await mkdir(workspace, { recursive: true });
  // Only project files are copied. No Git metadata, local records, or credentials.
  for (const file of ['src', 'server', 'tests', 'experiments', 'node_modules', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'README.md']) await cp(join(root, file), join(workspace, file), { recursive: true });
  await writeFile(join(workspace, 'AGENTS.md'), [
    '# Isolated AX workflow workspace',
    'Work only in this directory. Do not read parent directories, credentials, or conversation records. Do not make network requests, commit, push, or invoke Paperclip.',
    'Use existing installed dependencies. Do not run npm install. Only implement the assigned stage and write its permitted outputs.',
    'Do not edit server adapters, authentication, original records, or server API behavior. Preserve all project isolation/privacy invariants.',
    'QA owns tests and must report defects without fixing product code. Development owns fixes. Do not weaken tests to obtain passing results.',
    'Use workflow-artifacts for specifications and reports. Reports contain findings and outcomes, never private reasoning or raw command output.',
  ].join('\n'));
  await mkdir(join(workspace, 'workflow-artifacts'), { recursive: true });
  if (followup) {
    const inherited = new Set(Object.values(STAGE_OUTPUTS).flat().filter(file => file.startsWith('workflow-artifacts/')).map(file => file.slice('workflow-artifacts/'.length)));
    inherited.add('requirements-amendment.md');
    for (const name of inherited) {
      try { await cp(join(followup.parent.workspace, 'workflow-artifacts', name), join(workspace, 'workflow-artifacts', name)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await writeFile(join(workspace, 'workflow-artifacts/improvement-request.md'), `# Accepted feature improvement\n\nParent workflow: ${followup.parent.id}\nParent case: ${followup.parent.caseId}\n\n${followup.reason}\n\nPreserve all accepted functional and privacy behavior. Development edits product source only. QA independently verifies the existing tests, build, browser scenarios and deterministic graph comparisons.\n`);
    await atomicJSON(join(lab, `state-ax-${followup.parent.id}.json`), followup.parent);
  }
  const sourceBaseline = await fingerprint(join(root, 'src'));
  await api('/instance/settings/experimental', 'PATCH', { enablePipelines: true });
  const company = followup ? await api(`/companies/${followup.parent.companyId}`) : await api('/companies', 'POST', { name: `${definition.name} · ${suffix}`, description: definition.description });
  if (!followup) await api(`/companies/${company.id}`, 'PATCH', { requireBoardApprovalForNewAgents: false });
  const project = await api(`/companies/${company.id}/projects`, 'POST', {
    name: followup ? `${definition.project} · 개선 ${suffix}` : definition.project, description: definition.description, status: 'in_progress',
    workspace: { name: 'AX 기능 개발 복사본', sourceType: 'non_git_path', cwd: workspace, isPrimary: true },
  });
  const agents = followup ? { ...followup.parent.agents } : {};
  for (const team of followup ? [] : definition.teams) {
    const agent = await api(`/companies/${company.id}/agents`, 'POST', {
      name: team.name, role: team.role, title: `${team.name} · AX 기능 개발`,
      reportsTo: team.key === 'product' ? null : agents.product,
      adapterType: 'process', capabilities: 'AX 검색·상태 필터 개발. 실제 Codex CLI를 단계별 호출합니다.',
      adapterConfig: { command: process.execPath, args: [], cwd: workspace, timeoutSec: 900 },
      runtimeConfig: heartbeat(false), permissions: { canCreateAgents: false, canCreateSkills: false },
    });
    agents[team.key] = agent.id;
  }
  const stages = [...definition.stages, { ...definition.rework, phase: '결함 재작업' }];
  const pipeline = await api(`/companies/${company.id}/pipelines`, 'POST', {
    key: `ax-lifecycle-${suffix}`, name: followup ? '승인된 AX 개선 → 재검증 · 승인 · 로컬 출시' : '제품 → 개발 → 시스템 테스트 → 온라인', projectId: project.id, description: definition.description,
    stages: [...stages.map((s, i) => ({ key: s.key, name: `${s.phase} · ${s.name}`, kind: 'working', position: (i + 1) * 100 })),
      { key: 'done', name: '검증된 로컬 출시', kind: 'done', position: (stages.length + 1) * 100 }, { key: 'cancelled', name: '중단', kind: 'cancelled', position: (stages.length + 2) * 100 }],
  });
  await api(`/pipelines/${pipeline.id}/transitions`, 'PUT', { enforceTransitions: true, transitions: transitions() });
  const ingest = await api(`/pipelines/${pipeline.id}/cases`, 'POST', {
    caseKey: `ax-filter-${suffix}`, title: definition.project, stageKey: followup ? 'fix' : 'requirements', summary: followup?.reason ?? definition.description,
    fields: { sourceImage: '66da67ff4a9a5e711d0287b9.png', teams: definition.teams.map(t => t.name), mode: 'codex', ...(followup ? {parentWorkflowId: followup.parent.id, parentCaseId: followup.parent.caseId} : {}) },
  });
  const state = { schemaVersion: 1, id: suffix, version, companyId: company.id, projectId: project.id, pipelineId: pipeline.id, caseId: ingest.case.id,
    workflowDefinition: structuredClone(definition), workflowDefinitionDigest: definitionDigest(definition),
    workspace, sourceBaseline, agents, tasks: [], cursor: followup ? 'fix' : 'requirements', retryStage: followup ? 'system' : null, attempts: {}, events: [], createdAt: new Date().toISOString(), complete: false,
    ...(followup ? { parentWorkflowId: followup.parent.id, parentCaseId: followup.parent.caseId, parentAcceptanceIssue: followup.parent.tasks.findLast(t => t.stage === 'acceptance').issueId, parentFinalIssue: followup.parent.tasks.at(-1).issueId, reviewReason: followup.reason, topologyVerification: !!followup.topologyVerification, navigationVerification: !!followup.navigationVerification } : {}) };
  await atomicJSON(stateFile, state);
  console.log(`AX workflow prepared: ${base.origin} · ${company.name}`);
  return state;
}

export function trackedTasks(state) { return [...state.tasks, ...(state.supplementalTasks ?? [])]; }
export function activeWorkflowTask(state) {
  return trackedTasks(state).find(task => task.issueId === (state.activeSupplementalTaskId ?? state.pendingRecovery?.taskIssueId)) ?? state.tasks.at(-1);
}
export class Workflow {
  constructor(state, { request = api, save = s => atomicJSON(stateFile, s), sleep = ms => new Promise(ok => setTimeout(ok, ms)), now = Date.now } = {}) {
    this.state = state; this.request = request; this.save = save; this.sleep = sleep; this.now = now;
    this.definition = state.workflowDefinition ?? definition;
    this.pipelineKeys = [...this.definition.stages.map(stage => stage.key), 'fix', 'done', 'cancelled'];
  }
  async checkpoint(type, fields = {}) {
    this.state.events.push({ at: new Date(this.now()).toISOString(), type, ...fields });
    await this.save(this.state);
  }
  async move(to, reason) {
    if (!this.pipelineKeys.includes(to)) throw new Error('Invalid pipeline destination');
    if (this.state.pendingMove && this.state.pendingMove.to !== to) throw new Error('A different transition is pending');
    if (!this.state.pendingMove) {
      this.state.pendingMove = { from: this.state.cursor, to, reason };
      await this.checkpoint('transition-planned', { to, reason });
    }
    const detail = await this.request(`/cases/${this.state.caseId}`);
    const pipeline = await this.request(`/pipelines/${this.state.pipelineId}`);
    const current = pipeline.stages.find(s => s.id === detail.case.stageId)?.key;
    if (current === 'cancelled') throw new Error('Workflow was cancelled');
    if (![this.state.pendingMove.from, to].includes(current)) throw new Error('Pipeline changed outside this controller; reconcile before continuing');
    if (current !== to) await this.request(`/cases/${this.state.caseId}/transition`, 'POST', { toStageKey: to, expectedVersion: detail.case.version, reason });
    this.state.cursor = to;
    this.state.pendingMove = null;
    await this.checkpoint('transition', { to, reason });
  }
  async reconcile() {
    if (this.state.pendingMove) return this.move(this.state.pendingMove.to, this.state.pendingMove.reason);
    const detail = await this.request(`/cases/${this.state.caseId}`);
    const pipeline = await this.request(`/pipelines/${this.state.pipelineId}`);
    const key = pipeline.stages.find(s => s.id === detail.case.stageId)?.key;
    if (key !== this.state.cursor) throw new Error('Pipeline changed outside this controller; reconcile before continuing');
  }
  async task(stageKey) {
    const state = this.state;
    if (state.pendingMove) throw new Error('Recover the pending transition before creating a task');
    const previous = state.tasks.at(-1);
    if (previous?.stage === stageKey && !previous.consumed) {
      if (!previous.linked) {
        const detail = await this.request(`/cases/${state.caseId}`);
        if (!detail.links?.some(link => link.issueId === previous.issueId && !link.retiredAt)) await this.request(`/cases/${state.caseId}/issue-links`, 'POST', { issueId: previous.issueId, role: 'work' });
        previous.linked = true;
        await this.checkpoint('task-linked', { issueId: previous.issueId });
      }
      return previous;
    }
    const stage = stageKey === 'fix' ? this.definition.rework : this.definition.stages.find(s => s.key === stageKey);
    if (!stage) throw new Error('Unknown task stage');
    if (state.pendingTask && state.pendingTask.stage !== stageKey) throw new Error('Recover the pending task creation first');
    if (!state.pendingTask) {
      state.pendingTask = { stage: stageKey, payload: {
      title: `${stage.phase ?? '결함 수정'} · ${stage.name}`, projectId: state.projectId, assigneeAgentId: state.agents[stage.team], status: 'todo', priority: 'medium',
      description: `${this.definition.description}\n현재 단계: ${stageKey}. 이전 산출물은 workflow-artifacts에서 확인합니다.${stageKey === 'fix' ? `\n실패 단계: ${state.retryStage}. 해당 QA 보고의 결함을 수정하고 테스트 기대값을 약화하지 마세요.${state.reviewReason ? `\n추가 코드 검토 요청: ${state.reviewReason}` : ''}` : ''}`,
      blockedByIssueIds: previous ? [previous.issueId] : state.parentFinalIssue ? [state.parentFinalIssue] : state.parentAcceptanceIssue ? [state.parentAcceptanceIssue] : [],
      idempotencyKey: `ax-${state.caseId}-${randomUUID()}`, allowDuplicate: true,
      } };
      await this.checkpoint('task-planned', { stage: stageKey, requestKey: state.pendingTask.payload.idempotencyKey });
    }
    const issue = await this.request(`/companies/${state.companyId}/issues`, 'POST', state.pendingTask.payload);
    const task = { stage: stageKey, issueId: issue.id, identifier: issue.identifier, agentId: state.agents[stage.team], consumed: false,
      wakeKey: `${state.caseId}-${stageKey}-${issue.id}`, result: null, runId: null, graphVerification: !!state.parentWorkflowId, topologyVerification: !!state.topologyVerification, navigationVerification: !!state.navigationVerification };
    state.tasks.push(task);
    state.pendingTask = null;
    if (stageKey === 'fix') delete state.reviewReason;
    await this.checkpoint('task-created', { stage: stageKey, issueId: issue.id });
    await this.request(`/cases/${state.caseId}/issue-links`, 'POST', { issueId: issue.id, role: 'work' });
    task.linked = true;
    await this.checkpoint('task-linked', { issueId: issue.id });
    return task;
  }
  async requestRevision(reason) {
    const task = this.state.tasks.at(-1);
    if (this.state.cursor !== 'fix' || task?.stage !== 'fix' || task.consumed) throw new Error('Code review revision requires an unfinished fix stage');
    if (typeof reason !== 'string' || reason.trim().length < 20 || reason.length > 600) throw new Error('Code review requires 20 to 600 characters of concrete feedback');
    if (!task.runId || (await this.request(`/heartbeat-runs/${task.runId}`)).status !== 'succeeded') throw new Error('Review the completed development execution before requesting a revision');
    await this.execute(task, 'http://127.0.0.1:3200');
    task.consumed = true;
    this.state.reviewReason = reason.trim();
    await this.checkpoint('code-review-revision', { stage: task.stage, issueId: task.issueId, reason: this.state.reviewReason });
  }
  async configure(task, verifyUrl) {
    await this.request(`/agents/${task.agentId}`, 'PATCH', {
      adapterConfig: { command: process.execPath, args: [join(root, 'experiments/paperclip/ax-stage-agent.mjs'), '--stage', task.stage, '--workspace', this.state.workspace, '--issue', task.issueId], cwd: this.state.workspace,
        timeoutSec: 900, env: { AX_VERIFY_URL: verifyUrl, AX_VERIFY_FILTER_GRAPH: this.state.parentWorkflowId ? '1' : '0', AX_VERIFY_TOPOLOGY: this.state.topologyVerification ? '1' : '0', AX_VERIFY_NAVIGATION: this.state.navigationVerification ? '1' : '0' } }, runtimeConfig: heartbeat(true),
    });
  }
  async approvalRevalidation(reason) {
    const state = this.state;
    const approval = state.tasks.at(-1);
    const qaAgent = state.agents[this.definition.stages.find(stage => stage.key === 'system')?.team];
    if (!qaAgent) throw new Error('Pinned system team has no assigned agent');
    if (state.cursor !== 'approval' || approval?.stage !== 'approval' || approval.consumed || state.pendingMove || state.pendingTask || state.pendingRecovery) throw new Error('Approval revalidation requires an unfinished paused approval');
    if (typeof reason !== 'string' || reason.trim().length < 20 || reason.length > 600) throw new Error('Revalidation requires 20 to 600 characters of reviewed scope');
    const issue = await this.request(`/issues/${approval.issueId}`);
    const run = await this.request(`/heartbeat-runs/${approval.runId}`);
    if (!['failed', 'cancelled', 'timed_out', 'interrupted'].includes(run.status) || issue.executionBlocker?.runId !== approval.runId || issue.executionBlocker?.agentId !== approval.agentId) throw new Error('Approval execution must be terminal and require reconciliation');
    const prior = state.tasks.findLast(task => task.stage === 'system' && task.result?.verdict === 'pass');
    if (!prior || (await this.request(`/issues/${prior.issueId}`)).status !== 'done' || (await this.request(`/heartbeat-runs/${prior.runId}`)).status !== 'succeeded') throw new Error('Revalidation requires a completed successful system anchor');
    state.supplementalTasks ??= [];
    let task = state.supplementalTasks.findLast(task => task.approvalIssueId === approval.issueId);
    const live = await this.request(`/companies/${state.companyId}/live-runs`);
    if (live.some(run => ['queued', 'running'].includes(run.status) && run.id !== task?.runId)) throw new Error('An untracked execution is active');
    if (!task) {
      state.pendingSupplementalTask ??= { approvalIssueId: approval.issueId, payload: {
        title: '승인 보류 범위 · 시스템 QA 재검증', projectId: state.projectId, assigneeAgentId: qaAgent,
        status: 'todo', priority: 'medium', blockedByIssueIds: [prior.issueId], allowDuplicate: true,
        idempotencyKey: `ax-revalidation-${state.caseId}-${randomUUID()}`,
        description: `현재 단계: system. 승인 작업 ${approval.identifier}의 보류 범위를 실제로 재검증합니다. ${reason.trim()}\n제품 및 테스트 기대값은 바꾸지 말고 현재 검증기와 필수 검사를 독립 실행합니다. 이전 verified 보고서는 보존합니다.`,
      } };
      if (state.pendingSupplementalTask.approvalIssueId !== approval.issueId) throw new Error('A different supplemental task is pending');
      await this.checkpoint('approval-revalidation-planned', { approvalIssueId: approval.issueId, requestKey: state.pendingSupplementalTask.payload.idempotencyKey });
      const created = await this.request(`/companies/${state.companyId}/issues`, 'POST', state.pendingSupplementalTask.payload);
      task = { stage: 'system', purpose: 'approval-revalidation', approvalIssueId: approval.issueId, supersedesIssueId: prior.issueId,
        issueId: created.id, identifier: created.identifier, agentId: qaAgent, consumed: false, result: null, runId: null,
        wakeKey: `${state.caseId}-revalidation-${created.id}`, graphVerification: !!state.parentWorkflowId,
        topologyVerification: !!state.topologyVerification, navigationVerification: !!state.navigationVerification, reason: reason.trim() };
      state.supplementalTasks.push(task); delete state.pendingSupplementalTask;
      await this.checkpoint('approval-revalidation-created', { issueId: task.issueId, approvalIssueId: approval.issueId });
    }
    if (!task.linked) {
      const detail = await this.request(`/cases/${state.caseId}`);
      if (!detail.links?.some(link => link.issueId === task.issueId && !link.retiredAt)) await this.request(`/cases/${state.caseId}/issue-links`, 'POST', { issueId: task.issueId, role: 'work' });
      task.linked = true; await this.checkpoint('approval-revalidation-linked', { issueId: task.issueId });
    }
    const dependencies = [...new Set([...(issue.blockedBy ?? []).map(dependency => dependency.id), prior.issueId, task.issueId])];
    await this.request(`/issues/${approval.issueId}`, 'PATCH', { blockedByIssueIds: dependencies });
    const refreshed = await this.request(`/issues/${approval.issueId}`);
    if (refreshed.executionBlocker?.recoveryActionId !== issue.executionBlocker?.recoveryActionId || !refreshed.blockedBy?.some(dependency => dependency.id === task.issueId)) throw new Error('Native approval dependency or recovery action changed');
    state.activeSupplementalTaskId = task.issueId;
    await this.checkpoint('approval-revalidation-ready', { issueId: task.issueId, approvalIssueId: approval.issueId });
    return task;
  }
  async verifyApprovalRevalidation(approval) {
    const task = this.state.supplementalTasks?.findLast(task => task.approvalIssueId === approval.issueId);
    if (!task) return;
    if (!task.consumed || !task.runId || validateQAReport(task.result, task).verdict !== 'pass'
      || (await this.request(`/heartbeat-runs/${task.runId}`)).status !== 'succeeded'
      || (await this.request(`/issues/${task.issueId}`)).status !== 'done') throw new Error('Approval revalidation must pass with completed native provenance');
    const current = validateQAReport(JSON.parse(await readFile(join(this.state.workspace, 'workflow-artifacts/system.json'), 'utf8')), task);
    if (current.verdict !== 'pass' || !isDeepStrictEqual(current, task.result)) throw new Error('Current system report differs from verified approval revalidation');
  }
  async recover({ actionOutcome, outcomeEvidence, supplemental = false } = {}) {
    if (shutdownRequested) throw new Error('Controller is stopping');
    const task = this.state.pendingRecovery?.taskIssueId
      ? trackedTasks(this.state).find(task => task.issueId === this.state.pendingRecovery.taskIssueId)
      : supplemental ? this.state.supplementalTasks?.at(-1) : this.state.tasks.at(-1);
    if (!task || task.consumed) throw new Error('No unfinished task to recover');
    if (task.stage === 'approval') await this.verifyApprovalRevalidation(task);
    if (!this.state.pendingRecovery) {
      if (!['not_performed', 'completed', 'mixed'].includes(actionOutcome) || typeof outcomeEvidence !== 'string' || outcomeEvidence.trim().length < 20) throw new Error('Recovery requires a reviewed action outcome and at least 20 characters of evidence');
      const issue = await this.request(`/issues/${task.issueId}`);
      const blocker = issue.executionBlocker;
      const previousRun = task.runId ?? task.runHistory?.at(-1);
      if (!blocker?.recoveryActionId || blocker.runId !== previousRun || blocker.agentId !== task.agentId) throw new Error('Recovery blocker does not match the tracked failed execution');
      const run = await this.request(`/heartbeat-runs/${previousRun}`);
      if (!['failed', 'cancelled', 'timed_out', 'interrupted'].includes(run.status)) throw new Error('Recovery requires a confirmed terminal provider run');
      this.state.pendingRecovery = { actionId: blocker.recoveryActionId, runId: previousRun, actionOutcome, evidence: outcomeEvidence.trim(), ...(supplemental ? { taskIssueId: task.issueId } : {}) };
      await this.checkpoint('recovery-planned', { stage: task.stage, actionId: blocker.recoveryActionId, previousRunId: previousRun, actionOutcome });
    }
    const planned = this.state.pendingRecovery;
    await this.configure(task, ['acceptance', 'delivery-review'].includes(task.stage) ? 'http://127.0.0.1:3201' : 'http://127.0.0.1:3200');
    // Paperclip verifies stopped processes and released execution authority itself.
    // Its dispatcher owns the continuation; never replace this with a generic wake.
    await this.request(`/issues/${task.issueId}/recovery-actions/resolve`, 'POST', {
      actionId: planned.actionId, outcome: 'restored', sourceIssueStatus: 'todo',
      resolutionNote: 'Reviewed execution outcomes; resume the assigned stage.',
      executionReconciliation: { runId: planned.runId, providerStopped: true, actionOutcome: planned.actionOutcome, outcomeEvidence: planned.evidence },
    });
    const deadline = this.now() + 30000;
    while (this.now() < deadline) {
      if (shutdownRequested) throw new Error('Controller is stopping');
      const candidates = await this.request(`/issues/${task.issueId}/runs`);
      for (const candidate of candidates.filter(run => run.agentId === task.agentId && run.retryOfRunId === planned.runId)) {
        const run = await this.request(`/heartbeat-runs/${candidate.runId}`);
        if (run.contextSnapshot?.recoveryActionId !== planned.actionId || run.contextSnapshot?.previousRunId !== planned.runId) continue;
        task.runHistory = [...new Set([...(task.runHistory ?? []), planned.runId])];
        task.runId = candidate.runId;
        task.result = null;
        delete task.wakeReceipt;
        delete this.state.pendingRecovery;
        await this.checkpoint('execution-reconciled', { stage: task.stage, runId: task.runId, previousRunId: planned.runId, actionId: planned.actionId, actionOutcome: planned.actionOutcome });
        return task;
      }
      await this.sleep(1000);
    }
    throw new Error('Recovery continuation not yet delivered; run again to resume the saved recovery');
  }
  async execute(task, verifyUrl) {
    if (shutdownRequested) throw new Error('Controller is stopping');
    const request = this.request;
    const issue = await request(`/issues/${task.issueId}`);
    if (task.result && issue.status === 'done') return task.result;
    await this.configure(task, verifyUrl);
    try {
      if (!task.runId) {
        const wake = await request(`/agents/${task.agentId}/wakeup`, 'POST', {
          source: 'on_demand', triggerDetail: 'manual', reason: `AX lifecycle: ${task.stage}`, payload: { issueId: task.issueId }, idempotencyKey: task.wakeKey,
        });
        task.runId = wake.id ?? wake.run?.id;
        if (!task.runId) {
          task.wakeReceipt = Object.fromEntries(['status', 'reason', 'issueId', 'executionRunId'].map(key => [key, wake[key] ?? null]));
          await this.checkpoint('run-skipped', { stage: task.stage, ...task.wakeReceipt });
          throw new Error(`Wakeup did not return a run (${wake.reason ?? 'unknown'})`);
        }
        delete task.wakeReceipt;
        await this.checkpoint('run-started', { stage: task.stage, runId: task.runId });
      }
      console.log(`Running ${task.stage} · ${task.identifier}`);
      const deadline = this.now() + 960000;
      let ended;
      while (this.now() < deadline) {
        if (shutdownRequested) throw new Error('Controller is stopping');
        const run = await request(`/heartbeat-runs/${task.runId}`);
        if (run.status === 'succeeded') { ended = run; break; }
        if (!['queued', 'running'].includes(run.status)) throw new Error(`Stage ${task.stage} run ended: ${run.status}`);
        await this.sleep(1000);
      }
      if (!ended) { await request(`/heartbeat-runs/${task.runId}/cancel`, 'POST', {}); throw new Error('Stage execution timed out'); }
      if ((await request(`/issues/${task.issueId}`)).status !== 'done') throw new Error('Successful run did not complete its issue');
      if (qaStages.has(task.stage)) task.result = validateQAReport(JSON.parse(await readFile(join(this.state.workspace, 'workflow-artifacts', `${task.stage}.json`), 'utf8')), task);
      else if (task.stage === 'delivery-review') task.result = validateDeliveryReview(JSON.parse(await readFile(join(this.state.workspace, 'workflow-artifacts/delivery-review.json'), 'utf8')), this.state);
      else task.result = { verdict: 'pass' };
      if (!['pass', 'fail'].includes(task.result.verdict)) throw new Error('Invalid stage verdict');
      await atomicJSON(join(this.state.workspace, 'workflow-artifacts', `verified-${task.identifier}.json`), { stage: task.stage, issueId: task.issueId, runId: task.runId, ...task.result });
      await this.checkpoint('run-verified', { stage: task.stage, runId: task.runId, verdict: task.result.verdict });
      return task.result;
    } finally { await request(`/agents/${task.agentId}`, 'PATCH', { runtimeConfig: heartbeat(false) }); }
  }
  async advance(task) {
    const state = this.state;
    if (task.result?.verdict === 'fail') {
      if (!qaStages.has(task.stage)) throw new Error('Only QA may request a defect repair');
      state.attempts[task.stage] = (state.attempts[task.stage] ?? 0) + 1;
      state.retryStage = task.stage === 'acceptance' ? 'system' : task.stage;
      state.candidate = null;
      task.consumed = true;
      if (state.attempts[task.stage] > this.definition.rework.maxAttempts) state.stopReason = 'rework-limit';
      await this.checkpoint('defect-found', { stage: task.stage, attempt: state.attempts[task.stage] });
      if (state.attempts[task.stage] > this.definition.rework.maxAttempts) throw new Error('Rework limit reached; workflow remains incomplete');
      await this.move('fix', `QA ${task.stage}: repair required`);
      return;
    }
    if (task.result?.verdict !== 'pass') throw new Error('No verified task result');
    task.consumed = true;
    if (task.stage === 'fix') {
      const destination = state.retryStage;
      if (!['smoke', 'system'].includes(destination)) throw new Error('No defect retest destination');
      state.retryStage = null;
      await this.move(destination, 'Development repaired defects; QA must retest');
    } else await this.move(nextAfter(task.stage, this.definition), `${task.stage}: verified`);
  }
}

async function packageRelease(state) {
  const approval = JSON.parse(await readFile(join(state.workspace, 'workflow-artifacts/approval.json'), 'utf8'));
  if (approval.approved !== true) throw new Error('Product release approval is required');
  await command('npm', ['test'], state.workspace);
  await command('npm', ['run', 'build'], state.workspace);
  const sources = { ...await fingerprint(join(state.workspace, 'src')), ...Object.fromEntries(Object.entries(await fingerprint(join(state.workspace, 'server'))).map(([p,h]) => [`server/${p}`,h])) };
  const digest = createHash('sha256').update(JSON.stringify(sources)).digest('hex');
  const release = join(lab, 'releases', `${state.id}-${digest.slice(0, 12)}`);
  await mkdir(release, { recursive: true });
  // Production adapters use Node built-ins; the client dependencies are bundled.
  for (const file of ['dist', 'server', 'package.json']) await cp(join(state.workspace, file), join(release, file), { recursive: true });
  await verifyReleaseRuntime(release, sources);
  const assetHashes = await readReleaseAssetHashes(release);
  const assetDigest = createHash('sha256').update(JSON.stringify(assetHashes)).digest('hex');
  const manifest = { workflowId: state.id, digest, assetDigest, assetHashes, createdAt: new Date().toISOString(), url: 'http://127.0.0.1:3201', sourceHashes: sources, approvalIssue: state.tasks.findLast(t => t.stage === 'approval').issueId };
  await atomicJSON(join(release, 'release.json'), manifest);
  await command('tar', ['-czf', `${release}.tar.gz`, '-C', release, '.']);
  state.candidate = { path: release, ...manifest };
  await atomicJSON(stateFile, state);
  await atomicJSON(join(state.workspace, 'workflow-artifacts/deployment.json'), state.candidate);
  return state.candidate;
}
async function run(state, { recovery = null } = {}) {
  await health();
  await hydrateWorkflowDefinition(state);
  const workflow = new Workflow(state);
  await workflow.reconcile();
  let staging, releaseServer;
  const prepare = async stage => {
    if (qaStages.has(stage) && !staging) staging = await startAX(state.workspace, 3200);
    if (stage === 'acceptance' || stage === 'delivery-review' || stage === 'done') {
      if (!state.candidate) throw new Error('No approved release candidate');
      if (!releaseServer) releaseServer = await startVerifiedRelease(state.candidate, 3201);
      else await verifyReleaseRuntime(state.candidate.path, releaseSourceBaseline(state.candidate));
      const delivery = await verifyReleaseDelivery(state.candidate.path, releaseServer.url, fetch, releaseAssetBaseline(state.candidate));
      await persistDeliveryEvidence(state, delivery);
    }
  };
  try {
    if (state.pendingRecovery?.taskIssueId) throw new Error('Resume supplemental recovery with revalidate');
    if (recovery || state.pendingRecovery) {
      await prepare(state.cursor);
      await workflow.recover(recovery ?? {});
    }
    const live = await api(`/companies/${state.companyId}/live-runs`);
    const knownRuns = new Set(trackedTasks(state).map(t => t.runId).filter(Boolean));
    if (live.some(run => ['queued', 'running'].includes(run.status) && !knownRuns.has(run.id))) throw new Error('An untracked agent run is active');
    while (state.cursor !== 'done') {
      if (shutdownRequested) throw new Error('Controller is stopping');
      if (state.stopReason) throw new Error('Rework limit reached; inspect the defect reports before starting a new experiment');
      if (state.cursor === 'cancelled') throw new Error('Workflow was cancelled');
      const stage = state.cursor;
      await prepare(stage);
      const task = await workflow.task(stage);
      const result = await workflow.execute(task, stage === 'acceptance' || stage === 'delivery-review' ? releaseServer.url : staging?.url ?? 'http://127.0.0.1:3200');
      if (stage === 'release') await packageRelease(state);
      if (stage === 'acceptance' && result.verdict === 'fail' && releaseServer) { await releaseServer.stop(); releaseServer = null; }
      await workflow.advance(task);
    }
    if (!state.candidate) throw new Error('Missing accepted release');
    await prepare('done');
    try {
      const previous = JSON.parse(await readFile(join(lab, 'current-ax-release.json'), 'utf8'));
      if (previous.digest !== state.candidate.digest || previous.workflowId !== state.id) await atomicJSON(join(lab, 'previous-ax-release.json'), previous);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await atomicJSON(join(lab, 'current-ax-release.json'), state.candidate);
    state.complete = true;
    await workflow.checkpoint('release-accepted', { digest: state.candidate.digest });
    console.log(`AX workflow complete. Local release: ${state.candidate.url}\nUse npm run paperclip:ax:serve to start the accepted release.`);
  } finally {
    if (staging) await staging.stop();
    if (releaseServer) await releaseServer.stop();
  }
}
async function apply(state) {
  if (!state.complete || state.cursor !== 'done') throw new Error('Workflow must finish acceptance before applying changes');
  const current = await fingerprint(join(root, 'src'));
  if (JSON.stringify(current) !== JSON.stringify(state.sourceBaseline)) throw new Error('AX source changed since seed; review and integrate manually');
  const sourceFiles = await fingerprint(join(state.workspace, 'src'));
  for (const file of Object.keys(sourceFiles)) {
    await mkdir(dirname(join(root, 'src', file)), { recursive: true });
    await cp(join(state.workspace, 'src', file), join(root, 'src', file));
  }
  for (const file of ['agent-filter.test.mjs', 'agent-filter.browser.mjs']) await cp(join(state.workspace, 'tests', file), join(root, 'tests', file));
  const reports = join(root, 'experiments/paperclip/runs', state.id);
  await mkdir(reports, { recursive: true });
  const reportNames = new Set([
    ...Object.values(STAGE_OUTPUTS).flat().filter(file => file.startsWith('workflow-artifacts/')).map(file => file.slice('workflow-artifacts/'.length)),
    'requirements-amendment.md', 'qa-contract-review.md', 'agent-filter-browser-results.json',
    'implementation-validation.json', 'fix-validation.json', 'release-delivery.json',
    'improvement-request.md', 'filter-verification.json', 'topology-verification.json', 'navigation-verification.json',
  ]);
  for (const file of await readdir(join(state.workspace, 'workflow-artifacts'))) {
    if (reportNames.has(file) || /^(?:operator-review|verified)-[A-Z]+-\d+\.(?:md|json)$/.test(file)) await cp(join(state.workspace, 'workflow-artifacts', file), join(reports, file));
  }
  await atomicJSON(join(reports, 'execution.json'), { workflowId: state.id, companyId: state.companyId, pipelineId: state.pipelineId, caseId: state.caseId,
    ...(state.parentWorkflowId ? { parentWorkflowId: state.parentWorkflowId, parentCaseId: state.parentCaseId, parentFinalIssue: state.parentFinalIssue ?? state.parentAcceptanceIssue } : {}),
    supplementalTasks: (state.supplementalTasks ?? []).map(({stage,purpose,approvalIssueId,supersedesIssueId,issueId,identifier,agentId,runId,runHistory,result}) => ({stage,purpose,approvalIssueId,supersedesIssueId,issueId,identifier,agentId,runId,runHistory: runHistory ?? [],result})),
    workflowDefinitionDigest: state.workflowDefinitionDigest, teams: (state.workflowDefinition ?? definition).teams, tasks: state.tasks.map(({stage,issueId,identifier,agentId,runId,runHistory,result}) => ({stage,issueId,identifier,agentId,runId,runHistory: runHistory ?? [],verdict: result?.verdict,
      ...(qaStages.has(stage) ? {checks: result?.checks, findings: result?.findings, agentVerdict: result?.agentVerdict, agentUnverifiedChecks: result?.agentUnverifiedChecks ?? []} : {}),
      ...(stage === 'delivery-review' ? {review: {accepted: result?.accepted, reason: result?.reason, releaseDigest: result?.releaseDigest, acceptanceRunId: result?.acceptanceRunId, acceptanceIssueId: result?.acceptanceIssueId}} : {}) })), events: state.events,
    release: { digest: state.candidate.digest,
      ...(state.candidate.assetHashes ? { assetDigest: state.candidate.assetDigest, assetCount: Object.keys(state.candidate.assetHashes).length } : {}),
      approved: true, accepted: true, url: state.candidate.url } });
  console.log(`Applied accepted AX feature; reviewed reports: experiments/paperclip/runs/${state.id}`);
}
async function main() {
  const [action = 'status', ...args] = process.argv.slice(2);
  await mkdir(lab, { recursive: true });
  if (action === 'serve') {
    const release = JSON.parse(await readFile(join(lab, 'current-ax-release.json'), 'utf8'));
    const server = await startVerifiedRelease(release, 3201);
    try { await verifyReleaseDelivery(release.path, server.url, fetch, releaseAssetBaseline(release)); }
    catch (error) { await server.stop(); throw error; }
    console.log(`Accepted AX release: ${server.url}`);
    await new Promise((ok, fail) => server.child.once('close', code => code === 0 || shutdownRequested ? ok() : fail(new Error('Release server stopped'))));
    return;
  }
  if (action === 'status') {
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    await health();
    console.log(`Stage: ${state.cursor}; accepted: ${state.complete}`);
    for (const task of trackedTasks(state)) console.log(`${task.identifier} · ${task.stage}${task.purpose ? ` (${task.purpose})` : ''} · ${(await api(`/issues/${task.issueId}`)).status} · ${task.result?.verdict ?? 'pending'}`);
    return;
  }
  if (!['seed', 'run', 'apply', 'retry', 'recover', 'revise', 'improve', 'revalidate'].includes(action)) throw new Error('Use seed, run, retry, recover, revise, improve, revalidate, status, apply, or serve');
  const lockPath = join(lab, 'ax-workflow.lock');
  const lock = await open(lockPath, 'wx').catch(error => { if (error.code === 'EEXIST') throw new Error('AX workflow lock exists; verify its owner stopped before removing it'); throw error; });
  ownsLock = true;
  ownsWorkflow = ['run', 'retry', 'recover', 'revise', 'improve', 'revalidate'].includes(action);
  try {
    await lock.writeFile(String(process.pid));
    if (action === 'seed') await seed(args.includes('--fresh'));
    if (action === 'run') await run(await seed(false));
    if (action === 'retry') {
      const state = JSON.parse(await readFile(stateFile, 'utf8'));
      await health(); await hydrateWorkflowDefinition(state);
      const task = state.tasks.at(-1);
      if (!task?.runId || task.consumed) throw new Error('No failed task to retry');
      const current = await api(`/heartbeat-runs/${task.runId}`);
      if (['queued', 'running', 'succeeded'].includes(current.status)) throw new Error('Retry requires a confirmed failed or cancelled run');
      if ((await api(`/issues/${task.issueId}`)).executionBlocker) throw new Error('Execution reconciliation required: use recover --outcome <mixed|completed|not_performed> --evidence <reviewed outcome evidence>');
      task.runHistory = [...(task.runHistory ?? []), task.runId];
      task.runId = null; task.result = null; task.wakeKey = `${task.issueId}-retry-${task.runHistory.length}`;
      await atomicJSON(stateFile, state);
      await run(state);
    }
    if (action === 'revalidate') {
      const state = JSON.parse(await readFile(stateFile, 'utf8'));
      await health(); await hydrateWorkflowDefinition(state);
      const workflow = new Workflow(state); await workflow.reconcile();
      const option = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
      const task = state.pendingRecovery?.taskIssueId
        ? state.supplementalTasks?.find(task => task.issueId === state.pendingRecovery.taskIssueId)
        : await workflow.approvalRevalidation(option('--reason') ?? state.supplementalTasks?.at(-1)?.reason);
      if (!task) throw new Error('No supplemental task to resume');
      state.activeSupplementalTaskId = task.issueId; await workflow.checkpoint('supplemental-execution-selected', { issueId: task.issueId });
      const server = await startAX(state.workspace, 3200);
      try {
        if (state.pendingRecovery?.taskIssueId || option('--outcome')) await workflow.recover({ supplemental: true, actionOutcome: option('--outcome'), outcomeEvidence: option('--evidence') });
        const result = await workflow.execute(task, server.url);
        task.consumed = true; delete state.activeSupplementalTaskId;
        await workflow.checkpoint('approval-revalidation-completed', { issueId: task.issueId, verdict: result.verdict });
        if (result.verdict !== 'pass') throw new Error('Supplemental QA failed; approval remains blocked');
        console.log(`Approval revalidation passed: ${task.identifier}; formally recover the original approval.`);
      } finally { await server.stop(); }
    }
    if (action === 'recover') {
      const state = JSON.parse(await readFile(stateFile, 'utf8'));
      await health(); await hydrateWorkflowDefinition(state);
      const option = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
      await run(state, { recovery: { actionOutcome: option('--outcome'), outcomeEvidence: option('--evidence') } });
    }
    if (action === 'revise') {
      const state = JSON.parse(await readFile(stateFile, 'utf8'));
      await health(); await hydrateWorkflowDefinition(state);
      await new Workflow(state).requestRevision(args.includes('--reason') ? args[args.indexOf('--reason') + 1] : undefined);
      await run(state);
    }
    if (action === 'improve') {
      const parent = JSON.parse(await readFile(stateFile, 'utf8'));
      await health(); await hydrateWorkflowDefinition(parent);
      const reason = args.includes('--reason') ? args[args.indexOf('--reason') + 1] : undefined;
      const reviewedReason = await assertImprovementInput(parent, reason);
      await run(await seed(true, { parent, reason: reviewedReason, topologyVerification: args.includes('--verify-topology'), navigationVerification: args.includes('--verify-navigation') }));
    }
    if (action === 'apply') {
      const state = JSON.parse(await readFile(stateFile, 'utf8'));
      await health(); await hydrateWorkflowDefinition(state);
      await apply(state);
    }
  } finally { ownsWorkflow = false; ownsLock = false; await lock.close(); await rm(lockPath, { force: true }); }
}
export function installShutdownHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    void (async () => {
      try {
        if (ownsWorkflow) {
          const state = JSON.parse(await readFile(stateFile, 'utf8'));
          const task = activeWorkflowTask(state);
          if (task) await api(`/agents/${task.agentId}`, 'PATCH', { runtimeConfig: heartbeat(false) });
          const ids = new Set(task?.runId ? [task.runId] : []);
          if (state.pendingRecovery && task) {
            const live = await api(`/companies/${state.companyId}/live-runs`);
            for (const candidate of live.filter(r => r.issueId === task.issueId && r.agentId === task.agentId)) {
              const run = await api(`/heartbeat-runs/${candidate.id}`);
              if (run.contextSnapshot?.recoveryActionId === state.pendingRecovery.actionId && run.contextSnapshot?.previousRunId === state.pendingRecovery.runId) ids.add(candidate.id);
            }
          }
          for (const id of ids) {
            const run = await api(`/heartbeat-runs/${id}`);
            if (['queued', 'running'].includes(run.status)) await api(`/heartbeat-runs/${id}/cancel`, 'POST', {});
          }
        }
      } catch { console.error('Controller stopped; verify the tracked Paperclip run before resuming.'); }
      await Promise.allSettled([stopOwnedServers(), shutdownOwnedChildGroups()]);
      if (ownsLock) {
        const lockPath = join(lab, 'ax-workflow.lock');
        try { if ((await readFile(lockPath, 'utf8')) === String(process.pid)) await rm(lockPath); } catch { /* Never remove another controller's lock. */ }
      }
      process.exit(signal === 'SIGINT' ? 130 : 143);
    })();
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installShutdownHandlers();
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
