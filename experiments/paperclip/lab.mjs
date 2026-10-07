import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, access, open, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const lab = join(root, '.paperclip-lab');
const cli = join(lab, 'runtime/node_modules/paperclipai/dist/index.js');
const version = '2026.1005.0';
const definition = JSON.parse(await readFile(new URL('./workflow.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
const command = args[0] ?? 'status';
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'smoke';
if (!['smoke', 'codex'].includes(mode)) throw new Error('--mode must be smoke or codex');
const statePath = join(lab, `state-${mode}.json`);
const base = new URL(process.env.AX_PAPERCLIP_URL || 'http://127.0.0.1:3100');
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname) || base.username || base.password || base.pathname !== '/') {
  throw new Error('Paperclip evaluation only accepts a loopback HTTP server');
}
function isolatedEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAPERCLIP_') && !['DATABASE_URL', 'DATABASE_MIGRATION_URL', 'HOST', 'PORT'].includes(key)));
}
function child(executable, parameters, env = process.env) {
  return new Promise((ok, fail) => {
    const process = spawn(executable, parameters, { cwd: root, env, stdio: 'inherit' });
    process.on('error', fail);
    process.on('exit', (code) => code === 0 ? ok() : fail(new Error(`${executable} exited with ${code}`)));
  });
}
async function api(path, method = 'GET', payload) {
  const response = await fetch(new URL(`/api${path}`, base), {
    method, headers: { 'Content-Type': 'application/json', Origin: base.origin },
    body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
async function ensureLocalInstance() {
  const health = await api('/health');
  if (health.version !== version || health.deploymentMode !== 'local_trusted') {
    throw new Error(`Expected Paperclip ${version} in local_trusted mode`);
  }
}
const heartbeat = wakeOnDemand => ({ heartbeat: { enabled: false, wakeOnDemand, maxConcurrentRuns: 1 } });
async function seed() {
  await ensureLocalInstance();
  await mkdir(lab, { recursive: true });
  if (!args.includes('--fresh')) {
    try { const state = JSON.parse(await readFile(statePath, 'utf8')); await api(`/companies/${state.companyId}`); return state; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const suffix = Date.now().toString(36);
  const workspace = join(lab, 'workspaces', `${mode}-${suffix}`);
  await mkdir(workspace, { recursive: true });
  // Keep the coding agent within the sample project's own instruction boundary.
  await writeFile(join(workspace, 'AGENTS.md'), 'Only work in this sample directory. Do not read parent directories, call network services, commit, push, or change credentials. Follow the assigned stage and write only its output files.\n');
  await api('/instance/settings/experimental', 'PATCH', { enablePipelines: true });
  const company = await api('/companies', 'POST', { name: `${definition.name} · ${mode} · ${suffix}`, description: definition.description });
  await api(`/companies/${company.id}`, 'PATCH', { requireBoardApprovalForNewAgents: false });
  const project = await api(`/companies/${company.id}/projects`, 'POST', {
    name: `${definition.project} · ${mode}`, description: definition.description, status: 'in_progress',
    workspace: { name: '격리된 예제 프로젝트', sourceType: 'non_git_path', cwd: workspace, isPrimary: true },
  });
  const stages = [];
  for (const [index, stage] of definition.stages.entries()) {
    const agent = await api(`/companies/${company.id}/agents`, 'POST', {
      name: stage.agent, role: stage.role, title: stage.name,
      reportsTo: index ? stages[0].agentId : null, adapterType: 'process',
      capabilities: `${stage.name}; ${mode === 'smoke' ? '모델 없는 시뮬레이션' : '실제 Codex CLI 실행'}`,
      adapterConfig: { command: process.execPath, args: [join(root, 'experiments/paperclip/stage-agent.mjs'), '--stage', stage.key, '--mode', mode, '--workspace', workspace], cwd: workspace, timeoutSec: 240 },
      runtimeConfig: heartbeat(false), permissions: { canCreateAgents: false, canCreateSkills: false },
    });
    const issue = await api(`/companies/${company.id}/issues`, 'POST', {
      title: `${index + 1}. ${stage.name} · ${stage.agent}`, description: `${definition.description}\n산출물: ${stage.output}\n실행 방식: ${mode}`,
      projectId: project.id, assigneeAgentId: agent.id, status: 'todo', priority: 'medium',
      blockedByIssueIds: stages.length ? [stages.at(-1).issueId] : [],
    });
    await api(`/agents/${agent.id}`, 'PATCH', { adapterConfig: {
      ...agent.adapterConfig, env: { AX_PAPERCLIP_ISSUE_ID: issue.id },
    } });
    stages.push({ ...stage, agentId: agent.id, issueId: issue.id, identifier: issue.identifier });
  }
  const pipeline = await api(`/companies/${company.id}/pipelines`, 'POST', {
    key: `ax-fixed-${suffix}`, name: '요구사항 → 구현 → 검증', projectId: project.id, description: definition.description,
    stages: [...stages.map((stage, index) => ({ key: stage.key, name: `${stage.name} · ${stage.agent}`, kind: 'working', position: (index + 1) * 100 })), { key: 'done', name: '완료', kind: 'done', position: 400 }, { key: 'cancelled', name: '취소', kind: 'cancelled', position: 500 }],
  });
  await api(`/pipelines/${pipeline.id}/transitions`, 'PUT', {
    enforceTransitions: true,
    transitions: stages.flatMap((stage, index) => [{ fromStageKey: stage.key, toStageKey: stages[index + 1]?.key ?? 'done' }, { fromStageKey: stage.key, toStageKey: 'cancelled' }]),
  });
  const ingest = await api(`/pipelines/${pipeline.id}/cases`, 'POST', {
    caseKey: `slugify-${suffix}`, title: `Slugify 제작 · ${mode}`, stageKey: stages[0].key,
    summary: `${mode === 'smoke' ? '시뮬레이션' : '실제 Codex'}: 정의된 순서대로 세 에이전트를 호출합니다.`,
    fields: { mode, steps: stages.map(({ key, agentId, issueId }) => ({ key, agentId, issueId })) },
  });
  for (const stage of stages) await api(`/cases/${ingest.case.id}/issue-links`, 'POST', { issueId: stage.issueId, role: 'work' });
  const state = { version, mode, companyId: company.id, projectId: project.id, pipelineId: pipeline.id, caseId: ingest.case.id, workspace, stages };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  console.log(`Prepared ${mode} workflow. Dashboard: ${base.origin}\nCompany: ${company.name}\nWorkspace: ${workspace}`);
  return state;
}
async function status(state) {
  for (const stage of state.stages) {
    const issue = await api(`/issues/${stage.issueId}`);
    console.log(`${stage.identifier} · ${stage.name} · ${stage.agent}: ${issue.status}`);
  }
  const detail = await api(`/cases/${state.caseId}`);
  console.log(`Pipeline stage: ${detail.case.stageKey ?? detail.stage?.key ?? detail.case.stageId}`);
}
async function run(state) {
  const initialCase = await api(`/cases/${state.caseId}`);
  const initialPipeline = await api(`/pipelines/${state.pipelineId}`);
  if (initialPipeline.stages.find(stage => stage.id === initialCase.case.stageId)?.kind === 'cancelled') throw new Error('Workflow case was cancelled');
  // One local controller at a time; agent timers and assignment wakeups stay disabled.
  const live = await api(`/companies/${state.companyId}/live-runs`);
  if (live.some(run => ['queued', 'running'].includes(run.status))) throw new Error('A workflow run is already active');
  for (const [index, stage] of state.stages.entries()) {
    const issue = await api(`/issues/${stage.issueId}`);
    if (issue.status !== 'done') {
      for (const prior of state.stages.slice(0, index)) {
        if ((await api(`/issues/${prior.issueId}`)).status !== 'done') throw new Error('Upstream stage is incomplete');
      }
      await api(`/agents/${stage.agentId}`, 'PATCH', { runtimeConfig: heartbeat(true) });
      let runId;
      try {
        const wake = await api(`/agents/${stage.agentId}/wakeup`, 'POST', {
          source: 'on_demand', triggerDetail: 'manual', reason: 'AX fixed workflow', payload: { issueId: stage.issueId },
          idempotencyKey: `${state.caseId}-${stage.key}-${Date.now()}`,
        });
        runId = wake.id ?? wake.run?.id;
        if (!runId) throw new Error(`Wake did not produce a run: ${JSON.stringify(wake)}`);
        console.log(`Running ${stage.agent}: ${stage.identifier}`);
        const deadline = Date.now() + 270000;
        let completed = false;
        while (Date.now() < deadline) {
          const current = await api(`/heartbeat-runs/${runId}`);
          if (current.status === 'succeeded') { completed = true; break; }
          if (!['queued', 'running'].includes(current.status)) throw new Error(`${stage.agent} run ended: ${current.status}`);
          await new Promise(ok => setTimeout(ok, 1000));
        }
        if (!completed) {
          await api(`/heartbeat-runs/${runId}/cancel`, 'POST', {});
          throw new Error(`${stage.agent} timed out`);
        }
        if ((await api(`/issues/${stage.issueId}`)).status !== 'done') throw new Error('Agent run succeeded but task is incomplete');
      } finally {
        await api(`/agents/${stage.agentId}`, 'PATCH', { runtimeConfig: heartbeat(false) });
      }
    }
    const detail = await api(`/cases/${state.caseId}`);
    const pipeline = await api(`/pipelines/${state.pipelineId}`);
    const currentKey = pipeline.stages.find(item => item.id === detail.case.stageId)?.key;
    if (currentKey === stage.key) {
      await api(`/cases/${state.caseId}/transition`, 'POST', {
        toStageKey: state.stages[index + 1]?.key ?? 'done', expectedVersion: detail.case.version,
        reason: `${stage.agent}: completed task and verified output`,
      });
    }
    console.log(`Completed ${stage.agent}`);
  }
  await status(state);
}

await mkdir(lab, { recursive: true });
if (command === 'install') {
  await child('npm', ['install', '--prefix', join(lab, 'runtime'), '--no-package-lock', `paperclipai@${version}`]);
} else if (command === 'start') {
  await access(cli);
  let configured = true;
  try { await access(join(lab, 'data/instances/default/config.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; configured = false; }
  const parameters = configured
    ? [cli, 'run', '--data-dir', join(lab, 'data'), '--bind', 'loopback']
    : [cli, 'onboard', '--data-dir', join(lab, 'data'), '--bind', 'loopback', '--yes', '--no-install-service'];
  await child(process.execPath, parameters, isolatedEnv());
} else if (command === 'seed') {
  await status(await seed());
} else if (command === 'run') {
  const lockPath = join(lab, 'workflow.lock');
  const lock = await open(lockPath, 'wx').catch(error => {
    if (error.code === 'EEXIST') throw new Error('Another controller holds .paperclip-lab/workflow.lock; verify it has stopped before removing a stale lock');
    throw error;
  });
  try {
    await lock.writeFile(String(process.pid));
    await run(await seed());
  } finally {
    await lock.close(); await rm(lockPath, { force: true });
  }
} else if (command === 'status') {
  await ensureLocalInstance();
  await status(JSON.parse(await readFile(statePath, 'utf8')));
} else {
  throw new Error('Use install, start, seed, run or status');
}
