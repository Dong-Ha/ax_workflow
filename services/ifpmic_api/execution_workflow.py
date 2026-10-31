"""Activation and an explicit recorded mock task; no P01 or human outcome."""
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError

from .execution_protocol import (SHA, ProtocolError, activation_proposal, build_from_queue,
                                 canonical_uuid, validate_start, workflow_id)

ACTIVITY_RETRY = RetryPolicy(initial_interval=timedelta(seconds=1), backoff_coefficient=5,
                             maximum_interval=timedelta(seconds=30), maximum_attempts=3)


@workflow.defn(name='IFPMICJobWorkflow')
class IFPMICJobWorkflow:
    def __init__(self):
        self._phase = 'admission_wait'
        self._notifications = set()

    @workflow.query
    def phase(self) -> str:
        return self._phase

    @workflow.signal
    def command_available(self, notification: Any):
        if (type(notification) is dict and set(notification) == {'command_id', 'payload_sha256'}
                and canonical_uuid(notification['command_id'])
                and type(notification['payload_sha256']) is str
                and SHA.fullmatch(notification['payload_sha256'])):
            self._notifications.add((notification['command_id'], notification['payload_sha256']))
        # H2 never consumes human commands; H3/H4 read the durable inbox.

    @workflow.query
    def notification_count(self) -> int:
        return len(self._notifications)

    async def parked(self, phase):
        self._phase = phase
        await workflow.wait_condition(lambda: False)

    async def attempt(self, name, value):
        try:
            answer = await workflow.execute_activity(name, value,
                start_to_close_timeout=timedelta(seconds=40),
                schedule_to_close_timeout=timedelta(seconds=120), retry_policy=ACTIVITY_RETRY)
            return answer if type(answer) is dict else {'status': 'wait'}
        except ActivityError:
            # Retry the same decision/proposal, never reinterpret an uncertain
            # database commit as a rejection or a fresh create operation.
            return {'status': 'wait'}

    @workflow.run
    async def run(self, value: Any) -> dict:
        try:
            validate_start(value)
            info = workflow.info()
            build_id = build_from_queue(info.task_queue)
            if info.workflow_id != workflow_id(value['job_id']) or not canonical_uuid(info.run_id):
                raise ProtocolError()
        except ProtocolError:
            await self.parked('invalid_start')
            return {}  # Unreachable; no domain completion or alternate writer.
        request = {'job_id': value['job_id'], 'run_id': info.run_id,
                   'build_id': build_id, 'binding_sha256': value['binding_sha256']}
        while True:
            ready = await self.attempt('ifpmic.h2.read_activation', request)
            if ready.get('status') == 'quarantined':
                await self.parked('quarantined')
            if ready.get('status') == 'ready':
                break
            await workflow.sleep(1)
        try:
            proposal = activation_proposal(value['job_id'], info.run_id, build_id,
                value['binding_sha256'], ready['command_id'], ready['command_payload_sha256'])
        except (ProtocolError, KeyError):
            await self.parked('quarantined')
            return {}
        self._phase = 'projection_wait'
        while True:
            outcome = await self.attempt('ifpmic.h2.project_activation', proposal)
            if outcome.get('status') == 'applied':
                # The activity result is recorded in history. Never branch on
                # this worker process's environment during workflow replay.
                if ready.get('mock_task_mode') == 'request-preflight-v1':
                    self._phase = 'mock_running'
                    result = await self.attempt('ifpmic.mock.preflight', request)
                    if result.get('status') == 'completed':
                        await self.parked('mock_complete')
                    if result.get('status') == 'quarantined':
                        await self.parked('mock_quarantined')
                    # The SDK already bounded retries. Preserve this run for
                    # recovery instead of issuing an unbounded new activity loop.
                    await self.parked('mock_wait')
                await self.parked('queued')
            if outcome.get('status') == 'rejected':
                self._phase = 'rejected'
                return {'status': 'rejected', 'code': outcome['code']}
            if outcome.get('status') == 'quarantined':
                await self.parked('quarantined')
            await workflow.sleep(1)
