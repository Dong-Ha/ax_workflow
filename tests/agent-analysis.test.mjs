import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAnalysis, sha256 } from '../runtime/agents/analysis.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roles = ['spec-gen', 'tc', 'code-dev', 'arch-runner', 'sqe', 'report'];
const valid = (overrides = {}) => ({ status: 'completed', summary: '분석 완료',
  requirements: [{ id: 'REQ-001', text: '동작을 수행한다', acceptance: '결과가 확인된다' }],
  missing_inputs: [], impact: ['모듈 A'], questions: [], ...overrides });

async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ax-agent-analysis-'));
  const agents = path.join(temp, 'agents');
  await mkdir(agents);
  await writeFile(path.join(agents, 'registry.json'), await readFile(path.join(repo, 'agents/registry.json')));
  await writeFile(path.join(agents, 'common.md'), await readFile(path.join(repo, 'agents/common.md')));
  for (const role of roles) {
    await mkdir(path.join(agents, role));
    await writeFile(path.join(agents, role, 'AGENTS.md'), await readFile(path.join(repo, 'agents', role, 'AGENTS.md')));
  }
  const output = path.join(temp, 'runs');
  t.after(() => rm(temp, { recursive: true, force: true }));
  return { agents, output };
}

const request = { title: '시험 요청', request: '기능을 분석한다', source_context: '모듈 A가 입력을 처리한다' };

test('P01 flows into P02 with trusted IDs and artifact hashes', async (t) => {
  const { agents, output } = await fixture(t);
  const calls = [];
  const result = await runAnalysis(request, { outputRoot: output, instructionsRoot: agents, invoke: async call => {
    calls.push(call);
    return valid({ summary: calls.length === 1 ? '요청 확인' : '영향 분석 완료' });
  } });
  assert.equal(result.run.status, 'slice_completed');
  assert.deepEqual(result.run.steps.map(step => step.step_id), ['P01', 'P02']);
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /"previous": \{/);
  assert.match(calls[1].prompt, /요청 확인/);
  for (const step of result.run.steps) {
    assert.equal(step.result.execution_id, step.execution_id);
    assert.equal(step.result.job_id, result.run.run_id);
    assert.deepEqual(step.result.artifact_ids, [`${result.run.run_id}/${step.step_id}.json`]);
    const bytes = await readFile(path.join(result.directory, `${step.step_id}.json`));
    assert.equal(step.artifact_sha256, sha256(bytes));
  }
});

test('instruction bundles stay pinned when files change during P01', async (t) => {
  const { agents, output } = await fixture(t);
  let changed = false;
  const result = await runAnalysis(request, { outputRoot: output, instructionsRoot: agents, invoke: async () => {
    if (!changed) {
      changed = true;
      await writeFile(path.join(agents, 'spec-gen', 'AGENTS.md'), '# altered after pin\n');
    }
    return valid();
  } });
  assert.equal(result.run.steps[0].instructions.bundle_sha256, result.run.steps[1].instructions.bundle_sha256);
  const p02Instructions = await readFile(path.join(result.directory, 'P02-instructions.md'), 'utf8');
  assert.match(p02Instructions, /요구사항 입수/);
  assert.doesNotMatch(p02Instructions, /altered after pin/);
});

test('needs_human stops before P02', async (t) => {
  const { agents, output } = await fixture(t);
  let calls = 0;
  const result = await runAnalysis(request, { outputRoot: output, instructionsRoot: agents, invoke: async () => {
    calls++;
    return valid({ status: 'needs_human', questions: ['기준 자료를 제공해 주세요'] });
  } });
  assert.equal(calls, 1);
  assert.equal(result.run.status, 'needs_human');
  assert.deepEqual(result.run.steps.map(step => step.step_id), ['P01']);
});

test('invalid schema and secret marker fail without persisting model content', async (t) => {
  const { agents, output } = await fixture(t);
  const result = await runAnalysis(request, { outputRoot: output, instructionsRoot: agents,
    invoke: async () => ({ ...valid(), unexpected: 'SECRET_MODEL_MARKER' }) });
  assert.equal(result.run.status, 'failed');
  assert.equal(result.run.steps[0].result.status, 'failed');
  const run = JSON.stringify(result.run);
  assert.doesNotMatch(run, /SECRET_MODEL_MARKER/);
  await assert.rejects(readFile(path.join(result.directory, 'P01.json')));
});

test('missing input is rejected before invoking model', async (t) => {
  const { agents, output } = await fixture(t);
  let calls = 0;
  await assert.rejects(runAnalysis({ ...request, source_context: ' ' }, { outputRoot: output,
    instructionsRoot: agents, invoke: async () => { calls++; return valid(); } }), { message: 'ANALYSIS_REQUEST_INVALID' });
  assert.equal(calls, 0);
});

test('invoke failure and pre-aborted run never report completion', async (t) => {
  const { agents, output } = await fixture(t);
  const failed = await runAnalysis(request, { outputRoot: output, instructionsRoot: agents,
    invoke: async () => { throw new Error('AGENT_EXECUTION_FAILED'); } });
  assert.equal(failed.run.status, 'failed');
  assert.notEqual(failed.run.steps[0].result.status, 'completed');
  const controller = new AbortController();
  controller.abort();
  const aborted = await runAnalysis(request, { outputRoot: output, instructionsRoot: agents, signal: controller.signal,
    invoke: async ({ signal }) => { if (signal.aborted) throw new Error('AGENT_INTERRUPTED'); return valid(); } });
  assert.equal(aborted.run.status, 'interrupted');
  assert.equal(aborted.run.steps[0].result.status, 'interrupted');
});

test('completed response with unresolved inputs is rejected before P02', async (t) => {
  const { agents, output } = await fixture(t);
  let calls = 0;
  const result = await runAnalysis(request, { outputRoot: output, instructionsRoot: agents,
    invoke: async () => { calls++; return valid({ missing_inputs: ['필수 기준 자료'] }); } });
  assert.equal(calls, 1);
  assert.equal(result.run.status, 'failed');
  assert.equal(result.run.steps[0].validation_error, 'UNRESOLVED_INPUT');
  assert.deepEqual(result.run.steps[0].result.artifact_ids, []);
});
