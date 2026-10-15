import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { replayScenario } from '../src/ifpmic/replay.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specs = path.join(root, 'docs/ifpmic/design-v1/specs');
const [rawWorkflow, stateContract] = await Promise.all([
  readFile(path.join(specs, 'workflow.v1.json'), 'utf8').then(JSON.parse),
  readFile(path.join(specs, 'state-contract.json'), 'utf8').then(JSON.parse),
]);

function event(id, type, step_id, overrides = {}) {
  return {
    event_id: `evt:${id}`,
    source_id: 'mock-source:1',
    source_seq: id,
    type,
    mode: 'mock',
    job_id: 'mock:scenario-1',
    step_id,
    cycle: 1,
    attempt: 1,
    execution_id: `mock:${step_id}:c1:a1`,
    ...overrides,
  };
}

function scenario(events, id = 'scenario-1') {
  return { id, title: 'mock replay fixture', requirement_ids: [], events };
}

function stepEvents(seq, step_id, state = 'SUCCEEDED') {
  return [
    event(seq, 'step', step_id, { payload: { state: 'READY' } }),
    event(seq + 1, 'step', step_id, { payload: { state: 'RUNNING' } }),
    event(seq + 2, 'step', step_id, { payload: { state } }),
  ];
}

function humanWaitEvents(seq, step_id) {
  return [
    event(seq, 'step', step_id, { payload: { state: 'READY' } }),
    event(seq + 1, 'step', step_id, { payload: { state: 'RUNNING' } }),
    event(seq + 2, 'step', step_id, { payload: { state: 'WAITING_HUMAN' } }),
    event(seq + 3, 'human', step_id, { payload: {
      actor: 'mock:human', task_id: `mock:task:${step_id}:c1`, plan_version: 'mock:plan:v1', evidence_id: `mock:evidence:${step_id}`,
    } }),
    event(seq + 4, 'step', step_id, { payload: { state: 'SUCCEEDED' } }),
  ];
}

function deepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(child => deepFrozen(child, seen));
}

test('replayScenario creates deterministic mock initial plan without mutating inputs', () => {
  const input = scenario([]);
  const beforeScenario = structuredClone(input);
  const beforeWorkflow = structuredClone(rawWorkflow);
  const beforeContract = structuredClone(stateContract);
  const first = replayScenario(input, rawWorkflow, stateContract);
  const second = replayScenario(input, rawWorkflow, stateContract);
  assert.deepEqual(first, second);
  assert.deepEqual(input, beforeScenario);
  assert.deepEqual(rawWorkflow, beforeWorkflow);
  assert.deepEqual(stateContract, beforeContract);
  assert.ok(deepFrozen(first), 'the complete replay result is deeply frozen');
  assert.equal(first.mode, 'mock');
  assert.equal(first.job_id, 'mock:scenario-1');
  assert.equal(first.cycle, 1);
  assert.equal(first.candidate_fingerprint, 'mock:candidate:A');
  assert.equal(first.rule_version, 'mock:rules:v1');
  assert.equal(first.current_step, 'P01');
  assert.equal(first.rework_count, 0);
  assert.equal(first.timeline.length, 0);
  assert.equal(Object.keys(first.steps).length, 29);
  for (const [step_id, row] of Object.entries(first.steps)) {
    assert.equal(row.state, 'PENDING', row.step_id);
    assert.equal(row.attempt, 1, row.step_id);
    assert.equal(row.execution_id, `mock:${step_id}:c1:a1`, step_id);
  }
});

test('replayScenario rejects any supplied workflow that diverges from its canonical bundle', () => {
  const mutations = [
    workflow => { workflow.nodes.find(node => node.id === 'P07').owner = 'agent'; },
    workflow => { workflow.nodes.find(node => node.id === 'P07').owner = 'code-dev'; },
    workflow => { workflow.nodes.find(node => node.id === 'P16').owner = 'arch-runner'; },
    workflow => { workflow.nodes.find(node => node.id === 'P01').on_pass = 'P03'; },
    workflow => { workflow.nodes.find(node => node.id === 'P01').skip_policy = 'REUSE'; },
  ];
  for (const mutate of mutations) {
    const altered = structuredClone(rawWorkflow);
    mutate(altered);
    assert.throws(() => replayScenario(scenario([]), altered, stateContract), error => {
      assert.equal(error.constructor, TypeError);
      return true;
    });
  }
});

test('step success advances only to the original next node and does not auto-run it', () => {
  const result = replayScenario(scenario([
    ...stepEvents(1, 'P01'),
  ]), rawWorkflow, stateContract);
  assert.equal(result.current_step, 'P02');
  assert.equal(result.steps.P01.state, 'SUCCEEDED');
  assert.equal(result.steps.P02.state, 'PENDING');
  assert.deepEqual(result.timeline.slice(-1).map(row => ({ type: row.type, step_id: row.step_id, applied: row.applied })), [
    { type: 'step', step_id: 'P01', applied: true },
  ]);
});

test('agent completion remains an execution observation and cannot complete human work or gates', () => {
  const agentOnly = replayScenario(scenario([
    event(1, 'agent', 'P07', { payload: { status: 'completed' } }),
    ...stepEvents(2, 'P07'),
  ]), rawWorkflow, stateContract);
  assert.equal(agentOnly.current_step, 'P01');
  assert.equal(agentOnly.steps.P07.state, 'PENDING');
  assert.equal(agentOnly.timeline.some(row => row.applied && row.type === 'step'), false);

  const systemWithoutMeasurement = replayScenario(scenario([
    ...stepEvents(1, 'P16'),
  ]), rawWorkflow, stateContract);
  assert.equal(systemWithoutMeasurement.current_step, 'P01');
  assert.equal(systemWithoutMeasurement.steps.P16.state, 'PENDING');
});

test('human-owned completion requires an explicit matching human submission', () => {
  const events = [];
  let seq = 0;
  for (const step_id of ['P01', 'P02', 'P03', 'P04', 'P05']) {
    events.push(...stepEvents(++seq, step_id)); seq += 2;
  }
  events.push(...humanWaitEvents(++seq, 'X01')); seq += 4;
  // P06 is also human-owned: an agent completion alone must not advance it.
  events.push(event(++seq, 'step', 'P06', { payload: { state: 'READY' } }));
  events.push(event(++seq, 'step', 'P06', { payload: { state: 'RUNNING' } }));
  events.push(event(++seq, 'step', 'P06', { payload: { state: 'WAITING_HUMAN' } }));
  events.push(event(++seq, 'agent', 'P06', { payload: { status: 'completed' } }));
  events.push(event(++seq, 'step', 'P06', { payload: { state: 'SUCCEEDED' } }));
  const blocked = replayScenario(scenario(events), rawWorkflow, stateContract);
  assert.equal(blocked.current_step, 'P06');
  assert.equal(blocked.steps.P06.state, 'WAITING_HUMAN');

  events.push(event(++seq, 'human', 'P06', { payload: {
    actor: 'mock:human', task_id: 'mock:task:P06:c1', plan_version: 'mock:plan:v1', evidence_id: 'mock:evidence:P06',
  } }));
  events.push(event(++seq, 'step', 'P06', { payload: { state: 'SUCCEEDED' } }));
  const accepted = replayScenario(scenario(events), rawWorkflow, stateContract);
  assert.equal(accepted.current_step, 'P07');
  assert.equal(accepted.steps.P06.state, 'SUCCEEDED');
});

test('system quality success requires current complete PASS measurement evidence', () => {
  const events = [];
  let seq = 0;
  for (const step_id of ['P01', 'P02', 'P03', 'P04', 'P05', 'X01', 'P06', 'P07', 'P08', 'P09', 'P10', 'P11', 'P12', 'P13', 'P14', 'P15']) {
    const owner = rawWorkflow.nodes.find(node => node.id === step_id).owner;
    if (owner === 'human') {
      events.push(...humanWaitEvents(++seq, step_id)); seq += 4;
    } else {
      events.push(...stepEvents(++seq, step_id)); seq += 2;
    }
  }
  events.push(event(++seq, 'step', 'P16', { payload: { state: 'READY' } }));
  events.push(event(++seq, 'step', 'P16', { payload: { state: 'RUNNING' } }));
  const evidence = {
    mode: 'mock', job_id: 'mock:scenario-1', step_id: 'P16', cycle: 1, attempt: 1,
    execution_id: 'mock:P16:c1:a1', candidate_fingerprint: 'mock:candidate:A',
    rule_version: 'mock:rules:v1', evidence_id: 'mock:evidence:P16', complete: true,
  };
  events.push(event(++seq, 'measurement', 'P16', { payload: { evidence, verdict: 'PASS' } }));
  events.push(event(++seq, 'step', 'P16', { payload: { state: 'SUCCEEDED' } }));
  const accepted = replayScenario(scenario(events), rawWorkflow, stateContract);
  assert.equal(accepted.current_step, 'P17');
  assert.equal(accepted.steps.P16.state, 'SUCCEEDED');

  const staleEvidence = structuredClone(events);
  const measurement = staleEvidence.at(-2);
  measurement.payload.evidence.candidate_fingerprint = 'mock:candidate:OLD';
  const rejected = replayScenario(scenario(staleEvidence), rawWorkflow, stateContract);
  assert.equal(rejected.current_step, 'P16');
  assert.equal(rejected.steps.P16.state, 'RUNNING');
});

test('duplicate identities are idempotent and conflicting payloads are counted without another row', () => {
  const first = event(1, 'step', 'P01', { payload: { state: 'READY' } });
  const same = structuredClone(first);
  const conflicting = { ...structuredClone(first), payload: { state: 'WAITING_HUMAN' } };
  const result = replayScenario(scenario([first, same, conflicting]), rawWorkflow, stateContract);
  assert.equal(result.timeline.length, 1);
  assert.equal(result.timeline[0].event_id, first.event_id);
  assert.equal(result.steps.P01.state, 'READY');
  assert.equal(result.duplicate_count, 2);
  assert.equal(result.conflict_count, 1);
});

test('event ID and source-sequence dedup axes suppress fresh transport aliases', () => {
  const base = event(1, 'step', 'P01', { payload: { state: 'READY' } });
  const sameEventIdNewSequence = { ...structuredClone(base), source_seq: 2 };
  const sameSequenceNewEventId = { ...structuredClone(base), event_id: 'fresh-event-id' };
  const byEventId = replayScenario(scenario([base, sameEventIdNewSequence]), rawWorkflow, stateContract);
  assert.equal(byEventId.timeline.length, 1);
  assert.equal(byEventId.duplicate_count, 1);
  assert.equal(byEventId.conflict_count, 0);

  const bySourceSequence = replayScenario(scenario([base, sameSequenceNewEventId]), rawWorkflow, stateContract);
  assert.equal(bySourceSequence.timeline.length, 1);
  assert.equal(bySourceSequence.duplicate_count, 1);
  assert.equal(bySourceSequence.conflict_count, 0);
});

test('a conflicting event alias cannot be replayed through a fresh ID on the aliased sequence', () => {
  const base = event(1, 'step', 'P01', { payload: { state: 'READY' } });
  const collision = { ...structuredClone(base), source_seq: 2, payload: { state: 'RUNNING' } };
  const freshAlias = { ...structuredClone(collision), event_id: 'fresh-event-after-collision' };
  const result = replayScenario(scenario([base, collision, freshAlias]), rawWorkflow, stateContract);
  assert.equal(result.timeline.length, 1);
  assert.equal(result.steps.P01.state, 'READY');
  assert.equal(result.duplicate_count, 2);
  assert.equal(result.conflict_count, 1);
});

test('rejected event keys remain reserved and a corrected payload on that key conflicts', () => {
  const rejected = event(1, 'step', 'P01', { payload: { state: 'SKIPPED' } });
  const changedPayload = { ...structuredClone(rejected), payload: { state: 'READY' } };
  const result = replayScenario(scenario([rejected, changedPayload]), rawWorkflow, stateContract);
  assert.equal(result.steps.P01.state, 'PENDING');
  assert.equal(result.timeline.length, 1);
  assert.equal(result.duplicate_count, 1);
  assert.equal(result.conflict_count, 1);
});

test('per-source sequence watermark ignores older distinct events', () => {
  const agentResult = replayScenario(scenario([
    event(10, 'agent', 'P01', { payload: { status: 'completed' } }),
    event(9, 'agent', 'P01', { event_id: 'older-agent-event', payload: { status: 'running' } }),
  ]), rawWorkflow, stateContract);
  assert.equal(agentResult.steps.P01.agent_status, 'completed');
  assert.equal(agentResult.timeline[0].applied, true);
  assert.equal(agentResult.timeline[1].applied, false);

  const deviceResult = replayScenario(scenario([
    event(10, 'device', 'P01', { payload: {
      mode: 'mock', now_ms: 1_000, last_heartbeat_ms: 1_000, lease_expires_ms: 2_000, operation_state: 'idle',
    } }),
    event(9, 'device', 'P01', { event_id: 'older-device-event', payload: {
      mode: 'mock', now_ms: 1_000, last_heartbeat_ms: 0, lease_expires_ms: 1_000, operation_state: 'unknown',
    } }),
  ]), rawWorkflow, stateContract);
  assert.equal(deviceResult.device.operation_state, 'idle');
  assert.equal(deviceResult.device.quarantined, false);
  assert.equal(deviceResult.timeline[1].applied, false);
});

test('rejected high-sequence events do not poison the source watermark for valid lower sequence events', () => {
  const invalidEvents = [
    event(999, 'step', 'P01', { mode: 'real', payload: { state: 'READY' } }),
    event(999, 'step', 'P01', { unexpected_field: true, payload: { state: 'READY' } }),
    event(999, 'step', 'P01', { payload: { state: 'SKIPPED' } }),
  ];
  for (const invalid of invalidEvents) {
    const valid = { ...event(1, 'step', 'P01', { payload: { state: 'READY' } }), event_id: 'valid-lower-sequence' };
    const result = replayScenario(scenario([invalid, valid]), rawWorkflow, stateContract);
    assert.equal(result.steps.P01.state, 'READY');
    assert.equal(result.timeline[1].applied, true);
  }
});

test('device telemetry older than the latest accepted device clock is ignored even with a newer sequence', () => {
  const result = replayScenario(scenario([
    event(10, 'device', 'P01', { payload: {
      mode: 'mock', now_ms: 10_000, last_heartbeat_ms: 10_000, lease_expires_ms: 20_000, operation_state: 'idle',
    } }),
    event(11, 'device', 'P01', { payload: {
      mode: 'mock', now_ms: 9_999, last_heartbeat_ms: 9_999, lease_expires_ms: 20_000, operation_state: 'unknown',
    } }),
  ]), rawWorkflow, stateContract);
  assert.equal(result.device.status, 'AVAILABLE');
  assert.equal(result.device.operation_state, 'idle');
  assert.equal(result.device.quarantined, false);
  assert.equal(result.timeline[0].applied, true);
  assert.equal(result.timeline[1].applied, false);
  assert.equal(result.timeline[1].reason, 'stale_device_clock');
});

test('device telemetry with older clock is ignored across distinct sources too', () => {
  const result = replayScenario(scenario([
    event(5, 'device', 'P01', { source_id: 'bridge-a', payload: {
      mode: 'mock', now_ms: 10_000, last_heartbeat_ms: 10_000, lease_expires_ms: 20_000, operation_state: 'idle',
    } }),
    event(1, 'device', 'P01', { source_id: 'bridge-b', payload: {
      mode: 'mock', now_ms: 9_000, last_heartbeat_ms: 0, lease_expires_ms: 9_000, operation_state: 'unknown',
    } }),
  ]), rawWorkflow, stateContract);
  assert.equal(result.device.status, 'AVAILABLE');
  assert.equal(result.device.operation_state, 'idle');
  assert.equal(result.device.quarantined, false);
  assert.equal(result.timeline[1].applied, false);
  assert.equal(result.timeline[1].reason, 'stale_device_clock');
});

test('stale coordinates, malformed events and unsupported types are ignored without leaking payloads', () => {
  const stale = event(1, 'step', 'P01', { cycle: 0, payload: { state: 'RUNNING', secret: 'DO_NOT_LEAK' } });
  const badMode = event(2, 'step', 'P01', { mode: 'real', payload: { state: 'RUNNING' } });
  const missingSeq = event(3, 'step', 'P01', { source_seq: 0, payload: { state: 'RUNNING' } });
  const unknown = event(4, 'untrusted-special-type', 'P01', { payload: { token: 'DO_NOT_LEAK' } });
  const result = replayScenario(scenario([stale, badMode, missingSeq, unknown]), rawWorkflow, stateContract);
  assert.equal(result.current_step, 'P01');
  assert.equal(result.steps.P01.state, 'PENDING');
  assert.equal(result.timeline.length, 4);
  assert.ok(result.timeline.every(row => row.applied === false));
  assert.ok(result.timeline.every(row => row.mode === 'mock'));
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_LEAK/);
});

test('cursor replay is deterministic and a shorter cursor rolls back later observations', () => {
  const events = [
    ...stepEvents(1, 'P01'),
    ...stepEvents(4, 'P02'),
  ];
  const full = replayScenario(scenario(events), rawWorkflow, stateContract);
  const prefix = replayScenario(scenario(events), rawWorkflow, stateContract, 3);
  const samePrefix = replayScenario(scenario(events), rawWorkflow, stateContract, 3);
  assert.deepEqual(prefix, samePrefix);
  assert.equal(full.current_step, 'P03');
  assert.equal(prefix.current_step, 'P02');
  assert.equal(prefix.timeline.length, 3);
  assert.equal(prefix.steps.P02.state, 'PENDING');
});

test('expired active device observation quarantines replay and blocks step success', () => {
  const result = replayScenario(scenario([
    event(1, 'step', 'P01', { payload: { state: 'READY' } }),
    event(2, 'step', 'P01', { payload: { state: 'RUNNING' } }),
    event(3, 'device', 'P01', { payload: {
      mode: 'mock', now_ms: 60_000, last_heartbeat_ms: 0, lease_expires_ms: 60_000, operation_state: 'active',
    } }),
    event(4, 'step', 'P01', { payload: { state: 'WAITING_HUMAN' } }),
    event(5, 'step', 'P01', { payload: { state: 'SUCCEEDED' } }),
  ]), rawWorkflow, stateContract);
  assert.deepEqual(result.device, {
    mode: 'mock', heartbeat_due: true, offline: true, lease_expired: true,
    quarantined: true, reassign_allowed: false, status: 'RECONCILING', operation_state: 'active',
  });
  assert.equal(result.status, 'RECONCILING');
  assert.equal(result.current_step, 'P01');
  assert.equal(result.steps.P01.state, 'WAITING_HUMAN');
  assert.equal(result.real_publish_allowed, false);
  assert.deepEqual(result.timeline.slice(-2).map(row => row.reason), ['', 'reconciliation_required']);
});

test('device quarantine stays latched after a newer idle observation without a reconciliation protocol', () => {
  const result = replayScenario(scenario([
    event(1, 'step', 'P01', { payload: { state: 'READY' } }),
    event(2, 'step', 'P01', { payload: { state: 'RUNNING' } }),
    event(3, 'device', 'P01', { payload: {
      mode: 'mock', now_ms: 60_000, last_heartbeat_ms: 0, lease_expires_ms: 60_000, operation_state: 'active',
    } }),
    event(4, 'device', 'P01', { payload: {
      mode: 'mock', now_ms: 61_000, last_heartbeat_ms: 61_000, lease_expires_ms: 62_000, operation_state: 'idle',
    } }),
  ]), rawWorkflow, stateContract);
  assert.equal(result.device.operation_state, 'idle');
  assert.equal(result.device.quarantined, true);
  assert.equal(result.device.status, 'RECONCILING');
  assert.equal(result.status, 'RECONCILING');
  assert.equal(result.real_publish_allowed, false);
});

test('step skips, unknown fields and forbidden transitions fail closed', () => {
  const events = [
    event(1, 'step', 'P01', { payload: { state: 'SKIPPED', reason: 'not approved' } }),
    event(2, 'step', 'P01', { hidden_runtime_secret: 'DO_NOT_LEAK', payload: { state: 'READY' } }),
    event(3, 'step', 'P01', { payload: { state: 'READY', private_note: 'DO_NOT_LEAK' } }),
  ];
  const result = replayScenario(scenario(events), rawWorkflow, stateContract);
  assert.equal(result.current_step, 'P01');
  assert.equal(result.steps.P01.state, 'PENDING');
  assert.ok(result.timeline.every(row => row.applied === false));
  assert.doesNotMatch(JSON.stringify(result), /not approved|DO_NOT_LEAK|hidden_runtime_secret/);
});

test('a bare RUNNING to RECONCILING step transition requires explicit reconciliation evidence', () => {
  const result = replayScenario(scenario([
    event(1, 'step', 'P01', { payload: { state: 'READY' } }),
    event(2, 'step', 'P01', { payload: { state: 'RUNNING' } }),
    event(3, 'step', 'P01', { payload: { state: 'RECONCILING' } }),
  ]), rawWorkflow, stateContract);
  assert.equal(result.steps.P01.state, 'RUNNING');
  assert.equal(result.status, 'RUNNING');
  assert.equal(result.timeline.at(-1).applied, false);
  assert.equal(result.timeline.at(-1).reason, 'control_evidence_required');
});

test('scenario, event and evidence opaque IDs follow strict grammar without leaking rejected values', () => {
  const secretMarker = 'tc-secret-opaque-marker';
  for (const id of [` ${secretMarker}`, `${secretMarker} `, `${secretMarker}@invalid`, 'a'.repeat(129)]) {
    assert.throws(() => replayScenario(scenario([], id), rawWorkflow, stateContract), error => {
      assert.equal(error.constructor, TypeError);
      assert.doesNotMatch(error.message, new RegExp(secretMarker));
      return true;
    });
  }

  const badEventId = event(1, 'agent', 'P01', { event_id: `${secretMarker}@bad` , payload: { status: 'completed' } });
  const badSourceId = event(2, 'agent', 'P01', { source_id: `${secretMarker}@bad`, payload: { status: 'completed' } });
  const result = replayScenario(scenario([badEventId, badSourceId]), rawWorkflow, stateContract);
  assert.ok(result.timeline.every(row => row.applied === false));
  assert.deepEqual(result.timeline.map(row => [row.event_id, row.source_id]), [
    ['[invalid]', 'mock-source:1'], ['evt:2', '[invalid]'],
  ]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secretMarker));

  const events = [];
  let seq = 0;
  for (const step_id of ['P01', 'P02', 'P03', 'P04', 'P05']) {
    events.push(...stepEvents(++seq, step_id)); seq += 2;
  }
  events.push(...humanWaitEvents(++seq, 'X01'));
  const humanEvent = events.find(item => item.type === 'human');
  humanEvent.payload.evidence_id = `mock:${secretMarker} @bad`;
  const evidenceResult = replayScenario(scenario(events), rawWorkflow, stateContract);
  assert.equal(evidenceResult.current_step, 'X01');
  assert.equal(evidenceResult.steps.X01.evidence_ids.length, 0);
  assert.equal(evidenceResult.timeline.find(row => row.type === 'human').applied, false);
  assert.doesNotMatch(JSON.stringify(evidenceResult), new RegExp(secretMarker));
});
