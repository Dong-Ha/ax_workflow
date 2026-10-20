"""Loopback-only demo identities. Never a company identity provider."""
from __future__ import annotations

import base64
import hashlib
import hmac
import html
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import secrets
import socket
import threading
import time
from urllib.parse import parse_qs, urlencode, urlsplit

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa


def b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


class LocalIssuer:
    """One-use code + PKCE + RS256 tokens for two explicitly synthetic users."""

    def __init__(self, port: int, api_origin: str, client_secret: str):
        self.origin = f"http://127.0.0.1:{port}"
        self.issuer = self.origin + "/issuer"
        self.redirect = api_origin + "/auth/callback"
        self.client_id = "ifpmic-local-demo"
        self.secret = client_secret
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.codes: dict[str, dict] = {}
        self.consents: dict[str, dict] = {}
        self.lock = threading.Lock()
        self.request_threads = []
        self.request_sockets = []
        self.closing = False
        self.retired_requests = 0
        provider = self

        class Server(ThreadingHTTPServer):
            daemon_threads = True

            def process_request(self, request, client_address):
                with provider.lock:
                    previous = len(provider.request_threads)
                    provider.request_threads = [thread for thread in provider.request_threads if thread.is_alive()]
                    provider.retired_requests += previous - len(provider.request_threads)
                    provider.request_sockets = [owned for owned in provider.request_sockets if owned.fileno() >= 0]
                    if provider.closing or len(provider.request_threads) >= 16:
                        request.close()
                        return
                    thread = threading.Thread(target=self.process_request_thread,
                        args=(request, client_address), name="ifpmic-demo-oidc-request", daemon=True)
                    provider.request_threads.append(thread)
                    provider.request_sockets.append(request)
                    thread.start()

            def get_request(self):
                sock, address = super().get_request()
                sock.settimeout(3)
                return sock, address

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass  # Codes, state, credentials and request targets stay unlogged.

            def respond(self, status, body=b"", content_type="application/json", **headers):
                self.send_response(status)
                for name, value in {"Content-Type": content_type, "Cache-Control": "no-store",
                                    "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
                                    "Content-Length": str(len(body)), **headers}.items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(body)

            def form(self):
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 8192:
                    raise ValueError("invalid demo form")
                return parse_qs(self.rfile.read(size).decode("ascii"), keep_blank_values=True,
                                strict_parsing=True, max_num_fields=16)

            def do_GET(self):
                try:
                    if self.headers.get("Host") != urlsplit(provider.origin).netloc:
                        raise ValueError()
                    path = urlsplit(self.path)
                    if path.path == "/keys" and not path.query:
                        numbers = provider.key.public_key().public_numbers()
                        uint = lambda n: b64(n.to_bytes((n.bit_length() + 7) // 8, "big"))
                        body = {"keys": [{"kty": "RSA", "kid": "local-demo-key", "use": "sig",
                                          "alg": "RS256", "n": uint(numbers.n), "e": uint(numbers.e)}]}
                        return self.respond(200, json.dumps(body).encode("ascii"))
                    if path.path != "/authorize" or len(path.query) > 8192:
                        raise ValueError()
                    query = parse_qs(path.query, keep_blank_values=True, strict_parsing=True,
                                     max_num_fields=16)
                    provider.validate_authorization(query)
                    ticket = secrets.token_urlsafe(32)
                    with provider.lock:
                        provider.prune()
                        if len(provider.consents) >= 128:
                            raise ValueError()
                        provider.consents[ticket] = {"query": query, "expires": time.time() + 120}
                    body = f'''<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>IFPMIC 데모 로그인</title>
<style>body{{font:18px/1.7 system-ui;background:#0b111b;color:#e7eef9;margin:8vh auto;padding:24px;max-width:600px}}button{{font:inherit;padding:16px;margin:8px;border:1px solid #63d4b4;border-radius:8px;background:#17372f;color:#e7eef9}}p{{color:#a2b3cb}}</style>
<h1>로컬 데모 계정 선택</h1><p>실제 API의 OIDC 로그인을 사용합니다. 두 계정은 합성이며 사내 SSO가 아닙니다.</p>
<form method="post" action="/consent"><input type="hidden" name="ticket" value="{html.escape(ticket, quote=True)}">
<button name="account" value="a" data-testid="login-a">데모 사용자 A</button>
<button name="account" value="b" data-testid="login-b">데모 사용자 B</button></form></html>'''
                    return self.respond(200, body.encode("utf-8"), "text/html; charset=utf-8",
                                        **{"Referrer-Policy": "same-origin", "Content-Security-Policy": f"default-src 'none'; style-src 'unsafe-inline'; form-action 'self' {api_origin}; frame-ancestors 'none'"})
                except Exception:
                    self.respond(400, b'{"error":"invalid_request"}')

            def do_POST(self):
                try:
                    if self.headers.get("Host") != urlsplit(provider.origin).netloc:
                        raise ValueError()
                    values = self.form()
                    if self.path == "/consent":
                        if self.headers.get("Origin") != provider.origin or set(values) != {"ticket", "account"}:
                            raise ValueError()
                        account = provider.one(values, "account")
                        if account not in ("a", "b"):
                            raise ValueError()
                        with provider.lock:
                            provider.prune()
                            consent = provider.consents.pop(provider.one(values, "ticket"), None)
                            if consent is None or len(provider.codes) >= 128:
                                raise ValueError()
                            code = secrets.token_urlsafe(32)
                            provider.codes[code] = {"query": consent["query"], "subject": "demo-" + account,
                                                    "expires": time.time() + 60}
                        location = provider.redirect + "?" + urlencode({
                            "code": code, "state": provider.one(consent["query"], "state")})
                        return self.respond(303, Location=location)
                    if self.path != "/token":
                        raise ValueError()
                    expected_auth = "Basic " + base64.b64encode(
                        (provider.client_id + ":" + provider.secret).encode()).decode("ascii")
                    if not hmac.compare_digest(self.headers.get("Authorization", ""), expected_auth):
                        raise ValueError()
                    if provider.one(values, "grant_type") != "authorization_code":
                        raise ValueError()
                    with provider.lock:
                        provider.prune()
                        grant = provider.codes.pop(provider.one(values, "code"), None)
                    if grant is None or provider.one(values, "redirect_uri") != provider.redirect:
                        raise ValueError()
                    challenge = b64(hashlib.sha256(provider.one(values, "code_verifier").encode("ascii")).digest())
                    if not hmac.compare_digest(challenge, provider.one(grant["query"], "code_challenge")):
                        raise ValueError()
                    now = int(time.time())
                    token = provider.sign({"iss": provider.issuer, "sub": grant["subject"],
                                           "aud": provider.client_id, "iat": now, "exp": now + 120,
                                           "nonce": provider.one(grant["query"], "nonce")})
                    return self.respond(200, json.dumps({"token_type": "Bearer", "expires_in": 120,
                        "access_token": secrets.token_urlsafe(32), "id_token": token}).encode("ascii"))
                except Exception:
                    self.respond(400, b'{"error":"invalid_grant"}')

        self.server = Server(("127.0.0.1", port), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, name="ifpmic-demo-issuer", daemon=True)

    @staticmethod
    def one(values, name):
        items = values.get(name)
        if not isinstance(items, list) or len(items) != 1 or not items[0]:
            raise ValueError("invalid demo parameter")
        return items[0]

    def validate_authorization(self, query):
        for field in ("state", "nonce", "code_challenge"):
            value = self.one(query, field)
            if len(value) > 256 or any(ord(c) < 32 for c in value):
                raise ValueError()
        for field, expected in {"client_id": self.client_id, "redirect_uri": self.redirect,
                                "response_type": "code", "code_challenge_method": "S256"}.items():
            if self.one(query, field) != expected:
                raise ValueError()

    def prune(self):
        now = time.time()
        for mapping in (self.codes, self.consents):
            for key in [key for key, value in mapping.items() if value["expires"] <= now]:
                del mapping[key]

    def sign(self, claims):
        encode = lambda value: b64(json.dumps(value, separators=(",", ":")).encode("ascii"))
        signed = encode({"alg": "RS256", "kid": "local-demo-key", "typ": "JWT"}) + "." + encode(claims)
        signature = self.key.sign(signed.encode("ascii"), padding.PKCS1v15(), hashes.SHA256())
        return signed + "." + b64(signature)

    def start(self):
        self.thread.start()

    def close(self):
        deadline = time.monotonic() + 5
        with self.lock:
            self.closing = True
            sockets, threads = tuple(self.request_sockets), tuple(self.request_threads)
        stopper = None
        try:
            if self.thread.ident is not None:
                stopper = threading.Thread(target=self.server.shutdown, name="ifpmic-demo-oidc-close", daemon=True)
                stopper.start()
            for owned in sockets:
                try:
                    owned.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                owned.close()
        finally:
            self.server.server_close()
        for thread in (*threads, self.thread, stopper):
            if thread is not None and thread.ident is not None:
                thread.join(timeout=max(0, deadline - time.monotonic()))
        if any(thread.is_alive() for thread in (*threads, self.thread, stopper) if thread is not None):
            raise RuntimeError("demo issuer shutdown unconfirmed")
        self.closed_observation = {
            "serving_thread_alive": self.thread.is_alive(),
            "request_threads_alive": [thread.is_alive() for thread in threads],
            "socket_fds": [owned.fileno() for owned in sockets],
            "retired_completed_requests": self.retired_requests,
            "shutdown_helper_alive": False if stopper is None else stopper.is_alive(),
        }
