"""Pure local-file/config checks for the H2 execution launcher."""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

import pytest

from services.ifpmic_api.execution_manifest import load_config, local_dsn, private_json, verify_loaded_environment
from services.ifpmic_api.execution_protocol import ProtocolError


SERVER_SHA256 = "207da747b02c8a63bba3abd3d9d21131ad0c242523d7a2982650e26698eae822"
DEPLOYMENT_ID = "h2-test-deployment"


def _write_private(path: Path, value: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(value)
    path.chmod(0o600)


def _manifest(format_name: str, marker: str) -> dict[str, object]:
    return {"format": format_name, "files": {"literal": marker}}


def _canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("ascii")


def _domain_sha(domain: str, value: object) -> str:
    return hashlib.sha256(domain.encode("ascii") + b"\0" + _canonical(value)).hexdigest()


def _config_tree(tmp_path: Path, monkeypatch, *, endpoint="127.0.0.1:7233", extra=None):
    tmp_path.mkdir(parents=True, exist_ok=True)
    for name in list(os.environ):
        if name.startswith("PG"):
            monkeypatch.delenv(name)
    root = tmp_path / "private"
    root.mkdir(mode=0o700)
    root.chmod(0o700)
    workspace = root / "workspace"
    workspace.mkdir(mode=0o700)
    workspace.chmod(0o700)
    source = _manifest("ifpmic.h2.source.v1", "source")
    environment = _manifest("ifpmic.h2.environment.v1", "environment")
    monkeypatch.setattr("services.ifpmic_api.execution_manifest.verify_loaded_environment", lambda: None)
    monkeypatch.setattr("services.ifpmic_api.execution_manifest.source_manifest", lambda: source)
    monkeypatch.setattr("services.ifpmic_api.execution_manifest.environment_manifest", lambda: environment)
    source_path, environment_path = root / "source.json", root / "environment.json"
    _write_private(source_path, (json.dumps(source, sort_keys=True, separators=(",", ":")) + "\n").encode())
    _write_private(environment_path, (json.dumps(environment, sort_keys=True, separators=(",", ":")) + "\n").encode())
    source_hash = hashlib.sha256(_canonical(source)).hexdigest()
    environment_hash = hashlib.sha256(_canonical(environment)).hexdigest()
    build_hash = _domain_sha("ifpmic.b03.build.v1", {
        "protocol_version": "h2-v1", "source_manifest_sha256": source_hash,
        "environment_manifest_sha256": environment_hash, "workflow_type": "IFPMICJobWorkflow",
    })
    server_hash = _domain_sha("ifpmic.b03.deployment.v1", {
        "protocol_version": "h2-v1", "deployment_id": DEPLOYMENT_ID,
        "namespace": "default", "server_endpoint": endpoint,
    })
    identity = {
        "deployment_id": DEPLOYMENT_ID,
        "namespace": "default",
        "server_endpoint": endpoint,
        "server_config_sha256": server_hash,
        "build_id": build_hash,
        "source_manifest_sha256": source_hash,
        "environment_manifest_sha256": environment_hash,
    }
    value = {
        "format": "ifpmic.h2.runtime.v1", "mode": "dispatcher", "identity": identity,
        "dsn": f"host={root} port=5432 dbname=ifpmic user=dispatcher password=synthetic",
        "workspace_root": str(workspace), "source_manifest_path": str(source_path),
        "environment_manifest_path": str(environment_path),
    }
    if extra:
        value.update(extra)
    config_path = root / "runtime.json"
    _write_private(config_path, (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode())
    return root, workspace, source_path, environment_path, config_path, value


def test_private_json_accepts_only_private_single_link_file_and_parent(tmp_path: Path):
    root = tmp_path / "private"
    root.mkdir(mode=0o700)
    root.chmod(0o700)
    file = root / "config.json"
    _write_private(file, b'{"mode":"dispatcher"}\n')
    assert private_json(str(file)) == {"mode": "dispatcher"}

    linked = root / "hardlink.json"
    os.link(file, linked)
    with pytest.raises(ProtocolError) as hardlink:
        private_json(str(linked))
    assert hardlink.value.code == "BUILD_UNAVAILABLE"

    symlink = root / "symlink.json"
    symlink.symlink_to(file.name)
    with pytest.raises(ProtocolError) as link:
        private_json(str(symlink))
    assert link.value.code == "BUILD_UNAVAILABLE"

    linked.unlink()
    symlink.unlink()
    file.chmod(0o644)
    with pytest.raises(ProtocolError) as file_mode:
        private_json(str(file))
    assert file_mode.value.code == "BUILD_UNAVAILABLE"
    file.chmod(0o600)

    root.chmod(0o755)
    with pytest.raises(ProtocolError) as parent_mode:
        private_json(str(file))
    assert parent_mode.value.code == "BUILD_UNAVAILABLE"


def test_private_json_rejects_duplicate_keys(tmp_path: Path):
    root = tmp_path / "private"
    root.mkdir(mode=0o700)
    root.chmod(0o700)
    path = root / "duplicate.json"
    _write_private(path, b'{"mode":"dispatcher","mode":"worker"}\n')
    with pytest.raises(ProtocolError) as duplicate:
        private_json(str(path))
    assert duplicate.value.code == "BUILD_UNAVAILABLE"


def test_load_config_accepts_literal_private_manifests_and_local_socket_dsn(tmp_path: Path, monkeypatch):
    _root, _workspace, _source, _environment, config_path, _value = _config_tree(tmp_path, monkeypatch)
    loaded, identity = load_config(str(config_path))
    assert loaded["mode"] == "dispatcher"
    assert loaded["identity"]["deployment_id"] == DEPLOYMENT_ID
    assert identity.server_config_sha256 == SERVER_SHA256
    assert identity.deployment_id == DEPLOYMENT_ID


def test_load_config_rejects_source_manifest_mismatch(tmp_path: Path, monkeypatch):
    _root, _workspace, source_path, _environment, config_path, _value = _config_tree(tmp_path, monkeypatch)
    source_path.write_text('{"files":{"changed":"bad"},"format":"ifpmic.h2.source.v1"}\n')
    source_path.chmod(0o600)
    with pytest.raises(ProtocolError) as mismatch:
        load_config(str(config_path))
    assert mismatch.value.code == "BUILD_UNAVAILABLE"


def test_load_config_rejects_environment_manifest_mismatch(tmp_path: Path, monkeypatch):
    _root, _workspace, _source, environment_path, config_path, _value = _config_tree(tmp_path, monkeypatch)
    environment_path.write_text('{"files":{"changed":"bad"},"format":"ifpmic.h2.environment.v1"}\n')
    environment_path.chmod(0o600)
    with pytest.raises(ProtocolError) as mismatch:
        load_config(str(config_path))
    assert mismatch.value.code == "BUILD_UNAVAILABLE"


def test_load_config_rejects_extra_fields_and_endpoint_digest_mismatch(tmp_path: Path, monkeypatch):
    _root, _workspace, _source, _environment, config_path, _value = _config_tree(
        tmp_path / "extra", monkeypatch, extra={"fallback_dsn": "must-not-be-accepted"},
    )
    with pytest.raises(ProtocolError) as extra:
        load_config(str(config_path))
    assert extra.value.code == "BUILD_UNAVAILABLE"

    _root, _workspace, _source, _environment, config_path, _value = _config_tree(
        tmp_path / "endpoint", monkeypatch, endpoint="127.0.0.2:7233",
    )
    with pytest.raises(ProtocolError) as endpoint:
        load_config(str(config_path))
    assert endpoint.value.code == "BUILD_UNAVAILABLE"


def test_loaded_environment_requires_b_and_fresh_empty_cache(tmp_path: Path, monkeypatch):
    cache = tmp_path / "cache"
    cache.mkdir(mode=0o700)
    cache.chmod(0o700)
    monkeypatch.setattr(sys, "dont_write_bytecode", True)
    monkeypatch.setattr(sys, "pycache_prefix", str(cache))
    for name in ("PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP"):
        monkeypatch.delenv(name, raising=False)
    verify_loaded_environment()

    (cache / "stale.pyc").write_bytes(b"stale")
    with pytest.raises(ProtocolError) as stale_cache:
        verify_loaded_environment()
    assert stale_cache.value.code == "BUILD_UNAVAILABLE"

    (cache / "stale.pyc").unlink()
    monkeypatch.setattr(sys, "dont_write_bytecode", False)
    with pytest.raises(ProtocolError) as bytecode:
        verify_loaded_environment()
    assert bytecode.value.code == "BUILD_UNAVAILABLE"

    monkeypatch.setattr(sys, "dont_write_bytecode", True)
    monkeypatch.setenv("PYTHONPATH", str(tmp_path))
    with pytest.raises(ProtocolError) as ambient_pythonpath:
        verify_loaded_environment()
    assert ambient_pythonpath.value.code == "BUILD_UNAVAILABLE"


def test_local_dsn_requires_one_existing_unix_socket_directory(tmp_path: Path, monkeypatch):
    for name in list(os.environ):
        if name.startswith("PG"):
            monkeypatch.delenv(name)
    socket_root = tmp_path / "pg"
    socket_root.mkdir(mode=0o700)
    socket_root.chmod(0o700)
    dsn = f"host={socket_root} port=5432 dbname=ifpmic user=dispatcher password=synthetic"
    assert local_dsn(dsn) == dsn

    with pytest.raises(ProtocolError) as host_list:
        local_dsn(f"host={socket_root},127.0.0.1 port=5432 dbname=ifpmic user=dispatcher password=synthetic")
    assert host_list.value.code == "BUILD_UNAVAILABLE"

    missing = tmp_path / "missing-socket-dir"
    with pytest.raises(ProtocolError) as missing_root:
        local_dsn(f"host={missing} port=5432 dbname=ifpmic user=dispatcher password=synthetic")
    assert missing_root.value.code == "BUILD_UNAVAILABLE"

    monkeypatch.setenv("PGHOST", str(socket_root))
    with pytest.raises(ProtocolError) as ambient:
        local_dsn(dsn)
    assert ambient.value.code == "BUILD_UNAVAILABLE"
