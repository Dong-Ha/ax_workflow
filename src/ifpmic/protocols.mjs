// Synthetic observation protocols. No command execution, allocation or publication.
export function newStepRecord(id, cycle, attempt = 1, state = 'PENDING') {
  return {
    state, cycle, agent_status: 'idle', gate_verdict: null, gate_complete: false,
    gate_candidate_fingerprint: null, gate_rule_version: null, gate_evidence_id: null,
    attempt, execution_id: `mock:${id}:c${cycle}:a${attempt}`, evidence_ids: [],
    failure_evidence_id: null, failure_candidate_fingerprint: null, failure_outcome: null,
    retry_due_ms: null, infrastructure_error: false, skip_basis: null, unchanged_analysis: null, exemption_report: null,
  };
}

export function mockHumanTaskId(id, cycle, attempt) {
  return `mock:task:${id}:c${cycle}${attempt === 1 ? '' : `:a${attempt}`}`;
}

export function createObservationProtocols({ result, graph, submissions, transitionAllowed, mockId, policy, exemptionCurrent = () => false, expectedPlanVersion = () => 'mock:plan:v1' }) {
  const passRoutes = new Map(graph.edges.filter(edge => edge.kind === 'pass').map(edge => [edge.from, edge.to]));
  const gateIds = ['P16', 'P18', 'P20', 'P24'];
  const digestBindings = new Map();
  const manifestBindings = new Map();
  let clock = -1;
  const integerTime = value => Number.isSafeInteger(value) && value >= 0;
  const snapshot = value => structuredClone(value);
  const archiveAttempt = (node, step) => result.history.push({ kind: 'attempt', cycle: result.cycle, step_id: node.id, step: snapshot(step) });
  const currentGates = () => gateIds.every(id => {
    const step = result.steps[id];
    return exemptionCurrent(id) || step.state === 'SUCCEEDED' && step.cycle === result.cycle && step.gate_verdict === 'PASS'
      && step.gate_complete && step.gate_candidate_fingerprint === result.candidate_fingerprint
      && step.gate_rule_version === result.rule_version && mockId(step.gate_evidence_id);
  });
  const releaseCurrent = () => result.release.manifest && currentGates()
    && result.release.manifest.cycle === result.cycle
    && result.release.manifest.candidate_fingerprint === result.candidate_fingerprint
    && result.release.manifest.rule_version === result.rule_version
    && result.release.manifest.attempt === result.steps.X02.attempt
    && result.release.manifest.execution_id === result.steps.X02.execution_id
    && gateIds.every((id, index) => result.steps[id].gate_evidence_id === result.release.manifest.gate_evidence_ids[index]
      && result.steps[id].gate_verdict === result.release.manifest.gate_dispositions[index]);
  const manifestMatches = payload => releaseCurrent()
    && payload.manifest_id === result.release.manifest.manifest_id
    && payload.digest === result.release.manifest.digest
    && payload.candidate_fingerprint === result.candidate_fingerprint;
  const resetRelease = () => {
    result.release.manifest = null; result.release.approved = false;
    result.release.receipt_id = null; result.release.rejection = null;
  };
  const currentSubmission = (node, step) => {
    const submission = submissions.get(node.id);
    return submission?.execution_id === step.execution_id && submission.cycle === result.cycle
      && submission.attempt === step.attempt ? submission : null;
  };
  function failureOutcome(node, step) {
    if (node.owner === 'human') {
      const decision = currentSubmission(node, step)?.decision;
      if (node.id === 'X01' && decision === 'reject') return 'rejected';
      if (node.id === 'P21' && decision === 'reject') return 'business_fail';
      if (node.id === 'P21' && decision === 'design_change_needed') return decision;
      if (node.id === 'X03' && ['reject_code', 'reject_design', 'reject_release_metadata'].includes(decision)) return decision;
      return null;
    }
    return graph.edges.some(edge => edge.from === node.id && edge.kind === 'business_fail') ? 'business_fail' : null;
  }
  function routeEdge(node, outcome) {
    return graph.edges.find(edge => edge.from === node.id && (outcome === 'business_fail'
      ? edge.kind === 'business_fail' : edge.kind === 'special' && edge.outcome === outcome));
  }
  const protocolTypes = new Set(['business_failure', 'route', 'infra_error', 'retry', 'candidate',
    'manifest', 'approval', 'receipt', 'notes_failure', 'notes_retry']);

  function apply(event, node, step) {
    if (!protocolTypes.has(event.type)) return null;
    if (result.device?.quarantined) return 'reconciliation_required';
    const payload = event.payload;
    if (event.type === 'business_failure') {
      const outcome = failureOutcome(node, step);
      if (!outcome || !routeEdge(node, outcome) || !transitionAllowed(step.state, 'FAILED')) return 'invalid_business_failure';
      if (payload.candidate_fingerprint !== result.candidate_fingerprint || !mockId(payload.evidence_id)) return 'stale_failure_evidence';
      if (node.owner === 'system' && (step.gate_verdict !== 'FAIL' || !step.gate_complete
          || step.gate_evidence_id !== payload.evidence_id || step.gate_candidate_fingerprint !== result.candidate_fingerprint
          || step.gate_rule_version !== result.rule_version)) return 'gate_fail_required';
      if (node.owner === 'human' && (currentSubmission(node, step)?.evidence_id !== payload.evidence_id
          || currentSubmission(node, step)?.candidate_fingerprint !== result.candidate_fingerprint)) return 'negative_human_decision_required';
      if (!['human', 'system'].includes(node.owner) && !['P13', 'P14'].includes(node.id)) return 'invalid_business_failure';
      step.state = 'FAILED'; step.failure_evidence_id = payload.evidence_id;
      step.failure_candidate_fingerprint = result.candidate_fingerprint; step.failure_outcome = outcome;
      if (!step.evidence_ids.includes(payload.evidence_id)) step.evidence_ids.push(payload.evidence_id);
      result.status = 'FAILED'; result.wait_reason = 'business_failure';
      return '';
    }
    if (event.type === 'route') {
      const edge = routeEdge(node, payload.outcome);
      if (step.state !== 'FAILED' || !edge || edge.to !== payload.target
          || step.failure_outcome !== payload.outcome || !mockId(step.failure_evidence_id)
          || payload.evidence_id !== step.failure_evidence_id
          || payload.candidate_fingerprint !== result.candidate_fingerprint
          || step.failure_candidate_fingerprint !== result.candidate_fingerprint) return 'invalid_failure_route';
      if (result.rework_count >= policy.business_rework_cycles) {
        result.status = 'WAITING_HUMAN'; result.wait_reason = 'business_rework_limit';
        if (!result.failure_bundle.some(item => item.cycle === result.cycle && item.step_id === node.id && item.attempt === step.attempt)) {
          result.failure_bundle.push({ step_id: node.id, cycle: result.cycle, attempt: step.attempt, evidence_id: step.failure_evidence_id });
        }
        return '';
      }
      if (node.id === 'X03' && payload.outcome === 'reject_release_metadata') {
        if (!currentGates() || result.release.publication_count !== 0 || result.release.receipt_id
            || result.steps.X02.state !== 'SUCCEEDED'
            || !['P25', 'P26'].every(id => result.steps[id].state === 'PENDING')
            || !['X02', 'X03'].every(id => Number.isSafeInteger(result.steps[id].attempt + 1))) return 'invalid_metadata_recovery';
        result.history.push({ kind: 'release_metadata', cycle: result.cycle,
          candidate_fingerprint: result.candidate_fingerprint, release: snapshot(result.release) });
        for (const id of ['X02', 'X03']) {
          const old = result.steps[id];
          archiveAttempt({ id }, old);
          result.steps[id] = newStepRecord(id, result.cycle, old.attempt + 1);
        }
        result.rework_count++; submissions.delete('X03'); resetRelease();
        result.required_revalidation = ['X02', 'X03', 'P25', 'P26'];
        result.current_step = 'X02'; result.status = 'RUNNING'; result.wait_reason = '';
        return '';
      }
      result.history.push({ kind: 'cycle', cycle: result.cycle, candidate_fingerprint: result.candidate_fingerprint, steps: snapshot(result.steps) });
      result.cycle++; result.rework_count++;
      for (const entry of graph.nodes) result.steps[entry.id] = newStepRecord(entry.id, result.cycle);
      submissions.clear(); resetRelease();
      result.required_revalidation = [];
      for (let id = edge.to; id !== 'END'; id = passRoutes.get(id)) result.required_revalidation.push(id);
      result.current_step = edge.to; result.status = 'RUNNING'; result.wait_reason = '';
      return '';
    }
    if (event.type === 'infra_error') {
      if (step.state !== 'RUNNING' || !integerTime(payload.now_ms) || payload.now_ms < clock) return 'invalid_infrastructure_error';
      if (!['agent', 'build', 'metric', 'notes'].includes(payload.operation) || node.id === 'P25'
          || result.device?.operation_state === 'active' || result.device?.operation_state === 'unknown') return 'non_retryable_operation';
      const nextState = step.attempt >= policy.infrastructure_max_attempts ? 'WAITING_HUMAN' : 'WAITING_RETRY';
      if (!transitionAllowed(step.state, nextState)) return 'illegal_transition';
      const due = payload.now_ms + (policy.infrastructure_backoff_seconds[step.attempt - 1] ?? 0) * 1000;
      if (!integerTime(due)) return 'invalid_clock';
      clock = payload.now_ms; step.state = nextState; step.infrastructure_error = true;
      step.retry_due_ms = nextState === 'WAITING_RETRY' ? due : null;
      result.wait_reason = nextState === 'WAITING_RETRY' ? 'infrastructure_backoff' : 'infrastructure_attempt_limit';
      if (nextState === 'WAITING_HUMAN') result.status = 'WAITING_HUMAN';
      return '';
    }
    if (event.type === 'retry') {
      if (!integerTime(payload.now_ms) || payload.now_ms < clock) return 'invalid_clock';
      if (step.state !== 'WAITING_RETRY' || !step.infrastructure_error || step.attempt >= policy.infrastructure_max_attempts
          || payload.now_ms < step.retry_due_ms) return 'retry_not_due';
      if (!transitionAllowed('PENDING', 'READY')) return 'illegal_transition';
      clock = payload.now_ms; archiveAttempt(node, step);
      result.steps[node.id] = newStepRecord(node.id, result.cycle, step.attempt + 1, 'READY');
      submissions.delete(node.id);
      result.status = node.id === 'P26' && result.release.publication_count === 1 ? 'RELEASED_PENDING_NOTES' : 'RUNNING';
      result.wait_reason = '';
      return '';
    }
    if (event.type === 'candidate') {
      if (node.id !== 'P13' || step.state !== 'RUNNING' || !mockId(payload.candidate_fingerprint)) return 'invalid_candidate';
      if (payload.candidate_fingerprint === result.candidate_fingerprint) return '';
      result.history.push({ kind: 'candidate', cycle: result.cycle, candidate_fingerprint: result.candidate_fingerprint, steps: snapshot(result.steps) });
      result.candidate_fingerprint = payload.candidate_fingerprint;
      for (const entry of Object.values(result.steps)) {
        entry.gate_verdict = null; entry.gate_complete = false; entry.gate_candidate_fingerprint = null;
        entry.gate_rule_version = null; entry.gate_evidence_id = null;
      }
      resetRelease();
      return '';
    }
    if (event.type === 'manifest') {
      if (node.id !== 'X02' || step.state !== 'RUNNING' || !currentGates()) return 'release_gates_required';
      if (Object.values(payload).some(value => !mockId(value)) || payload.candidate_fingerprint !== result.candidate_fingerprint
          || payload.rule_version !== result.rule_version) return 'invalid_manifest';
      const fields = ['manifest_id', 'digest', 'candidate_fingerprint', 'rule_version', 'destination', 'notes_hash', 'evidence_bundle'];
      if (fields.some(key => !mockId(payload[key]))) return 'invalid_manifest';
      const binding = { cycle: result.cycle, attempt: step.attempt, execution_id: step.execution_id,
        gate_evidence_ids: gateIds.map(id => result.steps[id].gate_evidence_id),
        gate_dispositions: gateIds.map(id => result.steps[id].gate_verdict) };
      const signature = JSON.stringify([fields.map(key => payload[key]), binding]);
      if ((digestBindings.has(payload.digest) && digestBindings.get(payload.digest) !== signature)
          || (manifestBindings.has(payload.manifest_id) && manifestBindings.get(payload.manifest_id) !== signature)) return 'manifest_binding_conflict';
      digestBindings.set(payload.digest, signature); manifestBindings.set(payload.manifest_id, signature);
      result.release.manifest = Object.fromEntries(fields.map(key => [key, payload[key]]));
      Object.assign(result.release.manifest, binding);
      result.release.approved = false; result.release.rejection = null; result.release.receipt_id = null;
      return '';
    }
    if (event.type === 'approval') {
      if (node.id !== 'X03' || step.state !== 'WAITING_HUMAN' || payload.actor !== 'mock:human'
          || payload.task_id !== mockHumanTaskId(node.id, result.cycle, step.attempt) || payload.plan_version !== expectedPlanVersion()
          || !mockId(payload.evidence_id) || !manifestMatches(payload)
          || !['approve', 'reject_code', 'reject_design', 'reject_release_metadata'].includes(payload.decision)) return 'invalid_release_approval';
      if (submissions.has(node.id)) return 'human_task_already_submitted';
      submissions.set(node.id, { decision: payload.decision, evidence_id: payload.evidence_id,
        candidate_fingerprint: result.candidate_fingerprint, cycle: result.cycle, attempt: step.attempt, execution_id: step.execution_id });
      step.evidence_ids.push(payload.evidence_id);
      result.release.approved = payload.decision === 'approve';
      result.release.rejection = result.release.approved ? null : payload.decision;
      return '';
    }
    if (event.type === 'receipt') {
      if (node.id !== 'P25' || step.state !== 'RUNNING' || !result.release.approved || !manifestMatches(payload)
          || payload.observed !== true || !mockId(payload.receipt_id)) return 'invalid_release_receipt';
      if (result.release.receipt_id || result.release.publication_count !== 0) return 'receipt_already_observed';
      result.release.receipt_id = payload.receipt_id; step.evidence_ids.push(payload.receipt_id);
      return '';
    }
    if (event.type === 'notes_failure') {
      if (node.id !== 'P26' || step.state !== 'RUNNING' || result.release.publication_count !== 1
          || !result.release.receipt_id || !mockId(payload.evidence_id) || !transitionAllowed(step.state, 'FAILED')) return 'invalid_notes_failure';
      step.state = 'FAILED'; step.evidence_ids.push(payload.evidence_id);
      result.status = 'RELEASED_PENDING_NOTES'; result.wait_reason = 'notes_failed';
      return '';
    }
    if (event.type === 'notes_retry') {
      if (node.id !== 'P26' || step.state !== 'FAILED' || result.status !== 'RELEASED_PENDING_NOTES'
          || result.release.publication_count !== 1 || !result.release.receipt_id || !mockId(payload.evidence_id)
          || !transitionAllowed('PENDING', 'READY') || !Number.isSafeInteger(step.attempt + 1)) return 'invalid_notes_retry';
      archiveAttempt(node, step);
      result.steps[node.id] = newStepRecord(node.id, result.cycle, step.attempt + 1, 'READY');
      result.steps[node.id].evidence_ids.push(payload.evidence_id);
      result.wait_reason = '';
      return '';
    }
    return 'unknown_type';
  }

  function successGuard(node) {
    if (node.id === 'X02' && !releaseCurrent()) return 'release_manifest_required';
    if (node.id === 'X03' && (!releaseCurrent() || !result.release.approved)) return 'release_approval_required';
    if (node.id === 'P25' && (!releaseCurrent() || !result.release.approved || !result.release.receipt_id)) return 'release_receipt_required';
    return '';
  }
  return { apply, successGuard, manifestMatches };
}
