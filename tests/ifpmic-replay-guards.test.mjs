import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isAllowedStepTransition, evidenceCurrent, projectDeviceClock } from '../src/ifpmic/replay.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateContract = JSON.parse(await readFile(path.join(root, 'docs/ifpmic/design-v1/specs/state-contract.json'), 'utf8'));

// Independent fixed oracle copied from the approved state-contract. Do not derive
// expected adjacency from the object passed to isAllowedStepTransition.
const transitionOracle = {
  PENDING: ['READY', 'SKIPPED', 'CANCELED'],
  READY: ['RUNNING', 'WAITING_HUMAN', 'WAITING_DEVICE', 'PAUSED', 'CANCELED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'WAITING_HUMAN', 'WAITING_AGENT', 'WAITING_DEVICE', 'WAITING_RETRY', 'RECONCILING', 'PAUSE_REQUESTED', 'CANCEL_REQUESTED'],
  WAITING_AGENT: ['RUNNING', 'FAILED', 'WAITING_HUMAN', 'PAUSE_REQUESTED', 'CANCEL_REQUESTED'],
  WAITING_HUMAN: ['READY', 'SUCCEEDED', 'FAILED', 'PAUSED', 'CANCELED'],
  WAITING_DEVICE: ['READY', 'RECONCILING', 'PAUSED', 'CANCELED'],
  WAITING_RETRY: ['READY', 'WAITING_HUMAN', 'PAUSED', 'CANCELED'],
  RECONCILING: ['SUCCEEDED', 'FAILED', 'WAITING_HUMAN', 'WAITING_DEVICE', 'CANCELED'],
  PAUSE_REQUESTED: ['PAUSED', 'SUCCEEDED', 'FAILED', 'RECONCILING', 'CANCEL_REQUESTED'],
  PAUSED: ['READY', 'WAITING_HUMAN', 'WAITING_DEVICE', 'CANCELED'],
  CANCEL_REQUESTED: ['CANCELED', 'RECONCILING'],
  SUCCEEDED: ['SUPERSEDED'],
  FAILED: ['SUPERSEDED'],
  SKIPPED: ['SUPERSEDED'],
  CANCELED: [],
  SUPERSEDED: [],
};

test('isAllowedStepTransition matches every literal allowed edge and rejects every non-edge', () => {
  assert.deepEqual(stateContract.step_transitions, transitionOracle);
  for (const [from, allowed] of Object.entries(transitionOracle)) {
    for (const to of Object.keys(transitionOracle)) {
      assert.equal(isAllowedStepTransition(from, to, stateContract), allowed.includes(to), `${from} -> ${to}`);
    }
    assert.equal(isAllowedStepTransition(from, from, stateContract), false, `${from} self-transition`);
  }
  assert.equal(isAllowedStepTransition('UNKNOWN', 'READY', stateContract), false);
  assert.equal(isAllowedStepTransition('READY', 'UNKNOWN', stateContract), false);
  assert.equal(isAllowedStepTransition('', 'READY', stateContract), false);
  assert.equal(isAllowedStepTransition('READY', '', stateContract), false);
  assert.equal(isAllowedStepTransition('READY', 'RUNNING', null), false);
  assert.equal(isAllowedStepTransition('READY', 'RUNNING', { step_transitions: [] }), false);
  const mutatedContract = structuredClone(stateContract);
  mutatedContract.step_transitions.PENDING.push('RUNNING');
  assert.equal(isAllowedStepTransition('PENDING', 'RUNNING', mutatedContract), false,
    'caller-added transitions cannot expand the pinned canonical adjacency');
});

const validEvidence = Object.freeze({
  job_id: 'job-1',
  step_id: 'P16',
  execution_id: 'exec-3',
  candidate_fingerprint: 'sha256:abc',
  rule_version: 'sam-rules-v4',
  cycle: 2,
  attempt: 1,
  mode: 'mock',
});
const validContext = Object.freeze({ ...validEvidence });

test('evidenceCurrent accepts only exact mock execution coordinates and rule/candidate identity', () => {
  assert.equal(evidenceCurrent(validEvidence, validContext), true);
  const mismatches = [
    ['job_id', 'job-2'], ['step_id', 'P07'], ['execution_id', 'exec-4'],
    ['candidate_fingerprint', 'sha256:def'], ['rule_version', 'sam-rules-v5'],
    ['cycle', 1], ['attempt', 2], ['mode', 'real'],
  ];
  for (const [field, value] of mismatches) {
    assert.equal(evidenceCurrent(validEvidence, { ...validContext, [field]: value }), false, `${field} mismatch`);
    assert.equal(evidenceCurrent({ ...validEvidence, [field]: value }, validContext), false, `${field} evidence mismatch`);
  }
  assert.equal(evidenceCurrent(validEvidence, { ...validContext, mode: 'real' }), false);
});

test('evidenceCurrent fails closed for missing, empty, malformed, or non-mock coordinates', () => {
  for (const field of ['job_id', 'step_id', 'execution_id', 'candidate_fingerprint', 'rule_version']) {
    const missing = { ...validEvidence };
    delete missing[field];
    assert.equal(evidenceCurrent(missing, validContext), false, `missing evidence ${field}`);
    assert.equal(evidenceCurrent(validEvidence, { ...validContext, [field]: '' }), false, `empty context ${field}`);
    assert.equal(evidenceCurrent({ ...validEvidence, [field]: '  ' }, validContext), false, `blank evidence ${field}`);
  }
  for (const value of [0, -1, 1.5, NaN, Infinity, '2', null, undefined]) {
    assert.equal(evidenceCurrent({ ...validEvidence, cycle: value }, validContext), false, `cycle ${String(value)}`);
    assert.equal(evidenceCurrent({ ...validEvidence, attempt: value }, validContext), false, `attempt ${String(value)}`);
  }
  assert.equal(evidenceCurrent({ ...validEvidence, mode: 'real' }, validContext), false);
  assert.equal(evidenceCurrent(validEvidence, { ...validContext, mode: 'live' }), false);
  assert.equal(evidenceCurrent(null, validContext), false);
  assert.equal(evidenceCurrent(validEvidence, null), false);
});

const clock = (now_ms, last_heartbeat_ms, lease_expires_ms, operation_state = 'idle', profile) => ({
  mode: 'mock', now_ms, last_heartbeat_ms, lease_expires_ms, operation_state,
  ...(profile ? { profile } : {}),
});
const projected = (observation, expected) => {
  const before = structuredClone(observation);
  const result = projectDeviceClock(observation);
  assert.deepEqual(observation, before, 'projection must not mutate observation');
  const operation_state = Object.hasOwn(expected, 'operation_state') ? expected.operation_state
    : ['idle', 'active', 'unknown'].includes(observation?.operation_state) ? observation.operation_state : null;
  assert.deepEqual(result, { mode: 'mock', ...expected, operation_state });
  assert.deepEqual(Object.keys(result).sort(), [
    'mode', 'heartbeat_due', 'offline', 'lease_expired', 'quarantined', 'reassign_allowed', 'status', 'operation_state',
  ].sort(), 'projection must omit unapproved input fields');
  return result;
};

test('projectDeviceClock marks heartbeat and offline thresholds at exact boundaries', () => {
  projected(clock(9_999, 0, 60_000), {
    heartbeat_due: false, offline: false, lease_expired: false, quarantined: false, reassign_allowed: false, status: 'AVAILABLE',
  });
  projected(clock(10_000, 0, 60_000), {
    heartbeat_due: true, offline: false, lease_expired: false, quarantined: false, reassign_allowed: false, status: 'AVAILABLE',
  });
  projected(clock(10_001, 0, 60_000), {
    heartbeat_due: true, offline: false, lease_expired: false, quarantined: false, reassign_allowed: false, status: 'AVAILABLE',
  });
  projected(clock(29_999, 0, 60_000), {
    heartbeat_due: true, offline: false, lease_expired: false, quarantined: false, reassign_allowed: false, status: 'AVAILABLE',
  });
  projected(clock(30_000, 0, 60_000), {
    heartbeat_due: true, offline: true, lease_expired: false, quarantined: false, reassign_allowed: false, status: 'OFFLINE',
  });
  projected(clock(30_001, 0, 60_000), {
    heartbeat_due: true, offline: true, lease_expired: false, quarantined: false, reassign_allowed: false, status: 'OFFLINE',
  });
});

test('projectDeviceClock enforces lease expiry and quarantines active/unknown operations', () => {
  projected(clock(9_999, 0, 60_000, 'active'), {
    heartbeat_due: false, offline: false, lease_expired: false, quarantined: false, reassign_allowed: false, status: 'ACTIVE',
  });
  const activeButOffline = projected(clock(59_999, 0, 60_000, 'active'), {
    heartbeat_due: true, offline: true, lease_expired: false, quarantined: false, reassign_allowed: false, status: 'OFFLINE',
  });
  assert.equal(activeButOffline.operation_state, 'active', 'OFFLINE status must preserve a still-running operation');
  projected(clock(60_000, 0, 60_000, 'active'), {
    heartbeat_due: true, offline: true, lease_expired: true, quarantined: true, reassign_allowed: false, status: 'RECONCILING',
  });
  projected(clock(60_001, 0, 60_000, 'active'), {
    heartbeat_due: true, offline: true, lease_expired: true, quarantined: true, reassign_allowed: false, status: 'RECONCILING',
  });
  projected(clock(0, 0, 0, 'unknown'), {
    heartbeat_due: false, offline: false, lease_expired: true, quarantined: true, reassign_allowed: false, status: 'RECONCILING',
  });
  projected(clock(60_000, 0, 60_000, 'idle'), {
    heartbeat_due: true, offline: true, lease_expired: true, quarantined: false, reassign_allowed: false, status: 'OFFLINE',
  });
});

test('projectDeviceClock accepts valid thresholds and fails closed for invalid observations', () => {
  projected(clock(5_000, 0, 20_000, 'idle', { heartbeat_ms: 5_000, offline_ms: 8_000 }), {
    heartbeat_due: true, offline: false, lease_expired: false, quarantined: false, reassign_allowed: false, status: 'AVAILABLE',
  });
  const invalids = [
    null,
    {},
    { ...clock(0, 0, 60_000), mode: 'real' },
    clock(-1, 0, 60_000),
    clock(1, -1, 60_000),
    clock(0, 1, 60_000),
    clock(0, 0, -1),
    clock(NaN, 0, 60_000),
    clock(Infinity, 0, 60_000),
    clock(1.5, 0, 60_000),
    clock(Number.MAX_SAFE_INTEGER + 1, 0, Number.MAX_SAFE_INTEGER + 1),
    clock(0, 0, 60_000, 'busy'),
    clock(0, 0, 60_000, 'idle', { heartbeat_ms: 1.5, offline_ms: 30_000 }),
    clock(0, 0, 60_000, 'idle', { heartbeat_ms: Number.MAX_SAFE_INTEGER + 1, offline_ms: Number.MAX_SAFE_INTEGER + 1 }),
    clock(0, 0, 60_000, null),
    clock(0, 0, 60_000, 'idle', { heartbeat_ms: 0, offline_ms: 30_000 }),
    clock(0, 0, 60_000, 'idle', { heartbeat_ms: 10_000, offline_ms: 9_999 }),
    clock(0, 0, 60_000, 'idle', { heartbeat_ms: Infinity, offline_ms: 30_000 }),
  ];
  for (const observation of invalids) {
    const result = projectDeviceClock(observation);
    assert.deepEqual(result, {
      mode: 'mock', heartbeat_due: false, offline: false, lease_expired: false,
      quarantined: true, reassign_allowed: false, status: 'UNKNOWN', operation_state: null,
    });
  }
});

test('projectDeviceClock treats future heartbeat as UNKNOWN and never enables reassignment', () => {
  projected(clock(5_000, 5_001, 60_000, 'idle'), {
    heartbeat_due: false, offline: false, lease_expired: false, quarantined: true, reassign_allowed: false, status: 'UNKNOWN', operation_state: null,
  });
  projected(clock(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER - 2, Number.MAX_SAFE_INTEGER), {
    heartbeat_due: false, offline: false, lease_expired: false, quarantined: false, reassign_allowed: false, status: 'AVAILABLE',
  });
  projected(clock(Number.MAX_SAFE_INTEGER - 1, 0, Number.MAX_SAFE_INTEGER, 'idle', {
    heartbeat_ms: Number.MAX_SAFE_INTEGER, offline_ms: Number.MAX_SAFE_INTEGER,
  }), {
    heartbeat_due: false, offline: false, lease_expired: false, quarantined: false, reassign_allowed: false, status: 'AVAILABLE',
  });
  for (const observation of [clock(0, 0, 60_000), clock(30_000, 0, 60_000), clock(60_000, 0, 60_000, 'active')]) {
    assert.equal(projectDeviceClock(observation).reassign_allowed, false);
  }
});
