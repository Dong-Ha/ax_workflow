import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createScenarioCatalog } from '../src/ifpmic/scenarios.mjs';
import { replayScenario } from '../src/ifpmic/replay.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specs = path.join(root, 'docs/ifpmic/design-v1/specs');
const [workflow, stateContract] = await Promise.all([
  readFile(path.join(specs, 'workflow.v1.json'), 'utf8').then(JSON.parse),
  readFile(path.join(specs, 'state-contract.json'), 'utf8').then(JSON.parse),
]);

const expectedScenarioIds = [
  'happy-path', 'human-wait', 'human-wait-oss', 'debug-failure', 'review-failure',
  'sam-failure', 'tem-failure', 'static-failure', 'sqe-failure', 'oss-failure', 'oss-design-change',
  'plan-rejection', 'release-reject-code', 'release-reject-design', 'metadata-recovery',
  'metric-missing', 'stale-result', 'stale-candidate', 'stale-approval', 'duplicate-events',
  'retry-limit', 'cycle-limit', 'device-boundaries', 'flash-unknown', 'notes-only',
];

// Literal checkpoint oracle from docs/ifpmic/V2-UI.md. start/end are required
// for every scenario and all other IDs are scenario-local observations.
const checkpointOracle = {
  'happy-path': ['planning', 'development', 'quality', 'approved', 'published', 'completed'],
  'human-wait': ['wait', 'agent-completed', 'blocked'],
  'human-wait-oss': ['wait', 'agent-completed', 'blocked'],
  'debug-failure': ['failed', 'returned'],
  'review-failure': ['failed', 'returned'],
  'oss-failure': ['rejected', 'failed', 'returned'],
  'oss-design-change': ['rejected', 'failed', 'returned'],
  'sam-failure': ['failed', 'returned'],
  'tem-failure': ['failed', 'returned'],
  'static-failure': ['failed', 'returned'],
  'sqe-failure': ['failed', 'returned'],
  'plan-rejection': ['rejected', 'failed', 'returned'],
  'release-reject-code': ['rejected', 'failed', 'returned'],
  'release-reject-design': ['rejected', 'failed', 'returned'],
  'metadata-recovery': ['rejected', 'returned', 'corrected', 'approved', 'completed'],
  'metric-missing': ['incomplete', 'blocked'],
  'stale-result': ['stale', 'blocked'],
  'stale-candidate': ['stale', 'blocked'],
  'stale-approval': ['stale'],
  'duplicate-events': ['first', 'duplicates'],
  'retry-limit': ['wait-first', 'attempt-two', 'wait-second', 'limit'],
  'cycle-limit': ['return-one', 'return-two', 'return-three', 'limit'],
  'device-boundaries': [
    'time-9999', 'time-10000', 'time-10001', 'time-29999', 'time-30000', 'time-30001',
    'time-59999', 'time-60000', 'time-60001',
  ],
  'flash-unknown': ['unknown', 'idle'],
  'notes-only': ['notes-failed', 'notes-retry', 'completed'],
};

// Independent fixed final-state oracle; it intentionally does not derive route
// expectations from the imported workflow graph.
const finalOracle = {
  'happy-path': { current_step: 'END', status: 'COMPLETED', cycle: 1, succeeded: 29, publication_count: 1 },
  'human-wait': { current_step: 'P07', step: 'P07', state: 'WAITING_HUMAN', status: 'WAITING_HUMAN' },
  'human-wait-oss': { current_step: 'P21', step: 'P21', state: 'WAITING_HUMAN', status: 'WAITING_HUMAN' },
  'debug-failure': { current_step: 'P11', status: 'RUNNING', cycle: 2, rework_count: 1 },
  'review-failure': { current_step: 'P11', status: 'RUNNING', cycle: 2, rework_count: 1 },
  'oss-failure': { current_step: 'P11', status: 'RUNNING', cycle: 2, rework_count: 1 },
  'oss-design-change': { current_step: 'P07', status: 'RUNNING', cycle: 2, rework_count: 1 },
  'sam-failure': { current_step: 'P07', status: 'RUNNING', cycle: 2, rework_count: 1 },
  'tem-failure': { current_step: 'P11', status: 'RUNNING', cycle: 2, rework_count: 1 },
  'static-failure': { current_step: 'P11', status: 'RUNNING', cycle: 2, rework_count: 1 },
  'sqe-failure': { current_step: 'P07', status: 'RUNNING', cycle: 2, rework_count: 1 },
  'plan-rejection': { current_step: 'P02', status: 'RUNNING', cycle: 2, rework_count: 1, approved: false },
  'release-reject-code': { current_step: 'P11', status: 'RUNNING', cycle: 2, rework_count: 1, approved: false },
  'release-reject-design': { current_step: 'P07', status: 'RUNNING', cycle: 2, rework_count: 1, approved: false },
  'metadata-recovery': { current_step: 'END', status: 'COMPLETED', cycle: 1, rework_count: 1, x02Attempt: 2, x03Attempt: 2, publication_count: 1 },
  'metric-missing': { current_step: 'P16', status: 'RUNNING', state: 'RUNNING', gate_verdict: 'INCONCLUSIVE' },
  'stale-result': { current_step: 'P16', state: 'RUNNING', gate_verdict: null },
  'stale-candidate': { current_step: 'P16', state: 'RUNNING', gate_verdict: null },
  'stale-approval': { current_step: 'X03', state: 'WAITING_HUMAN', approved: false },
  'duplicate-events': { current_step: 'P01', state: 'READY', timeline: 1, duplicate_count: 3, conflict_count: 1 },
  'retry-limit': { current_step: 'P13', state: 'WAITING_HUMAN', attempt: 3, archivedAttempts: 2 },
  'cycle-limit': { current_step: 'P13', state: 'FAILED', status: 'WAITING_HUMAN', cycle: 4, rework_count: 3 },
  'device-boundaries': { current_step: 'P22', state: 'RUNNING', status: 'RECONCILING', reassign_allowed: false },
  'flash-unknown': { current_step: 'P22', state: 'RUNNING', status: 'RECONCILING', reassign_allowed: false },
  'notes-only': { current_step: 'END', status: 'COMPLETED', state: 'SUCCEEDED', p26Attempt: 2, publication_count: 1 },
};

function deepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every(child => deepFrozen(child, seen));
}

function assertExpectedEnd(result, expected, scenarioId) {
  if (expected.current_step !== undefined) assert.equal(result.current_step, expected.current_step, scenarioId);
  if (expected.status !== undefined) assert.equal(result.status, expected.status, scenarioId);
  if (expected.cycle !== undefined) assert.equal(result.cycle, expected.cycle, scenarioId);
  if (expected.rework_count !== undefined) assert.equal(result.rework_count, expected.rework_count, scenarioId);
  if (expected.publication_count !== undefined) assert.equal(result.release.publication_count, expected.publication_count, scenarioId);
  if (expected.approved !== undefined) assert.equal(result.release.approved, expected.approved, scenarioId);
  if (expected.reassign_allowed !== undefined) assert.equal(result.device.reassign_allowed, expected.reassign_allowed, scenarioId);
  if (expected.step) assert.equal(result.steps[expected.step].state, expected.state, scenarioId);
  if (expected.state && expected.step === undefined) {
    const stepId = expected.current_step === 'END' ? 'P26' : expected.current_step;
    assert.equal(result.steps[stepId].state, expected.state, scenarioId);
  }
  if (expected.gate_verdict !== undefined) assert.equal(result.steps.P16.gate_verdict, expected.gate_verdict, scenarioId);
  if (expected.succeeded !== undefined) {
    assert.equal(Object.values(result.steps).filter(step => step.state === 'SUCCEEDED').length, expected.succeeded, scenarioId);
  }
  if (expected.x02Attempt !== undefined) assert.equal(result.steps.X02.attempt, expected.x02Attempt, scenarioId);
  if (expected.x03Attempt !== undefined) assert.equal(result.steps.X03.attempt, expected.x03Attempt, scenarioId);
  if (expected.p26Attempt !== undefined) assert.equal(result.steps.P26.attempt, expected.p26Attempt, scenarioId);
  if (expected.attempt !== undefined) assert.equal(result.steps.P13.attempt, expected.attempt, scenarioId);
  if (expected.archivedAttempts !== undefined) {
    assert.equal(result.history.filter(row => row.kind === 'attempt' && row.step_id === 'P13').length, expected.archivedAttempts, scenarioId);
  }
  if (expected.timeline !== undefined) assert.equal(result.timeline.length, expected.timeline, scenarioId);
  if (expected.duplicate_count !== undefined) assert.equal(result.duplicate_count, expected.duplicate_count, scenarioId);
  if (expected.conflict_count !== undefined) assert.equal(result.conflict_count, expected.conflict_count, scenarioId);
  if (scenarioId === 'cycle-limit') assert.ok(result.failure_bundle.length > 0);
}

test('fixed mock catalog inventory, frozen values and checkpoint IDs match literal oracle', () => {
  const originalWorkflow = structuredClone(workflow);
  const originalContract = structuredClone(stateContract);
  const catalog = createScenarioCatalog(workflow, stateContract);
  assert.deepEqual(catalog.map(item => item.id).sort(), [...expectedScenarioIds].sort());
  assert.equal(catalog.length, 25);
  assert.deepEqual(workflow, originalWorkflow);
  assert.deepEqual(stateContract, originalContract);
  assert.ok(deepFrozen(catalog), 'catalog, scenarios, events, payloads and checkpoints are deeply frozen');
  assert.deepEqual(createScenarioCatalog(workflow, stateContract), catalog, 'catalog construction is deterministic');

  for (const scenario of catalog) {
    assert.equal(scenario.title.length > 0, true, scenario.id);
    assert.ok(scenario.requirement_ids.length > 0, scenario.id);
    assert.ok(Array.isArray(scenario.events), scenario.id);
    const checkpoints = scenario.checkpoints;
    assert.deepEqual(checkpoints.map(point => point.id), ['start', ...checkpointOracle[scenario.id], 'end'], `${scenario.id} checkpoint order`);
    assert.equal(checkpoints[0].cursor, 0, `${scenario.id} start prefix`);
    assert.equal(checkpoints.at(-1).cursor, scenario.events.length, `${scenario.id} end prefix`);
    const cursors = checkpoints.map(point => point.cursor);
    assert.equal(new Set(checkpoints.map(point => point.id)).size, checkpoints.length, `${scenario.id} checkpoint IDs are unique`);
    assert.ok(cursors.every((cursor, index) => Number.isSafeInteger(cursor)
      && cursor >= 0 && cursor <= scenario.events.length
      && (index === 0 || cursor >= cursors[index - 1])), `${scenario.id} cursor prefix is monotonic`);
    for (const event of scenario.events) {
      assert.equal(event.mode, 'mock', `${scenario.id}/${event.event_id} is mock-only`);
      for (const field of ['event_id', 'source_id', 'source_seq', 'job_id', 'step_id', 'cycle', 'attempt', 'execution_id', 'type', 'payload']) {
        assert.ok(Object.hasOwn(event, field), `${scenario.id}/${field} is present`);
      }
      assert.equal(event.job_id, `mock:${scenario.id}`, `${scenario.id} job identity`);
    }
  }
  assert.deepEqual(workflow, originalWorkflow, 'catalog builder did not mutate workflow input');
  assert.deepEqual(stateContract, originalContract, 'catalog builder did not mutate state contract input');
});

test('all fixed scenario endpoints match independent status, route, attempt, evidence and publication oracle', () => {
  const catalog = createScenarioCatalog(workflow, stateContract);
  for (const scenario of catalog) {
    const before = structuredClone(scenario);
    const result = replayScenario(scenario, workflow, stateContract);
    assert.deepEqual(scenario, before, `${scenario.id} replay leaves catalog fixture unchanged`);
    assert.equal(result.mode, 'mock', scenario.id);
    assert.equal(result.scenario_id, scenario.id);
    assert.equal(result.real_publish_allowed, false, scenario.id);
    assertExpectedEnd(result, finalOracle[scenario.id], scenario.id);
  }
});

test('every checkpoint deterministically replays exactly its event prefix and leaves raw events untouched', () => {
  const catalog = createScenarioCatalog(workflow, stateContract);
  for (const scenario of catalog) {
    const original = structuredClone(scenario);
    for (const point of scenario.checkpoints) {
      const first = replayScenario(scenario, workflow, stateContract, point.cursor);
      const second = replayScenario(scenario, workflow, stateContract, point.cursor);
      assert.deepEqual(first, second, `${scenario.id}/${point.id} deterministic prefix`);
      assert.equal(first.mode, 'mock', `${scenario.id}/${point.id}`);
      assert.equal(first.timeline.length + first.duplicate_count, point.cursor, `${scenario.id}/${point.id} cursor consumed as prefix`);
      assert.deepEqual(scenario, original, `${scenario.id}/${point.id} does not mutate catalog events`);
    }
    const start = replayScenario(scenario, workflow, stateContract, 0);
    assert.equal(start.current_step, 'P01', `${scenario.id}/start`);
    assert.equal(start.cycle, 1, `${scenario.id}/start`);
    assert.ok(Object.values(start.steps).every(step => step.state === 'PENDING'), `${scenario.id}/start has no prior-state leakage`);
  }
});

test('critical prefixes retain expected wait, failure, quality and release boundaries', () => {
  const catalog = createScenarioCatalog(workflow, stateContract);
  const byId = new Map(catalog.map(item => [item.id, item]));
  const at = (scenarioId, checkpointId) => {
    const scenario = byId.get(scenarioId);
    const point = scenario.checkpoints.find(item => item.id === checkpointId);
    assert.ok(point, `${scenarioId}/${checkpointId} checkpoint is defined`);
    return replayScenario(scenario, workflow, stateContract, point.cursor);
  };

  for (const id of ['human-wait', 'human-wait-oss']) {
    const waiting = at(id, 'wait');
    assert.equal(waiting.steps[waiting.current_step].state, 'WAITING_HUMAN', id);
    const agentCompleted = at(id, 'agent-completed');
    assert.equal(agentCompleted.steps[agentCompleted.current_step].agent_status, 'completed', id);
    assert.equal(agentCompleted.steps[agentCompleted.current_step].state, 'WAITING_HUMAN', id);
    assert.equal(at(id, 'blocked').steps[agentCompleted.current_step].state, 'WAITING_HUMAN', id);
  }

  for (const id of ['sam-failure', 'tem-failure', 'static-failure', 'sqe-failure']) {
    const failed = at(id, 'failed');
    const gateId = id === 'sam-failure' ? 'P16' : id === 'tem-failure' ? 'P18' : id === 'static-failure' ? 'P20' : 'P24';
    assert.equal(failed.steps[gateId].gate_verdict, 'FAIL', `${id} failure evidence visible before return`);
    if (id === 'sqe-failure') {
      assert.ok(failed.steps.P22.state === 'SUCCEEDED' && failed.steps.P23.state === 'SUCCEEDED', 'SQE trial and report precede P24 gate');
    }
    const returned = at(id, 'returned');
    assert.equal(returned.cycle, 2, `${id} new cycle`);
    assert.equal(returned.steps[gateId].gate_verdict, null, `${id} old gate does not unlock new cycle`);
    assert.ok(returned.history[0].steps[gateId].gate_verdict === 'FAIL', `${id} old failure remains in history`);
  }

  const metadata = byId.get('metadata-recovery');
  const rejected = replayScenario(metadata, workflow, stateContract, metadata.checkpoints.find(point => point.id === 'rejected').cursor);
  assert.equal(rejected.steps.X03.state, 'WAITING_HUMAN');
  assert.equal(rejected.release.rejection, 'reject_release_metadata');
  assert.equal(rejected.release.approved, false);
  const returned = replayScenario(metadata, workflow, stateContract, metadata.checkpoints.find(point => point.id === 'returned').cursor);
  assert.equal(returned.cycle, 1);
  assert.equal(returned.steps.X02.attempt, 2);
  assert.equal(returned.steps.X03.attempt, 2);
  for (const id of ['P16', 'P18', 'P20', 'P24']) assert.equal(returned.steps[id].gate_verdict, 'PASS', `metadata/${id} preserved quality gate`);
  const corrected = replayScenario(metadata, workflow, stateContract, metadata.checkpoints.find(point => point.id === 'corrected').cursor);
  assert.ok(corrected.release.manifest);
  const approved = replayScenario(metadata, workflow, stateContract, metadata.checkpoints.find(point => point.id === 'approved').cursor);
  assert.equal(approved.release.approved, true);
  const completed = replayScenario(metadata, workflow, stateContract, metadata.checkpoints.find(point => point.id === 'completed').cursor);
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.release.publication_count, 1);
});

test('device and notes checkpoint edge values are literal and never authorize real work', () => {
  const catalog = createScenarioCatalog(workflow, stateContract);
  const byId = new Map(catalog.map(item => [item.id, item]));
  const read = (scenarioId, checkpointId) => {
    const scenario = byId.get(scenarioId);
    const checkpoint = scenario.checkpoints.find(item => item.id === checkpointId);
    assert.ok(checkpoint);
    return replayScenario(scenario, workflow, stateContract, checkpoint.cursor);
  };

  const deviceStates = [
    ['time-9999', false, false], ['time-10000', true, false], ['time-10001', true, false],
    ['time-29999', true, false], ['time-30000', true, true], ['time-30001', true, true],
    ['time-59999', true, true], ['time-60000', true, true], ['time-60001', true, true],
  ];
  for (const [checkpoint, heartbeatDue, offline] of deviceStates) {
    const result = read('device-boundaries', checkpoint);
    assert.equal(result.device.heartbeat_due, heartbeatDue, checkpoint);
    assert.equal(result.device.offline, offline, checkpoint);
    assert.equal(result.device.reassign_allowed, false, checkpoint);
    assert.equal(result.real_publish_allowed, false, checkpoint);
  }
  const unknown = read('flash-unknown', 'unknown');
  assert.equal(unknown.device.status, 'RECONCILING');
  assert.equal(unknown.device.operation_state, 'unknown');
  assert.equal(unknown.device.quarantined, true);
  assert.equal(unknown.status, 'RECONCILING');
  assert.equal(unknown.steps.P22.state, 'RUNNING');
  assert.equal(unknown.device.reassign_allowed, false);
  const idle = read('flash-unknown', 'idle');
  assert.equal(idle.device.quarantined, true, 'later idle telemetry cannot clear the quarantine latch');
  assert.equal(idle.status, 'RECONCILING');
  assert.equal(idle.device.reassign_allowed, false);

  const notesFailed = read('notes-only', 'notes-failed');
  assert.equal(notesFailed.status, 'RELEASED_PENDING_NOTES');
  assert.equal(notesFailed.steps.P25.state, 'SUCCEEDED');
  assert.equal(notesFailed.release.publication_count, 1);
  const notesRetry = read('notes-only', 'notes-retry');
  assert.equal(notesRetry.steps.P26.attempt, 2);
  assert.equal(notesRetry.steps.P26.state, 'READY');
  assert.equal(notesRetry.release.publication_count, 1);
  assert.equal(notesRetry.release.receipt_id, notesFailed.release.receipt_id);
});
