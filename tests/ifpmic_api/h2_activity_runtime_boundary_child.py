"""Private constructor-injected child for H2 activity/runtime boundary tests.

It validates the private config and source/environment manifests before SDK
imports or dependency-subclass injection. All SQL and Temporal calls remain
the real production calls; only the named private barrier/fault edge is injected.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import signal
import sys
import time


_BARRIER: Path | None = None
_MODE = ""


def _event(name: str, **fields) -> None:
    assert _BARRIER is not None and name.isascii() and name.replace("_", "").isalnum()
    value = {"event": name, "monotonic": time.monotonic(), **fields}
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("ascii") + b"\n"
    path = _BARRIER / (name + ".json")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        view = memoryview(raw)
        while view:
            count = os.write(fd, view)
            if count <= 0:
                raise OSError("short private activity-runtime event write")
            view = view[count:]
        os.fsync(fd)
    finally:
        os.close(fd)


def _wait_for_file(name: str, timeout: float = 190.0) -> None:
    assert _BARRIER is not None
    path = _BARRIER / name
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            info = path.lstat()
        except FileNotFoundError:
            time.sleep(0.02)
            continue
        if (not path.is_symlink() and path.is_file() and info.st_uid == os.getuid()
                and (info.st_mode & 0o777) == 0o600 and info.st_nlink == 1):
            return
        time.sleep(0.02)
    raise TimeoutError("private activity-runtime barrier deadline")


class _HungCursor:
    def __init__(self, connection, cursor):
        self.connection, self.cursor = connection, cursor

    def fetchone(self):
        value = self.cursor.fetchone()
        pid = self.connection.execute("SELECT pg_backend_pid()").fetchone()[0]
        _event("projection_driver_blocked", backend_pid=pid)
        # This is a real server-side statement in the actual uncommitted
        # project_activation transaction. The local timeout is deliberately
        # longer than execution_runtime's 15-second self-termination bound.
        self.connection.execute("SET LOCAL statement_timeout='30s'")
        self.connection.execute("SELECT pg_sleep(30)")
        return value

    def __getattr__(self, name):
        return getattr(self.cursor, name)


class _HungConnection:
    def __init__(self, connection, project_sql):
        self.connection, self.project_sql = connection, project_sql

    def __enter__(self):
        self.connection.__enter__()
        return self

    def __exit__(self, *args):
        return self.connection.__exit__(*args)

    def transaction(self):
        return self.connection.transaction()

    def execute(self, query, *args, **kwargs):
        cursor = self.connection.execute(query, *args, **kwargs)
        if _MODE == "hung-driver" and query == self.project_sql:
            return _HungCursor(self.connection, cursor)
        return cursor


def _install_store_injection(store_module) -> None:
    OriginalStore = store_module.ExecutionStore

    class TCStore(OriginalStore):
        def __init__(self, *, dsn=None, db_factory=None, fault_hook=None):
            if _MODE == "hung-driver":
                if dsn is None or db_factory is not None:
                    raise ValueError("TC_HUNG_DRIVER_CONFIG_INVALID")
                database_dsn = dsn
                project_sql = store_module.CALLS["project_activation"]

                def injected_db_factory():
                    connection = store_module.psycopg.connect(database_dsn, connect_timeout=3)
                    return _HungConnection(connection, project_sql)

                dsn = None
                db_factory = injected_db_factory

            def injected(phase: str) -> None:
                if phase == "after_project_activation_commit" and _MODE == "authority-replay":
                    _event("projection_commit_complete")
                    _wait_for_file("release-activity-result")
                if fault_hook is not None:
                    fault_hook(phase)

            super().__init__(dsn=dsn, db_factory=db_factory, fault_hook=injected)

        def call(self, operation, *args):
            if operation == "project_activation" and _MODE == "authority-before":
                _event("before_first_projection_sql")
                _wait_for_file("release-project-activation")
            return super().call(operation, *args)

    store_module.ExecutionStore = TCStore


def _install_transport_injection(temporal_module) -> None:
    OriginalTransport = temporal_module.TemporalTransport

    class TCTransport(OriginalTransport):
        async def observe(self, binding):
            try:
                return await super().observe(binding)
            except temporal_module.MissingHistory:
                _event("actual_history_not_found")
                _wait_for_file("allow_retention_rpc")
                raise

        async def retention_seconds(self):
            _event("actual_retention_rpc_begin")
            try:
                return await super().retention_seconds()
            except Exception as error:
                context = error.__context__
                _event("actual_retention_rpc_failed",
                       error_type=type(error).__qualname__,
                       context_type=None if context is None else type(context).__qualname__,
                       context_detail=None if context is None else str(context))
                raise

    temporal_module.TemporalTransport = TCTransport


def _install_worker_injection(worker_module) -> None:
    OriginalWorker = worker_module.Worker

    class TCWorker(OriginalWorker):
        async def run(self):
            _event("worker_run_entered")
            if _MODE == "normal-sigterm":
                await self._test_shutdown.wait()
                return None
            if _MODE == "runtime-concurrent-fatal":
                _event("worker_fatal_armed")
                await asyncio.to_thread(_wait_for_file, "release-worker-task")
                _event("worker_task_action", action="raise")
                os.kill(os.getpid(), signal.SIGTERM)
                _event("concurrent_sigterm_sent")
                raise RuntimeError("TC_INJECTED_WORKER_FATAL")
            _wait_task = asyncio.to_thread(_wait_for_file, "release-worker-task")
            await _wait_task
            action = (_BARRIER / "worker-action").read_text(encoding="ascii").strip()
            _event("worker_task_action", action=action)
            if action == "raise":
                raise RuntimeError("TC_INJECTED_WORKER_FATAL")
            if action == "return":
                return None
            raise RuntimeError("TC_INVALID_WORKER_ACTION")

        async def shutdown(self):
            if _MODE == "normal-sigterm":
                self._test_shutdown.set()
            return None

        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._test_shutdown = asyncio.Event()

    worker_module.Worker = TCWorker


def main(argv=None) -> int:
    global _BARRIER, _MODE
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 3:
        return 2
    config_path, mode, barrier_text = args
    if mode not in {
        "retention-rpc", "authority-replay", "runtime-return", "runtime-fatal",
        "runtime-concurrent-fatal", "normal-sigterm", "hung-driver", "authority-before",
    }:
        return 2
    barrier = Path(barrier_text)
    try:
        info = barrier.lstat()
        if (not barrier.is_absolute() or not barrier.is_dir() or barrier.is_symlink()
                or info.st_uid != os.getuid() or (info.st_mode & 0o777) != 0o700):
            raise ValueError("BARRIER_INVALID")
        _BARRIER, _MODE = barrier, mode

        # Required ordering: validate manifests, build identity and runtime
        # config before importing SDK modules or installing TC subclasses.
        from services.ifpmic_api.execution_manifest import load_config

        config, _identity = load_config(config_path)
        if mode == "retention-rpc" and config["mode"] != "dispatcher":
            raise ValueError("CONFIG_INVALID")
        if mode != "retention-rpc" and config["mode"] != "worker":
            raise ValueError("CONFIG_INVALID")

        import services.ifpmic_api.execution_dispatcher  # noqa: F401
        import services.ifpmic_api.execution_runtime as runtime_module
        import services.ifpmic_api.execution_store as store_module
        import services.ifpmic_api.execution_temporal as temporal_module

        if mode in {"authority-before", "authority-replay", "hung-driver"}:
            _install_store_injection(store_module)
        if mode == "retention-rpc":
            _install_transport_injection(temporal_module)
        if mode in {
            "runtime-return", "runtime-fatal", "runtime-concurrent-fatal", "normal-sigterm",
        }:
            import temporalio.worker as worker_module
            _install_worker_injection(worker_module)

        # Call the actual launcher entry point and actual execution_runtime.run;
        # only the explicitly named dependency constructor is substituted.
        sys.argv = [str(Path(runtime_module.__file__))]
        return runtime_module.main()
    except BaseException:
        try:
            os.write(2, b"H2_ACTIVITY_RUNTIME_CHILD_FAILED\n")
        except OSError:
            pass
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
