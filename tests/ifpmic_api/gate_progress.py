"""Private, low-overhead per-case progress events for the frozen gate runner.

Enable explicitly with ``-p tests.ifpmic_api.gate_progress`` and set
``IFPMIC_H2_CASE_PROGRESS_PATH`` to a private JSONL destination.
"""

from __future__ import annotations

import json
import os
import stat
import time


_FD: int | None = None


def _check_private_regular_file(fd: int) -> None:
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode):
        raise RuntimeError("case progress destination is not a regular file")
    if info.st_uid != os.geteuid() or info.st_nlink != 1:
        raise RuntimeError("case progress destination ownership/link check failed")
    if stat.S_IMODE(info.st_mode) != 0o600:
        raise RuntimeError("case progress destination must have mode 0600")


def pytest_configure(config: object) -> None:
    del config
    global _FD
    raw_path = os.environ.get("IFPMIC_H2_CASE_PROGRESS_PATH")
    if not raw_path:
        raise RuntimeError("IFPMIC_H2_CASE_PROGRESS_PATH is required")
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW
    try:
        fd = os.open(raw_path, flags | os.O_EXCL, 0o600)
        os.fchmod(fd, 0o600)
    except FileExistsError:
        fd = os.open(raw_path, flags)
    try:
        _check_private_regular_file(fd)
    except BaseException:
        os.close(fd)
        raise
    _FD = fd


def pytest_unconfigure(config: object) -> None:
    del config
    global _FD
    if _FD is not None:
        os.close(_FD)
        _FD = None


def _record(event: str, nodeid: str, **fields: object) -> None:
    if _FD is None:
        raise RuntimeError("case progress plugin was not configured")
    _check_private_regular_file(_FD)
    record = {
        "nodeid": nodeid,
        "event": event,
        "monotonic": time.monotonic(),
        **fields,
    }
    payload = (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    view = memoryview(payload)
    while view:
        written = os.write(_FD, view)
        if written <= 0:
            raise OSError("short write to case progress destination")
        view = view[written:]


def pytest_runtest_logstart(nodeid: str, location: object) -> None:
    del location
    _record("start", nodeid)


def pytest_runtest_logreport(report: object) -> None:
    _record(
        "report",
        report.nodeid,
        when=report.when,
        outcome=report.outcome,
        duration=report.duration,
    )


def pytest_runtest_logfinish(nodeid: str, location: object) -> None:
    del location
    _record("finish", nodeid)
