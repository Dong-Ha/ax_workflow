"""Independent G5 workspace fixtures built on the real G4 PostgreSQL harness."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import replace
import hashlib
import json
import os
import stat
import base64
from pathlib import Path
from uuid import UUID

import psycopg
import pytest
from fastapi.testclient import TestClient

from services.ifpmic_api.app import create_app
from tests.ifpmic_api.jobs_fixture import (
    API_ORIGIN,
    bridge_for,
    owner_dsn,
    seed_profile_store,
    valid_create_job,
    write_headers,
)


WORKSPACE_CHILD_NAMES = ("source", "tc", "artifacts", "build")
WORKSPACE_MARKER_NAME = ".ifpmic-workspace.json"


def expected_marker_bytes(job_id: str, workspace_token: str) -> bytes:
    """Literal G5 marker oracle; deliberately independent of workspace_fs."""
    UUID(job_id)
    UUID(workspace_token)
    value = {
        "format": "ifpmic.workspace.v1",
        "job_id": job_id,
        "workspace_token": workspace_token,
    }
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii")


def set_mode(path: Path, mode: int = 0o700) -> Path:
    path.mkdir(mode=mode, parents=True, exist_ok=True)
    path.chmod(mode)
    return path


def tree_fingerprint(root: Path) -> list[dict[str, object]]:
    """Return an lstat-only tree oracle; never follow a symlink target."""
    rows: list[dict[str, object]] = []
    pending = [root]
    while pending:
        directory = pending.pop()
        for child in sorted(directory.iterdir(), key=lambda p: p.name):
            info = child.lstat()
            row: dict[str, object] = {
                "path": child.relative_to(root).as_posix(),
                "mode": stat.S_IMODE(info.st_mode),
                "uid": info.st_uid,
                "device": info.st_dev,
                "inode": info.st_ino,
                "size": info.st_size,
            }
            if stat.S_ISLNK(info.st_mode):
                row["kind"] = "symlink"
                row["link"] = os.readlink(child)
            elif stat.S_ISDIR(info.st_mode):
                row["kind"] = "directory"
                pending.append(child)
            elif stat.S_ISREG(info.st_mode):
                row["kind"] = "file"
                # lstat+open no-follow: if a race swaps in a link, fail the fixture
                # rather than following it and reading an outside sentinel.
                flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
                fd = os.open(child, flags)
                try:
                    opened = os.fstat(fd)
                    if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                        raise AssertionError("workspace fixture changed during tree snapshot")
                    digest = hashlib.sha256()
                    while chunk := os.read(fd, 65536):
                        digest.update(chunk)
                    row["sha256"] = digest.hexdigest()
                finally:
                    os.close(fd)
            else:
                row["kind"] = "special"
            rows.append(row)
    return sorted(rows, key=lambda row: str(row["path"]))


@pytest.fixture
def workspace_root(tmp_path: Path) -> Path:
    root = tmp_path / "workspace-root"
    root.mkdir(mode=0o700)
    root.chmod(0o700)
    return root


@contextmanager
def workspace_client(harness, workspace_root: Path, *, fault_hook=None, cleanup_config=None):
    """Create a second API app sharing G4's isolated DB and authenticated session."""
    from tests.ifpmic_api.h2_fixture_cleanup import managed_test_client

    settings = replace(
        harness["settings"],
        workspace_root=str(workspace_root),
        workspace_lease_seconds=2,
        workspace_poll_seconds=1,
    )
    app = create_app(
        settings,
        bridge_runner=harness["bridge"],
        clock=harness["clock"],
        fault_hook=fault_hook,
    )
    with managed_test_client(TestClient(app, base_url=API_ORIGIN, follow_redirects=False),
                             app, cleanup_config) as client:
        client.cookies.set("ax_session", harness["session"], path="/")
        yield {**harness, "app": app, "client": client, "settings": settings,
               "workspace_root": workspace_root}


def accept_workspace_job(harness, *, key="g5-workspace-job", **payload_changes):
    payload = valid_create_job(harness, **payload_changes)
    response = harness["client"].post(
        "/api/v1/jobs", json=payload,
        headers=write_headers(harness, key=key),
    )
    assert response.status_code == 202
    receipt = response.json()
    assert receipt["status"] == "accepted"
    with psycopg.connect(owner_dsn(harness["database"])) as connection:
        row = connection.execute(
            """SELECT j.status,j.revision,j.cycle,j.current_step_ids,j.candidate_fingerprint,
                      c.status,c.applied_revision,c.error_code,o.state,w.command_id::text,
                      w.workspace_token::text,w.state,w.generation,w.claim_token::text,
                      w.claim_expires_at,w.error_code
                 FROM ifpmic.jobs j JOIN ifpmic.commands c USING(job_id)
                 JOIN ifpmic.commands_outbox o USING(command_id)
                 JOIN ifpmic.workspace_intents w USING(job_id)
                WHERE j.job_id=%s""",
            (receipt["resource_id"],),
        ).fetchone()
    assert row is not None
    assert row[:9] == ("DRAFT", 0, 0, [], None, "accepted", None, None, "pending")
    assert row[11:] == ("RESERVED", 0, None, None, None)
    return {"receipt": receipt, "job_id": receipt["resource_id"], "initial_row": row,
            "payload": payload}


def workspace_rows(harness, job_id: str) -> tuple:
    """Read the complete G4 acceptance group plus intent using independent owner role."""
    with psycopg.connect(owner_dsn(harness["database"])) as connection:
        return connection.execute(
            """SELECT j.owner_id::text,j.project_id,j.snapshot_id,j.workflow_id,
                      j.status,j.revision,j.cycle,j.current_step_ids,j.candidate_fingerprint,
                      c.actor_id::text,c.route,c.idempotency_key,c.command_payload_json,
                      c.payload_sha256,c.status,c.applied_revision,c.error_code,o.state,
                      w.command_id::text,w.workspace_token::text,w.state,w.generation,
                      w.claim_token::text,w.claim_expires_at,w.error_code
                 FROM ifpmic.jobs j JOIN ifpmic.commands c USING(job_id)
                 JOIN ifpmic.commands_outbox o USING(command_id)
                 JOIN ifpmic.workspace_intents w USING(job_id)
                WHERE j.job_id=%s""",
            (job_id,),
        ).fetchone()


def write_workspace_settings(settings, path: Path) -> None:
    """Serialize only the explicit private worker configuration for CLI tests."""
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
        "workspace_root": settings.workspace_root,
        "workspace_lease_seconds": settings.workspace_lease_seconds,
        "workspace_poll_seconds": settings.workspace_poll_seconds,
    }
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    with os.fdopen(descriptor, "w", encoding="ascii") as target:
        target.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")))
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


@pytest.fixture
def workspace_environment(g4_harness, workspace_root, request):
    with workspace_client(g4_harness, workspace_root, cleanup_config=request.config) as harness:
        yield harness
