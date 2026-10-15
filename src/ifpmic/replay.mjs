import { buildWorkflowGraph, safeText } from './contract.mjs';
import canonicalStateContract from '../../docs/ifpmic/design-v1/specs/state-contract.json' with { type: 'json' };
import canonicalWorkflow from '../../docs/ifpmic/design-v1/specs/workflow.v1.json' with { type: 'json' };

// Guards for synthetic observations only. No execution, timers, leases or publication.
const stepStates = new Set([
  'PENDING', 'READY', 'RUNNING', 'WAITING_AGENT', 'WAITING_HUMAN',
  'WAITING_DEVICE', 'WAITING_RETRY', 'RECONCILING', 'PAUSE_REQUESTED',
  'PAUSED', 'CANCEL_REQUESTED', 'SUCCEEDED', 'FAILED', 'SKIPPED',
  'CANCELED', 'SUPERSEDED',
]);
const canonicalEdges = new Set(Object.entries(canonicalStateContract.step_transitions)
  .flatMap(([from, targets]) => targets.map(to => `${from}:${to}`)));
const identityStrings = ['job_id', 'step_id', 'execution_id', 'candidate_fingerprint', 'rule_version'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isSafeInteger(value) && value > 0;

export function isAllowedStepTransition(from, to, stateContract) {
  if (!stepStates.has(from) || !stepStates.has(to) || !record(stateContract)
      || !own(stateContract, 'step_transitions') || !record(stateContract.step_transitions)) return false;
  const transitions = stateContract.step_transitions;
  return canonicalEdges.has(`${from}:${to}`)
    && own(transitions, from) && Array.isArray(transitions[from]) && transitions[from].includes(to);
}

export function evidenceCurrent(evidence, context) {
  if (!record(evidence) || !record(context)) return false;
  if (!own(evidence, 'mode') || !own(context, 'mode') || evidence.mode !== 'mock' || context.mode !== 'mock') return false;
  for (const field of identityStrings) {
    if (!own(evidence, field) || !own(context, field) || typeof evidence[field] !== 'string'
        || evidence[field].trim().length === 0 || evidence[field] !== context[field]) return false;
  }
  for (const field of ['cycle', 'attempt']) {
    if (!own(evidence, field) || !own(context, field) || !Number.isSafeInteger(evidence[field])
        || evidence[field] <= 0 || evidence[field] !== context[field]) return false;
  }
  return true;
}

const unknownDevice = () => Object.freeze({
  mode: 'mock', heartbeat_due: false, offline: false, lease_expired: false,
  quarantined: true, reassign_allowed: false, status: 'UNKNOWN', operation_state: null,
});

export function projectDeviceClock(observation) {
  if (!record(observation) || !own(observation, 'mode') || observation.mode !== 'mock') return unknownDevice();
  for (const field of ['now_ms', 'last_heartbeat_ms', 'lease_expires_ms']) {
    if (!own(observation, field) || !timestamp(observation[field])) return unknownDevice();
  }
  if (!own(observation, 'operation_state') || !['idle', 'active', 'unknown'].includes(observation.operation_state)
      || observation.last_heartbeat_ms > observation.now_ms) return unknownDevice();
  const profile = own(observation, 'profile') ? observation.profile : { heartbeat_ms: 10000, offline_ms: 30000 };
  if (!record(profile) || !own(profile, 'heartbeat_ms') || !own(profile, 'offline_ms')
      || !positive(profile.heartbeat_ms) || !positive(profile.offline_ms)
      || profile.offline_ms < profile.heartbeat_ms) return unknownDevice();
  const elapsed = observation.now_ms - observation.last_heartbeat_ms;
  const heartbeat_due = elapsed >= profile.heartbeat_ms;
  const offline = elapsed >= profile.offline_ms;
  const lease_expired = observation.now_ms >= observation.lease_expires_ms;
  const quarantined = observation.operation_state === 'unknown'
    || (observation.operation_state === 'active' && lease_expired);
  const status = quarantined ? 'RECONCILING' : offline ? 'OFFLINE'
    : observation.operation_state === 'active' ? 'ACTIVE' : 'AVAILABLE';
  return Object.freeze({
    mode: 'mock', heartbeat_due, offline, lease_expired, quarantined,
    reassign_allowed: false, status, operation_state: observation.operation_state,
  });
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// Used only for transient equality checks; incoming payloads never enter the projection.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const canonicalWorkflowSignature = canonical(canonicalWorkflow);
const opaqueId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/.test(value)
  && safeText(value) === value;
const mockEvidence = value => opaqueId(value) && value.startsWith('mock:');
const eventTypes = new Set(['step', 'agent', 'human', 'measurement', 'device']);
const eventFields = new Set(['event_id', 'source_id', 'source_seq', 'type', 'mode', 'job_id',
  'step_id', 'cycle', 'attempt', 'execution_id', 'payload']);
const payloadFields = {
  step: ['state'], agent: ['status'], human: ['actor', 'task_id', 'plan_version', 'evidence_id'],
  measurement: ['evidence', 'verdict'],
  device: ['mode', 'now_ms', 'last_heartbeat_ms', 'lease_expires_ms', 'operation_state', 'profile'],
};

/** Recompute an observation prefix from scratch. This function cannot execute work. */
export function replayScenario(scenario, workflow, stateContract, cursor = scenario?.events?.length) {
  if (!record(scenario) || !opaqueId(scenario.id) || !Array.isArray(scenario.events)) {
    throw new TypeError('A scenario ID and events array are required');
  }
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > scenario.events.length) {
    throw new RangeError('Cursor must identify an observation prefix');
  }
  if (canonical(workflow) !== canonicalWorkflowSignature) {
    throw new TypeError('Replay requires the canonical IFPMIC workflow contract');
  }
  const graph = buildWorkflowGraph(workflow);
  const scenarioId = safeText(scenario.id, 240);
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const routes = new Map(graph.edges.filter(edge => edge.kind === 'pass').map(edge => [edge.from, edge.to]));
  const result = {
    mode: 'mock', scenario_id: scenarioId, job_id: `mock:${scenarioId}`,
    status: 'RUNNING', cycle: 1, rework_count: 0, candidate_fingerprint: 'mock:candidate:A',
    rule_version: 'mock:rules:v1', current_step: 'P01', steps: {}, history: [],
    timeline: [], ignored: [], duplicate_count: 0, conflict_count: 0,
    device: null, release: { publication_count: 0, approved: false },
    wait_reason: '', real_publish_allowed: false,
  };
  for (const node of graph.nodes) result.steps[node.id] = {
    state: 'PENDING', agent_status: 'idle', gate_verdict: null,
    attempt: 1, execution_id: `mock:${node.id}:c1:a1`, evidence_ids: [],
  };
  const eventIds = new Map();
  const sequences = new Map();
  const latestSequences = new Map();
  const submissions = new Set();
  let quarantined = false;
  let latestDeviceTime = -1;
  function apply(event) {
    if (!record(event) || event.mode !== 'mock' || !opaqueId(event.event_id)
        || !opaqueId(event.source_id) || !Number.isSafeInteger(event.source_seq) || event.source_seq < 1) return 'invalid_event';
    if (Object.keys(event).some(key => !eventFields.has(key))) return 'unknown_event_field';
    if (!eventTypes.has(event.type)) return 'unknown_type';
    if (!record(event.payload)) return 'invalid_payload';
    if (Object.keys(event.payload).some(key => !payloadFields[event.type].includes(key))) return 'unknown_payload_field';
    const step = result.steps[event.step_id];
    if (!step || !nodes.has(event.step_id)) return 'unknown_step';
    if (event.job_id !== result.job_id || event.cycle !== result.cycle
        || event.attempt !== step.attempt || event.execution_id !== step.execution_id) return 'stale_execution';
    if (event.step_id !== result.current_step) return 'inactive_step';
    const payload = record(event.payload) ? event.payload : {};
    const node = nodes.get(event.step_id);
    if (event.type === 'agent') {
      if (!['running', 'completed', 'failed'].includes(payload.status)) return 'invalid_agent_status';
      step.agent_status = payload.status;
      return '';
    }
    if (event.type === 'human') {
      if (node.owner !== 'human' || step.state !== 'WAITING_HUMAN'
          || payload.actor !== 'mock:human' || payload.task_id !== `mock:task:${node.id}:c${result.cycle}`
          || payload.plan_version !== 'mock:plan:v1' || !mockEvidence(payload.evidence_id)) return 'invalid_human_submission';
      // Release approval requires digest checking in a later increment, never generic submission.
      if (node.id === 'X03') return 'release_digest_required';
      submissions.add(node.id);
      if (!step.evidence_ids.includes(payload.evidence_id)) step.evidence_ids.push(safeText(payload.evidence_id, 240));
      return '';
    }
    if (event.type === 'measurement') {
      if (node.owner !== 'system' || step.state !== 'RUNNING') return 'invalid_measurement_target';
      const context = { mode: 'mock', job_id: result.job_id, step_id: node.id, cycle: result.cycle,
        attempt: step.attempt, execution_id: step.execution_id,
        candidate_fingerprint: result.candidate_fingerprint, rule_version: result.rule_version };
      if (!evidenceCurrent(payload.evidence, context)) return 'stale_evidence';
      if (!['PASS', 'FAIL', 'ERROR', 'INCONCLUSIVE'].includes(payload.verdict)) return 'invalid_verdict';
      if (!own(payload.evidence, 'evidence_id') || !mockEvidence(payload.evidence.evidence_id)) return 'missing_evidence';
      step.gate_verdict = own(payload.evidence, 'complete') && payload.evidence.complete === true ? payload.verdict : 'INCONCLUSIVE';
      if (!step.evidence_ids.includes(payload.evidence.evidence_id)) step.evidence_ids.push(safeText(payload.evidence.evidence_id, 240));
      return '';
    }
    if (event.type === 'device') {
      if (timestamp(payload.now_ms) && payload.now_ms < latestDeviceTime) return 'stale_device_clock';
      const observation = projectDeviceClock(payload);
      if (timestamp(payload.now_ms)) latestDeviceTime = payload.now_ms;
      quarantined ||= observation.quarantined;
      result.device = { ...observation, quarantined,
        status: quarantined && observation.status !== 'UNKNOWN' ? 'RECONCILING' : observation.status };
      if (result.device.quarantined) {
        result.status = 'RECONCILING'; result.wait_reason = 'device_reconciliation_required';
      }
      return '';
    }
    if (event.type !== 'step') return 'unknown_type';
    if (!isAllowedStepTransition(step.state, payload.state, stateContract)) return 'illegal_transition';
    // Skip, pause, cancel, and reconciliation require their own evidence protocols.
    if (['SKIPPED', 'PAUSED', 'PAUSE_REQUESTED', 'CANCEL_REQUESTED', 'CANCELED', 'SUPERSEDED', 'RECONCILING'].includes(payload.state)) return 'control_evidence_required';
    if (payload.state === 'SUCCEEDED') {
      if (result.status === 'RECONCILING') return 'reconciliation_required';
      if (node.owner === 'human' && !submissions.has(node.id)) return 'human_submission_required';
      if (node.owner === 'system' && step.gate_verdict !== 'PASS') return 'gate_pass_required';
      if (node.id === 'P25') return 'release_approval_required';
    }
    step.state = payload.state;
    if (payload.state === 'SUCCEEDED') {
      result.current_step = routes.get(node.id);
      result.status = result.current_step === 'END' ? 'COMPLETED' : 'RUNNING';
      result.wait_reason = '';
    } else if (['WAITING_HUMAN', 'WAITING_DEVICE', 'RECONCILING', 'FAILED'].includes(payload.state)) {
      result.status = payload.state;
      result.wait_reason = payload.state.toLowerCase();
    }
    return '';
  }
  for (const event of scenario.events.slice(0, cursor)) {
    const validKey = record(event) && opaqueId(event.event_id) && opaqueId(event.source_id)
      && Number.isSafeInteger(event.source_seq) && event.source_seq > 0;
    let staleSequence = false;
    if (validKey) {
      const sequence = JSON.stringify([event.source_id, event.source_seq]);
      const { event_id: _id, source_id: _source, source_seq: _sequence, ...observation } = event;
      const signature = canonical(observation);
      const priorId = eventIds.get(event.event_id);
      const priorSequence = sequences.get(sequence);
      if (priorId !== undefined || priorSequence !== undefined) {
        result.duplicate_count++;
        if ((priorId !== undefined && priorId !== signature) || (priorSequence !== undefined && priorSequence !== signature)) result.conflict_count++;
        // Record both aliases, so a rejected collision cannot be replayed with a fresh key.
        if (priorId === undefined) eventIds.set(event.event_id, signature);
        if (priorSequence === undefined) sequences.set(sequence, signature);
        continue;
      }
      eventIds.set(event.event_id, signature); sequences.set(sequence, signature);
      staleSequence = event.source_seq < (latestSequences.get(event.source_id) ?? 0);
    }
    const reason = staleSequence ? 'stale_source_sequence' : apply(event);
    // Rejected data reserves dedup keys but cannot advance the accepted-state watermark.
    if (reason === '' && validKey) latestSequences.set(event.source_id, event.source_seq);
    if (result.device?.quarantined) {
      result.status = 'RECONCILING'; result.wait_reason = 'device_reconciliation_required';
    }
    const row = {
      event_id: opaqueId(event?.event_id) ? event.event_id : '[invalid]',
      source_id: opaqueId(event?.source_id) ? event.source_id : '[invalid]',
      source_seq: Number.isSafeInteger(event?.source_seq) ? event.source_seq : null,
      type: eventTypes.has(event?.type) ? event.type : 'unknown', step_id: nodes.has(event?.step_id) ? event.step_id : '',
      mode: 'mock', applied: reason === '', reason,
    };
    result.timeline.push(row);
    if (reason) result.ignored.push(row);
  }
  return freeze(result);
}
