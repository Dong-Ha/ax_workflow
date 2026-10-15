import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { replayScenario } from '../src/ifpmic/replay.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specs = path.join(root, 'docs/ifpmic/design-v1/specs');
const [workflow, stateContract] = await Promise.all([
  readFile(path.join(specs, 'workflow.v1.json'), 'utf8').then(JSON.parse),
  readFile(path.join(specs, 'state-contract.json'), 'utf8').then(JSON.parse),
]);

// Literal original-contract oracle: P03 -> P04; X02 -> X03 -> P25 -> P26 -> END.
const fixedOrder = [
  'P01', 'P02', 'P03', 'P04', 'P05', 'X01', 'P06', 'P07', 'P08', 'P09', 'P10',
  'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19', 'P20', 'P21',
  'P22', 'P23', 'P24', 'X02', 'X03', 'P25', 'P26',
];
const operationKey = 'mock:release-action:ifpmic-ax-v1';
const sqeCases = ['mock:sqe:case:boot', 'mock:sqe:case:function'];
const sqeProfile = { profile_ref: 'mock:sqe:profile', profile_version: 'mock:sqe:profile:v1',
  script_version: 'mock:sqe:script:v1', parser_version: 'mock:sqe:parser:v1' };

function harness(id) {
  const events = [];
  let seq = 0;
  const current = () => replayScenario({ id, events }, workflow, stateContract);
  function add(type, step_id, payload = {}, overrides = {}) {
    const before = current();
    const step = before.steps[step_id];
    events.push({
      event_id: `evt:${id}:${++seq}`, source_id: 'mock-exception-source', source_seq: seq,
      type, mode: 'mock', job_id: before.job_id, step_id, cycle: before.cycle,
      attempt: step?.attempt ?? 1, execution_id: step?.execution_id ?? `mock:${step_id}:c${before.cycle}:a1`,
      payload, ...overrides,
    });
    return current();
  }
  return { id, events, current, add };
}

function runBasic(h, id) {
  h.add('step', id, { state: 'READY' });
  return h.add('step', id, { state: 'RUNNING' });
}

function taskId(ordinal, attempt = 1) {
  return `mock:task:P03:c1:a${attempt}:q${ordinal}`;
}

function openQuestion(h, ordinal, questionId, requirementsVersion = 'mock:requirements:v1') {
  return h.add('spec_unresolved', 'P03', {
    question_id: questionId, candidate_fingerprint: h.current().candidate_fingerprint,
    requirements_version: requirementsVersion, evidence_id: `mock:evidence:question-${ordinal}`,
  });
}

function resolveQuestion(h, { ordinal = 1, questionId = `mock:question:${ordinal}`,
  previousVersion = 'mock:requirements:v1', nextVersion = `mock:requirements:v${ordinal + 1}`,
  complete = true, task = taskId(ordinal), actor = 'mock:human', plan = 'mock:plan:v1',
  candidate = h.current().candidate_fingerprint, evidenceId = `mock:evidence:resolution-${ordinal}` } = {}) {
  return h.add('spec_resolution', 'P03', {
    actor, question_id: questionId, task_id: task, plan_version: plan,
    candidate_fingerprint: candidate, requirements_version: previousVersion,
    resolved_requirements_version: nextVersion, complete, evidence_id: evidenceId,
  });
}

function manifestPayload(h) {
  const result = h.current();
  return {
    manifest_id: 'mock:manifest:exceptions-v1', digest: 'mock:digest:exceptions-v1',
    candidate_fingerprint: result.candidate_fingerprint, rule_version: result.rule_version,
    destination: 'mock:destination:exceptions', notes_hash: 'mock:notes:exceptions',
    evidence_bundle: 'mock:evidence-bundle:exceptions',
  };
}

function addMockSqe(h, id) {
  const result = h.current(), p22 = result.steps.P22;
  const prefix = `mock:${h.id}:sqe:c${result.cycle}:a${p22.attempt}`;
  if (id === 'P22') {
    const context = { actor: 'mock:sqe', candidate_fingerprint: result.candidate_fingerprint, ...sqeProfile,
      rule_version: result.rule_version, device_id: `${prefix}:device`, bridge_id: `${prefix}:bridge`,
      image_hash: `${prefix}:image`, expected_image_identity: `${prefix}:boot`, evidence_id: `${prefix}:context` };
    h.add('sqe_context', id, context);
    h.add('sqe_result', id, { actor: 'mock:sqe', execution_mode: 'bridge_mock', task_id: null, performer_id: 'mock:sqe',
      candidate_fingerprint: result.candidate_fingerprint, ...sqeProfile, rule_version: result.rule_version,
      device_id: context.device_id, bridge_id: context.bridge_id, image_hash: context.image_hash,
      observed_device_id: context.device_id, observed_image_identity: context.expected_image_identity,
      started_at_ms: 1000, finished_at_ms: 2000, execution_status: 'completed', parser_status: 'complete', exit_code: 0,
      cases: sqeCases.map(case_id => ({ case_id, outcome: 'PASS' })), stdout_artifact_id: `${prefix}:stdout`,
      stderr_artifact_id: `${prefix}:stderr`, result_artifact_id: `${prefix}:result-artifact`, evidence_id: `${prefix}:result` });
  } else {
    const current = h.current();
    h.add('sqe_report', id, { actor: 'mock:sqe', candidate_fingerprint: current.candidate_fingerprint,
      result_evidence_id: current.steps.P22.sqe_result.evidence_id, result_execution_id: current.steps.P22.execution_id,
      profile_ref: sqeProfile.profile_ref, profile_version: sqeProfile.profile_version,
      report_artifact_id: `${prefix}:report-artifact`, report_link_id: `${prefix}:report-link`, evidence_id: `${prefix}:report` });
  }
}

// Keep the release exception fixture on the current P12 contract without
// deriving proof from the product catalog enricher.
function addLiteralP12ChildProof(h) {
  const result = h.current(), step = result.steps.P12;
  const suffix = `c${result.cycle}:a${step.attempt}`;
  const parent = { coordinator_task_id: `mock:exceptions:parent-task:${suffix}`,
    coordinator_execution_id: `mock:exceptions:parent-exec:${suffix}`,
    candidate_fingerprint: result.candidate_fingerprint, requirements_version: result.requirements_version };
  const requestId = `mock:exceptions:request:${suffix}`, childTask = `mock:exceptions:task:${suffix}`;
  const childExecution = `mock:exceptions:child-exec:${suffix}`, production = `mock:exceptions:production:${suffix}`;
  const patch = `mock:exceptions:patch:${suffix}`, resultEvidence = `mock:exceptions:result-proof:${suffix}`;
  h.add('p12_coordinator', 'P12', { actor: 'mock:system', role: 'code-dev', purpose: 'p12_coordination', ...parent,
    p11_execution_id: result.steps.P11.execution_id, code_artifact_id: `mock:exceptions:code:${suffix}`,
    production_hash: production, tc_design_artifact_id: `mock:exceptions:design:${suffix}`,
    workspace_id: `mock:exceptions:integration-ws:${suffix}`, write_scope: 'tests_integration_only',
    runtime_profile_ref: 'mock:runtime:code-dev-coordinator:v1', evidence_id: `mock:exceptions:coordinator-proof:${suffix}` });
  h.add('child_request', 'P12', { actor: 'mock:code-dev', ...parent, request_id: requestId, child_task_id: childTask,
    ordinal: 1, child_role: 'tc', workspace_id: `mock:exceptions:tc-ws:${suffix}`, write_scope: 'tests_only',
    runtime_profile_ref: 'mock:runtime:tc:v1', output_schema_ref: 'mock:schema:tc-patch:v1',
    code_artifact_id: `mock:exceptions:code:${suffix}`, tc_design_artifact_id: `mock:exceptions:design:${suffix}`,
    prior_child_execution_id: null, checkpoint_artifact_id: null, answer_evidence_id: null, answer_artifact_id: null,
    evidence_id: `mock:exceptions:request-proof:${suffix}` });
  h.add('child_assignment', 'P12', { actor: 'mock:system', ...parent, request_id: requestId, child_task_id: childTask,
    child_execution_id: childExecution, workspace_id: `mock:exceptions:tc-ws:${suffix}`,
    evidence_id: `mock:exceptions:assignment-proof:${suffix}` });
  h.add('child_result', 'P12', { actor: 'mock:tc', ...parent, request_id: requestId, child_task_id: childTask,
    child_execution_id: childExecution, workspace_id: `mock:exceptions:tc-ws:${suffix}`, status: 'completed',
    output_schema_ref: 'mock:schema:tc-patch:v1', patch_artifact_id: patch,
    changed_path_refs: ['mock:path:tests:unit'], production_hash: production,
    question_id: null, checkpoint_artifact_id: null, failure_class: null,
    started_at_ms: 1000, finished_at_ms: 2000, evidence_id: resultEvidence });
  h.add('child_collect', 'P12', { actor: 'mock:code-dev', ...parent, child_execution_id: childExecution,
    result_evidence_id: resultEvidence, evidence_id: `mock:exceptions:collect-proof:${suffix}` });
  h.add('child_integrated', 'P12', { actor: 'mock:code-dev', ...parent, child_execution_id: childExecution,
    result_evidence_id: resultEvidence, patch_artifact_id: patch, production_hash_before: production,
    production_hash_after: production, changed_path_refs: ['mock:path:tests:unit'], expectations_changed: false,
    outcome: 'integrated', integration_artifact_id: `mock:exceptions:integration-proof:${suffix}`,
    evidence_id: `mock:exceptions:integrated-proof:${suffix}` });
}

function runNormalStep(h, id) {
  h.add('step', id, { state: 'READY' });
  h.add('step', id, { state: 'RUNNING' });
  if (id === 'P12') addLiteralP12ChildProof(h);
  const node = workflow.nodes.find(item => item.id === id);
  if (id === 'P22' || id === 'P23') {
    addMockSqe(h, id);
  } else if (node.owner === 'system') {
    const result = h.current(), step = result.steps[id];
    h.add('measurement', id, { evidence: {
      mode: 'mock', job_id: result.job_id, step_id: id, cycle: result.cycle,
      attempt: step.attempt, execution_id: step.execution_id,
      candidate_fingerprint: result.candidate_fingerprint, rule_version: result.rule_version,
      evidence_id: `mock:evidence:gate-${id}:c${result.cycle}:a${step.attempt}`, complete: true,
    }, verdict: 'PASS' });
  } else if (node.owner === 'human') {
    if (id === 'X03') {
      h.add('step', id, { state: 'WAITING_HUMAN' });
      const result = h.current(), manifest = result.release.manifest;
      h.add('approval', id, { actor: 'mock:human', task_id: 'mock:task:X03:c1',
        plan_version: 'mock:plan:v1', evidence_id: 'mock:evidence:approval',
        manifest_id: manifest.manifest_id, digest: manifest.digest,
        candidate_fingerprint: manifest.candidate_fingerprint, decision: 'approve' });
    } else {
      h.add('step', id, { state: 'WAITING_HUMAN' });
      const step = h.current().steps[id];
      const task = `mock:task:${id}:c1${step.attempt === 1 ? '' : `:a${step.attempt}`}`;
      h.add('human', id, { actor: 'mock:human', task_id: task,
        plan_version: 'mock:plan:v1', evidence_id: `mock:evidence:${id}` });
    }
  } else {
    if (id === 'X02') h.add('manifest', id, manifestPayload(h));
    if (id === 'P25') {
      const result = h.current(), manifest = result.release.manifest;
      h.add('receipt', id, { manifest_id: manifest.manifest_id, digest: manifest.digest,
        candidate_fingerprint: manifest.candidate_fingerprint, receipt_id: 'mock:receipt:baseline', observed: true });
    }
  }
  return h.add('step', id, { state: 'SUCCEEDED' });
}

function advanceBefore(h, target) {
  for (const id of fixedOrder) {
    if (id === target) return;
    runNormalStep(h, id);
  }
}

function releaseHarness(id) {
  const h = harness(id);
  advanceBefore(h, 'P25');
  runBasic(h, 'P25');
  return h;
}

function remoteCoordinates(h) {
  const result = h.current();
  const manifest = result.release.manifest;
  return { manifest_id: manifest.manifest_id, digest: manifest.digest,
    candidate_fingerprint: manifest.candidate_fingerprint, operation_key: operationKey };
}

function reconcile(h, outcome, query_seq, extra = {}) {
  return h.add('remote_reconcile', 'P25', {
    ...remoteCoordinates(h), evidence_id: `mock:evidence:remote-${query_seq}-${outcome}`,
    query_seq, outcome,
    ...(outcome === 'found' ? { receipt_id: 'mock:receipt:remote-found' } : {}),
    ...extra,
  }, { source_id: `mock-query-source-${query_seq}` });
}

test('P03 question resolution requires fresh task/version and a separate current-version review before P04', () => {
  const h = harness('spec-question-happy');
  runBasic(h, 'P01');
  h.add('step', 'P01', { state: 'SUCCEEDED' });
  runBasic(h, 'P02');
  h.add('step', 'P02', { state: 'SUCCEEDED' });
  runBasic(h, 'P03');
  let result = openQuestion(h, 1, 'mock:question:1');
  assert.equal(result.steps.P03.state, 'WAITING_HUMAN');
  assert.equal(result.status, 'WAITING_HUMAN');
  assert.equal(result.cycle, 1);
  assert.equal(result.steps.P03.attempt, 1);
  assert.equal(result.requirements_version, 'mock:requirements:v1');
  assert.equal(result.spec_review.question_id, 'mock:question:1');
  assert.equal(result.spec_review.task_id, taskId(1));
  assert.equal(result.spec_review.ordinal, 1);
  assert.equal(result.spec_review.requirements_version, 'mock:requirements:v1');
  assert.equal(result.spec_review.resolved_requirements_version, null);
  assert.equal(result.spec_review.resolved, false);
  assert.equal(result.spec_review.reviewed, false);

  const beforeDuplicate = result.ignored.length;
  result = openQuestion(h, 2, 'mock:question:2');
  assert.equal(result.spec_review.question_id, 'mock:question:1');
  assert.equal(result.ignored.length, beforeDuplicate + 1);

  result = resolveQuestion(h, { ordinal: 1, questionId: 'mock:question:1', complete: false });
  assert.equal(result.steps.P03.state, 'WAITING_HUMAN');
  assert.equal(result.requirements_version, 'mock:requirements:v1');
  assert.equal(result.spec_review.resolved, false);
  result = resolveQuestion(h, { ordinal: 1, questionId: 'mock:question:1' });
  assert.equal(result.steps.P03.state, 'READY');
  assert.equal(result.requirements_version, 'mock:requirements:v2');
  assert.equal(result.spec_review.resolved, true);
  assert.equal(result.spec_review.reviewed, false);

  result = h.add('step', 'P03', { state: 'RUNNING' });
  result = h.add('step', 'P03', { state: 'SUCCEEDED' });
  assert.equal(result.current_step, 'P03');
  assert.equal(result.steps.P03.state, 'RUNNING');
  assert.equal(result.ignored.at(-1)?.reason, 'spec_review_required');

  result = h.add('agent', 'P03', { status: 'completed' });
  assert.equal(result.spec_review.reviewed, false);
  result = h.add('spec_reviewed', 'P03', { actor: 'mock:spec-gen',
    candidate_fingerprint: result.candidate_fingerprint,
    requirements_version: 'mock:requirements:v2', evidence_id: 'mock:evidence:review-v2' });
  assert.equal(result.spec_review.reviewed, true);
  result = h.add('step', 'P03', { state: 'SUCCEEDED' });
  assert.equal(result.current_step, 'P04');
  assert.equal(result.steps.P03.state, 'SUCCEEDED');
  assert.equal(result.cycle, 1);
  assert.equal(result.steps.P03.attempt, 1);
  assert.equal(result.real_publish_allowed, false);
});

test('P03 rejects stale or reused question coordinates and preserves old question history', () => {
  const h = harness('spec-question-reject-stale');
  runBasic(h, 'P01'); h.add('step', 'P01', { state: 'SUCCEEDED' });
  runBasic(h, 'P02'); h.add('step', 'P02', { state: 'SUCCEEDED' });
  runBasic(h, 'P03');
  openQuestion(h, 1, 'mock:question:old');

  for (const bad of [
    { task: 'mock:task:P03:c1:a1:q2' },
    { actor: 'mock:someone-else' },
    { plan: 'mock:plan:old' },
    { candidate: 'mock:candidate:old' },
    { previousVersion: 'mock:requirements:old' },
    { nextVersion: 'mock:requirements:v1' },
  ]) {
    const before = h.current();
    const next = resolveQuestion(h, { ordinal: 1, questionId: 'mock:question:old', ...bad });
    assert.equal(next.steps.P03.state, 'WAITING_HUMAN');
    assert.equal(next.spec_review.resolved, false);
    assert.equal(next.requirements_version, before.requirements_version);
  }

  resolveQuestion(h, { ordinal: 1, questionId: 'mock:question:old' });
  h.add('step', 'P03', { state: 'RUNNING' });
  let result = openQuestion(h, 2, 'mock:question:new', 'mock:requirements:v2');
  const priorQuestionHistory = structuredClone(result.history.at(-1));
  assert.equal(result.spec_review.ordinal, 2);
  assert.equal(result.spec_review.task_id, taskId(2));
  assert.equal(result.spec_review.question_id, 'mock:question:new');
  assert.equal(result.history.at(-1).kind, 'spec_question');
  assert.equal(result.history.at(-1).spec_review.question_id, 'mock:question:old');
  assert.deepEqual(result.history.at(-1), priorQuestionHistory);
  result = resolveQuestion(h, { ordinal: 2, questionId: 'mock:question:new',
    previousVersion: 'mock:requirements:v2', nextVersion: 'mock:requirements:v3' });
  assert.equal(result.requirements_version, 'mock:requirements:v3');
  h.add('step', 'P03', { state: 'RUNNING' });
  h.add('spec_reviewed', 'P03', { actor: 'mock:spec-gen', candidate_fingerprint: h.current().candidate_fingerprint,
    requirements_version: 'mock:requirements:v3', evidence_id: 'mock:evidence:review-new' });
  h.add('step', 'P03', { state: 'SUCCEEDED' });
  assert.equal(h.current().current_step, 'P04');
  for (const id of fixedOrder.slice(fixedOrder.indexOf('P04'))) {
    if (id === 'P03') continue;
    const state = h.current().steps[id];
    if (state.state !== 'PENDING') continue;
    runNormalStep(h, id);
  }
  const completed = h.current();
  assert.equal(completed.current_step, 'END');
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.steps.P03.state, 'SUCCEEDED');
  assert.equal(completed.spec_review.question_id, 'mock:question:new');
  assert.equal(completed.spec_review.resolved, true);
  assert.equal(completed.spec_review.reviewed, true);
  assert.equal(completed.requirements_version, 'mock:requirements:v3');
  assert.equal(completed.history.some(entry => entry.kind === 'spec_question'
    && entry.spec_review.question_id === 'mock:question:old'), true);
  assert.equal(completed.release.publication_count, 1);
  assert.equal(completed.release.receipt_id, 'mock:receipt:baseline');
  assert.equal(completed.real_publish_allowed, false);
});

test('P03 open question blocks generic transitions and all noncurrent task coordinates', () => {
  const h = harness('spec-question-blocks-generic');
  runBasic(h, 'P01'); h.add('step', 'P01', { state: 'SUCCEEDED' });
  runBasic(h, 'P02'); h.add('step', 'P02', { state: 'SUCCEEDED' });
  runBasic(h, 'P03');
  openQuestion(h, 1, 'mock:question:blocked');
  const protectedQuestion = structuredClone(h.current().spec_review);
  const blocked = [
    ['step', { state: 'READY' }], ['step', { state: 'RUNNING' }], ['step', { state: 'SUCCEEDED' }],
    ['human', { actor: 'mock:human', task_id: taskId(1), plan_version: 'mock:plan:v1', evidence_id: 'mock:evidence:generic' }],
    ['infra_error', { now_ms: 1, operation: 'read' }], ['retry', { now_ms: 2 }],
    ['spec_unresolved', { question_id: 'mock:question:blocked', candidate_fingerprint: h.current().candidate_fingerprint,
      requirements_version: 'mock:requirements:v1', evidence_id: 'mock:evidence:duplicate-id' }],
    ['spec_unresolved', { question_id: 'mock:question:other', candidate_fingerprint: h.current().candidate_fingerprint,
      requirements_version: 'mock:requirements:v1', evidence_id: 'mock:evidence:duplicate-new-id' }],
    ['spec_resolution', { actor: 'mock:human', question_id: 'mock:question:wrong', task_id: taskId(1),
      plan_version: 'mock:plan:v1', candidate_fingerprint: h.current().candidate_fingerprint,
      requirements_version: 'mock:requirements:v1', resolved_requirements_version: 'mock:requirements:v2',
      complete: true, evidence_id: 'mock:evidence:wrong-question' }],
  ];
  for (const [type, payload] of blocked) {
    const result = h.add(type, 'P03', payload);
    assert.equal(result.steps.P03.state, 'WAITING_HUMAN', `${type} must not leave question wait`);
    assert.deepEqual(result.spec_review, protectedQuestion, `${type} must not change active question`);
  }
  for (const override of [
    { attempt: 2 }, { cycle: 2 }, { execution_id: 'mock:P03:c1:a2' },
  ]) {
    const result = h.add('spec_resolution', 'P03', {
      actor: 'mock:human', question_id: protectedQuestion.question_id, task_id: protectedQuestion.task_id,
      plan_version: 'mock:plan:v1', candidate_fingerprint: protectedQuestion.candidate_fingerprint,
      requirements_version: protectedQuestion.requirements_version,
      resolved_requirements_version: 'mock:requirements:v2', complete: true, evidence_id: 'mock:evidence:stale-coordinate',
    }, override);
    assert.equal(result.steps.P03.state, 'WAITING_HUMAN');
    assert.deepEqual(result.spec_review, protectedQuestion);
  }
});

test('P03 re-review rejects wrong actor/version and cannot reuse a prior requirements version or question ID', () => {
  const h = harness('spec-review-reject-old');
  runBasic(h, 'P01'); h.add('step', 'P01', { state: 'SUCCEEDED' });
  runBasic(h, 'P02'); h.add('step', 'P02', { state: 'SUCCEEDED' });
  runBasic(h, 'P03');
  openQuestion(h, 1, 'mock:question:one');
  resolveQuestion(h, { ordinal: 1, questionId: 'mock:question:one' });
  h.add('step', 'P03', { state: 'RUNNING' });
  const current = h.current();
  for (const payload of [
    { actor: 'mock:wrong-agent', candidate_fingerprint: current.candidate_fingerprint,
      requirements_version: 'mock:requirements:v2', evidence_id: 'mock:evidence:wrong-reviewer' },
    { actor: 'mock:spec-gen', candidate_fingerprint: current.candidate_fingerprint,
      requirements_version: 'mock:requirements:v1', evidence_id: 'mock:evidence:old-version-review' },
  ]) {
    const result = h.add('spec_reviewed', 'P03', payload);
    assert.equal(result.spec_review.reviewed, false);
  }
  openQuestion(h, 2, 'mock:question:two', 'mock:requirements:v2');
  const oldVersion = resolveQuestion(h, { ordinal: 2, questionId: 'mock:question:two',
    previousVersion: 'mock:requirements:v2', nextVersion: 'mock:requirements:v1',
    evidenceId: 'mock:evidence:reuse-old-version' });
  assert.equal(oldVersion.spec_review.resolved, false);
  assert.equal(oldVersion.requirements_version, 'mock:requirements:v2');
  const reusedId = h.add('spec_unresolved', 'P03', { question_id: 'mock:question:one',
    candidate_fingerprint: h.current().candidate_fingerprint,
    requirements_version: 'mock:requirements:v2', evidence_id: 'mock:evidence:reuse-old-question' });
  assert.equal(reusedId.spec_review.question_id, 'mock:question:two');
  assert.equal(reusedId.spec_review.ordinal, 2);
  resolveQuestion(h, { ordinal: 2, questionId: 'mock:question:two', previousVersion: 'mock:requirements:v2',
    nextVersion: 'mock:requirements:v3', evidenceId: 'mock:evidence:resolve-two' });
  h.add('step', 'P03', { state: 'RUNNING' });
  const reusedAfterResolution = h.add('spec_unresolved', 'P03', { question_id: 'mock:question:one',
    candidate_fingerprint: h.current().candidate_fingerprint,
    requirements_version: 'mock:requirements:v3', evidence_id: 'mock:evidence:reuse-old-after-resolve' });
  assert.equal(reusedAfterResolution.spec_review.question_id, 'mock:question:two');
  assert.equal(reusedAfterResolution.spec_review.ordinal, 2);
});

test('P03 resolved question cannot bypass re-review through infrastructure retry and a fresh execution', () => {
  const h = harness('spec-review-infra-bypass');
  runBasic(h, 'P01'); h.add('step', 'P01', { state: 'SUCCEEDED' });
  runBasic(h, 'P02'); h.add('step', 'P02', { state: 'SUCCEEDED' });
  runBasic(h, 'P03');
  openQuestion(h, 1, 'mock:question:retry');
  resolveQuestion(h, { ordinal: 1, questionId: 'mock:question:retry' });
  h.add('step', 'P03', { state: 'RUNNING' });
  const oldAttempt = h.current().steps.P03;
  let result = h.add('infra_error', 'P03', { now_ms: 1_000, operation: 'agent' });
  assert.equal(result.steps.P03.state, 'WAITING_RETRY');
  result = h.add('retry', 'P03', { now_ms: 11_000 });
  assert.equal(result.steps.P03.attempt, 2);
  assert.notEqual(result.steps.P03.execution_id, oldAttempt.execution_id);
  h.add('step', 'P03', { state: 'RUNNING' });
  result = h.add('step', 'P03', { state: 'SUCCEEDED' });
  assert.equal(result.current_step, 'P03', 'new attempt requires fresh spec_reviewed evidence before success');
  assert.equal(result.steps.P03.state, 'RUNNING');
  assert.equal(result.spec_review.resolved, true);
  assert.equal(result.spec_review.reviewed, false);
  result = h.add('spec_reviewed', 'P03', { actor: 'mock:spec-gen',
    candidate_fingerprint: result.candidate_fingerprint,
    requirements_version: result.requirements_version, evidence_id: 'mock:evidence:review-attempt-2' });
  assert.equal(result.spec_review.reviewed, true);
  assert.equal(result.spec_review.review_attempt, 2);
  assert.equal(result.spec_review.review_execution_id, result.steps.P03.execution_id);
  assert.equal(h.add('step', 'P03', { state: 'SUCCEEDED' }).current_step, 'P04');
});

test('P03 review and resolution evidence are bound to their attempt across infrastructure retry', () => {
  const h = harness('spec-review-bound-attempt');
  runBasic(h, 'P01'); h.add('step', 'P01', { state: 'SUCCEEDED' });
  runBasic(h, 'P02'); h.add('step', 'P02', { state: 'SUCCEEDED' });
  runBasic(h, 'P03');
  openQuestion(h, 1, 'mock:question:attempt-bound');
  resolveQuestion(h, { ordinal: 1, questionId: 'mock:question:attempt-bound' });
  h.add('step', 'P03', { state: 'RUNNING' });
  let result = h.add('spec_reviewed', 'P03', { actor: 'mock:spec-gen',
    candidate_fingerprint: h.current().candidate_fingerprint,
    requirements_version: 'mock:requirements:v2', evidence_id: 'mock:evidence:review-attempt-1' });
  assert.equal(result.spec_review.review_attempt, 1);
  const firstReviewExecution = result.spec_review.review_execution_id;

  h.add('infra_error', 'P03', { now_ms: 1_000, operation: 'agent' });
  result = h.add('retry', 'P03', { now_ms: 11_000 });
  assert.equal(result.steps.P03.attempt, 2);
  h.add('step', 'P03', { state: 'RUNNING' });
  assert.notEqual(h.current().steps.P03.execution_id, firstReviewExecution);
  const afterRetry = structuredClone(h.current().spec_review);

  // Old human answer coordinates/evidence cannot be submitted again for the retry.
  result = h.add('spec_resolution', 'P03', { actor: 'mock:human',
    question_id: 'mock:question:attempt-bound', task_id: taskId(1), plan_version: 'mock:plan:v1',
    candidate_fingerprint: h.current().candidate_fingerprint,
    requirements_version: 'mock:requirements:v1', resolved_requirements_version: 'mock:requirements:v3',
    complete: true, evidence_id: 'mock:evidence:resolution-1' });
  assert.equal(result.steps.P03.state, 'RUNNING');
  assert.equal(result.requirements_version, 'mock:requirements:v2');
  assert.deepEqual(result.spec_review, afterRetry);

  // Reusing question, answer, or review evidence is rejected on the new attempt.
  const trialState = h.current();
  for (const [index, evidence_id] of [
    'mock:evidence:question-1', 'mock:evidence:resolution-1',
    'mock:evidence:review-attempt-1',
  ].entries()) {
    const event = {
      event_id: `evt:${h.id}:trial${index}`, source_id: 'mock-exception-trial',
      source_seq: index + 1, type: 'spec_reviewed', mode: 'mock', job_id: trialState.job_id,
      step_id: 'P03', cycle: trialState.cycle, attempt: trialState.steps.P03.attempt,
      execution_id: trialState.steps.P03.execution_id,
      payload: { actor: 'mock:spec-gen', candidate_fingerprint: trialState.candidate_fingerprint,
        requirements_version: 'mock:requirements:v2', evidence_id },
    };
    const trial = replayScenario({ id: h.id, events: [...h.events, event] }, workflow, stateContract);
    assert.equal(trial.timeline.at(-1).applied, false, `${evidence_id} must not be reused as review evidence`);
    assert.equal(trial.spec_review.review_attempt, 1);
    assert.equal(trial.spec_review.review_execution_id, firstReviewExecution);
  }
  result = h.add('spec_reviewed', 'P03', { actor: 'mock:spec-gen',
    candidate_fingerprint: h.current().candidate_fingerprint,
    requirements_version: 'mock:requirements:v2', evidence_id: 'mock:evidence:review-attempt-2-fresh' });
  assert.equal(result.spec_review.reviewed, true);
  assert.equal(result.spec_review.review_attempt, 2);
  assert.equal(result.spec_review.review_execution_id, result.steps.P03.execution_id);
  assert.notEqual(result.spec_review.review_execution_id, firstReviewExecution);
  const archivedReview = result.history.find(row => row.kind === 'spec_review_attempt');
  assert.ok(archivedReview);
  assert.equal(archivedReview.spec_review.review_attempt, 1);
  assert.equal(archivedReview.spec_review.review_execution_id, firstReviewExecution);
  assert.equal(archivedReview.spec_review.review_evidence_id, 'mock:evidence:review-attempt-1');
  assert.equal(h.add('step', 'P03', { state: 'SUCCEEDED' }).current_step, 'P04');
});

test('P03 device quarantine retains the open question and resolution cannot clear quarantine', () => {
  const h = harness('spec-question-device-quarantine');
  runBasic(h, 'P01'); h.add('step', 'P01', { state: 'SUCCEEDED' });
  runBasic(h, 'P02'); h.add('step', 'P02', { state: 'SUCCEEDED' });
  runBasic(h, 'P03');
  openQuestion(h, 1, 'mock:question:device');
  const question = structuredClone(h.current().spec_review);
  let result = h.add('device', 'P03', { mode: 'mock', now_ms: 10, last_heartbeat_ms: 10,
    lease_expires_ms: 5, operation_state: 'active' });
  assert.equal(result.status, 'RECONCILING');
  assert.equal(result.device.quarantined, true);
  assert.deepEqual(result.spec_review, question);
  result = resolveQuestion(h, { ordinal: 1, questionId: 'mock:question:device' });
  assert.equal(result.steps.P03.state, 'WAITING_HUMAN');
  assert.deepEqual(result.spec_review, question);
});

test('P25 unknown result reconciles same operation key to one receipt without changing cycle or attempt', () => {
  const h = releaseHarness('remote-found');
  const before = structuredClone(h.current());
  const unknown = h.add('remote_unknown', 'P25', {
    ...remoteCoordinates(h), evidence_id: 'mock:evidence:remote-unknown',
  });
  assert.equal(unknown.steps.P25.state, 'RECONCILING');
  assert.equal(unknown.status, 'RECONCILING');
  assert.equal(unknown.cycle, before.cycle);
  assert.equal(unknown.steps.P25.attempt, before.steps.P25.attempt);
  assert.equal(unknown.release.receipt_id, null);
  assert.equal(unknown.release.publication_count, 0);
  assert.equal(unknown.release.approved, before.release.approved);
  assert.equal(unknown.real_publish_allowed, false);
  assert.equal(unknown.remote_reconciliation.operation_key, operationKey);

  let result = reconcile(h, 'unknown', 1);
  assert.equal(result.steps.P25.state, 'RECONCILING');
  assert.equal(result.remote_reconciliation.outcome, 'unknown');
  assert.equal(result.release.receipt_id, null);
  result = reconcile(h, 'found', 2);
  assert.equal(result.steps.P25.state, 'SUCCEEDED');
  assert.equal(result.current_step, 'P26');
  assert.equal(result.release.receipt_id, 'mock:receipt:remote-found');
  assert.equal(result.release.publication_count, 1);
  assert.equal(result.cycle, 1);
  assert.equal(result.steps.P25.attempt, 1);
  result = h.add('step', 'P26', { state: 'READY' });
  result = h.add('step', 'P26', { state: 'RUNNING' });
  result = h.add('step', 'P26', { state: 'SUCCEEDED' });
  assert.equal(result.current_step, 'END');
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.release.publication_count, 1);
  assert.equal(result.release.receipt_id, 'mock:receipt:remote-found');
});

test('P25 unknown, absent, and conflict stay reconciling until a newer same-key found observation', () => {
  for (const initialOutcome of ['unknown', 'absent', 'conflict']) {
    const h = releaseHarness(`remote-${initialOutcome}`);
    const beforeCycle = h.current().cycle;
    h.add('remote_unknown', 'P25', { ...remoteCoordinates(h), evidence_id: `mock:evidence:unknown-${initialOutcome}` });
    let result = reconcile(h, initialOutcome, 1);
    assert.equal(result.steps.P25.state, 'RECONCILING');
    assert.equal(result.remote_reconciliation.outcome, initialOutcome);
    assert.equal(result.remote_reconciliation.query_seq, 1);
    assert.equal(result.release.receipt_id, null);
    assert.equal(result.release.publication_count, 0);
    result = reconcile(h, 'found', 2);
    assert.equal(result.steps.P25.state, 'SUCCEEDED');
    assert.equal(result.current_step, 'P26');
    assert.equal(result.release.publication_count, 1);
    assert.equal(result.cycle, beforeCycle);
    assert.equal(result.steps.P25.attempt, 1);
  }
});

test('P25 rejects stale coordinates and query sequence regressions across sources', () => {
  const h = releaseHarness('remote-stale-coordinates');
  const valid = remoteCoordinates(h);
  h.add('remote_unknown', 'P25', { ...valid, evidence_id: 'mock:evidence:remote-unknown' });
  let result = reconcile(h, 'unknown', 5);
  const baseline = structuredClone(result.remote_reconciliation);
  for (const overrides of [
    { manifest_id: 'mock:manifest:stale' },
    { digest: 'mock:digest:stale' },
    { candidate_fingerprint: 'mock:candidate:stale' },
    { operation_key: 'mock:release-action:other' },
  ]) {
    result = reconcile(h, 'found', 6, overrides);
    assert.equal(result.steps.P25.state, 'RECONCILING');
    assert.equal(result.release.receipt_id, null);
    assert.deepEqual(result.remote_reconciliation, baseline);
  }
  result = reconcile(h, 'absent', 5);
  assert.deepEqual(result.remote_reconciliation, baseline);
  result = reconcile(h, 'absent', 4);
  assert.deepEqual(result.remote_reconciliation, baseline);
  result = reconcile(h, 'found', 6);
  assert.equal(result.steps.P25.state, 'SUCCEEDED');
  assert.equal(result.release.receipt_id, 'mock:receipt:remote-found');
});

test('generic P25 step, receipt, agent, retry, and a different operation cannot resolve remote uncertainty', () => {
  const h = releaseHarness('remote-no-generic-resolution');
  h.add('remote_unknown', 'P25', { ...remoteCoordinates(h), evidence_id: 'mock:evidence:remote-unknown' });
  const coords = remoteCoordinates(h);
  const receipt = { manifest_id: coords.manifest_id, digest: coords.digest,
    candidate_fingerprint: coords.candidate_fingerprint, receipt_id: 'mock:receipt:forged', observed: true };
  for (const [type, payload] of [
    ['step', { state: 'SUCCEEDED' }], ['agent', { status: 'completed' }],
    ['receipt', receipt], ['retry', { now_ms: 1000 }],
  ]) {
    const result = h.add(type, 'P25', payload);
    assert.equal(result.steps.P25.state, 'RECONCILING');
    assert.equal(result.current_step, 'P25');
    assert.equal(result.release.receipt_id, null);
    assert.equal(result.release.publication_count, 0);
  }
  let result = reconcile(h, 'found', 1, { operation_key: 'mock:release-action:different' });
  assert.equal(result.steps.P25.state, 'RECONCILING');
  assert.equal(result.release.receipt_id, null);
  result = reconcile(h, 'found', 1);
  assert.equal(result.steps.P25.state, 'SUCCEEDED');
  assert.equal(result.release.publication_count, 1);
});

test('P25 requires current approved manifest and strictly newer safe query sequence', () => {
  const h = releaseHarness('remote-invalid-observations');
  const coords = remoteCoordinates(h);
  const invalid = [
    { ...coords, manifest_id: 'mock:manifest:wrong' },
    { ...coords, digest: 'mock:digest:wrong' },
    { ...coords, candidate_fingerprint: 'mock:candidate:wrong' },
  ];
  for (const fields of invalid) {
    const result = h.add('remote_unknown', 'P25', { ...fields, evidence_id: `mock:evidence:unknown-invalid-${h.events.length}` });
    assert.equal(result.steps.P25.state, 'RUNNING');
    assert.equal(result.remote_reconciliation, null);
  }
  h.add('remote_unknown', 'P25', { ...coords, evidence_id: 'mock:evidence:unknown-valid' });
  for (const query_seq of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const result = reconcile(h, 'unknown', query_seq);
    assert.equal(result.steps.P25.state, 'RECONCILING');
    assert.equal(result.remote_reconciliation.query_seq, 0);
    assert.equal(result.remote_reconciliation.observations.length, 1);
  }
  const missingReceipt = h.add('remote_reconcile', 'P25', { ...coords,
    evidence_id: 'mock:evidence:found-no-receipt', query_seq: 1, outcome: 'found' });
  assert.equal(missingReceipt.steps.P25.state, 'RECONCILING');
  assert.equal(missingReceipt.release.receipt_id, null);
  const receiptOnNonFound = h.add('remote_reconcile', 'P25', { ...coords,
    evidence_id: 'mock:evidence:unknown-with-receipt', query_seq: 1, outcome: 'unknown',
    receipt_id: 'mock:receipt:unexpected' });
  assert.equal(receiptOnNonFound.steps.P25.state, 'RECONCILING');
  assert.equal(receiptOnNonFound.remote_reconciliation.query_seq, 0);
  const found = reconcile(h, 'found', 1);
  assert.equal(found.steps.P25.state, 'SUCCEEDED');
  assert.equal(found.release.publication_count, 1);
});

test('P25 does not replace an already-observed receipt and exact found duplicates remain idempotent', () => {
  const h = releaseHarness('remote-receipt-idempotency');
  const coords = remoteCoordinates(h);
  const receiptObserved = h.add('receipt', 'P25', { manifest_id: coords.manifest_id, digest: coords.digest,
    candidate_fingerprint: coords.candidate_fingerprint, receipt_id: 'mock:receipt:prior', observed: true });
  assert.equal(receiptObserved.steps.P25.state, 'RUNNING');
  assert.equal(receiptObserved.release.receipt_id, 'mock:receipt:prior');
  assert.equal(receiptObserved.release.publication_count, 1, 'an accepted receipt fact increments the observed publication count immediately');
  h.add('remote_unknown', 'P25', { ...coords, evidence_id: 'mock:evidence:remote-unknown' });
  const conflict = reconcile(h, 'found', 1);
  assert.equal(conflict.steps.P25.state, 'RECONCILING');
  assert.equal(conflict.release.receipt_id, 'mock:receipt:prior');
  assert.equal(conflict.release.publication_count, 1, 'a conflicting provider observation cannot erase an already accepted publication fact');
  const found = reconcile(h, 'found', 2, { receipt_id: 'mock:receipt:prior' });
  assert.equal(found.steps.P25.state, 'SUCCEEDED');
  assert.equal(found.release.receipt_id, 'mock:receipt:prior');
  assert.equal(found.release.publication_count, 1);
  const foundEvent = structuredClone(h.events.at(-1));
  h.events.push(foundEvent);
  const duplicate = h.current();
  assert.equal(duplicate.steps.P25.state, 'SUCCEEDED');
  assert.equal(duplicate.release.publication_count, 1);
  assert.equal(duplicate.release.receipt_id, 'mock:receipt:prior');
  assert.ok(duplicate.duplicate_count >= 1);
});

test('P25 device quarantine remains latched through idle telemetry and blocks remote found', () => {
  const h = releaseHarness('remote-device-quarantine');
  const coords = remoteCoordinates(h);
  h.add('remote_unknown', 'P25', { ...coords, evidence_id: 'mock:evidence:remote-unknown' });
  let result = h.add('device', 'P25', { mode: 'mock', now_ms: 100, last_heartbeat_ms: 100,
    lease_expires_ms: 50, operation_state: 'unknown' });
  assert.equal(result.status, 'RECONCILING');
  assert.equal(result.device.quarantined, true);
  result = h.add('device', 'P25', { mode: 'mock', now_ms: 101, last_heartbeat_ms: 101,
    lease_expires_ms: 200, operation_state: 'idle' });
  assert.equal(result.device.operation_state, 'idle');
  assert.equal(result.device.quarantined, true);
  assert.equal(result.status, 'RECONCILING');
  result = reconcile(h, 'found', 1);
  assert.equal(result.steps.P25.state, 'RECONCILING');
  assert.equal(result.release.receipt_id, null);
  assert.equal(result.release.publication_count, 0);
  assert.equal(result.remote_reconciliation.outcome, 'unknown');
});

test('unapproved release cannot be reconciled by injecting a P25 observation while X03 is waiting', () => {
  const h = harness('remote-without-approval');
  advanceBefore(h, 'X03');
  h.add('step', 'X03', { state: 'READY' });
  h.add('step', 'X03', { state: 'RUNNING' });
  h.add('step', 'X03', { state: 'WAITING_HUMAN' });
  const before = h.current();
  assert.equal(before.current_step, 'X03');
  assert.equal(before.release.approved, false);
  assert.ok(before.release.manifest);
  const manifest = before.release.manifest;
  const result = h.add('remote_unknown', 'P25', {
    manifest_id: manifest.manifest_id, digest: manifest.digest,
    candidate_fingerprint: manifest.candidate_fingerprint,
    operation_key: operationKey, evidence_id: 'mock:evidence:unapproved-remote',
  });
  assert.equal(result.current_step, 'X03');
  assert.equal(result.steps.X03.state, 'WAITING_HUMAN');
  assert.equal(result.steps.P25.state, 'PENDING');
  assert.equal(result.release.approved, false);
  assert.deepEqual(result.release.manifest, before.release.manifest);
  assert.equal(result.release.receipt_id, null);
  assert.equal(result.release.publication_count, 0);
  assert.equal(result.remote_reconciliation, null);
});

test('exception observation projections are frozen and never mutate input events or the canonical workflow', () => {
  const h = releaseHarness('remote-input-immutable');
  const payload = { ...remoteCoordinates(h), evidence_id: 'mock:evidence:remote-unknown' };
  const before = structuredClone({ payload, workflow });
  h.add('remote_unknown', 'P25', payload);
  const result = h.current();
  assert.deepEqual({ payload, workflow }, before);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.remote_reconciliation), true);
  assert.equal(Object.isFrozen(result.remote_reconciliation.observations), true);
  assert.equal(Object.isFrozen(result.history), true);
  assert.equal(result.real_publish_allowed, false);
});
