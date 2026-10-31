"""Pure activity/workflow boundary tests for the opt-in mock preflight."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from temporalio.exceptions import ApplicationError

from services.ifpmic_api.execution_activities import ActivationActivities
from services.ifpmic_api.execution_mock_task import MockTaskActivities
from services.ifpmic_api.execution_protocol import workflow_id
from services.ifpmic_api.execution_workflow import IFPMICJobWorkflow
from services.ifpmic_api.mock_task import TASK_KIND
from services.ifpmic_api.workspace_fs import WorkspaceError


JOB = "123e4567-e89b-42d3-a456-426614174000"
COMMAND = "223e4567-e89b-42d3-a456-426614174000"
RUN = "323e4567-e89b-42d3-a456-426614174000"
WORKSPACE = "423e4567-e89b-42d3-a456-426614174000"
BUILD = "a" * 64
BINDING = "b" * 64


def task_input():
    return {
        "job_id": JOB, "command_id": COMMAND, "admitted_run_id": RUN,
        "build_id": BUILD, "change_type": "BUGFIX", "base_ref_present": True,
        "request_saved": True, "workspace_ready": True, "engine_admitted": True,
    }


def request():
    return {"job_id": JOB, "run_id": RUN, "build_id": BUILD, "binding_sha256": BINDING}


class FakeStore:
    def __init__(self, answer=None, *, error=None, record=None):
        self.answer, self.error, self.record = answer, error, record
        self.calls = []

    def call(self, name, *args):
        self.calls.append((name, args))
        if self.error is not None:
            raise self.error
        if name == "read_mock_task_input":
            return self.answer
        if name == "record_mock_task_result":
            return self.record if self.record is not None else {"status": "completed"}
        raise AssertionError(name)


class FakeWorkspace:
    def __init__(self, error=None):
        self.error = error
        self.calls = []

    def validate_ready(self, job_id, token):
        self.calls.append((job_id, token))
        if self.error is not None:
            raise self.error


def ready_answer(value=None):
    return {"status": "ready", "workspace_token": WORKSPACE,
            "input": task_input() if value is None else value}


def test_activation_marker_is_opt_in_and_only_added_to_ready_result():
    class ActivationStore:
        def call(self, name, *_args):
            assert name == "read_activation"
            return {"status": "ready", "workspace_token": WORKSPACE,
                    "binding_sha256": BINDING, "command_id": COMMAND,
                    "command_payload_sha256": "c" * 64}

    identity = SimpleNamespace(build_id=BUILD)
    workspace = FakeWorkspace()
    default = ActivationActivities(ActivationStore(), identity, workspace)
    opted_in = ActivationActivities(ActivationStore(), identity, workspace, mock_task_mode=TASK_KIND)
    assert "mock_task_mode" not in default.read_activation(request())
    assert opted_in.read_activation(request())["mock_task_mode"] == TASK_KIND


def test_mock_activity_off_or_bad_request_never_touches_store_or_workspace():
    store, workspace = FakeStore(ready_answer()), FakeWorkspace()
    assert MockTaskActivities(store, SimpleNamespace(build_id=BUILD), workspace).run(request()) == {
        "status": "quarantined"}
    enabled = MockTaskActivities(store, SimpleNamespace(build_id=BUILD), workspace, mode=TASK_KIND)
    bad = request() | {"run_id": "not-a-uuid"}
    assert enabled.run(bad) == {"status": "quarantined"}
    assert store.calls == []
    assert workspace.calls == []


@pytest.mark.parametrize("changes", [
    {"job_id": "not-a-uuid"}, {"build_id": "d" * 64}, {"binding_sha256": "short"},
])
def test_mock_activity_rejects_each_invalid_request_identity_without_store(changes):
    store, workspace = FakeStore(ready_answer()), FakeWorkspace()
    activity = MockTaskActivities(store, SimpleNamespace(build_id=BUILD), workspace, mode=TASK_KIND)
    assert activity.run(request() | changes) == {"status": "quarantined"}
    assert store.calls == []
    assert workspace.calls == []


def test_mock_activity_returns_only_fixed_status_and_records_safe_result():
    store, workspace = FakeStore(ready_answer()), FakeWorkspace()
    activity = MockTaskActivities(store, SimpleNamespace(build_id=BUILD), workspace, mode=TASK_KIND)

    result = activity.run(request())

    assert result == {"status": "completed"}
    assert workspace.calls == [(JOB, WORKSPACE)]
    assert [call[0] for call in store.calls] == ["read_mock_task_input", "record_mock_task_result"]
    recorded = store.calls[1][1]
    assert recorded[:4] == (JOB, RUN, BUILD, BINDING)
    assert recorded[4].obj["outcome"] == "passed"
    assert "command_id" not in str(recorded[4].obj)


def test_committed_replay_skips_workspace_and_evaluation():
    store, workspace = FakeStore({"status": "completed"}), FakeWorkspace()
    activity = MockTaskActivities(store, SimpleNamespace(build_id=BUILD), workspace, mode=TASK_KIND)

    assert activity.run(request()) == {"status": "completed"}
    assert [call[0] for call in store.calls] == ["read_mock_task_input"]
    assert workspace.calls == []


def test_uncertain_commit_retry_reuses_same_recorded_effect(monkeypatch):
    from services.ifpmic_api import execution_mock_task as module

    class CommitThenLoseResponse(FakeStore):
        committed = False

        def call(self, name, *args):
            if name == "read_mock_task_input" and self.committed:
                self.calls.append((name, args))
                return {"status": "completed"}
            if name == "record_mock_task_result":
                self.calls.append((name, args))
                self.committed = True
                raise RuntimeError("simulated lost commit response")
            return super().call(name, *args)

    evaluations = []
    evaluator = module.evaluate_preflight

    def counted(value):
        evaluations.append(value)
        return evaluator(value)

    monkeypatch.setattr(module, "evaluate_preflight", counted)
    store, workspace = CommitThenLoseResponse(ready_answer()), FakeWorkspace()
    activity = MockTaskActivities(store, SimpleNamespace(build_id=BUILD), workspace, mode=TASK_KIND)

    with pytest.raises(ApplicationError):
        activity.run(request())
    assert activity.run(request()) == {"status": "completed"}
    assert len(evaluations) == 1
    assert [name for name, _args in store.calls].count("record_mock_task_result") == 1
    assert [name for name, _args in store.calls].count("read_mock_task_input") == 2


@pytest.mark.parametrize("mutation", [
    lambda value: value.update(job_id=COMMAND),
    lambda value: value.update(admitted_run_id=COMMAND),
    lambda value: value.update(build_id="d" * 64),
    lambda value: value.update(command_id="bad-command"),
    lambda value: value.update(private_payload="secret"),
])
def test_wrong_identity_or_private_input_quarantines_without_result(mutation):
    value = task_input()
    mutation(value)
    store, workspace = FakeStore(ready_answer(value)), FakeWorkspace()
    activity = MockTaskActivities(store, SimpleNamespace(build_id=BUILD), workspace, mode=TASK_KIND)

    assert activity.run(request()) == {"status": "quarantined"}
    assert not any(name == "record_mock_task_result" for name, _args in store.calls)


def test_non_uuid_workspace_identity_is_quarantined_before_filesystem_check():
    answer = ready_answer()
    answer["workspace_token"] = "not-a-uuid"
    store, workspace = FakeStore(answer), FakeWorkspace()
    activity = MockTaskActivities(store, SimpleNamespace(build_id=BUILD), workspace, mode=TASK_KIND)
    assert activity.run(request()) == {"status": "quarantined"}
    assert workspace.calls == []
    assert not any(name == "record_mock_task_result" for name, _args in store.calls)


def test_unsafe_workspace_quarantines_and_uncertain_store_error_is_fixed_retryable():
    unsafe = FakeWorkspace(WorkspaceError("WORKSPACE_UNSAFE"))
    store = FakeStore(ready_answer())
    activity = MockTaskActivities(store, SimpleNamespace(build_id=BUILD), unsafe, mode=TASK_KIND)
    assert activity.run(request()) == {"status": "quarantined"}
    assert not any(name == "record_mock_task_result" for name, _args in store.calls)

    secret_error = RuntimeError("private DSN and SQL statement")
    failed = MockTaskActivities(FakeStore(error=secret_error), SimpleNamespace(build_id=BUILD),
                                FakeWorkspace(), mode=TASK_KIND)
    with pytest.raises(ApplicationError) as raised:
        failed.run(request())
    assert raised.value.type == "MockTaskUnavailable"
    assert "DEPENDENCY_UNAVAILABLE" in str(raised.value)
    assert "private DSN" not in repr(raised.value)


class Parked(Exception):
    pass


def _run_workflow(monkeypatch, marker, mock_answer=None):
    from services.ifpmic_api import execution_workflow as module

    calls = []
    monkeypatch.setattr(module.workflow, "info", lambda: SimpleNamespace(
        workflow_id=workflow_id(JOB), run_id=RUN, task_queue="ifpmic.build." + BUILD))

    async def execute(name, value, **_kwargs):
        calls.append(name)
        if name == "ifpmic.h2.read_activation":
            return {"status": "ready", "command_id": COMMAND,
                    "command_payload_sha256": "c" * 64, **marker}
        if name == "ifpmic.h2.project_activation":
            return {"status": "applied"}
        return mock_answer or {"status": "completed"}

    async def wait_condition(_predicate):
        raise Parked

    async def sleep(_seconds):
        raise AssertionError("unexpected workflow polling")

    monkeypatch.setattr(module.workflow, "execute_activity", execute)
    monkeypatch.setattr(module.workflow, "wait_condition", wait_condition)
    monkeypatch.setattr(module.workflow, "sleep", sleep)
    workflow = IFPMICJobWorkflow()
    with pytest.raises(Parked):
        asyncio.run(workflow.run({"protocol_version": "h2-v1", "job_id": JOB,
                                  "project_id": "project", "binding_sha256": BINDING}))
    return calls, workflow._phase


def test_workflow_without_recorded_marker_parks_queued_without_mock_activity(monkeypatch):
    calls, phase = _run_workflow(monkeypatch, {})
    assert calls == ["ifpmic.h2.read_activation", "ifpmic.h2.project_activation"]
    assert phase == "queued"


def test_workflow_uses_recorded_marker_for_one_mock_attempt_and_parks(monkeypatch):
    calls, phase = _run_workflow(monkeypatch, {"mock_task_mode": TASK_KIND})
    assert calls == ["ifpmic.h2.read_activation", "ifpmic.h2.project_activation",
                     "ifpmic.mock.preflight"]
    assert phase == "mock_complete"


def test_workflow_parks_after_bounded_mock_retry_exhaustion(monkeypatch):
    calls, phase = _run_workflow(monkeypatch, {"mock_task_mode": TASK_KIND}, {"status": "wait"})
    assert calls == ["ifpmic.h2.read_activation", "ifpmic.h2.project_activation",
                     "ifpmic.mock.preflight"]
    assert phase == "mock_wait"
