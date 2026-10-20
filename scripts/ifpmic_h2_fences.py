"""Structural validation of the four retained SQL/auth raw observations.

Schemas mirror JSON emitted by test_workflow_schema.py. This is not a SQL
business oracle: fresh runtime tests and their independent review remain required.
No product, database driver or Temporal SDK is imported here.
"""
from __future__ import annotations

import hashlib
import json
import re

from scripts.ifpmic_h2_raw_evidence import EvidenceError, _require

_PREFIX = 'tests/ifpmic_api/test_workflow_schema.py::'
CASE_NODES = {
    'role_registry_and_function_acl': _PREFIX + 'test_h2_role_registry_and_function_acl_match_static_contract',
    'four_role_oid_recreation': _PREFIX + 'test_h2_four_role_oid_recreation_is_drift_and_does_not_rebind',
    'service_role_scram_hba': _PREFIX + 'test_h2_service_roles_use_scram_without_trust_fallthrough',
    'real_create_activation_receipt_replay_and_run_fences':
        _PREFIX + 'test_h2_real_create_activation_receipt_replay_and_run_fences',
}
_ROLES = ('runtime', 'operator', 'dispatcher', 'projector')
_TABLES = ('jobs', 'commands', 'commands_outbox', 'workspace_intents',
           'execution_bindings', 'worker_run_scopes', 'projection_receipts', 'delivery_attempts')


def _text(value):
    return type(value) is str and bool(value)


def _positive(value):
    return type(value) is int and value > 0


def _nonnegative(value):
    return type(value) is int and value >= 0


def _sha(value):
    return type(value) is str and re.fullmatch('[0-9a-f]{64}', value) is not None


def _object(value):
    return type(value) is dict and bool(value)


def _boolean(value):
    return type(value) is bool


def _nullable(predicate):
    return lambda value: value is None or predicate(value)


def _fields(**fields):
    def check(value):
        return (type(value) is dict and set(fields) <= set(value) and
                all(predicate(value[key]) for key, predicate in fields.items()))
    return check


def _row(*predicates):
    return lambda value: (type(value) is list and len(value) == len(predicates) and
                          all(predicate(item) for predicate, item in zip(predicates, value)))


def _rows(predicate, *, minimum=0, maximum=None):
    return lambda value: (type(value) is list and len(value) >= minimum and
                          (maximum is None or len(value) <= maximum) and
                          all(predicate(item) for item in value))


def _count(predicate, count):
    return _rows(predicate, minimum=count, maximum=count)


_ROLE_FLAGS = _row(_text, _positive, *([_boolean] * 7))
_PRINCIPAL = _row(_positive, _text, _text, _text, _nullable(_text), _boolean)
_CONFIG_ROW = _row(_boolean, _text, _positive, _text, _positive, _text,
                   _positive, _text, _positive, _text)
_BUILD = _fields(build_id=_text, workflow_type=_text, protocol_version=_text,
                 namespace=_text, server_endpoint=_text, server_config_sha256=_sha,
                 source_manifest_sha256=_sha, environment_manifest_sha256=_sha)
# Registry read_build includes execution location fields; dispatch_config's
# nested builds are smaller and only carry per-build fields (source lines607-613).
_DISPATCH_BUILD = _fields(build_id=_text, source_manifest_sha256=_sha,
                          environment_manifest_sha256=_sha)
_ROLE_SCHEMA = _fields(
    role_acl_observations=_fields(
        role_config=_count(_CONFIG_ROW, 1), roles=_count(_ROLE_FLAGS, 4),
        functions=_count(_fields(
            signature=_text, expected_allowed_kinds=_rows(_text, minimum=1),
            metadata=_row(_positive, _nullable(_text), _text, _boolean, _nullable(_rows(_text))),
            role_execute=_fields(**{role: _boolean for role in _ROLES}), public_execute=_boolean), 11),
        table_privileges=_count(_fields(role_kind=_text, table=_text,
                                        privileges=_row(*([_boolean] * 4))), 32),
        catalog_privileges=_count(_fields(role_kind=_text, column=_text,
                                          table_update_delete=_row(_boolean, _boolean),
                                          column_update=_boolean), 36),
        job_create_command_column_privileges=_fields(INSERT=_boolean, UPDATE=_boolean),
        worker_principals=_count(_PRINCIPAL, 2)),
    dispatcher_session_identity=_row(_text, _text),
    dispatcher_read_config=_fields(deployment_id=_text, namespace=_text,
                                   server_endpoint=_text, server_config_sha256=_sha,
                                   builds=_count(_DISPATCH_BUILD, 1)),
    projector_session_identity=_row(_text, _text), projector_registered_build=_BUILD,
    denied_operations=_count(_fields(role=_text, statement=_text, sqlstate=_text), 14))
_OID_SCHEMA = _fields(
    migration_result=_fields(applied=_rows(_text, minimum=1), unchanged=_rows(_text)),
    original_config=_row(_positive, _text), replacement_role_oid=_positive,
    migration_error=_fields(type=_text, code=_text),
    final_config=_count(_row(_boolean, _text, _positive, _text), 1),
    current_role_oid=_positive, immutable_principal_rows=_rows(_PRINCIPAL),
    replacement_role_privileges=_row(_boolean, _boolean))
_SCRAM_SCHEMA = _fields(
    successful_session_users=_count(_text, 4),
    rejected_password_attempts=_count(_fields(
        attempt=_nonnegative, exception_type=_text, sqlstate=_nullable(_text),
        message=_text, expected_reason=_text), 3),
    actual_hba_rules=_count(_row(_positive, _count(_text, 1), _text), 4))
_RECEIPT = _fields(status=_text, command_id=_text, resource_id=_text)
_WINDOW = _row(*([lambda value: value is None] * 3))
# Full JSONB row columns from migrations001/003 (no application imports).
_BINDING_FIELDS = {
    **{key: _text for key in ('job_id', 'project_id', 'create_command_id', 'deployment_id',
                              'namespace', 'temporal_workflow_id', 'workflow_type',
                              'build_id', 'task_queue', 'snapshot_id', 'workspace_token', 'state')},
    **{key: _sha for key in ('server_config_sha256', 'catalog_record_sha256', 'workflow_sha256',
                             'state_sha256', 'agent_sha256', 'command_payload_sha256', 'binding_sha256')},
    'workspace_generation': _nonnegative, 'admitted_run_id': _nullable(_text),
    'first_start_attempt_at': _nullable(_text), 'uncertain_until': _nullable(_text),
    'observed_retention_seconds': _nullable(_positive), 'quarantine_code': _nullable(_text),
}
_BINDING = _fields(**_BINDING_FIELDS)
_PROJECT_RESULT = _fields(status=_text, command_id=_text, applied_revision=_nullable(_nonnegative),
                          error_code=_nullable(_text), job_id=_text, job_status=_text,
                          revision=_nonnegative)
_JOB = _fields(job_id=_text, owner_id=_text, project_id=_text, snapshot_id=_text,
                workflow_id=_text, status=_text, revision=_nonnegative, cycle=_nonnegative,
                current_step_ids=_rows(_text), candidate_fingerprint=_nullable(_text),
                created_at=_text, create_command_id=_text, create_route=_text)
_COMMAND = _fields(command_id=_text, actor_id=_text, route=_text, idempotency_key=_text,
                    project_id=_text, job_id=_text, command_payload_json=_text, payload_sha256=_sha,
                    status=_text, applied_revision=_nullable(_nonnegative),
                    error_code=_nullable(_text), created_at=_text)
_OUTBOX = _fields(command_id=_text, state=_text, created_at=_text, generation=_nonnegative,
                  claim_token=_nullable(_text), claim_expires_at=_nullable(_text),
                  next_attempt_at=_text, last_error=_nullable(_text),
                  observed_run_id=_nullable(_text), dispatched_at=_nullable(_text))
_WORKSPACE = _fields(job_id=_text, command_id=_text, workspace_token=_text, state=_text,
                     generation=_nonnegative, claim_token=_nullable(_text),
                     claim_expires_at=_nullable(_text), error_code=_nullable(_text))
_SCOPE = _fields(job_id=_text, admitted_run_id=_text, projector_role_oid=_positive,
                 projector_role_name=_text, deployment_id=_text, build_id=_text)
_PROJECTION = _fields(job_id=_text, transition_sequence=_positive, command_id=_text,
                      admitted_run_id=_text, build_id=_text, proposal_sha256=_sha,
                      expected_revision=_nonnegative, outcome=_text, result_json=_PROJECT_RESULT,
                      committed_at=_text)
_DELIVERY = _fields(command_id=_text, generation=_positive, attempted_at=_text,
                    completed_at=_nullable(_text), result=_nullable(_text),
                    observed_run_id=_nullable(_text), error_code=_nullable(_text))
_TABLE_SCHEMAS = dict(zip(_TABLES, (_JOB, _COMMAND, _OUTBOX, _WORKSPACE, _BINDING,
                                  _SCOPE, _PROJECTION, _DELIVERY)))


def _final_rows(*, conflict):
    # Both branches reserve/admit/ack; admit_run inserts a scope even without a
    # running worker. Only the quarantined branch legitimately has no receipt.
    return _fields(**{table: _rows(predicate, minimum=0 if conflict and
                                   table == 'projection_receipts' else 1,
                                   maximum=0 if conflict and table == 'projection_receipts' else None)
                       for table, predicate in _TABLE_SCHEMAS.items()})


_CLAIM = _fields(status=_text, command_id=_text, job_id=_text, project_id=_text,
                 payload_sha256=_sha, generation=_positive, claim_token=_text,
                 claim_expires_at=_text, route=_text, command_status=_text, create_command_id=_text,
                 binding=_nullable(_BINDING),
                 workspace=_fields(state=_text, workspace_token=_text, generation=_nonnegative))
_BINDING_RESULT = _fields(status=_text, binding=_BINDING)
_STALE = _fields(status=_text, code=_text)
_ACK = _fields(status=_text, affected=_nonnegative)
_FUNCTION_SCHEMA = _fields(**{
    'claim': _CLAIM, 'conflict_claim': _CLAIM,
    **{key: _BINDING_RESULT for key in ('reserve', 'start_attempt', 'admission',
                                      'conflict_reserve', 'conflict_start_attempt', 'conflict_admission')},
    **{key: _STALE for key in ('stale_reserve', 'stale_admission', 'workspace_wait', 'conflict_projection')},
    'stale_ack': _fields(status=_text, affected=_nonnegative, code=_text),
    'ack': _ACK, 'conflict_ack': _ACK,
    'activation_ready': _fields(status=_text, job_id=_text, binding_sha256=_sha, command_id=_text,
                                 command_payload_sha256=_sha, revision=_nonnegative,
                                 workspace_token=_text, workspace_generation=_nonnegative),
    'project_activation': _PROJECT_RESULT, 'replay_after_revocation': _PROJECT_RESULT,
    'initial_window': _WINDOW,
    'partial_window_rejections': _count(_fields(assignment=_text, sqlstate=_text,
                                               constraint=_text, restored_window=_WINDOW), 2),
    'wrong_run_denial': _fields(sqlstate=_text),
    'direct_command_table_denial': _fields(sqlstate=_text),
    'api_replay': _fields(status_code=_positive, json=_RECEIPT),
    'command_outcome_rejections': _count(_fields(
        command_id=_text, before=_row(_text, _nullable(_nonnegative), _nullable(_text)),
        requested=_row(_text, _nullable(_nonnegative), _nullable(_text)),
        sqlstate=_text, constraint=_text), 2),
})
_JOB_DTO = _fields(job_id=_text, owner_id=_text, status=_text, revision=_nonnegative,
                    cycle=_nonnegative, workflow_version=_text, current_step_ids=_rows(_text),
                    candidate_fingerprint=_nullable(_text),
                    profile_version=lambda value: type(value) is str)
_ERROR = _fields(code=_text, message=_text, trace_id=_text)
_CREATE_SCHEMA = _fields(
    nul_rejection=_fields(status_code=_positive, body=_ERROR,
                          counts_before=_row(_nonnegative, _nonnegative),
                          counts_after=_row(_nonnegative, _nonnegative)),
    accepted_create=_RECEIPT, payload_sha256=_sha, function_results=_FUNCTION_SCHEMA,
    workspace_identity=_fields(token=_text, generation=_positive),
    binding_sha256=_sha, proposal_sha256=_sha,
    api_listing=_fields(status_code=_positive, matching_job=_JOB_DTO),
    api_detail=_fields(job=_JOB_DTO, steps=_rows(_object),
                       last_event_id=lambda value: type(value) is str),
    api_command=_fields(command_id=_text, status=_text, applied_revision=_nonnegative,
                        error=_nullable(_object)),
    revoked_api_responses=_count(_fields(status_code=_positive, body=_ERROR), 3),
    conflict=_fields(accepted=_RECEIPT, payload_sha256=_sha, binding_sha256=_sha,
                     proposal_sha256=_sha,
                     state=_row(_text, _nonnegative, _text, _text, _text, _nonnegative)),
    primary_final_rows=_final_rows(conflict=False), conflict_final_rows=_final_rows(conflict=True))
_SCHEMAS = dict(zip(CASE_NODES, (_ROLE_SCHEMA, _OID_SCHEMA, _SCRAM_SCHEMA, _CREATE_SCHEMA)))


def validate_retained_fence(document, node_id, filename):
    """Require the real raw envelope and case-specific nested observation shape.

    Only the producer's JSON representation is accepted (tuples have already
    become arrays). Unknown extra body fields remain retained; no values are
    sanitized, coerced or synthesized to satisfy the schema.
    """
    _require(type(document) is dict and set(document) == {
        'kind', 'case_id', 'pytest_current_test', 'observed_monotonic_ns',
        'evidence_sha256', 'evidence'}, 'INVALID_FENCE_ENVELOPE')
    _require(document['kind'] == 'ifpmic.b03.h2.retained-fence-observation.v1', 'INVALID_FENCE_KIND')
    case_id = document['case_id']
    _require(type(case_id) is str and case_id in CASE_NODES and
             CASE_NODES[case_id] == node_id and document['pytest_current_test'] == node_id,
             'FENCE_CASE_NODE_MISMATCH')
    _require(filename == hashlib.sha256(node_id.encode('utf-8')).hexdigest() + '.json',
             'FENCE_FILENAME_MISMATCH')
    _require(_positive(document['observed_monotonic_ns']), 'INVALID_FENCE_TIMESTAMP')
    evidence = document['evidence']
    _require(_SCHEMAS[case_id](evidence), 'INVALID_FENCE_EVIDENCE')
    try:
        canonical = json.dumps(evidence, ensure_ascii=True, sort_keys=True,
                               separators=(',', ':'), allow_nan=False).encode('ascii')
    except (TypeError, ValueError, OverflowError, RecursionError):
        raise EvidenceError('INVALID_FENCE_EVIDENCE') from None
    _require(_sha(document['evidence_sha256']) and
             hashlib.sha256(canonical).hexdigest() == document['evidence_sha256'],
             'FENCE_EVIDENCE_DIGEST_MISMATCH')
    return {'case_id': case_id, 'evidence_fields': len(evidence), 'evidence_digest_verified': True}
