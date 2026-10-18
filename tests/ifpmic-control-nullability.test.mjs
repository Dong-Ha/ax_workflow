import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createScenarioCatalog, replayScenario } from '../src/ifpmic/replay.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specs = path.join(root, 'docs/ifpmic/design-v1/specs');
const [workflow, stateContract] = await Promise.all([
  readFile(path.join(specs, 'workflow.v1.json'), 'utf8').then(JSON.parse),
  readFile(path.join(specs, 'state-contract.json'), 'utf8').then(JSON.parse),
]);
const catalog = createScenarioCatalog(workflow, stateContract);

// Independent K4 schema oracle: literal fields and source event indexes from
// the approved 15 controls fixtures, never imported from the product validator.
const anchors = Object.freeze({
  control_submitted: { scenario: 'control-command-lifecycle', index: 2 },
  control_apply: { scenario: 'control-command-lifecycle', index: 3 },
  control_pause_ack: { scenario: 'control-command-lifecycle', index: 4 },
  control_execution_end: { scenario: 'cancel-flash-unknown', index: 116 },
  control_cancel_boundary: { scenario: 'cancel-child', index: 65 },
  control_cancel_complete: { scenario: 'cancel-child', index: 66 },
  bridge_registered: { scenario: 'cancel-flash-unknown', index: 104 },
  bridge_observed: { scenario: 'cancel-flash-unknown', index: 105 },
  bridge_reconciled: { scenario: 'cancel-flash-unknown', index: 114 },
  bridge_released: { scenario: 'cancel-flash-unknown', index: 115 },
  remote_intent: { scenario: 'cancel-remote-late-receipt', index: 127 },
  remote_observed: { scenario: 'cancel-remote-late-receipt', index: 128 },
  remote_terminal: { scenario: 'cancel-remote-late-receipt', index: 132 },
});
const fields = Object.freeze({
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
});
const nullable = Object.freeze({
  bridge_observed: ['exit_code', 'stdout_artifact_id', 'stderr_artifact_id', 'test_result_artifact_id', 'started_at', 'finished_at'],
  control_execution_end: ['prior_result_evidence_id'],
  remote_observed: ['receipt_id'],
});
const nullRejectReason = Object.freeze({
  control_submitted: 'invalid_control_submission',
  control_apply: 'invalid_control_application',
  control_pause_ack: 'invalid_pause_ack',
  control_execution_end: 'invalid_execution_end',
  control_cancel_boundary: 'invalid_cancel_boundary',
  control_cancel_complete: 'invalid_cancel_completion',
  bridge_registered: 'invalid_bridge_registration',
  bridge_observed: 'invalid_bridge_observation',
  bridge_reconciled: 'invalid_bridge_reconciliation',
  bridge_released: 'invalid_bridge_release',
  remote_intent: 'invalid_remote_intent',
  remote_observed: 'invalid_remote_observation',
  remote_terminal: 'invalid_remote_terminal',
});
const nullEvidenceReason = Object.freeze({
  control_apply: 'invalid_control_application',
  control_pause_ack: 'invalid_pause_ack',
  control_execution_end: 'invalid_control_evidence',
  control_cancel_boundary: 'invalid_control_evidence',
  control_cancel_complete: 'invalid_control_evidence',
  bridge_registered: 'invalid_control_evidence',
  bridge_observed: 'invalid_control_evidence',
  bridge_reconciled: 'invalid_control_evidence',
  bridge_released: 'invalid_control_evidence',
  remote_intent: 'invalid_control_evidence',
  remote_observed: 'invalid_control_evidence',
  remote_terminal: 'invalid_control_evidence',
});

function scenarioFor(type) {
  const anchor = anchors[type];
  const scenario = catalog.find(item => item.id === anchor.scenario);
  assert.ok(scenario, `${type} fixed anchor scenario exists`);
  const event = scenario.events[anchor.index];
  assert.ok(event, `${type} fixed anchor index exists`);
  assert.equal(event.type, type, `${type} pinned event index`);
  assert.equal(event.source_id, 'mock:controls-catalog', `${type} anchor is authored control evidence`);
  assert.equal(event.mode, 'mock');
  assert.equal(event.step_id, undefined, `${type} uses the exact job event envelope`);
  return { scenario, event, index: anchor.index };
}

function projection(snapshot) {
  const { timeline, ignored, duplicate_count, conflict_count, ...domain } = structuredClone(snapshot);
  if (domain.control) domain.control.commands = [];
  return domain;
}

function runMutation(scenario, index, event) {
  const candidate = { ...scenario, events: [...scenario.events.slice(0, index), event] };
  return replayScenario(candidate, workflow, stateContract, candidate.events.length);
}

function assertRejectedAtomically(type, scenario, index, original, mutated, expectedReason, label) {
  const before = replayScenario(scenario, workflow, stateContract, index);
  const result = runMutation(scenario, index, mutated);
  const row = result.timeline.at(-1);
  assert.equal(row.event_id, original.event_id, `${type}/${label} retains the event identity`);
  assert.equal(row.applied, false, `${type}/${label} is rejected`);
  assert.equal(row.reason, expectedReason, `${type}/${label} uses the fixed rejection class`);
  assert.deepEqual(result.control.commands, before.control.commands, `${type}/${label} does not mutate command receipts`);
  assert.deepEqual(projection(result), projection(before), `${type}/${label} leaves the business projection unchanged`);
}

test('each of the thirteen fixed control job event anchors is a valid applied positive control', () => {
  assert.deepEqual(Object.keys(anchors).sort(), Object.keys(fields).sort(), 'literal type inventories match exactly');
  assert.deepEqual(Object.keys(fields).sort(), Object.keys(nullRejectReason).sort(), 'every event type has a literal null policy');
  for (const type of Object.keys(fields)) {
    const { scenario, index, event } = scenarioFor(type);
    const prefix = replayScenario(scenario, workflow, stateContract, index + 1);
    const row = prefix.timeline.at(-1);
    assert.equal(row.event_id, event.event_id, `${type} positive anchor event`);
    assert.equal(row.applied, true, `${type} positive anchor applies before mutations`);
  }
});

test('every required control job payload field is rejected when omitted or null unless the fixed scenario proves it nullable', () => {
  for (const type of Object.keys(fields)) {
    const { scenario, event, index } = scenarioFor(type);
    const allowedNulls = nullable[type] ?? [];
    for (const key of fields[type]) {
      assert.ok(Object.hasOwn(event.payload, key), `${type}.${key} exists in the valid source anchor`);

      const missing = structuredClone(event);
      delete missing.payload[key];
      assertRejectedAtomically(type, scenario, index, event, missing, 'invalid_control_payload', `${key}/missing`);

      const withNull = structuredClone(event);
      withNull.payload[key] = null;
      if (allowedNulls.includes(key)) {
        const before = replayScenario(scenario, workflow, stateContract, index);
        const result = runMutation(scenario, index, withNull);
        assert.equal(result.timeline.at(-1).event_id, event.event_id, `${type}.${key}/nullable event identity`);
        assert.equal(result.timeline.at(-1).applied, true, `${type}.${key} null is explicitly allowed by this fixed anchor`);
        assert.notDeepEqual(projection(result), projection(before), `${type}.${key} nullable event is accepted as a ledger observation`);
      } else {
        const reason = key === 'evidence_id' ? nullEvidenceReason[type] : nullRejectReason[type];
        assertRejectedAtomically(type, scenario, index, event, withNull, reason, `${key}/null`);
      }

      const extra = structuredClone(event);
      extra.payload.unexpected_control_schema_field = `mock:${type}:extra`;
      assertRejectedAtomically(type, scenario, index, event, extra, 'unknown_payload_field', `${key}/extra`);
    }
  }
});
