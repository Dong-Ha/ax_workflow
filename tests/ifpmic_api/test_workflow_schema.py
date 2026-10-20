"""H2 PostgreSQL schema/authentication boundary tests.

These tests prove SQL schema and local principal authentication only. They do
not exercise a Temporal server, dispatcher delivery, workflow history, or the
original B03 AT acceptance scenarios.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat
import time
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql

from services.ifpmic_api.migrate import MigrationError, apply_migrations
from tests.ifpmic_api.workflow_schema_fixture import (
    CURRENT_VERSIONS, capture_private_migration_context, seed_legacy_create,
)
from tests.ifpmic_api.jobs_fixture import (
    API_ORIGIN, capture_snapshot, owner_dsn, seed_catalog_and_eligibility,
    seed_profile_store, valid_create_job, write_headers,
)


pytest_plugins = ("tests.ifpmic_api.workflow_schema_fixture", "tests.ifpmic_api.jobs_fixture")

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "services/ifpmic_api/migrations"
PINNED_001 = "cf0437a5f32e1589e4ea821afbb2ef2480d780a276667880aa9a08a0f4c77f12"
PINNED_002 = "95c01f06eb586e0c1067f04672edfed8e0a11215752ad859ac9e4744da5a504e"

H2_TABLES = {
    "execution_role_config",
    "execution_deployments",
    "engine_builds",
    "worker_principals",
    "execution_bindings",
    "worker_run_scopes",
    "delivery_attempts",
    "projection_receipts",
}
DEPLOYMENT_ID = "h2-test-deployment"
NAMESPACE = "default"
SERVER_ENDPOINT = "127.0.0.1:7233"
SERVER_CONFIG_SHA256 = "207da747b02c8a63bba3abd3d9d21131ad0c242523d7a2982650e26698eae822"
SOURCE_MANIFEST_SHA256 = "d" * 64
ENVIRONMENT_MANIFEST_SHA256 = "e" * 64
BUILD_ID = "b2576b14c813fb095fcb81023b66f16f73e1ef59c5ea3e828e3d37f7cc87ede2"
WORKFLOW_SHA256 = "bab40a7abb3929896add1ef2cd074893dd2a7de14d200a5d6cea4b7a77eb0e89"
STATE_SHA256 = "0248e130017043539319c56af854f5388a95d33e7e687902a3438fdff414244a"
AGENT_SHA256 = "ca6d4bea7abf0fffe7354c482af0d521c3a2e367217a69923a4bfe43fa27ab64"


def _record_retained_fence_evidence(case_name: str, evidence: dict[str, object]) -> None:
    """Write actual observations only when the H2 runner supplies its private root."""
    raw_root = os.environ.get("IFPMIC_H2_RUNTIME_EVIDENCE_ROOT")
    if raw_root is None:
        return
    root = Path(raw_root)
    assert root.is_absolute()
    info = root.lstat()
    assert stat.S_ISDIR(info.st_mode) and not root.is_symlink()
    assert info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700
    case_root = root / "retained-fences"
    case_root.mkdir(mode=0o700, exist_ok=True)
    case_info = case_root.lstat()
    assert stat.S_ISDIR(case_info.st_mode) and not case_root.is_symlink()
    assert case_info.st_uid == os.getuid() and stat.S_IMODE(case_info.st_mode) == 0o700
    current = os.environ.get("PYTEST_CURRENT_TEST")
    assert current is not None and current
    node_id = current.split(" (", 1)[0]
    canonical = json.dumps(evidence, ensure_ascii=True, sort_keys=True,
                           separators=(",", ":"), allow_nan=False).encode("ascii")
    document = {
        "kind": "ifpmic.b03.h2.retained-fence-observation.v1",
        "case_id": case_name,
        "pytest_current_test": node_id,
        "observed_monotonic_ns": time.monotonic_ns(),
        "evidence_sha256": hashlib.sha256(canonical).hexdigest(),
        "evidence": evidence,
    }
    payload = json.dumps(document, ensure_ascii=True, sort_keys=True,
                         separators=(",", ":"), allow_nan=False).encode("ascii") + b"\n"
    filename = hashlib.sha256(node_id.encode("utf-8")).hexdigest() + ".json"
    fd = os.open(case_root / filename,
                 os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                 0o600)
    try:
        os.fchmod(fd, 0o600)
        opened = os.fstat(fd)
        assert stat.S_ISREG(opened.st_mode) and opened.st_uid == os.getuid()
        assert opened.st_nlink == 1 and stat.S_IMODE(opened.st_mode) == 0o600
        view = memoryview(payload)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError("short retained-fence evidence write")
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)


def _capture_job_rows(owner, job_id: str) -> dict[str, list[dict[str, object]]]:
    """Read actual final rows for one synthetic job, retaining full JSONB rows."""
    queries = {
        "jobs": ("SELECT to_jsonb(t) FROM ifpmic.jobs t WHERE job_id=%s", (job_id,)),
        "commands": ("SELECT to_jsonb(t) FROM ifpmic.commands t WHERE job_id=%s ORDER BY command_id",
                     (job_id,)),
        "commands_outbox": ("SELECT to_jsonb(t) FROM ifpmic.commands_outbox t WHERE command_id IN "
                            "(SELECT command_id FROM ifpmic.commands WHERE job_id=%s) ORDER BY command_id",
                            (job_id,)),
        "workspace_intents": ("SELECT to_jsonb(t) FROM ifpmic.workspace_intents t WHERE job_id=%s", (job_id,)),
        "execution_bindings": ("SELECT to_jsonb(t) FROM ifpmic.execution_bindings t WHERE job_id=%s", (job_id,)),
        "worker_run_scopes": ("SELECT to_jsonb(t) FROM ifpmic.worker_run_scopes t WHERE job_id=%s", (job_id,)),
        "projection_receipts": ("SELECT to_jsonb(t) FROM ifpmic.projection_receipts t WHERE job_id=%s "
                                "ORDER BY transition_sequence", (job_id,)),
        "delivery_attempts": ("SELECT to_jsonb(t) FROM ifpmic.delivery_attempts t WHERE command_id IN "
                              "(SELECT command_id FROM ifpmic.commands WHERE job_id=%s) ORDER BY generation",
                              (job_id,)),
    }
    return {name: [row[0] for row in owner.execute(query, params).fetchall()]
            for name, (query, params) in queries.items()}


def _record_fence_job_boundary(harness, job_id: str, boundary: str) -> None:
    if os.environ.get("IFPMIC_H2_RUNTIME_EVIDENCE_ROOT") is None:
        return
    from tests.ifpmic_api.h2_snapshot_evidence import record_query_observation

    with psycopg.connect(owner_dsn(harness["database"]), connect_timeout=2,
                         options="-c lock_timeout=1000 -c statement_timeout=2000") as owner:
        rows = _capture_job_rows(owner, job_id)
    record_query_observation("sql.fence.job_rows", job_id,
                             {"boundary": boundary, "rows": rows})


def _capture_role_acl_observations(database, cluster) -> dict[str, object]:
    roles = {
        "runtime": database.roles.runtime,
        "operator": database.roles.operator,
        "dispatcher": database.roles.dispatcher,
        "projector": database.roles.projector,
    }
    with psycopg.connect(database.owner_dsn(cluster)) as owner:
        role_config = owner.execute(
            "SELECT singleton,migration_version,runtime_role_oid::bigint,runtime_role_name,"
            "operator_role_oid::bigint,operator_role_name,dispatcher_role_oid::bigint,"
            "dispatcher_role_name,projector_role_oid::bigint,projector_role_name "
            "FROM ifpmic.execution_role_config"
        ).fetchall()
        role_rows = owner.execute(
            "SELECT rolname,oid::bigint,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolcanlogin,"
            "rolreplication,EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=p.oid OR m.roleid=p.oid) "
            "FROM pg_roles p WHERE rolname=ANY(%s) ORDER BY rolname", (list(roles.values()),),
        ).fetchall()
        functions = []
        for signature, allowed_kinds in WORKER_FUNCTIONS.items():
            metadata = owner.execute(
                "SELECT p.oid::bigint,p.proacl::text,pg_get_userbyid(p.proowner),p.prosecdef,p.proconfig "
                "FROM pg_proc p WHERE p.oid=%s::regprocedure", (signature,),
            ).fetchone()
            role_execute = {
                kind: owner.execute(
                    "SELECT has_function_privilege(%s,%s,'EXECUTE')", (role, signature),
                ).fetchone()[0]
                for kind, role in roles.items()
            }
            public_execute = owner.execute(
                "SELECT coalesce(bool_or(x.grantee=0 AND x.privilege_type='EXECUTE'),false) "
                "FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x "
                "WHERE p.oid=%s::regprocedure", (signature,),
            ).fetchone()[0]
            functions.append({"signature": signature, "expected_allowed_kinds": sorted(allowed_kinds),
                              "metadata": metadata, "role_execute": role_execute,
                              "public_execute": public_execute})
        table_privileges = []
        for table in sorted(H2_TABLES):
            for kind, role in roles.items():
                privileges = owner.execute(
                    "SELECT has_table_privilege(%s,%s,'SELECT'),has_table_privilege(%s,%s,'INSERT'),"
                    "has_table_privilege(%s,%s,'UPDATE'),has_table_privilege(%s,%s,'DELETE')",
                    (role, f"ifpmic.{table}", role, f"ifpmic.{table}", role,
                     f"ifpmic.{table}", role, f"ifpmic.{table}"),
                ).fetchone()
                table_privileges.append({"role_kind": kind, "table": table, "privileges": privileges})
        columns = (
            "project_id", "version_key", "snapshot_id", "record_bytes", "record_bytes_sha256",
            "profile_version_json", "mode", "enabled", "configuration_complete",
        )
        catalog_privileges = []
        for kind, role in roles.items():
            table_update_delete = owner.execute(
                "SELECT has_table_privilege(%s,'ifpmic.profile_catalog','UPDATE'),"
                "has_table_privilege(%s,'ifpmic.profile_catalog','DELETE')", (role, role),
            ).fetchone()
            for column in columns:
                column_update = owner.execute(
                    "SELECT has_column_privilege(%s,'ifpmic.profile_catalog',%s,'UPDATE')",
                    (role, column),
                ).fetchone()[0]
                catalog_privileges.append({"role_kind": kind, "column": column,
                                           "table_update_delete": table_update_delete,
                                           "column_update": column_update})
        job_create_column = {
            privilege: owner.execute(
                "SELECT has_column_privilege(%s,'ifpmic.jobs','create_command_id',%s)",
                (database.roles.runtime, privilege),
            ).fetchone()[0]
            for privilege in ("INSERT", "UPDATE")
        }
        principals = owner.execute(
            "SELECT role_oid::bigint,role_name,kind,deployment_id,build_id,active "
            "FROM ifpmic.worker_principals ORDER BY kind,role_name"
        ).fetchall()
    return {"role_config": role_config, "roles": role_rows, "functions": functions,
            "table_privileges": table_privileges, "catalog_privileges": catalog_privileges,
            "job_create_command_column_privileges": job_create_column,
            "worker_principals": principals}

# This is a literal role matrix from the approved H2 contract, not generated
# from pg_proc or the installed migration.
WORKER_FUNCTIONS = {
    "ifpmic.read_dispatch_config()": {"dispatcher"},
    "ifpmic.read_registered_build(text)": {"projector"},
    "ifpmic.claim_delivery(uuid)": {"dispatcher"},
    "ifpmic.reserve_execution(uuid,bigint,uuid,text,uuid,bigint)": {"dispatcher"},
    "ifpmic.record_start_attempt(uuid,bigint,uuid,bigint)": {"dispatcher"},
    "ifpmic.admit_run(uuid,bigint,uuid,text,text)": {"dispatcher"},
    "ifpmic.record_delivery(uuid,bigint,uuid,text,text,text)": {"dispatcher"},
    "ifpmic.read_activation(uuid,text,text)": {"projector"},
    "ifpmic.project_activation(uuid,text,text,bigint,bigint,uuid,text)": {"projector"},
    "ifpmic.report_dispatch_incident(uuid,bigint,uuid,text)": {"dispatcher"},
    "ifpmic.report_projection_incident(uuid,text,text,text)": {"projector"},
}


def _apply_current(cluster, database):
    with psycopg.connect(database.owner_dsn(cluster), autocommit=True) as owner:
        return apply_migrations(
            owner,
            runtime_role=database.roles.runtime,
            operator_role=database.roles.operator,
            dispatcher_role=database.roles.dispatcher,
            projector_role=database.roles.projector,
        )


def _seed_legacy(connection):
    return seed_legacy_create(
        connection,
        owner_id=str(uuid4()),
        project_id=f"h2-project-{uuid4().hex}",
        snapshot_id="a" * 64,
        command_id=str(uuid4()),
        job_id=str(uuid4()),
    )


def _register_dispatcher_and_projector(owner, database):
    deployment = DEPLOYMENT_ID
    build = BUILD_ID
    canonical_deployment = json.dumps(
        {"protocol_version": "h2-v1", "deployment_id": deployment, "namespace": NAMESPACE,
         "server_endpoint": SERVER_ENDPOINT},
        ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False,
    ).encode("ascii")
    assert hashlib.sha256(b"ifpmic.b03.deployment.v1\0" + canonical_deployment).hexdigest() == SERVER_CONFIG_SHA256
    canonical_build = json.dumps(
        {"protocol_version": "h2-v1", "source_manifest_sha256": SOURCE_MANIFEST_SHA256,
         "environment_manifest_sha256": ENVIRONMENT_MANIFEST_SHA256, "workflow_type": "IFPMICJobWorkflow"},
        ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False,
    ).encode("ascii")
    assert hashlib.sha256(b"ifpmic.b03.build.v1\0" + canonical_build).hexdigest() == BUILD_ID
    owner.execute(
        "INSERT INTO ifpmic.execution_deployments(deployment_id,namespace,server_endpoint,server_config_sha256) "
        "VALUES(%s,%s,%s,%s)",
        (deployment, NAMESPACE, SERVER_ENDPOINT, SERVER_CONFIG_SHA256),
    )
    owner.execute(
        "INSERT INTO ifpmic.engine_builds(deployment_id,build_id,source_manifest_sha256,environment_manifest_sha256,"
        "workflow_type,task_queue,protocol_version) VALUES(%s,%s,%s,%s,'IFPMICJobWorkflow',%s,'h2-v1')",
        (deployment, build, SOURCE_MANIFEST_SHA256, ENVIRONMENT_MANIFEST_SHA256, f"ifpmic.build.{build}"),
    )
    role_oids = dict(owner.execute(
        "SELECT rolname,oid FROM pg_roles WHERE rolname=ANY(%s)",
        ([database.roles.dispatcher, database.roles.projector],),
    ).fetchall())
    owner.execute(
        "INSERT INTO ifpmic.worker_principals(role_oid,role_name,kind,deployment_id,build_id) "
        "VALUES(%s,%s,'dispatcher',%s,NULL),(%s,%s,'projector',%s,%s)",
        (role_oids[database.roles.dispatcher], database.roles.dispatcher, deployment,
         role_oids[database.roles.projector], database.roles.projector, deployment, build),
    )
    return deployment, build


def test_h2_upgrade_backfills_create_origin_and_keeps_extra_commands_separate(
    pg_cluster, migration_db, workflow_scram_hba
):
    with psycopg.connect(migration_db.owner_dsn(pg_cluster), autocommit=True) as owner:
        historical = apply_migrations(
            owner, runtime_role=migration_db.roles.runtime, operator_role=migration_db.roles.operator,
            migration_dir=migration_db.legacy_migration_dir,
        )
        assert historical == {"applied": ["001_initial", "002_auth_retention"], "unchanged": []}
        seeded = _seed_legacy(owner)
        before = owner.execute(
            "SELECT j.job_id,j.owner_id,j.project_id,j.snapshot_id,j.workflow_id,j.status,j.revision,"
            "c.command_id,c.route,c.idempotency_key,c.command_payload_json,c.payload_sha256,"
            "o.state,w.workspace_token,w.state "
            "FROM ifpmic.jobs j JOIN ifpmic.commands c ON c.job_id=j.job_id "
            "JOIN ifpmic.commands_outbox o ON o.command_id=c.command_id "
            "JOIN ifpmic.workspace_intents w ON w.job_id=j.job_id "
            "WHERE j.job_id=%s", (seeded["job_id"],),
        ).fetchone()

    assert hashlib.sha256((MIGRATIONS / "001_initial.sql").read_bytes()).hexdigest() == PINNED_001
    assert hashlib.sha256((MIGRATIONS / "002_auth_retention.sql").read_bytes()).hexdigest() == PINNED_002
    assert _apply_current(pg_cluster, migration_db) == {
        "applied": ["003_workflow_execution", "004_prebinding_incident"],
        "unchanged": ["001_initial", "002_auth_retention"],
    }

    with psycopg.connect(migration_db.owner_dsn(pg_cluster)) as owner:
        after = owner.execute(
            "SELECT j.job_id,j.owner_id,j.project_id,j.snapshot_id,j.workflow_id,j.status,j.revision,"
            "j.create_command_id,j.create_route,c.command_id,c.route,c.idempotency_key,c.command_payload_json,c.payload_sha256,"
            "o.state,w.workspace_token,w.state FROM ifpmic.jobs j "
            "JOIN ifpmic.commands c ON c.command_id=j.create_command_id AND c.job_id=j.job_id "
            "JOIN ifpmic.commands_outbox o ON o.command_id=c.command_id "
            "JOIN ifpmic.workspace_intents w ON w.job_id=j.job_id WHERE j.job_id=%s",
            (seeded["job_id"],),
        ).fetchone()
        normalized_after = (
            str(after[0]), str(after[1]), *after[2:7], str(after[7]), after[8], str(after[9]),
            *after[10:13], after[13], after[14], str(after[15]), after[16],
        )
        expected_after = (
            str(before[0]), str(before[1]), *before[2:7], seeded["command_id"], "POST /api/v1/jobs",
            str(before[7]), before[8], before[9], seeded["payload_text"], seeded["payload_hash"],
            before[12], str(before[13]), before[14],
        )
        assert normalized_after == expected_after
        human_command = str(uuid4())
        owner.execute(
            "INSERT INTO ifpmic.commands(command_id,actor_id,route,idempotency_key,project_id,job_id,"
            "command_payload_json,payload_sha256) VALUES(%s,%s,%s,%s,%s,%s,'{}',%s)",
            (human_command, seeded["owner_id"],
             f"POST /api/v1/jobs/{seeded['job_id']}/human-submissions", "later-human", seeded["project_id"],
             seeded["job_id"], "f" * 64),
        )
        # Product read models must join by jobs.create_command_id, never by an
        # arbitrary command for the job after route multiplicity is widened.
        selected_create = owner.execute(
            "SELECT c.command_id,c.route FROM ifpmic.jobs j JOIN ifpmic.commands c "
            "ON c.command_id=j.create_command_id AND c.job_id=j.job_id WHERE j.job_id=%s",
            (seeded["job_id"],),
        ).fetchone()
        assert (str(selected_create[0]), selected_create[1]) == (
            seeded["command_id"], "POST /api/v1/jobs",
        )
        owner.commit()

        with pytest.raises(psycopg.errors.UniqueViolation):
            owner.execute(
                "INSERT INTO ifpmic.commands(command_id,actor_id,route,idempotency_key,project_id,job_id,"
                "command_payload_json,payload_sha256) VALUES(%s,%s,'POST /api/v1/jobs',%s,%s,%s,'{}',%s)",
                (str(uuid4()), seeded["owner_id"], "duplicate-create", seeded["project_id"],
                 seeded["job_id"], "1" * 64),
            )
        owner.rollback()
        with pytest.raises(psycopg.errors.IntegrityError):
            with owner.transaction():
                owner.execute(
                    "INSERT INTO ifpmic.jobs(job_id,owner_id,project_id,snapshot_id,workflow_id,create_command_id) "
                    "VALUES(%s,%s,%s,%s,'ifpmic-sw-v1',%s)",
                    (str(uuid4()), seeded["owner_id"], seeded["project_id"], seeded["snapshot_id"], human_command),
                )
                owner.execute("SET CONSTRAINTS ALL IMMEDIATE")
        versions = owner.execute(
            "SELECT version FROM ifpmic.schema_migrations ORDER BY version"
        ).fetchall()
    assert versions == [
        ("001_initial",), ("002_auth_retention",),
        ("003_workflow_execution",), ("004_prebinding_incident",),
    ]


def test_h2_missing_create_origin_rolls_back_all_003_objects(pg_cluster, migration_db, workflow_scram_hba):
    with psycopg.connect(migration_db.owner_dsn(pg_cluster), autocommit=True) as owner:
        apply_migrations(owner, runtime_role=migration_db.roles.runtime, operator_role=migration_db.roles.operator,
                         migration_dir=migration_db.legacy_migration_dir)
        valid = _seed_legacy(owner)
        missing = {**valid, "job_id": str(uuid4())}
        owner.execute(
            "INSERT INTO ifpmic.jobs(job_id,owner_id,project_id,snapshot_id,workflow_id) "
            "VALUES(%s,%s,%s,%s,'ifpmic-sw-v1')",
            (missing["job_id"], valid["owner_id"], valid["project_id"], valid["snapshot_id"]),
        )
        prior_rows = owner.execute(
            "SELECT version,source_sha256 FROM ifpmic.schema_migrations ORDER BY version"
        ).fetchall()

    with pytest.raises(MigrationError) as raised:
        _apply_current(pg_cluster, migration_db)
    assert raised.value.code == "MIGRATION_IO"
    capture_private_migration_context(raised.value, "test_h2_missing_create_origin_rolls_back_all_003_objects")
    with psycopg.connect(migration_db.owner_dsn(pg_cluster)) as owner:
        assert owner.execute("SELECT version,source_sha256 FROM ifpmic.schema_migrations ORDER BY version").fetchall() == prior_rows
        assert owner.execute("SELECT to_regclass('ifpmic.execution_role_config')").fetchone() == (None,)
        assert owner.execute("SELECT count(*) FROM ifpmic.jobs WHERE job_id=%s", (valid["job_id"],)).fetchone() == (1,)
        assert owner.execute(
            "SELECT count(*) FROM information_schema.columns WHERE table_schema='ifpmic' "
            "AND table_name='jobs' AND column_name='create_command_id'"
        ).fetchone() == (0,)


def test_h2_ambiguous_create_origin_rolls_back_all_003_objects(pg_cluster, migration_db, workflow_scram_hba):
    with psycopg.connect(migration_db.owner_dsn(pg_cluster), autocommit=True) as owner:
        apply_migrations(owner, runtime_role=migration_db.roles.runtime, operator_role=migration_db.roles.operator,
                         migration_dir=migration_db.legacy_migration_dir)
        seeded = _seed_legacy(owner)
        # Simulate an externally corrupted legacy schema. The original unique
        # constraint normally makes two create origins impossible.
        owner.execute("ALTER TABLE ifpmic.commands DROP CONSTRAINT commands_job_id_key")
        owner.execute(
            "INSERT INTO ifpmic.commands(command_id,actor_id,route,idempotency_key,project_id,job_id,"
            "command_payload_json,payload_sha256) VALUES(%s,%s,'POST /api/v1/jobs',%s,%s,%s,'{}',%s)",
            (str(uuid4()), seeded["owner_id"], "second-create-origin", seeded["project_id"],
             seeded["job_id"], "3" * 64),
        )
        prior_rows = owner.execute(
            "SELECT version,source_sha256 FROM ifpmic.schema_migrations ORDER BY version"
        ).fetchall()

    with pytest.raises(MigrationError) as raised:
        _apply_current(pg_cluster, migration_db)
    assert raised.value.code == "MIGRATION_IO"
    capture_private_migration_context(raised.value, "test_h2_ambiguous_create_origin_rolls_back_all_003_objects")
    with psycopg.connect(migration_db.owner_dsn(pg_cluster)) as owner:
        assert owner.execute("SELECT version,source_sha256 FROM ifpmic.schema_migrations ORDER BY version").fetchall() == prior_rows
        assert owner.execute("SELECT to_regclass('ifpmic.execution_role_config')").fetchone() == (None,)
        assert owner.execute("SELECT count(*) FROM ifpmic.commands WHERE job_id=%s", (seeded["job_id"],)).fetchone() == (2,)


def test_h2_schema_inventory_and_create_route_constraints(workflow_schema_db):
    database, cluster = workflow_schema_db
    with psycopg.connect(database.owner_dsn(cluster)) as owner:
        tables = {
            name for (name,) in owner.execute(
                "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='ifpmic'"
            ).fetchall()
        }
        assert H2_TABLES <= tables
        columns = {
            name for (name,) in owner.execute(
                "SELECT column_name FROM information_schema.columns WHERE table_schema='ifpmic' AND table_name='jobs'"
            ).fetchall()
        }
        assert {"create_command_id", "create_route"} <= columns
        not_null = owner.execute(
            "SELECT is_nullable,column_default FROM information_schema.columns "
            "WHERE table_schema='ifpmic' AND table_name='jobs' AND column_name='create_command_id'"
        ).fetchone()
        assert not_null == ("NO", None)

        constraints = dict(owner.execute(
            "SELECT conname,pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE connamespace='ifpmic'::regnamespace AND conrelid='ifpmic.jobs'::regclass"
        ).fetchall())
        assert "FOREIGN KEY (create_command_id, job_id, create_route)" in constraints["job_create_command"]
        assert "DEFERRABLE INITIALLY DEFERRED" in constraints["job_create_command"]
        assert "UNIQUE (create_command_id, job_id)" in constraints["job_create_pair"]
        route_definition = dict(owner.execute(
            "SELECT conname,pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE connamespace='ifpmic'::regnamespace AND conrelid='ifpmic.commands'::regclass"
        ).fetchall())
        assert "human-submissions" in route_definition["command_route_scope"]
        assert "plan-decision" in route_definition["command_route_scope"]
        indexes = owner.execute(
            "SELECT indexdef FROM pg_indexes WHERE schemaname='ifpmic' AND tablename='commands'"
        ).fetchall()
        assert any("one_create_command" in definition and "WHERE (route = 'POST /api/v1/jobs'::text)" in definition
                   for (definition,) in indexes)


def test_h2_role_registry_and_function_acl_match_static_contract(workflow_schema_db):
    database, cluster = workflow_schema_db
    assert database.migrate_current(cluster) == {"applied": [], "unchanged": CURRENT_VERSIONS}
    with psycopg.connect(database.owner_dsn(cluster)) as owner:
        expected_config = owner.execute(
            "SELECT singleton,migration_version,runtime_role_oid,runtime_role_name,operator_role_oid,operator_role_name,"
            "dispatcher_role_oid,dispatcher_role_name,projector_role_oid,projector_role_name "
            "FROM ifpmic.execution_role_config"
        ).fetchall()
        assert len(expected_config) == 1
        row = expected_config[0]
        assert row[0:2] == (True, "003_workflow_execution")
        assert row[3::2] == (database.roles.runtime, database.roles.operator,
                             database.roles.dispatcher, database.roles.projector)
        assert len(set(row[2::2])) == 4
        current_oids = dict(owner.execute(
            "SELECT rolname,oid FROM pg_roles WHERE rolname=ANY(%s)",
            ([database.roles.runtime,database.roles.operator,database.roles.dispatcher,database.roles.projector],),
        ).fetchall())
        assert row[2::2] == tuple(current_oids[name] for name in row[3::2])

        role_names = {
            "runtime": database.roles.runtime,
            "operator": database.roles.operator,
            "dispatcher": database.roles.dispatcher,
            "projector": database.roles.projector,
        }
        for role in role_names.values():
            assert owner.execute(
                "SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolcanlogin,rolreplication, "
                "EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid OR roleid=pg_roles.oid) "
                "FROM pg_roles WHERE rolname=%s", (role,),
            ).fetchone() == (False, False, False, False, True, False, False)

        for signature, allowed_kinds in WORKER_FUNCTIONS.items():
            for kind, role in role_names.items():
                assert owner.execute(
                    "SELECT has_function_privilege(%s,%s,'EXECUTE')", (role, signature)
                ).fetchone() == (kind in allowed_kinds,)
                assert owner.execute(
                    "SELECT coalesce(bool_or(x.grantee=0 AND x.privilege_type='EXECUTE'),false) "
                    "FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x "
                    "WHERE p.oid=%s::regprocedure", (signature,),
                ).fetchone() == (False,)
            owner_name = owner.execute(
                "SELECT pg_get_userbyid(p.proowner),p.prosecdef,p.proconfig FROM pg_proc p WHERE p.oid=%s::regprocedure",
                (signature,),
            ).fetchone()
            assert owner_name[0] == database.roles.migration
            assert owner_name[1] is True
            assert any(config.replace(" ", "") == "search_path=pg_catalog,ifpmic,pg_temp"
                       for config in (owner_name[2] or []))

        for table in H2_TABLES:
            for role in role_names.values():
                assert owner.execute(
                    "SELECT has_table_privilege(%s,%s,'SELECT'),has_table_privilege(%s,%s,'INSERT'),"
                    "has_table_privilege(%s,%s,'UPDATE'),has_table_privilege(%s,%s,'DELETE')",
                    (role, f"ifpmic.{table}", role, f"ifpmic.{table}", role, f"ifpmic.{table}", role, f"ifpmic.{table}"),
                ).fetchone() == (False, False, False, False)

        # The SQL catalog validator relies on owner-imported, immutable rows.
        # Check all four service roles, including column-level ACLs that a
        # table-only privilege query would not expose.
        catalog_columns = (
            "project_id", "version_key", "snapshot_id", "record_bytes", "record_bytes_sha256",
            "profile_version_json", "mode", "enabled", "configuration_complete",
        )
        for role in role_names.values():
            assert owner.execute(
                "SELECT has_table_privilege(%s,'ifpmic.profile_catalog','UPDATE'),"
                "has_table_privilege(%s,'ifpmic.profile_catalog','DELETE')",
                (role, role),
            ).fetchone() == (False, False)
            for column in catalog_columns:
                assert owner.execute(
                    "SELECT has_column_privilege(%s,'ifpmic.profile_catalog',%s,'UPDATE')",
                    (role, column),
                ).fetchone() == (False,)
        assert owner.execute(
            "SELECT has_column_privilege(%s,'ifpmic.jobs','create_command_id','INSERT')",
            (database.roles.runtime,),
        ).fetchone() == (True,)
        assert owner.execute(
            "SELECT has_column_privilege(%s,'ifpmic.jobs','create_command_id','UPDATE')",
            (database.roles.runtime,),
        ).fetchone() == (False,)

        _register_dispatcher_and_projector(owner, database)
        assert owner.execute("SELECT count(*) FROM ifpmic.worker_principals").fetchone() == (2,)

    role_dsns = {
        database.roles.runtime: database.runtime_dsn(cluster),
        database.roles.operator: database.operator_dsn(cluster),
        database.roles.dispatcher: database.dispatcher_dsn(cluster),
        database.roles.projector: database.projector_dsn(cluster),
    }
    denied = []
    for role, dsn in role_dsns.items():
        with psycopg.connect(dsn, autocommit=True) as service_role:
            with pytest.raises(psycopg.errors.InsufficientPrivilege) as raised:
                service_role.execute("UPDATE ifpmic.profile_catalog SET enabled=enabled WHERE false")
            denied.append({"role": role, "statement": "profile_catalog UPDATE", "sqlstate": raised.value.sqlstate})
            with pytest.raises(psycopg.errors.InsufficientPrivilege) as raised:
                service_role.execute("DELETE FROM ifpmic.profile_catalog WHERE false")
            denied.append({"role": role, "statement": "profile_catalog DELETE", "sqlstate": raised.value.sqlstate})

    with psycopg.connect(database.dispatcher_dsn(cluster), autocommit=True) as dispatcher:
        dispatcher_identity = dispatcher.execute("SELECT session_user,current_user").fetchone()
        assert dispatcher_identity == (
            database.roles.dispatcher, database.roles.dispatcher,
        )
        config = dispatcher.execute("SELECT ifpmic.read_dispatch_config()").fetchone()[0]
        assert config["deployment_id"] == DEPLOYMENT_ID
        assert config["namespace"] == NAMESPACE
        assert config["server_endpoint"] == SERVER_ENDPOINT
        assert config["server_config_sha256"] == SERVER_CONFIG_SHA256
        assert len(config["builds"]) == 1
        assert config["builds"][0]["build_id"] == BUILD_ID
        assert config["builds"][0]["source_manifest_sha256"] == SOURCE_MANIFEST_SHA256
        assert config["builds"][0]["environment_manifest_sha256"] == ENVIRONMENT_MANIFEST_SHA256
        dispatcher.execute("SET application_name='ifpmic_h2_projector'")
        assert dispatcher.execute("SELECT session_user").fetchone() == (database.roles.dispatcher,)
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as raised:
            dispatcher.execute("SELECT ifpmic.read_registered_build(%s)", (BUILD_ID,))
        denied.append({"role": "dispatcher", "statement": "read_registered_build", "sqlstate": raised.value.sqlstate})
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as raised:
            dispatcher.execute(sql.SQL("SET ROLE {}").format(sql.Identifier(database.roles.projector)))
        denied.append({"role": "dispatcher", "statement": "SET ROLE projector", "sqlstate": raised.value.sqlstate})
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as raised:
            dispatcher.execute("UPDATE ifpmic.execution_deployments SET enabled=false")
        denied.append({"role": "dispatcher", "statement": "execution_deployments UPDATE",
                       "sqlstate": raised.value.sqlstate})

    with psycopg.connect(database.projector_dsn(cluster), autocommit=True) as projector:
        registered = projector.execute("SELECT ifpmic.read_registered_build(%s)", (BUILD_ID,)).fetchone()[0]
        assert registered["workflow_type"] == "IFPMICJobWorkflow"
        assert registered["protocol_version"] == "h2-v1"
        assert registered["build_id"] == BUILD_ID
        assert registered["namespace"] == NAMESPACE
        assert registered["server_endpoint"] == SERVER_ENDPOINT
        assert registered["server_config_sha256"] == SERVER_CONFIG_SHA256
        assert registered["source_manifest_sha256"] == SOURCE_MANIFEST_SHA256
        assert registered["environment_manifest_sha256"] == ENVIRONMENT_MANIFEST_SHA256
        projector_identity = projector.execute("SELECT session_user,current_user").fetchone()
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as raised:
            projector.execute("SELECT ifpmic.read_dispatch_config()")
        denied.append({"role": "projector", "statement": "read_dispatch_config", "sqlstate": raised.value.sqlstate})
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as raised:
            projector.execute("SELECT ifpmic.read_registered_build(%s)", ("a" * 64,))
        denied.append({"role": "projector", "statement": "read_registered_build_unknown", "sqlstate": raised.value.sqlstate})
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as raised:
            projector.execute("INSERT INTO ifpmic.projection_receipts(job_id,transition_sequence,command_id,"
                              "admitted_run_id,build_id,proposal_sha256,expected_revision,outcome,result_json) "
                              "VALUES(%s,1,%s,%s,%s,%s,0,'applied','{}')",
                              (str(uuid4()), str(uuid4()), str(uuid4()), "b" * 64, "a" * 64))
        denied.append({"role": "projector", "statement": "projection_receipts INSERT",
                       "sqlstate": raised.value.sqlstate})
    acl_observations = _capture_role_acl_observations(database, cluster)
    _record_retained_fence_evidence("role_registry_and_function_acl", {
        "role_acl_observations": acl_observations,
        "dispatcher_session_identity": dispatcher_identity,
        "dispatcher_read_config": config,
        "projector_session_identity": projector_identity,
        "projector_registered_build": registered,
        "denied_operations": denied,
    })


def test_h2_four_role_oid_recreation_is_drift_and_does_not_rebind(pg_cluster, pg_roles):
    database_name = f"ifpmic_h2_oid_{uuid4().hex[:12]}"
    dispatcher_name = f"ifpmic_h2_oid_dispatcher_{uuid4().hex[:8]}"
    dispatcher_password = uuid4().hex + uuid4().hex
    with psycopg.connect(pg_cluster.dsn(), autocommit=True) as bootstrap:
        bootstrap.execute(
            sql.SQL("CREATE ROLE {} LOGIN PASSWORD {} NOSUPERUSER NOCREATEDB NOCREATEROLE "
                    "NOBYPASSRLS NOINHERIT").format(sql.Identifier(dispatcher_name), sql.Literal(dispatcher_password))
        )
        bootstrap.execute(
            sql.SQL("CREATE DATABASE {} OWNER {}").format(sql.Identifier(database_name), sql.Identifier(pg_roles.migration))
        )

    dsn = pg_cluster.dsn(user=pg_roles.migration, database=database_name)
    try:
        with psycopg.connect(dsn, autocommit=True) as owner:
            first = apply_migrations(
                owner, runtime_role=pg_roles.runtime, operator_role=pg_roles.operator,
                dispatcher_role=dispatcher_name, projector_role=pg_roles.projector,
            )
            assert first == {"applied": CURRENT_VERSIONS, "unchanged": []}
            original_config = owner.execute(
                "SELECT dispatcher_role_oid::bigint,dispatcher_role_name "
                "FROM ifpmic.execution_role_config"
            ).fetchone()
        with psycopg.connect(pg_cluster.dsn(), autocommit=True) as bootstrap:
            with psycopg.connect(dsn, autocommit=True) as owner:
                owner.execute(sql.SQL("REVOKE ALL ON SCHEMA ifpmic FROM {}").format(sql.Identifier(dispatcher_name)))
                owner.execute(sql.SQL("REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ifpmic FROM {}").format(sql.Identifier(dispatcher_name)))
            bootstrap.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(dispatcher_name)))
            bootstrap.execute(
                sql.SQL("CREATE ROLE {} LOGIN PASSWORD {} NOSUPERUSER NOCREATEDB NOCREATEROLE "
                        "NOBYPASSRLS NOINHERIT").format(sql.Identifier(dispatcher_name), sql.Literal(uuid4().hex))
            )
            replacement_oid = bootstrap.execute(
                "SELECT oid::bigint FROM pg_roles WHERE rolname=%s", (dispatcher_name,),
            ).fetchone()[0]
        with psycopg.connect(dsn, autocommit=True) as owner:
            with pytest.raises(MigrationError) as raised:
                apply_migrations(
                    owner, runtime_role=pg_roles.runtime, operator_role=pg_roles.operator,
                    dispatcher_role=dispatcher_name, projector_role=pg_roles.projector,
                )
        assert raised.value.code == "MIGRATION_ROLE_DRIFT"
        with psycopg.connect(dsn) as owner:
            final_config = owner.execute(
                "SELECT singleton,migration_version,dispatcher_role_oid::bigint,dispatcher_role_name "
                "FROM ifpmic.execution_role_config"
            ).fetchall()
            assert len(final_config) == 1
            current_oid = owner.execute(
                "SELECT dispatcher_role_oid FROM ifpmic.execution_role_config"
            ).fetchone()[0]
            current_role_oid = owner.execute(
                "SELECT oid::bigint FROM pg_roles WHERE rolname=%s", (dispatcher_name,),
            ).fetchone()[0]
            principal_rows = owner.execute(
                "SELECT role_oid::bigint,role_name,kind,deployment_id,build_id,active "
                "FROM ifpmic.worker_principals WHERE role_name=%s", (dispatcher_name,),
            ).fetchall()
            replacement_privileges = owner.execute(
                "SELECT has_schema_privilege(%s,'ifpmic','USAGE'),"
                "has_function_privilege(%s,'ifpmic.claim_delivery(uuid)','EXECUTE')",
                (dispatcher_name, dispatcher_name),
            ).fetchone()
            assert current_oid != current_role_oid
        _record_retained_fence_evidence("four_role_oid_recreation", {
            "migration_result": first,
            "original_config": original_config,
            "replacement_role_oid": replacement_oid,
            "migration_error": {"type": type(raised.value).__name__, "code": raised.value.code},
            "final_config": final_config,
            "current_role_oid": current_role_oid,
            "immutable_principal_rows": principal_rows,
            "replacement_role_privileges": replacement_privileges,
        })
    finally:
        with psycopg.connect(pg_cluster.dsn(), autocommit=True) as bootstrap:
            bootstrap.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(database_name)))
            bootstrap.execute(sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(dispatcher_name)))


def test_h2_rejects_worker_membership_and_role_name_drift_atomically(workflow_schema_db):
    database, cluster = workflow_schema_db
    with psycopg.connect(database.owner_dsn(cluster), autocommit=True) as owner:
        before = owner.execute(
            "SELECT singleton,migration_version,runtime_role_oid,runtime_role_name,operator_role_oid,operator_role_name,"
            "dispatcher_role_oid,dispatcher_role_name,projector_role_oid,projector_role_name "
            "FROM ifpmic.execution_role_config"
        ).fetchall()
    with psycopg.connect(cluster.dsn(), autocommit=True) as bootstrap:
        bootstrap.execute(sql.SQL("GRANT {} TO {}").format(
            sql.Identifier(database.roles.alternate_runtime), sql.Identifier(database.roles.dispatcher)
        ))
    with psycopg.connect(database.owner_dsn(cluster), autocommit=True) as owner:
        with pytest.raises(MigrationError) as raised:
            apply_migrations(
                owner, runtime_role=database.roles.runtime, operator_role=database.roles.operator,
                dispatcher_role=database.roles.dispatcher, projector_role=database.roles.projector,
            )
        assert raised.value.code == "MIGRATION_ROLE_INVALID"
    with psycopg.connect(cluster.dsn(), autocommit=True) as bootstrap:
        bootstrap.execute(sql.SQL("REVOKE {} FROM {}").format(
            sql.Identifier(database.roles.alternate_runtime), sql.Identifier(database.roles.dispatcher)
        ))
    with psycopg.connect(database.owner_dsn(cluster), autocommit=True) as owner:
        with pytest.raises(MigrationError) as raised:
            apply_migrations(
                owner, runtime_role=database.roles.runtime, operator_role=database.roles.operator,
                dispatcher_role=database.roles.alternate_runtime, projector_role=database.roles.projector,
            )
        assert raised.value.code == "MIGRATION_ROLE_DRIFT"
        after = owner.execute(
            "SELECT singleton,migration_version,runtime_role_oid,runtime_role_name,operator_role_oid,operator_role_name,"
            "dispatcher_role_oid,dispatcher_role_name,projector_role_oid,projector_role_name "
            "FROM ifpmic.execution_role_config"
        ).fetchall()
    assert after == before


def test_h2_service_roles_use_scram_without_trust_fallthrough(workflow_schema_db):
    database, cluster = workflow_schema_db
    good_dsns = (
        database.runtime_dsn(cluster), database.operator_dsn(cluster),
        database.dispatcher_dsn(cluster), database.projector_dsn(cluster),
    )
    good_session_users = []
    for dsn in good_dsns:
        with psycopg.connect(dsn) as connection:
            session_user = connection.execute("SELECT session_user").fetchone()[0]
            assert session_user
            good_session_users.append(session_user)

    wrong_password_dsns = (
        cluster.dsn(user=database.roles.runtime, database=database.name, password="wrong-private-test-password"),
        cluster.dsn(user=database.roles.dispatcher, database=database.name),
        cluster.dsn(user=database.roles.dispatcher, database=database.name, password=database.roles.projector_password),
    )
    rejected = []
    for index, dsn in enumerate(wrong_password_dsns):
        with pytest.raises(psycopg.OperationalError) as raised:
            psycopg.connect(dsn, connect_timeout=2)
        message = str(raised.value)
        expected_reason = "no password supplied" if index == 1 else "password authentication failed"
        rejected.append({"attempt": index, "exception_type": type(raised.value).__name__,
                         "sqlstate": getattr(raised.value, "sqlstate", None),
                         "message": message, "expected_reason": expected_reason})
        from tests.ifpmic_api.h2_snapshot_evidence import record_query_observation

        record_query_observation("sql.scram.authentication_rejection", database.name, rejected[-1])
        assert expected_reason in message.lower()

    with psycopg.connect(cluster.dsn()) as owner:
        rules = owner.execute(
            "SELECT line_number,user_name,auth_method FROM pg_hba_file_rules "
            "WHERE line_number BETWEEN 1 AND 4 ORDER BY line_number"
        ).fetchall()
    assert rules == [
        (1, [database.roles.runtime], "scram-sha-256"),
        (2, [database.roles.operator], "scram-sha-256"),
        (3, [database.roles.dispatcher], "scram-sha-256"),
        (4, [database.roles.projector], "scram-sha-256"),
    ]
    _record_retained_fence_evidence("service_role_scram_hba", {
        "successful_session_users": good_session_users,
        "rejected_password_attempts": rejected,
        "actual_hba_rules": rules,
    })


def test_h2_real_create_activation_receipt_replay_and_run_fences(workflow_scram_hba, g4_harness):
    """Exercise the SQL protocol from an actual G4 command, not synthetic rows."""
    harness = g4_harness
    before_counts = None
    with psycopg.connect(owner_dsn(harness["database"])) as owner:
        before_counts = owner.execute(
            "SELECT (SELECT count(*) FROM ifpmic.jobs),(SELECT count(*) FROM ifpmic.commands)"
        ).fetchone()
    nul_payload = valid_create_job(harness, request_text="invalid\x00request")
    nul_response = harness["client"].post(
        "/api/v1/jobs", json=nul_payload,
        headers=write_headers(harness, key="h2-activation-reject-nul"),
    )
    assert nul_response.status_code == 422
    nul_error = nul_response.json()
    assert nul_error["code"] == "INVALID_REQUEST" and nul_error["message"] == "INVALID_REQUEST"
    assert set(nul_error) == {"code", "message", "trace_id"}
    assert nul_response.headers.get("cache-control") == "no-store"
    assert nul_response.headers.get("referrer-policy") == "no-referrer"
    with psycopg.connect(owner_dsn(harness["database"])) as owner:
        nul_counts_after = owner.execute(
            "SELECT (SELECT count(*) FROM ifpmic.jobs),(SELECT count(*) FROM ifpmic.commands)"
        ).fetchone()
        assert nul_counts_after == before_counts

    payload = valid_create_job(
        harness,
        title="rev-\ud800-😀",
        request_text='Unicode Ω 😀 quote " slash \\ and preserved line\n',
    )
    # The accepted G4 envelope is ASCII and lossless for lone surrogates. NUL
    # is rejected at ingress, rather than being smuggled through SQL parsing.
    payload_bytes = json.dumps(
        payload, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False,
    ).encode("ascii")
    response = harness["client"].post(
        "/api/v1/jobs",
        content=payload_bytes,
        headers={**write_headers(harness, key="h2-activation-real-command"), "Content-Type": "application/json"},
    )
    assert response.status_code == 202
    accepted = response.json()
    assert accepted["status"] == "accepted"
    command_id = accepted["command_id"]
    job_id = accepted["resource_id"]
    create_envelope = json.dumps(
        {"format": "ifpmic.create-job.v1", "payload": payload},
        ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False,
    ).encode("ascii")
    payload_sha = hashlib.sha256(create_envelope).hexdigest()
    database, cluster = harness["database"]

    with psycopg.connect(owner_dsn(harness["database"])) as owner:
        valid_eligibility = owner.execute(
            "INSERT INTO ifpmic.profile_eligibility(project_id,snapshot_id,mode,evidence_ref,evidence_sha256,"
            "granted_at,expires_at) VALUES(%s,%s,'mock','h2-activation-fixture',%s,"
            "clock_timestamp()-interval '1 day',clock_timestamp()+interval '30 days') RETURNING eligibility_id::text",
            (harness["project_id"], harness["record"].snapshot_id, "9" * 64),
        ).fetchone()[0]
        workspace = owner.execute(
            "UPDATE ifpmic.workspace_intents SET state='READY' WHERE job_id=%s "
            "RETURNING command_id,workspace_token,generation", (job_id,),
        ).fetchone()
        assert workspace is not None
        assert str(workspace[0]) == command_id
        workspace_token, workspace_generation = str(workspace[1]), workspace[2]
        registry = _register_dispatcher_and_projector(owner, database)
        owner.commit()
    deployment_id, build_id = registry

    _record_fence_job_boundary(harness, job_id, "before_claim")
    function_results = {}
    with psycopg.connect(database.dispatcher_dsn(cluster), autocommit=True) as dispatcher:
        claim = dispatcher.execute("SELECT ifpmic.claim_delivery(%s)", (command_id,)).fetchone()[0]
        function_results["claim"] = claim
        assert claim["status"] == "claimed"
        assert str(claim["job_id"]) == job_id
        assert claim["payload_sha256"] == payload_sha
        generation = claim["generation"]
        token = str(claim["claim_token"])

        stale_reserve = dispatcher.execute(
            "SELECT ifpmic.reserve_execution(%s,%s,%s,%s,%s,%s)",
            (command_id, generation, str(uuid4()), build_id, workspace_token, workspace_generation),
        ).fetchone()[0]
        function_results["stale_reserve"] = stale_reserve
        assert stale_reserve == {"status": "stale", "code": "CLAIM_STALE"}

        reserved = dispatcher.execute(
            "SELECT ifpmic.reserve_execution(%s,%s,%s,%s,%s,%s)",
            (command_id, generation, token, build_id, workspace_token, workspace_generation),
        ).fetchone()[0]
        function_results["reserve"] = reserved
        _record_fence_job_boundary(harness, job_id, "after_reserve")
        assert reserved["status"] == "reserved"
        assert reserved["binding"]["state"] == "reserved"
        assert reserved["binding"]["workspace_token"] == workspace_token
        assert reserved["binding"]["workspace_generation"] == workspace_generation
        binding_sha = reserved["binding"]["binding_sha256"]
        # Independently construct all 18 immutable binding fields from the
        # accepted command, fixed registration and original pinned resources.
        binding_document = {
            "job_id": job_id,
            "project_id": harness["project_id"],
            "create_command_id": command_id,
            "deployment_id": DEPLOYMENT_ID,
            "namespace": NAMESPACE,
            "server_config_sha256": SERVER_CONFIG_SHA256,
            "temporal_workflow_id": f"ifpmic.job.{job_id}",
            "workflow_type": "IFPMICJobWorkflow",
            "build_id": BUILD_ID,
            "task_queue": f"ifpmic.build.{BUILD_ID}",
            "snapshot_id": harness["record"].snapshot_id,
            "catalog_record_sha256": harness["record"].record_bytes_sha256,
            "workflow_sha256": WORKFLOW_SHA256,
            "state_sha256": STATE_SHA256,
            "agent_sha256": AGENT_SHA256,
            "workspace_token": workspace_token,
            "workspace_generation": workspace_generation,
            "command_payload_sha256": payload_sha,
        }
        assert len(binding_document) == 18
        binding_bytes = json.dumps(
            binding_document, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False,
        ).encode("ascii")
        expected_binding_sha = hashlib.sha256(
            b"ifpmic.b03.execution-binding.v1\0" + binding_bytes
        ).hexdigest()
        assert binding_sha == expected_binding_sha

        # The initial window is genuinely all-NULL. Partial shapes must fail
        # the named SQL CHECK before the valid service operation populates all
        # three fields atomically.
        with psycopg.connect(owner_dsn(harness["database"])) as owner:
            initial_window = owner.execute(
                "SELECT first_start_attempt_at,uncertain_until,observed_retention_seconds "
                "FROM ifpmic.execution_bindings WHERE job_id=%s", (job_id,),
            ).fetchone()
            function_results["initial_window"] = initial_window
            assert initial_window == (None, None, None)
            partial_windows = (
                ("SET first_start_attempt_at=clock_timestamp()",),
                ("SET first_start_attempt_at=clock_timestamp(),"
                 " uncertain_until=clock_timestamp()+interval '5 minutes'",),
            )
            for (assignment,) in partial_windows:
                with pytest.raises(psycopg.errors.CheckViolation) as violation:
                    with owner.transaction():
                        owner.execute(
                            f"UPDATE ifpmic.execution_bindings {assignment} WHERE job_id=%s", (job_id,),
                        )
                assert violation.value.diag.constraint_name == "binding_start_window_shape"
                restored_window = owner.execute(
                    "SELECT first_start_attempt_at,uncertain_until,observed_retention_seconds "
                    "FROM ifpmic.execution_bindings WHERE job_id=%s", (job_id,),
                ).fetchone()
                function_results.setdefault("partial_window_rejections", []).append({
                    "assignment": assignment, "sqlstate": violation.value.sqlstate,
                    "constraint": violation.value.diag.constraint_name,
                    "restored_window": restored_window,
                })
                assert restored_window == initial_window

        start = dispatcher.execute(
            "SELECT ifpmic.record_start_attempt(%s,%s,%s,3601)", (command_id, generation, token)
        ).fetchone()[0]
        function_results["start_attempt"] = start
        assert start["status"] == "permitted"
        run_id = str(uuid4())
        stale_admission = dispatcher.execute(
            "SELECT ifpmic.admit_run(%s,%s,%s,%s,%s)",
            (command_id, generation + 1, token, run_id, binding_sha),
        ).fetchone()[0]
        function_results["stale_admission"] = stale_admission
        assert stale_admission == {"status": "stale", "code": "CLAIM_STALE"}
        admission = dispatcher.execute(
            "SELECT ifpmic.admit_run(%s,%s,%s,%s,%s)",
            (command_id, generation, token, run_id, binding_sha),
        ).fetchone()[0]
        function_results["admission"] = admission
        _record_fence_job_boundary(harness, job_id, "after_admission")
        assert admission["status"] == "admitted"
        assert admission["binding"]["admitted_run_id"] == run_id

        with psycopg.connect(owner_dsn(harness["database"])) as owner:
            owner.execute("UPDATE ifpmic.workspace_intents SET state='ERROR' WHERE job_id=%s", (job_id,))
            owner.commit()
        with psycopg.connect(database.projector_dsn(cluster), autocommit=True) as projector:
            waiting_workspace = projector.execute(
                "SELECT ifpmic.read_activation(%s,%s,%s)", (job_id, run_id, build_id),
            ).fetchone()[0]
            function_results["workspace_wait"] = waiting_workspace
            assert waiting_workspace == {"status": "wait", "code": "WORKSPACE_NOT_READY"}
        with psycopg.connect(owner_dsn(harness["database"])) as owner:
            owner.execute("UPDATE ifpmic.workspace_intents SET state='READY' WHERE job_id=%s", (job_id,))
            owner.commit()

        stale_ack = dispatcher.execute(
            "SELECT ifpmic.record_delivery(%s,%s,%s,'started',%s,NULL)",
            (command_id, generation + 1, token, run_id),
        ).fetchone()[0]
        function_results["stale_ack"] = stale_ack
        assert stale_ack == {"status": "stale", "affected": 0, "code": "CLAIM_STALE"}
        # Dispatcher is intentionally not granted table SELECT. Observe the
        # lease through an independent owner connection instead.
        with psycopg.connect(owner_dsn(harness["database"])) as owner:
            outbox = owner.execute(
                "SELECT state,generation,claim_token FROM ifpmic.commands_outbox WHERE command_id=%s",
                (command_id,),
            ).fetchone()
        assert outbox[:2] == ("leased", generation)
        assert str(outbox[2]) == token
        ack = dispatcher.execute(
            "SELECT ifpmic.record_delivery(%s,%s,%s,'started',%s,NULL)",
            (command_id, generation, token, run_id),
        ).fetchone()[0]
        function_results["ack"] = ack
        assert ack == {"status": "dispatched", "affected": 1}

    with psycopg.connect(database.projector_dsn(cluster), autocommit=True) as projector:
        activation = projector.execute(
            "SELECT ifpmic.read_activation(%s,%s,%s)", (job_id, run_id, build_id),
        ).fetchone()[0]
        function_results["activation_ready"] = activation
        assert activation == {
            "status": "ready", "job_id": job_id, "binding_sha256": binding_sha,
            "command_id": command_id, "command_payload_sha256": payload_sha,
            "revision": 0, "workspace_token": workspace_token, "workspace_generation": workspace_generation,
        }
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as wrong_run:
            projector.execute("SELECT ifpmic.read_activation(%s,%s,%s)", (job_id, str(uuid4()), build_id))
        function_results["wrong_run_denial"] = {"sqlstate": wrong_run.value.sqlstate}
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as direct_table:
            projector.execute("SELECT payload_sha256 FROM ifpmic.commands WHERE command_id=%s", (command_id,))
        function_results["direct_command_table_denial"] = {"sqlstate": direct_table.value.sqlstate}

    # The proposal oracle is independently assembled from the approved fixed
    # H2 DTO fields and canonical JSON rule.
    proposal = {
        "protocol_version": "h2-v1", "kind": "activate_create", "job_id": job_id, "run_id": run_id,
        "build_id": build_id, "binding_sha256": binding_sha, "transition_sequence": 1,
        "expected_revision": 0, "command_id": command_id, "command_payload_sha256": payload_sha,
    }
    proposal_bytes = json.dumps(proposal, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("ascii")
    proposal_hash = hashlib.sha256(b"ifpmic.b03.transition.v1\0" + proposal_bytes).hexdigest()
    _record_fence_job_boundary(harness, job_id, "before_first_projection")
    with psycopg.connect(database.projector_dsn(cluster), autocommit=True) as projector:
        applied = projector.execute(
            "SELECT ifpmic.project_activation(%s,%s,%s,1,0,%s,%s)",
            (job_id, run_id, build_id, command_id, proposal_hash),
        ).fetchone()[0]
        function_results["project_activation"] = applied
        assert applied == {
            "status": "applied", "command_id": command_id, "applied_revision": 1, "error_code": None,
            "job_id": job_id, "job_status": "QUEUED", "revision": 1,
        }
    _record_fence_job_boundary(harness, job_id, "after_first_projection")

    # A later human-route command has no profile_version and must not replace
    # the immutable create-command source used by the job read DTO.
    future_command_id = str(uuid4())
    with psycopg.connect(owner_dsn(harness["database"])) as owner:
        owner.execute(
            "INSERT INTO ifpmic.commands(command_id,actor_id,route,idempotency_key,project_id,job_id,"
            "command_payload_json,payload_sha256) VALUES(%s,%s,%s,%s,%s,%s,'{}',%s)",
            (future_command_id, harness["user_id"],
             f"POST /api/v1/jobs/{job_id}/human-submissions", "h2-future-human-without-profile",
             harness["project_id"], job_id, "7" * 64),
        )
        owner.commit()

    listing = harness["client"].get("/api/v1/jobs")
    assert listing.status_code == 200
    listed = listing.json()
    assert set(listed) == {"items", "next_cursor"}
    matching = [item for item in listed["items"] if item["job_id"] == job_id]
    assert len(matching) == 1
    expected_job = {
        "job_id": job_id, "owner_id": harness["user_id"], "status": "QUEUED", "revision": 1,
        "cycle": 0, "workflow_version": "ifpmic-sw-v1", "current_step_ids": [],
        "candidate_fingerprint": None, "profile_version": harness["profile_version"],
    }
    assert matching[0] == expected_job
    detail = harness["client"].get(f"/api/v1/jobs/{job_id}")
    assert detail.status_code == 200
    assert detail.json() == {"job": expected_job, "steps": [], "last_event_id": ""}
    command_detail = harness["client"].get(f"/api/v1/commands/{command_id}")
    assert command_detail.status_code == 200
    assert command_detail.json() == {
        "command_id": command_id, "status": "applied", "applied_revision": 1, "error": None,
    }
    replay_response = harness["client"].post(
        "/api/v1/jobs", content=payload_bytes,
        headers={**write_headers(harness, key="h2-activation-real-command"), "Content-Type": "application/json"},
    )
    assert replay_response.status_code == 202
    assert replay_response.json() == accepted
    function_results["api_replay"] = {"status_code": replay_response.status_code,
                                       "json": replay_response.json()}

    # Exercise a separate accepted job whose verified workspace identity
    # changes after reserve/admission but before its first projection. The
    # changed READY generation must quarantine without consuming the command.
    conflict_payload = valid_create_job(harness, request_text="workspace identity changed after reserve")
    conflict_response = harness["client"].post(
        "/api/v1/jobs", json=conflict_payload,
        headers=write_headers(harness, key="h2-workspace-generation-conflict"),
    )
    assert conflict_response.status_code == 202
    conflict_receipt = conflict_response.json()
    conflict_command = conflict_receipt["command_id"]
    conflict_job = conflict_receipt["resource_id"]
    conflict_envelope = json.dumps(
        {"format": "ifpmic.create-job.v1", "payload": conflict_payload},
        ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False,
    ).encode("ascii")
    conflict_payload_sha = hashlib.sha256(conflict_envelope).hexdigest()
    with psycopg.connect(owner_dsn(harness["database"])) as owner:
        workspace = owner.execute(
            "UPDATE ifpmic.workspace_intents SET state='READY' WHERE job_id=%s "
            "RETURNING workspace_token,generation", (conflict_job,),
        ).fetchone()
        conflict_workspace_token, conflict_workspace_generation = str(workspace[0]), workspace[1]
        owner.commit()
    with psycopg.connect(database.dispatcher_dsn(cluster), autocommit=True) as dispatcher:
        conflict_claim = dispatcher.execute(
            "SELECT ifpmic.claim_delivery(%s)", (conflict_command,),
        ).fetchone()[0]
        function_results["conflict_claim"] = conflict_claim
        assert conflict_claim["status"] == "claimed"
        conflict_generation = conflict_claim["generation"]
        conflict_claim_token = str(conflict_claim["claim_token"])
        conflict_reserved = dispatcher.execute(
            "SELECT ifpmic.reserve_execution(%s,%s,%s,%s,%s,%s)",
            (conflict_command, conflict_generation, conflict_claim_token, build_id,
             conflict_workspace_token, conflict_workspace_generation),
        ).fetchone()[0]
        function_results["conflict_reserve"] = conflict_reserved
        assert conflict_reserved["status"] == "reserved"
        conflict_binding_sha = conflict_reserved["binding"]["binding_sha256"]
        conflict_start = dispatcher.execute(
            "SELECT ifpmic.record_start_attempt(%s,%s,%s,3601)",
            (conflict_command, conflict_generation, conflict_claim_token),
        ).fetchone()[0]
        function_results["conflict_start_attempt"] = conflict_start
        assert conflict_start["status"] == "permitted"
        conflict_run_id = str(uuid4())
        conflict_admission = dispatcher.execute(
            "SELECT ifpmic.admit_run(%s,%s,%s,%s,%s)",
            (conflict_command, conflict_generation, conflict_claim_token, conflict_run_id, conflict_binding_sha),
        ).fetchone()[0]
        function_results["conflict_admission"] = conflict_admission
        assert conflict_admission["status"] == "admitted"
        conflict_ack = dispatcher.execute(
            "SELECT ifpmic.record_delivery(%s,%s,%s,'started',%s,NULL)",
            (conflict_command, conflict_generation, conflict_claim_token, conflict_run_id),
        ).fetchone()[0]
        function_results["conflict_ack"] = conflict_ack
        assert conflict_ack == {"status": "dispatched", "affected": 1}
    with psycopg.connect(owner_dsn(harness["database"])) as owner:
        owner.execute(
            "UPDATE ifpmic.workspace_intents SET generation=generation+1,state='READY' WHERE job_id=%s",
            (conflict_job,),
        )
        owner.commit()
    conflict_proposal = {
        "protocol_version": "h2-v1", "kind": "activate_create", "job_id": conflict_job,
        "run_id": conflict_run_id, "build_id": build_id, "binding_sha256": conflict_binding_sha,
        "transition_sequence": 1, "expected_revision": 0, "command_id": conflict_command,
        "command_payload_sha256": conflict_payload_sha,
    }
    conflict_proposal_bytes = json.dumps(
        conflict_proposal, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False,
    ).encode("ascii")
    conflict_proposal_sha = hashlib.sha256(
        b"ifpmic.b03.transition.v1\0" + conflict_proposal_bytes
    ).hexdigest()
    with psycopg.connect(database.projector_dsn(cluster), autocommit=True) as projector:
        conflict_projection = projector.execute(
            "SELECT ifpmic.project_activation(%s,%s,%s,1,0,%s,%s)",
            (conflict_job, conflict_run_id, build_id, conflict_command, conflict_proposal_sha),
        ).fetchone()[0]
    function_results["conflict_projection"] = conflict_projection
    assert conflict_projection == {"status": "quarantined", "code": "WORKSPACE_IDENTITY_CONFLICT"}
    with psycopg.connect(owner_dsn(harness["database"])) as owner:
        conflict_state = owner.execute(
            "SELECT j.status,j.revision,c.status,b.state,b.quarantine_code,"
            "(SELECT count(*) FROM ifpmic.projection_receipts r WHERE r.job_id=j.job_id) "
            "FROM ifpmic.jobs j JOIN ifpmic.commands c ON c.command_id=j.create_command_id "
            "JOIN ifpmic.execution_bindings b ON b.job_id=j.job_id WHERE j.job_id=%s", (conflict_job,),
        ).fetchone()
        assert conflict_state == (
            "DRAFT", 0, "accepted", "quarantined", "WORKSPACE_IDENTITY_CONFLICT", 0,
        )

    _record_fence_job_boundary(harness, job_id, "before_authority_revocation")
    with psycopg.connect(owner_dsn(harness["database"])) as owner:
        # The first job's immutable applied receipt is replayed even after its
        # workspace generation changes and mutable human authority is revoked.
        owner.execute(
            "UPDATE ifpmic.workspace_intents SET generation=generation+1,state='READY' WHERE job_id=%s",
            (job_id,),
        )
        owner.execute("UPDATE ifpmic.memberships SET active=false WHERE user_id=%s AND project_id=%s",
                      (harness["user_id"], harness["project_id"]))
        owner.execute(
            "INSERT INTO ifpmic.profile_revocations(project_id,eligibility_id,revoked_at) "
            "SELECT project_id,eligibility_id,clock_timestamp() FROM ifpmic.profile_eligibility "
            "WHERE project_id=%s AND snapshot_id=%s ON CONFLICT DO NOTHING",
            (harness["project_id"], harness["record"].snapshot_id),
        )
        owner.commit()
    _record_fence_job_boundary(harness, job_id, "after_authority_revocation_before_replay")
    with psycopg.connect(database.projector_dsn(cluster), autocommit=True) as projector:
        replay = projector.execute(
            "SELECT ifpmic.project_activation(%s,%s,%s,1,0,%s,%s)",
            (job_id, run_id, build_id, command_id, proposal_hash),
        ).fetchone()[0]
    function_results["replay_after_revocation"] = replay
    assert replay == applied
    _record_fence_job_boundary(harness, job_id, "after_receipt_replay")
    revoked_api_responses = []
    for response in (
        harness["client"].get(f"/api/v1/jobs/{job_id}"),
        harness["client"].get(f"/api/v1/commands/{command_id}"),
        harness["client"].post(
            "/api/v1/jobs", content=payload_bytes,
            headers={**write_headers(harness, key="h2-activation-real-command"), "Content-Type": "application/json"},
        ),
    ):
        assert response.status_code == 403
        assert response.json()["code"] == "FORBIDDEN"
        revoked_api_responses.append({"status_code": response.status_code, "body": response.json()})

    for invalid_status, invalid_revision, invalid_error in (
        ("applied", None, None),
        ("rejected", None, None),
    ):
        with psycopg.connect(owner_dsn(harness["database"])) as owner:
            malformed_command_id = str(uuid4())
            owner.execute(
                "INSERT INTO ifpmic.commands(command_id,actor_id,route,idempotency_key,project_id,job_id,"
                "command_payload_json,payload_sha256) VALUES(%s,%s,%s,%s,%s,%s,'{}',%s)",
                (malformed_command_id, harness["user_id"],
                 f"POST /api/v1/jobs/{job_id}/human-submissions", f"h2-malformed-{uuid4().hex}",
                 harness["project_id"], job_id, "8" * 64),
            )
            malformed_before = owner.execute(
                "SELECT status,applied_revision,error_code FROM ifpmic.commands WHERE command_id=%s",
                (malformed_command_id,),
            ).fetchone()
            assert malformed_before == ("accepted", None, None)
            with pytest.raises(psycopg.errors.CheckViolation) as violation:
                with owner.transaction():
                    owner.execute(
                        "UPDATE ifpmic.commands SET status=%s,applied_revision=%s,error_code=%s WHERE command_id=%s",
                        (invalid_status, invalid_revision, invalid_error, malformed_command_id),
                    )
            assert violation.value.diag.constraint_name == "command_outcome_shape"
            function_results.setdefault("command_outcome_rejections", []).append({
                "command_id": malformed_command_id, "before": malformed_before,
                "requested": [invalid_status, invalid_revision, invalid_error],
                "sqlstate": violation.value.sqlstate,
                "constraint": violation.value.diag.constraint_name,
            })

    with psycopg.connect(owner_dsn(harness["database"])) as owner:
        primary_rows = _capture_job_rows(owner, job_id)
        conflict_rows = _capture_job_rows(owner, conflict_job)
    _record_retained_fence_evidence("real_create_activation_receipt_replay_and_run_fences", {
        "nul_rejection": {"status_code": nul_response.status_code, "body": nul_error,
                          "counts_before": before_counts, "counts_after": nul_counts_after},
        "accepted_create": accepted,
        "payload_sha256": payload_sha,
        "function_results": function_results,
        "workspace_identity": {"token": workspace_token, "generation": workspace_generation},
        "binding_sha256": binding_sha,
        "proposal_sha256": proposal_hash,
        "api_listing": {"status_code": listing.status_code, "matching_job": matching[0]},
        "api_detail": detail.json(),
        "api_command": command_detail.json(),
        "revoked_api_responses": revoked_api_responses,
        "conflict": {"accepted": conflict_receipt, "payload_sha256": conflict_payload_sha,
                     "binding_sha256": conflict_binding_sha, "proposal_sha256": conflict_proposal_sha,
                     "state": conflict_state},
        "primary_final_rows": primary_rows,
        "conflict_final_rows": conflict_rows,
    })


def test_h2_lone_surrogate_profile_version_survives_real_create_and_activation(
    workflow_scram_hba, g4_harness,
):
    """Preserve B01's lone-surrogate profile label through real G4 and H2 SQL."""
    harness = g4_harness
    profile_version = "\ud800"
    seed_profile_store(
        harness["store_root"], project_id=harness["project_id"], profile_version=profile_version,
    )
    record = capture_snapshot(
        harness["store_root"], project_id=harness["project_id"], profile_version=profile_version,
    )
    assert record.profile_version == profile_version
    assert record.profile_version_json == '"\\ud800"'
    assert record.profile_version_json.isascii()
    assert b"\\ud800" in record.record_bytes
    assert record.project_id == harness["project_id"]
    _imported, eligibility_id = seed_catalog_and_eligibility(harness["database"], record)
    assert eligibility_id
    # G4 authorization uses its frozen 2030 clock. SQL activation uses the
    # actual PostgreSQL clock, so add a separately valid SQL-side grant rather
    # than relying on the future-dated HTTP fixture grant.
    with psycopg.connect(owner_dsn(harness["database"])) as owner:
        sql_eligibility_id = owner.execute(
            "INSERT INTO ifpmic.profile_eligibility(project_id,snapshot_id,mode,evidence_ref,evidence_sha256,"
            "granted_at,expires_at) VALUES(%s,%s,'mock','h2-surrogate-sql-activation',%s,"
            "clock_timestamp()-interval '1 day',clock_timestamp()+interval '30 days') RETURNING eligibility_id::text",
            (harness["project_id"], record.snapshot_id, "9" * 64),
        ).fetchone()[0]
    assert sql_eligibility_id

    payload = valid_create_job(harness, profile_version=profile_version)
    payload_bytes = json.dumps(
        payload, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False,
    ).encode("ascii")
    accepted_response = harness["client"].post(
        "/api/v1/jobs", content=payload_bytes,
        headers={
            **write_headers(harness, key="h2-lone-surrogate-profile-version"),
            "Content-Type": "application/json",
        },
    )
    assert accepted_response.status_code == 202
    accepted = accepted_response.json()
    assert accepted["status"] == "accepted"
    command_id, job_id = accepted["command_id"], accepted["resource_id"]
    envelope = json.dumps(
        {"format": "ifpmic.create-job.v1", "payload": payload},
        ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False,
    ).encode("ascii")
    payload_sha = hashlib.sha256(envelope).hexdigest()

    database, cluster = harness["database"]
    with psycopg.connect(owner_dsn(harness["database"])) as owner:
        workspace = owner.execute(
            "UPDATE ifpmic.workspace_intents SET state='READY' WHERE job_id=%s "
            "RETURNING command_id,workspace_token,generation", (job_id,),
        ).fetchone()
        assert workspace is not None
        assert str(workspace[0]) == command_id
        workspace_token, workspace_generation = str(workspace[1]), workspace[2]
        _register_dispatcher_and_projector(owner, database)
        owner.commit()

    with psycopg.connect(database.dispatcher_dsn(cluster), autocommit=True) as dispatcher:
        claim = dispatcher.execute(
            "SELECT ifpmic.claim_delivery(%s)", (command_id,),
        ).fetchone()[0]
        assert claim["status"] == "claimed"
        generation, token = claim["generation"], str(claim["claim_token"])
        reserved = dispatcher.execute(
            "SELECT ifpmic.reserve_execution(%s,%s,%s,%s,%s,%s)",
            (command_id, generation, token, BUILD_ID, workspace_token, workspace_generation),
        ).fetchone()[0]
        assert reserved["status"] == "reserved"
        binding_sha = reserved["binding"]["binding_sha256"]
        start = dispatcher.execute(
            "SELECT ifpmic.record_start_attempt(%s,%s,%s,3601)",
            (command_id, generation, token),
        ).fetchone()[0]
        assert start["status"] == "permitted"
        run_id = str(uuid4())
        admission = dispatcher.execute(
            "SELECT ifpmic.admit_run(%s,%s,%s,%s,%s)",
            (command_id, generation, token, run_id, binding_sha),
        ).fetchone()[0]
        assert admission["status"] == "admitted"
        delivery = dispatcher.execute(
            "SELECT ifpmic.record_delivery(%s,%s,%s,'started',%s,NULL)",
            (command_id, generation, token, run_id),
        ).fetchone()[0]
        assert delivery == {"status": "dispatched", "affected": 1}

    with psycopg.connect(database.projector_dsn(cluster), autocommit=True) as projector:
        activation = projector.execute(
            "SELECT ifpmic.read_activation(%s,%s,%s)", (job_id, run_id, BUILD_ID),
        ).fetchone()[0]
        assert activation["status"] == "ready"
        assert activation["command_payload_sha256"] == payload_sha
        assert activation["job_id"] == job_id
        assert activation["workspace_token"] == workspace_token
        assert activation["workspace_generation"] == workspace_generation
        proposal = {
            "protocol_version": "h2-v1", "kind": "activate_create", "job_id": job_id,
            "run_id": run_id, "build_id": BUILD_ID, "binding_sha256": binding_sha,
            "transition_sequence": 1, "expected_revision": 0, "command_id": command_id,
            "command_payload_sha256": payload_sha,
        }
        proposal_bytes = json.dumps(
            proposal, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False,
        ).encode("ascii")
        proposal_sha = hashlib.sha256(b"ifpmic.b03.transition.v1\0" + proposal_bytes).hexdigest()
        projected = projector.execute(
            "SELECT ifpmic.project_activation(%s,%s,%s,1,0,%s,%s)",
            (job_id, run_id, BUILD_ID, command_id, proposal_sha),
        ).fetchone()[0]
    assert projected == {
        "status": "applied", "command_id": command_id, "applied_revision": 1,
        "error_code": None, "job_id": job_id, "job_status": "QUEUED", "revision": 1,
    }

    with psycopg.connect(owner_dsn(harness["database"])) as owner:
        state = owner.execute(
            "SELECT j.status,j.revision,c.status,c.applied_revision,o.state,b.admitted_run_id,"
            "(SELECT count(*) FROM ifpmic.projection_receipts WHERE job_id=j.job_id) "
            "FROM ifpmic.jobs j JOIN ifpmic.commands c ON c.command_id=j.create_command_id "
            "JOIN ifpmic.commands_outbox o ON o.command_id=c.command_id "
            "JOIN ifpmic.execution_bindings b ON b.job_id=j.job_id WHERE j.job_id=%s", (job_id,),
        ).fetchone()
        assert tuple(map(lambda value: str(value) if hasattr(value, "hex") else value, state)) == (
            "QUEUED", 1, "applied", 1, "dispatched", run_id, 1,
        )
