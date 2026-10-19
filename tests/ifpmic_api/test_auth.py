"""B02 G3 authentication boundary tests.

All authentication uses a local signed synthetic OIDC provider and the real
isolated PostgreSQL role. Expected values below are literal contract oracles;
they are not discovered from the implementation response.
"""

from __future__ import annotations

import base64
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import socket
import signal
import subprocess
import sys
import time
from http.cookies import SimpleCookie
from urllib.parse import parse_qs, urlencode, urlsplit
from uuid import UUID, uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from services.ifpmic_api.app import create_app
from services.ifpmic_api.migrate import apply_migrations
from services.ifpmic_api.settings import Settings, SettingsError, load_settings
from tests.ifpmic_api.oidc_provider import CLIENT_ID, CLIENT_SECRET, KEY_ID, SyntheticOIDCProvider


API_ORIGIN = "http://127.0.0.1:18321"
UI_ORIGIN = "http://127.0.0.1:4173"
CSRF_KEY = b"g3-independent-test-key-material-32bytes+"
CALLBACK_CODE = "g3-local-code"


class FrozenClock:
    def __init__(self) -> None:
        self.value = datetime(2030, 1, 2, 3, 4, 5, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.value

    def advance(self, **delta) -> None:
        self.value += timedelta(**delta)


@pytest.fixture
def frozen_clock() -> FrozenClock:
    return FrozenClock()


@pytest.fixture
def oidc_provider() -> SyntheticOIDCProvider:
    provider = SyntheticOIDCProvider().start()
    try:
        yield provider
    finally:
        provider.close()


@pytest.fixture
def auth_database(pg_cluster, migration_db):
    with psycopg.connect(migration_db.owner_dsn(pg_cluster), autocommit=True) as connection:
        apply_migrations(
            connection,
            runtime_role=migration_db.roles.runtime,
            operator_role=migration_db.roles.operator,
            dispatcher_role=migration_db.roles.dispatcher,
            projector_role=migration_db.roles.projector,
        )
    return migration_db, pg_cluster


def _runtime_dsn(auth_database) -> str:
    database, cluster = auth_database
    return database.runtime_dsn(cluster)


def _owner_dsn(auth_database) -> str:
    database, cluster = auth_database
    return database.owner_dsn(cluster)


def _settings(provider: SyntheticOIDCProvider, database_dsn: str, **changes) -> Settings:
    values = {
        "mode": "mock",
        "api_origin": API_ORIGIN,
        "issuer": provider.issuer,
        "client_id": CLIENT_ID,
        "authorization_endpoint": provider.authorization_endpoint,
        "token_endpoint": provider.token_endpoint,
        "jwks_uri": provider.jwks_uri,
        "redirect_uri": API_ORIGIN + "/auth/callback",
        "post_login_url": UI_ORIGIN + "/ifpmic.html",
        "allowed_ui_origins": (UI_ORIGIN,),
        "csrf_key": CSRF_KEY,
        "database_dsn": database_dsn,
        "client_secret": CLIENT_SECRET,
        "client_auth_method": "client_secret_basic",
        "signing_algorithms": ("RS256",),
    }
    values.update(changes)
    return Settings(**values)


@pytest.fixture
def auth_harness(oidc_provider, auth_database, frozen_clock):
    settings = _settings(oidc_provider, _runtime_dsn(auth_database))
    app = create_app(settings, clock=frozen_clock)
    with TestClient(app, base_url=API_ORIGIN, follow_redirects=False) as client:
        yield client, app, settings, oidc_provider, frozen_clock, auth_database


def _decode_b64url_32(value: str) -> bytes:
    assert len(value) == 43
    assert "=" not in value
    raw = base64.urlsafe_b64decode(value + "=")
    assert len(raw) == 32
    assert base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=") == value
    return raw


def _start_login(client, provider, clock):
    response = client.get("/auth/login", follow_redirects=False)
    assert response.status_code == 303
    location = response.headers["location"]
    parts = urlsplit(location)
    assert f"{parts.scheme}://{parts.netloc}" + parts.path == provider.authorization_endpoint
    query = parse_qs(parts.query, keep_blank_values=True, strict_parsing=True)
    assert set(query) == {
        "client_id", "code_challenge", "code_challenge_method", "nonce", "redirect_uri",
        "response_type", "scope", "state",
    }
    assert query["client_id"] == [CLIENT_ID]
    assert query["redirect_uri"] == [API_ORIGIN + "/auth/callback"]
    assert query["response_type"] == ["code"]
    assert query["scope"] == ["openid"]
    assert query["code_challenge_method"] == ["S256"]
    state = query["state"][0]
    nonce = query["nonce"][0]
    _decode_b64url_32(state)
    _decode_b64url_32(nonce)
    assert len(query["code_challenge"][0]) == 43
    assert "code_verifier" not in query
    provider.register_authorization(query)
    provider.claim_time = clock().timestamp()

    cookies = SimpleCookie()
    cookies.load("\n".join(response.headers.get_list("set-cookie")))
    assert "ax_login" in cookies
    cookie = cookies["ax_login"]
    provider.browser_cookie = cookie.value
    _decode_b64url_32(cookie.value)
    assert cookie["path"] == "/auth"
    assert cookie["httponly"]
    assert cookie["samesite"].lower() == "lax"
    assert cookie["max-age"] == "300"
    assert not cookie["secure"]
    return query, response


def _callback(client, query, *, code=CALLBACK_CODE, extra=""):
    raw = urlencode({"code": code, "state": query["state"][0]})
    return client.get("/auth/callback?" + raw + extra, follow_redirects=False)


def _assert_fixed_error(response, *, status: int, code: str) -> None:
    assert response.status_code == status
    try:
        body = response.json()
    except Exception:
        pytest.fail("error response was not fixed JSON")
    assert set(body) == {"code", "message", "trace_id"}
    assert body["code"] == code and body["message"] == code
    UUID(body["trace_id"])
    assert response.headers.get("cache-control") == "no-store"
    assert response.headers.get("referrer-policy") == "no-referrer"


def _assert_no_canary(response, *canaries: str) -> None:
    for canary in canaries:
        if canary and canary.encode("utf-8") in response.content:
            pytest.fail("sensitive callback canary appeared in HTTP response")


def _complete_login(client, provider, clock):
    query, _ = _start_login(client, provider, clock)
    response = _callback(client, query)
    return query, response


def _session_rows(auth_database):
    with psycopg.connect(_owner_dsn(auth_database)) as connection:
        users = connection.execute(
            "SELECT user_id::text, identity_subject, display_name FROM ifpmic.users ORDER BY user_id"
        ).fetchall()
        sessions = connection.execute(
            "SELECT token_hash,user_id::text,created_at,expires_at,last_seen_at,revoked_at "
            "FROM ifpmic.user_sessions ORDER BY created_at,token_hash"
        ).fetchall()
        transactions = connection.execute(
            "SELECT state_hash,browser_hash,nonce,pkce_verifier,expires_at,consumed_at "
            "FROM ifpmic.oidc_login_transactions ORDER BY state_hash"
        ).fetchall()
    return users, sessions, transactions


def _digest_label(label: str) -> str:
    return hashlib.sha256(label.encode("utf-8")).hexdigest()


def _seed_login_rows(auth_database, *, count: int, now: datetime, expires_at: datetime,
                     consumed_at: datetime | None, label: str) -> list[str]:
    state_hashes = [_digest_label(f"{label}:state:{index}") for index in range(count)]
    with psycopg.connect(_owner_dsn(auth_database)) as connection:
        connection.cursor().executemany(
            "INSERT INTO ifpmic.oidc_login_transactions(state_hash,browser_hash,nonce,pkce_verifier,expires_at,consumed_at) "
            "VALUES(%s,%s,%s,%s,%s,%s)",
            [(state_hash, _digest_label(f"{label}:browser:{index}"), f"{label}:nonce:{index}",
              f"{label}:verifier:{index}", expires_at, consumed_at)
             for index, state_hash in enumerate(state_hashes)],
        )
    return state_hashes


def _seed_session_rows(auth_database, *, count: int, now: datetime, expires_at: datetime,
                       revoked_at: datetime | None, last_seen_at: datetime, label: str) -> list[str]:
    token_hashes = [_digest_label(f"{label}:session:{index}") for index in range(count)]
    with psycopg.connect(_owner_dsn(auth_database)) as connection:
        user_id = connection.execute(
            "INSERT INTO ifpmic.users(identity_subject,display_name) VALUES(%s,%s) RETURNING user_id",
            (f"retention:{label}", "Retention fixture"),
        ).fetchone()[0]
        connection.cursor().executemany(
            "INSERT INTO ifpmic.user_sessions(token_hash,user_id,created_at,expires_at,last_seen_at,revoked_at) "
            "VALUES(%s,%s,%s,%s,%s,%s)",
            [(token_hash, user_id, now - timedelta(hours=1), expires_at, last_seen_at, revoked_at)
             for token_hash in token_hashes],
        )
    return token_hashes


def _expected_csrf(key: bytes, cookie: str) -> str:
    material = b"ifpmic.csrf.v1\x00" + cookie.encode("ascii")
    return base64.urlsafe_b64encode(hmac.new(key, material, hashlib.sha256).digest()).decode("ascii").rstrip("=")


def test_login_builds_pkce_s256_and_split_origin_allowlisted_request(auth_harness):
    client, _, _, provider, clock, _ = auth_harness
    query, response = _start_login(client, provider, clock)
    assert query["code_challenge"][0] == provider.expected_challenge
    assert provider.authorization_endpoint != provider.token_endpoint
    assert provider.token_endpoint != provider.jwks_uri
    assert not response.text


def test_valid_signed_callback_creates_only_opaque_session_and_literal_stable_csrf(auth_harness):
    client, _, _, provider, clock, database = auth_harness
    query, response = _complete_login(client, provider, clock)
    assert response.status_code == 303
    assert response.headers["location"] == UI_ORIGIN + "/ifpmic.html"
    _assert_no_canary(response, CALLBACK_CODE, query["state"][0], query["nonce"][0], provider.access_token)
    cookies = SimpleCookie()
    cookies.load("\n".join(response.headers.get_list("set-cookie")))
    assert "ax_session" in cookies
    session_cookie = cookies["ax_session"]
    token = session_cookie.value
    _decode_b64url_32(token)
    assert session_cookie["path"] == "/"
    assert session_cookie["httponly"]
    assert session_cookie["samesite"].lower() == "lax"
    assert session_cookie["max-age"] == "28800"
    assert not session_cookie["secure"]
    cleared_login = SimpleCookie("\n".join(response.headers.get_list("set-cookie")))["ax_login"]
    assert cleared_login.value == "" and cleared_login["path"] == "/auth" and cleared_login["max-age"] == "0"
    assert cleared_login["httponly"] and cleared_login["samesite"].lower() == "lax"
    assert not cleared_login["domain"] and not cleared_login["secure"]
    assert provider.token_body["code"] == [CALLBACK_CODE]
    assert provider.token_authorization is not None and provider.token_authorization.startswith("Basic ")
    basic = base64.b64decode(provider.token_authorization.removeprefix("Basic ")).decode("utf-8")
    assert basic == f"{CLIENT_ID}:{CLIENT_SECRET}"
    assert provider.token_accept_encoding == "identity"

    session = client.get("/api/v1/session")
    assert session.status_code == 200
    assert set(session.json()) == {"user_id", "csrf_token", "mode"}
    assert session.json()["mode"] == "mock"
    assert session.json()["csrf_token"] == _expected_csrf(CSRF_KEY, token)
    assert len(session.json()["csrf_token"]) == 43
    assert session.headers.get("cache-control") == "no-store"

    users, sessions, transactions = _session_rows(database)
    assert len(users) == len(sessions) == len(transactions) == 1
    user_id, identity_subject, display_name = users[0]
    assert identity_subject == json.dumps([provider.issuer, "synthetic-subject-01"], ensure_ascii=True, separators=(",", ":"))
    assert display_name == "IFPMIC user"
    assert sessions[0][0] == hashlib.sha256(token.encode("ascii")).hexdigest()
    assert sessions[0][1] == user_id
    assert sessions[0][3] - sessions[0][2] == timedelta(hours=8)
    assert transactions[0][0] == hashlib.sha256(query["state"][0].encode("ascii")).hexdigest()
    assert transactions[0][1] == hashlib.sha256(provider.browser_cookie.encode("ascii")).hexdigest()
    assert transactions[0][2] == query["nonce"][0]
    assert transactions[0][3] == provider.token_body["code_verifier"][0]
    assert transactions[0][5] is not None


@pytest.mark.parametrize(
    ("claim_changes", "removed", "expected_status"),
    [
        ({"exp": "at_now"}, (), 401),
        ({"exp": "before_now"}, (), 401),
        ({"exp": "after_now"}, (), 303),
        ({"nbf": "at_now"}, (), 303),
        ({"nbf": "after_now"}, (), 401),
        ({"nbf": "before_now"}, (), 303),
        ({"iat": "at_now"}, (), 303),
        ({"iat": "after_now"}, (), 401),
        ({"exp": True}, (), 401),
        ({"exp": float("nan")}, (), 401),
        ({"iat": float("inf")}, (), 401),
        ({"aud": [CLIENT_ID, CLIENT_ID]}, (), 401),
        ({"aud": [CLIENT_ID, "other-audience"]}, (), 401),
        ({"aud": [CLIENT_ID, "other-audience"], "azp": CLIENT_ID}, (), 303),
        ({"aud": [CLIENT_ID]}, (), 303),
        ({"aud": [CLIENT_ID, "other-audience"]}, (), 401),
        ({"aud": CLIENT_ID, "azp": "other-client"}, (), 401),
        ({"aud": "wrong-client"}, (), 401),
        ({"aud": 7}, (), 401),
        ({"iss": "https://wrong-issuer.example"}, (), 401),
        ({"nonce": "wrong-nonce"}, (), 401),
        ({"sub": ""}, (), 401),
        ({"sub": "bad\x00subject"}, (), 401),
        ({"sub": "\ud800"}, (), 401),
        ({"aud": [CLIENT_ID, "other-audience"], "azp": "other-client"}, (), 401),
        ({}, ("exp",), 401),
        ({}, ("iat",), 401),
        ({}, ("sub",), 401),
    ],
)
def test_signed_id_token_claim_oracle(auth_harness, claim_changes, removed, expected_status):
    client, _, _, provider, clock, database = auth_harness
    query, _ = _start_login(client, provider, clock)
    now = clock().timestamp()
    provider.claim_overrides = {
        key: {"at_now": now, "before_now": now - 1, "after_now": now + 1}[value]
        if value in ("at_now", "before_now", "after_now") else value
        for key, value in claim_changes.items()
    }
    provider.claim_removals = set(removed)
    response = _callback(client, query)
    assert response.status_code == expected_status
    if expected_status == 401:
        _assert_fixed_error(response, status=401, code="AUTH_REQUIRED")
        assert _session_rows(database)[0] == []
    else:
        assert response.headers["location"] == UI_ORIGIN + "/ifpmic.html"


@pytest.mark.parametrize(
    ("alg", "kid", "use_private_jwk", "expected_status"),
    [
        ("HS256", KEY_ID, False, 401),
        ("none", KEY_ID, False, 401),
        ("RS256", "unknown-kid", False, 401),
        ("RS256", KEY_ID, True, 401),
    ],
)
def test_jws_algorithm_key_and_private_jwks_rejections(auth_harness, alg, kid, use_private_jwk, expected_status):
    client, _, _, provider, clock, database = auth_harness
    query, _ = _start_login(client, provider, clock)
    provider.claim_overrides = {}
    if use_private_jwk:
        jwk = provider.public_jwk()
        jwk["d"] = "private-test-material"
        provider.jwks_document = {"keys": [jwk]}
    provider.token_alg = alg
    provider.token_kid = kid
    response = _callback(client, query)
    assert response.status_code == expected_status
    if expected_status == 401:
        _assert_fixed_error(response, status=401, code="AUTH_REQUIRED")
        assert _session_rows(database)[0] == []


def test_rsa_jwks_other_private_parameter_is_rejected(auth_harness):
    client, _, _, provider, clock, database = auth_harness
    query, _ = _start_login(client, provider, clock)
    jwk = provider.public_jwk()
    jwk["oth"] = [{"r": "synthetic-private-prime"}]
    provider.jwks_document = {"keys": [jwk]}

    response = _callback(client, query)

    _assert_fixed_error(response, status=401, code="AUTH_REQUIRED")
    assert _session_rows(database)[0] == []
    assert _session_rows(database)[1] == []


def test_signature_from_unpublished_key_is_rejected(auth_harness):
    from cryptography.hazmat.primitives.asymmetric import rsa

    client, _, _, provider, clock, database = auth_harness
    query, _ = _start_login(client, provider, clock)
    provider.signing_key_override = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    response = _callback(client, query)
    _assert_fixed_error(response, status=401, code="AUTH_REQUIRED")
    assert _session_rows(database)[0] == []


def test_untrusted_jws_header_cannot_select_a_key_url(auth_harness):
    client, _, _, provider, clock, database = auth_harness
    query, _ = _start_login(client, provider, clock)
    provider.extra_token_headers = {"jku": "http://127.0.0.1:9/attacker-keys"}
    response = _callback(client, query)
    _assert_fixed_error(response, status=401, code="AUTH_REQUIRED")
    # Verification fetches only the configured JWKS endpoint; the untrusted
    # token header never supplies a network target.
    assert provider.jwks_request_count == 1
    assert _session_rows(database)[0] == []


def test_code_length_limit_is_enforced_before_exchange(auth_harness):
    client, _, _, provider, clock, database = auth_harness
    query, _ = _start_login(client, provider, clock)
    response = _callback(client, query, code="x" * 4097)
    _assert_fixed_error(response, status=401, code="AUTH_REQUIRED")
    assert provider.token_request_count == 0
    assert _session_rows(database)[0] == []


@pytest.mark.parametrize(("endpoint", "target_size", "chunked", "expected_status"), [
    ("token", 65536, False, 303),
    ("jwks", 65536, False, 303),
    ("token", 65537, True, 503),
    ("jwks", 65537, True, 503),
])
def test_oidc_stream_byte_limit_including_chunked_response(auth_harness, endpoint, target_size, chunked,
                                                             expected_status):
    client, _, _, provider, clock, database = auth_harness
    query, _ = _start_login(client, provider, clock)
    if endpoint == "token":
        provider.token_target_size = target_size
        if chunked:
            provider.token_response_headers = {"Transfer-Encoding": "chunked"}
    else:
        provider.jwks_target_size = target_size
        if chunked:
            provider.jwks_response_headers = {"Transfer-Encoding": "chunked"}
    response = _callback(client, query)
    assert response.status_code == expected_status
    if expected_status == 303:
        assert response.headers["location"] == UI_ORIGIN + "/ifpmic.html"
    else:
        _assert_fixed_error(response, status=503, code="DEPENDENCY_UNAVAILABLE")
        assert _session_rows(database)[1] == []


@pytest.mark.parametrize(("endpoint", "headers"), [
    ("token", {"Content-Encoding": "gzip"}),
    ("jwks", {"Content-Encoding": "br"}),
    ("token", {"Location": "http://127.0.0.1:9/redirect"}),
    ("jwks", {"Location": "http://127.0.0.1:9/redirect"}),
])
def test_oidc_rejects_compression_and_redirects_without_following(auth_harness, endpoint, headers):
    client, _, _, provider, clock, database = auth_harness
    query, _ = _start_login(client, provider, clock)
    if endpoint == "token":
        provider.token_response_headers = headers
        if "Location" in headers:
            provider.token_status = 302
    else:
        provider.jwks_response_headers = headers
        if "Location" in headers:
            # JWKS is always served by do_GET with status 200, so a redirect is
            # represented by an explicit response status control below.
            provider.jwks_status = 302
    response = _callback(client, query)
    _assert_fixed_error(response, status=503, code="DEPENDENCY_UNAVAILABLE")
    assert _session_rows(database)[1] == []


@pytest.mark.parametrize("endpoint", ["token", "jwks"])
def test_oidc_non_success_http_status_is_fixed_dependency_error(auth_harness, endpoint):
    client, _, _, provider, clock, database = auth_harness
    query, _ = _start_login(client, provider, clock)
    if endpoint == "token":
        provider.token_status = 500
    else:
        provider.jwks_status = 500
    response = _callback(client, query)
    _assert_fixed_error(response, status=503, code="DEPENDENCY_UNAVAILABLE")
    assert _session_rows(database)[1] == []


def test_cross_browser_state_mismatch_does_not_consume_valid_browser_transaction(auth_harness):
    client_a, _, _, provider, clock, database = auth_harness
    query_a, _ = _start_login(client_a, provider, clock)
    client_b = TestClient(create_app(_settings(provider, _runtime_dsn(database)), clock=clock),
                          base_url=API_ORIGIN, follow_redirects=False)
    try:
        query_b, _ = _start_login(client_b, provider, clock)
        response = _callback(client_b, query_a)
        _assert_fixed_error(response, status=401, code="AUTH_REQUIRED")
        assert provider.token_request_count == 0
        # The matching browser can still complete its own transaction.
        provider.register_authorization(query_a)
        provider.claim_time = clock().timestamp()
        response_a = _callback(client_a, query_a)
        assert response_a.status_code == 303
        assert len(_session_rows(database)[0]) == 1
        assert query_a["state"] != query_b["state"]
    finally:
        client_b.close()


def test_consumed_callback_cannot_be_replayed_and_failure_requires_fresh_login(auth_harness):
    client, _, _, provider, clock, database = auth_harness
    query, _ = _start_login(client, provider, clock)
    provider.token_error = "invalid_grant"
    provider.token_status = 400
    first = _callback(client, query)
    _assert_fixed_error(first, status=401, code="AUTH_REQUIRED")
    assert provider.token_request_count == 1
    with psycopg.connect(_owner_dsn(database)) as connection:
        row = connection.execute(
            "SELECT consumed_at FROM ifpmic.oidc_login_transactions WHERE state_hash=%s",
            (hashlib.sha256(query["state"][0].encode("ascii")).hexdigest(),),
        ).fetchone()
    assert row is not None and row[0] is not None
    second = _callback(client, query)
    _assert_fixed_error(second, status=401, code="AUTH_REQUIRED")
    assert provider.token_request_count == 1
    assert _session_rows(database)[1] == []


@pytest.mark.parametrize(
    ("http_status", "provider_error", "expected_status"),
    [
        (400, "invalid_grant", 401),
        (401, "invalid_grant", 401),
        (400, "invalid_request", 503),
        (401, "invalid_request", 503),
        (400, "invalid_client", 503),
        (401, "server_error", 503),
        (400, "temporarily_unavailable", 503),
        (400, "provider-error-private-canary", 503),
        (200, "invalid_grant", 503),
        (500, "invalid_grant", 503),
    ],
)
def test_token_provider_error_mapping_is_literal_and_fixed(auth_harness, http_status, provider_error,
                                                             expected_status):
    client, _, _, provider, clock, database = auth_harness
    query, _ = _start_login(client, provider, clock)
    provider.token_status = http_status
    provider.token_error = provider_error
    response = _callback(client, query)
    if expected_status == 401:
        _assert_fixed_error(response, status=401, code="AUTH_REQUIRED")
    else:
        _assert_fixed_error(response, status=503, code="DEPENDENCY_UNAVAILABLE")
    _assert_no_canary(response, "provider-error-private-canary", "private", query["state"][0])
    assert provider.token_request_count == 1
    assert _session_rows(database)[0] == []
    assert _session_rows(database)[1] == []


@pytest.mark.parametrize("expires_delta", [timedelta(0), timedelta(seconds=-1)])
def test_login_transaction_expiry_is_strict_at_boundary(auth_harness, expires_delta):
    client, _, _, provider, clock, database = auth_harness
    query, _ = _start_login(client, provider, clock)
    with psycopg.connect(_owner_dsn(database)) as connection:
        connection.execute(
            "UPDATE ifpmic.oidc_login_transactions SET expires_at=%s WHERE state_hash=%s",
            (clock() + expires_delta, hashlib.sha256(query["state"][0].encode("ascii")).hexdigest()),
        )
    response = _callback(client, query)
    _assert_fixed_error(response, status=401, code="AUTH_REQUIRED")
    assert provider.token_request_count == 0
    assert _session_rows(database)[1] == []


def test_concurrent_callback_consumes_browser_state_once(auth_harness):
    from concurrent.futures import ThreadPoolExecutor

    client, _, _, provider, clock, database = auth_harness
    query, login_response = _start_login(client, provider, clock)
    browser = SimpleCookie("\n".join(login_response.headers.get_list("set-cookie")))["ax_login"].value
    second = TestClient(create_app(_settings(provider, _runtime_dsn(database)), clock=clock),
                        base_url=API_ORIGIN, follow_redirects=False)
    second.cookies.set("ax_login", browser, path="/auth")
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda c: _callback(c, query), (client, second)))
        assert sorted(response.status_code for response in results) == [303, 401]
        assert provider.token_request_count == 1
        assert len(_session_rows(database)[1]) == 1
    finally:
        second.close()


@pytest.mark.parametrize(
    ("query_suffix", "expected_error"),
    [
        ("&code=duplicate-code", "AUTH_REQUIRED"),
        ("&state=duplicate-state", "AUTH_REQUIRED"),
        ("&unknown=1", "AUTH_REQUIRED"),
        ("&iss=https%3A%2F%2Fwrong-issuer.example", "AUTH_REQUIRED"),
    ],
)
def test_callback_query_allowlist_and_duplicate_parameters(auth_harness, query_suffix, expected_error):
    client, _, _, provider, clock, database = auth_harness
    query, _ = _start_login(client, provider, clock)
    response = _callback(client, query, extra=query_suffix)
    _assert_fixed_error(response, status=401, code=expected_error)
    _assert_no_canary(response, "duplicate-code", "duplicate-state")
    assert _session_rows(database)[0] == []
    assert provider.token_request_count == 0


@pytest.mark.parametrize(
    "raw_query",
    [
        "code=%FF&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "code=%ZZ&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "code=abc%00def&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "x" * 8193,
    ],
)
def test_callback_malformed_utf8_controls_and_size_fail_closed(auth_harness, raw_query):
    client, _, _, _, _, database = auth_harness
    response = client.get("/auth/callback?" + raw_query, follow_redirects=False)
    _assert_fixed_error(response, status=401, code="AUTH_REQUIRED")
    assert _session_rows(database)[0] == []


def test_provider_error_description_is_never_redirected_or_echoed(auth_harness):
    client, _, _, provider, clock, database = auth_harness
    query, _ = _start_login(client, provider, clock)
    response = client.get(
        "/auth/callback?" + urlencode({"state": query["state"][0], "error": "access_denied",
                                        "error_description": "provider-error-canary"}),
        follow_redirects=False,
    )
    _assert_fixed_error(response, status=401, code="AUTH_REQUIRED")
    _assert_no_canary(response, "provider-error-canary")
    assert "location" not in response.headers or "provider-error-canary" not in response.headers["location"]
    assert _session_rows(database)[0] == []


def test_optional_callback_issuer_and_session_state_are_accepted_only_when_issuer_matches(auth_harness):
    from urllib.parse import quote

    client, _, _, provider, clock, database = auth_harness
    query, _ = _start_login(client, provider, clock)
    extra = "&iss=" + quote(provider.issuer, safe="") + "&session_state=opaque-state"
    response = _callback(client, query, extra=extra)
    assert response.status_code == 303
    assert len(_session_rows(database)[0]) == 1


@pytest.mark.parametrize(
    ("session_age", "expected_status"),
    [
        (timedelta(minutes=29, seconds=59), 200),
        (timedelta(minutes=30), 401),
        (timedelta(minutes=30, seconds=1), 401),
    ],
)
def test_idle_timeout_exact_boundary(auth_harness, session_age, expected_status):
    client, _, _, provider, clock, database = auth_harness
    _, response = _complete_login(client, provider, clock)
    assert response.status_code == 303
    token = client.cookies.get("ax_session")
    now = clock()
    with psycopg.connect(_owner_dsn(database)) as connection:
        connection.execute(
            "UPDATE ifpmic.user_sessions SET last_seen_at=%s WHERE token_hash=%s",
            (now - session_age, hashlib.sha256(token.encode("ascii")).hexdigest()),
        )
    response = client.get("/api/v1/session")
    assert response.status_code == expected_status
    if expected_status == 401:
        _assert_fixed_error(response, status=401, code="AUTH_REQUIRED")


def test_absolute_session_expiry_exact_boundary_and_no_extension(auth_harness):
    client, _, _, provider, clock, database = auth_harness
    _, response = _complete_login(client, provider, clock)
    assert response.status_code == 303
    token = client.cookies.get("ax_session")
    token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
    now = clock()
    with psycopg.connect(_owner_dsn(database)) as connection:
        created, expires = connection.execute(
            "SELECT created_at,expires_at FROM ifpmic.user_sessions WHERE token_hash=%s", (token_hash,)
        ).fetchone()
    assert expires - created == timedelta(hours=8)
    with psycopg.connect(_owner_dsn(database)) as connection:
        connection.execute(
            "UPDATE ifpmic.user_sessions SET last_seen_at=%s WHERE token_hash=%s",
            (expires - timedelta(microseconds=1), token_hash),
        )
    clock.value = expires - timedelta(microseconds=1)
    assert client.get("/api/v1/session").status_code == 200
    clock.value = expires
    expired = client.get("/api/v1/session")
    _assert_fixed_error(expired, status=401, code="AUTH_REQUIRED")
    with psycopg.connect(_owner_dsn(database)) as connection:
        after = connection.execute(
            "SELECT expires_at FROM ifpmic.user_sessions WHERE token_hash=%s", (token_hash,)
        ).fetchone()[0]
    assert after == expires


def test_login_rotates_session_and_csrf_stays_stable_during_get(auth_harness):
    client, _, _, provider, clock, database = auth_harness
    first_query, first_response = _complete_login(client, provider, clock)
    assert first_response.status_code == 303
    first_token = SimpleCookie("\n".join(first_response.headers.get_list("set-cookie")))["ax_session"].value
    first_user = client.get("/api/v1/session").json()
    assert first_user["csrf_token"] == _expected_csrf(CSRF_KEY, first_token)
    assert client.get("/api/v1/session").json()["csrf_token"] == first_user["csrf_token"]

    second_query, _ = _start_login(client, provider, clock)
    second_response = _callback(client, second_query)
    assert second_response.status_code == 303
    second_token = client.cookies.get("ax_session")
    assert second_token != first_token
    second_session = client.get("/api/v1/session").json()
    assert second_session["csrf_token"] == _expected_csrf(CSRF_KEY, second_token)
    assert second_session["csrf_token"] != first_user["csrf_token"]
    _, sessions, _ = _session_rows(database)
    assert len(sessions) == 2
    old = next(row for row in sessions if row[0] == hashlib.sha256(first_token.encode("ascii")).hexdigest())
    new = next(row for row in sessions if row[0] == hashlib.sha256(second_token.encode("ascii")).hexdigest())
    assert old[5] is not None and new[5] is None
    assert first_query["state"] != second_query["state"]


def test_csrf_token_is_stable_across_application_restart(auth_harness):
    client, _, settings, provider, clock, database = auth_harness
    _, login_response = _complete_login(client, provider, clock)
    assert login_response.status_code == 303
    old_csrf = client.get("/api/v1/session").json()["csrf_token"]
    session_token = client.cookies.get("ax_session")

    restarted = TestClient(create_app(settings, clock=clock), base_url=API_ORIGIN, follow_redirects=False)
    try:
        restarted.cookies.set("ax_session", session_token, path="/")
        response = restarted.get("/api/v1/session")
        assert response.status_code == 200
        assert response.json()["csrf_token"] == old_csrf
    finally:
        restarted.close()


@pytest.mark.parametrize(
    ("hook_point", "status", "code", "persisted_sessions"),
    [
        ("session_before_commit", 503, "DEPENDENCY_UNAVAILABLE", 0),
        ("session_after_commit", 503, "COMMIT_UNCERTAIN", 1),
    ],
)
def test_session_commit_fault_never_returns_success_cookie(auth_harness, hook_point, status, code,
                                                             persisted_sessions):
    _, _, settings, provider, clock, database = auth_harness

    def fault(point):
        if point == hook_point:
            raise RuntimeError("private commit fault canary")

    client = TestClient(create_app(settings, clock=clock, fault_hook=fault),
                        base_url=API_ORIGIN, follow_redirects=False)
    try:
        query, _ = _start_login(client, provider, clock)
        response = _callback(client, query)
        _assert_fixed_error(response, status=status, code=code)
        assert not any("ax_session=" in value for value in response.headers.get_list("set-cookie"))
        _assert_no_canary(response, "private commit fault canary", CALLBACK_CODE, query["state"][0])
        with psycopg.connect(_owner_dsn(database)) as connection:
            count = connection.execute("SELECT count(*) FROM ifpmic.user_sessions").fetchone()[0]
        assert count == persisted_sessions
        assert client.get("/api/v1/session").status_code == 401
    finally:
        client.close()


def test_logout_requires_session_exact_csrf_and_origin_then_revokes(auth_harness):
    client, _, _, provider, clock, database = auth_harness
    _, login_response = _complete_login(client, provider, clock)
    assert login_response.status_code == 303
    session_token = client.cookies.get("ax_session")
    csrf = client.get("/api/v1/session").json()["csrf_token"]

    no_origin = client.post("/auth/logout", headers={"X-CSRF-Token": csrf}, follow_redirects=False)
    _assert_fixed_error(no_origin, status=403, code="ORIGIN_FORBIDDEN")
    bad_origin = client.post("/auth/logout", headers={"X-CSRF-Token": csrf, "Origin": "http://127.0.0.1:9999"})
    _assert_fixed_error(bad_origin, status=403, code="ORIGIN_FORBIDDEN")
    bad_csrf = client.post("/auth/logout", headers={"X-CSRF-Token": "wrong", "Origin": UI_ORIGIN})
    _assert_fixed_error(bad_csrf, status=403, code="CSRF_INVALID")

    success = client.post("/auth/logout", headers={"X-CSRF-Token": csrf, "Origin": UI_ORIGIN}, follow_redirects=False)
    assert success.status_code == 204 and not success.content
    cleared_session = SimpleCookie("\n".join(success.headers.get_list("set-cookie")))["ax_session"]
    assert cleared_session.value == "" and cleared_session["path"] == "/" and cleared_session["max-age"] == "0"
    assert cleared_session["httponly"] and cleared_session["samesite"].lower() == "lax"
    assert not cleared_session["domain"] and not cleared_session["secure"]
    assert client.get("/api/v1/session").status_code == 401
    _, sessions, _ = _session_rows(database)
    row = next(item for item in sessions if item[0] == hashlib.sha256(session_token.encode("ascii")).hexdigest())
    assert row[5] is not None


@pytest.mark.parametrize(
    ("headers", "expected_code"),
    [
        ([ ("Cookie", "ax_session=one"), ("Cookie", "ax_session=two") ], "AUTH_REQUIRED"),
        ([ ("Cookie", "ax_session=one; ax_session=two") ], "AUTH_REQUIRED"),
        ([ ("Authorization", "Bearer spoof-one"), ("Authorization", "Bearer spoof-two") ], "AUTH_REQUIRED"),
        ([ ("Authorization", "Bearer spoof"), ("X-User-ID", "spoof"), ("X-Company-ID", "spoof"),
           ("X-Owner-ID", "spoof"), ("X-Local-Board", "true"), ("X-Worker", "true") ], "AUTH_REQUIRED"),
    ],
)
def test_duplicate_or_spoofed_auth_headers_never_authenticate(auth_harness, headers, expected_code):
    client, _, _, _, _, database = auth_harness
    response = client.get("/api/v1/session", headers=headers)
    _assert_fixed_error(response, status=401, code=expected_code)
    assert _session_rows(database)[0] == []


def test_spoofed_actor_headers_do_not_override_valid_cookie_session(auth_harness):
    client, _, _, provider, clock, _ = auth_harness
    _, response = _complete_login(client, provider, clock)
    assert response.status_code == 303
    expected_user = client.get("/api/v1/session").json()["user_id"]
    response = client.get("/api/v1/session", headers={
        "Authorization": "Bearer spoofed", "X-User-ID": "00000000-0000-0000-0000-000000000001",
        "X-Company-ID": "other", "X-Owner-ID": "00000000-0000-0000-0000-000000000002",
        "X-Local-Board": "true", "X-Worker": "true",
    })
    assert response.status_code == 200
    assert response.json()["user_id"] == expected_user


def test_duplicate_origin_and_csrf_headers_are_rejected(auth_harness):
    client, _, _, provider, clock, _ = auth_harness
    _, response = _complete_login(client, provider, clock)
    assert response.status_code == 303
    csrf = client.get("/api/v1/session").json()["csrf_token"]
    origin_error = client.post("/auth/logout", headers=[("Origin", UI_ORIGIN), ("Origin", UI_ORIGIN),
                                                           ("X-CSRF-Token", csrf)])
    _assert_fixed_error(origin_error, status=403, code="ORIGIN_FORBIDDEN")
    csrf_error = client.post("/auth/logout", headers=[("Origin", UI_ORIGIN), ("X-CSRF-Token", csrf),
                                                        ("X-CSRF-Token", csrf)])
    _assert_fixed_error(csrf_error, status=403, code="CSRF_INVALID")


def test_host_cors_and_preflight_are_exact(auth_harness):
    client, _, _, _, _, _ = auth_harness
    bad_host = client.get("/auth/login", headers={"Host": "evil.example"}, follow_redirects=False)
    _assert_fixed_error(bad_host, status=422, code="INVALID_REQUEST")
    preflight = client.options(
        "/auth/logout",
        headers={"Origin": UI_ORIGIN, "Access-Control-Request-Method": "POST",
                 "Access-Control-Request-Headers": "content-type,x-csrf-token,idempotency-key"},
    )
    assert preflight.status_code == 204
    assert preflight.headers.get("access-control-allow-origin") == UI_ORIGIN
    assert preflight.headers.get("access-control-allow-credentials") == "true"
    assert "origin" in preflight.headers.get("vary", "").lower()
    assert "*" not in preflight.headers.get("access-control-allow-origin", "")
    denied = client.options(
        "/auth/logout",
        headers={"Origin": UI_ORIGIN, "Access-Control-Request-Method": "DELETE",
                 "Access-Control-Request-Headers": "x-evil"},
    )
    _assert_fixed_error(denied, status=403, code="FORBIDDEN")


def test_real_uvicorn_callback_stdout_stderr_and_application_log_canaries(auth_database, oidc_provider,
                                                                           frozen_clock):
    """Exercise the real service entrypoint and retain its private process logs."""
    import stat

    database = auth_database
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    api_origin = f"http://127.0.0.1:{port}"
    settings = _settings(oidc_provider, _runtime_dsn(database), api_origin=api_origin,
                         redirect_uri=api_origin + "/auth/callback")
    private_root = Path("workflow-artifacts/verification/private/b02-g3").resolve()
    private_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    private_root.chmod(0o700)
    run_id = uuid4().hex
    config_path = private_root / f"uvicorn-{run_id}.json"
    stdout_path = private_root / f"uvicorn-{run_id}.stdout.log"
    stderr_path = private_root / f"uvicorn-{run_id}.stderr.log"
    config = {
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
    }
    config_fd = os.open(config_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(config_fd, "w", encoding="utf-8") as config_file:
        config_file.write(json.dumps(config, separators=(",", ":")))
    argv = [str(Path(".ifpmic-venv/bin/python").absolute()), "-m", "services.ifpmic_api.serve"]
    env = {
        "PATH": os.pathsep.join([str(Path(".ifpmic-venv/bin").resolve()), "/usr/bin", "/bin"]),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "IFPMIC_API_CONFIG": str(config_path),
        "IFPMIC_API_PORT": str(port),
    }
    stdout_fd = os.open(stdout_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    stderr_fd = os.open(stderr_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    process = None
    canaries: list[str] = []
    observed_cases: dict[str, int] = {}
    try:
        process = subprocess.Popen(argv, cwd=Path(__file__).resolve().parents[2], env=env,
                                   stdin=subprocess.DEVNULL, stdout=stdout_fd, stderr=stderr_fd,
                                   start_new_session=True)
        os.close(stdout_fd)
        stdout_fd = -1
        os.close(stderr_fd)
        stderr_fd = -1
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            if process.poll() is not None:
                pytest.fail("IFPMIC Uvicorn exited before loopback readiness")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    break
            except OSError:
                time.sleep(0.05)
        else:
            pytest.fail("IFPMIC Uvicorn did not become ready on the selected loopback port")

        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        connection.request("GET", "/auth/login", headers={"Host": f"127.0.0.1:{port}"})
        login = connection.getresponse()
        observed_cases["success_login"] = login.status
        assert login.status == 303
        location = login.getheader("Location")
        cookies = SimpleCookie("\n".join(login.headers.get_all("Set-Cookie", [])))
        login.read()
        assert "ax_login" in cookies
        login_cookie = cookies["ax_login"].value
        query = parse_qs(urlsplit(location).query, keep_blank_values=True, strict_parsing=True)
        oidc_provider.register_authorization(query)
        oidc_provider.expected_code = "g3-uvicorn-code-canary"
        oidc_provider.claim_time = datetime.now(timezone.utc).timestamp()
        canaries.extend(["g3-uvicorn-code-canary", query["state"][0], login_cookie,
                         oidc_provider.access_token])

        connection.request("GET", "/auth/callback?" + urlencode({
            "code": "g3-uvicorn-code-canary", "state": query["state"][0],
        }), headers={"Host": f"127.0.0.1:{port}", "Cookie": f"ax_login={login_cookie}"})
        callback = connection.getresponse()
        callback.read()
        observed_cases["success"] = callback.status
        assert callback.status == 303
        assert callback.getheader("Location") == UI_ORIGIN + "/ifpmic.html"
        session_headers = callback.headers.get_all("Set-Cookie", [])
        session_cookies = SimpleCookie("\n".join(session_headers))
        assert "ax_session" in session_cookies
        canaries.append(session_cookies["ax_session"].value)

        # A replay is rejected before any second exchange and its raw query is
        # still not logged by the actual server.
        connection.request("GET", "/auth/callback?" + urlencode({
            "code": "g3-uvicorn-code-canary", "state": query["state"][0],
        }), headers={"Host": f"127.0.0.1:{port}", "Cookie": f"ax_login={login_cookie}"})
        replay = connection.getresponse()
        replay.read()
        observed_cases["replay"] = replay.status
        assert replay.status == 401
        connection.close()

        expired_connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        expired_connection.request("GET", "/auth/login", headers={"Host": f"127.0.0.1:{port}"})
        expired_login = expired_connection.getresponse()
        expired_location = expired_login.getheader("Location")
        expired_headers = expired_login.headers.get_all("Set-Cookie", [])
        expired_login.read()
        expired_query = parse_qs(urlsplit(expired_location).query,
                                 keep_blank_values=True, strict_parsing=True)
        expired_cookie = SimpleCookie("\n".join(expired_headers))["ax_login"].value
        canaries.extend([expired_query["state"][0], expired_cookie])
        with psycopg.connect(_owner_dsn(database)) as owner:
            owner.execute(
                "UPDATE ifpmic.oidc_login_transactions SET expires_at=%s WHERE state_hash=%s",
                (datetime.now(timezone.utc) - timedelta(microseconds=1),
                 hashlib.sha256(expired_query["state"][0].encode("ascii")).hexdigest()),
            )
        prior_token_requests = oidc_provider.token_request_count
        expired_connection.request("GET", "/auth/callback?" + urlencode({
            "code": "g3-expired-code-canary", "state": expired_query["state"][0],
        }), headers={"Host": f"127.0.0.1:{port}", "Cookie": f"ax_login={expired_cookie}"})
        expired = expired_connection.getresponse()
        expired_body = expired.read()
        observed_cases["expired_state"] = expired.status
        assert expired.status == 401 and b"AUTH_REQUIRED" in expired_body
        assert oidc_provider.token_request_count == prior_token_requests
        assert b"g3-expired-code-canary" not in expired_body

        invalid_state = "g3-invalid-state-canary"
        canaries.append(invalid_state)
        expired_connection.request("GET", "/auth/callback?" + urlencode({
            "code": "g3-invalid-code-canary", "state": invalid_state,
        }), headers={"Host": f"127.0.0.1:{port}"})
        invalid = expired_connection.getresponse()
        invalid_body = invalid.read()
        observed_cases["invalid_state"] = invalid.status
        assert invalid.status == 401 and b"AUTH_REQUIRED" in invalid_body
        assert b"g3-invalid-code-canary" not in invalid_body
        expired_connection.close()

        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        connection.request("GET", "/auth/login", headers={"Host": f"127.0.0.1:{port}"})
        second_login = connection.getresponse()
        second_location = second_login.getheader("Location")
        second_login.read()
        second_query = parse_qs(urlsplit(second_location).query,
                                keep_blank_values=True, strict_parsing=True)
        second_cookie = SimpleCookie("\n".join(second_login.headers.get_all("Set-Cookie", [])))["ax_login"].value
        error_description = "g3-uvicorn-error-description-canary"
        canaries.extend([second_query["state"][0], second_cookie, error_description])
        connection.request("GET", "/auth/callback?" + urlencode({
            "error": "access_denied", "error_description": error_description,
            "state": second_query["state"][0],
        }), headers={"Host": f"127.0.0.1:{port}", "Cookie": f"ax_login={second_cookie}"})
        failed = connection.getresponse()
        body = failed.read()
        observed_cases["provider_error"] = failed.status
        assert failed.status == 401
        assert b"AUTH_REQUIRED" in body
        connection.close()
    finally:
        if process is not None and process.poll() is None:
            process.send_signal(signal.SIGINT)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        if stdout_fd >= 0:
            os.close(stdout_fd)
        if stderr_fd >= 0:
            os.close(stderr_fd)
        config_path.unlink(missing_ok=True)

    assert stat.S_IMODE(private_root.stat().st_mode) == 0o700
    assert stat.S_IMODE(stdout_path.stat().st_mode) == 0o600
    assert stat.S_IMODE(stderr_path.stat().st_mode) == 0o600
    assert process is not None and process.returncode == 0
    logs = stdout_path.read_bytes() + stderr_path.read_bytes()
    for canary in canaries:
        assert canary.encode("utf-8") not in logs
    with pytest.raises(ProcessLookupError):
        os.kill(process.pid, 0)

    observation_path = os.environ.get("IFPMIC_AUTH_TEST_OBSERVATION_PATH")
    if observation_path:
        import hashlib as _hashlib
        import stat as _stat

        observation = {
            "kind": "ifpmic.g3.service-observation.v1",
            "cases": {name: observed_cases[name] for name in
                      ("success", "replay", "provider_error", "expired_state", "invalid_state")},
            "canaries_absent": True,
            "service_exit_code": process.returncode,
            "pid_alive": False,
            "logs": {
                "stdout": {"sha256": _hashlib.sha256(stdout_path.read_bytes()).hexdigest(),
                           "bytes": stdout_path.stat().st_size},
                "stderr": {"sha256": _hashlib.sha256(stderr_path.read_bytes()).hexdigest(),
                           "bytes": stderr_path.stat().st_size},
            },
            "private_directory_mode": oct(_stat.S_IMODE(private_root.stat().st_mode)),
            "stdout_mode": oct(_stat.S_IMODE(stdout_path.stat().st_mode)),
            "stderr_mode": oct(_stat.S_IMODE(stderr_path.stat().st_mode)),
        }
        destination = Path(observation_path)
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(json.dumps(observation, sort_keys=True, separators=(",", ":")) + "\n")


@pytest.mark.parametrize(
    ("changes", "expected_valid"),
    [
        ({"mode": "real"}, False),
        ({"api_origin": "http://localhost:18321"}, False),
        ({"allowed_ui_origins": ("*",)}, False),
        ({"csrf_key": b"short"}, False),
        ({"signing_algorithms": ("HS256",)}, False),
        ({"signing_algorithms": ("RS256", "RS256")}, False),
        ({"client_secret": None}, False),
        ({"client_auth_method": "none", "client_secret": None}, True),
        ({"auth_gc_interval_seconds": 0}, False),
        ({"auth_gc_interval_seconds": 61}, False),
        ({"auth_gc_interval_seconds": True}, False),
        ({"auth_gc_interval_seconds": 1.0}, False),
    ],
)
def test_settings_reject_unapproved_authentication_configuration(oidc_provider, auth_database, changes, expected_valid):
    values = {
        "mode": "mock", "api_origin": API_ORIGIN, "issuer": oidc_provider.issuer,
        "client_id": CLIENT_ID, "authorization_endpoint": oidc_provider.authorization_endpoint,
        "token_endpoint": oidc_provider.token_endpoint, "jwks_uri": oidc_provider.jwks_uri,
        "redirect_uri": API_ORIGIN + "/auth/callback", "post_login_url": UI_ORIGIN + "/ifpmic.html",
        "allowed_ui_origins": (UI_ORIGIN,), "csrf_key": CSRF_KEY,
        "database_dsn": _runtime_dsn(auth_database), "client_secret": CLIENT_SECRET,
    }
    values.update(changes)
    if expected_valid:
        Settings(**values)
    else:
        with pytest.raises(SettingsError) as raised:
            Settings(**values)
        assert raised.value.code == "SETTINGS_INVALID"
        assert str(raised.value) == "SETTINGS_INVALID"


@pytest.mark.parametrize("field_value", [
    "http://user:password@127.0.0.1:1234/token",
    "http://127.0.0.1:1234/token?redirect=https://attacker.invalid",
    "http://127.0.0.1:1234/token#fragment",
    "http://localhost:1234/token",
    "http://127.0.0.1:1234/token\nX-Injected: true",
])
def test_settings_reject_endpoint_aliases_and_url_confusion(oidc_provider, auth_database, field_value):
    values = {
        "mode": "mock", "api_origin": API_ORIGIN, "issuer": oidc_provider.issuer,
        "client_id": CLIENT_ID, "authorization_endpoint": oidc_provider.authorization_endpoint,
        "token_endpoint": oidc_provider.token_endpoint, "jwks_uri": oidc_provider.jwks_uri,
        "redirect_uri": API_ORIGIN + "/auth/callback", "post_login_url": UI_ORIGIN + "/ifpmic.html",
        "allowed_ui_origins": (UI_ORIGIN,), "csrf_key": CSRF_KEY,
        "database_dsn": _runtime_dsn(auth_database), "client_secret": CLIENT_SECRET,
    }
    values["token_endpoint"] = field_value
    with pytest.raises(SettingsError) as raised:
        Settings(**values)
    assert raised.value.code == "SETTINGS_INVALID"


def test_real_mode_requires_https_for_api_ui_and_all_oidc_endpoints(oidc_provider, auth_database):
    real_values = {
        "mode": "real", "api_origin": "https://api.example.test", "issuer": "https://id.example.test/issuer",
        "client_id": CLIENT_ID, "authorization_endpoint": "https://id.example.test/authorize",
        "token_endpoint": "https://id.example.test/token", "jwks_uri": "https://keys.example.test/jwks",
        "redirect_uri": "https://api.example.test/auth/callback",
        "post_login_url": "https://ui.example.test/ifpmic.html",
        "allowed_ui_origins": ("https://ui.example.test",), "csrf_key": CSRF_KEY,
        "database_dsn": _runtime_dsn(auth_database), "client_secret": CLIENT_SECRET,
    }
    Settings(**real_values)
    for key in ("api_origin", "issuer", "authorization_endpoint", "token_endpoint", "jwks_uri",
                "redirect_uri", "post_login_url", "allowed_ui_origins"):
        mutated = dict(real_values)
        if key == "allowed_ui_origins":
            mutated[key] = ("http://ui.example.test",)
        else:
            mutated[key] = mutated[key].replace("https://", "http://", 1)
        with pytest.raises(SettingsError):
            Settings(**mutated)


def test_load_settings_requires_private_regular_non_symlink_file(tmp_path, oidc_provider, auth_database):
    values = {
        "mode": "mock", "api_origin": API_ORIGIN, "issuer": oidc_provider.issuer,
        "client_id": CLIENT_ID, "authorization_endpoint": oidc_provider.authorization_endpoint,
        "token_endpoint": oidc_provider.token_endpoint, "jwks_uri": oidc_provider.jwks_uri,
        "redirect_uri": API_ORIGIN + "/auth/callback", "post_login_url": UI_ORIGIN + "/ifpmic.html",
        "allowed_ui_origins": [UI_ORIGIN], "csrf_key": base64.urlsafe_b64encode(CSRF_KEY).decode().rstrip("="),
        "database_dsn": _runtime_dsn(auth_database), "client_secret": CLIENT_SECRET,
    }
    path = tmp_path / "settings.json"
    path.write_text(json.dumps(values), encoding="utf-8")
    path.chmod(0o600)
    assert load_settings(path).mode == "mock"
    path.chmod(0o644)
    with pytest.raises(SettingsError):
        load_settings(path)
    path.chmod(0o600)
    alias = tmp_path / "settings-link.json"
    alias.symlink_to(path)
    with pytest.raises(SettingsError):
        load_settings(alias)
    path.write_text('{"mode":"mock","mode":"real"}', encoding="utf-8")
    with pytest.raises(SettingsError):
        load_settings(path)


def _auth_storage_counts(auth_database):
    with psycopg.connect(_owner_dsn(auth_database)) as connection:
        return (
            connection.execute("SELECT count(*) FROM ifpmic.oidc_login_transactions").fetchone()[0],
            connection.execute("SELECT count(*) FROM ifpmic.user_sessions").fetchone()[0],
        )


def test_auth_maintenance_deletes_expired_rows_at_boundary_only(auth_harness):
    _, app, _, _, clock, database = auth_harness
    now = clock()
    login_expired_pending = _seed_login_rows(
        database, count=1, now=now, expires_at=now - timedelta(microseconds=1),
        consumed_at=None, label="expired-pending",
    )
    login_expired_consumed = _seed_login_rows(
        database, count=1, now=now, expires_at=now, consumed_at=now - timedelta(seconds=1),
        label="expired-consumed",
    )
    login_live = _seed_login_rows(
        database, count=1, now=now, expires_at=now + timedelta(microseconds=1),
        consumed_at=None, label="live-pending",
    )
    login_live_consumed = _seed_login_rows(
        database, count=1, now=now, expires_at=now + timedelta(seconds=1),
        consumed_at=now - timedelta(seconds=1), label="live-consumed",
    )
    session_expired = _seed_session_rows(
        database, count=3, now=now, expires_at=now, revoked_at=now - timedelta(seconds=1),
        last_seen_at=now - timedelta(days=1), label="expired-sessions",
    )
    session_live_revoked = _seed_session_rows(
        database, count=1, now=now, expires_at=now + timedelta(seconds=1),
        revoked_at=now - timedelta(days=1), last_seen_at=now - timedelta(days=1), label="live-revoked",
    )
    session_live_idle = _seed_session_rows(
        database, count=1, now=now, expires_at=now + timedelta(seconds=1),
        revoked_at=None, last_seen_at=now - timedelta(days=1), label="live-idle",
    )

    assert app.state.auth.maintenance() == {"login_transactions": 2, "sessions": 3}

    with psycopg.connect(_owner_dsn(database)) as connection:
        login_hashes = {row[0] for row in connection.execute(
            "SELECT state_hash FROM ifpmic.oidc_login_transactions"
        ).fetchall()}
        session_hashes = {row[0] for row in connection.execute(
            "SELECT token_hash FROM ifpmic.user_sessions"
        ).fetchall()}
    assert login_hashes == {hash_value for group in (login_live, login_live_consumed) for hash_value in group}
    assert session_hashes == {hash_value for group in (session_live_revoked, session_live_idle) for hash_value in group}
    assert not ({*login_expired_pending, *login_expired_consumed} & login_hashes)
    assert not (set(session_expired) & session_hashes)


def test_auth_maintenance_deletes_at_most_1000_per_table_and_makes_progress(auth_harness):
    _, app, _, _, clock, database = auth_harness
    now = clock()
    _seed_login_rows(database, count=1001, now=now, expires_at=now - timedelta(seconds=1),
                     consumed_at=None, label="batch-login")
    _seed_session_rows(database, count=1001, now=now, expires_at=now - timedelta(seconds=1),
                       revoked_at=None, last_seen_at=now, label="batch-sessions")

    assert app.state.auth.maintenance() == {"login_transactions": 1000, "sessions": 1000}
    assert _auth_storage_counts(database) == (1, 1)
    assert app.state.auth.maintenance() == {"login_transactions": 1, "sessions": 1}
    assert _auth_storage_counts(database) == (0, 0)


def test_login_admission_enforces_1024_row_cap_and_race_has_one_winner(
    oidc_provider, auth_database, frozen_clock
):
    database = auth_database
    now = frozen_clock()
    _seed_login_rows(database, count=1023, now=now, expires_at=now + timedelta(minutes=5),
                     consumed_at=None, label="capacity-race")
    settings = _settings(oidc_provider, _runtime_dsn(database))
    clients = [
        TestClient(create_app(settings, clock=frozen_clock), base_url=API_ORIGIN, follow_redirects=False)
        for _ in range(2)
    ]
    try:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda client: client.get("/auth/login"), clients))
        assert sorted(response.status_code for response in responses) == [303, 503]
        rejected = next(response for response in responses if response.status_code == 503)
        _assert_fixed_error(rejected, status=503, code="DEPENDENCY_UNAVAILABLE")
        assert sum("ax_login=" in header for response in responses
                   for header in response.headers.get_list("set-cookie")) == 1
        assert _auth_storage_counts(database) == (1024, 0)
        full = clients[0].get("/auth/login")
        _assert_fixed_error(full, status=503, code="DEPENDENCY_UNAVAILABLE")
        assert not any("ax_login=" in header for header in full.headers.get_list("set-cookie"))
        assert _auth_storage_counts(database) == (1024, 0)
    finally:
        for client in clients:
            client.close()


def test_full_login_capacity_rejection_commits_bounded_expiry_cleanup(
    oidc_provider, auth_database, frozen_clock
):
    database = auth_database
    now = frozen_clock()
    live_hashes = _seed_login_rows(
        database, count=1024, now=now, expires_at=now + timedelta(minutes=5),
        consumed_at=None, label="capacity-live",
    )
    _seed_login_rows(database, count=1001, now=now, expires_at=now - timedelta(seconds=1),
                     consumed_at=None, label="capacity-expired")
    _seed_session_rows(database, count=1001, now=now, expires_at=now - timedelta(seconds=1),
                       revoked_at=None, last_seen_at=now, label="capacity-expired-session")
    client = TestClient(create_app(_settings(oidc_provider, _runtime_dsn(database)), clock=frozen_clock),
                        base_url=API_ORIGIN, follow_redirects=False)
    try:
        first = client.get("/auth/login")
        _assert_fixed_error(first, status=503, code="DEPENDENCY_UNAVAILABLE")
        assert _auth_storage_counts(database) == (1025, 1)
        second = client.get("/auth/login")
        _assert_fixed_error(second, status=503, code="DEPENDENCY_UNAVAILABLE")
        assert _auth_storage_counts(database) == (1024, 0)
        assert not any("ax_login=" in header for response in (first, second)
                       for header in response.headers.get_list("set-cookie"))

        with psycopg.connect(_owner_dsn(database)) as connection:
            connection.execute("DELETE FROM ifpmic.oidc_login_transactions WHERE state_hash=%s",
                               (live_hashes[0],))
        admitted = client.get("/auth/login")
        assert admitted.status_code == 303
        assert _auth_storage_counts(database) == (1024, 0)
    finally:
        client.close()


def test_lifespan_gc_retries_database_failure_and_stops_cleanly(
    oidc_provider, auth_database, frozen_clock, caplog
):
    database = auth_database
    now = frozen_clock()
    _seed_login_rows(database, count=1, now=now, expires_at=now - timedelta(seconds=1),
                     consumed_at=None, label="scheduler-expired")
    settings = _settings(oidc_provider, _runtime_dsn(database), auth_gc_interval_seconds=1)
    app = create_app(settings, clock=frozen_clock)
    original_factory = app.state.auth.db_factory
    attempts = 0
    canary = "private-gc-database-canary"

    def fail_once_then_connect():
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError(canary)
        return original_factory()

    app.state.auth.db_factory = fail_once_then_connect
    with TestClient(app, base_url=API_ORIGIN, follow_redirects=False):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and _auth_storage_counts(database)[0] != 0:
            time.sleep(0.05)
        assert attempts >= 2
        assert _auth_storage_counts(database) == (0, 0)
    assert app.state.maintenance_task.done()
    assert canary not in caplog.text
