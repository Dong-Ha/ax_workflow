"""H2 read-only admission projection API contract tests."""

from __future__ import annotations

from datetime import timedelta
from uuid import UUID, uuid4

import psycopg
import pytest
import json
from fastapi.testclient import TestClient

from tests.ifpmic_api.jobs_fixture import (
    API_ORIGIN,
    PROJECT_ID,
    client_with,
    login,
    owner_dsn,
    operator_dsn,
    runtime_dsn,
    seed_membership,
    valid_create_job,
    write_headers,
)


pytest_plugins = ("tests.ifpmic_api.jobs_fixture", "tests.ifpmic_api.workflow_schema_fixture")


def _accepted(harness, key="admission-read-create"):
    response = harness["client"].post(
        "/api/v1/jobs", json=valid_create_job(harness), headers=write_headers(harness, key=key),
    )
    assert response.status_code == 202
    return response.json()


def _fixed(response, status: int, code: str) -> None:
    assert response.status_code == status
    value = response.json()
    assert set(value) == {"code", "message", "trace_id"}
    assert value["code"] == value["message"] == code
    UUID(value["trace_id"])
    assert response.headers.get("cache-control") == "no-store"
    assert response.headers.get("referrer-policy") == "no-referrer"


def _pending_side_effect_state(owner, job_id):
    return owner.execute(
        "SELECT j.status,j.revision,c.status,c.applied_revision,o.state,o.generation,o.last_error,"
        "o.observed_run_id,(SELECT count(*) FROM ifpmic.execution_bindings WHERE job_id=j.job_id),"
        "(SELECT count(*) FROM ifpmic.projection_receipts WHERE job_id=j.job_id),"
        "(SELECT count(*) FROM ifpmic.delivery_attempts WHERE command_id=c.command_id) "
        "FROM ifpmic.jobs j JOIN ifpmic.commands c ON c.command_id=j.create_command_id "
        "JOIN ifpmic.commands_outbox o ON o.command_id=c.command_id WHERE j.job_id=%s",
        (job_id,),
    ).fetchone()


def test_pending_read_returns_projection_without_mutating_execution_state(g4_harness):
    harness = g4_harness
    accepted = _accepted(harness)
    with psycopg.connect(owner_dsn(harness["database"])) as owner:
        before = _pending_side_effect_state(owner, accepted["resource_id"])

    response = harness["client"].get(f"/api/v1/jobs/{accepted['resource_id']}/admission")
    assert response.status_code == 200
    body = response.json()
    assert body == {
        "schema_version": "ifpmic.admission-status.v1",
        "job_id": accepted["resource_id"],
        "command_id": accepted["command_id"],
        "admission_status": "pending",
        "job_status": "DRAFT",
        "job_revision": 0,
        "command_status": "accepted",
        "applied_revision": None,
        "admitted_run_id": None,
        "receipt": None,
        "error_code": None,
    }
    with psycopg.connect(owner_dsn(harness["database"])) as owner:
        after = _pending_side_effect_state(owner, accepted["resource_id"])
    assert after == before


def _seed_test_deployment(owner):
    """Create synthetic relational identity rows; this does not attest engine execution."""
    deployment = "admission-read-synthetic"
    build = "b" * 64
    owner.execute(
        "INSERT INTO ifpmic.execution_deployments(deployment_id,namespace,server_endpoint,server_config_sha256) "
        "VALUES(%s,'default','127.0.0.1',%s)", (deployment, "c" * 64),
    )
    owner.execute(
        "INSERT INTO ifpmic.engine_builds(deployment_id,build_id,source_manifest_sha256,"
        "environment_manifest_sha256,workflow_type,task_queue,protocol_version) "
        "VALUES(%s,%s,%s,%s,'IFPMICJobWorkflow',%s,'h2-v1')",
        (deployment, build, "d" * 64, "e" * 64, f"ifpmic.build.{build}"),
    )
    return deployment, build


def _seed_binding(owner, accepted, deployment, build, *, state="admitted", run_id=None, quarantine_code=None):
    identity = owner.execute(
        "SELECT j.project_id,j.create_command_id,j.snapshot_id,w.workspace_token,w.generation,"
        "c.payload_sha256 FROM ifpmic.jobs j JOIN ifpmic.workspace_intents w USING(job_id) "
        "JOIN ifpmic.commands c ON c.command_id=j.create_command_id WHERE j.job_id=%s",
        (accepted["resource_id"],),
    ).fetchone()
    project_id, command_id, snapshot_id, workspace_token, generation, payload_hash = identity
    owner.execute(
        "INSERT INTO ifpmic.execution_bindings(job_id,project_id,create_command_id,deployment_id,namespace,"
        "server_config_sha256,temporal_workflow_id,workflow_type,build_id,task_queue,snapshot_id,"
        "catalog_record_sha256,workflow_sha256,state_sha256,agent_sha256,workspace_token,workspace_generation,"
        "command_payload_sha256,binding_sha256,admitted_run_id,state,quarantine_code) "
        "VALUES(%s,%s,%s,%s,'default',%s,%s,'IFPMICJobWorkflow',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (accepted["resource_id"], project_id, command_id, deployment, "c" * 64,
         f"ifpmic.job.{accepted['resource_id']}", build, f"ifpmic.build.{build}", snapshot_id,
         "f" * 64, "1" * 64, "2" * 64, "3" * 64, workspace_token, generation,
         payload_hash, "5" * 64, run_id, state, quarantine_code),
    )
    return command_id


def _seed_quarantine_attempt(owner, command_id, code, *, observed_run_id=None):
    owner.execute(
        "UPDATE ifpmic.commands_outbox SET state='quarantined',generation=1,last_error=%s,observed_run_id=%s "
        "WHERE command_id=%s", (code, observed_run_id, command_id),
    )
    owner.execute(
        "INSERT INTO ifpmic.delivery_attempts(command_id,generation,completed_at,result,observed_run_id,error_code) "
        "VALUES(%s,1,now(),'quarantined',%s,%s)", (command_id, observed_run_id, code),
    )


def test_sql_projection_classifies_non_pending_states_from_synthetic_tuples(g4_harness):
    """Exercise SQL classification only; synthetic rows do not indicate a real Temporal run."""
    harness = g4_harness
    cases = {
        phase: _accepted(harness, key=f"admission-sql-{phase}")
        for phase in ("admitted", "applied", "rejected", "prebinding_quarantine", "bound_quarantine", "corrupt")
    }
    deployment, build = None, None
    run_ids = {phase: str(uuid4()) for phase in ("admitted", "applied", "rejected", "bound_quarantine")}
    with psycopg.connect(owner_dsn(harness["database"]), autocommit=True) as owner:
        deployment, build = _seed_test_deployment(owner)
        _seed_binding(owner, cases["admitted"], deployment, build, run_id=run_ids["admitted"])
        _seed_binding(owner, cases["applied"], deployment, build, run_id=run_ids["applied"])
        applied_command = cases["applied"]["command_id"]
        owner.execute("UPDATE ifpmic.commands SET status='applied',applied_revision=1 WHERE command_id=%s",
                      (applied_command,))
        owner.execute("UPDATE ifpmic.jobs SET status='QUEUED',revision=1 WHERE job_id=%s",
                      (cases["applied"]["resource_id"],))
        owner.execute(
            "INSERT INTO ifpmic.projection_receipts(job_id,transition_sequence,command_id,admitted_run_id,build_id,"
            "proposal_sha256,expected_revision,outcome,result_json) VALUES(%s,1,%s,%s,%s,%s,0,'applied',%s::jsonb)",
            (cases["applied"]["resource_id"], applied_command, run_ids["applied"], build, "6" * 64,
             json.dumps({"status": "applied", "command_id": applied_command, "applied_revision": 1,
                         "error_code": None, "job_id": cases["applied"]["resource_id"],
                         "job_status": "QUEUED", "revision": 1})),
        )

        _seed_binding(owner, cases["rejected"], deployment, build, run_id=run_ids["rejected"])
        rejected_command = cases["rejected"]["command_id"]
        owner.execute("UPDATE ifpmic.commands SET status='rejected',error_code='PROFILE_INELIGIBLE' "
                      "WHERE command_id=%s", (rejected_command,))
        owner.execute(
            "INSERT INTO ifpmic.projection_receipts(job_id,transition_sequence,command_id,admitted_run_id,build_id,"
            "proposal_sha256,expected_revision,outcome,result_json) VALUES(%s,1,%s,%s,%s,%s,0,'rejected',%s::jsonb)",
            (cases["rejected"]["resource_id"], rejected_command, run_ids["rejected"], build, "7" * 64,
             json.dumps({"status": "rejected", "command_id": rejected_command, "applied_revision": None,
                         "error_code": "PROFILE_INELIGIBLE", "job_id": cases["rejected"]["resource_id"],
                         "job_status": "DRAFT", "revision": 0})),
        )

        prebinding_command = cases["prebinding_quarantine"]["command_id"]
        _seed_quarantine_attempt(owner, prebinding_command, "WORKSPACE_IDENTITY_CONFLICT")
        bound_command = _seed_binding(owner, cases["bound_quarantine"], deployment, build,
                                      state="quarantined", run_id=run_ids["bound_quarantine"],
                                      quarantine_code="BUILD_UNAVAILABLE")
        _seed_quarantine_attempt(owner, bound_command, "BUILD_UNAVAILABLE",
                                 observed_run_id=run_ids["bound_quarantine"])
        # A dispatched outbox without a binding/run is explicitly inconsistent.
        corrupt_command = cases["corrupt"]["command_id"]
        corrupt_run = str(uuid4())
        owner.execute(
            "UPDATE ifpmic.commands_outbox SET state='dispatched',generation=1,dispatched_at=now(),"
            "observed_run_id=%s WHERE command_id=%s", (corrupt_run, corrupt_command),
        )
        owner.execute(
            "INSERT INTO ifpmic.delivery_attempts(command_id,generation,completed_at,result,observed_run_id) "
            "VALUES(%s,1,now(),'started',%s)", (corrupt_command, corrupt_run),
        )

    expected = {
        "admitted": ("admitted_pending_projection", run_ids["admitted"], None),
        "applied": ("applied", run_ids["applied"], "applied"),
        "rejected": ("rejected", run_ids["rejected"], "rejected"),
        "prebinding_quarantine": ("quarantined", None, None),
        "bound_quarantine": ("quarantined", run_ids["bound_quarantine"], None),
    }
    for case, (phase, run_id, receipt_outcome) in expected.items():
        response = harness["client"].get(f"/api/v1/jobs/{cases[case]['resource_id']}/admission")
        assert response.status_code == 200
        dto = response.json()
        assert (dto["admission_status"], dto["admitted_run_id"]) == (phase, run_id)
        assert (None if dto["receipt"] is None else dto["receipt"]["outcome"]) == receipt_outcome
    _fixed(harness["client"].get(f"/api/v1/jobs/{cases['corrupt']['resource_id']}/admission"),
           503, "DEPENDENCY_UNAVAILABLE")


def test_read_authorization_hides_missing_malformed_and_invisible_jobs(g4_harness):
    harness = g4_harness
    accepted = _accepted(harness)
    _fixed(harness["client"].get("/api/v1/jobs/not-a-uuid/admission"), 403, "FORBIDDEN")
    _fixed(harness["client"].get(f"/api/v1/jobs/{uuid4()}/admission"), 403, "FORBIDDEN")

    _app_b, client_b = client_with(harness)
    try:
        client_b.cookies.clear()
        user_b, _session, _csrf = login(client_b, harness["provider"], harness["clock"], "admission-user-b")
        seed_membership(harness["database"], PROJECT_ID, user_b, active=True, capabilities=())
        _fixed(client_b.get(f"/api/v1/jobs/{accepted['resource_id']}/admission"), 403, "FORBIDDEN")

        with psycopg.connect(operator_dsn(harness["database"]), autocommit=True) as operator:
            operator.execute(
                "INSERT INTO ifpmic.job_delegations(project_id,job_id,user_id,action,expires_at) "
                "VALUES(%s,%s,%s,'job.read',%s)",
                (PROJECT_ID, accepted["resource_id"], user_b, harness["clock"]() + timedelta(hours=1)),
            )
        delegated = client_b.get(f"/api/v1/jobs/{accepted['resource_id']}/admission")
        assert delegated.status_code == 200
        assert delegated.json()["job_id"] == accepted["resource_id"]

        with psycopg.connect(operator_dsn(harness["database"]), autocommit=True) as operator:
            operator.execute(
                "UPDATE ifpmic.memberships SET active=false WHERE project_id=%s AND user_id=%s",
                (PROJECT_ID, user_b),
            )
        _fixed(client_b.get(f"/api/v1/jobs/{accepted['resource_id']}/admission"), 403, "FORBIDDEN")

        seed_membership(harness["database"], PROJECT_ID, user_b, active=True, capabilities=())
        with psycopg.connect(operator_dsn(harness["database"]), autocommit=True) as operator:
            operator.execute(
                "UPDATE ifpmic.job_delegations SET revoked_at=%s "
                "WHERE project_id=%s AND job_id=%s AND user_id=%s",
                (harness["clock"](), PROJECT_ID, accepted["resource_id"], user_b),
            )
        _fixed(client_b.get(f"/api/v1/jobs/{accepted['resource_id']}/admission"), 403, "FORBIDDEN")
    finally:
        client_b.close()


def test_visible_job_with_inconsistent_create_command_fails_closed(g4_harness):
    harness = g4_harness
    accepted = _accepted(harness)
    with psycopg.connect(owner_dsn(harness["database"]), autocommit=True) as owner:
        owner.execute(
            "UPDATE ifpmic.commands SET status='applied',applied_revision=1 WHERE command_id=%s",
            (accepted["command_id"],),
        )
    _fixed(
        harness["client"].get(f"/api/v1/jobs/{accepted['resource_id']}/admission"),
        503,
        "DEPENDENCY_UNAVAILABLE",
    )


def test_admission_read_requires_authenticated_session(g4_harness):
    with TestClient(g4_harness["app"], base_url=API_ORIGIN, follow_redirects=False) as client:
        response = client.get(f"/api/v1/jobs/{uuid4()}/admission")
    _fixed(response, 401, "AUTH_REQUIRED")


def test_read_function_has_narrow_runtime_execute_acl_and_fixed_security(g4_harness):
    database, _cluster = g4_harness["database"]
    signature = "ifpmic.read_job_admission(uuid)"
    with psycopg.connect(owner_dsn(g4_harness["database"])) as owner:
        function = owner.execute(
            "SELECT pg_get_userbyid(p.proowner),p.prosecdef,p.provolatile,p.proconfig "
            "FROM pg_proc p WHERE p.oid=%s::regprocedure", (signature,),
        ).fetchone()
        acl = owner.execute(
            "SELECT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE r.rolname END,x.privilege_type FROM pg_proc p "
            "CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x "
            "LEFT JOIN pg_roles r ON r.oid=x.grantee WHERE p.oid=%s::regprocedure",
            (signature,),
        ).fetchall()
    assert function == (database.roles.migration, True, "s", ["search_path=pg_catalog, ifpmic, pg_temp"])
    assert set(acl) == {
        (database.roles.migration, "EXECUTE"),
        (database.roles.runtime, "EXECUTE"),
    }
    with psycopg.connect(runtime_dsn(g4_harness["database"])) as runtime:
        for table in ("execution_bindings", "projection_receipts", "delivery_attempts",
                      "worker_run_scopes", "engine_builds", "execution_deployments"):
            assert not runtime.execute(
                "SELECT has_table_privilege(current_user,%s,'SELECT')", (f"ifpmic.{table}",),
            ).fetchone()[0]
