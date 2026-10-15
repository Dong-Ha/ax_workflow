import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { replayScenario } from '../src/ifpmic/replay.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specs = path.join(root, 'docs/ifpmic/design-v1/specs');
const [workflow, stateContract] = await Promise.all([
  readFile(path.join(specs, 'workflow.v1.json'), 'utf8').then(JSON.parse),
  readFile(path.join(specs, 'state-contract.json'), 'utf8').then(JSON.parse),
]);

const reuseIds = ['P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10', 'P11', 'P12'];
const policyPairs = [['P15', 'P16'], ['P17', 'P18'], ['P19', 'P20'], ['P22', 'P24']];
const policyIds = ['P15', 'P17', 'P19', 'P21', 'P22'];
const gates = ['P16', 'P18', 'P20', 'P24'];

function harness(id = 'routing-fixture') {
  const events = [];
  let sequence = 0;
  const current = () => replayScenario({ id, events }, workflow, stateContract);
  function add(type, step_id, payload = {}, overrides = {}) {
    const result = current();
    const step = result.steps[step_id];
    const event = {
      event_id: `evt:${id}:${++sequence}`,
      source_id: 'mock:routing:source',
      source_seq: sequence,
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

function taskId(id, cycle = 1, attempt = 1) {
  return `mock:task:${id}:c${cycle}${attempt === 1 ? '' : `:a${attempt}`}`;
}

function enterHuman(h, id) {
  h.add('step', id, { state: 'READY' });
  h.add('step', id, { state: 'RUNNING' });
  h.add('step', id, { state: 'WAITING_HUMAN' });
}

function approveHuman(h, id, evidenceId, planVersion = 'mock:plan:routing:1') {
  const result = h.current();
  return h.add('human', id, {
    actor: 'mock:human', task_id: taskId(id, result.cycle, result.steps[id].attempt),
    plan_version: planVersion, evidence_id: evidenceId,
  });
}

function contextFor(h, profileKind = 'pilot', changeType = 'FEATURE', planVersion = 'mock:plan:routing:1') {
  const result = h.current();
  return {
    profile_id: `mock:profile:${profileKind}:routing-v1`,
    profile_hash: 'mock:hash:profile:routing-v1',
    profile_kind: profileKind,
    change_type: changeType,
    plan_version: planVersion,
    candidate_fingerprint: result.candidate_fingerprint,
    requirements_version: result.requirements_version,
    source_hash: 'mock:hash:source:A',
    test_hash: 'mock:hash:tests:A',
    environment_hash: 'mock:hash:environment:A',
    baseline_environment_hash: 'mock:hash:environment:A',
    input_hashes: Object.fromEntries(reuseIds.map(id => [id, `mock:hash:input:${id}:A`])),
    policy_rule_id: profileKind === 'policy_demo' ? 'mock:policy:exempt:v1' : null,
    policy_approval_id: profileKind === 'policy_demo' ? 'mock:approval:policy:routing-v1' : null,
  };
}

function reuseEntry(stepId, context, {
  same = true, evidence = `mock:evidence:reuse:${stepId}`, baseline_hash: baselineHash,
  baseline_input_hash: baselineInputHash,
} = {}) {
  const input = context.input_hashes[stepId];
  return {
    step_id: stepId,
    baseline_hash: baselineHash ?? (stepId === 'P10' && context.change_type === 'NEW_HW'
      ? context.environment_hash : `mock:hash:baseline:${stepId}:A`),
    baseline_input_hash: baselineInputHash ?? input,
    current_input_hash: same ? input : `mock:hash:input:${stepId}:changed`,
    reason_id: `mock:reason:reuse:${stepId}`,
    evidence_id: evidence,
  };
}

function planReuseEntry(stepId, context, overrides = {}) {
  const { evidence_id: _evidenceId, ...entry } = reuseEntry(stepId, context);
  return { ...entry, ...overrides };
}

function localReuseConfirmation(h, id, context, options = {}) {
  const item = reuseEntry(id, context, options);
  const result = h.current();
  const confirmation = {
    actor: 'mock:human', task_id: `mock:reuse:${id}:c${result.cycle}:a${result.steps[id].attempt}`,
    plan_version: context.plan_version, candidate_fingerprint: context.candidate_fingerprint,
    requirements_version: context.requirements_version, baseline_hash: item.baseline_hash,
    baseline_input_hash: item.baseline_input_hash, current_input_hash: item.current_input_hash,
    reason_id: item.reason_id, evidence_id: item.evidence_id,
  };
  h.add('reuse_confirmation', id, confirmation);
  return item;
}

function startP02(h, context) {
  const before = h.current();
  assert.equal(before.current_step, 'P01');
  h.add('step', 'P01', { state: 'READY' });
  h.add('step', 'P01', { state: 'RUNNING' });
  h.add('step', 'P01', { state: 'SUCCEEDED' });
  h.add('step', 'P02', { state: 'READY' });
  h.add('step', 'P02', { state: 'RUNNING' });
  h.add('route_context', 'P02', context);
  return h.current();
}

function skipByReuse(h, id, context, evidenceId) {
  const result = h.add('skip', id, { evidence_id: evidenceId });
  return result;
}

function reachX01(h, { profileKind = 'pilot', changeType = 'FEATURE', reuseSteps = reuseIds, exemptSteps = [], reuseOverrides = {}, contextOverrides = {} } = {}) {
  const context = { ...contextFor(h, profileKind, changeType), ...contextOverrides };
  startP02(h, context);
  h.add('step', 'P02', { state: 'SUCCEEDED' });
  const priorReuse = [];
  const items = new Map();
  if (changeType === 'NEW_HW') {
    for (const id of ['P03', 'P04', 'P05']) {
      h.add('step', id, { state: 'READY' });
      h.add('step', id, { state: 'RUNNING' });
      h.add('step', id, { state: 'SUCCEEDED' });
    }
  } else {
    for (const id of ['P03', 'P04', 'P05']) {
      const item = localReuseConfirmation(h, id, context);
      items.set(id, item);
      priorReuse.push({ step_id: id, evidence_id: item.evidence_id });
      skipByReuse(h, id, context, item.evidence_id);
    }
  }
  assert.equal(h.current().current_step, 'X01');
  enterHuman(h, 'X01');
  const submissionEvidence = 'mock:evidence:X01:submission:routing';
  approveHuman(h, 'X01', submissionEvidence, context.plan_version);

  const selectedReuseSteps = changeType === 'NEW_HW' ? ['P10'] : reuseSteps;
  const globalReuse = selectedReuseSteps.filter(id => !['P03', 'P04', 'P05'].includes(id));
  for (const id of globalReuse) items.set(id, reuseEntry(id, context, reuseOverrides[id] || {}));
  const fullReuseSteps = selectedReuseSteps.map(id => {
    const { evidence_id: _evidenceId, ...entry } = items.get(id);
    return entry;
  });
  const planEvidence = 'mock:evidence:X01:plan:routing';
  const plan = {
    actor: 'mock:human', task_id: taskId('X01'), plan_version: context.plan_version,
    candidate_fingerprint: context.candidate_fingerprint, requirements_version: context.requirements_version,
    evidence_id: submissionEvidence, plan_hash: 'mock:hash:plan:routing-v1',
    reason_id: 'mock:reason:plan:routing', prior_reuse: priorReuse,
    reuse_steps: fullReuseSteps,
    exempt_steps: [...exemptSteps],
  };
  h.add('plan_confirmation', 'X01', plan);
  h.add('step', 'X01', { state: 'SUCCEEDED' });
  return { context, priorReuse, items, plan, planEvidence: submissionEvidence };
}

function unchangedAnalysis(h, id, context, overrides = {}) {
  const field = id === 'P11' ? context.source_hash : context.test_hash;
  const actor = id === 'P11' ? 'mock:code-dev' : 'mock:tc';
  const evidence = `mock:evidence:unchanged:${id}:routing`;
  h.add('unchanged_analysis', id, {
    actor, plan_version: context.plan_version, candidate_fingerprint: context.candidate_fingerprint,
    requirements_version: context.requirements_version, baseline_hash: field, current_hash: field,
    needs_changes: false, requirements_satisfied: true, evidence_id: evidence,
    ...overrides,
  });
  return evidence;
}

function skipCurrentReuseChain(h, planData, { through = 'P12', noChange = false, noChangeOnly = false, p12Analysis = {} } = {}) {
  const { context, items, planEvidence } = planData;
  for (const id of ['P06', 'P07', 'P08', 'P09', 'P10', 'P11', 'P12']) {
    if (id === 'P11') unchangedAnalysis(h, id, context);
    if (id === 'P12') unchangedAnalysis(h, id, context, p12Analysis);
    if (noChange && id === 'P12') {
      const productionEvidence = `mock:evidence:unchanged:P11:routing`;
      const testsEvidence = `mock:evidence:unchanged:P12:routing`;
      const payload = {
        actor: 'mock:human', task_id: `mock:no-change:P12:c${h.current().cycle}:a${h.current().steps.P12.attempt}`,
        plan_version: context.plan_version, candidate_fingerprint: context.candidate_fingerprint,
        requirements_version: context.requirements_version, reason_id: 'mock:reason:no-change:routing',
        evidence_id: 'mock:evidence:no-change:routing', production_evidence_id: productionEvidence,
        tests_evidence_id: testsEvidence, reuse_evidence_id: planEvidence,
      };
      const variants = [
        { production_evidence_id: 'mock:evidence:wrong-production-proof' },
        { tests_evidence_id: 'mock:evidence:wrong-tests-proof' },
        { reuse_evidence_id: 'mock:evidence:wrong-plan-proof' },
        { actor: 'mock:code-dev' },
        { task_id: 'mock:no-change:P12:c1:a2' },
        { plan_version: 'mock:plan:stale' },
        { candidate_fingerprint: 'mock:candidate:stale' },
        { requirements_version: 'mock:requirements:stale' },
      ];
      let invalid;
      for (const variant of variants) {
        invalid = h.add('no_change', id, { ...payload, ...variant });
        assert.equal(invalid.steps.P12.state, 'PENDING', 'invalid NO_CHANGE proof is rejected without transition');
        assert.equal(invalid.no_change, null);
      }
      if (noChangeOnly) return invalid;
      const result = h.add('no_change', id, payload);
      return result;
    }
    const result = h.add('skip', id, { evidence_id: planEvidence });
    if (id === through) return result;
  }
  return h.current();
}

function passGate(h, id) {
  h.add('step', id, { state: 'READY' });
  h.add('step', id, { state: 'RUNNING' });
  const result = h.current();
  const step = result.steps[id];
  h.add('measurement', id, {
    evidence: {
      mode: 'mock', job_id: result.job_id, step_id: id, cycle: result.cycle,
      attempt: step.attempt, execution_id: step.execution_id,
      candidate_fingerprint: result.candidate_fingerprint, rule_version: result.rule_version,
      evidence_id: `mock:evidence:${id}:candidate-${result.candidate_fingerprint.slice(-1)}`,
      complete: true,
    },
    verdict: 'PASS',
  });
  return h.add('step', id, { state: 'SUCCEEDED' });
}

function failGate(h, id) {
  h.add('step', id, { state: 'READY' });
  h.add('step', id, { state: 'RUNNING' });
  const result = h.current();
  const step = result.steps[id];
  const evidenceId = `mock:evidence:${id}:business-fail`;
  h.add('measurement', id, {
    evidence: {
      mode: 'mock', job_id: result.job_id, step_id: id, cycle: result.cycle,
      attempt: step.attempt, execution_id: step.execution_id,
      candidate_fingerprint: result.candidate_fingerprint, rule_version: result.rule_version,
      evidence_id: evidenceId, complete: true,
    },
    verdict: 'FAIL',
  });
  const failed = h.add('business_failure', id, {
    candidate_fingerprint: result.candidate_fingerprint, evidence_id: evidenceId,
  });
  return h.add('route', id, {
    outcome: 'business_fail', target: 'P07',
    candidate_fingerprint: failed.candidate_fingerprint,
    evidence_id: failed.steps[id].failure_evidence_id,
  });
}

function passHuman(h, id) {
  enterHuman(h, id);
  approveHuman(h, id, `mock:evidence:${id}:candidate-${h.current().candidate_fingerprint.slice(-1)}`);
  return h.add('step', id, { state: 'SUCCEEDED' });
}

function completeAfterQuality(h, planVersion = 'mock:plan:v1') {
  for (const id of ['P15', 'P16', 'P17', 'P18', 'P19', 'P20']) {
    if (['P16', 'P18', 'P20'].includes(id)) passGate(h, id);
    else {
      h.add('step', id, { state: 'READY' });
      h.add('step', id, { state: 'RUNNING' });
      h.add('step', id, { state: 'SUCCEEDED' });
    }
  }
  enterHuman(h, 'P21');
  approveHuman(h, 'P21', `mock:evidence:P21:candidate-${h.current().candidate_fingerprint.slice(-1)}`, planVersion);
  h.add('step', 'P21', { state: 'SUCCEEDED' });
  for (const id of ['P22', 'P23']) {
    h.add('step', id, { state: 'READY' });
    h.add('step', id, { state: 'RUNNING' });
    h.add('step', id, { state: 'SUCCEEDED' });
  }
  passGate(h, 'P24');
  return finishRelease(h, planVersion);
}

function finishRelease(h, planVersion, tag = 'fresh') {
  h.add('step', 'X02', { state: 'READY' });
  h.add('step', 'X02', { state: 'RUNNING' });
  const result = h.current();
  h.add('manifest', 'X02', {
    manifest_id: `mock:manifest:routing:${tag}`, digest: `mock:digest:routing:${tag}`,
    candidate_fingerprint: result.candidate_fingerprint, rule_version: result.rule_version,
    destination: 'mock:destination:routing', notes_hash: 'mock:notes:routing',
    evidence_bundle: 'mock:evidence-bundle:routing',
  });
  h.add('step', 'X02', { state: 'SUCCEEDED' });
  enterHuman(h, 'X03');
  const manifest = h.current().release.manifest;
  const approvalContext = h.current();
  h.add('approval', 'X03', {
    actor: 'mock:human', task_id: taskId('X03', approvalContext.cycle, approvalContext.steps.X03.attempt), plan_version: planVersion,
    evidence_id: `mock:evidence:X03:${tag}-approval`, manifest_id: manifest.manifest_id,
    digest: manifest.digest, candidate_fingerprint: manifest.candidate_fingerprint, decision: 'approve',
  });
  h.add('step', 'X03', { state: 'SUCCEEDED' });
  h.add('step', 'P25', { state: 'READY' });
  h.add('step', 'P25', { state: 'RUNNING' });
  h.add('receipt', 'P25', {
    manifest_id: manifest.manifest_id, digest: manifest.digest,
    candidate_fingerprint: manifest.candidate_fingerprint,
    receipt_id: `mock:receipt:routing:${tag}`, observed: true,
  });
  h.add('step', 'P25', { state: 'SUCCEEDED' });
  h.add('step', 'P26', { state: 'READY' });
  h.add('step', 'P26', { state: 'RUNNING' });
  return h.add('step', 'P26', { state: 'SUCCEEDED' });
}

test('route_context and X01 plan confirmation keep local pre-reuse distinct from global approved scope', () => {
  const h = harness('routing-plan');
  const context = contextFor(h);
  startP02(h, context);
  assert.equal(h.current().current_step, 'P02', 'route context is only a proposal snapshot');
  for (const key of Object.keys(context)) assert.deepEqual(h.current().route_plan.context[key], context[key], `context binds ${key}`);
  assert.equal(h.current().route_plan.confirmed, null);
  h.add('step', 'P02', { state: 'SUCCEEDED' });

  const earlyItems = new Map();
  const p03Item = localReuseConfirmation(h, 'P03', context);
  earlyItems.set('P03', p03Item);
  assert.equal(h.current().steps.P03.state, 'PENDING', 'node-local confirmation is not completion');
  assert.equal(h.current().route_plan.confirmed, null, 'local reuse is not global plan approval');
  const badGlobalSkip = h.add('skip', 'P03', { evidence_id: 'mock:evidence:unapproved:global' });
  assert.equal(badGlobalSkip.steps.P03.state, 'PENDING');
  assert.equal(badGlobalSkip.timeline.at(-1).applied, false);
  skipByReuse(h, 'P03', context, p03Item.evidence_id);

  // Fixed oracle: the remaining early documents each require their own local
  // confirmation; a P03 confirmation cannot stand in for P04/P05.
  for (const id of ['P04', 'P05']) {
    const wrong = h.add('skip', id, { evidence_id: p03Item.evidence_id });
    assert.equal(wrong.steps[id].state, 'PENDING', `${id} rejects another node's evidence`);
    const item = localReuseConfirmation(h, id, context);
    earlyItems.set(id, item);
    skipByReuse(h, id, context, item.evidence_id);
  }
  assert.equal(h.current().current_step, 'X01');
  enterHuman(h, 'X01');
  const submitted = 'mock:evidence:X01:submission:bad-scope';
  approveHuman(h, 'X01', submitted, context.plan_version);
  const incomplete = h.add('plan_confirmation', 'X01', {
    actor: 'mock:human', task_id: taskId('X01'), plan_version: context.plan_version,
    candidate_fingerprint: context.candidate_fingerprint, requirements_version: context.requirements_version,
    evidence_id: submitted, plan_hash: 'mock:hash:plan:incomplete', reason_id: 'mock:reason:plan',
    prior_reuse: ['P03', 'P04'].map(step_id => ({ step_id, evidence_id: earlyItems.get(step_id).evidence_id })),
    reuse_steps: reuseIds.map(id => planReuseEntry(id, context)), exempt_steps: [],
  });
  assert.equal(incomplete.route_plan.confirmed, null, 'missing P04/P05 exact prior scope is rejected');
  assert.equal(incomplete.steps.X01.state, 'WAITING_HUMAN');
  const completePlan = {
    actor: 'mock:human', task_id: taskId('X01'), plan_version: context.plan_version,
    candidate_fingerprint: context.candidate_fingerprint, requirements_version: context.requirements_version,
    evidence_id: submitted, plan_hash: 'mock:hash:plan:complete', reason_id: 'mock:reason:plan',
    prior_reuse: ['P03', 'P04', 'P05'].map(step_id => ({ step_id, evidence_id: earlyItems.get(step_id).evidence_id })),
    reuse_steps: reuseIds.map(id => planReuseEntry(id, context)), exempt_steps: [],
  };
  const invalidPlans = [
    { ...completePlan, reuse_steps: completePlan.reuse_steps.map(item => item.step_id === 'P03' ? { ...item, baseline_hash: 'mock:hash:wrong-baseline' } : item) },
    { ...completePlan, reuse_steps: completePlan.reuse_steps.map(item => item.step_id === 'P03' ? { ...item, baseline_input_hash: 'mock:hash:wrong-input' } : item) },
    { ...completePlan, reuse_steps: completePlan.reuse_steps.map(item => item.step_id === 'P03' ? { ...item, current_input_hash: 'mock:hash:wrong-input' } : item) },
    { ...completePlan, reuse_steps: [...completePlan.reuse_steps, completePlan.reuse_steps[0]] },
    { ...completePlan, reuse_steps: completePlan.reuse_steps.map(item => item.step_id === 'P03' ? { ...item, extra: 'mock:unexpected' } : item) },
  ];
  for (const invalid of invalidPlans) {
    const rejected = h.add('plan_confirmation', 'X01', invalid);
    assert.equal(rejected.route_plan.confirmed, null, 'altered, duplicate, or expanded reuse scope is rejected');
    assert.equal(rejected.steps.X01.state, 'WAITING_HUMAN');
  }
  const accepted = h.add('plan_confirmation', 'X01', completePlan);
  assert.notEqual(accepted.route_plan.confirmed, null, 'the exact complete early proof and ten-item scope is accepted');
});

test('route context rejects missing, extra and stale binding values without mutating the proposal snapshot', () => {
  const h = harness('routing-context-negative');
  h.add('step', 'P01', { state: 'READY' });
  h.add('step', 'P01', { state: 'RUNNING' });
  h.add('step', 'P01', { state: 'SUCCEEDED' });
  h.add('step', 'P02', { state: 'READY' });
  h.add('step', 'P02', { state: 'RUNNING' });
  const good = contextFor(h);
  const missing = structuredClone(good);
  delete missing.input_hashes.P05;
  const badMissing = h.add('route_context', 'P02', missing);
  assert.equal(badMissing.route_plan.context, null, 'missing one of ten fixed reuse input keys is rejected');
  const extra = structuredClone(good);
  extra.input_hashes.P99 = 'mock:hash:input:P99';
  const badExtra = h.add('route_context', 'P02', extra);
  assert.equal(badExtra.route_plan.context, null, 'unknown input map key is rejected');
  const stale = structuredClone(good);
  stale.candidate_fingerprint = 'mock:candidate:stale';
  const badStale = h.add('route_context', 'P02', stale);
  assert.equal(badStale.route_plan.context, null, 'stale candidate binding is rejected');
  const invalidProfile = structuredClone(good);
  invalidProfile.profile_kind = 'production';
  const badProfile = h.add('route_context', 'P02', invalidProfile);
  assert.equal(badProfile.route_plan.context, null, 'unknown profile control is rejected');
  const accepted = h.add('route_context', 'P02', good);
  for (const key of Object.keys(good)) assert.deepEqual(accepted.route_plan.context[key], good[key], `accepted context binds ${key}`);
  assert.equal(accepted.steps.P02.state, 'RUNNING');
});

test('plan confirmation and NO_CHANGE reject absent context without throwing or changing workflow state', () => {
  const noPlan = harness('routing-no-context-plan');
  for (const id of ['P01', 'P02', 'P03', 'P04', 'P05']) {
    noPlan.add('step', id, { state: 'READY' });
    noPlan.add('step', id, { state: 'RUNNING' });
    noPlan.add('step', id, { state: 'SUCCEEDED' });
  }
  enterHuman(noPlan, 'X01');
  const submission = 'mock:evidence:X01:no-context-submission';
  approveHuman(noPlan, 'X01', submission, 'mock:plan:v1');
  const beforePlan = noPlan.current();
  const rejectedPlan = noPlan.add('plan_confirmation', 'X01', {
    actor: 'mock:human', task_id: taskId('X01'), plan_version: 'mock:plan:v1',
    candidate_fingerprint: beforePlan.candidate_fingerprint, requirements_version: beforePlan.requirements_version,
    evidence_id: submission, plan_hash: 'mock:hash:no-context-plan', reason_id: 'mock:reason:no-context',
    prior_reuse: [], reuse_steps: [], exempt_steps: [],
  });
  assert.equal(rejectedPlan.route_plan.context, null);
  assert.equal(rejectedPlan.route_plan.confirmed, null);
  assert.equal(rejectedPlan.steps.X01.state, 'WAITING_HUMAN');
  assert.equal(rejectedPlan.timeline.at(-1).applied, false);

  const noChange = harness('routing-no-context-close');
  for (const id of ['P01', 'P02', 'P03', 'P04', 'P05']) {
    noChange.add('step', id, { state: 'READY' });
    noChange.add('step', id, { state: 'RUNNING' });
    noChange.add('step', id, { state: 'SUCCEEDED' });
  }
  enterHuman(noChange, 'X01');
  approveHuman(noChange, 'X01', 'mock:evidence:X01:no-context-approval', 'mock:plan:v1');
  noChange.add('step', 'X01', { state: 'SUCCEEDED' });
  for (const id of ['P06', 'P07', 'P08', 'P09', 'P10']) {
    enterHuman(noChange, id);
    approveHuman(noChange, id, `mock:evidence:${id}:no-context`, 'mock:plan:v1');
    noChange.add('step', id, { state: 'SUCCEEDED' });
  }
  for (const id of ['P11', 'P12']) {
    noChange.add('step', id, { state: 'READY' });
    noChange.add('step', id, { state: 'RUNNING' });
  }
  noChange.add('step', 'P11', { state: 'SUCCEEDED' });
  noChange.add('step', 'P12', { state: 'READY' });
  noChange.add('step', 'P12', { state: 'RUNNING' });
  const beforeClose = noChange.current();
  const rejectedClose = noChange.add('no_change', 'P12', {
    actor: 'mock:human', task_id: 'mock:no-change:P12:c1:a1', plan_version: 'mock:plan:v1',
    candidate_fingerprint: beforeClose.candidate_fingerprint, requirements_version: beforeClose.requirements_version,
    reason_id: 'mock:reason:no-context-close', evidence_id: 'mock:evidence:no-context-close',
    production_evidence_id: 'mock:evidence:production', tests_evidence_id: 'mock:evidence:tests',
    reuse_evidence_id: 'mock:evidence:plan',
  });
  assert.equal(rejectedClose.no_change, null);
  assert.equal(rejectedClose.status, 'RUNNING');
  assert.equal(rejectedClose.steps.P12.state, 'RUNNING');
  assert.equal(rejectedClose.timeline.at(-1).applied, false);
});

test('X01 infrastructure retry requires fresh task/evidence while preserving the immutable scope', () => {
  const h = harness('routing-x01-retry');
  const context = contextFor(h);
  startP02(h, context);
  h.add('step', 'P02', { state: 'SUCCEEDED' });
  const priorReuse = [];
  const earlyItems = new Map();
  for (const id of ['P03', 'P04', 'P05']) {
    const item = localReuseConfirmation(h, id, context);
    earlyItems.set(id, item);
    priorReuse.push({ step_id: id, evidence_id: item.evidence_id });
    skipByReuse(h, id, context, item.evidence_id);
  }
  h.add('step', 'X01', { state: 'READY' });
  h.add('step', 'X01', { state: 'RUNNING' });
  const errored = h.add('infra_error', 'X01', { now_ms: 1000, operation: 'agent' });
  assert.equal(errored.steps.X01.state, 'WAITING_RETRY');
  const oldExecution = errored.steps.X01.execution_id;
  const retried = h.add('retry', 'X01', { now_ms: 11000 });
  assert.equal(retried.steps.X01.attempt, 2);
  assert.notEqual(retried.steps.X01.execution_id, oldExecution);
  h.add('step', 'X01', { state: 'RUNNING' });
  h.add('step', 'X01', { state: 'WAITING_HUMAN' });
  const oldTaskSubmission = h.add('human', 'X01', {
    actor: 'mock:human', task_id: taskId('X01', 1, 1), plan_version: context.plan_version,
    evidence_id: 'mock:evidence:X01:old-attempt',
  });
  assert.equal(oldTaskSubmission.steps.X01.state, 'WAITING_HUMAN');
  assert.equal(oldTaskSubmission.timeline.at(-1).applied, false, 'attempt-1 task cannot resolve attempt 2');
  const oldPlan = h.add('plan_confirmation', 'X01', {
    actor: 'mock:human', task_id: taskId('X01', 1, 1), plan_version: context.plan_version,
    candidate_fingerprint: context.candidate_fingerprint, requirements_version: context.requirements_version,
    evidence_id: 'mock:evidence:X01:old-attempt', plan_hash: 'mock:hash:plan:x01-retry',
    reason_id: 'mock:reason:plan:x01-retry', prior_reuse: priorReuse,
    reuse_steps: reuseIds.map(id => planReuseEntry(id, context)), exempt_steps: [],
  });
  assert.equal(oldPlan.route_plan.confirmed, null, 'old task/scope cannot confirm the retried X01 attempt');

  const freshEvidence = 'mock:evidence:X01:fresh-attempt-2';
  approveHuman(h, 'X01', freshEvidence, context.plan_version);
  const confirmed = h.add('plan_confirmation', 'X01', {
    actor: 'mock:human', task_id: taskId('X01', 1, 2), plan_version: context.plan_version,
    candidate_fingerprint: context.candidate_fingerprint, requirements_version: context.requirements_version,
    evidence_id: freshEvidence, plan_hash: 'mock:hash:plan:x01-retry',
    reason_id: 'mock:reason:plan:x01-retry', prior_reuse: priorReuse,
    reuse_steps: reuseIds.map(id => planReuseEntry(id, context)), exempt_steps: [],
  });
  assert.equal(confirmed.route_plan.confirmed.approval_attempt, 2);
  assert.equal(confirmed.route_plan.confirmed.approval_execution_id, confirmed.steps.X01.execution_id);
  assert.equal(confirmed.route_plan.confirmed.plan_version, context.plan_version, 'immutable plan version remains the same');
});

test('global reuse scope is item-bound, rejects absent or altered basis, and P11/P12 need separate analyses', () => {
  const h = harness('routing-global-reuse');
  const plan = reachX01(h);
  assert.equal(h.current().current_step, 'P06');
  const unapproved = h.add('skip', 'P06', { evidence_id: 'mock:evidence:wrong-plan' });
  assert.equal(unapproved.steps.P06.state, 'PENDING');
  assert.equal(unapproved.timeline.at(-1).applied, false);

  const first = skipCurrentReuseChain(h, plan, { through: 'P10' });
  assert.equal(first.current_step, 'P11');
  const withoutAnalysis = h.add('skip', 'P11', { evidence_id: plan.planEvidence });
  assert.equal(withoutAnalysis.steps.P11.state, 'PENDING');
  assert.equal(withoutAnalysis.timeline.at(-1).applied, false);
  unchangedAnalysis(h, 'P11', plan.context);
  const p11 = h.add('skip', 'P11', { evidence_id: plan.planEvidence });
  assert.equal(p11.steps.P11.state, 'SKIPPED');
  assert.ok(p11.steps.P11.skip_basis && typeof p11.steps.P11.skip_basis === 'object');
  assert.equal(p11.steps.P11.unchanged_analysis.needs_changes, false);
  assert.equal(p11.steps.P11.unchanged_analysis.requirements_satisfied, true);
});

test('P12 NO_CHANGE is human-confirmed terminal state, atomic with skip and leaves every later node pending', () => {
  const h = harness('routing-no-change');
  const plan = reachX01(h);
  const stopped = skipCurrentReuseChain(h, plan, { noChange: true });
  assert.equal(stopped.current_step, 'P12');
  assert.equal(stopped.status, 'NO_CHANGE');
  assert.equal(stopped.steps.P12.state, 'SKIPPED');
  assert.equal(stopped.no_change.reason_id, 'mock:reason:no-change:routing');
  assert.equal(stopped.no_change.production_evidence_id, 'mock:evidence:unchanged:P11:routing');
  assert.equal(stopped.no_change.tests_evidence_id, 'mock:evidence:unchanged:P12:routing');
  assert.equal(stopped.no_change.reuse_evidence_id, plan.planEvidence);
  assert.equal(stopped.release.publication_count, 0);
  assert.equal(stopped.release.manifest, null);
  assert.equal(stopped.release.receipt_id, null);
  for (const id of workflow.nodes.map(node => node.id).filter(id => Number(id.slice(1)) >= 13 || ['X02', 'X03', 'P25', 'P26'].includes(id))) {
    assert.equal(stopped.steps[id].state, 'PENDING', `${id} remains pending after NO_CHANGE`);
  }
  const terminalSnapshot = structuredClone(stopped);
  delete terminalSnapshot.timeline;
  delete terminalSnapshot.ignored;
  const forbiddenEvents = [
    ['agent', { status: 'completed' }],
    ['step', { state: 'READY' }],
    ['human', {
      actor: 'mock:human', task_id: taskId('P12'), plan_version: plan.context.plan_version,
      evidence_id: 'mock:evidence:terminal:human',
    }],
    ['device', {
      mode: 'mock', now_ms: 1_000, last_heartbeat_ms: 1_000, lease_expires_ms: 2_000, operation_state: 'idle',
    }],
    ['no_change', {
      actor: 'mock:human', task_id: taskId('P12'), plan_version: plan.context.plan_version,
      candidate_fingerprint: stopped.candidate_fingerprint, requirements_version: stopped.requirements_version,
      reason_id: 'mock:reason:no-change:terminal-repeat', evidence_id: 'mock:evidence:no-change:terminal-repeat',
      production_evidence_id: 'mock:evidence:unchanged:P11:routing',
      tests_evidence_id: 'mock:evidence:unchanged:P12:routing', reuse_evidence_id: plan.planEvidence,
    }],
  ];
  for (const [type, payload] of forbiddenEvents) {
    const after = h.add(type, 'P12', payload);
    assert.equal(after.timeline.at(-1).reason, 'terminal_no_change', `${type} is blocked by the terminal NO_CHANGE guard`);
    assert.equal(after.timeline.at(-1).applied, false);
    assert.equal(after.status, 'NO_CHANGE');
    assert.equal(after.real_publish_allowed, false);
    assert.equal(after.release.publication_count, 0);
    const projection = structuredClone(after);
    delete projection.timeline;
    delete projection.ignored;
    assert.deepEqual(projection, terminalSnapshot, `${type} cannot mutate the terminal business projection`);
  }
});

test('NO_CHANGE requires both analyses to prove unchanged and requirements satisfied', () => {
  const invalidAnalyses = [
    { needs_changes: true },
    { requirements_satisfied: false },
    { baseline_hash: 'mock:hash:tests:wrong' },
    { current_hash: 'mock:hash:tests:wrong' },
    { actor: 'mock:code-dev' },
  ];
  for (const [index, override] of invalidAnalyses.entries()) {
    const h = harness(`routing-no-change-analysis-${index + 1}`);
    const plan = reachX01(h);
    const result = skipCurrentReuseChain(h, plan, { noChange: true, noChangeOnly: true, p12Analysis: override });
    assert.equal(result.current_step, 'P12');
    assert.equal(result.status, 'RUNNING');
    assert.equal(result.steps.P12.state, 'PENDING');
    assert.equal(result.no_change, null);
    assert.equal(result.timeline.at(-1).applied, false);
  }
});

test('pilot and NEW_HW plans cannot grant exemptions; coupled plan scopes are indivisible', () => {
  for (const [profileKind, changeType] of [['pilot', 'FEATURE'], ['policy_demo', 'NEW_HW']]) {
    const h = harness(`routing-exempt-deny-${profileKind}-${changeType}`);
    const plan = reachX01(h, { profileKind, changeType, exemptSteps: policyPairs[0] });
    assert.equal(plan.context.profile_kind, profileKind);
    assert.equal(h.current().route_plan.confirmed, null, 'forbidden exemption declaration is not confirmed');
    assert.equal(h.current().steps.X01.state, 'WAITING_HUMAN');
  }
  const h = harness('routing-half-pair');
  const plan = reachX01(h, { profileKind: 'policy_demo', exemptSteps: ['P15'] });
  assert.equal(plan.context.profile_kind, 'policy_demo');
  assert.equal(h.current().route_plan.confirmed, null, 'half-pair scope cannot be confirmed');
  assert.equal(h.current().steps.X01.state, 'WAITING_HUMAN');
});

test('NEW_HW permits only same-environment P10 reuse and rejects early or mismatched baseline reuse', () => {
  const early = harness('routing-new-hardware-early');
  const earlyContext = contextFor(early, 'pilot', 'NEW_HW');
  startP02(early, earlyContext);
  early.add('step', 'P02', { state: 'SUCCEEDED' });
  localReuseConfirmation(early, 'P03', earlyContext);
  assert.equal(early.current().steps.P03.state, 'PENDING');
  assert.equal(early.current().route_plan.reuse_confirmations.P03, undefined,
    'NEW_HW does not allow early document reuse confirmation');

  const h = harness('routing-new-hardware-p10');
  const plan = reachX01(h, { changeType: 'NEW_HW' });
  assert.notEqual(h.current().route_plan.confirmed, null);
  for (const id of ['P06', 'P07', 'P08', 'P09']) {
    enterHuman(h, id);
    approveHuman(h, id, `mock:evidence:${id}:new-hardware`, plan.context.plan_version);
    h.add('step', id, { state: 'SUCCEEDED' });
  }
  const p10 = h.add('skip', 'P10', { evidence_id: plan.planEvidence });
  assert.equal(p10.steps.P10.state, 'SKIPPED');
  assert.ok(p10.steps.P10.skip_basis);
  for (const id of ['P11', 'P12']) {
    h.add('step', id, { state: 'READY' });
    h.add('step', id, { state: 'RUNNING' });
    h.add('step', id, { state: 'SUCCEEDED' });
  }
  assert.equal(h.current().current_step, 'P13');

  const mismatch = harness('routing-new-hardware-p10-mismatch');
  reachX01(mismatch, { changeType: 'NEW_HW', reuseOverrides: { P10: { same: false } } });
  assert.equal(mismatch.current().route_plan.confirmed, null, 'P10 cannot reuse input with a changed baseline');
  assert.equal(mismatch.current().steps.X01.state, 'WAITING_HUMAN');

  const wrongBaseline = harness('routing-new-hardware-baseline-mismatch');
  reachX01(wrongBaseline, { changeType: 'NEW_HW', reuseOverrides: { P10: { baseline_hash: 'mock:hash:environment:other' } } });
  assert.equal(wrongBaseline.current().route_plan.confirmed, null, 'P10 baseline hash must equal the approved environment hash');
  const wrongEnvironment = harness('routing-new-hardware-environment-mismatch');
  reachX01(wrongEnvironment, { changeType: 'NEW_HW', contextOverrides: { baseline_environment_hash: 'mock:hash:environment:other' } });
  assert.equal(wrongEnvironment.current().route_plan.confirmed, null, 'baseline_environment_hash must match current environment');
});

test('policy demo exemption is coupled, P23 report is mandatory, and EXEMPT is not PASS', () => {
  const exempt = [...policyPairs.flat(), 'P21'];
  const h = harness('routing-policy-exemptions');
  const plan = reachX01(h, { profileKind: 'policy_demo', exemptSteps: exempt });
  assert.notEqual(h.current().route_plan.confirmed, null);
  skipCurrentReuseChain(h, plan);
  for (const id of ['P13', 'P14']) {
    h.add('step', id, { state: 'READY' });
    h.add('step', id, { state: 'RUNNING' });
    h.add('step', id, { state: 'SUCCEEDED' });
  }
  for (const id of ['P15', 'P16', 'P17', 'P18', 'P19', 'P20']) {
    h.add('skip', id, { evidence_id: plan.planEvidence });
  }
  const p21 = h.add('skip', 'P21', { evidence_id: plan.planEvidence });
  assert.equal(p21.steps.P21.state, 'SKIPPED');
  const p22 = h.add('skip', 'P22', { evidence_id: plan.planEvidence });
  assert.equal(p22.steps.P22.state, 'SKIPPED');
  assert.equal(p22.steps.P24.state, 'PENDING', 'P24 cannot be consumed before P23 report');
  const neverSkip = h.add('skip', 'P23', { evidence_id: plan.planEvidence });
  assert.equal(neverSkip.steps.P23.state, 'PENDING', 'NEVER P23 cannot be skipped, including under an exemption plan');
  h.add('step', 'P23', { state: 'READY' });
  h.add('step', 'P23', { state: 'RUNNING' });
  const noReport = h.add('step', 'P23', { state: 'SUCCEEDED' });
  assert.equal(noReport.steps.P23.state, 'RUNNING', 'agent completion does not replace the SQE report');
  assert.equal(noReport.steps.P24.state, 'PENDING');
  const report = {
    actor: 'mock:sqe', plan_version: plan.context.plan_version,
    candidate_fingerprint: plan.context.candidate_fingerprint,
    requirements_version: plan.context.requirements_version,
    exemption_evidence_id: plan.planEvidence, performed: false,
    report_id: 'mock:report:P23:exemption', evidence_id: 'mock:evidence:P23:exemption',
  };
  for (const invalid of [
    { ...report, actor: 'mock:human' },
    { ...report, performed: true },
    { ...report, exemption_evidence_id: 'mock:evidence:wrong-plan' },
  ]) {
    const rejected = h.add('exemption_report', 'P23', invalid);
    assert.equal(rejected.steps.P23.exemption_report, null);
    assert.equal(rejected.steps.P23.state, 'RUNNING');
  }
  h.add('exemption_report', 'P23', report);
  const p23 = h.add('step', 'P23', { state: 'SUCCEEDED' });
  assert.equal(p23.steps.P23.state, 'SUCCEEDED');
  assert.equal(p23.steps.P23.exemption_report.performed, false);
  const p24 = h.add('skip', 'P24', { evidence_id: plan.planEvidence });
  assert.equal(p24.steps.P24.state, 'SKIPPED');
  for (const id of gates) {
    assert.equal(p24.steps[id].gate_verdict, 'EXEMPT', `${id} remains explicitly exempt`);
    assert.equal(p24.steps[id].gate_complete, false);
  }
  const attemptedPass = h.add('measurement', 'P24', {
    evidence: {
      mode: 'mock', job_id: p24.job_id, step_id: 'P24', cycle: p24.cycle,
      attempt: p24.steps.P24.attempt, execution_id: p24.steps.P24.execution_id,
      candidate_fingerprint: p24.candidate_fingerprint, rule_version: p24.rule_version,
      evidence_id: 'mock:evidence:P24:forged-pass', complete: true,
    },
    verdict: 'PASS',
  });
  assert.equal(attemptedPass.steps.P24.gate_verdict, 'EXEMPT', 'a PASS event cannot rewrite EXEMPT disposition');
  h.add('step', 'X02', { state: 'READY' });
  h.add('step', 'X02', { state: 'RUNNING' });
  let release = h.current();
  h.add('manifest', 'X02', {
    manifest_id: 'mock:manifest:routing:metadata-a', digest: 'mock:digest:routing:metadata-a',
    candidate_fingerprint: release.candidate_fingerprint, rule_version: release.rule_version,
    destination: 'mock:destination:routing', notes_hash: 'mock:notes:routing',
    evidence_bundle: 'mock:evidence-bundle:routing',
  });
  h.add('step', 'X02', { state: 'SUCCEEDED' });
  enterHuman(h, 'X03');
  release = h.current();
  const rejectionEvidence = 'mock:evidence:X03:reject-metadata';
  h.add('approval', 'X03', {
    actor: 'mock:human', task_id: taskId('X03'), plan_version: plan.context.plan_version,
    evidence_id: rejectionEvidence, manifest_id: release.release.manifest.manifest_id,
    digest: release.release.manifest.digest, candidate_fingerprint: release.candidate_fingerprint,
    decision: 'reject_release_metadata',
  });
  h.add('business_failure', 'X03', {
    candidate_fingerprint: release.candidate_fingerprint, evidence_id: rejectionEvidence,
  });
  release = h.current();
  const metadataRetry = h.add('route', 'X03', {
    outcome: 'reject_release_metadata', target: 'X02',
    candidate_fingerprint: release.candidate_fingerprint,
    evidence_id: release.steps.X03.failure_evidence_id,
  });
  assert.equal(metadataRetry.cycle, 1);
  assert.equal(metadataRetry.current_step, 'X02');
  assert.equal(metadataRetry.steps.X02.attempt, 2);
  assert.deepEqual(metadataRetry.required_revalidation, ['X02', 'X03', 'P25', 'P26']);
  for (const id of gates) {
    assert.equal(metadataRetry.steps[id].state, 'SKIPPED');
    assert.equal(metadataRetry.steps[id].gate_verdict, 'EXEMPT');
  }
  assert.equal(metadataRetry.steps.P23.exemption_report.performed, false);
  const completed = finishRelease(h, plan.context.plan_version, 'metadata-b');
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.current_step, 'END');
  assert.equal(completed.release.publication_count, 1);
  assert.equal(completed.release.approved, true);
  assert.equal(completed.release.receipt_id, 'mock:receipt:routing:metadata-b');
  assert.deepEqual(completed.release.manifest.gate_dispositions, ['EXEMPT', 'EXEMPT', 'EXEMPT', 'EXEMPT']);
});

test('P13 candidate change invalidates prior skip/exemption/no-change authority while allowing fresh PASS gates', () => {
  const h = harness('routing-candidate-revalidation');
  const plan = reachX01(h, { profileKind: 'policy_demo', exemptSteps: [...policyPairs.flat(), 'P21'] });
  const p06 = h.add('skip', 'P06', { evidence_id: plan.planEvidence });
  assert.equal(p06.steps.P06.state, 'SKIPPED');
  // Run all middle nodes through a representative approved plan; the candidate
  // change at P13 is the policy boundary under test.
  for (const id of ['P07', 'P08', 'P09', 'P10', 'P11', 'P12']) {
    if (id === 'P11' || id === 'P12') unchangedAnalysis(h, id, plan.context);
    h.add('skip', id, { evidence_id: plan.planEvidence });
  }
  h.add('step', 'P13', { state: 'READY' });
  h.add('step', 'P13', { state: 'RUNNING' });
  const changed = h.add('candidate', 'P13', { candidate_fingerprint: 'mock:candidate:B' });
  assert.equal(changed.candidate_fingerprint, 'mock:candidate:B');
  for (const id of ['P15', 'P16', 'P17', 'P18', 'P19', 'P20', 'P21', 'P22', 'P23', 'P24']) {
    assert.equal(changed.steps[id].state, 'PENDING', `${id} is not silently exempted under candidate B`);
  }
  assert.equal(changed.real_publish_allowed, false);
  assert.equal(changed.release.publication_count, 0);
  h.add('step', 'P13', { state: 'SUCCEEDED' });
  h.add('step', 'P14', { state: 'READY' });
  h.add('step', 'P14', { state: 'RUNNING' });
  h.add('step', 'P14', { state: 'SUCCEEDED' });
  const oldExemption = h.add('skip', 'P15', { evidence_id: plan.planEvidence });
  assert.equal(oldExemption.steps.P15.state, 'PENDING', 'candidate A exemption cannot authorize candidate B at P15');
  const completed = completeAfterQuality(h, plan.context.plan_version);
  assert.equal(completed.status, 'COMPLETED', 'fresh candidate B may complete normal execution');
  assert.equal(completed.current_step, 'END');
  assert.equal(completed.release.approved, true);
  assert.equal(completed.release.receipt_id, 'mock:receipt:routing:fresh');
  assert.deepEqual(completed.release.manifest.gate_dispositions, ['PASS', 'PASS', 'PASS', 'PASS']);
  assert.equal(completed.release.publication_count, 1);
});

test('business rework uses the literal P13-to-P11 suffix and denies old cycle skip authority', () => {
  const h = harness('routing-business-revalidation');
  const plan = reachX01(h);
  skipCurrentReuseChain(h, plan);
  h.add('step', 'P13', { state: 'READY' });
  h.add('step', 'P13', { state: 'RUNNING' });
  const failed = h.add('business_failure', 'P13', {
    candidate_fingerprint: h.current().candidate_fingerprint,
    evidence_id: 'mock:evidence:failure:P13:routing',
  });
  assert.equal(failed.steps.P13.state, 'FAILED');
  const routed = h.add('route', 'P13', {
    outcome: 'business_fail', target: 'P11', candidate_fingerprint: failed.candidate_fingerprint,
    evidence_id: failed.steps.P13.failure_evidence_id,
  });
  const expectedSuffix = ['P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19', 'P20', 'P21', 'P22', 'P23', 'P24', 'X02', 'X03', 'P25', 'P26'];
  assert.equal(routed.cycle, 2);
  assert.equal(routed.current_step, 'P11');
  assert.deepEqual(routed.required_revalidation, expectedSuffix);
  assert.equal(routed.steps.P11.state, 'PENDING');
  const oldBasis = h.add('skip', 'P11', { evidence_id: plan.planEvidence });
  assert.equal(oldBasis.steps.P11.state, 'PENDING', 'old-cycle X01 plan cannot bypass current revalidation');
  assert.equal(oldBasis.timeline.at(-1).applied, false);
});

test('P16 and P24 failures force a fresh P07 suffix and reject the prior global reuse plan', () => {
  for (const failingGate of ['P16', 'P24']) {
    const h = harness(`routing-${failingGate}-revalidation`);
    const plan = reachX01(h);
    skipCurrentReuseChain(h, plan);
    for (const id of ['P13', 'P14']) {
      h.add('step', id, { state: 'READY' });
      h.add('step', id, { state: 'RUNNING' });
      h.add('step', id, { state: 'SUCCEEDED' });
    }
    let routed;
    if (failingGate === 'P16') {
      h.add('step', 'P15', { state: 'READY' });
      h.add('step', 'P15', { state: 'RUNNING' });
      h.add('step', 'P15', { state: 'SUCCEEDED' });
      routed = failGate(h, 'P16');
    } else {
      for (const id of ['P15', 'P16', 'P17', 'P18', 'P19', 'P20']) {
        if (['P16', 'P18', 'P20'].includes(id)) passGate(h, id);
        else {
          h.add('step', id, { state: 'READY' });
          h.add('step', id, { state: 'RUNNING' });
          h.add('step', id, { state: 'SUCCEEDED' });
        }
      }
      // Continue from the completed P20 gate through the SQE report to P24.
      h.add('step', 'P21', { state: 'READY' });
      h.add('step', 'P21', { state: 'RUNNING' });
      h.add('step', 'P21', { state: 'WAITING_HUMAN' });
      approveHuman(h, 'P21', 'mock:evidence:P21:routing-P24');
      h.add('step', 'P21', { state: 'SUCCEEDED' });
      for (const id of ['P22', 'P23']) {
        h.add('step', id, { state: 'READY' });
        h.add('step', id, { state: 'RUNNING' });
        h.add('step', id, { state: 'SUCCEEDED' });
      }
      routed = failGate(h, 'P24');
    }
    const expectedSuffix = ['P07', 'P08', 'P09', 'P10', 'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19', 'P20', 'P21', 'P22', 'P23', 'P24', 'X02', 'X03', 'P25', 'P26'];
    assert.equal(routed.cycle, 2, `${failingGate} starts a new business cycle`);
    assert.equal(routed.current_step, 'P07');
    assert.deepEqual(routed.required_revalidation, expectedSuffix);
    const staleSkip = h.add('skip', 'P07', { evidence_id: plan.planEvidence });
    assert.equal(staleSkip.steps.P07.state, 'PENDING', 'old plan cannot bypass forced P07 revalidation');
    assert.equal(staleSkip.timeline.at(-1).applied, false);
  }
});

test('X01 rejection forces a fresh P02 context and forbids old local/global reuse authority', () => {
  const h = harness('routing-X01-replan');
  const oldContext = contextFor(h, 'pilot', 'FEATURE', 'mock:plan:routing:old');
  startP02(h, oldContext);
  h.add('step', 'P02', { state: 'SUCCEEDED' });
  const localEvidence = [];
  for (const id of ['P03', 'P04', 'P05']) {
    const item = localReuseConfirmation(h, id, oldContext);
    localEvidence.push({ step_id: id, evidence_id: item.evidence_id });
    skipByReuse(h, id, oldContext, item.evidence_id);
  }
  enterHuman(h, 'X01');
  const rejectEvidence = 'mock:evidence:X01:rejected-routing';
  h.add('human', 'X01', {
    actor: 'mock:human', task_id: taskId('X01'), plan_version: oldContext.plan_version,
    evidence_id: rejectEvidence, decision: 'reject',
  });
  h.add('business_failure', 'X01', {
    candidate_fingerprint: h.current().candidate_fingerprint, evidence_id: rejectEvidence,
  });
  let failed = h.current();
  const routed = h.add('route', 'X01', {
    outcome: 'rejected', target: 'P02', candidate_fingerprint: failed.candidate_fingerprint,
    evidence_id: failed.steps.X01.failure_evidence_id,
  });
  assert.equal(routed.cycle, 2);
  assert.deepEqual(routed.required_revalidation, ['P02', 'P03', 'P04', 'P05', 'X01', 'P06', 'P07', 'P08', 'P09', 'P10', 'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19', 'P20', 'P21', 'P22', 'P23', 'P24', 'X02', 'X03', 'P25', 'P26']);
  assert.equal(routed.steps.X01.state, 'PENDING');
  assert.equal(routed.steps.P03.state, 'PENDING');
  h.add('step', 'P02', { state: 'READY' });
  h.add('step', 'P02', { state: 'RUNNING' });
  const priorPlanSnapshot = structuredClone(h.current().route_plan);
  const reusedVersion = contextFor(h, 'pilot', 'FEATURE', oldContext.plan_version);
  const rejectedVersion = h.add('route_context', 'P02', reusedVersion);
  assert.deepEqual(rejectedVersion.route_plan, priorPlanSnapshot, 'stale context remains an inert historical snapshot');
  assert.equal(rejectedVersion.route_plan.context.cycle, 1);
  assert.equal(rejectedVersion.timeline.at(-1).applied, false, 'a plan version from the rejected cycle cannot be reused');
  assert.equal(rejectedVersion.timeline.at(-1).reason, 'invalid_route_context');
  const newContext = contextFor(h, 'pilot', 'FEATURE', 'mock:plan:routing:new');
  h.add('route_context', 'P02', newContext);
  h.add('step', 'P02', { state: 'SUCCEEDED' });
  const earlyReuse = h.add('reuse_confirmation', 'P03', {
    actor: 'mock:human', task_id: `mock:reuse:P03:c2:a1`, plan_version: newContext.plan_version,
    candidate_fingerprint: newContext.candidate_fingerprint, requirements_version: newContext.requirements_version,
    baseline_hash: 'mock:hash:baseline:P03:A', baseline_input_hash: newContext.input_hashes.P03,
    current_input_hash: newContext.input_hashes.P03, reason_id: 'mock:reason:reuse:P03', evidence_id: 'mock:evidence:reuse:new-P03',
  });
  assert.equal(earlyReuse.steps.P03.state, 'PENDING', 'forced P03 is performed, not locally skipped');
  assert.equal(earlyReuse.route_plan.confirmed, null);
  for (const id of ['P03', 'P04', 'P05']) {
    h.add('step', id, { state: 'READY' });
    h.add('step', id, { state: 'RUNNING' });
    h.add('step', id, { state: 'SUCCEEDED' });
  }
  enterHuman(h, 'X01');
  const submissionEvidence = 'mock:evidence:X01:new-plan-submission';
  approveHuman(h, 'X01', submissionEvidence, newContext.plan_version);
  const current = h.current();
  const confirmation = h.add('plan_confirmation', 'X01', {
    actor: 'mock:human', task_id: taskId('X01', current.cycle, current.steps.X01.attempt),
    plan_version: newContext.plan_version, candidate_fingerprint: current.candidate_fingerprint,
    requirements_version: current.requirements_version, evidence_id: submissionEvidence,
    plan_hash: 'mock:hash:plan:routing-v2', reason_id: 'mock:reason:plan:routing-v2',
    prior_reuse: [], reuse_steps: [], exempt_steps: [],
  });
  assert.notEqual(confirmation.route_plan.confirmed, null, 'a new plan confirms after actual P03-P05 completion');
  assert.equal(confirmation.route_plan.confirmed.plan_version, newContext.plan_version);
  assert.equal(h.add('step', 'X01', { state: 'SUCCEEDED' }).steps.X01.state, 'SUCCEEDED');
  assert.equal(localEvidence.length, 3, 'the rejected cycle had three distinct local confirmations archived');
});

test('routing fixtures cover the original literal NEVER, REUSE, POLICY and COUPLED node groups', () => {
  const byId = new Map(workflow.nodes.map(node => [node.id, node]));
  const never = ['P01', 'P02', 'X01', 'P13', 'P14', 'P23', 'X02', 'X03', 'P25', 'P26'];
  const coupled = ['P16', 'P18', 'P20', 'P24'];
  for (const id of never) assert.equal(byId.get(id)?.skip_policy, 'NEVER', `${id} is NEVER in original source contract`);
  for (const id of reuseIds) assert.equal(byId.get(id)?.skip_policy, 'REUSE', `${id} is REUSE in original source contract`);
  for (const id of policyIds) assert.equal(byId.get(id)?.skip_policy, 'POLICY', `${id} is POLICY in original source contract`);
  for (const id of coupled) assert.equal(byId.get(id)?.skip_policy, 'COUPLED', `${id} is COUPLED in original source contract`);
  assert.deepEqual(policyPairs, [['P15', 'P16'], ['P17', 'P18'], ['P19', 'P20'], ['P22', 'P24']]);
  assert.deepEqual(gates, coupled);
  const h = harness('routing-never-skip');
  const attempted = h.add('skip', 'P01', { evidence_id: 'mock:evidence:invented-skip' });
  assert.equal(attempted.steps.P01.state, 'PENDING');
  assert.equal(attempted.timeline.at(-1).applied, false, 'NEVER node remains unskipped under mock evidence');
});
