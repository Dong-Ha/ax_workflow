"""Actual one-shot Dispatcher child with test-only durable file barriers.

Configuration/manifests are validated before SDK imports. The child always uses
production ExecutionStore, Dispatcher, ReadyWorkspace and TemporalTransport;
only the named store/dispatcher constructor hook is added by this process.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
import time


def _private_dir(raw: str) -> Path:
    path = Path(raw)
    info = path.lstat()
    if (not path.is_absolute() or not path.is_dir() or path.is_symlink()
            or info.st_uid != os.getuid() or (info.st_mode & 0o777) != 0o700):
        raise ValueError("BARRIER_INVALID")
    return path


def _write_event(root: Path, name: str) -> None:
    if not name.isascii() or not name.replace("_", "").isalnum():
        raise ValueError("BARRIER_INVALID")
    path = root / ("reached-" + name)
    data = (json.dumps({"event": name, "monotonic": time.monotonic()},
                       sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode("ascii")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        view = memoryview(data)
        while view:
            count = os.write(fd, view)
            if count <= 0:
                raise OSError("short private transport event write")
            view = view[count:]
        os.fsync(fd)
    finally:
        os.close(fd)


def _wait_release(root: Path, name: str, timeout=180.0) -> None:
    path = root / ("release-" + name)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            info = path.lstat()
        except FileNotFoundError:
            time.sleep(0.02)
            continue
        if (not path.is_symlink() and path.is_file() and info.st_uid == os.getuid()
                and (info.st_mode & 0o777) == 0o600 and info.st_nlink == 1):
            return
        time.sleep(0.02)
    raise TimeoutError("private transport barrier timeout")


async def _once(config, identity, command_id, root, store_phases, dispatcher_phase):
    from services.ifpmic_api.execution_dispatcher import Dispatcher
    from services.ifpmic_api.execution_store import ExecutionStore
    from services.ifpmic_api.execution_temporal import TemporalTransport
    from services.ifpmic_api.execution_workspace import ReadyWorkspace

    def gate(name):
        if name in store_phases:
            _write_event(root, name)
            _wait_release(root, name)

    class TCStore(ExecutionStore):
        def __init__(self, *, dsn=None, db_factory=None, fault_hook=None):
            def combined(name):
                gate(name)
                if fault_hook is not None:
                    fault_hook(name)
            super().__init__(dsn=dsn, db_factory=db_factory, fault_hook=combined)

    store = TCStore(dsn=config["dsn"])
    workspace = ReadyWorkspace(config["workspace_root"])
    dispatcher = Dispatcher(store, None, identity, workspace)
    # Match launcher ordering: authenticated registry and workspace checks are
    # complete before the actual SDK connection or any claim.
    await dispatcher.bootstrap()
    transport = await TemporalTransport.connect(identity)

    def dispatcher_gate(name):
        if name == dispatcher_phase:
            _write_event(root, name)
            _wait_release(root, name)
    result = await Dispatcher(store, transport, identity, workspace,
                              fault_hook=dispatcher_gate).once(command_id)
    return {"status": result.get("status", "unavailable"),
            "code": result.get("code") if result.get("code") in {
                "WORKSPACE_NOT_READY", "DEPENDENCY_UNAVAILABLE", "BINDING_CONFLICT",
                "RUN_CONFLICT", "WORKER_FORBIDDEN", "WORKSPACE_IDENTITY_CONFLICT",
            } else None}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--config", required=True)
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--control-dir", required=True)
    parser.add_argument("--command-id", required=True)
    parser.add_argument("--store-phase", action="append", default=[])
    parser.add_argument("--dispatcher-phase", default="")
    args = parser.parse_args(argv)
    try:
        root = _private_dir(args.control_dir)
        repo = Path(args.repo_root).resolve(strict=True)
        if not (repo / "services/ifpmic_api/execution_manifest.py").is_file():
            raise ValueError("BUILD_UNAVAILABLE")
        sys.path.insert(0, str(repo))
        # Validate real private config and source/environment manifests before
        # importing execution or Temporal SDK modules.
        from services.ifpmic_api.execution_manifest import load_config
        config, identity = load_config(args.config)
        if config["mode"] != "dispatcher" or len(args.command_id) != 36:
            raise ValueError("BUILD_UNAVAILABLE")
        result = asyncio.run(_once(config, identity, args.command_id, root,
                                  frozenset(args.store_phase), args.dispatcher_phase))
        sys.stdout.write(json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n")
        return 0 if result["status"] in {"dispatched", "idle", "wait", "quarantined"} else 3
    except Exception:
        # Avoid serializing dependency messages, credentials, or private paths.
        sys.stdout.write('{"status":"unavailable","code":"DEPENDENCY_UNAVAILABLE"}\n')
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
