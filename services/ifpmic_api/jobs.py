"""User-scoped durable create commands. Acceptance never executes a workflow."""
from contextlib import contextmanager
import json
import uuid

import psycopg

from .errors import ApiError
from .admission import validate_admission
from .request_contract import canonical_uuid, make_cursor, payload_identity, read_cursor
from .snapshot_bridge import BridgeError, SnapshotBridge, SnapshotRecord

ROUTE = 'POST /api/v1/jobs'
IDEMPOTENCY_CONSTRAINT = 'commands_actor_id_route_idempotency_key_key'
JOB_STATUSES = frozenset({
    'DRAFT', 'QUEUED', 'RUNNING', 'WAITING_HUMAN', 'WAITING_DEVICE', 'PAUSED',
    'RECONCILING', 'FAILED', 'CANCELED', 'NO_CHANGE', 'RELEASED_PENDING_NOTES', 'COMPLETED',
})
WORKFLOW_NODE_IDS = frozenset({
    'P01', 'P02', 'P03', 'P04', 'P05', 'X01', 'P06', 'P07', 'P08', 'P09',
    'P10', 'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19',
    'P20', 'P21', 'P22', 'P23', 'P24', 'X02', 'X03', 'P25', 'P26',
})
CATALOG_COLUMNS = ('project_id', 'version_key', 'snapshot_id', 'record_bytes', 'record_bytes_sha256',
                   'profile_version_json', 'mode', 'enabled', 'configuration_complete')
JOB_COLUMNS = '''j.job_id,j.owner_id,j.status,j.revision,j.cycle,j.workflow_id,
                 j.current_step_ids,j.candidate_fingerprint,c.command_payload_json,j.created_at'''
VISIBLE = '''EXISTS (SELECT 1 FROM ifpmic.memberships m WHERE m.project_id=j.project_id
                 AND m.user_id=%s AND m.active)
             AND (j.owner_id=%s OR EXISTS (SELECT 1 FROM ifpmic.job_delegations d
                 WHERE d.project_id=j.project_id AND d.job_id=j.job_id AND d.user_id=%s
                 AND d.action='job.read' AND d.revoked_at IS NULL AND d.expires_at>%s))'''


class ReplayRace(Exception):
    """Roll back attempted-project locks before inspecting the original project."""


class JobService:
    def __init__(self, settings, auth, *, db_factory, bridge_runner=None, fault_hook=None):
        self.settings = settings
        self.auth = auth
        self.db_factory = db_factory
        self.bridge = bridge_runner
        self.fault_hook = fault_hook

    @contextmanager
    def transaction(self):
        with self.db_factory() as db:
            with db.transaction():
                db.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
                db.execute("SET LOCAL lock_timeout = '5s'")
                db.execute("SET LOCAL statement_timeout = '30s'")
                yield db

    def hook(self, name):
        if self.fault_hook:
            self.fault_hook(name)

    def pre_authenticate(self, request, *, write=False):
        with self.transaction() as db:
            self.auth.authenticate(db, request, write=write)

    @staticmethod
    def existing(db, actor, key):
        return db.execute('''SELECT command_id,project_id,job_id,payload_sha256 FROM ifpmic.commands
            WHERE actor_id=%s AND route=%s AND idempotency_key=%s''', (actor, ROUTE, key)).fetchone()

    def lock_membership(self, db, actor, project, *, create=False):
        row = db.execute('SELECT project_id FROM ifpmic.authorization_guards WHERE project_id=%s FOR UPDATE',
                         (project,)).fetchone()
        if row is None:
            raise ApiError('FORBIDDEN')
        self.hook('job_after_guard_lock')
        # Direct operator UPDATE acquires its tuple before its trigger takes the
        # guard. NOWAIT prevents waiting back on that tuple while owning guard.
        membership = db.execute('''SELECT active,capabilities FROM ifpmic.memberships
            WHERE project_id=%s AND user_id=%s FOR UPDATE NOWAIT''', (project, actor)).fetchone()
        self.hook('job_after_membership_lock')
        if membership is None or not membership[0] or (create and 'request.create' not in membership[1]):
            raise ApiError('FORBIDDEN')

    def replay(self, db, request, current, existing, digest):
        command_id, project, job_id, previous_digest = existing
        self.lock_membership(db, current.user_id, project)
        # A wait for authority can cross a session's idle/absolute expiry.
        self.auth.authenticate(db, request, write=True)
        owned = db.execute('''SELECT 1 FROM ifpmic.jobs
            WHERE project_id=%s AND job_id=%s AND owner_id=%s''', (project, job_id, current.user_id)).fetchone()
        if owned is None:
            raise ApiError('FORBIDDEN')
        if previous_digest != digest:
            raise ApiError('IDEMPOTENCY_CONFLICT')
        return {'command_id': str(command_id), 'status': 'accepted', 'resource_id': str(job_id)}

    def probe(self, request, key, payload, digest, *, check_new_membership=False):
        result = None
        with self.transaction() as db:
            current = self.auth.authenticate(db, request, write=True)
            existing = self.existing(db, current.user_id, key)
            if existing is not None:
                result = self.replay(db, request, current, existing, digest)
            elif check_new_membership:
                row = db.execute('''SELECT 1 FROM ifpmic.memberships
                    WHERE project_id=%s AND user_id=%s AND active AND 'request.create'=ANY(capabilities)''',
                                 (payload['project_id'], current.user_id)).fetchone()
                if row is None:
                    raise ApiError('FORBIDDEN')
        return result

    async def capture(self, payload):
        if self.bridge is None:
            if self.settings.node_executable is None:
                raise ApiError('DEPENDENCY_UNAVAILABLE')
            self.bridge = SnapshotBridge(self.settings.node_executable, self.settings.profile_store)
        record = await self.bridge.read_snapshot(payload['project_id'], payload['profile_version'])
        if not isinstance(record, SnapshotRecord):
            raise ApiError('DEPENDENCY_UNAVAILABLE')
        return record

    def bind_snapshot(self, db, payload, record, now):
        if record.project_id != payload['project_id'] or record.profile_version != payload['profile_version']:
            raise ApiError('PROFILE_VERSION_CONFLICT')
        catalog = db.execute('''SELECT project_id,version_key,snapshot_id,record_bytes,record_bytes_sha256,
            profile_version_json,mode,enabled,configuration_complete FROM ifpmic.profile_catalog
            WHERE project_id=%s AND version_key=%s''', (payload['project_id'], record.version_key)).fetchone()
        if catalog is None:
            raise ApiError('PROFILE_INELIGIBLE')
        if tuple(catalog) != tuple(getattr(record, name) for name in CATALOG_COLUMNS):
            raise ApiError('PROFILE_VERSION_CONFLICT')
        if not record.enabled or not record.configuration_complete or record.mode != self.settings.mode:
            raise ApiError('PROFILE_INELIGIBLE')
        grant = db.execute('''SELECT 1 FROM ifpmic.profile_eligibility e
            WHERE e.project_id=%s AND e.snapshot_id=%s AND e.mode=%s AND e.granted_at<=%s AND e.expires_at>%s
            AND NOT EXISTS (SELECT 1 FROM ifpmic.profile_revocations r
                WHERE r.project_id=e.project_id AND r.eligibility_id=e.eligibility_id) LIMIT 1''',
                           (record.project_id, record.snapshot_id, self.settings.mode, now, now)).fetchone()
        if grant is None:
            raise ApiError('PROFILE_INELIGIBLE')

    @staticmethod
    def artifacts(db, actor, payload):
        ids = payload['input_artifact_ids']
        if ids:
            found = db.execute('''SELECT count(*) FROM ifpmic.artifacts WHERE artifact_id=ANY(%s::uuid[])
                AND project_id=%s AND owner_id=%s AND state='available' ''',
                               (ids, payload['project_id'], actor)).fetchone()[0]
            if found != len(set(ids)):
                raise ApiError('FORBIDDEN')

    async def create(self, request, payload, key):
        stored, digest = payload_identity(payload)
        receipt = self.probe(request, key, payload, digest, check_new_membership=True)
        if receipt is not None:
            return receipt
        # Every transaction/session lock is closed before an external process.
        try:
            record = await self.capture(payload)
        except Exception as error:
            receipt = self.probe(request, key, payload, digest)
            if receipt is not None:
                return receipt
            code = ('PROFILE_INELIGIBLE' if isinstance(error, BridgeError) and error.code == 'PROFILE_VERSION_INVALID'
                    else 'DEPENDENCY_UNAVAILABLE')
            raise ApiError(code) from None
        commit_started = False
        try:
            with self.transaction() as db:
                current = self.auth.authenticate(db, request, write=True)
                if self.existing(db, current.user_id, key) is not None:
                    raise ReplayRace()
                self.lock_membership(db, current.user_id, payload['project_id'], create=True)
                self.auth.authenticate(db, request, write=True)
                if self.existing(db, current.user_id, key) is not None:
                    raise ReplayRace()
                self.bind_snapshot(db, payload, record, self.auth.now())
                self.artifacts(db, current.user_id, payload)
                job_id = uuid.uuid4()
                command_id = uuid.uuid4()
                self.hook('job_before_insert')
                db.execute('''INSERT INTO ifpmic.jobs(job_id,create_command_id,owner_id,project_id,snapshot_id,workflow_id)
                    VALUES(%s,%s,%s,%s,%s,%s)''',
                           (job_id, command_id, current.user_id, payload['project_id'],
                            record.snapshot_id, record.workflow_id))
                self.hook('job_after_insert')
                self.hook('command_before_insert')
                command_id = db.execute('''INSERT INTO ifpmic.commands
                    (command_id,actor_id,route,idempotency_key,project_id,job_id,command_payload_json,payload_sha256)
                    VALUES(%s,%s,%s,%s,%s,%s,%s,%s) RETURNING command_id''',
                                        (command_id, current.user_id, ROUTE, key, payload['project_id'],
                                         job_id, stored, digest)).fetchone()[0]
                self.hook('command_after_insert')
                self.hook('outbox_before_insert')
                db.execute('INSERT INTO ifpmic.commands_outbox(command_id) VALUES(%s)', (command_id,))
                self.hook('outbox_after_insert')
                self.hook('intent_before_insert')
                db.execute('INSERT INTO ifpmic.workspace_intents(job_id,command_id) VALUES(%s,%s)', (job_id, command_id))
                self.hook('intent_after_insert')
                self.hook('job_before_commit')
                commit_started = True
            self.hook('job_after_commit')
            self.hook('job_before_response')
            return {'command_id': str(command_id), 'status': 'accepted', 'resource_id': str(job_id)}
        except ReplayRace:
            receipt = self.probe(request, key, payload, digest)
            if receipt is None:
                raise ApiError('DEPENDENCY_UNAVAILABLE') from None
            return receipt
        except psycopg.errors.UniqueViolation as error:
            if (not commit_started and error.diag.schema_name == 'ifpmic' and error.diag.table_name == 'commands'
                    and error.diag.constraint_name == IDEMPOTENCY_CONSTRAINT):
                receipt = self.probe(request, key, payload, digest)
                if receipt is not None:
                    return receipt
            raise ApiError('COMMIT_UNCERTAIN' if commit_started else 'DEPENDENCY_UNAVAILABLE') from None
        except ApiError:
            if commit_started:
                raise ApiError('COMMIT_UNCERTAIN') from None
            raise
        except Exception:
            raise ApiError('COMMIT_UNCERTAIN' if commit_started else 'DEPENDENCY_UNAVAILABLE') from None

    @staticmethod
    def job_dto(row):
        if (type(row[2]) is not str or row[2] not in JOB_STATUSES or
                type(row[3]) is not int or row[3] < 0 or
                type(row[4]) is not int or row[4] < 0 or not isinstance(row[6], list) or
                any(type(step_id) is not str or step_id not in WORKFLOW_NODE_IDS for step_id in row[6])):
            raise ApiError('DEPENDENCY_UNAVAILABLE')
        payload = json.loads(row[8])
        return {'job_id': str(row[0]), 'owner_id': str(row[1]), 'status': row[2], 'revision': row[3],
                'cycle': row[4], 'workflow_version': row[5], 'current_step_ids': row[6],
                'candidate_fingerprint': row[7], 'profile_version': payload['profile_version']}

    def list(self, request, limit, cursor):
        with self.transaction() as db:
            current = self.auth.authenticate(db, request)
            anchor = read_cursor(self.settings.csrf_key, current.user_id, cursor)
            params = [current.user_id, current.user_id, current.user_id, self.auth.now()]
            boundary = ''
            if anchor is not None:
                boundary = ' AND (j.created_at,j.job_id)<(%s::timestamptz,%s::uuid)'
                params.extend(anchor)
            params.append(limit + 1)
            rows = db.execute('SELECT ' + JOB_COLUMNS + ''' FROM ifpmic.jobs j
                JOIN ifpmic.commands c ON c.command_id=j.create_command_id AND c.job_id=j.job_id
                    AND c.route='POST /api/v1/jobs'
                WHERE ''' + VISIBLE + boundary + ' ORDER BY j.created_at DESC,j.job_id DESC LIMIT %s', params).fetchall()
            visible = rows[:limit]
            next_cursor = (make_cursor(self.settings.csrf_key, current.user_id, visible[-1][9], visible[-1][0])
                           if len(rows) > limit else None)
            return {'items': [self.job_dto(row) for row in visible], 'next_cursor': next_cursor}

    def snapshot(self, request, job_id):
        with self.transaction() as db:
            current = self.auth.authenticate(db, request)
            if not canonical_uuid(job_id):
                raise ApiError('FORBIDDEN')
            row = db.execute('SELECT ' + JOB_COLUMNS + ''' FROM ifpmic.jobs j
                JOIN ifpmic.commands c ON c.command_id=j.create_command_id AND c.job_id=j.job_id
                    AND c.route='POST /api/v1/jobs'
                WHERE j.job_id=%s AND ''' + VISIBLE,
                             (job_id, current.user_id, current.user_id, current.user_id, self.auth.now())).fetchone()
            if row is None:
                raise ApiError('FORBIDDEN')
            job = self.job_dto(row)
            return {'job': job, 'steps': [], 'last_event_id': ''}

    def admission(self, request, job_id):
        with self.transaction() as db:
            current = self.auth.authenticate(db, request)
            if not canonical_uuid(job_id):
                raise ApiError('FORBIDDEN')
            # Visibility, the exact CREATE command, and the privileged read
            # capability share one READ COMMITTED statement snapshot.
            rows = db.execute('''SELECT j.job_id,j.project_id,j.create_command_id,j.owner_id,
                    c.command_id,c.actor_id,a.job_id,a.project_id,a.create_command_id,a.owner_id,a.admission
                FROM ifpmic.jobs j
                LEFT JOIN ifpmic.commands c ON c.command_id=j.create_command_id AND c.job_id=j.job_id
                    AND c.project_id=j.project_id AND c.route='POST /api/v1/jobs'
                LEFT JOIN LATERAL ifpmic.read_job_admission(j.job_id) a ON true
                WHERE j.job_id=%s AND ''' + VISIBLE + ' LIMIT 2',
                (job_id, current.user_id, current.user_id, current.user_id, self.auth.now())).fetchall()
            if not rows:
                raise ApiError('FORBIDDEN')
            if len(rows) != 1:
                raise ApiError('DEPENDENCY_UNAVAILABLE')
            row = rows[0]
            if (row[4] != row[2] or row[5] != row[3]
                    or tuple(row[6:10]) != tuple(row[:4])):
                raise ApiError('DEPENDENCY_UNAVAILABLE')
            return validate_admission(row[10], job_id=row[0], command_id=row[2], job_statuses=JOB_STATUSES)

    def command(self, request, command_id):
        with self.transaction() as db:
            current = self.auth.authenticate(db, request)
            if not canonical_uuid(command_id):
                raise ApiError('FORBIDDEN')
            row = db.execute('''SELECT c.command_id,c.status,c.applied_revision,c.error_code
                FROM ifpmic.commands c JOIN ifpmic.jobs j ON j.project_id=c.project_id AND j.job_id=c.job_id
                WHERE c.command_id=%s AND ''' + VISIBLE,
                             (command_id, current.user_id, current.user_id, current.user_id, self.auth.now())).fetchone()
            if row is None:
                raise ApiError('FORBIDDEN')
            error = None
            if row[3] is not None:
                if row[3] not in ApiError.STATUS:
                    raise ApiError('DEPENDENCY_UNAVAILABLE')
                error = {'code': row[3], 'message': row[3], 'trace_id': request.scope['ifpmic.trace_id']}
            return {'command_id': str(row[0]), 'status': row[1], 'applied_revision': row[2], 'error': error}
