// Pure synthetic exception observations; never issues queries or commands.
export function createExceptionProtocols({ result, transitionAllowed, mockId, releaseMatches }) {
  const questionIds = new Set();
  const specEvidenceIds = new Set();
  const versions = new Set([result.requirements_version]);
  let ordinal = 0;
  const currentQuestion = step => result.spec_review?.cycle === result.cycle
    && result.spec_review.attempt === step.attempt && result.spec_review.execution_id === step.execution_id
    ? result.spec_review : null;
  const currentRemote = step => result.remote_reconciliation?.cycle === result.cycle
    && result.remote_reconciliation.attempt === step.attempt && result.remote_reconciliation.execution_id === step.execution_id
    ? result.remote_reconciliation : null;
  const addEvidence = (step, id) => { if (!step.evidence_ids.includes(id)) step.evidence_ids.push(id); };
  const types = new Set(['spec_unresolved', 'spec_resolution', 'spec_reviewed', 'remote_unknown', 'remote_reconcile']);
  function blockingReason(event, node, step) {
    const question = node.id === 'P03' ? currentQuestion(step) : null;
    if (question && !question.resolved && !['spec_resolution', 'spec_unresolved', 'agent', 'device'].includes(event.type)) return 'spec_resolution_required';
    const remote = node.id === 'P25' ? currentRemote(step) : null;
    if (remote && step.state === 'RECONCILING' && !['remote_reconcile', 'agent', 'device'].includes(event.type)) return 'remote_reconciliation_required';
    return '';
  }
  function apply(event, node, step) {
    if (!types.has(event.type)) return null;
    if (result.device?.quarantined) return 'reconciliation_required';
    const p = event.payload;
    if (event.type === 'spec_unresolved') {
      const previous = currentQuestion(step);
      if (node.id !== 'P03' || step.state !== 'RUNNING' || previous && !previous.resolved
          || !transitionAllowed(step.state, 'WAITING_HUMAN')) return 'invalid_spec_question';
      if (!mockId(p.question_id) || questionIds.has(p.question_id) || !mockId(p.evidence_id) || specEvidenceIds.has(p.evidence_id)
          || p.candidate_fingerprint !== result.candidate_fingerprint
          || p.requirements_version !== result.requirements_version) return 'invalid_spec_question_evidence';
      if (result.spec_review) result.history.push({ kind: 'spec_question', cycle: result.spec_review.cycle,
        step_id: 'P03', spec_review: structuredClone(result.spec_review) });
      questionIds.add(p.question_id); specEvidenceIds.add(p.evidence_id); ordinal++;
      result.spec_review = { question_id: p.question_id, task_id: `mock:task:P03:c${result.cycle}:a${step.attempt}:q${ordinal}`,
        ordinal, cycle: result.cycle, attempt: step.attempt, execution_id: step.execution_id,
        candidate_fingerprint: result.candidate_fingerprint, requirements_version: result.requirements_version,
        question_evidence_id: p.evidence_id, resolved_requirements_version: null,
        resolution_evidence_id: null, review_evidence_id: null, review_attempt: null, review_execution_id: null, resolved: false, reviewed: false };
      step.state = 'WAITING_HUMAN'; addEvidence(step, p.evidence_id);
      result.status = 'WAITING_HUMAN'; result.wait_reason = 'spec_resolution_required';
      return '';
    }
    if (event.type === 'spec_resolution') {
      const question = currentQuestion(step);
      if (node.id !== 'P03' || step.state !== 'WAITING_HUMAN' || !question || question.resolved
          || !transitionAllowed(step.state, 'READY')) return 'invalid_spec_resolution';
      if (p.actor !== 'mock:human' || p.question_id !== question.question_id || p.task_id !== question.task_id
          || p.plan_version !== 'mock:plan:v1' || p.candidate_fingerprint !== result.candidate_fingerprint
          || p.candidate_fingerprint !== question.candidate_fingerprint
          || p.requirements_version !== question.requirements_version || p.requirements_version !== result.requirements_version
          || !mockId(p.resolved_requirements_version) || versions.has(p.resolved_requirements_version)
          || p.complete !== true || !mockId(p.evidence_id) || specEvidenceIds.has(p.evidence_id)) return 'invalid_spec_resolution_evidence';
      specEvidenceIds.add(p.evidence_id); versions.add(p.resolved_requirements_version); result.requirements_version = p.resolved_requirements_version;
      question.resolved = true; question.resolved_requirements_version = p.resolved_requirements_version;
      question.resolution_evidence_id = p.evidence_id; addEvidence(step, p.evidence_id);
      step.state = 'READY'; step.agent_status = 'idle'; result.status = 'RUNNING'; result.wait_reason = '';
      return '';
    }
    if (event.type === 'spec_reviewed') {
      // The answer is durable. Review proof is specific to the current execution.
      const question = result.spec_review;
      if (node.id !== 'P03' || step.state !== 'RUNNING' || !question?.resolved || question.cycle !== result.cycle
          || question.candidate_fingerprint !== result.candidate_fingerprint
          || question.reviewed && question.review_attempt === step.attempt && question.review_execution_id === step.execution_id
          || p.actor !== 'mock:spec-gen' || p.candidate_fingerprint !== result.candidate_fingerprint
          || p.requirements_version !== question.resolved_requirements_version || p.requirements_version !== result.requirements_version
          || !mockId(p.evidence_id) || specEvidenceIds.has(p.evidence_id)) return 'invalid_spec_review';
      if (question.reviewed) result.history.push({ kind: 'spec_review_attempt', cycle: question.cycle,
        step_id: 'P03', spec_review: structuredClone(question) });
      question.reviewed = true; question.review_evidence_id = p.evidence_id;
      question.review_attempt = step.attempt; question.review_execution_id = step.execution_id;
      specEvidenceIds.add(p.evidence_id);
      step.agent_status = 'completed'; addEvidence(step, p.evidence_id);
      return '';
    }
    if (event.type === 'remote_unknown') {
      if (node.id !== 'P25' || step.state !== 'RUNNING' || !result.release.approved || !releaseMatches(p)
          || !mockId(p.operation_key) || !mockId(p.evidence_id) || step.evidence_ids.includes(p.evidence_id)
          || !transitionAllowed(step.state, 'RECONCILING')) return 'invalid_remote_unknown';
      result.remote_reconciliation = { operation_key: p.operation_key, manifest_id: p.manifest_id,
        digest: p.digest, candidate_fingerprint: p.candidate_fingerprint,
        cycle: result.cycle, attempt: step.attempt, execution_id: step.execution_id,
        query_seq: 0, outcome: 'unknown', observations: [{ outcome: 'unknown', evidence_id: p.evidence_id, query_seq: 0 }] };
      step.state = 'RECONCILING'; addEvidence(step, p.evidence_id);
      result.status = 'RECONCILING'; result.wait_reason = 'remote_reconciliation_required';
      return '';
    }
    const remote = currentRemote(step);
    if (node.id !== 'P25' || step.state !== 'RECONCILING' || !remote || !result.release.approved
        || !releaseMatches(p) || p.operation_key !== remote.operation_key || p.manifest_id !== remote.manifest_id
        || p.digest !== remote.digest || p.candidate_fingerprint !== remote.candidate_fingerprint
        || !mockId(p.evidence_id) || step.evidence_ids.includes(p.evidence_id) || !['found', 'unknown', 'absent', 'conflict'].includes(p.outcome)) return 'invalid_remote_reconciliation';
    if (!Number.isSafeInteger(p.query_seq) || p.query_seq <= remote.query_seq) return 'stale_remote_query';
    if (p.outcome === 'found') {
      if (!mockId(p.receipt_id) || result.release.receipt_id && result.release.receipt_id !== p.receipt_id
          || result.release.publication_count !== 0 || !transitionAllowed(step.state, 'SUCCEEDED')) return 'invalid_remote_receipt';
      result.release.receipt_id = p.receipt_id; result.release.publication_count = 1;
      addEvidence(step, p.receipt_id); step.state = 'SUCCEEDED';
      result.current_step = 'P26'; result.status = 'RUNNING'; result.wait_reason = '';
    } else {
      if (Object.hasOwn(p, 'receipt_id')) return 'unexpected_remote_receipt';
      result.status = 'RECONCILING'; result.wait_reason = p.outcome === 'unknown'
        ? 'remote_reconciliation_required' : `remote_${p.outcome}_requires_human`;
    }
    remote.query_seq = p.query_seq; remote.outcome = p.outcome;
    remote.observations.push({ outcome: p.outcome, evidence_id: p.evidence_id, query_seq: p.query_seq });
    addEvidence(step, p.evidence_id);
    return '';
  }
  function successGuard(node, step) {
    if (node.id !== 'P03') return '';
    const question = result.spec_review?.cycle === result.cycle ? result.spec_review : null;
    return question && (!question.resolved || !question.reviewed
      || question.review_attempt !== step.attempt || question.review_execution_id !== step.execution_id
      || question.resolved_requirements_version !== result.requirements_version) ? 'spec_review_required' : '';
  }
  return { apply, blockingReason, successGuard };
}
