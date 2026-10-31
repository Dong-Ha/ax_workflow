"""Short authenticated transactions; never retain a connection over Temporal I/O."""
from contextlib import contextmanager

import psycopg

CALLS = {
    'read_mock_task_input': 'SELECT ifpmic.read_mock_task_input(%s,%s,%s,%s)',
    'record_mock_task_result': 'SELECT ifpmic.record_mock_task_result(%s,%s,%s,%s,%s)',
    'read_dispatch_config': 'SELECT ifpmic.read_dispatch_config()',
    'read_registered_build': 'SELECT ifpmic.read_registered_build(%s)',
    'claim_delivery': 'SELECT ifpmic.claim_delivery(%s)',
    'reserve_execution': 'SELECT ifpmic.reserve_execution(%s,%s,%s,%s,%s,%s)',
    'record_start_attempt': 'SELECT ifpmic.record_start_attempt(%s,%s,%s,%s)',
    'admit_run': 'SELECT ifpmic.admit_run(%s,%s,%s,%s,%s)',
    'record_delivery': 'SELECT ifpmic.record_delivery(%s,%s,%s,%s,%s,%s)',
    'read_activation': 'SELECT ifpmic.read_activation(%s,%s,%s)',
    'project_activation': 'SELECT ifpmic.project_activation(%s,%s,%s,%s,%s,%s,%s)',
    'report_dispatch_incident': 'SELECT ifpmic.report_dispatch_incident(%s,%s,%s,%s)',
    'report_projection_incident': 'SELECT ifpmic.report_projection_incident(%s,%s,%s,%s)',
}


class ExecutionUnavailable(Exception):
    def __init__(self, uncertain=False):
        self.uncertain = uncertain
        super().__init__('COMMIT_UNCERTAIN' if uncertain else 'DEPENDENCY_UNAVAILABLE')


class ExecutionStore:
    def __init__(self, *, dsn=None, db_factory=None, fault_hook=None):
        if (dsn is None) == (db_factory is None):
            raise ValueError('EXECUTION_CONFIG_INVALID')
        self.db_factory = db_factory or (lambda: psycopg.connect(dsn, connect_timeout=3))
        # A TC-only in-process injection seam. No production env/HTTP switch.
        self.fault_hook = fault_hook

    def hook(self, phase):
        if self.fault_hook is not None:
            self.fault_hook(phase)

    @contextmanager
    def transaction(self, operation):
        committing = False
        try:
            with self.db_factory() as db:
                with db.transaction():
                    db.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
                    db.execute("SET LOCAL lock_timeout = '5s'")
                    db.execute("SET LOCAL statement_timeout = '30s'")
                    yield db
                    self.hook('before_' + operation + '_commit')
                    committing = True
            self.hook('after_' + operation + '_commit')
        except Exception:
            # Keep the original exception only in the local Python context.
            # No driver message/DSN/SQL text becomes an activity result.
            raise ExecutionUnavailable(committing) from None

    def call(self, operation, *args):
        statement = CALLS[operation]  # Closed allowlist, never caller SQL.
        with self.transaction(operation) as db:
            answer = db.execute(statement, args).fetchone()[0]
            if type(answer) is not dict:
                raise ValueError('EXECUTION_PROTOCOL_INVALID')
        return answer
