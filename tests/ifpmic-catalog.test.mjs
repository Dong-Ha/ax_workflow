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
const [workflow, stateContract, priorCatalogEvidence, routingUiBaseline, sqeBaseline, sqeUiBaselineText, childrenBaseline, controlsBaseline, controlsBaselineText] = await Promise.all([
  readFile(path.join(specs, 'workflow.v1.json'), 'utf8').then(JSON.parse),
  readFile(path.join(specs, 'state-contract.json'), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'docs/ifpmic/evidence/v2/ui-catalog.json'), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'docs/ifpmic/evidence/v2/routing-ui-baseline-32.json'), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'docs/ifpmic/evidence/v2/sqe-baseline-41.json'), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'docs/ifpmic/evidence/v2/sqe-ui-baseline-41.json'), 'utf8'),
  readFile(path.join(root, 'docs/ifpmic/evidence/v2/children-baseline-50.json'), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'docs/ifpmic/evidence/v2/controls-baseline-59.json'), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'docs/ifpmic/evidence/v2/controls-baseline-59.json'), 'utf8'),
]);
const sqeUiBaseline = JSON.parse(sqeUiBaselineText);

const originalCatalogView = scenario => {
  const events = scenario.events.filter(event => !['mock:sqe-catalog', 'mock:child-catalog'].includes(event.source_id));
  const checkpoints = scenario.checkpoints.map(point => ({ ...point,
    cursor: scenario.events.slice(0, point.cursor).filter(event => !['mock:sqe-catalog', 'mock:child-catalog'].includes(event.source_id)).length }));
  return { events, checkpoints };
};

// The children baseline is the exact catalog immediately before child-event
// insertion, so preserve SQE records while stripping only child-catalog rows.
const preChildrenCatalogView = scenario => {
  const events = scenario.events.filter(event => event.source_id !== 'mock:child-catalog');
  const checkpoints = scenario.checkpoints.map(point => ({ ...point,
    cursor: scenario.events.slice(0, point.cursor).filter(event => event.source_id !== 'mock:child-catalog').length }));
  return { events, checkpoints };
};

const childEventTypes = ['p12_coordinator', 'child_request', 'child_assignment', 'child_result', 'child_collect', 'child_integrated'];
const noChildExecutionScenarios = new Set([
  'human-wait', 'plan-rejection', 'duplicate-events', 'spec-question-wait', 'spec-question-resolution',
  'spec-question-retry', 'spec-question-repeat', 'routing-reuse', 'routing-new-hw', 'routing-exempt',
  'routing-pilot-denied', 'routing-no-change', 'routing-no-change-denied', 'routing-candidate',
  'routing-replan', 'routing-metadata',
]);
function literalChildAnchorCount(scenarioId) {
  if (scenarioId === 'cycle-limit') return 4;
  return noChildExecutionScenarios.has(scenarioId) ? 0 : 1;
}
function expectedChildInsertions(originalEvents) {
  const expected = [];
  let candidate_fingerprint = 'mock:candidate:A';
  let requirements_version = 'mock:requirements:v1';
  for (const anchor of originalEvents) {
    if (anchor.type === 'candidate') candidate_fingerprint = anchor.payload.candidate_fingerprint;
    if (anchor.type === 'spec_resolution' && anchor.payload.complete === true) requirements_version = anchor.payload.resolved_requirements_version;
    if (anchor.type === 'step' && anchor.step_id === 'P12' && anchor.payload.state === 'RUNNING') {
      for (const [offset, type] of childEventTypes.entries()) expected.push({ type, anchor, offset, candidate_fingerprint, requirements_version });
    }
  }
  return expected;
}

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
  'sqe-manual-pass', 'sqe-manual-fail', 'sqe-incomplete', 'sqe-parser-error', 'sqe-identity-mismatch',
  'sqe-manual-retry', 'sqe-report-retry', 'sqe-judgment-retry', 'sqe-manual-quarantine',
  'agent-wait', 'agent-handoff', 'agent-child-failure', 'agent-child-question', 'agent-child-retry-limit',
  'agent-child-stale-cycle', 'agent-child-permissions', 'agent-child-interrupted', 'agent-child-canceled',
];
const migratedScenarioIds = expectedScenarioIds.slice(0, 41);
const sqeUiScenarioIds = [
  'sqe-manual-pass', 'sqe-manual-fail', 'sqe-incomplete', 'sqe-parser-error', 'sqe-identity-mismatch',
  'sqe-manual-retry', 'sqe-report-retry', 'sqe-judgment-retry', 'sqe-manual-quarantine',
];
const sqeProofCountOracle = {
  'happy-path': 3, 'human-wait': 0, 'human-wait-oss': 0, 'debug-failure': 0, 'review-failure': 0,
  'sam-failure': 0, 'tem-failure': 0, 'static-failure': 0, 'sqe-failure': 3, 'oss-failure': 0,
  'oss-design-change': 0, 'plan-rejection': 0, 'release-reject-code': 3, 'release-reject-design': 3,
  'metadata-recovery': 3, 'metric-missing': 0, 'stale-result': 0, 'stale-candidate': 0,
  'stale-approval': 3, 'duplicate-events': 0, 'retry-limit': 0, 'cycle-limit': 0,
  'device-boundaries': 1, 'flash-unknown': 1, 'notes-only': 3, 'spec-question-wait': 0,
  'spec-question-resolution': 0, 'spec-question-retry': 0, 'spec-question-repeat': 0,
  'remote-uncertainty': 3, 'remote-recovery': 3, 'remote-device-quarantine': 3,
  'routing-reuse': 3, 'routing-new-hw': 0, 'routing-exempt': 0, 'routing-pilot-denied': 0,
  'routing-no-change': 0, 'routing-no-change-denied': 0, 'routing-candidate': 3,
  'routing-replan': 0, 'routing-metadata': 0,
};

function expectedSqeInsertions(originalEvents) {
  const expected = [];
  const contexts = new Map();
  const results = new Map();
  let candidate = 'mock:candidate:A';
  for (const anchor of originalEvents) {
    if (anchor.type === 'candidate') candidate = anchor.payload.candidate_fingerprint;
    if (anchor.type === 'step' && anchor.step_id === 'P22' && anchor.payload.state === 'RUNNING') {
      const proof = { type: 'sqe_context', anchor, side: 'after', candidate };
      contexts.set(`${anchor.cycle}:${anchor.attempt}`, proof);
      expected.push(proof);
    }
    if (anchor.type === 'step' && anchor.step_id === 'P22' && anchor.payload.state === 'SUCCEEDED') {
      const context = contexts.get(`${anchor.cycle}:${anchor.attempt}`);
      if (context) {
        const proof = { type: 'sqe_result', anchor, side: 'before', candidate: context.candidate };
        results.set(anchor.cycle, proof);
        expected.push(proof);
      }
    }
    if (anchor.type === 'step' && anchor.step_id === 'P23' && anchor.payload.state === 'SUCCEEDED') {
      const result = results.get(anchor.cycle);
      if (result) expected.push({ type: 'sqe_report', anchor, side: 'before', candidate });
    }
  }
  return expected;
}

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
  'sqe-manual-pass': ['waiting', 'rejected', 'submitted', 'reported', 'judged'],
  'sqe-manual-fail': ['submitted', 'reported', 'judged', 'rerouted'],
  'sqe-incomplete': ['collected', 'reported', 'blocked'],
  'sqe-parser-error': ['collected', 'reported', 'blocked'],
  'sqe-identity-mismatch': ['collected', 'reported', 'blocked'],
  'sqe-manual-retry': ['waiting', 'submitted', 'backoff', 'retried', 'waiting-two', 'stale', 'submitted-two', 'judged'],
  'sqe-report-retry': ['reported', 'backoff', 'retried', 'stale', 'reported-two'],
  'sqe-judgment-retry': ['judged', 'backoff', 'retried', 'stale', 'judged-two'],
  'sqe-manual-quarantine': ['waiting', 'quarantined', 'blocked'],
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
  'sqe-manual-pass': { current_step: 'END', status: 'COMPLETED', cycle: 1, publication_count: 1, sqe_mode: 'manual', verdict: 'PASS', complete: true },
  'sqe-manual-fail': { current_step: 'P07', status: 'RUNNING', cycle: 2, rework_count: 1, publication_count: 0 },
  'sqe-incomplete': { current_step: 'P24', status: 'RUNNING', cycle: 1, publication_count: 0, verdict: 'INCONCLUSIVE', complete: false },
  'sqe-parser-error': { current_step: 'P24', status: 'RUNNING', cycle: 1, publication_count: 0, verdict: 'ERROR', complete: false },
  'sqe-identity-mismatch': { current_step: 'P24', status: 'RUNNING', cycle: 1, publication_count: 0, verdict: 'INCONCLUSIVE', complete: false },
  'sqe-manual-retry': { current_step: 'END', status: 'COMPLETED', cycle: 1, publication_count: 1, sqe_mode: 'manual', p22Attempt: 2, verdict: 'PASS', complete: true },
  'sqe-report-retry': { current_step: 'END', status: 'COMPLETED', cycle: 1, publication_count: 1, p23Attempt: 2, verdict: 'PASS', complete: true },
  'sqe-judgment-retry': { current_step: 'END', status: 'COMPLETED', cycle: 1, publication_count: 1, p24Attempt: 2, verdict: 'PASS', complete: true },
  'sqe-manual-quarantine': { current_step: 'P22', status: 'RECONCILING', cycle: 1, publication_count: 0, quarantined: true, sqe_result: null },
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
  if (expected.sqe_mode !== undefined) assert.equal(result.steps.P22.sqe_execution_mode, expected.sqe_mode, scenarioId);
  if (Object.hasOwn(expected, 'verdict')) assert.equal(result.steps.P24.gate_verdict, expected.verdict, scenarioId);
  if (Object.hasOwn(expected, 'complete')) assert.equal(result.steps.P24.gate_complete, expected.complete, scenarioId);
  if (expected.p22Attempt !== undefined) assert.equal(result.steps.P22.attempt, expected.p22Attempt, scenarioId);
  if (expected.p23Attempt !== undefined) assert.equal(result.steps.P23.attempt, expected.p23Attempt, scenarioId);
  if (expected.p24Attempt !== undefined) assert.equal(result.steps.P24.attempt, expected.p24Attempt, scenarioId);
  if (Object.hasOwn(expected, 'sqe_result')) assert.equal(result.steps.P22.sqe_result ?? null, expected.sqe_result, scenarioId);
  if (expected.quarantined !== undefined) assert.equal(result.device?.quarantined, expected.quarantined, scenarioId);
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

test('original 59-scenario inventory and historical checkpoints remain the unchanged catalog prefix', async () => {
  const originalWorkflow = structuredClone(workflow);
  const originalContract = structuredClone(stateContract);
  const catalog = createScenarioCatalog(workflow, stateContract);
  assert.deepEqual(catalog.slice(0, 59).map(item => item.id), expectedScenarioIds,
    'the original 59 ordered scenarios remain the unchanged prefix before the appended controls cases');
  assert.deepEqual(workflow, originalWorkflow);
  assert.deepEqual(stateContract, originalContract);
  assert.ok(deepFrozen(catalog), 'catalog, scenarios, events, payloads and checkpoints are deeply frozen');
  assert.deepEqual(createScenarioCatalog(workflow, stateContract), catalog, 'catalog construction is deterministic');

  assert.equal(createHash('sha256').update(controlsBaselineText).digest('hex'),
    'ac5b2386b03738b4da8ea1cd93fa0dd1f46961d550d67b77fb35852289a79a78',
    'the approved immutable pre-control 59-scenario baseline bytes stay pinned');
  assert.equal(controlsBaseline.scenario_count, 59);
  assert.deepEqual(catalog.slice(0, 59).map(item => item.id), controlsBaseline.scenarios.map(item => item.id));
  const historicalTrace = await readFile(path.join(root, controlsBaseline.historical_trace_archive));
  assert.equal(createHash('sha256').update(historicalTrace).digest('hex'), controlsBaseline.historical_trace_archive_sha256,
    'the complete accepted pre-control trace archive stays byte-pinned');
  for (const [index, scenario] of catalog.slice(0, 59).entries()) {
    const baseline = controlsBaseline.scenarios[index];
    assert.equal(createHash('sha256').update(JSON.stringify(scenario.events)).digest('hex'), baseline.events_sha256,
      `${scenario.id} original 59 event bytes remain unchanged`);
    assert.equal(createHash('sha256').update(JSON.stringify(scenario.checkpoints)).digest('hex'), baseline.checkpoints_sha256,
      `${scenario.id} original 59 checkpoint order/cursors remain unchanged`);
  }

  for (const scenario of catalog.slice(0, 50)) {
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
    const normalized = originalCatalogView(scenario);
    assert.equal(createHash('sha256').update(JSON.stringify(normalized.events)).digest('hex'), priorFixtures.get(id),
      `${id} original event bytes restore the previously accepted 25-scenario catalog after removing only SQE insertions`);
  }
  assert.equal(routingUiBaseline.scenario_count, 32);
  assert.equal(routingUiBaseline.scenarios.length, 32);
  const baseline32 = new Map(routingUiBaseline.scenarios.map(item => [item.id, item]));
  for (const scenario of catalog.slice(0, 32)) {
    const baseline = baseline32.get(scenario.id);
    assert.ok(baseline, `${scenario.id} exists in frozen 32-scenario baseline`);
    const normalized = originalCatalogView(scenario);
    assert.equal(createHash('sha256').update(JSON.stringify(normalized.events)).digest('hex'), baseline.events_sha256,
      `${scenario.id} original event bytes preserved`);
    assert.equal(createHash('sha256').update(JSON.stringify(normalized.checkpoints)).digest('hex'), baseline.checkpoints_sha256,
      `${scenario.id} original checkpoint bytes preserved`);
  }
  assert.equal(sqeBaseline.scenario_count, 41);
  assert.equal(sqeBaseline.scenarios.length, 41);
  const baseline41 = new Map(sqeBaseline.scenarios.map(item => [item.id, item]));
  assert.equal(baseline41.size, 41);
  assert.deepEqual(Object.keys(sqeProofCountOracle).sort(), migratedScenarioIds.sort(),
    'literal insertion-count oracle covers only the 41 migrated baseline scenarios');
  for (const scenario of catalog.slice(0, 41)) {
    const baseline = baseline41.get(scenario.id);
    assert.ok(baseline, `${scenario.id} exists in approved pre-SQE baseline`);
    const normalized = originalCatalogView(scenario);
    assert.equal(createHash('sha256').update(JSON.stringify(normalized.events)).digest('hex'), baseline.events_sha256,
      `${scenario.id} original event bytes are restored by removing only typed SQE-catalog source events`);
    assert.deepEqual(normalized.checkpoints, baseline.checkpoints,
      `${scenario.id} original checkpoint IDs, titles, ordering and cursors are exactly restored`);
    assert.equal(createHash('sha256').update(JSON.stringify(normalized.checkpoints)).digest('hex'), baseline.checkpoints_sha256,
      `${scenario.id} normalized checkpoint hash matches approved baseline`);
    const inserted = scenario.events.filter(event => event.source_id === 'mock:sqe-catalog');
    assert.equal(inserted.length, sqeProofCountOracle[scenario.id], `${scenario.id} has its fixed expected inserted proof count`);
    assert.ok(inserted.every(event => ['sqe_context', 'sqe_result', 'sqe_report'].includes(event.type)),
      `${scenario.id} migration adds only allowlisted SQE proof event types`);
    assert.ok(scenario.events.filter(event => !['mock:sqe-catalog', 'mock:child-catalog'].includes(event.source_id)).every(event => {
      const originalIndex = normalized.events.indexOf(event);
      return originalIndex >= 0;
    }), `${scenario.id} preserves every original event object in order`);

    const anchors = expectedSqeInsertions(normalized.events);
    assert.equal(inserted.length, anchors.length, `${scenario.id} inserted proof count matches original workflow anchors`);
    const actualByIndex = inserted.map(event => ({ event, index: scenario.events.indexOf(event) })).sort((a, b) => a.index - b.index);
    assert.deepEqual(actualByIndex.map(({ event }) => event.type), anchors.map(row => row.type),
      `${scenario.id} SQE proof event order follows P22/P23 anchors`);
    const evidenceIds = new Set();
    const artifactIds = new Set();
    for (const [index, { event, index: eventIndex }] of actualByIndex.entries()) {
      const expected = anchors[index];
      const anchorIndex = scenario.events.indexOf(expected.anchor);
      assert.equal(event.job_id, expected.anchor.job_id, `${scenario.id}/${event.type} keeps source job`);
      assert.equal(event.step_id, expected.anchor.step_id, `${scenario.id}/${event.type} binds its workflow node`);
      assert.equal(event.cycle, expected.anchor.cycle, `${scenario.id}/${event.type} binds original cycle`);
      assert.equal(event.attempt, expected.anchor.attempt, `${scenario.id}/${event.type} binds original attempt`);
      assert.equal(event.execution_id, expected.anchor.execution_id, `${scenario.id}/${event.type} binds execution`);
      if (event.type !== 'sqe_context') assert.equal(event.payload.candidate_fingerprint, expected.candidate,
        `${scenario.id}/${event.type} binds the original candidate`);
      else assert.equal(event.payload.candidate_fingerprint, expected.candidate,
        `${scenario.id}/context binds candidate at P22 start`);
      assert.equal(eventIndex, expected.side === 'after' ? anchorIndex + 1 : anchorIndex - 1,
        `${scenario.id}/${event.type} is inserted at the exact authored anchor`);
      assert.ok(event.source_seq > 0 && Number.isSafeInteger(event.source_seq), `${scenario.id} inserted source sequence is valid`);
      const eId = event.payload.evidence_id;
      assert.ok(typeof eId === 'string' && !evidenceIds.has(eId), `${scenario.id} proof evidence IDs are unique`);
      evidenceIds.add(eId);
      for (const key of ['stdout_artifact_id', 'stderr_artifact_id', 'result_artifact_id', 'report_artifact_id', 'report_link_id']) {
        const value = event.payload[key];
        if (value !== undefined) {
          assert.ok(!artifactIds.has(value), `${scenario.id} artifact ID ${key} is unique`);
          artifactIds.add(value);
        }
      }
    }
    assert.ok(inserted.every((event, index) => index === 0 || inserted[index - 1].source_seq < event.source_seq),
      `${scenario.id} inserted proof source sequence is strictly increasing`);
    const replayed = replayScenario(scenario, workflow, stateContract);
    for (const event of inserted) {
      const row = replayed.timeline.find(item => item.event_id === event.event_id);
      assert.ok(row, `${scenario.id}/${event.type} is represented in replay timeline`);
      assert.equal(row.applied, true, `${scenario.id}/${event.type} is current usable evidence, not stale/inactive residue`);
    }
  }
  for (const scenario of catalog.slice(41, 50)) {
    assert.ok(sqeUiScenarioIds.includes(scenario.id), `${scenario.id} belongs to the nine-case SQE UI extension`);
    assert.ok(!baseline41.has(scenario.id), `${scenario.id} is not misrepresented as an original-41 baseline fixture`);
    const authored = scenario.events.filter(event => event.source_id === 'mock:sqe-ui');
    assert.ok(authored.length > 0, `${scenario.id} has explicit new SQE UI events`);
    assert.ok(authored.every(event => event.mode === 'mock' && Number.isSafeInteger(event.source_seq) && event.source_seq > 0),
      `${scenario.id} new-source events are mock and sequenced`);
    assert.ok(authored.every((event, index) => index === 0 || authored[index - 1].source_seq < event.source_seq),
      `${scenario.id} new-source sequence increases strictly`);
    for (const [index, event] of authored.entries()) {
      assert.equal(event.source_seq, index + 1, `${scenario.id} fixed SQE UI source sequence`);
      assert.equal(event.event_id, `mock:${scenario.id}:ui:e${index + 1}`, `${scenario.id} fixed SQE UI event ID`);
    }
  }
  assert.equal(sqeUiBaseline.kind, 'immutable_pre_sqe_ui_catalog_baseline');
  assert.equal(sqeUiBaseline.source_commit, '2d6319f');
  assert.equal(sqeUiBaseline.scenario_count, 41);
  assert.equal(createHash('sha256').update(sqeUiBaselineText).digest('hex'),
    '0716157c37e7fa97a76e007f1c16f114131b86d1663f1ac10eef89111644aa4a',
    'the approved immutable 2d6319f 41-scenario registry stays pinned');
  const uiBaseline41 = new Map(sqeUiBaseline.scenarios.map(item => [item.id, item]));
  assert.equal(uiBaseline41.size, 41);
  for (const scenario of catalog.slice(0, 41)) {
    const baseline = uiBaseline41.get(scenario.id);
    assert.ok(baseline, `${scenario.id} belongs to the immutable pre-UI 41 baseline`);
    const normalized = preChildrenCatalogView(scenario);
    assert.equal(createHash('sha256').update(JSON.stringify(normalized.events)).digest('hex'), baseline.events_sha256,
      `${scenario.id} raw event fixture exactly matches commit 2d6319f without SQE normalization`);
    assert.deepEqual(normalized.checkpoints, baseline.checkpoints,
      `${scenario.id} checkpoint list/cursors restore commit 2d6319f before child insertion`);
    assert.equal(createHash('sha256').update(JSON.stringify(normalized.checkpoints)).digest('hex'), baseline.checkpoints_sha256,
      `${scenario.id} raw checkpoint SHA matches commit 2d6319f`);
  }
  assert.deepEqual(workflow, originalWorkflow, 'catalog builder did not mutate workflow input');
  assert.deepEqual(stateContract, originalContract, 'catalog builder did not mutate state contract input');
});

test('child catalog migration preserves the fixed 50-scenario baseline and applies six proofs at every P12 execution anchor', async () => {
  const catalog = createScenarioCatalog(workflow, stateContract);
  assert.equal(childrenBaseline.kind, 'immutable_pre_child_protocol_catalog_baseline');
  assert.equal(childrenBaseline.scenario_count, 50);
  assert.equal(childrenBaseline.scenarios.length, 50);
  assert.deepEqual(catalog.slice(0, 50).map(item => item.id), childrenBaseline.scenarios.map(item => item.id),
    'the exact original 50 scenario IDs and order remain the prefix');
  const archive = await readFile(path.join(root, childrenBaseline.historical_trace_archive));
  assert.equal(createHash('sha256').update(archive).digest('hex'), childrenBaseline.historical_trace_archive_sha256,
    'the immutable historical trace archive is byte-pinned');

  for (const scenario of catalog.slice(0, 50)) {
    const baseline = childrenBaseline.scenarios.find(item => item.id === scenario.id);
    assert.ok(baseline, `${scenario.id} is in the frozen pre-child baseline`);
    const restored = preChildrenCatalogView(scenario);
    assert.equal(createHash('sha256').update(JSON.stringify(restored.events)).digest('hex'), baseline.events_sha256,
      `${scenario.id} restores exact pre-child event bytes by removing only child-catalog events`);
    assert.deepEqual(restored.checkpoints, baseline.checkpoints,
      `${scenario.id} restores every original checkpoint ID/title/order/cursor`);
    assert.equal(createHash('sha256').update(JSON.stringify(restored.checkpoints)).digest('hex'), baseline.checkpoints_sha256,
      `${scenario.id} restores the pre-child checkpoint hash`);

    const anchors = expectedChildInsertions(restored.events);
    const inserted = scenario.events.filter(event => event.source_id === 'mock:child-catalog');
    assert.equal(anchors.length / childEventTypes.length, literalChildAnchorCount(scenario.id), `${scenario.id} has the fixed original P12 RUNNING anchor count`);
    assert.equal(inserted.length, anchors.length, `${scenario.id} has exactly six inserted proofs per original P12 RUNNING anchor`);
    assert.equal(inserted.length % childEventTypes.length, 0, `${scenario.id} child insertions form complete six-event groups`);
    const byIndex = inserted.map(event => ({ event, index: scenario.events.indexOf(event) })).sort((a, b) => a.index - b.index);
    assert.deepEqual(byIndex.map(row => row.event.type), anchors.map(row => row.type),
      `${scenario.id} child proof types follow the literal six-event protocol order`);
    for (const [index, { event, index: eventIndex }] of byIndex.entries()) {
      const expected = anchors[index];
      const anchorIndex = scenario.events.indexOf(expected.anchor);
      assert.equal(eventIndex, anchorIndex + 1 + expected.offset, `${scenario.id}/${event.type} immediately follows its P12 RUNNING anchor in protocol order`);
      for (const field of ['mode', 'job_id', 'step_id', 'cycle', 'attempt', 'execution_id']) {
        assert.equal(event[field], field === 'mode' ? 'mock' : expected.anchor[field], `${scenario.id}/${event.type} binds anchor ${field}`);
      }
      assert.equal(event.source_id, 'mock:child-catalog');
      assert.equal(event.event_id, `mock:${scenario.id}:child-event:${index + 1}`);
      assert.equal(event.source_seq, index + 1, `${scenario.id} child source sequence is fixed and contiguous`);
      assert.equal(event.payload.candidate_fingerprint, expected.candidate_fingerprint);
      assert.equal(event.payload.requirements_version, expected.requirements_version);
    }

    for (let offset = 0; offset < inserted.length; offset += childEventTypes.length) {
      const group = inserted.slice(offset, offset + childEventTypes.length);
      const [coordinator, request, assignment, childResult, collection, integration] = group;
      const c = coordinator.payload, q = request.payload, a = assignment.payload, r = childResult.payload;
      assert.equal(q.coordinator_task_id, c.coordinator_task_id);
      assert.equal(q.coordinator_execution_id, c.coordinator_execution_id);
      assert.equal(a.request_id, q.request_id);
      assert.equal(a.child_task_id, q.child_task_id);
      assert.equal(r.child_execution_id, a.child_execution_id);
      assert.equal(collection.payload.child_execution_id, a.child_execution_id);
      assert.equal(collection.payload.result_evidence_id, r.evidence_id);
      assert.equal(integration.payload.result_evidence_id, r.evidence_id);
      assert.equal(integration.payload.patch_artifact_id, r.patch_artifact_id);
      assert.equal(r.status, 'completed');
    }

    const replayed = replayScenario(scenario, workflow, stateContract);
    for (const event of inserted) {
      const row = replayed.timeline.find(item => item.event_id === event.event_id);
      assert.ok(row, `${scenario.id}/${event.type} has a replay journal row`);
      assert.equal(row.applied, true, `${scenario.id}/${event.type} is accepted evidence at its inserted prefix`);
    }
  }
});

test('the original 50 fixed scenario endpoints match their independent status, route, attempt, evidence and publication oracle', () => {
  const catalog = createScenarioCatalog(workflow, stateContract);
  for (const scenario of catalog.slice(0, 50)) {
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

test('all 50 catalog endpoints and exception checkpoints match independent literal state oracle', () => {
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

test('nine SQE UI scenarios satisfy literal checkpoints, typed proof bindings, stale-attempt guards and archive rules', () => {
  const catalog = createScenarioCatalog(workflow, stateContract);
  const byId = new Map(catalog.map(item => [item.id, item]));
  const oracle = {
    'sqe-manual-pass': {
      waiting: { current: 'P22', status: 'WAITING_HUMAN', step: 'WAITING_HUMAN', attempt: 1, mode: 'manual', verdict: null },
      rejected: { current: 'P22', status: 'WAITING_HUMAN', step: 'WAITING_HUMAN', attempt: 1, mode: 'manual', rejected: true },
      submitted: { current: 'P22', status: 'RUNNING', step: 'READY', attempt: 1, mode: 'manual', verdict: null, result: true },
      reported: { current: 'P24', status: 'RUNNING', p22: 'SUCCEEDED', p23: 'SUCCEEDED', p24: 'PENDING', report: true },
      judged: { current: 'X02', status: 'RUNNING', p22: 'SUCCEEDED', p23: 'SUCCEEDED', p24: 'SUCCEEDED', verdict: 'PASS', complete: true },
    },
      'sqe-manual-fail': {
      submitted: { current: 'P22', status: 'RUNNING', step: 'READY', attempt: 1, mode: 'manual', verdict: null, result: true },
      reported: { current: 'P24', status: 'RUNNING', p22: 'SUCCEEDED', p23: 'SUCCEEDED', p24: 'PENDING', report: true },
      judged: { current: 'P24', status: 'RUNNING', cycle: 1, p22: 'SUCCEEDED', p23: 'SUCCEEDED', p24: 'RUNNING', verdict: 'FAIL', complete: true },
      rerouted: { current: 'P07', status: 'RUNNING', cycle: 2, rework: 1, p22: 'PENDING', p24: 'PENDING', history: true },
    },
    'sqe-incomplete': {
      collected: { current: 'P22', status: 'RUNNING', p22: 'RUNNING', p23: 'PENDING', result: true, verdict: null },
      reported: { current: 'P24', status: 'RUNNING', p22: 'SUCCEEDED', p23: 'SUCCEEDED', p24: 'PENDING', verdict: null },
      blocked: { current: 'P24', status: 'RUNNING', p22: 'SUCCEEDED', p23: 'SUCCEEDED', p24: 'RUNNING', verdict: 'INCONCLUSIVE', complete: false },
    },
    'sqe-parser-error': {
      collected: { current: 'P22', status: 'RUNNING', p22: 'RUNNING', p23: 'PENDING', result: true, verdict: null },
      reported: { current: 'P24', status: 'RUNNING', p22: 'SUCCEEDED', p23: 'SUCCEEDED', p24: 'PENDING', verdict: null },
      blocked: { current: 'P24', status: 'RUNNING', p22: 'SUCCEEDED', p23: 'SUCCEEDED', p24: 'RUNNING', verdict: 'ERROR', complete: false },
    },
    'sqe-identity-mismatch': {
      collected: { current: 'P22', status: 'RUNNING', p22: 'RUNNING', p23: 'PENDING', result: true, verdict: null },
      reported: { current: 'P24', status: 'RUNNING', p22: 'SUCCEEDED', p23: 'SUCCEEDED', p24: 'PENDING', verdict: null },
      blocked: { current: 'P24', status: 'RUNNING', p22: 'SUCCEEDED', p23: 'SUCCEEDED', p24: 'RUNNING', verdict: 'INCONCLUSIVE', complete: false },
    },
    'sqe-manual-retry': {
      waiting: { current: 'P22', status: 'WAITING_HUMAN', step: 'WAITING_HUMAN', attempt: 1, mode: 'manual' },
      submitted: { current: 'P22', status: 'RUNNING', step: 'READY', attempt: 1, mode: 'manual', result: true },
      backoff: { current: 'P22', status: 'RUNNING', step: 'WAITING_RETRY', attempt: 1, infrastructure: true },
      retried: { current: 'P22', status: 'RUNNING', step: 'READY', attempt: 2, mode: null, result: false, history: true },
      'waiting-two': { current: 'P22', status: 'WAITING_HUMAN', step: 'WAITING_HUMAN', attempt: 2, mode: 'manual' },
      stale: { current: 'P22', status: 'WAITING_HUMAN', step: 'WAITING_HUMAN', attempt: 2, rejected: true },
      'submitted-two': { current: 'P22', status: 'RUNNING', step: 'READY', attempt: 2, mode: 'manual', result: true },
      judged: { current: 'X02', status: 'RUNNING', p22: 'SUCCEEDED', verdict: 'PASS', complete: true },
    },
    'sqe-report-retry': {
      reported: { current: 'P23', status: 'RUNNING', p23: 'RUNNING', attempt: 1, report: true },
      backoff: { current: 'P23', status: 'RUNNING', p23: 'WAITING_RETRY', attempt: 1, report: true },
      retried: { current: 'P23', status: 'RUNNING', p23: 'READY', attempt: 2, report: false, history: true },
      stale: { current: 'P23', status: 'RUNNING', p23: 'RUNNING', attempt: 2, rejected: true, report: false },
      'reported-two': { current: 'P23', status: 'RUNNING', p23: 'RUNNING', attempt: 2, report: true },
    },
    'sqe-judgment-retry': {
      judged: { current: 'P24', status: 'RUNNING', p24: 'RUNNING', attempt: 1, verdict: 'PASS' },
      backoff: { current: 'P24', status: 'RUNNING', p24: 'WAITING_RETRY', attempt: 1, verdict: 'PASS' },
      retried: { current: 'P24', status: 'RUNNING', p24: 'READY', attempt: 2, verdict: null, history: true },
      stale: { current: 'P24', status: 'RUNNING', p24: 'RUNNING', attempt: 2, rejected: true, verdict: null },
      'judged-two': { current: 'P24', status: 'RUNNING', p24: 'RUNNING', attempt: 2, verdict: 'PASS', complete: true },
    },
    'sqe-manual-quarantine': {
      waiting: { current: 'P22', status: 'WAITING_HUMAN', step: 'WAITING_HUMAN', attempt: 1, mode: 'manual' },
      quarantined: { current: 'P22', status: 'RECONCILING', step: 'WAITING_HUMAN', quarantined: true, result: false },
      blocked: { current: 'P22', status: 'RECONCILING', step: 'WAITING_HUMAN', quarantined: true, result: false, rejected: true },
    },
  };
  assert.deepEqual(Object.keys(oracle), sqeUiScenarioIds, 'checkpoint oracle covers each new SQE scenario exactly once');
  const at = (scenarioId, checkpointId) => {
    const scenario = byId.get(scenarioId);
    assert.ok(scenario, `${scenarioId} is present`);
    const point = scenario.checkpoints.find(item => item.id === checkpointId);
    assert.ok(point, `${scenarioId}/${checkpointId} is present`);
    const before = structuredClone(scenario);
    const result = replayScenario(scenario, workflow, stateContract, point.cursor);
    assert.deepEqual(scenario, before, `${scenarioId}/${checkpointId} leaves fixture immutable`);
    assert.equal(result.real_publish_allowed, false, `${scenarioId}/${checkpointId} never authorizes real publish`);
    return result;
  };
  for (const [scenarioId, points] of Object.entries(oracle)) {
    for (const [checkpointId, expected] of Object.entries(points)) {
      const result = at(scenarioId, checkpointId);
      const label = `${scenarioId}/${checkpointId}`;
      assert.equal(result.current_step, expected.current, `${label}/current`);
      assert.equal(result.status, expected.status, `${label}/status`);
      if (expected.cycle !== undefined) assert.equal(result.cycle, expected.cycle, `${label}/cycle`);
      if (expected.rework !== undefined) assert.equal(result.rework_count, expected.rework, `${label}/rework`);
      for (const key of ['p22', 'p23', 'p24']) if (expected[key] !== undefined) {
        assert.equal(result.steps[key.toUpperCase()].state, expected[key], `${label}/${key} state`);
      }
      if (expected.step !== undefined) assert.equal(result.steps.P22.state, expected.step, `${label}/P22 state`);
      if (expected.attempt !== undefined) assert.equal(result.steps[expected.p23 !== undefined ? 'P23' : expected.p24 !== undefined ? 'P24' : 'P22'].attempt, expected.attempt, `${label}/attempt`);
      if (expected.mode !== undefined) assert.equal(result.steps.P22.sqe_execution_mode ?? null, expected.mode, `${label}/execution mode`);
      if (Object.hasOwn(expected, 'verdict')) assert.equal(result.steps.P24.gate_verdict ?? null, expected.verdict, `${label}/verdict`);
      if (Object.hasOwn(expected, 'complete')) assert.equal(result.steps.P24.gate_complete ?? null, expected.complete, `${label}/complete`);
      if (Object.hasOwn(expected, 'result')) assert.equal(Boolean(result.steps.P22.sqe_result), expected.result, `${label}/result presence`);
      if (Object.hasOwn(expected, 'report')) assert.equal(Boolean(result.steps.P23.sqe_report), expected.report, `${label}/report presence`);
      if (Object.hasOwn(expected, 'quarantined')) assert.equal(result.device?.quarantined, expected.quarantined, `${label}/quarantine`);
      if (expected.history) assert.ok(result.history.some(row => ['attempt', 'cycle'].includes(row.kind)), `${label}/archived attempt`);
      if (expected.rejected) {
        const rejected = result.timeline.at(-1);
        assert.equal(rejected?.applied, false, `${label}/rejection applied=false`);
        const reasons = {
          'sqe-manual-pass/rejected': 'invalid_manual_submission',
          'sqe-manual-retry/stale': 'invalid_sqe_result',
          'sqe-report-retry/stale': 'stale_execution',
          'sqe-judgment-retry/stale': 'stale_execution',
          'sqe-manual-quarantine/blocked': 'reconciliation_required',
        };
        const reason = reasons[label] ?? (['sqe-incomplete', 'sqe-parser-error', 'sqe-identity-mismatch'].includes(scenarioId)
          ? 'gate_pass_required' : undefined);
        if (reason) assert.equal(rejected.reason, reason, `${label}/fixed rejection reason`);
        else assert.ok(rejected?.reason, `${label}/rejection reason present`);
      }
    }
  }

  const catalogById = new Map(catalog.map(item => [item.id, item]));
  const manualReady = at('sqe-manual-pass', 'submitted');
  assert.equal(manualReady.steps.P22.sqe_result.execution_status, 'completed');
  assert.equal(manualReady.steps.P22.sqe_execution_mode, 'manual');
  assert.equal(manualReady.steps.P22.state, 'READY');
  assert.equal(manualReady.steps.P24.gate_verdict, null, 'manual bundle acceptance is not a judgment');
  assert.equal(manualReady.steps.P23.sqe_report, null, 'manual bundle acceptance is not a report');
  const manualRejected = at('sqe-manual-pass', 'rejected');
  assert.equal(manualRejected.timeline.at(-1).applied, false, 'wrong manual task is rejected');
  const incomplete = at('sqe-incomplete', 'blocked');
  assert.ok(!incomplete.steps.P22.sqe_result.cases.some(row => row.case_id === 'mock:sqe:case:function'), 'incomplete fixture actually omits a mandatory case');
  assert.equal(incomplete.steps.P24.gate_complete, false);
  const parserError = at('sqe-parser-error', 'blocked');
  assert.equal(parserError.steps.P22.sqe_result.parser_status, 'error');
  assert.equal(parserError.steps.P22.sqe_result.exit_code, null);
  const identityMismatch = at('sqe-identity-mismatch', 'blocked');
  assert.notEqual(identityMismatch.steps.P22.sqe_result.observed_image_identity, identityMismatch.steps.P22.sqe_context.expected_image_identity,
    'identity-mismatch fixture preserves a distinct observed boot identity');

  const manualRetry = at('sqe-manual-retry', 'end');
  assert.equal(manualRetry.steps.P22.attempt, 2);
  assert.equal(manualRetry.steps.P22.sqe_execution_mode, 'manual');
  assert.ok(manualRetry.steps.P22.sqe_manual_task.requested_at_ms >= 15000, 'new human request is after retry eligibility');
  assert.ok(manualRetry.steps.P22.sqe_result.started_at_ms >= manualRetry.steps.P22.sqe_manual_task.requested_at_ms,
    'new manual bundle cannot predate its attempt-2 request');
  assert.ok(manualRetry.steps.P22.sqe_result.finished_at_ms >= manualRetry.steps.P22.sqe_result.started_at_ms,
    'attempt-2 finish follows start');
  assert.ok(manualRetry.history.some(row => row.kind === 'attempt' && row.step_id === 'P22' && row.step.attempt === 1
    && row.step.sqe_result?.execution_status === 'infrastructure_error'), 'a1 manual infra bundle is archived');
  const reportRetry = at('sqe-report-retry', 'stale');
  const reportFixture = catalogById.get('sqe-report-retry');
  const reportStaleCursor = reportFixture.checkpoints.find(point => point.id === 'stale').cursor;
  const authoredReports = reportFixture.events.slice(0, reportStaleCursor)
    .filter(event => event.source_id === 'mock:sqe-ui' && event.type === 'sqe_report');
  assert.equal(authoredReports.length, 2);
  assert.deepEqual(authoredReports[1].payload, authoredReports[0].payload, 'retry replays the actual a1 report payload');
  assert.equal(authoredReports[1].attempt, 1, 'stale report keeps original a1 outer attempt coordinate');
  assert.equal(authoredReports[1].execution_id, 'mock:P23:c1:a1', 'stale report keeps original a1 execution coordinate');
  assert.equal(reportRetry.timeline.at(-1).applied, false, 'stale a1 report payload is rejected in a2');
  assert.equal(reportRetry.steps.P23.sqe_report, null, 'rejected old report did not become current a2 report');
  const judgmentRetry = at('sqe-judgment-retry', 'stale');
  const measurementFixture = catalogById.get('sqe-judgment-retry');
  const measurementStaleCursor = measurementFixture.checkpoints.find(point => point.id === 'stale').cursor;
  const measurementEvents = measurementFixture.events.slice(0, measurementStaleCursor)
    .filter(event => event.source_id === 'mock:sqe-ui' && event.type === 'measurement');
  assert.equal(measurementEvents.length, 2);
  assert.deepEqual(measurementEvents[1].payload, measurementEvents[0].payload, 'retry replays the actual a1 measurement payload');
  assert.equal(measurementEvents[1].attempt, 1, 'stale measurement keeps original a1 outer attempt coordinate');
  assert.equal(measurementEvents[1].execution_id, 'mock:P24:c1:a1', 'stale measurement keeps original a1 execution coordinate');
  assert.equal(judgmentRetry.timeline.at(-1).applied, false, 'stale a1 measurement is rejected in a2');
  assert.equal(judgmentRetry.steps.P24.gate_verdict, null, 'rejected old measurement does not populate the a2 gate');
  const quarantined = at('sqe-manual-quarantine', 'blocked');
  assert.equal(quarantined.device.quarantined, true);
  assert.equal(quarantined.steps.P22.sqe_result, null, 'quarantine blocks human submission from becoming current result');
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
