"""Independent G4 fixtures: real B01 snapshot bytes, real PostgreSQL, synthetic OIDC."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient

from services.ifpmic_api.catalog import import_snapshot
from services.ifpmic_api.migrate import apply_migrations
from services.ifpmic_api.snapshot_bridge import SnapshotBridge
from services.ifpmic_api.settings import Settings
from tests.ifpmic_api.oidc_provider import SyntheticOIDCProvider
from tests.ifpmic_api.test_auth import API_ORIGIN, UI_ORIGIN, _settings


ROOT = Path(__file__).resolve().parents[2]
NODE = shutil.which("node")
PROJECT_ID = "g4-fixed-project"
PROFILE_VERSION = "g4-fixture-v1"
FROZEN_NOW = datetime(2030, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
CSRF_KEY = b"g4-independent-test-key-material-32bytes+"


SEED_PROFILE_SCRIPT = r"""
import { pathToFileURL } from 'node:url';
const input = JSON.parse((await new Promise((resolve, reject) => {
  let data = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => data += c);
  process.stdin.on('end', () => resolve(data)); process.stdin.on('error', reject);
})));
const root = process.cwd();
const { validProfile } = await import(pathToFileURL(`${root}/tests/helpers/ifpmic-profile-fixtures.mjs`));
const { createSnapshot } = await import(pathToFileURL(`${root}/runtime/ifpmic/snapshot.mjs`));
const { initStore, publishSnapshot } = await import(pathToFileURL(`${root}/runtime/ifpmic/store.mjs`));
const profile = structuredClone(validProfile);
profile.project_id = input.project_id;
profile.mode = 'mock';
if (input.enabled === false) profile.enabled = false;
if (input.configuration_incomplete === true) profile.release.version = 'CONFIGURE';
const profileText = JSON.stringify(profile);
await initStore(input.store_root);
let record;
try { record = createSnapshot({ profileText, profileVersion: input.profile_version }); }
catch (error) {
  process.stdout.write(JSON.stringify({ error: { code: error?.code ?? 'SEED_FAILED' } }) + '\n');
  process.exitCode = 2;
}
if (record) {
  await publishSnapshot(input.store_root, record);
  process.stdout.write(JSON.stringify({ seeded: true, snapshot_id: record.snapshot_id }) + '\n');
}
"""


class FrozenClock:
    def __init__(self, value: datetime = FROZEN_NOW):
        self.value = value

    def __call__(self) -> datetime:
        return self.value

    def advance(self, **delta) -> None:
        self.value += timedelta(**delta)


@pytest.fixture
def g4_clock() -> FrozenClock:
    return FrozenClock()


@pytest.fixture
def g4_oidc_provider() -> SyntheticOIDCProvider:
    provider = SyntheticOIDCProvider().start()
    try:
        yield provider
    finally:
        provider.close()


@pytest.fixture
def g4_database(pg_cluster, migration_db):
    with psycopg.connect(migration_db.owner_dsn(pg_cluster), autocommit=True) as connection:
        apply_migrations(
            connection,
            runtime_role=migration_db.roles.runtime,
            operator_role=migration_db.roles.operator,
        )
    return migration_db, pg_cluster


def owner_dsn(database) -> str:
    migration, cluster = database
    return migration.owner_dsn(cluster)


def runtime_dsn(database) -> str:
    migration, cluster = database
    return migration.runtime_dsn(cluster)


def operator_dsn(database) -> str:
    migration, cluster = database
    return migration.operator_dsn(cluster)


def seed_profile_store(store_root: Path, project_id: str = PROJECT_ID,
                       profile_version: str = PROFILE_VERSION, *, enabled=True,
                       configuration_incomplete=False) -> None:
    if NODE is None:
        pytest.fail("G4 requires the pinned Node runtime for the B01 snapshot capture fixture")
    result = subprocess.run(
        [NODE, "--input-type=module", "--eval", SEED_PROFILE_SCRIPT],
        cwd=ROOT,
        input=json.dumps(
            {"store_root": str(store_root), "project_id": project_id,
             "profile_version": profile_version, "enabled": enabled,
             "configuration_incomplete": configuration_incomplete},
            ensure_ascii=True, separators=(",", ":"),
        ).encode("ascii"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
        check=False,
    )
    # Intentionally do not include child output in assertion diagnostics.
    assert result.returncode == 0
    assert result.stderr == b""
    assert result.stdout.endswith(b"\n") and result.stdout.count(b"\n") == 1
    assert set(json.loads(result.stdout)) == {"seeded", "snapshot_id"}


def build_settings(provider, database, store_root: Path, **changes) -> Settings:
    settings = _settings(provider, runtime_dsn(database), **changes)
    return Settings(**{
        **settings.__dict__,
        "node_executable": NODE,
        "profile_store": str(store_root),
    })


def bridge_for(store_root: Path) -> SnapshotBridge:
    if NODE is None:
        pytest.fail("Node executable required for G4 snapshot bridge")
    return SnapshotBridge(node_executable=NODE, store_root=store_root)


def capture_snapshot(store_root: Path, project_id: str = PROJECT_ID,
                     profile_version: str = PROFILE_VERSION):
    return asyncio.run(bridge_for(store_root).read_snapshot(project_id, profile_version))


def seed_catalog_and_eligibility(database, record, *,
                                granted_at=FROZEN_NOW - timedelta(days=1),
                                expires_at=FROZEN_NOW + timedelta(days=30)):
    imported = seed_catalog_only(database, record)
    with psycopg.connect(operator_dsn(database), autocommit=True) as connection:
        eligibility_id = connection.execute(
            """INSERT INTO ifpmic.profile_eligibility
               (project_id,snapshot_id,mode,evidence_ref,evidence_sha256,granted_at,expires_at)
               VALUES(%s,%s,%s,%s,%s,%s,%s) RETURNING eligibility_id::text""",
            (record.project_id, record.snapshot_id, record.mode, "g4-synthetic-authority",
             "a" * 64, granted_at, expires_at),
        ).fetchone()[0]
    return imported, eligibility_id


def seed_catalog_only(database, record):
    with psycopg.connect(operator_dsn(database), autocommit=True) as connection:
        connection.execute("INSERT INTO ifpmic.projects(project_id) VALUES(%s) ON CONFLICT DO NOTHING",
                           (record.project_id,))
        imported = import_snapshot(connection, record)
    return imported


def seed_membership(database, project_id: str, user_id: str, *, active=True,
                    capabilities=("request.create",)):
    with psycopg.connect(operator_dsn(database), autocommit=True) as connection:
        connection.execute("INSERT INTO ifpmic.projects(project_id) VALUES(%s) ON CONFLICT DO NOTHING",
                           (project_id,))
        connection.execute(
            "INSERT INTO ifpmic.memberships(project_id,user_id,active,capabilities) VALUES(%s,%s,%s,%s) "
            "ON CONFLICT(project_id,user_id) DO UPDATE SET active=EXCLUDED.active,capabilities=EXCLUDED.capabilities",
            (project_id, user_id, active, list(capabilities)),
        )


def login(client: TestClient, provider, clock: FrozenClock,
          subject: str = "g4-user-a") -> tuple[str, str, str]:
    """Complete a synthetic login and return (user_id, session token, CSRF token)."""
    from tests.ifpmic_api.test_auth import _callback, _start_login

    query, _ = _start_login(client, provider, clock)
    provider.claim_overrides = {"sub": subject}
    response = _callback(client, query)
    assert response.status_code == 303
    session = client.get("/api/v1/session")
    assert session.status_code == 200
    return session.json()["user_id"], client.cookies.get("ax_session"), session.json()["csrf_token"]


@pytest.fixture
def g4_harness(tmp_path, g4_database, g4_oidc_provider, g4_clock):
    """A real app/PG/Node bridge harness; membership/grant fixtures remain synthetic."""
    from services.ifpmic_api.app import create_app

    store_root = tmp_path / "profile-store"
    seed_profile_store(store_root)
    record = capture_snapshot(store_root)
    _, eligibility_id = seed_catalog_and_eligibility(g4_database, record)
    settings = build_settings(g4_oidc_provider, g4_database, store_root)
    bridge = bridge_for(store_root)
    app = create_app(settings, bridge_runner=bridge, clock=g4_clock)
    with TestClient(app, base_url=API_ORIGIN, follow_redirects=False) as client:
        user_id, session, csrf = login(client, g4_oidc_provider, g4_clock)
        seed_membership(g4_database, PROJECT_ID, user_id)
        yield {
            "client": client, "app": app, "settings": settings, "clock": g4_clock,
            "database": g4_database, "provider": g4_oidc_provider, "user_id": user_id,
            "session": session, "csrf": csrf, "record": record, "bridge": bridge,
            "eligibility_id": eligibility_id,
            "store_root": store_root, "project_id": PROJECT_ID, "profile_version": PROFILE_VERSION,
        }


def write_headers(harness, *, key="g4-key-1", session=None, csrf=None):
    return {
        "Origin": UI_ORIGIN,
        "X-CSRF-Token": csrf or harness["csrf"],
        "Idempotency-Key": key,
        "Cookie": "ax_session=" + (session or harness["session"]),
    }


def client_with(harness, *, fault_hook=None, bridge_runner=None):
    """Create another app/client over the same isolated DB and current session."""
    from services.ifpmic_api.app import create_app

    app = create_app(
        harness["settings"],
        bridge_runner=bridge_runner or harness["bridge"],
        clock=harness["clock"],
        fault_hook=fault_hook,
    )
    client = TestClient(app, base_url=API_ORIGIN, follow_redirects=False)
    client.cookies.set("ax_session", harness["session"], path="/")
    return app, client


def valid_create_job(harness, **changes):
    payload = {
        "project_id": harness["project_id"],
        "title": "G4 synthetic job",
        "request_text": "Validate isolated acceptance",
        "change_type": "FEATURE",
        "base_ref": "refs/heads/main",
        "input_artifact_ids": [],
        "profile_version": harness["profile_version"],
        "release_mode": "team_github_tag",
    }
    payload.update(changes)
    return payload


def seed_job_rows(harness, count: int, *, owner_id: str | None = None,
                  start_minute: int = 1) -> list[str]:
    """Seed structurally valid DRAFT acceptance rows for deterministic list tests."""
    import hashlib

    actor = owner_id or harness["user_id"]
    ids = []
    with psycopg.connect(owner_dsn(harness["database"])) as connection:
        for index in range(count):
            import uuid
            job_id = str(uuid.uuid4())
            command_id = str(uuid.uuid4())
            minute = start_minute + index
            payload = {
                "project_id": harness["project_id"],
                "title": f"seeded-list-{index}",
                "request_text": "synthetic database list fixture",
                "change_type": "FEATURE",
                "base_ref": "refs/heads/main",
                "input_artifact_ids": [],
                "profile_version": harness["profile_version"],
                "release_mode": "team_github_tag",
            }
            stored = json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False)
            envelope = json.dumps({"format": "ifpmic.create-job.v1", "payload": payload},
                                  ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False)
            digest = hashlib.sha256(envelope.encode("utf-8")).hexdigest()
            created_at = FROZEN_NOW - timedelta(minutes=minute)
            connection.execute(
                "INSERT INTO ifpmic.jobs(job_id,owner_id,project_id,snapshot_id,workflow_id,created_at) "
                "VALUES(%s,%s,%s,%s,'ifpmic-sw-v1',%s)",
                (job_id, actor, harness["project_id"], harness["record"].snapshot_id, created_at),
            )
            connection.execute(
                """INSERT INTO ifpmic.commands(command_id,actor_id,route,idempotency_key,project_id,job_id,
                   command_payload_json,payload_sha256,created_at)
                   VALUES(%s,%s,'POST /api/v1/jobs',%s,%s,%s,%s,%s,%s)""",
                (command_id, actor, f"seed-list-{index}-{job_id}", harness["project_id"], job_id,
                 stored, digest, created_at),
            )
            connection.execute("INSERT INTO ifpmic.commands_outbox(command_id) VALUES(%s)", (command_id,))
            connection.execute("INSERT INTO ifpmic.workspace_intents(job_id,command_id) VALUES(%s,%s)",
                               (job_id, command_id))
            ids.append(job_id)
    return ids


def private_settings_file(settings, path: Path) -> None:
    """Write the exact runtime config using a private test-only file."""
    value = {
        "mode": settings.mode,
        "api_origin": settings.api_origin,
        "issuer": settings.issuer,
        "client_id": settings.client_id,
        "authorization_endpoint": settings.authorization_endpoint,
        "token_endpoint": settings.token_endpoint,
        "jwks_uri": settings.jwks_uri,
        "redirect_uri": settings.redirect_uri,
        "post_login_url": settings.post_login_url,
        "allowed_ui_origins": list(settings.allowed_ui_origins),
        "csrf_key": base64.urlsafe_b64encode(settings.csrf_key).decode("ascii").rstrip("="),
        "database_dsn": settings.database_dsn,
        "client_secret": settings.client_secret,
        "client_auth_method": settings.client_auth_method,
        "signing_algorithms": list(settings.signing_algorithms),
        "auth_gc_interval_seconds": settings.auth_gc_interval_seconds,
        "node_executable": settings.node_executable,
        "profile_store": settings.profile_store,
    }
    path.write_text(json.dumps(value, ensure_ascii=True, separators=(",", ":")), encoding="ascii")
    path.chmod(0o600)


def free_loopback_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def wait_http_ready(process: subprocess.Popen, url: str, timeout: float = 15.0) -> None:
    import urllib.error
    import urllib.request

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise AssertionError("G4 API process exited before ready")
        try:
            request = urllib.request.Request(url, headers={"Origin": "http://127.0.0.1:4173"})
            with urllib.request.urlopen(request, timeout=0.5) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            time.sleep(0.05)
    raise AssertionError("G4 API process readiness timeout")
