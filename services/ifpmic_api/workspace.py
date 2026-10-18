"""Explicit workspace worker. A READY intent never applies a job command."""
from contextlib import contextmanager
import json
import os
import signal
import sys
import time

from .request_contract import canonical_uuid, strict_json
from .settings import load_settings
from .workspace_fs import WorkspaceFilesystem, WorkspaceError

MAX_GENERATION = 9223372036854775807
COLUMNS = 'job_id,workspace_token,state,generation,claim_token,claim_expires_at,error_code'


def result(status, job_id=None, error_code=None):
    return {'status': status, 'job_id': str(job_id) if job_id is not None else None, 'error_code': error_code}


class DatabaseFailure(Exception):
    def __init__(self, uncertain):
        self.uncertain = uncertain


class WorkspaceService:
    def __init__(self, settings, *, db_factory, filesystem=None, fault_hook=None):
        self.settings = settings
        self.db_factory = db_factory
        self.filesystem = filesystem
        self.fault_hook = fault_hook

    def hook(self, name):
        if self.fault_hook:
            self.fault_hook(name)

    @contextmanager
    def transaction(self, operation=None):
        committing = False
        phase = None
        try:
            with self.db_factory() as db:
                with db.transaction():
                    db.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
                    db.execute("SET LOCAL lock_timeout = '5s'")
                    db.execute("SET LOCAL statement_timeout = '30s'")
                    yield db
                    phase = operation.get('phase') if operation is not None else None
                    if phase:
                        self.hook(f'workspace_before_{phase}_commit')
                        committing = True
            if phase:
                self.hook(f'workspace_after_{phase}_commit')
        except Exception:
            raise DatabaseFailure(committing) from None

    @staticmethod
    def database_result(error, job_id=None):
        return result('commit_uncertain' if error.uncertain else 'dependency_unavailable', job_id,
                      'WORKSPACE_COMMIT_UNCERTAIN' if error.uncertain else 'WORKSPACE_UNAVAILABLE')

    @staticmethod
    def valid(row):
        _, _, state, generation, token, expires, error = row[:7]
        if state == 'RESERVED':
            return token is None and expires is None and error is None and generation < MAX_GENERATION
        if state == 'PROVISIONING':
            return generation > 0 and token is not None and expires is not None and error is None
        if state == 'READY':
            return generation > 0 and token is None and expires is None and error is None
        return False

    def claim(self, job_id):
        operation = {}
        answer = result('idle')
        with self.transaction(operation) as db:
            row = db.execute('SELECT ' + COLUMNS + ''' FROM ifpmic.workspace_intents
                WHERE (state='RESERVED' OR (state='PROVISIONING' AND
                   (claim_token IS NULL OR claim_expires_at IS NULL OR generation=0 OR error_code IS NOT NULL
                    OR claim_expires_at<=clock_timestamp())))
                AND (%s::uuid IS NULL OR job_id=%s::uuid)
                ORDER BY job_id LIMIT 1 FOR UPDATE SKIP LOCKED''', (job_id, job_id)).fetchone()
            if row is not None:
                # Fresh statement/clock after row lock, not a pre-wait timestamp.
                row = db.execute('SELECT ' + COLUMNS + ',clock_timestamp() FROM ifpmic.workspace_intents WHERE job_id=%s',
                                 (row[0],)).fetchone()
                if not self.valid(row) or (row[2] == 'PROVISIONING' and row[3] == MAX_GENERATION):
                    db.execute('''UPDATE ifpmic.workspace_intents SET state='ERROR',claim_token=NULL,
                        claim_expires_at=NULL,error_code='WORKSPACE_INVALID_STATE' WHERE job_id=%s''', (row[0],))
                    operation['phase'] = 'error'
                    answer = result('error', row[0], 'WORKSPACE_INVALID_STATE')
                elif row[2] == 'RESERVED' or row[5] <= row[7]:
                    claimed = db.execute('''UPDATE ifpmic.workspace_intents SET state='PROVISIONING',
                        generation=generation+1,claim_token=gen_random_uuid(),
                        claim_expires_at=clock_timestamp()+(%s * interval '1 second'),error_code=NULL
                        WHERE job_id=%s RETURNING job_id,workspace_token,generation,claim_token''',
                                         (self.settings.workspace_lease_seconds, row[0])).fetchone()
                    operation['phase'] = 'claim'
                    answer = claimed
        return answer

    def finish(self, claim, error_code=None):
        job_id, _, generation, token = claim
        operation = {}
        answer = result('stale', job_id, 'WORKSPACE_STALE')
        if error_code is None:
            self.hook('workspace_before_ready')
        with self.transaction(operation) as db:
            db.execute('SELECT job_id FROM ifpmic.workspace_intents WHERE job_id=%s FOR UPDATE', (job_id,)).fetchone()
            self.hook('workspace_after_completion_lock')
            row = db.execute('''UPDATE ifpmic.workspace_intents SET state=%s,claim_token=NULL,
                claim_expires_at=NULL,error_code=%s WHERE job_id=%s AND state='PROVISIONING'
                AND generation=%s AND claim_token=%s AND claim_expires_at>clock_timestamp()
                RETURNING job_id''', ('ERROR' if error_code else 'READY', error_code, job_id, generation, token)).fetchone()
            if row is not None:
                operation['phase'] = 'error' if error_code else 'ready'
                answer = result('error' if error_code else 'ready', job_id, error_code)
        return answer

    def reconcile_once(self, job_id=None):
        if self.settings.workspace_root is None or (job_id is not None and not canonical_uuid(job_id)):
            return result('invalid_request', error_code='WORKSPACE_INVALID_REQUEST')
        claim = None
        try:
            if job_id is not None:
                with self.transaction() as db:
                    row = db.execute('SELECT ' + COLUMNS + ' FROM ifpmic.workspace_intents WHERE job_id=%s', (job_id,)).fetchone()
                if row is None or row[2] == 'ERROR':
                    return result('idle')
                if row[2] == 'READY':
                    return (result('already_ready', row[0]) if self.valid(row)
                            else result('error', row[0], 'WORKSPACE_INVALID_STATE'))
            if self.filesystem is None:
                self.filesystem = WorkspaceFilesystem(self.settings.workspace_root, fault_hook=self.fault_hook)
            self.filesystem.check_root()
            self.hook('workspace_before_claim')
            claim = self.claim(job_id)
            if isinstance(claim, dict):
                return claim
            try:
                self.filesystem.provision(str(claim[0]), str(claim[1]))
            except WorkspaceError as error:
                return self.finish(claim, error.code)
            return self.finish(claim)
        except WorkspaceError as error:
            return result('error', error_code=error.code)
        except DatabaseFailure as error:
            return self.database_result(error, claim[0] if isinstance(claim, tuple) else job_id)
        except Exception:
            return result('dependency_unavailable', claim[0] if isinstance(claim, tuple) else job_id, 'WORKSPACE_UNAVAILABLE')

    def retry_error(self, job_id):
        if self.settings.workspace_root is None or not canonical_uuid(job_id):
            return result('invalid_request', error_code='WORKSPACE_INVALID_REQUEST')
        operation = {}
        answer = result('not_retryable', job_id)
        try:
            with self.transaction(operation) as db:
                row = db.execute('SELECT state FROM ifpmic.workspace_intents WHERE job_id=%s FOR UPDATE', (job_id,)).fetchone()
                if row is not None and row[0] == 'ERROR':
                    db.execute('''UPDATE ifpmic.workspace_intents SET state='RESERVED',claim_token=NULL,
                        claim_expires_at=NULL,error_code=NULL WHERE job_id=%s''', (job_id,))
                    operation['phase'] = 'retry'
                    answer = result('retry_queued', job_id)
            return answer
        except DatabaseFailure as error:
            return self.database_result(error, job_id)


def main():
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in {'once', 'run', 'retry-error'}:
            raise ValueError()
        command = sys.argv[1]
        settings = load_settings(os.environ['IFPMIC_API_CONFIG'])
        if settings.workspace_root is None or not settings.database_dsn:
            raise ValueError()
        job_id = None
        if command != 'run':
            raw = sys.stdin.buffer.read(65537)
            if len(raw) > 65536:
                raise ValueError()
            data = strict_json(raw)
            allowed = ({}, {'job_id': data.get('job_id')}) if type(data) is dict else ()
            if data not in allowed or (command == 'retry-error' and 'job_id' not in data):
                raise ValueError()
            job_id = data.get('job_id')
            if 'job_id' in data and not canonical_uuid(job_id):
                raise ValueError()
    except Exception:
        output = result('invalid_request', error_code='WORKSPACE_INVALID_REQUEST')
        print(json.dumps(output, sort_keys=True, separators=(',', ':'), ensure_ascii=True))
        return 2
    import psycopg
    os.umask(0o077)  # Explicit standalone worker only, never shared API process.
    service = WorkspaceService(settings, db_factory=lambda: psycopg.connect(
        settings.database_dsn, autocommit=True, connect_timeout=10))
    if command == 'run':
        stopped = False

        def stop(signum, frame):
            nonlocal stopped
            stopped = True

        signal.signal(signal.SIGINT, stop)
        signal.signal(signal.SIGTERM, stop)
        while not stopped:
            service.reconcile_once()
            deadline = time.monotonic() + settings.workspace_poll_seconds
            while not stopped and time.monotonic() < deadline:
                time.sleep(min(0.1, max(0, deadline - time.monotonic())))
        output = result('stopped')
    else:
        output = service.retry_error(job_id) if command == 'retry-error' else service.reconcile_once(job_id)
    print(json.dumps(output, sort_keys=True, separators=(',', ':'), ensure_ascii=True))
    return 0 if output['status'] in {'ready', 'already_ready', 'idle', 'retry_queued', 'not_retryable', 'stopped'} else 3


if __name__ == '__main__':
    sys.exit(main())
