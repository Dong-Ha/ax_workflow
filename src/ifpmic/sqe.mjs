// Pure synthetic evidence collection. Never commands a bridge or human or clears device quarantine.
import { mockSqeProfile as profile } from './sqe-profile.mjs';
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const clone = value => structuredClone(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const profileKeys = ['profile_ref', 'profile_version', 'script_version', 'parser_version', 'rule_version'];
const bindingKeys = ['candidate_fingerprint', ...profileKeys, 'device_id', 'bridge_id', 'image_hash'];
const contextKeys = ['actor', ...bindingKeys, 'expected_image_identity', 'evidence_id'];
const requestKeys = ['actor', 'task_id', 'assignee', 'performer_id', 'reason_id', 'requested_at_ms', 'evidence_id'];
const resultKeys = ['actor', 'execution_mode', 'task_id', 'performer_id', ...bindingKeys,
  'observed_device_id', 'observed_image_identity', 'started_at_ms', 'finished_at_ms', 'execution_status',
  'parser_status', 'exit_code', 'cases', 'stdout_artifact_id', 'stderr_artifact_id', 'result_artifact_id', 'evidence_id'];
const reportKeys = ['actor', 'candidate_fingerprint', 'result_evidence_id', 'result_execution_id',
  'profile_ref', 'profile_version', 'report_artifact_id', 'report_link_id', 'evidence_id'];
export const sqePayloadFields = Object.freeze({ sqe_context: Object.freeze(contextKeys), manual_request: Object.freeze(requestKeys),
  sqe_result: Object.freeze(resultKeys), sqe_report: Object.freeze(reportKeys) });
const proofTypes = new Set(['sqe_context', 'manual_request', 'sqe_result', 'sqe_report']);
export function createSqeProtocols({ result, mockId, transitionAllowed, evidenceCurrent }) {
  const evidenceIds = new Set();
  const p22 = () => result.steps.P22;
  const p23 = () => result.steps.P23;
  const coords = step => ({ cycle: result.cycle, attempt: step.attempt, execution_id: step.execution_id });
  const current = (proof, step) => proof && proof.cycle === result.cycle && proof.attempt === step.attempt
    && proof.execution_id === step.execution_id && proof.candidate_fingerprint === result.candidate_fingerprint;
  const contextCurrent = () => current(p22().sqe_context, p22())
    && profileKeys.every(key => p22().sqe_context[key] === profile[key])
    && p22().sqe_context.rule_version === result.rule_version;
  const resultCurrent = () => contextCurrent() && current(p22().sqe_result, p22())
    && bindingKeys.every(key => p22().sqe_result[key] === p22().sqe_context[key]);
  const collected = () => resultCurrent() && p22().sqe_result.execution_status === 'completed';
  const reportCurrent = () => collected() && p22().state === 'SUCCEEDED' && current(p23().sqe_report, p23())
    && p23().sqe_report.result_evidence_id === p22().sqe_result.evidence_id
    && p23().sqe_report.result_execution_id === p22().execution_id
    && p23().sqe_report.profile_ref === profile.profile_ref && p23().sqe_report.profile_version === profile.profile_version;
  const fresh = id => mockId(id) && !evidenceIds.has(id);
  const add = (step, id) => { evidenceIds.add(id); if (!step.evidence_ids.includes(id)) step.evidence_ids.push(id); };
  function disposition() {
    if (!collected()) return null;
    const ctx = p22().sqe_context, proof = p22().sqe_result;
    if (proof.observed_device_id !== ctx.device_id || proof.observed_image_identity !== ctx.expected_image_identity) return 'INCONCLUSIVE';
    if (proof.parser_status === 'error' || proof.exit_code === null || proof.cases.some(row => row.outcome === 'ERROR')) return 'ERROR';
    if (profile.expected_cases.some(id => !proof.cases.some(row => row.case_id === id))
      || proof.cases.some(row => row.outcome === 'INCONCLUSIVE') || ![0, 1].includes(proof.exit_code)
      || proof.cases.every(row => row.outcome === 'PASS') && proof.exit_code !== 0) return 'INCONCLUSIVE';
    return proof.cases.some(row => row.outcome === 'FAIL') ? 'FAIL' : 'PASS';
  }
  function gateCurrent() {
    const gate = result.steps.P24;
    return Boolean(reportCurrent() && p23().state === 'SUCCEEDED' && disposition() === 'PASS'
      && gate.gate_sqe_report_evidence_id === p23().sqe_report.evidence_id);
  }
  function blockingReason(event, node, step) {
    if (['P22', 'P23', 'P24'].includes(node.id) && event.type === 'step' && event.payload.state === 'FAILED')
      return 'dedicated_sqe_failure_required';
    if (node.id === 'P22' && current(step.sqe_manual_task, step) && !step.sqe_result && event.type === 'step'
      && ['READY', 'RUNNING', 'SUCCEEDED'].includes(event.payload.state)) return 'manual_submission_required';
    return '';
  }
  function apply(event, node, step) {
    const measurement = event.type === 'measurement' && node.id === 'P24';
    if (!proofTypes.has(event.type) && !measurement) return null;
    if (result.device?.quarantined || result.status === 'RECONCILING') return 'reconciliation_required';
    const p = event.payload;
    if (event.type === 'sqe_context') {
      if (node.id !== 'P22' || step.state !== 'RUNNING' || step.sqe_context || !shape(p, contextKeys)
        || p.actor !== 'mock:sqe' || p.candidate_fingerprint !== result.candidate_fingerprint
        || !profileKeys.every(key => p[key] === profile[key]) || p.rule_version !== result.rule_version
        || !['device_id', 'bridge_id', 'image_hash', 'expected_image_identity'].every(key => mockId(p[key]))
        || !fresh(p.evidence_id)) return 'invalid_sqe_context';
      step.sqe_context = { ...clone(p), ...coords(step) }; step.sqe_execution_mode = 'bridge_mock';
      add(step, p.evidence_id); return '';
    }
    if (event.type === 'manual_request') {
      if (node.id !== 'P22' || step.state !== 'RUNNING' || !contextCurrent() || step.sqe_result || step.sqe_manual_task
        || !shape(p, requestKeys) || p.actor !== 'mock:sqe' || p.assignee !== 'mock:human'
        || p.performer_id !== 'mock:performer:sqe' || p.task_id !== `mock:manual:P22:c${result.cycle}:a${step.attempt}`
        || !mockId(p.reason_id) || !time(p.requested_at_ms) || !fresh(p.evidence_id)
        || ['active', 'unknown'].includes(result.device?.operation_state)
        || !transitionAllowed(step.state, 'WAITING_HUMAN')) return 'invalid_manual_request';
      step.sqe_manual_task = { ...clone(p), ...coords(step), candidate_fingerprint: result.candidate_fingerprint };
      step.sqe_execution_mode = 'manual'; step.state = 'WAITING_HUMAN';
      result.status = 'WAITING_HUMAN'; result.wait_reason = 'manual_sqe_submission_required'; add(step, p.evidence_id); return '';
    }
    if (event.type === 'sqe_result') {
      if (node.id !== 'P22' || !contextCurrent() || step.sqe_result || !shape(p, resultKeys)
        || !bindingKeys.every(key => p[key] === step.sqe_context[key]) || !fresh(p.evidence_id)
        || !['observed_device_id', 'observed_image_identity', 'stdout_artifact_id', 'stderr_artifact_id', 'result_artifact_id'].every(key => mockId(p[key]))
        || new Set([p.stdout_artifact_id, p.stderr_artifact_id, p.result_artifact_id]).size !== 3
        || !time(p.started_at_ms) || !time(p.finished_at_ms) || p.finished_at_ms < p.started_at_ms
        || !['completed', 'infrastructure_error'].includes(p.execution_status) || !['complete', 'error'].includes(p.parser_status)
        || !(p.exit_code === null || Number.isSafeInteger(p.exit_code)) || !Array.isArray(p.cases)
        || p.cases.length > profile.expected_cases.length || !p.cases.every(row => shape(row, ['case_id', 'outcome'])
          && profile.expected_cases.includes(row.case_id) && ['PASS', 'FAIL', 'ERROR', 'INCONCLUSIVE'].includes(row.outcome))
        || new Set(p.cases.map(row => row.case_id)).size !== p.cases.length) return 'invalid_sqe_result';
      if (p.execution_mode === 'bridge_mock') {
        if (step.state !== 'RUNNING' || step.sqe_manual_task || p.actor !== 'mock:sqe' || p.performer_id !== 'mock:sqe'
          || p.task_id !== null) return 'invalid_sqe_performer';
      } else if (p.execution_mode === 'manual') {
        const task = step.sqe_manual_task;
        if (step.state !== 'WAITING_HUMAN' || !current(task, step) || p.actor !== task.assignee
          || p.task_id !== task.task_id || p.performer_id !== task.performer_id || p.started_at_ms < task.requested_at_ms
          || !transitionAllowed(step.state, 'READY')) return 'invalid_manual_submission';
      } else return 'invalid_sqe_performer';
      step.sqe_result = { ...clone(p), ...coords(step) }; step.sqe_execution_mode = p.execution_mode; add(step, p.evidence_id);
      if (p.execution_mode === 'manual') { step.state = 'READY'; result.status = 'RUNNING'; result.wait_reason = ''; }
      return '';
    }
    if (event.type === 'sqe_report') {
      if (node.id !== 'P23' || step.state !== 'RUNNING' || step.sqe_report || !shape(p, reportKeys)
        || !collected() || p22().state !== 'SUCCEEDED' || p.actor !== 'mock:sqe'
        || p.candidate_fingerprint !== result.candidate_fingerprint
        || p.result_evidence_id !== p22().sqe_result.evidence_id || p.result_execution_id !== p22().execution_id
        || p.profile_ref !== profile.profile_ref || p.profile_version !== profile.profile_version
        || !mockId(p.report_artifact_id) || !mockId(p.report_link_id) || !fresh(p.evidence_id)) return 'invalid_sqe_report';
      step.sqe_report = { ...clone(p), ...coords(step), execution_mode: p22().sqe_execution_mode };
      add(step, p.evidence_id); return '';
    }
    if (measurement) {
      if (step.state !== 'RUNNING' || !reportCurrent() || p23().state !== 'SUCCEEDED') return 'sqe_report_required';
      const expected = disposition();
      const ctx = { mode: 'mock', job_id: result.job_id, step_id: 'P24', ...coords(step),
        candidate_fingerprint: result.candidate_fingerprint, rule_version: result.rule_version };
      if (!evidenceCurrent(p.evidence, ctx)) return 'stale_evidence';
      if (!fresh(p.evidence.evidence_id)) return 'invalid_sqe_gate_evidence';
      const complete = ['PASS', 'FAIL'].includes(expected);
      if (p.verdict !== expected || p.evidence.complete !== complete) return 'sqe_disposition_mismatch';
      step.gate_verdict = expected; step.gate_complete = complete; step.gate_candidate_fingerprint = result.candidate_fingerprint;
      step.gate_rule_version = result.rule_version; step.gate_evidence_id = p.evidence.evidence_id;
      step.gate_sqe_report_evidence_id = p23().sqe_report.evidence_id; add(step, p.evidence.evidence_id); return '';
    }
    return 'unknown_type';
  }
  function successGuard(node) {
    if (node.id === 'P22' && !collected()) return 'sqe_result_required';
    if (node.id === 'P23' && p22().state !== 'SKIPPED' && !reportCurrent()) return 'sqe_report_required';
    if (node.id === 'P24' && !gateCurrent()) return 'sqe_gate_evidence_required';
    return '';
  }
  return { apply, blockingReason, successGuard, gateCurrent };
}
