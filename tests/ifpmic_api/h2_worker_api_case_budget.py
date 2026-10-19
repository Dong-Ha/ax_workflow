"""Per-case watchdog for the H2 API/worker crash process cases.

The execution runner must explicitly load this plugin and set the private
timings directory. Each case receives 215 seconds for pytest setup/body and one
shared 25 second teardown window.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import signal
import stat
import time

import pytest

from tests.ifpmic_api.h2_fixture_cleanup import installed_controller, restore_preserving_error


BODY_SECONDS = 215
CLEANUP_SECONDS = 25
CASE_FILES = {
    "tests/ifpmic_api/test_h2_worker_api_crashes.py::"
    "test_h2_api_commit_before_response_sigkill_retry_applies_once": "api-commit-before-response.json",
    "tests/ifpmic_api/test_h2_worker_api_crashes.py::"
    "test_h2_worker_projection_before_pg_commit_sigkill_rolls_back_then_retries": "worker-before-pg-commit.json",
    "tests/ifpmic_api/test_h2_worker_api_crashes.py::"
    "test_h2_worker_projection_after_pg_commit_sigkill_replays_receipt": "worker-after-pg-commit.json",
    "tests/ifpmic_api/test_h2_worker_api_crashes.py::"
    "test_h2_activity_completed_before_workflow_decision_sigkill_replays_history": "activity-completed-before-decision.json",
}


class CaseDeadline:
    def __init__(self, nodeid: str, path: Path):
        self.nodeid = nodeid
        self.case_id = nodeid.rsplit("::", 1)[1]
        self.path = path
        self.started_at = 0.0
        self.cleanup_start = None
        self.finish = None
        self.setup_start = self.setup_finish = None
        self.call_start = self.call_finish = None
        self.teardown_start = self.teardown_finish = None
        self.events: list[dict[str, object]] = []
        self.cleanup_started = False
        self.body_timed_out = False
        self.cleanup_timed_out = False
        self._old_handler = None
        self._old_timer = (0.0, 0.0)

    def write(self, *, create=False):
        parent = self.path.parent
        info = parent.lstat()
        assert stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
        assert stat.S_IMODE(info.st_mode) == 0o700 and not parent.is_symlink()
        now = self.finish or time.monotonic()

        def elapsed(a, b):
            return None if a is None or b is None else b - a

        value = {
            "kind": "ifpmic.b03.h2.worker-api.case-timing.v1", "case_id": self.case_id,
            "nodeid": self.nodeid,
            "status": "cleanup_timeout" if self.cleanup_timed_out else
                      "body_timeout" if self.body_timed_out else
                      "finished" if self.finish is not None else "running",
            "events": self.events,
            "started_monotonic": self.started_at, "cleanup_started_monotonic": self.cleanup_start,
            "finished_monotonic": self.finish,
            "body_seconds": elapsed(self.started_at, self.cleanup_start),
            "cleanup_seconds": elapsed(self.cleanup_start, self.finish),
            "total_seconds": elapsed(self.started_at, self.finish),
            "setup_seconds": elapsed(self.setup_start, self.setup_finish),
            "call_seconds": elapsed(self.call_start, self.call_finish),
            "teardown_seconds": elapsed(self.teardown_start, self.teardown_finish),
            "body_timeout_triggered": self.body_timed_out,
            "cleanup_timeout_triggered": self.cleanup_timed_out,
        }
        raw = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("ascii") + b"\n"
        flags = os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC | (os.O_CREAT | os.O_EXCL if create else 0)
        fd = os.open(self.path, flags, 0o600)
        try:
            st = os.fstat(fd)
            assert stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and st.st_nlink == 1
            if create:
                os.fchmod(fd, 0o600)
            assert stat.S_IMODE(os.fstat(fd).st_mode) == 0o600
            if not create:
                os.ftruncate(fd, 0)
            view = memoryview(raw)
            while view:
                n = os.write(fd, view)
                if n <= 0:
                    raise OSError("short private timing write")
                view = view[n:]
            os.fsync(fd)
        finally:
            os.close(fd)

    def boundary(self, name):
        now = time.monotonic()
        assert math.isfinite(now)
        self.events.append({"event": name, "monotonic": now})
        setattr(self, {"setup_start": "setup_start", "setup_finish": "setup_finish",
                       "call_start": "call_start", "call_finish": "call_finish",
                       "teardown_start": "teardown_start", "teardown_finish": "teardown_finish"}.get(name, "_unused"), now)
        self.write()

    def start(self):
        self._old_handler = signal.getsignal(signal.SIGALRM)
        self._old_timer = signal.getitimer(signal.ITIMER_REAL)
        self.started_at = time.monotonic()
        self.deadline = self.started_at + BODY_SECONDS

        def body_timeout(_sig, _frame):
            self.body_timed_out = True
            self.begin_cleanup()
            raise TimeoutError("H2 worker/API case body deadline exceeded")

        signal.signal(signal.SIGALRM, body_timeout)
        signal.setitimer(signal.ITIMER_REAL, BODY_SECONDS)
        self.write(create=True)

    def begin_cleanup(self):
        if self.cleanup_started:
            return
        self.cleanup_started = True
        self.cleanup_start = time.monotonic()
        signal.setitimer(signal.ITIMER_REAL, 0)

        def cleanup_timeout(_sig, _frame):
            self.cleanup_timed_out = True
            raise TimeoutError("H2 worker/API cleanup deadline exceeded")

        signal.signal(signal.SIGALRM, cleanup_timeout)
        signal.setitimer(signal.ITIMER_REAL, CLEANUP_SECONDS)
        self.events.append({"event": "cleanup_start", "monotonic": self.cleanup_start})
        self.write()

    def cleanup_budget(self):
        self.begin_cleanup()

    def cleanup_remaining(self, maximum):
        self.begin_cleanup()
        left = min(float(maximum), self.cleanup_start + CLEANUP_SECONDS - time.monotonic())
        if left <= 0:
            self.cleanup_timed_out = True
            raise TimeoutError("H2 worker/API cleanup deadline exceeded")
        return left

    def remaining(self, maximum: float) -> float:
        left = min(float(maximum), self.deadline - time.monotonic())
        if left <= 0:
            raise TimeoutError("H2 worker/API case body deadline exceeded")
        return left

    def restore(self):
        self.finish = time.monotonic()
        self.events.append({"event": "case_finish", "monotonic": self.finish})
        try:
            self.write()
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            if self._old_handler is not None:
                signal.signal(signal.SIGALRM, self._old_handler)
            if self._old_timer[0] > 0:
                signal.setitimer(signal.ITIMER_REAL, *self._old_timer)


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_protocol(item, nextitem):
    if item.nodeid not in CASE_FILES:
        yield
        return
    root = os.environ.get("IFPMIC_H2_WORKER_API_TIMINGS_DIR")
    assert root is not None
    path = Path(root)
    assert path.is_absolute() and path.is_dir() and not path.is_symlink()
    info = path.lstat()
    assert stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700
    deadline = CaseDeadline(item.nodeid, path / CASE_FILES[item.nodeid])
    item._ifpmic_h2_worker_api_deadline = deadline
    with installed_controller(item.config, deadline):
        try:
            deadline.start()
            yield
        finally:
            restore_preserving_error(deadline.restore)


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_setup(item):
    if item.nodeid in CASE_FILES:
        item._ifpmic_h2_worker_api_deadline.boundary("setup_start")
    yield
    if item.nodeid in CASE_FILES:
        item._ifpmic_h2_worker_api_deadline.boundary("setup_finish")


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_call(item):
    if item.nodeid in CASE_FILES:
        item._ifpmic_h2_worker_api_deadline.boundary("call_start")
    yield
    if item.nodeid in CASE_FILES:
        item._ifpmic_h2_worker_api_deadline.boundary("call_finish")


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_teardown(item, nextitem):
    if item.nodeid in CASE_FILES:
        deadline = item._ifpmic_h2_worker_api_deadline
        deadline.begin_cleanup()
        deadline.boundary("teardown_start")
    yield
    if item.nodeid in CASE_FILES:
        item._ifpmic_h2_worker_api_deadline.boundary("teardown_finish")
