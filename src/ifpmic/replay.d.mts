export interface MockEvent {
  event_id: string; source_id: string; source_seq: number; type: string; mode: 'mock';
  job_id: string; step_id: string; cycle: number; attempt: number; execution_id: string;
  payload: Record<string, unknown>;
}
export interface MockScenario {
  id: string; title: string; requirement_ids: readonly string[]; events: readonly MockEvent[];
  checkpoints: readonly { id: string; title: string; cursor: number }[];
}
export interface ReplayStep {
  state: string; cycle: number; agent_status: string; gate_verdict: string | null; gate_complete: boolean;
  gate_candidate_fingerprint: string | null; gate_rule_version: string | null; gate_evidence_id: string | null;
  attempt: number; execution_id: string; evidence_ids: readonly string[]; retry_due_ms: number | null;
  failure_evidence_id: string | null; failure_candidate_fingerprint: string | null;
  failure_outcome: string | null; infrastructure_error: boolean;
}
export interface ReplayDevice {
  mode: 'mock'; heartbeat_due: boolean; offline: boolean; lease_expired: boolean;
  quarantined: boolean; reassign_allowed: false; status: string; operation_state: string | null;
}
export interface ReplayRelease {
  publication_count: number; approved: boolean; rejection: string | null; receipt_id: string | null;
  manifest: null | { manifest_id: string; digest: string; candidate_fingerprint: string; rule_version: string;
    destination: string; notes_hash: string; evidence_bundle: string; cycle: number; attempt: number;
    execution_id: string; gate_evidence_ids: readonly string[] };
}
export interface MockSpecReview {
  question_id: string; task_id: string; ordinal: number; cycle: number; attempt: number; execution_id: string;
  candidate_fingerprint: string; requirements_version: string; question_evidence_id: string;
  resolved_requirements_version: string | null; resolution_evidence_id: string | null;
  review_evidence_id: string | null; review_attempt: number | null; review_execution_id: string | null; resolved: boolean; reviewed: boolean;
}
export interface MockRemoteReconciliation {
  operation_key: string; manifest_id: string; digest: string; candidate_fingerprint: string;
  cycle: number; attempt: number; execution_id: string; query_seq: number; outcome: string;
  observations: readonly { outcome: string; evidence_id: string; query_seq: number }[];
}
export interface ReplaySnapshot {
  mode: 'mock'; scenario_id: string; job_id: string; status: string; cycle: number; rework_count: number;
  candidate_fingerprint: string; rule_version: string; current_step: string; steps: Record<string, ReplayStep>;
  history: readonly { kind: string; cycle: number; candidate_fingerprint?: string; step_id?: string;
    step?: ReplayStep; steps?: Record<string, ReplayStep>; release?: ReplayRelease; spec_review?: MockSpecReview }[];
  timeline: readonly { event_id: string; source_id: string; source_seq: number | null; type: string;
    step_id: string; mode: 'mock'; applied: boolean; reason: string }[];
  ignored: ReplaySnapshot['timeline']; duplicate_count: number; conflict_count: number;
  requirements_version: string; spec_review: MockSpecReview | null; remote_reconciliation: MockRemoteReconciliation | null;
  device: ReplayDevice | null; release: ReplayRelease; wait_reason: string; real_publish_allowed: false;
  required_revalidation: readonly string[]; failure_bundle: readonly { step_id: string; cycle: number; attempt: number; evidence_id: string }[];
}
export function isAllowedStepTransition(from: unknown, to: unknown, stateContract: unknown): boolean;
export function evidenceCurrent(evidence: unknown, context: unknown): boolean;
export function projectDeviceClock(observation: unknown): ReplayDevice;
export function replayScenario(scenario: MockScenario, workflow: unknown, stateContract: unknown, cursor?: number): ReplaySnapshot;
export { createScenarioCatalog } from './scenarios.mjs';
