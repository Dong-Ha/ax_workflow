"""Strict original job request DTO and authenticated pagination contract."""
import base64
from datetime import datetime, timezone
import hashlib
import hmac
import json
import re
from urllib.parse import parse_qsl
from uuid import UUID

from .errors import ApiError

BODY_LIMIT = 8 * 1024 * 1024
CREATE_FIELDS = {'project_id', 'title', 'request_text', 'change_type', 'base_ref',
                 'input_artifact_ids', 'profile_version', 'release_mode'}


def ascii_json(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(',', ':'), allow_nan=False)


def scalar(value):
    try:
        value.encode('utf-8')
        return True
    except (AttributeError, UnicodeError):
        return False


def identifier(value):
    return isinstance(value, str) and bool(value) and not any(ord(c) < 32 or ord(c) == 127 for c in value)


def canonical_uuid(value):
    try:
        return isinstance(value, str) and str(UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def strict_json(raw, *, limit=BODY_LIMIT):
    if len(raw) > limit:
        raise ApiError('REQUEST_TOO_LARGE')
    depth, quoted, escaped = 0, False, False
    for byte in raw:
        if quoted:
            if escaped:
                escaped = False
            elif byte == 92:
                escaped = True
            elif byte == 34:
                quoted = False
        elif byte == 34:
            quoted = True
        elif byte in (91, 123):
            depth += 1
            if depth > 64:
                raise ApiError('REQUEST_TOO_LARGE')
        elif byte in (93, 125):
            depth -= 1

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError()
            result[key] = value
        return result

    def invalid_constant(value):
        raise ValueError()

    try:
        return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=invalid_constant)
    except Exception:
        raise ApiError('INVALID_REQUEST') from None


def create_payload(raw):
    value = strict_json(raw)
    if not isinstance(value, dict) or set(value) != CREATE_FIELDS:
        raise ApiError('INVALID_REQUEST')
    for key in CREATE_FIELDS - {'input_artifact_ids'}:
        item = value[key]
        if (not isinstance(item, str) or not item or '\x00' in item or
                (key != 'request_text' and not identifier(item))):
            raise ApiError('INVALID_REQUEST')
    if (not scalar(value['project_id']) or value['change_type'] not in {'NEW_HW', 'FEATURE', 'BUGFIX'} or
            value['release_mode'] not in {'team_github_tag', 'shared_gerrit_change', 'shared_github_pr', 'shared_github_commit'} or
            type(value['input_artifact_ids']) is not list or
            any(not canonical_uuid(item) for item in value['input_artifact_ids'])):
        raise ApiError('INVALID_REQUEST')
    return value


def payload_identity(payload):
    stored = ascii_json(payload)
    digest = hashlib.sha256(ascii_json({'format': 'ifpmic.create-job.v1', 'payload': payload}).encode('utf-8')).hexdigest()
    return stored, digest


def one_header(request, name):
    values = request.headers.getlist(name)
    if len(values) != 1:
        raise ApiError('INVALID_REQUEST')
    return values[0]


def idempotency_key(request):
    value = one_header(request, 'idempotency-key')
    if not 1 <= len(value) <= 128 or any(not 32 <= ord(c) <= 126 for c in value):
        raise ApiError('INVALID_REQUEST')
    return value


async def read_create(request):
    if request.scope.get('query_string'):
        raise ApiError('INVALID_REQUEST')
    content_type = one_header(request, 'content-type')
    if not re.fullmatch(r'application/json(?:\s*;\s*charset\s*=\s*utf-8)?', content_type, re.I):
        raise ApiError('INVALID_REQUEST')
    encodings = request.headers.getlist('content-encoding')
    if len(encodings) > 1 or (encodings and encodings[0].lower() != 'identity'):
        raise ApiError('INVALID_REQUEST')
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > BODY_LIMIT:
            raise ApiError('REQUEST_TOO_LARGE')
        raw.extend(chunk)
    return create_payload(bytes(raw))


def list_query(request):
    try:
        raw = request.scope.get('query_string', b'')
        if len(raw) > 16384 or re.search(rb'%(?![0-9a-fA-F]{2})', raw):
            raise ValueError()
        pairs = parse_qsl(raw.decode('ascii'), keep_blank_values=True, encoding='utf-8', errors='strict', max_num_fields=3)
        values = dict(pairs)
        if len(values) != len(pairs) or not set(values) <= {'limit', 'cursor'}:
            raise ValueError()
        size = values.get('limit', '25')
        if not re.fullmatch('[1-9][0-9]{0,2}', size) or not 1 <= int(size) <= 100:
            raise ValueError()
        return int(size), values.get('cursor')
    except Exception:
        raise ApiError('INVALID_REQUEST') from None


def _b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def _unb64(value):
    if not isinstance(value, str) or not re.fullmatch('[A-Za-z0-9_-]+', value):
        raise ValueError()
    raw = base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True)
    if _b64(raw) != value:
        raise ValueError()
    return raw


def timestamp(value):
    return value.astimezone(timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')


def make_cursor(key, actor, created_at, job_id):
    payload = {'v': 1, 'actor_id': str(actor), 'route': 'GET /api/v1/jobs', 'scope': 'accessible-jobs-v1',
               'created_at': timestamp(created_at), 'job_id': str(job_id)}
    body = _b64(ascii_json(payload).encode('ascii'))
    signature = hmac.digest(key, b'ifpmic.cursor.v1\x00' + body.encode('ascii'), 'sha256')
    return body + '.' + _b64(signature)


def read_cursor(key, actor, token):
    if token is None:
        return None
    try:
        if not isinstance(token, str) or len(token) > 8192:
            raise ValueError()
        body, encoded_signature = token.split('.')
        signature = _unb64(encoded_signature)
        expected = hmac.digest(key, b'ifpmic.cursor.v1\x00' + body.encode('ascii'), 'sha256')
        if not hmac.compare_digest(signature, expected):
            raise ValueError()
        raw = _unb64(body)
        value = strict_json(raw, limit=8192)
        if (type(value) is not dict or set(value) != {'v', 'actor_id', 'route', 'scope', 'created_at', 'job_id'} or
                ascii_json(value).encode('ascii') != raw or type(value['v']) is not int or value['v'] != 1 or
                value['actor_id'] != str(actor) or value['route'] != 'GET /api/v1/jobs' or
                value['scope'] != 'accessible-jobs-v1' or not canonical_uuid(value['job_id']) or
                not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z', value['created_at'])):
            raise ValueError()
        time = datetime.strptime(value['created_at'], '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc)
        return time, UUID(value['job_id'])
    except Exception:
        raise ApiError('INVALID_REQUEST') from None
