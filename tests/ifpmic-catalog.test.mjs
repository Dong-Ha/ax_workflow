import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createScenarioCatalog } from '../src/ifpmic/scenarios.mjs';
import { replayScenario } from '../src/ifpmic/replay.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specs = path.join(root, 'docs/ifpmic/design-v1/specs');
const [workflow, stateContract, priorCatalogEvidence, routingUiBaseline] = await Promise.all([
  readFile(path.join(specs, 'workflow.v1.json'), 'utf8').then(JSON.parse),
  readFile(path.join(specs, 'state-contract.json'), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'docs/ifpmic/evidence/v2/ui-catalog.json'), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'docs/ifpmic/evidence/v2/routing-ui-baseline-32.json'), 'utf8').then(JSON.parse),
]);

const expectedScenarioIds = [
  'happy-path', 'human-wait', 'human-wait-oss', 'debug-failure', 'review-failure',
  'sam-failure', 'tem-failure', 'static-failure', 'sqe-failure', 'oss-failure', 'oss-design-change',
  'plan-rejection', 'release-reject-code', 'release-reject-design', 'metadata-recovery',
  'metric-missing', 'stale-result', 'stale-candidate', 'stale-approval', 'duplicate-events',
  'retry-limit', 'cycle-limit', 'device-boundaries', 'flash-unknown', 'notes-only',
  'spec-question-wait', 'spec-question-resolution', 'spec-question-retry', 'spec-question-repeat',
  'remote-uncertainty', 'remote-recovery', 'remote-device-quarantine',
  'routing-reuse', 'routing-new-hw', 'routing-exempt', 'routing-pilot-denied',
  'routing-no-change', 'routing-no-change-denied', 'routing-candidate', 'routing-replan', 'routing-metadata',
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
  'spec-question-wait': ['question', 'blocked'],
  'spec-question-resolution': ['question', 'answered', 'review-blocked', 'reviewed', 'continued'],
  'spec-question-retry': ['question', 'answered', 'reviewed-first', 'retry-wait', 'retried', 'review-blocked', 'reviewed', 'continued'],
  'spec-question-repeat': ['question', 'answered', 'question-two', 'stale-answer', 'answered-two', 'reviewed', 'continued'],
  'remote-uncertainty': ['unknown', 'queried-unknown', 'absent', 'conflict', 'stale'],
  'remote-recovery': ['unknown', 'absent', 'found', 'late', 'completed'],
  'remote-device-quarantine': ['unknown', 'quarantined', 'idle', 'blocked'],
  'routing-reuse': ['local', 'early', 'confirmed', 'reused'],
  'routing-new-hw': ['early-blocked', 'confirmed', 'reused'],
  'routing-exempt': ['confirmed', 'paired', 'report-blocked', 'reported', 'exempt'],
  'routing-pilot-denied': ['denied', 'confirmed', 'blocked'],
  'routing-no-change': ['production', 'analysed', 'closed', 'terminal'],
  'routing-no-change-denied': ['production', 'analysed', 'denied'],
  'routing-candidate': ['confirmed', 'changed', 'blocked'],
  'routing-replan': ['rejected', 'rerouted', 'stale', 'replanned'],
  'routing-metadata': ['exempt', 'rejected', 'retried'],
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
  'spec-question-wait': { current_step: 'P03', status: 'WAITING_HUMAN', state: 'WAITING_HUMAN', cycle: 1, requirements_version: 'mock:requirements:v1', spec: { question_id: 'mock:question:spec-question-wait:q1', ordinal: 1, resolved: false, reviewed: false } },
  'spec-question-resolution': { current_step: 'P04', status: 'RUNNING', cycle: 1, requirements_version: 'mock:requirements:v2', spec: { question_id: 'mock:question:spec-question-resolution:q1', ordinal: 1, resolved: true, reviewed: true, review_attempt: 1, review_execution_id: 'mock:P03:c1:a1' } },
  'spec-question-retry': { current_step: 'P04', status: 'RUNNING', cycle: 1, requirements_version: 'mock:requirements:v2', p03Attempt: 2, spec: { question_id: 'mock:question:spec-question-retry:q1', ordinal: 1, resolved: true, reviewed: true, review_attempt: 2, review_execution_id: 'mock:P03:c1:a2' } },
  'spec-question-repeat': { current_step: 'P04', status: 'RUNNING', cycle: 1, requirements_version: 'mock:requirements:v3', spec: { question_id: 'mock:question:spec-question-repeat:q2', ordinal: 2, resolved: true, reviewed: true, review_attempt: 1, review_execution_id: 'mock:P03:c1:a1' } },
  'remote-uncertainty': { current_step: 'P25', status: 'RECONCILING', cycle: 1, attempt: 1, publication_count: 0, receipt_id: null, remote: { operation_key: 'mock:remote-uncertainty:operation', query_seq: 3, outcome: 'conflict' } },
  'remote-recovery': { current_step: 'END', status: 'COMPLETED', cycle: 1, attempt: 1, publication_count: 1, receipt_id: 'mock:remote-recovery:remote:receipt', remote: { operation_key: 'mock:remote-recovery:operation', query_seq: 2, outcome: 'found' } },
  'remote-device-quarantine': { current_step: 'P25', status: 'RECONCILING', cycle: 1, attempt: 1, publication_count: 0, receipt_id: null, device_quarantined: true, remote: { operation_key: 'mock:remote-device-quarantine:operation', query_seq: 0, outcome: 'unknown' } },
  'routing-reuse': { current_step: 'END', status: 'COMPLETED', cycle: 1, publication_count: 1, routing: { profile_kind: 'pilot', confirmed: true }, gate_dispositions: ['PASS', 'PASS', 'PASS', 'PASS'] },
  'routing-new-hw': { current_step: 'P11', status: 'RUNNING', cycle: 1, publication_count: 0, step: 'P11', state: 'PENDING', routing: { change_type: 'NEW_HW', reuse_steps: ['P10'] } },
  'routing-exempt': { current_step: 'END', status: 'COMPLETED', cycle: 1, publication_count: 1, routing: { profile_kind: 'policy_demo', confirmed: true }, gate_dispositions: ['EXEMPT', 'EXEMPT', 'EXEMPT', 'EXEMPT'] },
  'routing-pilot-denied': { current_step: 'P15', status: 'RUNNING', cycle: 1, publication_count: 0, step: 'P15', state: 'PENDING', routing: { profile_kind: 'pilot', confirmed: true } },
  'routing-no-change': { current_step: 'P12', status: 'NO_CHANGE', cycle: 1, publication_count: 0, step: 'P12', state: 'SKIPPED', receipt_id: null, manifest_id: null, no_change: true },
  'routing-no-change-denied': { current_step: 'P12', status: 'RUNNING', cycle: 1, publication_count: 0, step: 'P12', state: 'PENDING', no_change: null },
  'routing-candidate': { current_step: 'END', status: 'COMPLETED', cycle: 1, publication_count: 1, routing: { candidate_fingerprint: 'mock:candidate:B' }, gate_dispositions: ['PASS', 'PASS', 'PASS', 'PASS'] },
  'routing-replan': { current_step: 'P06', status: 'RUNNING', cycle: 2, rework_count: 1, publication_count: 0, routing: { plan_version: 'mock:routing-replan:plan:c2', confirmed: true } },
  'routing-metadata': { current_step: 'END', status: 'COMPLETED', cycle: 1, rework_count: 1, x02Attempt: 2, x03Attempt: 2, publication_count: 1, gate_dispositions: ['EXEMPT', 'EXEMPT', 'EXEMPT', 'EXEMPT'] },
};

const routingReuseScope = ['P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10', 'P11', 'P12'];
const routingSuffixFromP02 = ['P02', 'P03', 'P04', 'P05', 'X01', 'P06', 'P07', 'P08', 'P09', 'P10', 'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19', 'P20', 'P21', 'P22', 'P23', 'P24', 'X02', 'X03', 'P25', 'P26'];
const routingSuffixFromP07 = ['P07', 'P08', 'P09', 'P10', 'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19', 'P20', 'P21', 'P22', 'P23', 'P24', 'X02', 'X03', 'P25', 'P26'];
const routingGateIds = ['P16', 'P18', 'P20', 'P24'];
const routingCheckpointOracle = {
  'routing-reuse': {
    local: { current: 'P03', status: 'RUNNING', cycle: 1, states: { P03: 'PENDING' }, confirmed: false, localReuse: ['P03'] },
    early: { current: 'X01', status: 'RUNNING', cycle: 1, states: { P03: 'SKIPPED', P04: 'SKIPPED', P05: 'SKIPPED', X01: 'PENDING' }, confirmed: false },
    confirmed: { current: 'P06', status: 'RUNNING', cycle: 1, states: { X01: 'SUCCEEDED', P06: 'PENDING' }, confirmed: true, reuseScope: routingReuseScope },
    reused: { current: 'P13', status: 'RUNNING', cycle: 1, states: Object.fromEntries(routingReuseScope.map(id => [id, 'SKIPPED'])), confirmed: true, reuseScope: routingReuseScope },
  },
  'routing-new-hw': {
    'early-blocked': { current: 'P03', status: 'RUNNING', cycle: 1, states: { P03: 'PENDING' }, confirmed: false, reason: 'invalid_reuse_confirmation' },
    confirmed: { current: 'P06', status: 'RUNNING', cycle: 1, states: { P03: 'SUCCEEDED', P04: 'SUCCEEDED', P05: 'SUCCEEDED', P06: 'PENDING' }, confirmed: true, reuseScope: ['P10'] },
    reused: { current: 'P11', status: 'RUNNING', cycle: 1, states: { P10: 'SKIPPED', P11: 'PENDING' }, confirmed: true, reuseScope: ['P10'] },
  },
  'routing-exempt': {
    confirmed: { current: 'P06', status: 'RUNNING', cycle: 1, confirmed: true, exempt_steps: ['P15', 'P16', 'P17', 'P18', 'P19', 'P20', 'P21', 'P22', 'P24'] },
    paired: { current: 'P17', status: 'RUNNING', cycle: 1, states: { P15: 'SKIPPED', P16: 'SKIPPED', P17: 'PENDING' }, gates: { P16: 'EXEMPT' }, confirmed: true },
    'report-blocked': { current: 'P23', status: 'RUNNING', cycle: 1, states: { P22: 'SKIPPED', P23: 'RUNNING', P24: 'PENDING' }, gates: { P16: 'EXEMPT', P18: 'EXEMPT', P20: 'EXEMPT' }, reason: 'exemption_report_required' },
    reported: { current: 'P24', status: 'RUNNING', cycle: 1, states: { P23: 'SUCCEEDED', P24: 'PENDING' }, exemptionPerformed: false },
    exempt: { current: 'X02', status: 'RUNNING', cycle: 1, states: { P24: 'SKIPPED', X02: 'PENDING' }, gates: { P16: 'EXEMPT', P18: 'EXEMPT', P20: 'EXEMPT', P24: 'EXEMPT' } },
  },
  'routing-pilot-denied': {
    denied: { current: 'X01', status: 'WAITING_HUMAN', cycle: 1, states: { X01: 'WAITING_HUMAN' }, confirmed: false, reason: 'invalid_exemption_scope' },
    confirmed: { current: 'P06', status: 'RUNNING', cycle: 1, confirmed: true, exempt_steps: [] },
    blocked: { current: 'P15', status: 'RUNNING', cycle: 1, states: { P15: 'PENDING' }, reason: 'skip_authorization_required' },
  },
  'routing-no-change': {
    production: { current: 'P12', status: 'RUNNING', cycle: 1, states: { P11: 'SKIPPED', P12: 'PENDING' }, analyses: { P11: { needs_changes: false, requirements_satisfied: true } } },
    analysed: { current: 'P12', status: 'RUNNING', cycle: 1, states: { P12: 'PENDING' }, analyses: { P12: { needs_changes: false, requirements_satisfied: true } } },
    closed: { current: 'P12', status: 'NO_CHANGE', cycle: 1, states: { P12: 'SKIPPED', P13: 'PENDING' }, noChange: true, publication: 0 },
    terminal: { current: 'P12', status: 'NO_CHANGE', cycle: 1, states: { P12: 'SKIPPED', P13: 'PENDING' }, noChange: true, publication: 0, reason: 'terminal_no_change' },
  },
  'routing-no-change-denied': {
    production: { current: 'P12', status: 'RUNNING', cycle: 1, states: { P11: 'SKIPPED', P12: 'PENDING' } },
    analysed: { current: 'P12', status: 'RUNNING', cycle: 1, states: { P12: 'PENDING' }, analyses: { P12: { needs_changes: true, requirements_satisfied: true } } },
    denied: { current: 'P12', status: 'RUNNING', cycle: 1, states: { P12: 'PENDING' }, noChange: false, publication: 0, reason: 'invalid_no_change' },
  },
  'routing-candidate': {
    confirmed: { current: 'P06', status: 'RUNNING', cycle: 1, confirmed: true },
    changed: { current: 'P13', status: 'RUNNING', cycle: 1, states: { P13: 'RUNNING' }, candidate: 'mock:candidate:B' },
    blocked: { current: 'P15', status: 'RUNNING', cycle: 1, states: { P15: 'PENDING' }, candidate: 'mock:candidate:B', reason: 'stale_route_context' },
  },
  'routing-replan': {
    rejected: { current: 'X01', status: 'FAILED', cycle: 1, states: { X01: 'FAILED' } },
    rerouted: { current: 'P02', status: 'RUNNING', cycle: 2, states: { P02: 'PENDING' }, contextCycle: 1, historyKinds: ['cycle'] },
    stale: { current: 'P02', status: 'RUNNING', cycle: 2, states: { P02: 'RUNNING' }, contextCycle: 1, confirmed: false, reason: 'invalid_route_context' },
    replanned: { current: 'P06', status: 'RUNNING', cycle: 2, states: { P03: 'SUCCEEDED', P04: 'SUCCEEDED', P05: 'SUCCEEDED', X01: 'SUCCEEDED', P06: 'PENDING' }, contextCycle: 2, confirmed: true, planVersion: 'mock:routing-replan:plan:c2', required: routingSuffixFromP02, historyKinds: ['cycle', 'route_plan'] },
  },
  'routing-metadata': {
    exempt: { current: 'X02', status: 'RUNNING', cycle: 1, gates: { P16: 'EXEMPT', P18: 'EXEMPT', P20: 'EXEMPT', P24: 'EXEMPT' } },
    rejected: { current: 'X03', status: 'WAITING_HUMAN', cycle: 1, states: { X03: 'WAITING_HUMAN' }, approved: false, rejection: 'reject_release_metadata' },
    retried: { current: 'X02', status: 'RUNNING', cycle: 1, rework: 1, states: { X02: 'PENDING', X03: 'PENDING', P25: 'PENDING', P26: 'PENDING' }, attempts: { X02: 2, X03: 2 }, gates: { P16: 'EXEMPT', P18: 'EXEMPT', P20: 'EXEMPT', P24: 'EXEMPT' }, manifest: null, historyKinds: ['release_metadata', 'attempt', 'attempt'] },
  },
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
  if (expected.p03Attempt !== undefined) assert.equal(result.steps.P03.attempt, expected.p03Attempt, scenarioId);
  if (expected.archivedAttempts !== undefined) {
    assert.equal(result.history.filter(row => row.kind === 'attempt' && row.step_id === 'P13').length, expected.archivedAttempts, scenarioId);
  }
  if (expected.timeline !== undefined) assert.equal(result.timeline.length, expected.timeline, scenarioId);
  if (expected.duplicate_count !== undefined) assert.equal(result.duplicate_count, expected.duplicate_count, scenarioId);
  if (expected.conflict_count !== undefined) assert.equal(result.conflict_count, expected.conflict_count, scenarioId);
  if (expected.requirements_version !== undefined) assert.equal(result.requirements_version, expected.requirements_version, scenarioId);
  if (Object.hasOwn(expected, 'receipt_id')) assert.equal(result.release.receipt_id, expected.receipt_id, scenarioId);
  if (expected.remote !== undefined) {
    for (const [key, value] of Object.entries(expected.remote)) assert.equal(result.remote_reconciliation[key], value, `${scenarioId}/remote.${key}`);
  }
  if (expected.device_quarantined !== undefined) assert.equal(result.device.quarantined, expected.device_quarantined, scenarioId);
  if (Object.hasOwn(expected, 'manifest_id')) assert.equal(result.release.manifest?.manifest_id ?? null, expected.manifest_id, scenarioId);
  if (Object.hasOwn(expected, 'no_change')) {
    if (expected.no_change === true) assert.ok(result.no_change, scenarioId);
    else assert.equal(result.no_change, expected.no_change, scenarioId);
  }
  if (expected.gate_dispositions !== undefined) assert.deepEqual(result.release.manifest?.gate_dispositions, expected.gate_dispositions, scenarioId);
  if (expected.routing !== undefined) {
    const routing = expected.routing;
    if (routing.profile_kind !== undefined) assert.equal(result.route_plan.context?.profile_kind, routing.profile_kind, `${scenarioId}/profile`);
    if (routing.change_type !== undefined) assert.equal(result.route_plan.context?.change_type, routing.change_type, `${scenarioId}/change type`);
    if (routing.candidate_fingerprint !== undefined) assert.equal(result.candidate_fingerprint, routing.candidate_fingerprint, `${scenarioId}/candidate`);
    if (routing.confirmed !== undefined) assert.equal(Boolean(result.route_plan.confirmed), routing.confirmed, `${scenarioId}/plan confirmation`);
    if (routing.plan_version !== undefined) assert.equal(result.route_plan.confirmed?.plan_version, routing.plan_version, `${scenarioId}/plan version`);
    if (routing.reuse_steps !== undefined) assert.deepEqual(result.route_plan.confirmed?.reuse_steps.map(item => item.step_id), routing.reuse_steps, `${scenarioId}/reuse scope`);
    if (routing.exempt_steps !== undefined) assert.deepEqual(result.route_plan.confirmed?.exempt_steps, routing.exempt_steps, `${scenarioId}/exemption scope`);
    if (routing.required !== undefined) assert.deepEqual(result.required_revalidation, routing.required, `${scenarioId}/required revalidation`);
  }
  if (expected.spec !== undefined) {
    for (const [key, value] of Object.entries(expected.spec)) assert.equal(result.spec_review[key], value, `${scenarioId}/spec.${key}`);
  }
  if (scenarioId === 'cycle-limit') assert.ok(result.failure_bundle.length > 0);
}

function assertRoutingCheckpoint(result, expected, scenarioId, checkpointId) {
  const label = `${scenarioId}/${checkpointId}`;
  assert.equal(result.current_step, expected.current, `${label}/current`);
  assert.equal(result.status, expected.status, `${label}/status`);
  assert.equal(result.cycle, expected.cycle, `${label}/cycle`);
  if (expected.rework !== undefined) assert.equal(result.rework_count, expected.rework, `${label}/rework`);
  for (const [id, state] of Object.entries(expected.states ?? {})) assert.equal(result.steps[id].state, state, `${label}/${id}`);
  if (expected.confirmed !== undefined) assert.equal(Boolean(result.route_plan.confirmed), expected.confirmed, `${label}/confirmed`);
  if (expected.contextCycle !== undefined) assert.equal(result.route_plan.context?.cycle, expected.contextCycle, `${label}/context cycle`);
  if (expected.planVersion !== undefined) assert.equal(result.route_plan.confirmed?.plan_version, expected.planVersion, `${label}/plan version`);
  if (expected.localReuse !== undefined) assert.deepEqual(Object.keys(result.route_plan.reuse_confirmations).sort(), expected.localReuse, `${label}/local reuse confirmations`);
  if (expected.reuseScope !== undefined) assert.deepEqual(result.route_plan.confirmed?.reuse_steps.map(item => item.step_id), expected.reuseScope, `${label}/approved reuse scope`);
  if (expected.exempt_steps !== undefined) assert.deepEqual(result.route_plan.confirmed?.exempt_steps, expected.exempt_steps, `${label}/approved exemption scope`);
  for (const [id, verdict] of Object.entries(expected.gates ?? {})) assert.equal(result.steps[id].gate_verdict, verdict, `${label}/${id} gate`);
  if (expected.exemptionPerformed !== undefined) assert.equal(result.steps.P23.exemption_report?.performed, expected.exemptionPerformed, `${label}/P23 report`);
  for (const [id, values] of Object.entries(expected.analyses ?? {})) {
    for (const [key, value] of Object.entries(values)) assert.equal(result.steps[id].unchanged_analysis?.[key], value, `${label}/${id}.${key}`);
  }
  if (expected.candidate !== undefined) assert.equal(result.candidate_fingerprint, expected.candidate, `${label}/candidate`);
  if (expected.noChange !== undefined) assert.equal(Boolean(result.no_change), expected.noChange, `${label}/no_change`);
  if (expected.publication !== undefined) assert.equal(result.release.publication_count, expected.publication, `${label}/publication`);
  if (Object.hasOwn(expected, 'manifest')) assert.equal(result.release.manifest, expected.manifest, `${label}/manifest`);
  if (Object.hasOwn(expected, 'rejection')) assert.equal(result.release.rejection, expected.rejection, `${label}/release rejection`);
  if (expected.attempts !== undefined) {
    for (const [id, attempt] of Object.entries(expected.attempts)) assert.equal(result.steps[id].attempt, attempt, `${label}/${id} attempt`);
  }
  if (expected.required !== undefined) assert.deepEqual(result.required_revalidation, expected.required, `${label}/required revalidation`);
  if (expected.historyKinds !== undefined) assert.deepEqual(result.history.map(row => row.kind), expected.historyKinds, `${label}/history kinds`);
  if (expected.reason !== undefined) {
    assert.equal(result.timeline.at(-1)?.reason, expected.reason, `${label}/rejection reason`);
    assert.equal(result.timeline.at(-1)?.applied, false, `${label}/rejected event`);
  }
  if (expected.approved !== undefined) assert.equal(result.release.approved, expected.approved, `${label}/release approval`);
  if (expected.gateDispositions !== undefined) assert.deepEqual(result.release.manifest?.gate_dispositions, expected.gateDispositions, `${label}/manifest gate dispositions`);
}

test('fixed 41-scenario mock catalog inventory, frozen values and checkpoint IDs match literal oracle', () => {
  const originalWorkflow = structuredClone(workflow);
  const originalContract = structuredClone(stateContract);
  const catalog = createScenarioCatalog(workflow, stateContract);
  assert.deepEqual(catalog.map(item => item.id).sort(), [...expectedScenarioIds].sort());
  assert.equal(catalog.length, 41);
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
  const priorFixtures = new Map(priorCatalogEvidence.scenarios.map(item => [item.id, item.fixture_sha256]));
  for (const id of expectedScenarioIds.slice(0, 25)) {
    const scenario = catalog.find(item => item.id === id);
    assert.ok(priorFixtures.has(id), `previous catalog manifest contains ${id}`);
    assert.equal(createHash('sha256').update(JSON.stringify(scenario.events)).digest('hex'), priorFixtures.get(id),
      `${id} event fixture bytes remain identical to previously accepted 25-scenario catalog`);
  }
  assert.equal(routingUiBaseline.scenario_count, 32);
  assert.equal(routingUiBaseline.scenarios.length, 32);
  const baseline32 = new Map(routingUiBaseline.scenarios.map(item => [item.id, item]));
  for (const scenario of catalog.slice(0, 32)) {
    const baseline = baseline32.get(scenario.id);
    assert.ok(baseline, `${scenario.id} exists in frozen 32-scenario baseline`);
    assert.equal(createHash('sha256').update(JSON.stringify(scenario.events)).digest('hex'), baseline.events_sha256,
      `${scenario.id} original event bytes preserved`);
    assert.equal(createHash('sha256').update(JSON.stringify(scenario.checkpoints)).digest('hex'), baseline.checkpoints_sha256,
      `${scenario.id} original checkpoint bytes preserved`);
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

test('all 41 catalog endpoints and exception checkpoints match independent literal state oracle', () => {
  const catalog = createScenarioCatalog(workflow, stateContract);
  const byId = new Map(catalog.map(item => [item.id, item]));
  const expected = {
    'spec-question-wait': {
      question: { current: 'P03', status: 'WAITING_HUMAN', state: 'WAITING_HUMAN', version: 'mock:requirements:v1', q: 'mock:question:spec-question-wait:q1', task: 'mock:task:P03:c1:a1:q1', ordinal: 1, resolved: false, reviewed: false },
      blocked: { current: 'P03', status: 'WAITING_HUMAN', state: 'WAITING_HUMAN', version: 'mock:requirements:v1', q: 'mock:question:spec-question-wait:q1', task: 'mock:task:P03:c1:a1:q1', ordinal: 1, resolved: false, reviewed: false },
    },
    'spec-question-resolution': {
      question: { current: 'P03', status: 'WAITING_HUMAN', state: 'WAITING_HUMAN', version: 'mock:requirements:v1', q: 'mock:question:spec-question-resolution:q1', task: 'mock:task:P03:c1:a1:q1', ordinal: 1, resolved: false, reviewed: false },
      answered: { current: 'P03', status: 'RUNNING', state: 'READY', version: 'mock:requirements:v2', resolved: true, reviewed: false },
      'review-blocked': { current: 'P03', status: 'RUNNING', state: 'RUNNING', version: 'mock:requirements:v2', resolved: true, reviewed: false },
      reviewed: { current: 'P03', status: 'RUNNING', state: 'RUNNING', version: 'mock:requirements:v2', resolved: true, reviewed: true, reviewAttempt: 1, reviewExecution: 'mock:P03:c1:a1' },
      continued: { current: 'P04', status: 'RUNNING', state: 'SUCCEEDED', version: 'mock:requirements:v2', resolved: true, reviewed: true },
    },
    'spec-question-retry': {
      question: { current: 'P03', status: 'WAITING_HUMAN', state: 'WAITING_HUMAN', version: 'mock:requirements:v1', q: 'mock:question:spec-question-retry:q1', task: 'mock:task:P03:c1:a1:q1', ordinal: 1, resolved: false, reviewed: false },
      answered: { current: 'P03', status: 'RUNNING', state: 'READY', version: 'mock:requirements:v2', resolved: true, reviewed: false },
      'reviewed-first': { current: 'P03', status: 'RUNNING', state: 'RUNNING', version: 'mock:requirements:v2', attempt: 1, resolved: true, reviewed: true, reviewAttempt: 1, reviewExecution: 'mock:P03:c1:a1' },
      'retry-wait': { current: 'P03', status: 'RUNNING', state: 'WAITING_RETRY', version: 'mock:requirements:v2', resolved: true, reviewed: true },
      retried: { current: 'P03', status: 'RUNNING', state: 'READY', version: 'mock:requirements:v2', attempt: 2, resolved: true, reviewed: true, reviewAttempt: 1, reviewExecution: 'mock:P03:c1:a1' },
      'review-blocked': { current: 'P03', status: 'RUNNING', state: 'RUNNING', version: 'mock:requirements:v2', attempt: 2, resolved: true, reviewed: true, reviewAttempt: 1, reviewExecution: 'mock:P03:c1:a1' },
      reviewed: { current: 'P03', status: 'RUNNING', state: 'RUNNING', version: 'mock:requirements:v2', attempt: 2, resolved: true, reviewed: true, reviewAttempt: 2, reviewExecution: 'mock:P03:c1:a2' },
      continued: { current: 'P04', status: 'RUNNING', state: 'SUCCEEDED', version: 'mock:requirements:v2', attempt: 2, resolved: true, reviewed: true, reviewAttempt: 2, reviewExecution: 'mock:P03:c1:a2' },
    },
    'spec-question-repeat': {
      question: { current: 'P03', status: 'WAITING_HUMAN', state: 'WAITING_HUMAN', version: 'mock:requirements:v1', q: 'mock:question:spec-question-repeat:q1', ordinal: 1, resolved: false, reviewed: false },
      answered: { current: 'P03', status: 'RUNNING', state: 'READY', version: 'mock:requirements:v2', q: 'mock:question:spec-question-repeat:q1', ordinal: 1, resolved: true, reviewed: false },
      'question-two': { current: 'P03', status: 'WAITING_HUMAN', state: 'WAITING_HUMAN', version: 'mock:requirements:v2', q: 'mock:question:spec-question-repeat:q2', task: 'mock:task:P03:c1:a1:q2', ordinal: 2, resolved: false, reviewed: false },
      'stale-answer': { current: 'P03', status: 'WAITING_HUMAN', state: 'WAITING_HUMAN', version: 'mock:requirements:v2', q: 'mock:question:spec-question-repeat:q2', ordinal: 2, resolved: false, reviewed: false },
      'answered-two': { current: 'P03', status: 'RUNNING', state: 'READY', version: 'mock:requirements:v3', q: 'mock:question:spec-question-repeat:q2', ordinal: 2, resolved: true, reviewed: false },
      reviewed: { current: 'P03', status: 'RUNNING', state: 'RUNNING', version: 'mock:requirements:v3', q: 'mock:question:spec-question-repeat:q2', ordinal: 2, resolved: true, reviewed: true },
      continued: { current: 'P04', status: 'RUNNING', state: 'SUCCEEDED', version: 'mock:requirements:v3', q: 'mock:question:spec-question-repeat:q2', ordinal: 2, resolved: true, reviewed: true },
    },
    'remote-uncertainty': {
      unknown: { current: 'P25', status: 'RECONCILING', state: 'RECONCILING', query: 0, outcome: 'unknown', publication: 0, receipt: null },
      'queried-unknown': { current: 'P25', status: 'RECONCILING', state: 'RECONCILING', query: 1, outcome: 'unknown', publication: 0, receipt: null },
      absent: { current: 'P25', status: 'RECONCILING', state: 'RECONCILING', query: 2, outcome: 'absent', publication: 0, receipt: null },
      conflict: { current: 'P25', status: 'RECONCILING', state: 'RECONCILING', query: 3, outcome: 'conflict', publication: 0, receipt: null },
      stale: { current: 'P25', status: 'RECONCILING', state: 'RECONCILING', query: 3, outcome: 'conflict', publication: 0, receipt: null },
    },
    'remote-recovery': {
      unknown: { current: 'P25', status: 'RECONCILING', state: 'RECONCILING', query: 0, outcome: 'unknown', publication: 0, receipt: null },
      absent: { current: 'P25', status: 'RECONCILING', state: 'RECONCILING', query: 1, outcome: 'absent', publication: 0, receipt: null },
      found: { current: 'P26', status: 'RUNNING', p25: 'SUCCEEDED', query: 2, outcome: 'found', publication: 1, receipt: 'mock:remote-recovery:remote:receipt' },
      late: { current: 'P26', status: 'RUNNING', p25: 'SUCCEEDED', query: 2, outcome: 'found', publication: 1, receipt: 'mock:remote-recovery:remote:receipt' },
      completed: { current: 'END', status: 'COMPLETED', p25: 'SUCCEEDED', query: 2, outcome: 'found', publication: 1, receipt: 'mock:remote-recovery:remote:receipt' },
    },
    'remote-device-quarantine': {
      unknown: { current: 'P25', status: 'RECONCILING', state: 'RECONCILING', query: 0, outcome: 'unknown', quarantined: false, publication: 0 },
      quarantined: { current: 'P25', status: 'RECONCILING', state: 'RECONCILING', query: 0, outcome: 'unknown', quarantined: true, publication: 0 },
      idle: { current: 'P25', status: 'RECONCILING', state: 'RECONCILING', query: 0, outcome: 'unknown', quarantined: true, publication: 0 },
      blocked: { current: 'P25', status: 'RECONCILING', state: 'RECONCILING', query: 0, outcome: 'unknown', quarantined: true, publication: 0 },
    },
  };

  const read = (scenarioId, checkpointId) => {
    const scenario = byId.get(scenarioId);
    const point = scenario.checkpoints.find(item => item.id === checkpointId);
    assert.ok(point, `${scenarioId}/${checkpointId} is a literal oracle checkpoint`);
    return replayScenario(scenario, workflow, stateContract, point.cursor);
  };
  for (const [scenarioId, checkpoints] of Object.entries(expected)) {
    for (const [checkpointId, want] of Object.entries(checkpoints)) {
      const result = read(scenarioId, checkpointId);
      assert.equal(result.current_step, want.current, `${scenarioId}/${checkpointId}/current`);
      assert.equal(result.status, want.status, `${scenarioId}/${checkpointId}/status`);
      const stepId = want.current === 'P04' || want.current === 'P26' || want.current === 'END' ? 'P03' : want.current;
      if (want.state !== undefined) assert.equal(result.steps[stepId].state, want.state, `${scenarioId}/${checkpointId}/state`);
      if (want.p25 !== undefined) assert.equal(result.steps.P25.state, want.p25, `${scenarioId}/${checkpointId}/P25`);
      if (want.version !== undefined) assert.equal(result.requirements_version, want.version, `${scenarioId}/${checkpointId}/requirements version`);
      if (want.attempt !== undefined) assert.equal(result.steps.P03.attempt, want.attempt, `${scenarioId}/${checkpointId}/attempt`);
      if (want.q !== undefined) assert.equal(result.spec_review.question_id, want.q, `${scenarioId}/${checkpointId}/question`);
      if (want.task !== undefined) assert.equal(result.spec_review.task_id, want.task, `${scenarioId}/${checkpointId}/task`);
      if (want.ordinal !== undefined) assert.equal(result.spec_review.ordinal, want.ordinal, `${scenarioId}/${checkpointId}/ordinal`);
      if (want.resolved !== undefined) assert.equal(result.spec_review.resolved, want.resolved, `${scenarioId}/${checkpointId}/resolved`);
      if (want.reviewed !== undefined) assert.equal(result.spec_review.reviewed, want.reviewed, `${scenarioId}/${checkpointId}/reviewed`);
      if (want.reviewAttempt !== undefined) assert.equal(result.spec_review.review_attempt, want.reviewAttempt, `${scenarioId}/${checkpointId}/review attempt`);
      if (want.reviewExecution !== undefined) assert.equal(result.spec_review.review_execution_id, want.reviewExecution, `${scenarioId}/${checkpointId}/review execution`);
      if (want.query !== undefined) assert.equal(result.remote_reconciliation.query_seq, want.query, `${scenarioId}/${checkpointId}/query sequence`);
      if (want.outcome !== undefined) assert.equal(result.remote_reconciliation.outcome, want.outcome, `${scenarioId}/${checkpointId}/remote outcome`);
      if (want.publication !== undefined) assert.equal(result.release.publication_count, want.publication, `${scenarioId}/${checkpointId}/publication`);
      if (Object.hasOwn(want, 'receipt')) assert.equal(result.release.receipt_id, want.receipt, `${scenarioId}/${checkpointId}/receipt`);
      if (want.quarantined !== undefined) assert.equal(result.device?.quarantined ?? false, want.quarantined, `${scenarioId}/${checkpointId}/device quarantine`);
    }
  }
  const staleRemote = read('remote-uncertainty', 'stale');
  assert.equal(staleRemote.timeline.at(-1).applied, false);
  assert.equal(staleRemote.timeline.at(-1).reason, 'stale_remote_query');
  assert.equal(staleRemote.remote_reconciliation.observations.length, 4);
  const retryEnd = read('spec-question-retry', 'end');
  const oldReview = retryEnd.history.find(row => row.kind === 'spec_review_attempt');
  assert.ok(oldReview);
  assert.equal(oldReview.spec_review.review_attempt, 1);
  assert.equal(oldReview.spec_review.review_execution_id, 'mock:P03:c1:a1');
  assert.ok(oldReview.spec_review.review_evidence_id);
  const repeatEnd = read('spec-question-repeat', 'end');
  const firstQuestion = repeatEnd.history.find(row => row.kind === 'spec_question');
  assert.ok(firstQuestion);
  assert.equal(firstQuestion.spec_review.question_id, 'mock:question:spec-question-repeat:q1');
  assert.equal(firstQuestion.spec_review.resolved_requirements_version, 'mock:requirements:v2');
  assert.ok(firstQuestion.spec_review.resolution_evidence_id);
});

test('all nine routing catalog cases satisfy the independent fixed checkpoint oracle', () => {
  const catalog = createScenarioCatalog(workflow, stateContract);
  const byId = new Map(catalog.map(item => [item.id, item]));
  for (const [scenarioId, checkpoints] of Object.entries(routingCheckpointOracle)) {
    const scenario = byId.get(scenarioId);
    assert.ok(scenario, `${scenarioId} is present in the catalog`);
    for (const [checkpointId, expected] of Object.entries(checkpoints)) {
      const point = scenario.checkpoints.find(item => item.id === checkpointId);
      assert.ok(point, `${scenarioId}/${checkpointId} is a planned checkpoint`);
      const original = structuredClone(scenario);
      const result = replayScenario(scenario, workflow, stateContract, point.cursor);
      assertRoutingCheckpoint(result, expected, scenarioId, checkpointId);
      assert.equal(result.real_publish_allowed, false, `${scenarioId}/${checkpointId} never grants real publish authority`);
      assert.deepEqual(scenario, original, `${scenarioId}/${checkpointId} does not mutate fixture input`);
    }
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
