"""Independent IFPMIC API, leaving the existing AX GET-only server intact."""
import json
import logging
import re
import asyncio
from contextlib import asynccontextmanager
from urllib.parse import parse_qsl, urlsplit
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException
from starlette.responses import Response, RedirectResponse

from .auth import AuthService, canonical_token, csrf_token
from .errors import ApiError
from .settings import Settings, SettingsError
from .jobs import JobService
from .request_contract import idempotency_key, list_query, read_create
from .workspace import WorkspaceService


def json_response(value, status=200):
    return Response(json.dumps(value, ensure_ascii=True, separators=(',', ':')), status_code=status, media_type='application/json')


def error_response(error, trace_id):
    return json_response({'code': error.code, 'message': error.code, 'trace_id': trace_id}, error.status)


class Boundary:
    def __init__(self, app, *, settings):
        self.app = app
        self.settings = settings

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            await self.app(scope, receive, send)
            return
        scope['ifpmic.trace_id'] = str(uuid4())
        headers = {}
        started = False

        async def safe_send(message):
            nonlocal started
            if message['type'] == 'http.response.start':
                started = True
                outgoing = list(message.get('headers', []))
                outgoing += [(b'cache-control', b'no-store'), (b'referrer-policy', b'no-referrer')]
                origin = headers.get('origin', [None])[0]
                if origin in self.settings.allowed_ui_origins:
                    outgoing += [(b'access-control-allow-origin', origin.encode('ascii')),
                                 (b'access-control-allow-credentials', b'true'), (b'vary', b'Origin')]
                message = {**message, 'headers': outgoing}
            await send(message)

        try:
            for raw_name, raw_value in scope.get('headers', []):
                name = raw_name.decode('ascii').lower()
                headers.setdefault(name, []).append(raw_value.decode('latin-1'))
            for name, code in (('origin', 'ORIGIN_FORBIDDEN'), ('x-csrf-token', 'CSRF_INVALID'),
                               ('authorization', 'AUTH_REQUIRED'), ('cookie', 'AUTH_REQUIRED')):
                if len(headers.get(name, [])) > 1:
                    raise ApiError(code)
            expected_host = urlsplit(self.settings.api_origin).netloc
            if headers.get('host') != [expected_host]:
                raise ApiError('INVALID_REQUEST')
            origin = headers.get('origin', [None])[0]
            if origin is not None and origin not in self.settings.allowed_ui_origins:
                raise ApiError('ORIGIN_FORBIDDEN')
            cookies = {}
            for part in headers.get('cookie', [''])[0].split(';'):
                if not part.strip():
                    continue
                name, separator, value = part.strip().partition('=')
                if name in ('ax_session', 'ax_login'):
                    if not separator or name in cookies or not canonical_token(value):
                        raise ApiError('AUTH_REQUIRED')
                    cookies[name] = value
            scope['ifpmic.cookies'] = cookies
            if scope['method'] == 'OPTIONS' and 'access-control-request-method' in headers:
                requested = headers['access-control-request-method']
                requested_headers = headers.get('access-control-request-headers', [''])
                if (origin is None or len(requested) != 1 or requested[0] not in ('GET', 'POST') or
                        len(requested_headers) != 1 or any(h.strip().lower() not in {
                            'content-type', 'x-csrf-token', 'idempotency-key'} for h in requested_headers[0].split(',') if h.strip())):
                    raise ApiError('FORBIDDEN')
                response = Response(status_code=204, headers={'Access-Control-Allow-Methods': 'GET, POST',
                    'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token, Idempotency-Key', 'Access-Control-Max-Age': '600'})
                await response(scope, receive, safe_send)
                return
            await self.app(scope, receive, safe_send)
        except Exception as error:
            if not started:
                public = error if isinstance(error, ApiError) else ApiError('DEPENDENCY_UNAVAILABLE')
                await error_response(public, scope['ifpmic.trace_id'])(scope, receive, safe_send)
            # Never rethrow a private request/SQL/OIDC exception into Uvicorn's
            # request-line exception logging, including after headers were sent.


def callback_values(request):
    try:
        raw = request.scope.get('query_string', b'')
        if len(raw) > 8192 or re.search(rb'%(?![0-9a-fA-F]{2})', raw):
            raise ValueError()
        pairs = parse_qsl(raw.decode('ascii'), keep_blank_values=True, encoding='utf-8', errors='strict', max_num_fields=16)
        values = {}
        for name, value in pairs:
            if name in values or name not in {'code', 'state', 'error', 'error_description', 'iss', 'session_state'}:
                raise ValueError()
            if any(ord(c) < 32 or ord(c) == 127 for c in value):
                raise ValueError()
            values[name] = value
        if not canonical_token(values.get('state')) or bool(values.get('code')) == bool(values.get('error')):
            raise ValueError()
        if len(values.get('code', '')) > 4096:
            raise ValueError()
        return values
    except Exception:
        raise ApiError('AUTH_REQUIRED') from None


def create_app(settings, *, db_factory=None, oidc_transport=None, bridge_runner=None, filesystem=None, clock=None, fault_hook=None):
    if not isinstance(settings, Settings):
        raise SettingsError()
    if db_factory is None:
        if not settings.database_dsn:
            raise SettingsError()
        import psycopg
        db_factory = lambda: psycopg.connect(settings.database_dsn, autocommit=True, connect_timeout=10)
    for name in ('authlib', 'httpx2', 'httpcore2'):
        logging.getLogger(name).setLevel(logging.WARNING)
    auth = AuthService(settings, db_factory=db_factory, transport_factory=oidc_transport, clock=clock, fault_hook=fault_hook)

    @asynccontextmanager
    async def lifespan(app):
        async def maintain():
            while True:
                await asyncio.sleep(settings.auth_gc_interval_seconds)
                try:
                    auth.maintenance()
                except Exception:
                    # Retry at the next bounded tick; never format a DSN,
                    # stored nonce/verifier or database exception into logs.
                    pass
        task = asyncio.create_task(maintain())
        app.state.maintenance_task = task
        try:
            yield
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.auth = auth
    app.state.bridge_runner = bridge_runner
    app.state.filesystem = filesystem
    app.state.workspaces = WorkspaceService(settings, db_factory=db_factory,
                                           filesystem=filesystem, fault_hook=fault_hook)
    jobs = JobService(settings, auth, db_factory=db_factory, bridge_runner=bridge_runner, fault_hook=fault_hook)
    app.state.jobs = jobs

    @app.exception_handler(ApiError)
    async def api_error(request, error):
        return error_response(error, request.scope['ifpmic.trace_id'])

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, error):
        return error_response(ApiError('INVALID_REQUEST'), request.scope['ifpmic.trace_id'])

    @app.exception_handler(HTTPException)
    async def missing_route(request, error):
        return error_response(ApiError('FORBIDDEN'), request.scope['ifpmic.trace_id'])

    @app.get('/auth/login')
    async def login(request: Request):
        if request.scope.get('query_string'):
            raise ApiError('INVALID_REQUEST')
        url, browser = await auth.begin()
        response = RedirectResponse(url, status_code=303)
        response.set_cookie('ax_login', browser, max_age=300, path='/auth', secure=settings.mode == 'real', httponly=True, samesite='lax')
        return response

    @app.get('/auth/callback')
    async def callback(request: Request):
        values = callback_values(request)
        cookies = request.scope['ifpmic.cookies']
        session = await auth.finish(state=values['state'], browser=cookies.get('ax_login'), code=values.get('code'),
                                    previous_session=cookies.get('ax_session'), provider_error='error' in values,
                                    response_issuer=values.get('iss'))
        response = RedirectResponse(settings.post_login_url, status_code=303)
        response.set_cookie('ax_session', session, max_age=28800, path='/', secure=settings.mode == 'real', httponly=True, samesite='lax')
        response.delete_cookie('ax_login', path='/auth', secure=settings.mode == 'real', httponly=True, samesite='lax')
        return response

    @app.get('/api/v1/session')
    async def session(request: Request):
        with db_factory() as db:
            with db.transaction():
                current = auth.authenticate(db, request)
        return json_response({'user_id': current.user_id, 'csrf_token': csrf_token(settings.csrf_key, current.token), 'mode': settings.mode})

    @app.post('/auth/logout')
    async def logout(request: Request):
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if body:
                raise ApiError('INVALID_REQUEST')
        with db_factory() as db:
            with db.transaction():
                current = auth.authenticate(db, request, write=True)
                db.execute('UPDATE ifpmic.user_sessions SET revoked_at=%s WHERE token_hash=%s', (auth.now(), current.token_hash))
        response = Response(status_code=204)
        response.delete_cookie('ax_session', path='/', secure=settings.mode == 'real', httponly=True, samesite='lax')
        return response

    @app.post('/api/v1/jobs')
    async def create_job(request: Request):
        jobs.pre_authenticate(request, write=True)
        key = idempotency_key(request)
        payload = await read_create(request)
        return json_response(await jobs.create(request, payload, key), 202)

    @app.get('/api/v1/jobs')
    async def list_jobs(request: Request):
        jobs.pre_authenticate(request)
        limit, cursor = list_query(request)
        return json_response(jobs.list(request, limit, cursor))

    @app.get('/api/v1/jobs/{job_id}')
    async def job_snapshot(job_id: str, request: Request):
        return json_response(jobs.snapshot(request, job_id))

    @app.get('/api/v1/commands/{command_id}')
    async def command_status(command_id: str, request: Request):
        return json_response(jobs.command(request, command_id))

    app.add_middleware(Boundary, settings=settings)
    return app
