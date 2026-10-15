import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { replayScenario } from '../src/ifpmic/replay.mjs';
import { mockSqeProfile } from '../src/ifpmic/sqe-profile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specs = path.join(root, 'docs/ifpmic/design-v1/specs');
const [workflow, stateContract] = await Promise.all([
  readFile(path.join(specs, 'workflow.v1.json'), 'utf8').then(JSON.parse),
  readFile(path.join(specs, 'state-contract.json'), 'utf8').then(JSON.parse),
]);

// Fixed route expectations copied from the approved V2 protocol and original
// workflow; expected pairs are never calculated from runtime graph edges.
const routeCases = [
  { from: 'P13', outcome: 'business_fail', target: 'P11' },
  { from: 'P14', outcome: 'business_fail', target: 'P11' },
  { from: 'P16', outcome: 'business_fail', target: 'P07' },
  { from: 'P18', outcome: 'business_fail', target: 'P11' },
  { from: 'P20', outcome: 'business_fail', target: 'P11' },
  { from: 'P21', outcome: 'business_fail', target: 'P11', decision: 'reject' },
  { from: 'P24', outcome: 'business_fail', target: 'P07' },
  { from: 'X01', outcome: 'rejected', target: 'P02', decision: 'reject' },
  { from: 'P21', outcome: 'design_change_needed', target: 'P07', decision: 'design_change_needed' },
  { from: 'X03', outcome: 'reject_code', target: 'P11' },
  { from: 'X03', outcome: 'reject_design', target: 'P07' },
  { from: 'X03', outcome: 'reject_release_metadata', target: 'X02' },
];

const nodeOrder = [
  'P01', 'P02', 'P03', 'P04', 'P05', 'X01', 'P06', 'P07', 'P08', 'P09', 'P10',
  'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19', 'P20', 'P21',
  'P22', 'P23', 'P24', 'X02', 'X03', 'P25', 'P26',
];
const requiredSqeCases = ['mock:sqe:case:boot', 'mock:sqe:case:function'];

function harness(id = 'protocol-fixture') {
  const events = [];
  let seq = 0;
  const current = () => replayScenario({ id, events }, workflow, stateContract);
  function add(type, step_id, payload = {}, overrides = {}) {
    const result = current();
    const step = result.steps[step_id];
    const event = {
      event_id: `evt:${id}:${++seq}`,
      source_id: 'mock-protocol-source',
      source_seq: seq,
      type,
      mode: 'mock',
      job_id: result.job_id,
      step_id,
      cycle: result.cycle,
      attempt: step?.attempt ?? 1,
      execution_id: step?.execution_id ?? `mock:${step_id}:c${result.cycle}:a1`,
      payload,
      ...overrides,
    };
    events.push(event);
    return current();
  }
  return { id, events, current, add };
}

function measurementPayload(h, step_id, verdict, evidenceId) {
  const result = h.current();
  const step = result.steps[step_id];
  evidenceId ??= `mock:evidence:${step_id}:c${result.cycle}:a${step.attempt}`;
  return {
    evidence: {
      mode: 'mock', job_id: result.job_id, step_id, cycle: result.cycle,
      attempt: step.attempt, execution_id: step.execution_id,
      candidate_fingerprint: result.candidate_fingerprint, rule_version: result.rule_version,
      evidence_id: evidenceId, complete: true,
    },
    verdict,
  };
}

function taskId(step_id, cycle, attempt) {
  return `mock:task:${step_id}:c${cycle}${attempt === 1 ? '' : `:a${attempt}`}`;
}

function systemStep(h, step_id, verdict = 'PASS') {
  h.add('step', step_id, { state: 'READY' });
  h.add('step', step_id, { state: 'RUNNING' });
  h.add('measurement', step_id, measurementPayload(h, step_id, verdict));
  if (verdict === 'PASS') h.add('step', step_id, { state: 'SUCCEEDED' });
}

function humanTask(h, step_id, decision = 'approve') {
  h.add('step', step_id, { state: 'READY' });
  h.add('step', step_id, { state: 'RUNNING' });
  h.add('step', step_id, { state: 'WAITING_HUMAN' });
  h.add('human', step_id, {
    actor: 'mock:human', task_id: taskId(step_id, h.current().cycle, h.current().steps[step_id].attempt),
    plan_version: 'mock:plan:v1', evidence_id: `mock:evidence:${step_id}`,
    ...(decision === 'approve' ? {} : { decision }),
  });
  return h.current();
}

function manifestPayload(h) {
  const result = h.current();
  return {
    manifest_id: 'mock:manifest:v1', digest: 'mock:digest:v1',
    candidate_fingerprint: result.candidate_fingerprint, rule_version: result.rule_version,
    destination: 'mock:destination:v1', notes_hash: 'mock:notes:v1', evidence_bundle: 'mock:evidence-bundle:v1',
  };
}

function completeMockSqe(h, step_id, failCase = false) {
  const result = h.current();
  const step = result.steps.P22;
  const prefix = `mock:${h.id}:sqe:c${result.cycle}:a${step.attempt}`;
  const context = {
    actor: 'mock:sqe', candidate_fingerprint: result.candidate_fingerprint,
    profile_ref: mockSqeProfile.profile_ref, profile_version: mockSqeProfile.profile_version,
    script_version: mockSqeProfile.script_version, parser_version: mockSqeProfile.parser_version,
    rule_version: result.rule_version, device_id: `${prefix}:device`, bridge_id: `${prefix}:bridge`,
    image_hash: `${prefix}:image`, expected_image_identity: `${prefix}:boot`, evidence_id: `${prefix}:context`,
  };
  if (step_id === 'P22') {
    h.add('sqe_context', 'P22', context);
    h.add('sqe_result', 'P22', {
      actor: 'mock:sqe', execution_mode: 'bridge_mock', task_id: null, performer_id: 'mock:sqe',
      candidate_fingerprint: result.candidate_fingerprint,
      profile_ref: context.profile_ref, profile_version: context.profile_version,
      script_version: context.script_version, parser_version: context.parser_version,
      rule_version: result.rule_version, device_id: context.device_id, bridge_id: context.bridge_id,
      image_hash: context.image_hash, observed_device_id: context.device_id,
      observed_image_identity: context.expected_image_identity,
      started_at_ms: 1000, finished_at_ms: 2000, execution_status: 'completed', parser_status: 'complete',
      exit_code: failCase ? 1 : 0,
      cases: requiredSqeCases.map((case_id, index) => ({ case_id, outcome: failCase && index === 1 ? 'FAIL' : 'PASS' })),
      stdout_artifact_id: `${prefix}:stdout`, stderr_artifact_id: `${prefix}:stderr`,
      result_artifact_id: `${prefix}:result-artifact`, evidence_id: `${prefix}:result`,
    });
  } else {
    const p22 = result.steps.P22;
    h.add('sqe_report', 'P23', {
      actor: 'mock:sqe', candidate_fingerprint: result.candidate_fingerprint,
      result_evidence_id: p22.sqe_result.evidence_id, result_execution_id: p22.execution_id,
      profile_ref: mockSqeProfile.profile_ref, profile_version: mockSqeProfile.profile_version,
      report_artifact_id: `mock:${h.id}:sqe:report-artifact:c${result.cycle}`,
      report_link_id: `mock:${h.id}:sqe:report-link:c${result.cycle}`,
      evidence_id: `mock:${h.id}:sqe:report:c${result.cycle}`,
    });
  }
}

// Independent fixed P12 child proof. This deliberately spells out the six
// protocol observations instead of calling the product catalog enricher.
function completeMockChild(h) {
  const result = h.current();
  const step = result.steps.P12;
  const suffix = `c${result.cycle}:a${step.attempt}`;
  const parent = {
    coordinator_task_id: `mock:protocol:parent-task:${suffix}`,
    coordinator_execution_id: `mock:protocol:parent-exec:${suffix}`,
    candidate_fingerprint: result.candidate_fingerprint,
    requirements_version: result.requirements_version,
  };
  const child = {
    request_id: `mock:protocol:request:${suffix}`,
    child_task_id: `mock:protocol:task:${suffix}`,
    child_execution_id: `mock:protocol:child-exec:${suffix}`,
  };
  const proof = name => `mock:protocol:${name}:${suffix}`;
  const p11 = result.steps.P11;
  h.add('p12_coordinator', 'P12', {
    actor: 'mock:system', role: 'code-dev', purpose: 'p12_coordination', ...parent,
    p11_execution_id: p11.execution_id, code_artifact_id: `mock:protocol:code:${suffix}`,
    production_hash: `mock:protocol:production:${suffix}`, tc_design_artifact_id: `mock:protocol:design:${suffix}`,
    workspace_id: `mock:protocol:integration-ws:${suffix}`, write_scope: 'tests_integration_only',
    runtime_profile_ref: 'mock:runtime:code-dev-coordinator:v1', evidence_id: proof('coordinator-proof'),
  });
  h.add('child_request', 'P12', {
    actor: 'mock:code-dev', ...parent, request_id: child.request_id, child_task_id: child.child_task_id,
    ordinal: 1, child_role: 'tc',
    workspace_id: `mock:protocol:tc-ws:${suffix}`, write_scope: 'tests_only', runtime_profile_ref: 'mock:runtime:tc:v1',
    output_schema_ref: 'mock:schema:tc-patch:v1', code_artifact_id: `mock:protocol:code:${suffix}`,
    tc_design_artifact_id: `mock:protocol:design:${suffix}`, prior_child_execution_id: null,
    checkpoint_artifact_id: null, answer_evidence_id: null, answer_artifact_id: null, evidence_id: proof('request-proof'),
  });
  h.add('child_assignment', 'P12', {
    actor: 'mock:system', ...parent, ...child, workspace_id: `mock:protocol:tc-ws:${suffix}`,
    evidence_id: proof('assignment-proof'),
  });
  h.add('child_result', 'P12', {
    actor: 'mock:tc', ...parent, ...child, workspace_id: `mock:protocol:tc-ws:${suffix}`,
    status: 'completed', output_schema_ref: 'mock:schema:tc-patch:v1', patch_artifact_id: `mock:protocol:patch:${suffix}`,
    changed_path_refs: ['mock:path:tests:unit'], production_hash: `mock:protocol:production:${suffix}`,
    question_id: null, checkpoint_artifact_id: null, failure_class: null, started_at_ms: 1000, finished_at_ms: 2000,
    evidence_id: proof('result-proof'),
  });
  h.add('child_collect', 'P12', {
    actor: 'mock:code-dev', ...parent, child_execution_id: child.child_execution_id,
    result_evidence_id: proof('result-proof'), evidence_id: proof('collect-proof'),
  });
  h.add('child_integrated', 'P12', {
    actor: 'mock:code-dev', ...parent, child_execution_id: child.child_execution_id,
    result_evidence_id: proof('result-proof'), patch_artifact_id: `mock:protocol:patch:${suffix}`,
    production_hash_before: `mock:protocol:production:${suffix}`, production_hash_after: `mock:protocol:production:${suffix}`,
    changed_path_refs: ['mock:path:tests:unit'], expectations_changed: false, outcome: 'integrated',
    integration_artifact_id: `mock:protocol:integration:${suffix}`, evidence_id: proof('integrated-proof'),
  });
}

function runStep(h, step_id, { sqeFail = false } = {}) {
  const node = workflow.nodes.find(item => item.id === step_id);
  if (node.owner === 'system' && !['P22', 'P23'].includes(step_id)) return systemStep(h, step_id);
  if (node.owner === 'human') {
    if (step_id === 'X03') {
      h.add('step', step_id, { state: 'READY' });
      h.add('step', step_id, { state: 'RUNNING' });
      h.add('step', step_id, { state: 'WAITING_HUMAN' });
      const result = h.current();
      const manifest = result.release.manifest;
      h.add('approval', step_id, {
        actor: 'mock:human', task_id: taskId('X03', result.cycle, result.steps.X03.attempt),
        plan_version: 'mock:plan:v1', evidence_id: 'mock:evidence:approval',
        manifest_id: manifest.manifest_id, digest: manifest.digest,
        candidate_fingerprint: manifest.candidate_fingerprint, decision: 'approve',
      });
      return h.add('step', step_id, { state: 'SUCCEEDED' });
    }
    humanTask(h, step_id);
    return h.add('step', step_id, { state: 'SUCCEEDED' });
  }
  h.add('step', step_id, { state: 'READY' });
  h.add('step', step_id, { state: 'RUNNING' });
  if (step_id === 'P12') completeMockChild(h);
  if (step_id === 'P22' || step_id === 'P23') completeMockSqe(h, step_id, sqeFail);
  if (step_id === 'X02') h.add('manifest', step_id, manifestPayload(h));
  if (step_id === 'P25') {
    const result = h.current();
    const manifest = result.release.manifest;
    h.add('receipt', step_id, {
      manifest_id: manifest.manifest_id, digest: manifest.digest,
      candidate_fingerprint: manifest.candidate_fingerprint,
      receipt_id: 'mock:receipt:v1', observed: true,
    });
  }
  const completed = h.add('step', step_id, { state: 'SUCCEEDED' });
  if (step_id === 'P12' && completed.steps.P12.state !== 'SUCCEEDED') {
    throw new Error(`P12 fixture completion rejected: ${JSON.stringify(completed.timeline.slice(-8))}`);
  }
  return completed;
}

function advanceTo(h, target, runOptions = {}) {
  const current = h.current().current_step;
  const start = Math.max(0, nodeOrder.indexOf(current));
  for (const step_id of nodeOrder.slice(start)) {
    if (step_id === 'END') break;
    if (step_id === target) return h.current();
    runStep(h, step_id, runOptions);
  }
  throw new Error(`Fixture builder did not reach ${target}`);
}

function driveFailure(h, routeCase) {
  const { from, decision, outcome } = routeCase;
  advanceTo(h, from, { sqeFail: from === 'P24' });
  if (from === 'P13' || from === 'P14') {
    h.add('step', from, { state: 'READY' });
    h.add('step', from, { state: 'RUNNING' });
  } else if (['P16', 'P18', 'P20', 'P24'].includes(from)) {
    h.add('step', from, { state: 'READY' });
    h.add('step', from, { state: 'RUNNING' });
    h.add('measurement', from, measurementPayload(h, from, 'FAIL', `mock:failure:${from}`));
  } else if (from === 'X03') {
    h.add('step', from, { state: 'READY' });
    h.add('step', from, { state: 'RUNNING' });
    h.add('step', from, { state: 'WAITING_HUMAN' });
    const result = h.current();
    const manifest = result.release.manifest;
    h.add('approval', from, {
      actor: 'mock:human', task_id: taskId('X03', result.cycle, result.steps.X03.attempt),
      plan_version: 'mock:plan:v1', evidence_id: `mock:negative:${outcome}`,
      manifest_id: manifest.manifest_id, digest: manifest.digest,
      candidate_fingerprint: manifest.candidate_fingerprint, decision: outcome,
    });
  } else {
    humanTask(h, from, decision);
  }
  h.add('business_failure', from, {
    candidate_fingerprint: h.current().candidate_fingerprint,
    evidence_id: from === 'P16' || from === 'P18' || from === 'P20' || from === 'P24'
      ? `mock:failure:${from}` : from === 'X03' ? `mock:negative:${outcome}` : `mock:evidence:${from}`,
  });
}

test('literal business-failure and node-rejection route oracle creates immutable new cycles', () => {
  for (const [index, routeCase] of routeCases.entries()) {
    const h = harness(`route-${index + 1}`);
    driveFailure(h, routeCase);
    const failed = h.current();
    assert.equal(failed.steps[routeCase.from].state, 'FAILED', `${routeCase.from} business failure recorded`);
    if (routeCase.decision || routeCase.from === 'X03') {
      if (routeCase.from === 'X03') assert.equal(failed.release.approved, false);
      const falseSuccess = h.add('step', routeCase.from, { state: 'SUCCEEDED' });
      assert.equal(falseSuccess.steps[routeCase.from].state, 'FAILED', 'negative human decision cannot complete the node');
      assert.equal(falseSuccess.timeline.at(-1).applied, false);
    }
    const route = h.add('route', routeCase.from, {
      outcome: routeCase.outcome, target: routeCase.target,
      candidate_fingerprint: failed.candidate_fingerprint,
      evidence_id: failed.steps[routeCase.from].failure_evidence_id,
    });

    const metadataOnly = routeCase.outcome === 'reject_release_metadata';
    assert.equal(route.cycle, metadataOnly ? 1 : 2, `${routeCase.from}/${routeCase.outcome} cycle`);
    assert.equal(route.rework_count, 1);
    assert.equal(route.current_step, routeCase.target);
    assert.equal(route.status, 'RUNNING');
    assert.equal(route.steps[routeCase.target].state, 'PENDING');
    assert.equal(route.steps[routeCase.target].attempt, metadataOnly ? 2 : 1);
    assert.equal(route.steps[routeCase.target].execution_id, metadataOnly
      ? `mock:X02:c1:a2` : `mock:${routeCase.target}:c2:a1`);
    if (metadataOnly) {
      for (const id of ['P16', 'P18', 'P20', 'P24']) {
        assert.equal(route.steps[id].state, 'SUCCEEDED', `${id} quality result remains in the same cycle`);
        assert.equal(route.steps[id].cycle, 1);
      }
      assert.equal(route.steps.P25.state, 'PENDING');
      assert.equal(route.steps.P26.state, 'PENDING');
      assert.deepEqual(route.required_revalidation, ['X02', 'X03', 'P25', 'P26']);
      assert.equal(route.history.length, 3);
      assert.equal(route.history[0].kind, 'release_metadata');
      assert.equal(route.history[0].cycle, 1);
      assert.equal(route.history[0].release.manifest.manifest_id, failed.release.manifest.manifest_id);
      assert.deepEqual(route.history.slice(1).map(row => [row.kind, row.step_id]), [['attempt', 'X02'], ['attempt', 'X03']]);
    } else {
      assert.ok(Object.values(route.steps).every(step => step.state === 'PENDING'));
      assert.deepEqual(route.required_revalidation, nodeOrder.slice(nodeOrder.indexOf(routeCase.target)));
      assert.equal(route.history.length, 1);
      assert.equal(route.history[0].kind, 'cycle');
      assert.equal(route.history[0].cycle, 1);
      assert.equal(route.history[0].steps[routeCase.from].state, 'FAILED');
      assert.equal(route.history[0].steps[routeCase.from].failure_evidence_id, failed.steps[routeCase.from].failure_evidence_id);
    }
    if (routeCase.from === 'P24') {
      assert.equal(route.history[0].steps.P22.state, 'SUCCEEDED', 'SQE result collection precedes report publication');
      assert.equal(route.history[0].steps.P23.state, 'SUCCEEDED', 'SQE report is visible before the P24 gate failure');
    }
    assert.equal(route.real_publish_allowed, false);
    const staleRoute = h.add('route', routeCase.from, {
      outcome: routeCase.outcome, target: routeCase.target,
      candidate_fingerprint: failed.candidate_fingerprint,
      evidence_id: failed.steps[routeCase.from].failure_evidence_id,
    }, { cycle: 1, attempt: 1, execution_id: `mock:${routeCase.from}:c1:a1` });
    assert.equal(staleRoute.cycle, metadataOnly ? 1 : 2);
    assert.equal(staleRoute.current_step, routeCase.target);
    assert.equal(staleRoute.timeline.at(-1).applied, false);
  }
});

test('route cannot reinterpret failure evidence or choose a non-oracle target', () => {
  const h = harness('route-reject');
  const routeCase = routeCases[0];
  driveFailure(h, routeCase);
  const before = h.current();
  const invalidRoutes = [
    { outcome: routeCase.outcome, target: 'P07', candidate_fingerprint: before.candidate_fingerprint, evidence_id: before.steps[routeCase.from].failure_evidence_id },
    { outcome: routeCase.outcome, target: routeCase.target, candidate_fingerprint: before.candidate_fingerprint, evidence_id: 'mock:wrong-evidence' },
    { outcome: routeCase.outcome, target: routeCase.target, candidate_fingerprint: 'mock:candidate:stale', evidence_id: before.steps[routeCase.from].failure_evidence_id },
    { outcome: 'reject_code', target: 'P11', candidate_fingerprint: before.candidate_fingerprint, evidence_id: before.steps[routeCase.from].failure_evidence_id },
    { outcome: 'P03.unresolved', target: 'WAITING_HUMAN', candidate_fingerprint: before.candidate_fingerprint, evidence_id: before.steps[routeCase.from].failure_evidence_id },
    { outcome: 'P25.unknown_remote_state', target: 'RECONCILING', candidate_fingerprint: before.candidate_fingerprint, evidence_id: before.steps[routeCase.from].failure_evidence_id },
  ];
  for (const payload of invalidRoutes) {
    const rejected = h.add('route', routeCase.from, payload);
    assert.equal(rejected.cycle, 1);
    assert.equal(rejected.current_step, routeCase.from);
    assert.equal(rejected.steps[routeCase.from].state, 'FAILED');
    assert.equal(rejected.timeline.at(-1).applied, false);
  }
});

test('three additional rework cycles are allowed and the next return waits for a human', () => {
  const h = harness('rework-ceiling');
  driveFailure(h, routeCases[0]);
  const routeCurrentFailure = () => {
    const failed = h.current();
    return h.add('route', 'P13', {
      outcome: 'business_fail', target: 'P11',
      candidate_fingerprint: failed.candidate_fingerprint,
      evidence_id: failed.steps.P13.failure_evidence_id,
    });
  };
  const cycle2 = routeCurrentFailure();
  assert.equal(cycle2.cycle, 2);
  const failP13Again = cycle => {
    runStep(h, 'P11');
    runStep(h, 'P12');
    h.add('step', 'P13', { state: 'READY' });
    h.add('step', 'P13', { state: 'RUNNING' });
    h.add('business_failure', 'P13', {
      candidate_fingerprint: h.current().candidate_fingerprint,
      evidence_id: `mock:failure:P13:c${cycle}`,
    });
  };
  failP13Again(2);
  const cycle3 = routeCurrentFailure();
  assert.equal(cycle3.cycle, 3);
  assert.equal(cycle3.rework_count, 2);
  failP13Again(3);
  const cycle4 = routeCurrentFailure();
  assert.equal(cycle4.cycle, 4);
  assert.equal(cycle4.rework_count, 3);
  failP13Again(4);
  const capped = routeCurrentFailure();
  assert.equal(capped.cycle, 4);
  assert.equal(capped.rework_count, 3);
  assert.equal(capped.status, 'WAITING_HUMAN');
  assert.ok(capped.failure_bundle.some(item => item.step_id === 'P13' && item.cycle === 4));
});

test('only the three allowed infrastructure attempts are created at exact 10s and 30s boundaries', () => {
  const h = harness('infra-retries');
  advanceTo(h, 'P11');
  h.add('step', 'P11', { state: 'READY' });
  h.add('step', 'P11', { state: 'RUNNING' });
  let result = h.add('infra_error', 'P11', { now_ms: 1_000, operation: 'build' });
  assert.equal(result.steps.P11.state, 'WAITING_RETRY');
  assert.equal(result.steps.P11.retry_due_ms, 11_000);
  assert.equal(result.steps.P11.gate_verdict, null);
  assert.equal(result.steps.P11.infrastructure_error, true);
  const tooEarly = h.add('retry', 'P11', { now_ms: 10_999 });
  assert.equal(tooEarly.steps.P11.attempt, 1);
  assert.equal(tooEarly.steps.P11.state, 'WAITING_RETRY');
  result = h.add('retry', 'P11', { now_ms: 11_000 });
  assert.equal(result.steps.P11.attempt, 2);
  assert.equal(result.steps.P11.state, 'READY');
  assert.equal(result.steps.P11.execution_id, 'mock:P11:c1:a2');
  assert.equal(result.history.at(-1).kind, 'attempt');
  assert.equal(result.history.at(-1).step.state, 'WAITING_RETRY');
  const staleAttempt = h.add('step', 'P11', { state: 'READY' }, { attempt: 1, execution_id: 'mock:P11:c1:a1' });
  assert.equal(staleAttempt.steps.P11.attempt, 2);
  assert.equal(staleAttempt.steps.P11.state, 'READY');
  assert.equal(staleAttempt.timeline.at(-1).applied, false);

  h.add('step', 'P11', { state: 'RUNNING' });
  result = h.add('infra_error', 'P11', { now_ms: 11_001, operation: 'build' });
  assert.equal(result.steps.P11.retry_due_ms, 41_001);
  assert.equal(result.steps.P11.state, 'WAITING_RETRY');
  const beforeDue = h.add('retry', 'P11', { now_ms: 41_000 });
  assert.equal(beforeDue.steps.P11.attempt, 2);
  result = h.add('retry', 'P11', { now_ms: 41_001 });
  assert.equal(result.steps.P11.attempt, 3);
  assert.equal(result.steps.P11.state, 'READY');
  h.add('step', 'P11', { state: 'RUNNING' });
  result = h.add('infra_error', 'P11', { now_ms: 41_002, operation: 'build' });
  assert.equal(result.steps.P11.attempt, 3);
  assert.equal(result.steps.P11.state, 'WAITING_HUMAN');
  assert.equal(result.steps.P11.retry_due_ms, null);
  assert.equal(result.steps.P11.gate_verdict, null);
  assert.equal(result.timeline.some(row => row.applied && row.type === 'retry' && row.step_id === 'P11'), true);

  const plusOne = harness('retry-plus-one-boundaries');
  advanceTo(plusOne, 'P11');
  plusOne.add('step', 'P11', { state: 'READY' });
  plusOne.add('step', 'P11', { state: 'RUNNING' });
  plusOne.add('infra_error', 'P11', { now_ms: 1_000, operation: 'agent' });
  result = plusOne.add('retry', 'P11', { now_ms: 11_001 });
  assert.equal(result.steps.P11.attempt, 2);
  plusOne.add('step', 'P11', { state: 'RUNNING' });
  plusOne.add('infra_error', 'P11', { now_ms: 11_002, operation: 'agent' });
  result = plusOne.add('retry', 'P11', { now_ms: 41_003 });
  assert.equal(result.steps.P11.attempt, 3);
  assert.equal(result.steps.P11.execution_id, 'mock:P11:c1:a3');
});

test('unsafe infra operations, invalid clocks, non-monotonic clocks and fourth attempts fail closed', () => {
  for (const operation of ['flash', 'remote_push', 'create_pr', 'create_tag', 'release_publish', 'shell']) {
    const h = harness(`unsafe-${operation}`);
    advanceTo(h, 'P11');
    h.add('step', 'P11', { state: 'READY' });
    h.add('step', 'P11', { state: 'RUNNING' });
    const result = h.add('infra_error', 'P11', { now_ms: 100, operation });
    assert.equal(result.steps.P11.state, 'RUNNING', operation);
    assert.equal(result.timeline.at(-1).applied, false, operation);
  }

  const invalidClock = harness('invalid-infra-clock');
  advanceTo(invalidClock, 'P11');
  invalidClock.add('step', 'P11', { state: 'READY' });
  invalidClock.add('step', 'P11', { state: 'RUNNING' });
  for (const now_ms of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = invalidClock.add('infra_error', 'P11', { now_ms, operation: 'build' });
    assert.equal(invalid.steps.P11.state, 'RUNNING');
    assert.equal(invalid.timeline.at(-1).applied, false);
  }

  const monotonic = harness('nonmonotonic-infra-clock');
  advanceTo(monotonic, 'P11');
  monotonic.add('step', 'P11', { state: 'READY' });
  monotonic.add('step', 'P11', { state: 'RUNNING' });
  monotonic.add('infra_error', 'P11', { now_ms: 10_000, operation: 'agent' });
  monotonic.add('retry', 'P11', { now_ms: 20_000 });
  monotonic.add('step', 'P11', { state: 'RUNNING' });
  const backward = monotonic.add('infra_error', 'P11', { now_ms: 19_999, operation: 'agent' });
  assert.equal(backward.steps.P11.attempt, 2);
  assert.equal(backward.steps.P11.state, 'RUNNING');
  assert.equal(backward.timeline.at(-1).applied, false);
});

test('manifest IDs and digests remain bound to a single immutable mock manifest observation', () => {
  const h = harness('manifest-binding');
  advanceTo(h, 'X02');
  assert.equal(h.current().current_step, 'X02', `fresh recovery reached X02; tail=${JSON.stringify(h.current().timeline.slice(-8))}`);
  h.add('step', 'X02', { state: 'READY' });
  h.add('step', 'X02', { state: 'RUNNING' });
  const manifest = manifestPayload(h);
  let result = h.add('manifest', 'X02', { ...manifest, candidate_fingerprint: 'mock:candidate:stale' });
  assert.equal(result.timeline.at(-1).applied, false);
  assert.equal(result.release.manifest, null);
  result = h.add('manifest', 'X02', { ...manifest, rule_version: 'mock:rules:stale' });
  assert.equal(result.timeline.at(-1).applied, false);
  assert.equal(result.release.manifest, null);
  result = h.add('manifest', 'X02', manifest);
  assert.equal(result.release.manifest.manifest_id, manifest.manifest_id);
  assert.equal(result.release.manifest.digest, manifest.digest);
  const original = structuredClone(result.release.manifest);
  result = h.add('manifest', 'X02', { ...manifest, notes_hash: 'mock:notes:changed' });
  assert.equal(result.timeline.at(-1).applied, false);
  assert.deepEqual(result.release.manifest, original);
  result = h.add('manifest', 'X02', { ...manifest, manifest_id: 'mock:manifest:other' });
  assert.equal(result.timeline.at(-1).applied, false);
  assert.deepEqual(result.release.manifest, original);
});

test('X03 requires current manifest-bound approval and P25 requires a unique matching receipt', () => {
  const h = harness('approval-and-receipt');
  advanceTo(h, 'X03');
  h.add('step', 'X03', { state: 'READY' });
  h.add('step', 'X03', { state: 'RUNNING' });
  h.add('step', 'X03', { state: 'WAITING_HUMAN' });
  const resultAtX03 = h.current();
  const manifest = resultAtX03.release.manifest;
  const approval = {
    actor: 'mock:human', task_id: `mock:task:X03:c${resultAtX03.cycle}`,
    plan_version: 'mock:plan:v1', evidence_id: 'mock:approval:evidence',
    manifest_id: manifest.manifest_id, digest: manifest.digest,
    candidate_fingerprint: manifest.candidate_fingerprint, decision: 'approve',
  };
  let result = h.add('human', 'X03', {
    actor: 'mock:human', task_id: approval.task_id, plan_version: approval.plan_version,
    evidence_id: 'mock:generic-human',
  });
  assert.equal(result.timeline.at(-1).applied, false);
  result = h.add('step', 'X03', { state: 'SUCCEEDED' });
  assert.equal(result.steps.X03.state, 'WAITING_HUMAN');
  assert.equal(result.timeline.at(-1).applied, false);

  result = h.add('approval', 'X03', { ...approval, digest: 'mock:digest:stale' });
  assert.equal(result.timeline.at(-1).applied, false);
  assert.equal(result.release.approved, false);
  result = h.add('approval', 'X03', { ...approval, candidate_fingerprint: 'mock:candidate:stale' });
  assert.equal(result.timeline.at(-1).applied, false);
  assert.equal(result.release.approved, false);
  result = h.add('approval', 'X03', { ...approval, manifest_id: 'mock:manifest:stale' });
  assert.equal(result.timeline.at(-1).applied, false);
  assert.equal(result.release.approved, false);
  result = h.add('approval', 'X03', approval);
  assert.equal(result.release.approved, true);
  result = h.add('step', 'X03', { state: 'SUCCEEDED' });
  assert.equal(result.current_step, 'P25');

  h.add('step', 'P25', { state: 'READY' });
  h.add('step', 'P25', { state: 'RUNNING' });
  const validReceipt = {
    manifest_id: manifest.manifest_id, digest: manifest.digest,
    candidate_fingerprint: manifest.candidate_fingerprint,
    receipt_id: 'mock:receipt:unique', observed: true,
  };
  result = h.add('receipt', 'P25', { ...validReceipt, digest: 'mock:digest:stale' });
  assert.equal(result.timeline.at(-1).applied, false);
  assert.equal(result.release.receipt_id, null);
  result = h.add('receipt', 'P25', { ...validReceipt, observed: false });
  assert.equal(result.timeline.at(-1).applied, false);
  assert.equal(result.release.receipt_id, null);
  result = h.add('receipt', 'P25', { ...validReceipt, manifest_id: 'mock:manifest:stale' });
  assert.equal(result.timeline.at(-1).applied, false);
  assert.equal(result.release.receipt_id, null);
  h.add('agent', 'P25', { status: 'completed' });
  result = h.add('step', 'P25', { state: 'SUCCEEDED' });
  assert.equal(result.steps.P25.state, 'RUNNING');
  assert.equal(result.timeline.at(-1).applied, false);
  result = h.add('receipt', 'P25', validReceipt);
  assert.equal(result.release.receipt_id, validReceipt.receipt_id);
  const receiptSnapshot = structuredClone(result.release);
  result = h.add('receipt', 'P25', { ...validReceipt, receipt_id: 'mock:receipt:duplicate' });
  assert.equal(result.timeline.at(-1).applied, false);
  assert.deepEqual(result.release, receiptSnapshot);
  result = h.add('step', 'P25', { state: 'SUCCEEDED' });
  assert.equal(result.current_step, 'P26');
  assert.equal(result.release.publication_count, 1);
  assert.equal(result.release.receipt_id, validReceipt.receipt_id);
  assert.equal(result.real_publish_allowed, false);
});

test('candidate B invalidates prior-cycle release binding and candidate A evidence cannot pass its gate', () => {
  const h = harness('candidate-binding');
  const reject = routeCases.find(item => item.from === 'X03' && item.outcome === 'reject_code');
  driveFailure(h, reject);
  const beforeRoute = h.current();
  assert.equal(beforeRoute.release.manifest.candidate_fingerprint, 'mock:candidate:A');
  const cycle2 = h.add('route', 'X03', {
    outcome: reject.outcome, target: reject.target,
    candidate_fingerprint: beforeRoute.candidate_fingerprint,
    evidence_id: beforeRoute.steps.X03.failure_evidence_id,
  });
  assert.equal(cycle2.cycle, 2);
  assert.equal(cycle2.release.manifest, null);
  assert.equal(cycle2.release.approved, false);
  const staleApproval = h.add('approval', 'X03', {
    actor: 'mock:human', task_id: 'mock:task:X03:c1', plan_version: 'mock:plan:v1',
    evidence_id: 'mock:stale:approval', manifest_id: 'mock:manifest:v1',
    digest: 'mock:digest:v1', candidate_fingerprint: 'mock:candidate:A', decision: 'approve',
  }, { cycle: 1, attempt: 1, execution_id: 'mock:X03:c1:a1' });
  assert.equal(staleApproval.release.approved, false);
  assert.equal(staleApproval.timeline.at(-1).applied, false);

  runStep(h, 'P11');
  runStep(h, 'P12');
  h.add('step', 'P13', { state: 'READY' });
  h.add('step', 'P13', { state: 'RUNNING' });
  const candidateB = h.add('candidate', 'P13', { candidate_fingerprint: 'mock:candidate:B' });
  assert.equal(candidateB.candidate_fingerprint, 'mock:candidate:B');
  h.add('step', 'P13', { state: 'SUCCEEDED' });
  runStep(h, 'P14');
  runStep(h, 'P15');
  h.add('step', 'P16', { state: 'READY' });
  h.add('step', 'P16', { state: 'RUNNING' });
  const oldEvidence = measurementPayload(h, 'P16', 'PASS');
  oldEvidence.evidence.candidate_fingerprint = 'mock:candidate:A';
  let result = h.add('measurement', 'P16', oldEvidence);
  assert.equal(result.timeline.at(-1).applied, false);
  assert.equal(result.steps.P16.gate_verdict, null);
  result = h.add('step', 'P16', { state: 'SUCCEEDED' });
  assert.equal(result.steps.P16.state, 'RUNNING');
  assert.equal(result.timeline.at(-1).applied, false);
  result = h.add('measurement', 'P16', measurementPayload(h, 'P16', 'PASS'));
  assert.equal(result.steps.P16.gate_verdict, 'PASS');
  result = h.add('step', 'P16', { state: 'SUCCEEDED' });
  assert.equal(result.steps.P16.state, 'SUCCEEDED');
  assert.equal(result.current_step, 'P17');
});

test('manifest observation cannot be reused across cycles even when candidate and visible tuple are unchanged', () => {
  const h = harness('cross-cycle-manifest-binding');
  const reject = routeCases.find(item => item.from === 'X03' && item.outcome === 'reject_code');
  driveFailure(h, reject);
  let beforeRoute = h.current();
  const oldManifest = structuredClone(beforeRoute.release.manifest);
  const cycle2 = h.add('route', 'X03', {
    outcome: reject.outcome, target: reject.target,
    candidate_fingerprint: beforeRoute.candidate_fingerprint,
    evidence_id: beforeRoute.steps.X03.failure_evidence_id,
  });
  assert.equal(cycle2.cycle, 2);
  assert.equal(cycle2.candidate_fingerprint, 'mock:candidate:A');
  assert.equal(cycle2.release.manifest, null);

  advanceTo(h, 'X02');
  assert.equal(h.current().current_step, 'X02', `fresh recovery reached X02; tail=${JSON.stringify(h.current().timeline.slice(-8))}`);
  h.add('step', 'X02', { state: 'READY' });
  h.add('step', 'X02', { state: 'RUNNING' });
  const reusedOldObservation = h.add('manifest', 'X02', {
    manifest_id: oldManifest.manifest_id,
    digest: oldManifest.digest,
    candidate_fingerprint: oldManifest.candidate_fingerprint,
    rule_version: oldManifest.rule_version,
    destination: oldManifest.destination,
    notes_hash: oldManifest.notes_hash,
    evidence_bundle: oldManifest.evidence_bundle,
  });
  assert.equal(reusedOldObservation.timeline.at(-1).applied, false);
  assert.equal(reusedOldObservation.timeline.at(-1).reason, 'manifest_binding_conflict');
  assert.equal(reusedOldObservation.release.manifest, null);

  const freshObservation = h.add('manifest', 'X02', {
    manifest_id: 'mock:manifest:c2-fresh',
    digest: 'mock:digest:c2-fresh',
    candidate_fingerprint: reusedOldObservation.candidate_fingerprint,
    rule_version: reusedOldObservation.rule_version,
    destination: oldManifest.destination,
    notes_hash: oldManifest.notes_hash,
    evidence_bundle: 'mock:evidence-bundle:c2-fresh',
  });
  assert.equal(freshObservation.timeline.at(-1).applied, true);
  assert.equal(freshObservation.release.manifest.manifest_id, 'mock:manifest:c2-fresh');
  assert.equal(freshObservation.release.manifest.digest, 'mock:digest:c2-fresh');
});

test('release-metadata rejection can resume X02 without fabricating a new quality-gate run', () => {
  const h = harness('release-metadata-recovery-deadend');
  const reject = routeCases.find(item => item.from === 'X03' && item.outcome === 'reject_release_metadata');
  driveFailure(h, reject);
  const failedCycle = h.current();
  const gateProof = Object.fromEntries(['P16', 'P18', 'P20', 'P24'].map(id => [id, {
    state: failedCycle.steps[id].state,
    gate_evidence_id: failedCycle.steps[id].gate_evidence_id,
    gate_candidate_fingerprint: failedCycle.steps[id].gate_candidate_fingerprint,
    gate_rule_version: failedCycle.steps[id].gate_rule_version,
  }]));
  const oldManifest = structuredClone(failedCycle.release.manifest);
  const priorCandidate = failedCycle.candidate_fingerprint;
  const priorRule = failedCycle.rule_version;
  const cycle2 = h.add('route', 'X03', {
    outcome: reject.outcome, target: reject.target,
    candidate_fingerprint: failedCycle.candidate_fingerprint,
    evidence_id: failedCycle.steps.X03.failure_evidence_id,
  });
  assert.equal(cycle2.cycle, 1, 'metadata correction remains in the same business cycle');
  assert.equal(cycle2.rework_count, 1);
  assert.equal(cycle2.current_step, 'X02');
  assert.equal(cycle2.candidate_fingerprint, priorCandidate);
  assert.equal(cycle2.rule_version, priorRule);
  for (const [id, proof] of Object.entries(gateProof)) assert.deepEqual({
    state: cycle2.steps[id].state,
    gate_evidence_id: cycle2.steps[id].gate_evidence_id,
    gate_candidate_fingerprint: cycle2.steps[id].gate_candidate_fingerprint,
    gate_rule_version: cycle2.steps[id].gate_rule_version,
  }, proof, `${id} gate proof is preserved exactly`);
  assert.equal(cycle2.steps.X02.attempt, 2);
  assert.equal(cycle2.steps.X03.attempt, 2);
  assert.equal(cycle2.steps.X02.execution_id, 'mock:X02:c1:a2');
  assert.equal(cycle2.steps.X03.execution_id, 'mock:X03:c1:a2');
  assert.equal(cycle2.steps.P25.state, 'PENDING');
  assert.equal(cycle2.steps.P26.state, 'PENDING');
  assert.deepEqual(cycle2.required_revalidation, ['X02', 'X03', 'P25', 'P26']);
  assert.equal(cycle2.release.manifest, null);
  assert.equal(cycle2.release.approved, false);
  assert.equal(cycle2.release.publication_count, 0);
  assert.deepEqual(cycle2.history.map(row => row.kind), ['release_metadata', 'attempt', 'attempt']);
  assert.equal(cycle2.history[0].release.manifest.manifest_id, oldManifest.manifest_id);
  assert.equal(cycle2.history[1].step.execution_id, 'mock:X02:c1:a1');
  assert.equal(cycle2.history[1].step.state, 'SUCCEEDED');
  assert.equal(cycle2.history[2].step.execution_id, 'mock:X03:c1:a1');
  assert.equal(cycle2.history[2].step.state, 'FAILED');

  h.add('step', 'X02', { state: 'READY' });
  h.add('step', 'X02', { state: 'RUNNING' });
  const reusedManifest = h.add('manifest', 'X02', {
    ...manifestPayload(h), manifest_id: oldManifest.manifest_id, digest: oldManifest.digest,
    candidate_fingerprint: oldManifest.candidate_fingerprint, rule_version: oldManifest.rule_version,
    destination: oldManifest.destination, notes_hash: oldManifest.notes_hash, evidence_bundle: oldManifest.evidence_bundle,
  });
  assert.equal(reusedManifest.timeline.at(-1).applied, false);
  assert.equal(reusedManifest.timeline.at(-1).reason, 'manifest_binding_conflict');
  assert.equal(reusedManifest.release.manifest, null);

  const freshManifest = {
    ...manifestPayload(h), manifest_id: 'mock:manifest:metadata-fixed',
    digest: 'mock:digest:metadata-fixed', evidence_bundle: 'mock:evidence-bundle:metadata-fixed',
  };
  let result = h.add('manifest', 'X02', freshManifest);
  assert.equal(result.timeline.at(-1).applied, true);
  assert.equal(result.steps.P16.gate_evidence_id, gateProof.P16.gate_evidence_id);
  assert.equal(h.add('step', 'X02', { state: 'SUCCEEDED' }).current_step, 'X03');
  h.add('step', 'X03', { state: 'READY' });
  h.add('step', 'X03', { state: 'RUNNING' });
  h.add('step', 'X03', { state: 'WAITING_HUMAN' });
  const oldTaskApproval = h.add('approval', 'X03', {
    actor: 'mock:human', task_id: taskId('X03', 1, 1), plan_version: 'mock:plan:v1',
    evidence_id: 'mock:old-task-approval', manifest_id: freshManifest.manifest_id,
    digest: freshManifest.digest, candidate_fingerprint: priorCandidate, decision: 'approve',
  });
  assert.equal(oldTaskApproval.timeline.at(-1).applied, false);
  assert.equal(oldTaskApproval.release.approved, false);
  result = h.add('approval', 'X03', {
    actor: 'mock:human', task_id: taskId('X03', 1, 2), plan_version: 'mock:plan:v1',
    evidence_id: 'mock:current-task-approval', manifest_id: freshManifest.manifest_id,
    digest: freshManifest.digest, candidate_fingerprint: priorCandidate, decision: 'approve',
  });
  assert.equal(result.timeline.at(-1).applied, true);
  assert.equal(h.add('step', 'X03', { state: 'SUCCEEDED' }).current_step, 'P25');
  runStep(h, 'P25');
  runStep(h, 'P26');
  result = h.current();
  assert.equal(result.current_step, 'END');
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.release.publication_count, 1);
  assert.equal(result.steps.P26.state, 'SUCCEEDED');
  for (const [id, proof] of Object.entries(gateProof)) assert.deepEqual({
    state: result.steps[id].state,
    gate_evidence_id: result.steps[id].gate_evidence_id,
    gate_candidate_fingerprint: result.steps[id].gate_candidate_fingerprint,
    gate_rule_version: result.steps[id].gate_rule_version,
  }, proof, `${id} gate evidence remains unchanged through release recovery`);
});

test('human submission is bound to the current attempt and cleared on infrastructure retry', () => {
  const h = harness('human-attempt-binding');
  advanceTo(h, 'P06');
  humanTask(h, 'P06');
  const firstAttempt = h.current().steps.P06;
  assert.equal(firstAttempt.attempt, 1);
  assert.equal(h.add('step', 'P06', { state: 'READY' }).steps.P06.state, 'READY');
  h.add('step', 'P06', { state: 'RUNNING' });
  let result = h.add('infra_error', 'P06', { now_ms: 1000, operation: 'agent' });
  assert.equal(result.steps.P06.state, 'WAITING_RETRY');
  assert.equal(result.steps.P06.retry_due_ms, 11_000);
  result = h.add('retry', 'P06', { now_ms: 11_000 });
  assert.equal(result.steps.P06.attempt, 2);
  assert.equal(result.steps.P06.execution_id, 'mock:P06:c1:a2');
  assert.equal(result.steps.P06.state, 'READY');
  h.add('step', 'P06', { state: 'RUNNING' });
  h.add('step', 'P06', { state: 'WAITING_HUMAN' });
  result = h.add('step', 'P06', { state: 'SUCCEEDED' });
  assert.equal(result.steps.P06.state, 'WAITING_HUMAN');
  assert.equal(result.timeline.at(-1).reason, 'human_submission_required');

  const oldTask = h.add('human', 'P06', {
    actor: 'mock:human', task_id: taskId('P06', 1, 1), plan_version: 'mock:plan:v1', evidence_id: 'mock:old-proof',
  });
  assert.equal(oldTask.timeline.at(-1).applied, false);
  assert.equal(oldTask.timeline.at(-1).reason, 'invalid_human_submission');
  const newTask = h.add('human', 'P06', {
    actor: 'mock:human', task_id: taskId('P06', 1, 2), plan_version: 'mock:plan:v1', evidence_id: 'mock:attempt-2-proof',
  });
  assert.equal(newTask.timeline.at(-1).applied, true);
  assert.equal(h.add('step', 'P06', { state: 'SUCCEEDED' }).current_step, 'P07');
  assert.equal(h.current().history.some(row => row.kind === 'attempt' && row.step.execution_id === firstAttempt.execution_id), true);
});

test('metadata repair and ordinary business returns share the three-rework ceiling', () => {
  const h = harness('mixed-rework-ceiling');
  const metadataReject = routeCases.find(item => item.from === 'X03' && item.outcome === 'reject_release_metadata');
  driveFailure(h, metadataReject);
  let failed = h.current();
  let result = h.add('route', 'X03', {
    outcome: metadataReject.outcome, target: metadataReject.target,
    candidate_fingerprint: failed.candidate_fingerprint, evidence_id: failed.steps.X03.failure_evidence_id,
  });
  assert.equal(result.rework_count, 1);
  assert.equal(result.cycle, 1);

  h.add('step', 'X02', { state: 'READY' });
  h.add('step', 'X02', { state: 'RUNNING' });
  const manifest = { ...manifestPayload(h), manifest_id: 'mock:manifest:mixed-budget',
    digest: 'mock:digest:mixed-budget', evidence_bundle: 'mock:evidence:mixed-budget' };
  h.add('manifest', 'X02', manifest);
  h.add('step', 'X02', { state: 'SUCCEEDED' });
  h.add('step', 'X03', { state: 'READY' });
  h.add('step', 'X03', { state: 'RUNNING' });
  h.add('step', 'X03', { state: 'WAITING_HUMAN' });
  let current = h.current();
  h.add('approval', 'X03', {
    actor: 'mock:human', task_id: taskId('X03', current.cycle, current.steps.X03.attempt),
    plan_version: 'mock:plan:v1', evidence_id: 'mock:reject-code-budget',
    manifest_id: manifest.manifest_id, digest: manifest.digest,
    candidate_fingerprint: current.candidate_fingerprint, decision: 'reject_code',
  });
  h.add('business_failure', 'X03', { candidate_fingerprint: current.candidate_fingerprint, evidence_id: 'mock:reject-code-budget' });
  failed = h.current();
  result = h.add('route', 'X03', {
    outcome: 'reject_code', target: 'P11', candidate_fingerprint: failed.candidate_fingerprint,
    evidence_id: failed.steps.X03.failure_evidence_id,
  });
  assert.equal(result.rework_count, 2);
  assert.equal(result.cycle, 2);

  runStep(h, 'P11');
  runStep(h, 'P12');
  const failP13 = () => {
    h.add('step', 'P13', { state: 'READY' });
    h.add('step', 'P13', { state: 'RUNNING' });
    h.add('business_failure', 'P13', {
      candidate_fingerprint: h.current().candidate_fingerprint,
      evidence_id: `mock:failure:P13:budget:${h.current().cycle}:${h.current().rework_count}`,
    });
  };
  failP13();
  failed = h.current();
  result = h.add('route', 'P13', { outcome: 'business_fail', target: 'P11',
    candidate_fingerprint: failed.candidate_fingerprint, evidence_id: failed.steps.P13.failure_evidence_id });
  assert.equal(result.rework_count, 3);
  assert.equal(result.cycle, 3);

  runStep(h, 'P11');
  runStep(h, 'P12');
  failP13();
  failed = h.current();
  result = h.add('route', 'P13', { outcome: 'business_fail', target: 'P11',
    candidate_fingerprint: failed.candidate_fingerprint, evidence_id: failed.steps.P13.failure_evidence_id });
  assert.equal(result.rework_count, 3);
  assert.equal(result.cycle, 3);
  assert.equal(result.status, 'WAITING_HUMAN');
  assert.equal(result.current_step, 'P13');
  assert.equal(result.timeline.at(-1).applied, true);
  assert.equal(result.history.filter(row => row.kind === 'release_metadata').length, 1);
});

test('metadata recovery X02 infrastructure retries preserve gates and stop at attempt three', () => {
  const h = harness('metadata-infra-retry');
  const metadataReject = routeCases.find(item => item.from === 'X03' && item.outcome === 'reject_release_metadata');
  driveFailure(h, metadataReject);
  let failed = h.current();
  let result = h.add('route', 'X03', {
    outcome: metadataReject.outcome, target: metadataReject.target,
    candidate_fingerprint: failed.candidate_fingerprint, evidence_id: failed.steps.X03.failure_evidence_id,
  });
  const gateProof = Object.fromEntries(['P16', 'P18', 'P20', 'P24'].map(id => [id, result.steps[id].gate_evidence_id]));
  h.add('step', 'X02', { state: 'READY' });
  h.add('step', 'X02', { state: 'RUNNING' });
  result = h.add('infra_error', 'X02', { now_ms: 1000, operation: 'notes' });
  assert.equal(result.steps.X02.attempt, 2);
  assert.equal(result.steps.X02.state, 'WAITING_RETRY');
  assert.equal(result.steps.X02.retry_due_ms, 31_000);
  result = h.add('retry', 'X02', { now_ms: 31_000 });
  assert.equal(result.steps.X02.attempt, 3);
  assert.equal(result.steps.X02.execution_id, 'mock:X02:c1:a3');
  h.add('step', 'X02', { state: 'RUNNING' });
  result = h.add('infra_error', 'X02', { now_ms: 31_001, operation: 'notes' });
  assert.equal(result.steps.X02.state, 'WAITING_HUMAN');
  assert.equal(result.steps.X02.attempt, 3);
  assert.equal(result.steps.X02.retry_due_ms, null);
  const noFourth = h.add('retry', 'X02', { now_ms: 100_000 });
  assert.equal(noFourth.steps.X02.attempt, 3);
  assert.equal(noFourth.timeline.at(-1).applied, false);
  for (const [id, evidence] of Object.entries(gateProof)) assert.equal(noFourth.steps[id].gate_evidence_id, evidence);
  assert.equal(noFourth.release.publication_count, 0);
  assert.equal(noFourth.release.receipt_id, null);
});

test('P26 note failure and retry preserve the single P25 receipt and avoid republishing', () => {
  const h = harness('notes-only-retry');
  advanceTo(h, 'P26');
  h.add('step', 'P26', { state: 'READY' });
  h.add('step', 'P26', { state: 'RUNNING' });
  let result = h.add('notes_failure', 'P26', { evidence_id: 'mock:notes-failure:v1' });
  assert.equal(result.status, 'RELEASED_PENDING_NOTES');
  assert.equal(result.steps.P26.state, 'FAILED');
  assert.equal(result.release.publication_count, 1);
  assert.equal(result.release.receipt_id, 'mock:receipt:v1');
  const priorReceipt = structuredClone(result.release);
  result = h.add('notes_retry', 'P26', { evidence_id: 'mock:notes-retry:v1' });
  assert.equal(result.status, 'RELEASED_PENDING_NOTES');
  assert.equal(result.steps.P26.attempt, 2);
  assert.equal(result.steps.P26.state, 'READY');
  assert.equal(result.steps.P26.execution_id, 'mock:P26:c1:a2');
  assert.equal(result.release.publication_count, 1);
  assert.equal(result.release.receipt_id, priorReceipt.receipt_id);
  assert.deepEqual(result.release, priorReceipt);
  assert.equal(result.history.at(-1).kind, 'attempt');
  assert.equal(result.history.at(-1).step.state, 'FAILED');
});

test('normal mock workflow reaches END with 29 completed steps and one synthetic receipt', () => {
  const h = harness('normal-29-step-completion');
  for (const step_id of nodeOrder) runStep(h, step_id);
  const result = h.current();
  assert.equal(Object.keys(result.steps).length, 29);
  assert.equal(Object.values(result.steps).filter(step => step.state === 'SUCCEEDED').length, 29);
  assert.equal(result.current_step, 'END');
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.release.publication_count, 1);
  assert.equal(result.release.receipt_id, 'mock:receipt:v1');
  assert.equal(result.real_publish_allowed, false);
});
