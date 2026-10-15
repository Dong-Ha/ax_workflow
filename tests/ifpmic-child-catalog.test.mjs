import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScenarioCatalog } from '../src/ifpmic/scenarios.mjs';
import { replayScenario } from '../src/ifpmic/replay.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specs = path.join(root, 'docs/ifpmic/design-v1/specs');
const [workflow, stateContract, baseline50] = await Promise.all([
  readFile(path.join(specs, 'workflow.v1.json'), 'utf8').then(JSON.parse),
  readFile(path.join(specs, 'state-contract.json'), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'docs/ifpmic/evidence/v2/children-baseline-50.json'), 'utf8').then(JSON.parse),
]);

const childIds = [
  'agent-wait', 'agent-handoff', 'agent-child-failure', 'agent-child-question',
  'agent-child-retry-limit', 'agent-child-stale-cycle', 'agent-child-permissions',
  'agent-child-interrupted', 'agent-child-canceled',
];
const childEvents = ['p12_coordinator', 'child_request', 'child_assignment', 'child_result', 'child_collect', 'child_integrated'];
const childRequirementIds = ['REQ-01', 'REQ-02', 'REQ-05', 'REQ-06', 'REQ-10', 'REQ-11', 'REQ-12', 'REQ-13', 'REQ-14'];

// Literal C3 endpoint and checkpoint oracle from V2-CHILDREN.md; never derive
// expected states from the catalog author's events or replay output.
const oracle = {
  'agent-wait': {
    requested: ['P12', 'RUNNING', 1, 'RUNNING', 'RUNNING', null, 1],
    waiting: ['P12', 'RUNNING', 1, 'WAITING_AGENT', 'WAITING_AGENT', 'running', 1],
    blocked: ['P12', 'RUNNING', 1, 'WAITING_AGENT', 'WAITING_AGENT', 'running', 1],
    end: ['P12', 'RUNNING', 1, 'WAITING_AGENT', 'WAITING_AGENT', 'running', 1],
  },
  'agent-handoff': {
    waiting: ['P12', 'RUNNING', 1, 'WAITING_AGENT', 'WAITING_AGENT', 'running', 1],
    returned: ['P12', 'RUNNING', 1, 'WAITING_AGENT', 'WAITING_AGENT', 'completed', 1],
    collected: ['P12', 'RUNNING', 1, 'RUNNING', 'RUNNING', 'completed', 1],
    conflict: ['P12', 'RUNNING', 1, 'RUNNING', 'RUNNING', 'completed', 1],
    integrated: ['P12', 'RUNNING', 1, 'RUNNING', 'COMPLETED', 'completed', 1],
    passed: ['P13', 'RUNNING', 1, 'SUCCEEDED', 'COMPLETED', 'completed', 1],
    end: ['END', 'COMPLETED', 1, 'SUCCEEDED', 'COMPLETED', 'completed', 1],
  },
  'agent-child-failure': {
    failed: ['P12', 'RUNNING', 1, 'WAITING_AGENT', 'WAITING_AGENT', 'failed', 1],
    collected: ['P12', 'RUNNING', 1, 'RUNNING', 'RUNNING', 'failed', 1],
    backoff: ['P12', 'RUNNING', 1, 'WAITING_RETRY', 'FAILED', 'failed', 1],
    retried: ['P12', 'RUNNING', 1, 'READY', null, null, 0],
    stale: ['P12', 'RUNNING', 1, 'READY', null, null, 0],
    recovered: ['P13', 'RUNNING', 1, 'SUCCEEDED', 'COMPLETED', 'completed', 1],
    end: ['END', 'COMPLETED', 1, 'SUCCEEDED', 'COMPLETED', 'completed', 1],
  },
  'agent-child-question': {
    question: ['P12', 'WAITING_HUMAN', 1, 'WAITING_AGENT', 'WAITING_AGENT', 'needs_human', 1],
    'waiting-human': ['P12', 'WAITING_HUMAN', 1, 'WAITING_HUMAN', 'WAITING_HUMAN', 'needs_human', 1],
    rejected: ['P12', 'WAITING_HUMAN', 1, 'WAITING_HUMAN', 'WAITING_HUMAN', 'needs_human', 1],
    answered: ['P12', 'WAITING_HUMAN', 1, 'WAITING_HUMAN', 'WAITING_HUMAN', 'needs_human', 1],
    resumed: ['P12', 'RUNNING', 1, 'WAITING_AGENT', 'WAITING_AGENT', 'running', 2],
    integrated: ['P12', 'RUNNING', 1, 'RUNNING', 'COMPLETED', 'completed', 2],
    end: ['END', 'COMPLETED', 1, 'SUCCEEDED', 'COMPLETED', 'completed', 2],
  },
  'agent-child-retry-limit': {
    'backoff-one': ['P12', 'RUNNING', 1, 'WAITING_RETRY', 'FAILED', 'failed', 1],
    'attempt-two': ['P12', 'RUNNING', 1, 'READY', null, null, 0],
    'backoff-two': ['P12', 'RUNNING', 1, 'WAITING_RETRY', 'FAILED', 'failed', 1],
    'attempt-three': ['P12', 'RUNNING', 1, 'READY', null, null, 0],
    capped: ['P12', 'WAITING_HUMAN', 1, 'WAITING_HUMAN', 'FAILED', 'failed', 1],
    'blocked-four': ['P12', 'WAITING_HUMAN', 1, 'WAITING_HUMAN', 'FAILED', 'failed', 1],
    end: ['P12', 'WAITING_HUMAN', 1, 'WAITING_HUMAN', 'FAILED', 'failed', 1],
  },
  'agent-child-stale-cycle': {
    rerouted: ['P11', 'RUNNING', 2, 'PENDING', null, null, 0],
    waiting: ['P12', 'RUNNING', 2, 'WAITING_AGENT', 'WAITING_AGENT', 'running', 1],
    stale: ['P12', 'RUNNING', 2, 'WAITING_AGENT', 'WAITING_AGENT', 'running', 1],
    recovered: ['P13', 'RUNNING', 2, 'SUCCEEDED', 'COMPLETED', 'completed', 1],
    end: ['END', 'COMPLETED', 2, 'SUCCEEDED', 'COMPLETED', 'completed', 1],
  },
  'agent-child-permissions': {
    denied: ['P12', 'RUNNING', 1, 'RUNNING', 'RUNNING', null, 0],
    waiting: ['P12', 'RUNNING', 1, 'WAITING_AGENT', 'WAITING_AGENT', 'running', 1],
    collected: ['P12', 'RUNNING', 1, 'RUNNING', 'RUNNING', 'completed', 1],
    'integration-denied': ['P12', 'RUNNING', 1, 'RUNNING', 'RUNNING', 'completed', 1],
    integrated: ['P12', 'RUNNING', 1, 'RUNNING', 'COMPLETED', 'completed', 1],
    end: ['END', 'COMPLETED', 1, 'SUCCEEDED', 'COMPLETED', 'completed', 1],
  },
  'agent-child-interrupted': {
    interrupted: ['P12', 'RUNNING', 1, 'WAITING_AGENT', 'WAITING_AGENT', 'interrupted', 1],
    collected: ['P12', 'WAITING_HUMAN', 1, 'WAITING_HUMAN', 'WAITING_HUMAN', 'interrupted', 1],
    'denied-retry': ['P12', 'WAITING_HUMAN', 1, 'WAITING_HUMAN', 'WAITING_HUMAN', 'interrupted', 1],
    end: ['P12', 'WAITING_HUMAN', 1, 'WAITING_HUMAN', 'WAITING_HUMAN', 'interrupted', 1],
  },
  'agent-child-canceled': {
    canceled: ['P12', 'RUNNING', 1, 'WAITING_AGENT', 'WAITING_AGENT', 'canceled', 1],
    collected: ['P12', 'WAITING_HUMAN', 1, 'WAITING_HUMAN', 'WAITING_HUMAN', 'canceled', 1],
    'recovery-approved': ['P12', 'WAITING_HUMAN', 1, 'WAITING_HUMAN', 'WAITING_HUMAN', 'canceled', 1],
    backoff: ['P12', 'RUNNING', 1, 'WAITING_RETRY', 'FAILED', 'canceled', 1],
    retried: ['P12', 'RUNNING', 1, 'READY', null, null, 0],
    recovered: ['P13', 'RUNNING', 1, 'SUCCEEDED', 'COMPLETED', 'completed', 1],
    end: ['END', 'COMPLETED', 1, 'SUCCEEDED', 'COMPLETED', 'completed', 1],
  },
};
const pointIds = ids => ['start', ...ids, 'end'];
const startOracle = ['P01', 'RUNNING', 1, 'PENDING', null, null, 0];
const attemptOracle = {
  'agent-child-failure': { retried: 2, stale: 2, recovered: 2, end: 2 },
  'agent-child-retry-limit': { 'attempt-two': 2, 'backoff-two': 2, 'attempt-three': 3, capped: 3, 'blocked-four': 3, end: 3 },
  'agent-child-canceled': { retried: 2, recovered: 2, end: 2 },
};

test('catalog migrates exactly nine independently specified child scenarios after the fixed 50-case prefix', () => {
  const catalog = createScenarioCatalog(workflow, stateContract);
  assert.equal(baseline50.scenario_count, 50);
  assert.equal(catalog.length, 74);
  assert.deepEqual(catalog.slice(0, 50).map(item => item.id), baseline50.scenarios.map(item => item.id));
  assert.deepEqual(catalog.slice(50, 59).map(item => item.id), childIds);
  for (const item of catalog.slice(50, 59)) {
    assert.equal(item.catalog_version, 'mock:ifpmic:children:v1');
    assert.deepEqual(item.requirement_ids, childRequirementIds);
    assert.deepEqual(item.checkpoints.map(checkpoint => checkpoint.id), pointIds(Object.keys(oracle[item.id]).filter(id => id !== 'end')));
  }
});

test('each child endpoint and every checkpoint matches literal status, cycle, P12 state and parent-child projection', () => {
  const catalog = createScenarioCatalog(workflow, stateContract);
  for (const id of childIds) {
    const scenario = catalog.find(item => item.id === id);
    assert.ok(scenario, `${id} exists`);
    assert.deepEqual(scenario.checkpoints.map(point => point.id), pointIds(Object.keys(oracle[id]).filter(key => key !== 'end')), `${id} checkpoint IDs`);
    const original = structuredClone(scenario);
    const startPoint = scenario.checkpoints.find(row => row.id === 'start');
    assert.equal(startPoint.cursor, 0, `${id}/start begins before observations`);
    const start = replayScenario(scenario, workflow, stateContract, startPoint.cursor);
    assert.deepEqual([start.current_step, start.status, start.cycle, start.steps.P12.state,
      start.steps.P12.child_coordination?.status ?? null, null, 0], startOracle, `${id}/start literal state`);
    for (const [checkpointId, expected] of Object.entries(oracle[id])) {
      const point = scenario.checkpoints.find(row => row.id === checkpointId);
      assert.ok(point, `${id}/${checkpointId} exists`);
      assert.ok(Number.isSafeInteger(point.cursor) && point.cursor >= 0 && point.cursor <= scenario.events.length,
        `${id}/${checkpointId} cursor is bounded`);
      const first = replayScenario(scenario, workflow, stateContract, point.cursor);
      const second = replayScenario(scenario, workflow, stateContract, point.cursor);
      assert.deepEqual(first, second, `${id}/${checkpointId} is deterministic`);
      const [current, status, cycle, p12State, coordinatorStatus, childStatus, ordinal] = expected;
      assert.equal(first.current_step, current, `${id}/${checkpointId}/current`);
      assert.equal(first.status, status, `${id}/${checkpointId}/status`);
      assert.equal(first.cycle, cycle, `${id}/${checkpointId}/cycle`);
      assert.equal(first.steps.P12.state, p12State, `${id}/${checkpointId}/P12`);
      assert.equal(first.steps.P12.attempt, attemptOracle[id]?.[checkpointId] ?? 1, `${id}/${checkpointId}/P12 attempt`);
      assert.equal(first.real_publish_allowed, false, `${id}/${checkpointId}/no real authority`);
      assert.equal(first.job_id, `mock:${id}`, `${id}/${checkpointId}/job`);
      assert.equal(first.steps.P12.child_coordination?.status ?? null, coordinatorStatus, `${id}/${checkpointId}/coordinator`);
      const requests = first.steps.P12.child_coordination?.requests ?? [];
      const lastRequest = requests.at(-1);
      const observedChildStatus = lastRequest?.result?.status ?? (lastRequest?.assignment?.child_execution_id ? 'running' : null);
      assert.equal(observedChildStatus, childStatus, `${id}/${checkpointId}/child result or running`);
      assert.equal(requests.length ? requests.at(-1).ordinal : 0, ordinal, `${id}/${checkpointId}/request ordinal`);
      assert.deepEqual(scenario, original, `${id}/${checkpointId} does not mutate fixture`);
    }
  }
});

test('child scenario observations are uniquely sequenced mock events and opaque IDs do not expose source material', () => {
  const catalog = createScenarioCatalog(workflow, stateContract);
  for (const scenario of catalog.slice(50, 59)) {
    const authored = scenario.events.filter(event => event.source_id === 'mock:child-examples');
    assert.ok(authored.length > 0, `${scenario.id} has explicit child events`);
    assert.ok(authored.every(event => event.mode === 'mock'), `${scenario.id} events are mock only`);
    assert.deepEqual(authored.map(event => event.source_seq), authored.map((_, index) => index + 1), `${scenario.id} sequence is contiguous`);
    assert.deepEqual(authored.map(event => event.event_id), authored.map((_, index) => `mock:${scenario.id}:child-example:${index + 1}`));
    const replay = replayScenario(scenario, workflow, stateContract);
    const rows = replay.timeline.filter(row => row.source_id === 'mock:child-examples');
    assert.equal(rows.length, authored.length, `${scenario.id} all authored events appear in journal`);
    const appliedIds = authored.filter(event => childEvents.includes(event.type)
      && replay.timeline.find(row => row.event_id === event.event_id)?.applied)
      .map(event => event.payload?.evidence_id).filter(Boolean);
    assert.equal(new Set(appliedIds).size, appliedIds.length, `${scenario.id} accepted evidence IDs unique; deliberate stale resend may reuse an old ID only as rejected`);
    for (const event of authored) {
      assert.equal(event.job_id, `mock:${scenario.id}`);
      assert.ok(!JSON.stringify(event).includes('/home/'), `${scenario.id} excludes local paths`);
      assert.ok(!JSON.stringify(event).includes('Bearer '), `${scenario.id} excludes credentials`);
    }
  }
});
