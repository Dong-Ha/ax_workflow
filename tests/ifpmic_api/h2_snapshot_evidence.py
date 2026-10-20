"""Persist actual owner-query observations privately without changing their oracle."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import time
from uuid import UUID, uuid4


def _private_directory(path: Path) -> None:
    path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    assert stat.S_ISDIR(info.st_mode) and not path.is_symlink()
    assert info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700


def _evidence_root() -> Path | None:
    raw_root = os.environ.get("IFPMIC_H2_RUNTIME_EVIDENCE_ROOT")
    if raw_root is None:
        return None
    root = Path(raw_root)
    assert root.is_absolute()
    info = root.lstat()
    assert stat.S_ISDIR(info.st_mode) and not root.is_symlink()
    assert info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700
    return root


def _write_observation(directory: Path, document: dict[str, object]) -> None:
    payload = json.dumps(document, ensure_ascii=True, sort_keys=True,
                         separators=(",", ":"), allow_nan=False).encode("ascii") + b"\n"
    path = directory / f"{document['observed_monotonic_ns']}-{uuid4().hex}.json"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                 0o600)
    try:
        os.fchmod(fd, 0o600)
        current = os.fstat(fd)
        assert stat.S_ISREG(current.st_mode) and current.st_uid == os.getuid()
        assert current.st_nlink == 1 and stat.S_IMODE(current.st_mode) == 0o600
        view = memoryview(payload)
        while view:
            count = os.write(fd, view)
            if count <= 0:
                raise OSError("short private observation write")
            view = view[count:]
        os.fsync(fd)
    finally:
        os.close(fd)


def record_query_observation(operation: str, subject: str, result: object) -> None:
    """Record an actual decoded query result; never normalize or invent rows."""
    root = _evidence_root()
    if root is None:
        return
    node = os.environ.get("PYTEST_CURRENT_TEST")
    assert node
    directory = root / "query-observations"
    _private_directory(directory)
    caller = sys._getframe(1)
    _write_observation(directory, {
        "kind": "ifpmic.b03.h2.query-observation.v1",
        "operation": operation, "subject": subject, "result": result,
        "pytest_current_test": node, "observed_monotonic_ns": time.monotonic_ns(),
        "caller": {"file": Path(caller.f_code.co_filename).name,
                   "function": caller.f_code.co_name, "line": caller.f_lineno},
    })


def record_owner_snapshot(job_id: str, snapshot: dict[str, object]) -> None:
    """Persist original rows; an enabled recorder fails closed on evidence loss."""
    root = _evidence_root()
    if root is None:
        return
    assert str(UUID(job_id)) == job_id
    observations = root / "owner-snapshots"
    _private_directory(observations)
    job_root = observations / job_id
    _private_directory(job_root)
    node = os.environ.get("PYTEST_CURRENT_TEST")
    assert node is not None and node
    canonical = json.dumps(snapshot, ensure_ascii=True, sort_keys=True,
                           separators=(",", ":"), allow_nan=False).encode("ascii")
    caller = sys._getframe(2)
    observed = time.monotonic_ns()
    document = {
        "kind": "ifpmic.b03.h2.owner-snapshot-observation.v1",
        "job_id": job_id,
        "pytest_current_test": node,
        "observed_monotonic_ns": observed,
        "caller": {"file": Path(caller.f_code.co_filename).name,
                   "function": caller.f_code.co_name, "line": caller.f_lineno},
        "snapshot_sha256": hashlib.sha256(canonical).hexdigest(),
        "snapshot": snapshot,
    }
    _write_observation(job_root, document)
