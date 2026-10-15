import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayScenario } from '../../src/ifpmic/replay.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const specs = path.join(root, 'docs/ifpmic/design-v1/specs');
export const [workflow, stateContract] = await Promise.all([
  readFile(path.join(specs, 'workflow.v1.json'), 'utf8').then(JSON.parse),
  readFile(path.join(specs, 'state-contract.json'), 'utf8').then(JSON.parse),
]);

const INPUT_IDS = ['P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10', 'P11', 'P12'];

export function makeChildrenHarness(id = 'children-fixture') {
  const events = [];
  let sequence = 0;
  const current = () => replayScenario({ id, events }, workflow, stateContract);

  function add(type, step_id, payload = {}, overrides = {}) {
    const before = current();
    const step = before.steps[step_id];
    const event = {
      event_id: `evt:${id}:${++sequence}`,
      source_id: `mock:children-tc:${id}`,
      source_seq: sequence,
      type,
      mode: 'mock',
      job_id: before.job_id,
      step_id,
      cycle: before.cycle,
      attempt: step?.attempt ?? 1,
      execution_id: step?.execution_id ?? `mock:${step_id}:c${before.cycle}:a1`,
      payload,
      ...overrides,
    };
    events.push(event);
    return current();
  }

  function agentStep(step_id) {
    add('step', step_id, { state: 'READY' });
    add('step', step_id, { state: 'RUNNING' });
    add('agent', step_id, { status: 'completed' });
    add('step', step_id, { state: 'SUCCEEDED' });
  }

  function humanStep(step_id) {
    const before = current();
    const attempt = before.steps[step_id].attempt;
    add('step', step_id, { state: 'READY' });
    add('step', step_id, { state: 'RUNNING' });
    add('step', step_id, { state: 'WAITING_HUMAN' });
    add('human', step_id, {
      actor: 'mock:human', task_id: `mock:task:${step_id}:c${before.cycle}${attempt === 1 ? '' : `:a${attempt}`}`,
      plan_version: 'mock:plan:children:v1', evidence_id: `mock:children:${id}:human:${step_id}:a${attempt}`,
    });
    add('step', step_id, { state: 'SUCCEEDED' });
  }

  function reachP12() {
    // P01 and P02 begin the ordinary NEW_HW/FULL-execution path.
    add('step', 'P01', { state: 'READY' });
    add('step', 'P01', { state: 'RUNNING' });
    add('agent', 'P01', { status: 'completed' });
    add('step', 'P01', { state: 'SUCCEEDED' });
    add('step', 'P02', { state: 'READY' });
    add('step', 'P02', { state: 'RUNNING' });
    const beforeContext = current();
    const planVersion = 'mock:plan:children:v1';
    const routeContext = {
      profile_id: 'mock:profile:pilot:children-v1', profile_hash: 'mock:hash:profile:children-v1',
      profile_kind: 'pilot', change_type: 'NEW_HW', plan_version: planVersion,
      candidate_fingerprint: beforeContext.candidate_fingerprint,
      requirements_version: beforeContext.requirements_version,
      source_hash: 'mock:hash:source:children:A', test_hash: 'mock:hash:tests:children:A',
      environment_hash: 'mock:hash:environment:children:A', baseline_environment_hash: 'mock:hash:environment:children:A',
      input_hashes: Object.fromEntries(INPUT_IDS.map(node => [node, `mock:hash:input:${node}:children:A`])),
      policy_rule_id: null, policy_approval_id: null,
    };
    add('route_context', 'P02', routeContext);
    add('step', 'P02', { state: 'SUCCEEDED' });

    for (const step of ['P03', 'P04', 'P05']) agentStep(step);
    add('step', 'X01', { state: 'READY' });
    add('step', 'X01', { state: 'RUNNING' });
    add('step', 'X01', { state: 'WAITING_HUMAN' });
    const x01Evidence = `mock:children:${id}:plan-submission`;
    add('human', 'X01', {
      actor: 'mock:human', task_id: 'mock:task:X01:c1', plan_version: planVersion, evidence_id: x01Evidence,
    });
    add('plan_confirmation', 'X01', {
      actor: 'mock:human', task_id: 'mock:task:X01:c1', plan_version: planVersion,
      candidate_fingerprint: current().candidate_fingerprint, requirements_version: current().requirements_version,
      evidence_id: x01Evidence, plan_hash: 'mock:hash:plan:children:v1', reason_id: 'mock:reason:execute-all',
      prior_reuse: [], reuse_steps: [{ step_id: 'P10', baseline_hash: routeContext.environment_hash,
        baseline_input_hash: routeContext.input_hashes.P10, current_input_hash: routeContext.input_hashes.P10,
        reason_id: 'mock:reason:reuse:P10' }], exempt_steps: [],
    });
    add('step', 'X01', { state: 'SUCCEEDED' });

    for (const step of ['P06', 'P07', 'P08']) humanStep(step);
    agentStep('P09');
    add('skip', 'P10', { evidence_id: x01Evidence });
    agentStep('P11');
    add('step', 'P12', { state: 'READY' });
    add('step', 'P12', { state: 'RUNNING' });
    const ready = current();
    if (ready.current_step !== 'P12' || ready.steps.P12.state !== 'RUNNING') {
      throw new Error(`Independent fixture failed to reach P12 RUNNING: ${ready.current_step}/${ready.steps.P12.state}`);
    }
    return ready;
  }

  return { id, events, current, add, reachP12 };
}

export function childrenIds(id, cycle = 1, attempt = 1, ordinal = 1) {
  return {
    coordinator_task_id: `mock:children:${id}:coord-task:c${cycle}:a${attempt}`,
    coordinator_execution_id: `mock:children:${id}:coord-exec:c${cycle}:a${attempt}`,
    child_task_id: `mock:children:${id}:tc-task:c${cycle}:a${attempt}`,
    request_id: `mock:children:${id}:request:c${cycle}:a${attempt}:o${ordinal}`,
    child_execution_id: `mock:children:${id}:tc-exec:c${cycle}:a${attempt}:o${ordinal}`,
    coordinator_workspace_id: `mock:workspace:${id}:coord:c${cycle}:a${attempt}`,
    child_workspace_id: `mock:workspace:${id}:tc:c${cycle}:a${attempt}:o${ordinal}`,
  };
}

export function baseChildContext(h) {
  const result = h.current();
  const step = result.steps.P12;
  const ids = childrenIds(h.id, result.cycle, step.attempt, 1);
  return {
    ...ids,
    envelope: {
      job_id: result.job_id, step_id: 'P12', cycle: result.cycle, attempt: step.attempt,
      execution_id: step.execution_id, candidate_fingerprint: result.candidate_fingerprint,
      requirements_version: result.requirements_version,
    },
    p11_execution_id: result.steps.P11.execution_id,
    code_artifact_id: `mock:artifact:${h.id}:code:c${result.cycle}`,
    production_hash: `mock:hash:${h.id}:production:c${result.cycle}`,
    tc_design_artifact_id: `mock:artifact:${h.id}:tc-design:c${result.cycle}`,
    tc_output_schema_ref: 'mock:schema:tc-patch:v1',
    coordinator_runtime_profile_ref: 'mock:runtime:code-dev-coordinator:v1',
    tc_runtime_profile_ref: 'mock:runtime:tc:v1',
  };
}

export function coordinatorPayload(h, context = baseChildContext(h), overrides = {}) {
  const state = h.current();
  return {
    actor: 'mock:system', role: 'code-dev', purpose: 'p12_coordination',
    coordinator_task_id: context.coordinator_task_id,
    coordinator_execution_id: context.coordinator_execution_id,
    candidate_fingerprint: state.candidate_fingerprint,
    requirements_version: state.requirements_version,
    p11_execution_id: context.p11_execution_id,
    code_artifact_id: context.code_artifact_id,
    production_hash: context.production_hash,
    tc_design_artifact_id: context.tc_design_artifact_id,
    workspace_id: context.coordinator_workspace_id,
    write_scope: 'tests_integration_only',
    runtime_profile_ref: context.coordinator_runtime_profile_ref,
    evidence_id: `mock:children:${h.id}:coordinator-proof:c${state.cycle}:a${state.steps.P12.attempt}`,
    ...overrides,
  };
}

export function requestPayload(h, context = baseChildContext(h), overrides = {}) {
  const state = h.current();
  return {
    actor: 'mock:code-dev',
    coordinator_task_id: context.coordinator_task_id,
    coordinator_execution_id: context.coordinator_execution_id,
    request_id: context.request_id,
    child_task_id: context.child_task_id,
    ordinal: 1,
    child_role: 'tc',
    candidate_fingerprint: state.candidate_fingerprint,
    requirements_version: state.requirements_version,
    workspace_id: context.child_workspace_id,
    write_scope: 'tests_only',
    runtime_profile_ref: context.tc_runtime_profile_ref,
    output_schema_ref: context.tc_output_schema_ref,
    code_artifact_id: context.code_artifact_id,
    tc_design_artifact_id: context.tc_design_artifact_id,
    prior_child_execution_id: null,
    checkpoint_artifact_id: null,
    answer_evidence_id: null,
    answer_artifact_id: null,
    evidence_id: `mock:children:${h.id}:request-proof:c${state.cycle}:a${state.steps.P12.attempt}:o1`,
    ...overrides,
  };
}

export function assignmentPayload(h, context = baseChildContext(h), overrides = {}) {
  const state = h.current();
  return {
    actor: 'mock:system',
    coordinator_task_id: context.coordinator_task_id,
    coordinator_execution_id: context.coordinator_execution_id,
    request_id: context.request_id,
    child_task_id: context.child_task_id,
    child_execution_id: context.child_execution_id,
    candidate_fingerprint: state.candidate_fingerprint,
    requirements_version: state.requirements_version,
    workspace_id: context.child_workspace_id,
    evidence_id: `mock:children:${h.id}:assignment-proof:c${state.cycle}:a${state.steps.P12.attempt}:o1`,
    ...overrides,
  };
}

export function resultPayload(h, context = baseChildContext(h), status = 'completed', overrides = {}) {
  const state = h.current();
  const prefix = `mock:children:${h.id}:result:c${state.cycle}:a${state.steps.P12.attempt}:o1`;
  const terminal = ['failed', 'canceled', 'interrupted'].includes(status);
  return {
    actor: 'mock:tc',
    coordinator_task_id: context.coordinator_task_id,
    coordinator_execution_id: context.coordinator_execution_id,
    request_id: context.request_id,
    child_task_id: context.child_task_id,
    child_execution_id: context.child_execution_id,
    candidate_fingerprint: state.candidate_fingerprint,
    requirements_version: state.requirements_version,
    workspace_id: context.child_workspace_id,
    status,
    output_schema_ref: context.tc_output_schema_ref,
    patch_artifact_id: status === 'completed' ? `${prefix}:patch` : null,
    changed_path_refs: status === 'completed' ? ['mock:path:tests:unit'] : [],
    production_hash: context.production_hash,
    question_id: status === 'needs_human' ? `${prefix}:question` : null,
    checkpoint_artifact_id: status === 'needs_human' ? `${prefix}:checkpoint` : null,
    failure_class: terminal ? ({ failed: 'agent_failure', canceled: 'canceled', interrupted: 'interrupted' })[status] : null,
    started_at_ms: 1000,
    finished_at_ms: 2000,
    evidence_id: `${prefix}:evidence`,
    ...overrides,
  };
}

export function collectPayload(h, context = baseChildContext(h), resultEvidenceId = null, overrides = {}) {
  const state = h.current();
  return {
    actor: 'mock:code-dev',
    coordinator_task_id: context.coordinator_task_id,
    coordinator_execution_id: context.coordinator_execution_id,
    child_execution_id: context.child_execution_id,
    result_evidence_id: resultEvidenceId ?? resultPayload(h, context).evidence_id,
    candidate_fingerprint: state.candidate_fingerprint,
    requirements_version: state.requirements_version,
    evidence_id: `mock:children:${h.id}:collect-proof:c${state.cycle}:a${state.steps.P12.attempt}:o1`,
    ...overrides,
  };
}

export function integratedPayload(h, context = baseChildContext(h), overrides = {}) {
  const state = h.current();
  const result = resultPayload(h, context);
  return {
    actor: 'mock:code-dev',
    coordinator_task_id: context.coordinator_task_id,
    coordinator_execution_id: context.coordinator_execution_id,
    child_execution_id: context.child_execution_id,
    result_evidence_id: result.evidence_id,
    patch_artifact_id: result.patch_artifact_id,
    candidate_fingerprint: state.candidate_fingerprint,
    requirements_version: state.requirements_version,
    production_hash_before: context.production_hash,
    production_hash_after: context.production_hash,
    changed_path_refs: [...result.changed_path_refs],
    expectations_changed: false,
    outcome: 'integrated',
    integration_artifact_id: `mock:children:${h.id}:integration:c${state.cycle}:a${state.steps.P12.attempt}:o1`,
    evidence_id: `mock:children:${h.id}:integration-proof:c${state.cycle}:a${state.steps.P12.attempt}:o1`,
    ...overrides,
  };
}

export function setupCompletedChild(h, { context = baseChildContext(h), overrides = {} } = {}) {
  h.add('p12_coordinator', 'P12', coordinatorPayload(h, context));
  h.add('child_request', 'P12', requestPayload(h, context));
  h.add('child_assignment', 'P12', assignmentPayload(h, context));
  h.add('child_result', 'P12', resultPayload(h, context, 'completed', overrides));
  const result = h.current();
  const step = result.steps.P12;
  return { context, result, resultEvidenceId: result.child_coordination?.requests?.at(-1)?.result?.evidence_id,
    p12Execution: step.execution_id };
}
