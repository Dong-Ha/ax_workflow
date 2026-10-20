"""Synthetic structural tests for retained H2 SQL-fence observations.

No product, database driver, SDK, pytest plugin, or service code is imported.
The fixtures model the JSON emitted by test_workflow_schema.py and prove only
the private raw-observation structure, not SQL or H2 acceptance.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from copy import deepcopy

from scripts.ifpmic_h2_artifacts import (
    ArtifactRule,
    CaseArtifacts,
    audit_artifacts,
    prepare_phase_rules,
)
from scripts.ifpmic_h2_fences import CASE_NODES, validate_retained_fence
from scripts.ifpmic_h2_raw_evidence import EvidenceError


KIND = "ifpmic.b03.h2.retained-fence-observation.v1"
ROLE_CASE = "role_registry_and_function_acl"
OID_CASE = "four_role_oid_recreation"
SCRAM_CASE = "service_role_scram_hba"
CREATE_CASE = "real_create_activation_receipt_replay_and_run_fences"
ROLES = ("runtime", "operator", "dispatcher", "projector")
TABLES = (
    "jobs", "commands", "commands_outbox", "workspace_intents",
    "execution_bindings", "worker_run_scopes", "projection_receipts",
    "delivery_attempts",
)
SHA = "a" * 64
EXPECTED_CASE_NODES = {
    "role_registry_and_function_acl":
        "tests/ifpmic_api/test_workflow_schema.py::test_h2_role_registry_and_function_acl_match_static_contract",
    "four_role_oid_recreation":
        "tests/ifpmic_api/test_workflow_schema.py::test_h2_four_role_oid_recreation_is_drift_and_does_not_rebind",
    "service_role_scram_hba":
        "tests/ifpmic_api/test_workflow_schema.py::test_h2_service_roles_use_scram_without_trust_fallthrough",
    "real_create_activation_receipt_replay_and_run_fences":
        "tests/ifpmic_api/test_workflow_schema.py::test_h2_real_create_activation_receipt_replay_and_run_fences",
}


def _json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=True, sort_keys=True,
                       separators=(",", ":"), allow_nan=False) + "\n").encode("ascii")


def _receipt(job: str = "job-primary") -> dict:
    return {"status": "accepted", "command_id": "command-" + job,
            "resource_id": job}


def _role_evidence() -> dict:
    names = dict(zip(ROLES, ("ifpmic_runtime", "ifpmic_operator",
                             "ifpmic_dispatcher", "ifpmic_projector")))
    role_config = [True, "003_workflow_execution", 101, names["runtime"],
                   102, names["operator"], 103, names["dispatcher"],
                   104, names["projector"]]
    roles = [[names[kind], oid, False, False, False, False, True, False, False]
             for kind, oid in zip(ROLES, (101, 102, 103, 104))]
    functions = []
    for index in range(11):
        allowed = "dispatcher" if index % 2 == 0 else "projector"
        functions.append({
            "signature": f"ifpmic.function_{index}()",
            "expected_allowed_kinds": [allowed],
            "metadata": [200 + index, None, "ifpmic_migration", True,
                         ["search_path=pg_catalog,ifpmic,pg_temp"]],
            "role_execute": {role: role == allowed for role in ROLES},
            "public_execute": False,
        })
    table_privileges = [
        {"role_kind": role, "table": table, "privileges": [False, False, False, False]}
        for table in TABLES for role in ROLES
    ]
    catalog_columns = (
        "project_id", "version_key", "snapshot_id", "record_bytes",
        "record_bytes_sha256", "profile_version_json", "mode", "enabled",
        "configuration_complete",
    )
    catalog_privileges = [
        {"role_kind": role, "column": column,
         "table_update_delete": [False, False], "column_update": False}
        for role in ROLES for column in catalog_columns
    ]
    principals = [
        [301, names["dispatcher"], "dispatcher", "deployment-1", None, True],
        [302, names["projector"], "projector", "deployment-1", "build-1", True],
    ]
    dispatch_build = {"build_id": "build-1", "source_manifest_sha256": SHA,
                      "environment_manifest_sha256": "b" * 64}
    registered = {
        **dispatch_build, "workflow_type": "IFPMICJobWorkflow",
        "protocol_version": "h2-v1", "namespace": "default",
        "server_endpoint": "127.0.0.1:7233", "server_config_sha256": "c" * 64,
    }
    denied = [
        {"role": role, "statement": f"denial-{index}", "sqlstate": "42501"}
        for index, role in enumerate((list(ROLES) * 4)[:14])
    ]
    return {
        "role_acl_observations": {
            "role_config": [role_config], "roles": roles, "functions": functions,
            "table_privileges": table_privileges,
            "catalog_privileges": catalog_privileges,
            "job_create_command_column_privileges": {"INSERT": True, "UPDATE": False},
            "worker_principals": principals,
        },
        "dispatcher_session_identity": [names["dispatcher"], names["dispatcher"]],
        "dispatcher_read_config": {
            "deployment_id": "deployment-1", "namespace": "default",
            "server_endpoint": "127.0.0.1:7233", "server_config_sha256": "c" * 64,
            "builds": [dispatch_build],
        },
        "projector_session_identity": [names["projector"], names["projector"]],
        "projector_registered_build": registered,
        "denied_operations": denied,
    }


def _oid_evidence() -> dict:
    return {
        "migration_result": {
            "applied": ["001_initial", "002_auth_retention",
                        "003_workflow_execution", "004_prebinding_incident"],
            "unchanged": [],
        },
        "original_config": [901, "ifpmic_h2_oid_dispatcher"],
        "replacement_role_oid": 902,
        "migration_error": {"type": "MigrationError", "code": "MIGRATION_ROLE_DRIFT"},
        "final_config": [[True, "003_workflow_execution", 901,
                           "ifpmic_h2_oid_dispatcher"]],
        "current_role_oid": 902,
        # This fresh database did not register worker principals in this test.
        "immutable_principal_rows": [],
        "replacement_role_privileges": [False, False],
    }


def _scram_evidence() -> dict:
    names = ["ifpmic_runtime", "ifpmic_operator", "ifpmic_dispatcher", "ifpmic_projector"]
    return {
        "successful_session_users": names,
        "rejected_password_attempts": [
            {"attempt": 0, "exception_type": "OperationalError", "sqlstate": None,
             "message": "password authentication failed", "expected_reason": "password authentication failed"},
            {"attempt": 1, "exception_type": "OperationalError", "sqlstate": None,
             "message": "no password supplied", "expected_reason": "no password supplied"},
            {"attempt": 2, "exception_type": "OperationalError", "sqlstate": None,
             "message": "password authentication failed", "expected_reason": "password authentication failed"},
        ],
        "actual_hba_rules": [[index, [name], "scram-sha-256"]
                              for index, name in enumerate(names, 1)],
    }


def _function_results() -> dict:
    statuses = {
        "claim": "claimed", "stale_reserve": "stale", "reserve": "reserved",
        "start_attempt": "permitted", "stale_admission": "stale",
        "admission": "admitted", "workspace_wait": "wait", "stale_ack": "stale",
        "ack": "dispatched", "activation_ready": "ready", "project_activation": "applied",
        "conflict_claim": "claimed", "conflict_reserve": "reserved",
        "conflict_start_attempt": "permitted", "conflict_admission": "admitted",
        "conflict_ack": "dispatched", "conflict_projection": "quarantined",
        "replay_after_revocation": "applied",
    }
    results = {
        **{key: {"status": value} for key, value in statuses.items()},
        "initial_window": [None, None, None],
        "partial_window_rejections": [
            {"assignment": "first_start_attempt_at only", "sqlstate": "23514",
             "constraint": "binding_start_window_shape", "restored_window": [None, None, None]},
            {"assignment": "first_start_attempt_at and uncertain_until", "sqlstate": "23514",
             "constraint": "binding_start_window_shape", "restored_window": [None, None, None]},
        ],
        "wrong_run_denial": {"sqlstate": "42501"},
        "direct_command_table_denial": {"sqlstate": "42501"},
        "api_replay": {"status_code": 202, "json": _receipt()},
        "command_outcome_rejections": [
            {"command_id": "malformed-applied", "before": ["accepted", None, None],
             "requested": ["applied", None, None], "sqlstate": "23514",
             "constraint": "command_outcome_shape"},
            {"command_id": "malformed-rejected", "before": ["accepted", None, None],
             "requested": ["rejected", None, None], "sqlstate": "23514",
             "constraint": "command_outcome_shape"},
        ],
    }
    reserved = _binding("job-primary", state="reserved")
    started = _binding("job-primary", state="reserved", started=True)
    admitted = _binding("job-primary", state="admitted", started=True, admitted=True)
    conflict_reserved = _binding("job-conflict", state="reserved", conflict=True)
    conflict_started = _binding("job-conflict", state="reserved", started=True, conflict=True)
    conflict_admitted = _binding("job-conflict", state="admitted", started=True,
                                 admitted=True, conflict=True)
    for key, binding in (
        ("reserve", reserved), ("start_attempt", started), ("admission", admitted),
        ("conflict_reserve", conflict_reserved),
        ("conflict_start_attempt", conflict_started),
        ("conflict_admission", conflict_admitted),
    ):
        results[key] = {"status": results[key]["status"], "binding": binding}
    results["claim"] = _claim("job-primary", "command-primary", "run-primary")
    results["conflict_claim"] = _claim("job-conflict", "command-conflict", "run-conflict")
    results["stale_reserve"] = {"status": "stale", "code": "CLAIM_STALE"}
    results["stale_admission"] = {"status": "stale", "code": "CLAIM_STALE"}
    results["workspace_wait"] = {"status": "wait", "code": "WORKSPACE_NOT_READY"}
    results["stale_ack"] = {"status": "stale", "affected": 0, "code": "CLAIM_STALE"}
    results["ack"] = {"status": "dispatched", "affected": 1}
    results["conflict_ack"] = {"status": "dispatched", "affected": 1}
    results["activation_ready"] = {
        "status": "ready", "job_id": "job-primary", "binding_sha256": "b" * 64,
        "command_id": "command-primary", "command_payload_sha256": SHA,
        "revision": 0, "workspace_token": "workspace-primary", "workspace_generation": 1,
    }
    project_result = {
        "status": "applied", "command_id": "command-primary", "applied_revision": 1,
        "error_code": None, "job_id": "job-primary", "job_status": "QUEUED", "revision": 1,
    }
    results["project_activation"] = project_result
    results["replay_after_revocation"] = deepcopy(project_result)
    results["conflict_projection"] = {
        "status": "quarantined", "code": "WORKSPACE_IDENTITY_CONFLICT",
    }
    return results


def _binding(job: str, *, state: str, started: bool = False,
             admitted: bool = False, conflict: bool = False) -> dict:
    token = "workspace-" + ("conflict" if conflict else "primary")
    run = "run-" + ("conflict" if conflict else "primary")
    return {
        "job_id": job, "project_id": "project-1", "create_command_id": "command-" + ("conflict" if conflict else "primary"),
        "deployment_id": "deployment-1", "namespace": "default",
        "server_config_sha256": "c" * 64, "temporal_workflow_id": "ifpmic.job." + job,
        "workflow_type": "IFPMICJobWorkflow", "build_id": "build-1",
        "task_queue": "ifpmic.build.build-1", "snapshot_id": "snapshot-1",
        "catalog_record_sha256": "d" * 64, "workflow_sha256": "e" * 64,
        "state_sha256": "f" * 64, "agent_sha256": "1" * 64,
        "command_payload_sha256": SHA, "state": state, "workspace_token": token,
        "workspace_generation": 2 if conflict else 1, "binding_sha256": "b" * 64,
        "admitted_run_id": run if admitted else None,
        "first_start_attempt_at": "2026-10-20T01:02:03Z" if started else None,
        "uncertain_until": "2026-10-20T02:02:03Z" if started else None,
        "observed_retention_seconds": 3601 if started else None,
        "quarantine_code": "WORKSPACE_IDENTITY_CONFLICT" if conflict and state == "quarantined" else None,
    }


def _claim(job: str, command: str, run: str) -> dict:
    return {
        "status": "claimed", "command_id": command, "generation": 1,
        "claim_token": "claim-" + command, "claim_expires_at": "2026-10-20T01:02:03Z",
        "job_id": job, "project_id": "project-1", "route": "POST /api/v1/jobs",
        "payload_sha256": SHA, "command_status": "accepted", "create_command_id": command,
        "binding": None,
        "workspace": {"state": "READY", "workspace_token": "workspace-" + job,
                       "generation": 1},
    }


def _final_rows(*, conflict: bool) -> dict:
    suffix = "conflict" if conflict else "primary"
    job_id, command_id = "job-" + suffix, "command-" + suffix
    workspace_token = "workspace-" + suffix
    run_id = "run-" + suffix
    binding = _binding(job_id, state="quarantined" if conflict else "admitted",
                       started=True, admitted=True, conflict=conflict)
    project_result = {
        "status": "applied", "command_id": "command-primary", "applied_revision": 1,
        "error_code": None, "job_id": "job-primary", "job_status": "QUEUED", "revision": 1,
    }
    rows = {
        "jobs": [{
            "job_id": job_id, "owner_id": "owner-1", "project_id": "project-1",
            "snapshot_id": "snapshot-1", "workflow_id": "ifpmic-sw-v1",
            "status": "DRAFT" if conflict else "QUEUED", "revision": 0 if conflict else 1,
            "cycle": 0, "current_step_ids": [], "candidate_fingerprint": None,
            "created_at": "2026-10-20T01:00:00Z", "create_command_id": command_id,
            "create_route": "POST /api/v1/jobs",
        }],
        "commands": [{
            "command_id": command_id, "actor_id": "owner-1", "route": "POST /api/v1/jobs",
            "idempotency_key": "synthetic-" + suffix, "project_id": "project-1",
            "job_id": job_id, "command_payload_json": "{}", "payload_sha256": SHA,
            "status": "accepted" if conflict else "applied",
            "applied_revision": None if conflict else 1,
            "error_code": None, "created_at": "2026-10-20T01:00:00Z",
        }],
        "commands_outbox": [{
            "command_id": command_id, "state": "dispatched",
            "created_at": "2026-10-20T01:00:00Z", "generation": 1,
            "claim_token": None, "claim_expires_at": None,
            "next_attempt_at": "2026-10-20T01:00:01Z", "last_error": None,
            "observed_run_id": run_id, "dispatched_at": "2026-10-20T01:00:02Z",
        }],
        "workspace_intents": [{
            "job_id": job_id, "command_id": command_id, "workspace_token": workspace_token,
            "state": "READY", "generation": 2 if conflict else 1,
            "claim_token": None, "claim_expires_at": None, "error_code": None,
        }],
        "execution_bindings": [binding],
        "worker_run_scopes": [{
            "job_id": job_id, "admitted_run_id": run_id, "projector_role_oid": 501,
            "projector_role_name": "ifpmic_projector", "deployment_id": "deployment-1",
            "build_id": "build-1",
        }],
        "projection_receipts": [],
        "delivery_attempts": [{
            "command_id": command_id, "generation": 1,
            "attempted_at": "2026-10-20T01:00:01Z", "completed_at": "2026-10-20T01:00:02Z",
            "result": "started", "observed_run_id": run_id, "error_code": None,
        }],
    }
    if not conflict:
        rows["projection_receipts"] = [{
            "job_id": job_id, "transition_sequence": 1, "command_id": command_id,
            "admitted_run_id": run_id, "build_id": "build-1", "proposal_sha256": "c" * 64,
            "expected_revision": 0, "outcome": "applied", "result_json": project_result,
            "committed_at": "2026-10-20T01:00:03Z",
        }]
    return rows


def _create_evidence() -> dict:
    function_results = _function_results()
    job_dto = {
        "job_id": "job-primary", "owner_id": "owner-1", "status": "QUEUED",
        "revision": 1, "cycle": 0, "workflow_version": "ifpmic-sw-v1",
        "current_step_ids": [], "candidate_fingerprint": None,
        "profile_version": "profile-v1",
    }
    return {
        "nul_rejection": {
            "status_code": 422,
            "body": {"code": "INVALID_REQUEST", "message": "INVALID_REQUEST", "trace_id": "trace-1"},
            "counts_before": [0, 0], "counts_after": [0, 0],
        },
        "accepted_create": _receipt(), "payload_sha256": SHA,
        "function_results": function_results,
        "workspace_identity": {"token": "workspace-token", "generation": 1},
        "binding_sha256": "b" * 64, "proposal_sha256": "c" * 64,
        "api_listing": {"status_code": 200, "matching_job": deepcopy(job_dto)},
        "api_detail": {"job": deepcopy(job_dto),
                       "steps": [], "last_event_id": ""},
        "api_command": {"command_id": "command-primary", "status": "applied",
                        "applied_revision": 1, "error": None},
        "revoked_api_responses": [
            {"status_code": 403, "body": {
                "code": "FORBIDDEN", "message": "FORBIDDEN", "trace_id": "trace-1",
            }}
            for _ in range(3)
        ],
        "conflict": {
            "accepted": _receipt("job-conflict"), "payload_sha256": "d" * 64,
            "binding_sha256": "e" * 64, "proposal_sha256": "f" * 64,
            # Captured from the six-column owner SELECT at source lines 1219-1227.
            "state": ["DRAFT", 0, "accepted", "quarantined",
                      "WORKSPACE_IDENTITY_CONFLICT", 0],
        },
        "primary_final_rows": _final_rows(conflict=False),
        "conflict_final_rows": _final_rows(conflict=True),
    }


EVIDENCE_FACTORIES = {
    ROLE_CASE: _role_evidence,
    OID_CASE: _oid_evidence,
    SCRAM_CASE: _scram_evidence,
    CREATE_CASE: _create_evidence,
}


def _document(case_id: str, *, node_id: str | None = None, evidence: dict | None = None) -> dict:
    node = CASE_NODES[case_id] if node_id is None else node_id
    actual_evidence = EVIDENCE_FACTORIES[case_id]() if evidence is None else evidence
    canonical = json.dumps(actual_evidence, ensure_ascii=True, sort_keys=True,
                           separators=(",", ":"), allow_nan=False).encode("ascii")
    return {
        "kind": "ifpmic.b03.h2.retained-fence-observation.v1",
        "case_id": case_id,
        "pytest_current_test": node,
        "observed_monotonic_ns": 123456789,
        "evidence_sha256": hashlib.sha256(canonical).hexdigest(),
        "evidence": actual_evidence,
    }


def _filename(node_id: str) -> str:
    return hashlib.sha256(node_id.encode("utf-8")).hexdigest() + ".json"


def _validate(case_id: str, document: dict | None = None, *, node_id: str | None = None,
              filename: str | None = None):
    node = CASE_NODES[case_id] if node_id is None else node_id
    return validate_retained_fence(_document(case_id) if document is None else document, node,
                                   _filename(node) if filename is None else filename)


class RetainedFenceTests(unittest.TestCase):
    def test_four_source_shaped_observations_validate_without_acceptance_claim(self) -> None:
        self.assertEqual(CASE_NODES, EXPECTED_CASE_NODES)
        for case_id in EVIDENCE_FACTORIES:
            with self.subTest(case_id=case_id):
                document = _document(case_id)
                result = _validate(case_id, document)
                self.assertEqual(result["case_id"], case_id)
                self.assertIs(result["evidence_digest_verified"], True)

    def test_oid_principals_may_be_empty_but_admitted_scopes_exist_in_both_final_snapshots(self) -> None:
        oid = _document(OID_CASE)
        self.assertEqual(oid["evidence"]["immutable_principal_rows"], [])
        created = _document(CREATE_CASE)
        self.assertEqual(created["evidence"]["conflict_final_rows"]["projection_receipts"], [])
        self.assertEqual(len(created["evidence"]["primary_final_rows"]["worker_run_scopes"]), 1)
        self.assertEqual(len(created["evidence"]["conflict_final_rows"]["worker_run_scopes"]), 1)
        self.assertTrue(all(len(created["evidence"]["primary_final_rows"][table]) == 1
                            for table in TABLES))
        self.assertTrue(all(len(created["evidence"]["conflict_final_rows"][table]) == 1
                            for table in TABLES if table != "projection_receipts"))
        self.assertTrue(_validate(OID_CASE, oid))
        self.assertTrue(_validate(CREATE_CASE, created))

    def test_each_source_derived_row_width_is_enforced(self) -> None:
        mutations = (
            (ROLE_CASE, lambda e: e["role_acl_observations"]["role_config"][0].pop(),
             "INVALID_FENCE_EVIDENCE"),
            (ROLE_CASE, lambda e: e["role_acl_observations"]["roles"][0].pop(),
             "INVALID_FENCE_EVIDENCE"),
            (OID_CASE, lambda e: e["original_config"].pop(), "INVALID_FENCE_EVIDENCE"),
            (SCRAM_CASE, lambda e: e["actual_hba_rules"][0].pop(), "INVALID_FENCE_EVIDENCE"),
            (CREATE_CASE, lambda e: e["function_results"]["initial_window"].pop(),
             "INVALID_FENCE_EVIDENCE"),
        )
        for case_id, mutate, code in mutations:
            with self.subTest(case_id=case_id):
                evidence = EVIDENCE_FACTORIES[case_id]()
                mutate(evidence)
                self._assert_error(code, lambda: _validate(case_id, _document(case_id, evidence=evidence)))

    def test_nested_raw_scalar_types_and_boolean_integer_boundaries_are_strict(self) -> None:
        mutations = (
            (OID_CASE, lambda e: e["original_config"].__setitem__(0, True)),
            (OID_CASE, lambda e: e["original_config"].__setitem__(0, "901")),
            (ROLE_CASE, lambda e: e["role_acl_observations"]["roles"][0].__setitem__(2, "false")),
            (CREATE_CASE, lambda e: e["primary_final_rows"]["jobs"][0].__setitem__("revision", True)),
            (CREATE_CASE, lambda e: e["primary_final_rows"]["commands"][0].__setitem__("command_payload_json", 7)),
            (SCRAM_CASE, lambda e: e["rejected_password_attempts"][0].__setitem__("attempt", True)),
            (SCRAM_CASE, lambda e: e["actual_hba_rules"].__setitem__(0, "not-a-row")),
        )
        for case_id, mutate in mutations:
            with self.subTest(case_id=case_id):
                evidence = EVIDENCE_FACTORIES[case_id]()
                mutate(evidence)
                self._assert_error("INVALID_FENCE_EVIDENCE",
                                   lambda: _validate(case_id, _document(case_id, evidence=evidence)))

    def test_missing_and_wrong_type_command_payload_json_are_rejected(self) -> None:
        for mutation in (
            lambda row: row.pop("command_payload_json"),
            lambda row: row.__setitem__("command_payload_json", 42),
        ):
            with self.subTest(mutation=mutation):
                evidence = _create_evidence()
                mutation(evidence["primary_final_rows"]["commands"][0])
                self._assert_error("INVALID_FENCE_EVIDENCE",
                                   lambda: _validate(CREATE_CASE,
                                       _document(CREATE_CASE, evidence=evidence)))

    def test_each_binding_jsonb_raw_column_is_required(self) -> None:
        for key in _binding("job-primary", state="reserved"):
            with self.subTest(column=key):
                evidence = _create_evidence()
                del evidence["function_results"]["reserve"]["binding"][key]
                self._assert_error("INVALID_FENCE_EVIDENCE",
                                   lambda: _validate(CREATE_CASE, _document(CREATE_CASE, evidence=evidence)))

    def test_each_final_table_jsonb_raw_column_is_required(self) -> None:
        evidence_template = _create_evidence()
        for table, row in evidence_template["primary_final_rows"].items():
            for key in row[0]:
                with self.subTest(table=table, column=key):
                    evidence = _create_evidence()
                    del evidence["primary_final_rows"][table][0][key]
                    self._assert_error("INVALID_FENCE_EVIDENCE",
                                       lambda: _validate(CREATE_CASE,
                                           _document(CREATE_CASE, evidence=evidence)))

    def test_every_required_final_table_rejects_an_empty_rows_array(self) -> None:
        for table in TABLES:
            with self.subTest(table=table, branch="primary"):
                evidence = _create_evidence()
                evidence["primary_final_rows"][table] = []
                self._assert_error("INVALID_FENCE_EVIDENCE",
                                   lambda: _validate(CREATE_CASE,
                                       _document(CREATE_CASE, evidence=evidence)))
            if table != "projection_receipts":
                with self.subTest(table=table, branch="conflict"):
                    evidence = _create_evidence()
                    evidence["conflict_final_rows"][table] = []
                    self._assert_error("INVALID_FENCE_EVIDENCE",
                                       lambda: _validate(CREATE_CASE,
                                           _document(CREATE_CASE, evidence=evidence)))

    def test_hash_only_final_row_is_rejected(self) -> None:
        evidence = _create_evidence()
        evidence["primary_final_rows"]["jobs"] = [{"sha256": SHA}]
        self._assert_error("INVALID_FENCE_EVIDENCE",
                           lambda: _validate(CREATE_CASE,
                               _document(CREATE_CASE, evidence=evidence)))

    def test_hash_only_and_incomplete_api_error_bodies_are_rejected(self) -> None:
        for body in ({"sha256": SHA}, {"code": "FORBIDDEN", "message": "FORBIDDEN"}):
            with self.subTest(body_keys=sorted(body)):
                evidence = _create_evidence()
                evidence["revoked_api_responses"][0]["body"] = body
                self._assert_error("INVALID_FENCE_EVIDENCE",
                                   lambda: _validate(CREATE_CASE,
                                       _document(CREATE_CASE, evidence=evidence)))

    def test_status_only_function_result_is_rejected_when_operation_has_more_columns(self) -> None:
        evidence = _create_evidence()
        evidence["function_results"]["ack"] = {"status": "dispatched"}
        self._assert_error("INVALID_FENCE_EVIDENCE",
                           lambda: _validate(CREATE_CASE,
                               _document(CREATE_CASE, evidence=evidence)))

    def test_each_of_the_18_function_results_requires_its_distinguishing_raw_field(self) -> None:
        distinguishing_fields = {
            "claim": "command_id", "stale_reserve": "code", "reserve": "binding",
            "start_attempt": "binding", "stale_admission": "code", "admission": "binding",
            "workspace_wait": "code", "stale_ack": "affected", "ack": "affected",
            "activation_ready": "revision", "project_activation": "command_id",
            "conflict_claim": "command_id", "conflict_reserve": "binding",
            "conflict_start_attempt": "binding", "conflict_admission": "binding",
            "conflict_ack": "affected", "conflict_projection": "code",
            "replay_after_revocation": "command_id",
        }
        self.assertEqual(len(distinguishing_fields), 18)
        for operation, field in distinguishing_fields.items():
            with self.subTest(operation=operation, field=field):
                evidence = _create_evidence()
                del evidence["function_results"][operation][field]
                self._assert_error("INVALID_FENCE_EVIDENCE",
                                   lambda: _validate(CREATE_CASE,
                                       _document(CREATE_CASE, evidence=evidence)))

    def test_missing_job_dto_field_is_rejected_in_both_api_shapes(self) -> None:
        for location in ("api_listing", "api_detail"):
            for field in _create_evidence()[location]["matching_job" if location == "api_listing" else "job"]:
                with self.subTest(location=location, field=field):
                    evidence = _create_evidence()
                    key = "matching_job" if location == "api_listing" else "job"
                    del evidence[location][key][field]
                    self._assert_error("INVALID_FENCE_EVIDENCE",
                                       lambda: _validate(CREATE_CASE,
                                           _document(CREATE_CASE, evidence=evidence)))

    def test_missing_required_envelope_key_is_rejected(self) -> None:
        document = _document(ROLE_CASE)
        del document["evidence"]
        self._assert_error("INVALID_FENCE_ENVELOPE", lambda: _validate(ROLE_CASE, document))

    def test_empty_envelope_is_not_replaced_with_a_valid_default_fixture(self) -> None:
        self._assert_error("INVALID_FENCE_ENVELOPE", lambda: _validate(ROLE_CASE, {}))

    def test_envelope_with_an_extra_key_is_rejected(self) -> None:
        document = _document(ROLE_CASE)
        document["unreviewed"] = "extra"
        self._assert_error("INVALID_FENCE_ENVELOPE", lambda: _validate(ROLE_CASE, document))

    def test_non_object_or_empty_evidence_is_rejected(self) -> None:
        for evidence in ([], {}, "private" ):
            with self.subTest(evidence_type=type(evidence).__name__):
                document = _document(ROLE_CASE)
                document["evidence"] = evidence
                self._assert_error("INVALID_FENCE_EVIDENCE", lambda: _validate(ROLE_CASE, document))

    def test_hash_only_evidence_is_rejected_even_with_matching_digest(self) -> None:
        evidence = {"evidence_sha256": SHA}
        document = _document(ROLE_CASE, evidence=evidence)
        self._assert_error("INVALID_FENCE_EVIDENCE", lambda: _validate(ROLE_CASE, document))

    def test_stale_evidence_digest_is_rejected(self) -> None:
        document = _document(ROLE_CASE)
        document["evidence_sha256"] = "0" * 64
        self._assert_error("FENCE_EVIDENCE_DIGEST_MISMATCH", lambda: _validate(ROLE_CASE, document))

    def test_wrong_kind_is_rejected(self) -> None:
        document = _document(ROLE_CASE)
        document["kind"] = "ifpmic.other.v1"
        self._assert_error("INVALID_FENCE_KIND", lambda: _validate(ROLE_CASE, document))

    def test_node_and_case_id_must_identify_the_same_literal_test(self) -> None:
        document = _document(ROLE_CASE)
        document["pytest_current_test"] = CASE_NODES[OID_CASE]
        self._assert_error("FENCE_CASE_NODE_MISMATCH", lambda: _validate(ROLE_CASE, document))
        document = _document(ROLE_CASE)
        document["case_id"] = OID_CASE
        self._assert_error("FENCE_CASE_NODE_MISMATCH", lambda: _validate(ROLE_CASE, document))

    def test_filename_must_be_sha256_of_literal_node_id(self) -> None:
        self._assert_error("FENCE_FILENAME_MISMATCH", lambda: _validate(
            ROLE_CASE, filename="wrong-node.json"))

    def test_timestamp_rejects_boolean_zero_and_wrong_types(self) -> None:
        for value in (True, False, 0, -1, "123"):
            with self.subTest(value=value):
                document = _document(ROLE_CASE)
                document["observed_monotonic_ns"] = value
                self._assert_error("INVALID_FENCE_TIMESTAMP", lambda: _validate(ROLE_CASE, document))

    def test_evidence_digest_must_be_canonical_lowercase_sha256(self) -> None:
        for value in ("A" * 64, "g" * 64, 123):
            with self.subTest(value_type=type(value).__name__):
                document = _document(ROLE_CASE)
                document["evidence_sha256"] = value
                self._assert_error("FENCE_EVIDENCE_DIGEST_MISMATCH", lambda: _validate(ROLE_CASE, document))

    def test_retained_fence_artifact_is_read_from_private_root_and_indexed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="h2-fence-artifact-") as temp:
            root = Path(temp) / "evidence"
            root.mkdir(mode=0o700)
            case_id = OID_CASE
            node = CASE_NODES[case_id]
            directory = root / "retained-fences"
            directory.mkdir(mode=0o700)
            path = directory / _filename(node)
            payload = _json_bytes(_document(case_id))
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                os.fchmod(fd, 0o600)
                os.write(fd, payload)
                os.fsync(fd)
            finally:
                os.close(fd)

            result = audit_artifacts(root, [CaseArtifacts(
                node, ".", (ArtifactRule(
                    "retained-fences/" + _filename(node), "retained_fence_json",
                    required_keys=("kind", "case_id", "pytest_current_test",
                                   "observed_monotonic_ns", "evidence_sha256", "evidence"),
                    node_field="pytest_current_test",
                ),),
            )])

            self.assertEqual(result["cases"][node]["files"][0]["format"], "retained_fence_json")
            self.assertEqual(result["cases"][node]["files"][0]["case_id"], case_id)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_retained_fence_artifact_rejects_stale_nested_digest_end_to_end(self) -> None:
        with tempfile.TemporaryDirectory(prefix="h2-fence-stale-digest-") as temp:
            root = Path(temp) / "evidence"
            root.mkdir(mode=0o700)
            case_id = ROLE_CASE
            node = CASE_NODES[case_id]
            directory = root / "retained-fences"
            directory.mkdir(mode=0o700)
            path = directory / _filename(node)
            document = _document(case_id)
            document["evidence_sha256"] = "0" * 64
            payload = _json_bytes(document)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                os.fchmod(fd, 0o600)
                view = memoryview(payload)
                while view:
                    written = os.write(fd, view)
                    if written <= 0:
                        raise OSError("short synthetic fence write")
                    view = view[written:]
                os.fsync(fd)
            finally:
                os.close(fd)

            self._assert_error("FENCE_EVIDENCE_DIGEST_MISMATCH", lambda: audit_artifacts(root, [
                CaseArtifacts(node, ".", (ArtifactRule(
                    "retained-fences/" + _filename(node), "retained_fence_json",
                    required_keys=("kind", "case_id", "pytest_current_test",
                                   "observed_monotonic_ns", "evidence_sha256", "evidence"),
                    node_field="pytest_current_test",
                ),)),
            ]))

    def test_phase_rule_loader_preserves_retained_fence_format(self) -> None:
        node = CASE_NODES[OID_CASE]
        row = {
            "node_id": node, "phase": "h2_schema_python", "case_directory": ".",
            "unresolved": [], "minimum_owner": 0, "queries_min": {}, "queries_max": {},
            "artifacts": [{
                "path": "retained-fences/" + _filename(node),
                "format": "retained_fence_json", "minimum": 1, "maximum": 1,
                "required_keys": ["kind", "case_id", "pytest_current_test",
                                  "observed_monotonic_ns", "evidence_sha256", "evidence"],
                "node_field": "pytest_current_test",
            }],
        }
        document = {
            "kind": "ifpmic.b03.h2.runtime-full-machine-evidence-rules.v1",
            "status": "candidate_pending_exact_review", "unresolved": [], "cases": [row],
        }

        _recorders, cases = prepare_phase_rules(
            document, "h2_schema_python", {node}, {node})

        self.assertEqual(cases[0].artifacts[0].format, "retained_fence_json")
        self.assertEqual(cases[0].artifacts[0].node_field, "pytest_current_test")

    def test_phase_rule_loader_rejects_generic_json_downgrades_for_fence_nodes(self) -> None:
        node = CASE_NODES[OID_CASE]
        base_row = {
            "node_id": node, "phase": "h2_schema_python", "case_directory": ".",
            "unresolved": [], "minimum_owner": 0, "queries_min": {}, "queries_max": {},
            "artifacts": [{
                "path": "retained-fences/" + _filename(node),
                "format": "retained_fence_json", "minimum": 1, "maximum": 1,
                "required_keys": ["kind", "case_id", "pytest_current_test",
                                  "observed_monotonic_ns", "evidence_sha256", "evidence"],
                "node_field": "pytest_current_test",
            }],
        }
        mutations = {
            "generic_json": lambda row: row["artifacts"][0].update(format="json"),
            "wrong_node_field": lambda row: row["artifacts"][0].update(node_field="node_id"),
            "wrong_path": lambda row: row["artifacts"][0].update(path="retained-fences/other.json"),
            "wrong_directory": lambda row: row.update(case_directory="workflow_schema"),
            "extra_artifact": lambda row: row["artifacts"].append({
                "path": "extra.json", "format": "json", "minimum": 1,
                "maximum": 1, "required_keys": [],
            }),
            "nonunique_count": lambda row: row["artifacts"][0].update(minimum=0, maximum=2),
        }
        for name, mutate in mutations.items():
            with self.subTest(downgrade=name):
                row = deepcopy(base_row)
                mutate(row)
                document = {
                    "kind": "ifpmic.b03.h2.runtime-full-machine-evidence-rules.v1",
                    "status": "candidate_pending_exact_review", "unresolved": [], "cases": [row],
                }
                self._assert_error("RETAINED_FENCE_RULE_DOWNGRADE", lambda: prepare_phase_rules(
                    document, "h2_schema_python", {node}, {node}))

    def _assert_error(self, expected: str, callback) -> None:
        with self.assertRaises(EvidenceError) as captured:
            callback()
        self.assertEqual(str(captured.exception), expected)


if __name__ == "__main__":
    unittest.main()
