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

// Independent K5 oracle transcribed from the approved V2-CONTROLS.md table.
// It intentionally contains only the new 15 cases; historical-prefix byte
// checks remain in ifpmic-catalog.test.mjs.
const controls = {
  'control-command-lifecycle': {
    points: ['accepted', 'requested', 'paused', 'resumed'],
    end: { current_step: 'END', status: 'COMPLETED', publication_count: 1 },
  },
  'control-command-conflicts': {
    points: ['accepted', 'applied-one', 'rejected-two', 'duplicate', 'body-conflict'],
    end: { current_step: 'P07', status: 'WAITING_HUMAN', phase: 'PAUSED', publication_count: 0 },
  },
  'control-apply-after-progress': {
    points: ['submitted', 'advanced', 'rejected'],
    end: { current_step: 'P02', status: 'RUNNING', publication_count: 0 },
  },
  'pause-human': {
    points: ['paused', 'submitted', 'finished', 'resumed'],
    end: { current_step: 'END', status: 'COMPLETED', publication_count: 1 },
  },
  'pause-child': {
    points: ['paused', 'returned', 'collected', 'blocked', 'resumed'],
    end: { current_step: 'END', status: 'COMPLETED', publication_count: 1 },
  },
  'pause-manual-sqe': {
    points: ['paused', 'submitted', 'blocked', 'resumed'],
    end: { current_step: 'END', status: 'COMPLETED', publication_count: 1 },
  },
  'pause-device-wait': {
    points: ['paused', 'resumed'],
    end: { current_step: 'P22', status: 'WAITING_DEVICE', publication_count: 0 },
  },
  'pause-retry': {
    points: ['paused', 'due-blocked', 'resumed', 'retried'],
    end: { current_step: 'END', status: 'COMPLETED', publication_count: 1, P13_attempt: 2 },
  },
  'pause-final': {
    points: ['paused', 'finished', 'resumed'],
    end: { current_step: 'END', status: 'COMPLETED', publication_count: 1 },
  },
  'cancel-child': {
    points: ['requested', 'returned', 'blocked', 'quiescent', 'canceled'],
    end: { current_step: 'P12', status: 'CANCELED', P12_state: 'CANCELED', publication_count: 0 },
  },
  'cancel-flash-unknown': {
    points: ['registered', 'unknown', 'requested', 'rejected', 'reconciled', 'released', 'canceled'],
    end: { current_step: 'P22', status: 'CANCELED', P22_state: 'CANCELED', publication_count: 0 },
  },
  'cancel-remote-late-receipt': {
    points: ['intent', 'requested', 'receipt', 'quiescent', 'canceled', 'late'],
    end: { current_step: 'P25', status: 'CANCELED', P25_state: 'CANCELED', P26_state: 'CANCELED', publication_count: 1 },
  },
  'cancel-pending-dispatch': {
    points: ['pending', 'requested', 'blocked', 'drained', 'canceled'],
    end: { current_step: 'P12', status: 'CANCELED', P12_state: 'CANCELED', publication_count: 0 },
  },
  'cancel-released-notes': {
    points: ['failed', 'requested', 'canceled', 'blocked'],
    end: { current_step: 'P26', status: 'CANCELED', P26_state: 'FAILED', publication_count: 1 },
  },
  'control-notes-retry': {
    points: ['failed', 'accepted', 'retried', 'completed'],
    end: { current_step: 'END', status: 'COMPLETED', P26_attempt: 2, publication_count: 1 },
  },
};

// These per-checkpoint values are the literal observable parts named in the
// plan table. Unspecified fields are deliberately left to their owning K1–K4
// contract tests instead of being inferred from the replay result.
const checkpointOracle = {
  'control-command-lifecycle': {
    accepted: { 'control.admission_open': true },
    requested: { 'control.phase': 'PAUSE_REQUESTED', 'control.admission_open': false },
    paused: { 'control.phase': 'PAUSED', 'control.admission_open': false },
    resumed: { 'control.phase': null, 'control.admission_open': true },
  },
  'control-command-conflicts': {
    accepted: { 'control.commands.length': 2 },
    'applied-one': { 'control.commands.0.status': 'applied', 'control.commands.1.status': 'accepted' },
    'rejected-two': { 'control.commands.1.status': 'rejected', 'control.commands.1.error.code': 'REVISION_CONFLICT' },
    duplicate: { 'control.commands.length': 2 },
    'body-conflict': { 'control.commands.length': 2 },
  },
  'control-apply-after-progress': {
    submitted: { 'control.commands.0.status': 'accepted' },
    advanced: { current_step: 'P02', 'steps.P02.state': 'PENDING' },
    rejected: { current_step: 'P02', 'control.commands.0.status': 'rejected', 'control.commands.0.error.code': 'REVISION_CONFLICT' },
  },
  'pause-human': {
    paused: { 'control.phase': 'PAUSED', 'control.admission_open': false, 'steps.P07.state': 'WAITING_HUMAN' },
    submitted: { 'control.phase': 'PAUSED', 'control.admission_open': false },
    finished: { 'control.phase': 'PAUSED', 'steps.P08.state': 'PENDING' },
    resumed: { 'control.phase': null, 'control.admission_open': true },
  },
  'pause-child': {
    paused: { 'control.phase': 'PAUSED', 'steps.P12.state': 'WAITING_AGENT' },
    returned: { 'control.phase': 'PAUSED', 'steps.P12.child_coordination.requests.0.result.status': 'completed',
      'steps.P12.child_coordination.requests.0.result.patch_artifact_id.$present': true },
    collected: { 'control.phase': 'PAUSED', 'steps.P12.state': 'RUNNING',
      'steps.P12.child_coordination.requests.0.result.patch_artifact_id.$present': true },
    blocked: { 'control.phase': 'PAUSED', 'control.admission_open': false },
    resumed: { 'control.phase': null, 'control.admission_open': true },
  },
  'pause-manual-sqe': {
    paused: { 'control.phase': 'PAUSED' },
    submitted: { 'control.phase': 'PAUSED', 'steps.P22.state': 'READY' },
    blocked: { 'control.phase': 'PAUSED', 'control.admission_open': false },
    resumed: { 'control.phase': null, 'control.admission_open': true },
  },
  'pause-device-wait': {
    paused: { 'control.phase': 'PAUSED', 'steps.P22.state': 'WAITING_DEVICE' },
    resumed: { 'control.phase': null, 'steps.P22.state': 'WAITING_DEVICE', 'steps.P22.attempt': 1 },
  },
  'pause-retry': {
    paused: { 'control.phase': 'PAUSED', 'steps.P13.state': 'WAITING_RETRY' },
    'due-blocked': { 'control.phase': 'PAUSED', 'steps.P13.state': 'WAITING_RETRY', 'steps.P13.attempt': 1 },
    resumed: { 'control.phase': null, 'steps.P13.state': 'WAITING_RETRY', 'steps.P13.attempt': 1 },
    retried: { 'steps.P13.attempt': 2 },
  },
  'pause-final': {
    paused: { 'control.phase': 'PAUSED' },
    finished: { 'control.phase': 'PAUSED', current_step: 'END' },
    resumed: { 'control.phase': null, 'control.admission_open': true },
  },
  'cancel-child': {
    requested: { 'control.phase': 'CANCEL_REQUESTED', 'control.admission_open': false },
    returned: { 'control.phase': 'CANCEL_REQUESTED', 'control.facts.1.type': 'child_result',
      'control.facts.1.payload.status': 'completed', 'control.facts.1.payload.patch_artifact_id': 'mock:cancel-child:ch:patch:c1:a1',
      'steps.P12.child_coordination.requests.0.result': null,
      'steps.P12.child_coordination.requests.0.collection': null, 'steps.P12.child_coordination.requests.0.integration': null },
    blocked: { 'control.phase': 'CANCEL_REQUESTED' },
    quiescent: { 'control.phase': 'QUIESCENT' },
    canceled: { 'control.phase': 'CANCELED', 'control.admission_open': false },
  },
  'cancel-flash-unknown': {
    registered: { 'control.bridges.length': 1 },
    unknown: { 'control.unscoped_quarantine': false },
    requested: { 'control.phase': 'CANCEL_REQUESTED' },
    rejected: { 'control.phase': 'CANCEL_REQUESTED' },
    reconciled: { 'control.bridges.0.reconciliation.$present': true },
    released: { 'control.bridges.0.released': true },
    canceled: { 'control.phase': 'CANCELED' },
  },
  'cancel-remote-late-receipt': {
    intent: { 'control.remotes.length': 1 },
    requested: { 'control.phase': 'CANCEL_REQUESTED' },
    receipt: { 'control.phase': 'CANCEL_REQUESTED', 'release.publication_count': 1, 'steps.P26.state': 'PENDING' },
    quiescent: { 'control.phase': 'QUIESCENT' },
    canceled: { 'control.phase': 'CANCELED' },
    late: { 'control.phase': 'CANCELED' },
  },
  'cancel-pending-dispatch': {
    pending: { 'steps.P12.child_coordination.requests.0.request_id': 'mock:cancel-pending-dispatch:ch:request:c1:a1',
      'steps.P12.child_coordination.requests.0.assignment': null, 'control.pending_request_ids.length': 0 },
    requested: { 'control.phase': 'CANCEL_REQUESTED' },
    blocked: { 'control.phase': 'CANCEL_REQUESTED' },
    drained: { 'control.pending_request_ids': ['mock:cancel-pending-dispatch:ch:request:c1:a1'],
      'steps.P12.child_coordination.requests.0.assignment': null },
    canceled: { 'control.phase': 'CANCELED' },
  },
  'cancel-released-notes': {
    failed: { 'steps.P26.state': 'FAILED', publication_count: 1 },
    requested: { 'control.phase': 'CANCEL_REQUESTED' },
    canceled: { 'control.phase': 'CANCELED', 'steps.P26.state': 'FAILED' },
    blocked: { 'control.phase': 'CANCELED', 'steps.P26.state': 'FAILED' },
  },
  'control-notes-retry': {
    failed: { 'steps.P26.state': 'FAILED' },
    accepted: { 'control.commands.0.status': 'accepted' },
    retried: { 'steps.P26.attempt': 2, 'steps.P26.state': 'READY' },
    completed: { current_step: 'END', 'steps.P26.attempt': 2 },
  },
};

const typedRejectionOracle = {
  'control-command-conflicts': { 'body-conflict': 'control_idempotency_conflict' },
  'pause-child': { blocked: 'control_pause_admission_closed' },
  'pause-manual-sqe': { blocked: 'control_pause_admission_closed' },
  'cancel-child': { blocked: 'control_cancel_admission_closed' },
  'cancel-pending-dispatch': { blocked: [
    { offset: -2, reason: 'control_cancel_admission_closed' },
    { offset: -1, reason: 'invalid_cancel_boundary' },
  ] },
  'pause-retry': { 'due-blocked': 'control_pause_admission_closed' },
};

function valueAt(snapshot, key) {
  if (key === 'phase') return snapshot.control.phase;
  const attempt = /^(P\d+)_attempt$/.exec(key);
  if (attempt) return snapshot.steps?.[attempt[1]]?.attempt;
  const state = /^(P\d+)_state$/.exec(key);
  if (state) return snapshot.steps?.[state[1]]?.state;
  const parts = key.split('.');
  if (parts.at(-1) === '$present') return parts.slice(0, -1).reduce((value, part) => value?.[part], snapshot) != null;
  return parts.reduce((value, part) => value?.[part], snapshot);
}

function assertLiteralSnapshot(snapshot, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    const path = key === 'publication_count' ? 'release.publication_count' : key;
    assert.deepEqual(valueAt(snapshot, path), value, `${label}/${key}`);
  }
  assert.equal(snapshot.real_publish_allowed, false, `${label} cannot authorize real publication`);
}

function controlDomain(snapshot) {
  const c = snapshot.control;
  return {
    status: snapshot.status, wait_reason: snapshot.wait_reason, current_step: snapshot.current_step,
    cycle: snapshot.cycle, rework_count: snapshot.rework_count, candidate_fingerprint: snapshot.candidate_fingerprint,
    requirements_version: snapshot.requirements_version, rule_version: snapshot.rule_version,
    steps: snapshot.steps, history: snapshot.history, release: snapshot.release, device: snapshot.device,
    route_plan: snapshot.route_plan, no_change: snapshot.no_change, required_revalidation: snapshot.required_revalidation,
    failure_bundle: snapshot.failure_bundle,
    control: { phase: c.phase, admission_open: c.admission_open, applied_command_ids: c.applied_command_ids,
      command_id: c.command_id, pause_anchor: c.pause_anchor, resume_step: c.resume_step, resume_state: c.resume_state,
      reconciliation_required: c.reconciliation_required, fence: c.fence, executions: c.executions,
      known_executions: c.known_executions, pending_request_ids: c.pending_request_ids,
      execution_ends: c.execution_ends, unscoped_quarantine: c.unscoped_quarantine,
      generic_device: c.generic_device, bridges: c.bridges, remotes: c.remotes, facts: c.facts, boundary: c.boundary },
  };
}

test('the approved controls cases are appended after the immutable 59-scenario prefix', () => {
  const catalog = createScenarioCatalog(workflow, stateContract);
  const ids = Object.keys(controls);
  assert.equal(catalog.length, 74);
  assert.deepEqual(catalog.slice(59).map(scenario => scenario.id), ids);
  for (const scenario of catalog.slice(59)) {
    assert.equal(scenario.catalog_version, 'mock:ifpmic:controls:v1', `${scenario.id} catalog version`);
    assert.deepEqual(scenario.checkpoints.map(point => point.id), ['start', ...controls[scenario.id].points, 'end'],
      `${scenario.id} literal checkpoint inventory/order`);
    const authored = scenario.events.filter(event => event.source_id === 'mock:controls-catalog');
    assert.ok(authored.length > 0, `${scenario.id} has independently authored control facts`);
    assert.ok(new Set(authored.map(event => event.event_id)).size === authored.length, `${scenario.id} control event IDs are unique`);
    assert.ok(authored.every((event, index) => event.mode === 'mock'
      && event.job_id === `mock:${scenario.id}`
      && typeof event.event_id === 'string' && event.event_id.startsWith('mock:')
      && event.source_seq === index + 1), `${scenario.id} authored control facts have fixed mock identity and sequence`);
  }
});

test('every controls checkpoint replays deterministically and all 15 endpoints match the plan literals', () => {
  const catalog = createScenarioCatalog(workflow, stateContract);
  for (const [id, expected] of Object.entries(controls)) {
    const scenario = catalog.find(item => item.id === id);
    assert.ok(scenario, `${id} exists`);
    const original = structuredClone(scenario);
    for (const point of scenario.checkpoints) {
      assert.ok(Number.isSafeInteger(point.cursor) && point.cursor >= 0 && point.cursor <= scenario.events.length,
        `${id}/${point.id} cursor is bounded`);
      const first = replayScenario(scenario, workflow, stateContract, point.cursor);
      const second = replayScenario(scenario, workflow, stateContract, point.cursor);
      assert.deepEqual(first, second, `${id}/${point.id} deterministic prefix`);
      assert.equal(first.timeline.length + first.duplicate_count, point.cursor, `${id}/${point.id} consumes exact prefix`);
      const literal = checkpointOracle[id]?.[point.id];
      if (literal) assertLiteralSnapshot(first, literal, `${id}/${point.id}`);
      if (id === 'pause-retry' && point.id === 'retried') {
        assert.ok(first.history.some(row => row.kind === 'attempt' && row.step_id === 'P13'
          && row.step.attempt === 1 && row.step.state === 'WAITING_RETRY'),
        'P13 attempt 1 retry wait is archived before attempt 2');
      }
      if (id === 'control-notes-retry' && point.id === 'retried') {
        assert.ok(first.history.some(row => row.kind === 'attempt' && row.step_id === 'P26'
          && row.step.attempt === 1 && row.step.state === 'FAILED'),
        'P26 failed notes attempt is retained in history');
        assert.equal(first.release.publication_count, 1, 'notes retry does not republish');
      }
      if (id === 'control-notes-retry' && point.id === 'completed') {
        assert.equal(first.release.publication_count, 1, 'notes completion preserves the original publication count');
        assert.ok(first.release.receipt_id, 'notes completion preserves the original receipt');
      }
      const rejectedReason = typedRejectionOracle[id]?.[point.id];
      if (rejectedReason) {
        const event = scenario.events[point.cursor - 1];
        const row = first.timeline.find(item => item.event_id === event?.event_id);
        assert.ok(row, `${id}/${point.id} retains the rejected observation row`);
        assert.equal(row.applied, false, `${id}/${point.id} rejection is typed as not applied`);
        const terminalReason = Array.isArray(rejectedReason)
          ? rejectedReason.find(probe => probe.offset === -1)?.reason
          : rejectedReason;
        assert.equal(row.reason, terminalReason, `${id}/${point.id} rejection reason`);
      }
      assert.deepEqual(scenario, original, `${id}/${point.id} does not mutate authored events`);
      if (point.id === 'end') assertLiteralSnapshot(first, expected.end, `${id}/end`);
    }
    const end = replayScenario(scenario, workflow, stateContract, scenario.events.length);
    assertLiteralSnapshot(end, expected.end, `${id}/events-end`);
  }
});

test('explicitly blocked controls probes keep their plan-specified typed rejection reasons', () => {
  const catalog = createScenarioCatalog(workflow, stateContract);
  for (const [id, points] of Object.entries(typedRejectionOracle)) {
    const scenario = catalog.find(item => item.id === id);
    assert.ok(scenario, `${id} exists`);
    for (const [pointId, reason] of Object.entries(points)) {
      const point = scenario.checkpoints.find(item => item.id === pointId);
      assert.ok(point, `${id}/${pointId} is a literal checkpoint`);
      const snapshot = replayScenario(scenario, workflow, stateContract, point.cursor);
      const probes = Array.isArray(reason) ? reason : [{ offset: -1, reason }];
      for (const probe of probes) {
        const event = scenario.events[point.cursor + probe.offset];
        const row = snapshot.timeline.find(item => item.event_id === event?.event_id);
        assert.ok(row, `${id}/${pointId} retains rejected event at offset ${probe.offset}`);
        assert.equal(row.applied, false, `${id}/${pointId} event at offset ${probe.offset} did not apply`);
        assert.equal(row.reason, probe.reason, `${id}/${pointId} typed rejection at offset ${probe.offset}`);
      }
    }
  }
  const flash = catalog.find(item => item.id === 'cancel-flash-unknown');
  assert.ok(flash, 'cancel-flash-unknown exists');
  const rejectedPoint = flash.checkpoints.find(item => item.id === 'rejected');
  assert.ok(rejectedPoint, 'cancel-flash-unknown/rejected is a literal checkpoint');
  const flashSnapshot = replayScenario(flash, workflow, stateContract, rejectedPoint.cursor);
  const flashReasons = new Set(flashSnapshot.timeline.filter(row => row.applied === false).map(row => row.reason));
  for (const reason of ['invalid_bridge_observation', 'invalid_cancel_boundary']) {
    assert.ok(flashReasons.has(reason), `cancel-flash-unknown/rejected records ${reason}`);
  }
  assert.equal(flashSnapshot.device.quarantined, true, 'an idle observation does not release the typed bridge quarantine');

  const releasedNotes = catalog.find(item => item.id === 'cancel-released-notes');
  assert.ok(releasedNotes, 'cancel-released-notes exists');
  const blocked = releasedNotes.checkpoints.find(item => item.id === 'blocked');
  assert.ok(blocked, 'cancel-released-notes/blocked is a literal checkpoint');
  const blockedSnapshot = replayScenario(releasedNotes, workflow, stateContract, blocked.cursor);
  assert.equal(blockedSnapshot.control.commands.at(-1)?.status, 'rejected', 'retry after cancellation is rejected');
  assert.equal(blockedSnapshot.control.commands.at(-1)?.error?.code, 'CONTROL_INELIGIBLE',
    'retry rejection uses the typed ineligible-control reason');
  const p25Reentry = releasedNotes.events[blocked.cursor - 1];
  const p25Row = blockedSnapshot.timeline.find(row => row.event_id === p25Reentry?.event_id);
  assert.equal(p25Row?.applied, false, 'P25 re-entry does not apply');
  assert.equal(p25Row?.reason, 'inactive_step', 'P25 re-entry retains its typed inactive-step rejection');
});

test('revision and idempotency rejections leave the preceding domain projection unchanged', () => {
  const catalog = createScenarioCatalog(workflow, stateContract);
  const compare = (id, beforePoint, rejectedPoint) => {
    const scenario = catalog.find(item => item.id === id);
    assert.ok(scenario, `${id} exists`);
    const beforeCursor = scenario.checkpoints.find(point => point.id === beforePoint)?.cursor;
    const rejectedCursor = scenario.checkpoints.find(point => point.id === rejectedPoint)?.cursor;
    assert.ok(Number.isSafeInteger(beforeCursor), `${id}/${beforePoint} exists`);
    assert.ok(Number.isSafeInteger(rejectedCursor), `${id}/${rejectedPoint} exists`);
    const before = replayScenario(scenario, workflow, stateContract, beforeCursor);
    const after = replayScenario(scenario, workflow, stateContract, rejectedCursor);
    assert.equal(after.revision, before.revision, `${id}/${rejectedPoint} does not advance domain revision`);
    assert.deepEqual(controlDomain(after), controlDomain(before), `${id}/${rejectedPoint} is atomically domain-inert`);
  };
  compare('control-command-conflicts', 'applied-one', 'rejected-two');
  compare('control-command-conflicts', 'duplicate', 'body-conflict');
  compare('control-apply-after-progress', 'advanced', 'rejected');
});
