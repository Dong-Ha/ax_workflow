"""Whole-case deadlines for the initial H2 transport-boundary cases."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import time

import pytest

from tests.ifpmic_api.h2_fixture_cleanup import installed_controller, restore_preserving_error

CASE_NODE_IDS = frozenset({
    "tests/ifpmic_api/test_h2_transport_boundaries.py::test_h2_machine_authority_disable_serializes_with_claim[disable-before-claim]",
    "tests/ifpmic_api/test_h2_transport_boundaries.py::test_h2_machine_authority_disable_serializes_with_claim[claim-before-disable]",
    "tests/ifpmic_api/test_h2_transport_boundaries.py::test_h2_activity_waits_until_admission_same_run",
})

CASE_BUDGETS = {nodeid: (215, 25) for nodeid in CASE_NODE_IDS}


class TransportCaseDeadline:
    def __init__(self, nodeid: str):
        self.nodeid = nodeid
        self.body_seconds, self.cleanup_seconds = CASE_BUDGETS[nodeid]
        self.started = self.cleanup_at = self.finished = None
        self.body_deadline = None
        self.body_timeout = self.cleanup_timeout = False
        self.handler = None
        self.timer = (0.0, 0.0)
        self.path = None

    def _write(self, create=False):
        if self.path is None:
            return
        parent = self.path.parent
        info = parent.lstat()
        assert stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
        assert stat.S_IMODE(info.st_mode) == 0o700 and not parent.is_symlink()
        value = {
            "kind": "ifpmic.b03.h2.transport-case-timing.v1", "nodeid": self.nodeid,
            "started_monotonic": self.started, "cleanup_started_monotonic": self.cleanup_at,
            "finished_monotonic": self.finished,
            "body_seconds": None if self.cleanup_at is None else self.cleanup_at - self.started,
            "cleanup_seconds": None if self.finished is None or self.cleanup_at is None else self.finished - self.cleanup_at,
            "body_budget_seconds": self.body_seconds, "cleanup_budget_seconds": self.cleanup_seconds,
            "body_timeout_triggered": self.body_timeout, "cleanup_timeout_triggered": self.cleanup_timeout,
        }
        raw = json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("ascii") + b"\n"
        flags = os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC | (os.O_CREAT | os.O_EXCL if create else 0)
        fd = os.open(self.path, flags, 0o600)
        try:
            current = os.fstat(fd)
            assert stat.S_ISREG(current.st_mode) and current.st_uid == os.getuid() and current.st_nlink == 1
            if create:
                os.fchmod(fd, 0o600)
            else:
                os.ftruncate(fd, 0)
            assert stat.S_IMODE(os.fstat(fd).st_mode) == 0o600
            view = memoryview(raw)
            while view:
                count = os.write(fd, view)
                if count <= 0:
                    raise OSError("short transport timing write")
                view = view[count:]
            os.fsync(fd)
        finally:
            os.close(fd)

    def start(self):
        self.handler = signal.getsignal(signal.SIGALRM)
        self.timer = signal.getitimer(signal.ITIMER_REAL)
        self.started = time.monotonic()
        self.body_deadline = self.started + self.body_seconds
        root = Path(os.environ["IFPMIC_H2_TRANSPORT_TIMINGS_ROOT"])
        assert root.is_absolute() and root.is_dir() and not root.is_symlink()
        assert stat.S_IMODE(root.stat().st_mode) == 0o700 and root.stat().st_uid == os.getuid()
        self.path = root / (hashlib.sha256(self.nodeid.encode("utf-8")).hexdigest() + ".json")
        def timeout(_signum, _frame):
            self.body_timeout = True
            self.begin_cleanup()
            raise TimeoutError("H2 transport body/setup deadline exceeded")
        signal.signal(signal.SIGALRM, timeout)
        signal.setitimer(signal.ITIMER_REAL, self.body_seconds)
        self._write(create=True)

    def begin_cleanup(self):
        if self.cleanup_at is not None:
            return
        self.cleanup_at = time.monotonic()
        signal.setitimer(signal.ITIMER_REAL, 0)
        def timeout(_signum, _frame):
            self.cleanup_timeout = True
            raise TimeoutError("H2 transport cleanup deadline exceeded")
        signal.signal(signal.SIGALRM, timeout)
        signal.setitimer(signal.ITIMER_REAL, self.cleanup_seconds)
        self._write()

    def cleanup_remaining(self, maximum=30):
        """Begin once and return positive time left in the shared cleanup epoch."""
        self.begin_cleanup()
        left = min(float(maximum), self.cleanup_at + self.cleanup_seconds - time.monotonic())
        if left <= 0:
            raise TimeoutError("H2 transport cleanup deadline exceeded")
        return left

    def remaining(self, maximum=30):
        left = min(float(maximum), self.body_deadline - time.monotonic())
        if left <= 0:
            raise TimeoutError("H2 transport body/setup deadline exceeded")
        return left

    def restore(self):
        self.finished = time.monotonic()
        try:
            self._write()
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            if self.handler is not None:
                signal.signal(signal.SIGALRM, self.handler)
            if self.timer[0] > 0:
                signal.setitimer(signal.ITIMER_REAL, *self.timer)


@pytest.fixture
def h2_transport_case_deadline(request):
    deadline = getattr(request.node, "_ifpmic_h2_transport_deadline", None)
    if deadline is None:
        pytest.fail("runner did not load H2 transport case watchdog")
    return deadline


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_protocol(item, nextitem):
    if item.nodeid not in CASE_NODE_IDS:
        yield
        return
    deadline = TransportCaseDeadline(item.nodeid)
    item._ifpmic_h2_transport_deadline = deadline
    with installed_controller(item.config, deadline):
        try:
            deadline.start()
            yield
        finally:
            restore_preserving_error(deadline.restore)


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_teardown(item, nextitem):
    if item.nodeid in CASE_NODE_IDS:
        item._ifpmic_h2_transport_deadline.begin_cleanup()
    yield
