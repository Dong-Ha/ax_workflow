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

function fixture(id, events) { return { id, title: `control boundary ${id}`, requirement_ids: [], events }; }
function jobEvent(id, source, seq, type, payload) {
  return { event_id: `mock:${id}:${source}:event:${seq}`, source_id: `mock:${id}:${source}`,
    source_seq: seq, type, mode: 'mock', job_id: `mock:${id}`, payload };
}
function stepEvent(id, source, seq, stepId, attempt, state) {
  return { event_id: `mock:${id}:${source}:event:${seq}`, source_id: `mock:${id}:${source}`,
    source_seq: seq, type: 'step', mode: 'mock', job_id: `mock:${id}`, step_id: stepId,
    cycle: 1, attempt, execution_id: `mock:${stepId}:c1:a${attempt}`, payload: { state } };
}
function command(id, key, action, expectedRevision) {
  return { command_id: `mock:${id}:command:${key}`, actor: 'mock:human', route: `/jobs/mock:${id}/controls`,
    idempotency_key: `mock:${id}:key:${key}`, authorization_ref: 'mock:authorization:owner-control:v1',
    csrf_ref: 'mock:csrf:validated:v1', body: { expected_revision: expectedRevision, action, reason: `mock:${id}:reason:${key}` } };
}
function submit(id, seq, key, action, revision) {
  return jobEvent(id, 'controls', seq, 'control_submitted', command(id, key, action, revision));
}
function apply(id, seq, key, now, evidence = `mock:${id}:apply:${key}`) {
  return jobEvent(id, 'controls', seq, 'control_apply', { command_id: `mock:${id}:command:${key}`,
    actor: 'mock:system', observed_now_ms: now, evidence_id: evidence });
}
function domain(result) {
  const { timeline, ignored, duplicate_count, conflict_count, ...projection } = result;
  return projection;
}
function businessDomain(result) {
  const projection = structuredClone(domain(result));
  if (projection.control) projection.control.commands = [];
  return projection;
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
function retryWait() {
  const source = catalog.find(item => item.id === 'retry-limit');
  assert.ok(source, 'literal retry-limit catalog fixture exists');
  const events = source.events.slice(0, 66);
  const snapshot = replayScenario(fixture(source.id, events), workflow, stateContract);
  assert.equal(events.length, 66);
  assert.equal(snapshot.revision, 65);
  assert.equal(snapshot.current_step, 'P13');
  assert.equal(snapshot.steps.P13.state, 'WAITING_RETRY');
  assert.equal(snapshot.steps.P13.attempt, 1);
  assert.equal(snapshot.steps.P13.retry_due_ms, 10_000);
  return { id: source.id, events, snapshot };
}

test('control.retry honors the 10-second first retry boundary and the fixed 30-second next delay', () => {
  const { id, events, snapshot } = retryWait();
  const firstCmd = 'retry-first';
  const beforeFirst = replayScenario(fixture(id, [
    ...events, submit(id, 1, firstCmd, 'retry', snapshot.revision), apply(id, 2, firstCmd, 9_999),
  ]), workflow, stateContract);
  assert.equal(beforeFirst.steps.P13.state, 'WAITING_RETRY');
  assert.equal(beforeFirst.steps.P13.attempt, 1);
  assert.equal(beforeFirst.steps.P13.retry_due_ms, 10_000);
  assert.equal(beforeFirst.control.commands.at(-1).status, 'rejected');
  assert.equal(beforeFirst.control.commands.at(-1).error.code, 'CONTROL_INELIGIBLE');

  const atFirstDue = replayScenario(fixture(id, [
    ...events, submit(id, 1, firstCmd, 'retry', snapshot.revision), apply(id, 2, firstCmd, 10_000),
  ]), workflow, stateContract);
  assert.equal(atFirstDue.steps.P13.state, 'READY');
  assert.equal(atFirstDue.steps.P13.attempt, 2);
  assert.equal(atFirstDue.steps.P13.retry_due_ms, null);
  assert.equal(atFirstDue.history.at(-1).kind, 'attempt');
  assert.equal(atFirstDue.history.at(-1).step.attempt, 1);
  assert.equal(atFirstDue.control.commands.at(-1).status, 'applied');

  const afterFirstDue = replayScenario(fixture(id, [
    ...events, submit(id, 1, firstCmd, 'retry', snapshot.revision), apply(id, 2, firstCmd, 10_001),
  ]), workflow, stateContract);
  assert.equal(afterFirstDue.steps.P13.state, 'READY');
  assert.equal(afterFirstDue.steps.P13.attempt, 2);

  const secondFailure = structuredClone(catalog.find(item => item.id === 'retry-limit').events[69]);
  const secondAttempt = [
    ...events, submit(id, 1, firstCmd, 'retry', snapshot.revision), apply(id, 2, firstCmd, 10_000),
    structuredClone(catalog.find(item => item.id === 'retry-limit').events[68]), secondFailure,
  ];
  const waitingSecond = replayScenario(fixture(id, secondAttempt), workflow, stateContract);
  assert.equal(waitingSecond.revision, 68);
  assert.equal(waitingSecond.steps.P13.state, 'WAITING_RETRY');
  assert.equal(waitingSecond.steps.P13.attempt, 2);
  assert.equal(waitingSecond.steps.P13.retry_due_ms, 40_000, 'the next infrastructure delay is 30 seconds');

  const secondCmd = 'retry-second';
  const beforeSecond = replayScenario(fixture(id, [
    ...secondAttempt, submit(id, 3, secondCmd, 'retry', waitingSecond.revision), apply(id, 4, secondCmd, 39_999),
  ]), workflow, stateContract);
  assert.equal(beforeSecond.steps.P13.state, 'WAITING_RETRY');
  assert.equal(beforeSecond.steps.P13.attempt, 2);
  assert.equal(beforeSecond.steps.P13.retry_due_ms, 40_000);
  assert.equal(beforeSecond.control.commands.at(-1).status, 'rejected');

  const atSecondDue = replayScenario(fixture(id, [
    ...secondAttempt, submit(id, 3, secondCmd, 'retry', waitingSecond.revision), apply(id, 4, secondCmd, 40_000),
  ]), workflow, stateContract);
  assert.equal(atSecondDue.steps.P13.state, 'READY');
  assert.equal(atSecondDue.steps.P13.attempt, 3);
  assert.equal(atSecondDue.steps.P13.retry_due_ms, null);
  assert.equal(atSecondDue.control.commands.at(-1).status, 'applied');
});

test('infrastructure retry caps at three attempts and rejects attempt four without changing work state', () => {
  const { id, events, snapshot } = retryWait();
  const first = [
    ...events,
    submit(id, 1, 'retry1', 'retry', snapshot.revision), apply(id, 2, 'retry1', 10_000),
    structuredClone(catalog.find(item => item.id === 'retry-limit').events[68]),
    structuredClone(catalog.find(item => item.id === 'retry-limit').events[69]),
    submit(id, 3, 'retry2', 'retry', 68), apply(id, 4, 'retry2', 40_000),
    structuredClone(catalog.find(item => item.id === 'retry-limit').events[72]),
    structuredClone(catalog.find(item => item.id === 'retry-limit').events[73]),
  ];
  const thirdFailure = replayScenario(fixture(id, first), workflow, stateContract);
  assert.equal(thirdFailure.steps.P13.attempt, 3);
  assert.equal(thirdFailure.steps.P13.state, 'WAITING_HUMAN');
  assert.equal(thirdFailure.steps.P13.retry_due_ms, null);
  assert.equal(thirdFailure.steps.P13.infrastructure_error, true);
  assert.equal(thirdFailure.wait_reason, 'infrastructure_attempt_limit');
  const before = businessDomain(thirdFailure);
  const fourth = replayScenario(fixture(id, [
    ...first, submit(id, 5, 'retry4', 'retry', thirdFailure.revision), apply(id, 6, 'retry4', 70_000),
  ]), workflow, stateContract);
  assert.equal(fourth.steps.P13.state, 'WAITING_HUMAN');
  assert.equal(fourth.steps.P13.attempt, 3);
  assert.equal(fourth.steps.P13.retry_due_ms, null);
  assert.equal(fourth.control.commands.at(-1).status, 'rejected');
  assert.equal(fourth.control.commands.at(-1).error.code, 'CONTROL_INELIGIBLE');
  assert.deepEqual(businessDomain(fourth), before);
});

test('notes retry requires its typed P26 failure, preserves receipt/manifest, and is not subject to the infrastructure attempt cap', () => {
  const source = catalog.find(item => item.id === 'notes-only');
  assert.ok(source, 'fixed notes-only trace exists');
  const id = source.id;
  const initialEvents = source.events.slice(0, 133);
  const initial = replayScenario(fixture(id, initialEvents), workflow, stateContract);
  assert.equal(initial.revision, 132);
  assert.equal(initial.status, 'RELEASED_PENDING_NOTES');
  assert.equal(initial.current_step, 'P26');
  assert.equal(initial.steps.P26.state, 'FAILED');
  assert.equal(initial.steps.P26.attempt, 1);
  assert.equal(initial.steps.P26.notes_failure.evidence_id, 'mock:notes:failure');
  assert.equal(initial.release.publication_count, 1);
  const manifest = structuredClone(initial.release.manifest);
  const receipt = initial.release.receipt_id;

  const retry = (events, seq, key, revision) => [
    submit(id, seq, key, 'retry', revision), apply(id, seq + 1, key, 50_000 + seq),
  ];
  const first = replayScenario(fixture(id, [...initialEvents, ...retry(initialEvents, 1, 'notes-retry-1', initial.revision)]), workflow, stateContract);
  assert.equal(first.steps.P26.state, 'READY');
  assert.equal(first.steps.P26.attempt, 2);
  assert.equal(first.release.publication_count, 1);
  assert.equal(first.release.receipt_id, receipt);
  assert.deepEqual(first.release.manifest, manifest);

  let events = [...initialEvents, ...retry(initialEvents, 1, 'notes-retry-1', initial.revision)];
  let revision = first.revision;
  let controlSeq = 3;
  let stepSeq = 1;
  for (const attempt of [2, 3]) {
    events.push(stepEvent(id, 'notes-loop', stepSeq++, 'P26', attempt, 'RUNNING'));
    events.push({ event_id: `mock:${id}:notes-loop:failure:${attempt}`, source_id: `mock:${id}:notes-loop-failures`,
      source_seq: attempt, type: 'notes_failure', mode: 'mock', job_id: `mock:${id}`, step_id: 'P26', cycle: 1,
      attempt, execution_id: `mock:P26:c1:a${attempt}`, payload: { evidence_id: `mock:${id}:notes-failure:${attempt}` } });
    revision += 2;
    const key = `notes-retry-${attempt}`;
    events.push(...retry(events, controlSeq, key, revision));
    controlSeq += 2;
    revision += 1;
    const observed = replayScenario(fixture(id, events), workflow, stateContract);
    assert.equal(observed.steps.P26.state, 'READY');
    assert.equal(observed.steps.P26.attempt, attempt + 1);
    assert.equal(observed.release.publication_count, 1);
    assert.equal(observed.release.receipt_id, receipt);
    assert.deepEqual(observed.release.manifest, manifest);
    assert.equal(observed.control.commands.at(-1).status, 'applied');
  }

  const notesAfterThirdAttempt = replayScenario(fixture(id, events), workflow, stateContract);
  assert.equal(notesAfterThirdAttempt.steps.P26.attempt, 4, 'notes-only can proceed beyond the infrastructure three-attempt cap');
  assert.equal(notesAfterThirdAttempt.steps.P26.state, 'READY');

  const genericFailure = replayScenario(fixture(id, [
    ...source.events.slice(0, 132), stepEvent(id, 'generic-failed', 1, 'P26', 1, 'FAILED'),
  ]), workflow, stateContract);
  const noTypedMarker = replayScenario(fixture(id, [
    ...source.events.slice(0, 132), stepEvent(id, 'generic-failed', 1, 'P26', 1, 'FAILED'),
    ...retry([], 1, 'generic-failed-retry', genericFailure.revision),
  ]), workflow, stateContract);
  assert.equal(noTypedMarker.steps.P26.state, 'FAILED');
  assert.equal(noTypedMarker.steps.P26.notes_failure, null);
  assert.equal(noTypedMarker.control.commands.at(-1).status, 'rejected');
  assert.equal(noTypedMarker.control.commands.at(-1).error.code, 'CONTROL_INELIGIBLE');
  assert.equal(noTypedMarker.release.publication_count, 1);
});

test('retry is blocked while paused, canceling, or device quarantine/reconciliation is active', () => {
  const { id, events, snapshot } = retryWait();
  const due = snapshot.steps.P13.retry_due_ms;
  const pauseId = `mock:${id}:command:pause`;
  const pausePrefix = [
    ...events, submit(id, 1, 'pause', 'pause', snapshot.revision), apply(id, 2, 'pause', due),
    jobEvent(id, 'controls', 3, 'control_pause_ack', { command_id: pauseId, actor: 'mock:system',
      fence_id: `mock:${id}:pause-fence`, drained_request_ids: [], evidence_id: `mock:${id}:pause-ack` }),
  ];
  const pausedBeforeRetry = replayScenario(fixture(id, pausePrefix), workflow, stateContract);
  assert.equal(pausedBeforeRetry.revision, 67);
  const paused = replayScenario(fixture(id, [
    ...pausePrefix, submit(id, 4, 'paused-retry', 'retry', pausedBeforeRetry.revision),
    apply(id, 5, 'paused-retry', due),
  ]), workflow, stateContract);
  assert.equal(paused.control.phase, 'PAUSED');
  assert.equal(paused.steps.P13.state, 'WAITING_RETRY');
  assert.equal(paused.steps.P13.attempt, 1);
  assert.equal(paused.control.commands.at(-1).status, 'rejected');
  assert.equal(paused.control.commands.at(-1).error.code, 'CONTROL_INELIGIBLE');

  const cancelId = `mock:${id}:command:cancel`;
  const cancel = replayScenario(fixture(id, [
    ...events, submit(id, 1, 'cancel', 'cancel', snapshot.revision), apply(id, 2, 'cancel', due),
    submit(id, 3, 'cancel-retry', 'retry', snapshot.revision + 1), apply(id, 4, 'cancel-retry', due),
  ]), workflow, stateContract);
  assert.equal(cancel.control.phase, 'CANCEL_REQUESTED');
  assert.equal(cancel.steps.P13.state, 'WAITING_RETRY');
  assert.equal(cancel.steps.P13.attempt, 1);
  assert.equal(cancel.control.commands.at(-1).status, 'rejected');
  assert.equal(cancel.control.commands.at(-1).error.code, 'CONTROL_INELIGIBLE');
  assert.equal(cancel.control.command_id, cancelId);

  const quarantined = replayScenario(fixture(id, [
    ...events,
    { event_id: `mock:${id}:device:unknown`, source_id: `mock:${id}:device`, source_seq: 1, type: 'device', mode: 'mock',
      job_id: `mock:${id}`, step_id: 'P13', cycle: 1, attempt: 1, execution_id: 'mock:P13:c1:a1',
      payload: { mode: 'mock', now_ms: 100, last_heartbeat_ms: 100, lease_expires_ms: 50, operation_state: 'unknown' } },
  ]), workflow, stateContract);
  const quarantineRetry = replayScenario(fixture(id, [
    ...events,
    { event_id: `mock:${id}:device:unknown`, source_id: `mock:${id}:device`, source_seq: 1, type: 'device', mode: 'mock',
      job_id: `mock:${id}`, step_id: 'P13', cycle: 1, attempt: 1, execution_id: 'mock:P13:c1:a1',
      payload: { mode: 'mock', now_ms: 100, last_heartbeat_ms: 100, lease_expires_ms: 50, operation_state: 'unknown' } },
    submit(id, 1, 'quarantine-retry', 'retry', quarantined.revision), apply(id, 2, 'quarantine-retry', due),
  ]), workflow, stateContract);
  assert.equal(quarantineRetry.status, 'RECONCILING');
  assert.equal(quarantineRetry.device.quarantined, true);
  assert.equal(quarantineRetry.steps.P13.state, 'WAITING_RETRY');
  assert.equal(quarantineRetry.steps.P13.attempt, 1);
  assert.equal(quarantineRetry.control.commands.at(-1).status, 'rejected');
});

const payloadKeys = Object.freeze({
  control_submitted: ['command_id', 'actor', 'route', 'idempotency_key', 'authorization_ref', 'csrf_ref', 'body'],
  control_apply: ['command_id', 'actor', 'observed_now_ms', 'evidence_id'],
  control_pause_ack: ['command_id', 'actor', 'fence_id', 'drained_request_ids', 'evidence_id'],
  control_execution_end: ['actor', 'control_command_id', 'kind', 'step_id', 'cycle', 'attempt', 'step_execution_id', 'agent_execution_id', 'status', 'prior_result_evidence_id', 'evidence_id'],
  control_cancel_boundary: ['command_id', 'actor', 'fence_id', 'drained_request_ids', 'execution_result_ids', 'bridge_reconciliation_ids', 'bridge_release_ids', 'remote_terminal_ids', 'evidence_id'],
  control_cancel_complete: ['command_id', 'actor', 'boundary_evidence_id', 'evidence_id'],
  bridge_registered: ['actor', 'command', 'step_execution_id', 'candidate_fingerprint', 'requirements_version', 'evidence_id'],
  bridge_observed: ['actor', 'command_id', 'lease_id', 'fencing_token', 'bridge_id', 'device_id', 'sequence', 'state', 'observed_mode', 'device_identity', 'exit_code', 'stdout_artifact_id', 'stderr_artifact_id', 'test_result_artifact_id', 'image_identity', 'started_at', 'finished_at', 'evidence_id'],
  bridge_reconciled: ['actor', 'command_id', 'lease_id', 'fencing_token', 'bridge_id', 'device_id', 'result_evidence_id', 'query_seq', 'safe_boundary', 'observed_mode', 'device_identity', 'os_lock_held', 'evidence_id'],
  bridge_released: ['actor', 'command_id', 'lease_id', 'fencing_token', 'reconciliation_evidence_id', 'os_lock_released', 'lease_released', 'evidence_id'],
  remote_intent: ['actor', 'operation_key', 'manifest_id', 'digest', 'candidate_fingerprint', 'rule_version', 'destination', 'step_id', 'cycle', 'attempt', 'execution_id', 'evidence_id'],
  remote_observed: ['actor', 'operation_key', 'query_seq', 'outcome', 'manifest_id', 'digest', 'candidate_fingerprint', 'cycle', 'attempt', 'execution_id', 'receipt_id', 'evidence_id'],
  remote_terminal: ['actor', 'operation_key', 'manifest_id', 'digest', 'candidate_fingerprint', 'cycle', 'attempt', 'execution_id', 'query_evidence_id', 'provider_state', 'receipt_id', 'safe_boundary', 'evidence_id'],
});

test('all thirteen control job payload schemas reject each missing and extra required-field shape atomically', () => {
  const id = 'control-k4-schema-matrix';
  for (const [type, keys] of Object.entries(payloadKeys)) {
    assert.ok(keys.length > 0, `${type} has independently pinned fields`);
    const full = Object.fromEntries(keys.map(key => [key, null]));
    for (const key of keys) {
      const missing = { ...full }; delete missing[key];
      const omitted = replayScenario(fixture(id, [jobEvent(id, type, 1, type, missing)]), workflow, stateContract);
      assert.equal(omitted.timeline.at(-1).applied, false, `${type}.${key} omission`);
      assert.equal(omitted.timeline.at(-1).reason, 'invalid_control_payload', `${type}.${key} omission rejected by exact schema`);
      const extra = replayScenario(fixture(id, [jobEvent(id, type, 1, type, { ...full, unexpected: 'mock:extra' })]), workflow, stateContract);
      assert.equal(extra.timeline.at(-1).applied, false, `${type}.${key} extra-field control`);
      assert.equal(extra.timeline.at(-1).reason, 'unknown_payload_field', `${type} extra payload field rejected by the strict event allowlist`);
    }
  }
});

test('job control envelope has exactly seven required fields and malformed envelope rows are domain-atomic', () => {
  const id = 'control-k4-envelope-matrix';
  const commandPayload = command(id, 'shape', 'pause', 0);
  const valid = jobEvent(id, 'envelope', 1, 'control_submitted', commandPayload);
  const fields = ['event_id', 'source_id', 'source_seq', 'type', 'mode', 'job_id', 'payload'];
  const bad = [];
  let seq = 1;
  for (const field of fields) {
    const seed = () => ({ ...valid, event_id: `mock:${id}:event:${seq}`, source_id: `mock:${id}:source`, source_seq: seq++ });
    const missing = seed(); delete missing[field]; bad.push(missing);
    bad.push({ ...seed(), [field]: null });
    bad.push({ ...seed(), unexpected: 'mock:extra' });
  }
  const baseline = replayScenario(fixture(id, []), workflow, stateContract);
  const result = replayScenario(fixture(id, bad), workflow, stateContract);
  assert.deepEqual(domain(result), domain(baseline));
  assert.equal(result.control.commands.length, 0);
  assert.ok(result.timeline.every(row => row.applied === false));
  assert.doesNotMatch(JSON.stringify(result), /mock:extra/);
});

test('control IDs, revision numbers, event sequences, and repeated evidence obey safe-integer/opaque identity bounds', () => {
  const id = 'control-k4-id-sequence';
  const validId = `mock:${'a'.repeat(123)}`;
  const valid = command(id, 'boundary', 'pause', Number.MAX_SAFE_INTEGER);
  valid.command_id = validId;
  valid.idempotency_key = `mock:${'k'.repeat(123)}`;
  const invalidId = command(id, 'too-long', 'pause', 0);
  invalidId.command_id = `mock:${'b'.repeat(124)}`;
  const result = replayScenario(fixture(id, [
    jobEvent(id, 'control', 1, 'control_submitted', valid),
    jobEvent(id, 'control', 2, 'control_submitted', invalidId),
    jobEvent(id, 'control', Number.MAX_SAFE_INTEGER + 1, 'control_submitted', command(id, 'unsafe-seq', 'pause', 0)),
  ]), workflow, stateContract);
  assert.equal(validId.length, 128);
  assert.equal(invalidId.command_id.length, 129);
  assert.equal(result.control.commands.length, 1);
  assert.equal(result.control.commands[0].command_id, validId);
  assert.equal(result.control.commands[0].body.expected_revision, Number.MAX_SAFE_INTEGER);
  assert.equal(result.timeline[1].applied, false);
  assert.equal(result.timeline[2].applied, false);

  const applyId = `mock:${id}:command:apply`;
  const afterSubmit = replayScenario(fixture(id, [
    jobEvent(id, 'apply', 1, 'control_submitted', command(id, 'apply', 'pause', 0)),
    jobEvent(id, 'apply', 2, 'control_apply', { command_id: applyId, actor: 'mock:system', observed_now_ms: 10,
      evidence_id: `mock:${id}:same-evidence` }),
    jobEvent(id, 'apply', 3, 'control_submitted', command(id, 'apply-alias', 'pause', 0)),
    jobEvent(id, 'apply', 4, 'control_apply', { command_id: `mock:${id}:command:apply-alias`, actor: 'mock:system', observed_now_ms: 10,
      evidence_id: `mock:${id}:same-evidence` }),
  ]), workflow, stateContract);
  assert.equal(afterSubmit.control.phase, 'PAUSE_REQUESTED');
  assert.equal(afterSubmit.control.commands.at(-1).status, 'accepted');
  assert.equal(afterSubmit.timeline.at(-1).applied, false);
  assert.equal(afterSubmit.timeline.at(-1).reason, 'invalid_control_application');
});

test('control revision, application clock, and source sequence reject invalid numeric boundaries without consuming the command', () => {
  const id = 'control-k4-numeric-boundaries';
  const invalidNumbers = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, null];
  for (const [index, value] of invalidNumbers.entries()) {
    const event = jobEvent(id, `revision-${index}`, 1, 'control_submitted', command(id, `revision-${index}`, 'pause', value));
    const result = replayScenario(fixture(id, [event]), workflow, stateContract);
    assert.equal(result.control.commands.length, 0, `invalid expected_revision ${String(value)}`);
    assert.equal(result.timeline.at(-1).reason, 'invalid_control_submission');
  }
  for (const validRevision of [0, Number.MAX_SAFE_INTEGER]) {
    const result = replayScenario(fixture(id, [jobEvent(id, `valid-revision-${validRevision}`, 1, 'control_submitted',
      command(id, `valid-revision-${validRevision}`, 'pause', validRevision))]), workflow, stateContract);
    assert.equal(result.control.commands.length, 1);
    assert.equal(result.timeline.at(-1).applied, true);
  }

  const commandId = command(id, 'clock', 'pause', 0);
  const invalidClockEvents = [];
  let seq = 1;
  for (const now of invalidNumbers) {
    const suffix = `clock-${seq}`;
    invalidClockEvents.push(jobEvent(id, 'clock', seq++, 'control_submitted', command(id, suffix, 'pause', 0)));
    invalidClockEvents.push(jobEvent(id, 'clock', seq++, 'control_apply', { command_id: `mock:${id}:command:${suffix}`,
      actor: 'mock:system', observed_now_ms: now, evidence_id: `mock:${id}:clock-evidence:${suffix}` }));
  }
  const badClocks = replayScenario(fixture(id, invalidClockEvents), workflow, stateContract);
  assert.equal(badClocks.control.phase, null);
  assert.equal(badClocks.control.applied_command_ids.length, 0);
  assert.ok(badClocks.control.commands.every(entry => entry.status === 'accepted'));
  assert.ok(badClocks.timeline.filter(row => row.type === 'control_apply').every(row => row.reason === 'invalid_control_application'));

  for (const badSeq of [-1, 0, 1.25, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    const result = replayScenario(fixture(id, [jobEvent(id, `bad-seq-${String(badSeq)}`, badSeq, 'control_submitted',
      command(id, `bad-seq-${String(badSeq)}`, 'pause', 0))]), workflow, stateContract);
    assert.equal(result.control.commands.length, 0, `invalid source_seq ${String(badSeq)}`);
    assert.equal(result.timeline.at(-1).applied, false);
  }
  assert.equal(commandId.body.expected_revision, 0);
});

test('frozen inputs replay deterministically and rejected control observations preserve the complete domain projection', () => {
  const { id, events, snapshot } = retryWait();
  const bad = [
    submit(id, 1, 'wrong-action', 'retry', snapshot.revision),
    apply(id, 2, 'wrong-action', -1),
  ];
  const frozen = deepFreeze(fixture(id, [...events, ...bad]));
  const one = replayScenario(frozen, workflow, stateContract);
  const two = replayScenario(frozen, workflow, stateContract);
  assert.deepEqual(one, two);
  assert.deepEqual(businessDomain(one), businessDomain(snapshot));
  assert.equal(one.control.commands.at(-1).status, 'accepted');
  assert.equal(one.steps.P13.state, 'WAITING_RETRY');
  assert.equal(one.steps.P13.attempt, 1);
});
