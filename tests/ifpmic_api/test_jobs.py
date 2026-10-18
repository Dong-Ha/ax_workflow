"""G4 public job API tests using literal OpenAPI/plan oracles and isolated PG."""

from __future__ import annotations

import hashlib
import asyncio
import json
import uuid
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import base64
import hmac
from pathlib import Path
from http.client import HTTPConnection

import psycopg
import pytest
from fastapi.testclient import TestClient

pytest_plugins = ("tests.ifpmic_api.jobs_fixture",)

from tests.ifpmic_api.jobs_fixture import (
    API_ORIGIN,
    PROFILE_VERSION,
    PROJECT_ID,
    bridge_for,
    capture_snapshot,
    client_with,
    free_loopback_port,
    login,
    operator_dsn,
    owner_dsn,
    private_settings_file,
    runtime_dsn,
    seed_job_rows,
    seed_membership,
    seed_catalog_and_eligibility,
    seed_catalog_only,
    seed_profile_store,
    valid_create_job,
    wait_http_ready,
    write_headers,
)
from tests.ifpmic_api.test_auth import UI_ORIGIN


JOB_KEYS = {
    "job_id", "owner_id", "status", "revision", "cycle", "workflow_version",
    "current_step_ids", "candidate_fingerprint", "profile_version",
}
RECEIPT_KEYS = {"command_id", "status", "resource_id"}
COMMAND_STATUS_KEYS = {"command_id", "status", "applied_revision", "error"}
SNAPSHOT_KEYS = {"job", "steps", "last_event_id"}
RELEASE_MODES = {
    "team_github_tag", "shared_gerrit_change", "shared_github_pr", "shared_github_commit",
}


def _fixed_error(response, status: int, code: str):
    assert response.status_code == status
    value = response.json()
    assert set(value) == {"code", "message", "trace_id"}
    assert value["code"] == code and value["message"] == code
    uuid.UUID(value["trace_id"])
    assert response.headers.get("cache-control") == "no-store"
    assert response.headers.get("referrer-policy") == "no-referrer"


def _counts(harness):
    with psycopg.connect(owner_dsn(harness["database"])) as connection:
        return tuple(
            connection.execute(f"SELECT count(*) FROM ifpmic.{table}").fetchone()[0]
            for table in ("jobs", "commands", "commands_outbox", "workspace_intents")
        )


def _payload_sha(payload):
    body = json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False)
    envelope = json.dumps(
        {"format": "ifpmic.create-job.v1", "payload": payload},
        ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False,
    )
    return body, hashlib.sha256(envelope.encode("utf-8")).hexdigest()


def test_create_job_returns_original_openapi_dtos_and_persists_atomic_semantic_record(g4_harness):
    harness = g4_harness
    payload = valid_create_job(harness)
    before = _counts(harness)

    accepted = harness["client"].post(
        "/api/v1/jobs", json=payload, headers=write_headers(harness),
    )
    assert accepted.status_code == 202
    receipt = accepted.json()
    assert set(receipt) == RECEIPT_KEYS
    assert receipt["status"] == "accepted"
    uuid.UUID(receipt["command_id"])
    uuid.UUID(receipt["resource_id"])
    assert _counts(harness) == tuple(value + 1 for value in before)
    _record_cases(create=202)

    detail = harness["client"].get(f"/api/v1/jobs/{receipt['resource_id']}")
    assert detail.status_code == 200
    snapshot = detail.json()
    assert set(snapshot) == SNAPSHOT_KEYS
    assert snapshot["steps"] == []
    assert snapshot["last_event_id"] == ""
    job = snapshot["job"]
    assert set(job) == JOB_KEYS
    assert job == {
        "job_id": receipt["resource_id"],
        "owner_id": harness["user_id"],
        "status": "DRAFT",
        "revision": 0,
        "cycle": 0,
        "workflow_version": "ifpmic-sw-v1",
        "current_step_ids": [],
        "candidate_fingerprint": None,
        "profile_version": harness["profile_version"],
    }
    assert "project_id" not in job and "title" not in job

    command = harness["client"].get(f"/api/v1/commands/{receipt['command_id']}")
    assert command.status_code == 200
    assert set(command.json()) == COMMAND_STATUS_KEYS
    assert command.json() == {
        "command_id": receipt["command_id"], "status": "accepted",
        "applied_revision": None, "error": None,
    }

    expected_body_json, expected_sha = _payload_sha(payload)
    with psycopg.connect(owner_dsn(harness["database"])) as connection:
        rows = connection.execute(
            """SELECT j.owner_id::text,j.project_id,j.snapshot_id,j.workflow_id,j.status,j.revision,j.cycle,
                      j.current_step_ids,j.candidate_fingerprint,c.actor_id::text,c.route,c.idempotency_key,
                      c.command_payload_json,c.payload_sha256,c.status,c.applied_revision,c.error_code,
                      o.state,w.state
                 FROM ifpmic.jobs j JOIN ifpmic.commands c USING(job_id)
                 JOIN ifpmic.commands_outbox o USING(command_id)
                 JOIN ifpmic.workspace_intents w USING(job_id)
                WHERE j.job_id=%s""",
            (receipt["resource_id"],),
        ).fetchone()
    assert rows == (
        harness["user_id"], harness["project_id"], harness["record"].snapshot_id,
        "ifpmic-sw-v1", "DRAFT", 0, 0, [], None, harness["user_id"],
        "POST /api/v1/jobs", "g4-key-1", expected_body_json, expected_sha,
        "accepted", None, None, "pending", "RESERVED",
    )


@pytest.mark.parametrize("missing", [
    "project_id", "title", "request_text", "change_type", "base_ref",
    "input_artifact_ids", "profile_version", "release_mode",
])
def test_create_job_rejects_each_missing_original_required_field_atomically(g4_harness, missing):
    harness = g4_harness
    payload = valid_create_job(harness)
    payload.pop(missing)
    before = _counts(harness)
    response = harness["client"].post("/api/v1/jobs", json=payload, headers=write_headers(harness))
    _fixed_error(response, 422, "INVALID_REQUEST")
    assert _counts(harness) == before



@pytest.mark.parametrize("mutation", [
    "owner_id", "workflow_version", "eligibility", "profile_json", "unknown",
])
def test_create_job_rejects_all_untrusted_or_unknown_fields(g4_harness, mutation):
    harness = g4_harness
    payload = valid_create_job(harness)
    key = {
        "owner_id": "owner_id", "workflow_version": "workflow_version",
        "eligibility": "eligibility", "profile_json": "profile",
        "unknown": "surprise",
    }[mutation]
    payload[key] = "attacker-controlled"
    before = _counts(harness)
    response = harness["client"].post("/api/v1/jobs", json=payload, headers=write_headers(harness))
    _fixed_error(response, 422, "INVALID_REQUEST")
    assert _counts(harness) == before


@pytest.mark.parametrize("change_type", ["NEW_HW", "FEATURE", "BUGFIX"])
@pytest.mark.parametrize("release_mode", sorted(RELEASE_MODES))
def test_original_create_job_enums_are_accepted(g4_harness, change_type, release_mode):
    harness = g4_harness
    payload = valid_create_job(harness, change_type=change_type, release_mode=release_mode)
    key = f"enum-{change_type}-{release_mode}"
    response = harness["client"].post("/api/v1/jobs", json=payload, headers=write_headers(harness, key=key))
    assert response.status_code == 202
    assert response.json()["status"] == "accepted"


@pytest.mark.parametrize("value", ["OTHER", "", None, 1])
def test_invalid_original_enum_values_are_rejected_without_rows(g4_harness, value):
    harness = g4_harness
    before = _counts(harness)
    payload = valid_create_job(harness, change_type=value)
    response = harness["client"].post("/api/v1/jobs", json=payload, headers=write_headers(harness))
    _fixed_error(response, 422, "INVALID_REQUEST")
    assert _counts(harness) == before


@pytest.mark.parametrize("raw", [
    b'{"project_id":"x","project_id":"y"}',
    b'{"project_id":"x","title":"t","request_text":"r","change_type":"FEATURE","base_ref":"main","input_artifact_ids":[],"profile_version":"v","release_mode":"team_github_tag","owner_id":"x"}',
    b'{"project_id":"x","title":"t","request_text":"r","change_type":"FEATURE","base_ref":"main","input_artifact_ids":[],"profile_version":"v","release_mode":"team_github_tag","nested":{"x":{"x":{"x":{"x":0}}}}}',
    b'{"project_id":"x","title":"t","request_text":NaN,"change_type":"FEATURE","base_ref":"main","input_artifact_ids":[],"profile_version":"v","release_mode":"team_github_tag"}',
    b'{"project_id":"\xff"}',
])
def test_malformed_duplicate_nonfinite_deep_or_invalid_utf8_bodies_are_fixed_errors(g4_harness, raw):
    harness = g4_harness
    before = _counts(harness)
    headers = write_headers(harness)
    headers["Content-Type"] = "application/json"
    response = harness["client"].post("/api/v1/jobs", content=raw, headers=headers)
    _fixed_error(response, 422, "INVALID_REQUEST")
    assert _counts(harness) == before


def test_create_transport_headers_and_authentication_boundaries(g4_harness):
    harness = g4_harness
    payload = valid_create_job(harness)
    body = json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
    base_headers = [("Origin", UI_ORIGIN), ("X-CSRF-Token", harness["csrf"]),
                    ("Cookie", "ax_session=" + harness["session"]),
                    ("Content-Type", "application/json")]
    before = _counts(harness)

    cases = [
        ("missing-idempotency", base_headers, 422, "INVALID_REQUEST"),
        ("duplicate-idempotency", base_headers + [("Idempotency-Key", "a"), ("Idempotency-Key", "b")],
         422, "INVALID_REQUEST"),
        ("empty-idempotency", base_headers + [("Idempotency-Key", "")], 422, "INVALID_REQUEST"),
        ("long-idempotency", base_headers + [("Idempotency-Key", "x" * 129)], 422, "INVALID_REQUEST"),
        ("identity-content-encoding", base_headers + [("Content-Encoding", "identity"),
         ("Idempotency-Key", "header-identity")], 202, None),
        ("utf8-charset", base_headers[:-1] + [("Content-Type", "application/json; charset=utf-8"),
         ("Idempotency-Key", "header-charset")], 202, None),
        ("unsupported-content-encoding", base_headers + [("Content-Encoding", "gzip"),
         ("Idempotency-Key", "header-gzip")], 422, "INVALID_REQUEST"),
        ("unsupported-content-type", base_headers[:-1] + [("Content-Type", "text/plain"),
         ("Idempotency-Key", "header-text-plain")], 422, "INVALID_REQUEST"),
        ("duplicate-content-encoding", base_headers + [("Content-Encoding", "identity"),
         ("Content-Encoding", "identity"), ("Idempotency-Key", "header-duplicate-encoding")],
         422, "INVALID_REQUEST"),
        ("duplicate-content-type", base_headers + [("Content-Type", "text/plain"),
         ("Idempotency-Key", "header-duplicate-content-type")], 422, "INVALID_REQUEST"),
    ]
    accepted = 0
    for label, headers, status, code in cases:
        if label in {"identity-content-encoding", "utf8-charset"}:
            assert status == 202
            response = harness["client"].request("POST", "/api/v1/jobs", content=body, headers=headers)
            assert response.status_code == 202
            accepted += 1
            continue
        response = harness["client"].request("POST", "/api/v1/jobs", content=body, headers=headers)
        _fixed_error(response, status, code)
        assert _counts(harness) == tuple(value + accepted for value in before)

    valid_1 = base_headers + [("Idempotency-Key", "x")]
    valid_space = base_headers + [("Idempotency-Key", "key with spaces")]
    valid_128 = base_headers + [("Idempotency-Key", "k" * 128)]
    for index, headers in enumerate((valid_1, valid_space, valid_128)):
        response = harness["client"].request("POST", "/api/v1/jobs", content=body, headers=headers)
        assert response.status_code == 202
        assert response.json()["status"] == "accepted"
        assert _counts(harness) == tuple(value + accepted + index + 1 for value in before)

    with TestClient(harness["app"], base_url=API_ORIGIN, follow_redirects=False) as unauthenticated:
        no_auth = [("Origin", UI_ORIGIN),
                   ("Content-Type", "application/json"), ("Idempotency-Key", "no-auth")]
        response = unauthenticated.request("POST", "/api/v1/jobs", content=b"not-json", headers=no_auth)
        _fixed_error(response, 401, "AUTH_REQUIRED")
    bad_origin = [("Origin", "https://attacker.invalid"), ("X-CSRF-Token", harness["csrf"]),
                  ("Cookie", "ax_session=" + harness["session"]), ("Content-Type", "application/json"),
                  ("Idempotency-Key", "bad-origin")]
    response = harness["client"].request("POST", "/api/v1/jobs", content=b"not-json", headers=bad_origin)
    _fixed_error(response, 403, "ORIGIN_FORBIDDEN")
    bad_csrf = [("Origin", UI_ORIGIN), ("X-CSRF-Token", "wrong"),
                ("Cookie", "ax_session=" + harness["session"]), ("Content-Type", "application/json"),
                ("Idempotency-Key", "bad-csrf")]
    response = harness["client"].request("POST", "/api/v1/jobs", content=b"not-json", headers=bad_csrf)
    _fixed_error(response, 403, "CSRF_INVALID")
    response = harness["client"].post(
        "/api/v1/jobs?unexpected=1", content=body,
        headers={**write_headers(harness, key="post-query"), "Content-Type": "application/json"},
    )
    _fixed_error(response, 422, "INVALID_REQUEST")
    assert _counts(harness) == tuple(value + 5 for value in before)

    # The HTTP client rejects C0 bytes before transmission, so exercise the
    # ASGI boundary with a faithful raw-header scope to prove its own contract.
    async def raw_asgi(headers):
        response = []
        sent = False
        async def receive():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": body.encode("ascii"), "more_body": False}
            return {"type": "http.disconnect"}
        async def send(message):
            response.append(message)
        scope = {
            "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1", "method": "POST", "scheme": "http",
            "path": "/api/v1/jobs", "raw_path": b"/api/v1/jobs", "query_string": b"",
            "root_path": "", "headers": headers,
            "client": ("127.0.0.1", 43210), "server": ("127.0.0.1", 18321),
        }
        await harness["app"](scope, receive, send)
        start = next(message for message in response if message["type"] == "http.response.start")
        return start["status"]

    for invalid_key in (b"bad\x1fkey", b"non-ascii-\xff"):
        control_headers = [
            (b"host", b"127.0.0.1:18321"), (b"origin", UI_ORIGIN.encode("ascii")),
            (b"cookie", ("ax_session=" + harness["session"]).encode("ascii")),
            (b"x-csrf-token", harness["csrf"].encode("ascii")),
            (b"content-type", b"application/json"), (b"idempotency-key", invalid_key),
        ]
        assert asyncio.run(raw_asgi(control_headers)) == 422
    assert _counts(harness) == tuple(value + 5 for value in before)


def test_create_body_accepts_exact_limit_and_scans_depth_boundary(g4_harness):
    harness = g4_harness
    limit = 8 * 1024 * 1024
    payload = valid_create_job(harness, request_text="")
    encoded = json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
    payload["request_text"] = "a" * (limit - len(encoded.encode("ascii")))
    raw = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("ascii")
    assert len(raw) == limit
    headers = write_headers(harness, key="exact-eight-mib")
    headers["Content-Type"] = "application/json"
    before = _counts(harness)
    accepted = harness["client"].post("/api/v1/jobs", content=raw, headers=headers)
    assert accepted.status_code == 202
    assert _counts(harness) == tuple(value + 1 for value in before)

    valid = valid_create_job(harness)
    tail = b"," + json.dumps({key: value for key, value in valid.items() if key != "project_id"},
                              ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("ascii")[1:]
    prefix = b'{"project_id":"' + harness["project_id"].encode("ascii") + b'"'
    for depth, expected_code in ((63, "INVALID_REQUEST"), (64, "REQUEST_TOO_LARGE")):
        nested = b',"extra":' + b"[" * depth + b"0" + b"]" * depth
        body = prefix + nested + tail
        before = _counts(harness)
        response = harness["client"].post(
            "/api/v1/jobs", content=body,
            headers={**write_headers(harness, key=f"depth-{depth}"), "Content-Type": "application/json"},
        )
        _fixed_error(response, 422, expected_code)
        assert _counts(harness) == before

    duplicate_tail = json.dumps({key: value for key, value in valid.items() if key != "project_id"},
                                ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("ascii")[1:]
    duplicate = (b'{"project_id":"' + harness["project_id"].encode("ascii") +
                 b'","project_\\u0069d":"' + harness["project_id"].encode("ascii") + b'",' + duplicate_tail)
    before = _counts(harness)
    response = harness["client"].post(
        "/api/v1/jobs", content=duplicate,
        headers={**write_headers(harness, key="escaped-duplicate-key"), "Content-Type": "application/json"},
    )
    _fixed_error(response, 422, "INVALID_REQUEST")
    assert _counts(harness) == before

    invalid_utf8 = json.dumps(valid, ensure_ascii=True, separators=(",", ":")).encode("ascii")
    invalid_utf8 = invalid_utf8.replace(b'"title":"G4 synthetic job"', b'"title":"\xff"')
    response = harness["client"].post(
        "/api/v1/jobs", content=invalid_utf8,
        headers={**write_headers(harness, key="invalid-utf8-title"), "Content-Type": "application/json"},
    )
    _fixed_error(response, 422, "INVALID_REQUEST")
    assert _counts(harness) == before


def test_original_string_scalar_control_and_type_matrix_is_atomic(g4_harness):
    harness = g4_harness
    vectors = [
        ("project-id-surrogate", {"project_id": "bad-\ud800"}),
        ("project-id-empty", {"project_id": ""}),
        ("title-empty", {"title": ""}),
        ("request-text-empty", {"request_text": ""}),
        ("base-ref-empty", {"base_ref": ""}),
        ("profile-version-empty", {"profile_version": ""}),
        ("title-nul", {"title": "bad\x00title"}),
        ("request-text-nul", {"request_text": "bad\x00text"}),
        ("base-ref-del", {"base_ref": "bad\x7fref"}),
        ("profile-version-control", {"profile_version": "bad\x01version"}),
        ("artifact-list-null", {"input_artifact_ids": None}),
        ("artifact-item-noncanonical", {"input_artifact_ids": ["A0000000-0000-0000-0000-000000000001"]}),
        ("project-wrongtype", {"project_id": 9}),
        ("request-wrongtype", {"request_text": []}),
        ("change-wrongtype", {"change_type": True}),
        ("release-wrongtype", {"release_mode": {"value": "team_github_tag"}}),
    ]
    for index, (label, mutation) in enumerate(vectors):
        before = _counts(harness)
        payload = valid_create_job(harness, **mutation)
        response = harness["client"].post(
            "/api/v1/jobs",
            content=json.dumps(payload, ensure_ascii=True, sort_keys=True,
                               separators=(",", ":"), allow_nan=False).encode("ascii"),
            headers={**write_headers(harness, key=f"original-field-{index}-{label}"),
                     "Content-Type": "application/json"},
        )
        _fixed_error(response, 422, "INVALID_REQUEST")
        assert _counts(harness) == before


def test_request_body_size_over_limit_has_fixed_error_and_no_partial_rows(g4_harness):
    harness = g4_harness
    before = _counts(harness)
    raw = b"{" + (b" " * (8 * 1024 * 1024)) + b"}"
    headers = write_headers(harness)
    headers["Content-Type"] = "application/json"
    response = harness["client"].post("/api/v1/jobs", content=raw, headers=headers)
    _fixed_error(response, 422, "REQUEST_TOO_LARGE")
    assert _counts(harness) == before


def test_lone_surrogate_and_astral_semantic_text_round_trip_in_ascii_payload(g4_harness):
    harness = g4_harness
    payload = valid_create_job(harness, title="rev-\ud800-😀", request_text="tab\tnewline\nkept")
    headers = write_headers(harness)
    headers["Content-Type"] = "application/json"
    response = harness["client"].post(
        "/api/v1/jobs", content=json.dumps(payload, ensure_ascii=True, sort_keys=True,
                                           separators=(",", ":")).encode("ascii"), headers=headers,
    )
    assert response.status_code == 202
    expected_body_json, expected_sha = _payload_sha(payload)
    with psycopg.connect(owner_dsn(harness["database"])) as connection:
        stored = connection.execute(
            "SELECT command_payload_json,payload_sha256 FROM ifpmic.commands WHERE command_id=%s",
            (response.json()["command_id"],),
        ).fetchone()
    assert stored == (expected_body_json, expected_sha)
    assert "\\ud800" in stored[0] and "😀" in json.loads(stored[0])["title"]


def test_same_key_replays_original_receipt_different_body_conflicts_and_different_key_is_new(g4_harness):
    harness = g4_harness
    payload = valid_create_job(harness)
    first = harness["client"].post("/api/v1/jobs", json=payload, headers=write_headers(harness, key="same-key"))
    assert first.status_code == 202
    count_after_first = _counts(harness)
    replay = harness["client"].post("/api/v1/jobs", json=payload, headers=write_headers(harness, key="same-key"))
    assert replay.status_code == 202 and replay.json() == first.json()
    assert _counts(harness) == count_after_first

    changed = valid_create_job(harness, title="different body")
    conflict = harness["client"].post("/api/v1/jobs", json=changed, headers=write_headers(harness, key="same-key"))
    _fixed_error(conflict, 409, "IDEMPOTENCY_CONFLICT")
    assert _counts(harness) == count_after_first

    independent = harness["client"].post("/api/v1/jobs", json=payload, headers=write_headers(harness, key="other-key"))
    assert independent.status_code == 202
    assert independent.json()["resource_id"] != first.json()["resource_id"]
    assert _counts(harness) == tuple(value + 1 for value in count_after_first)
    _record_cases(same_key_replay=202, same_key_conflict=409)


def test_original_replay_survives_revocation_file_loss_and_create_capability_removal(g4_harness):
    harness = g4_harness
    payload = valid_create_job(harness, title="replay-after-current-authority-change")
    key = "replay-after-current-authority-change"
    first = harness["client"].post("/api/v1/jobs", json=payload,
                                   headers=write_headers(harness, key=key))
    assert first.status_code == 202
    after_accept = _counts(harness)
    with psycopg.connect(operator_dsn(harness["database"]), autocommit=True) as connection:
        connection.execute(
            "INSERT INTO ifpmic.profile_revocations(project_id,eligibility_id,revoked_at) VALUES(%s,%s,%s)",
            (harness["project_id"], harness["eligibility_id"], harness["clock"]()),
        )
        connection.execute(
            "UPDATE ifpmic.memberships SET capabilities=%s WHERE project_id=%s AND user_id=%s",
            ([], harness["project_id"], harness["user_id"]),
        )
    snapshot_path = Path(harness["store_root"]) / f"{harness['record'].version_key}.snapshot.json"
    snapshot_path.unlink()
    assert not snapshot_path.exists()

    replay = harness["client"].post("/api/v1/jobs", json=payload,
                                    headers=write_headers(harness, key=key))
    assert replay.status_code == 202 and replay.json() == first.json()
    conflict = harness["client"].post(
        "/api/v1/jobs", json=valid_create_job(harness, title="different accepted body"),
        headers=write_headers(harness, key=key),
    )
    _fixed_error(conflict, 409, "IDEMPOTENCY_CONFLICT")
    assert _counts(harness) == after_accept

    # Current active membership remains necessary for replay, even though
    # request.create capability and the current snapshot were removed above.
    with psycopg.connect(operator_dsn(harness["database"]), autocommit=True) as connection:
        connection.execute(
            "UPDATE ifpmic.memberships SET active=false WHERE project_id=%s AND user_id=%s",
            (harness["project_id"], harness["user_id"]),
        )
    inactive_replay = harness["client"].post(
        "/api/v1/jobs", json=payload, headers=write_headers(harness, key=key),
    )
    _fixed_error(inactive_replay, 403, "FORBIDDEN")
    assert _counts(harness) == after_accept


def test_artifact_ids_must_be_existing_available_owned_by_actor_and_project(g4_harness):
    harness = g4_harness
    artifact_a = str(uuid.uuid4())
    artifact_b = str(uuid.uuid4())
    artifact_pending = str(uuid.uuid4())
    artifact_rejected = str(uuid.uuid4())
    other_project_artifact = str(uuid.uuid4())
    foreign_owner = str(uuid.uuid4())
    other_project = "g4-other-project"
    with psycopg.connect(owner_dsn(harness["database"]), autocommit=True) as connection:
        connection.execute(
            "INSERT INTO ifpmic.users(user_id,identity_subject,display_name) VALUES(%s,%s,%s)",
            (foreign_owner, "g4-foreign-artifact-owner", "G4 foreign artifact owner"),
        )
    with psycopg.connect(operator_dsn(harness["database"]), autocommit=True) as connection:
        connection.execute("INSERT INTO ifpmic.projects(project_id) VALUES(%s)", (other_project,))
        connection.cursor().executemany(
            """INSERT INTO ifpmic.artifacts(artifact_id,project_id,owner_id,state,sha256,size)
               VALUES(%s,%s,%s,%s,%s,1)""",
            [
                (artifact_a, PROJECT_ID, harness["user_id"], "available", "1" * 64),
                (artifact_b, PROJECT_ID, foreign_owner, "available", "2" * 64),
                (other_project_artifact, other_project, harness["user_id"], "available", "3" * 64),
                (artifact_pending, PROJECT_ID, harness["user_id"], "pending", "4" * 64),
                (artifact_rejected, PROJECT_ID, harness["user_id"], "rejected", "5" * 64),
            ],
        )
    payload = valid_create_job(harness, input_artifact_ids=[artifact_a, artifact_a])
    accepted = harness["client"].post("/api/v1/jobs", json=payload, headers=write_headers(harness))
    assert accepted.status_code == 202
    expected_body_json, expected_sha = _payload_sha(payload)
    with psycopg.connect(owner_dsn(harness["database"])) as connection:
        stored = connection.execute(
            "SELECT command_payload_json,payload_sha256 FROM ifpmic.commands WHERE command_id=%s",
            (accepted.json()["command_id"],),
        ).fetchone()
    assert stored == (expected_body_json, expected_sha)
    assert json.loads(stored[0])["input_artifact_ids"] == [artifact_a, artifact_a]

    for index, ids in enumerate(([str(uuid.uuid4())], [artifact_b], [other_project_artifact],
                                 [artifact_pending], [artifact_rejected], ["not-a-uuid"])):
        before = _counts(harness)
        response = harness["client"].post(
            "/api/v1/jobs", json=valid_create_job(harness, input_artifact_ids=ids),
            headers=write_headers(harness, key=f"artifact-invalid-{index}"),
        )
        expected = "INVALID_REQUEST" if ids == ["not-a-uuid"] else "FORBIDDEN"
        _fixed_error(response, 422 if expected == "INVALID_REQUEST" else 403, expected)
        assert _counts(harness) == before


def test_authorization_is_current_session_membership_and_one_job_read_delegation_only(g4_harness):
    harness = g4_harness
    owner = harness["client"]
    accepted = owner.post(
        "/api/v1/jobs", json=valid_create_job(harness), headers=write_headers(harness),
    )
    assert accepted.status_code == 202
    receipt = accepted.json()
    owner_id = harness["user_id"]

    _app_b, client_b = client_with(harness)
    try:
        # Avoid passing A's cookie during B's login, which would intentionally
        # rotate/revoke that session under the G3 contract.
        client_b.cookies.clear()
        user_b, session_b, csrf_b = login(client_b, harness["provider"], harness["clock"], "g4-user-b")
        seed_membership(harness["database"], PROJECT_ID, user_b, active=True, capabilities=())
        own_job = seed_job_rows(harness, 1, owner_id=user_b)[0]
        with psycopg.connect(owner_dsn(harness["database"])) as connection:
            own_command = connection.execute(
                "SELECT command_id::text FROM ifpmic.commands WHERE job_id=%s", (own_job,),
            ).fetchone()[0]
        own_detail = client_b.get(f"/api/v1/jobs/{own_job}")
        own_status = client_b.get(f"/api/v1/commands/{own_command}")
        assert own_detail.status_code == own_status.status_code == 200
        assert own_detail.json()["job"]["owner_id"] == user_b

        denied_detail = client_b.get(f"/api/v1/jobs/{receipt['resource_id']}")
        _fixed_error(denied_detail, 403, "FORBIDDEN")
        denied_command = client_b.get(f"/api/v1/commands/{receipt['command_id']}")
        _fixed_error(denied_command, 403, "FORBIDDEN")
        missing_detail = client_b.get(f"/api/v1/jobs/{uuid.uuid4()}")
        malformed_detail = client_b.get("/api/v1/jobs/not-a-uuid")
        _fixed_error(missing_detail, 403, "FORBIDDEN")
        _fixed_error(malformed_detail, 403, "FORBIDDEN")
        assert set(missing_detail.json()) == set(malformed_detail.json())
        _record_cases(unauthorized=403)
        no_create = client_b.post(
            "/api/v1/jobs", json=valid_create_job(harness),
            headers=write_headers(harness, key="b-no-create", session=session_b, csrf=csrf_b),
        )
        _fixed_error(no_create, 403, "FORBIDDEN")

        with psycopg.connect(operator_dsn(harness["database"]), autocommit=True) as connection:
            connection.execute(
                "INSERT INTO ifpmic.job_delegations(project_id,job_id,user_id,action,expires_at) "
                "VALUES(%s,%s,%s,'job.read',%s)",
                (PROJECT_ID, receipt["resource_id"], user_b, harness["clock"]() + timedelta(hours=1)),
            )
        delegated_detail = client_b.get(f"/api/v1/jobs/{receipt['resource_id']}")
        assert delegated_detail.status_code == 200
        assert delegated_detail.json()["job"]["owner_id"] == owner_id
        delegated_command = client_b.get(f"/api/v1/commands/{receipt['command_id']}")
        assert delegated_command.status_code == 200
        assert delegated_command.json()["command_id"] == receipt["command_id"]

        with psycopg.connect(operator_dsn(harness["database"]), autocommit=True) as connection:
            connection.execute(
                "UPDATE ifpmic.job_delegations SET expires_at=%s "
                "WHERE project_id=%s AND job_id=%s AND user_id=%s",
                (harness["clock"](), PROJECT_ID, receipt["resource_id"], user_b),
            )
        expired = client_b.get(f"/api/v1/jobs/{receipt['resource_id']}")
        _fixed_error(expired, 403, "FORBIDDEN")
        expired_command = client_b.get(f"/api/v1/commands/{receipt['command_id']}")
        _fixed_error(expired_command, 403, "FORBIDDEN")

        still_no_create = client_b.post(
            "/api/v1/jobs", json=valid_create_job(harness),
            headers=write_headers(harness, key="b-still-no-create", session=session_b, csrf=csrf_b),
        )
        _fixed_error(still_no_create, 403, "FORBIDDEN")

        with psycopg.connect(operator_dsn(harness["database"]), autocommit=True) as connection:
            connection.execute(
                "UPDATE ifpmic.job_delegations SET revoked_at=%s WHERE project_id=%s AND job_id=%s AND user_id=%s",
                (harness["clock"](), PROJECT_ID, receipt["resource_id"], user_b),
            )
        revoked = client_b.get(f"/api/v1/jobs/{receipt['resource_id']}")
        _fixed_error(revoked, 403, "FORBIDDEN")
        _record_cases(owner_without_create_can_read=200, hidden_detail=403,
                      delegated_read=200, revoked_delegation=403)
    finally:
        client_b.close()


def test_owner_and_project_cannot_be_spoofed_by_identity_headers_or_request_body(g4_harness):
    harness = g4_harness
    forged = valid_create_job(harness)
    forged["owner_id"] = str(uuid.uuid4())
    before = _counts(harness)
    bad_body = harness["client"].post("/api/v1/jobs", json=forged, headers=write_headers(harness))
    _fixed_error(bad_body, 422, "INVALID_REQUEST")
    assert _counts(harness) == before

    valid = harness["client"].post(
        "/api/v1/jobs", json=valid_create_job(harness),
        headers={**write_headers(harness, key="header-spoof"), "X-User-ID": "victim",
                 "X-Owner-ID": "victim", "X-Company-ID": "other", "X-Worker": "true"},
    )
    assert valid.status_code == 202
    snapshot = harness["client"].get(f"/api/v1/jobs/{valid.json()['resource_id']}").json()
    assert snapshot["job"]["owner_id"] == harness["user_id"]


@pytest.mark.parametrize(("hook", "committed"), [
    ("job_after_guard_lock", False),
    ("job_after_membership_lock", False),
    ("job_before_insert", False),
    ("job_after_insert", False),
    ("command_before_insert", False),
    ("command_after_insert", False),
    ("outbox_before_insert", False),
    ("outbox_after_insert", False),
    ("intent_before_insert", False),
    ("intent_after_insert", False),
    ("job_before_commit", False),
    ("job_after_commit", True),
    ("job_before_response", True),
])
def test_job_fault_boundaries_are_all_or_none_and_retry_recovers_committed_receipt(g4_harness, hook, committed):
    harness = g4_harness

    class OneShotFault:
        fired = False

        def __call__(self, name):
            if name == hook and not self.fired:
                self.fired = True
                raise RuntimeError("g4-private-fault-canary")

    fault = OneShotFault()
    _app, client = client_with(harness, fault_hook=fault)
    try:
        before = _counts(harness)
        payload = valid_create_job(harness, title=f"fault-{hook}")
        key = f"fault-{hook}"
        response = client.post("/api/v1/jobs", json=payload, headers=write_headers(harness, key=key))
        assert response.status_code == 503
        expected_code = "COMMIT_UNCERTAIN" if committed else "DEPENDENCY_UNAVAILABLE"
        _fixed_error(response, 503, expected_code)
        assert fault.fired
        after = _counts(harness)
        if committed:
            assert after == tuple(value + 1 for value in before)
            replay = client.post("/api/v1/jobs", json=payload, headers=write_headers(harness, key=key))
            assert replay.status_code == 202
            receipt = replay.json()
            assert set(receipt) == RECEIPT_KEYS and receipt["status"] == "accepted"
            assert _counts(harness) == after
            _record_cases(fault_postcommit=503, retry_original_receipt=202)
        else:
            assert after == before
            _record_cases(fault_precommit=503)
    finally:
        client.close()


def test_database_commit_ack_loss_is_uncertain_and_replay_finds_committed_group(g4_harness):
    """Real PG commit followed by a test-wrapper acknowledgement failure."""
    harness = g4_harness
    state = {"armed": False, "injected": False}

    class TransactionWithLostAcknowledgement:
        def __init__(self, transaction):
            self.transaction = transaction

        def __enter__(self):
            return self.transaction.__enter__()

        def __exit__(self, exc_type, exc, traceback):
            result = self.transaction.__exit__(exc_type, exc, traceback)
            if exc_type is None and state["armed"]:
                state["armed"] = False
                state["injected"] = True
                raise psycopg.OperationalError("g4-private-commit-ack-canary")
            return result

    class WrappedConnection:
        def __init__(self, connection):
            self.connection = connection

        def __getattr__(self, name):
            return getattr(self.connection, name)

        def transaction(self, *args, **kwargs):
            return TransactionWithLostAcknowledgement(self.connection.transaction(*args, **kwargs))

    class ConnectionContext:
        def __enter__(self):
            self.connection = psycopg.connect(runtime_dsn(harness["database"]), autocommit=True)
            return WrappedConnection(self.connection)

        def __exit__(self, exc_type, exc, traceback):
            self.connection.close()

    def db_factory():
        return ConnectionContext()

    def hook(name):
        if name == "job_before_commit" and not state["injected"]:
            state["armed"] = True

    from services.ifpmic_api.app import create_app
    app = create_app(
        harness["settings"], db_factory=db_factory, bridge_runner=harness["bridge"],
        clock=harness["clock"], fault_hook=hook,
    )
    with TestClient(app, base_url=API_ORIGIN, follow_redirects=False) as client:
        client.cookies.set("ax_session", harness["session"], path="/")
        payload = valid_create_job(harness, title="g4-commit-ack-loss")
        key = "g4-commit-ack-loss"
        before = _counts(harness)
        lost = client.post("/api/v1/jobs", json=payload, headers=write_headers(harness, key=key))
        _fixed_error(lost, 503, "COMMIT_UNCERTAIN")
        assert state == {"armed": False, "injected": True}
        committed = _counts(harness)
        assert committed == tuple(value + 1 for value in before)
        replay = client.post("/api/v1/jobs", json=payload, headers=write_headers(harness, key=key))
        assert replay.status_code == 202 and replay.json()["status"] == "accepted"
        assert set(replay.json()) == RECEIPT_KEYS
        assert _counts(harness) == committed
        with psycopg.connect(owner_dsn(harness["database"])) as connection:
            group = connection.execute(
                """SELECT j.job_id::text,c.command_id::text,o.state,w.state
                     FROM ifpmic.jobs j JOIN ifpmic.commands c USING(job_id)
                     JOIN ifpmic.commands_outbox o USING(command_id)
                     JOIN ifpmic.workspace_intents w USING(job_id)
                    WHERE c.idempotency_key=%s""",
                (key,),
            ).fetchone()
        assert group == (replay.json()["resource_id"], replay.json()["command_id"], "pending", "RESERVED")
    _record_cases(fault_postcommit=503)


def test_ineligible_profile_and_membership_rejection_have_no_acceptance_rows(g4_harness):
    harness = g4_harness
    before = _counts(harness)
    with psycopg.connect(owner_dsn(harness["database"]), autocommit=True) as connection:
        connection.execute(
            "INSERT INTO ifpmic.profile_revocations(eligibility_id,project_id,revoked_at) VALUES(%s,%s,%s)",
            (harness["eligibility_id"], harness["project_id"], harness["clock"]()),
        )
    response = harness["client"].post(
        "/api/v1/jobs", json=valid_create_job(harness), headers=write_headers(harness),
    )
    _fixed_error(response, 422, "PROFILE_INELIGIBLE")
    assert _counts(harness) == before


def test_snapshot_eligibility_boundaries_and_catalog_metadata_are_fail_closed(g4_harness, tmp_path):
    harness = g4_harness
    cases = [
        ("missing-grant", "g4-missing-grant", True, True, "PROFILE_INELIGIBLE"),
        ("expiry-equals-now", "g4-expiry-boundary", True, True, "PROFILE_INELIGIBLE"),
        ("future-grant", "g4-future-grant", True, True, "PROFILE_INELIGIBLE"),
        ("disabled-snapshot", "g4-disabled-snapshot", False, True, "PROFILE_INELIGIBLE"),
        ("incomplete-snapshot", "g4-incomplete-snapshot", True, False, "PROFILE_INELIGIBLE"),
        ("missing-catalog", "g4-missing-catalog", True, True, "PROFILE_INELIGIBLE"),
    ]
    for index, (case, project_id, enabled, complete, expected_code) in enumerate(cases):
        store = harness["store_root"]
        seed_profile_store(store, project_id=project_id, profile_version=f"profile-{index}",
                           enabled=enabled, configuration_incomplete=not complete)
        record = capture_snapshot(store, project_id, f"profile-{index}")
        assert record.enabled is enabled
        assert record.configuration_complete is complete
        if case == "missing-grant":
            seed_catalog_only(harness["database"], record)
        elif case != "missing-catalog":
            grant_options = {}
            if case == "expiry-equals-now":
                grant_options["expires_at"] = harness["clock"]()
            elif case == "future-grant":
                grant_options["granted_at"] = harness["clock"]() + timedelta(seconds=1)
            seed_catalog_and_eligibility(harness["database"], record, **grant_options)
        seed_membership(harness["database"], project_id, harness["user_id"])
        before = _counts(harness)
        response = harness["client"].post(
            "/api/v1/jobs", json=valid_create_job(harness, project_id=project_id,
                                                  profile_version=f"profile-{index}"),
            headers=write_headers(harness, key=f"eligibility-{case}"),
        )
        _fixed_error(response, 422, expected_code)
        assert _counts(harness) == before

    real_origin = "https://api.g4.invalid"
    real_ui = "https://ui.g4.invalid"
    wrong_mode_settings = replace(
        harness["settings"], mode="real", api_origin=real_origin, issuer="https://issuer.g4.invalid",
        authorization_endpoint="https://issuer.g4.invalid/authorize",
        token_endpoint="https://issuer.g4.invalid/token", jwks_uri="https://issuer.g4.invalid/jwks",
        redirect_uri=real_origin + "/auth/callback", post_login_url=real_ui + "/ifpmic.html",
        allowed_ui_origins=(real_ui,),
    )
    from services.ifpmic_api.app import create_app
    wrong_mode_client = TestClient(
        create_app(wrong_mode_settings, bridge_runner=harness["bridge"], clock=harness["clock"]),
        base_url=real_origin, follow_redirects=False,
    )
    wrong_mode_client.cookies.set("ax_session", harness["session"], path="/")
    try:
        before = _counts(harness)
        response = wrong_mode_client.post(
            "/api/v1/jobs", json=valid_create_job(harness),
            headers={"Origin": real_ui, "X-CSRF-Token": harness["csrf"],
                     "Idempotency-Key": "wrong-runtime-mode"},
        )
        _fixed_error(response, 422, "PROFILE_INELIGIBLE")
        assert _counts(harness) == before
    finally:
        wrong_mode_client.close()

    # Deactivation is current authority and must also block, even though a
    # valid snapshot/grant and prior authenticated session still exist.
    with psycopg.connect(operator_dsn(harness["database"]), autocommit=True) as connection:
        connection.execute(
            "UPDATE ifpmic.memberships SET active=false WHERE project_id=%s AND user_id=%s",
            (harness["project_id"], harness["user_id"]),
        )
    denied = harness["client"].post(
        "/api/v1/jobs", json=valid_create_job(harness), headers=write_headers(harness, key="inactive-membership"),
    )
    _fixed_error(denied, 403, "FORBIDDEN")
    assert _counts(harness) == before


def test_session_and_grant_expiry_are_rechecked_after_authority_lock_wait(g4_harness):
    harness = g4_harness
    before = _counts(harness)
    frozen_now = harness["clock"]()
    with psycopg.connect(operator_dsn(harness["database"]), autocommit=True) as connection:
        connection.execute(
            "INSERT INTO ifpmic.profile_revocations(project_id,eligibility_id,revoked_at) VALUES(%s,%s,%s)",
            (harness["project_id"], harness["eligibility_id"], frozen_now),
        )
    _, short_grant_id = seed_catalog_and_eligibility(
        harness["database"], harness["record"], expires_at=frozen_now + timedelta(seconds=1),
    )

    grant_wait_fired = {"value": False}
    def expire_grant_after_guard(name):
        if name == "job_after_guard_lock" and not grant_wait_fired["value"]:
            grant_wait_fired["value"] = True
            harness["clock"].advance(seconds=2)

    _app, client = client_with(harness, fault_hook=expire_grant_after_guard)
    try:
        grant_expired = client.post(
            "/api/v1/jobs", json=valid_create_job(harness, title="expiry-after-guard-grant"),
            headers=write_headers(harness, key="expiry-after-guard-grant"),
        )
        _fixed_error(grant_expired, 422, "PROFILE_INELIGIBLE")
        assert grant_wait_fired["value"] is True
        assert _counts(harness) == before
    finally:
        client.close()

    harness["clock"].value = frozen_now
    with psycopg.connect(operator_dsn(harness["database"]), autocommit=True) as connection:
        connection.execute(
            "INSERT INTO ifpmic.profile_revocations(project_id,eligibility_id,revoked_at) VALUES(%s,%s,%s)",
            (harness["project_id"], short_grant_id, frozen_now),
        )
    harness["clock"].value = frozen_now
    seed_catalog_and_eligibility(
        harness["database"], harness["record"], expires_at=frozen_now + timedelta(days=30),
    )
    session_wait_fired = {"value": False}
    def expire_session_after_guard(name):
        if name == "job_after_guard_lock" and not session_wait_fired["value"]:
            session_wait_fired["value"] = True
            harness["clock"].advance(hours=9)

    _app, client = client_with(harness, fault_hook=expire_session_after_guard)
    try:
        session_expired = client.post(
            "/api/v1/jobs", json=valid_create_job(harness, title="expiry-after-guard-session"),
            headers=write_headers(harness, key="expiry-after-guard-session"),
        )
        _fixed_error(session_expired, 401, "AUTH_REQUIRED")
        assert session_wait_fired["value"] is True
        assert _counts(harness) == before
    finally:
        client.close()
    _record_cases(grant_expired_after_guard=422, session_expired_after_guard=401)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _signed_cursor(harness, *, actor_id=None, route="GET /api/v1/jobs", scope="accessible-jobs-v1",
                   created_at="2030-01-01T00:00:00.000000Z", job_id="00000000-0000-0000-0000-000000000001",
                   version=1):
    payload = {
        "v": version, "actor_id": actor_id or harness["user_id"], "route": route,
        "scope": scope, "created_at": created_at, "job_id": job_id,
    }
    encoded = _b64url(json.dumps(payload, ensure_ascii=True, sort_keys=True,
                                 separators=(",", ":"), allow_nan=False).encode("ascii"))
    signature = _b64url(hmac.new(
        harness["settings"].csrf_key,
        b"ifpmic.cursor.v1\x00" + encoded.encode("ascii"), hashlib.sha256,
    ).digest())
    return encoded + "." + signature, payload


def test_list_default25_descending_cursor_bytes_and_complete_pagination(g4_harness):
    harness = g4_harness
    expected_ids = seed_job_rows(harness, 30)
    response = harness["client"].get("/api/v1/jobs")
    assert response.status_code == 200
    first = response.json()
    assert set(first) == {"items", "next_cursor"}
    assert len(first["items"]) == 25
    assert [item["job_id"] for item in first["items"]] == expected_ids[:25]
    assert all(set(item) == JOB_KEYS for item in first["items"])
    assert first["next_cursor"] is not None

    encoded, signature = first["next_cursor"].split(".")
    assert _b64url(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))) == encoded
    payload_bytes = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
    payload = json.loads(payload_bytes.decode("ascii"))
    assert payload_bytes == json.dumps(payload, ensure_ascii=True, sort_keys=True,
                                       separators=(",", ":"), allow_nan=False).encode("ascii")
    assert payload == {
        "v": 1, "actor_id": harness["user_id"], "route": "GET /api/v1/jobs",
        "scope": "accessible-jobs-v1", "created_at": "2030-01-02T02:39:05.000000Z",
        "job_id": expected_ids[24],
    }
    expected_mac = _b64url(hmac.new(
        harness["settings"].csrf_key,
        b"ifpmic.cursor.v1\x00" + encoded.encode("ascii"), hashlib.sha256,
    ).digest())
    assert signature == expected_mac

    second = harness["client"].get("/api/v1/jobs", params={"cursor": first["next_cursor"]}).json()
    assert [item["job_id"] for item in second["items"]] == expected_ids[25:]
    assert second["next_cursor"] is None
    assert len({item["job_id"] for item in first["items"] + second["items"]}) == 30

    all_items = harness["client"].get("/api/v1/jobs?limit=100").json()
    assert [item["job_id"] for item in all_items["items"]] == expected_ids
    assert all_items["next_cursor"] is None
    _record_cases(pagination_default=25, pagination_limit100=100)


@pytest.mark.parametrize("query", [
    "limit=0", "limit=101", "limit=01", "limit=+1", "limit=1.0", "limit=NaN",
    "owner_id=someone", "project_id=somewhere", "status=DRAFT",
    "limit=1&limit=2", "cursor=x&cursor=y",
])
def test_list_rejects_invalid_bounds_noncanonical_or_unsupported_query(g4_harness, query):
    response = g4_harness["client"].get("/api/v1/jobs?" + query)
    _fixed_error(response, 422, "INVALID_REQUEST")


@pytest.mark.parametrize("mutation", [
    "tampered-signature", "wrong-actor", "wrong-route", "wrong-scope", "bad-timestamp",
    "bad-job-id", "boolean-version",
])
def test_list_rejects_invalid_or_wrong_scope_signed_cursor(g4_harness, mutation):
    harness = g4_harness
    fields = {}
    if mutation == "wrong-actor":
        fields["actor_id"] = str(uuid.uuid4())
    elif mutation == "wrong-route":
        fields["route"] = "GET /api/v1/commands"
    elif mutation == "wrong-scope":
        fields["scope"] = "all-jobs"
    elif mutation == "bad-timestamp":
        fields["created_at"] = "2030-01-01T03:40:05Z"
    elif mutation == "bad-job-id":
        fields["job_id"] = "not-a-uuid"
    elif mutation == "boolean-version":
        fields["version"] = True
    valid_cursor, _ = _signed_cursor(harness)
    positive = harness["client"].get("/api/v1/jobs", params={"cursor": valid_cursor})
    assert positive.status_code == 200 and positive.json() == {"items": [], "next_cursor": None}
    cursor, _ = _signed_cursor(harness, **fields)
    if mutation == "tampered-signature":
        encoded, signature = cursor.split(".")
        cursor = encoded + "." + ("A" if signature[0] != "A" else "B") + signature[1:]
    response = harness["client"].get("/api/v1/jobs", params={"cursor": cursor})
    _fixed_error(response, 422, "INVALID_REQUEST")


def test_access_is_rechecked_between_list_pages_after_membership_revocation(g4_harness):
    harness = g4_harness
    seed_job_rows(harness, 30)
    first = harness["client"].get("/api/v1/jobs").json()
    assert len(first["items"]) == 25 and first["next_cursor"]
    with psycopg.connect(operator_dsn(harness["database"]), autocommit=True) as connection:
        connection.execute(
            "UPDATE ifpmic.memberships SET active=false WHERE project_id=%s AND user_id=%s",
            (harness["project_id"], harness["user_id"]),
        )
    next_page = harness["client"].get("/api/v1/jobs", params={"cursor": first["next_cursor"]})
    assert next_page.status_code == 200
    assert next_page.json() == {"items": [], "next_cursor": None}


def _second_owner_session(harness):
    _app, client = client_with(harness)
    client.cookies.clear()
    user_id, session, csrf = login(
        client, harness["provider"], harness["clock"], "g4-user-a",
    )
    assert user_id == harness["user_id"]
    return client, session, csrf


def test_distinct_sessions_same_actor_race_same_idempotency_body_has_one_receipt(g4_harness):
    harness = g4_harness
    other, other_session, other_csrf = _second_owner_session(harness)
    entered = threading.Barrier(2)

    class RendezvousBridge:
        async def read_snapshot(self, project_id, profile_version):
            await __import__("asyncio").to_thread(entered.wait, 10)
            return await harness["bridge"].read_snapshot(project_id, profile_version)

    app_a, client_a = client_with(harness, bridge_runner=RendezvousBridge())
    app_b, client_b = client_with(harness, bridge_runner=RendezvousBridge())
    try:
        payload = valid_create_job(harness, title="race-same-actor-same-body")
        headers_a = write_headers(harness, key="race-same-actor")
        headers_b = write_headers(harness, key="race-same-actor", session=other_session, csrf=other_csrf)
        with ThreadPoolExecutor(max_workers=2) as pool:
            future_a = pool.submit(client_a.post, "/api/v1/jobs", json=payload, headers=headers_a)
            future_b = pool.submit(client_b.post, "/api/v1/jobs", json=payload, headers=headers_b)
            response_a, response_b = future_a.result(timeout=35), future_b.result(timeout=35)
        assert response_a.status_code == response_b.status_code == 202
        assert response_a.json() == response_b.json()
        assert _counts(harness) == (1, 1, 1, 1)
        _record_cases(distinct_sessions_same_actor=True)
    finally:
        client_a.close()
        client_b.close()
        other.close()


def test_same_actor_cross_project_key_race_has_one_winner_and_no_orphan_group(g4_harness, tmp_path):
    harness = g4_harness
    second_project = "g4-cross-project"
    second_store = tmp_path / "second-project-store"
    seed_profile_store(second_store, project_id=second_project,
                       profile_version=harness["profile_version"])
    second_record = capture_snapshot(second_store, second_project, harness["profile_version"])
    seed_catalog_and_eligibility(harness["database"], second_record)
    seed_membership(harness["database"], second_project, harness["user_id"])
    other, other_session, other_csrf = _second_owner_session(harness)
    rendezvous = threading.Barrier(2)

    class ProjectBridge:
        async def read_snapshot(self, project_id, profile_version):
            await __import__("asyncio").to_thread(rendezvous.wait, 10)
            if project_id == second_project:
                return await bridge_for(second_store).read_snapshot(project_id, profile_version)
            return await harness["bridge"].read_snapshot(project_id, profile_version)

    _app_a, client_a = client_with(harness, bridge_runner=ProjectBridge())
    _app_b, client_b = client_with(harness, bridge_runner=ProjectBridge())
    try:
        payload_a = valid_create_job(harness, title="cross-project-race-A")
        payload_b = valid_create_job(harness, project_id=second_project, title="cross-project-race-B")
        headers_a = write_headers(harness, key="cross-project-global-key")
        headers_b = write_headers(harness, key="cross-project-global-key", session=other_session, csrf=other_csrf)
        with ThreadPoolExecutor(max_workers=2) as pool:
            future_a = pool.submit(client_a.post, "/api/v1/jobs", json=payload_a, headers=headers_a)
            future_b = pool.submit(client_b.post, "/api/v1/jobs", json=payload_b, headers=headers_b)
            response_a, response_b = future_a.result(timeout=40), future_b.result(timeout=40)
        assert sorted((response_a.status_code, response_b.status_code)) == [202, 409]
        winner = response_a if response_a.status_code == 202 else response_b
        loser = response_b if winner is response_a else response_a
        assert winner.json()["status"] == "accepted"
        _fixed_error(loser, 409, "IDEMPOTENCY_CONFLICT")
        assert _counts(harness) == (1, 1, 1, 1)
        with psycopg.connect(owner_dsn(harness["database"])) as connection:
            assert connection.execute("SELECT count(*) FROM ifpmic.jobs").fetchone()[0] == 1
            saved_project = connection.execute("SELECT project_id FROM ifpmic.jobs").fetchone()[0]
        assert saved_project in {PROJECT_ID, second_project}
        _record_cases(cross_project_race=True)
    finally:
        client_a.close()
        client_b.close()
        other.close()


def test_independent_processes_contend_at_open_transaction_unique_insert(g4_harness, tmp_path):
    harness = g4_harness
    project_b = "g4-independent-process-project-b"
    seed_profile_store(harness["store_root"], project_id=project_b,
                       profile_version=harness["profile_version"])
    record_b = capture_snapshot(harness["store_root"], project_b, harness["profile_version"])
    seed_catalog_and_eligibility(harness["database"], record_b)
    seed_membership(harness["database"], project_b, harness["user_id"])
    other, session_b, csrf_b = _second_owner_session(harness)
    try:
        before = _counts(harness)
        results, process_records = _process_open_transaction_race(
            tmp_path, settings=harness["settings"],
            payloads=[valid_create_job(harness, title="process-contender-a"),
                      valid_create_job(harness, project_id=project_b, title="process-contender-b")],
            sessions=[(harness["session"], harness["csrf"]), (session_b, csrf_b)],
            key="g4-process-unique-contention",
        )
        assert sorted(item["status"] for item in results) == [202, 409]
        conflict = next(item for item in results if item["status"] == 409)
        assert conflict["code"] == "IDEMPOTENCY_CONFLICT"
        assert sum(item["receipt_status"] == "accepted" for item in results) == 1
        assert _counts(harness) == tuple(value + 1 for value in before)
        assert all(item["exit_code"] == 0 and not item["pid_alive"] for item in process_records)
        _record_process_race("cross-project-open-transaction-contention", process_records)
        _record_cases(cross_project_unique_contention=True)
    finally:
        other.close()


def test_losing_bridge_failure_recovers_concurrently_committed_original_receipt(g4_harness):
    harness = g4_harness
    captured = threading.Event()
    release = threading.Event()

    class DelayedFailureBridge:
        async def read_snapshot(self, project_id, profile_version):
            captured.set()
            ok = await __import__("asyncio").to_thread(release.wait, 15)
            assert ok
            raise RuntimeError("g4-bridge-failure-private-canary")

    _app, delayed_client = client_with(harness, bridge_runner=DelayedFailureBridge())
    try:
        payload = valid_create_job(harness, title="bridge-replay-race")
        key = "bridge-replay-race"
        with ThreadPoolExecutor(max_workers=1) as pool:
            losing = pool.submit(
                delayed_client.post, "/api/v1/jobs", json=payload,
                headers=write_headers(harness, key=key),
            )
            assert captured.wait(10)
            winner = harness["client"].post(
                "/api/v1/jobs", json=payload, headers=write_headers(harness, key=key),
            )
            assert winner.status_code == 202
            release.set()
            recovered = losing.result(timeout=20)
        assert recovered.status_code == 202
        assert recovered.json() == winner.json()
        assert _counts(harness) == (1, 1, 1, 1)
        _record_cases(bridge_failure_replay=True)
    finally:
        release.set()
        delayed_client.close()


def test_membership_operator_lock_inversion_uses_nowait_and_rolls_back(g4_harness):
    harness = g4_harness
    guard_locked = threading.Event()
    release_api = threading.Event()
    operator_started = threading.Event()
    operator_result = {}

    def hook(name):
        if name == "job_after_guard_lock":
            guard_locked.set()
            assert release_api.wait(10)

    app, client = client_with(harness, fault_hook=hook)
    payload = valid_create_job(harness, title="g4-nowait-lock-order")

    def operator_update():
        try:
            with psycopg.connect(operator_dsn(harness["database"])) as connection:
                operator_result["pid"] = connection.execute("SELECT pg_backend_pid()").fetchone()[0]
                operator_started.set()
                connection.execute(
                    "UPDATE ifpmic.memberships SET active=true WHERE project_id=%s AND user_id=%s",
                    (PROJECT_ID, harness["user_id"]),
                )
                operator_result["committed"] = True
        except Exception as error:
            operator_result["error_type"] = type(error).__name__
            operator_result["error_sqlstate"] = getattr(error, "sqlstate", None)
            raise

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            api_future = pool.submit(
                client.post, "/api/v1/jobs", json=payload, headers=write_headers(harness, key="g4-nowait-key"),
            )
            assert guard_locked.wait(10)
            operator_future = pool.submit(operator_update)
            assert operator_started.wait(10)
            deadline = time.monotonic() + 5
            waiting = False
            while time.monotonic() < deadline:
                # PostgreSQL intentionally hides other-role activity details
                # from an ordinary owner login; observe with the same local
                # operator role that owns the blocked backend.
                with psycopg.connect(operator_dsn(harness["database"])) as observer:
                    state = observer.execute(
                        "SELECT wait_event_type,wait_event,pg_blocking_pids(pid) FROM pg_stat_activity WHERE pid=%s",
                        (operator_result["pid"],),
                    ).fetchone()
                if state and state[0] == "Lock" and state[2]:
                    waiting = True
                    break
                if operator_future.done():
                    try:
                        operator_future.result()
                    except Exception:
                        break
                time.sleep(0.02)
            assert waiting, ("operator UPDATE did not reach its guard wait while holding the membership row; "
                             f"error_type={operator_result.get('error_type')} "
                             f"sqlstate={operator_result.get('error_sqlstate')} wait={state}")
            release_api.set()
            response = api_future.result(timeout=12)
            operator_future.result(timeout=12)
        _fixed_error(response, 503, "DEPENDENCY_UNAVAILABLE")
        assert operator_result.get("committed") is True
        assert _counts(harness) == (0, 0, 0, 0)
        _record_cases(membership_nowait_no_deadlock=True)
    finally:
        release_api.set()
        client.close()


def test_mock_authority_cli_grants_and_revokes_only_allowlisted_profile_rows(g4_harness, tmp_path):
    harness = g4_harness
    settings_path = tmp_path / "ifpmic-api.json"
    private_settings_file(harness["settings"], settings_path)
    base_env = {
        **os.environ,
        "IFPMIC_API_CONFIG": str(settings_path),
        "IFPMIC_OPERATOR_DSN": operator_dsn(harness["database"]),
    }
    request = {
        "project_id": PROJECT_ID,
        "snapshot_id": harness["record"].snapshot_id,
        "evidence_ref": "G4 synthetic test authority",
        "evidence_sha256": "9" * 64,
        "expires_at": "2030-02-01T00:00:00+00:00",
    }
    granted = subprocess.run(
        [sys.executable, "-m", "services.ifpmic_api.authority", "grant-mock-profile"],
        input=json.dumps(request, ensure_ascii=True, separators=(",", ":")).encode("ascii"),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=base_env, cwd=Path(__file__).resolve().parents[2],
        timeout=20, check=False,
    )
    assert granted.returncode == 0 and granted.stderr == b""
    assert granted.stdout.endswith(b"\n") and granted.stdout.count(b"\n") == 1
    grant_result = json.loads(granted.stdout)
    assert set(grant_result) == {"eligibility_id"}
    eligibility_id = grant_result["eligibility_id"]
    uuid.UUID(eligibility_id)
    with psycopg.connect(owner_dsn(harness["database"])) as connection:
        row = connection.execute(
            "SELECT mode,evidence_ref,evidence_sha256,expires_at FROM ifpmic.profile_eligibility WHERE eligibility_id=%s",
            (eligibility_id,),
        ).fetchone()
    assert row[:3] == ("mock", request["evidence_ref"], request["evidence_sha256"])
    assert row[3].astimezone(timezone.utc).isoformat() == "2030-02-01T00:00:00+00:00"

    revoke = subprocess.run(
        [sys.executable, "-m", "services.ifpmic_api.authority", "revoke-profile"],
        input=json.dumps({"project_id": PROJECT_ID, "eligibility_id": eligibility_id},
                         separators=(",", ":")).encode("ascii"),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=base_env,
        cwd=Path(__file__).resolve().parents[2], timeout=20, check=False,
    )
    assert revoke.returncode == 0 and revoke.stderr == b""
    assert revoke.stdout == b'{"revoked":true}\n'
    with psycopg.connect(owner_dsn(harness["database"])) as connection:
        first = connection.execute(
            "SELECT count(*),min(revoked_at),max(revoked_at) FROM ifpmic.profile_revocations WHERE eligibility_id=%s",
            (eligibility_id,),
        ).fetchone()
    assert first[0] == 1 and first[1] == first[2]
    assert abs((datetime.now(timezone.utc) - first[1].astimezone(timezone.utc)).total_seconds()) < 10
    repeated = subprocess.run(
        [sys.executable, "-m", "services.ifpmic_api.authority", "revoke-profile"],
        input=json.dumps({"project_id": PROJECT_ID, "eligibility_id": eligibility_id},
                         separators=(",", ":")).encode("ascii"),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=base_env,
        cwd=Path(__file__).resolve().parents[2], timeout=20, check=False,
    )
    assert repeated.returncode == 0 and repeated.stdout == revoke.stdout
    with psycopg.connect(owner_dsn(harness["database"])) as connection:
        assert connection.execute(
            "SELECT count(*) FROM ifpmic.profile_revocations WHERE eligibility_id=%s", (eligibility_id,),
        ).fetchone()[0] == 1
    _record_cases(cli_grant=0, cli_revoke=0)

    def cli(operation, raw, env=base_env):
        return subprocess.run(
            [sys.executable, "-m", "services.ifpmic_api.authority", operation], input=raw,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
            cwd=Path(__file__).resolve().parents[2], timeout=20, check=False,
        )

    malformed = cli("grant-mock-profile", b'{"project_id":"x","project_id":"y"}')
    assert malformed.returncode == 2 and malformed.stderr == b""
    assert malformed.stdout == b'{"error":{"code":"AUTHORITY_INVALID_REQUEST"}}\n'
    extra = {**request, "owner_id": str(uuid.uuid4())}
    bad_shape = cli("grant-mock-profile", json.dumps(extra, separators=(",", ":")).encode("ascii"))
    assert bad_shape.returncode == 2 and bad_shape.stderr == b""
    assert bad_shape.stdout == b'{"error":{"code":"AUTHORITY_INVALID_REQUEST"}}\n'
    expired_at = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    expired = {**request, "expires_at": expired_at}
    bad_expiry = cli("grant-mock-profile", json.dumps(expired, separators=(",", ":")).encode("ascii"))
    assert bad_expiry.returncode == 2 and bad_expiry.stderr == b""
    assert bad_expiry.stdout == b'{"error":{"code":"AUTHORITY_INVALID_REQUEST"}}\n'
    foreign_revoke = cli(
        "revoke-profile", json.dumps({"project_id": "unknown-project", "eligibility_id": eligibility_id},
                                      separators=(",", ":")).encode("ascii"),
    )
    assert foreign_revoke.returncode == 2 and foreign_revoke.stderr == b""
    assert foreign_revoke.stdout == b'{"error":{"code":"AUTHORITY_FORBIDDEN"}}\n'
    no_config = cli("revoke-profile", json.dumps(
        {"project_id": PROJECT_ID, "eligibility_id": eligibility_id}, separators=(",", ":")
    ).encode("ascii"), {"PATH": os.environ["PATH"], "IFPMIC_OPERATOR_DSN": operator_dsn(harness["database"])})
    assert no_config.returncode == 3 and no_config.stderr == b""
    assert no_config.stdout == b'{"error":{"code":"AUTHORITY_UNAVAILABLE"}}\n'
    real_config = tmp_path / "real-mode-settings.json"
    real_origin = "https://api.authority.invalid"
    real_ui = "https://ui.authority.invalid"
    real_settings = replace(
        harness["settings"], mode="real", api_origin=real_origin, issuer="https://issuer.authority.invalid",
        authorization_endpoint="https://issuer.authority.invalid/authorize",
        token_endpoint="https://issuer.authority.invalid/token", jwks_uri="https://issuer.authority.invalid/jwks",
        redirect_uri=real_origin + "/auth/callback", post_login_url=real_ui + "/ifpmic.html",
        allowed_ui_origins=(real_ui,),
    )
    private_settings_file(real_settings, real_config)
    wrong_mode = cli("grant-mock-profile", json.dumps(request, separators=(",", ":")).encode("ascii"),
                     {**base_env, "IFPMIC_API_CONFIG": str(real_config)})
    assert wrong_mode.returncode == 2 and wrong_mode.stderr == b""
    assert wrong_mode.stdout == b'{"error":{"code":"AUTHORITY_FORBIDDEN"}}\n'


def test_real_uvicorn_restart_preserves_accepted_job_receipt_and_private_logs(g4_harness, tmp_path, monkeypatch):
    harness = g4_harness
    storage = tmp_path / "g4-private-service"
    storage.mkdir(mode=0o700)
    storage.chmod(0o700)
    port = free_loopback_port()
    api_origin = f"http://127.0.0.1:{port}"
    settings = replace(
        harness["settings"], api_origin=api_origin, redirect_uri=api_origin + "/auth/callback",
    )
    process_session, process_csrf = _seed_wall_clock_session(harness)
    config = storage / "settings.json"
    private_settings_file(settings, config)
    stdout_path, stderr_path = storage / "service.stdout", storage / "service.stderr"
    canary = "g4-restart-private-canary"
    payload = valid_create_job(harness, title=canary)
    process_session_b, process_csrf_b = _seed_wall_clock_session(harness)
    request_headers = {
        "Origin": "http://127.0.0.1:4173",
        "Cookie": "ax_session=" + process_session,
        "Content-Type": "application/json",
        "X-CSRF-Token": process_csrf,
        "Idempotency-Key": "g4-process-restart",
    }
    processes = []

    def make_eligibility_wall_clock_valid(record):
        now = datetime.now(timezone.utc)
        seed_catalog_and_eligibility(
            harness["database"], record,
            granted_at=now - timedelta(minutes=1), expires_at=now + timedelta(days=30),
        )

    # The FastAPI test fixture uses a 2030 frozen clock. The real Uvicorn
    # process uses wall time, so its synthetic grants are seeded in that clock.
    make_eligibility_wall_clock_valid(harness["record"])

    def start_process():
        out_fd = os.open(stdout_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        err_fd = os.open(stderr_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        os.chmod(stdout_path, 0o600)
        os.chmod(stderr_path, 0o600)
        try:
            process = subprocess.Popen(
                [sys.executable, "-m", "services.ifpmic_api.serve"],
                cwd=Path(__file__).resolve().parents[2],
                env={**os.environ, "IFPMIC_API_CONFIG": str(config), "IFPMIC_API_PORT": str(port)},
                stdin=subprocess.DEVNULL, stdout=out_fd, stderr=err_fd,
            )
        finally:
            os.close(out_fd)
            os.close(err_fd)
        processes.append(process)
        _wait_process_ready(process, api_origin)
        return process

    def request(method, path, body=None):
        connection = HTTPConnection("127.0.0.1", port, timeout=10)
        try:
            data = None if body is None else json.dumps(body, ensure_ascii=True, separators=(",", ":"))
            headers = {"Origin": "http://127.0.0.1:4173", "Cookie": "ax_session=" + process_session}
            if method == "POST":
                headers.update(request_headers)
            connection.request(method, path, body=data, headers=headers)
            response = connection.getresponse()
            content = response.read()
            return response.status, json.loads(content) if content else None
        finally:
            connection.close()

    try:
        first = start_process()
        status, receipt = request("POST", "/api/v1/jobs", payload)
        assert status == 202 and receipt["status"] == "accepted", (
            f"synthetic process create returned fixed status/code {status}/{(receipt or {}).get('code')}"
        )
        assert request("GET", f"/api/v1/jobs/{receipt['resource_id']}")[0] == 200

        same_body = valid_create_job(harness, title="g4-subprocess-same-body")
        same_race, same_processes = _process_http_race(
            storage, base_url=api_origin, payloads=[same_body, same_body],
            sessions=[(process_session, process_csrf), (process_session_b, process_csrf_b)],
            key="g4-process-same-key",
        )
        assert [item["status"] for item in same_race] == [202, 202]
        assert same_race[0]["body"] == same_race[1]["body"]
        _record_process_race("same-key-same-body", same_processes)

        second_project = "g4-process-cross-project"
        seed_profile_store(harness["store_root"], project_id=second_project,
                           profile_version=harness["profile_version"])
        second_record = capture_snapshot(harness["store_root"], second_project, harness["profile_version"])
        make_eligibility_wall_clock_valid(second_record)
        seed_membership(harness["database"], second_project, harness["user_id"])
        project_race, project_processes = _process_http_race(
            storage, base_url=api_origin,
            payloads=[valid_create_job(harness, title="g4-process-project-A"),
                      valid_create_job(harness, project_id=second_project, title="g4-process-project-B")],
            sessions=[(process_session, process_csrf), (process_session_b, process_csrf_b)],
            key="g4-process-cross-project-key",
        )
        assert sorted(item["status"] for item in project_race) == [202, 409]
        _record_process_race("same-actor-cross-project-key", project_processes)
        _record_cases(concurrent_one_winner=True, distinct_sessions_same_actor=True,
                      cross_project_race=True, same_key_conflict=409)
        assert _counts(harness) == (3, 3, 3, 3)
        first.send_signal(signal.SIGINT)
        assert first.wait(timeout=15) == 0
        assert not _pid_exists(first.pid)

        second = start_process()
        detail_status, detail = request("GET", f"/api/v1/jobs/{receipt['resource_id']}")
        command_status, command = request("GET", f"/api/v1/commands/{receipt['command_id']}")
        replay_status, replay = request("POST", "/api/v1/jobs", payload)
        assert detail_status == command_status == 200
        assert replay_status == 202 and replay == receipt
        assert detail["job"]["status"] == "DRAFT" and detail["job"]["revision"] == 0
        assert detail["steps"] == [] and detail["last_event_id"] == ""
        assert command["status"] == "accepted" and command["applied_revision"] is None
        assert _counts(harness) == (3, 3, 3, 3)
        second.send_signal(signal.SIGINT)
        assert second.wait(timeout=15) == 0
        assert not _pid_exists(second.pid)
    finally:
        for process in processes:
            if process.poll() is None:
                process.send_signal(signal.SIGINT)
                process.wait(timeout=15)

    output = stdout_path.read_bytes()
    error_output = stderr_path.read_bytes()
    assert canary.encode("ascii") not in output + error_output
    assert process_session.encode("ascii") not in output + error_output
    assert process_csrf.encode("ascii") not in output + error_output
    assert stat_mode(storage) == 0o700
    assert stat_mode(stdout_path) == stat_mode(stderr_path) == 0o600
    observation_path = os.environ.get("IFPMIC_JOBS_TEST_OBSERVATION_PATH")
    if observation_path:
        _write_runtime_observation(observation_path, processes, stdout_path, stderr_path, canary,
                                   process_session, process_csrf)
        _record_cases(create=202, same_key_replay=202, same_key_conflict=409,
                      concurrent_one_winner=True, distinct_sessions_same_actor=True,
                      cross_project_race=True)


def test_gate_subreaper_cleans_only_owned_orphaned_service_descendant(tmp_path):
    """Exercise gate cleanup in a child process, never enabling subreaper in pytest."""
    unrelated = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    pid_file = tmp_path / "orphan.pid"
    harness = r'''
import json, os, subprocess, sys
from pathlib import Path
sys.path.insert(0, 'scripts')
import verify_ifpmic_g4 as gate
gate.enable_subreaper()
pidfile = Path(sys.argv[1])
try:
  child = subprocess.run([sys.executable, '-c',
    "import subprocess,sys; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); print(p.pid)"],
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, text=True)
  pidfile.write_text(child.stdout.strip(), encoding='ascii')
  result = gate.cleanup_owned_children()
  print(json.dumps(result, sort_keys=True, separators=(',', ':')))
finally:
  gate.cleanup_owned_children()
'''
    try:
        completed = subprocess.run(
            [sys.executable, "-c", harness, str(pid_file)], cwd=Path(__file__).resolve().parents[2],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=15, check=False,
        )
        assert completed.returncode == 0 and completed.stderr == b""
        assert completed.stdout.endswith(b"\n") and completed.stdout.count(b"\n") == 1
        assert json.loads(completed.stdout) == {"pid_alive": False, "result": "stopped", "signalled_count": 1}
        orphan_pid = int(pid_file.read_text(encoding="ascii"))
        assert not _pid_exists(orphan_pid)
        assert unrelated.poll() is None
    finally:
        if unrelated.poll() is None:
            unrelated.terminate()
            unrelated.wait(timeout=5)



def test_gate_subreaper_reaps_natural_orphan_while_command_runs_and_preserves_status(tmp_path):
    """The gate reaps its naturally exiting adopted child without touching outsiders."""
    command_pid_file = tmp_path / "gate-command.pid"
    orphan_pid_file = tmp_path / "natural-orphan.pid"
    harness = r'''
import json, os, subprocess, sys, threading, time
from pathlib import Path
sys.path.insert(0, 'scripts')
import verify_ifpmic_g4 as gate
gate.enable_subreaper()
unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
preexisting = subprocess.Popen([sys.executable, '-c', 'import sys,time; time.sleep(0.30); sys.exit(17)'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
preexisting_pid = preexisting.pid
command_pid_file = Path(sys.argv[1])
orphan_pid_file = Path(sys.argv[2])
command = r"""import os, pathlib, subprocess, sys, time
command_pid_file = pathlib.Path(sys.argv[1]); orphan_pid_file = pathlib.Path(sys.argv[2])
command_pid_file.write_text(str(os.getpid()), encoding='ascii')
launcher = "import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(0.35)'],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); print(p.pid,flush=True); time.sleep(0.05)"
launched = subprocess.run([sys.executable, '-c', launcher], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, text=True)
orphan_pid_file.write_text(launched.stdout.strip(), encoding='ascii')
time.sleep(1.0)
print('command-complete')
sys.exit(23)
"""
result_box = {}
errors = []
def invoke():
  try:
    result_box['result'] = gate.run_owned_command([sys.executable, '-c', command, str(command_pid_file), str(orphan_pid_file)], cwd=Path.cwd(), timeout=5, env=os.environ.copy())
  except BaseException as error:
    errors.append(type(error).__name__)
worker = threading.Thread(target=invoke)
worker.start()
reaped_while_command_alive = False
outsider_survived = False
preexisting_zombie_while_command_alive = False
deadline = time.monotonic() + 5
while time.monotonic() < deadline and worker.is_alive():
  try:
    command_pid = int(command_pid_file.read_text(encoding='ascii'))
    orphan_pid = int(orphan_pid_file.read_text(encoding='ascii'))
  except (OSError, ValueError):
    time.sleep(0.01)
    continue
  try:
    command_stat = Path(f'/proc/{command_pid}/stat').read_text().rsplit(') ', 1)[1].split()
  except (OSError, IndexError):
    command_stat = None
  try:
    orphan_stat = Path(f'/proc/{orphan_pid}/stat').read_text().rsplit(') ', 1)[1].split()
  except (OSError, IndexError):
    orphan_stat = None
  try:
    preexisting_stat = Path(f'/proc/{preexisting_pid}/stat').read_text().rsplit(') ', 1)[1].split()
  except (OSError, IndexError):
    preexisting_stat = None
  if command_stat and command_stat[0] != 'Z' and preexisting_stat and preexisting_stat[0] == 'Z':
    preexisting_zombie_while_command_alive = True
  if command_stat and command_stat[0] != 'Z' and orphan_stat is None:
    reaped_while_command_alive = True
    outsider_survived = unrelated.poll() is None
    break
  time.sleep(0.01)
worker.join(timeout=6)
try:
  assert not worker.is_alive(), 'owned command did not finish within bound'
  assert not errors, errors
  result = result_box['result']
  assert result.returncode == 23
  assert result.stdout == b'command-complete\n'
  assert result.stderr == b''
  assert reaped_while_command_alive, 'adopted natural orphan was not reaped before command exit'
  assert preexisting_zombie_while_command_alive, 'preexisting child did not exit while wrapped command was live'
  assert preexisting.wait(timeout=1) == 17, 'background reaper stole the preexisting direct child status'
  assert outsider_survived and unrelated.poll() is None
  orphan_pid = int(orphan_pid_file.read_text(encoding='ascii'))
  assert not Path(f'/proc/{orphan_pid}').exists()
  print(json.dumps({'command_exit_code': result.returncode, 'natural_orphan_reaped_while_command_live': True,
                    'preexisting_child_exit_status_preserved': True,
                    'command_output_preserved': result.stdout == b'command-complete\n',
                    'unrelated_process_alive': True}, sort_keys=True, separators=(',', ':')))
finally:
  gate.cleanup_owned_children()
  if preexisting.poll() is None:
    preexisting.terminate()
    preexisting.wait(timeout=5)
  if unrelated.poll() is None:
    unrelated.terminate()
    unrelated.wait(timeout=5)
'''
    completed = subprocess.run(
        [sys.executable, "-c", harness, str(command_pid_file), str(orphan_pid_file)],
        cwd=Path(__file__).resolve().parents[2], stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, check=False,
    )
    assert completed.returncode == 0 and completed.stderr == b""
    report = json.loads(completed.stdout)
    assert report == {
        "command_exit_code": 23,
        "natural_orphan_reaped_while_command_live": True,
        "preexisting_child_exit_status_preserved": True,
        "command_output_preserved": True,
        "unrelated_process_alive": True,
    }


def _seed_wall_clock_session(harness):
    """A real-clock synthetic session for actual Uvicorn, unlike frozen API fixtures."""
    import secrets

    token = _b64url(secrets.token_bytes(32))
    token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
    now = datetime.now(timezone.utc)
    with psycopg.connect(owner_dsn(harness["database"])) as connection:
        connection.execute(
            "INSERT INTO ifpmic.user_sessions(token_hash,user_id,created_at,expires_at,last_seen_at) "
            "VALUES(%s,%s,%s,%s,%s)",
            (token_hash, harness["user_id"], now, now + timedelta(hours=8), now),
        )
    csrf = hmac.new(
        harness["settings"].csrf_key, b"ifpmic.csrf.v1\x00" + token.encode("ascii"), hashlib.sha256,
    ).digest()
    return token, _b64url(csrf)


_HTTP_RACE_WORKER = r'''
import http.client, json, sys, time
from pathlib import Path
from urllib.parse import urlsplit
value = json.loads(sys.stdin.buffer.read().decode('utf-8'))
barrier = Path(value['barrier'])
(barrier / (value['worker'] + '.ready')).write_text('ready', encoding='ascii')
deadline = time.monotonic() + 10
while time.monotonic() < deadline:
    if (barrier / '0.ready').exists() and (barrier / '1.ready').exists():
        break
    time.sleep(0.01)
else:
    raise SystemExit(7)
parts = urlsplit(value['base_url'])
connection = http.client.HTTPConnection(parts.hostname, parts.port, timeout=15)
body = json.dumps(value['payload'], ensure_ascii=True, separators=(',', ':'))
headers = {'Origin': 'http://127.0.0.1:4173', 'Cookie': 'ax_session=' + value['session'],
           'Content-Type': 'application/json', 'X-CSRF-Token': value['csrf'],
           'Idempotency-Key': value['key']}
connection.request('POST', '/api/v1/jobs', body=body, headers=headers)
response = connection.getresponse()
raw = response.read()
print(json.dumps({'status': response.status, 'body': json.loads(raw)}, ensure_ascii=True,
                 sort_keys=True, separators=(',', ':')))
connection.close()
'''


def _process_http_race(tmp_path, *, base_url, payloads, sessions, key):
    barrier = tmp_path / ("barrier-" + uuid.uuid4().hex)
    barrier.mkdir(mode=0o700)
    barrier.chmod(0o700)
    results = []
    processes = []
    output_files = []
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = []
            for index in range(2):
                stdout_path = barrier / f"worker-{index}.stdout"
                stderr_path = barrier / f"worker-{index}.stderr"
                stdout_file = stdout_path.open("xb")
                stderr_file = stderr_path.open("xb")
                os.chmod(stdout_path, 0o600)
                os.chmod(stderr_path, 0o600)
                output_files.extend([stdout_file, stderr_file])
                process = subprocess.Popen(
                    [sys.executable, "-c", _HTTP_RACE_WORKER], stdin=subprocess.PIPE,
                    stdout=stdout_file, stderr=stderr_file, cwd=Path(__file__).resolve().parents[2],
                    env={"PATH": os.environ["PATH"]},
                )
                processes.append((process, stdout_path, stderr_path))
                request = {"base_url": base_url, "barrier": str(barrier), "worker": str(index),
                           "payload": payloads[index], "session": sessions[index][0],
                           "csrf": sessions[index][1], "key": key}
                futures.append(pool.submit(
                    process.communicate,
                    json.dumps(request, ensure_ascii=True, separators=(",", ":")).encode("ascii"),
                    timeout=25,
                ))
            for future in futures:
                future.result(timeout=28)
        for output in output_files:
            output.close()
        for process, stdout_path, stderr_path in processes:
            assert process.wait(timeout=2) == 0
            assert not _pid_exists(process.pid)
            assert stderr_path.stat().st_size == 0
            raw = stdout_path.read_bytes()
            assert raw.endswith(b"\n") and raw.count(b"\n") == 1
            results.append(json.loads(raw))
    finally:
        for process, _, _ in processes:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
        for output in output_files:
            if not output.closed:
                output.close()
    import stat
    process_records = []
    for process, stdout_path, stderr_path in processes:
        def info(value):
            raw = value.read_bytes()
            return {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
                    "mode": oct(stat.S_IMODE(value.stat().st_mode))}
        process_records.append({"exit_code": process.returncode, "pid_alive": False,
                                "stdout": info(stdout_path), "stderr": info(stderr_path)})
    return results, process_records


_DB_CONTENTION_WORKER = r'''
import json, sys, time
from datetime import datetime, timezone
from pathlib import Path
from fastapi.testclient import TestClient
from services.ifpmic_api.app import create_app
from services.ifpmic_api.settings import load_settings

value = json.loads(sys.stdin.buffer.read().decode('ascii'))
barrier = Path(value['barrier'])
settings = load_settings(value['settings_path'])
def hook(name):
    if name != 'command_before_insert':
        return
    (barrier / (value['worker'] + '.ready')).write_text('open-transaction', encoding='ascii')
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        if (barrier / 'release').exists():
            return
        time.sleep(.01)
    raise RuntimeError('test barrier timed out')

def frozen_clock():
    return datetime(2030, 1, 2, 3, 4, 5, tzinfo=timezone.utc)

app = create_app(settings, clock=frozen_clock, fault_hook=hook)
headers = {'Origin': settings.allowed_ui_origins[0], 'Cookie': 'ax_session=' + value['session'],
           'X-CSRF-Token': value['csrf'], 'Idempotency-Key': value['key']}
with TestClient(app, base_url=settings.api_origin, follow_redirects=False) as client:
    response = client.post('/api/v1/jobs', json=value['payload'], headers=headers)
    body = response.json()
    print(json.dumps({'status': response.status_code, 'code': body.get('code'),
                      'receipt_status': body.get('status')}, sort_keys=True, separators=(',', ':')))
'''


def _process_open_transaction_race(tmp_path, *, settings, payloads, sessions, key):
    """Hold two independent request transactions at the command insert seam."""
    barrier = tmp_path / ("db-barrier-" + uuid.uuid4().hex)
    barrier.mkdir(mode=0o700)
    barrier.chmod(0o700)
    settings_path = barrier / "settings.json"
    from tests.ifpmic_api.jobs_fixture import private_settings_file
    private_settings_file(settings, settings_path)
    processes = []
    output_files = []
    try:
        for index in range(2):
            stdout_path = barrier / f"db-worker-{index}.stdout"
            stderr_path = barrier / f"db-worker-{index}.stderr"
            stdout = stdout_path.open("xb")
            stderr = stderr_path.open("xb")
            os.chmod(stdout_path, 0o600)
            os.chmod(stderr_path, 0o600)
            output_files.extend((stdout, stderr))
            process = subprocess.Popen(
                [sys.executable, "-c", _DB_CONTENTION_WORKER], stdin=subprocess.PIPE,
                stdout=stdout, stderr=stderr, cwd=Path(__file__).resolve().parents[2],
                env={"PATH": os.environ["PATH"], "PYTHONPATH": str(Path(__file__).resolve().parents[2])},
                start_new_session=True,
            )
            processes.append((process, stdout_path, stderr_path))
            request = {"barrier": str(barrier), "settings_path": str(settings_path),
                       "worker": str(index), "payload": payloads[index],
                       "session": sessions[index][0], "csrf": sessions[index][1], "key": key}
            process.stdin.write(json.dumps(request, ensure_ascii=True, separators=(",", ":")).encode("ascii"))
            process.stdin.close()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if all((barrier / f"{index}.ready").exists() for index in range(2)):
                break
            if any(process.poll() is not None for process, _, _ in processes):
                break
            time.sleep(0.02)
        assert all((barrier / f"{index}.ready").exists() for index in range(2)), (
            "both independent request processes must reach command_before_insert with open transactions"
        )
        (barrier / "release").write_text("release", encoding="ascii")
        results = []
        for process, stdout_path, stderr_path in processes:
            assert process.wait(timeout=8) == 0
            assert not _pid_exists(process.pid)
            assert stderr_path.stat().st_size == 0
            raw = stdout_path.read_bytes()
            assert raw.endswith(b"\n") and raw.count(b"\n") == 1
            results.append(json.loads(raw))
    finally:
        if not (barrier / "release").exists():
            (barrier / "release").write_text("release", encoding="ascii")
        for process, _, _ in processes:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
        for stream in output_files:
            stream.close()

    import stat
    records = []
    for process, stdout_path, stderr_path in processes:
        def info(path):
            raw = path.read_bytes()
            return {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
                    "mode": oct(stat.S_IMODE(path.stat().st_mode))}
        records.append({"exit_code": process.returncode, "pid_alive": False,
                        "stdout": info(stdout_path), "stderr": info(stderr_path)})
    return results, records


def _record_process_race(case, records):
    path = os.environ.get("IFPMIC_JOBS_TEST_OBSERVATION_PATH")
    if not path:
        return
    record = _load_runtime_observation(path)
    record.setdefault("process_races", {})[case] = records
    _save_runtime_observation(path, record)


def _wait_process_ready(process, base_url, timeout=15):
    import urllib.error
    import urllib.request

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise AssertionError("G4 Uvicorn process exited before ready")
        try:
            request = urllib.request.Request(base_url + "/not-a-route",
                                             headers={"Origin": "http://127.0.0.1:4173"})
            urllib.request.urlopen(request, timeout=0.5)
        except urllib.error.HTTPError as error:
            if error.code == 403:
                return
        except OSError:
            time.sleep(0.05)
    raise AssertionError("G4 Uvicorn readiness timeout")


def _pid_exists(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def stat_mode(path):
    import stat
    return stat.S_IMODE(Path(path).stat().st_mode)


def _write_runtime_observation(path, processes, stdout_path, stderr_path, *canaries):
    import stat

    for process in processes:
        assert process.poll() == 0 and not _pid_exists(process.pid)
    for canary in canaries:
        if isinstance(canary, str):
            assert canary.encode("ascii") not in stdout_path.read_bytes() + stderr_path.read_bytes()
    def file_info(value):
        raw = Path(value).read_bytes()
        return {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
                "mode": oct(stat.S_IMODE(Path(value).stat().st_mode))}
    record = _load_runtime_observation(path)
    record["cases"].update({"restart_detail": 200})
    service_records = [
        {"exit_code": process.returncode, "pid_alive": False,
         "logs": {"stdout": {k: v for k, v in file_info(stdout_path).items() if k in {"sha256", "bytes"}},
                  "stderr": {k: v for k, v in file_info(stderr_path).items() if k in {"sha256", "bytes"}}},
         "private_directory_mode": "0o700", "stdout_mode": "0o600", "stderr_mode": "0o600"}
        for process in processes
    ]
    record["services"] = service_records
    record["service"] = service_records[-1]
    _save_runtime_observation(path, record)


def _load_runtime_observation(path):
    target = Path(path)
    if target.exists():
        record = json.loads(target.read_text(encoding="ascii"))
        assert record["kind"] == "ifpmic.g4.runtime-observation.v1"
        return record
    return {"kind": "ifpmic.g4.runtime-observation.v1", "cases": {}, "additional_cases": {},
            "services": [], "service": None, "no_canaries": True,
            "private_directory_mode": "0o700"}


def _save_runtime_observation(path, record):
    import tempfile
    target = Path(path)
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    target.parent.chmod(0o700)
    data = json.dumps(record, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    fd, temporary = tempfile.mkstemp(prefix=".g4-observation-", dir=target.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="ascii") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    target.chmod(0o600)


def _record_cases(**cases):
    path = os.environ.get("IFPMIC_JOBS_TEST_OBSERVATION_PATH")
    if not path:
        return
    record = _load_runtime_observation(path)
    expected = {"create", "same_key_replay", "same_key_conflict", "unauthorized", "fault_precommit",
                "fault_postcommit", "pagination_default", "restart_detail", "concurrent_one_winner",
                "membership_nowait_no_deadlock", "bridge_failure_replay", "cli_grant", "cli_revoke",
                "distinct_sessions_same_actor", "cross_project_race", "cross_project_unique_contention"}
    record["cases"].update({key: value for key, value in cases.items() if key in expected})
    record["additional_cases"].update({key: value for key, value in cases.items() if key not in expected})
    _save_runtime_observation(path, record)
