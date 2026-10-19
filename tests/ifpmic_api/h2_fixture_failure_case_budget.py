"""Whole-case clocks for fixture-cleanup failure regressions (25s + 5s)."""
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
    "tests/ifpmic_api/test_h2_fixture_cleanup_failures.py::test_restore_error_keeps_exact_primary_and_notes_secondary",
    "tests/ifpmic_api/test_h2_fixture_cleanup_failures.py::test_restore_only_failure_escapes_by_identity",
    "tests/ifpmic_api/test_h2_fixture_cleanup_failures.py::test_expired_cleanup_budget_performs_no_new_lifecycle_action",
    "tests/ifpmic_api/test_h2_fixture_cleanup_failures.py::test_partial_oidc_start_fails_closed_for_unstarted_thread_handle",
    "tests/ifpmic_api/test_h2_fixture_cleanup_failures.py::test_unconfirmed_testclient_exit_records_unknown_ownership",
})
CASE_BUDGETS = {nodeid: (25, 5) for nodeid in CASE_NODE_IDS}


class FixtureFailureDeadline:
    def __init__(self, nodeid):
        self.nodeid = nodeid
        self.body_seconds, self.cleanup_seconds = CASE_BUDGETS[nodeid]
        self.started = self.cleanup_at = self.finished = None
        self.body_deadline = self.cleanup_deadline = None
        self.body_timeout = self.cleanup_timeout = False
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
            "kind": "ifpmic.b03.h2.fixture-failure-case-timing.v1",
            "nodeid": self.nodeid,
            "started_monotonic": self.started,
            "cleanup_started_monotonic": self.cleanup_at,
            "finished_monotonic": self.finished,
            "body_elapsed_seconds": None if self.cleanup_at is None
                else self.cleanup_at - self.started,
            "cleanup_elapsed_seconds": None if self.finished is None or self.cleanup_at is None
                else self.finished - self.cleanup_at,
            "body_budget_seconds": self.body_seconds,
            "cleanup_budget_seconds": self.cleanup_seconds,
            "body_timeout_triggered": self.body_timeout,
            "cleanup_timeout_triggered": self.cleanup_timeout,
        }
        raw = json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"),
                         allow_nan=False).encode("ascii") + b"\n"
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
            view = memoryview(raw)
            while view:
                count = os.write(fd, view)
                if count <= 0:
                    raise OSError("short fixture-failure timing write")
                view = view[count:]
            os.fsync(fd)
        finally:
            os.close(fd)

    def start(self):
        self.prior_handler = signal.getsignal(signal.SIGALRM)
        self.prior_timer = signal.getitimer(signal.ITIMER_REAL)
        self.started = time.monotonic()
        self.body_deadline = self.started + self.body_seconds
        raw = os.environ.get("IFPMIC_H2_FIXTURE_FAILURE_TIMINGS_ROOT")
        assert raw is not None
        root = Path(raw)
        assert root.is_absolute() and root.is_dir() and not root.is_symlink()
        root_info = root.lstat()
        assert stat.S_ISDIR(root_info.st_mode) and root_info.st_uid == os.getuid()
        assert stat.S_IMODE(root_info.st_mode) == 0o700
        self.path = root / (hashlib.sha256(self.nodeid.encode("utf-8")).hexdigest() + ".json")

        def body_timeout(_signum, _frame):
            self.body_timeout = True
            self.begin_cleanup()
            raise TimeoutError("fixture failure setup/body deadline exceeded")

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
            raise TimeoutError("fixture failure cleanup deadline exceeded")

        signal.signal(signal.SIGALRM, cleanup_timeout)
        signal.setitimer(signal.ITIMER_REAL, self.cleanup_seconds)
        self._write()

    def remaining(self, maximum=30):
        remaining = min(float(maximum), self.body_deadline - time.monotonic())
        if remaining <= 0:
            raise TimeoutError("fixture failure setup/body deadline exceeded")
        return remaining

    def cleanup_remaining(self, maximum=30):
        if self.cleanup_at is None:
            self.begin_cleanup()
        remaining = min(float(maximum), self.cleanup_deadline - time.monotonic())
        if remaining <= 0:
            self.cleanup_timeout = True
            raise TimeoutError("fixture failure cleanup deadline exceeded")
        return remaining

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


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_protocol(item, nextitem):
    if item.nodeid not in CASE_NODE_IDS:
        yield
        return
    deadline = FixtureFailureDeadline(item.nodeid)
    item._ifpmic_h2_fixture_failure_deadline = deadline
    with installed_controller(item.config, deadline):
        try:
            deadline.start()
            yield
        finally:
            restore_preserving_error(deadline.restore)


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_teardown(item, nextitem):
    if item.nodeid in CASE_NODE_IDS:
        item._ifpmic_h2_fixture_failure_deadline.begin_cleanup()
    yield
