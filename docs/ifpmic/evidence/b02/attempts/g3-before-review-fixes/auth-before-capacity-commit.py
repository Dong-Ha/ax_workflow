"""Opaque database sessions and one-use browser-bound OIDC transactions."""
import base64
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import re
import secrets

from .errors import ApiError
from . import oidc


def random_token():
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b'=').decode('ascii')


def canonical_token(value):
    if not isinstance(value, str) or re.fullmatch(r'[A-Za-z0-9_-]{43}', value) is None:
        return False
    raw = base64.urlsafe_b64decode(value + '=')
    return len(raw) == 32 and base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii') == value


def token_hash(value):
    return hashlib.sha256(value.encode('ascii')).hexdigest()


def csrf_token(key, session):
    digest = hmac.digest(key, b'ifpmic.csrf.v1\x00' + session.encode('ascii'), 'sha256')
    return base64.urlsafe_b64encode(digest).rstrip(b'=').decode('ascii')


@dataclass(frozen=True, repr=False)
class Session:
    user_id: str
    token_hash: str
    token: str


class AuthService:
    def __init__(self, settings, *, db_factory, transport_factory=None, clock=None, fault_hook=None):
        self.settings = settings
        self.db_factory = db_factory
        self.transport_factory = transport_factory
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.fault_hook = fault_hook

    def now(self):
        value = self.clock()
        if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
            raise ApiError('DEPENDENCY_UNAVAILABLE')
        return value.astimezone(timezone.utc)

    def _cleanup(self, db, now):
        db.execute("SET LOCAL lock_timeout = '5s'")
        db.execute("SET LOCAL statement_timeout = '5s'")
        db.execute('SELECT pg_advisory_xact_lock(7300245100000003)')
        login = db.execute('''DELETE FROM ifpmic.oidc_login_transactions WHERE state_hash IN (
            SELECT state_hash FROM ifpmic.oidc_login_transactions WHERE expires_at<=%s
            ORDER BY expires_at,state_hash LIMIT 1000 FOR UPDATE SKIP LOCKED)''', (now,)).rowcount
        sessions = db.execute('''DELETE FROM ifpmic.user_sessions WHERE token_hash IN (
            SELECT token_hash FROM ifpmic.user_sessions WHERE expires_at<=%s
            ORDER BY expires_at,token_hash LIMIT 1000 FOR UPDATE SKIP LOCKED)''', (now,)).rowcount
        return {'login_transactions': login, 'sessions': sessions}

    def maintenance(self):
        """Trusted clock only; no request-selected cutoff, table or delete cap."""
        with self.db_factory() as db:
            with db.transaction():
                return self._cleanup(db, self.now())

    async def begin(self):
        state, browser, nonce, verifier = (random_token() for _ in range(4))
        with self.db_factory() as db:
            with db.transaction():
                now = self.now()
                self._cleanup(db, now)
                count = db.execute('SELECT count(*) FROM (SELECT 1 FROM ifpmic.oidc_login_transactions LIMIT 1024) AS pending').fetchone()[0]
                if count >= 1024:
                    raise ApiError('DEPENDENCY_UNAVAILABLE')
                db.execute('''INSERT INTO ifpmic.oidc_login_transactions
                    (state_hash,browser_hash,nonce,pkce_verifier,expires_at) VALUES(%s,%s,%s,%s,%s)''',
                           (token_hash(state), token_hash(browser), nonce, verifier, now + timedelta(seconds=300)))
        url = await oidc.authorization_url(self.settings, state=state, nonce=nonce, verifier=verifier,
                                           transport_factory=self.transport_factory)
        return url, browser

    def consume(self, state, browser):
        if not canonical_token(state) or not canonical_token(browser):
            raise ApiError('AUTH_REQUIRED')
        now = self.now()
        with self.db_factory() as db:
            with db.transaction():
                row = db.execute('''UPDATE ifpmic.oidc_login_transactions SET consumed_at=%s
                    WHERE state_hash=%s AND browser_hash=%s AND consumed_at IS NULL AND expires_at>%s
                    RETURNING nonce,pkce_verifier''', (now, token_hash(state), token_hash(browser), now)).fetchone()
                if row is None:
                    raise ApiError('AUTH_REQUIRED')
        return row

    async def finish(self, *, state, browser, code, previous_session=None, provider_error=False, response_issuer=None):
        nonce, verifier = self.consume(state, browser)
        if provider_error or (response_issuer is not None and response_issuer != self.settings.issuer):
            raise ApiError('AUTH_REQUIRED')
        subject = await oidc.exchange(self.settings, code=code, verifier=verifier, nonce=nonce,
                                      now=lambda: self.now().timestamp(), transport_factory=self.transport_factory)
        session = random_token()
        now = self.now()
        identity = json.dumps([self.settings.issuer, subject], ensure_ascii=True, separators=(',', ':'))
        ready_to_commit = False
        try:
            with self.db_factory() as db:
                with db.transaction():
                    user_id = db.execute('''INSERT INTO ifpmic.users(identity_subject,display_name) VALUES(%s,%s)
                        ON CONFLICT(identity_subject) DO UPDATE SET display_name=EXCLUDED.display_name
                        RETURNING user_id''', (identity, 'IFPMIC user')).fetchone()[0]
                    if canonical_token(previous_session):
                        db.execute('UPDATE ifpmic.user_sessions SET revoked_at=%s WHERE token_hash=%s AND revoked_at IS NULL',
                                   (now, token_hash(previous_session)))
                    db.execute('''INSERT INTO ifpmic.user_sessions(token_hash,user_id,created_at,expires_at,last_seen_at)
                        VALUES(%s,%s,%s,%s,%s)''', (token_hash(session), user_id, now, now + timedelta(hours=8), now))
                    if self.fault_hook:
                        self.fault_hook('session_before_commit')
                    ready_to_commit = True
            if self.fault_hook:
                self.fault_hook('session_after_commit')
        except Exception:
            raise ApiError('COMMIT_UNCERTAIN' if ready_to_commit else 'DEPENDENCY_UNAVAILABLE') from None
        return session

    def authenticate(self, connection, request, *, write=False):
        """Use inside the caller's transaction, including later G4 acceptance."""
        token = request.scope.get('ifpmic.cookies', {}).get('ax_session')
        if not canonical_token(token):
            raise ApiError('AUTH_REQUIRED')
        now = self.now()
        row = connection.execute('''SELECT user_id FROM ifpmic.user_sessions WHERE token_hash=%s
            AND revoked_at IS NULL AND created_at<=%s AND expires_at>%s AND last_seen_at>%s
            FOR UPDATE''', (token_hash(token), now, now, now - timedelta(minutes=30))).fetchone()
        if row is None:
            raise ApiError('AUTH_REQUIRED')
        if write:
            if request.headers.get('origin') not in self.settings.allowed_ui_origins:
                raise ApiError('ORIGIN_FORBIDDEN')
            supplied = request.headers.get('x-csrf-token', '')
            if not canonical_token(supplied) or not hmac.compare_digest(supplied, csrf_token(self.settings.csrf_key, token)):
                raise ApiError('CSRF_INVALID')
        connection.execute('UPDATE ifpmic.user_sessions SET last_seen_at=%s WHERE token_hash=%s', (now, token_hash(token)))
        return Session(str(row[0]), token_hash(token), token)
