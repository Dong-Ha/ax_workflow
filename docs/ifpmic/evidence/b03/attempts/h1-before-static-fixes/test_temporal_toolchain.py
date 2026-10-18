"""H1 qualification tests for the pinned, isolated Temporal toolchain.

These tests never connect to IFPMIC PostgreSQL, Paperclip, or an external
Temporal endpoint. The integration fixture is intentionally synthetic.
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib.metadata
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import socket
import stat
import subprocess
import sys
import time
from typing import Any

import pytest

from scripts.ifpmic_temporal_toolchain import (
    CLI_SHA,
    ToolchainError,
    owned_listeners,
    process_identity,
    start_server,
    stop_all_owned,
    stop_owned,
    verify_binary,
)


EXPECTED_LOCK_SHA256 = "9c6141efe9ccb7cd9a94e3663c2faf9049eb10b883c93f492bb3e46c3a8883f7"
EXPECTED_NORMALIZED_LOCK_SHA256 = "ccbbf7a8aab39cd80861f607afd4994bf461d07cbf592f6acfcc492e63ff85c6"
EXPECTED_README_SHA256 = "0964d4dae840f9a433d88ee92132efedb7e17c77ac815d0e955c6fdbc65c7100"
EXPECTED_CLI_ARCHIVE_SHA256 = "09a0326a51db84d02735e53542b9ebd8c4758daf47482a9ab0abce15844e60d5"
EXPECTED_CLI_SHA256 = "712217694cac9f786a72d4b6c876cd15f3dcf1bf31434d9fed6af25242a327a0"
EXPECTED_PACKAGES = {
    "annotated-doc": "0.0.5",
    "annotated-types": "0.8.0",
    "anyio": "4.15.1",
    "authlib": "1.9.1",
    "certifi": "2026.7.22",
    "cffi": "2.1.1",
    "click": "8.5.0",
    "cryptography": "50.0.2",
    "fastapi": "0.144.0",
    "h11": "0.16.0",
    "httpcore": "1.0.9",
    "httpcore2": "2.13.1",
    "httpx": "0.28.1",
    "httpx2": "2.13.1",
    "idna": "3.20",
    "iniconfig": "2.3.1",
    "joserfc": "1.7.5",
    "nexus-rpc": "1.4.0",
    "opentelemetry-api": "1.45.1",
    "packaging": "26.3",
    "pluggy": "1.7.0",
    "protobuf": "7.36.2",
    "psycopg": "3.3.6",
    "psycopg-binary": "3.3.6",
    "pycparser": "3.11",
    "pydantic": "2.14.1",
    "pydantic-core": "2.50.1",
    "pygments": "2.21.0",
    "pytest": "9.1.1",
    "starlette": "1.8.0",
    "temporalio": "1.34.0",
    "truststore": "0.10.5",
    "types-protobuf": "7.35.1.20260906",
    "typing-extensions": "4.16.0",
    "uvicorn": "0.54.0",
}
ORIGINAL_PACKAGES = {
    key: value for key, value in EXPECTED_PACKAGES.items()
    if key not in {"nexus-rpc", "protobuf", "temporalio", "types-protobuf"}
}


class CaseDeadlineExceeded(TimeoutError):
    """Raised by the per-test body watchdog; never treated as a skip."""


class CleanupDeadlineExceeded(TimeoutError):
    """Raised when owned-process cleanup exhausts its reserved budget."""


class _Deadline:
    def __init__(self, body_seconds: int, cleanup_seconds: int) -> None:
        self.body_seconds = body_seconds
        self.cleanup_seconds = cleanup_seconds
        self.total_seconds = body_seconds + cleanup_seconds
        self.body_deadline = time.monotonic() + body_seconds
        self.started = time.monotonic()
        self.cleanup_started = False

    def remaining(self, maximum: float) -> float:
        value = min(float(maximum), self.body_deadline - time.monotonic())
        if value <= 0:
            raise CaseDeadlineExceeded("case body deadline exceeded")
        return value

    @contextlib.contextmanager
    def cleanup_budget(self):
        if self.cleanup_started:
            raise RuntimeError("cleanup budget may be entered only once")
        self.cleanup_started = True
        signal.setitimer(signal.ITIMER_REAL, 0)

        def cleanup_timeout(_signum, _frame):
            raise CleanupDeadlineExceeded("case cleanup deadline exceeded")

        signal.signal(signal.SIGALRM, cleanup_timeout)
        signal.setitimer(signal.ITIMER_REAL, self.cleanup_seconds)
        try:
            yield
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)


@pytest.fixture(autouse=True)
def _case_watchdog(request):
    integration = request.node.originalname == "test_temporal_persistent_history_restart_and_duplicate_policy"
    body_seconds, cleanup_seconds = (215, 25) if integration else (25, 5)
    deadline = _Deadline(body_seconds, cleanup_seconds)
    prior_handler = signal.getsignal(signal.SIGALRM)
    prior_timer = signal.getitimer(signal.ITIMER_REAL)

    def body_timeout(_signum, _frame):
        raise CaseDeadlineExceeded("case body deadline exceeded")

    signal.signal(signal.SIGALRM, body_timeout)
    signal.setitimer(signal.ITIMER_REAL, body_seconds)
    try:
        yield deadline
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, prior_handler)
        if prior_timer[0] > 0:
            signal.setitimer(signal.ITIMER_REAL, *prior_timer)
        elapsed = time.monotonic() - deadline.started
        if elapsed > deadline.total_seconds:
            pytest.fail("test plus cleanup exceeded its contract deadline", pytrace=False)


def _manifest() -> tuple[Path, dict[str, Any]]:
    value = os.environ.get("IFPMIC_H1_TOOLCHAIN_MANIFEST")
    if not value:
        pytest.fail("IFPMIC_H1_TOOLCHAIN_MANIFEST is required", pytrace=False)
    path = Path(value)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        pytest.fail("toolchain manifest must be an absolute regular file", pytrace=False)
    return path, json.loads(path.read_text(encoding="utf-8"))


def _evidence_root() -> Path:
    value = os.environ.get("IFPMIC_H1_EVIDENCE_ROOT")
    if not value:
        pytest.fail("IFPMIC_H1_EVIDENCE_ROOT is required", pytrace=False)
    path = Path(value)
    if not path.is_absolute() or path.is_symlink() or not path.is_dir():
        pytest.fail("evidence root must be a pre-created private directory", pytrace=False)
    if stat.S_IMODE(path.stat().st_mode) != 0o700:
        pytest.fail("evidence root must have mode 0700", pytrace=False)
    return path


def _hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _package_inventory() -> dict[str, str]:
    result: dict[str, str] = {}
    for distribution in importlib.metadata.distributions():
        name = distribution.metadata.get("Name")
        if name:
            result[name.lower().replace("_", "-")] = distribution.version
    return result


def _minimal_env(tmp_dir: Path | None = None) -> dict[str, str]:
    tool_bin = str(Path(sys.executable).parent)
    env = {
        "PATH": os.pathsep.join((tool_bin, "/usr/bin", "/bin")),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
    }
    if tmp_dir is not None:
        env["TMPDIR"] = str(tmp_dir)
    return env


def _candidate_lock() -> Path:
    return Path(
        "workflow-artifacts/verification/B03/H1/preparations/"
        "2026-10-18T19-40-54Z-uv-resolution-retry/candidate-requirements.lock"
    ).resolve()


def _normalized_lock_inventory(path: Path) -> dict[str, str]:
    inventory: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^([A-Za-z0-9_.-]+)==([^\s\\]+)", line)
        if match:
            name = match.group(1).lower().replace("_", "-")
            assert name not in inventory, f"duplicate distribution in normalized lock: {name}"
            inventory[name] = match.group(2)
    return inventory


def test_installed_toolchain_pins() -> None:
    manifest_path, manifest = _manifest()
    toolchain_root = Path(manifest["toolchain_root"])
    assert toolchain_root.is_absolute()
    assert Path(sys.executable).absolute() == toolchain_root / "venv/bin/python"
    assert tuple(sys.version_info[:2]) == (3, 12)

    lock_path = _candidate_lock()
    assert lock_path.is_file()
    assert _hash(lock_path) == EXPECTED_LOCK_SHA256
    readme = Path("README.md").resolve()
    assert _hash(readme) == EXPECTED_README_SHA256
    normalized_lock = Path("services/ifpmic_api/requirements-temporal.lock").resolve()
    assert normalized_lock.is_file() and not normalized_lock.is_symlink()
    assert _hash(normalized_lock) == EXPECTED_NORMALIZED_LOCK_SHA256
    assert _normalized_lock_inventory(normalized_lock) == EXPECTED_PACKAGES
    assert manifest["candidate_lock_sha256"] == EXPECTED_LOCK_SHA256
    assert manifest["installed"] == EXPECTED_PACKAGES
    assert len(manifest["installed"]) == 36
    assert {name: manifest["installed"][name] for name in ORIGINAL_PACKAGES} == ORIGINAL_PACKAGES
    assert _package_inventory() == EXPECTED_PACKAGES
    assert importlib.metadata.version("temporalio") == "1.34.0"

    cli = toolchain_root / "temporal"
    assert cli.is_file() and not cli.is_symlink()
    assert manifest["cli_binary_sha256"] == EXPECTED_CLI_SHA256 == CLI_SHA
    assert _hash(cli) == EXPECTED_CLI_SHA256
    assert verify_binary(cli, EXPECTED_CLI_SHA256) == cli
    archive = toolchain_root / manifest["archive"]["filename"]
    assert _hash(archive) == EXPECTED_CLI_ARCHIVE_SHA256
    version = subprocess.run(
        [str(cli), "--version"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=5,
        check=False,
        env=_minimal_env(),
        text=True,
    )
    assert version.returncode == 0
    assert "1.9.1" in version.stdout
    assert "1.32.0" in version.stdout
    assert manifest_path.stat().st_mode & 0o077 == 0


def test_wrong_hash_prevents_execution(tmp_path: Path) -> None:
    sentinel_calls = tmp_path / "sentinel-called"
    sentinel = tmp_path / "sentinel"
    sentinel.write_text(
        f"#!/bin/sh\nprintf called > {sentinel_calls}\n",
        encoding="utf-8",
    )
    sentinel.chmod(0o700)
    data_dir = tmp_path / "server-data"
    ports = [17233, 18233, 18234]

    with pytest.raises(ToolchainError) as caught:
        start_server(sentinel.absolute(), "0" * 64, data_dir.absolute(), ports)

    assert caught.value.code == "HASH_MISMATCH"
    assert not sentinel_calls.exists()
    assert not data_dir.exists()


@pytest.mark.parametrize(
    ("kind", "expected_code"),
    (("missing", "ARTIFACT_INVALID"), ("truncated", "ARTIFACT_INVALID")),
    ids=("missing", "truncated"),
)
def test_missing_and_truncated_binary_prevent_execution(
    tmp_path: Path,
    kind: str,
    expected_code: str,
) -> None:
    data_dir = tmp_path / "server-data"
    ports = [17233, 18233, 18234]
    if kind == "missing":
        binary = (tmp_path / "missing-temporal").absolute()
        expected_hash = EXPECTED_CLI_SHA256
    else:
        binary = (tmp_path / "truncated-temporal").absolute()
        binary.write_bytes(b"\x7fELF\x02\x01\x00\x00")
        binary.chmod(0o700)
        expected_hash = _hash(binary)

    with pytest.raises(ToolchainError) as caught:
        start_server(binary, expected_hash, data_dir.absolute(), ports)

    assert caught.value.code == expected_code
    assert not data_dir.exists()


class _ProcessJournal:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.records: list[dict[str, Any]] = []
        self.handles: list[subprocess.Popen] = []
        self._next = 0
        self._write()

    def _write_json(self, name: str, value: object) -> None:
        path = self.root / name
        tmp = self.root / (name + ".tmp")
        payload = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
        fd = os.open(tmp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        try:
            os.fchmod(fd, 0o600)
            view = memoryview(payload)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    raise OSError("short evidence write")
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, path)

    def _write(self) -> None:
        self._write_json("processes.json", {"kind": "ifpmic.b03.h1.processes.v1", "processes": self.records})

    def _new_record(self, role: str, process: subprocess.Popen, stdout_name: str, stderr_name: str) -> dict[str, Any]:
        ticks = getattr(process, "_ifpmic_start_ticks", None) or process_identity(process.pid)
        if ticks is None:
            raise AssertionError("owned process has no saved start-time identity")
        record = {
            "index": self._next,
            "role": role,
            "pid": process.pid,
            "start_ticks": ticks,
            "returncode": None,
            "forced": False,
            "absent": False,
            "stdout_log": stdout_name,
            "stderr_log": stderr_name,
        }
        self._next += 1
        self.records.append(record)
        self._write()
        return record

    def server(self, role: str, process: subprocess.Popen, log_name: str) -> dict[str, Any]:
        return self._new_record(role, process, log_name, log_name)

    def spawn_child(
        self,
        role: str,
        argv: list[str],
        *,
        env: dict[str, str],
    ) -> tuple[subprocess.Popen, dict[str, Any]]:
        index = self._next
        stdout_name = f"process-{index:03d}-stdout.log"
        stderr_name = f"process-{index:03d}-stderr.log"
        stdout_fd = os.open(self.root / stdout_name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        stderr_fd = os.open(self.root / stderr_name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            process = subprocess.Popen(
                argv,
                cwd=Path(__file__).resolve().parents[2],
                stdin=subprocess.DEVNULL,
                stdout=stdout_fd,
                stderr=stderr_fd,
                env=env,
                start_new_session=True,
            )
        except BaseException:
            os.close(stdout_fd)
            os.close(stderr_fd)
            raise
        os.close(stdout_fd)
        os.close(stderr_fd)
        ticks = process_identity(process.pid)
        if ticks is None:
            process.poll()
            raise AssertionError("child process identity could not be recorded")
        process._ifpmic_start_ticks = ticks
        self.handles.append(process)
        return process, self._new_record(role, process, stdout_name, stderr_name)

    def finished(self, process: subprocess.Popen, record: dict[str, Any], timeout: float) -> str:
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            raise AssertionError(f"owned {record['role']} exceeded its process deadline") from None
        record["returncode"] = code
        record["absent"] = process_identity(process.pid) != record["start_ticks"]
        self._write()
        return (self.root / record["stdout_log"]).read_text(encoding="utf-8")

    def stopped(self, results: list[dict[str, Any]]) -> None:
        by_identity = {(item["pid"], item["start_ticks"]): item for item in results}
        for record in self.records:
            item = by_identity.get((record["pid"], record["start_ticks"]))
            if item is not None:
                record["returncode"] = item["returncode"]
                record["forced"] = item["forced"]
                record["absent"] = item["absent"]
        self._write()


def _atomic_result(root: Path, value: dict[str, Any]) -> None:
    path = root / "result.json"
    tmp = root / "result.json.tmp"
    payload = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    fd = os.open(tmp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    try:
        os.fchmod(fd, 0o600)
        view = memoryview(payload)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError("short evidence write")
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, path)


def _allocate_ports() -> list[int]:
    sockets = []
    try:
        for _ in range(3):
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.bind(("127.0.0.1", 0))
            sockets.append(sock)
        ports = [sock.getsockname()[1] for sock in sockets]
        assert len(set(ports)) == 3
        return ports
    finally:
        for sock in sockets:
            sock.close()


def _assert_loopback_listeners(process: subprocess.Popen, ports: list[int]) -> list[dict[str, Any]]:
    listeners = owned_listeners(process)
    assert listeners
    assert all(item["loopback"] and ipaddress.ip_address(item["address"]).is_loopback for item in listeners)
    assert set(ports).issubset({item["port"] for item in listeners})
    return listeners


def _fixture_argv(toolchain_root: Path, action: str, **values: str) -> list[str]:
    fixture = Path(__file__).with_name("temporal_toolchain_fixture.py")
    argv = [
        str(toolchain_root / "venv/bin/python"),
        str(fixture),
        action,
    ]
    for name, value in values.items():
        argv.extend((f"--{name.replace('_', '-')}", value))
    return argv


def _probe_result(stdout: str) -> dict[str, Any]:
    lines = [line for line in stdout.splitlines() if line]
    assert len(lines) == 1, "probe must emit exactly one JSON result line"
    result = json.loads(lines[0])
    assert isinstance(result, dict)
    assert "error_type" not in result
    return result


def _assert_history_file(path: Path) -> dict[str, Any]:
    assert path.is_file()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    return json.loads(path.read_text(encoding="utf-8"))


def test_temporal_persistent_history_restart_and_duplicate_policy(_case_watchdog: _Deadline) -> None:
    manifest_path, manifest = _manifest()
    toolchain_root = Path(manifest["toolchain_root"])
    cli = toolchain_root / "temporal"
    assert _hash(cli) == EXPECTED_CLI_SHA256
    evidence_root = _evidence_root()
    attempt_root = evidence_root / "integration"
    attempt_root.mkdir(mode=0o700, exist_ok=False)
    if stat.S_IMODE(attempt_root.stat().st_mode) != 0o700:
        pytest.fail("integration evidence directory must have mode 0700", pytrace=False)
    journal = _ProcessJournal(attempt_root)
    result_record: dict[str, Any] = {
        "kind": "ifpmic.b03.h1.integration-observation.v1",
        "status": "running",
        "workflow_id": "ifpmic-h1-qualification-fixed",
        "phases": {},
    }
    _atomic_result(attempt_root, result_record)
    active: list[subprocess.Popen] = []
    server_data = attempt_root / "server-data"
    ports = _allocate_ports()
    workflow_id = result_record["workflow_id"]
    task_queue = "ifpmic-h1-qualification-fixed"
    processes = []
    process_records: dict[int, dict[str, Any]] = {}
    try:
        server1 = start_server(cli, EXPECTED_CLI_SHA256, server_data.absolute(), ports, log_name="server-0.log")
        active.append(server1)
        server1_record = journal.server("server-phase1", server1, "server-data/server-0.log")
        process_records[server1.pid] = server1_record
        listeners1 = _assert_loopback_listeners(server1, ports)

        worker1, worker1_record = journal.spawn_child(
            "worker-phase1",
            _fixture_argv(
                toolchain_root,
                "worker",
                target=f"127.0.0.1:{ports[0]}",
                task_queue=task_queue,
            ),
            env=_minimal_env(attempt_root),
        )
        active.append(worker1)
        process_records[worker1.pid] = worker1_record
        phase1_history = attempt_root / "history-phase1.json"
        probe1, probe1_record = journal.spawn_child(
            "client-phase1",
            _fixture_argv(
                toolchain_root,
                "probe",
                target=f"127.0.0.1:{ports[0]}",
                task_queue=task_queue,
                workflow_id=workflow_id,
                action="phase1",
                history_path=str(phase1_history),
            ),
            env=_minimal_env(attempt_root),
        )
        active.append(probe1)
        process_records[probe1.pid] = probe1_record
        stdout1 = journal.finished(probe1, probe1_record, _case_watchdog.remaining(30))
        assert probe1.returncode == 0
        active.remove(probe1)
        phase1 = _probe_result(stdout1)
        assert phase1["phase"] == "phase1"
        assert phase1["workflow_id"] == workflow_id
        run_id = phase1["run_id"]
        assert isinstance(run_id, str) and run_id
        assert phase1["retention_seconds"] > 3600
        assert phase1["query_phase"] == "waiting"
        assert phase1["duplicate_error"] == {
            "type": "WorkflowAlreadyStartedError",
            "run_id": run_id,
            "is_expected_typed_error": True,
        }
        history1 = phase1["history"]
        events1 = history1["events"]
        assert history1["workflow_id"] == workflow_id
        assert history1["run_id"] == run_id
        assert events1
        assert events1[0]["event_type"] == "workflow_execution_started_event_attributes"
        assert all(item["event_type"] != "workflow_execution_completed_event_attributes" for item in events1)
        assert [item["event_id"] for item in events1] == sorted({item["event_id"] for item in events1})
        _assert_history_file(phase1_history)
        result_record["phases"]["phase1"] = {
            "run_id": run_id,
            "retention_seconds": phase1["retention_seconds"],
            "waiting": True,
            "running_duplicate_rejected": True,
            "events": events1,
            "listeners": listeners1,
        }
        _atomic_result(attempt_root, result_record)

        worker_result = stop_owned(worker1)
        server_result = stop_owned(server1)
        journal.stopped([worker_result, server_result])
        active.remove(worker1)
        active.remove(server1)
        assert not worker_result["forced"] and worker_result["absent"]
        assert not server_result["forced"] and server_result["absent"]
        assert worker1.returncode == 0
        assert server1.returncode == 0

        server2 = start_server(cli, EXPECTED_CLI_SHA256, server_data.absolute(), ports, log_name="server-1.log")
        active.append(server2)
        server2_record = journal.server("server-phase2", server2, "server-data/server-1.log")
        process_records[server2.pid] = server2_record
        listeners2 = _assert_loopback_listeners(server2, ports)

        worker2, worker2_record = journal.spawn_child(
            "worker-phase2",
            _fixture_argv(
                toolchain_root,
                "worker",
                target=f"127.0.0.1:{ports[0]}",
                task_queue=task_queue,
            ),
            env=_minimal_env(attempt_root),
        )
        active.append(worker2)
        process_records[worker2.pid] = worker2_record
        phase2_before = attempt_root / "history-phase2-before.json"
        phase2_after = attempt_root / "history-phase2-after.json"
        probe2, probe2_record = journal.spawn_child(
            "client-phase2",
            _fixture_argv(
                toolchain_root,
                "probe",
                target=f"127.0.0.1:{ports[0]}",
                task_queue=task_queue,
                workflow_id=workflow_id,
                expected_run_id=run_id,
                action="phase2",
                history_before_path=str(phase2_before),
                history_after_path=str(phase2_after),
            ),
            env=_minimal_env(attempt_root),
        )
        active.append(probe2)
        process_records[probe2.pid] = probe2_record
        stdout2 = journal.finished(probe2, probe2_record, _case_watchdog.remaining(30))
        assert probe2.returncode == 0
        active.remove(probe2)
        phase2 = _probe_result(stdout2)
        assert phase2["phase"] == "phase2"
        assert phase2["workflow_id"] == workflow_id
        assert phase2["run_id"] == run_id
        assert phase2["retention_seconds"] > 3600
        assert phase2["query_phase_before_signal"] == "waiting"
        history_before = phase2["history_before"]
        events_before = history_before["events"]
        assert history_before["run_id"] == run_id
        assert events_before[: len(events1)] == events1
        assert phase2["signal"] == "finish"
        assert phase2["result"] == "h1-finished-v1"
        history_after = phase2["history_after"]
        events_after = history_after["events"]
        assert history_after["run_id"] == run_id
        assert events_after[: len(events1)] == events1
        assert events_after[-1]["event_type"] == "workflow_execution_completed_event_attributes"
        assert [item["event_id"] for item in events_after] == sorted({item["event_id"] for item in events_after})
        assert phase2["duplicate_error"] == {
            "type": "WorkflowAlreadyStartedError",
            "run_id": run_id,
            "is_expected_typed_error": True,
        }
        assert len(phase2["executions"]) == 1
        assert phase2["executions"][0]["workflow_id"] == workflow_id
        assert phase2["executions"][0]["run_id"] == run_id
        _assert_history_file(phase2_before)
        _assert_history_file(phase2_after)
        result_record["phases"]["phase2"] = {
            "run_id": run_id,
            "retention_seconds": phase2["retention_seconds"],
            "same_history_prefix": True,
            "signal_completed": True,
            "closed_duplicate_rejected": True,
            "events": events_after,
            "listeners": listeners2,
            "logical_execution_count": len(phase2["executions"]),
        }
        _atomic_result(attempt_root, result_record)

        worker_result = stop_owned(worker2)
        server_result = stop_owned(server2)
        journal.stopped([worker_result, server_result])
        active.remove(worker2)
        active.remove(server2)
        assert not worker_result["forced"] and worker_result["absent"]
        assert not server_result["forced"] and server_result["absent"]
        assert worker2.returncode == 0
        assert server2.returncode == 0
        result_record["status"] = "passed"
    except BaseException as exc:
        result_record["status"] = "failed"
        result_record["failure_type"] = type(exc).__name__
        raise
    finally:
        with _case_watchdog.cleanup_budget():
            if active:
                cleanup = stop_all_owned(active, total_timeout=25)
                journal.stopped(cleanup)
                result_record["cleanup"] = cleanup
            result_record["process_count"] = len(journal.records)
            _atomic_result(attempt_root, result_record)

    assert len(journal.records) == 6
    assert all(record["absent"] for record in journal.records)
    assert all(not record["forced"] for record in journal.records)
