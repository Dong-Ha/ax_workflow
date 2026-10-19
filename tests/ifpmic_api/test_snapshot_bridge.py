"""G2 real Node/Python snapshot bridge and catalog tests.

The Node bridge reuses B01; this file supplies fixed boundary values and does
not canonicalize production profile data as part of the application path.
"""

from __future__ import annotations

import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys

import psycopg
import pytest
from psycopg.conninfo import make_conninfo

from services.ifpmic_api.catalog import CatalogError, import_snapshot
from services.ifpmic_api.migrate import apply_migrations
from services.ifpmic_api.snapshot_bridge import (
    BridgeError,
    PROTOCOL,
    RECORD_LIMIT,
    SCRIPT_PATH,
    STDERR_LIMIT,
    STDIN_LIMIT,
    STDOUT_LIMIT,
    SnapshotBridge,
    SnapshotRecord,
    decode_frame,
)


ROOT = Path(__file__).resolve().parents[2]
NODE = shutil.which("node")
PROJECT_ID = "tc-fixed-project"
VECTOR_VERSION = "vector-v1"
VECTOR_VERSION_KEY = "38587a1d8351cc6a462f28bc25b7b2eee078e2831419ddead0c3d89e0cb5c6f8"
VECTOR_SNAPSHOT_ID = "0e2e6287ec5cfc0a089ac3badaeedc5215e3e5349a4157e8e9df41c346f1d2bf"
VECTOR_PROFILE_SHA256 = "8d6632e906c695020020b37c7c970f7dbd1515a5b5de27c60487198656d139a7"
VECTOR_BUNDLE_SHA256 = "83146f468cc425fc5851e179a24781ed4ca62babb5d219b2a95f153d8a0bf873"
ASTRAL_VERSION_KEY = "83cc4cd836538a093bf40b7c5f25a5fc84a9f408f282169df5c41e237023958b"
LONE_SURROGATE_VERSION_KEY = "10dfdff4a6fdeee221ca84f6bcea7b06ba8d7689865ff29da30b202a93be064b"

SEED_SCRIPT = r"""
import { pathToFileURL } from 'node:url';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const root = process.cwd();
const { validProfile } = await import(pathToFileURL(`${root}/tests/helpers/ifpmic-profile-fixtures.mjs`));
const { createSnapshot } = await import(pathToFileURL(`${root}/runtime/ifpmic/snapshot.mjs`));
const { initStore, publishSnapshot } = await import(pathToFileURL(`${root}/runtime/ifpmic/store.mjs`));
const profile = structuredClone(validProfile);
if (input.changed_profile) profile.release.version = '9.9.9';
function assignPath(path, value) {
  let target = profile;
  for (const part of path.slice(0, -1)) target = target[part];
  target[path[path.length - 1]] = value;
}
for (const [path, value] of input.marker_fields ?? []) assignPath(path, value);
for (const path of input.empty_array_fields ?? []) assignPath(path, []);
const profileText = JSON.stringify(profile);
await initStore(input.store_root);
let record;
try { record = createSnapshot({ profileText, profileVersion: input.profile_version }); }
catch (error) {
  process.stdout.write(JSON.stringify({ error: { code: error?.code ?? 'SEED_FAILED' } }) + '\n');
  process.exitCode = 2;
}
if (record) {
  await publishSnapshot(input.store_root, record);
  process.stdout.write(JSON.stringify({ seeded: true, snapshot_id: record.snapshot_id }) + '\n');
}
"""


def _run(coro):
    return asyncio.run(coro)


def _seed_store(store_root: Path, profile_version: str = VECTOR_VERSION, *, changed_profile: bool = False,
                marker_fields=(), empty_array_fields=(), expected_error=None):
    if NODE is None:
        pytest.fail("Node executable is required for G2 real-child tests")
    result = subprocess.run(
        [NODE, "--input-type=module", "--eval", SEED_SCRIPT],
        cwd=ROOT,
        input=json.dumps(
            {"store_root": str(store_root), "profile_version": profile_version, "changed_profile": changed_profile,
             "marker_fields": marker_fields, "empty_array_fields": empty_array_fields},
            ensure_ascii=True,
            separators=(",", ":"),
        ).encode("ascii"),
        capture_output=True,
        timeout=30,
        check=False,
    )
    if expected_error is not None:
        assert result.returncode == 2, f"fixed B01 boundary seed exit={result.returncode}"
        assert result.stderr == b""
        assert result.stdout.endswith(b"\n") and result.stdout.count(b"\n") == 1
        assert json.loads(result.stdout) == {"error": {"code": expected_error}}
        return None
    assert result.returncode == 0, f"fixed B01 seed subprocess exit={result.returncode}"
    assert result.stderr == b""
    assert result.stdout.endswith(b"\n") and result.stdout.count(b"\n") == 1
    return json.loads(result.stdout)


@pytest.fixture
def vector_store(tmp_path):
    store = tmp_path / "snapshots"
    seeded = _seed_store(store)
    assert seeded["snapshot_id"] == VECTOR_SNAPSHOT_ID
    return store


def _bridge(store_root: Path, *, timeout=10, max_active=4, max_queued=16):
    assert NODE is not None
    return SnapshotBridge(
        node_executable=NODE,
        store_root=store_root,
        script_path=SCRIPT_PATH,
        timeout=timeout,
        max_active=max_active,
        max_queued=max_queued,
    )


def _frame(raw: bytes, *, project_id=PROJECT_ID, profile_version=VECTOR_VERSION, **changes) -> bytes:
    frame = {
        "protocol": "ifpmic.snapshot-bridge.v1",
        "record_base64": base64.b64encode(raw).decode("ascii"),
        "record_bytes_sha256": hashlib.sha256(raw).hexdigest(),
        "version_key": VECTOR_VERSION_KEY,
    }
    frame.update(changes)
    return (json.dumps(frame, ensure_ascii=True, separators=(",", ":")) + "\n").encode("ascii")


def _mutated_record_bytes(raw: bytes, mutation) -> bytes:
    record = json.loads(raw)
    mutation(record)
    return (json.dumps(record, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")


def test_real_node_bridge_returns_fixed_b01_golden_and_exact_store_bytes(vector_store):
    record = _run(_bridge(vector_store).read_snapshot(PROJECT_ID, VECTOR_VERSION))
    version_path = vector_store / f"{VECTOR_VERSION_KEY}.snapshot.json"
    stored_bytes = version_path.read_bytes()

    assert isinstance(record, SnapshotRecord)
    assert record.project_id == PROJECT_ID
    assert record.profile_version == VECTOR_VERSION
    assert record.profile_version_json == '"vector-v1"'
    assert record.version_key == VECTOR_VERSION_KEY
    assert record.snapshot_id == VECTOR_SNAPSHOT_ID
    assert record.workflow_id == "ifpmic-sw-v1"
    assert record.workflow == {
        "workflow_id": "ifpmic-sw-v1",
        "schema_version": "1.0.0",
        "source_sha256": "bab40a7abb3929896add1ef2cd074893dd2a7de14d200a5d6cea4b7a77eb0e89",
        "state_source_sha256": "0248e130017043539319c56af854f5388a95d33e7e687902a3438fdff414244a",
        "agent_source_sha256": "ca6d4bea7abf0fffe7354c482af0d521c3a2e367217a69923a4bfe43fa27ab64",
        "bundle_sha256": VECTOR_BUNDLE_SHA256,
    }
    if record.record_bytes != stored_bytes:
        pytest.fail("bridge raw snapshot bytes differ from the immutable store bytes")
    assert len(record.record_bytes) <= 2 * 1024 * 1024
    assert record.record_bytes.endswith(b"\n") and record.record_bytes.count(b"\n") == 1
    assert record.record_bytes_sha256 == hashlib.sha256(stored_bytes).hexdigest()
    assert record.mode == "real" and record.enabled is True and record.configuration_complete is True
    with pytest.raises((AttributeError, TypeError)):
        record.snapshot_id = "0" * 64


def test_bridge_preserves_astral_and_lone_surrogate_profile_versions(vector_store, tmp_path):
    astral = "😀"
    astral_store = tmp_path / "astral-store"
    _seed_store(astral_store, astral)
    astral_record = _run(_bridge(astral_store).read_snapshot(PROJECT_ID, astral))
    assert astral_record.profile_version == astral
    assert astral_record.version_key == ASTRAL_VERSION_KEY
    assert astral_record.profile_version_json == '"\\ud83d\\ude00"'
    assert astral_record.profile_version_json.isascii()
    assert astral.encode("utf-8") in astral_record.record_bytes

    lone_surrogate = "\ud800"
    surrogate_store = tmp_path / "surrogate-store"
    _seed_store(surrogate_store, lone_surrogate)
    surrogate_record = _run(_bridge(surrogate_store).read_snapshot(PROJECT_ID, lone_surrogate))
    assert surrogate_record.profile_version == lone_surrogate
    assert surrogate_record.version_key == LONE_SURROGATE_VERSION_KEY
    assert surrogate_record.profile_version_json == '"\\ud800"'
    assert surrogate_record.profile_version_json.isascii()
    assert b"\\ud800" in surrogate_record.record_bytes


def test_configuration_completeness_checks_all_six_sections_markers_and_nested_empty_arrays(tmp_path):
    marker_store = tmp_path / "marker-store"
    _seed_store(
        marker_store,
        marker_fields=(
            (("source", "repository_ref"), "CONFIGURE"),
            (("runtimes", "provider_profile_ref"), "APPROVED_BEDROCK_PROFILE"),
            (("build", "profile_ref"), "PIN_AFTER_COMPATIBILITY_TEST"),
            (("quality", "sam", "program_ref"), "INTERNAL_EXISTING_RULES"),
            (("device", "device_id"), "device-configured"),
            (("release", "version"), "release-configured"),
        ),
    )
    marker_record = _run(_bridge(marker_store).read_snapshot(PROJECT_ID, VECTOR_VERSION))
    assert marker_record.mode == "real" and marker_record.enabled is True
    assert marker_record.configuration_complete is False

    empty_store = tmp_path / "empty-array-store"
    _seed_store(
        empty_store,
        empty_array_fields=(
            ("source", "driver_paths"), ("source", "test_paths"),
            ("build", "artifact_patterns"), ("device", "sqe_expected_cases"),
            ("release", "reviewers"),
        ),
    )
    empty_record = _run(_bridge(empty_store).read_snapshot(PROJECT_ID, VECTOR_VERSION))
    assert empty_record.configuration_complete is False

    valid_store = tmp_path / "complete-store"
    _seed_store(valid_store)
    valid_record = _run(_bridge(valid_store).read_snapshot(PROJECT_ID, VECTOR_VERSION))
    assert valid_record.configuration_complete is True


def test_node_bridge_uses_exact_private_request_and_rejects_untrusted_request_shape(vector_store):
    assert NODE is not None
    expected_request = (
        b'{"protocol":"ifpmic.snapshot-bridge.v1","operation":"read_snapshot",'
        b'"project_id":"tc-fixed-project","profile_version":"vector-v1"}\n'
    )
    completed = subprocess.run(
        [NODE, str(SCRIPT_PATH), str(vector_store)],
        cwd=ROOT,
        input=expected_request,
        capture_output=True,
        timeout=10,
        check=False,
    )
    assert completed.returncode == 0 and completed.stderr == b""
    assert completed.stdout.endswith(b"\n") and completed.stdout.count(b"\n") == 1
    frame = json.loads(completed.stdout)
    assert set(frame) == {"protocol", "record_base64", "record_bytes_sha256", "version_key"}
    assert frame["protocol"] == "ifpmic.snapshot-bridge.v1"
    assert frame["version_key"] == VECTOR_VERSION_KEY

    invalid_requests = [
        b'{"protocol":"wrong","operation":"read_snapshot","project_id":"tc-fixed-project","profile_version":"vector-v1"}',
        b'{"protocol":"ifpmic.snapshot-bridge.v1","operation":"publish_snapshot","project_id":"tc-fixed-project","profile_version":"vector-v1"}',
        b'{"protocol":"ifpmic.snapshot-bridge.v1","operation":"read_snapshot","project_id":"tc-fixed-project","profile_version":"vector-v1","store_root":"/tmp/ATTACKER_PATH"}',
        b'{"protocol":"ifpmic.snapshot-bridge.v1","operation":"read_snapshot","project_id":"tc-fixed-project","project_id":"/tmp/ATTACKER_PATH","profile_version":"vector-v1"}',
        b'{"protocol":"ifpmic.snapshot-bridge.v1","operation":"read_snapshot","project_id":"tc-fixed-project","profile_version":"vector-v1"} {}',
        b'{"protocol":"ifpmic.snapshot-bridge.v1","operation":"read_snapshot","project_id":"tc-fixed-project","profile_version":2}',
        b'\xff',
    ]
    for request in invalid_requests:
        result = subprocess.run(
            [NODE, str(SCRIPT_PATH), str(vector_store)], cwd=ROOT, input=request,
            capture_output=True, timeout=10, check=False,
        )
        assert result.returncode != 0
        assert result.stderr == b""
        assert result.stdout.endswith(b"\n") and result.stdout.count(b"\n") == 1
        assert json.loads(result.stdout) == {"error": {"code": "BRIDGE_INVALID_REQUEST"}}
        assert b"ATTACKER_PATH" not in result.stdout + result.stderr

    # The fixed Node reader allows JSON trailing whitespace, so the exact byte
    # ceiling can be exercised without changing the request's meaning.
    exact_limit = expected_request[:-1] + b" " * (STDIN_LIMIT - len(expected_request)) + b"\n"
    assert len(exact_limit) == STDIN_LIMIT
    at_limit = subprocess.run(
        [NODE, str(SCRIPT_PATH), str(vector_store)], cwd=ROOT, input=exact_limit,
        capture_output=True, timeout=30, check=False,
    )
    assert at_limit.returncode == 0 and at_limit.stderr == b""
    assert at_limit.stdout.endswith(b"\n") and at_limit.stdout.count(b"\n") == 1
    one_over = expected_request[:-1] + b" " * (STDIN_LIMIT + 1 - len(expected_request)) + b"\n"
    assert len(one_over) == STDIN_LIMIT + 1
    over_limit = subprocess.run(
        [NODE, str(SCRIPT_PATH), str(vector_store)], cwd=ROOT, input=one_over,
        capture_output=True, timeout=30, check=False,
    )
    assert over_limit.returncode != 0
    assert over_limit.stderr == b""
    assert json.loads(over_limit.stdout) == {"error": {"code": "BRIDGE_INVALID_REQUEST"}}


def test_python_input_identity_rejects_invalid_values_before_spawning(vector_store, monkeypatch):
    async def fail_if_spawned(*args, **kwargs):
        raise AssertionError("invalid identity reached child creation")

    import services.ifpmic_api.snapshot_bridge as bridge_module

    monkeypatch.setattr(bridge_module.asyncio, "create_subprocess_exec", fail_if_spawned)
    bridge = _bridge(vector_store)
    for project_id, version in (("", VECTOR_VERSION), ("bad\x00project", VECTOR_VERSION), ("bad\ud800project", VECTOR_VERSION), (PROJECT_ID, ""), (PROJECT_ID, "bad\x7fversion")):
        with pytest.raises(BridgeError) as raised:
            _run(bridge.read_snapshot(project_id, version))
        assert raised.value.code == "BRIDGE_INVALID_REQUEST"
        assert str(raised.value) == "BRIDGE_INVALID_REQUEST"


def test_bridge_rejects_unsupported_platform_runtime_without_child_creation(vector_store, monkeypatch):
    import services.ifpmic_api.snapshot_bridge as bridge_module

    monkeypatch.setattr(bridge_module.sys, "platform", "darwin")
    with pytest.raises(BridgeError) as raised:
        _bridge(vector_store)
    assert raised.value.code == "BRIDGE_UNAVAILABLE"
    assert str(raised.value) == "BRIDGE_UNAVAILABLE"


@pytest.mark.parametrize("kwargs", [
    {"timeout": 0}, {"timeout": 10.001}, {"timeout": True}, {"timeout": float("nan")},
    {"max_active": 0}, {"max_active": 5}, {"max_active": True},
    {"max_queued": -1}, {"max_queued": 17}, {"max_queued": False},
])
def test_bridge_configuration_rejects_outside_fixed_resource_bounds(vector_store, kwargs):
    with pytest.raises(BridgeError) as raised:
        _bridge(vector_store, **kwargs)
    assert raised.value.code == "BRIDGE_INVALID_REQUEST"


def test_python_stdin_limit_is_inclusive_and_astral_json_expansion_is_bounded(vector_store, monkeypatch):
    import services.ifpmic_api.snapshot_bridge as bridge_module

    seen = []

    async def fixed_child_error(*argv, **kwargs):
        child = _FakeChild(b'{"error":{"code":"STORE_INVALID"}}\n', exit_code=2)
        seen.append(child)
        return child

    monkeypatch.setattr(bridge_module.asyncio, "create_subprocess_exec", fixed_child_error)
    base = json.dumps(
        {"protocol": PROTOCOL, "operation": "read_snapshot", "project_id": PROJECT_ID, "profile_version": "v"},
        ensure_ascii=True,
        separators=(",", ":"),
    ).encode("ascii") + b"\n"
    exact_version = "v" * (STDIN_LIMIT - len(base) + 1)
    with pytest.raises(BridgeError) as raised:
        _run(_bridge(vector_store).read_snapshot(PROJECT_ID, exact_version))
    assert raised.value.code == "STORE_INVALID"
    assert seen[0].stdin.closed is True
    assert len(seen[0].stdin.data) == STDIN_LIMIT

    spawn_calls = []

    async def fail_if_spawned(*args, **kwargs):
        spawn_calls.append(True)
        raise AssertionError("over-limit Python request reached child creation")

    monkeypatch.setattr(bridge_module.asyncio, "create_subprocess_exec", fail_if_spawned)
    astral_expanded = "😀" * (STDIN_LIMIT // 12 + 16)
    with pytest.raises(BridgeError) as raised:
        _run(_bridge(vector_store).read_snapshot(PROJECT_ID, astral_expanded))
    assert raised.value.code == "BRIDGE_INVALID_REQUEST"
    assert spawn_calls == []


def test_decode_frame_strict_framing_schema_base64_hash_and_bound_identity(vector_store):
    assert NODE is not None
    request = (
        b'{"protocol":"ifpmic.snapshot-bridge.v1","operation":"read_snapshot",'
        b'"project_id":"tc-fixed-project","profile_version":"vector-v1"}\n'
    )
    result = subprocess.run([NODE, str(SCRIPT_PATH), str(vector_store)], cwd=ROOT, input=request,
                            capture_output=True, timeout=10, check=False)
    assert result.returncode == 0
    valid = result.stdout
    decoded = decode_frame(valid, project_id=PROJECT_ID, profile_version=VECTOR_VERSION)
    assert decoded.snapshot_id == VECTOR_SNAPSHOT_ID
    assert decoded.version_key == VECTOR_VERSION_KEY

    malformed_frames = [
        valid.rstrip(b"\n"),
        valid + b"\n",
        valid.replace(b"\n", b"\r\n"),
        valid + b"{}\n",
        valid.replace(b"record_base64", b"record_b64", 1),
        valid.replace(b"ifpmic.snapshot-bridge.v1", b"wrong", 1),
        valid.replace(b"record_base64\":\"", b"record_base64\":\"!!", 1),
    ]
    duplicate = valid.rstrip(b"\n").replace(b'"protocol":', b'"protocol":"ifpmic.snapshot-bridge.v1","protocol":', 1) + b"\n"
    malformed_frames.append(duplicate)
    for frame in malformed_frames:
        with pytest.raises(BridgeError) as raised:
            decode_frame(frame, project_id=PROJECT_ID, profile_version=VECTOR_VERSION)
        assert raised.value.code == "BRIDGE_PROTOCOL"

    with pytest.raises(BridgeError) as raised:
        decode_frame(valid, project_id="different-project", profile_version=VECTOR_VERSION)
    assert raised.value.code == "BRIDGE_PROTOCOL"
    with pytest.raises(BridgeError) as raised:
        decode_frame(valid, project_id=PROJECT_ID, profile_version="different-version")
    assert raised.value.code == "BRIDGE_PROTOCOL"

    decoded_raw = decoded.record_bytes
    bad_record_frames = [
        _frame(decoded_raw, record_bytes_sha256="0" * 64),
        _frame(decoded_raw, version_key="invalid"),
        _frame(_mutated_record_bytes(decoded_raw, lambda record: record["payload"].update(project_id="attacker"))),
        _frame(_mutated_record_bytes(decoded_raw, lambda record: record["payload"].update(profile_version="other"))),
        _frame(_mutated_record_bytes(decoded_raw, lambda record: record["payload"].update(workflow={"workflow_id": "wrong"}))),
        _frame(_mutated_record_bytes(decoded_raw, lambda record: record["payload"].update(profile_sha256="bad"))),
        _frame(_mutated_record_bytes(decoded_raw, lambda record: record["payload"].update(unknown="extra"))),
    ]
    for frame in bad_record_frames:
        with pytest.raises(BridgeError) as raised:
            decode_frame(frame, project_id=PROJECT_ID, profile_version=VECTOR_VERSION)
        assert raised.value.code == "BRIDGE_PROTOCOL"


def test_decode_frame_enforces_exact_inclusive_raw_and_stdout_limits(vector_store):
    assert NODE is not None
    request = (
        b'{"protocol":"ifpmic.snapshot-bridge.v1","operation":"read_snapshot",'
        b'"project_id":"tc-fixed-project","profile_version":"vector-v1"}\n'
    )
    result = subprocess.run([NODE, str(SCRIPT_PATH), str(vector_store)], cwd=ROOT, input=request,
                            capture_output=True, timeout=10, check=False)
    raw = decode_frame(result.stdout, project_id=PROJECT_ID, profile_version=VECTOR_VERSION).record_bytes
    padded_raw = raw[:-1] + b" " * (RECORD_LIMIT - len(raw)) + b"\n"
    assert len(padded_raw) == RECORD_LIMIT
    accepted = decode_frame(_frame(padded_raw), project_id=PROJECT_ID, profile_version=VECTOR_VERSION)
    assert len(accepted.record_bytes) == RECORD_LIMIT

    one_over_raw = raw[:-1] + b" " * (RECORD_LIMIT + 1 - len(raw)) + b"\n"
    assert len(one_over_raw) == RECORD_LIMIT + 1
    with pytest.raises(BridgeError) as raised:
        decode_frame(_frame(one_over_raw), project_id=PROJECT_ID, profile_version=VECTOR_VERSION)
    assert raised.value.code == "BRIDGE_PROTOCOL"

    json_frame = json.loads(_frame(raw))
    without_lf = (json.dumps(json_frame, separators=(",", ":"))).encode("ascii")
    padded_stdout = without_lf + b" " * (STDOUT_LIMIT - len(without_lf) - 1) + b"\n"
    assert len(padded_stdout) == STDOUT_LIMIT
    assert decode_frame(padded_stdout, project_id=PROJECT_ID, profile_version=VECTOR_VERSION).snapshot_id == VECTOR_SNAPSHOT_ID
    with pytest.raises(BridgeError) as raised:
        decode_frame(padded_stdout + b" ", project_id=PROJECT_ID, profile_version=VECTOR_VERSION)
    assert raised.value.code == "BRIDGE_OUTPUT_LIMIT"


def test_actual_node_record_accepts_exact_two_mib_and_rejects_one_over(vector_store, tmp_path):
    base = (vector_store / f"{VECTOR_VERSION_KEY}.snapshot.json").read_bytes()
    exact_version_length = len(VECTOR_VERSION) + RECORD_LIMIT - len(base)
    assert exact_version_length > len(VECTOR_VERSION)
    exact_version = "v" * exact_version_length
    exact_store = tmp_path / "exact-limit-store"
    seeded = _seed_store(exact_store, exact_version)
    version_key = hashlib.sha256(
        json.dumps([PROJECT_ID, exact_version], ensure_ascii=True, separators=(",", ":")).encode("ascii")
    ).hexdigest()
    record = _run(_bridge(exact_store).read_snapshot(PROJECT_ID, exact_version))
    assert seeded["snapshot_id"] == record.snapshot_id
    assert len(record.record_bytes) == RECORD_LIMIT
    assert record.version_key == version_key
    exact_path = exact_store / f"{version_key}.snapshot.json"
    if exact_path.read_bytes() != record.record_bytes:
        pytest.fail("exact-limit bridge bytes differ from published bytes")

    too_long_store = tmp_path / "over-limit-store"
    _seed_store(too_long_store, exact_version + "v", expected_error="PROFILE_VERSION_INVALID")
    assert too_long_store.is_dir()
    assert list(too_long_store.iterdir()) == []


class _FakeStream:
    def __init__(self, data: bytes, gate: asyncio.Event | None = None):
        self.data = data
        self.gate = gate
        self.reads = 0

    async def read(self, amount: int):
        self.reads += 1
        if self.gate is not None:
            await self.gate.wait()
        if not self.data:
            return b""
        chunk, self.data = self.data[:amount], self.data[amount:]
        return chunk


class _FakeStdin:
    def write(self, data):
        self.data = data

    async def drain(self):
        return None

    def close(self):
        self.closed = True


class _FakeChild:
    def __init__(self, stdout: bytes, stderr: bytes = b"", gate: asyncio.Event | None = None, exit_code: int = 0):
        self.stdin = _FakeStdin()
        self.stdout = _FakeStream(stdout, gate)
        self.stderr = _FakeStream(stderr, gate)
        self.returncode = None
        self.killed = False
        self.waited = False
        self.gate = gate
        self.exit_code = exit_code

    async def wait(self):
        if self.gate is not None:
            await self.gate.wait()
        self.returncode = self.exit_code if not self.killed else -9
        self.waited = True
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9
        if self.gate is not None:
            self.gate.set()


def _valid_frame_for_fake():
    payload = {
        "format": "ifpmic.profile-snapshot.v1",
        "canonicalization": "ifpmic-json-v1",
        "project_id": PROJECT_ID,
        "profile_version": VECTOR_VERSION,
        "workflow": {
            "workflow_id": "ifpmic-sw-v1", "schema_version": "1.0.0",
            "source_sha256": "bab40a7abb3929896add1ef2cd074893dd2a7de14d200a5d6cea4b7a77eb0e89",
            "state_source_sha256": "0248e130017043539319c56af854f5388a95d33e7e687902a3438fdff414244a",
            "agent_source_sha256": "ca6d4bea7abf0fffe7354c482af0d521c3a2e367217a69923a4bfe43fa27ab64",
            "bundle_sha256": VECTOR_BUNDLE_SHA256,
        },
        "profile_sha256": VECTOR_PROFILE_SHA256,
        "profile": {
            "project_id": PROJECT_ID, "mode": "real", "enabled": True,
            "source": {"repository_ref": "r", "base_ref": "b", "driver_paths": ["d"], "test_paths": ["t"]},
            "runtimes": {"primary": "p", "secondary": "s", "provider_profile_ref": "x", "model_id": "m", "versions": {"x": "1"}},
            "build": {"profile_ref": "x", "toolchain_digest": "x"},
            "quality": {"sam": {"program_ref": "x"}, "tem": {"program_ref": "x"}, "static": {"program_ref": "x"}},
            "device": {"device_id": "x"}, "release": {"mode": "team_github_tag"},
        },
    }
    raw = (json.dumps({"snapshot_id": VECTOR_SNAPSHOT_ID, "payload": payload}, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")
    return raw, _frame(raw)


def test_stderr_byte_limit_and_fixed_subprocess_argv(vector_store, monkeypatch):
    import services.ifpmic_api.snapshot_bridge as bridge_module

    raw, valid = _valid_frame_for_fake()
    seen = []

    async def fake_spawn(*argv, **kwargs):
        seen.append((argv, kwargs))
        return _FakeChild(valid, b"S" * STDERR_LIMIT)

    monkeypatch.setattr(bridge_module.asyncio, "create_subprocess_exec", fake_spawn)
    record = _run(_bridge(vector_store).read_snapshot(PROJECT_ID, VECTOR_VERSION))
    assert record.snapshot_id == VECTOR_SNAPSHOT_ID
    assert seen and seen[0][0] == (str(Path(NODE).resolve()), str(SCRIPT_PATH.resolve()), str(vector_store.resolve()))
    assert "shell" not in seen[0][1]
    assert seen[0][1]["stdin"] == asyncio.subprocess.PIPE
    assert seen[0][1]["stdout"] == asyncio.subprocess.PIPE
    assert seen[0][1]["stderr"] == asyncio.subprocess.PIPE

    async def too_much_stderr(*argv, **kwargs):
        return _FakeChild(valid, b"S" * (STDERR_LIMIT + 1))

    monkeypatch.setattr(bridge_module.asyncio, "create_subprocess_exec", too_much_stderr)
    with pytest.raises(BridgeError) as raised:
        _run(_bridge(vector_store).read_snapshot(PROJECT_ID, VECTOR_VERSION))
    assert raised.value.code == "BRIDGE_OUTPUT_LIMIT"

    async def too_much_stdout(*argv, **kwargs):
        return _FakeChild(valid + b" " * (STDOUT_LIMIT + 1))

    monkeypatch.setattr(bridge_module.asyncio, "create_subprocess_exec", too_much_stdout)
    with pytest.raises(BridgeError) as raised:
        _run(_bridge(vector_store).read_snapshot(PROJECT_ID, VECTOR_VERSION))
    assert raised.value.code == "BRIDGE_OUTPUT_LIMIT"


def test_child_errors_are_allowlisted_and_unknown_errors_are_sanitized(vector_store, monkeypatch):
    import services.ifpmic_api.snapshot_bridge as bridge_module

    async def fixed_error(*argv, **kwargs):
        return _FakeChild(b'{"error":{"code":"SNAPSHOT_CORRUPT"}}\n', exit_code=2)

    monkeypatch.setattr(bridge_module.asyncio, "create_subprocess_exec", fixed_error)
    with pytest.raises(BridgeError) as raised:
        _run(_bridge(vector_store).read_snapshot(PROJECT_ID, VECTOR_VERSION))
    assert raised.value.code == "SNAPSHOT_CORRUPT"
    assert str(raised.value) == "SNAPSHOT_CORRUPT"

    async def unknown_error(*argv, **kwargs):
        return _FakeChild(b'{"error":{"code":"/tmp/PRIVATE_PATH"}}\n', exit_code=2)

    monkeypatch.setattr(bridge_module.asyncio, "create_subprocess_exec", unknown_error)
    with pytest.raises(BridgeError) as raised:
        _run(_bridge(vector_store).read_snapshot(PROJECT_ID, VECTOR_VERSION))
    assert raised.value.code == "BRIDGE_UNAVAILABLE"
    assert "/tmp/PRIVATE_PATH" not in str(raised.value)


def test_real_node_fixed_store_error_and_spawn_error_are_sanitized(vector_store, tmp_path, monkeypatch):
    missing_store = tmp_path / "missing-store"
    with pytest.raises(BridgeError) as raised:
        _run(_bridge(missing_store).read_snapshot(PROJECT_ID, VECTOR_VERSION))
    assert raised.value.code == "STORE_INVALID"
    assert str(raised.value) == "STORE_INVALID"

    import services.ifpmic_api.snapshot_bridge as bridge_module

    async def private_spawn_failure(*argv, **kwargs):
        raise OSError("SPAWN_PRIVATE_CANARY")

    monkeypatch.setattr(bridge_module.asyncio, "create_subprocess_exec", private_spawn_failure)
    with pytest.raises(BridgeError) as raised:
        _run(_bridge(vector_store).read_snapshot(PROJECT_ID, VECTOR_VERSION))
    assert raised.value.code == "BRIDGE_UNAVAILABLE"
    assert "SPAWN_PRIVATE_CANARY" not in str(raised.value)


def test_timeout_kills_reaps_child_and_capacity_is_released(vector_store, monkeypatch):
    import services.ifpmic_api.snapshot_bridge as bridge_module

    _, valid = _valid_frame_for_fake()
    children = []
    gates = []

    async def blocked_spawn(*argv, **kwargs):
        gate = asyncio.Event()
        child = _FakeChild(valid, gate=gate)
        children.append(child)
        gates.append(gate)
        return child

    monkeypatch.setattr(bridge_module.asyncio, "create_subprocess_exec", blocked_spawn)
    bridge = _bridge(vector_store, timeout=0.02, max_active=1, max_queued=0)

    async def scenario():
        with pytest.raises(BridgeError) as raised:
            await bridge.read_snapshot(PROJECT_ID, VECTOR_VERSION)
        assert raised.value.code == "BRIDGE_TIMEOUT"
        assert len(children) == 1
        assert children[0].killed is True and children[0].waited is True
        # The failed child released its slot; a later request reaches spawn too.
        with pytest.raises(BridgeError):
            await bridge.read_snapshot(PROJECT_ID, VECTOR_VERSION)
        assert len(children) == 2
        assert children[1].killed is True and children[1].waited is True

    _run(scenario())


def test_cancellation_during_spawn_waits_for_handle_then_kills_and_reaps(vector_store, monkeypatch):
    import services.ifpmic_api.snapshot_bridge as bridge_module

    _, valid = _valid_frame_for_fake()
    spawn_started = asyncio.Event()
    release_spawn = asyncio.Event()
    child = _FakeChild(valid)

    cancellation_seen = asyncio.Event()

    async def spawn_race(*argv, **kwargs):
        spawn_started.set()
        try:
            await release_spawn.wait()
        except asyncio.CancelledError:
            # Model the subprocess-transport race where cancellation arrives
            # during pipe setup but setup still returns its process handle.
            cancellation_seen.set()
            await release_spawn.wait()
        return child

    monkeypatch.setattr(bridge_module.asyncio, "create_subprocess_exec", spawn_race)

    async def scenario():
        request = asyncio.create_task(_bridge(vector_store).read_snapshot(PROJECT_ID, VECTOR_VERSION))
        await spawn_started.wait()
        request.cancel()
        await cancellation_seen.wait()
        assert not child.killed
        request.cancel()
        release_spawn.set()
        try:
            await request
        except asyncio.CancelledError:
            pass
        else:
            pytest.fail("cancelled bridge request returned normally")
        assert child.killed is True
        assert child.stdin.closed is True
        assert child.waited is True

    _run(scenario())


def test_deadline_during_spawn_waits_for_handle_then_kills_and_reaps(vector_store, monkeypatch):
    import services.ifpmic_api.snapshot_bridge as bridge_module

    _, valid = _valid_frame_for_fake()
    spawn_started = asyncio.Event()
    cancellation_seen = asyncio.Event()
    release_spawn = asyncio.Event()
    child = _FakeChild(valid)

    async def spawn_race(*argv, **kwargs):
        spawn_started.set()
        try:
            await release_spawn.wait()
        except asyncio.CancelledError:
            cancellation_seen.set()
            await release_spawn.wait()
        return child

    monkeypatch.setattr(bridge_module.asyncio, "create_subprocess_exec", spawn_race)
    bridge = _bridge(vector_store, timeout=0.02)

    async def scenario():
        request = asyncio.create_task(bridge.read_snapshot(PROJECT_ID, VECTOR_VERSION))
        await spawn_started.wait()
        await cancellation_seen.wait()
        assert not child.killed
        release_spawn.set()
        with pytest.raises(BridgeError) as raised:
            await request
        assert raised.value.code == "BRIDGE_TIMEOUT"
        assert child.killed is True
        assert child.stdin.closed is True
        assert child.waited is True

    _run(scenario())


@pytest.mark.parametrize("stream_name,source", [
    ("stdout", "process.stdout.write(Buffer.alloc(4 * 1024 * 1024, 65));"),
    ("stderr", "process.stderr.write(Buffer.alloc(4097, 66));"),
])
def test_real_child_output_overflow_is_killed_and_reaped(vector_store, tmp_path, stream_name, source, monkeypatch):
    assert NODE is not None
    import services.ifpmic_api.snapshot_bridge as bridge_module

    script = tmp_path / f"burst-{stream_name}.mjs"
    script.write_text(source + "\n", encoding="ascii")
    original_spawn = bridge_module.asyncio.create_subprocess_exec
    children = []

    async def recording_spawn(*args, **kwargs):
        child = await original_spawn(*args, **kwargs)
        children.append(child)
        return child

    monkeypatch.setattr(bridge_module.asyncio, "create_subprocess_exec", recording_spawn)
    bridge = SnapshotBridge(NODE, vector_store, script_path=script, timeout=5)
    with pytest.raises(BridgeError) as raised:
        _run(bridge.read_snapshot(PROJECT_ID, VECTOR_VERSION))
    assert raised.value.code == "BRIDGE_OUTPUT_LIMIT"
    assert len(children) == 1 and children[0].returncode is not None
    with pytest.raises(ProcessLookupError):
        os.kill(children[0].pid, 0)


def test_real_child_timeout_reaps_process(vector_store, tmp_path, monkeypatch):
    assert NODE is not None
    import services.ifpmic_api.snapshot_bridge as bridge_module

    script = tmp_path / "sleep.mjs"
    script.write_text("setInterval(() => {}, 1000);\n", encoding="ascii")
    original_spawn = bridge_module.asyncio.create_subprocess_exec
    children = []

    async def recording_spawn(*args, **kwargs):
        child = await original_spawn(*args, **kwargs)
        children.append(child)
        return child

    monkeypatch.setattr(bridge_module.asyncio, "create_subprocess_exec", recording_spawn)
    bridge = SnapshotBridge(NODE, vector_store, script_path=script, timeout=0.1)
    with pytest.raises(BridgeError) as raised:
        _run(bridge.read_snapshot(PROJECT_ID, VECTOR_VERSION))
    assert raised.value.code == "BRIDGE_TIMEOUT"
    assert len(children) == 1
    assert children[0].returncode is not None
    with pytest.raises(ProcessLookupError):
        os.kill(children[0].pid, 0)


def _cli_env(*, node=None, store=None, dsn=None):
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "PYTHONPATH": str(ROOT),
        "LANG": "C.UTF-8",
    }
    if node is not None:
        env["IFPMIC_NODE_EXECUTABLE"] = str(node)
    if store is not None:
        env["IFPMIC_PROFILE_STORE"] = str(store)
    if dsn is not None:
        env["IFPMIC_OPERATOR_DSN"] = dsn
    return env


def _run_catalog_cli(payload: bytes, *, env, args=()):
    return subprocess.run(
        [sys.executable, "-m", "services.ifpmic_api.catalog", *args],
        cwd=ROOT,
        env=env,
        input=payload,
        capture_output=True,
        timeout=30,
        check=False,
    )


def _assert_cli_json(result, *, exit_code, expected):
    assert result.returncode == exit_code
    assert result.stderr == b""
    assert result.stdout.endswith(b"\n") and result.stdout.count(b"\n") == 1
    assert json.loads(result.stdout) == expected


def test_operator_cli_imports_idempotently_and_never_returns_profile_or_dsn(vector_store, pg_cluster, migration_db):
    with psycopg.connect(migration_db.owner_dsn(pg_cluster), autocommit=True) as owner:
        apply_migrations(owner, runtime_role=migration_db.roles.runtime, operator_role=migration_db.roles.operator,
                        dispatcher_role=migration_db.roles.dispatcher, projector_role=migration_db.roles.projector)
    with psycopg.connect(migration_db.operator_dsn(pg_cluster)) as operator:
        operator.execute("INSERT INTO ifpmic.projects(project_id) VALUES(%s)", (PROJECT_ID,))
        operator.commit()

    sentinel_dsn = "DSN_PRIVATE_CANARY_63e4d9"
    dsn = make_conninfo(migration_db.operator_dsn(pg_cluster), application_name=sentinel_dsn)
    env = _cli_env(node=NODE, store=vector_store, dsn=dsn)
    request = json.dumps({"project_id": PROJECT_ID, "profile_version": VECTOR_VERSION}, separators=(",", ":")).encode() + b"\n"
    exact_request = request[:-1] + b" " * (STDIN_LIMIT - len(request)) + b"\n"
    assert len(exact_request) == STDIN_LIMIT
    expected_first = {"imported": True, "snapshot_id": VECTOR_SNAPSHOT_ID, "version_key": VECTOR_VERSION_KEY}
    expected_second = {"imported": False, "snapshot_id": VECTOR_SNAPSHOT_ID, "version_key": VECTOR_VERSION_KEY}
    first = _run_catalog_cli(exact_request, env=env)
    _assert_cli_json(first, exit_code=0, expected=expected_first)
    second = _run_catalog_cli(request, env=env)
    _assert_cli_json(second, exit_code=0, expected=expected_second)
    assert sentinel_dsn.encode() not in first.stdout + first.stderr + second.stdout + second.stderr
    assert b'"record_bytes"' not in first.stdout + second.stdout
    assert b'"profile"' not in first.stdout + second.stdout
    with psycopg.connect(migration_db.owner_dsn(pg_cluster)) as owner:
        assert owner.execute(
            "SELECT count(*) FROM ifpmic.profile_catalog WHERE project_id=%s AND version_key=%s",
            (PROJECT_ID, VECTOR_VERSION_KEY),
        ).fetchone() == (1,)
        assert owner.execute(
            "SELECT count(*) FROM ifpmic.profile_eligibility WHERE project_id=%s",
            (PROJECT_ID,),
        ).fetchone() == (0,)

@pytest.mark.parametrize("missing_name", [
    "IFPMIC_NODE_EXECUTABLE", "IFPMIC_PROFILE_STORE", "IFPMIC_OPERATOR_DSN",
])
def test_operator_cli_missing_configuration_is_fixed_and_sanitized(vector_store, pg_cluster, migration_db, missing_name):
    env = _cli_env(node=NODE, store=vector_store, dsn=migration_db.operator_dsn(pg_cluster))
    env.pop(missing_name)
    canary = "CONFIG_PRIVATE_CANARY"
    env["IFPMIC_PROFILE_STORE"] = canary if missing_name != "IFPMIC_PROFILE_STORE" else str(vector_store)
    result = _run_catalog_cli(b'{"project_id":"tc-fixed-project","profile_version":"vector-v1"}\n', env=env, args=(canary,))
    _assert_cli_json(result, exit_code=2, expected={"error": {"code": "CATALOG_CONFIG_INVALID"}})
    assert canary.encode() not in result.stdout + result.stderr


@pytest.mark.parametrize("payload", [
    b'{"project_id":"tc-fixed-project","profile_version":"vector-v1","store_root":"/tmp/ATTACKER_PATH"}\n',
    b'{"project_id":"tc-fixed-project","project_id":"/tmp/ATTACKER_PATH","profile_version":"vector-v1"}\n',
    b'{"project_id":"tc-fixed-project","profile_version":2}\n',
    b'{"project_id":"tc-fixed-project","profile_version":"vector-v1"} {}\n',
    b'\xff\n',
])
def test_operator_cli_rejects_untrusted_request_shapes_without_echo(payload, vector_store, pg_cluster, migration_db):
    env = _cli_env(node=NODE, store=vector_store, dsn=migration_db.operator_dsn(pg_cluster))
    result = _run_catalog_cli(payload, env=env)
    _assert_cli_json(result, exit_code=2, expected={"error": {"code": "CATALOG_REQUEST_INVALID"}})
    assert b"ATTACKER_PATH" not in result.stdout + result.stderr


def test_operator_cli_rejects_oversized_request_without_raw_input_echo(vector_store, pg_cluster, migration_db):
    env = _cli_env(node=NODE, store=vector_store, dsn=migration_db.operator_dsn(pg_cluster))
    canary = "OVERSIZE_PRIVATE_CANARY"
    base = json.dumps(
        {"project_id": PROJECT_ID, "profile_version": canary}, separators=(",", ":")
    ).encode("ascii") + b"\n"
    payload = base[:-1] + b" " * (STDIN_LIMIT + 1 - len(base)) + b"\n"
    assert len(payload) == STDIN_LIMIT + 1
    result = _run_catalog_cli(payload, env=env)
    _assert_cli_json(result, exit_code=2, expected={"error": {"code": "CATALOG_REQUEST_INVALID"}})
    assert canary.encode() not in result.stdout + result.stderr


def test_four_active_sixteen_queued_and_next_call_is_busy(vector_store, monkeypatch):
    import services.ifpmic_api.snapshot_bridge as bridge_module

    _, valid = _valid_frame_for_fake()
    gate = asyncio.Event()
    children = []

    async def blocked_spawn(*argv, **kwargs):
        child = _FakeChild(valid, gate=gate)
        children.append(child)
        return child

    monkeypatch.setattr(bridge_module.asyncio, "create_subprocess_exec", blocked_spawn)
    bridge = _bridge(vector_store, timeout=10, max_active=4, max_queued=16)

    async def scenario():
        tasks = [asyncio.create_task(bridge.read_snapshot(PROJECT_ID, VECTOR_VERSION)) for _ in range(20)]
        await asyncio.sleep(0.05)
        assert len(children) == 4
        with pytest.raises(BridgeError) as raised:
            await bridge.read_snapshot(PROJECT_ID, VECTOR_VERSION)
        assert raised.value.code == "BRIDGE_BUSY"
        gate.set()
        records = await asyncio.gather(*tasks)
        assert len(records) == 20 and all(row.snapshot_id == VECTOR_SNAPSHOT_ID for row in records)
        assert len(children) == 20
        assert all(child.waited for child in children)

    _run(scenario())


def test_import_catalog_is_byte_exact_idempotent_conflict_safe_and_never_grants(vector_store, tmp_path, pg_cluster, migration_db):
    with psycopg.connect(migration_db.owner_dsn(pg_cluster), autocommit=True) as connection:
        apply_migrations(connection, runtime_role=migration_db.roles.runtime, operator_role=migration_db.roles.operator,
                          dispatcher_role=migration_db.roles.dispatcher, projector_role=migration_db.roles.projector)
    record = _run(_bridge(vector_store).read_snapshot(PROJECT_ID, VECTOR_VERSION))

    with psycopg.connect(migration_db.operator_dsn(pg_cluster)) as operator:
        operator.execute("INSERT INTO ifpmic.projects(project_id) VALUES(%s)", (PROJECT_ID,))
        operator.commit()
        first = import_snapshot(operator, record)
        second = import_snapshot(operator, record)
    assert first == {"imported": True, "snapshot_id": VECTOR_SNAPSHOT_ID, "version_key": VECTOR_VERSION_KEY}
    assert second == {"imported": False, "snapshot_id": VECTOR_SNAPSHOT_ID, "version_key": VECTOR_VERSION_KEY}

    with psycopg.connect(migration_db.owner_dsn(pg_cluster)) as owner:
        stored = owner.execute(
            "SELECT project_id,version_key,snapshot_id,record_bytes,record_bytes_sha256,profile_version_json,mode,enabled,configuration_complete "
            "FROM ifpmic.profile_catalog WHERE project_id=%s AND version_key=%s",
            (PROJECT_ID, VECTOR_VERSION_KEY),
        ).fetchone()
        assert stored[:3] == (PROJECT_ID, VECTOR_VERSION_KEY, VECTOR_SNAPSHOT_ID)
        if stored[3] != record.record_bytes:
            pytest.fail("catalog raw snapshot bytes differ from the bridge DTO")
        assert stored[4:] == (record.record_bytes_sha256, '"vector-v1"', "real", True, True)
        assert owner.execute("SELECT count(*) FROM ifpmic.profile_eligibility WHERE project_id=%s", (PROJECT_ID,)).fetchone() == (0,)

    with psycopg.connect(migration_db.operator_dsn(pg_cluster)) as operator:
        with operator.transaction():
            with pytest.raises(CatalogError) as raised:
                import_snapshot(operator, record)
            assert raised.value.code == "CATALOG_TRANSACTION_ACTIVE"
        assert operator.info.transaction_status.name == "IDLE"

    changed_store = tmp_path / "changed-profile-store"
    _seed_store(changed_store, VECTOR_VERSION, changed_profile=True)
    changed = _run(_bridge(changed_store).read_snapshot(PROJECT_ID, VECTOR_VERSION))
    assert changed.version_key == VECTOR_VERSION_KEY
    assert changed.snapshot_id != VECTOR_SNAPSHOT_ID
    with psycopg.connect(migration_db.operator_dsn(pg_cluster)) as operator:
        with pytest.raises(CatalogError) as raised:
            import_snapshot(operator, changed)
        assert raised.value.code == "PROFILE_VERSION_CONFLICT"
        operator.rollback()
    with psycopg.connect(migration_db.owner_dsn(pg_cluster)) as owner:
        assert owner.execute(
            "SELECT snapshot_id,record_bytes FROM ifpmic.profile_catalog WHERE project_id=%s AND version_key=%s",
            (PROJECT_ID, VECTOR_VERSION_KEY),
        ).fetchone()[0] == VECTOR_SNAPSHOT_ID
        if owner.execute(
            "SELECT record_bytes FROM ifpmic.profile_catalog WHERE project_id=%s AND version_key=%s",
            (PROJECT_ID, VECTOR_VERSION_KEY),
        ).fetchone()[0] != record.record_bytes:
            pytest.fail("conflict attempt changed immutable catalog bytes")

    # Python retains the JSON-escaped label while Node's raw canonical record
    # also contains the losslessly escaped lone surrogate bytes.
    surrogate_version = "\ud800"
    surrogate_store = tmp_path / "surrogate-catalog-store"
    _seed_store(surrogate_store, surrogate_version)
    surrogate = _run(_bridge(surrogate_store).read_snapshot(PROJECT_ID, surrogate_version))
    assert surrogate.profile_version_json == '"\\ud800"'
    with psycopg.connect(migration_db.operator_dsn(pg_cluster)) as operator:
        surrogate_import = import_snapshot(operator, surrogate)
    assert surrogate_import["imported"] is True
    with psycopg.connect(migration_db.owner_dsn(pg_cluster)) as owner:
        stored_label, stored_bytes = owner.execute(
            "SELECT profile_version_json,record_bytes FROM ifpmic.profile_catalog WHERE project_id=%s AND version_key=%s",
            (PROJECT_ID, surrogate.version_key),
        ).fetchone()
        assert stored_label == '"\\ud800"'
        if stored_bytes != surrogate.record_bytes:
            pytest.fail("catalog changed surrogate-version snapshot bytes")

    # Concurrent idempotent imports have one insert winner and one exact reuse.
    concurrent_store = tmp_path / "concurrent-catalog-store"
    _seed_store(concurrent_store, "concurrent-v1")
    concurrent_record = _run(_bridge(concurrent_store).read_snapshot(PROJECT_ID, "concurrent-v1"))

    def import_concurrently(_):
        with psycopg.connect(migration_db.operator_dsn(pg_cluster)) as operator:
            return import_snapshot(operator, concurrent_record)["imported"]

    with ThreadPoolExecutor(max_workers=2) as pool:
        concurrent_results = list(pool.map(import_concurrently, range(2)))
    assert sorted(concurrent_results) == [False, True]

    # The runtime DB role cannot use this internal operator primitive to add
    # snapshots; a Python DTO alone does not confer database authority.
    runtime_store = tmp_path / "runtime-denied-store"
    _seed_store(runtime_store, "runtime-denied-v1")
    runtime_record = _run(_bridge(runtime_store).read_snapshot(PROJECT_ID, "runtime-denied-v1"))
    with psycopg.connect(migration_db.runtime_dsn(pg_cluster)) as runtime:
        with pytest.raises(CatalogError) as raised:
            import_snapshot(runtime, runtime_record)
        assert raised.value.code == "CATALOG_IO"
        runtime.rollback()
    with psycopg.connect(migration_db.owner_dsn(pg_cluster)) as owner:
        assert owner.execute(
            "SELECT count(*) FROM ifpmic.profile_catalog WHERE project_id=%s AND version_key=%s",
            (PROJECT_ID, runtime_record.version_key),
        ).fetchone() == (0,)
