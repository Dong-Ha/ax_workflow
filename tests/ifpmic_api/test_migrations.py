"""G1 PostgreSQL migration, role and schema-contract acceptance tests.

Expected table/privilege/constraint behavior is stated literally here; tests do
not introspect migration SQL to construct their oracles.
"""

from __future__ import annotations

import hashlib
import shutil
import json
import os
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql

from services.ifpmic_api.migrate import MigrationError, apply_migrations


MIGRATION_VERSION = "001_initial"
MIGRATION_FILE = Path(__file__).resolve().parents[2] / "services/ifpmic_api/migrations/001_initial.sql"
PINNED_MIGRATION_SHA256 = "cf0437a5f32e1589e4ea821afbb2ef2480d780a276667880aa9a08a0f4c77f12"
RETENTION_MIGRATION_VERSION = "002_auth_retention"
RETENTION_MIGRATION_FILE = Path(__file__).resolve().parents[2] / "services/ifpmic_api/migrations/002_auth_retention.sql"
PINNED_RETENTION_MIGRATION_SHA256 = "95c01f06eb586e0c1067f04672edfed8e0a11215752ad859ac9e4744da5a504e"
MIGRATION_VERSIONS = [MIGRATION_VERSION, RETENTION_MIGRATION_VERSION]
CURRENT_MIGRATION_VERSIONS = [MIGRATION_VERSION, RETENTION_MIGRATION_VERSION, "003_workflow_execution"]
AUTH_RETENTION_DELETE_TABLES = {"oidc_login_transactions", "user_sessions"}

REQUIRED_TABLES = {
    "users",
    "projects",
    "authorization_guards",
    "memberships",
    "profile_catalog",
    "profile_eligibility",
    "profile_revocations",
    "jobs",
    "job_delegations",
    "artifacts",
    "commands",
    "commands_outbox",
    "workspace_intents",
    "oidc_login_transactions",
    "user_sessions",
}

RUNTIME_INSERT_COLUMNS = {
    "users": {"user_id", "identity_subject", "display_name"},
    "jobs": {"job_id", "owner_id", "project_id", "snapshot_id", "workflow_id"},
    "commands": {
        "command_id", "actor_id", "route", "idempotency_key", "project_id", "job_id",
        "command_payload_json", "payload_sha256",
    },
    "commands_outbox": {"command_id"},
    "workspace_intents": {"job_id", "command_id"},
    "oidc_login_transactions": {"state_hash", "browser_hash", "nonce", "pkce_verifier", "expires_at"},
    "user_sessions": {"token_hash", "user_id", "created_at", "expires_at", "last_seen_at"},
}
OPERATOR_INSERT_TABLES = {
    "projects", "authorization_guards", "memberships", "profile_catalog",
    "profile_eligibility", "profile_revocations", "job_delegations", "artifacts",
}
OPERATOR_SELECT_TABLES = {
    "users", "projects", "authorization_guards", "memberships", "profile_catalog",
    "profile_eligibility", "profile_revocations", "jobs", "job_delegations",
    "artifacts", "workspace_intents",
}
RUNTIME_UPDATE_COLUMNS = {
    "users": {"display_name"},
    "user_sessions": {"last_seen_at", "revoked_at"},
    "oidc_login_transactions": {"consumed_at"},
    "memberships": {"lock_version"},
    "authorization_guards": {"lock_version"},
    "workspace_intents": {"state", "generation", "claim_token", "claim_expires_at", "error_code"},
}
OPERATOR_UPDATE_COLUMNS = {
    "memberships": {"active", "capabilities"},
    "job_delegations": {"expires_at", "revoked_at"},
    "authorization_guards": {"lock_version"},
}


def _migrate_with_cluster(pg_cluster, database, *, runtime_role=None, operator_role=None, migration_dir=None):
    with psycopg.connect(database.owner_dsn(pg_cluster), autocommit=True) as connection:
        return apply_migrations(
            connection,
            runtime_role=runtime_role or database.roles.runtime,
            operator_role=operator_role or database.roles.operator,
            migration_dir=migration_dir or database.legacy_migration_dir,
        )


def _expect_migration_error(call, code):
    with pytest.raises(MigrationError) as raised:
        call()
    assert raised.value.code == code
    assert str(raised.value) == code


def test_fresh_migration_and_idempotent_rerun(pg_cluster, migration_db):
    assert hashlib.sha256(MIGRATION_FILE.read_bytes()).hexdigest() == PINNED_MIGRATION_SHA256
    assert hashlib.sha256(RETENTION_MIGRATION_FILE.read_bytes()).hexdigest() == PINNED_RETENTION_MIGRATION_SHA256

    first = _migrate_with_cluster(pg_cluster, migration_db)
    assert first == {"applied": MIGRATION_VERSIONS, "unchanged": []}

    second = _migrate_with_cluster(pg_cluster, migration_db)
    assert second == {"applied": [], "unchanged": MIGRATION_VERSIONS}

    with psycopg.connect(migration_db.owner_dsn(pg_cluster)) as connection:
        schema_owner = connection.execute(
            "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='ifpmic'"
        ).fetchone()[0]
        rows = connection.execute(
            "SELECT version,source_sha256,runtime_role,operator_role FROM ifpmic.schema_migrations ORDER BY version"
        ).fetchall()
        tables = {
            name
            for (name,) in connection.execute(
                "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='ifpmic'"
            ).fetchall()
        }
        expiry_indexes = connection.execute(
            "SELECT tablename,indexdef FROM pg_catalog.pg_indexes "
            "WHERE schemaname='ifpmic' AND tablename=ANY(%s)",
            (sorted(AUTH_RETENTION_DELETE_TABLES),),
        ).fetchall()
    assert schema_owner == migration_db.roles.migration
    assert rows == [
        (MIGRATION_VERSION, PINNED_MIGRATION_SHA256, migration_db.roles.runtime, migration_db.roles.operator),
        (RETENTION_MIGRATION_VERSION, PINNED_RETENTION_MIGRATION_SHA256, migration_db.roles.runtime, migration_db.roles.operator),
    ]
    assert REQUIRED_TABLES <= tables
    indexed_auth_tables = {
        table: [definition for indexed_table, definition in expiry_indexes
                if indexed_table == table and "(expires_at" in definition]
        for table in AUTH_RETENTION_DELETE_TABLES
    }
    assert all(len(definitions) == 1 for definitions in indexed_auth_tables.values())


def test_migration_rejects_file_drift_removed_versions_and_role_drift(pg_cluster, migration_db, tmp_path):
    assert _migrate_with_cluster(pg_cluster, migration_db) == {
        "applied": MIGRATION_VERSIONS,
        "unchanged": [],
    }

    for version, source_file in (
        (MIGRATION_VERSION, MIGRATION_FILE),
        (RETENTION_MIGRATION_VERSION, RETENTION_MIGRATION_FILE),
    ):
        copied = tmp_path / f"changed-{version}"
        copied.mkdir()
        shutil.copyfile(MIGRATION_FILE, copied / f"{MIGRATION_VERSION}.sql")
        shutil.copyfile(RETENTION_MIGRATION_FILE, copied / f"{RETENTION_MIGRATION_VERSION}.sql")
        with (copied / f"{version}.sql").open("ab") as source:
            source.write(b"\n-- changed source bytes\n")
        _expect_migration_error(
            lambda copied=copied: _migrate_with_cluster(pg_cluster, migration_db, migration_dir=copied),
            "MIGRATION_DRIFT",
        )

    removed = tmp_path / "removed"
    removed.mkdir()
    shutil.copyfile(MIGRATION_FILE, removed / f"{MIGRATION_VERSION}.sql")
    shutil.copyfile(RETENTION_MIGRATION_FILE, removed / "003_replacement.sql")
    _expect_migration_error(
        lambda: _migrate_with_cluster(pg_cluster, migration_db, migration_dir=removed),
        "MIGRATION_DRIFT",
    )
    empty = tmp_path / "empty"
    empty.mkdir()
    _expect_migration_error(
        lambda: _migrate_with_cluster(pg_cluster, migration_db, migration_dir=empty),
        "MIGRATION_SOURCE_INVALID",
    )

    _expect_migration_error(
        lambda: _migrate_with_cluster(
            pg_cluster, migration_db, operator_role=migration_db.roles.alternate_runtime
        ),
        "MIGRATION_ROLE_DRIFT",
    )

    # All rejected attempts leave the originally accepted migration record intact.
    with psycopg.connect(migration_db.owner_dsn(pg_cluster)) as connection:
        rows = connection.execute(
            "SELECT version,source_sha256,runtime_role,operator_role FROM ifpmic.schema_migrations ORDER BY version"
        ).fetchall()
    assert rows == [
        (MIGRATION_VERSION, PINNED_MIGRATION_SHA256, migration_db.roles.runtime, migration_db.roles.operator),
        (RETENTION_MIGRATION_VERSION, PINNED_RETENTION_MIGRATION_SHA256, migration_db.roles.runtime, migration_db.roles.operator),
    ]


def test_invalid_role_and_active_transaction_are_refused(pg_cluster, migration_db):
    _expect_migration_error(
        lambda: _migrate_with_cluster(
            pg_cluster, migration_db, operator_role=migration_db.roles.runtime
        ),
        "MIGRATION_ROLE_INVALID",
    )
    _expect_migration_error(
        lambda: _migrate_with_cluster(pg_cluster, migration_db, runtime_role="ifpmic_missing_runtime"),
        "MIGRATION_ROLE_INVALID",
    )

    bootstrap = pg_cluster.dsn()
    with psycopg.connect(bootstrap, autocommit=True) as connection:
        connection.execute(
            sql.SQL("GRANT {} TO {}").format(
                sql.Identifier(migration_db.roles.alternate_runtime),
                sql.Identifier(migration_db.roles.runtime),
            )
        )
    _expect_migration_error(
        lambda: _migrate_with_cluster(pg_cluster, migration_db),
        "MIGRATION_ROLE_INVALID",
    )
    with psycopg.connect(bootstrap, autocommit=True) as connection:
        connection.execute(
            sql.SQL("REVOKE {} FROM {}").format(
                sql.Identifier(migration_db.roles.alternate_runtime),
                sql.Identifier(migration_db.roles.runtime),
            )
        )
        connection.execute(sql.SQL("ALTER ROLE {} REPLICATION").format(sql.Identifier(migration_db.roles.alternate_runtime)))
    _expect_migration_error(
        lambda: _migrate_with_cluster(pg_cluster, migration_db, runtime_role=migration_db.roles.alternate_runtime),
        "MIGRATION_ROLE_INVALID",
    )
    with psycopg.connect(bootstrap, autocommit=True) as connection:
        connection.execute(sql.SQL("ALTER ROLE {} NOREPLICATION").format(sql.Identifier(migration_db.roles.alternate_runtime)))

    _migrate_with_cluster(pg_cluster, migration_db)
    for role_name in (migration_db.roles.runtime, migration_db.roles.operator):
        with psycopg.connect(pg_cluster.dsn(user=role_name, database=migration_db.name), autocommit=True) as connection:
            _expect_migration_error(
                lambda connection=connection: apply_migrations(
                    connection,
                    runtime_role=migration_db.roles.alternate_runtime,
                    operator_role=migration_db.roles.operator,
                    migration_dir=migration_db.legacy_migration_dir,
                ),
                "MIGRATION_OWNER_INVALID",
            )

    with psycopg.connect(migration_db.owner_dsn(pg_cluster), autocommit=True) as connection:
        with connection.transaction():
            _expect_migration_error(
                lambda: apply_migrations(
                    connection,
                    runtime_role=migration_db.roles.runtime,
                    operator_role=migration_db.roles.operator,
                    migration_dir=migration_db.legacy_migration_dir,
                ),
                "MIGRATION_TRANSACTION_ACTIVE",
            )


def test_runtime_and_operator_are_distinct_nonowner_least_privilege_roles(pg_cluster, migration_db):
    assert _migrate_with_cluster(pg_cluster, migration_db) == {
        "applied": MIGRATION_VERSIONS,
        "unchanged": [],
    }
    with psycopg.connect(migration_db.owner_dsn(pg_cluster)) as connection:
        role_rows = connection.execute(
            "SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolcanlogin, "
            "EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) "
            "FROM pg_roles WHERE rolname = ANY(%s)",
            ([migration_db.roles.runtime, migration_db.roles.operator],),
        ).fetchall()
        assert len(role_rows) == 2
        for role in role_rows:
            assert role[1:5] == (False, False, False, False)
            assert role[5] is True
            assert role[6] is False

        for role_name in (migration_db.roles.runtime, migration_db.roles.operator):
            assert connection.execute(
                "SELECT has_schema_privilege(%s,'ifpmic','USAGE'), "
                "has_schema_privilege(%s,'ifpmic','CREATE'), "
                "has_database_privilege(%s,current_database(),'CREATE')",
                (role_name, role_name, role_name),
            ).fetchone() == (True, False, False)
            assert connection.execute(
                "SELECT has_table_privilege(%s,'ifpmic.schema_migrations','SELECT'), "
                "has_table_privilege(%s,'ifpmic.schema_migrations','INSERT'), "
                "has_table_privilege(%s,'ifpmic.schema_migrations','UPDATE'), "
                "has_table_privilege(%s,'ifpmic.schema_migrations','DELETE')",
                (role_name, role_name, role_name, role_name),
            ).fetchone() == (False, False, False, False)

        for table in REQUIRED_TABLES:
            assert connection.execute(
                "SELECT has_table_privilege(%s,%s,'SELECT')",
                (migration_db.roles.runtime, f"ifpmic.{table}"),
            ).fetchone() == (True,)
            assert connection.execute(
                "SELECT has_table_privilege(%s,%s,'SELECT')",
                (migration_db.roles.operator, f"ifpmic.{table}"),
            ).fetchone()[0] is (table in OPERATOR_SELECT_TABLES)
            assert connection.execute(
                "SELECT has_table_privilege(%s,%s,'DELETE')",
                (migration_db.roles.runtime, f"ifpmic.{table}"),
            ).fetchone()[0] is (table in AUTH_RETENTION_DELETE_TABLES)
            assert connection.execute(
                "SELECT has_table_privilege(%s,%s,'DELETE')",
                (migration_db.roles.operator, f"ifpmic.{table}"),
            ).fetchone() == (False,)

        for table in REQUIRED_TABLES:
            for role_name, expected_columns in (
                (migration_db.roles.runtime, RUNTIME_INSERT_COLUMNS.get(table, set())),
                (migration_db.roles.operator, set() if table not in OPERATOR_INSERT_TABLES else None),
            ):
                if expected_columns is None:
                    # Operator grants are intentionally whole-table INSERT grants.
                    assert connection.execute(
                        "SELECT has_table_privilege(%s,%s,'INSERT')",
                        (role_name, f"ifpmic.{table}"),
                    ).fetchone()[0] is True
                    continue
                for column in expected_columns:
                    assert connection.execute(
                        "SELECT has_column_privilege(%s,%s,%s,'INSERT')",
                        (role_name, f"ifpmic.{table}", column),
                    ).fetchone() == (True,)
                all_columns = {
                    row[0]
                    for row in connection.execute(
                        "SELECT column_name FROM information_schema.columns "
                        "WHERE table_schema='ifpmic' AND table_name=%s",
                        (table,),
                    ).fetchall()
                }
                for column in all_columns - expected_columns:
                    assert connection.execute(
                        "SELECT has_column_privilege(%s,%s,%s,'INSERT')",
                        (role_name, f"ifpmic.{table}", column),
                    ).fetchone() == (False,)

        # Operator may insert all columns in its explicitly managed tables only.
        for table in OPERATOR_INSERT_TABLES:
            assert connection.execute(
                "SELECT has_table_privilege(%s,%s,'INSERT')",
                (migration_db.roles.operator, f"ifpmic.{table}"),
            ).fetchone() == (True,)

        for role_name, expected in (
            (migration_db.roles.runtime, RUNTIME_UPDATE_COLUMNS),
            (migration_db.roles.operator, OPERATOR_UPDATE_COLUMNS),
        ):
            for table, columns in expected.items():
                for column in columns:
                    assert connection.execute(
                        "SELECT has_column_privilege(%s,%s,%s,'UPDATE')",
                        (role_name, f"ifpmic.{table}", column),
                    ).fetchone() == (True,)

        # These authority/state fields must not become writable by either API role.
        forbidden_updates = {
            "profile_catalog": {"record_bytes", "record_bytes_sha256", "enabled"},
            "profile_eligibility": {"expires_at", "evidence_sha256"},
            "jobs": {"owner_id", "status", "revision", "candidate_fingerprint"},
            "commands": {"status", "applied_revision", "error_code"},
            "commands_outbox": {"state"},
        }
        for role_name in (migration_db.roles.runtime, migration_db.roles.operator):
            for table, columns in forbidden_updates.items():
                for column in columns:
                    assert connection.execute(
                        "SELECT has_column_privilege(%s,%s,%s,'UPDATE')",
                        (role_name, f"ifpmic.{table}", column),
                    ).fetchone() == (False,)

        replication_rows = connection.execute(
            "SELECT rolreplication FROM pg_roles WHERE rolname=ANY(%s)",
            ([migration_db.roles.runtime, migration_db.roles.operator],),
        ).fetchall()
        assert len(replication_rows) == 2 and all(row == (False,) for row in replication_rows)
        for role_name in (migration_db.roles.runtime, migration_db.roles.operator):
            assert connection.execute(
                "SELECT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid OR roleid=pg_roles.oid) "
                "FROM pg_roles WHERE rolname=%s",
                (role_name,),
            ).fetchone() == (False,)

    with psycopg.connect(migration_db.runtime_dsn(pg_cluster), autocommit=True) as runtime:
        for table in sorted(REQUIRED_TABLES - AUTH_RETENTION_DELETE_TABLES):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                runtime.execute(sql.SQL("DELETE FROM ifpmic.{} WHERE false").format(sql.Identifier(table)))
            runtime.rollback()


def test_runtime_and_operator_can_only_perform_their_planned_mutations(pg_cluster, migration_db):
    _migrate_with_cluster(pg_cluster, migration_db)
    now = datetime.now(timezone.utc)
    digest = "a" * 64
    identity = "ifpmic-g1-user@example.invalid"
    with psycopg.connect(migration_db.runtime_dsn(pg_cluster)) as runtime:
        user_id = runtime.execute(
            "INSERT INTO ifpmic.users(identity_subject,display_name) VALUES(%s,%s) RETURNING user_id",
            (identity, "G1 synthetic"),
        ).fetchone()[0]
        runtime.execute("UPDATE ifpmic.users SET display_name=%s WHERE user_id=%s", ("G1 synthetic updated", user_id))
        runtime.execute(
            "INSERT INTO ifpmic.oidc_login_transactions(state_hash,browser_hash,nonce,pkce_verifier,expires_at) "
            "VALUES(%s,%s,%s,%s,%s)",
            ("1" * 64, "browser-hash", "nonce", "verifier", now + timedelta(minutes=5)),
        )
        runtime.execute(
            "UPDATE ifpmic.oidc_login_transactions SET consumed_at=%s WHERE state_hash=%s",
            (now, "1" * 64),
        )
        runtime.execute(
            "INSERT INTO ifpmic.user_sessions(token_hash,user_id,created_at,expires_at,last_seen_at) "
            "VALUES(%s,%s,%s,%s,%s)",
            ("2" * 64, user_id, now, now + timedelta(hours=8), now),
        )
        runtime.execute(
            "UPDATE ifpmic.user_sessions SET last_seen_at=%s,revoked_at=%s WHERE token_hash=%s",
            (now + timedelta(seconds=1), None, "2" * 64),
        )
        runtime.execute("DELETE FROM ifpmic.oidc_login_transactions WHERE state_hash=%s", ("1" * 64,))
        runtime.execute("DELETE FROM ifpmic.user_sessions WHERE token_hash=%s", ("2" * 64,))

    with psycopg.connect(migration_db.operator_dsn(pg_cluster)) as operator:
        operator.execute("INSERT INTO ifpmic.projects(project_id) VALUES(%s)", ("g1-project",))
        operator.execute(
            "INSERT INTO ifpmic.memberships(project_id,user_id,active,capabilities) VALUES(%s,%s,true,%s)",
            ("g1-project", user_id, ["request.create"]),
        )
        operator.execute(
            "INSERT INTO ifpmic.profile_catalog(project_id,version_key,snapshot_id,record_bytes,record_bytes_sha256,"
            "profile_version_json,mode,enabled,configuration_complete) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            ("g1-project", "3" * 64, "4" * 64, b"synthetic-record", hashlib.sha256(b"synthetic-record").hexdigest(), '"g1-v1"', "mock", True, True),
        )
        operator.execute(
            "INSERT INTO ifpmic.profile_eligibility(project_id,snapshot_id,mode,evidence_ref,evidence_sha256,granted_at,expires_at) "
            "VALUES(%s,%s,%s,%s,%s,%s,%s)",
            ("g1-project", "4" * 64, "mock", "synthetic-fixture", digest, now, now + timedelta(days=1)),
        )
        operator.execute(
            "INSERT INTO ifpmic.artifacts(project_id,owner_id,state,sha256,size) VALUES(%s,%s,%s,%s,%s)",
            ("g1-project", user_id, "available", digest, 1),
        )
        operator.execute("UPDATE ifpmic.memberships SET active=false WHERE project_id=%s AND user_id=%s", ("g1-project", user_id))
        operator.execute("UPDATE ifpmic.memberships SET active=true,capabilities=%s WHERE project_id=%s AND user_id=%s", (["request.create"], "g1-project", user_id))
        operator.execute("UPDATE ifpmic.authorization_guards SET lock_version=lock_version+1 WHERE project_id=%s", ("g1-project",))

    with psycopg.connect(migration_db.runtime_dsn(pg_cluster)) as runtime:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            runtime.execute("INSERT INTO ifpmic.projects(project_id) VALUES(%s)", ("runtime-must-not-provision",))
        runtime.rollback()
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            runtime.execute("UPDATE ifpmic.profile_catalog SET enabled=false WHERE project_id=%s", ("g1-project",))
        runtime.rollback()


def test_real_profile_eligibility_is_not_mintable_by_operator(pg_cluster, migration_db):
    _migrate_with_cluster(pg_cluster, migration_db)
    now = datetime.now(timezone.utc)
    with psycopg.connect(migration_db.runtime_dsn(pg_cluster)) as runtime:
        user_id = runtime.execute(
            "INSERT INTO ifpmic.users(identity_subject,display_name) VALUES(%s,%s) RETURNING user_id",
            ("real-authz-user", "G1 synthetic"),
        ).fetchone()[0]
    with psycopg.connect(migration_db.operator_dsn(pg_cluster)) as operator:
        operator.execute("INSERT INTO ifpmic.projects(project_id) VALUES(%s)", ("real-authz-project",))
        operator.execute(
            "INSERT INTO ifpmic.profile_catalog(project_id,version_key,snapshot_id,record_bytes,record_bytes_sha256,"
            "profile_version_json,mode,enabled,configuration_complete) VALUES(%s,%s,%s,%s,%s,%s,'real',true,true)",
            ("real-authz-project", "9" * 64, "a" * 64, b"synthetic-real-profile", hashlib.sha256(b"synthetic-real-profile").hexdigest(), '"g1-real-v1"'),
        )
        operator.commit()
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            operator.execute(
                "INSERT INTO ifpmic.profile_eligibility(project_id,snapshot_id,mode,evidence_ref,evidence_sha256,granted_at,expires_at) "
                "VALUES(%s,%s,'real',%s,%s,%s,%s)",
                ("real-authz-project", "a" * 64, "operator-attempt", "b" * 64, now, now + timedelta(days=1)),
            )
        operator.rollback()

    # The schema owner may seed a synthetic record to validate constraints;
    # this does not constitute a grant from an external authority.
    with psycopg.connect(migration_db.owner_dsn(pg_cluster)) as owner:
        owner.execute(
            "INSERT INTO ifpmic.profile_eligibility(project_id,snapshot_id,mode,evidence_ref,evidence_sha256,granted_at,expires_at) "
            "VALUES(%s,%s,'real',%s,%s,%s,%s)",
            ("real-authz-project", "a" * 64, "synthetic-owner-fixture", "b" * 64, now, now + timedelta(days=1)),
        )
    with psycopg.connect(migration_db.owner_dsn(pg_cluster)) as owner:
        assert owner.execute(
            "SELECT count(*) FROM ifpmic.profile_eligibility WHERE mode='real'"
        ).fetchone() == (1,)


def test_migration_cli_errors_are_one_line_json_and_do_not_echo_secrets(pg_cluster, migration_db):
    root = Path(__file__).resolve().parents[2]
    sentinel = "dsn-secret-sentinel-not-for-output"
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "PYTHONPATH": str(root),
        "IFPMIC_MIGRATION_DSN": sentinel,
        "IFPMIC_RUNTIME_ROLE": "ifpmic_test_runtime",
    }
    result = subprocess.run(
        [sys.executable, "-m", "services.ifpmic_api.migrate"],
        cwd=root,
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == 2
    assert result.stderr == ""
    assert result.stdout.endswith("\n") and result.stdout.count("\n") == 1
    assert json.loads(result.stdout) == {"error": {"code": "MIGRATION_CONFIG_INVALID"}}
    assert sentinel not in result.stdout + result.stderr

    env.pop("IFPMIC_OPERATOR_ROLE", None)
    extra_arg = subprocess.run(
        [sys.executable, "-m", "services.ifpmic_api.migrate", "unexpected"],
        cwd=root,
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert extra_arg.returncode == 2
    assert extra_arg.stderr == ""
    assert json.loads(extra_arg.stdout) == {"error": {"code": "MIGRATION_CONFIG_INVALID"}}
    assert sentinel not in extra_arg.stdout + extra_arg.stderr


def test_migration_cli_applies_and_reruns_without_leaking_connection_info(pg_cluster, migration_db):
    root = Path(__file__).resolve().parents[2]
    sentinel = "cli-password-sentinel-not-for-output"
    dsn = pg_cluster.dsn(user=migration_db.roles.migration, database=migration_db.name)
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "PYTHONPATH": str(root),
        "IFPMIC_MIGRATION_DSN": dsn,
        "IFPMIC_RUNTIME_ROLE": migration_db.roles.runtime,
        "IFPMIC_OPERATOR_ROLE": migration_db.roles.operator,
        "IFPMIC_DISPATCHER_ROLE": migration_db.roles.dispatcher,
        "IFPMIC_PROJECTOR_ROLE": migration_db.roles.projector,
        "IFPMIC_TEST_SENTINEL": sentinel,
    }
    command = [sys.executable, "-m", "services.ifpmic_api.migrate"]
    first = subprocess.run(
        command, cwd=root, env=env, stdin=subprocess.DEVNULL, capture_output=True,
        text=True, timeout=20, check=False,
    )
    assert first.returncode == 0
    assert first.stderr == ""
    assert first.stdout.endswith("\n") and first.stdout.count("\n") == 1
    assert json.loads(first.stdout) == {"applied": CURRENT_MIGRATION_VERSIONS, "unchanged": []}
    assert sentinel not in first.stdout + first.stderr and dsn not in first.stdout + first.stderr

    second = subprocess.run(
        command, cwd=root, env=env, stdin=subprocess.DEVNULL, capture_output=True,
        text=True, timeout=20, check=False,
    )
    assert second.returncode == 0
    assert second.stderr == ""
    assert second.stdout.endswith("\n") and second.stdout.count("\n") == 1
    assert json.loads(second.stdout) == {"applied": [], "unchanged": CURRENT_MIGRATION_VERSIONS}
    assert sentinel not in second.stdout + second.stderr and dsn not in second.stdout + second.stderr


def test_database_constraints_bind_owner_project_snapshot_and_command(pg_cluster, migration_db):
    _migrate_with_cluster(pg_cluster, migration_db)
    now = datetime.now(timezone.utc)
    with psycopg.connect(migration_db.runtime_dsn(pg_cluster)) as runtime:
        user_id = runtime.execute(
            "INSERT INTO ifpmic.users(identity_subject,display_name) VALUES(%s,%s) RETURNING user_id",
            ("constraint-user", "Constraint User"),
        ).fetchone()[0]
    with psycopg.connect(migration_db.operator_dsn(pg_cluster)) as operator:
        operator.execute("INSERT INTO ifpmic.projects(project_id) VALUES(%s)", ("constraint-project",))
        operator.execute(
            "INSERT INTO ifpmic.memberships(project_id,user_id,active,capabilities) VALUES(%s,%s,true,%s)",
            ("constraint-project", user_id, ["request.create"]),
        )
        operator.execute(
            "INSERT INTO ifpmic.profile_catalog(project_id,version_key,snapshot_id,record_bytes,record_bytes_sha256,"
            "profile_version_json,mode,enabled,configuration_complete) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            ("constraint-project", "5" * 64, "6" * 64, b"record", hashlib.sha256(b"record").hexdigest(), '"v1"', "mock", True, True),
        )
    with psycopg.connect(migration_db.runtime_dsn(pg_cluster)) as runtime:
        job_id = runtime.execute(
            "INSERT INTO ifpmic.jobs(owner_id,project_id,snapshot_id,workflow_id) VALUES(%s,%s,%s,%s) RETURNING job_id",
            (user_id, "constraint-project", "6" * 64, "ifpmic-sw-v1"),
        ).fetchone()[0]
        command_id = runtime.execute(
            "INSERT INTO ifpmic.commands(actor_id,route,idempotency_key,project_id,job_id,command_payload_json,payload_sha256) "
            "VALUES(%s,%s,%s,%s,%s,%s,%s) RETURNING command_id",
            (user_id, "POST /api/v1/jobs", "constraint-key", "constraint-project", job_id, '{"fixture":"g1"}', "7" * 64),
        ).fetchone()[0]
        runtime.execute("INSERT INTO ifpmic.commands_outbox(command_id) VALUES(%s)", (command_id,))
        runtime.execute("INSERT INTO ifpmic.workspace_intents(job_id,command_id) VALUES(%s,%s)", (job_id, command_id))
        runtime.execute(
            "UPDATE ifpmic.workspace_intents SET state='PROVISIONING',generation=1,claim_token=%s,"
            "claim_expires_at=%s WHERE job_id=%s",
            (uuid4(), now + timedelta(minutes=1), job_id),
        )
        runtime.commit()

        # Runtime may create a DRAFT/accepted/pending reservation only. The
        # defaulted state columns cannot be bootstrapped directly as advanced.
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            runtime.execute(
                "INSERT INTO ifpmic.jobs(owner_id,project_id,snapshot_id,workflow_id,status) "
                "VALUES(%s,%s,%s,%s,'COMPLETED')",
                (user_id, "constraint-project", "6" * 64, "ifpmic-sw-v1"),
            )
        runtime.rollback()

        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            runtime.execute(
                "INSERT INTO ifpmic.commands(actor_id,route,idempotency_key,project_id,job_id,"
                "command_payload_json,payload_sha256,status) VALUES(%s,%s,%s,%s,%s,%s,%s,'applied')",
                (user_id, "POST /api/v1/jobs", "forbidden-status", "constraint-project", job_id, '{}', "8" * 64),
            )
        runtime.rollback()

        with pytest.raises(psycopg.errors.CheckViolation):
            runtime.execute(
                "INSERT INTO ifpmic.jobs(owner_id,project_id,snapshot_id,workflow_id) VALUES(%s,%s,%s,%s)",
                (user_id, "constraint-project", "6" * 64, "schema_version-1.0.0"),
            )
        runtime.rollback()
        with pytest.raises(psycopg.errors.UniqueViolation):
            runtime.execute(
                "INSERT INTO ifpmic.commands(actor_id,route,idempotency_key,project_id,job_id,command_payload_json,payload_sha256) "
                "VALUES(%s,%s,%s,%s,%s,%s,%s)",
                (user_id, "POST /api/v1/jobs", "constraint-key", "constraint-project", job_id, '{"fixture":"different"}', "8" * 64),
            )
        runtime.rollback()

    with psycopg.connect(migration_db.operator_dsn(pg_cluster)) as operator:
        delegation_id = operator.execute(
            "INSERT INTO ifpmic.job_delegations(project_id,job_id,user_id,action,expires_at) "
            "VALUES(%s,%s,%s,'job.read',%s) RETURNING delegation_id",
            ("constraint-project", job_id, user_id, now + timedelta(hours=1)),
        ).fetchone()[0]
        operator.execute(
            "UPDATE ifpmic.job_delegations SET expires_at=%s,revoked_at=%s WHERE delegation_id=%s",
            (now + timedelta(hours=2), now, delegation_id),
        )

    with psycopg.connect(migration_db.owner_dsn(pg_cluster)) as owner:
        assert owner.execute("SELECT count(*) FROM ifpmic.jobs").fetchone()[0] == 1
        assert owner.execute("SELECT count(*) FROM ifpmic.commands").fetchone()[0] == 1
        assert owner.execute("SELECT count(*) FROM ifpmic.commands_outbox").fetchone()[0] == 1
        assert owner.execute("SELECT count(*) FROM ifpmic.workspace_intents").fetchone()[0] == 1
        assert owner.execute("SELECT state,generation FROM ifpmic.workspace_intents").fetchone() == ("PROVISIONING", 1)


def test_failed_migration_rolls_back_schema_and_concurrent_migration_is_serialized(pg_cluster, migration_db, tmp_path):
    for version, source_file in (
        (MIGRATION_VERSION, MIGRATION_FILE),
        (RETENTION_MIGRATION_VERSION, RETENTION_MIGRATION_FILE),
    ):
        broken = tmp_path / f"broken-{version}"
        broken.mkdir()
        shutil.copyfile(MIGRATION_FILE, broken / f"{MIGRATION_VERSION}.sql")
        shutil.copyfile(RETENTION_MIGRATION_FILE, broken / f"{RETENTION_MIGRATION_VERSION}.sql")
        broken_sql = broken / f"{version}.sql"
        source = source_file.read_text(encoding="utf-8")
        broken_sql.write_text(source + "\nINVALID SQL;\n", encoding="utf-8")
        _expect_migration_error(
            lambda broken=broken: _migrate_with_cluster(pg_cluster, migration_db, migration_dir=broken),
            "MIGRATION_IO",
        )
        with psycopg.connect(migration_db.owner_dsn(pg_cluster)) as connection:
            assert connection.execute("SELECT to_regnamespace('ifpmic')").fetchone()[0] is None

    barrier = threading.Barrier(2)

    def migrate_once():
        with psycopg.connect(migration_db.owner_dsn(pg_cluster), autocommit=True) as connection:
            barrier.wait(timeout=10)
            return apply_migrations(
                connection,
                runtime_role=migration_db.roles.runtime,
                operator_role=migration_db.roles.operator,
                migration_dir=migration_db.legacy_migration_dir,
            )

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: migrate_once(), range(2)))
    assert sorted((tuple(row["applied"]), tuple(row["unchanged"])) for row in results) == sorted(
        [(tuple(MIGRATION_VERSIONS), ()), ((), tuple(MIGRATION_VERSIONS))]
    )
    with psycopg.connect(migration_db.owner_dsn(pg_cluster)) as connection:
        assert connection.execute("SELECT count(*) FROM ifpmic.schema_migrations").fetchone()[0] == 2
        assert connection.execute("SELECT count(*) FROM ifpmic.jobs").fetchone()[0] == 0
