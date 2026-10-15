// Pure P12 observations. These declarations never start agents or inspect/write worktrees.
const binding = ['candidate_fingerprint', 'requirements_version'];
const parent = ['coordinator_task_id', 'coordinator_execution_id'];
const fields = {
  p12_coordinator: ['actor', 'role', 'purpose', ...parent, ...binding, 'p11_execution_id', 'code_artifact_id', 'production_hash', 'tc_design_artifact_id', 'workspace_id', 'write_scope', 'runtime_profile_ref', 'evidence_id'],
  child_request: ['actor', ...parent, 'request_id', 'child_task_id', 'ordinal', 'child_role', ...binding, 'workspace_id', 'write_scope', 'runtime_profile_ref', 'output_schema_ref', 'code_artifact_id', 'tc_design_artifact_id', 'prior_child_execution_id', 'checkpoint_artifact_id', 'answer_evidence_id', 'answer_artifact_id', 'evidence_id'],
  child_assignment: ['actor', ...parent, 'request_id', 'child_task_id', 'child_execution_id', ...binding, 'workspace_id', 'evidence_id'],
  child_result: ['actor', ...parent, 'request_id', 'child_task_id', 'child_execution_id', ...binding, 'workspace_id', 'status', 'output_schema_ref', 'patch_artifact_id', 'changed_path_refs', 'production_hash', 'question_id', 'checkpoint_artifact_id', 'failure_class', 'started_at_ms', 'finished_at_ms', 'evidence_id'],
  child_collect: ['actor', ...parent, 'child_execution_id', 'result_evidence_id', ...binding, 'evidence_id'],
  child_answer: ['actor', ...parent, 'child_execution_id', 'task_id', 'question_id', 'answer_artifact_id', 'checkpoint_artifact_id', ...binding, 'evidence_id'],
  child_recovery: ['actor', ...parent, 'child_execution_id', 'task_id', 'result_evidence_id', 'action', 'reason_id', ...binding, 'evidence_id'],
  child_integrated: ['actor', ...parent, 'child_execution_id', 'result_evidence_id', 'patch_artifact_id', ...binding, 'production_hash_before', 'production_hash_after', 'changed_path_refs', 'expectations_changed', 'outcome', 'integration_artifact_id', 'evidence_id'],
};
export const childPayloadFields = Object.freeze(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, Object.freeze(value)])));
const shape = (p, keys) => p && typeof p === 'object' && !Array.isArray(p)
  && Object.keys(p).length === keys.length && keys.every(key => Object.hasOwn(p, key));
const clone = value => structuredClone(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const paths = value => Array.isArray(value) && value.length === 1 && value[0] === 'mock:path:tests:unit';

export function childEvidenceCurrent(context, snapshot) {
  const step = snapshot.steps.P12;
  return Boolean(context && context.cycle === snapshot.cycle && context.attempt === step.attempt
    && context.execution_id === step.execution_id && binding.every(key => context[key] === snapshot[key]));
}

export function createChildProtocols({ result, mockId, transitionAllowed }) {
  // Reserved only by accepted observations; rejected payloads cannot mint authority or poison IDs.
  const ids = new Set();
  const fresh = (...values) => new Set(values).size === values.length && values.every(id => mockId(id) && !ids.has(id));
  const reserve = (...values) => values.forEach(id => ids.add(id));
  const current = c => childEvidenceCurrent(c?.context, result);
  const tail = c => c?.requests.at(-1);
  const matches = (p, c) => current(c) && [...parent, ...binding].every(key => p[key] === c.context[key]);
  const sameChild = (p, request) => request?.assignment && p.child_execution_id === request.assignment.child_execution_id;
  const reconciles = () => result.status === 'RECONCILING' || result.device?.quarantined;
  const add = (step, p) => { reserve(p.evidence_id); step.evidence_ids.push(p.evidence_id); };
  const canRecover = c => {
    const r = tail(c);
    if (!current(c) || c.status !== 'RUNNING' || r?.integration) return false;
    if (!r) return true;
    if (!r.assignment || !r.result || !r.collection) return false;
    return r.result.status === 'failed' || r.result.status === 'completed'
      || ['canceled', 'interrupted'].includes(r.result.status) && Boolean(r.recovery);
  };
  const answered = c => {
    const r = tail(c);
    return c?.human_task && r?.collection && (c.human_task.kind === 'agent_question' ? r.answer : r.recovery);
  };
  function blockingReason(event, node, step) {
    if (node.id !== 'P12') return '';
    const c = step.child_coordination, r = tail(c), p = event.payload;
    if (reconciles() && ['step', 'infra_error', 'retry', 'human'].includes(event.type)) return 'reconciliation_required';
    if (event.type === 'infra_error' && (!canRecover(c) || p.operation !== 'agent')) return 'child_recovery_required';
    if (event.type === 'human') return 'child_human_evidence_required';
    if (event.type === 'agent') {
      if (!r?.assignment) return 'child_assignment_required';
      const expected = r.result?.status ?? 'running';
      return p.status === expected && ['running', 'completed', 'failed'].includes(expected) ? '' : 'child_agent_status_conflict';
    }
    if (event.type !== 'step') return '';
    if (p.state === 'FAILED' || p.state === 'WAITING_AGENT' || p.state === 'WAITING_HUMAN' || p.state === 'WAITING_RETRY' || p.state === 'WAITING_DEVICE') return 'child_evidence_required';
    if (step.state === 'WAITING_AGENT') return 'child_collection_required';
    if (step.state === 'WAITING_HUMAN' && !step.infrastructure_error) {
      if (p.state !== 'READY' || !current(c) || !answered(c)) return 'child_human_evidence_required';
    }
    if (step.state === 'READY' && c && (!current(c) || !answered(c))) return 'child_human_evidence_required';
    return '';
  }
  function apply(event, node, step) {
    if (!Object.hasOwn(fields, event.type)) {
      // Matching legacy telemetry is observable, but cannot create child or workflow authority.
      if (node.id === 'P12' && event.type === 'agent') return '';
      return null;
    }
    const p = event.payload, c = step.child_coordination, r = tail(c);
    if (node.id !== 'P12' || !shape(p, fields[event.type]) || !fresh(p.evidence_id)) return 'invalid_child_proof';
    if (reconciles() && event.type !== 'child_result') return 'reconciliation_required';
    if (event.type === 'p12_coordinator') {
      const p11 = result.steps.P11;
      if (step.state !== 'RUNNING' || c || p.actor !== 'mock:system' || p.role !== 'code-dev' || p.purpose !== 'p12_coordination'
        || !['SUCCEEDED', 'SKIPPED'].includes(p11.state) || p11.cycle !== result.cycle || p.p11_execution_id !== p11.execution_id
        || p11.state === 'SKIPPED' && !p11.skip_basis || !binding.every(key => p[key] === result[key])
        || !['code_artifact_id', 'production_hash', 'tc_design_artifact_id', 'workspace_id'].every(key => mockId(p[key]))
        || !fresh(p.coordinator_task_id, p.coordinator_execution_id, p.evidence_id)
        || p.write_scope !== 'tests_integration_only' || p.runtime_profile_ref !== 'mock:runtime:code-dev-coordinator:v1') return 'invalid_child_coordinator';
      step.child_coordination = { context: { ...clone(p), cycle: result.cycle, attempt: step.attempt, execution_id: step.execution_id },
        status: 'RUNNING', requests: [], human_task: null };
      reserve(...parent.map(key => p[key])); add(step, p); return '';
    }
    if (!matches(p, c)) return 'child_binding_mismatch';
    if (event.type === 'child_request') {
      if (step.state !== 'RUNNING' || c.status !== 'RUNNING' || p.actor !== 'mock:code-dev' || p.child_role !== 'tc'
        || p.write_scope !== 'tests_only' || p.runtime_profile_ref !== 'mock:runtime:tc:v1' || p.output_schema_ref !== 'mock:schema:tc-patch:v1'
        || !mockId(p.workspace_id) || p.workspace_id === c.context.workspace_id || p.code_artifact_id !== c.context.code_artifact_id
        || p.tc_design_artifact_id !== c.context.tc_design_artifact_id || !Number.isSafeInteger(p.ordinal) || p.ordinal !== c.requests.length + 1
        || !fresh(p.request_id, p.evidence_id)) return 'invalid_child_request';
      if (!r) {
        if (p.ordinal !== 1 || !fresh(p.child_task_id, p.request_id, p.evidence_id)
          || ['prior_child_execution_id', 'checkpoint_artifact_id', 'answer_evidence_id', 'answer_artifact_id'].some(key => p[key] !== null)) return 'invalid_child_request';
      } else if (!r.answer || r.result?.status !== 'needs_human' || !r.collection || p.child_task_id !== r.child_task_id
        || p.prior_child_execution_id !== r.assignment.child_execution_id || p.checkpoint_artifact_id !== r.result.checkpoint_artifact_id
        || p.answer_evidence_id !== r.answer.evidence_id || p.answer_artifact_id !== r.answer.answer_artifact_id) return 'child_resume_evidence_required';
      reserve(p.request_id, p.child_task_id); c.requests.push({ ...clone(p), assignment: null, result: null, collection: null,
        answer: null, recovery: null, conflicts: [], integration: null }); c.human_task = null;
      result.wait_reason = 'child_assignment_pending'; add(step, p); return '';
    }
    if (event.type === 'child_assignment') {
      if (step.state !== 'RUNNING' || c.status !== 'RUNNING' || !r || r.assignment || p.actor !== 'mock:system'
        || !['request_id', 'child_task_id', 'workspace_id'].every(key => p[key] === r[key])
        || !fresh(p.child_execution_id, p.evidence_id) || !transitionAllowed(step.state, 'WAITING_AGENT')) return 'invalid_child_assignment';
      r.assignment = clone(p); reserve(p.child_execution_id); c.status = 'WAITING_AGENT'; step.state = 'WAITING_AGENT';
      result.status = 'RUNNING'; result.wait_reason = 'child_execution_pending'; add(step, p); return '';
    }
    if (!sameChild(p, r)) return 'child_execution_mismatch';
    if (event.type === 'child_result') {
      if (step.state !== 'WAITING_AGENT' || c.status !== 'WAITING_AGENT' || r.result || p.actor !== 'mock:tc'
        || !['request_id', 'child_task_id', 'workspace_id', 'output_schema_ref'].every(key => p[key] === r[key])
        || p.production_hash !== c.context.production_hash || !time(p.started_at_ms) || !time(p.finished_at_ms)
        || p.finished_at_ms < p.started_at_ms || !['completed', 'needs_human', 'failed', 'canceled', 'interrupted'].includes(p.status)) return 'invalid_child_result';
      if (p.status === 'completed') {
        if (!mockId(p.patch_artifact_id) || !paths(p.changed_path_refs) || p.question_id !== null
          || p.checkpoint_artifact_id !== null || p.failure_class !== null) return 'invalid_child_result';
      } else {
        if (p.patch_artifact_id !== null || !Array.isArray(p.changed_path_refs) || p.changed_path_refs.length) return 'invalid_child_result';
        if (p.status === 'needs_human') {
          if (!mockId(p.question_id) || !mockId(p.checkpoint_artifact_id) || p.failure_class !== null) return 'invalid_child_result';
        } else if (p.question_id !== null || p.checkpoint_artifact_id !== null
          || p.failure_class !== (p.status === 'failed' ? 'agent_failure' : p.status)) return 'invalid_child_result';
      }
      // Validate derived task IDs before accepting immutable terminal results.
      if (['needs_human', 'canceled', 'interrupted'].includes(p.status)
        && !mockId(`mock:child-${p.status === 'needs_human' ? 'human' : 'recovery'}:${p.child_execution_id}`)) return 'invalid_child_task_id';
      r.result = clone(p); add(step, p);
      if (!reconciles() && p.status === 'needs_human') { result.status = 'WAITING_HUMAN'; result.wait_reason = 'child_question_collection_pending'; }
      return '';
    }
    if (event.type === 'child_collect') {
      if (step.state !== 'WAITING_AGENT' || c.status !== 'WAITING_AGENT' || !r.result || r.collection || p.actor !== 'mock:code-dev'
        || p.result_evidence_id !== r.result.evidence_id) return 'invalid_child_collection';
      const human = ['needs_human', 'canceled', 'interrupted'].includes(r.result.status);
      const next = human ? 'WAITING_HUMAN' : 'RUNNING';
      if (!transitionAllowed(step.state, next)) return 'illegal_transition';
      r.collection = clone(p); c.status = next; step.state = next; result.status = human ? 'WAITING_HUMAN' : 'RUNNING';
      if (human) {
        const question = r.result.status === 'needs_human';
        c.human_task = { task_id: `mock:child-${question ? 'human' : 'recovery'}:${p.child_execution_id}`,
          kind: question ? 'agent_question' : 'agent_recovery', assignee: 'mock:human', child_execution_id: p.child_execution_id };
        result.wait_reason = question ? 'child_answer_required' : 'child_recovery_required';
      } else result.wait_reason = r.result.status === 'completed' ? 'child_integration_required' : 'child_infrastructure_recovery_required';
      add(step, p); return '';
    }
    if (['child_answer', 'child_recovery'].includes(event.type)) {
      const answer = event.type === 'child_answer';
      if (step.state !== 'WAITING_HUMAN' || c.status !== 'WAITING_HUMAN' || !r.collection || !c.human_task
        || p.actor !== c.human_task.assignee || p.task_id !== c.human_task.task_id
        || c.human_task.kind !== (answer ? 'agent_question' : 'agent_recovery') || (answer ? r.answer : r.recovery)) return 'invalid_child_human_proof';
      if (answer) {
        if (p.question_id !== r.result.question_id || p.checkpoint_artifact_id !== r.result.checkpoint_artifact_id
          || !mockId(p.answer_artifact_id)) return 'invalid_child_answer';
        r.answer = clone(p);
      } else {
        if (p.result_evidence_id !== r.result.evidence_id || p.action !== 'retry' || !mockId(p.reason_id)) return 'invalid_child_recovery';
        r.recovery = clone(p);
      }
      add(step, p); return '';
    }
    if (event.type === 'child_integrated') {
      if (step.state !== 'RUNNING' || c.status !== 'RUNNING' || r.result?.status !== 'completed' || !r.collection || r.integration
        || p.actor !== 'mock:code-dev' || p.result_evidence_id !== r.result.evidence_id || p.patch_artifact_id !== r.result.patch_artifact_id
        || p.production_hash_before !== c.context.production_hash || p.production_hash_after !== c.context.production_hash
        || !paths(p.changed_path_refs) || JSON.stringify(p.changed_path_refs) !== JSON.stringify(r.result.changed_path_refs)
        || p.expectations_changed !== false || !['conflict', 'integrated'].includes(p.outcome)
        || (p.outcome === 'conflict' ? p.integration_artifact_id !== null : !mockId(p.integration_artifact_id))) return 'invalid_child_integration';
      if (p.outcome === 'conflict') { r.conflicts.push(clone(p)); result.wait_reason = 'child_integration_conflict'; }
      else { r.integration = clone(p); c.status = 'COMPLETED'; result.wait_reason = ''; }
      add(step, p); return '';
    }
    return 'unknown_type';
  }
  function successGuard(node, step) {
    if (node.id !== 'P12') return '';
    const c = step.child_coordination, r = tail(c);
    return current(c) && c.status === 'COMPLETED' && r?.integration && r.result?.status === 'completed' && r.collection
      ? '' : 'child_integration_required';
  }
  function afterStep(step, state) {
    const c = step.child_coordination;
    if (!c) return;
    if (state === 'RUNNING' && answered(c)) c.status = 'RUNNING';
    if (state === 'READY') { result.status = 'RUNNING'; result.wait_reason = 'child_human_resume_ready'; }
  }
  function afterInfrastructureError(step) {
    if (!step.child_coordination) return;
    step.child_coordination.status = 'FAILED';
    if (step.state === 'WAITING_HUMAN') result.failure_bundle.push({ step_id: 'P12', cycle: result.cycle, attempt: step.attempt,
      evidence_id: tail(step.child_coordination)?.result?.evidence_id ?? step.child_coordination.context.evidence_id });
  }
  return { apply, blockingReason, successGuard, afterStep, afterInfrastructureError };
}
