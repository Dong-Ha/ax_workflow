"""Subprocess-only synthetic workflow used to qualify the pinned Temporal SDK.

This fixture is deliberately separate from the IFPMIC workflow implementation.
It emits only synthetic identifiers and normalized history facts to stdout;
the full history JSON is written to a private evidence file supplied by the
test harness.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import sys
from datetime import timedelta
from pathlib import Path
from typing import Any

from temporalio import workflow
from temporalio.client import Client
from temporalio.common import WorkflowIDConflictPolicy, WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.service import RPCError, RPCStatusCode
from temporalio.worker import Worker
from temporalio.api.workflowservice.v1 import DescribeNamespaceRequest


FIXTURE_MARKER = "h1-synthetic-v1"
FIXTURE_RESULT = "h1-finished-v1"
RPC_TIMEOUT = timedelta(seconds=5)
CONNECT_TIMEOUT_SECONDS = 30
RETRYABLE_RPC_CODES = {RPCStatusCode.UNAVAILABLE, RPCStatusCode.DEADLINE_EXCEEDED}


@workflow.defn(name="IFPMICH1SyntheticWait")
class IFPMICH1SyntheticWait:
    """A deterministic wait/signal fixture with no IFPMIC business effects."""

    def __init__(self) -> None:
        self._finished = False
        self._marker = ""

    @workflow.run
    async def run(self, marker: str) -> str:
        self._marker = marker
        await workflow.wait_condition(lambda: self._finished)
        return FIXTURE_RESULT

    @workflow.signal
    async def finish(self) -> None:
        self._finished = True

    @workflow.query
    def phase(self) -> str:
        return "finished" if self._finished else "waiting"


def _safe_history_summary(history: Any) -> dict[str, Any]:
    return {
        "workflow_id": history.workflow_id,
        "run_id": history.run_id,
        "events": [
            {
                "event_id": int(event.event_id),
                "event_type": event.WhichOneof("attributes"),
            }
            for event in history.events
        ],
    }


def _write_private_json(path_value: str, value: object) -> None:
    path = Path(path_value).resolve()
    data = (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(path, flags, 0o600)
    try:
        os.fchmod(fd, 0o600)
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError("short evidence write")
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)


async def _connect_ready(args: argparse.Namespace) -> tuple[Client, float]:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + CONNECT_TIMEOUT_SECONDS
    client: Client | None = None
    while loop.time() < deadline:
        try:
            if client is None:
                client = await asyncio.wait_for(
                    Client.connect(args.target),
                    timeout=min(RPC_TIMEOUT.total_seconds(), max(0.001, deadline - loop.time())),
                )
            retention = await asyncio.wait_for(
                _namespace_retention_seconds(client),
                timeout=min(RPC_TIMEOUT.total_seconds(), max(0.001, deadline - loop.time())),
            )
            return client, retention
        except RPCError as exc:
            if exc.status not in RETRYABLE_RPC_CODES:
                raise
            await asyncio.sleep(min(0.1, max(0, deadline - loop.time())))
        except (ConnectionError, OSError):
            await asyncio.sleep(min(0.1, max(0, deadline - loop.time())))
        except RuntimeError as exc:
            # The pinned SDK bridge wraps initial transport failures with this
            # exact prefix; unrelated RuntimeErrors are not startup retries.
            if not str(exc).startswith("Failed client connect:"):
                raise
            client = None
            await asyncio.sleep(min(0.1, max(0, deadline - loop.time())))
        except TimeoutError:
            await asyncio.sleep(min(0.1, max(0, deadline - loop.time())))
    raise TimeoutError("Temporal readiness deadline exceeded")


async def _worker(args: argparse.Namespace) -> None:
    client, _retention = await _connect_ready(args)
    worker = Worker(
        client,
        task_queue=args.task_queue,
        workflows=[IFPMICH1SyntheticWait],
    )
    loop = asyncio.get_running_loop()
    stop_requested = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop_requested.set)

    worker_task = asyncio.create_task(worker.run())
    stop_task = asyncio.create_task(stop_requested.wait())
    done, _ = await asyncio.wait(
        (worker_task, stop_task),
        return_when=asyncio.FIRST_COMPLETED,
    )
    if worker_task in done:
        stop_task.cancel()
        await worker_task
        return
    await worker.shutdown()
    await worker_task


async def _namespace_retention_seconds(client: Client) -> float:
    response = await client.workflow_service.describe_namespace(
        DescribeNamespaceRequest(namespace="default"),
        rpc_timeout=RPC_TIMEOUT,
    )
    ttl = response.config.workflow_execution_retention_ttl
    return float(ttl.seconds) + float(ttl.nanos) / 1_000_000_000


async def _wait_for_phase(handle: Any, expected: str, deadline_seconds: float) -> str:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + deadline_seconds
    last = ""
    while loop.time() < deadline:
        last = await handle.query("phase", rpc_timeout=RPC_TIMEOUT)
        if last == expected:
            return last
        await asyncio.sleep(0.1)
    return last


async def _history(handle: Any, path_value: str) -> dict[str, Any]:
    history = await handle.fetch_history(rpc_timeout=RPC_TIMEOUT)
    _write_private_json(path_value, history.to_json_dict())
    return _safe_history_summary(history)


def _duplicate_error_summary(error: BaseException) -> dict[str, object]:
    return {
        "type": type(error).__name__,
        "run_id": getattr(error, "run_id", None),
        "is_expected_typed_error": isinstance(error, WorkflowAlreadyStartedError),
    }


async def _phase1(args: argparse.Namespace) -> dict[str, Any]:
    client, retention = await _connect_ready(args)
    if retention <= 3600:
        raise AssertionError("Temporal namespace retention is not above one hour")
    handle = await client.start_workflow(
        IFPMICH1SyntheticWait.run,
        FIXTURE_MARKER,
        id=args.workflow_id,
        task_queue=args.task_queue,
        id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
        id_conflict_policy=WorkflowIDConflictPolicy.FAIL,
        rpc_timeout=RPC_TIMEOUT,
    )
    run_id = handle.result_run_id
    if not isinstance(run_id, str) or not run_id:
        raise AssertionError("start_workflow did not return a concrete run ID")
    handle = client.get_workflow_handle(args.workflow_id, run_id=run_id)
    phase = await _wait_for_phase(handle, "waiting", 15)
    duplicate_error: dict[str, object] | None = None
    try:
        await client.start_workflow(
            IFPMICH1SyntheticWait.run,
            FIXTURE_MARKER,
            id=args.workflow_id,
            task_queue=args.task_queue,
            id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
            id_conflict_policy=WorkflowIDConflictPolicy.FAIL,
            rpc_timeout=RPC_TIMEOUT,
        )
    except Exception as exc:
        duplicate_error = _duplicate_error_summary(exc)
    history = await _history(handle, args.history_path)
    return {
        "phase": "phase1",
        "workflow_id": args.workflow_id,
        "run_id": handle.run_id,
        "retention_seconds": retention,
        "query_phase": phase,
        "duplicate_error": duplicate_error,
        "history": history,
    }


async def _phase2(args: argparse.Namespace) -> dict[str, Any]:
    client, retention = await _connect_ready(args)
    if retention <= 3600:
        raise AssertionError("Temporal namespace retention is not above one hour after restart")
    handle = client.get_workflow_handle(args.workflow_id, run_id=args.expected_run_id)
    phase = await _wait_for_phase(handle, "waiting", 15)
    history_before = await _history(handle, args.history_before_path)
    await handle.signal("finish", rpc_timeout=RPC_TIMEOUT)
    result = await handle.result(rpc_timeout=RPC_TIMEOUT)
    history_after = await _history(handle, args.history_after_path)

    duplicate_error: dict[str, object] | None = None
    try:
        await client.start_workflow(
            IFPMICH1SyntheticWait.run,
            FIXTURE_MARKER,
            id=args.workflow_id,
            task_queue=args.task_queue,
            id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
            id_conflict_policy=WorkflowIDConflictPolicy.FAIL,
            rpc_timeout=RPC_TIMEOUT,
        )
    except Exception as exc:
        duplicate_error = _duplicate_error_summary(exc)

    executions = await _wait_for_single_execution(client, args.workflow_id, 15)
    return {
        "phase": "phase2",
        "workflow_id": args.workflow_id,
        "run_id": handle.result_run_id,
        "retention_seconds": retention,
        "query_phase_before_signal": phase,
        "history_before": history_before,
        "signal": "finish",
        "result": result,
        "history_after": history_after,
        "duplicate_error": duplicate_error,
        "executions": executions,
    }


async def _wait_for_single_execution(
    client: Client,
    workflow_id: str,
    timeout_seconds: float,
) -> list[dict[str, Any]]:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_seconds
    while loop.time() < deadline:
        remaining = deadline - loop.time()

        async def collect() -> list[dict[str, Any]]:
            current = []
            async for item in client.list_workflows(
                f'WorkflowId = "{workflow_id}"',
                limit=10,
                rpc_timeout=RPC_TIMEOUT,
            ):
                current.append(
                    {
                        "workflow_id": item.id,
                        "run_id": item.run_id,
                        "status": getattr(item.status, "name", str(item.status)),
                    }
                )
            return current

        executions = await asyncio.wait_for(
            collect(),
            timeout=min(RPC_TIMEOUT.total_seconds(), remaining),
        )
        if len(executions) > 1:
            raise AssertionError("more than one logical workflow execution is visible")
        if len(executions) == 1:
            return executions
        await asyncio.sleep(min(0.1, max(0, deadline - loop.time())))
    raise TimeoutError("expected workflow execution was not visible before deadline")


async def _probe(args: argparse.Namespace) -> dict[str, Any]:
    if args.action == "phase1":
        return await _phase1(args)
    return await _phase2(args)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    worker = subparsers.add_parser("worker")
    worker.add_argument("--target", required=True)
    worker.add_argument("--task-queue", required=True)

    probe = subparsers.add_parser("probe")
    probe.add_argument("--target", required=True)
    probe.add_argument("--task-queue", required=True)
    probe.add_argument("--workflow-id", required=True)
    probe.add_argument("--action", choices=("phase1", "phase2"), required=True)
    probe.add_argument("--history-path")
    probe.add_argument("--history-before-path")
    probe.add_argument("--history-after-path")
    probe.add_argument("--expected-run-id")
    return parser


def main() -> int:
    args = _parser().parse_args()
    try:
        if args.command == "worker":
            asyncio.run(_worker(args))
            return 0
        if args.action == "phase1" and not args.history_path:
            raise ValueError("phase1 history path is required")
        if args.action == "phase2" and not (
            args.history_before_path
            and args.history_after_path
            and args.expected_run_id
        ):
            raise ValueError("phase2 arguments are incomplete")
        result = asyncio.run(_probe(args))
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except BaseException as exc:
        # Avoid printing exception text: it may contain endpoint or local
        # configuration details. The parent test receives only a fixed class.
        print(json.dumps({"error_type": type(exc).__name__}, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    # Register the importable module class, not the __main__ module identity;
    # Temporal's default sandbox imports workflow code by module name.
    from temporal_toolchain_fixture import IFPMICH1SyntheticWait as _importable_workflow

    IFPMICH1SyntheticWait = _importable_workflow
    raise SystemExit(main())
