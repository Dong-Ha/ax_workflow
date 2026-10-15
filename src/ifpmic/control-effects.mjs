// Synthetic bridge and publisher observations. This module never executes operations.
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const shape = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const isoTime = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isSafeInteger(Date.parse(value)) && Date.parse(value) >= 0 && new Date(Date.parse(value)).toISOString() === value;
const nullableId = (value, mockId) => value === null || mockId(value);
const sha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const positiveInt = value => Number.isSafeInteger(value) && value > 0;
const nonnegativeInt = value => Number.isSafeInteger(value) && value >= 0;
const terminalBridge = new Set(['SUCCEEDED', 'FAILED', 'CANCELED']);
const bridgeCommandFields = Object.freeze(['command_id', 'job_id', 'step_id', 'cycle', 'attempt', 'bridge_id', 'device_id',
  'lease_id', 'fencing_token', 'action', 'profile_ref', 'profile_version', 'artifact_id', 'artifact_sha256', 'deadline', 'idempotency_key']);
const bridgeObservationFields = Object.freeze(['actor', 'command_id', 'lease_id', 'fencing_token', 'bridge_id', 'device_id',
  'sequence', 'state', 'observed_mode', 'device_identity', 'exit_code', 'stdout_artifact_id', 'stderr_artifact_id',
  'test_result_artifact_id', 'image_identity', 'started_at', 'finished_at', 'evidence_id']);
const profileByAction = Object.freeze({
  flash_profile: Object.freeze({ profile_ref: 'mock:bridge:flash', profile_version: 'mock:bridge:profile:v1' }),
  run_sqe_profile: Object.freeze({ profile_ref: 'mock:bridge:sqe', profile_version: 'mock:bridge:profile:v1' }),
});
const imageRegistry = Object.freeze([Object.freeze({
  candidate_fingerprint: 'mock:cancel-flash-unknown:candidate:c1',
  image_hash_ref: 'mock:cancel-flash-unknown:image:c1',
  image_sha256: '38a3b557f6c86100a0180fd612c57332aa650ee4cf43abe5e1674726c2bf165b',
  artifact_id: 'mock:artifact:image:38a3b557f6c86100a0180fd612c57332aa650ee4cf43abe5e1674726c2bf165b',
  expected_image_identity: 'mock:cancel-flash-unknown:boot:c1',
  device_id: 'mock:cancel-flash-unknown:device',
  bridge_id: 'mock:cancel-flash-unknown:bridge',
})]);

const sameBinding = (a, b) => ['manifest_id', 'digest', 'candidate_fingerprint', 'cycle', 'attempt', 'execution_id']
  .every(key => a[key] === b[key]);
const sameBridgeResult = (a, b) => ['state', 'observed_mode', 'device_identity', 'exit_code', 'stdout_artifact_id',
  'stderr_artifact_id', 'test_result_artifact_id', 'image_identity', 'started_at', 'finished_at']
  .every(key => a[key] === b[key]);
const bridgeEdges = Object.freeze({
  QUEUED: new Set(['ACKED', 'UNKNOWN', 'CANCELED']),
  ACKED: new Set(['RUNNING', 'UNKNOWN', 'CANCELED']),
  RUNNING: new Set(['SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELED']),
  UNKNOWN: new Set(['SUCCEEDED', 'FAILED', 'CANCELED']),
});

export function createControlEffects({ result, mockId, fresh, recordFact, invalidateBoundary, releaseMatches }) {
  const control = result.control;
  if (!Array.isArray(control.bridges)) control.bridges = [];
  if (!Array.isArray(control.remotes)) control.remotes = [];
  if (!Array.isArray(control.facts)) control.facts = [];
  if (typeof control.unscoped_quarantine !== 'boolean') control.unscoped_quarantine = false;

  const registeredBridge = id => control.bridges.find(entry => entry.command.command_id === id);
  const registeredRemote = key => control.remotes.find(entry => entry.operation_key === key);
  const currentStep = id => result.steps[id];
  const commandIdentity = p => {
    const entry = registeredBridge(p.command_id);
    return entry && p.lease_id === entry.command.lease_id && p.fencing_token === entry.command.fencing_token
      && p.bridge_id === entry.command.bridge_id && p.device_id === entry.command.device_id ? entry : null;
  };
  const remoteBinding = p => {
    const entry = registeredRemote(p.operation_key);
    return entry && sameBinding(entry, p) ? entry : null;
  };
  const currentRemote = entry => entry.cycle === result.cycle && entry.candidate_fingerprint === result.candidate_fingerprint
    && entry.step_id === 'P25' && entry.attempt === result.steps.P25?.attempt
    && entry.execution_id === result.steps.P25?.execution_id;
  function setDeviceProjection() {
    const generic = control.generic_device;
    const blocked = control.unscoped_quarantine || control.bridges.some(entry => entry.quarantined && !entry.released);
    const typedUnknown = control.bridges.some(entry => !entry.released && entry.observation?.state === 'UNKNOWN');
    const typedActive = control.bridges.some(entry => !entry.released && entry.observation?.state === 'RUNNING');
    const active = generic?.operation_state === 'active' || typedActive;
    if (result.device || control.bridges.length) {
      result.device = { mode: 'mock', heartbeat_due: false, offline: false, lease_expired: false,
        ...result.device, quarantined: blocked, reassign_allowed: false,
        operation_state: typedUnknown ? 'unknown' : typedActive ? 'active' : generic ? generic.operation_state : 'idle',
        status: blocked ? (generic?.status === 'UNKNOWN' ? 'UNKNOWN' : 'RECONCILING')
          : generic?.offline ? 'OFFLINE' : active ? 'ACTIVE' : 'AVAILABLE' };
    }
    if (blocked) { result.status = 'RECONCILING'; result.wait_reason = 'device_reconciliation_required'; }
    else if (result.status === 'RECONCILING' && result.wait_reason === 'device_reconciliation_required'
        && !control.reconciliation_required && !control.remotes.some(entry => !entry.terminal)) {
      const state = result.steps[result.current_step]?.state;
      result.status = ['WAITING_HUMAN', 'WAITING_DEVICE'].includes(state) ? state : 'RUNNING';
      result.wait_reason = result.status === 'RUNNING' ? '' : result.status.toLowerCase();
    }
  }
  function invalidateIfCanceling() {
    if (control.phase === 'CANCEL_REQUESTED' || control.phase === 'QUIESCENT') invalidateBoundary();
  }
  function commit(event, { material = true, conflict = false } = {}) {
    recordFact(event);
    if (conflict) {
      control.reconciliation_required = true;
      control.admission_open = false;
    }
    if (material) {
      if (control.phase === 'CANCELED') control.reconciliation_required = true;
      else invalidateIfCanceling();
    }
    setDeviceProjection();
    return '';
  }
  function exactEvidence(event) {
    return mockId(event?.payload?.evidence_id) && fresh(event.payload.evidence_id);
  }
  function registryRow(context) {
    const rows = imageRegistry.filter(row => row.candidate_fingerprint === result.candidate_fingerprint
      && row.image_hash_ref === context?.image_hash);
    if (rows.length !== 1) return null;
    const row = rows[0];
    return row.device_id === context.device_id && row.bridge_id === context.bridge_id
      && row.expected_image_identity === context.expected_image_identity ? row : null;
  }
  function validCommand(command, context, step) {
    if (!shape(command, bridgeCommandFields) || bridgeCommandFields.some(key => !Object.hasOwn(command, key))) return false;
    const profile = profileByAction[command.action];
    if (!profile || !mockId(command.command_id) || command.job_id !== result.job_id || command.step_id !== 'P22'
        || command.cycle !== result.cycle || command.attempt !== step.attempt || command.bridge_id !== context.bridge_id
        || command.device_id !== context.device_id || command.lease_id === '' || !mockId(command.lease_id)
        || !nonnegativeInt(command.fencing_token) || command.profile_ref !== profile.profile_ref
        || command.profile_version !== profile.profile_version || !isoTime(command.deadline)
        || !mockId(command.idempotency_key)) return false;
    const row = registryRow(context);
    if (command.action === 'run_sqe_profile') return Boolean(row && command.artifact_id === null && command.artifact_sha256 === null);
    return Boolean(row && command.artifact_id === row.artifact_id && command.artifact_sha256 === row.image_sha256
      && sha256(command.artifact_sha256));
  }
  function expectedModeIdentity(entry, mode) {
    const deviceId = entry.command.device_id;
    if (mode === 'adb') return deviceId;
    if (mode === 'fastboot' && deviceId.startsWith('mock:')) return `mock:fastboot:${deviceId.slice(5)}`;
    return null;
  }
  function validBridgeShape(p) {
    if (!shape(p, bridgeObservationFields)) return false;
    return p.actor === 'mock:bridge' && mockId(p.evidence_id) && mockId(p.command_id) && mockId(p.lease_id)
      && mockId(p.bridge_id) && mockId(p.device_id) && positiveInt(p.sequence) && nonnegativeInt(p.fencing_token)
      && ['QUEUED', 'ACKED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELED'].includes(p.state)
      && ['adb', 'fastboot'].includes(p.observed_mode) && mockId(p.device_identity)
      && (p.exit_code === null || Number.isSafeInteger(p.exit_code))
      && nullableId(p.stdout_artifact_id, mockId) && nullableId(p.stderr_artifact_id, mockId)
      && nullableId(p.test_result_artifact_id, mockId) && mockId(p.image_identity)
      && (p.started_at === null || nonnegativeInt(p.started_at)) && (p.finished_at === null || nonnegativeInt(p.finished_at));
  }
  function validBridgeState(entry, p) {
    const prior = entry.observation ?? { state: 'QUEUED', started_at: null };
    if (terminalBridge.has(prior.state) && !sameBridgeResult(prior, p)) return false;
    if (p.state === 'RUNNING' && control.bridges.some(other => other !== entry && !other.released
        && other.command.device_id === entry.command.device_id && ['RUNNING', 'UNKNOWN'].includes(other.observation?.state))) return false;
    if (p.device_identity !== expectedModeIdentity(entry, p.observed_mode)
        || p.image_identity !== entry.expected_image_identity || p.sequence <= entry.last_sequence) return false;
    if (p.state !== prior.state && !bridgeEdges[prior.state]?.has(p.state)) return false;
    if (prior.started_at !== null && p.started_at !== prior.started_at) return false;
    if (p.started_at !== null && p.finished_at !== null && p.finished_at < p.started_at) return false;
    const noArtifacts = p.stdout_artifact_id === null && p.stderr_artifact_id === null && p.test_result_artifact_id === null;
    const allOutput = mockId(p.stdout_artifact_id) && mockId(p.stderr_artifact_id);
    if (new Set([p.stdout_artifact_id, p.stderr_artifact_id, p.test_result_artifact_id].filter(x => x !== null)).size
        !== [p.stdout_artifact_id, p.stderr_artifact_id, p.test_result_artifact_id].filter(x => x !== null).length) return false;
    if (['QUEUED', 'ACKED'].includes(p.state)) return p.started_at === null && p.finished_at === null
      && p.exit_code === null && noArtifacts;
    if (p.state === 'UNKNOWN') return (p.started_at === null || prior?.started_at !== null
      && p.started_at === prior.started_at) && p.finished_at === null && p.exit_code === null && noArtifacts;
    if (p.state === 'RUNNING') return nonnegativeInt(p.started_at) && p.finished_at === null && p.exit_code === null && noArtifacts;
    if (p.state === 'SUCCEEDED') return nonnegativeInt(p.started_at) && nonnegativeInt(p.finished_at) && p.exit_code === 0 && allOutput
      && (entry.command.action === 'run_sqe_profile' ? mockId(p.test_result_artifact_id) : p.test_result_artifact_id === null);
    if (p.state === 'FAILED') return nonnegativeInt(p.started_at) && nonnegativeInt(p.finished_at) && Number.isSafeInteger(p.exit_code)
      && p.exit_code !== 0 && allOutput && p.test_result_artifact_id === null;
    if (p.state === 'CANCELED') {
      if (p.exit_code !== null || p.test_result_artifact_id !== null) return false;
      if (p.started_at === null) return p.finished_at === null && noArtifacts;
      return nonnegativeInt(p.finished_at) && allOutput;
    }
    return false;
  }
  function bindingFromIntent(p) {
    return { operation_key: p.operation_key, manifest_id: p.manifest_id, digest: p.digest,
      candidate_fingerprint: p.candidate_fingerprint, rule_version: p.rule_version, destination: p.destination,
      step_id: p.step_id, cycle: p.cycle, attempt: p.attempt, execution_id: p.execution_id };
  }
  function bridgeRegistered(event) {
    const p = event.payload, step = currentStep('P22'), context = step?.sqe_context;
    if (p.actor !== 'mock:bridge' || !exactEvidence(event) || !mockId(p.step_execution_id)
        || !mockId(p.candidate_fingerprint) || !mockId(p.requirements_version) || control.admission_open !== true
        || result.current_step !== 'P22' || step?.state !== 'RUNNING' || !context || step.execution_id !== p.step_execution_id
        || context.cycle !== result.cycle || context.attempt !== step.attempt || context.execution_id !== step.execution_id
        || p.candidate_fingerprint !== result.candidate_fingerprint || context.candidate_fingerprint !== result.candidate_fingerprint
        || p.requirements_version !== result.requirements_version || result.device?.quarantined || control.unscoped_quarantine
        || ['active', 'unknown'].includes(result.device?.operation_state) || !validCommand(p.command, context, step)
        || registeredBridge(p.command.command_id)) return 'invalid_bridge_registration';
    const previous = control.bridges.filter(entry => entry.command.device_id === p.command.device_id);
    if (previous.some(entry => !entry.released && (entry.command.lease_id !== p.command.lease_id
        || entry.command.fencing_token !== p.command.fencing_token))
        || previous.some(entry => entry.released && entry.command.lease_id === p.command.lease_id)
        || previous.some(entry => entry.command.lease_id !== p.command.lease_id && entry.command.fencing_token >= p.command.fencing_token)) return 'bridge_lease_conflict';
    const entry = { command: clone(p.command), step_execution_id: p.step_execution_id,
      candidate_fingerprint: p.candidate_fingerprint, requirements_version: p.requirements_version,
      expected_image_identity: context.expected_image_identity, registered_evidence_id: p.evidence_id,
      last_sequence: 0, observation: null, observation_history: [], reconciliation: null, reconciliation_history: [], release: null,
      released: false, quarantined: false };
    control.bridges.push(entry);
    return commit(event);
  }
  function bridgeObserved(event) {
    const p = event.payload;
    if (!validBridgeShape(p) || !exactEvidence(event)) return 'invalid_bridge_observation';
    const entry = commandIdentity(p);
    if (!entry || !validBridgeState(entry, p)) return 'invalid_bridge_observation';
    const prior = entry.observation;
    const sameTerminal = prior && terminalBridge.has(prior.state) && p.state === prior.state && sameBridgeResult(prior, p);
    const changed = !sameTerminal;
    entry.last_sequence = p.sequence;
    entry.observation_history.push(clone(p));
    if (sameTerminal) return commit(event, { material: false });
    entry.observation = clone(p);
    if (p.state === 'UNKNOWN') entry.quarantined = true;
    if (changed && (entry.reconciliation || entry.release)) { entry.reconciliation = null; entry.release = null; entry.released = false; }
    setDeviceProjection();
    return commit(event);
  }
  function bridgeReconciled(event) {
    const p = event.payload;
    const keys = ['actor', 'command_id', 'lease_id', 'fencing_token', 'bridge_id', 'device_id', 'result_evidence_id',
      'query_seq', 'safe_boundary', 'observed_mode', 'device_identity', 'os_lock_held', 'evidence_id'];
    if (!shape(p, keys) || p.actor !== 'mock:bridge' || !exactEvidence(event) || !mockId(p.command_id)
        || !mockId(p.lease_id) || !nonnegativeInt(p.fencing_token) || !mockId(p.bridge_id) || !mockId(p.device_id)
        || !mockId(p.result_evidence_id) || !positiveInt(p.query_seq) || p.safe_boundary !== true
        || !['adb', 'fastboot'].includes(p.observed_mode) || !mockId(p.device_identity) || p.os_lock_held !== true) return 'invalid_bridge_reconciliation';
    const entry = commandIdentity(p), last = entry?.observation;
    if (!entry || !last || !terminalBridge.has(last.state) || last.evidence_id !== p.result_evidence_id
        || last.sequence !== p.query_seq || p.observed_mode !== last.observed_mode
        || p.device_identity !== last.device_identity
        || p.device_identity !== expectedModeIdentity(entry, p.observed_mode)) return 'invalid_bridge_reconciliation';
    if (entry.reconciliation?.result_evidence_id === p.result_evidence_id && entry.reconciliation?.query_seq === p.query_seq) {
      entry.reconciliation_history.push(clone(p));
      return commit(event, { material: false });
    }
    entry.reconciliation = clone(p); entry.reconciliation_history ??= [];
    entry.reconciliation_history.push(clone(p)); entry.release = null; entry.released = false;
    return commit(event);
  }
  function bridgeReleased(event) {
    const p = event.payload;
    const keys = ['actor', 'command_id', 'lease_id', 'fencing_token', 'reconciliation_evidence_id',
      'os_lock_released', 'lease_released', 'evidence_id'];
    if (!shape(p, keys) || p.actor !== 'mock:system' || !exactEvidence(event) || !mockId(p.command_id)
        || !mockId(p.lease_id) || !nonnegativeInt(p.fencing_token) || !mockId(p.reconciliation_evidence_id)
        || p.os_lock_released !== true || p.lease_released !== true) return 'invalid_bridge_release';
    const entry = registeredBridge(p.command_id);
    if (!entry || p.lease_id !== entry.command.lease_id || p.fencing_token !== entry.command.fencing_token
        || !entry.observation || !terminalBridge.has(entry.observation.state) || !entry.reconciliation
        || entry.reconciliation.evidence_id !== p.reconciliation_evidence_id) return 'invalid_bridge_release';
    const otherBlocked = control.bridges.some(other => other !== entry && other.command.device_id === entry.command.device_id
      && !other.released && (!terminalBridge.has(other.observation?.state) || !other.reconciliation));
    if (control.unscoped_quarantine || otherBlocked) return 'invalid_bridge_release';
    if (entry.release && entry.released) return commit(event, { material: false });
    entry.release = clone(p); entry.released = true; entry.quarantined = false;
    setDeviceProjection();
    return commit(event);
  }
  function remoteIntent(event) {
    const p = event.payload, step = currentStep('P25'), manifest = result.release.manifest;
    const keys = ['actor', 'operation_key', 'manifest_id', 'digest', 'candidate_fingerprint', 'rule_version', 'destination',
      'step_id', 'cycle', 'attempt', 'execution_id', 'evidence_id'];
    if (!shape(p, keys) || p.actor !== 'mock:publisher' || !exactEvidence(event) || !mockId(p.operation_key)
        || !mockId(p.manifest_id) || !mockId(p.digest) || !mockId(p.candidate_fingerprint) || !mockId(p.rule_version)
        || !mockId(p.destination) || p.step_id !== 'P25' || p.cycle !== result.cycle || p.attempt !== step?.attempt
        || p.execution_id !== step?.execution_id || result.current_step !== 'P25' || step?.state !== 'RUNNING'
        || !result.release.approved || result.release.receipt_id || result.release.publication_count !== 0
        || control.admission_open !== true || !manifest || !releaseMatches(p) || p.manifest_id !== manifest.manifest_id
        || p.digest !== manifest.digest || p.candidate_fingerprint !== result.candidate_fingerprint
        || p.rule_version !== result.rule_version || p.destination !== manifest.destination || registeredRemote(p.operation_key) || control.remotes.some(entry => sameBinding(entry, p))) return 'invalid_remote_intent';
    control.remotes.push({ ...clone(bindingFromIntent(p)), evidence_id: p.evidence_id, queries: [], query_seq: 0,
      last_query: null, terminal: null, canonical_receipt_id: null, conflicts: [], history: [] });
    return commit(event);
  }
  function remoteObserved(event) {
    const p = event.payload;
    const keys = ['actor', 'operation_key', 'query_seq', 'outcome', 'manifest_id', 'digest', 'candidate_fingerprint',
      'cycle', 'attempt', 'execution_id', 'receipt_id', 'evidence_id'];
    if (!shape(p, keys) || p.actor !== 'mock:publisher' || !exactEvidence(event) || !mockId(p.operation_key)
        || !positiveInt(p.query_seq) || !['unknown', 'absent', 'conflict', 'found'].includes(p.outcome)
        || !mockId(p.manifest_id) || !mockId(p.digest) || !mockId(p.candidate_fingerprint)
        || !positiveInt(p.cycle) || !positiveInt(p.attempt) || !mockId(p.execution_id)
        || !nullableId(p.receipt_id, mockId) || (p.outcome === 'found') !== (p.receipt_id !== null)) return 'invalid_remote_observation';
    const entry = remoteBinding(p);
    if (!entry || p.query_seq <= entry.query_seq) return 'invalid_remote_observation';
    const current = currentRemote(entry), terminal = entry.terminal;
    const sameTerminalFact = Boolean(terminal && (terminal.provider_state === 'completed'
      ? p.outcome === 'found' && p.receipt_id === terminal.receipt_id
      : p.outcome === 'absent' && p.receipt_id === null));
    const conflict = p.outcome === 'conflict'
      || p.outcome === 'found' && Boolean(entry.canonical_receipt_id && p.receipt_id !== entry.canonical_receipt_id
        || entry.history.some(fact => fact.kind === 'terminal' && fact.fact.provider_state === 'canceled_no_effect')
        || current && result.release.receipt_id && p.receipt_id !== result.release.receipt_id);
    const query = clone(p);
    entry.query_seq = p.query_seq; entry.queries.push(query); entry.history.push({ kind: 'query', fact: query });
    if (!sameTerminalFact) {
      entry.last_query = query; entry.terminal = null;
      if (conflict) entry.conflicts.push(query);
      if (p.outcome === 'found') {
        entry.canonical_receipt_id ??= p.receipt_id;
        // A late effect is a fact even after job cancellation, and never advances P25/P26.
        if (current) {
          result.release.receipt_id ??= p.receipt_id;
          result.release.publication_count = 1;
        }
      }
      if (current && !['CANCELED', 'COMPLETED'].includes(result.status)) {
        if (['unknown', 'absent', 'conflict'].includes(p.outcome) || conflict) {
          result.status = 'RECONCILING'; result.wait_reason = 'remote_result_reconciliation_required';
        } else if (result.wait_reason === 'remote_result_reconciliation_required' && !result.device?.quarantined) {
          result.status = 'RUNNING'; result.wait_reason = '';
        }
      }
    }
    return commit(event, { material: !sameTerminalFact, conflict: conflict && current });
  }
  function remoteTerminal(event) {
    const p = event.payload;
    const keys = ['actor', 'operation_key', 'manifest_id', 'digest', 'candidate_fingerprint', 'cycle', 'attempt',
      'execution_id', 'query_evidence_id', 'provider_state', 'receipt_id', 'safe_boundary', 'evidence_id'];
    if (!shape(p, keys) || p.actor !== 'mock:publisher' || !exactEvidence(event) || !mockId(p.operation_key)
        || !mockId(p.manifest_id) || !mockId(p.digest) || !mockId(p.candidate_fingerprint)
        || !positiveInt(p.cycle) || !positiveInt(p.attempt) || !mockId(p.execution_id)
        || !mockId(p.query_evidence_id) || !['completed', 'canceled_no_effect'].includes(p.provider_state)
        || !nullableId(p.receipt_id, mockId) || p.safe_boundary !== true) return 'invalid_remote_terminal';
    const entry = remoteBinding(p), q = entry?.last_query;
    if (!entry || !q || q.evidence_id !== p.query_evidence_id || entry.conflicts.length) return 'invalid_remote_terminal';
    const valid = p.provider_state === 'completed'
      ? q.outcome === 'found' && q.receipt_id === p.receipt_id && p.receipt_id === entry.canonical_receipt_id
      : q.outcome === 'absent' && p.receipt_id === null && !entry.canonical_receipt_id;
    if (!valid) return 'invalid_remote_terminal';
    if (p.provider_state === 'completed' && currentRemote(entry)
        && result.release.receipt_id && result.release.receipt_id !== p.receipt_id) return 'remote_receipt_conflict';
    if (entry.terminal) {
      if (entry.terminal.provider_state !== p.provider_state || entry.terminal.receipt_id !== p.receipt_id
          || entry.terminal.query_evidence_id !== p.query_evidence_id) return 'invalid_remote_terminal';
      entry.history.push({ kind: 'terminal', fact: clone(p) });
      return commit(event, { material: false });
    }
    entry.terminal = clone(p); entry.history.push({ kind: 'terminal', fact: clone(p) });
    if (p.provider_state === 'completed' && currentRemote(entry)) {
      result.release.receipt_id = p.receipt_id; result.release.publication_count = 1;
    }
    return commit(event);
  }

  function apply(event) {
    switch (event?.type) {
      case 'bridge_registered': return bridgeRegistered(event);
      case 'bridge_observed': return bridgeObserved(event);
      case 'bridge_reconciled': return bridgeReconciled(event);
      case 'bridge_released': return bridgeReleased(event);
      case 'remote_intent': return remoteIntent(event);
      case 'remote_observed': return remoteObserved(event);
      case 'remote_terminal': return remoteTerminal(event);
      default: return null;
    }
  }
  function observeDevice(observation) {
    control.generic_device = clone(observation);
    if (observation?.quarantined === true) control.unscoped_quarantine = true;
    setDeviceProjection();
  }
  function quiescence() {
    if (control.unscoped_quarantine || control.reconciliation_required) return null;
    const bridgeReconciliation = [], bridgeRelease = [], remoteTerminalIds = [];
    for (const entry of control.bridges) {
      if (!entry.observation || !terminalBridge.has(entry.observation.state) || !entry.reconciliation
          || !entry.release || !entry.released || entry.reconciliation.result_evidence_id !== entry.observation.evidence_id
          || entry.reconciliation.query_seq !== entry.observation.sequence) return null;
      bridgeReconciliation.push(entry.reconciliation.evidence_id);
      bridgeRelease.push(entry.release.evidence_id);
    }
    for (const entry of control.remotes) {
      if (!entry.terminal || entry.conflicts.length) return null;
      remoteTerminalIds.push(entry.terminal.evidence_id);
    }
    return { bridge_reconciliation_ids: bridgeReconciliation, bridge_release_ids: bridgeRelease,
      remote_terminal_ids: remoteTerminalIds };
  }
  return { apply, quiescence, observeDevice };
}
