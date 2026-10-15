import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createScenarioCatalog, replayScenario } from '../src/ifpmic/replay.mjs';
import { createControlEffects } from '../src/ifpmic/control-effects.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specs = path.join(root, 'docs/ifpmic/design-v1/specs');
const [workflow, stateContract, registryBytes] = await Promise.all([
  readFile(path.join(specs, 'workflow.v1.json'), 'utf8').then(JSON.parse),
  readFile(path.join(specs, 'state-contract.json'), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'docs/ifpmic/evidence/v2/controls-artifact-registry.json')),
]);
const catalog = createScenarioCatalog(workflow, stateContract);

const registry = Object.freeze({
  candidate_fingerprint: 'mock:cancel-flash-unknown:candidate:c1',
  image_hash_ref: 'mock:cancel-flash-unknown:image:c1',
  image_sha256: '38a3b557f6c86100a0180fd612c57332aa650ee4cf43abe5e1674726c2bf165b',
  artifact_id: 'mock:artifact:image:38a3b557f6c86100a0180fd612c57332aa650ee4cf43abe5e1674726c2bf165b',
  expected_image_identity: 'mock:cancel-flash-unknown:boot:c1',
  device_id: 'mock:cancel-flash-unknown:device',
  bridge_id: 'mock:cancel-flash-unknown:bridge',
});
const registrySha = 'd21fe891b822d383560f02d26e67c2a9c8319323409f3ed84ff6ce37f2bf36c5';
const profileVersion = 'mock:bridge:profile:v1';
const flashProfile = 'mock:bridge:flash';
const sqeProfile = 'mock:bridge:sqe';
const startedAt = 1_797_509_600_000;
const finishedAt = 1_797_509_660_000;

function scenario(id, events) {
  return { id, title: `control effects fixture ${id}`, requirement_ids: [], events };
}

function catalogScenario(id) {
  const value = catalog.find(item => item.id === id);
  assert.ok(value, `fixed source scenario ${id} exists`);
  return value;
}

function jobEvent(id, source, seq, type, payload) {
  return {
    event_id: `mock:${id}:${source}:event:${seq}`,
    source_id: `mock:${id}:${source}`,
    source_seq: seq,
    type,
    mode: 'mock',
    job_id: `mock:${id}`,
    payload,
  };
}

function stepEvent(id, source, seq, type, stepId, payload) {
  const step = `mock:${stepId}:c1:a1`;
  return {
    event_id: `mock:${id}:${source}:event:${seq}`,
    source_id: `mock:${id}:${source}`,
    source_seq: seq,
    type,
    mode: 'mock',
    job_id: `mock:${id}`,
    step_id: stepId,
    cycle: 1,
    attempt: 1,
    execution_id: step,
    payload,
  };
}

function cloneWithCandidate(value, candidate) {
  if (typeof value === 'string') return value === 'mock:candidate:A' ? candidate : value;
  if (Array.isArray(value)) return value.map(item => cloneWithCandidate(item, candidate));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneWithCandidate(item, candidate)]));
}

function flashPrefix({ candidate = registry.candidate_fingerprint, contextChanges = {} } = {}) {
  const base = catalogScenario('sqe-manual-pass');
  assert.equal(base.events.length, 137);
  const beforeCandidate = base.events.slice(0, 65);
  const candidateEvent = stepEvent(base.id, 'fixture-candidate', 1, 'candidate', 'P13', {
    candidate_fingerprint: candidate,
  });
  const throughSqeContext = base.events.slice(65, 103).map(event => cloneWithCandidate(event, candidate));
  const context = throughSqeContext.find(event => event.type === 'sqe_context');
  assert.ok(context, 'fixed P22 context event exists before any manual result');
  Object.assign(context.payload, {
    candidate_fingerprint: candidate,
    image_hash: registry.image_hash_ref,
    device_id: registry.device_id,
    bridge_id: registry.bridge_id,
    expected_image_identity: registry.expected_image_identity,
  }, contextChanges);
  const events = [...beforeCandidate, candidateEvent, ...throughSqeContext];
  const before = replayScenario(scenario(base.id, events), workflow, stateContract);
  assert.equal(events.length, 104);
  assert.equal(before.revision, 103);
  assert.equal(before.current_step, 'P22');
  assert.equal(before.steps.P22.state, 'RUNNING');
  assert.equal(before.candidate_fingerprint, candidate);
  assert.equal(before.steps.P22.sqe_context.image_hash, contextChanges.image_hash ?? registry.image_hash_ref);
  return { id: base.id, events, result: before };
}

function bridgeCommand(id, changes = {}) {
  return {
    command_id: `mock:${id}:bridge-command:c1`,
    job_id: `mock:${id}`,
    step_id: 'P22',
    cycle: 1,
    attempt: 1,
    bridge_id: registry.bridge_id,
    device_id: registry.device_id,
    lease_id: `mock:${id}:lease:c1`,
    fencing_token: 0,
    action: 'flash_profile',
    profile_ref: flashProfile,
    profile_version: profileVersion,
    artifact_id: registry.artifact_id,
    artifact_sha256: registry.image_sha256,
    deadline: '2026-10-16T02:00:00.000Z',
    idempotency_key: `mock:${id}:bridge-key:c1`,
    ...changes,
  };
}

function bridgeRegistration(id, seq = 1, command = bridgeCommand(id), candidate = registry.candidate_fingerprint, requirements = 'mock:requirements:v1') {
  return jobEvent(id, 'bridge', seq, 'bridge_registered', {
    actor: 'mock:bridge',
    command,
    step_execution_id: 'mock:P22:c1:a1',
    candidate_fingerprint: candidate,
    requirements_version: requirements,
    evidence_id: `mock:${id}:bridge-registration:${seq}`,
  });
}

function bridgeObservation(id, seq, command = bridgeCommand(id), changes = {}) {
  return jobEvent(id, 'bridge', seq, 'bridge_observed', {
    actor: 'mock:bridge',
    command_id: command.command_id,
    lease_id: command.lease_id,
    fencing_token: command.fencing_token,
    bridge_id: command.bridge_id,
    device_id: command.device_id,
    sequence: seq,
    state: 'QUEUED',
    observed_mode: 'adb',
    device_identity: command.device_id,
    exit_code: null,
    stdout_artifact_id: null,
    stderr_artifact_id: null,
    test_result_artifact_id: null,
    image_identity: registry.expected_image_identity,
    started_at: null,
    finished_at: null,
    evidence_id: `mock:${id}:bridge-observation:${seq}`,
    ...changes,
  });
}

function bridgeReconciliation(id, command, resultSeq, eventSeq = resultSeq + 1, changes = {}) {
  return jobEvent(id, 'bridge', eventSeq, 'bridge_reconciled', {
    actor: 'mock:bridge', command_id: command.command_id, lease_id: command.lease_id,
    fencing_token: command.fencing_token, bridge_id: command.bridge_id, device_id: command.device_id,
    result_evidence_id: `mock:${id}:bridge-observation:${resultSeq}`, query_seq: resultSeq,
    safe_boundary: true, observed_mode: 'adb', device_identity: command.device_id,
    os_lock_held: true, evidence_id: `mock:${id}:bridge-reconciliation:${eventSeq}`,
    ...changes,
  });
}

function bridgeRelease(id, command, seq, reconciliationSeq = seq - 1, changes = {}) {
  return jobEvent(id, 'bridge', seq, 'bridge_released', {
    actor: 'mock:system', command_id: command.command_id, lease_id: command.lease_id,
    fencing_token: command.fencing_token,
    reconciliation_evidence_id: `mock:${id}:bridge-reconciliation:${reconciliationSeq}`,
    os_lock_released: true, lease_released: true,
    evidence_id: `mock:${id}:bridge-release:${seq}`,
    ...changes,
  });
}

function cancelCommand(id, key, expectedRevision) {
  return {
    command_id: `mock:${id}:cancel:${key}`,
    actor: 'mock:human', route: `/jobs/mock:${id}/controls`,
    idempotency_key: `mock:${id}:cancel-key:${key}`,
    authorization_ref: 'mock:authorization:owner-control:v1', csrf_ref: 'mock:csrf:validated:v1',
    body: { expected_revision: expectedRevision, action: 'cancel', reason: `mock:${id}:cancel-reason:${key}` },
  };
}

function submittedCancel(id, seq, key, expectedRevision) {
  return jobEvent(id, 'control', seq, 'control_submitted', cancelCommand(id, key, expectedRevision));
}

function appliedCancel(id, seq, key, now = 1000) {
  return jobEvent(id, 'control', seq, 'control_apply', {
    command_id: `mock:${id}:cancel:${key}`, actor: 'mock:system', observed_now_ms: now,
    evidence_id: `mock:${id}:cancel-apply:${key}`,
  });
}

function executionEnd(id, seq, commandId, { stepId = 'P22', stepExecutionId, agent, status = 'canceled', kind = 'logical', prior = null }) {
  const executionId = stepExecutionId ?? `mock:${stepId}:c1:a1`;
  return jobEvent(id, 'control', seq, 'control_execution_end', {
    actor: 'mock:adapter', control_command_id: commandId, kind,
    step_id: stepId, cycle: 1, attempt: 1, step_execution_id: executionId, agent_execution_id: agent,
    status, prior_result_evidence_id: prior,
    evidence_id: `mock:${id}:execution-end:${seq}`,
  });
}

function cancelBoundary(id, seq, commandId, { endIds = [], bridgeRecon = [], bridgeReleaseIds = [], remoteTerminalIds = [] } = {}) {
  return jobEvent(id, 'control', seq, 'control_cancel_boundary', {
    command_id: commandId, actor: 'mock:system', fence_id: `mock:${id}:cancel-fence`,
    drained_request_ids: [], execution_result_ids: endIds,
    bridge_reconciliation_ids: bridgeRecon, bridge_release_ids: bridgeReleaseIds,
    remote_terminal_ids: remoteTerminalIds, evidence_id: `mock:${id}:cancel-boundary:${seq}`,
  });
}

function cancelComplete(id, seq, commandId, boundarySeq) {
  return jobEvent(id, 'control', seq, 'control_cancel_complete', {
    command_id: commandId, actor: 'mock:system', boundary_evidence_id: `mock:${id}:cancel-boundary:${boundarySeq}`,
    evidence_id: `mock:${id}:cancel-complete:${seq}`,
  });
}

function remotePrefix() {
  const base = catalogScenario('happy-path');
  assert.equal(base.events.length, 134);
  const prefix = base.events.slice(0, 128);
  const result = replayScenario(scenario(base.id, prefix), workflow, stateContract);
  assert.equal(result.revision, 127);
  assert.equal(result.current_step, 'P25');
  assert.equal(result.steps.P25.state, 'RUNNING');
  assert.equal(result.status, 'RUNNING');
  assert.equal(result.release.approved, true);
  assert.equal(result.release.publication_count, 0);
  assert.equal(result.release.manifest.manifest_id, 'mock:happy-path:c1:a1:manifest');
  return { id: base.id, events: prefix, result };
}

const remoteBinding = Object.freeze({
  operation_key: 'mock:happy-path:remote-operation:c1',
  manifest_id: 'mock:happy-path:c1:a1:manifest', digest: 'mock:happy-path:c1:a1:digest',
  candidate_fingerprint: 'mock:candidate:A', rule_version: 'mock:rules:v1', destination: 'mock:destination',
  step_id: 'P25', cycle: 1, attempt: 1, execution_id: 'mock:P25:c1:a1',
});

function remoteIntent(id, seq = 1, changes = {}) {
  return jobEvent(id, 'remote', seq, 'remote_intent', {
    actor: 'mock:publisher', ...remoteBinding,
    evidence_id: `mock:${id}:remote-intent:${seq}`, ...changes,
  });
}

function remoteObserved(id, seq, querySeq, outcome, receiptId = null, changes = {}) {
  return jobEvent(id, 'remote', seq, 'remote_observed', {
    actor: 'mock:publisher', operation_key: remoteBinding.operation_key, query_seq: querySeq,
    outcome, manifest_id: remoteBinding.manifest_id, digest: remoteBinding.digest,
    candidate_fingerprint: remoteBinding.candidate_fingerprint, cycle: 1, attempt: 1,
    execution_id: 'mock:P25:c1:a1', receipt_id: receiptId,
    evidence_id: `mock:${id}:remote-query:${querySeq}`, ...changes,
  });
}

function remoteTerminal(id, seq, querySeq, providerState, receiptId = null) {
  return jobEvent(id, 'remote', seq, 'remote_terminal', {
    actor: 'mock:publisher', operation_key: remoteBinding.operation_key,
    manifest_id: remoteBinding.manifest_id, digest: remoteBinding.digest,
    candidate_fingerprint: remoteBinding.candidate_fingerprint,
    cycle: 1, attempt: 1, execution_id: 'mock:P25:c1:a1',
    query_evidence_id: `mock:${id}:remote-query:${querySeq}`,
    provider_state: providerState, receipt_id: receiptId, safe_boundary: true,
    evidence_id: `mock:${id}:remote-terminal:${seq}`,
  });
}

test('synthetic image artifact registry digest, opaque alias, and literal row remain pinned', () => {
  assert.equal(createHash('sha256').update(registryBytes).digest('hex'), registrySha);
  const parsed = JSON.parse(registryBytes.toString('utf8'));
  assert.deepEqual(parsed.rows, [registry]);
  const bytes = Buffer.from(`mock:ifpmic:image-bytes:v1\n${registry.candidate_fingerprint}\n${registry.image_hash_ref}`, 'utf8');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), registry.image_sha256);
  assert.equal(registry.artifact_id, `mock:artifact:image:${registry.image_sha256}`);
  assert.notEqual(registry.image_hash_ref, registry.image_sha256, 'catalog image_hash is an opaque alias, not a digest');
});

test('both registered bridge actions use exact profile bindings and never promote a bridge terminal into SQE success', () => {
  const flash = flashPrefix();
  const flashId = flash.id;
  const flashCmd = bridgeCommand(flashId);
  const flashEvents = [
    ...flash.events,
    bridgeRegistration(flashId, 1, flashCmd),
    bridgeObservation(flashId, 2, flashCmd, { sequence: 1, state: 'QUEUED', evidence_id: `mock:${flashId}:bridge-observation:1` }),
    bridgeObservation(flashId, 3, flashCmd, { sequence: 2, state: 'ACKED', evidence_id: `mock:${flashId}:bridge-observation:2` }),
    bridgeObservation(flashId, 4, flashCmd, { sequence: 3, state: 'RUNNING', started_at: startedAt, evidence_id: `mock:${flashId}:bridge-observation:3` }),
    bridgeObservation(flashId, 5, flashCmd, { sequence: 4, state: 'SUCCEEDED', started_at: startedAt, finished_at: finishedAt,
      exit_code: 0, stdout_artifact_id: `mock:${flashId}:stdout`, stderr_artifact_id: `mock:${flashId}:stderr`,
      evidence_id: `mock:${flashId}:bridge-observation:4` }),
  ];
  const flashResult = replayScenario(scenario(flashId, flashEvents), workflow, stateContract);
  assert.equal(flashResult.control.bridges.length, 1);
  assert.equal(flashResult.control.bridges[0].observation.state, 'SUCCEEDED');
  assert.equal(flashResult.steps.P22.state, 'RUNNING');
  assert.equal(flashResult.steps.P22.sqe_result, null);
  assert.equal(flashResult.steps.P22.gate_complete, false);

  const sqe = flashPrefix();
  const sqeId = sqe.id;
  const sqeCmd = bridgeCommand(sqeId, {
    command_id: `mock:${sqeId}:sqe-bridge-command:c1`, action: 'run_sqe_profile',
    profile_ref: sqeProfile, artifact_id: null, artifact_sha256: null,
    idempotency_key: `mock:${sqeId}:sqe-bridge-key:c1`,
  });
  const sqeResult = replayScenario(scenario(sqeId, [
    ...sqe.events,
    bridgeRegistration(sqeId, 1, sqeCmd),
    bridgeObservation(sqeId, 2, sqeCmd, { sequence: 1, state: 'QUEUED', evidence_id: `mock:${sqeId}:bridge-observation:1` }),
    bridgeObservation(sqeId, 3, sqeCmd, { sequence: 2, state: 'ACKED', evidence_id: `mock:${sqeId}:bridge-observation:2` }),
    bridgeObservation(sqeId, 4, sqeCmd, { sequence: 3, state: 'RUNNING', started_at: startedAt, evidence_id: `mock:${sqeId}:bridge-observation:3` }),
    bridgeObservation(sqeId, 5, sqeCmd, { sequence: 4, state: 'SUCCEEDED', started_at: startedAt, finished_at: finishedAt,
      exit_code: 0, stdout_artifact_id: `mock:${sqeId}:stdout`, stderr_artifact_id: `mock:${sqeId}:stderr`,
      test_result_artifact_id: `mock:${sqeId}:test-result`, evidence_id: `mock:${sqeId}:bridge-observation:4` }),
  ]), workflow, stateContract);
  assert.equal(sqeResult.control.bridges[0].command.action, 'run_sqe_profile');
  assert.equal(sqeResult.control.bridges[0].observation.state, 'SUCCEEDED');
  assert.equal(sqeResult.steps.P22.sqe_result, null);
  assert.equal(sqeResult.steps.P22.state, 'RUNNING');
});

test('bridge registration rejects every pinned registry substitution and malformed action tuple atomically', () => {
  const badCases = [
    { id: 'unknown-alias', contextChanges: { image_hash: 'mock:unknown:image:c1' } },
    { id: 'other-candidate-same-alias', candidate: 'mock:cancel-flash-unknown:candidate:c2' },
    { id: 'wrong-artifact', commandChanges: { artifact_id: 'mock:artifact:wrong-image' } },
    { id: 'wrong-digest', commandChanges: { artifact_sha256: '0'.repeat(64) } },
    { id: 'wrong-device', contextChanges: { device_id: 'mock:other:device' }, commandChanges: { device_id: 'mock:other:device' } },
    { id: 'wrong-bridge', contextChanges: { bridge_id: 'mock:other:bridge' }, commandChanges: { bridge_id: 'mock:other:bridge' } },
    { id: 'wrong-boot', contextChanges: { expected_image_identity: 'mock:other:boot' } },
  ];
  for (const entry of badCases) {
    const base = flashPrefix({ candidate: entry.candidate, contextChanges: entry.contextChanges });
    const command = bridgeCommand(base.id, entry.commandChanges);
    const result = replayScenario(scenario(base.id, [
      ...base.events, bridgeRegistration(base.id, 1, command, entry.candidate ?? registry.candidate_fingerprint),
    ]), workflow, stateContract);
    assert.equal(result.control.bridges.length, 0, entry.id);
    assert.equal(result.revision, base.result.revision, entry.id);
    assert.equal(result.timeline.at(-1).applied, false, entry.id);
  }
  const base = flashPrefix();
  const malformed = bridgeCommand(base.id, { action: 'run_sqe_profile', profile_ref: sqeProfile,
    artifact_id: registry.artifact_id, artifact_sha256: registry.image_sha256 });
  const invalidAction = replayScenario(scenario(base.id, [
    ...base.events, bridgeRegistration(base.id, 1, malformed),
  ]), workflow, stateContract);
  assert.equal(invalidAction.control.bridges.length, 0);
  assert.equal(invalidAction.timeline.at(-1).applied, false);
});

test('bridge event binding, closed status set, positive sequence, identities and per-command watermark fail closed', () => {
  const base = flashPrefix();
  const id = base.id;
  const command = bridgeCommand(id);
  const registered = [ ...base.events, bridgeRegistration(id, 1, command) ];
  const queued = bridgeObservation(id, 2, command, { sequence: 1, state: 'QUEUED', evidence_id: `mock:${id}:bridge-observation:1` });
  const invalids = [
    bridgeObservation(id, 3, command, { sequence: 2, state: 'RUNNING', started_at: startedAt, evidence_id: `mock:${id}:invalid:first-running` }),
    bridgeObservation(id, 4, command, { sequence: 0, state: 'ACKED', evidence_id: `mock:${id}:invalid:zero-seq` }),
    bridgeObservation(id, 5, command, { sequence: 2, state: 'ACKED', lease_id: 'mock:wrong:lease', evidence_id: `mock:${id}:invalid:lease` }),
    bridgeObservation(id, 6, command, { sequence: 2, state: 'ACKED', fencing_token: 1, evidence_id: `mock:${id}:invalid:fence` }),
    bridgeObservation(id, 7, command, { sequence: 2, state: 'ACKED', device_identity: 'mock:other:device', evidence_id: `mock:${id}:invalid:device` }),
    bridgeObservation(id, 8, command, { sequence: 2, state: 'ACKED', image_identity: 'mock:other:boot', evidence_id: `mock:${id}:invalid:image` }),
    bridgeObservation(id, 9, command, { sequence: 2, state: 'SUCCEEDED', exit_code: 0, started_at: startedAt,
      finished_at: finishedAt, stdout_artifact_id: `mock:${id}:stdout`, stderr_artifact_id: `mock:${id}:stderr`,
      evidence_id: `mock:${id}:invalid:terminal-before-run` }),
    bridgeObservation(id, 10, command, { sequence: 2, state: 'NOT_A_BRIDGE_STATE', evidence_id: `mock:${id}:invalid:state` }),
  ];
  const result = replayScenario(scenario(id, [ ...registered, queued, ...invalids ]), workflow, stateContract);
  assert.equal(result.control.bridges[0].observation.state, 'QUEUED');
  assert.equal(result.control.bridges[0].last_sequence, 1);
  assert.equal(result.control.bridges[0].observation_history.length, 1);
  assert.ok(result.timeline.slice(-invalids.length).every(row => row.applied === false));
});

test('bridge terminal retry is immutable; same-result repeat is history-only and a changed terminal result is rejected', () => {
  const base = flashPrefix();
  const id = base.id;
  const command = bridgeCommand(id);
  const result = replayScenario(scenario(id, [
    ...base.events, bridgeRegistration(id, 1, command),
    bridgeObservation(id, 2, command, { sequence: 1, state: 'QUEUED', evidence_id: `mock:${id}:bridge-observation:1` }),
    bridgeObservation(id, 3, command, { sequence: 2, state: 'ACKED', evidence_id: `mock:${id}:bridge-observation:2` }),
    bridgeObservation(id, 4, command, { sequence: 3, state: 'RUNNING', started_at: startedAt, evidence_id: `mock:${id}:bridge-observation:3` }),
    bridgeObservation(id, 5, command, { sequence: 4, state: 'SUCCEEDED', started_at: startedAt, finished_at: finishedAt,
      exit_code: 0, stdout_artifact_id: `mock:${id}:stdout`, stderr_artifact_id: `mock:${id}:stderr`, evidence_id: `mock:${id}:bridge-observation:4` }),
    bridgeObservation(id, 6, command, { sequence: 5, state: 'SUCCEEDED', started_at: startedAt, finished_at: finishedAt,
      exit_code: 0, stdout_artifact_id: `mock:${id}:stdout`, stderr_artifact_id: `mock:${id}:stderr`, evidence_id: `mock:${id}:bridge-observation:5` }),
    bridgeObservation(id, 7, command, { sequence: 6, state: 'SUCCEEDED', started_at: startedAt, finished_at: finishedAt,
      exit_code: 0, stdout_artifact_id: `mock:${id}:changed-stdout`, stderr_artifact_id: `mock:${id}:stderr`, evidence_id: `mock:${id}:bridge-observation:6` }),
  ]), workflow, stateContract);
  const entry = result.control.bridges[0];
  assert.equal(entry.observation.evidence_id, `mock:${id}:bridge-observation:4`);
  assert.equal(entry.observation.stdout_artifact_id, `mock:${id}:stdout`);
  assert.equal(entry.observation_history.length, 5, 'the same terminal fact may be journaled without changing canonical result');
  assert.equal(entry.last_sequence, 5);
  assert.equal(result.timeline.at(-1).applied, false);
});

test('device lease cannot overlap; a released lease stays retired and a new lease needs a strictly newer fence', () => {
  const base = flashPrefix();
  const id = base.id;
  const command = bridgeCommand(id);
  const overlapping = bridgeCommand(id, { command_id: `mock:${id}:bridge-command:overlap`, lease_id: `mock:${id}:lease:overlap`,
    idempotency_key: `mock:${id}:bridge-key:overlap`, fencing_token: 1 });
  const concurrent = replayScenario(scenario(id, [
    ...base.events, bridgeRegistration(id, 1, command),
    bridgeObservation(id, 2, command, { sequence: 1, state: 'QUEUED', evidence_id: `mock:${id}:bridge-observation:1` }),
    bridgeRegistration(id, 8, overlapping),
  ]), workflow, stateContract);
  assert.equal(concurrent.control.bridges.length, 1, 'a second lease cannot overlap an unreleased lease on the same device');
  assert.equal(concurrent.timeline.at(-1).applied, false);

  const activeAndReleased = [
    ...base.events,
    bridgeRegistration(id, 1, command),
    bridgeObservation(id, 2, command, { sequence: 1, state: 'QUEUED', evidence_id: `mock:${id}:bridge-observation:1` }),
    bridgeObservation(id, 3, command, { sequence: 2, state: 'ACKED', evidence_id: `mock:${id}:bridge-observation:2` }),
    bridgeObservation(id, 4, command, { sequence: 3, state: 'RUNNING', started_at: startedAt, evidence_id: `mock:${id}:bridge-observation:3` }),
    bridgeObservation(id, 5, command, { sequence: 4, state: 'SUCCEEDED', started_at: startedAt, finished_at: finishedAt,
      exit_code: 0, stdout_artifact_id: `mock:${id}:stdout`, stderr_artifact_id: `mock:${id}:stderr`,
      evidence_id: `mock:${id}:bridge-observation:4` }),
    bridgeReconciliation(id, command, 4, 6),
    bridgeRelease(id, command, 7, 6),
  ];
  const reuse = bridgeCommand(id, { command_id: `mock:${id}:bridge-command:reuse`, fencing_token: 1,
    idempotency_key: `mock:${id}:bridge-key:reuse` });
  const retiredLease = replayScenario(scenario(id, [
    ...activeAndReleased, bridgeRegistration(id, 8, reuse),
  ]), workflow, stateContract);
  assert.equal(retiredLease.control.bridges.length, 1, 'a lease remains retired after release');
  assert.equal(retiredLease.timeline.at(-1).applied, false);

  const staleFence = bridgeCommand(id, { command_id: `mock:${id}:bridge-command:stale-fence`, lease_id: `mock:${id}:lease:new`,
    idempotency_key: `mock:${id}:bridge-key:stale-fence`, fencing_token: 0 });
  const rejectedFence = replayScenario(scenario(id, [
    ...activeAndReleased, bridgeRegistration(id, 8, staleFence),
  ]), workflow, stateContract);
  assert.equal(rejectedFence.control.bridges.length, 1, 'new lease must exceed the released lease fencing token');
  assert.equal(rejectedFence.timeline.at(-1).applied, false);

  const freshLease = { ...staleFence, command_id: `mock:${id}:bridge-command:fresh-fence`,
    idempotency_key: `mock:${id}:bridge-key:fresh-fence`, fencing_token: 1 };
  const acceptedFence = replayScenario(scenario(id, [
    ...activeAndReleased, bridgeRegistration(id, 8, freshLease),
  ]), workflow, stateContract);
  assert.equal(acceptedFence.control.bridges.length, 2);
  assert.equal(acceptedFence.control.bridges[1].command.fencing_token, 1);
  assert.equal(acceptedFence.control.bridges[1].released, false);
});

test('UNKNOWN before start may terminate as CANCELED with null timestamps and outputs', () => {
  const base = flashPrefix();
  const id = base.id;
  const command = bridgeCommand(id);
  const result = replayScenario(scenario(id, [
    ...base.events,
    bridgeRegistration(id, 1, command),
    bridgeObservation(id, 2, command, { sequence: 1, state: 'QUEUED', evidence_id: `mock:${id}:bridge-observation:1` }),
    bridgeObservation(id, 3, command, { sequence: 2, state: 'UNKNOWN', evidence_id: `mock:${id}:bridge-observation:2` }),
    bridgeObservation(id, 4, command, { sequence: 3, state: 'CANCELED', evidence_id: `mock:${id}:bridge-observation:3` }),
  ]), workflow, stateContract);
  assert.equal(result.control.bridges[0].observation.state, 'CANCELED');
  assert.equal(result.control.bridges[0].observation.started_at, null);
  assert.equal(result.control.bridges[0].observation.finished_at, null);
  assert.equal(result.control.bridges[0].quarantined, true, 'terminal observation alone does not release quarantine');
});

test('FAILED bridge results use fastboot identity, numeric timestamps, and reject reversed time bounds atomically', () => {
  const base = flashPrefix();
  const id = base.id;
  const command = bridgeCommand(id);
  const fastboot = `mock:fastboot:${registry.device_id.slice(5)}`;
  const events = [
    ...base.events,
    bridgeRegistration(id, 1, command),
    bridgeObservation(id, 2, command, { sequence: 1, state: 'QUEUED', evidence_id: `mock:${id}:bridge-observation:1` }),
    bridgeObservation(id, 3, command, { sequence: 2, state: 'ACKED', evidence_id: `mock:${id}:bridge-observation:2` }),
    bridgeObservation(id, 4, command, { sequence: 3, state: 'RUNNING', observed_mode: 'fastboot', device_identity: fastboot,
      started_at: startedAt, evidence_id: `mock:${id}:bridge-observation:3` }),
    bridgeObservation(id, 5, command, { sequence: 4, state: 'FAILED', observed_mode: 'fastboot', device_identity: fastboot,
      started_at: startedAt, finished_at: startedAt - 1, exit_code: 1,
      stdout_artifact_id: `mock:${id}:failed-stdout`, stderr_artifact_id: `mock:${id}:failed-stderr`,
      evidence_id: `mock:${id}:invalid:reversed-time` }),
    bridgeObservation(id, 6, command, { sequence: 5, state: 'FAILED', observed_mode: 'fastboot', device_identity: fastboot,
      started_at: startedAt, finished_at: finishedAt, exit_code: 1,
      stdout_artifact_id: `mock:${id}:failed-stdout`, stderr_artifact_id: `mock:${id}:failed-stderr`,
      evidence_id: `mock:${id}:bridge-observation:5` }),
  ];
  const result = replayScenario(scenario(id, events), workflow, stateContract);
  const entry = result.control.bridges[0];
  assert.equal(entry.observation.state, 'FAILED');
  assert.equal(entry.observation.observed_mode, 'fastboot');
  assert.equal(entry.observation.device_identity, fastboot);
  assert.equal(entry.observation.finished_at, finishedAt);
  assert.equal(entry.last_sequence, 5);
  assert.equal(entry.observation_history.length, 4, 'reversed-time report does not enter canonical history');
  assert.equal(result.timeline.at(-2).applied, false);
  assert.equal(result.steps.P22.state, 'RUNNING');
});

test('unscoped device quarantine survives idle telemetry and prevents cancel completion', () => {
  const base = flashPrefix();
  const id = base.id;
  const quarantine = stepEvent(id, 'device', 1, 'device', 'P22', {
    mode: 'mock', now_ms: 20_000, last_heartbeat_ms: 20_000, lease_expires_ms: 60_000, operation_state: 'unknown',
  });
  const idle = stepEvent(id, 'device', 2, 'device', 'P22', {
    mode: 'mock', now_ms: 21_000, last_heartbeat_ms: 21_000, lease_expires_ms: 60_000, operation_state: 'idle',
  });
  const commandId = `mock:${id}:cancel:unscoped`;
  const command = bridgeCommand(id);
  const events = [
    ...base.events,
    quarantine,
    idle,
    bridgeRegistration(id, 1, command),
    submittedCancel(id, 1, 'unscoped', base.result.revision + 2),
    appliedCancel(id, 2, 'unscoped'),
    executionEnd(id, 3, commandId, { stepExecutionId: 'mock:P22:c1:a1', agent: 'mock:P22:c1:a1', status: 'canceled' }),
    cancelBoundary(id, 4, commandId, { endIds: [`mock:${id}:execution-end:3`] }),
    cancelComplete(id, 5, commandId, 4),
  ];
  const result = replayScenario(scenario(id, events), workflow, stateContract);
  assert.equal(result.control.unscoped_quarantine, true);
  assert.equal(result.device.quarantined, true);
  assert.equal(result.device.reassign_allowed, false);
  assert.equal(result.control.bridges.length, 0, 'a bridge cannot be registered over an unscoped unknown device');
  assert.equal(result.control.phase, 'CANCEL_REQUESTED');
  assert.equal(result.status, 'RECONCILING');
  assert.equal(result.control.boundary, null);
  assert.equal(result.steps.P22.state, 'RUNNING', 'a rejected cancel barrier does not mutate the logical step');
  assert.equal(result.timeline.at(-2).applied, false);
  assert.equal(result.timeline.at(-1).applied, false);
});

test('late typed SQE result must match an admitted execution-end proof and invalidates an already accepted boundary', () => {
  const base = flashPrefix();
  const id = base.id;
  const commandId = `mock:${id}:cancel:late-sqe`;
  const lateResult = {
    actor: 'mock:sqe', execution_mode: 'bridge_mock', task_id: null, performer_id: 'mock:sqe',
    candidate_fingerprint: registry.candidate_fingerprint, profile_ref: 'mock:sqe:profile',
    profile_version: 'mock:sqe:profile:v1', script_version: 'mock:sqe:script:v1',
    parser_version: 'mock:sqe:parser:v1', rule_version: 'mock:rules:v1', device_id: registry.device_id,
    bridge_id: registry.bridge_id, image_hash: registry.image_hash_ref, observed_device_id: registry.device_id,
    observed_image_identity: registry.expected_image_identity, started_at_ms: 1_797_509_600_000,
    finished_at_ms: 1_797_509_600_001, execution_status: 'completed', parser_status: 'complete', exit_code: 0,
    cases: [
      { case_id: 'mock:sqe:case:boot', outcome: 'PASS' },
      { case_id: 'mock:sqe:case:function', outcome: 'PASS' },
    ], stdout_artifact_id: `mock:${id}:late-sqe:stdout`, stderr_artifact_id: `mock:${id}:late-sqe:stderr`,
    result_artifact_id: `mock:${id}:late-sqe:result`, evidence_id: `mock:${id}:late-sqe-result`,
  };
  const result = replayScenario(scenario(id, [
    ...base.events,
    submittedCancel(id, 1, 'late-sqe', base.result.revision),
    appliedCancel(id, 2, 'late-sqe'),
    executionEnd(id, 3, commandId, { stepExecutionId: 'mock:P22:c1:a1', agent: 'mock:P22:c1:a1',
      status: 'completed', prior: null }),
    cancelBoundary(id, 4, commandId, { endIds: [`mock:${id}:execution-end:3`] }),
    stepEvent(id, 'late-sqe', 1, 'sqe_result', 'P22', lateResult),
  ]), workflow, stateContract);
  assert.equal(result.control.execution_ends[0].status, 'completed');
  assert.equal(result.control.execution_ends[0].prior_result_evidence_id, null);
  assert.equal(result.control.phase, 'CANCEL_REQUESTED');
  assert.equal(result.control.boundary, null, 'a typed result that contradicts a nullable end acknowledgement invalidates its barrier');
  assert.equal(result.control.reconciliation_required, true);
  assert.equal(result.status, 'RECONCILING');
  assert.equal(result.steps.P22.sqe_result, null, 'late proof remains in the control fact journal and is not promoted into the step');
  assert.equal(result.control.facts.at(-1).type, 'sqe_result');
  assert.equal(result.control.facts.at(-1).payload.evidence_id, lateResult.evidence_id);
  assert.equal(result.timeline.at(-1).applied, true);
});

test('late typed result for a guessed future execution is not admitted by the cancel snapshot', () => {
  const base = flashPrefix();
  const id = base.id;
  const commandId = `mock:${id}:cancel:future-step`;
  const result = replayScenario(scenario(id, [
    ...base.events,
    submittedCancel(id, 1, 'future-step', base.result.revision),
    appliedCancel(id, 2, 'future-step'),
    stepEvent(id, 'future-result', 1, 'notes_failure', 'P23', {
      evidence_id: `mock:${id}:guessed-future-p23-failure`,
    }),
  ]), workflow, stateContract);
  assert.equal(result.control.phase, 'CANCEL_REQUESTED');
  assert.ok(result.control.known_executions.some(execution => execution.step_id === 'P22'));
  assert.equal(result.control.known_executions.some(execution => execution.step_id === 'P23'), false,
    'future step identity may exist in the workflow, but was not admitted as an execution');
  assert.equal(result.control.facts.length, 1, 'only accepted cancel intent is recorded');
  assert.equal(result.steps.P23.state, 'PENDING');
  assert.equal(result.timeline.at(-1).applied, false);
  assert.equal(result.timeline.at(-1).reason, 'invalid_late_control_result');
});

test('bridge cancellation needs result, reconciliation, and lock/lease release before an exact cancel barrier', () => {
  const base = flashPrefix();
  const id = base.id;
  const command = bridgeCommand(id);
  const commandId = `mock:${id}:cancel:bridge`;
  const activeEvents = [
    ...base.events,
    bridgeRegistration(id, 1, command),
    bridgeObservation(id, 2, command, { sequence: 1, state: 'QUEUED', evidence_id: `mock:${id}:bridge-observation:1` }),
    bridgeObservation(id, 3, command, { sequence: 2, state: 'UNKNOWN', evidence_id: `mock:${id}:bridge-observation:2` }),
  ];
  const active = replayScenario(scenario(id, activeEvents), workflow, stateContract);
  assert.equal(active.device?.quarantined, true);
  assert.equal(active.device?.reassign_allowed, false);
  assert.equal(active.current_step, 'P22');

  const end = executionEnd(id, 3, commandId, {
    stepExecutionId: 'mock:P22:c1:a1', agent: 'mock:P22:c1:a1', status: 'canceled', prior: null,
  });
  const terminal = bridgeObservation(id, 4, command, { sequence: 3, state: 'CANCELED', started_at: startedAt,
    finished_at: finishedAt, stdout_artifact_id: `mock:${id}:canceled-stdout`, stderr_artifact_id: `mock:${id}:canceled-stderr`,
    evidence_id: `mock:${id}:bridge-observation:3` });
  const reconciliation = bridgeReconciliation(id, command, 3, 5);
  const release = bridgeRelease(id, command, 6, 5);
  const prefix = [
    ...activeEvents,
    submittedCancel(id, 1, 'bridge', active.revision), appliedCancel(id, 2, 'bridge'),
    terminal, reconciliation,
    end,
  ];
  const premature = replayScenario(scenario(id, [
    ...prefix,
    cancelBoundary(id, 4, commandId, { endIds: [`mock:${id}:execution-end:3`] }),
  ]), workflow, stateContract);
  assert.equal(premature.control.phase, 'CANCEL_REQUESTED');
  assert.equal(premature.control.boundary, null);
  assert.equal(premature.timeline.at(-1).applied, false);

  const complete = replayScenario(scenario(id, [
    ...prefix,
    release,
    cancelBoundary(id, 5, commandId, {
      endIds: [`mock:${id}:execution-end:3`],
      bridgeRecon: [`mock:${id}:bridge-reconciliation:5`],
      bridgeReleaseIds: [`mock:${id}:bridge-release:6`],
    }),
    cancelComplete(id, 6, commandId, 5),
  ]), workflow, stateContract);
  assert.equal(complete.control.phase, 'CANCELED');
  assert.equal(complete.status, 'CANCELED');
  assert.equal(complete.steps.P22.state, 'CANCELED');
  assert.equal(complete.steps.P22.sqe_result, null);
  assert.equal(complete.release.publication_count, 0);
  assert.equal(complete.device.reassign_allowed, false);
  assert.equal(complete.device.quarantined, false);
});

test('remote unknown and absent observations are not terminal; found receipt never auto-advances P25', () => {
  const base = remotePrefix();
  const id = base.id;
  const commandId = `mock:${id}:cancel:remote-found`;
  const receipt = `mock:${id}:remote-receipt:c1`;
  const end = executionEnd(id, 3, commandId, {
    stepId: 'P25', agent: 'mock:P25:c1:a1', status: 'completed', prior: null,
  });
  const prefix = [
    ...base.events,
    remoteIntent(id),
    submittedCancel(id, 1, 'remote-found', 128), appliedCancel(id, 2, 'remote-found'),
    remoteObserved(id, 2, 1, 'unknown'),
    remoteObserved(id, 3, 2, 'absent'),
    end,
  ];
  const noTerminal = replayScenario(scenario(id, [
    ...prefix,
    cancelBoundary(id, 4, commandId, { endIds: [`mock:${id}:execution-end:3`] }),
  ]), workflow, stateContract);
  assert.equal(noTerminal.control.phase, 'CANCEL_REQUESTED');
  assert.equal(noTerminal.control.remotes[0].terminal, null);
  assert.equal(noTerminal.release.publication_count, 0);
  assert.equal(noTerminal.timeline.at(-1).applied, false);

  const events = [
    ...prefix,
    remoteObserved(id, 4, 3, 'found', receipt),
    remoteTerminal(id, 5, 3, 'completed', receipt),
    cancelBoundary(id, 5, commandId, {
      endIds: [`mock:${id}:execution-end:3`], remoteTerminalIds: [`mock:${id}:remote-terminal:5`],
    }),
    cancelComplete(id, 6, commandId, 5),
    remoteObserved(id, 6, 4, 'found', receipt),
    remoteObserved(id, 7, 5, 'found', `mock:${id}:conflicting-receipt:c1`),
  ];
  const result = replayScenario(scenario(id, events), workflow, stateContract);
  assert.equal(result.control.phase, 'CANCELED');
  assert.equal(result.status, 'CANCELED');
  assert.equal(result.current_step, 'P25');
  assert.equal(result.steps.P25.state, 'CANCELED');
  assert.equal(result.steps.P26.state, 'CANCELED');
  assert.equal(result.release.receipt_id, receipt);
  assert.equal(result.release.publication_count, 1);
  assert.equal(result.control.remotes[0].canonical_receipt_id, receipt);
  assert.equal(result.control.reconciliation_required, true);
  assert.ok(result.control.remotes[0].conflicts.length > 0);
});

test('a provider canceled_no_effect terminal still records a late first found receipt exactly once and flags conflict', () => {
  const base = remotePrefix();
  const id = base.id;
  const commandId = `mock:${id}:cancel:remote-no-effect`;
  const receipt = `mock:${id}:late-receipt:c1`;
  const end = executionEnd(id, 3, commandId, {
    stepId: 'P25', agent: 'mock:P25:c1:a1', status: 'canceled', prior: null,
  });
  const result = replayScenario(scenario(id, [
    ...base.events,
    remoteIntent(id),
    submittedCancel(id, 1, 'remote-no-effect', 128), appliedCancel(id, 2, 'remote-no-effect'),
    remoteObserved(id, 2, 1, 'absent'),
    remoteTerminal(id, 3, 1, 'canceled_no_effect'),
    end,
    cancelBoundary(id, 4, commandId, {
      endIds: [`mock:${id}:execution-end:3`], remoteTerminalIds: [`mock:${id}:remote-terminal:3`],
    }),
    cancelComplete(id, 5, commandId, 4),
    remoteObserved(id, 4, 2, 'unknown'),
    remoteObserved(id, 5, 3, 'found', receipt),
  ]), workflow, stateContract);
  assert.equal(result.control.phase, 'CANCELED');
  assert.equal(result.status, 'CANCELED');
  assert.equal(result.control.reconciliation_required, true);
  assert.equal(result.release.receipt_id, receipt);
  assert.equal(result.release.publication_count, 1);
  assert.equal(result.steps.P25.state, 'CANCELED');
  assert.equal(result.steps.P26.state, 'CANCELED');
  assert.equal(result.control.remotes[0].queries.at(-2).outcome, 'unknown');
  assert.equal(result.control.remotes[0].history.some(row => row.kind === 'terminal'
    && row.fact.provider_state === 'canceled_no_effect'), true, 'an intervening unknown query cannot erase the prior provider terminal fact');
  assert.equal(result.control.remotes[0].conflicts.length, 1);
});

test('prior-cycle remote observations update only the archived operation ledger in an isolated helper fixture', () => {
  const base = remotePrefix();
  const id = base.id;
  const terminal = {
    actor: 'mock:publisher', operation_key: 'mock:prior-c1:remote-operation',
    manifest_id: 'mock:prior-c1:manifest', digest: 'mock:prior-c1:digest',
    candidate_fingerprint: 'mock:candidate:A', rule_version: 'mock:rules:v1', destination: 'mock:destination',
    step_id: 'P25', cycle: 1, attempt: 1, execution_id: 'mock:P25:c1:a1', provider_state: 'canceled_no_effect',
    receipt_id: null, query_evidence_id: 'mock:prior-c1:query:1', evidence_id: 'mock:prior-c1:terminal', safe_boundary: true,
  };
  const archived = {
    operation_key: terminal.operation_key, manifest_id: terminal.manifest_id, digest: terminal.digest,
    candidate_fingerprint: terminal.candidate_fingerprint, rule_version: terminal.rule_version,
    destination: terminal.destination, step_id: 'P25', cycle: 1, attempt: 1, execution_id: terminal.execution_id,
    evidence_id: 'mock:prior-c1:intent', queries: [{ query_seq: 1, outcome: 'absent', receipt_id: null }],
    query_seq: 1, last_query: { query_seq: 1, outcome: 'absent', receipt_id: null },
    terminal, canonical_receipt_id: null, conflicts: [], history: [{ kind: 'terminal', fact: terminal }],
  };
  const result = structuredClone(base.result);
  result.cycle = 2;
  result.candidate_fingerprint = 'mock:candidate:B';
  result.control = {
    phase: null, admission_open: true, reconciliation_required: false, unscoped_quarantine: false,
    generic_device: null, bridges: [], remotes: [archived], facts: [],
  };
  result.steps.P25.cycle = 2;
  result.steps.P25.execution_id = 'mock:P25:c2:a1';
  const before = structuredClone({
    status: result.status, current_step: result.current_step, cycle: result.cycle,
    candidate_fingerprint: result.candidate_fingerprint, steps: result.steps,
    release: result.release, device: result.device, phase: result.control.phase,
    admission_open: result.control.admission_open, reconciliation_required: result.control.reconciliation_required,
  });
  const recorded = [];
  const usedEvidence = new Set();
  const effects = createControlEffects({
    result,
    mockId: value => typeof value === 'string' && /^mock:[A-Za-z0-9:._/-]+$/.test(value),
    fresh: value => !usedEvidence.has(value) && (usedEvidence.add(value), true),
    recordFact: event => recorded.push(structuredClone(event)),
    invalidateBoundary: () => { result.control.boundary = null; },
    releaseMatches: () => true,
  });
  const archivedQuery = (eventSeq, querySeq, outcome, receiptId = null) => jobEvent(id, 'remote', eventSeq, 'remote_observed', {
    actor: 'mock:publisher', operation_key: terminal.operation_key, query_seq: querySeq, outcome,
    manifest_id: terminal.manifest_id, digest: terminal.digest,
    candidate_fingerprint: terminal.candidate_fingerprint, cycle: terminal.cycle,
    attempt: terminal.attempt, execution_id: terminal.execution_id, receipt_id: receiptId,
    evidence_id: `mock:prior-c1:query:${querySeq}`,
  });
  const unknown = archivedQuery(1, 2, 'unknown');
  const foundReceipt = 'mock:prior-c1:late-receipt';
  const found = archivedQuery(2, 3, 'found', foundReceipt);
  assert.equal(effects.apply(unknown), '');
  assert.equal(effects.apply(found), '');
  const after = structuredClone({
    status: result.status, current_step: result.current_step, cycle: result.cycle,
    candidate_fingerprint: result.candidate_fingerprint, steps: result.steps,
    release: result.release, device: result.device, phase: result.control.phase,
    admission_open: result.control.admission_open, reconciliation_required: result.control.reconciliation_required,
  });
  assert.deepEqual(after, before, 'the unreachable prior-cycle query fixture cannot change current-cycle gates, step state, or publication');
  assert.equal(result.control.remotes[0].query_seq, 3);
  assert.equal(result.control.remotes[0].last_query.outcome, 'found');
  assert.equal(result.control.remotes[0].canonical_receipt_id, foundReceipt);
  assert.equal(result.control.remotes[0].conflicts.length, 1);
  assert.equal(result.control.remotes[0].terminal, null, 'a newer unknown observation clears the current terminal projection');
  assert.equal(result.control.remotes[0].history.find(row => row.kind === 'terminal').fact.provider_state, 'canceled_no_effect',
    'the prior provider promise remains in immutable history');
  assert.equal(result.control.remotes[0].history.filter(row => row.kind === 'query').length, 2);
  assert.equal(recorded.length, 2);
  assert.equal(before.release.publication_count, 0);
  assert.equal(before.steps.P25.state, 'RUNNING');
  assert.equal(before.release.approved, true);
  assert.equal(before.cycle, 2);
});
