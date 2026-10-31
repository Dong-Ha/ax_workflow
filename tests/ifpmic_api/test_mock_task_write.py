"""Projector-only bounded mock task input and result persistence."""

import json
from datetime import timedelta
from uuid import uuid4

import psycopg
import pytest

from services.ifpmic_api.mock_task import evaluate_preflight
from tests.ifpmic_api.jobs_fixture import owner_dsn, seed_catalog_and_eligibility
from tests.ifpmic_api.test_admission_read import _seed_binding, _seed_test_deployment
from tests.ifpmic_api.test_mock_task_read import _accepted_job

pytest_plugins = ("tests.ifpmic_api.jobs_fixture", "tests.ifpmic_api.workflow_schema_fixture")


def test_projector_mock_task_write_is_scoped_opted_in_and_replayable(g4_harness):
    h = g4_harness
    accepted = _accepted_job(h, "mock-task-write")
    # The API harness uses a frozen 2030 clock, while worker SQL deliberately
    # checks the database clock. Supply a separate, currently valid synthetic
    # grant; do not weaken the production eligibility time checks.
    with psycopg.connect(owner_dsn(h["database"])) as owner:
        database_now = owner.execute("SELECT clock_timestamp()").fetchone()[0]
    seed_catalog_and_eligibility(h["database"], h["record"],
        granted_at=database_now - timedelta(minutes=1),
        expires_at=database_now + timedelta(hours=1))
    run_id = str(uuid4())
    with psycopg.connect(owner_dsn(h["database"]), autocommit=True) as owner:
        deployment, build = _seed_test_deployment(owner)
        catalog_hash = owner.execute("SELECT record_bytes_sha256 FROM ifpmic.profile_catalog WHERE project_id=%s AND snapshot_id=(SELECT snapshot_id FROM ifpmic.jobs WHERE job_id=%s)",
                                     (h["project_id"], accepted["resource_id"])).fetchone()[0]
        command = str(_seed_binding(owner, accepted, deployment, build, run_id=run_id, catalog_hash=catalog_hash))
        job = accepted["resource_id"]
        owner.execute("UPDATE ifpmic.workspace_intents SET state='READY' WHERE job_id=%s", (job,))
        owner.execute("UPDATE ifpmic.commands SET status='applied',applied_revision=1 WHERE command_id=%s", (command,))
        owner.execute("UPDATE ifpmic.jobs SET status='QUEUED',revision=1 WHERE job_id=%s", (job,))
        owner.execute(
            "INSERT INTO ifpmic.projection_receipts(job_id,transition_sequence,command_id,admitted_run_id,build_id,"
            "proposal_sha256,expected_revision,outcome,result_json) VALUES(%s,1,%s,%s,%s,%s,0,'applied',%s::jsonb)",
            (job, command, run_id, build, "6" * 64,
             json.dumps({"status":"applied","command_id":command,"applied_revision":1,
                "error_code":None,"job_id":job,"job_status":"QUEUED","revision":1})),
        )
        owner.execute("INSERT INTO ifpmic.mock_task_builds(deployment_id,build_id) VALUES(%s,%s)", (deployment, build))
        role = h["database"][0].roles.projector
        owner.execute(
            "INSERT INTO ifpmic.worker_principals(role_oid,role_name,kind,deployment_id,build_id) "
            "SELECT oid,%s,'projector',%s,%s FROM pg_roles WHERE rolname=%s", (role, deployment, build, role),
        )
        owner.execute(
            "INSERT INTO ifpmic.worker_run_scopes(job_id,admitted_run_id,projector_role_oid,projector_role_name,deployment_id,build_id) "
            "SELECT %s,%s,oid,%s,%s,%s FROM pg_roles WHERE rolname=%s", (job, run_id, role, deployment, build, role),
        )
        binding_hash = owner.execute("SELECT binding_sha256 FROM ifpmic.execution_bindings WHERE job_id=%s", (job,)).fetchone()[0]

    database, cluster = h["database"]
    with psycopg.connect(database.projector_dsn(cluster), autocommit=True) as projector:
        with psycopg.connect(owner_dsn(h["database"]), autocommit=True) as owner:
            owner.execute("UPDATE ifpmic.mock_task_builds SET enabled=false WHERE deployment_id=%s AND build_id=%s",
                          (deployment, build))
        with pytest.raises(psycopg.Error):
            projector.execute("SELECT ifpmic.read_mock_task_input(%s,%s,%s,%s)", (job, run_id, build, binding_hash))
        with psycopg.connect(owner_dsn(h["database"]), autocommit=True) as owner:
            owner.execute("UPDATE ifpmic.mock_task_builds SET enabled=true WHERE deployment_id=%s AND build_id=%s",
                          (deployment, build))
            owner.execute("UPDATE ifpmic.workspace_intents SET state='ERROR' WHERE job_id=%s", (job,))
        with pytest.raises(psycopg.Error):
            projector.execute("SELECT ifpmic.read_mock_task_input(%s,%s,%s,%s)", (job, run_id, build, binding_hash))
        with psycopg.connect(owner_dsn(h["database"]), autocommit=True) as owner:
            owner.execute("UPDATE ifpmic.workspace_intents SET state='READY' WHERE job_id=%s", (job,))
        ready = projector.execute("SELECT ifpmic.read_mock_task_input(%s,%s,%s,%s)",
                                  (job, run_id, build, binding_hash)).fetchone()[0]
        assert ready["status"] == "ready"
        assert set(ready["input"]) == {"job_id","command_id","admitted_run_id","build_id","change_type",
                                       "base_ref_present","request_saved","workspace_ready","engine_admitted"}
        result = evaluate_preflight(ready["input"])
        with pytest.raises(psycopg.Error):
            projector.execute("SELECT ifpmic.record_mock_task_result(%s,%s,%s,%s,%s)",
                              (job, run_id, build, binding_hash,
                               psycopg.types.json.Jsonb({**result, "result_sha256":"0" * 64})))
        with psycopg.connect(owner_dsn(h["database"])) as owner:
            assert owner.execute("SELECT count(*) FROM ifpmic.mock_task_results WHERE job_id=%s", (job,)).fetchone()[0] == 0
        assert projector.execute("SELECT ifpmic.record_mock_task_result(%s,%s,%s,%s,%s)",
                                 (job, run_id, build, binding_hash, psycopg.types.json.Jsonb(result))).fetchone()[0] == {"status":"completed"}
        with psycopg.connect(owner_dsn(h["database"]), autocommit=True) as owner:
            owner.execute("UPDATE ifpmic.workspace_intents SET state='ERROR' WHERE job_id=%s", (job,))
        # The immutable committed result is replayed without consulting mutable workspace state.
        assert projector.execute("SELECT ifpmic.read_mock_task_input(%s,%s,%s,%s)",
                                 (job, run_id, build, binding_hash)).fetchone()[0] == {"status":"completed"}
        assert projector.execute("SELECT ifpmic.record_mock_task_result(%s,%s,%s,%s,%s)",
                                 (job, run_id, build, binding_hash, psycopg.types.json.Jsonb(result))).fetchone()[0] == {"status":"completed"}
        with pytest.raises(psycopg.Error):
            projector.execute("SELECT ifpmic.record_mock_task_result(%s,%s,%s,%s,%s)",
                              (job, run_id, build, binding_hash,
                               psycopg.types.json.Jsonb({**result, "mode":"private"})))
        with pytest.raises(psycopg.Error):
            projector.execute("SELECT ifpmic.read_mock_task_input(%s,%s,%s,%s)", (job, run_id, build, "0" * 64))
        with pytest.raises(psycopg.Error):
            projector.execute("SELECT ifpmic.read_mock_task_input(%s,%s,%s,%s)", (job, run_id, "a" * 64, binding_hash))
        with pytest.raises(psycopg.Error):
            projector.execute("SELECT ifpmic.read_mock_task_input(%s,%s,%s,%s)", (job, str(uuid4()), build, binding_hash))

    with psycopg.connect(owner_dsn(h["database"])) as owner:
        for role in (database.roles.runtime, database.roles.operator, database.roles.dispatcher, database.roles.projector):
            acl = owner.execute(
                "SELECT has_table_privilege(%s,'ifpmic.mock_task_builds','SELECT'),"
                "has_table_privilege(%s,'ifpmic.mock_task_builds','INSERT'),"
                "has_table_privilege(%s,'ifpmic.mock_task_builds','UPDATE'),"
                "has_table_privilege(%s,'ifpmic.mock_task_builds','DELETE')",
                (role, role, role, role),
            ).fetchone()
            assert acl == (False, False, False, False)
        for signature in (
            "ifpmic.read_mock_task_input(uuid,text,text,text)",
            "ifpmic.record_mock_task_result(uuid,text,text,text,jsonb)",
            "ifpmic.mock_preflight_result(uuid,uuid,uuid,text)",
        ):
            for role in (database.roles.runtime, database.roles.operator, database.roles.dispatcher, database.roles.projector):
                allowed = owner.execute("SELECT has_function_privilege(%s,%s,'EXECUTE')", (role, signature)).fetchone()[0]
                assert allowed is (role == database.roles.projector and "mock_preflight_result" not in signature)

    with psycopg.connect(database.runtime_dsn(cluster), autocommit=True) as runtime:
        with pytest.raises(psycopg.Error):
            runtime.execute("SELECT ifpmic.read_mock_task_input(%s,%s,%s,%s)", (job, run_id, build, binding_hash))
