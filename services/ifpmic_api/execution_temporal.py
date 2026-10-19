"""Exact-ID Temporal transport. SQL never receives unobserved start claims."""
import asyncio
from datetime import timedelta

from temporalio.api.workflowservice.v1 import DescribeNamespaceRequest
from temporalio.client import Client
from temporalio.common import WorkflowIDConflictPolicy, WorkflowIDReusePolicy
from temporalio.converter import DataConverter, DefaultFailureConverter
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.service import RPCError, RPCStatusCode

from .execution_protocol import (WORKFLOW_TYPE, ProtocolError, canonical_uuid,
                                 start_input, workflow_id)

RPC_TIMEOUT = timedelta(seconds=10)


class MissingHistory(Exception):
    pass


class TransportUnavailable(Exception):
    def __init__(self):
        super().__init__('DEPENDENCY_UNAVAILABLE')


class PrivateFailureConverter(DefaultFailureConverter):
    """Unexpected Python failures must not serialize paths, text or arguments."""
    def to_failure(self, exception, payload_converter, failure):
        # Emit a fixed application failure directly; never serialize the raw
        # exception first, including its potentially private cause/details.
        failure.Clear()
        failure.message = 'IFPMIC_EXECUTION_UNAVAILABLE'
        failure.source = 'PythonSDK'
        failure.application_failure_info.type = 'IFPMICExecutionUnavailable'
        failure.application_failure_info.non_retryable = False


DATA_CONVERTER = DataConverter(failure_converter_class=PrivateFailureConverter)


class TemporalTransport:
    def __init__(self, client, identity):
        if client.namespace != identity.namespace:
            raise ProtocolError('BINDING_CONFLICT')
        self.client, self.identity = client, identity

    @classmethod
    async def connect(cls, identity):
        try:
            client = await asyncio.wait_for(Client.connect(
                identity.server_endpoint, namespace=identity.namespace,
                data_converter=DATA_CONVERTER, identity='ifpmic-h2'), timeout=10)
            return cls(client, identity)
        except Exception:
            raise TransportUnavailable() from None

    async def retention_seconds(self):
        try:
            response = await asyncio.wait_for(self.client.workflow_service.describe_namespace(
                DescribeNamespaceRequest(namespace=self.identity.namespace), timeout=RPC_TIMEOUT), 10)
            ttl = response.config.workflow_execution_retention_ttl
            if (response.namespace_info.name != self.identity.namespace or ttl.seconds <= 3600
                    or not 0 <= ttl.nanos < 1_000_000_000):
                raise ProtocolError('RETENTION_UNVERIFIED')
            return int(ttl.seconds)  # Conservative floor; SQL persists its own clock.
        except ProtocolError:
            raise
        except Exception:
            raise TransportUnavailable() from None

    async def observe(self, binding):
        """Read describe + first history event on the SAME discovered/pinned run."""
        async def read():
            run_id = binding.get('admitted_run_id')
            handle = self.client.get_workflow_handle(binding['temporal_workflow_id'], run_id=run_id)
            description = await handle.describe(rpc_timeout=RPC_TIMEOUT)
            observed = description.run_id
            if (not canonical_uuid(observed) or (run_id is not None and run_id != observed)
                    or description.id != workflow_id(binding['job_id'])
                    or description.namespace != binding['namespace']
                    or description.workflow_type != WORKFLOW_TYPE
                    or description.task_queue != binding['task_queue']):
                raise ProtocolError('RUN_CONFLICT')
            pinned = self.client.get_workflow_handle(description.id, run_id=observed)
            iterator = pinned.fetch_history_events(page_size=1, rpc_timeout=RPC_TIMEOUT)
            event = await anext(iterator)
            if not event.HasField('workflow_execution_started_event_attributes'):
                raise ProtocolError('BINDING_CONFLICT')
            started = event.workflow_execution_started_event_attributes
            args = await self.client.data_converter.decode_wrapper(started.input)
            if (event.event_id != 1 or started.original_execution_run_id != observed
                    or started.workflow_id != binding['temporal_workflow_id']
                    or started.workflow_type.name != WORKFLOW_TYPE
                    or started.task_queue.name != binding['task_queue']
                    or args != [start_input(binding)]):
                raise ProtocolError('BINDING_CONFLICT')
            return observed
        try:
            return await asyncio.wait_for(read(), 10)
        except ProtocolError:
            raise
        except RPCError as error:
            if error.status == RPCStatusCode.NOT_FOUND:
                raise MissingHistory() from None
            raise TransportUnavailable() from None
        except Exception:
            raise TransportUnavailable() from None

    async def start(self, binding):
        try:
            await asyncio.wait_for(self.client.start_workflow(
                WORKFLOW_TYPE, start_input(binding), id=binding['temporal_workflow_id'],
                task_queue=binding['task_queue'], id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
                id_conflict_policy=WorkflowIDConflictPolicy.FAIL, retry_policy=None,
                rpc_timeout=RPC_TIMEOUT), 10)
        except WorkflowAlreadyStartedError:
            return  # Not admission: caller MUST independently verify history.
        except Exception:
            raise TransportUnavailable() from None

    async def signal(self, binding, command_id, payload_sha256):
        try:
            handle = self.client.get_workflow_handle(binding['temporal_workflow_id'],
                                                     run_id=binding['admitted_run_id'])
            await asyncio.wait_for(handle.signal('command_available',
                {'command_id': command_id, 'payload_sha256': payload_sha256}, rpc_timeout=RPC_TIMEOUT), 10)
        except Exception:
            raise TransportUnavailable() from None
