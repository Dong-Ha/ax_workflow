import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createScenarioCatalog } from '../src/ifpmic/scenarios.mjs';
import { replayScenario } from '../src/ifpmic/replay.mjs';
import { mockSqeProfile } from '../src/ifpmic/sqe-profile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specs = path.join(root, 'docs/ifpmic/design-v1/specs');
const [workflow, stateContract] = await Promise.all([
  readFile(path.join(specs, 'workflow.v1.json'), 'utf8').then(JSON.parse),
  readFile(path.join(specs, 'state-contract.json'), 'utf8').then(JSON.parse),
]);
const catalog = createScenarioCatalog(workflow);
const approvedCases = ['mock:sqe:case:boot', 'mock:sqe:case:function'];
const sqeSource = 'mock:sqe-tc-source';
const observedFixtures = Object.create(null);

function fixture(id) {
  const item = catalog.find(scenario => scenario.id === id);
  assert.ok(item, `catalog contains ${id}`);
  return structuredClone(item);
}
function replay(item, cursor) { return replayScenario(item, workflow, stateContract, cursor); }
function workflowProjection(result) {
  const { timeline, ignored, duplicate_count, conflict_count, ...projection } = result;
  return projection;
}
function eventAt(item, sourceId, seq, type, stepId, payload) {
  const state = replay(item);
  const step = state.steps[stepId];
  return {
    event_id: `evt:${sourceId}:${seq}`, source_id: sourceId, source_seq: seq,
    type, mode: 'mock', job_id: state.job_id, step_id: stepId,
    cycle: state.cycle, attempt: step.attempt, execution_id: step.execution_id, payload,
  };
}
function originalOnly(item) {
  return item.events.filter(event => event.source_id !== 'mock:sqe-catalog');
}
function makeContext(id, state) {
  return {
    actor: 'mock:sqe', candidate_fingerprint: state.candidate_fingerprint,
    profile_ref: mockSqeProfile.profile_ref, profile_version: mockSqeProfile.profile_version,
    script_version: mockSqeProfile.script_version, parser_version: mockSqeProfile.parser_version,
    rule_version: state.rule_version,
    device_id: `mock:${id}:device:c${state.cycle}`, bridge_id: `mock:${id}:bridge:c${state.cycle}`,
    image_hash: `mock:${id}:image:c${state.cycle}`, expected_image_identity: `mock:${id}:boot:c${state.cycle}`,
    evidence_id: `mock:${id}:context:c${state.cycle}:a${state.steps.P22.attempt}`,
  };
}
function makeResult(id, state, context, overrides = {}) {
  return {
    actor: 'mock:sqe', execution_mode: 'bridge_mock', task_id: null, performer_id: 'mock:sqe',
    candidate_fingerprint: state.candidate_fingerprint,
    profile_ref: context.profile_ref, profile_version: context.profile_version,
    script_version: context.script_version, parser_version: context.parser_version, rule_version: context.rule_version,
    device_id: context.device_id, bridge_id: context.bridge_id, image_hash: context.image_hash,
    observed_device_id: context.device_id, observed_image_identity: context.expected_image_identity,
    started_at_ms: 1000, finished_at_ms: 2000, execution_status: 'completed', parser_status: 'complete',
    exit_code: 0, cases: approvedCases.map(case_id => ({ case_id, outcome: 'PASS' })),
    stdout_artifact_id: `mock:${id}:stdout`, stderr_artifact_id: `mock:${id}:stderr`,
    result_artifact_id: `mock:${id}:result-artifact`, evidence_id: `mock:${id}:result`,
    ...overrides,
  };
}
function makeReport(state, result) {
  return {
    actor: 'mock:sqe', candidate_fingerprint: state.candidate_fingerprint,
    result_evidence_id: result.evidence_id, result_execution_id: state.steps.P22.execution_id,
    profile_ref: mockSqeProfile.profile_ref, profile_version: mockSqeProfile.profile_version,
    report_artifact_id: 'mock:report:artifact', report_link_id: 'mock:report:link', evidence_id: 'mock:report:evidence',
  };
}

function manualHappyFixture({ contextOverrides = {}, resultOverrides = {}, reportOverride = null, insertProbeEvents = [] } = {}) {
  const old = fixture('happy-path');
  const events = originalOnly(old);
  const p22Running = events.findIndex(event => event.step_id === 'P22' && event.type === 'step' && event.payload.state === 'RUNNING');
  const p22Succeeded = events.findIndex(event => event.step_id === 'P22' && event.type === 'step' && event.payload.state === 'SUCCEEDED');
  const p23Running = events.findIndex(event => event.step_id === 'P23' && event.type === 'step' && event.payload.state === 'RUNNING');
  const p23Succeeded = events.findIndex(event => event.step_id === 'P23' && event.type === 'step' && event.payload.state === 'SUCCEEDED');
  assert.ok(p22Running >= 0 && p22Succeeded > p22Running && p23Running > p22Succeeded && p23Succeeded > p23Running);
  const resultEvents = events.slice(0, p22Running + 1);
  const sqeEvent = (type, step, payload, index) => eventAt({ ...old, events: resultEvents }, sqeSource, index, type, step, payload);
  const p22 = replay({ ...old, events: resultEvents });
  const context = { ...makeContext(`${old.id}:manual-tc`, p22), ...contextOverrides };
  resultEvents.push(sqeEvent('sqe_context', 'P22', context, 1));
  const manualTask = {
    actor: 'mock:sqe', task_id: `mock:manual:P22:c${p22.cycle}:a${p22.steps.P22.attempt}`,
    assignee: 'mock:human', performer_id: 'mock:performer:sqe', reason_id: 'mock:manual-reason',
    requested_at_ms: 3000, evidence_id: 'mock:manual-request:evidence',
  };
  resultEvents.push(sqeEvent('manual_request', 'P22', manualTask, 2));
  let waiting = replay({ ...old, events: resultEvents });
  const result = makeResult(`${old.id}:manual-tc`, waiting, context, {
    execution_mode: 'manual', actor: 'mock:human', task_id: manualTask.task_id,
    performer_id: manualTask.performer_id, started_at_ms: 3000, finished_at_ms: 4000,
    ...resultOverrides,
  });
  resultEvents.push(sqeEvent('sqe_result', 'P22', result, 3));
  resultEvents.push(sqeEvent('step', 'P22', { state: 'RUNNING' }, 4));
  // Keep the original P22 agent/success and P23 READY/RUNNING observations unchanged.
  resultEvents.push(...events.slice(p22Running + 1, p23Running + 1));
  let p23 = replay({ ...old, events: resultEvents });
  const report = makeReport(p23, result);
  resultEvents.push(sqeEvent('sqe_report', 'P23', reportOverride ?? report, 5));
  resultEvents.push(...events.slice(p23Running + 1));
  for (const probe of insertProbeEvents) resultEvents.splice(probe.index, 0, probe.event);
  return { scenario: { ...old, events: resultEvents }, context, manualTask, result, report };
}

function withSqeVariant(id, editResult, editMeasurement) {
  const scenario = fixture(id);
  const resultEvent = scenario.events.find(event => event.source_id === 'mock:sqe-catalog' && event.type === 'sqe_result');
  const measurement = scenario.events.find(event => event.step_id === 'P24' && event.type === 'measurement');
  assert.ok(resultEvent && measurement, `${id} carries SQE result and P24 observation`);
  editResult(resultEvent.payload);
  editMeasurement(measurement.payload);
  return scenario;
}

test('mock SQE profile is immutable with exactly two fixed synthetic required cases', () => {
  assert.deepEqual(mockSqeProfile, {
    profile_ref: 'mock:sqe:profile', profile_version: 'mock:sqe:profile:v1',
    script_version: 'mock:sqe:script:v1', parser_version: 'mock:sqe:parser:v1', rule_version: 'mock:rules:v1',
    expected_cases: approvedCases,
  });
  assert.ok(Object.isFrozen(mockSqeProfile));
  assert.ok(Object.isFrozen(mockSqeProfile.expected_cases));
});

test('bridge mock PASS and explicit SQE FAIL bind P22 result, P23 report, P24 disposition and release manifest', () => {
  const passed = replay(fixture('happy-path'));
  assert.equal(passed.current_step, 'END');
  assert.equal(passed.steps.P22.sqe_result.execution_mode, 'bridge_mock');
  assert.deepEqual(passed.steps.P22.sqe_result.cases, approvedCases.map(case_id => ({ case_id, outcome: 'PASS' })));
  assert.equal(passed.steps.P23.sqe_report.result_evidence_id, passed.steps.P22.sqe_result.evidence_id);
  assert.equal(passed.steps.P23.sqe_report.result_execution_id, passed.steps.P22.execution_id);
  assert.equal(passed.steps.P24.gate_verdict, 'PASS');
  assert.equal(passed.steps.P24.gate_sqe_report_evidence_id, passed.steps.P23.sqe_report.evidence_id);
  assert.equal(passed.release.manifest.sqe_report_evidence_id, passed.steps.P23.sqe_report.evidence_id);

  const failed = replay(fixture('sqe-failure'));
  assert.equal(failed.current_step, 'P07');
  assert.equal(failed.cycle, 2);
  assert.deepEqual(failed.history[0].steps.P22.sqe_result.cases, [
    { case_id: 'mock:sqe:case:boot', outcome: 'PASS' },
    { case_id: 'mock:sqe:case:function', outcome: 'FAIL' },
  ]);
  assert.equal(failed.history[0].steps.P24.gate_verdict, 'FAIL');
  assert.equal(failed.history[0].steps.P23.sqe_report.result_evidence_id, failed.history[0].steps.P22.sqe_result.evidence_id);
  observedFixtures['typed-fail'] = failed;
});

test('generic P22 state and agent completion cannot substitute for a collected bundle', () => {
  const scenario = fixture('happy-path');
  const events = originalOnly(scenario);
  const p22Running = events.findIndex(event => event.step_id === 'P22' && event.type === 'step' && event.payload.state === 'RUNNING');
  const prefix = events.slice(0, p22Running + 1);
  prefix.push(events.find(event => event.step_id === 'P22' && event.type === 'agent'));
  prefix.push(events.find(event => event.step_id === 'P22' && event.type === 'step' && event.payload.state === 'SUCCEEDED'));
  const result = replay({ ...scenario, events: prefix });
  assert.equal(result.current_step, 'P22');
  assert.equal(result.steps.P22.state, 'RUNNING');
  assert.equal(result.steps.P22.agent_status, 'completed');
  assert.equal(result.timeline.at(-1).applied, false);
  assert.equal(result.timeline.at(-1).reason, 'sqe_result_required');
  assert.equal(result.steps.P23.state, 'PENDING');
  assert.equal(result.release.publication_count, 0);
});

test('manual request waits for the assigned person and accepted result requires explicit RUNNING and SUCCEEDED', () => {
  const { scenario, manualTask, result: expectedBundle } = manualHappyFixture();
  const output = replay(scenario);
  assert.equal(output.current_step, 'END');
  assert.equal(output.steps.P22.sqe_execution_mode, 'manual');
  assert.equal(output.steps.P22.sqe_manual_task.task_id, manualTask.task_id);
  assert.equal(output.steps.P22.sqe_result.task_id, manualTask.task_id);
  assert.equal(output.steps.P22.sqe_result.performer_id, 'mock:performer:sqe');
  assert.equal(output.steps.P22.sqe_result.evidence_id, expectedBundle.evidence_id);
  assert.equal(output.steps.P22.state, 'SUCCEEDED');
  assert.equal(output.steps.P23.sqe_report.execution_mode, 'manual');
  assert.equal(output.steps.P24.gate_verdict, 'PASS');
  assert.equal(output.real_publish_allowed, false);
  observedFixtures['manual-pass'] = output;
});

test('manual context and submission enforce exact profile, actor, task, identity and time contracts', () => {
  const badContexts = [
    { name: 'wrong profile ref', edit: value => { value.profile_ref = 'mock:sqe:profile:other'; } },
    { name: 'wrong profile version', edit: value => { value.profile_version = 'mock:sqe:profile:v2'; } },
    { name: 'wrong script version', edit: value => { value.script_version = 'mock:sqe:script:v2'; } },
    { name: 'missing context field', edit: value => { value.bridge_id = undefined; } },
    { name: 'null context field', edit: value => { value.image_hash = null; } },
    { name: 'extra context field', edit: value => { value.unexpected = 'private'; } },
  ];
  for (const entry of badContexts) {
    const context = makeContext(`invalid-${entry.name.replaceAll(' ', '-')}`, replay(fixture('happy-path')));
    entry.edit(context);
    const built = manualHappyFixture({ contextOverrides: context });
    const output = replay(built.scenario);
    assert.equal(output.steps.P22.sqe_context, null, entry.name);
    assert.equal(output.steps.P22.sqe_manual_task, null, entry.name);
    assert.equal(output.steps.P22.state, 'RUNNING', entry.name);
    assert.equal(output.steps.P22.sqe_result, null, entry.name);
    assert.equal(output.release.publication_count, 0, entry.name);
  }

  const badResults = [
    { name: 'wrong actor', changes: { actor: 'mock:wrong-person' } },
    { name: 'wrong task', changes: { task_id: 'mock:manual:P22:c1:a2' } },
    { name: 'wrong performer', changes: { performer_id: 'mock:performer:other' } },
    { name: 'wrong candidate', changes: { candidate_fingerprint: 'mock:candidate:other' } },
    { name: 'wrong profile', changes: { profile_version: 'mock:sqe:profile:v2' } },
    { name: 'wrong profile hash', changes: { image_hash: 'mock:other:image' } },
    { name: 'wrong script version', changes: { script_version: 'mock:sqe:script:v2' } },
    { name: 'wrong parser version', changes: { parser_version: 'mock:sqe:parser:v2' } },
    { name: 'wrong rule version', changes: { rule_version: 'mock:rules:v2' } },
    { name: 'wrong device binding', changes: { device_id: 'mock:other:device' } },
    { name: 'started before task', changes: { started_at_ms: 2999 } },
    { name: 'finish before start', changes: { finished_at_ms: 2999 } },
    { name: 'unsafe start time', changes: { started_at_ms: Number.MAX_SAFE_INTEGER + 1 } },
    { name: 'missing result field', changes: { stdout_artifact_id: undefined } },
    { name: 'null result field', changes: { observed_image_identity: null } },
    { name: 'extra result field', changes: { private_text: 'must not leak' } },
  ];
  for (const entry of badResults) {
    const { scenario, result } = manualHappyFixture({ resultOverrides: entry.changes });
    const resultIndex = scenario.events.findIndex(event => event.type === 'sqe_result' && event.step_id === 'P22');
    assert.ok(resultIndex >= 0, `${entry.name} has an attempted submission`);
    const prefix = scenario.events.slice(0, resultIndex);
    const before = replay({ ...scenario, events: prefix });
    const output = replay({ ...scenario, events: [...prefix, scenario.events[resultIndex]] });
    assert.deepEqual(workflowProjection(output), workflowProjection(before), `${entry.name} rejected submission leaves business projection unchanged`);
    assert.equal(output.steps.P22.state, 'WAITING_HUMAN', entry.name);
    assert.equal(output.steps.P22.sqe_result, null, entry.name);
    assert.equal(output.steps.P22.sqe_manual_task.task_id, `mock:manual:P22:c1:a1`, entry.name);
    const row = output.timeline.find(event => event.type === 'sqe_result');
    assert.equal(row.applied, false, entry.name);
    assert.match(row.reason, /^(invalid_sqe_|invalid_manual_submission|unknown_payload_field)/i, entry.name);
    assert.equal(JSON.stringify(output).includes('must not leak'), false, entry.name);
    assert.ok(result.evidence_id);
    assert.equal(output.release.publication_count, 0, entry.name);
  }
});

test('a second P22 result bundle in the same attempt cannot replace the first accepted observation', () => {
  const { scenario, result: accepted } = manualHappyFixture();
  const resultIndex = scenario.events.findIndex(event => event.source_id === sqeSource && event.type === 'sqe_result');
  assert.ok(resultIndex >= 0);
  const prefix = scenario.events.slice(0, resultIndex + 1);
  const state = replay({ ...scenario, events: prefix });
  const duplicate = makeResult('manual-tc', state, state.steps.P22.sqe_context, {
    execution_mode: 'manual', actor: 'mock:human', task_id: state.steps.P22.sqe_manual_task.task_id,
    performer_id: 'mock:performer:sqe', started_at_ms: 3000, finished_at_ms: 4000,
    stdout_artifact_id: 'mock:manual:second-stdout', stderr_artifact_id: 'mock:manual:second-stderr',
    result_artifact_id: 'mock:manual:second-artifact', evidence_id: 'mock:manual:second-result',
  });
  const duplicateEvent = eventAt({ ...scenario, events: prefix }, 'mock:second-result', 1, 'sqe_result', 'P22', duplicate);
  const output = replay({ ...scenario, events: [...prefix, duplicateEvent] });
  assert.equal(output.steps.P22.sqe_result.evidence_id, accepted.evidence_id);
  assert.equal(output.steps.P22.state, 'READY');
  assert.equal(output.timeline.at(-1).applied, false);
  assert.equal(output.timeline.at(-1).reason, 'invalid_sqe_result');
  assert.equal(output.release.publication_count, 0);
});

test('manual task cannot be escaped by generic READY/RUNNING/SUCCEEDED before a result bundle', () => {
  const source = fixture('happy-path');
  const events = originalOnly(source);
  const p22Running = events.findIndex(event => event.step_id === 'P22' && event.type === 'step' && event.payload.state === 'RUNNING');
  const prefix = events.slice(0, p22Running + 1);
  let sequence = 0;
  const add = (type, payload) => prefix.push(eventAt({ ...source, events: prefix }, sqeSource, ++sequence, type, 'P22', payload));
  let state = replay({ ...source, events: prefix });
  const context = makeContext('manual-escape', state);
  add('sqe_context', context);
  state = replay({ ...source, events: prefix });
  add('manual_request', { actor: 'mock:sqe', task_id: `mock:manual:P22:c${state.cycle}:a${state.steps.P22.attempt}`,
    assignee: 'mock:human', performer_id: 'mock:performer:sqe', reason_id: 'mock:reason', requested_at_ms: 1, evidence_id: 'mock:request' });
  for (const next of ['READY', 'RUNNING', 'SUCCEEDED']) {
    const current = replay({ ...source, events: prefix });
    prefix.push({ ...eventAt({ ...source, events: prefix }, sqeSource, ++sequence, 'step', 'P22', { state: next }) });
    const after = replay({ ...source, events: prefix });
    assert.equal(after.timeline.at(-1).applied, false, `${next} rejected`);
    assert.equal(after.timeline.at(-1).reason, 'manual_submission_required');
    assert.equal(after.steps.P22.state, 'WAITING_HUMAN');
    assert.equal(after.steps.P22.sqe_manual_task.task_id, current.steps.P22.sqe_manual_task.task_id);
  }
});

test('P23 report is mandatory, current and result-bound before P23 or P24 can succeed', () => {
  const { scenario } = manualHappyFixture();
  const noReport = structuredClone(scenario);
  noReport.events = noReport.events.filter(event => event.type !== 'sqe_report');
  const blocked = replay(noReport);
  assert.equal(blocked.current_step, 'P23');
  assert.equal(blocked.steps.P23.state, 'RUNNING');
  assert.equal(blocked.timeline.find(row => row.step_id === 'P23' && row.type === 'step' && !row.applied)?.reason, 'sqe_report_required');
  assert.equal(blocked.steps.P24.state, 'PENDING');
  assert.equal(blocked.release.publication_count, 0);

  const staleReport = manualHappyFixture({ reportOverride: {
    actor: 'mock:sqe', candidate_fingerprint: 'mock:candidate:OLD',
    result_evidence_id: 'mock:old:result', result_execution_id: 'mock:P22:c1:a1',
    profile_ref: mockSqeProfile.profile_ref, profile_version: mockSqeProfile.profile_version,
    report_artifact_id: 'mock:old:artifact', report_link_id: 'mock:old:link', evidence_id: 'mock:old:report',
  } });
  const stale = replay(staleReport.scenario);
  const rejected = stale.timeline.find(row => row.type === 'sqe_report');
  assert.equal(rejected.applied, false);
  assert.equal(rejected.reason, 'invalid_sqe_report');
  assert.equal(stale.current_step, 'P23');
  assert.equal(stale.steps.P23.state, 'RUNNING');
});

test('P23 and P24 infrastructure retries reject stale attempt evidence and preserve release SQE binding', () => {
  const source = fixture('happy-path');
  const reportIndex = source.events.findIndex(event => event.source_id === 'mock:sqe-catalog' && event.type === 'sqe_report');
  const reportEvent = source.events[reportIndex];
  const p23RunningIndex = source.events.findIndex(event => event.step_id === 'P23' && event.type === 'step' && event.payload.state === 'RUNNING');
  const events = source.events.slice(0, reportIndex + 1);
  let clockSeq = 0, reportSeq = 0;
  const add = (type, step, payload, sourceId = 'mock:sqe-retry-tc') => {
    const seq = sourceId === 'mock:sqe-retry-clock' ? ++clockSeq : ++reportSeq;
    const event = eventAt({ ...source, events }, sourceId, seq, type, step, payload);
    events.push(event); return replay({ ...source, events });
  };
  assert.equal(replay({ ...source, events }).steps.P23.state, 'RUNNING');
  add('infra_error', 'P23', { now_ms: 0, operation: 'agent' }, 'mock:sqe-retry-clock');
  let state = add('retry', 'P23', { now_ms: 10000 }, 'mock:sqe-retry-clock');
  assert.equal(state.steps.P23.attempt, 2);
  add('step', 'P23', { state: 'RUNNING' });
  const stalePayload = structuredClone(reportEvent.payload);
  const staleReport = add('sqe_report', 'P23', stalePayload);
  assert.equal(staleReport.timeline.at(-1).applied, false);
  assert.equal(staleReport.steps.P23.sqe_report, null);
  assert.equal(staleReport.steps.P23.state, 'RUNNING');
  const p22 = staleReport.steps.P22;
  const currentReport = {
    actor: 'mock:sqe', candidate_fingerprint: staleReport.candidate_fingerprint,
    result_evidence_id: p22.sqe_result.evidence_id, result_execution_id: p22.execution_id,
    profile_ref: mockSqeProfile.profile_ref, profile_version: mockSqeProfile.profile_version,
    report_artifact_id: 'mock:sqe-retry:report-artifact:a2', report_link_id: 'mock:sqe-retry:report-link:a2',
    evidence_id: 'mock:sqe-retry:report:a2',
  };
  state = add('sqe_report', 'P23', currentReport);
  state = add('step', 'P23', { state: 'SUCCEEDED' });
  assert.equal(state.steps.P23.sqe_report.attempt, 2);
  assert.equal(state.steps.P23.state, 'SUCCEEDED');

  const p24OldGate = source.events.find(event => event.step_id === 'P24' && event.type === 'measurement');
  assert.ok(p24OldGate, 'catalog fixture supplies the first attempt gate proof');
  add('step', 'P24', { state: 'READY' });
  add('step', 'P24', { state: 'RUNNING' });
  let current = replay({ ...source, events });
  const oldGate = structuredClone(p24OldGate.payload);
  oldGate.evidence.evidence_id = 'mock:sqe-retry:gate:a1';
  add('measurement', 'P24', oldGate);
  add('infra_error', 'P24', { now_ms: 10000, operation: 'metric' }, 'mock:sqe-retry-clock');
  state = add('retry', 'P24', { now_ms: 20000 }, 'mock:sqe-retry-clock');
  assert.equal(state.steps.P24.attempt, 2);
  assert.equal(state.steps.P24.gate_verdict, null);
  add('step', 'P24', { state: 'RUNNING' });
  current = replay({ ...source, events });
  const p24Step = current.steps.P24;
  const freshGate = {
    evidence: { mode: 'mock', job_id: current.job_id, step_id: 'P24', cycle: current.cycle,
      attempt: p24Step.attempt, execution_id: p24Step.execution_id,
      candidate_fingerprint: current.candidate_fingerprint, rule_version: current.rule_version,
      evidence_id: 'mock:sqe-retry:gate:a2', complete: true }, verdict: 'PASS',
  };
  add('measurement', 'P24', freshGate);
  state = add('step', 'P24', { state: 'SUCCEEDED' });
  assert.equal(state.current_step, 'X02');
  assert.equal(state.steps.P24.gate_verdict, 'PASS');
  assert.equal(state.steps.P24.gate_sqe_report_evidence_id, currentReport.evidence_id);
  assert.equal(state.release.manifest, null, 'the metadata-recovery catalog case separately checks manifest SQE binding');
  assert.equal(p23RunningIndex >= 0, true);

  const metadata = replay(fixture('metadata-recovery'));
  assert.equal(metadata.current_step, 'END');
  assert.equal(metadata.release.manifest.sqe_report_evidence_id, metadata.steps.P23.sqe_report.evidence_id,
    'metadata repair publishes a manifest bound to the current SQE report');
});

test('P24 derives only the fixed disposition table and incomplete or parser-error results cannot pass', () => {
  const cases = [
    { name: 'missing required case', result: { cases: [{ case_id: approvedCases[0], outcome: 'PASS' }] }, verdict: 'INCONCLUSIVE', complete: false },
    { name: 'INCONCLUSIVE case', result: { cases: [{ case_id: approvedCases[0], outcome: 'PASS' }, { case_id: approvedCases[1], outcome: 'INCONCLUSIVE' }] }, verdict: 'INCONCLUSIVE', complete: false },
    { name: 'parser error', result: { parser_status: 'error' }, verdict: 'ERROR', complete: false },
    { name: 'case error', result: { cases: [{ case_id: approvedCases[0], outcome: 'PASS' }, { case_id: approvedCases[1], outcome: 'ERROR' }] }, verdict: 'ERROR', complete: false },
    { name: 'image identity mismatch', result: { observed_image_identity: 'mock:wrong:boot' }, verdict: 'INCONCLUSIVE', complete: false },
    { name: 'device identity mismatch', result: { observed_device_id: 'mock:wrong:device' }, verdict: 'INCONCLUSIVE', complete: false },
  ];
  for (const entry of cases) {
    const scenario = withSqeVariant('happy-path', payload => Object.assign(payload, entry.result), (payload) => {
      payload.verdict = entry.verdict; payload.evidence.complete = entry.complete;
      payload.evidence.evidence_id = `mock:P24:${entry.name.replaceAll(' ', '-')}`;
    });
    const result = replay(scenario);
    assert.equal(result.steps.P22.state, 'SUCCEEDED', entry.name);
    assert.equal(result.steps.P23.state, 'SUCCEEDED', entry.name);
    assert.equal(result.current_step, 'P24', entry.name);
    assert.equal(result.steps.P24.state, 'RUNNING', entry.name);
    assert.equal(result.steps.P24.gate_verdict, entry.verdict, entry.name);
    assert.equal(result.steps.P24.gate_complete, false, entry.name);
    assert.equal(result.timeline.find(row => row.step_id === 'P24' && row.type === 'step' && !row.applied)?.reason,
      'gate_pass_required', entry.name);
    assert.equal(result.release.publication_count, 0, entry.name);
    assert.equal(result.real_publish_allowed, false, entry.name);
    if (entry.name === 'missing required case') observedFixtures.incomplete = result;
    if (entry.name === 'parser error') observedFixtures['parser-error'] = result;
    if (entry.name === 'image identity mismatch') observedFixtures['identity-mismatch'] = result;
  }
});

test('P22 infrastructure error cannot pass or report and retry requires new attempt context and result', () => {
  const scenario = withSqeVariant('happy-path', payload => { payload.execution_status = 'infrastructure_error'; }, () => {});
  const failedBundle = replay(scenario);
  assert.equal(failedBundle.current_step, 'P22');
  assert.equal(failedBundle.steps.P22.state, 'RUNNING');
  assert.equal(failedBundle.timeline.find(row => row.step_id === 'P22' && row.type === 'step' && !row.applied)?.reason,
    'sqe_result_required');
  assert.equal(failedBundle.steps.P23.state, 'PENDING');

  const events = originalOnly(fixture('happy-path')).slice(0, 0);
  // Start from the full happy prefix through the recorded infrastructure-error bundle.
  const source = fixture('happy-path');
  const oldEvents = originalOnly(source);
  const p22Running = oldEvents.findIndex(event => event.step_id === 'P22' && event.type === 'step' && event.payload.state === 'RUNNING');
  const base = oldEvents.slice(0, p22Running + 1);
  let proofSeq = 0;
  const addProof = (type, payload, step = 'P22') => {
    const e = eventAt({ ...source, events }, sqeSource, ++proofSeq, type, step, payload);
    events.push(e); return e;
  };
  events.push(...base);
  const before = replay({ ...source, events });
  const context1 = makeContext('retry', before);
  addProof('sqe_context', context1);
  addProof('sqe_result', makeResult('retry', replay({ ...source, events }), context1, { execution_status: 'infrastructure_error' }));
  events.push(eventAt({ ...source, events }, 'mock:sqe-infra', 1, 'infra_error', 'P22', { now_ms: 0, operation: 'agent' }));
  events.push(eventAt({ ...source, events }, 'mock:sqe-infra', 2, 'retry', 'P22', { now_ms: 10000 }));
  const newAttempt = replay({ ...source, events });
  assert.equal(newAttempt.steps.P22.attempt, 2);
  assert.equal(newAttempt.steps.P22.execution_id, 'mock:P22:c1:a2');
  assert.equal(newAttempt.steps.P22.state, 'READY');
  const staleContext = addProof('sqe_context', context1);
  const afterStale = replay({ ...source, events });
  assert.equal(afterStale.timeline.at(-1).applied, false);
  assert.equal(afterStale.steps.P22.sqe_context, null);
  const context2 = makeContext('retry-new-attempt', afterStale);
  context2.evidence_id = 'mock:retry:context:c1:a2';
  addProof('step', { state: 'RUNNING' });
  addProof('sqe_context', context2);
  addProof('manual_request', {
    actor: 'mock:sqe', task_id: 'mock:manual:P22:c1:a1', assignee: 'mock:human',
    performer_id: 'mock:performer:sqe', reason_id: 'mock:old-task', requested_at_ms: 5000,
    evidence_id: 'mock:retry:old-human-request:a2',
  });
  const staleRequest = replay({ ...source, events });
  assert.equal(staleRequest.timeline.at(-1).applied, false);
  assert.equal(staleRequest.steps.P22.sqe_manual_task, null);
  addProof('sqe_result', makeResult('retry', replay({ ...source, events }), context1, {
    evidence_id: 'mock:retry:old-result:a2', stdout_artifact_id: 'mock:retry:old-stdout:a2',
    stderr_artifact_id: 'mock:retry:old-stderr:a2', result_artifact_id: 'mock:retry:old-artifact:a2',
  }));
  const staleResult = replay({ ...source, events });
  assert.equal(staleResult.timeline.at(-1).applied, false);
  assert.equal(staleResult.steps.P22.sqe_result, null);
  addProof('sqe_result', makeResult('retry-new-attempt', replay({ ...source, events }), context2, {
    evidence_id: 'mock:retry:result:c1:a2', stdout_artifact_id: 'mock:retry:stdout:a2',
    stderr_artifact_id: 'mock:retry:stderr:a2', result_artifact_id: 'mock:retry:artifact:a2',
  }));
  addProof('step', { state: 'SUCCEEDED' });
  const complete = replay({ ...source, events });
  assert.equal(complete.steps.P22.state, 'SUCCEEDED');
  assert.equal(complete.steps.P22.attempt, 2);
  assert.equal(complete.history.some(row => row.kind === 'attempt' && row.step_id === 'P22' && row.step.sqe_result.execution_status === 'infrastructure_error'), true);
  assert.notEqual(staleContext.payload.evidence_id, complete.steps.P22.sqe_context.evidence_id);
});

test('manual infrastructure failure archives attempt one and requires a fresh task and complete proof for attempt two', () => {
  const source = fixture('happy-path');
  const original = originalOnly(source);
  const p22Running = original.findIndex(event => event.step_id === 'P22' && event.type === 'step' && event.payload.state === 'RUNNING');
  const p23Running = original.findIndex(event => event.step_id === 'P23' && event.type === 'step' && event.payload.state === 'RUNNING');
  const base = original.slice(0, p22Running + 1);
  const events = [...base];
  let seq = 0;
  const add = (type, step, payload, sourceId = 'mock:manual-infra-tc') => {
    const event = eventAt({ ...source, events }, sourceId, ++seq, type, step, payload);
    events.push(event); return replay({ ...source, events });
  };
  let state = replay({ ...source, events });
  const context1 = makeContext('manual-infra', state);
  add('sqe_context', 'P22', context1);
  state = replay({ ...source, events });
  const task1 = `mock:manual:P22:c1:a1`;
  add('manual_request', 'P22', { actor: 'mock:sqe', task_id: task1, assignee: 'mock:human',
    performer_id: 'mock:performer:sqe', reason_id: 'mock:manual-infra', requested_at_ms: 1000, evidence_id: 'mock:manual-infra:request:a1' });
  state = replay({ ...source, events });
  const failedManualResult = makeResult('manual-infra', state, context1, {
    execution_mode: 'manual', actor: 'mock:human', task_id: task1, performer_id: 'mock:performer:sqe',
    started_at_ms: 1000, finished_at_ms: 2000, execution_status: 'infrastructure_error', parser_status: 'error',
    exit_code: null, cases: [], evidence_id: 'mock:manual-infra:result:a1', stdout_artifact_id: 'mock:manual-infra:stdout:a1',
    stderr_artifact_id: 'mock:manual-infra:stderr:a1', result_artifact_id: 'mock:manual-infra:artifact:a1',
  });
  state = add('sqe_result', 'P22', failedManualResult);
  assert.equal(state.steps.P22.state, 'READY');
  add('step', 'P22', { state: 'RUNNING' });
  add('infra_error', 'P22', { now_ms: 0, operation: 'agent' }, 'mock:manual-infra-clock');
  state = add('retry', 'P22', { now_ms: 10000 }, 'mock:manual-infra-clock');
  assert.equal(state.steps.P22.attempt, 2);
  assert.equal(state.steps.P22.state, 'READY');
  assert.equal(state.steps.P22.sqe_manual_task, null);
  assert.equal(state.steps.P22.sqe_result, null);
  assert.equal(state.history.at(-1).kind, 'attempt');
  assert.equal(state.history.at(-1).step.sqe_manual_task.task_id, task1);
  assert.equal(state.history.at(-1).step.sqe_result.evidence_id, failedManualResult.evidence_id);

  add('step', 'P22', { state: 'RUNNING' });
  const context2 = makeContext('manual-infra-new', replay({ ...source, events }));
  context2.evidence_id = 'mock:manual-infra:context:a2';
  add('sqe_context', 'P22', context2);
  const task2 = 'mock:manual:P22:c1:a2';
  add('manual_request', 'P22', { actor: 'mock:sqe', task_id: task2, assignee: 'mock:human',
    performer_id: 'mock:performer:sqe', reason_id: 'mock:manual-infra', requested_at_ms: 11000, evidence_id: 'mock:manual-infra:request:a2' });
  state = replay({ ...source, events });
  assert.equal(state.steps.P22.state, 'WAITING_HUMAN');
  add('sqe_result', 'P22', makeResult('manual-infra-new', state, context2, {
    execution_mode: 'manual', actor: 'mock:human', task_id: task1, performer_id: 'mock:performer:sqe',
    started_at_ms: 11000, finished_at_ms: 12000, evidence_id: 'mock:manual-infra:old-task-result:a2',
    stdout_artifact_id: 'mock:manual-infra:old-task-stdout:a2', stderr_artifact_id: 'mock:manual-infra:old-task-stderr:a2',
    result_artifact_id: 'mock:manual-infra:old-task-artifact:a2',
  }));
  state = replay({ ...source, events });
  assert.equal(state.timeline.at(-1).applied, false);
  assert.equal(state.steps.P22.state, 'WAITING_HUMAN');
  assert.equal(state.steps.P22.sqe_result, null);
  add('sqe_result', 'P22', makeResult('manual-infra-new', state, context2, {
    execution_mode: 'manual', actor: 'mock:human', task_id: task2, performer_id: 'mock:performer:sqe',
    started_at_ms: 11000, finished_at_ms: 12000, evidence_id: 'mock:manual-infra:result:a2',
    stdout_artifact_id: 'mock:manual-infra:stdout:a2', stderr_artifact_id: 'mock:manual-infra:stderr:a2',
    result_artifact_id: 'mock:manual-infra:artifact:a2',
  }));
  add('step', 'P22', { state: 'RUNNING' });
  add('step', 'P22', { state: 'SUCCEEDED' });
  events.push(...original.slice(p22Running + 1, p23Running + 1));
  state = replay({ ...source, events });
  assert.equal(state.steps.P22.state, 'SUCCEEDED');
  const p23Report = makeReport(state, state.steps.P22.sqe_result);
  p23Report.result_execution_id = state.steps.P22.execution_id;
  p23Report.evidence_id = 'mock:manual-infra:report:a2';
  events.push(eventAt({ ...source, events }, 'mock:manual-infra-report', 1, 'sqe_report', 'P23', p23Report));
  events.push(eventAt({ ...source, events }, 'mock:manual-infra-report', 2, 'step', 'P23', { state: 'SUCCEEDED' }));
  const p24 = replay({ ...source, events });
  assert.equal(p24.steps.P23.state, 'SUCCEEDED');
  assert.equal(p24.steps.P23.sqe_report.execution_mode, 'manual');
  assert.equal(p24.steps.P24.state, 'PENDING');
  observedFixtures['manual-retry'] = p24;
});

test('P22, P23 and P24 SQE records obey the shared 10s/30s retries, then stop at attempt three', () => {
  const source = fixture('happy-path');
  const fullEvents = source.events;
  const stepRunningAt = stepId => fullEvents.findIndex(event => event.type === 'step' && event.step_id === stepId
    && event.payload.state === 'RUNNING');
  const setupPrefix = stepId => {
    const index = stepRunningAt(stepId);
    assert.ok(index >= 0, `${stepId} anchor exists`);
    let prefix = fullEvents.slice(0, index + 1);
    if (stepId === 'P23') prefix = prefix.filter(event => !(event.source_id === 'mock:sqe-catalog' && event.type === 'sqe_report'));
    return prefix;
  };
  for (const stepId of ['P22', 'P23', 'P24']) {
    const events = setupPrefix(stepId);
    let seq = 0, infraSeq = 0;
    const sourceId = `mock:sqe-boundary:${stepId}`;
    const clockSource = `mock:sqe-boundary-clock:${stepId}`;
    const add = (type, payload, eventStep = stepId, eventSource = sourceId) => {
      const event = eventAt({ ...source, events }, eventSource,
        eventSource === clockSource ? ++infraSeq : ++seq, type, eventStep, payload);
      events.push(event);
      return replay({ ...source, events });
    };
    const evidenceByAttempt = new Map();
    let clock = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      let state = replay({ ...source, events });
      assert.equal(state.current_step, stepId, `${stepId}/attempt-${attempt} is active`);
      if (attempt > 1) add('step', { state: 'RUNNING' });
      state = replay({ ...source, events });
      const step = state.steps[stepId];
      assert.equal(step.attempt, attempt, `${stepId} expected attempt ${attempt}`);
      let oldEvidence = null;
      if (stepId === 'P22') {
        const context = makeContext(`${stepId}-retry-boundary`, state);
        context.evidence_id = `mock:${stepId}:boundary:context:a${attempt}`;
        add('sqe_context', context);
        state = replay({ ...source, events });
        const errorResult = makeResult(`${stepId}-retry-boundary`, state, context, {
          execution_status: 'infrastructure_error', parser_status: 'error', exit_code: null, cases: [],
          evidence_id: `mock:${stepId}:boundary:result:a${attempt}`,
          stdout_artifact_id: `mock:${stepId}:boundary:stdout:a${attempt}`,
          stderr_artifact_id: `mock:${stepId}:boundary:stderr:a${attempt}`,
          result_artifact_id: `mock:${stepId}:boundary:artifact:a${attempt}`,
        });
        add('sqe_result', errorResult);
        oldEvidence = { type: 'sqe_result', payload: errorResult };
        evidenceByAttempt.set(attempt, { context, result: errorResult });
      } else if (stepId === 'P23') {
        const result = state.steps.P22.sqe_result;
        const report = makeReport(state, result);
        report.evidence_id = `mock:${stepId}:boundary:report:a${attempt}`;
        report.report_artifact_id = `mock:${stepId}:boundary:report-artifact:a${attempt}`;
        report.report_link_id = `mock:${stepId}:boundary:report-link:a${attempt}`;
        add('sqe_report', report);
        oldEvidence = { type: 'sqe_report', payload: report };
        evidenceByAttempt.set(attempt, report);
      } else {
        if (attempt === 2) {
          const beforeStale = replay({ ...source, events });
          const stale = add('measurement', structuredClone(evidenceByAttempt.get(1)));
          assert.equal(stale.timeline.at(-1).applied, false, 'a1 gate envelope is stale on a2');
          assert.equal(stale.timeline.at(-1).reason, 'stale_evidence');
          assert.deepEqual(workflowProjection(stale), workflowProjection(beforeStale), 'stale a1 measurement leaves a2 gate projection unchanged');
        }
        const measurement = {
          evidence: { mode: 'mock', job_id: state.job_id, step_id: 'P24', cycle: state.cycle,
            attempt: step.attempt, execution_id: step.execution_id, candidate_fingerprint: state.candidate_fingerprint,
            rule_version: state.rule_version, evidence_id: `mock:P24:boundary:gate:a${attempt}`, complete: true },
          verdict: 'PASS',
        };
        add('measurement', measurement);
        oldEvidence = { type: 'measurement', payload: measurement };
        evidenceByAttempt.set(attempt, measurement);
      }
      state = replay({ ...source, events });
      if (stepId === 'P22') assert.ok(state.steps.P22.sqe_result, 'attempt records its error bundle');
      if (stepId === 'P23') assert.ok(state.steps.P23.sqe_report, 'attempt records its report');
      if (stepId === 'P24') assert.equal(state.steps.P24.gate_verdict, 'PASS', 'attempt records its gate proof');
      clock = attempt === 1 ? 0 : attempt === 2 ? 10000 : 40000;
      state = add('infra_error', { now_ms: clock, operation: stepId === 'P24' ? 'metric' : 'agent' }, stepId, clockSource);
      if (attempt < 3) {
        assert.equal(state.steps[stepId].state, 'WAITING_RETRY', `${stepId}/attempt-${attempt} waits for retry`);
        assert.equal(state.steps[stepId].retry_due_ms, clock + (attempt === 1 ? 10000 : 30000));
        const beforeEarlyRetry = state;
        const early = add('retry', { now_ms: state.steps[stepId].retry_due_ms - 1 }, stepId, clockSource);
        assert.equal(early.timeline.at(-1).applied, false, `${stepId}/attempt-${attempt} rejects one millisecond early`);
        assert.equal(early.steps[stepId].attempt, attempt);
        assert.equal(early.steps[stepId].state, 'WAITING_RETRY');
        state = add('retry', { now_ms: beforeEarlyRetry.steps[stepId].retry_due_ms }, stepId, clockSource);
        assert.equal(state.steps[stepId].attempt, attempt + 1, `${stepId}/attempt-${attempt} accepts exact backoff boundary`);
        assert.equal(state.steps[stepId].state, 'READY');
        if (stepId === 'P22') {
          assert.equal(state.steps.P22.sqe_context, null);
          assert.equal(state.steps.P22.sqe_result, null);
        } else if (stepId === 'P23') {
          assert.equal(state.steps.P23.sqe_report, null);
          assert.ok(state.steps.P22.sqe_result, 'P22 proof remains current while P23 retries');
        } else {
          assert.equal(state.steps.P24.gate_verdict, null);
          assert.equal(state.steps.P24.gate_evidence_id, null);
          assert.ok(state.steps.P23.sqe_report, 'P23 report remains current while P24 retries');
        }
      } else {
        assert.equal(state.steps[stepId].state, 'WAITING_HUMAN', `${stepId} attempt three requires human intervention`);
        assert.equal(state.steps[stepId].attempt, 3);
        assert.equal(state.steps[stepId].retry_due_ms, null);
        const beforeFourth = workflowProjection(state);
        const fourth = add('retry', { now_ms: clock }, stepId, clockSource);
        assert.equal(fourth.timeline.at(-1).applied, false);
        assert.equal(fourth.steps[stepId].attempt, 3, 'no fourth attempt exists');
        if (stepId === 'P22') {
          add('sqe_context', evidenceByAttempt.get(1).context);
        } else if (stepId === 'P23') {
          add('sqe_report', evidenceByAttempt.get(1));
        } else {
          add('measurement', evidenceByAttempt.get(1));
        }
        state = replay({ ...source, events });
        assert.deepEqual(workflowProjection(state), beforeFourth, `${stepId} old evidence cannot clear attempt-three wait`);
        assert.equal(state.steps[stepId].attempt, 3);
        assert.equal(state.release.publication_count, 0);
      }
    }
  }
});

test('generic FAILED cannot bypass evidence-bound SQE failure handling at P22, P23 or P24', () => {
  const full = fixture('happy-path');
  const base = originalOnly(full);
  const cases = [
    ['P22 without context', 'P22', event => event.step_id === 'P22' && event.type === 'step' && event.payload.state === 'RUNNING'],
    ['P23 after current result', 'P23', event => event.step_id === 'P23' && event.type === 'step' && event.payload.state === 'RUNNING'],
    ['P24 after current SQE report', 'P24', event => event.step_id === 'P24' && event.type === 'step' && event.payload.state === 'RUNNING'],
  ];
  for (const [label, stepId, predicate] of cases) {
    const source = stepId === 'P22' ? base : full.events;
    const end = source.findIndex(predicate);
    assert.ok(end >= 0, `${label} fixture reaches RUNNING`);
    const prefix = source.slice(0, end + 1);
    const scenario = { ...full, events: prefix };
    const before = replay(scenario);
    const failEvent = eventAt(scenario, `tc-fail-${stepId}`, 1, 'step', stepId, { state: 'FAILED' });
    const output = replay({ ...scenario, events: [...prefix, failEvent] });
    assert.deepEqual(workflowProjection(output), workflowProjection(before), `${label} leaves business projection unchanged`);
    assert.equal(output.steps[stepId].state, 'RUNNING', `${label} cannot directly fail the step`);
    assert.equal(output.timeline.at(-1).applied, false);
    assert.equal(output.timeline.at(-1).reason, 'dedicated_sqe_failure_required');
    assert.equal(output.current_step, before.current_step);
    assert.equal(output.release.publication_count, 0);
  }

  const old = fixture('happy-path');
  const events = originalOnly(old);
  const runningAt = events.findIndex(event => event.step_id === 'P22' && event.type === 'step' && event.payload.state === 'RUNNING');
  const prefix = events.slice(0, runningAt + 1);
  const before = replay({ ...old, events: prefix });
  const ctx = makeContext('failed-manual', before);
  prefix.push(eventAt({ ...old, events: prefix }, 'manual-wait-failure', 1, 'sqe_context', 'P22', ctx));
  prefix.push(eventAt({ ...old, events: prefix }, 'manual-wait-failure', 2, 'manual_request', 'P22', {
    actor: 'mock:sqe', task_id: `mock:manual:P22:c${before.cycle}:a${before.steps.P22.attempt}`,
    assignee: 'mock:human', performer_id: 'mock:performer:sqe', reason_id: 'mock:manual-reason',
    requested_at_ms: 3000, evidence_id: 'mock:manual-request:failed',
  }));
  const waitingScenario = { ...old, events: prefix };
  assert.equal(replay(waitingScenario).steps.P22.state, 'WAITING_HUMAN');
  const manualFail = eventAt(waitingScenario, 'manual-wait-failure', 3, 'step', 'P22', { state: 'FAILED' });
  const waitingOutput = replay({ ...waitingScenario, events: [...prefix, manualFail] });
  assert.equal(waitingOutput.steps.P22.state, 'WAITING_HUMAN');
  assert.equal(waitingOutput.timeline.at(-1).reason, 'dedicated_sqe_failure_required');
  assert.equal(waitingOutput.release.publication_count, 0);

  const businessFail = replay(fixture('sqe-failure'));
  assert.equal(businessFail.current_step, 'P07', 'a complete typed FAIL disposition still follows the authorized business route');
  assert.equal(businessFail.history[0].steps.P24.gate_verdict, 'FAIL');
});

test('duplicate SQE proof IDs, malformed case bundles, stale coordinates and quarantine fail closed', () => {
  const malformedCases = [
    { name: 'unknown case', edit: result => { result.cases[1].case_id = 'mock:sqe:case:invented'; } },
    { name: 'duplicate case', edit: result => { result.cases[1].case_id = result.cases[0].case_id; } },
    { name: 'extra case field', edit: result => { result.cases[1].unexpected = 'private'; } },
    { name: 'reused evidence id', edit: result => { result.evidence_id = 'mock:happy-path:sqe:context:c1:a1'; } },
    { name: 'reused artifact id', edit: result => { result.stderr_artifact_id = result.stdout_artifact_id; } },
  ];
  for (const invalid of malformedCases) {
    const scenario = fixture('happy-path');
    const sqeResult = scenario.events.find(event => event.source_id === 'mock:sqe-catalog' && event.type === 'sqe_result');
    invalid.edit(sqeResult.payload);
    const output = replay(scenario);
    const row = output.timeline.find(event => event.type === 'sqe_result');
    assert.equal(row.applied, false, invalid.name);
    assert.equal(output.steps.P22.state, 'RUNNING', invalid.name);
    assert.equal(output.steps.P23.state, 'PENDING', invalid.name);
    assert.equal(output.release.publication_count, 0, invalid.name);
  }

  const stale = fixture('happy-path');
  const staleResult = stale.events.find(event => event.source_id === 'mock:sqe-catalog' && event.type === 'sqe_result');
  staleResult.execution_id = 'mock:P22:c0:a1';
  const staleOutput = replay(stale);
  assert.equal(staleOutput.timeline.find(event => event.type === 'sqe_result').reason, 'stale_execution');
  assert.equal(staleOutput.steps.P22.state, 'RUNNING');

  const { scenario: manual } = manualHappyFixture();
  const contextEvent = manual.events.find(event => event.type === 'sqe_context' && event.step_id === 'P22');
  const requestEvent = manual.events.find(event => event.type === 'manual_request');
  const beforeRequest = manual.events.slice(0, manual.events.indexOf(requestEvent));
  const state = replay({ ...manual, events: beforeRequest });
  const quarantine = eventAt({ ...manual, events: beforeRequest }, 'mock:sqe-device', 1, 'device', 'P22', {
    mode: 'mock', now_ms: 100, last_heartbeat_ms: 100, lease_expires_ms: 100, operation_state: 'unknown',
  });
  const withQuarantine = [...beforeRequest, quarantine, requestEvent, ...manual.events.slice(manual.events.indexOf(requestEvent) + 1)];
  const quarantined = replay({ ...manual, events: withQuarantine });
  assert.equal(quarantined.device.quarantined, true);
  assert.equal(quarantined.timeline.find(row => row.type === 'manual_request').reason, 'reconciliation_required');
  assert.equal(quarantined.steps.P22.state, 'RUNNING');
  assert.equal(quarantined.status, 'RECONCILING');
  assert.ok(contextEvent && state.current_step === 'P22');
  assert.equal(quarantined.real_publish_allowed, false);
});

test('write synthetic SQE current/history observations after their independent assertions pass', async () => {
  const required = ['manual-pass', 'typed-fail', 'incomplete', 'parser-error', 'identity-mismatch', 'manual-retry'];
  for (const name of required) assert.ok(observedFixtures[name], `${name} fixture was asserted before evidence generation`);
  const projectStep = step => ({
    state: step.state, attempt: step.attempt, execution_id: step.execution_id,
    sqe_execution_mode: step.sqe_execution_mode,
    sqe_context: step.sqe_context, sqe_manual_task: step.sqe_manual_task,
    sqe_result: step.sqe_result, sqe_report: step.sqe_report,
    gate_verdict: step.gate_verdict, gate_complete: step.gate_complete,
    gate_evidence_id: step.gate_evidence_id, gate_sqe_report_evidence_id: step.gate_sqe_report_evidence_id,
  });
  const serialize = result => ({
    mode: result.mode, scenario_id: result.scenario_id, job_id: result.job_id, cycle: result.cycle,
    status: result.status, current_step: result.current_step, rework_count: result.rework_count,
    candidate_fingerprint: result.candidate_fingerprint, rule_version: result.rule_version,
    steps: Object.fromEntries(['P22', 'P23', 'P24'].map(id => [id, projectStep(result.steps[id])])),
    history: result.history.map(row => ({
      kind: row.kind, cycle: row.cycle, step_id: row.step_id,
      steps: row.steps ? Object.fromEntries(['P22', 'P23', 'P24'].map(id => [id, projectStep(row.steps[id])])) : undefined,
      step: row.step ? projectStep(row.step) : undefined,
    })),
    release: { approved: result.release.approved, publication_count: result.release.publication_count,
      manifest_id: result.release.manifest?.manifest_id ?? null,
      sqe_report_evidence_id: result.release.manifest?.sqe_report_evidence_id ?? null,
      receipt_id: result.release.receipt_id },
    event_journal: result.timeline.map(row => ({ event_id: row.event_id, source_id: row.source_id,
      source_seq: row.source_seq, type: row.type, step_id: row.step_id, cycle: row.cycle,
      attempt: row.attempt, applied: row.applied, reason: row.reason })),
  });
  const currentSource = await readFile(fileURLToPath(import.meta.url));
  const artifact = {
    kind: 'synthetic-sqe-observation-samples',
    generated_at: new Date().toISOString(),
    mode: 'mock',
    verdict_scope: 'generated observations from fixtures whose independent assertions passed; observations are evidence, not an oracle',
    test_file: 'tests/ifpmic-sqe.test.mjs',
    test_file_sha256: createHash('sha256').update(currentSource).digest('hex'),
    cases: Object.fromEntries(required.map(name => [name, serialize(observedFixtures[name])])),
  };
  const outputPath = path.join(root, 'workflow-artifacts/verification/V2/sqe/unit-observations.json');
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  const readback = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(readback.mode, 'mock');
  assert.deepEqual(Object.keys(readback.cases), required);
  assert.ok(readback.cases['typed-fail'].history.length > 0);
  assert.equal(readback.cases['manual-retry'].history.some(row => row.kind === 'attempt'), true);
  assert.equal(readback.cases['manual-pass'].release.publication_count, 1);
});
