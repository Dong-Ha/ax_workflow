"""Durable outbox delivery. Only Temporal may decide/apply business state."""
import asyncio

from .execution_protocol import ProtocolError
from .execution_store import ExecutionUnavailable
from .execution_temporal import MissingHistory, TransportUnavailable
from .workspace_fs import WorkspaceError


class Dispatcher:
    def __init__(self, store, transport, identity, workspace, *, fault_hook=None):
        self.store, self.transport, self.identity, self.workspace = store, transport, identity, workspace
        self.fault_hook = fault_hook  # TC process barrier injection only.

    async def call(self, operation, *args):
        return await asyncio.to_thread(self.store.call, operation, *args)

    def hook(self, phase):
        if self.fault_hook is not None:
            self.fault_hook(phase)

    async def bootstrap(self):
        self.identity.check_dispatcher(await self.call('read_dispatch_config'))
        await asyncio.to_thread(self.workspace.check_root)

    async def once(self, command_id=None):
        claim = None
        try:
            # Recheck registration, source-selected build and deployment on every
            # pass. Startup also performs this check before any network connect.
            await self.bootstrap()
            claim = await self.call('claim_delivery', command_id)
            if claim['status'] != 'claimed':
                return {'status': 'idle'}
            self.hook('after_claim_commit')
            return await self.deliver(claim)
        except ExecutionUnavailable as error:
            # An uncertain commit is never followed by an RPC on the assumption
            # that it failed. A fresh claim/SQL read reconciles on a later pass.
            return {'status': 'wait', 'code': 'COMMIT_UNCERTAIN' if error.uncertain else 'DEPENDENCY_UNAVAILABLE'}
        except ProtocolError as error:
            if claim is None:
                return {'status': 'unavailable', 'code': error.code}
            return await self.incident(claim, error.code)
        except TransportUnavailable:
            if claim is not None:
                return await self.ack(claim, 'uncertain', code='DEPENDENCY_UNAVAILABLE')
            return {'status': 'wait', 'code': 'DEPENDENCY_UNAVAILABLE'}

    async def ack(self, claim, result, run_id=None, code=None):
        try:
            value = await self.call('record_delivery', claim['command_id'], claim['generation'],
                                    claim['claim_token'], result, run_id, code)
            self.hook('after_delivery_ack')
            return value
        except ExecutionUnavailable as error:
            return {'status': 'wait', 'code': 'COMMIT_UNCERTAIN' if error.uncertain else 'DEPENDENCY_UNAVAILABLE'}

    async def incident(self, claim, code):
        try:
            return await self.call('report_dispatch_incident', claim['command_id'],
                                   claim['generation'], claim['claim_token'], code)
        except ExecutionUnavailable:
            return {'status': 'wait', 'code': 'DEPENDENCY_UNAVAILABLE'}

    async def deliver(self, claim):
        binding = claim['binding']
        create = claim['route'] == 'POST /api/v1/jobs'
        if create and (binding is None or binding['admitted_run_id'] is None):
            workspace = claim['workspace']
            if workspace is None or workspace['state'] != 'READY':
                return await self.ack(claim, 'retry', code='WORKSPACE_NOT_READY')
            try:
                await asyncio.to_thread(self.workspace.validate_ready, claim['job_id'], workspace['workspace_token'])
            except WorkspaceError as error:
                if error.code == 'WORKSPACE_UNSAFE':
                    # Requires append004's narrowly scoped pre-binding incident
                    # branch. Never reserve an unvalidated workspace to report it.
                    return await self.incident(claim, 'WORKSPACE_IDENTITY_CONFLICT')
                return await self.ack(claim, 'retry', code='DEPENDENCY_UNAVAILABLE')
            reserved = await self.call('reserve_execution', claim['command_id'], claim['generation'],
                                       claim['claim_token'], self.identity.build_id,
                                       workspace['workspace_token'], workspace['generation'])
            if reserved['status'] == 'wait':
                return await self.ack(claim, 'retry', code=reserved['code'])
            if reserved['status'] != 'reserved':
                return reserved
            binding = reserved['binding']
        if binding is None:
            raise ProtocolError('BINDING_CONFLICT')
        # Even pre-existing bindings must match this process's pinned deployment
        # and build. There is no newer-build or other-endpoint fallback.
        if any(binding[k] != value for k, value in (
                ('deployment_id', self.identity.deployment_id), ('namespace', self.identity.namespace),
                ('server_config_sha256', self.identity.server_config_sha256),
                ('build_id', self.identity.build_id), ('task_queue', self.identity.task_queue))):
            raise ProtocolError('BINDING_CONFLICT')
        if binding['state'] == 'quarantined':
            return {'status': 'quarantined', 'code': binding['quarantine_code']}
        if create and claim['command_status'] in ('applied', 'rejected') and binding['admitted_run_id']:
            # SQL verifies the immutable terminal receipt; status alone does not
            # authorize this reconciliation and no extra start is sent.
            return await self.ack(claim, 'receipt_reconciled', binding['admitted_run_id'])
        if not create and binding['admitted_run_id'] is None:
            return await self.ack(claim, 'retry', code='BINDING_NOT_ADMITTED')
        try:
            run_id = await self.transport.observe(binding)
        except MissingHistory:
            if binding['admitted_run_id'] is not None:
                return await self.incident(claim, 'HISTORY_MISSING')
            if not create:
                raise ProtocolError('BINDING_CONFLICT')
            try:
                retention = await self.transport.retention_seconds()
            except (TransportUnavailable, ProtocolError):
                return await self.incident(claim, 'RETENTION_UNVERIFIED')
            attempt = await self.call('record_start_attempt', claim['command_id'], claim['generation'],
                                      claim['claim_token'], retention)
            if attempt['status'] != 'permitted':
                return attempt
            binding = attempt['binding']
            self.hook('before_start_rpc')
            await self.transport.start(binding)
            self.hook('after_start_response')
            # Start's returned handle (or AlreadyStarted) is insufficient proof.
            try:
                run_id = await self.transport.observe(binding)
            except MissingHistory:
                return await self.ack(claim, 'uncertain', code='DEPENDENCY_UNAVAILABLE')
        self.hook('after_history_observed')
        if create:
            admission = await self.call('admit_run', claim['command_id'], claim['generation'],
                                        claim['claim_token'], run_id, binding['binding_sha256'])
            if admission['status'] != 'admitted':
                return admission
            self.hook('after_run_admitted')
            return await self.ack(claim, 'started', run_id)
        if run_id != binding['admitted_run_id']:
            raise ProtocolError('RUN_CONFLICT')
        await self.transport.signal(binding, claim['command_id'], claim['payload_sha256'])
        self.hook('after_signal_response')
        return await self.ack(claim, 'signaled', run_id)
