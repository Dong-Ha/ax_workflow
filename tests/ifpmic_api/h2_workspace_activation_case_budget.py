"""Whole-case budgets for the H2 workspace activation boundary cases."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import time

import pytest


CASE_NODE_IDS = frozenset({
    "tests/ifpmic_api/test_h2_workspace_activation_boundaries.py::test_h2_workspace_nonready_blocks_dispatcher_before_start[state-reserved]",
    "tests/ifpmic_api/test_h2_workspace_activation_boundaries.py::test_h2_workspace_nonready_blocks_dispatcher_before_start[state-provisioning]",
    "tests/ifpmic_api/test_h2_workspace_activation_boundaries.py::test_h2_workspace_nonready_blocks_dispatcher_before_start[state-error]",
    "tests/ifpmic_api/test_h2_workspace_activation_boundaries.py::test_h2_workspace_invalid_ready_fails_closed[marker-missing]",
    "tests/ifpmic_api/test_h2_workspace_activation_boundaries.py::test_h2_workspace_invalid_ready_fails_closed[marker-forged]",
    "tests/ifpmic_api/test_h2_workspace_activation_boundaries.py::test_h2_workspace_invalid_ready_fails_closed[marker-wrong-token]",
    "tests/ifpmic_api/test_h2_workspace_activation_boundaries.py::test_h2_workspace_invalid_ready_fails_closed[marker-symlink]",
    "tests/ifpmic_api/test_h2_workspace_activation_boundaries.py::test_h2_workspace_stale_generation_claim_is_fenced",
    "tests/ifpmic_api/test_h2_workspace_activation_boundaries.py::test_h2_workspace_nonready_blocks_admitted_worker[state-reserved]",
    "tests/ifpmic_api/test_h2_workspace_activation_boundaries.py::test_h2_workspace_nonready_blocks_admitted_worker[state-provisioning]",
    "tests/ifpmic_api/test_h2_workspace_activation_boundaries.py::test_h2_workspace_nonready_blocks_admitted_worker[state-error]",
})

CASE_BUDGETS = {nodeid: (215, 25) for nodeid in CASE_NODE_IDS}


class WorkspaceDeadline:
    def __init__(self, nodeid: str):
        self.nodeid = nodeid
        self.body_seconds, self.cleanup_seconds = CASE_BUDGETS[nodeid]
        self.started = None
        self.body_deadline = None
        self.cleanup_at = None
        self.cleanup_deadline = None
        self.finished = None
        self.body_timeout = False
        self.cleanup_timeout = False
        self.path = None
        self.prior_handler = None
        self.prior_timer = (0.0, 0.0)

    def _write(self, create=False):
        if self.path is None:
            return
        parent = self.path.parent
        info = parent.lstat()
        assert stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
        assert stat.S_IMODE(info.st_mode) == 0o700 and not parent.is_symlink()
        value = {
            "kind": "ifpmic.b03.h2.workspace-case-timing.v1",
            "nodeid": self.nodeid,
            "started_monotonic": self.started,
            "cleanup_started_monotonic": self.cleanup_at,
            "finished_monotonic": self.finished,
            "body_seconds": None if self.cleanup_at is None else self.cleanup_at - self.started,
            "cleanup_seconds": None if self.finished is None or self.cleanup_at is None
                else self.finished - self.cleanup_at,
            "body_budget_seconds": self.body_seconds,
            "cleanup_budget_seconds": self.cleanup_seconds,
            "body_timeout_triggered": self.body_timeout,
            "cleanup_timeout_triggered": self.cleanup_timeout,
        }
        raw = json.dumps(value, ensure_ascii=True, sort_keys=True,
                         separators=(",", ":"), allow_nan=False).encode("ascii") + b"\n"
        flags = os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC
        if create:
            flags |= os.O_CREAT | os.O_EXCL
        fd = os.open(self.path, flags, 0o600)
        try:
            current = os.fstat(fd)
            assert stat.S_ISREG(current.st_mode) and current.st_uid == os.getuid()
            assert current.st_nlink == 1
            if create:
                os.fchmod(fd, 0o600)
            else:
                os.ftruncate(fd, 0)
            assert stat.S_IMODE(os.fstat(fd).st_mode) == 0o600
            view = memoryview(raw)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    raise OSError("short private workspace timing write")
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)

    def start(self):
        self.prior_handler = signal.getsignal(signal.SIGALRM)
        self.prior_timer = signal.getitimer(signal.ITIMER_REAL)
        self.started = time.monotonic()
        self.body_deadline = self.started + self.body_seconds
        raw_root = os.environ.get("IFPMIC_H2_WORKSPACE_TIMINGS_ROOT")
        assert raw_root is not None
        root = Path(raw_root)
        assert root.is_absolute() and root.is_dir() and not root.is_symlink()
        assert stat.S_IMODE(root.stat().st_mode) == 0o700 and root.stat().st_uid == os.getuid()
        self.path = root / (hashlib.sha256(self.nodeid.encode("utf-8")).hexdigest() + ".json")

        def body_timeout(_signum, _frame):
            self.body_timeout = True
            self.begin_cleanup()
            raise TimeoutError("workspace case setup/body deadline exceeded")

        signal.signal(signal.SIGALRM, body_timeout)
        signal.setitimer(signal.ITIMER_REAL, self.body_seconds)
        self._write(create=True)

    def begin_cleanup(self):
        if self.cleanup_at is not None:
            return
        self.cleanup_at = time.monotonic()
        self.cleanup_deadline = self.cleanup_at + self.cleanup_seconds
        signal.setitimer(signal.ITIMER_REAL, 0)

        def cleanup_timeout(_signum, _frame):
            self.cleanup_timeout = True
            raise TimeoutError("workspace case cleanup deadline exceeded")

        signal.signal(signal.SIGALRM, cleanup_timeout)
        signal.setitimer(signal.ITIMER_REAL, self.cleanup_seconds)
        self._write()

    def remaining(self, maximum=30):
        left = min(float(maximum), self.body_deadline - time.monotonic())
        if left <= 0:
            raise TimeoutError("workspace case setup/body deadline exceeded")
        return left

    def cleanup_remaining(self, maximum=30):
        if self.cleanup_at is None:
            self.begin_cleanup()
        left = min(float(maximum), self.cleanup_deadline - time.monotonic())
        if left <= 0:
            self.cleanup_timeout = True
            raise TimeoutError("workspace case cleanup deadline exceeded")
        return left

    def restore(self):
        self.finished = time.monotonic()
        try:
            self._write()
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            if self.prior_handler is not None:
                signal.signal(signal.SIGALRM, self.prior_handler)
            if self.prior_timer[0] > 0:
                signal.setitimer(signal.ITIMER_REAL, *self.prior_timer)


@pytest.fixture
def h2_workspace_case_deadline(request):
    deadline = getattr(request.node, "_ifpmic_h2_workspace_deadline", None)
    if deadline is None:
        pytest.fail("the runner did not load the exact workspace case watchdog")
    return deadline


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_protocol(item, nextitem):
    if item.nodeid not in CASE_NODE_IDS:
        yield
        return
    deadline = WorkspaceDeadline(item.nodeid)
    item._ifpmic_h2_workspace_deadline = deadline
    from tests.ifpmic_api.h2_fixture_cleanup import installed_controller, restore_preserving_error

    with installed_controller(item.config, deadline):
        try:
            deadline.start()
            yield
        finally:
            restore_preserving_error(deadline.restore)


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_teardown(item, nextitem):
    if item.nodeid in CASE_NODE_IDS:
        item._ifpmic_h2_workspace_deadline.begin_cleanup()
    yield
