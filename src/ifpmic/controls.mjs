// Synthetic job-control observations only. No API writes, timers, dispatch or runtime signals.
const clone = value => structuredClone(value);
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const time = value => Number.isSafeInteger(value) && value >= 0;
export const controlPayloadFields = Object.freeze(Object.fromEntries(Object.entries({
  control_submitted: ['command_id', 'actor', 'route', 'idempotency_key', 'authorization_ref', 'csrf_ref', 'body'],
  control_apply: ['command_id', 'actor', 'observed_now_ms', 'evidence_id'],
  control_pause_ack: ['command_id', 'actor', 'fence_id', 'drained_request_ids', 'evidence_id'],
  control_execution_end: ['actor', 'control_command_id', 'kind', 'step_id', 'cycle', 'attempt', 'step_execution_id', 'agent_execution_id', 'status', 'prior_result_evidence_id', 'evidence_id'],
  control_cancel_boundary: ['command_id', 'actor', 'fence_id', 'drained_request_ids', 'execution_result_ids', 'bridge_reconciliation_ids', 'bridge_release_ids', 'remote_terminal_ids', 'evidence_id'],
  control_cancel_complete: ['command_id', 'actor', 'boundary_evidence_id', 'evidence_id'],
  bridge_registered: ['actor', 'command', 'step_execution_id', 'candidate_fingerprint', 'requirements_version', 'evidence_id'],
  bridge_observed: ['actor', 'command_id', 'lease_id', 'fencing_token', 'bridge_id', 'device_id', 'sequence', 'state', 'observed_mode', 'device_identity', 'exit_code', 'stdout_artifact_id', 'stderr_artifact_id', 'test_result_artifact_id', 'image_identity', 'started_at', 'finished_at', 'evidence_id'],
  bridge_reconciled: ['actor', 'command_id', 'lease_id', 'fencing_token', 'bridge_id', 'device_id', 'result_evidence_id', 'query_seq', 'safe_boundary', 'observed_mode', 'device_identity', 'os_lock_held', 'evidence_id'],
  bridge_released: ['actor', 'command_id', 'lease_id', 'fencing_token', 'reconciliation_evidence_id', 'os_lock_released', 'lease_released', 'evidence_id'],
  remote_intent: ['actor', 'operation_key', 'manifest_id', 'digest', 'candidate_fingerprint', 'rule_version', 'destination', 'step_id', 'cycle', 'attempt', 'execution_id', 'evidence_id'],
  remote_observed: ['actor', 'operation_key', 'query_seq', 'outcome', 'manifest_id', 'digest', 'candidate_fingerprint', 'cycle', 'attempt', 'execution_id', 'receipt_id', 'evidence_id'],
  remote_terminal: ['actor', 'operation_key', 'manifest_id', 'digest', 'candidate_fingerprint', 'cycle', 'attempt', 'execution_id', 'query_evidence_id', 'provider_state', 'receipt_id', 'safe_boundary', 'evidence_id'],
}).map(([type, keys]) => [type, Object.freeze(keys)])));

export function newControlRecord() {
  return { phase: null, admission_open: true, commands: [], applied_command_ids: [],
    command_id: null, pause_anchor: null, resume_step: null, resume_state: null,
    underlying_status: 'RUNNING', underlying_wait_reason: '', reconciliation_required: false,
    fence: null, executions: [], pending_request_ids: [], execution_ends: [],
    bridges: [], remotes: [], facts: [], boundary: null };
}

// Fixed domain DTO: inbox receipt status and event diagnostics are deliberately excluded.
export function controlDomainProjection(result) {
  const c = result.control;
  return {
    status: c.underlying_status, wait_reason: c.underlying_wait_reason,
    current_step: result.current_step, cycle: result.cycle, rework_count: result.rework_count,
    candidate_fingerprint: result.candidate_fingerprint, requirements_version: result.requirements_version,
    rule_version: result.rule_version, steps: result.steps, history: result.history,
    release: result.release, device: result.device, spec_review: result.spec_review,
    remote_reconciliation: result.remote_reconciliation, route_plan: result.route_plan,
    no_change: result.no_change, required_revalidation: result.required_revalidation, failure_bundle: result.failure_bundle,
    control: { phase: c.phase, admission_open: c.admission_open, applied_command_ids: c.applied_command_ids,
      command_id: c.command_id, pause_anchor: c.pause_anchor, resume_step: c.resume_step, resume_state: c.resume_state,
      reconciliation_required: c.reconciliation_required, fence: c.fence, executions: c.executions,
      pending_request_ids: c.pending_request_ids, execution_ends: c.execution_ends, bridges: c.bridges,
      remotes: c.remotes, facts: c.facts, boundary: c.boundary },
  };
}

export function createControlProtocols({ result, mockId, delegateRetry }) {
  const c = result.control;
  const evidenceIds = new Set();
  let priorDomain = JSON.stringify(controlDomainProjection(result));
  const fresh = id => mockId(id) && !evidenceIds.has(id)
    && !Object.values(result.steps).some(step => step.evidence_ids.includes(id));
  const sameBody = (a, b) => ['expected_revision', 'action', 'reason'].every(key => a[key] === b[key]);
  const command = id => c.commands.find(entry => entry.command_id === id);
  const current = () => result.steps[result.current_step];
  const pending = () => {
    const child = current()?.child_coordination;
    return child ? child.requests.filter(request => !request.assignment).map(request => request.request_id) : [];
  };
  const exactSet = (value, expected) => Array.isArray(value) && value.every(mockId)
    && new Set(value).size === value.length && value.length === expected.length && expected.every(id => value.includes(id));
  const coordinates = step => ({ step_id: result.current_step, cycle: result.cycle, attempt: step.attempt, step_execution_id: step.execution_id });
  function anchor() {
    const step = current(), executions = [], child = step?.child_coordination;
    if (step?.state === 'RUNNING' && result.current_step !== 'P12') {
      executions.push({ ...coordinates(step), kind: 'logical', agent_execution_id: step.execution_id });
    }
    if (result.current_step === 'P12' && child) {
      if (['RUNNING', 'WAITING_AGENT', 'WAITING_HUMAN', 'READY'].includes(step.state)
          && !['COMPLETED', 'FAILED'].includes(child.status)) executions.push({ ...coordinates(step), kind: 'coordinator', agent_execution_id: child.context.coordinator_execution_id });
      for (const request of child.requests) if (request.assignment) executions.push({ ...coordinates(step), kind: 'child', agent_execution_id: request.assignment.child_execution_id });
    }
    return { step_id: result.current_step, cycle: result.cycle, attempt: step?.attempt ?? null,
      execution_id: step?.execution_id ?? null, candidate_fingerprint: result.candidate_fingerprint,
      requirements_version: result.requirements_version, executions, pending_request_ids: pending(),
      bridge_ids: c.bridges.map(entry => entry.command.command_id), remote_keys: c.remotes.map(entry => entry.operation_key) };
  }
  function ineligible(entry) {
    const action = entry.body.action;
    if (result.status === 'NO_CHANGE') return true;
    if (c.phase === 'CANCELED') return action !== 'cancel';
    if (action === 'resume') return c.phase !== 'PAUSED' || result.device?.quarantined
      || result.status === 'RECONCILING' || c.reconciliation_required;
    if (result.status === 'COMPLETED') return true;
    if (action === 'cancel') return false;
    if (!c.admission_open || c.reconciliation_required) return true;
    if (action === 'pause') return false;
    const step = current();
    return result.status === 'RECONCILING' || result.device?.quarantined
      || !step || !(step.state === 'WAITING_RETRY' && step.infrastructure_error
        || result.current_step === 'P26' && step.state === 'FAILED' && step.notes_failure
          && result.status === 'RELEASED_PENDING_NOTES');
  }
  function reject(entry, code) {
    entry.status = 'rejected'; entry.error = { code, message: code === 'REVISION_CONFLICT'
      ? 'Expected revision does not match.' : 'Control is not eligible.', trace_id: entry.command_id };
    return '';
  }
  function apply(event) {
    const p = event.payload;
    if (!shape(p, controlPayloadFields[event.type])) return 'invalid_control_payload';
    if (event.type === 'control_submitted') {
      if (!mockId(p.command_id) || p.actor !== 'mock:human' || p.route !== `/jobs/${result.job_id}/controls`
          || !mockId(p.idempotency_key) || p.authorization_ref !== 'mock:authorization:owner-control:v1'
          || p.csrf_ref !== 'mock:csrf:validated:v1' || !shape(p.body, ['expected_revision', 'action', 'reason'])
          || !time(p.body.expected_revision) || !['pause', 'resume', 'cancel', 'retry'].includes(p.body.action)
          || !mockId(p.body.reason)) return 'invalid_control_submission';
      const existing = c.commands.find(entry => entry.actor === p.actor && entry.route === p.route && entry.idempotency_key === p.idempotency_key);
      if (existing) {
        if (!sameBody(existing.body, p.body)) return 'control_idempotency_conflict';
        return existing.command_id === p.command_id ? '' : 'control_command_alias_conflict';
      }
      if (command(p.command_id)) return 'control_command_id_conflict';
      c.commands.push({ ...clone(p), status: 'accepted', resource_id: result.job_id, applied_revision: null, error: null, decision: null });
      return '';
    }
    if (event.type === 'control_apply') {
      const entry = command(p.command_id);
      if (p.actor !== 'mock:system' || !entry || !time(p.observed_now_ms) || !mockId(p.evidence_id)) return 'invalid_control_application';
      if (entry.status !== 'accepted') return '';
      if (!fresh(p.evidence_id)) return 'invalid_control_application';
      entry.decision = { evidence_id: p.evidence_id, observed_now_ms: p.observed_now_ms };
      if (entry.body.expected_revision !== result.revision) return reject(entry, 'REVISION_CONFLICT');
      if (ineligible(entry)) return reject(entry, 'CONTROL_INELIGIBLE');
      const action = entry.body.action;
      if (action === 'retry') {
        const retryResult = delegateRetry(p.observed_now_ms, p.evidence_id);
        if (retryResult) return reject(entry, 'CONTROL_INELIGIBLE');
      } else if (action === 'pause' || action === 'cancel' && c.phase !== 'CANCELED') {
        c.pause_anchor = anchor(); c.executions = clone(c.pause_anchor.executions);
        c.pending_request_ids = [...c.pause_anchor.pending_request_ids];
        c.phase = action === 'pause' ? 'PAUSE_REQUESTED' : 'CANCEL_REQUESTED';
        c.admission_open = false; c.command_id = entry.command_id; c.fence = null; c.boundary = null;
        c.execution_ends = [];
      } else if (action === 'resume') {
        c.phase = null; c.admission_open = true; c.command_id = null; c.fence = null;
      }
      evidenceIds.add(p.evidence_id);
      c.applied_command_ids.push(entry.command_id); entry.status = 'applied'; entry.applied_revision = result.revision + 1;
      return '';
    }
    if (event.type === 'control_pause_ack') {
      if (p.actor !== 'mock:system' || c.phase !== 'PAUSE_REQUESTED' || p.command_id !== c.command_id
          || !fresh(p.evidence_id) || !mockId(p.fence_id) || !exactSet(p.drained_request_ids, c.pending_request_ids)) return 'invalid_pause_ack';
      c.fence = clone(p); c.phase = 'PAUSED'; evidenceIds.add(p.evidence_id); return '';
    }
    // Remaining K3 protocols are deliberately not inferred from generic status telemetry.
    return 'control_protocol_not_implemented';
  }
  function admissionReason(event) {
    if (c.admission_open) return '';
    if (['CANCEL_REQUESTED', 'QUIESCENT', 'CANCELED'].includes(c.phase)) return 'control_cancel_admission_closed';
    // Permit only observations of work/tasks admitted at the pause boundary.
    const a = c.pause_anchor;
    if (!a || event.step_id !== a.step_id || event.cycle !== a.cycle || event.attempt !== a.attempt
        || event.execution_id !== a.execution_id) return 'control_pause_admission_closed';
    const allowed = new Set(['agent', 'human', 'measurement', 'device', 'business_failure', 'infra_error',
      'receipt', 'notes_failure', 'spec_resolution', 'spec_reviewed', 'remote_unknown', 'remote_reconcile',
      'child_result', 'child_collect', 'child_answer', 'child_recovery', 'sqe_result', 'sqe_report', 'approval']);
    if (allowed.has(event.type)) return '';
    if (event.type === 'step' && ['SUCCEEDED', 'FAILED', 'WAITING_HUMAN', 'WAITING_DEVICE', 'WAITING_RETRY'].includes(event.payload.state)) return '';
    if (event.type === 'step' && event.payload.state === 'READY' && current()?.state === 'WAITING_HUMAN') return '';
    return 'control_pause_admission_closed';
  }
  function beforeEvent() {
    result.status = c.underlying_status; result.wait_reason = c.underlying_wait_reason;
  }
  function afterEvent(accepted, event) {
    c.underlying_status = result.status; c.underlying_wait_reason = result.wait_reason;
    if (!c.admission_open) {
      c.resume_step = result.current_step; c.resume_state = current()?.state ?? null;
      if (c.phase === 'CANCELED') { result.status = 'CANCELED'; result.wait_reason = 'job_canceled'; }
      else if (['CANCEL_REQUESTED', 'QUIESCENT'].includes(c.phase) || c.reconciliation_required || result.device?.quarantined) {
        result.status = 'RECONCILING'; result.wait_reason = 'control_reconciliation_required';
      } else if (['WAITING_HUMAN', 'WAITING_DEVICE', 'RECONCILING'].includes(c.underlying_status)) {
        result.status = c.underlying_status;
      } else if (c.phase === 'PAUSE_REQUESTED') {
        result.status = 'RECONCILING'; result.wait_reason = 'pause_fence_pending';
      } else { result.status = 'PAUSED'; result.wait_reason = 'job_paused'; }
    }
    if (accepted) {
      for (const id of [event?.payload?.evidence_id, event?.payload?.evidence?.evidence_id, event?.payload?.receipt_id]) {
        if (mockId(id)) evidenceIds.add(id);
      }
      const next = JSON.stringify(controlDomainProjection(result));
      if (next !== priorDomain) result.revision++;
      priorDomain = next;
    }
  }
  return { apply, admissionReason, beforeEvent, afterEvent };
}
