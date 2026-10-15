import test from 'node:test';
import assert from 'node:assert/strict';
import { childPayloadFields } from '../src/ifpmic/children.mjs';
import {
  makeChildrenHarness, baseChildContext, coordinatorPayload, requestPayload,
  assignmentPayload, resultPayload, collectPayload, integratedPayload,
} from './helpers/ifpmic-children.mjs';

const TYPES = ['p12_coordinator', 'child_request', 'child_assignment', 'child_result', 'child_collect', 'child_answer', 'child_recovery', 'child_integrated'];
const latest = h => h.current().steps.P12.child_coordination;
const last = h => h.current().timeline.at(-1);
const expectedPayloadFields = {
  p12_coordinator: ['actor', 'role', 'purpose', 'coordinator_task_id', 'coordinator_execution_id', 'candidate_fingerprint', 'requirements_version', 'p11_execution_id', 'code_artifact_id', 'production_hash', 'tc_design_artifact_id', 'workspace_id', 'write_scope', 'runtime_profile_ref', 'evidence_id'],
  child_request: ['actor', 'coordinator_task_id', 'coordinator_execution_id', 'request_id', 'child_task_id', 'ordinal', 'child_role', 'candidate_fingerprint', 'requirements_version', 'workspace_id', 'write_scope', 'runtime_profile_ref', 'output_schema_ref', 'code_artifact_id', 'tc_design_artifact_id', 'prior_child_execution_id', 'checkpoint_artifact_id', 'answer_evidence_id', 'answer_artifact_id', 'evidence_id'],
  child_assignment: ['actor', 'coordinator_task_id', 'coordinator_execution_id', 'request_id', 'child_task_id', 'child_execution_id', 'candidate_fingerprint', 'requirements_version', 'workspace_id', 'evidence_id'],
  child_result: ['actor', 'coordinator_task_id', 'coordinator_execution_id', 'request_id', 'child_task_id', 'child_execution_id', 'candidate_fingerprint', 'requirements_version', 'workspace_id', 'status', 'output_schema_ref', 'patch_artifact_id', 'changed_path_refs', 'production_hash', 'question_id', 'checkpoint_artifact_id', 'failure_class', 'started_at_ms', 'finished_at_ms', 'evidence_id'],
  child_collect: ['actor', 'coordinator_task_id', 'coordinator_execution_id', 'child_execution_id', 'result_evidence_id', 'candidate_fingerprint', 'requirements_version', 'evidence_id'],
  child_answer: ['actor', 'coordinator_task_id', 'coordinator_execution_id', 'child_execution_id', 'task_id', 'question_id', 'answer_artifact_id', 'checkpoint_artifact_id', 'candidate_fingerprint', 'requirements_version', 'evidence_id'],
  child_recovery: ['actor', 'coordinator_task_id', 'coordinator_execution_id', 'child_execution_id', 'task_id', 'result_evidence_id', 'action', 'reason_id', 'candidate_fingerprint', 'requirements_version', 'evidence_id'],
  child_integrated: ['actor', 'coordinator_task_id', 'coordinator_execution_id', 'child_execution_id', 'result_evidence_id', 'patch_artifact_id', 'candidate_fingerprint', 'requirements_version', 'production_hash_before', 'production_hash_after', 'changed_path_refs', 'expectations_changed', 'outcome', 'integration_artifact_id', 'evidence_id'],
};
const business = h => {
  const r = h.current();
  return Object.fromEntries(['mode', 'job_id', 'scenario_id', 'status', 'current_step', 'cycle', 'rework_count',
    'candidate_fingerprint', 'requirements_version', 'rule_version', 'wait_reason', 'real_publish_allowed',
    'device', 'release', 'route_plan', 'no_change', 'spec_review', 'remote_reconciliation',
    'failure_bundle', 'required_revalidation', 'steps', 'history'].map(key => [key, r[key]]));
};
function prepare(h) {
  if (h.current().current_step !== 'P12') h.reachP12();
  if (h.current().steps.P12.state === 'READY') h.add('step', 'P12', { state: 'RUNNING' });
  const context = baseChildContext(h);
  h.add('p12_coordinator', 'P12', coordinatorPayload(h, context));
  h.add('child_request', 'P12', requestPayload(h, context));
  h.add('child_assignment', 'P12', assignmentPayload(h, context));
  return context;
}

test('child event schema is fixed to the eight declared protocol types', () => {
  assert.deepEqual(Object.keys(childPayloadFields).sort(), [...TYPES].sort());
  assert.equal(Object.isFrozen(childPayloadFields), true);
  for (const type of TYPES) {
    assert.deepEqual(childPayloadFields[type], expectedPayloadFields[type], `${type} exact fixed field list`);
    assert.equal(Object.isFrozen(childPayloadFields[type]), true);
    assert.ok(childPayloadFields[type].includes('evidence_id'), type);
  }
});

test('P12 coordinator, request, assignment, result, collection and integration are distinct ordered observations', () => {
  const h = makeChildrenHarness('ordered');
  const before = h.reachP12();
  assert.equal(before.current_step, 'P12');
  assert.equal(before.steps.P12.state, 'RUNNING');
  const context = prepare(h);
  let r = h.current();
  assert.equal(r.steps.P12.state, 'WAITING_AGENT');
  assert.equal(r.steps.P12.child_coordination.status, 'WAITING_AGENT');
  assert.equal(r.steps.P12.child_coordination.requests[0].assignment.child_execution_id, context.child_execution_id);
  assert.equal(r.steps.P12.child_coordination.requests[0].result, null);

  h.add('child_result', 'P12', resultPayload(h, context));
  r = h.current();
  assert.equal(r.steps.P12.state, 'WAITING_AGENT');
  assert.equal(r.steps.P12.child_coordination.requests[0].result.status, 'completed');
  h.add('child_collect', 'P12', collectPayload(h, context));
  r = h.current();
  assert.equal(r.steps.P12.state, 'RUNNING');
  assert.equal(r.steps.P12.child_coordination.status, 'RUNNING');
  assert.equal(r.steps.P12.gate_verdict, null);

  h.add('child_integrated', 'P12', integratedPayload(h, context));
  r = h.current();
  assert.equal(r.steps.P12.child_coordination.status, 'COMPLETED');
  assert.equal(r.steps.P12.state, 'RUNNING');
  assert.equal(r.steps.P12.gate_verdict, null);
  h.add('step', 'P12', { state: 'SUCCEEDED' });
  r = h.current();
  assert.equal(r.steps.P12.state, 'SUCCEEDED');
  assert.equal(r.current_step, 'P13');
  assert.equal(r.real_publish_allowed, false);
});

test('generic WAITING_AGENT, agent completion, and human submission cannot bypass child protocol', () => {
  const h = makeChildrenHarness('bypass');
  h.reachP12();
  h.add('step', 'P12', { state: 'WAITING_AGENT' });
  assert.equal(h.current().steps.P12.state, 'RUNNING');
  assert.equal(last(h).applied, false);
  const projection = business(h);
  h.add('agent', 'P12', { status: 'completed' });
  assert.deepEqual(business(h), projection);
  h.add('human', 'P12', { actor: 'mock:human', task_id: 'mock:task:P12:c1', plan_version: 'mock:plan:v1', evidence_id: 'mock:bypass-human' });
  assert.deepEqual(business(h), projection);
  assert.equal(last(h).applied, false);
});

test('generic P12 SUCCEEDED is blocked at every incomplete child boundary and allowed only after integration', () => {
  const cases = [
    ['without coordinator', h => h.reachP12()],
    ['after coordinator only', h => { h.reachP12(); prepareCoordinatorOnly(h); }],
    ['after request only', h => { h.reachP12(); const c = prepareCoordinatorOnly(h); h.add('child_request', 'P12', requestPayload(h, c)); }],
    ['after assignment', h => prepare(h)],
    ['after returned result', h => { const c = prepare(h); h.add('child_result', 'P12', resultPayload(h, c)); }],
    ['after collection', h => { const c = prepare(h); const p = resultPayload(h, c); h.add('child_result', 'P12', p); h.add('child_collect', 'P12', collectPayload(h, c, p.evidence_id)); }],
    ['after integration conflict', h => { const c = prepare(h); const p = resultPayload(h, c); h.add('child_result', 'P12', p); h.add('child_collect', 'P12', collectPayload(h, c, p.evidence_id)); h.add('child_integrated', 'P12', integratedPayload(h, c, { outcome: 'conflict', integration_artifact_id: null, evidence_id: 'mock:children:gate:conflict' })); }],
  ];
  for (const [label, setup] of cases) {
    const h = makeChildrenHarness(`success-guard-${label.replaceAll(' ', '-')}`);
    setup(h);
    const before = business(h);
    h.add('step', 'P12', { state: 'SUCCEEDED' });
    assert.deepEqual(business(h), before, `${label} leaves the complete business projection unchanged`);
    assert.equal(last(h).applied, false, `${label} success attempt is rejected`);
  }
});

test('coordinator and child request reject wrong role, scope, shared workspace, extra keys and stale binding atomically', () => {
  const invalidCoordinators = [
    { role: 'tc' }, { write_scope: 'production' }, { extra: 'unexpected' },
    { candidate_fingerprint: 'mock:candidate:stale' },
  ];
  for (const [i, override] of invalidCoordinators.entries()) {
    const h = makeChildrenHarness(`bad-coordinator-${i}`);
    h.reachP12();
    const p = baseChildContext(h);
    const before = business(h);
    h.add('p12_coordinator', 'P12', coordinatorPayload(h, p, override));
    assert.deepEqual(business(h), before);
    assert.equal(last(h).applied, false);
  }

  const invalidRequests = [
    { child_role: 'code-dev' }, { write_scope: 'tests_and_product' },
    { workspace_id: '__coordinator_workspace__' },
    { ordinal: 2 }, { extra: 'unexpected' }, { requirements_version: 'mock:requirements:old' },
  ];
  for (const [i, override] of invalidRequests.entries()) {
    const h = makeChildrenHarness(`bad-request-${i}`);
    h.reachP12();
    const p = prepareCoordinatorOnly(h);
    const before = business(h);
    const actualOverride = override.workspace_id === '__coordinator_workspace__'
      ? { ...override, workspace_id: p.coordinator_workspace_id }
      : override;
    h.add('child_request', 'P12', requestPayload(h, p, actualOverride));
    assert.deepEqual(business(h), before);
    assert.equal(last(h).applied, false);
  }
});

function prepareCoordinatorOnly(h) {
  const p = baseChildContext(h);
  h.add('p12_coordinator', 'P12', coordinatorPayload(h, p));
  return p;
}

test('needs_human creates a distinct human task; exact answer and checkpoint are required before ordinal-two resume', () => {
  const h = makeChildrenHarness('question');
  const context = prepare(h);
  h.add('child_result', 'P12', resultPayload(h, context, 'needs_human'));
  let r = h.current();
  assert.equal(last(h).applied, true, last(h).reason);
  assert.equal(r.steps.P12.state, 'WAITING_AGENT');
  assert.equal(r.status, 'WAITING_HUMAN');
  h.add('child_collect', 'P12', collectPayload(h, context, resultPayload(h, context, 'needs_human').evidence_id));
  r = h.current();
  const coordination = r.steps.P12.child_coordination;
  const request = coordination.requests[0];
  const task = coordination.human_task;
  assert.equal(r.steps.P12.state, 'WAITING_HUMAN');
  assert.equal(task.kind, 'agent_question');
  assert.equal(task.assignee, 'mock:human');
  assert.equal(task.task_id, `mock:child-human:${context.child_execution_id}`);

  const prior = business(h);
  h.add('child_answer', 'P12', {
    actor: 'mock:human', coordinator_task_id: context.coordinator_task_id,
    coordinator_execution_id: context.coordinator_execution_id, child_execution_id: context.child_execution_id,
    task_id: task.task_id, question_id: request.result.question_id, answer_artifact_id: 'mock:answer:wrong',
    checkpoint_artifact_id: 'mock:checkpoint:wrong', candidate_fingerprint: r.candidate_fingerprint,
    requirements_version: r.requirements_version, evidence_id: 'mock:children:question:bad-answer',
  });
  assert.deepEqual(business(h), prior);
  assert.equal(last(h).applied, false);

  h.add('child_answer', 'P12', {
    actor: 'mock:human', coordinator_task_id: context.coordinator_task_id,
    coordinator_execution_id: context.coordinator_execution_id, child_execution_id: context.child_execution_id,
    task_id: task.task_id, question_id: request.result.question_id, answer_artifact_id: 'mock:answer:question:1',
    checkpoint_artifact_id: request.result.checkpoint_artifact_id, candidate_fingerprint: r.candidate_fingerprint,
    requirements_version: r.requirements_version, evidence_id: 'mock:children:question:good-answer',
  });
  assert.equal(h.current().steps.P12.state, 'WAITING_HUMAN');
  h.add('step', 'P12', { state: 'READY' });
  h.add('step', 'P12', { state: 'RUNNING' });
  const resumed = h.current();
  const answeredRequest = resumed.steps.P12.child_coordination.requests[0];
  const p2 = {
    ...context, ...{
      request_id: 'mock:children:question:request:c1:a1:o2',
      child_execution_id: 'mock:children:question:tc-exec:c1:a1:o2',
    },
  };
  h.add('child_request', 'P12', requestPayload(h, p2, {
    ordinal: 2, request_id: p2.request_id, child_task_id: request.child_task_id,
    prior_child_execution_id: context.child_execution_id,
    checkpoint_artifact_id: request.result.checkpoint_artifact_id,
    answer_evidence_id: answeredRequest.answer.evidence_id,
    answer_artifact_id: answeredRequest.answer.answer_artifact_id,
    evidence_id: 'mock:children:question:request:o2',
  }));
  h.add('child_assignment', 'P12', assignmentPayload(h, p2, {
    child_execution_id: p2.child_execution_id, evidence_id: 'mock:children:question:assignment:o2',
  }));
  const after = h.current();
  assert.equal(after.steps.P12.state, 'WAITING_AGENT');
  assert.equal(after.steps.P12.attempt, 1);
  assert.equal(after.steps.P12.child_coordination.requests.length, 2);
  assert.equal(after.steps.P12.child_coordination.requests[0].result.status, 'needs_human');
  assert.equal(after.steps.P12.child_coordination.requests[0].answer.evidence_id, 'mock:children:question:good-answer');
  assert.equal(resumed.steps.P12.child_coordination.requests[0].result.status, 'needs_human');
});

test('failed child must be collected and use original infrastructure backoff before a fresh attempt', () => {
  const h = makeChildrenHarness('retry');
  const old = prepare(h);
  const failed = resultPayload(h, old, 'failed');
  h.add('child_result', 'P12', failed);
  h.add('child_collect', 'P12', collectPayload(h, old, failed.evidence_id));
  assert.equal(h.current().steps.P12.state, 'RUNNING');
  h.add('infra_error', 'P12', { operation: 'agent', now_ms: 1000 });
  let r = h.current();
  assert.equal(r.steps.P12.state, 'WAITING_RETRY');
  assert.equal(r.steps.P12.retry_due_ms, 11000);
  assert.equal(r.steps.P12.child_coordination.status, 'FAILED');
  h.add('retry', 'P12', { now_ms: 10999 });
  assert.equal(h.current().steps.P12.state, 'WAITING_RETRY');
  h.add('retry', 'P12', { now_ms: 11000 });
  r = h.current();
  assert.equal(r.steps.P12.state, 'READY');
  assert.equal(r.steps.P12.attempt, 2);
  assert.equal(r.steps.P12.execution_id, 'mock:P12:c1:a2');
  assert.equal(r.history.at(-1).kind, 'attempt');
  assert.equal(r.history.at(-1).step.child_coordination.requests[0].result.status, 'failed');
  const next = baseChildContext(h);
  assert.notEqual(next.coordinator_execution_id, old.coordinator_execution_id);
  assert.notEqual(next.child_task_id, old.child_task_id);
  h.add('step', 'P12', { state: 'RUNNING' });
  h.add('p12_coordinator', 'P12', coordinatorPayload(h, next));
  const request2 = requestPayload(h, next);
  const beforeReuse = business(h);
  h.add('child_request', 'P12', requestPayload(h, next, {
    request_id: old.request_id, child_task_id: old.child_task_id,
    evidence_id: 'mock:children:retry:reused-request-evidence',
  }));
  assert.deepEqual(business(h), beforeReuse, 'request/task identity from prior P12 attempt cannot be reused');
  assert.equal(last(h).applied, false);
  h.add('child_request', 'P12', request2);
  assert.equal(last(h).applied, true);
  const requestBeforeReuse = business(h);
  h.add('child_assignment', 'P12', assignmentPayload(h, next, { child_execution_id: old.child_execution_id }));
  assert.deepEqual(business(h), requestBeforeReuse, 'a child execution from the prior P12 attempt cannot be reassigned');
  assert.equal(last(h).applied, false);
  h.add('child_assignment', 'P12', assignmentPayload(h, next));
  assert.equal(h.current().steps.P12.state, 'WAITING_AGENT');
  assert.equal(h.current().steps.P12.child_coordination.requests.length, 1);
});

test('child result schema rejects malformed output without consuming the current request', () => {
  const h = makeChildrenHarness('result-schema');
  const context = prepare(h);
  const valid = resultPayload(h, context);
  const before = business(h);
  h.add('child_result', 'P12', { ...valid, production_hash: 'mock:hash:production:changed' });
  assert.deepEqual(business(h), before);
  assert.equal(last(h).applied, false);
  h.add('child_result', 'P12', { ...valid, unexpected: 'not-allowlisted' });
  assert.deepEqual(business(h), before);
  assert.equal(last(h).applied, false);
  h.add('child_result', 'P12', valid);
  assert.equal(last(h).applied, true);
  assert.equal(h.current().steps.P12.child_coordination.requests[0].result.evidence_id, valid.evidence_id);
});

test('integration conflict remains visible and blocks success until a distinct valid receipt resolves it', () => {
  const h = makeChildrenHarness('integration-conflict');
  const context = prepare(h);
  const childResult = resultPayload(h, context);
  h.add('child_result', 'P12', childResult);
  h.add('child_collect', 'P12', collectPayload(h, context, childResult.evidence_id));
  h.add('child_integrated', 'P12', integratedPayload(h, context, {
    outcome: 'conflict', integration_artifact_id: null,
    evidence_id: 'mock:children:integration-conflict:conflict-proof',
  }));
  let r = h.current();
  assert.equal(r.steps.P12.state, 'RUNNING');
  assert.equal(r.steps.P12.child_coordination.status, 'RUNNING');
  assert.equal(r.steps.P12.child_coordination.requests[0].conflicts.length, 1);
  h.add('step', 'P12', { state: 'SUCCEEDED' });
  assert.equal(last(h).applied, false);
  assert.equal(h.current().steps.P12.state, 'RUNNING');
  h.add('child_integrated', 'P12', integratedPayload(h, context, {
    outcome: 'integrated', evidence_id: 'mock:children:integration-conflict:resolved-proof',
    integration_artifact_id: 'mock:children:integration-conflict:resolved-artifact',
  }));
  r = h.current();
  assert.equal(r.steps.P12.child_coordination.requests[0].conflicts.length, 1);
  assert.equal(r.steps.P12.child_coordination.requests[0].integration.outcome, 'integrated');
  h.add('step', 'P12', { state: 'SUCCEEDED' });
  assert.equal(h.current().steps.P12.state, 'SUCCEEDED');
});

test('interrupted child is not silently retried and remains blocked without its matching recovery task', () => {
  const h = makeChildrenHarness('interrupted-child');
  const context = prepare(h);
  const interrupted = resultPayload(h, context, 'interrupted');
  h.add('child_result', 'P12', interrupted);
  h.add('child_collect', 'P12', collectPayload(h, context, interrupted.evidence_id));
  const r = h.current();
  assert.equal(r.status, 'WAITING_HUMAN');
  assert.equal(r.steps.P12.state, 'WAITING_HUMAN');
  assert.equal(r.steps.P12.child_coordination.human_task.kind, 'agent_recovery');
  const before = business(h);
  h.add('step', 'P12', { state: 'READY' });
  assert.deepEqual(business(h), before);
  h.add('infra_error', 'P12', { operation: 'agent', now_ms: 1000 });
  assert.deepEqual(business(h), before);
  assert.equal(last(h).applied, false);
});

test('sticky device quarantine permits a bound child result observation but blocks collection and preserves reconciliation', () => {
  const h = makeChildrenHarness('child-quarantine');
  const context = prepare(h);
  h.add('device', 'P12', { mode: 'mock', now_ms: 5000, last_heartbeat_ms: 0, lease_expires_ms: 60000, operation_state: 'unknown' });
  let r = h.current();
  assert.equal(r.status, 'RECONCILING');
  assert.equal(r.device.quarantined, true);
  const result = resultPayload(h, context);
  h.add('child_result', 'P12', result);
  r = h.current();
  assert.equal(last(h).applied, true, 'the exact already-assigned terminal observation can be recorded');
  assert.equal(r.status, 'RECONCILING');
  assert.equal(r.device.quarantined, true);
  assert.equal(r.steps.P12.state, 'WAITING_AGENT');
  const beforeCollect = business(h);
  h.add('child_collect', 'P12', collectPayload(h, context, result.evidence_id));
  assert.deepEqual(business(h), beforeCollect);
  assert.equal(last(h).applied, false);
});

test('old cycle and wrong attempt/job envelopes cannot release a current assigned child', () => {
  const h = makeChildrenHarness('stale-envelope');
  const context = prepare(h);
  const result = resultPayload(h, context);
  for (const overrides of [
    { cycle: 0 }, { cycle: 2 }, { attempt: 2 }, { job_id: 'mock:other-job' },
    { execution_id: 'mock:P12:c1:a2' },
  ]) {
    const before = business(h);
    h.add('child_result', 'P12', result, overrides);
    assert.deepEqual(business(h), before, `stale event envelope ${JSON.stringify(overrides)} cannot alter child state`);
    assert.equal(last(h).applied, false);
  }
  h.add('child_result', 'P12', result);
  assert.equal(last(h).applied, true, 'rejected envelope aliases did not consume the valid proof ID');
  assert.equal(h.current().steps.P12.child_coordination.requests[0].result.evidence_id, result.evidence_id);
});

test('opaque coordinator and completed child IDs accept 128 characters and reject 129 without truncation', () => {
  const accepted = makeChildrenHarness('child-id-boundary');
  accepted.reachP12();
  const context = baseChildContext(accepted);
  const maxCoordinatorTask = `mock:${'a'.repeat(123)}`;
  const maxChildExecution = `mock:${'b'.repeat(123)}`;
  context.coordinator_task_id = maxCoordinatorTask;
  context.child_task_id = `mock:${'c'.repeat(123)}`;
  context.child_execution_id = maxChildExecution;
  accepted.add('p12_coordinator', 'P12', coordinatorPayload(accepted, context, { coordinator_task_id: maxCoordinatorTask }));
  assert.equal(last(accepted).applied, true);
  accepted.add('child_request', 'P12', requestPayload(accepted, context));
  assert.equal(last(accepted).applied, true);
  accepted.add('child_assignment', 'P12', assignmentPayload(accepted, context, { child_execution_id: maxChildExecution }));
  assert.equal(last(accepted).applied, true);
  const terminal = resultPayload(accepted, context, 'completed', {
    child_execution_id: maxChildExecution, patch_artifact_id: `mock:${'d'.repeat(123)}`,
  });
  accepted.add('child_result', 'P12', terminal);
  assert.equal(last(accepted).applied, true);
  assert.equal(accepted.current().steps.P12.child_coordination.requests[0].assignment.child_execution_id, maxChildExecution);
  assert.equal(accepted.current().steps.P12.child_coordination.requests[0].result.patch_artifact_id, terminal.patch_artifact_id);

  const rejected = makeChildrenHarness('child-id-boundary-reject');
  rejected.reachP12();
  const context129 = baseChildContext(rejected);
  rejected.add('p12_coordinator', 'P12', coordinatorPayload(rejected, context129, {
    coordinator_task_id: `mock:${'a'.repeat(124)}`,
  }));
  assert.equal(last(rejected).applied, false);
  assert.equal(rejected.current().steps.P12.child_coordination, null);
});

function childEventFixture(type, id) {
  const h = makeChildrenHarness(`schema-${id}`);
  h.reachP12();
  const context = baseChildContext(h);
  if (type === 'p12_coordinator') return { h, context, payload: coordinatorPayload(h, context) };
  h.add('p12_coordinator', 'P12', coordinatorPayload(h, context));
  if (type === 'child_request') return { h, context, payload: requestPayload(h, context) };
  h.add('child_request', 'P12', requestPayload(h, context));
  if (type === 'child_assignment') return { h, context, payload: assignmentPayload(h, context) };
  h.add('child_assignment', 'P12', assignmentPayload(h, context));
  const status = type === 'child_answer' ? 'needs_human' : type === 'child_recovery' ? 'canceled' : 'completed';
  const result = resultPayload(h, context, status);
  if (type === 'child_result') return { h, context, payload: result };
  h.add('child_result', 'P12', result);
  if (type === 'child_collect') return { h, context, payload: collectPayload(h, context, result.evidence_id) };
  h.add('child_collect', 'P12', collectPayload(h, context, result.evidence_id));
  const current = h.current();
  const row = current.steps.P12.child_coordination.requests[0];
  const common = {
    actor: type === 'child_answer' || type === 'child_recovery' ? 'mock:human' : 'mock:code-dev',
    coordinator_task_id: context.coordinator_task_id, coordinator_execution_id: context.coordinator_execution_id,
    child_execution_id: context.child_execution_id, candidate_fingerprint: current.candidate_fingerprint,
    requirements_version: current.requirements_version,
  };
  if (type === 'child_answer') return { h, context, payload: {
    ...common, task_id: current.steps.P12.child_coordination.human_task.task_id,
    question_id: row.result.question_id, answer_artifact_id: 'mock:schema:answer',
    checkpoint_artifact_id: row.result.checkpoint_artifact_id, evidence_id: 'mock:schema:answer-proof',
  } };
  if (type === 'child_recovery') return { h, context, payload: {
    ...common, task_id: current.steps.P12.child_coordination.human_task.task_id,
    result_evidence_id: row.result.evidence_id, action: 'retry', reason_id: 'mock:schema:recovery-reason',
    evidence_id: 'mock:schema:recovery-proof',
  } };
  const complete = resultPayload(h, context);
  return { h, context, payload: {
    actor: 'mock:code-dev', coordinator_task_id: context.coordinator_task_id,
    coordinator_execution_id: context.coordinator_execution_id, child_execution_id: context.child_execution_id,
    result_evidence_id: row.result.evidence_id, patch_artifact_id: row.result.patch_artifact_id,
    candidate_fingerprint: current.candidate_fingerprint, requirements_version: current.requirements_version,
    production_hash_before: context.production_hash, production_hash_after: context.production_hash,
    changed_path_refs: [...complete.changed_path_refs], expectations_changed: false, outcome: 'integrated',
    integration_artifact_id: 'mock:schema:integration-artifact', evidence_id: 'mock:schema:integration-proof',
  } };
}

test('every child event type rejects a missing required field and unknown extra field atomically', () => {
  const missingByType = {
    p12_coordinator: 'coordinator_execution_id', child_request: 'request_id', child_assignment: 'child_execution_id',
    child_result: 'status', child_collect: 'result_evidence_id', child_answer: 'task_id', child_recovery: 'reason_id',
    child_integrated: 'outcome',
  };
  for (const type of TYPES) {
    for (const mutate of [
      payload => { delete payload[missingByType[type]]; },
      payload => { payload.unexpected_field = 'mock:extra'; },
    ]) {
      const { h, payload } = childEventFixture(type, `${type}-required-field`);
      const before = business(h);
      const invalid = structuredClone(payload);
      mutate(invalid);
      h.add(type, 'P12', invalid);
      assert.deepEqual(business(h), before, `${type} malformed schema leaves state/history intact`);
      assert.equal(last(h).applied, false, `${type} malformed schema is rejected`);
      h.add(type, 'P12', payload);
      assert.equal(last(h).applied, true, `${type} rejected proof did not reserve valid evidence IDs`);
    }
  }
});

test('all eight event types reject representative null for required identifiers or enums', () => {
  const nullByType = {
    p12_coordinator: 'coordinator_task_id', child_request: 'workspace_id', child_assignment: 'child_execution_id',
    child_result: 'status', child_collect: 'result_evidence_id', child_answer: 'task_id', child_recovery: 'action',
    child_integrated: 'outcome',
  };
  for (const type of TYPES) {
    const { h, payload } = childEventFixture(type, `null-${type}`);
    const before = business(h);
    h.add(type, 'P12', { ...payload, [nullByType[type]]: null });
    assert.deepEqual(business(h), before, `${type} null required value changes no business projection`);
    assert.equal(last(h).applied, false, `${type} null required value rejected`);
  }
});

test('child result timestamps and changed-path allowlist reject negative, fractional, unsafe, reversed, duplicate and production values', () => {
  const invalid = [
    { started_at_ms: -1 }, { started_at_ms: 1.5 }, { started_at_ms: Number.MAX_SAFE_INTEGER + 1 },
    { started_at_ms: Number.NaN }, { started_at_ms: Number.POSITIVE_INFINITY },
    { finished_at_ms: -1 }, { finished_at_ms: 1.5 }, { finished_at_ms: Number.MAX_SAFE_INTEGER + 1 },
    { finished_at_ms: Number.NaN }, { finished_at_ms: Number.POSITIVE_INFINITY },
    { started_at_ms: 3000, finished_at_ms: 2000 },
    { changed_path_refs: ['mock:path:tests:unit', 'mock:path:tests:unit'] },
    { changed_path_refs: ['mock:path:production'] },
  ];
  for (const [index, override] of invalid.entries()) {
    const h = makeChildrenHarness(`result-boundary-${index}`);
    const context = prepare(h);
    const before = business(h);
    h.add('child_result', 'P12', resultPayload(h, context, 'completed', override));
    assert.deepEqual(business(h), before, `invalid child result ${index} is atomic`);
    assert.equal(last(h).applied, false, `invalid child result ${index} rejected`);
  }
  for (const [index, mutate] of [
    payload => { delete payload.started_at_ms; },
    payload => { delete payload.finished_at_ms; },
    payload => { payload.started_at_ms = null; },
    payload => { payload.finished_at_ms = null; },
  ].entries()) {
    const h = makeChildrenHarness(`result-time-presence-${index}`);
    const c = prepare(h);
    const malformed = resultPayload(h, c);
    mutate(malformed);
    const before = business(h);
    h.add('child_result', 'P12', malformed);
    assert.deepEqual(business(h), before, `timestamp presence/null case ${index} is atomic`);
    assert.equal(last(h).applied, false);
  }
  const maxSafe = makeChildrenHarness('result-max-safe-time');
  const context = prepare(maxSafe);
  const accepted = resultPayload(maxSafe, context, 'completed', { started_at_ms: Number.MAX_SAFE_INTEGER, finished_at_ms: Number.MAX_SAFE_INTEGER });
  maxSafe.add('child_result', 'P12', accepted);
  assert.equal(last(maxSafe).applied, true, 'the exact safe-integer timestamp boundary remains valid');
});

test('evidence IDs remain reserved across a new child request and duplicate integration receipts cannot mint authority', () => {
  const h = makeChildrenHarness('child-evidence-reuse');
  h.reachP12();
  const context = prepareCoordinatorOnly(h);
  const request = requestPayload(h, context);
  const before = business(h);
  h.add('child_request', 'P12', { ...request, evidence_id: context.evidence_id });
  assert.deepEqual(business(h), before);
  assert.equal(last(h).applied, false);
  h.add('child_request', 'P12', request);
  assert.equal(last(h).applied, true);
  h.add('child_assignment', 'P12', assignmentPayload(h, context));
  const result = resultPayload(h, context);
  h.add('child_result', 'P12', result);
  h.add('child_collect', 'P12', collectPayload(h, context, result.evidence_id));
  const receipt = integratedPayload(h, context);
  h.add('child_integrated', 'P12', receipt);
  assert.equal(last(h).applied, true);
  const afterFirst = business(h);
  h.add('child_integrated', 'P12', { ...receipt, evidence_id: 'mock:children:child-evidence-reuse:second-receipt' });
  assert.deepEqual(business(h), afterFirst);
  assert.equal(last(h).applied, false);
  assert.equal(h.current().steps.P12.child_coordination.requests[0].integration.evidence_id, receipt.evidence_id);
});

test('child observations enforce source watermarks and both deduplication aliases without poisoning independent sources', () => {
  const h = makeChildrenHarness('child-source-watermark');
  const c = prepare(h);
  const result = resultPayload(h, c);
  const base = { source_id: 'mock:source:result-primary', source_seq: 10, event_id: 'mock:event:result-primary' };
  h.add('child_result', 'P12', result, base);
  assert.equal(last(h).applied, true);
  const counts = () => [h.current().duplicate_count, h.current().conflict_count];
  h.add('child_result', 'P12', result, { source_id: 'mock:source:result-alias', source_seq: 1, event_id: base.event_id });
  assert.deepEqual(counts(), [1, 0], 'same event ID on a fresh source sequence is a duplicate');
  h.add('child_result', 'P12', result, { ...base, event_id: 'mock:event:result-sequence-alias' });
  assert.deepEqual(counts(), [2, 0], 'same source/sequence on a fresh event ID is a duplicate');
  h.add('child_result', 'P12', { ...result, status: 'failed', failure_class: 'agent_failure' }, {
    source_id: base.source_id, source_seq: 11, event_id: base.event_id,
  });
  assert.deepEqual(counts(), [3, 1], 'a conflicting alias is recorded without replacing the accepted result');
  const beforeCollection = business(h);
  h.add('child_collect', 'P12', collectPayload(h, c, result.evidence_id), {
    source_id: 'mock:source:independent-collector', source_seq: 1,
  });
  assert.equal(last(h).applied, true, 'lower sequence from an independent source is valid');
  assert.notDeepEqual(business(h), beforeCollection);

  const h2 = makeChildrenHarness('child-source-stale');
  const c2 = prepare(h2);
  const result2 = resultPayload(h2, c2);
  h2.add('child_result', 'P12', result2, { source_id: 'mock:source:ordered', source_seq: 10 });
  const collection = collectPayload(h2, c2, result2.evidence_id);
  const beforeStale = business(h2);
  h2.add('child_collect', 'P12', collection, { source_id: 'mock:source:ordered', source_seq: 9 });
  assert.deepEqual(business(h2), beforeStale, 'older sequence from same source is rejected atomically');
  assert.equal(last(h2).reason, 'stale_source_sequence');
  h2.add('child_collect', 'P12', collection, { source_id: 'mock:source:ordered', source_seq: 11 });
  assert.equal(last(h2).applied, true, 'rejected sequence does not advance the accepted watermark');
});

test('malformed high-sequence child observation does not poison a fresh lower sequence', () => {
  const h = makeChildrenHarness('child-watermark-reject');
  h.reachP12();
  const c = baseChildContext(h);
  const valid = coordinatorPayload(h, c);
  const before = business(h);
  h.add('p12_coordinator', 'P12', { ...valid, role: 'tc' }, { source_id: 'mock:source:corrected', source_seq: 999 });
  assert.deepEqual(business(h), before);
  assert.equal(last(h).applied, false);
  h.add('p12_coordinator', 'P12', valid, { source_id: 'mock:source:corrected', source_seq: 1 });
  assert.equal(last(h).applied, true, 'only accepted events advance a source watermark');
});

test('derived human task ID exactly at 128 is preserved, while a 129-character task cannot be created', () => {
  for (const [status, prefix] of [['needs_human', 'mock:child-human:'], ['canceled', 'mock:child-recovery:'], ['interrupted', 'mock:child-recovery:']]) {
    for (const taskLength of [128, 129]) {
      const id = `${status}-${taskLength}`;
      const h = makeChildrenHarness(`derived-id-${id}`);
      h.reachP12();
      const context = baseChildContext(h);
      const childLength = taskLength - prefix.length;
      context.child_execution_id = `mock:${'x'.repeat(childLength - 5)}`;
      h.add('p12_coordinator', 'P12', coordinatorPayload(h, context));
      h.add('child_request', 'P12', requestPayload(h, context));
      h.add('child_assignment', 'P12', assignmentPayload(h, context));
      const childResult = resultPayload(h, context, status);
      const before = business(h);
      h.add('child_result', 'P12', childResult);
      assert.equal(last(h).applied, taskLength === 128, `${status} derived task length ${taskLength}`);
      if (taskLength === 128) {
        h.add('child_collect', 'P12', collectPayload(h, context, childResult.evidence_id));
        assert.equal(h.current().steps.P12.child_coordination.human_task.task_id.length, 128);
      } else {
        assert.deepEqual(business(h), before, `${status} derived task 129 rejection changes no business state`);
        assert.equal(h.current().steps.P12.child_coordination.requests[0].result, null);
      }
    }
  }
});

test('child infrastructure attempts retain their history and enforce the original 10s/30s/three-attempt limit', () => {
  const h = makeChildrenHarness('child-retry-limit');
  h.reachP12();
  let now = 1000;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const context = prepare(h);
    const failed = resultPayload(h, context, 'failed');
    h.add('child_result', 'P12', failed);
    h.add('child_collect', 'P12', collectPayload(h, context, failed.evidence_id));
    h.add('infra_error', 'P12', { operation: 'agent', now_ms: now });
    const step = h.current().steps.P12;
    if (attempt < 3) {
      const delay = attempt === 1 ? 10000 : 30000;
      assert.equal(step.state, 'WAITING_RETRY');
      assert.equal(step.retry_due_ms, now + delay);
      h.add('retry', 'P12', { now_ms: now + delay - 1 });
      assert.equal(last(h).applied, false);
      h.add('retry', 'P12', { now_ms: now + delay });
      assert.equal(last(h).applied, true);
      assert.equal(h.current().steps.P12.attempt, attempt + 1);
      now += delay;
    } else {
      assert.equal(step.state, 'WAITING_HUMAN');
      assert.equal(step.retry_due_ms, null);
      assert.equal(h.current().failure_bundle.length > 0, true);
    }
  }
  const final = h.current();
  assert.equal(final.steps.P12.attempt, 3);
  assert.equal(final.steps.P12.child_coordination.status, 'FAILED');
  assert.deepEqual(final.history.filter(row => row.kind === 'attempt').map(row => row.step.attempt), [1, 2]);
  h.add('retry', 'P12', { now_ms: now + 100000 });
  assert.equal(last(h).applied, false);
  assert.equal(h.current().steps.P12.attempt, 3);
});

test('canceled child is not job cancellation and requires exact human recovery before retry', () => {
  const h = makeChildrenHarness('cancelled-child');
  const context = prepare(h);
  const canceled = resultPayload(h, context, 'canceled');
  h.add('child_result', 'P12', canceled);
  h.add('child_collect', 'P12', collectPayload(h, context, canceled.evidence_id));
  let r = h.current();
  const task = r.steps.P12.child_coordination.human_task;
  assert.equal(r.status, 'WAITING_HUMAN');
  assert.equal(r.steps.P12.state, 'WAITING_HUMAN');
  assert.equal(r.steps.P12.child_coordination.requests[0].result.status, 'canceled');
  const before = business(h);
  h.add('infra_error', 'P12', { operation: 'agent', now_ms: 1000 });
  assert.deepEqual(business(h), before);
  h.add('child_recovery', 'P12', {
    actor: 'mock:human', coordinator_task_id: context.coordinator_task_id,
    coordinator_execution_id: context.coordinator_execution_id, child_execution_id: context.child_execution_id,
    task_id: task.task_id, result_evidence_id: canceled.evidence_id, action: 'retry', reason_id: 'mock:reason:recover-child',
    candidate_fingerprint: r.candidate_fingerprint, requirements_version: r.requirements_version,
    evidence_id: 'mock:children:cancelled-child:recovery',
  });
  h.add('step', 'P12', { state: 'READY' });
  h.add('step', 'P12', { state: 'RUNNING' });
  h.add('infra_error', 'P12', { operation: 'agent', now_ms: 1000 });
  r = h.current();
  assert.equal(r.steps.P12.state, 'WAITING_RETRY');
  assert.equal(r.status, 'RUNNING');
  assert.equal(r.steps.P12.child_coordination.status, 'FAILED');
});

test('unassigned request cannot be recovered as infrastructure failure or coexist with a second writer', () => {
  const h = makeChildrenHarness('single-writer');
  h.reachP12();
  const context = prepareCoordinatorOnly(h);
  h.add('child_request', 'P12', requestPayload(h, context));
  const before = business(h);
  h.add('infra_error', 'P12', { operation: 'agent', now_ms: 1000 });
  assert.deepEqual(business(h), before);
  const duplicate = requestPayload(h, context, {
    request_id: 'mock:children:single-writer:request:second',
    child_task_id: 'mock:children:single-writer:task:second',
    evidence_id: 'mock:children:single-writer:request:second-proof',
  });
  h.add('child_request', 'P12', duplicate);
  assert.deepEqual(business(h), before);
  assert.equal(last(h).applied, false);
});
