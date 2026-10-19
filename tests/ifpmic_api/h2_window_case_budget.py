"""Per-case watchdogs for NEG-WINDOW (30s SQL cases; 215s+25s runtime cases)."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import time

import pytest


BODY_SECONDS = 215
CLEANUP_SECONDS = 25
CASE_BUDGETS = {
    "tests/ifpmic_api/test_h2_reconciliation_window.py::test_h2_window_retention[retention-null]": (25, 5),
    "tests/ifpmic_api/test_h2_reconciliation_window.py::test_h2_window_retention[retention-3600]": (25, 5),
    "tests/ifpmic_api/test_h2_reconciliation_window.py::test_h2_window_retention[retention-3601]": (25, 5),
    "tests/ifpmic_api/test_h2_reconciliation_window.py::test_h2_window_partial_shape_constraint": (25, 5),
    "tests/ifpmic_api/test_h2_reconciliation_window.py::test_h2_window_exact_deadline_with_isolated_clock_seam[before-deadline]": (25, 5),
    "tests/ifpmic_api/test_h2_reconciliation_window.py::test_h2_window_exact_deadline_with_isolated_clock_seam[at-deadline]": (25, 5),
    "tests/ifpmic_api/test_h2_reconciliation_window.py::test_h2_window_exact_deadline_with_isolated_clock_seam[after-deadline]": (25, 5),
    "tests/ifpmic_api/test_h2_reconciliation_window.py::test_h2_window_actual_dispatcher_boundary[actual-before-deadline]": (215, 25),
    "tests/ifpmic_api/test_h2_reconciliation_window.py::test_h2_window_actual_dispatcher_boundary[actual-after-deadline]": (215, 25),
}
CASE_NODE_IDS = frozenset(CASE_BUDGETS)


class WindowCaseDeadline:
    def __init__(self, nodeid: str):
        self.nodeid = nodeid
        self.body_seconds, self.cleanup_seconds = CASE_BUDGETS[nodeid]
        self.started = self.cleanup_at = self.finished = None
        self.body_deadline = None
        self.body_timeout = self.cleanup_timeout = False
        self._handler = None
        self._timer = (0.0, 0.0)
        self._path = None

    def _write(self, *, create=False):
        if self._path is None:
            return
        parent = self._path.parent
        info = parent.lstat()
        assert stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
        assert stat.S_IMODE(info.st_mode) == 0o700 and not parent.is_symlink()
        value = {
            "kind": "ifpmic.b03.h2.neg-window-case-timing.v1",
            "nodeid": self.nodeid,
            "started_monotonic": self.started,
            "cleanup_started_monotonic": self.cleanup_at,
            "finished_monotonic": self.finished,
            "body_seconds": None if self.cleanup_at is None else self.cleanup_at - self.started,
            "cleanup_seconds": None if self.finished is None or self.cleanup_at is None
                else self.finished - self.cleanup_at,
            "body_timeout_triggered": self.body_timeout,
            "cleanup_timeout_triggered": self.cleanup_timeout,
            "body_budget_seconds": self.body_seconds,
            "cleanup_budget_seconds": self.cleanup_seconds,
        }
        raw = json.dumps(value, ensure_ascii=True, sort_keys=True,
                         separators=(",", ":"), allow_nan=False).encode("ascii") + b"\n"
        flags = os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC
        if create:
            flags |= os.O_CREAT | os.O_EXCL
        descriptor = os.open(self._path, flags, 0o600)
        try:
            current = os.fstat(descriptor)
            assert stat.S_ISREG(current.st_mode) and current.st_uid == os.getuid()
            assert current.st_nlink == 1
            if create:
                os.fchmod(descriptor, 0o600)
            else:
                os.ftruncate(descriptor, 0)
            assert stat.S_IMODE(os.fstat(descriptor).st_mode) == 0o600
            view = memoryview(raw)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    raise OSError("short private NEG-WINDOW timing write")
                view = view[written:]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def start(self):
        self._handler = signal.getsignal(signal.SIGALRM)
        self._timer = signal.getitimer(signal.ITIMER_REAL)
        self.started = time.monotonic()
        self.body_deadline = self.started + self.body_seconds
        raw_root = os.environ.get("IFPMIC_H2_WINDOW_TIMINGS_ROOT")
        assert raw_root is not None
        root = Path(raw_root)
        assert root.is_absolute() and root.is_dir() and not root.is_symlink()
        assert stat.S_IMODE(root.stat().st_mode) == 0o700 and root.stat().st_uid == os.getuid()
        case_key = hashlib.sha256(self.nodeid.encode("utf-8")).hexdigest()
        self._path = root / (case_key + ".json")

        def body_timeout(_signum, _frame):
            self.body_timeout = True
            self.begin_cleanup()
            raise TimeoutError("NEG-WINDOW body/setup deadline exceeded")

        signal.signal(signal.SIGALRM, body_timeout)
        signal.setitimer(signal.ITIMER_REAL, self.body_seconds)
        self._write(create=True)

    def begin_cleanup(self):
        if self.cleanup_at is not None:
            return
        self.cleanup_at = time.monotonic()
        signal.setitimer(signal.ITIMER_REAL, 0)

        def cleanup_timeout(_signum, _frame):
            self.cleanup_timeout = True
            raise TimeoutError("NEG-WINDOW cleanup deadline exceeded")

        signal.signal(signal.SIGALRM, cleanup_timeout)
        signal.setitimer(signal.ITIMER_REAL, self.cleanup_seconds)
        self._write()

    def remaining(self, maximum=30):
        left = min(float(maximum), self.body_deadline - time.monotonic())
        if left <= 0:
            raise TimeoutError("NEG-WINDOW body/setup deadline exceeded")
        return left

    def restore(self):
        self.finished = time.monotonic()
        try:
            self._write()
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            if self._handler is not None:
                signal.signal(signal.SIGALRM, self._handler)
            if self._timer[0] > 0:
                signal.setitimer(signal.ITIMER_REAL, *self._timer)


@pytest.fixture
def h2_window_case_deadline(request):
    controller = getattr(request.node, "_ifpmic_h2_window_deadline", None)
    if controller is None:
        pytest.fail("the runner did not load the NEG-WINDOW case watchdog")
    return controller


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_protocol(item, nextitem):
    if item.nodeid not in CASE_NODE_IDS:
        yield
        return
    deadline = WindowCaseDeadline(item.nodeid)
    item._ifpmic_h2_window_deadline = deadline
    try:
        deadline.start()
        yield
    finally:
        deadline.restore()


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_teardown(item, nextitem):
    if item.nodeid in CASE_NODE_IDS:
        item._ifpmic_h2_window_deadline.begin_cleanup()
    yield
