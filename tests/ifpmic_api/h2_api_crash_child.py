"""Test-only real Uvicorn API process with an injected post-commit barrier."""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import stat
import sys
import time


def _event(path: Path, value: dict[str, object]) -> None:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("ascii") + b"\n"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        view = memoryview(raw)
        while view:
            count = os.write(fd, view)
            if count <= 0:
                raise OSError("short private API child event write")
            view = view[count:]
        os.fsync(fd)
    finally:
        os.close(fd)


def main() -> int:
    if len(sys.argv) != 5 or sys.argv[2] != "job_after_commit":
        return 2
    try:
        import uvicorn

        from services.ifpmic_api.app import create_app
        from services.ifpmic_api.settings import load_settings

        settings = load_settings(sys.argv[1])
        barrier = Path(sys.argv[3])
        port = int(sys.argv[4])
        info = barrier.lstat()
        if (not barrier.is_absolute() or not stat.S_ISDIR(info.st_mode)
                or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700):
            raise ValueError("BARRIER_INVALID")

        def fault_hook(name: str) -> None:
            if name == "job_after_commit":
                _event(barrier / "reached.json", {"phase": name, "monotonic": time.monotonic()})
                release = barrier / "release"
                while not release.exists():
                    time.sleep(0.02)

        # Sessions created by the isolated G4 harness use this deterministic
        # future clock. It stays inside private test code and is never selected
        # through the product HTTP or process-environment surface.
        fixed_now = datetime(2030, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
        app = create_app(settings, clock=lambda: fixed_now, fault_hook=fault_hook)
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port,
                                                access_log=False, server_header=False,
                                                proxy_headers=False, log_config=None))
        server.run()
        return 0
    except BaseException:
        try:
            os.write(2, b"H2_API_CHILD_FAILED\n")
        except OSError:
            pass
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
