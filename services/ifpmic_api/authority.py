"""Explicit operator-only mock eligibility grants and append-only revocation."""
from datetime import datetime, timezone
import json
import os
import re
import sys

import psycopg

from .request_contract import canonical_uuid, identifier, scalar, strict_json
from .settings import load_settings


class AuthorityError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def invalid():
    raise AuthorityError('AUTHORITY_INVALID_REQUEST')


def validate(operation, raw):
    try:
        value = strict_json(raw, limit=65536)
        keys = ({'project_id', 'snapshot_id', 'evidence_ref', 'evidence_sha256', 'expires_at'}
                if operation == 'grant-mock-profile' else {'project_id', 'eligibility_id'})
        if (type(value) is not dict or set(value) != keys or
                any(not isinstance(item, str) for item in value.values()) or
                not identifier(value['project_id']) or not scalar(value['project_id'])):
            invalid()
        if operation == 'grant-mock-profile':
            if (not re.fullmatch('[0-9a-f]{64}', value['snapshot_id']) or
                    not re.fullmatch('[0-9a-f]{64}', value['evidence_sha256']) or
                    not identifier(value['evidence_ref']) or not scalar(value['evidence_ref'])):
                invalid()
            expires = datetime.fromisoformat(value['expires_at'])
            if expires.tzinfo is None or expires.utcoffset() is None:
                invalid()
            value['expires_at'] = expires.astimezone(timezone.utc)
        elif not canonical_uuid(value['eligibility_id']):
            invalid()
        return value
    except Exception:
        invalid()


def apply(connection, operation, value, *, mode, clock=None):
    now = (clock or (lambda: datetime.now(timezone.utc)))()
    if not isinstance(now, datetime) or now.tzinfo is None or now.utcoffset() is None:
        raise AuthorityError('AUTHORITY_UNAVAILABLE')
    now = now.astimezone(timezone.utc)
    if operation == 'grant-mock-profile' and value['expires_at'] <= now:
        invalid()
    with connection.transaction():
        connection.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
        connection.execute("SET LOCAL lock_timeout = '5s'")
        connection.execute("SET LOCAL statement_timeout = '30s'")
        guard = connection.execute('''SELECT project_id FROM ifpmic.authorization_guards
            WHERE project_id=%s FOR UPDATE''', (value['project_id'],)).fetchone()
        if guard is None:
            raise AuthorityError('AUTHORITY_FORBIDDEN')
        # Authority time is sampled after any wait for the project guard.
        now = (clock or (lambda: datetime.now(timezone.utc)))()
        if not isinstance(now, datetime) or now.tzinfo is None or now.utcoffset() is None:
            raise AuthorityError('AUTHORITY_UNAVAILABLE')
        now = now.astimezone(timezone.utc)
        if operation == 'grant-mock-profile':
            if value['expires_at'] <= now:
                invalid()
            profile = connection.execute('''SELECT mode,enabled,configuration_complete FROM ifpmic.profile_catalog
                WHERE project_id=%s AND snapshot_id=%s''', (value['project_id'], value['snapshot_id'])).fetchone()
            if mode != 'mock' or profile != ('mock', True, True):
                raise AuthorityError('AUTHORITY_FORBIDDEN')
            result = connection.execute('''INSERT INTO ifpmic.profile_eligibility
                (project_id,snapshot_id,mode,evidence_ref,evidence_sha256,granted_at,expires_at)
                VALUES(%s,%s,'mock',%s,%s,%s,%s) RETURNING eligibility_id''',
                                        (value['project_id'], value['snapshot_id'], value['evidence_ref'],
                                         value['evidence_sha256'], now, value['expires_at'])).fetchone()
            return {'eligibility_id': str(result[0])}
        grant = connection.execute('''SELECT mode FROM ifpmic.profile_eligibility
            WHERE project_id=%s AND eligibility_id=%s''', (value['project_id'], value['eligibility_id'])).fetchone()
        if grant is None or grant[0] != mode:
            raise AuthorityError('AUTHORITY_FORBIDDEN')
        connection.execute('''INSERT INTO ifpmic.profile_revocations(project_id,eligibility_id,revoked_at)
            VALUES(%s,%s,%s) ON CONFLICT DO NOTHING''', (value['project_id'], value['eligibility_id'], now))
        return {'revoked': True}


def main():
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in {'grant-mock-profile', 'revoke-profile'}:
            invalid()
        operation = sys.argv[1]
        value = validate(operation, sys.stdin.buffer.read(65537))
        settings = load_settings(os.environ.get('IFPMIC_API_CONFIG'))
        dsn = os.environ.get('IFPMIC_OPERATOR_DSN')
        if not dsn:
            raise AuthorityError('AUTHORITY_UNAVAILABLE')
        with psycopg.connect(dsn, autocommit=True, connect_timeout=10) as connection:
            result = apply(connection, operation, value, mode=settings.mode)
        print(json.dumps(result, ensure_ascii=True, separators=(',', ':')))
        return 0
    except Exception as error:
        code = error.code if isinstance(error, AuthorityError) else 'AUTHORITY_UNAVAILABLE'
        print(json.dumps({'error': {'code': code}}, separators=(',', ':')))
        return 3 if code == 'AUTHORITY_UNAVAILABLE' else 2


if __name__ == '__main__':
    sys.exit(main())
