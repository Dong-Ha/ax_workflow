"""Read-only API contract tests for the bounded mock preflight result."""

from __future__ import annotations

import json
from datetime import timedelta
from uuid import UUID, uuid4

import psycopg
from fastapi.testclient import TestClient

from tests.ifpmic_api.jobs_fixture import (
    API_ORIGIN, PROJECT_ID, client_with, login, owner_dsn, operator_dsn,
    runtime_dsn, seed_membership,
)
from tests.ifpmic_api.test_admission_read import (
    _accepted, _seed_binding, _seed_test_deployment,
)

pytest_plugins = ("tests.ifpmic_api.jobs_fixture", "tests.ifpmic_api.workflow_schema_fixture")


def _fixed(response, status: int, code: str) -> None:
    assert response.status_code == status
    value = response.json()
    assert set(value) == {"code", "message", "trace_id"}
    assert value["code"] == value["message"] == code
    UUID(value["trace_id"])
    assert response.headers.get("cache-control") == "no-store"
    assert response.headers.get("referrer-policy") == "no-referrer"


def _accepted_job(harness, key="mock-task-read"):
    return _accepted(harness, key=key)


def _seed_applied_mock(owner, accepted, deployment, build, *, result=True):
    """Seed relational acceptance tuples; this is not evidence of Temporal execution."""
    run_id = str(uuid4())
    command_id = str(_seed_binding(owner, accepted, deployment, build, run_id=run_id))
    job_id = accepted["resource_id"]
    owner.execute("UPDATE ifpmic.workspace_intents SET state='READY' WHERE job_id=%s", (job_id,))
    owner.execute("UPDATE ifpmic.commands SET status='applied',applied_revision=1 WHERE command_id=%s",
                  (command_id,))
    owner.execute("UPDATE ifpmic.jobs SET status='QUEUED',revision=1 WHERE job_id=%s", (job_id,))
    owner.execute(
        "INSERT INTO ifpmic.projection_receipts(job_id,transition_sequence,command_id,admitted_run_id,build_id,"
        "proposal_sha256,expected_revision,outcome,result_json) VALUES(%s,1,%s,%s,%s,%s,0,'applied',%s::jsonb)",
        (job_id, command_id, run_id, build, "6" * 64,
         json.dumps({"status": "applied", "command_id": command_id, "applied_revision": 1,
                    "error_code": None, "job_id": job_id, "job_status": "QUEUED", "revision": 1})),
    )
    if result:
        owner.execute(
            "INSERT INTO ifpmic.mock_task_results(job_id,command_id,admitted_run_id,build_id,task_kind,result_json) "
            "VALUES(%s,%s,%s,%s,'request-preflight-v1',%s::jsonb)",
            (job_id, command_id, run_id, build,
             json.dumps({"task_kind": "request-preflight-v1", "mode": "mock", "outcome": "passed",
                         "checks": [{"name": name, "status": "passed"} for name in
                                    ("request_saved", "workspace_ready", "engine_admitted")],
                         "result_sha256": "a" * 64})),
        )
    return job_id, command_id, run_id


def test_pending_and_completed_reads_are_exact_and_nonmutating(g4_harness):
    harness = g4_harness
    pending = _accepted_job(harness, "mock-task-pending")
    with psycopg.connect(owner_dsn(harness["database"])) as owner:
        before = owner.execute(
            "SELECT j.status,j.revision,c.status,c.applied_revision,"
            "(SELECT count(*) FROM ifpmic.mock_task_results WHERE job_id=j.job_id) "
            "FROM ifpmic.jobs j JOIN ifpmic.commands c ON c.command_id=j.create_command_id WHERE j.job_id=%s",
            (pending["resource_id"],),
        ).fetchone()
    response = harness["client"].get(f"/api/v1/jobs/{pending['resource_id']}/mock-task")
    assert response.status_code == 200
    assert response.json() == {
        "schema_version": "ifpmic.mock-task.v1", "job_id": pending["resource_id"],
        "command_id": pending["command_id"], "admitted_run_id": None, "status": "pending",
        "result": None, "completed_at": None,
    }
    with psycopg.connect(owner_dsn(harness["database"])) as owner:
        after = owner.execute(
            "SELECT j.status,j.revision,c.status,c.applied_revision,"
            "(SELECT count(*) FROM ifpmic.mock_task_results WHERE job_id=j.job_id) "
            "FROM ifpmic.jobs j JOIN ifpmic.commands c ON c.command_id=j.create_command_id WHERE j.job_id=%s",
            (pending["resource_id"],),
        ).fetchone()
    assert after == before

    # Applied admission without a stored result remains pending; this
    # synthetic relational seed does not prove that a Temporal workflow ran.
    applied = _accepted_job(harness, "mock-task-applied-no-result")
    with psycopg.connect(owner_dsn(harness["database"]), autocommit=True) as owner:
        deployment, build = _seed_test_deployment(owner)
        applied_job, applied_command, _run_id = _seed_applied_mock(
            owner, applied, deployment, build, result=False,
        )
    response = harness["client"].get(f"/api/v1/jobs/{applied_job}/mock-task")
    assert response.status_code == 200
    assert response.json() == {
        "schema_version": "ifpmic.mock-task.v1", "job_id": applied_job,
        "command_id": applied_command, "admitted_run_id": None, "status": "pending",
        "result": None, "completed_at": None,
    }

    completed = _accepted_job(harness, "mock-task-completed")
    with psycopg.connect(owner_dsn(harness["database"]), autocommit=True) as owner:
        job_id, command_id, run_id = _seed_applied_mock(owner, completed, deployment, build)
    response = harness["client"].get(f"/api/v1/jobs/{job_id}/mock-task")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"schema_version", "job_id", "command_id", "admitted_run_id", "status", "result", "completed_at"}
    assert (body["schema_version"], body["job_id"], body["command_id"], body["admitted_run_id"], body["status"]) == (
        "ifpmic.mock-task.v1", job_id, command_id, run_id, "completed")
    assert body["result"] == {
        "task_kind": "request-preflight-v1", "mode": "mock", "outcome": "passed",
        "checks": [{"name": name, "status": "passed"} for name in
                   ("request_saved", "workspace_ready", "engine_admitted")],
        "result_sha256": "a" * 64,
    }
    assert body["completed_at"].endswith("Z")
    assert set(body["result"]) == {"task_kind", "mode", "outcome", "checks", "result_sha256"}
    with psycopg.connect(owner_dsn(harness["database"]), autocommit=True) as owner:
        owner.execute(
            "UPDATE ifpmic.profile_catalog SET enabled=false WHERE project_id=%s "
            "AND snapshot_id=(SELECT snapshot_id FROM ifpmic.jobs WHERE job_id=%s)",
            (PROJECT_ID, job_id),
        )
        # Later job-state movement does not erase the immutable first receipt.
        owner.execute("UPDATE ifpmic.jobs SET status='RUNNING',revision=2 WHERE job_id=%s", (job_id,))
    # A previously valid immutable result remains readable after disablement.
    assert harness["client"].get(f"/api/v1/jobs/{job_id}/mock-task").json() == body


def test_mock_task_read_authorization_hides_other_absent_and_malformed_jobs(g4_harness):
    harness = g4_harness
    accepted = _accepted_job(harness)
    _fixed(harness["client"].get("/api/v1/jobs/not-a-uuid/mock-task"), 403, "FORBIDDEN")
    _fixed(harness["client"].get(f"/api/v1/jobs/{uuid4()}/mock-task"), 403, "FORBIDDEN")
    _app_b, client_b = client_with(harness)
    try:
        client_b.cookies.clear()
        user_b, _session, _csrf = login(client_b, harness["provider"], harness["clock"], "mock-task-user-b")
        seed_membership(harness["database"], PROJECT_ID, user_b, active=True, capabilities=())
        _fixed(client_b.get(f"/api/v1/jobs/{accepted['resource_id']}/mock-task"), 403, "FORBIDDEN")
        with psycopg.connect(operator_dsn(harness["database"]), autocommit=True) as operator:
            operator.execute(
                "INSERT INTO ifpmic.job_delegations(project_id,job_id,user_id,action,expires_at) "
                "VALUES(%s,%s,%s,'job.read',%s)",
                (PROJECT_ID, accepted["resource_id"], user_b, harness["clock"]() + timedelta(hours=1)),
            )
        assert client_b.get(f"/api/v1/jobs/{accepted['resource_id']}/mock-task").status_code == 200
        with psycopg.connect(operator_dsn(harness["database"]), autocommit=True) as operator:
            operator.execute(
                "UPDATE ifpmic.job_delegations SET revoked_at=%s WHERE project_id=%s AND job_id=%s AND user_id=%s",
                (harness["clock"](), PROJECT_ID, accepted["resource_id"], user_b),
            )
        _fixed(client_b.get(f"/api/v1/jobs/{accepted['resource_id']}/mock-task"), 403, "FORBIDDEN")
    finally:
        client_b.close()


def test_mock_task_requires_auth_and_fails_closed_on_corrupt_result(g4_harness):
    harness = g4_harness
    with TestClient(harness["app"], base_url=API_ORIGIN, follow_redirects=False) as client:
        _fixed(client.get(f"/api/v1/jobs/{uuid4()}/mock-task"), 401, "AUTH_REQUIRED")
    accepted = _accepted_job(harness, "mock-task-corrupt")
    with psycopg.connect(owner_dsn(harness["database"]), autocommit=True) as owner:
        deployment, build = _seed_test_deployment(owner)
        job_id, _command, _run = _seed_applied_mock(owner, accepted, deployment, build)
        # This test's disposable database is isolated; drop only the result
        # shape guard so the API validator sees an owner-level corruption.
        owner.execute("ALTER TABLE ifpmic.mock_task_results DROP CONSTRAINT mock_result_shape")
        owner.execute("UPDATE ifpmic.mock_task_results SET result_json='{}'::jsonb WHERE job_id=%s", (job_id,))
    _fixed(harness["client"].get(f"/api/v1/jobs/{job_id}/mock-task"), 503, "DEPENDENCY_UNAVAILABLE")

    inconsistent = _accepted_job(harness, "mock-task-command-inconsistent")
    with psycopg.connect(owner_dsn(harness["database"]), autocommit=True) as owner:
        bad_job, _command, _run = _seed_applied_mock(owner, inconsistent, deployment, build, result=False)
        owner.execute("ALTER TABLE ifpmic.commands DISABLE TRIGGER terminal_command")
        try:
            owner.execute("UPDATE ifpmic.commands SET status='accepted',applied_revision=NULL WHERE job_id=%s",
                          (bad_job,))
        finally:
            owner.execute("ALTER TABLE ifpmic.commands ENABLE TRIGGER terminal_command")
    _fixed(harness["client"].get(f"/api/v1/jobs/{bad_job}/mock-task"), 503, "DEPENDENCY_UNAVAILABLE")


def test_mock_task_read_fails_closed_on_function_identity_and_cardinality(g4_harness):
    harness = g4_harness
    accepted = _accepted_job(harness, "mock-task-function-identity")
    with psycopg.connect(owner_dsn(harness["database"]), autocommit=True) as owner:
        owner.execute("""CREATE OR REPLACE FUNCTION ifpmic.read_job_mock_task(p_job_id uuid)
            RETURNS TABLE(job_id uuid,project_id text,create_command_id uuid,owner_id uuid,mock_task jsonb)
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,ifpmic,pg_temp AS $$
            SELECT j.job_id,j.project_id,'00000000-0000-4000-8000-000000000000'::uuid,j.owner_id,
              pg_catalog.jsonb_build_object('schema_version','ifpmic.mock-task.v1','job_id',j.job_id,
                'command_id',j.create_command_id,'admitted_run_id',NULL,'status','pending',
                'result',NULL,'completed_at',NULL)
            FROM ifpmic.jobs j WHERE j.job_id=p_job_id $$""")
    _fixed(harness["client"].get(f"/api/v1/jobs/{accepted['resource_id']}/mock-task"),
           503, "DEPENDENCY_UNAVAILABLE")
    with psycopg.connect(owner_dsn(harness["database"]), autocommit=True) as owner:
        owner.execute("""CREATE OR REPLACE FUNCTION ifpmic.read_job_mock_task(p_job_id uuid)
            RETURNS TABLE(job_id uuid,project_id text,create_command_id uuid,owner_id uuid,mock_task jsonb)
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,ifpmic,pg_temp AS $$
            SELECT j.job_id,j.project_id,j.create_command_id,j.owner_id,
              pg_catalog.jsonb_build_object('schema_version','ifpmic.mock-task.v1','job_id',j.job_id,
                'command_id',j.create_command_id,'admitted_run_id',NULL,'status','pending',
                'result',NULL,'completed_at',NULL)
            FROM ifpmic.jobs j WHERE j.job_id=p_job_id
            UNION ALL
            SELECT j.job_id,j.project_id,j.create_command_id,j.owner_id,
              pg_catalog.jsonb_build_object('schema_version','ifpmic.mock-task.v1','job_id',j.job_id,
                'command_id',j.create_command_id,'admitted_run_id',NULL,'status','pending',
                'result',NULL,'completed_at',NULL)
            FROM ifpmic.jobs j WHERE j.job_id=p_job_id $$""")
    _fixed(harness["client"].get(f"/api/v1/jobs/{accepted['resource_id']}/mock-task"),
           503, "DEPENDENCY_UNAVAILABLE")


def test_mock_task_function_and_table_acl_are_narrow(g4_harness):
    database, _cluster = g4_harness["database"]
    database_pair = g4_harness["database"]
    read_signature = "ifpmic.read_job_mock_task(uuid)"
    with psycopg.connect(owner_dsn(database_pair)) as owner:
        function = owner.execute(
            "SELECT pg_get_userbyid(p.proowner),p.prosecdef,p.provolatile,p.proconfig "
            "FROM pg_proc p WHERE p.oid=%s::regprocedure", (read_signature,),
        ).fetchone()
        acl = owner.execute(
            "SELECT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE r.rolname END,x.privilege_type FROM pg_proc p "
            "CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x "
            "LEFT JOIN pg_roles r ON r.oid=x.grantee WHERE p.oid=%s::regprocedure", (read_signature,),
        ).fetchall()
    assert function == (database.roles.migration, True, "s", ["search_path=pg_catalog, ifpmic, pg_temp"])
    assert set(acl) == {(database.roles.migration, "EXECUTE"), (database.roles.runtime, "EXECUTE")}
    service_roles = (database.roles.runtime, database.roles.operator,
                     database.roles.dispatcher, database.roles.projector)
    with psycopg.connect(owner_dsn(database_pair)) as owner:
        for role in service_roles:
            for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE"):
                assert not owner.execute(
                    "SELECT has_table_privilege(%s,'ifpmic.mock_task_results',%s)", (role, privilege),
                ).fetchone()[0]
            expected_execute = role == database.roles.runtime
            assert owner.execute(
                "SELECT has_function_privilege(%s,%s,'EXECUTE')", (role, read_signature),
            ).fetchone()[0] is expected_execute
    with psycopg.connect(runtime_dsn(database_pair)) as runtime:
        assert runtime.execute("SELECT count(*) FROM ifpmic.read_job_mock_task(%s)", (uuid4(),)).fetchone()[0] == 0
