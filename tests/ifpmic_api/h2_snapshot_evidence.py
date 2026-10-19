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


def record_owner_snapshot(job_id: str, snapshot: dict[str, object]) -> None:
    """Fail on evidence loss when the runner enables its private evidence root.

    Other suites using the shared query helper without H2 evidence remain valid.
    Each observation is a separate exclusive file, including concurrent reads.
    The caller retains its original object and database ordering.
    """
    raw_root = os.environ.get("IFPMIC_H2_RUNTIME_EVIDENCE_ROOT")
    if raw_root is None:
        return
    root = Path(raw_root)
    assert root.is_absolute()
    info = root.lstat()
    assert stat.S_ISDIR(info.st_mode) and not root.is_symlink()
    assert info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700
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
    payload = json.dumps(document, ensure_ascii=True, sort_keys=True,
                         separators=(",", ":"), allow_nan=False).encode("ascii") + b"\n"
    path = job_root / f"{observed}-{uuid4().hex}.json"
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
                raise OSError("short private owner snapshot write")
            view = view[count:]
        os.fsync(fd)
    finally:
        os.close(fd)
