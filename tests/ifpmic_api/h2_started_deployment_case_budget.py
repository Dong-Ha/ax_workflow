"""Whole-case watchdog for the H2 Started-history and deployment boundaries."""
from __future__ import annotations

import json
import hashlib
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
CASE_BASE = "tests/ifpmic_api/test_h2_started_deployment_boundaries.py::test_started_history_mismatch_fails_closed"
STARTED_VARIANTS = (
    "missing_input", "extra_input", "malformed_input", "binding_digest",
    "job_id", "project_id", "workflow_type", "task_queue", "build_id",
)
CASE_NODE_IDS = tuple(f"{CASE_BASE}[{variant}]" for variant in STARTED_VARIANTS) + (
    "tests/ifpmic_api/test_h2_started_deployment_boundaries.py::test_foreign_deployment_cannot_start_old_binding",
)


class StartedDeploymentDeadline:
    def __init__(self, nodeid: str):
        self.nodeid = nodeid
        self.started = self.body_deadline = self.cleanup_at = self.finished = None
        self.cleanup_started = self.body_timeout = self.cleanup_timeout = False
        self.events = []
        self._old_handler = None
        self._old_timer = (0.0, 0.0)

    def _write(self, *, create=False):
        root = Path(os.environ["IFPMIC_H2_STARTED_DEPLOYMENT_TIMINGS_ROOT"])
        info = root.lstat()
        assert root.is_absolute() and stat.S_ISDIR(info.st_mode) and not root.is_symlink()
        assert info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700
        path = root / (hashlib.sha256(self.nodeid.encode("utf-8")).hexdigest() + ".json")
        value = {
            "kind": "ifpmic.b03.h2.started-deployment.case-timing.v1",
            "nodeid": self.nodeid,
            "status": "cleanup_timeout" if self.cleanup_timeout else "body_timeout" if self.body_timeout else "finished" if self.finished else "running",
            "started_monotonic": self.started,
            "cleanup_started_monotonic": self.cleanup_at,
            "finished_monotonic": self.finished,
            "body_seconds": None if self.cleanup_at is None else self.cleanup_at - self.started,
            "cleanup_seconds": None if self.finished is None or self.cleanup_at is None else self.finished - self.cleanup_at,
            "total_seconds": None if self.finished is None else self.finished - self.started,
            "events": self.events,
            "body_timeout_triggered": self.body_timeout,
            "cleanup_timeout_triggered": self.cleanup_timeout,
        }
        raw = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("ascii") + b"\n"
        flags = os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC | (os.O_CREAT | os.O_EXCL if create else 0)
        fd = os.open(path, flags, 0o600)
        try:
            opened = os.fstat(fd)
            assert stat.S_ISREG(opened.st_mode) and opened.st_uid == os.getuid() and opened.st_nlink == 1
            if create:
                os.fchmod(fd, 0o600)
            else:
                os.ftruncate(fd, 0)
            view = memoryview(raw)
            while view:
                size = os.write(fd, view)
                if size <= 0:
                    raise OSError("short private timing write")
                view = view[size:]
            os.fsync(fd)
        finally:
            os.close(fd)

    def start(self):
        self._old_handler = signal.getsignal(signal.SIGALRM)
        self._old_timer = signal.getitimer(signal.ITIMER_REAL)
        self.started = time.monotonic()
        self.body_deadline = self.started + BODY_SECONDS
        def body_alarm(_signum, _frame):
            self.body_timeout = True
            self.begin_cleanup()
            raise TimeoutError("H2 started/deployment body deadline exceeded")
        signal.signal(signal.SIGALRM, body_alarm)
        signal.setitimer(signal.ITIMER_REAL, BODY_SECONDS)
        self._write(create=True)

    def begin_cleanup(self):
        if self.cleanup_started:
            return
        self.cleanup_started = True
        self.cleanup_at = time.monotonic()
        signal.setitimer(signal.ITIMER_REAL, 0)
        def cleanup_alarm(_signum, _frame):
            self.cleanup_timeout = True
            raise TimeoutError("H2 started/deployment cleanup deadline exceeded")
        signal.signal(signal.SIGALRM, cleanup_alarm)
        signal.setitimer(signal.ITIMER_REAL, CLEANUP_SECONDS)
        self.events.append({"event": "cleanup_start", "monotonic": self.cleanup_at})
        self._write()

    def cleanup_remaining(self, maximum):
        self.begin_cleanup()
        left = min(float(maximum), self.cleanup_at + CLEANUP_SECONDS - time.monotonic())
        if not math.isfinite(left) or left <= 0:
            self.cleanup_timeout = True
            raise TimeoutError("H2 cleanup budget exhausted")
        return left

    def remaining(self, maximum=30):
        left = min(float(maximum), self.body_deadline - time.monotonic())
        if left <= 0:
            raise TimeoutError("H2 started/deployment body deadline exceeded")
        return left

    def restore(self):
        try:
            self.finished = time.monotonic()
            self.events.append({"event": "protocol_finish", "monotonic": self.finished})
            self._write()
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            if self._old_handler is not None:
                signal.signal(signal.SIGALRM, self._old_handler)
            if self._old_timer[0] > 0:
                signal.setitimer(signal.ITIMER_REAL, *self._old_timer)


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_protocol(item, nextitem):
    if item.nodeid not in CASE_NODE_IDS:
        yield
        return
    deadline = StartedDeploymentDeadline(item.nodeid)
    item._ifpmic_h2_started_deployment_deadline = deadline
    with installed_controller(item.config, deadline):
        try:
            deadline.start()
            yield
        finally:
            restore_preserving_error(deadline.restore)


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_teardown(item, nextitem):
    if item.nodeid in CASE_NODE_IDS:
        item._ifpmic_h2_started_deployment_deadline.begin_cleanup()
    yield
