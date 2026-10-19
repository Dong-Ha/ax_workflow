"""215s body + one shared 25s teardown watchdog for H2 crash cases.

The runner must load this plugin explicitly. Its protocol hook begins before
session/function fixture setup; all collected IDs are exact and finite.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import signal
import stat
import time
from contextlib import contextmanager

import pytest

from tests.ifpmic_api.h2_fixture_cleanup import installed_controller, restore_preserving_error


CASE_NODE_IDS = frozenset({
    "tests/ifpmic_api/test_accepted_start_response_loss.py::test_actual_started_event_survives_lost_start_response_and_recovers_same_run",
    "tests/ifpmic_api/test_h2_dispatcher_crashes.py::test_claim_commit_crash_reclaims_only_after_expiry",
    "tests/ifpmic_api/test_h2_dispatcher_crashes.py::test_start_response_before_admission_crash_recovers_same_run",
    "tests/ifpmic_api/test_h2_dispatcher_crashes.py::test_admission_before_ack_crash_recovers_same_run",
    "tests/ifpmic_api/test_h2_dispatcher_crashes.py::test_ack_before_worker_activation_projects_once",
    "tests/ifpmic_api/test_h2_dispatcher_crashes.py::test_two_live_dispatchers_stale_ack_cannot_change_recovered_run",
    "tests/ifpmic_api/test_h2_dispatcher_crashes.py::test_admitted_missing_history_is_quarantined_without_replacement",
    "tests/ifpmic_api/test_h2_runtime_restart_and_history.py::test_postgres_and_temporal_restart_preserve_same_execution_and_receipt",
})
BODY_SECONDS = 215
CLEANUP_SECONDS = 25


class CrashCaseDeadline:
    def __init__(self, nodeid: str):
        self.nodeid = nodeid
        self.started = self.cleanup_at = self.finished = None
        self.body_deadline = None
        self.cleanup_deadline = None
        self.body_timeout = self.cleanup_timeout = False
        self._handler = None
        self._timer = (0.0, 0.0)
        self._path = None
        self.events = []

    def _write(self, create=False):
        if self._path is None:
            return
        parent = self._path.parent
        info = parent.lstat()
        assert stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
        assert stat.S_IMODE(info.st_mode) == 0o700 and not parent.is_symlink()
        payload = {"kind": "ifpmic.b03.h2.crash-case-timing.v1", "nodeid": self.nodeid,
                   "started_monotonic": self.started, "cleanup_started_monotonic": self.cleanup_at,
                   "finished_monotonic": self.finished,
                   "body_seconds": None if self.cleanup_at is None else self.cleanup_at - self.started,
                   "cleanup_seconds": None if self.finished is None or self.cleanup_at is None
                       else self.finished - self.cleanup_at,
                   "total_seconds": None if self.finished is None else self.finished - self.started,
                   "body_timeout_triggered": self.body_timeout,
                   "cleanup_timeout_triggered": self.cleanup_timeout,
                   "events": self.events}
        data = json.dumps(payload, ensure_ascii=True, sort_keys=True,
                          separators=(",", ":"), allow_nan=False).encode("ascii") + b"\n"
        flags = os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC
        if create:
            flags |= os.O_CREAT | os.O_EXCL
        fd = os.open(self._path, flags, 0o600)
        try:
            current = os.fstat(fd)
            assert stat.S_ISREG(current.st_mode) and current.st_uid == os.getuid()
            assert current.st_nlink == 1
            if create:
                os.fchmod(fd, 0o600)
            else:
                os.ftruncate(fd, 0)
            assert stat.S_IMODE(os.fstat(fd).st_mode) == 0o600
            view = memoryview(data)
            while view:
                size = os.write(fd, view)
                if size <= 0:
                    raise OSError("short private case timing write")
                view = view[size:]
            os.fsync(fd)
        finally:
            os.close(fd)

    def start(self):
        self._handler = signal.getsignal(signal.SIGALRM)
        self._timer = signal.getitimer(signal.ITIMER_REAL)
        self.started = time.monotonic()
        self.body_deadline = self.started + BODY_SECONDS
        raw_root = os.environ.get("IFPMIC_H2_CRASH_TIMINGS_ROOT")
        assert raw_root is not None
        root = Path(raw_root)
        info = root.lstat()
        assert root.is_absolute() and stat.S_ISDIR(info.st_mode)
        assert info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700
        assert not root.is_symlink()
        self._path = root / (hashlib.sha256(self.nodeid.encode("utf-8")).hexdigest() + ".json")

        def body_timeout(_signum, _frame):
            self.body_timeout = True
            self.begin_cleanup()
            raise TimeoutError("H2 crash case body deadline exceeded")

        signal.signal(signal.SIGALRM, body_timeout)
        signal.setitimer(signal.ITIMER_REAL, BODY_SECONDS)
        self.events.append({"event": "started", "monotonic": self.started})
        self._write(create=True)

    def begin_cleanup(self):
        if self.cleanup_at is not None:
            return
        self.cleanup_at = time.monotonic()
        self.cleanup_deadline = self.cleanup_at + CLEANUP_SECONDS
        signal.setitimer(signal.ITIMER_REAL, 0)

        def cleanup_timeout(_signum, _frame):
            self.cleanup_timeout = True
            raise TimeoutError("H2 crash cleanup deadline exceeded")

        signal.signal(signal.SIGALRM, cleanup_timeout)
        signal.setitimer(signal.ITIMER_REAL, CLEANUP_SECONDS)
        self.events.append({"event": "cleanup_started", "monotonic": self.cleanup_at})
        self._write()

    def cleanup_remaining(self, maximum):
        self.begin_cleanup()
        left = min(float(maximum), self.cleanup_deadline - time.monotonic())
        if left <= 0:
            self.cleanup_timeout = True
            raise TimeoutError("H2 crash cleanup deadline exceeded")
        return left

    def remaining(self, maximum=30):
        left = min(float(maximum), self.body_deadline - time.monotonic())
        if left <= 0:
            raise TimeoutError("H2 crash case body deadline exceeded")
        return left

    @contextmanager
    def cleanup_budget(self):
        self.begin_cleanup()
        yield

    def restore(self):
        self.finished = time.monotonic()
        self.events.append({"event": "finished", "monotonic": self.finished})
        try:
            self._write()
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            try:
                if self._handler is not None:
                    signal.signal(signal.SIGALRM, self._handler)
            finally:
                if self._timer[0] > 0:
                    signal.setitimer(signal.ITIMER_REAL, *self._timer)


@pytest.fixture
def h2_crash_case_deadline(request):
    controller = getattr(request.node, "_ifpmic_h2_crash_deadline", None)
    if controller is None:
        pytest.fail("the runner did not load the H2 crash case watchdog")
    return controller


@pytest.fixture
def accepted_start_case_deadline(request):
    controller = getattr(request.node, "_ifpmic_accepted_start_deadline", None)
    if controller is None:
        pytest.fail("the runner did not load the accepted-start whole-case watchdog")
    return controller


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_protocol(item, nextitem):
    if item.nodeid not in CASE_NODE_IDS:
        yield
        return
    deadline = CrashCaseDeadline(item.nodeid)
    item._ifpmic_h2_crash_deadline = deadline
    item._ifpmic_accepted_start_deadline = deadline
    with installed_controller(item.config, deadline):
        try:
            deadline.start()
            yield
        finally:
            restore_preserving_error(deadline.restore)


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_teardown(item, nextitem):
    if item.nodeid in CASE_NODE_IDS:
        item._ifpmic_h2_crash_deadline.begin_cleanup()
    yield
