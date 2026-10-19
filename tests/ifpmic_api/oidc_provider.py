"""Synthetic loopback OIDC provider used by B02 G3 integration tests.

The provider intentionally uses ordinary HTTP only on literal loopback because
the approved tests run with mode=mock. It never logs request paths, headers,
codes, state, verifier, cookies, or token bodies.
"""

from __future__ import annotations

import base64
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
import socket
import threading
import time
from typing import Any
from urllib.parse import parse_qs

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa


CLIENT_ID = "ifpmic-g3-client"
CLIENT_SECRET = "synthetic-g3-client-secret"
KEY_ID = "ifpmic-g3-rsa-1"
ACCESS_TOKEN = "synthetic-access-token-never-persist"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode("ascii")


def _jwk_uint(value: int) -> str:
    size = max(1, (value.bit_length() + 7) // 8)
    return _b64url(value.to_bytes(size, "big"))


class SyntheticOIDCProvider:
    """Three isolated loopback origins: authorization, token, and JWKS."""

    def __init__(self) -> None:
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.issuer = ""
        self.nonce = ""
        self.expected_challenge = ""
        self.expected_redirect_uri = ""
        self.expected_code = "g3-local-code"
        self.token_status = 200
        self.token_error: str | None = None
        self.access_token = ACCESS_TOKEN
        self.claim_overrides: dict[str, Any] = {}
        self.claim_removals: set[str] = set()
        self.claim_time: int | float | None = None
        self.signing_key_override = None
        self.jwks_document: Any | None = None
        self.token_response_headers: dict[str, str] = {}
        self.jwks_response_headers: dict[str, str] = {}
        self.jwks_status = 200
        self.token_extra_padding = 0
        self.jwks_extra_padding = 0
        self.token_target_size: int | None = None
        self.jwks_target_size: int | None = None
        self.extra_token_headers: dict[str, str] = {}
        self.token_body: dict[str, list[str]] | None = None
        self.token_authorization: str | None = None
        self.token_accept_encoding: str | None = None
        self.token_alg = "RS256"
        self.token_kid: str | None = KEY_ID
        self.id_token_override: str | None = None
        self.browser_cookie: str | None = None
        self.token_request_count = 0
        self.jwks_request_count = 0
        self.last_authorization: dict[str, list[str]] | None = None
        self._lock = threading.RLock()
        self._servers: list[ThreadingHTTPServer] = []
        self._threads: list[threading.Thread] = []
        self._request_threads: list[threading.Thread] = []
        self._request_sockets: list[socket.socket] = []
        self._origins: dict[str, str] = {}

    @property
    def authorization_endpoint(self) -> str:
        return f"{self._origins['authorization']}/authorize"

    @property
    def token_endpoint(self) -> str:
        return f"{self._origins['token']}/token"

    @property
    def jwks_uri(self) -> str:
        return f"{self._origins['jwks']}/keys"

    def start(self) -> "SyntheticOIDCProvider":
        provider = self

        class OwnedHTTPServer(ThreadingHTTPServer):
            def process_request(self, request, client_address):
                thread = threading.Thread(target=self.process_request_thread,
                                          args=(request, client_address), daemon=self.daemon_threads)
                with provider._lock:
                    provider._request_threads.append(thread)
                    provider._request_sockets.append(request)
                thread.start()

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, fmt: str, *args: object) -> None:
                # BaseHTTPRequestHandler's default includes request targets.
                return

            def _send(self, status: int, body: bytes, headers: dict[str, str] | None = None) -> None:
                self.send_response(status)
                outgoing = {"Content-Type": "application/json", **(headers or {})}
                chunked = any(name.lower() == "transfer-encoding" and value.lower() == "chunked"
                              for name, value in outgoing.items())
                if not chunked and not any(name.lower() == "content-length" for name in outgoing):
                    outgoing["Content-Length"] = str(len(body))
                for name, value in outgoing.items():
                    self.send_header(name, value)
                self.end_headers()
                if chunked:
                    for offset in range(0, len(body), 8192):
                        chunk = body[offset:offset + 8192]
                        self.wfile.write(f"{len(chunk):X}\r\n".encode("ascii") + chunk + b"\r\n")
                    self.wfile.write(b"0\r\n\r\n")
                else:
                    self.wfile.write(body)

            def do_GET(self) -> None:  # noqa: N802 - stdlib callback name
                if self.path != "/keys":
                    self._send(404, b"{}")
                    return
                with provider._lock:
                    provider.jwks_request_count += 1
                    document = provider.jwks_document or provider.jwks()
                    headers = dict(provider.jwks_response_headers)
                    padding_length = provider.jwks_extra_padding
                    target_size = provider.jwks_target_size
                    status = provider.jwks_status
                body = _json_bytes(document) + (b" " * max(0, padding_length))
                if target_size is not None:
                    body += b" " * max(0, target_size - len(body))
                self._send(status, body, headers)

            def do_POST(self) -> None:  # noqa: N802 - stdlib callback name
                if self.path != "/token":
                    self._send(404, b"{}")
                    return
                length = self.headers.get("Content-Length", "0")
                try:
                    count = int(length)
                except ValueError:
                    self._send(400, b"{}")
                    return
                body = self.rfile.read(max(0, min(count, 32768)))
                parsed = parse_qs(body.decode("ascii", errors="replace"), keep_blank_values=True)
                with provider._lock:
                    provider.token_request_count += 1
                    provider.token_body = parsed
                    provider.token_authorization = self.headers.get("Authorization")
                    provider.token_accept_encoding = self.headers.get("Accept-Encoding")
                    status = provider.token_status
                    error = provider.token_error
                    headers = dict(provider.token_response_headers)
                    token = provider.access_token
                    challenge = provider.expected_challenge
                    redirect_uri = provider.expected_redirect_uri
                    expected_code = provider.expected_code
                    nonce = provider.nonce
                    overrides = dict(provider.claim_overrides)
                    removals = set(provider.claim_removals)
                    claim_time = provider.claim_time
                    signing_key_override = provider.signing_key_override
                    token_alg = provider.token_alg
                    token_kid = provider.token_kid
                    id_token_override = provider.id_token_override
                    extra_token_headers = dict(provider.extra_token_headers)
                    extra_padding = provider.token_extra_padding
                    target_size = provider.token_target_size
                verifier = parsed.get("code_verifier", [""])[0]
                actual_challenge = _b64url(hashlib.sha256(verifier.encode("ascii", errors="ignore")).digest())
                if (
                    parsed.get("grant_type") != ["authorization_code"]
                    or parsed.get("code") != [expected_code]
                    or parsed.get("redirect_uri") != [redirect_uri]
                    or not verifier
                    or actual_challenge != challenge
                ):
                    self._send(400, _json_bytes({"error": "invalid_grant"}))
                    return
                if error is not None:
                    self._send(status, _json_bytes({"error": error}), headers)
                    return
                claims = provider.default_claims(nonce, now=claim_time)
                claims.update(overrides)
                for claim_name in removals:
                    claims.pop(claim_name, None)
                id_token = id_token_override or provider.sign(
                    claims, alg=token_alg, kid=token_kid, signing_key=signing_key_override,
                    extra_headers=extra_token_headers,
                )
                response = {
                    "access_token": token,
                    "token_type": "Bearer",
                    "expires_in": 300,
                    "id_token": id_token,
                }
                body = _json_bytes(response) + (b" " * max(0, extra_padding))
                if target_size is not None:
                    body += b" " * max(0, target_size - len(body))
                self._send(status, body, headers)

        for name in ("authorization", "token", "jwks"):
            server = OwnedHTTPServer(("127.0.0.1", 0), Handler)
            server.daemon_threads = True
            server.timeout = 1
            host, port = server.server_address
            self._servers.append(server)
            self._origins[name] = f"http://{host}:{port}"
            thread = threading.Thread(target=server.serve_forever, name=f"ifpmic-g3-{name}", daemon=True)
            self._threads.append(thread)
            thread.start()
        self.issuer = f"{self._origins['authorization']}/issuer"
        return self

    def close(self, *, remaining_time=None) -> None:
        if remaining_time is not None:
            remaining_time(3)
            errors = []

            def stop(server, serving_thread):
                try:
                    # shutdown waits for serve_forever's completion event. A
                    # partially started fixture may never have entered that loop.
                    if serving_thread is None or serving_thread.ident is None:
                        errors.append("SERVING_THREAD_START_UNCONFIRMED")
                    else:
                        server.shutdown()
                except BaseException as error:
                    errors.append(type(error).__name__)
                finally:
                    try:
                        server.server_close()
                    except BaseException as error:
                        errors.append(type(error).__name__)

            # All servers share the caller's one cleanup epoch. Retain both
            # helper and serving thread handles if shutdown is unconfirmed.
            self._shutdown_threads = [
                threading.Thread(target=stop,
                                 args=(server, self._threads[index] if index < len(self._threads) else None),
                                 daemon=True, name="ifpmic-h2-oidc-close")
                for index, server in enumerate(self._servers)
            ]
            with self._lock:
                self._last_h2_threads = (*self._shutdown_threads, *self._threads, *self._request_threads)
            for thread in self._shutdown_threads:
                thread.start()
            for thread in self._shutdown_threads:
                thread.join(timeout=remaining_time(3))
            if any(thread.is_alive() for thread in self._shutdown_threads):
                raise RuntimeError("H2 OIDC shutdown unconfirmed")
            # Shutdown completed accepting requests. Close only this provider's
            # saved sockets so keep-alive handlers can also finish and be joined.
            with self._lock:
                connections = list(self._request_sockets)
                request_threads = list(self._request_threads)
            self._last_h2_threads = (*self._shutdown_threads, *self._threads, *request_threads)
            for connection in connections:
                try:
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass  # The peer/handler may already have closed it.
                connection.close()
            for thread in (*self._threads, *request_threads):
                if thread.ident is None:
                    errors.append("THREAD_START_UNCONFIRMED")
                    continue
                thread.join(timeout=remaining_time(3))
            if errors or any(thread.is_alive() for thread in
                             (*self._shutdown_threads, *self._threads, *request_threads)):
                raise RuntimeError("H2 OIDC shutdown unconfirmed")
            self._servers.clear()
            self._threads.clear()
            self._request_threads.clear()
            self._request_sockets.clear()
            self._shutdown_threads.clear()
            return
        for server in self._servers:
            server.shutdown()
            server.server_close()
        for thread in self._threads:
            thread.join(timeout=3)
        self._servers.clear()
        self._threads.clear()
        self._request_threads.clear()
        self._request_sockets.clear()

    def register_authorization(self, query: dict[str, list[str]]) -> None:
        with self._lock:
            self.last_authorization = {key: list(values) for key, values in query.items()}
            self.nonce = query.get("nonce", [""])[0]
            self.expected_challenge = query.get("code_challenge", [""])[0]
            self.expected_redirect_uri = query.get("redirect_uri", [""])[0]
            self.claim_overrides = {}
            self.claim_removals = set()
            self.claim_time = None
            self.signing_key_override = None
            self.token_alg = "RS256"
            self.token_kid = KEY_ID
            self.id_token_override = None
            self.token_error = None
            self.token_status = 200
            self.token_response_headers = {}
            self.jwks_document = None
            self.jwks_response_headers = {}
            self.jwks_status = 200
            self.token_extra_padding = 0
            self.jwks_extra_padding = 0
            self.token_target_size = None
            self.jwks_target_size = None
            self.extra_token_headers = {}
            self.access_token = ACCESS_TOKEN
            self.expected_code = "g3-local-code"
            self.token_authorization = None
            self.token_accept_encoding = None

    def default_claims(self, nonce: str | None = None, *, now: int | float | None = None) -> dict[str, Any]:
        now = int(time.time() if now is None else now)
        return {
            "iss": self.issuer,
            "sub": "synthetic-subject-01",
            "aud": CLIENT_ID,
            "exp": now + 300,
            "iat": now,
            "nonce": self.nonce if nonce is None else nonce,
        }

    def public_jwk(self) -> dict[str, str]:
        numbers = self.key.public_key().public_numbers()
        return {
            "kty": "RSA",
            "use": "sig",
            "alg": "RS256",
            "kid": KEY_ID,
            "n": _jwk_uint(numbers.n),
            "e": _jwk_uint(numbers.e),
        }

    def jwks(self) -> dict[str, list[dict[str, str]]]:
        return {"keys": [self.public_jwk()]}

    def sign(self, claims: dict[str, Any], *, alg: str = "RS256", kid: str | None = KEY_ID,
             signing_key=None, extra_headers: dict[str, str] | None = None) -> str:
        header: dict[str, str] = {"alg": alg, "typ": "JWT"}
        if kid is not None:
            header["kid"] = kid
        header.update(extra_headers or {})
        signing_input = f"{_b64url(_json_bytes(header))}.{_b64url(_json_bytes(claims))}".encode("ascii")
        key = signing_key or self.key
        # Negative algorithm tests retain RSA bytes while changing only the
        # protected header, yielding a deterministic verification rejection.
        signature = key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
        return signing_input.decode("ascii") + "." + _b64url(signature)
