"""Scoped projector activities. Results contain fixed protocol data only."""
from temporalio import activity

from .execution_protocol import (SHA, activation_proposal,
                                 canonical_uuid, proposal_digest)
from .workspace_fs import WorkspaceError


def wait():
    return {'status': 'wait', 'code': 'DEPENDENCY_UNAVAILABLE'}


class ActivationActivities:
    def __init__(self, store, identity, workspace):
        self.store, self.identity, self.workspace = store, identity, workspace

    def valid_request(self, request):
        return (type(request) is dict and set(request) == {'job_id', 'run_id', 'build_id', 'binding_sha256'}
                and canonical_uuid(request['job_id']) and canonical_uuid(request['run_id'])
                and request['build_id'] == self.identity.build_id
                and type(request['binding_sha256']) is str and bool(SHA.fullmatch(request['binding_sha256'])))

    @activity.defn(name='ifpmic.h2.read_activation')
    def read_activation(self, request):
        try:
            if not self.valid_request(request):
                return wait()
            answer = self.store.call('read_activation', request['job_id'], request['run_id'], request['build_id'])
            if answer['status'] != 'ready':
                if answer['status'] == 'quarantined':
                    return {'status': 'quarantined'}
                return wait()
            if answer['binding_sha256'] != request['binding_sha256']:
                self.store.call('report_projection_incident', request['job_id'], request['run_id'],
                                request['build_id'], 'BINDING_CONFLICT')
                return {'status': 'quarantined'}
            try:
                self.workspace.validate_ready(request['job_id'], answer['workspace_token'])
            except WorkspaceError as error:
                if error.code == 'WORKSPACE_UNSAFE':
                    self.store.call('report_projection_incident', request['job_id'], request['run_id'],
                                    request['build_id'], 'WORKSPACE_IDENTITY_CONFLICT')
                    return {'status': 'quarantined'}
                return wait()
            # Validate before serializing anything returned by SQL into history.
            activation_proposal(request['job_id'], request['run_id'], request['build_id'],
                                answer['binding_sha256'], answer['command_id'], answer['command_payload_sha256'])
            return {k: answer[k] for k in ('status', 'binding_sha256', 'command_id', 'command_payload_sha256')}
        except Exception:
            return wait()

    @activity.defn(name='ifpmic.h2.project_activation')
    def project_activation(self, proposal):
        try:
            if proposal['build_id'] != self.identity.build_id:
                return wait()
            digest = proposal_digest(proposal)
            # Deliberately no read_activation/filesystem/current-user check
            # here. A committed receipt must replay even if those facts change
            # after commit but before this activity result reaches history.
            answer = self.store.call('project_activation', proposal['job_id'], proposal['run_id'],
                                     proposal['build_id'], 1, 0, proposal['command_id'], digest)
            status = answer['status']
            if status == 'applied' and answer['revision'] == 1 and answer['job_status'] == 'QUEUED':
                return {'status': 'applied'}
            if (status == 'rejected' and answer['revision'] == 0 and answer['job_status'] == 'DRAFT'
                    and answer['error_code'] in ('FORBIDDEN', 'PROFILE_INELIGIBLE')):
                return {'status': 'rejected', 'code': answer['error_code']}
            if status == 'quarantined':
                return {'status': 'quarantined'}
            return wait()
        except Exception:
            return wait()
