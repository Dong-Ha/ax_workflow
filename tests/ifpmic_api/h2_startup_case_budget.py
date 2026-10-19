"""Whole-case watchdog for real CLI startup rejection tests.

The runner explicitly loads this plugin. Its protocol hook starts before any
function-scoped fixture setup and retains one cleanup window through teardown.
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


CASE_BASE = (
    "tests/ifpmic_api/test_h2_runtime_startup_rejections.py::"
    "test_runtime_cli_rejects_registry_and_identity_mismatches"
)
CASE_IDS = (
    "no_job_missing_registration",
    "missing_deployment_dispatcher", "disabled_deployment_dispatcher",
    "missing_dispatcher_principal", "disabled_dispatcher_principal",
    "missing_projector_principal", "disabled_projector_principal",
    "missing_dispatcher_build", "disabled_dispatcher_build",
    "disabled_projector_build", "wrong_dispatcher_role", "wrong_projector_role",
    "wrong_dispatcher_password", "recreated_dispatcher_role_oid",
    "endpoint_mismatch", "namespace_mismatch", "deployment_mismatch",
    "build_mismatch_dispatcher", "build_mismatch_projector",
    "source_manifest_mismatch", "environment_manifest_mismatch",
)
CASE_NODE_IDS = tuple(f"{CASE_BASE}[{item}]" for item in CASE_IDS)
BODY_SECONDS = 25
CLEANUP_SECONDS = 5


class StartupCaseDeadline:
    def __init__(self, nodeid: str):
        self.nodeid = nodeid
        self.started = 0.0
        self.body_deadline = 0.0
        self.cleanup_started = False
        self.finished = None
        self.body_timeout = False
        self.cleanup_timeout = False
        self.events = []
        self._prior_handler = None
        self._prior_timer = (0.0, 0.0)
        self._timing_path = None

    def _write(self, *, create=False):
        root_value = os.environ.get("IFPMIC_H2_STARTUP_TIMINGS_ROOT")
        if root_value is None:
            raise AssertionError("startup case timing root is required")
        root = Path(root_value)
        info = root.lstat()
        assert root.is_absolute() and stat.S_ISDIR(info.st_mode)
        assert info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700
        assert not root.is_symlink()
        self._timing_path = root / (hashlib.sha256(self.nodeid.encode("utf-8")).hexdigest() + ".json")
        now = time.monotonic()
        cleanup = next((event["monotonic"] for event in self.events
                        if event["event"] == "cleanup_start"), None)
        document = {
            "kind": "ifpmic.b03.h2.startup-case-timing.v1", "nodeid": self.nodeid,
            "status": ("cleanup_timeout" if self.cleanup_timeout else
                       "body_timeout" if self.body_timeout else
                       "finished" if self.finished is not None else "running"),
            "started_monotonic": self.started,
            "cleanup_started_monotonic": cleanup,
            "finished_monotonic": self.finished,
            "body_seconds": None if cleanup is None else cleanup - self.started,
            "cleanup_seconds": None if self.finished is None or cleanup is None else self.finished - cleanup,
            "total_seconds": None if self.finished is None else self.finished - self.started,
            "observed_monotonic": now, "events": self.events,
            "body_timeout_triggered": self.body_timeout,
            "cleanup_timeout_triggered": self.cleanup_timeout,
        }
        raw = json.dumps(document, ensure_ascii=True, sort_keys=True,
                         separators=(",", ":"), allow_nan=False).encode("ascii") + b"\n"
        flags = os.O_WRONLY | os.O_CLOEXEC | os.O_NOFOLLOW
        if create:
            flags |= os.O_CREAT | os.O_EXCL
        fd = os.open(self._timing_path, flags, 0o600)
        try:
            opened = os.fstat(fd)
            assert stat.S_ISREG(opened.st_mode) and opened.st_uid == os.getuid()
            assert opened.st_nlink == 1
            if create:
                os.fchmod(fd, 0o600)
            else:
                os.ftruncate(fd, 0)
            view = memoryview(raw)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    raise OSError("short startup timing write")
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)

    def _record(self, event, *, create=False, at=None):
        current = time.monotonic() if at is None else at
        assert math.isfinite(current)
        self.events.append({"event": event, "monotonic": current})
        self._write(create=create)

    def start(self):
        self._prior_handler = signal.getsignal(signal.SIGALRM)
        self._prior_timer = signal.getitimer(signal.ITIMER_REAL)
        self.started = time.monotonic()
        self.body_deadline = self.started + BODY_SECONDS

        def body_alarm(_signum, _frame):
            self.body_timeout = True
            self.begin_cleanup()
            raise TimeoutError("startup case body deadline exceeded")

        signal.signal(signal.SIGALRM, body_alarm)
        signal.setitimer(signal.ITIMER_REAL, BODY_SECONDS)
        self._record("protocol_start", create=True)

    def begin_cleanup(self):
        if self.cleanup_started:
            return
        self.cleanup_started = True
        self.cleanup_at = time.monotonic()
        signal.setitimer(signal.ITIMER_REAL, 0)

        def cleanup_alarm(_signum, _frame):
            self.cleanup_timeout = True
            raise TimeoutError("startup case cleanup deadline exceeded")

        signal.signal(signal.SIGALRM, cleanup_alarm)
        signal.setitimer(signal.ITIMER_REAL, CLEANUP_SECONDS)
        self._record("cleanup_start", at=self.cleanup_at)

    def cleanup_remaining(self, maximum):
        self.begin_cleanup()
        left = min(float(maximum), self.cleanup_at + CLEANUP_SECONDS - time.monotonic())
        if left <= 0:
            self.cleanup_timeout = True
            raise TimeoutError("H2 startup cleanup deadline exceeded")
        return left

    def remaining(self, maximum=30):
        result = min(float(maximum), self.body_deadline - time.monotonic())
        if result <= 0:
            raise TimeoutError("startup case body deadline exceeded")
        return result

    @contextmanager
    def cleanup_budget(self):
        self.begin_cleanup()
        yield

    def restore(self):
        try:
            self.finished = time.monotonic()
            self.events.append({"event": "protocol_finish", "monotonic": self.finished})
            self._write()
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
    if item.nodeid not in CASE_NODE_IDS:
        yield
        return
    deadline = StartupCaseDeadline(item.nodeid)
    item._ifpmic_h2_startup_deadline = deadline
    with installed_controller(item.config, deadline):
        try:
            deadline.start()
            yield
        finally:
            restore_preserving_error(deadline.restore)


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_teardown(item, nextitem):
    if item.nodeid in CASE_NODE_IDS:
        item._ifpmic_h2_startup_deadline.begin_cleanup()
    yield
