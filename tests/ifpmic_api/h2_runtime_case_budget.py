"""Hard per-case watchdog covering H2 runtime fixture setup through teardown.

The runner explicitly loads this plugin for the persistent runtime phase. The
test body receives the same controller through ``request.node`` and can start
the shared cleanup window while reaping its owned child processes.
"""
from __future__ import annotations

import signal
import time
from contextlib import contextmanager
import json
import math
import os
from pathlib import Path
import stat

import pytest


CASE_NODE_ID = (
    "tests/ifpmic_api/test_h2_runtime_normal_flow.py::"
    "test_h2_runtime_real_cli_create_ready_admits_one_run_and_queues_one_receipt"
)
BODY_SECONDS = 215
CLEANUP_SECONDS = 25


class RuntimeCaseDeadline:
    def __init__(self) -> None:
        self.body_deadline = 0.0
        self.cleanup_started = False
        self.body_timeout_triggered = False
        self.cleanup_timeout_triggered = False
        self._prior_handler = None
        self._prior_timer = (0.0, 0.0)
        self.started_monotonic = 0.0
        self.cleanup_started_monotonic = None
        self.finished_monotonic = None
        self.events = []
        self.setup_started_monotonic = None
        self.setup_finished_monotonic = None
        self.call_started_monotonic = None
        self.call_finished_monotonic = None
        self.teardown_started_monotonic = None
        self.teardown_finished_monotonic = None
        self._timings_path = None

    def _snapshot(self) -> dict[str, object]:
        now = self.finished_monotonic or time.monotonic()
        cleanup_start = self.cleanup_started_monotonic

        def elapsed(start, finish):
            return None if start is None or finish is None else finish - start

        return {
            "kind": "ifpmic.b03.h2.runtime.case-timing.v1",
            "case_id": "tests.ifpmic_api.test_h2_runtime_normal_flow.test_h2_runtime_real_cli_create_ready_admits_one_run_and_queues_one_receipt",
            "nodeid": CASE_NODE_ID,
            "status": ("cleanup_timeout" if self.cleanup_timeout_triggered else
                       "body_timeout" if self.body_timeout_triggered else
                       "finished" if self.finished_monotonic is not None else "running"),
            "events": self.events,
            "started_monotonic": self.started_monotonic,
            "cleanup_started_monotonic": cleanup_start,
            "finished_monotonic": self.finished_monotonic,
            "body_seconds": elapsed(self.started_monotonic, cleanup_start),
            "cleanup_seconds": elapsed(cleanup_start, self.finished_monotonic),
            "total_seconds": elapsed(self.started_monotonic, self.finished_monotonic),
            "setup_seconds": elapsed(self.setup_started_monotonic, self.setup_finished_monotonic),
            "call_seconds": elapsed(self.call_started_monotonic, self.call_finished_monotonic),
            "teardown_seconds": elapsed(self.teardown_started_monotonic, self.teardown_finished_monotonic),
            "body_timeout_triggered": self.body_timeout_triggered,
            "cleanup_timeout_triggered": self.cleanup_timeout_triggered,
        }

    def _write_timing(self, *, create: bool = False) -> None:
        if self._timings_path is None:
            return
        parent_info = self._timings_path.parent.lstat()
        assert stat.S_ISDIR(parent_info.st_mode) and parent_info.st_uid == os.getuid()
        assert stat.S_IMODE(parent_info.st_mode) == 0o700
        assert not self._timings_path.parent.is_symlink()
        raw = json.dumps(self._snapshot(), ensure_ascii=True, sort_keys=True,
                         separators=(",", ":"), allow_nan=False).encode("ascii") + b"\n"
        if create:
            fd = os.open(self._timings_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                         os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        else:
            fd = os.open(self._timings_path, os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            info = os.fstat(fd)
            assert stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
            assert info.st_nlink == 1
            if create:
                os.fchmod(fd, 0o600)
            assert stat.S_IMODE(os.fstat(fd).st_mode) == 0o600
            if not create:
                os.ftruncate(fd, 0)
            view = memoryview(raw)
            while view:
                count = os.write(fd, view)
                if count <= 0:
                    raise OSError("short timing evidence write")
                view = view[count:]
            os.fsync(fd)
        finally:
            os.close(fd)

    def record_boundary(self, event: str) -> None:
        now = time.monotonic()
        assert math.isfinite(now)
        self.events.append({"event": event, "monotonic": now})
        if event == "setup_start":
            self.setup_started_monotonic = now
        elif event == "setup_finish":
            self.setup_finished_monotonic = now
        elif event == "call_start":
            self.call_started_monotonic = now
        elif event == "call_finish":
            self.call_finished_monotonic = now
        elif event == "teardown_start":
            self.teardown_started_monotonic = now
        elif event == "teardown_finish":
            self.teardown_finished_monotonic = now
        self._write_timing()

    def start(self) -> None:
        self._prior_handler = signal.getsignal(signal.SIGALRM)
        self._prior_timer = signal.getitimer(signal.ITIMER_REAL)
        self.started_monotonic = time.monotonic()
        self.body_deadline = self.started_monotonic + BODY_SECONDS
        self._timings_path_value = os.environ.get("IFPMIC_H2_RUNTIME_TIMINGS_PATH")
        assert self._timings_path_value is not None
        self._timings_path = Path(self._timings_path_value)
        assert self._timings_path.is_absolute() and self._timings_path.name == "case-timings.json"

        def timeout(_signum, _frame):
            self.body_timeout_triggered = True
            self.begin_cleanup()
            raise TimeoutError("H2 runtime case body deadline exceeded")

        signal.signal(signal.SIGALRM, timeout)
        signal.setitimer(signal.ITIMER_REAL, BODY_SECONDS)
        self._write_timing(create=True)

    def begin_cleanup(self) -> None:
        """Start one cleanup window shared by owned processes and fixtures."""
        if self.cleanup_started:
            return
        self.cleanup_started = True
        self.cleanup_started_monotonic = time.monotonic()
        signal.setitimer(signal.ITIMER_REAL, 0)

        def timeout(_signum, _frame):
            self.cleanup_timeout_triggered = True
            raise TimeoutError("H2 runtime cleanup deadline exceeded")

        signal.signal(signal.SIGALRM, timeout)
        signal.setitimer(signal.ITIMER_REAL, CLEANUP_SECONDS)
        self.events.append({"event": "cleanup_start", "monotonic": self.cleanup_started_monotonic})
        self._write_timing()

    def remaining(self, maximum: float) -> float:
        left = min(float(maximum), self.body_deadline - time.monotonic())
        if left <= 0:
            raise TimeoutError("H2 runtime case body deadline exceeded")
        return left

    @contextmanager
    def cleanup_budget(self):
        self.begin_cleanup()
        # Keep the signal timer active across all pytest fixture teardowns.
        yield

    def restore(self) -> None:
        self.finished_monotonic = time.monotonic()
        self.events.append({"event": "case_finish", "monotonic": self.finished_monotonic})
        try:
            self._write_timing()
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            try:
                if self._prior_handler is not None:
                    signal.signal(signal.SIGALRM, self._prior_handler)
            finally:
                if self._prior_timer[0] > 0:
                    signal.setitimer(signal.ITIMER_REAL, *self._prior_timer)


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_protocol(item, nextitem):
    if item.nodeid != CASE_NODE_ID:
        yield
        return
    deadline = RuntimeCaseDeadline()
    item._ifpmic_h2_runtime_deadline = deadline
    try:
        deadline.start()
        yield
    finally:
        deadline.restore()


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_setup(item):
    if item.nodeid == CASE_NODE_ID:
        item._ifpmic_h2_runtime_deadline.record_boundary("setup_start")
    yield
    if item.nodeid == CASE_NODE_ID:
        item._ifpmic_h2_runtime_deadline.record_boundary("setup_finish")


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_call(item):
    if item.nodeid == CASE_NODE_ID:
        item._ifpmic_h2_runtime_deadline.record_boundary("call_start")
    yield
    if item.nodeid == CASE_NODE_ID:
        item._ifpmic_h2_runtime_deadline.record_boundary("call_finish")


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_teardown(item, nextitem):
    if item.nodeid == CASE_NODE_ID:
        item._ifpmic_h2_runtime_deadline.begin_cleanup()
        item._ifpmic_h2_runtime_deadline.record_boundary("teardown_start")
    yield
    if item.nodeid == CASE_NODE_ID:
        item._ifpmic_h2_runtime_deadline.record_boundary("teardown_finish")
