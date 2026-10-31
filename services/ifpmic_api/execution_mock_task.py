"""A bounded metadata preflight. No shell, tools, network, or business stages."""
from psycopg.types.json import Jsonb
from temporalio import activity
from temporalio.exceptions import ApplicationError

from .execution_protocol import SHA, canonical_uuid
from .mock_task import TASK_KIND, evaluate_preflight
from .workspace_fs import WorkspaceError


class MockTaskActivities:
    def __init__(self, store, identity, workspace, *, mode=None):
        if mode not in (None, TASK_KIND):
            raise ValueError('EXECUTION_CONFIG_INVALID')
        self.store, self.identity, self.workspace, self.mode = store, identity, workspace, mode

    @activity.defn(name='ifpmic.mock.preflight')
    def run(self, request):
        if (self.mode != TASK_KIND or type(request) is not dict
                or set(request) != {'job_id', 'run_id', 'build_id', 'binding_sha256'}
                or not canonical_uuid(request['job_id']) or not canonical_uuid(request['run_id'])
                or request['build_id'] != self.identity.build_id
                or type(request['binding_sha256']) is not str or not SHA.fullmatch(request['binding_sha256'])):
            return {'status': 'quarantined'}
        args = tuple(request[key] for key in ('job_id', 'run_id', 'build_id', 'binding_sha256'))
        try:
            answer = self.store.call('read_mock_task_input', *args)
            if answer == {'status': 'completed'}:
                # Replay a committed effect without re-evaluating mutable FS
                # state or manufacturing another result after a lost response.
                return {'status': 'completed'}
            if (type(answer) is not dict or set(answer) != {'status', 'workspace_token', 'input'}
                    or answer['status'] != 'ready' or not canonical_uuid(answer['workspace_token'])):
                return {'status': 'quarantined'}
            value = answer['input']
            if (type(value) is not dict or value.get('job_id') != request['job_id']
                    or value.get('admitted_run_id') != request['run_id']
                    or value.get('build_id') != request['build_id']
                    or not canonical_uuid(value.get('command_id'))):
                return {'status': 'quarantined'}
            # Input and workspace token never become activity results/history.
            self.workspace.validate_ready(request['job_id'], answer['workspace_token'])
            result = evaluate_preflight(value)
            recorded = self.store.call('record_mock_task_result', *args, Jsonb(result))
            if recorded != {'status': 'completed'}:
                return {'status': 'quarantined'}
            return {'status': 'completed'}
        except WorkspaceError as error:
            if error.code == 'WORKSPACE_UNSAFE':
                return {'status': 'quarantined'}
            raise ApplicationError('DEPENDENCY_UNAVAILABLE', type='MockTaskUnavailable') from None
        except ValueError:
            return {'status': 'quarantined'}
        except Exception:
            # Fixed retryable SDK error. Never serialize a driver exception,
            # SQL statement, workspace token, source payload, or DSN.
            raise ApplicationError('DEPENDENCY_UNAVAILABLE', type='MockTaskUnavailable') from None
