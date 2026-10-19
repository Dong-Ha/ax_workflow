"""Test-only child that runs the real Dispatcher with one constructor hook.

There is no product environment fault switch. It validates the normal private
config, authenticates/validates the registered deployment and workspace before
Temporal connection, then uses the production Dispatcher.once path.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import sys
from pathlib import Path


def _parse_args(argv=None):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--command-id", required=True)
    parser.add_argument("--barrier-socket", required=True)
    parser.add_argument("--hook-phase", default="before_start_rpc")
    parser.add_argument("--repo-root", required=True)
    args = parser.parse_args(argv)
    if (len(args.command_id) != 36 or not args.barrier_socket.startswith("/")
            or ".." in Path(args.barrier_socket).parts or not args.repo_root.startswith("/")):
        raise ValueError("BUILD_UNAVAILABLE")
    return args


def _pause_at_before_start_rpc(path: str, phase: str) -> None:
    target = Path(path)
    info = target.lstat()
    if (not target.is_socket() or info.st_uid != os.geteuid()
            or (info.st_mode & 0o777) != 0o600 or target.is_symlink()):
        raise ValueError("BUILD_UNAVAILABLE")
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        connection.settimeout(190)
        connection.connect(path)
        connection.sendall(phase.encode("ascii") + b"\n")
        response = bytearray()
        while b"\n" not in response and len(response) < 32:
            chunk = connection.recv(32 - len(response))
            if not chunk:
                raise ValueError("BUILD_UNAVAILABLE")
            response.extend(chunk)
        if bytes(response) != b"continue\n":
            raise ValueError("BUILD_UNAVAILABLE")
    finally:
        connection.close()


async def _run_once(config, identity, command_id: str, barrier_socket: str,
                    hook_phase: str) -> dict[str, str]:
    # Product constructors are loaded only after exact config/manifest checks.
    from services.ifpmic_api.execution_dispatcher import Dispatcher
    from services.ifpmic_api.execution_protocol import canonical_uuid
    from services.ifpmic_api.execution_store import ExecutionStore
    from services.ifpmic_api.execution_temporal import TemporalTransport
    from services.ifpmic_api.execution_workspace import ReadyWorkspace

    if config["mode"] != "dispatcher" or not canonical_uuid(command_id):
        raise ValueError("BUILD_UNAVAILABLE")
    store = ExecutionStore(dsn=config["dsn"])
    workspace = ReadyWorkspace(config["workspace_root"])

    # Authenticate and verify registry/build/workspace with real SQL before any
    # Temporal client connection. Once() repeats the production bootstrap.
    await Dispatcher(store, None, identity, workspace).bootstrap()
    transport = await TemporalTransport.connect(identity)

    def fault_hook(phase: str) -> None:
        if phase == hook_phase:
            _pause_at_before_start_rpc(barrier_socket, phase)

    result = await Dispatcher(store, transport, identity, workspace,
                              fault_hook=fault_hook).once(command_id)
    return {"status": str(result.get("status", "unavailable"))}


def main(argv=None) -> int:
    try:
        args = _parse_args(argv)
        repo_root = Path(args.repo_root).resolve(strict=True)
        if not (repo_root / "services/ifpmic_api/execution_manifest.py").is_file():
            raise ValueError("BUILD_UNAVAILABLE")
        sys.path.insert(0, str(repo_root))
        config_path = os.environ.get("IFPMIC_EXECUTION_CONFIG")
        if not config_path:
            raise ValueError("BUILD_UNAVAILABLE")
        from services.ifpmic_api.execution_manifest import load_config
        config, identity = load_config(config_path)
        allowed_hooks = {
            "after_claim_commit", "before_start_rpc", "after_start_response",
            "after_run_admitted", "after_delivery_ack",
        }
        if args.hook_phase not in allowed_hooks:
            raise ValueError("BUILD_UNAVAILABLE")
        result = asyncio.run(_run_once(config, identity, args.command_id,
                                       args.barrier_socket, args.hook_phase))
        sys.stdout.write(json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n")
        return 0 if result["status"] == "dispatched" else 3
    except Exception:
        # No raw SDK/PG exception, command text, DSN or private path on stdout.
        sys.stdout.write('{"status":"unavailable"}\n')
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
