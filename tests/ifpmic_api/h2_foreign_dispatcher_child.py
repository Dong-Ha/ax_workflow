"""Run one real Dispatcher pass for a separately authenticated deployment."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import sys


def _parse(argv=None):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--command-id", required=True)
    parser.add_argument("--repo-root", required=True)
    value = parser.parse_args(argv)
    if len(value.command_id) != 36 or not value.repo_root.startswith("/"):
        raise ValueError("BUILD_UNAVAILABLE")
    return value


async def _once(config_path: str, command_id: str, repo_root: str) -> str:
    from services.ifpmic_api.execution_manifest import load_config

    config, identity = load_config(config_path)
    if config["mode"] != "dispatcher":
        raise ValueError("BUILD_UNAVAILABLE")
    from services.ifpmic_api.execution_dispatcher import Dispatcher
    from services.ifpmic_api.execution_store import ExecutionStore
    from services.ifpmic_api.execution_temporal import TemporalTransport
    from services.ifpmic_api.execution_workspace import ReadyWorkspace

    store = ExecutionStore(dsn=config["dsn"])
    workspace = ReadyWorkspace(config["workspace_root"])
    # First pass proves this foreign principal/config matches its own registry.
    await Dispatcher(store, None, identity, workspace).bootstrap()
    transport = await TemporalTransport.connect(identity)
    result = await Dispatcher(store, transport, identity, workspace).once(command_id)
    return str(result.get("status", "unavailable"))


def main(argv=None) -> int:
    try:
        args = _parse(argv)
        root = Path(args.repo_root).resolve(strict=True)
        if not (root / "services/ifpmic_api/execution_manifest.py").is_file():
            raise ValueError("BUILD_UNAVAILABLE")
        sys.path.insert(0, str(root))
        config_path = os.environ.get("IFPMIC_EXECUTION_CONFIG")
        if not config_path:
            raise ValueError("BUILD_UNAVAILABLE")
        status = asyncio.run(_once(config_path, args.command_id, str(root)))
        sys.stdout.write(json.dumps({"status": status}, sort_keys=True,
                                    separators=(",", ":")) + "\n")
        return 0 if status == "idle" else 3
    except Exception:
        sys.stdout.write('{"status":"unavailable"}\n')
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
