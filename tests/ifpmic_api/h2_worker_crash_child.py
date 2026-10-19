"""Test-only real Temporal worker with a private process barrier.

This module is launched only by H2 integration tests. The product launcher has
no environment or HTTP fault switch; the activity store receives its hook via
the documented constructor seam.
"""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import stat
import sys
import time


ALLOWED_PHASES = {
    "before_project_activation_commit", "after_project_activation_commit",
}


def _private_event(path: Path, value: dict[str, object]) -> None:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("ascii") + b"\n"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        view = memoryview(raw)
        while view:
            count = os.write(fd, view)
            if count <= 0:
                raise OSError("short private child event write")
            view = view[count:]
        os.fsync(fd)
    finally:
        os.close(fd)


def _wait_for_release(barrier: Path, phase: str) -> None:
    _private_event(barrier / "reached.json", {"phase": phase, "monotonic": time.monotonic()})
    release = barrier / "release"
    while not release.exists():
        time.sleep(0.02)


async def _run(config_path: str, phase: str, barrier_path: str) -> None:
    from services.ifpmic_api.execution_manifest import load_config

    # Validate source/environment/identity and private configuration before
    # importing any Temporal SDK module into this process.
    config, identity = load_config(config_path)

    from temporalio.worker import Worker

    from services.ifpmic_api.execution_activities import ActivationActivities
    from services.ifpmic_api.execution_identity import ExecutionIdentity
    from services.ifpmic_api.execution_store import ExecutionStore
    from services.ifpmic_api.execution_temporal import TemporalTransport
    from services.ifpmic_api.execution_workflow import IFPMICJobWorkflow
    from services.ifpmic_api.execution_workspace import ReadyWorkspace

    if config["mode"] != "worker" or not isinstance(identity, ExecutionIdentity):
        raise ValueError("CONFIG_INVALID")
    barrier = Path(barrier_path)
    info = barrier.lstat()
    if (not barrier.is_absolute() or not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700):
        raise ValueError("BARRIER_INVALID")

    def hook(name: str) -> None:
        if name == phase:
            _wait_for_release(barrier, phase)

    store = ExecutionStore(dsn=config["dsn"], fault_hook=hook)
    identity.check_projector(await asyncio.to_thread(store.call, "read_registered_build", identity.build_id))
    workspace = ReadyWorkspace(config["workspace_root"])
    await asyncio.to_thread(workspace.check_root)
    transport = await TemporalTransport.connect(identity)
    activities = ActivationActivities(store, identity, workspace)
    executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="ifpmic-h2-crash-activity")
    worker = Worker(transport.client, task_queue=identity.task_queue,
                    workflows=[IFPMICJobWorkflow],
                    activities=[activities.read_activation, activities.project_activation],
                    activity_executor=executor, max_concurrent_activities=4,
                    max_concurrent_workflow_tasks=4, build_id=identity.build_id,
                    identity="ifpmic-h2-tc-crash", use_worker_versioning=False)
    _private_event(barrier / "ready.json", {"status": "ready", "monotonic": time.monotonic()})
    await worker.run()


def main() -> int:
    if len(sys.argv) != 4 or sys.argv[2] not in ALLOWED_PHASES:
        return 2
    try:
        asyncio.run(_run(sys.argv[1], sys.argv[2], sys.argv[3]))
        return 0
    except BaseException:
        # Keep the child process channel free of raw SDK, SQL, or path details.
        try:
            os.write(2, b"H2_WORKER_CHILD_FAILED\n")
        except OSError:
            pass
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
