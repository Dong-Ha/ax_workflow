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

function stepEvent(scenarioId, seq, stepId, state, extra = {}) {
  return {
    event_id: `evt:${scenarioId}:step:${seq}`,
    source_id: `mock:${scenarioId}:steps`,
    source_seq: seq,
    type: 'step', mode: 'mock', job_id: `mock:${scenarioId}`,
    step_id: stepId, cycle: 1, attempt: 1, execution_id: `mock:${stepId}:c1:a1`,
    payload: { state, ...extra },
  };
}

function jobEvent(scenarioId, seq, type, payload, extra = {}) {
  return {
    event_id: `evt:${scenarioId}:control:${seq}`,
    source_id: `mock:${scenarioId}:controls`,
    source_seq: seq,
    type, mode: 'mock', job_id: `mock:${scenarioId}`, payload,
    ...extra,
  };
}

function command(scenarioId, action, key, expectedRevision, id = `mock:${scenarioId}:command:${key}`) {
  return {
    command_id: id,
    actor: 'mock:human',
    route: `/jobs/mock:${scenarioId}/controls`,
    idempotency_key: `mock:${scenarioId}:key:${key}`,
    authorization_ref: 'mock:authorization:owner-control:v1',
    csrf_ref: 'mock:csrf:validated:v1',
    body: { expected_revision: expectedRevision, action, reason: `mock:${scenarioId}:reason:${key}` },
  };
}

function submitted(scenarioId, seq, action, key, expectedRevision, id) {
  return jobEvent(scenarioId, seq, 'control_submitted', command(scenarioId, action, key, expectedRevision, id));
}

function applied(scenarioId, seq, id, observedNowMs = 1000) {
  return jobEvent(scenarioId, seq, 'control_apply', {
    command_id: id, actor: 'mock:system', observed_now_ms: observedNowMs,
    evidence_id: `mock:${scenarioId}:apply:${seq}`,
  });
}

function pauseAck(scenarioId, seq, id, drained = []) {
  return jobEvent(scenarioId, seq, 'control_pause_ack', {
    command_id: id, actor: 'mock:system', fence_id: `mock:${scenarioId}:pause-fence`,
    drained_request_ids: drained, evidence_id: `mock:${scenarioId}:pause-ack:${seq}`,
  });
}

function fixture(id, events) {
  return { id, title: `control fixture ${id}`, requirement_ids: [], events };
}

function domainProjection(result) {
  const { timeline, ignored, duplicate_count, conflict_count, ...domain } = result;
  return domain;
}

test('control submission is receipt-only; one current-revision apply wins and stale apply remains queryable', () => {
  const id = 'control-revision-race';
  const firstId = `mock:${id}:command:first`;
  const secondId = `mock:${id}:command:second`;
  const events = [
    stepEvent(id, 1, 'P01', 'READY'),
    stepEvent(id, 2, 'P01', 'RUNNING'),
    submitted(id, 1, 'pause', 'first', 2, firstId),
    submitted(id, 2, 'pause', 'second', 2, secondId),
  ];

  const accepted = replayScenario(fixture(id, events), workflow, stateContract);
  assert.equal(accepted.revision, 2);
  assert.equal(accepted.control.admission_open, true);
  assert.equal(accepted.steps.P01.state, 'RUNNING');
  assert.equal(accepted.control.commands.length, 2);
  assert.ok(accepted.control.commands.every(item => item.status === 'accepted'));

  const result = replayScenario(fixture(id, [...events,
    applied(id, 3, firstId), applied(id, 4, secondId),
  ]), workflow, stateContract);
  assert.equal(result.revision, 3);
  assert.equal(result.control.phase, 'PAUSE_REQUESTED');
  assert.equal(result.control.admission_open, false);
  assert.equal(result.control.commands.find(item => item.command_id === firstId).status, 'applied');
  assert.equal(result.control.commands.find(item => item.command_id === firstId).applied_revision, 3);
  assert.equal(result.control.commands.find(item => item.command_id === secondId).status, 'rejected');
  assert.equal(result.control.commands.find(item => item.command_id === secondId).applied_revision, null);
  assert.equal(result.steps.P01.state, 'RUNNING');
  assert.equal(result.timeline.at(-1).applied, true);
});

test('a decided command can be redelivered with the same evidence without a second revision or effect', () => {
  const id = 'control-apply-redelivery';
  const commandId = `mock:${id}:command:pause`;
  const apply = applied(id, 2, commandId);
  const events = [
    stepEvent(id, 1, 'P01', 'READY'), stepEvent(id, 2, 'P01', 'RUNNING'),
    submitted(id, 1, 'pause', 'pause', 2, commandId), apply,
    { ...apply, event_id: `evt:${id}:control:3`, source_seq: 3 },
  ];
  const result = replayScenario(fixture(id, events), workflow, stateContract);
  assert.equal(result.revision, 3);
  assert.equal(result.control.commands.length, 1);
  assert.equal(result.control.commands[0].status, 'applied');
  assert.deepEqual(result.control.applied_command_ids, [commandId]);
  assert.equal(result.control.phase, 'PAUSE_REQUESTED');
  assert.equal(result.timeline.at(-1).applied, true);
});

test('a command accepted before step progress is rejected at apply and its rejection does not alter the progressed domain state', () => {
  const id = 'control-stale-after-progress';
  const commandId = `mock:${id}:command:pause`;
  const events = [
    stepEvent(id, 1, 'P01', 'READY'), stepEvent(id, 2, 'P01', 'RUNNING'),
    submitted(id, 1, 'pause', 'pause', 2, commandId),
    stepEvent(id, 3, 'P01', 'SUCCEEDED'), applied(id, 2, commandId),
  ];
  const result = replayScenario(fixture(id, events), workflow, stateContract);
  assert.equal(result.revision, 3);
  assert.equal(result.current_step, 'P02');
  assert.equal(result.steps.P01.state, 'SUCCEEDED');
  assert.equal(result.steps.P02.state, 'PENDING');
  assert.equal(result.control.admission_open, true);
  assert.equal(result.control.phase, null);
  assert.equal(result.control.commands[0].status, 'rejected');
  assert.equal(result.control.commands[0].applied_revision, null);
});

test('END and completed jobs retain a command receipt but reject a new cancel without changing domain state', () => {
  const base = catalog.find(item => item.id === 'happy-path');
  assert.ok(base, 'fixed completed trace exists');
  const complete = replayScenario(fixture(base.id, base.events), workflow, stateContract);
  assert.equal(base.events.length, 134);
  assert.equal(complete.revision, 133);
  assert.equal(complete.status, 'COMPLETED');
  assert.equal(complete.current_step, 'END');

  const id = base.id;
  const commandId = `mock:${id}:command:terminal-cancel`;
  const result = replayScenario(fixture(id, [
    ...base.events,
    submitted(id, 1, 'cancel', 'terminal-cancel', 133, commandId),
    applied(id, 2, commandId),
  ]), workflow, stateContract);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.current_step, 'END');
  assert.equal(result.revision, 133);
  assert.equal(result.control.admission_open, true);
  assert.equal(result.control.commands.length, 1);
  assert.equal(result.control.commands[0].status, 'rejected');
  assert.equal(result.control.commands[0].applied_revision, null);
  assert.equal(result.control.commands[0].error.code, 'CONTROL_INELIGIBLE');
});

test('accepted domain changes advance revision while identical ordinary telemetry is a no-op', () => {
  const id = 'control-domain-revision';
  const events = [
    stepEvent(id, 1, 'P01', 'READY'), stepEvent(id, 2, 'P01', 'RUNNING'),
    { event_id: `evt:${id}:agent:1`, source_id: `mock:${id}:agent`, source_seq: 1, type: 'agent', mode: 'mock',
      job_id: `mock:${id}`, step_id: 'P01', cycle: 1, attempt: 1, execution_id: 'mock:P01:c1:a1', payload: { status: 'running' } },
    { event_id: `evt:${id}:agent:2`, source_id: `mock:${id}:agent`, source_seq: 2, type: 'agent', mode: 'mock',
      job_id: `mock:${id}`, step_id: 'P01', cycle: 1, attempt: 1, execution_id: 'mock:P01:c1:a1', payload: { status: 'running' } },
  ];
  const result = replayScenario(fixture(id, events), workflow, stateContract);
  assert.equal(result.revision, 3);
  assert.equal(result.steps.P01.agent_status, 'running');
  assert.ok(result.timeline.every(row => row.applied));
});

test('same idempotency scope/body reuses canonical command; key/body conflict and alias rebinding do not create a second command', () => {
  const id = 'control-idempotency';
  const canonicalId = `mock:${id}:command:canonical`;
  const aliasId = `mock:${id}:command:alias`;
  const events = [
    submitted(id, 1, 'pause', 'same', 0, canonicalId),
    submitted(id, 2, 'pause', 'same', 0, canonicalId),
  ];
  const same = replayScenario(fixture(id, events), workflow, stateContract);
  assert.equal(same.revision, 0);
  assert.equal(same.control.commands.length, 1);
  assert.equal(same.control.commands[0].command_id, canonicalId);
  assert.equal(same.control.commands[0].status, 'accepted');
  assert.equal(same.timeline.at(-1).applied, true);

  const conflictingBody = jobEvent(id, 3, 'control_submitted', {
    ...command(id, 'cancel', 'same', 0, canonicalId),
  });
  const aliasRebind = jobEvent(id, 4, 'control_submitted', {
    ...command(id, 'pause', 'different', 0, canonicalId),
  });
  const aliasMismatch = jobEvent(id, 5, 'control_submitted', {
    ...command(id, 'pause', 'same', 0, aliasId),
  });
  const result = replayScenario(fixture(id, [...events, conflictingBody, aliasRebind, aliasMismatch]), workflow, stateContract);
  assert.equal(result.revision, 0);
  assert.equal(result.control.commands.length, 1);
  assert.equal(result.control.commands[0].command_id, canonicalId);
  assert.ok(result.timeline.slice(-3).every(row => row.applied === false));
  assert.equal(result.steps.P01.state, 'PENDING');
});

test('strict control payload rejects missing, null, extra, wrong actor, and mismatched route without domain mutation', () => {
  const id = 'control-schema';
  const base = command(id, 'pause', 'schema', 0);
  const bad = [
    Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'csrf_ref')),
    { ...base, authorization_ref: null },
    { ...base, untrusted: 'do-not-leak' },
    { ...base, actor: 'mock:code-dev' },
    { ...base, route: '/jobs/mock:elsewhere/controls' },
  ];
  const before = replayScenario(fixture(id, []), workflow, stateContract);
  const events = bad.map((payload, index) => jobEvent(id, index + 1, 'control_submitted', payload));
  const result = replayScenario(fixture(id, events), workflow, stateContract);
  assert.equal(result.revision, 0);
  assert.deepEqual(domainProjection(result), domainProjection(before));
  assert.equal(result.control.commands.length, 0);
  assert.ok(result.timeline.every(row => row.applied === false));
  assert.doesNotMatch(JSON.stringify(result), /do-not-leak|elsewhere/);
});

test('job-scoped event envelope has exactly seven fields and body revisions are nonnegative safe integers', () => {
  const id = 'control-envelope-bounds';
  const base = command(id, 'pause', 'bounds', 0);
  const invalidBodies = [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null].map(expected_revision => ({
    ...base, body: { ...base.body, expected_revision },
  }));
  const events = invalidBodies.map((payload, index) => jobEvent(id, index + 1, 'control_submitted', payload));
  events.push(jobEvent(id, 5, 'control_submitted', base, { step_id: 'P01', cycle: 1, attempt: 1, execution_id: 'mock:P01:c1:a1' }));
  const result = replayScenario(fixture(id, events), workflow, stateContract);
  assert.equal(result.revision, 0);
  assert.equal(result.control.commands.length, 0);
  assert.ok(result.timeline.every(row => row.applied === false));
  assert.equal(result.steps.P01.state, 'PENDING');
});

test('command identifiers accept the 128-character boundary but reject 129 characters without recording the bad command', () => {
  const id = 'control-id-boundary';
  const validId = `mock:${'a'.repeat(123)}`;
  const valid = { ...command(id, 'pause', 'boundary', 0), command_id: validId,
    idempotency_key: `mock:${'k'.repeat(123)}` };
  const tooLong = { ...command(id, 'pause', 'too-long', 0), command_id: `mock:${'b'.repeat(124)}` };
  const result = replayScenario(fixture(id, [
    jobEvent(id, 1, 'control_submitted', valid), jobEvent(id, 2, 'control_submitted', tooLong),
  ]), workflow, stateContract);
  assert.equal(validId.length, 128);
  assert.equal(tooLong.command_id.length, 129);
  assert.equal(result.control.commands.length, 1);
  assert.equal(result.control.commands[0].command_id, validId);
  assert.equal(result.control.commands[0].status, 'accepted');
  assert.equal(result.timeline[1].applied, false);
});

test('pause closes admission, records an in-flight canonical completion, preserves the new frontier, then resume reopens it', () => {
  const id = 'control-pause-frontier';
  const commandId = `mock:${id}:command:pause`;
  const resumeId = `mock:${id}:command:resume`;
  const events = [
    stepEvent(id, 1, 'P01', 'READY'),
    stepEvent(id, 2, 'P01', 'RUNNING'),
    submitted(id, 1, 'pause', 'pause', 2, commandId),
    applied(id, 2, commandId),
    stepEvent(id, 3, 'P02', 'READY'),
  ];
  const blocked = replayScenario(fixture(id, events), workflow, stateContract);
  assert.equal(blocked.revision, 3);
  assert.equal(blocked.steps.P01.state, 'RUNNING');
  assert.equal(blocked.steps.P02.state, 'PENDING');
  assert.equal(blocked.timeline.at(-1).applied, false);
  assert.equal(blocked.control.admission_open, false);

  const inFlightDone = replayScenario(fixture(id, [
    ...events.slice(0, -1), stepEvent(id, 3, 'P01', 'SUCCEEDED'), pauseAck(id, 3, commandId),
  ]), workflow, stateContract);
  assert.equal(inFlightDone.steps.P01.state, 'SUCCEEDED');
  assert.equal(inFlightDone.current_step, 'P02');
  assert.equal(inFlightDone.steps.P02.state, 'PENDING');
  assert.equal(inFlightDone.control.phase, 'PAUSED');
  assert.equal(inFlightDone.control.admission_open, false);
  assert.equal(inFlightDone.status, 'PAUSED');

  const beforeFence = replayScenario(fixture(id, events.slice(0, 4)), workflow, stateContract);
  assert.equal(beforeFence.control.phase, 'PAUSE_REQUESTED');
  assert.equal(beforeFence.status, 'RECONCILING');
  assert.equal(beforeFence.wait_reason, 'pause_fence_pending');
  assert.equal(beforeFence.steps.P01.state, 'RUNNING');

  const resumed = replayScenario(fixture(id, [
    ...events.slice(0, -1), stepEvent(id, 3, 'P01', 'SUCCEEDED'), pauseAck(id, 3, commandId),
    submitted(id, 4, 'resume', 'resume', 5, resumeId), applied(id, 5, resumeId),
    stepEvent(id, 5, 'P02', 'READY'),
  ]), workflow, stateContract);
  assert.equal(resumed.control.phase, null);
  assert.equal(resumed.control.admission_open, true);
  assert.equal(resumed.steps.P01.state, 'SUCCEEDED');
  assert.equal(resumed.steps.P02.state, 'READY');
  assert.equal(resumed.current_step, 'P02');
  assert.equal(resumed.revision, 7);
});

test('resuming a human wait and advancing that step clears the stale WAITING_HUMAN job aggregate', () => {
  const base = catalog.find(item => item.id === 'human-wait');
  assert.ok(base, 'fixed human-wait trace exists');
  const waitCursor = base.checkpoints.find(item => item.id === 'wait')?.cursor;
  assert.equal(waitCursor, 33);
  const prefix = base.events.slice(0, waitCursor);
  const waiting = replayScenario(fixture(base.id, prefix), workflow, stateContract);
  assert.equal(waiting.status, 'WAITING_HUMAN');
  assert.equal(waiting.current_step, 'P07');
  assert.equal(waiting.steps.P07.state, 'WAITING_HUMAN');

  const id = base.id;
  const pauseId = `mock:${id}:command:pause-human-wait`;
  const resumeId = `mock:${id}:command:resume-human-wait`;
  const pausedEvents = [
    ...prefix,
    submitted(id, 1, 'pause', 'pause-human-wait', waiting.revision, pauseId),
    applied(id, 2, pauseId), pauseAck(id, 3, pauseId),
  ];
  const paused = replayScenario(fixture(id, pausedEvents), workflow, stateContract);
  assert.equal(paused.status, 'WAITING_HUMAN');
  assert.equal(paused.control.phase, 'PAUSED');
  assert.equal(paused.steps.P07.state, 'WAITING_HUMAN');

  const resumed = replayScenario(fixture(id, [
    ...pausedEvents,
    submitted(id, 4, 'resume', 'resume-human-wait', paused.revision, resumeId),
    applied(id, 5, resumeId),
    stepEvent(id, 1, 'P07', 'READY'),
    stepEvent(id, 2, 'P07', 'RUNNING'),
  ]), workflow, stateContract);
  assert.equal(resumed.control.phase, null);
  assert.equal(resumed.control.admission_open, true);
  assert.equal(resumed.steps.P07.state, 'RUNNING');
  assert.equal(resumed.status, 'RUNNING');
  assert.equal(resumed.wait_reason, '');
});

test('pause permits an admitted child result to be collected into its original human checkpoint, but blocks new child execution', () => {
  const base = catalog.find(item => item.id === 'agent-child-question');
  assert.ok(base, 'fixed source scenario exists');
  const collectIndex = base.events.findIndex(event => event.type === 'child_collect');
  assert.ok(collectIndex > 0);
  const id = base.id;
  const commandId = `mock:${id}:command:pause`;
  const beforeCollection = base.events.slice(0, collectIndex);
  const afterCollection = base.events.slice(collectIndex);
  const before = replayScenario(fixture(id, beforeCollection), workflow, stateContract);
  assert.equal(beforeCollection.length, 59);
  assert.equal(before.revision, 59);
  assert.ok(before.timeline.every(row => row.applied));
  const result = replayScenario(fixture(id, [
    ...beforeCollection,
    submitted(id, 1, 'pause', 'pause', 59, commandId),
    applied(id, 2, commandId),
    afterCollection[0],
  ]), workflow, stateContract);
  assert.equal(result.control.admission_open, false);
  assert.equal(result.steps.P12.child_coordination.requests[0].result.status, 'needs_human');
  assert.ok(result.steps.P12.child_coordination.human_task);
  assert.equal(result.steps.P12.state, 'WAITING_HUMAN');
  assert.equal(result.current_step, 'P12');

  const admittedFollowup = [
    afterCollection.find(event => event.type === 'child_collect'),
    afterCollection.filter(event => event.type === 'child_answer').at(-1),
    afterCollection.find(event => event.type === 'step' && event.payload.state === 'READY'),
    afterCollection.find(event => event.type === 'step' && event.payload.state === 'RUNNING'),
    afterCollection.find(event => event.type === 'child_request' && event.payload.ordinal === 2),
  ];
  assert.ok(admittedFollowup.every(Boolean), 'fixed source scenario exposes collect, answer, and subsequent dispatch probes');
  const blocked = replayScenario(fixture(id, [
    ...beforeCollection,
    submitted(id, 1, 'pause', 'pause', 59, commandId), applied(id, 2, commandId),
    ...admittedFollowup,
  ]), workflow, stateContract);
  assert.ok(blocked.timeline.slice(-2).every(row => row.applied === false));
  assert.equal(blocked.steps.P12.child_coordination.requests.length, 1);
  assert.equal(blocked.steps.P12.child_coordination.requests[0].assignment.child_execution_id, 'mock:agent-child-question:ch:exec:c1:a1');
  assert.equal(blocked.steps.P12.state, 'READY');
  assert.equal(blocked.control.admission_open, false);
});

test('pause on an existing infrastructure retry wait preserves attempt and due time; elapsed time alone cannot dispatch', () => {
  const base = catalog.find(item => item.id === 'retry-limit');
  assert.ok(base, 'fixed retry scenario exists');
  const waitingCursor = base.checkpoints.find(item => item.id === 'wait-first')?.cursor;
  assert.ok(Number.isSafeInteger(waitingCursor));
  const prefix = base.events.slice(0, waitingCursor);
  const id = base.id;
  const initial = replayScenario(fixture(id, prefix), workflow, stateContract);
  assert.equal(initial.current_step, 'P13');
  assert.equal(initial.steps.P13.state, 'WAITING_RETRY');
  const due = initial.steps.P13.retry_due_ms;
  assert.ok(Number.isSafeInteger(due));

  const commandId = `mock:${id}:command:pause`;
  const pausedEvents = [
    ...prefix,
    submitted(id, 1, 'pause', 'pause', initial.revision, commandId),
    applied(id, 2, commandId, due + 1),
    pauseAck(id, 3, commandId),
  ];
  const paused = replayScenario(fixture(id, pausedEvents), workflow, stateContract);
  assert.equal(paused.control.phase, 'PAUSED');
  assert.equal(paused.steps.P13.state, 'WAITING_RETRY');
  assert.equal(paused.steps.P13.attempt, 1);
  assert.equal(paused.steps.P13.retry_due_ms, due);
  assert.equal(paused.control.admission_open, false);

  const blockedRetry = replayScenario(fixture(id, [
    ...pausedEvents,
    stepEvent(id, 3, 'P13', 'READY'),
  ]), workflow, stateContract);
  assert.equal(blockedRetry.steps.P13.state, 'WAITING_RETRY');
  assert.equal(blockedRetry.steps.P13.attempt, 1);
  assert.equal(blockedRetry.steps.P13.retry_due_ms, due);
  assert.equal(blockedRetry.control.admission_open, false);

  const resumeId = `mock:${id}:command:resume`;
  const beforeDueId = `mock:${id}:command:retry-before-due`;
  const atDueId = `mock:${id}:command:retry-at-due`;
  const resumedPrefix = [
    ...pausedEvents,
    submitted(id, 4, 'resume', 'resume', 67, resumeId), applied(id, 5, resumeId, due - 1),
  ];
  const beforeDue = replayScenario(fixture(id, [
    ...resumedPrefix,
    submitted(id, 6, 'retry', 'retry-before-due', 68, beforeDueId),
    applied(id, 7, beforeDueId, due - 1),
  ]), workflow, stateContract);
  assert.equal(beforeDue.revision, 68);
  assert.equal(beforeDue.control.admission_open, true);
  assert.equal(beforeDue.steps.P13.state, 'WAITING_RETRY');
  assert.equal(beforeDue.steps.P13.attempt, 1);
  assert.equal(beforeDue.control.commands.at(-1).status, 'rejected');

  const atDue = replayScenario(fixture(id, [
    ...resumedPrefix,
    submitted(id, 6, 'retry', 'retry-at-due', 68, atDueId),
    applied(id, 7, atDueId, due),
  ]), workflow, stateContract);
  assert.equal(atDue.revision, 69);
  assert.equal(atDue.steps.P13.state, 'READY');
  assert.equal(atDue.steps.P13.attempt, 2);
  assert.equal(atDue.steps.P13.retry_due_ms, null);
  assert.ok(atDue.history.some(item => item.kind === 'attempt' && item.step_id === 'P13' && item.step.attempt === 1));
  assert.equal(atDue.control.commands.at(-1).status, 'applied');
});

test('final P26 completion while paused resumes to COMPLETED without rerunning P26; a later cancel is retained as rejected', () => {
  const base = catalog.find(item => item.id === 'happy-path');
  assert.ok(base, 'fixed successful trace exists');
  const completedIndex = base.events.findIndex(event => event.step_id === 'P26' && event.type === 'step'
    && event.payload.state === 'SUCCEEDED');
  assert.equal(completedIndex, 133);
  const prefix = base.events.slice(0, completedIndex);
  const before = replayScenario(fixture(base.id, prefix), workflow, stateContract);
  assert.equal(before.revision, 132);
  assert.equal(before.current_step, 'P26');
  assert.equal(before.steps.P26.state, 'RUNNING');
  assert.equal(before.release.publication_count, 1);

  const id = base.id;
  const pauseId = `mock:${id}:command:pause`;
  const resumeId = `mock:${id}:command:resume`;
  const completion = base.events[completedIndex];
  const events = [
    ...prefix,
    submitted(id, 1, 'pause', 'pause-final', 132, pauseId),
    applied(id, 2, pauseId),
    pauseAck(id, 3, pauseId),
    completion,
    submitted(id, 4, 'resume', 'resume-final', 135, resumeId),
    applied(id, 5, resumeId),
  ];
  const resumed = replayScenario(fixture(id, events), workflow, stateContract);
  assert.equal(resumed.revision, 136);
  assert.equal(resumed.control.phase, null);
  assert.equal(resumed.control.admission_open, true);
  assert.equal(resumed.status, 'COMPLETED');
  assert.equal(resumed.current_step, 'END');
  assert.equal(resumed.steps.P26.state, 'SUCCEEDED');
  assert.equal(resumed.steps.P26.attempt, 1);
  assert.equal(resumed.release.publication_count, 1);

  const terminal = replayScenario(fixture(id, [...events,
    submitted(id, 6, 'cancel', 'cancel-after-complete', 136),
    applied(id, 7, `mock:${id}:command:cancel-after-complete`),
  ]), workflow, stateContract);
  assert.equal(terminal.status, 'COMPLETED');
  assert.equal(terminal.current_step, 'END');
  assert.equal(terminal.steps.P26.state, 'SUCCEEDED');
  assert.equal(terminal.release.publication_count, 1);
  assert.equal(terminal.revision, 136);
  assert.equal(terminal.control.commands.at(-1).status, 'rejected');
  assert.equal(terminal.control.commands.at(-1).applied_revision, null);
});
