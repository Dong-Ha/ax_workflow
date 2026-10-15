import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createScenarioCatalog, replayScenario } from '../src/ifpmic/replay.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specs = path.join(root, 'docs/ifpmic/design-v1/specs');
const [workflow, stateContract] = await Promise.all([
  readFile(path.join(specs, 'workflow.v1.json'), 'utf8').then(JSON.parse),
  readFile(path.join(specs, 'state-contract.json'), 'utf8').then(JSON.parse),
]);
const catalog = createScenarioCatalog(workflow, stateContract);

function fixture(id, events) {
  return { id, title: `control cancel fixture ${id}`, requirement_ids: [], events };
}

function jobEvent(id, seq, type, payload, extra = {}) {
  return {
    event_id: `mock:${id}:control-event:${seq}`,
    source_id: `mock:${id}:control-source`,
    source_seq: seq,
    type,
    mode: 'mock',
    job_id: `mock:${id}`,
    payload,
    ...extra,
  };
}

function cancelCommand(id, key, expectedRevision) {
  return {
    command_id: `mock:${id}:cancel:${key}`,
    actor: 'mock:human',
    route: `/jobs/mock:${id}/controls`,
    idempotency_key: `mock:${id}:cancel-key:${key}`,
    authorization_ref: 'mock:authorization:owner-control:v1',
    csrf_ref: 'mock:csrf:validated:v1',
    body: { expected_revision: expectedRevision, action: 'cancel', reason: `mock:${id}:cancel-reason:${key}` },
  };
}

function submitCancel(id, seq, key, expectedRevision) {
  return jobEvent(id, seq, 'control_submitted', cancelCommand(id, key, expectedRevision));
}

function applyCancel(id, seq, key, observedNowMs = 1000) {
  return jobEvent(id, seq, 'control_apply', {
    command_id: `mock:${id}:cancel:${key}`,
    actor: 'mock:system',
    observed_now_ms: observedNowMs,
    evidence_id: `mock:${id}:cancel-apply:${key}`,
  });
}

function executionEnd(id, seq, commandId, spec, overrides = {}) {
  return jobEvent(id, seq, 'control_execution_end', {
    actor: 'mock:adapter',
    control_command_id: commandId,
    kind: spec.kind,
    step_id: spec.step_id,
    cycle: spec.cycle,
    attempt: spec.attempt,
    step_execution_id: spec.step_execution_id,
    agent_execution_id: spec.agent_execution_id,
    status: spec.status,
    prior_result_evidence_id: spec.prior_result_evidence_id ?? null,
    evidence_id: `mock:${id}:execution-end:${seq}`,
    ...overrides,
  });
}

function cancelBoundary(id, seq, commandId, {
  drained = [], executionResults = [], bridgeReconciliations = [], bridgeReleases = [], remoteTerminals = [],
} = {}, overrides = {}) {
  return jobEvent(id, seq, 'control_cancel_boundary', {
    command_id: commandId,
    actor: 'mock:system',
    fence_id: `mock:${id}:cancel-fence`,
    drained_request_ids: drained,
    execution_result_ids: executionResults,
    bridge_reconciliation_ids: bridgeReconciliations,
    bridge_release_ids: bridgeReleases,
    remote_terminal_ids: remoteTerminals,
    evidence_id: `mock:${id}:cancel-boundary:${seq}`,
    ...overrides,
  });
}

function cancelComplete(id, seq, commandId, boundaryEvidenceId, overrides = {}) {
  return jobEvent(id, seq, 'control_cancel_complete', {
    command_id: commandId,
    actor: 'mock:system',
    boundary_evidence_id: boundaryEvidenceId,
    evidence_id: `mock:${id}:cancel-complete:${seq}`,
    ...overrides,
  });
}

function requiredScenario(id) {
  const found = catalog.find(item => item.id === id);
  assert.ok(found, `fixed catalog fixture ${id} exists`);
  return found;
}

const logicalP01 = Object.freeze({
  kind: 'logical', step_id: 'P01', cycle: 1, attempt: 1,
  step_execution_id: 'mock:P01:c1:a1', agent_execution_id: 'mock:P01:c1:a1',
  status: 'completed', prior_result_evidence_id: null,
});

function runningP01Prefix() {
  const base = requiredScenario('happy-path');
  assert.equal(base.events.length, 134);
  const prefix = base.events.slice(0, 2);
  const before = replayScenario(fixture(base.id, prefix), workflow, stateContract);
  assert.equal(before.revision, 2);
  assert.equal(before.status, 'RUNNING');
  assert.equal(before.current_step, 'P01');
  assert.equal(before.steps.P01.state, 'RUNNING');
  return { id: base.id, prefix, revision: 2 };
}

function intentForP01(id, prefix, revision = 2) {
  const key = 'primary';
  return [
    ...prefix,
    submitCancel(id, 1, key, revision),
    applyCancel(id, 2, key),
  ];
}

test('logical cancel requires exact admitted execution end, explicit empty groups, fence, then canonical cancel edges', () => {
  const { id, prefix } = runningP01Prefix();
  const commandId = `mock:${id}:cancel:primary`;
  const ended = executionEnd(id, 3, commandId, logicalP01);
  const boundary = cancelBoundary(id, 4, commandId, { executionResults: [`mock:${id}:execution-end:3`] });
  const complete = cancelComplete(id, 5, commandId, `mock:${id}:cancel-boundary:4`);

  const early = replayScenario(fixture(id, [...intentForP01(id, prefix), boundary]), workflow, stateContract);
  assert.equal(early.control.phase, 'CANCEL_REQUESTED');
  assert.equal(early.status, 'RECONCILING');
  assert.equal(early.control.boundary, null);
  assert.equal(early.timeline.at(-1).applied, false);

  const result = replayScenario(fixture(id, [...intentForP01(id, prefix), ended, boundary, complete]), workflow, stateContract);
  assert.equal(result.control.phase, 'CANCELED');
  assert.equal(result.control.admission_open, false);
  assert.equal(result.status, 'CANCELED');
  assert.equal(result.current_step, 'P01');
  assert.equal(result.steps.P01.state, 'CANCELED');
  assert.equal(result.steps.P02.state, 'CANCELED');
  assert.equal(result.steps.END, undefined);
  assert.deepEqual(result.control.execution_ends.map(item => item.evidence_id), [`mock:${id}:execution-end:3`]);
  assert.deepEqual(result.control.boundary, {
    command_id: commandId, actor: 'mock:system', fence_id: `mock:${id}:cancel-fence`,
    drained_request_ids: [], execution_result_ids: [`mock:${id}:execution-end:3`],
    bridge_reconciliation_ids: [], bridge_release_ids: [], remote_terminal_ids: [],
    evidence_id: `mock:${id}:cancel-boundary:4`,
  });
});

test('wrong, unknown, or malformed end acknowledgements are atomic and cannot satisfy the admitted logical execution', () => {
  const { id, prefix } = runningP01Prefix();
  const commandId = `mock:${id}:cancel:primary`;
  const started = intentForP01(id, prefix);
  const wrong = [
    executionEnd(id, 3, commandId, logicalP01, { agent_execution_id: 'mock:P01:c1:other' }),
    executionEnd(id, 4, commandId, logicalP01, { status: 'succeeded' }),
    executionEnd(id, 5, commandId, logicalP01, { evidence_id: null }),
    executionEnd(id, 6, commandId, { ...logicalP01, kind: 'coordinator' }),
  ];
  const result = replayScenario(fixture(id, [...started, ...wrong]), workflow, stateContract);
  assert.equal(result.control.phase, 'CANCEL_REQUESTED');
  assert.equal(result.status, 'RECONCILING');
  assert.deepEqual(result.control.execution_ends, []);
  assert.equal(result.revision, 3);
  assert.ok(result.timeline.slice(-4).every(row => row.applied === false));

  const rejectedBoundary = replayScenario(fixture(id, [
    ...started,
    ...wrong,
    cancelBoundary(id, 7, commandId, { executionResults: ['mock:unknown:end'] }),
  ]), workflow, stateContract);
  assert.equal(rejectedBoundary.control.phase, 'CANCEL_REQUESTED');
  assert.equal(rejectedBoundary.control.boundary, null);
  assert.equal(rejectedBoundary.timeline.at(-1).applied, false);
});

test('a logical end fact is immutable across a fresh cancel command while the first intent is pending', () => {
  const { id, prefix } = runningP01Prefix();
  const first = `mock:${id}:cancel:primary`;
  const firstEnd = executionEnd(id, 3, first, logicalP01);
  const before = replayScenario(fixture(id, [...intentForP01(id, prefix), firstEnd]), workflow, stateContract);
  const firstEnds = structuredClone(before.control.execution_ends);
  assert.equal(firstEnds.length, 1);

  const result = replayScenario(fixture(id, [
    ...intentForP01(id, prefix), firstEnd,
    submitCancel(id, 4, 'second', before.revision),
    applyCancel(id, 5, 'second'),
  ]), workflow, stateContract);
  assert.deepEqual(result.control.execution_ends, firstEnds);
  assert.equal(result.control.command_id, first);
  assert.equal(result.control.phase, 'CANCEL_REQUESTED');
  assert.equal(result.control.commands.find(item => item.command_id === `mock:${id}:cancel:second`).status, 'applied');
  assert.deepEqual(result.control.applied_command_ids, [first, `mock:${id}:cancel:second`]);
});

test('cancel preserves already succeeded work and cancels the active and future steps without advancing the pointer', () => {
  const base = requiredScenario('happy-path');
  const prefix = base.events.slice(0, 6);
  const before = replayScenario(fixture(base.id, prefix), workflow, stateContract);
  assert.equal(before.revision, 6);
  assert.equal(before.current_step, 'P02');
  assert.equal(before.steps.P01.state, 'SUCCEEDED');
  assert.equal(before.steps.P02.state, 'RUNNING');
  const id = base.id;
  const commandId = `mock:${id}:cancel:preserve-terminal`;
  const active = {
    kind: 'logical', step_id: 'P02', cycle: 1, attempt: 1,
    step_execution_id: 'mock:P02:c1:a1', agent_execution_id: 'mock:P02:c1:a1',
    status: 'canceled', prior_result_evidence_id: null,
  };
  const events = [
    ...prefix,
    submitCancel(id, 1, 'preserve-terminal', 6), applyCancel(id, 2, 'preserve-terminal'),
    executionEnd(id, 3, commandId, active),
    cancelBoundary(id, 4, commandId, { executionResults: [`mock:${id}:execution-end:3`] }),
    cancelComplete(id, 5, commandId, `mock:${id}:cancel-boundary:4`),
  ];
  const result = replayScenario(fixture(id, events), workflow, stateContract);
  assert.equal(result.status, 'CANCELED');
  assert.equal(result.current_step, 'P02');
  assert.equal(result.steps.P01.state, 'SUCCEEDED');
  assert.equal(result.steps.P02.state, 'CANCELED');
  assert.equal(result.steps.P03.state, 'CANCELED');
  assert.equal(result.steps.P26.state, 'CANCELED');
  assert.equal(result.release.publication_count, 0);
});

test('unassigned P12 work must be explicitly drained; assignment after cancel is rejected and cannot create an execution', () => {
  const base = requiredScenario('agent-child-question');
  const prefix = base.events.slice(0, 57);
  const before = replayScenario(fixture(base.id, prefix), workflow, stateContract);
  assert.equal(before.revision, 57);
  assert.equal(before.current_step, 'P12');
  assert.equal(before.steps.P12.state, 'RUNNING');
  assert.equal(before.steps.P12.child_coordination.requests[0].assignment, null);
  const id = base.id;
  const requestId = 'mock:agent-child-question:ch:request:c1:a1';
  const commandId = `mock:${id}:cancel:pending-dispatch`;
  const coordinatorEnd = executionEnd(id, 3, commandId, {
    kind: 'coordinator', step_id: 'P12', cycle: 1, attempt: 1,
    step_execution_id: 'mock:P12:c1:a1',
    agent_execution_id: 'mock:agent-child-question:ch:parent-exec:c1:a1',
    status: 'canceled', prior_result_evidence_id: null,
  });
  const noDrain = cancelBoundary(id, 4, commandId, {
    executionResults: [`mock:${id}:execution-end:3`],
  });
  const accepted = replayScenario(fixture(id, [
    ...prefix, submitCancel(id, 1, 'pending-dispatch', 57), applyCancel(id, 2, 'pending-dispatch'), coordinatorEnd, noDrain,
  ]), workflow, stateContract);
  assert.equal(accepted.control.phase, 'CANCEL_REQUESTED');
  assert.equal(accepted.control.boundary, null);
  assert.equal(accepted.timeline.at(-1).applied, false);

  const assignment = base.events[57];
  const withDrain = replayScenario(fixture(id, [
    ...prefix, submitCancel(id, 1, 'pending-dispatch', 57), applyCancel(id, 2, 'pending-dispatch'),
    coordinatorEnd,
    cancelBoundary(id, 4, commandId, {
      drained: [requestId], executionResults: [`mock:${id}:execution-end:3`],
    }),
    assignment,
    cancelComplete(id, 5, commandId, `mock:${id}:cancel-boundary:4`),
  ]), workflow, stateContract);
  assert.equal(withDrain.control.phase, 'CANCELED');
  assert.equal(withDrain.status, 'CANCELED');
  assert.equal(withDrain.steps.P12.state, 'CANCELED');
  assert.equal(withDrain.steps.P12.child_coordination.requests[0].assignment, null);
  assert.equal(withDrain.control.execution_ends.length, 1);
  assert.equal(withDrain.timeline.at(-2).applied, false);
});

test('typed child result during cancellation is bound to both end acknowledgements but never collected into the parent', () => {
  const base = requiredScenario('agent-child-question');
  const prefix = base.events.slice(0, 58);
  const before = replayScenario(fixture(base.id, prefix), workflow, stateContract);
  assert.equal(before.revision, 58);
  assert.equal(before.steps.P12.state, 'WAITING_AGENT');
  const p12Before = structuredClone(before.steps.P12);
  const p12AfterCancel = { ...p12Before, state: 'CANCELED' };
  const id = base.id;
  const commandId = `mock:${id}:cancel:child-result`;
  const childExecutionId = 'mock:agent-child-question:ch:exec:c1:a1';
  const coordinatorExecutionId = 'mock:agent-child-question:ch:parent-exec:c1:a1';
  const childResult = base.events[58];
  const coordinatorEnd = executionEnd(id, 3, commandId, {
    kind: 'coordinator', step_id: 'P12', cycle: 1, attempt: 1,
    step_execution_id: 'mock:P12:c1:a1', agent_execution_id: coordinatorExecutionId,
    status: 'canceled', prior_result_evidence_id: null,
  });
  const childEnd = executionEnd(id, 4, commandId, {
    kind: 'child', step_id: 'P12', cycle: 1, attempt: 1,
    step_execution_id: 'mock:P12:c1:a1', agent_execution_id: childExecutionId,
    status: 'needs_human', prior_result_evidence_id: 'mock:agent-child-question:ch:result-proof:c1:a1',
  });
  const result = replayScenario(fixture(id, [
    ...prefix,
    submitCancel(id, 1, 'child-result', 58), applyCancel(id, 2, 'child-result'),
    childResult, coordinatorEnd, childEnd,
    cancelBoundary(id, 5, commandId, {
      executionResults: [`mock:${id}:execution-end:3`, `mock:${id}:execution-end:4`],
    }),
    cancelComplete(id, 6, commandId, `mock:${id}:cancel-boundary:5`),
  ]), workflow, stateContract);

  assert.equal(result.control.phase, 'CANCELED');
  assert.equal(result.status, 'CANCELED');
  assert.equal(result.current_step, 'P12');
  assert.deepEqual(result.steps.P12, p12AfterCancel);
  assert.ok(result.control.facts.some(fact => fact.type === 'child_result'
    && fact.payload.evidence_id === 'mock:agent-child-question:ch:result-proof:c1:a1'));
  assert.equal(result.control.reconciliation_required, false);
  assert.equal(result.steps.P12.child_coordination.requests[0].result, null);
  assert.equal(result.steps.P12.child_coordination.requests[0].collection, null);
  assert.equal(result.release.publication_count, 0);
});

test('a contradictory known child result arriving after final cancel is journaled and flags reconciliation without reopening the job', () => {
  const base = requiredScenario('agent-child-canceled');
  const prefix = base.events.slice(0, 58);
  const before = replayScenario(fixture(base.id, prefix), workflow, stateContract);
  const p12Before = structuredClone(before.steps.P12);
  const p12AfterCancel = { ...p12Before, state: 'CANCELED' };
  const id = base.id;
  const commandId = `mock:${id}:cancel:late-conflict`;
  const canceledResult = base.events[58];
  const coordinatorEnd = executionEnd(id, 3, commandId, {
    kind: 'coordinator', step_id: 'P12', cycle: 1, attempt: 1,
    step_execution_id: 'mock:P12:c1:a1', agent_execution_id: 'mock:agent-child-canceled:ch:parent-exec:c1:a1',
    status: 'canceled', prior_result_evidence_id: null,
  });
  const childEnd = executionEnd(id, 4, commandId, {
    kind: 'child', step_id: 'P12', cycle: 1, attempt: 1,
    step_execution_id: 'mock:P12:c1:a1', agent_execution_id: 'mock:agent-child-canceled:ch:exec:c1:a1',
    status: 'canceled', prior_result_evidence_id: 'mock:agent-child-canceled:ch:result-proof:c1:a1',
  });
  const lateConflict = {
    ...canceledResult,
    event_id: `mock:${id}:late-child-completed-after-cancel`,
    source_seq: 5,
    payload: {
      ...canceledResult.payload,
      status: 'completed',
      patch_artifact_id: 'mock:agent-child-canceled:ch:patch:c1:a1',
      changed_path_refs: ['mock:path:tests:unit'],
      failure_class: null,
      evidence_id: 'mock:agent-child-canceled:ch:late-completed-result-proof:c1:a1',
    },
  };
  const result = replayScenario(fixture(id, [
    ...prefix,
    submitCancel(id, 1, 'late-conflict', 58), applyCancel(id, 2, 'late-conflict'),
    canceledResult,
    coordinatorEnd, childEnd,
    cancelBoundary(id, 5, commandId, {
      executionResults: [`mock:${id}:execution-end:3`, `mock:${id}:execution-end:4`],
    }),
    cancelComplete(id, 6, commandId, `mock:${id}:cancel-boundary:5`),
    lateConflict,
  ]), workflow, stateContract);
  assert.equal(result.status, 'CANCELED');
  assert.equal(result.control.phase, 'CANCELED');
  assert.equal(result.control.admission_open, false);
  assert.equal(result.control.reconciliation_required, true);
  assert.deepEqual(result.steps.P12, p12AfterCancel);
  assert.ok(result.control.facts.some(fact => fact.type === 'child_result'
    && fact.payload.evidence_id === 'mock:agent-child-canceled:ch:late-completed-result-proof:c1:a1'));
});

test('canceling released notes preserves the failed P26 attempt and the already published receipt', () => {
  const base = requiredScenario('notes-only');
  const prefix = base.events.slice(0, 133);
  const before = replayScenario(fixture(base.id, prefix), workflow, stateContract);
  assert.equal(before.revision, 132);
  assert.equal(before.status, 'RELEASED_PENDING_NOTES');
  assert.equal(before.current_step, 'P26');
  assert.equal(before.steps.P26.state, 'FAILED');
  assert.equal(before.release.publication_count, 1);
  const failedP26 = structuredClone(before.steps.P26);
  const id = base.id;
  const commandId = `mock:${id}:cancel:released-notes`;
  const result = replayScenario(fixture(id, [
    ...prefix,
    submitCancel(id, 1, 'released-notes', 132), applyCancel(id, 2, 'released-notes'),
    cancelBoundary(id, 3, commandId),
    cancelComplete(id, 4, commandId, `mock:${id}:cancel-boundary:3`),
  ]), workflow, stateContract);
  assert.equal(result.control.phase, 'CANCELED');
  assert.equal(result.status, 'CANCELED');
  assert.equal(result.steps.P26.state, 'FAILED');
  assert.deepEqual(result.steps.P26, failedP26);
  assert.equal(result.release.publication_count, 1);
  assert.equal(result.current_step, 'P26');
});
