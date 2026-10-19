"""Literal H2 prebinding incident oracles for migration 004.

These cases exercise a trusted dispatcher SQL boundary. Filesystem identity
validation remains in the dispatcher and is not simulated by these SQL tests.
"""

from __future__ import annotations

import shutil
import threading
import time
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest

from services.ifpmic_api.migrate import MigrationError, apply_migrations
from tests.ifpmic_api.jobs_fixture import valid_create_job, write_headers


pytest_plugins = ("tests.ifpmic_api.jobs_fixture", "tests.ifpmic_api.workflow_schema_fixture")

DEPLOYMENT_ID = "h2-test-deployment"
NAMESPACE = "default"
SERVER_ENDPOINT = "127.0.0.1:7233"
SERVER_CONFIG_SHA256 = "207da747b02c8a63bba3abd3d9d21131ad0c242523d7a2982650e26698eae822"
SOURCE_MANIFEST_SHA256 = "d" * 64
ENVIRONMENT_MANIFEST_SHA256 = "e" * 64
BUILD_ID = "b2576b14c813fb095fcb81023b66f16f73e1ef59c5ea3e828e3d37f7cc87ede2"
FOREIGN_DEPLOYMENT_ID = "h2-foreign-deployment"
FOREIGN_BUILD_ID = "f" * 64
FOREIGN_SERVER_SHA256 = "c" * 64


def _register_dispatcher(owner, database):
    owner.execute(
        "INSERT INTO ifpmic.execution_deployments(deployment_id,namespace,server_endpoint,server_config_sha256) "
        "VALUES(%s,%s,%s,%s)",
        (DEPLOYMENT_ID, NAMESPACE, SERVER_ENDPOINT, SERVER_CONFIG_SHA256),
    )
    owner.execute(
        "INSERT INTO ifpmic.engine_builds(deployment_id,build_id,source_manifest_sha256,environment_manifest_sha256,"
        "workflow_type,task_queue,protocol_version) VALUES(%s,%s,%s,%s,'IFPMICJobWorkflow',%s,'h2-v1')",
        (DEPLOYMENT_ID, BUILD_ID, SOURCE_MANIFEST_SHA256, ENVIRONMENT_MANIFEST_SHA256, f"ifpmic.build.{BUILD_ID}"),
    )
    role_oids = dict(owner.execute(
        "SELECT rolname,oid FROM pg_roles WHERE rolname=ANY(%s)",
        ([database.roles.dispatcher, database.roles.projector],),
    ).fetchall())
    owner.execute(
        "INSERT INTO ifpmic.worker_principals(role_oid,role_name,kind,deployment_id,build_id) "
        "VALUES(%s,%s,'dispatcher',%s,NULL),(%s,%s,'projector',%s,%s)",
        (role_oids[database.roles.dispatcher], database.roles.dispatcher, DEPLOYMENT_ID,
         role_oids[database.roles.projector], database.roles.projector, DEPLOYMENT_ID, BUILD_ID),
    )


@pytest.fixture
def prebinding_delivery(workflow_scram_hba, g4_harness):
    """Create one accepted CREATE, READY intent and exact live leased attempt."""
    response = g4_harness["client"].post(
        "/api/v1/jobs", json=valid_create_job(g4_harness),
        headers=write_headers(g4_harness, key=f"h2-prebinding-{uuid4().hex}"),
    )
    assert response.status_code == 202
    accepted = response.json()
    command_id, job_id = accepted["command_id"], accepted["resource_id"]
    database, cluster = g4_harness["database"]
    with psycopg.connect(database.owner_dsn(cluster), autocommit=True) as owner:
        workspace = owner.execute(
            "UPDATE ifpmic.workspace_intents SET state='READY' WHERE job_id=%s "
            "RETURNING workspace_token,generation", (job_id,),
        ).fetchone()
        _register_dispatcher(owner, database)
        actor, project = owner.execute(
            "SELECT actor_id,project_id FROM ifpmic.commands WHERE command_id=%s", (command_id,),
        ).fetchone()
        sibling_command_id = str(uuid4())
        owner.execute(
            "INSERT INTO ifpmic.commands(command_id,actor_id,route,idempotency_key,project_id,job_id,"
            "command_payload_json,payload_sha256) VALUES(%s,%s,%s,%s,%s,%s,'{}',%s)",
            (sibling_command_id, actor, f"POST /api/v1/jobs/{job_id}/human-submissions",
             f"h2-sibling-{uuid4().hex}", project, job_id, "b" * 64),
        )
        owner.execute("INSERT INTO ifpmic.commands_outbox(command_id) VALUES(%s)", (sibling_command_id,))
    assert workspace is not None
    with psycopg.connect(database.dispatcher_dsn(cluster), autocommit=True) as dispatcher:
        claim = dispatcher.execute("SELECT ifpmic.claim_delivery(%s)", (command_id,)).fetchone()[0]
    assert claim["status"] == "claimed"
    return {
        "database": database, "cluster": cluster, "command_id": command_id, "job_id": job_id,
        "sibling_command_id": sibling_command_id,
        "generation": claim["generation"], "claim_token": str(claim["claim_token"]),
        "workspace_token": str(workspace[0]), "workspace_generation": workspace[1],
    }


def _incident(delivery, code="WORKSPACE_IDENTITY_CONFLICT"):
    database, cluster = delivery["database"], delivery["cluster"]
    with psycopg.connect(database.dispatcher_dsn(cluster), autocommit=True) as dispatcher:
        return dispatcher.execute(
            "SELECT ifpmic.report_dispatch_incident(%s,%s,%s,%s)",
            (delivery["command_id"], delivery["generation"], delivery["claim_token"], code),
        ).fetchone()[0]


def _owned_rows(delivery):
    database, cluster = delivery["database"], delivery["cluster"]
    with psycopg.connect(database.owner_dsn(cluster)) as owner:
        outbox = owner.execute(
            "SELECT state,generation,claim_token,claim_expires_at,last_error FROM ifpmic.commands_outbox "
            "WHERE command_id=%s", (delivery["command_id"],),
        ).fetchone()
        attempt = owner.execute(
            "SELECT completed_at,result,error_code FROM ifpmic.delivery_attempts "
            "WHERE command_id=%s AND generation=%s",
            (delivery["command_id"], delivery["generation"]),
        ).fetchone()
        job = owner.execute(
            "SELECT status,revision,cycle,current_step_ids,candidate_fingerprint FROM ifpmic.jobs WHERE job_id=%s",
            (delivery["job_id"],),
        ).fetchone()
        command = owner.execute(
            "SELECT status,applied_revision,error_code FROM ifpmic.commands WHERE command_id=%s",
            (delivery["command_id"],),
        ).fetchone()
        binding_count = owner.execute(
            "SELECT count(*) FROM ifpmic.execution_bindings WHERE job_id=%s", (delivery["job_id"],),
        ).fetchone()[0]
    return outbox, attempt, job, command, binding_count


def _protected_snapshot(delivery):
    """Capture facts the unbound incident branch is forbidden to mutate."""
    database, cluster = delivery["database"], delivery["cluster"]
    with psycopg.connect(database.owner_dsn(cluster)) as owner:
        workspace = owner.execute(
            "SELECT command_id,workspace_token,generation,state,claim_token,claim_expires_at,error_code "
            "FROM ifpmic.workspace_intents WHERE job_id=%s", (delivery["job_id"],),
        ).fetchone()
        membership = owner.execute(
            "SELECT active,capabilities,lock_version FROM ifpmic.memberships "
            "WHERE project_id=(SELECT project_id FROM ifpmic.jobs WHERE job_id=%s) "
            "AND user_id=(SELECT owner_id FROM ifpmic.jobs WHERE job_id=%s)",
            (delivery["job_id"], delivery["job_id"]),
        ).fetchone()
        authority = owner.execute(
            "SELECT d.enabled,p.active FROM ifpmic.execution_deployments d "
            "JOIN ifpmic.worker_principals p USING(deployment_id) WHERE d.deployment_id=%s "
            "ORDER BY p.kind,p.role_name", (DEPLOYMENT_ID,),
        ).fetchall()
        scopes = owner.execute(
            "SELECT count(*) FROM ifpmic.worker_run_scopes WHERE job_id=%s", (delivery["job_id"],),
        ).fetchone()[0]
        receipts = owner.execute(
            "SELECT count(*) FROM ifpmic.projection_receipts WHERE job_id=%s", (delivery["job_id"],),
        ).fetchone()[0]
        siblings = owner.execute(
            "SELECT c.command_id::text,c.route,c.status,o.state,o.generation,o.last_error "
            "FROM ifpmic.commands c JOIN ifpmic.commands_outbox o USING(command_id) "
            "WHERE c.job_id=%s AND c.command_id<>%s ORDER BY c.command_id",
            (delivery["job_id"], delivery["command_id"]),
        ).fetchall()
    return workspace, membership, authority, scopes, receipts, siblings


def test_h2_prebinding_ready_identity_conflict_quarantines_only_exact_delivery(prebinding_delivery):
    delivery = prebinding_delivery
    protected = _protected_snapshot(delivery)
    assert protected[0][3] == "READY"
    assert protected[1][0] is True
    assert protected[2] == [(True, True), (True, True)]
    assert protected[3:5] == (0, 0)
    assert len(protected[5]) == 1
    assert protected[5][0] == (
        delivery["sibling_command_id"], f"POST /api/v1/jobs/{delivery['job_id']}/human-submissions",
        "accepted", "pending", 0, None,
    )
    assert _incident(delivery) == {"status": "quarantined", "code": "WORKSPACE_IDENTITY_CONFLICT"}
    outbox, attempt, job, command, bindings = _owned_rows(delivery)
    assert outbox[0:2] == ("quarantined", delivery["generation"])
    assert outbox[2] is None and outbox[3] is None
    assert outbox[4] == "WORKSPACE_IDENTITY_CONFLICT"
    assert attempt[0] is not None
    assert attempt[1:] == ("quarantined", "WORKSPACE_IDENTITY_CONFLICT")
    assert job == ("DRAFT", 0, 0, [], None)
    assert command == ("accepted", None, None)
    assert bindings == 0
    assert _protected_snapshot(delivery) == protected


def test_h2_prebinding_incident_rejects_non_dispatcher_without_effect(prebinding_delivery):
    delivery = prebinding_delivery
    database, cluster = delivery["database"], delivery["cluster"]
    with psycopg.connect(database.runtime_dsn(cluster), autocommit=True) as runtime:
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as denied:
            runtime.execute(
                "SELECT ifpmic.report_dispatch_incident(%s,%s,%s,'WORKSPACE_IDENTITY_CONFLICT')",
                (delivery["command_id"], delivery["generation"], delivery["claim_token"]),
            )
    assert denied.value.sqlstate == "42501"
    assert _owned_rows(delivery)[0][0] == "leased"
    assert _owned_rows(delivery)[1] == (None, None, None)


def _assert_disabled_authority_is_forbidden(delivery, disable_sql, enable_sql):
    database, cluster = delivery["database"], delivery["cluster"]
    with psycopg.connect(database.owner_dsn(cluster), autocommit=True) as owner:
        owner.execute(disable_sql, (DEPLOYMENT_ID,))
    with psycopg.connect(database.dispatcher_dsn(cluster), autocommit=True) as dispatcher:
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as denied:
            dispatcher.execute(
                "SELECT ifpmic.report_dispatch_incident(%s,%s,%s,'WORKSPACE_IDENTITY_CONFLICT')",
                (delivery["command_id"], delivery["generation"], delivery["claim_token"]),
            )
    assert denied.value.sqlstate == "42501"
    assert _owned_rows(delivery)[0][0] == "leased"
    assert _owned_rows(delivery)[1] == (None, None, None)
    with psycopg.connect(database.owner_dsn(cluster), autocommit=True) as owner:
        owner.execute(enable_sql, (DEPLOYMENT_ID,))


def test_h2_prebinding_disabled_principal_is_forbidden(prebinding_delivery):
    _assert_disabled_authority_is_forbidden(
        prebinding_delivery,
        "UPDATE ifpmic.worker_principals SET active=false WHERE kind='dispatcher' AND deployment_id=%s",
        "UPDATE ifpmic.worker_principals SET active=true WHERE kind='dispatcher' AND deployment_id=%s",
    )


def test_h2_prebinding_disabled_deployment_is_forbidden(prebinding_delivery):
    _assert_disabled_authority_is_forbidden(
        prebinding_delivery,
        "UPDATE ifpmic.execution_deployments SET enabled=false WHERE deployment_id=%s",
        "UPDATE ifpmic.execution_deployments SET enabled=true WHERE deployment_id=%s",
    )


def _insert_wrong_route_delivery(delivery):
    database, cluster = delivery["database"], delivery["cluster"]
    wrong_command_id, wrong_token = str(uuid4()), str(uuid4())
    with psycopg.connect(database.owner_dsn(cluster), autocommit=True) as owner:
        actor, project = owner.execute(
            "SELECT actor_id,project_id FROM ifpmic.commands WHERE command_id=%s",
            (delivery["command_id"],),
        ).fetchone()
        owner.execute(
            "INSERT INTO ifpmic.commands(command_id,actor_id,route,idempotency_key,project_id,job_id,"
            "command_payload_json,payload_sha256) VALUES(%s,%s,%s,%s,%s,%s,'{}',%s)",
            (wrong_command_id, actor, f"POST /api/v1/jobs/{delivery['job_id']}/human-submissions",
             f"h2-wrong-route-{uuid4().hex}", project, delivery["job_id"], "a" * 64),
        )
        owner.execute(
            "INSERT INTO ifpmic.commands_outbox(command_id,state,generation,claim_token,claim_expires_at) "
            "VALUES(%s,'leased',1,%s,clock_timestamp()+interval '30 seconds')",
            (wrong_command_id, wrong_token),
        )
        owner.execute(
            "INSERT INTO ifpmic.delivery_attempts(command_id,generation) VALUES(%s,1)", (wrong_command_id,),
        )
    return {**delivery, "command_id": wrong_command_id, "generation": 1, "claim_token": wrong_token}


def test_h2_prebinding_wrong_create_route_is_forbidden(prebinding_delivery):
    wrong_delivery = _insert_wrong_route_delivery(prebinding_delivery)
    database, cluster = wrong_delivery["database"], wrong_delivery["cluster"]
    with psycopg.connect(database.dispatcher_dsn(cluster), autocommit=True) as dispatcher:
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as wrong_route:
            dispatcher.execute(
                "SELECT ifpmic.report_dispatch_incident(%s,1,%s,'WORKSPACE_IDENTITY_CONFLICT')",
                (wrong_delivery["command_id"], wrong_delivery["claim_token"]),
            )
    assert wrong_route.value.sqlstate == "42501"
    assert _owned_rows(wrong_delivery)[0][0] == "leased"
    assert _owned_rows(wrong_delivery)[1] == (None, None, None)


def test_h2_prebinding_terminal_job_is_forbidden(prebinding_delivery):
    delivery = prebinding_delivery
    database, cluster = delivery["database"], delivery["cluster"]
    with psycopg.connect(database.owner_dsn(cluster), autocommit=True) as owner:
        owner.execute("UPDATE ifpmic.jobs SET status='FAILED',revision=1 WHERE job_id=%s", (delivery["job_id"],))
    with psycopg.connect(database.dispatcher_dsn(cluster), autocommit=True) as dispatcher:
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as terminal:
            dispatcher.execute(
                "SELECT ifpmic.report_dispatch_incident(%s,%s,%s,'WORKSPACE_IDENTITY_CONFLICT')",
                (delivery["command_id"], delivery["generation"], delivery["claim_token"]),
            )
    assert terminal.value.sqlstate == "42501"
    assert _owned_rows(delivery)[0][0] == "leased"


def test_h2_prebinding_old_generation_and_token_cannot_quarantine_reclaimed_lease(prebinding_delivery):
    delivery = prebinding_delivery
    database, cluster = delivery["database"], delivery["cluster"]
    with psycopg.connect(database.owner_dsn(cluster), autocommit=True) as owner:
        owner.execute(
            "UPDATE ifpmic.commands_outbox SET claim_expires_at=clock_timestamp()-interval '1 second' "
            "WHERE command_id=%s", (delivery["command_id"],),
        )
    with psycopg.connect(database.dispatcher_dsn(cluster), autocommit=True) as dispatcher:
        reclaimed = dispatcher.execute("SELECT ifpmic.claim_delivery(%s)", (delivery["command_id"],)).fetchone()[0]
    assert reclaimed["status"] == "claimed"
    assert reclaimed["generation"] == delivery["generation"] + 1
    assert str(reclaimed["claim_token"]) != delivery["claim_token"]
    assert _incident(delivery) == {"status": "stale", "affected": 0, "code": "CLAIM_STALE"}
    outbox, old_attempt, *_ = _owned_rows(delivery)
    assert outbox[0] == "leased" and outbox[1] == reclaimed["generation"]
    assert str(outbox[2]) == str(reclaimed["claim_token"])
    assert old_attempt[1:] == ("expired", None)


def test_h2_prebinding_lease_expiring_while_job_lock_waits_is_stale(prebinding_delivery):
    delivery = prebinding_delivery
    database, cluster = delivery["database"], delivery["cluster"]
    started = threading.Event()
    observed = {}

    def report_after_lock_wait():
        with psycopg.connect(database.dispatcher_dsn(cluster), autocommit=True) as dispatcher:
            dispatcher.execute("SET application_name='h2-prebinding-expiry-wait'")
            started.set()
            observed["result"] = dispatcher.execute(
                "SELECT ifpmic.report_dispatch_incident(%s,%s,%s,'WORKSPACE_IDENTITY_CONFLICT')",
                (delivery["command_id"], delivery["generation"], delivery["claim_token"]),
            ).fetchone()[0]

    with psycopg.connect(database.owner_dsn(cluster), autocommit=False) as owner:
        owner.execute(
            "UPDATE ifpmic.commands_outbox SET claim_expires_at=clock_timestamp()+interval '1 second' "
            "WHERE command_id=%s", (delivery["command_id"],),
        )
        owner.execute("SELECT 1 FROM ifpmic.jobs WHERE job_id=%s FOR UPDATE", (delivery["job_id"],))
        worker = threading.Thread(target=report_after_lock_wait, daemon=True)
        worker.start()
        assert started.wait(timeout=5)
        deadline = time.monotonic() + 5
        waiting = 0
        while time.monotonic() < deadline:
            with psycopg.connect(database.dispatcher_dsn(cluster), autocommit=True) as monitor:
                waiting = monitor.execute(
                    "SELECT count(*) FROM pg_stat_activity WHERE application_name=%s AND wait_event_type='Lock'",
                    ("h2-prebinding-expiry-wait",),
                ).fetchone()[0]
            if waiting == 1:
                break
            time.sleep(0.01)
        assert waiting == 1
        time.sleep(1.1)
        owner.commit()
        worker.join(timeout=5)
        assert not worker.is_alive()
    assert observed["result"] == {"status": "stale", "affected": 0, "code": "CLAIM_STALE"}
    assert _owned_rows(delivery)[1] == (None, None, None)


def test_h2_prebinding_stale_lease_is_noop(prebinding_delivery):
    delivery = prebinding_delivery
    database, cluster = delivery["database"], delivery["cluster"]
    with psycopg.connect(database.owner_dsn(cluster), autocommit=True) as owner:
        owner.execute(
            "UPDATE ifpmic.commands_outbox SET claim_expires_at=clock_timestamp()-interval '1 second' "
            "WHERE command_id=%s", (delivery["command_id"],),
        )
    assert _incident(delivery) == {"status": "stale", "affected": 0, "code": "CLAIM_STALE"}
    outbox, attempt, job, command, bindings = _owned_rows(delivery)
    assert outbox[0] == "leased" and str(outbox[2]) == delivery["claim_token"]
    assert attempt == (None, None, None)
    assert job == ("DRAFT", 0, 0, [], None)
    assert command == ("accepted", None, None)
    assert bindings == 0


def test_h2_prebinding_nonready_workspace_waits_without_mutation(prebinding_delivery):
    delivery = prebinding_delivery
    database, cluster = delivery["database"], delivery["cluster"]
    with psycopg.connect(database.owner_dsn(cluster), autocommit=True) as owner:
        owner.execute("UPDATE ifpmic.workspace_intents SET state='PROVISIONING' WHERE job_id=%s", (delivery["job_id"],))
    before = _owned_rows(delivery)
    assert _incident(delivery) == {"status": "wait", "code": "WORKSPACE_NOT_READY"}
    assert _owned_rows(delivery) == before


def test_h2_prebinding_null_and_arbitrary_codes_fail_closed(prebinding_delivery):
    delivery = prebinding_delivery
    database, cluster = delivery["database"], delivery["cluster"]
    before = _owned_rows(delivery)
    for code in (None, "CLAIM_STALE", "UNRECOGNIZED_INCIDENT"):
        with psycopg.connect(database.dispatcher_dsn(cluster), autocommit=True) as dispatcher:
            with pytest.raises(psycopg.errors.InvalidParameterValue) as invalid:
                dispatcher.execute(
                    "SELECT ifpmic.report_dispatch_incident(%s,%s,%s,%s)",
                    (delivery["command_id"], delivery["generation"], delivery["claim_token"], code),
                )
        assert invalid.value.sqlstate == "22023"
        assert _owned_rows(delivery) == before


def test_h2_prebinding_missing_or_completed_attempt_rolls_back_outbox(prebinding_delivery):
    delivery = prebinding_delivery
    database, cluster = delivery["database"], delivery["cluster"]
    with psycopg.connect(database.owner_dsn(cluster), autocommit=True) as owner:
        owner.execute(
            "DELETE FROM ifpmic.delivery_attempts WHERE command_id=%s AND generation=%s",
            (delivery["command_id"], delivery["generation"]),
        )
    with psycopg.connect(database.dispatcher_dsn(cluster), autocommit=True) as dispatcher:
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as absent:
            dispatcher.execute(
                "SELECT ifpmic.report_dispatch_incident(%s,%s,%s,'WORKSPACE_IDENTITY_CONFLICT')",
                (delivery["command_id"], delivery["generation"], delivery["claim_token"]),
            )
    assert absent.value.sqlstate == "42501"
    assert _owned_rows(delivery)[0][0] == "leased"

    with psycopg.connect(database.owner_dsn(cluster), autocommit=True) as owner:
        owner.execute(
            "INSERT INTO ifpmic.delivery_attempts(command_id,generation,attempted_at,completed_at,result,error_code) "
            "VALUES(%s,%s,clock_timestamp(),clock_timestamp(),'retry','RETRYABLE_FIXTURE')",
            (delivery["command_id"], delivery["generation"]),
        )
    with psycopg.connect(database.dispatcher_dsn(cluster), autocommit=True) as dispatcher:
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as completed:
            dispatcher.execute(
                "SELECT ifpmic.report_dispatch_incident(%s,%s,%s,'WORKSPACE_IDENTITY_CONFLICT')",
                (delivery["command_id"], delivery["generation"], delivery["claim_token"]),
            )
    assert completed.value.sqlstate == "42501"
    assert _owned_rows(delivery)[0][0] == "leased"
    completed_attempt = _owned_rows(delivery)[1]
    assert completed_attempt[0] is not None
    assert completed_attempt[1:] == ("retry", "RETRYABLE_FIXTURE")


def test_h2_prebinding_incident_rereads_binding_after_concurrent_reservation(prebinding_delivery):
    delivery = prebinding_delivery
    database, cluster = delivery["database"], delivery["cluster"]
    started = threading.Event()
    observed = {}

    def report_after_reserve_lock():
        with psycopg.connect(database.dispatcher_dsn(cluster), autocommit=True) as dispatcher:
            dispatcher.execute("SET application_name='h2-prebinding-incident-race'")
            started.set()
            observed["result"] = dispatcher.execute(
                "SELECT ifpmic.report_dispatch_incident(%s,%s,%s,'WORKSPACE_IDENTITY_CONFLICT')",
                (delivery["command_id"], delivery["generation"], delivery["claim_token"]),
            ).fetchone()[0]

    with psycopg.connect(database.dispatcher_dsn(cluster), autocommit=False) as reserver:
        reserved = reserver.execute(
            "SELECT ifpmic.reserve_execution(%s,%s,%s,%s,%s,%s)",
            (delivery["command_id"], delivery["generation"], delivery["claim_token"], BUILD_ID,
             delivery["workspace_token"], delivery["workspace_generation"]),
        ).fetchone()[0]
        assert reserved["status"] == "reserved"
        worker = threading.Thread(target=report_after_reserve_lock, daemon=True)
        worker.start()
        assert started.wait(timeout=5)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            with psycopg.connect(database.dispatcher_dsn(cluster), autocommit=True) as monitor:
                waiting = monitor.execute(
                    "SELECT count(*) FROM pg_stat_activity WHERE application_name=%s AND wait_event_type='Lock'",
                    ("h2-prebinding-incident-race",),
                ).fetchone()[0]
            if waiting == 1:
                break
            time.sleep(0.01)
        assert waiting == 1
        reserver.commit()
        worker.join(timeout=5)
        assert not worker.is_alive()

    assert observed["result"] == {"status": "quarantined", "code": "WORKSPACE_IDENTITY_CONFLICT"}
    with psycopg.connect(database.owner_dsn(cluster)) as owner:
        binding = owner.execute(
            "SELECT state,quarantine_code FROM ifpmic.execution_bindings WHERE job_id=%s",
            (delivery["job_id"],),
        ).fetchone()
    assert binding == ("quarantined", "WORKSPACE_IDENTITY_CONFLICT")


def test_h2_prebinding_foreign_deployment_binding_is_forbidden_without_mutation(prebinding_delivery):
    delivery = prebinding_delivery
    database, cluster = delivery["database"], delivery["cluster"]
    with psycopg.connect(database.owner_dsn(cluster), autocommit=True) as owner:
        owner.execute(
            "INSERT INTO ifpmic.execution_deployments(deployment_id,namespace,server_endpoint,server_config_sha256) "
            "VALUES(%s,'default','127.0.0.1:7234',%s)",
            (FOREIGN_DEPLOYMENT_ID, FOREIGN_SERVER_SHA256),
        )
        owner.execute(
            "INSERT INTO ifpmic.engine_builds(deployment_id,build_id,source_manifest_sha256,"
            "environment_manifest_sha256,workflow_type,task_queue,protocol_version) "
            "VALUES(%s,%s,%s,%s,'IFPMICJobWorkflow',%s,'h2-v1')",
            (FOREIGN_DEPLOYMENT_ID, FOREIGN_BUILD_ID, "d" * 64, "e" * 64,
             f"ifpmic.build.{FOREIGN_BUILD_ID}"),
        )
        owner.execute(
            "INSERT INTO ifpmic.execution_bindings(job_id,project_id,create_command_id,deployment_id,namespace,"
            "server_config_sha256,temporal_workflow_id,workflow_type,build_id,task_queue,snapshot_id,"
            "catalog_record_sha256,workflow_sha256,state_sha256,agent_sha256,workspace_token,"
            "workspace_generation,command_payload_sha256,binding_sha256) "
            "SELECT j.job_id,j.project_id,j.create_command_id,%s,'default',%s,'ifpmic.job.'||j.job_id::text,"
            "'IFPMICJobWorkflow',%s,%s,j.snapshot_id,pc.record_bytes_sha256,%s,%s,%s,w.workspace_token,"
            "w.generation,c.payload_sha256,%s FROM ifpmic.jobs j "
            "JOIN ifpmic.commands c ON c.command_id=j.create_command_id "
            "JOIN ifpmic.profile_catalog pc ON pc.project_id=j.project_id AND pc.snapshot_id=j.snapshot_id "
            "JOIN ifpmic.workspace_intents w ON w.job_id=j.job_id WHERE j.job_id=%s",
            (FOREIGN_DEPLOYMENT_ID, FOREIGN_SERVER_SHA256, FOREIGN_BUILD_ID,
             f"ifpmic.build.{FOREIGN_BUILD_ID}", "1" * 64, "2" * 64, "3" * 64, "b" * 64,
             delivery["job_id"]),
        )
    before = _owned_rows(delivery)
    with psycopg.connect(database.dispatcher_dsn(cluster), autocommit=True) as dispatcher:
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as denied:
            dispatcher.execute(
                "SELECT ifpmic.report_dispatch_incident(%s,%s,%s,'WORKSPACE_IDENTITY_CONFLICT')",
                (delivery["command_id"], delivery["generation"], delivery["claim_token"]),
            )
    assert denied.value.sqlstate == "42501"
    assert _owned_rows(delivery) == before
    assert before[4] == 1
    with psycopg.connect(database.owner_dsn(cluster)) as owner:
        assert owner.execute(
            "SELECT deployment_id,state,quarantine_code FROM ifpmic.execution_bindings WHERE job_id=%s",
            (delivery["job_id"],),
        ).fetchone() == (FOREIGN_DEPLOYMENT_ID, "reserved", None)


def test_h2_prebinding_upgrade_004_failure_rolls_back_function_acl_and_ledger(
    pg_cluster, migration_db, workflow_scram_hba, tmp_path,
):
    source = Path(__file__).resolve().parents[2] / "services/ifpmic_api/migrations"
    pre_004 = tmp_path / "migrations-001-003"
    pre_004.mkdir()
    for version in ("001_initial", "002_auth_retention", "003_workflow_execution"):
        shutil.copyfile(source / f"{version}.sql", pre_004 / f"{version}.sql")
    with psycopg.connect(migration_db.owner_dsn(pg_cluster), autocommit=True) as owner:
        assert apply_migrations(
            owner, runtime_role=migration_db.roles.runtime, operator_role=migration_db.roles.operator,
            dispatcher_role=migration_db.roles.dispatcher, projector_role=migration_db.roles.projector,
            migration_dir=pre_004,
        ) == {"applied": ["001_initial", "002_auth_retention", "003_workflow_execution"], "unchanged": []}
        before_function = owner.execute(
            "SELECT pg_get_functiondef('ifpmic.report_dispatch_incident(uuid,bigint,uuid,text)'::regprocedure), "
            "proacl FROM pg_proc WHERE oid='ifpmic.report_dispatch_incident(uuid,bigint,uuid,text)'::regprocedure",
        ).fetchone()
        before_ledger = owner.execute(
            "SELECT version,source_sha256,runtime_role,operator_role FROM ifpmic.schema_migrations ORDER BY version"
        ).fetchall()

    broken = tmp_path / "migrations-broken-004"
    broken.mkdir()
    for path in pre_004.glob("*.sql"):
        shutil.copyfile(path, broken / path.name)
    migration_004 = source / "004_prebinding_incident.sql"
    shutil.copyfile(migration_004, broken / migration_004.name)
    with (broken / migration_004.name).open("ab") as sql_file:
        sql_file.write(b"\nSELECT 1/0;\n")

    with psycopg.connect(migration_db.owner_dsn(pg_cluster), autocommit=True) as owner:
        with pytest.raises(MigrationError) as failed:
            apply_migrations(
                owner, runtime_role=migration_db.roles.runtime, operator_role=migration_db.roles.operator,
                dispatcher_role=migration_db.roles.dispatcher, projector_role=migration_db.roles.projector,
                migration_dir=broken,
            )
        assert failed.value.code == "MIGRATION_IO"
        after_function = owner.execute(
            "SELECT pg_get_functiondef('ifpmic.report_dispatch_incident(uuid,bigint,uuid,text)'::regprocedure), "
            "proacl FROM pg_proc WHERE oid='ifpmic.report_dispatch_incident(uuid,bigint,uuid,text)'::regprocedure",
        ).fetchone()
        after_ledger = owner.execute(
            "SELECT version,source_sha256,runtime_role,operator_role FROM ifpmic.schema_migrations ORDER BY version"
        ).fetchall()
    assert after_function == before_function
    assert after_ledger == before_ledger

    with psycopg.connect(migration_db.owner_dsn(pg_cluster), autocommit=True) as owner:
        assert apply_migrations(
            owner, runtime_role=migration_db.roles.runtime, operator_role=migration_db.roles.operator,
            dispatcher_role=migration_db.roles.dispatcher, projector_role=migration_db.roles.projector,
            migration_dir=source,
        ) == {
            "applied": ["004_prebinding_incident"],
            "unchanged": ["001_initial", "002_auth_retention", "003_workflow_execution"],
        }
        assert apply_migrations(
            owner, runtime_role=migration_db.roles.runtime, operator_role=migration_db.roles.operator,
            dispatcher_role=migration_db.roles.dispatcher, projector_role=migration_db.roles.projector,
            migration_dir=source,
        ) == {
            "applied": [],
            "unchanged": ["001_initial", "002_auth_retention", "003_workflow_execution", "004_prebinding_incident"],
        }
        assert owner.execute(
            "SELECT has_function_privilege(%s,'ifpmic.report_dispatch_incident(uuid,bigint,uuid,text)','EXECUTE'), "
            "has_function_privilege(%s,'ifpmic.report_dispatch_incident(uuid,bigint,uuid,text)','EXECUTE'), "
            "has_function_privilege(%s,'ifpmic.report_dispatch_incident(uuid,bigint,uuid,text)','EXECUTE'), "
            "has_function_privilege(%s,'ifpmic.report_dispatch_incident(uuid,bigint,uuid,text)','EXECUTE')",
            (migration_db.roles.dispatcher, migration_db.roles.projector,
             migration_db.roles.runtime, migration_db.roles.operator),
        ).fetchone() == (True, False, False, False)
        acl = owner.execute(
            "SELECT coalesce(array_agg(CASE WHEN grantee=0 THEN 'PUBLIC' "
            "ELSE (SELECT rolname FROM pg_roles WHERE oid=grantee) END||':'||privilege_type "
            "ORDER BY grantee,privilege_type),'{}') "
            "FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) "
            "WHERE p.oid='ifpmic.report_dispatch_incident(uuid,bigint,uuid,text)'::regprocedure",
        ).fetchone()[0]
        assert set(acl) == {f"{migration_db.roles.migration}:EXECUTE", f"{migration_db.roles.dispatcher}:EXECUTE"}


def test_h2_prebinding_successful_003_to_004_upgrade_rerun_and_exact_function_acl(
    pg_cluster, migration_db, tmp_path,
):
    source = Path(__file__).resolve().parents[2] / "services/ifpmic_api/migrations"
    pre_004 = tmp_path / "successful-upgrade-001-003"
    pre_004.mkdir()
    for version in ("001_initial", "002_auth_retention", "003_workflow_execution"):
        shutil.copyfile(source / f"{version}.sql", pre_004 / f"{version}.sql")
    with psycopg.connect(migration_db.owner_dsn(pg_cluster), autocommit=True) as owner:
        assert apply_migrations(
            owner, runtime_role=migration_db.roles.runtime, operator_role=migration_db.roles.operator,
            dispatcher_role=migration_db.roles.dispatcher, projector_role=migration_db.roles.projector,
            migration_dir=pre_004,
        ) == {"applied": ["001_initial", "002_auth_retention", "003_workflow_execution"], "unchanged": []}
        before = owner.execute(
            "SELECT pg_get_functiondef('ifpmic.report_dispatch_incident(uuid,bigint,uuid,text)'::regprocedure)"
        ).fetchone()[0]
        assert apply_migrations(
            owner, runtime_role=migration_db.roles.runtime, operator_role=migration_db.roles.operator,
            dispatcher_role=migration_db.roles.dispatcher, projector_role=migration_db.roles.projector,
            migration_dir=source,
        ) == {
            "applied": ["004_prebinding_incident"],
            "unchanged": ["001_initial", "002_auth_retention", "003_workflow_execution"],
        }
        after = owner.execute(
            "SELECT pg_get_functiondef('ifpmic.report_dispatch_incident(uuid,bigint,uuid,text)'::regprocedure)"
        ).fetchone()[0]
        assert after != before
        assert apply_migrations(
            owner, runtime_role=migration_db.roles.runtime, operator_role=migration_db.roles.operator,
            dispatcher_role=migration_db.roles.dispatcher, projector_role=migration_db.roles.projector,
            migration_dir=source,
        ) == {
            "applied": [],
            "unchanged": ["001_initial", "002_auth_retention", "003_workflow_execution", "004_prebinding_incident"],
        }
        assert owner.execute(
            "SELECT has_function_privilege(%s,'ifpmic.report_dispatch_incident(uuid,bigint,uuid,text)','EXECUTE'), "
            "has_function_privilege(%s,'ifpmic.report_dispatch_incident(uuid,bigint,uuid,text)','EXECUTE'), "
            "has_function_privilege(%s,'ifpmic.report_dispatch_incident(uuid,bigint,uuid,text)','EXECUTE'), "
            "has_function_privilege(%s,'ifpmic.report_dispatch_incident(uuid,bigint,uuid,text)','EXECUTE')",
            (migration_db.roles.dispatcher, migration_db.roles.projector,
             migration_db.roles.runtime, migration_db.roles.operator),
        ).fetchone() == (True, False, False, False)
        acl = owner.execute(
            "SELECT coalesce(array_agg(CASE WHEN grantee=0 THEN 'PUBLIC' "
            "ELSE (SELECT rolname FROM pg_roles WHERE oid=grantee) END||':'||privilege_type "
            "ORDER BY grantee,privilege_type),'{}') "
            "FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) "
            "WHERE p.oid='ifpmic.report_dispatch_incident(uuid,bigint,uuid,text)'::regprocedure",
        ).fetchone()[0]
        assert set(acl) == {f"{migration_db.roles.migration}:EXECUTE", f"{migration_db.roles.dispatcher}:EXECUTE"}
