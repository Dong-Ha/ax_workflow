"""Owned-process helpers for real dispatcher cut-point tests.

This module is test-only. It builds the same real private manifests, registry,
G5 workspace and Temporal server as the normal-runtime test, then runs the
production Dispatcher through the constructor-injected child barrier.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import signal
import socket
import stat
import subprocess
import sys
import threading
import time
from uuid import uuid4

import psycopg

from tests.ifpmic_api import test_accepted_start_response_loss as accepted_start
from tests.ifpmic_api import test_h2_runtime_normal_flow as normal
from scripts.ifpmic_temporal_toolchain import verify_binary


class PhaseBarrier:
    def __init__(self, path: Path, phase: str):
        self.path = path
        self.phase = phase
        self.hit = threading.Event()
        self.release_requested = threading.Event()
        self.released = threading.Event()
        self.error = None
        self.listener = None
        self.connection = None
        self.thread = None
        self.events = []

    def start(self):
        if len(os.fsencode(self.path)) >= 100:
            raise AssertionError("barrier path exceeds local socket bound")
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(str(self.path))
        os.chmod(self.path, 0o600)
        info = self.path.lstat()
        assert stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid()
        assert stat.S_IMODE(info.st_mode) == 0o600
        self.listener.listen(1)
        self.listener.settimeout(1.0)
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        try:
            while not self.release_requested.is_set():
                try:
                    connection, _ = self.listener.accept()
                    break
                except TimeoutError:
                    continue
            else:
                return
            self.connection = connection
            connection.settimeout(5.0)
            token = bytearray()
            while b"\n" not in token and len(token) < 80:
                chunk = connection.recv(80 - len(token))
                if not chunk:
                    raise ConnectionError("dispatcher closed barrier socket")
                token.extend(chunk)
            if bytes(token) != self.phase.encode("ascii") + b"\n":
                raise AssertionError("dispatcher paused at a different hook")
            self.events.append({"event": "phase_reached", "phase": self.phase,
                                "monotonic": time.monotonic()})
            self.hit.set()
            if not self.release_requested.wait(190):
                raise TimeoutError("dispatcher barrier release deadline")
            connection.sendall(b"continue\n")
            self.events.append({"event": "released", "phase": self.phase,
                                "monotonic": time.monotonic()})
            self.released.set()
        except BaseException as error:
            self.error = error
            self.hit.set()
        finally:
            if self.connection is not None:
                self.connection.close()

    def wait(self, timeout):
        if not self.hit.wait(timeout):
            raise TimeoutError("dispatcher did not reach expected production hook")
        if self.error is not None:
            raise AssertionError("dispatcher phase barrier failed") from self.error

    def release(self):
        self.release_requested.set()
        if not self.released.wait(2.0):
            raise TimeoutError("dispatcher did not leave production hook")

    def close(self):
        self.release_requested.set()
        if self.connection is not None:
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.connection.close()
        if self.listener is not None:
            self.listener.close()
        if self.thread is not None:
            self.thread.join(timeout=2.0)
            if self.thread.is_alive():
                raise TimeoutError("phase barrier thread did not stop")
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass


def _cleanup_failed_prepare(ownership, primary_error):
    root = ownership.get("root")
    journal = ownership.get("journal")
    cleanup_error_types = []
    for barrier, _barrier_dir in ownership.get("barriers", []):
        try:
            barrier.close()
        except BaseException as error:
            cleanup_error_types.append(type(error).__name__)
    processes = ownership.get("processes", [])
    outcomes = []
    for process in processes:
        try:
            normal._append_private_journal(journal, {
                "event": "stop_requested", "pid": process.pid,
                "start_ticks": getattr(process, "_ifpmic_start_ticks", None),
                "pre_stop_exit_code": process.poll(), "mode": "graceful",
            })
        except BaseException as error:
            cleanup_error_types.append(type(error).__name__)
        try:
            forced = False
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    forced = True
                    process.kill()
                    process.wait(timeout=5)
            outcome = {
                "returncode": process.poll(), "forced": forced,
                "absent": normal.process_identity(process.pid) !=
                getattr(process, "_ifpmic_start_ticks", None),
            }
            outcomes.append(outcome)
            normal._append_private_journal(journal, {
                "event": "stopped", "pid": process.pid,
                "start_ticks": getattr(process, "_ifpmic_start_ticks", None),
                "exit_code": outcome["returncode"], "absent": outcome["absent"],
                "forced": outcome["forced"],
            })
        except BaseException as error:
            cleanup_error_types.append(type(error).__name__)
    if root is not None and journal is not None and journal.exists():
        try:
            normal._write_private(root / "prepare-failure.json", normal._canonical({
                "status": "failed" if not cleanup_error_types else "cleanup_failed",
                "primary_error_type": type(primary_error).__name__,
                "cleanup_error_types": cleanup_error_types,
                "process_outcomes": [
                    {"pid": process.pid, "returncode": result["returncode"],
                     "absent": result["absent"], "forced": result["forced"]}
                    for process, result in zip(processes, outcomes)],
                "process_journal_sha256": hashlib.sha256(journal.read_bytes()).hexdigest(),
            }) + b"\n")
        except BaseException:
            cleanup_error_types.append("PRIVATE_FAILURE_EVIDENCE_WRITE")
    return cleanup_error_types


def start_owned_temporal_server(binary, expected_sha256, data_dir, ports, *, log_name):
    """Start the pinned server while retaining a Popen handle on every path."""
    binary = verify_binary(binary, expected_sha256)
    if (len(ports) != 3 or len(set(ports)) != 3
            or any(type(port) is not int or not 1 <= port <= 65535 for port in ports)
            or Path(log_name).name != log_name or log_name in ("", ".", "..")):
        raise ValueError("invalid owned Temporal server parameters")
    directory = Path(data_dir)
    if not directory.is_absolute() or directory.is_symlink():
        raise ValueError("invalid Temporal storage directory")
    directory.mkdir(mode=0o700, exist_ok=True)
    assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    env_path = directory / "isolated-env.json"
    if env_path.exists() or env_path.is_symlink():
        assert not env_path.is_symlink() and env_path.read_bytes() == b"{}"
    else:
        fd = os.open(env_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
        try:
            os.write(fd, b"{}")
        finally:
            os.close(fd)
    env_path.chmod(0o600)
    log_path = directory / log_name
    log_fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    args = [str(binary), "--disable-config-env", "--disable-config-file", "--env-file",
            str(env_path), "server", "start-dev", "--ip", "127.0.0.1", "--port",
            str(ports[0]), "--http-port", str(ports[1]), "--metrics-port", str(ports[2]),
            "--db-filename", str(directory / "temporal.sqlite"), "--headless"]
    try:
        process = subprocess.Popen(args, cwd=directory, stdin=subprocess.DEVNULL,
                                   stdout=log_fd, stderr=subprocess.STDOUT,
                                   env={"PATH": os.defpath, "PYTHONDONTWRITEBYTECODE": "1"},
                                   start_new_session=True)
    finally:
        os.close(log_fd)
    try:
        ticks = normal.process_identity(process.pid)
    except BaseException:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        raise
    if ticks is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        assert process.poll() is not None
        raise AssertionError("Temporal server process identity unavailable; direct child reaped")
    process._ifpmic_start_ticks = ticks
    return process


def prepare_case(harness, deadline: float, case_name: str) -> dict[str, object]:
    ownership = {"processes": [], "records": [], "barriers": []}
    try:
        return _prepare_case_impl(harness, deadline, case_name, ownership)
    except BaseException as error:
        _cleanup_failed_prepare(ownership, error)
        raise


def _prepare_case_impl(harness, deadline: float, case_name: str, ownership) -> dict[str, object]:
    accepted = normal.accept_workspace_job(harness, key="h2-runtime-" + case_name)
    job_id = accepted["job_id"]
    group = normal.workspace_rows(harness, job_id)
    assert group is not None
    workspace_root = Path(harness["workspace_root"])
    workspace, tree_before = normal._workspace_ready(harness, workspace_root, job_id)
    normal._add_live_sql_eligibility(harness, job_id)
    before = normal._read_owner_snapshot(harness, job_id)
    assert before["accepted"] is not None
    assert before["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
    assert before["bindings"] == before["scopes"] == before["receipts"] == before["attempts"] == []
    assert before["noncreate_commands"] == 0

    root = normal._private_dir(normal._runtime_evidence_root() / case_name)
    journal = root / "process-journal.jsonl"
    normal._create_private_journal(journal)
    ownership.update({"root": root, "journal": journal})
    toolchain = normal._read_h1_toolchain()
    ports = normal._allocate_loopback_ports()
    temporal_root = root / "temporal-data"
    server = start_owned_temporal_server(Path(toolchain["toolchain_root"]) / "temporal",
                                         toolchain["cli_binary_sha256"], temporal_root, ports,
                                         log_name="temporal-server.log")
    ownership["processes"].append(server)
    server_record = {"role": "temporal", "pid": server.pid,
                     "start_ticks": server._ifpmic_start_ticks,
                     "log": temporal_root / "temporal-server.log"}
    ownership["records"].append(server_record)
    normal._append_private_journal(journal, {"event": "started", **server_record})
    normal._wait_for_temporal_listeners(server, ports,
                                        time.monotonic() + min(30, deadline - time.monotonic()))
    temporal_store = temporal_root / "temporal.sqlite"
    assert temporal_store.is_file()
    temporal_stat = temporal_store.stat()

    source_value = normal.source_manifest()
    env_value = normal.environment_manifest()
    source_sha = normal._manifest_hash(source_value)
    env_sha = normal._manifest_hash(env_value)
    source_path = root / "source-manifest.json"
    env_path = root / "environment-manifest.json"
    normal._write_private(source_path, normal._canonical(source_value) + b"\n")
    normal._write_private(env_path, normal._canonical(env_value) + b"\n")
    deployment_id = "h2-crash-" + uuid4().hex
    endpoint = f"127.0.0.1:{ports[0]}"
    deployment_doc = {"protocol_version": normal.PROTOCOL_VERSION,
                      "deployment_id": deployment_id, "namespace": normal.NAMESPACE,
                      "server_endpoint": endpoint}
    server_sha = normal._domain_hash("ifpmic.b03.deployment.v1", deployment_doc)
    build_doc = {"protocol_version": normal.PROTOCOL_VERSION,
                 "source_manifest_sha256": source_sha,
                 "environment_manifest_sha256": env_sha,
                 "workflow_type": normal.WORKFLOW_TYPE}
    build_id = normal._domain_hash("ifpmic.b03.build.v1", build_doc)
    identity = {"deployment_id": deployment_id, "namespace": normal.NAMESPACE,
                "server_endpoint": endpoint, "server_config_sha256": server_sha,
                "build_id": build_id, "source_manifest_sha256": source_sha,
                "environment_manifest_sha256": env_sha}
    roles = normal._register_identity(harness, identity)
    dispatcher_config = normal._write_runtime_config(
        root, "dispatcher", identity, normal._private_dsn(harness["database"], "dispatcher"),
        workspace_root, source_path, env_path)
    worker_config = normal._write_runtime_config(
        root, "worker", identity, normal._private_dsn(harness["database"], "projector"),
        workspace_root, source_path, env_path)
    assert normal._read_owner_snapshot(harness, job_id) == before
    assert hashlib.sha256(source_path.read_bytes()).hexdigest()
    return {"harness": harness, "accepted": accepted, "job_id": job_id, "group": group,
            "workspace": workspace, "tree_before": tree_before, "before": before,
            "root": root, "journal": journal, "server": server,
            "server_record": server_record, "temporal_root": temporal_root,
            "temporal_store": temporal_store,
            "temporal_store_identity": (temporal_stat.st_dev, temporal_stat.st_ino),
            "ports": ports, "identity": identity, "roles": roles,
            "dispatcher_config": dispatcher_config, "worker_config": worker_config,
            "processes": ownership["processes"], "records": ownership["records"],
            "barriers": ownership["barriers"],
            "deadline": deadline}


def start_barrier_dispatcher(case: dict[str, object], phase: str):
    tmp_root = Path(os.environ["TMPDIR"])
    barrier_dir = normal._private_dir(tmp_root / ("h2d-" + uuid4().hex[:8]))
    barrier = PhaseBarrier(barrier_dir / "phase.sock", phase)
    case["barriers"].append((barrier, barrier_dir))
    barrier.start()
    root = case["root"]
    child_source = Path(accepted_start.__file__).with_name("accepted_start_dispatcher_child.py")
    logs = normal._private_dir(root / "dispatcher-cut-logs")
    stdout = logs / "dispatcher.stdout"
    stderr = logs / "dispatcher.stderr"
    descriptors = []
    process = None
    cache = None
    try:
        out_fd = os.open(stdout, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
        descriptors.append(out_fd)
        err_fd = os.open(stderr, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
        descriptors.append(err_fd)
        cache = normal._private_dir(root / "dispatcher-cut-pycache")
        env = normal._minimal_runtime_env(root, case["dispatcher_config"])
        args = [sys.executable, "-B", "-X", "pycache_prefix=" + str(cache), str(child_source),
                "--command-id", case["group"][18], "--barrier-socket", str(barrier.path),
                "--hook-phase", phase, "--repo-root", str(normal.REPO_ROOT)]
        process = subprocess.Popen(args, cwd=normal.REPO_ROOT, stdin=subprocess.DEVNULL,
                                   stdout=out_fd, stderr=err_fd, env=env,
                                   start_new_session=True)
    finally:
        for descriptor in descriptors:
            try:
                os.close(descriptor)
            except OSError:
                pass
    assert process is not None
    try:
        ticks = normal.process_identity(process.pid)
    except BaseException:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        barrier.close()
        raise
    if ticks is None:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        raise AssertionError("dispatcher phase child identity unavailable")
    process._ifpmic_start_ticks = ticks
    record = {"role": "dispatcher-cut-" + phase, "pid": process.pid,
              "start_ticks": ticks, "stdout": stdout, "stderr": stderr,
              "cache": cache}
    case["processes"].append(process)
    case["records"].append(record)
    normal._append_private_journal(case["journal"], {"event": "started", **record})
    return process, record, barrier


def kill_at_barrier(case, process, record, barrier, timeout):
    barrier.wait(timeout)
    assert process.poll() is None
    assert normal.process_identity(process.pid) == record["start_ticks"]
    barrier_cut = {"hook_phase": barrier.phase, "events": list(barrier.events),
                   "pid": process.pid, "start_ticks": record["start_ticks"]}
    normal._write_private(case["root"] / "dispatcher-barrier.json",
                          normal._canonical(barrier_cut) + b"\n")
    normal._append_private_journal(case["journal"], {
        "event": "kill_requested", "pid": process.pid,
        "start_ticks": record["start_ticks"], "pre_kill_exit_code": process.poll(),
        "signal": "SIGKILL", "monotonic": time.monotonic(),
    })
    os.kill(process.pid, signal.SIGKILL)
    process.wait(timeout=5)
    assert process.returncode == -signal.SIGKILL
    assert normal.process_identity(process.pid) is None
    normal._append_private_journal(case["journal"], {
        "event": "killed_at_production_hook", "pid": process.pid,
        "start_ticks": record["start_ticks"], "signal": "SIGKILL",
        "returncode": process.returncode, "absent": True,
    })
    return barrier_cut


def wait_claim_expired(case, claim, timeout):
    command_id = case["group"][18]
    stop = time.monotonic() + timeout
    while time.monotonic() < stop:
        with psycopg.connect(normal.owner_dsn(case["harness"]["database"])) as conn:
            row = conn.execute(
                "SELECT state,generation,claim_token::text,claim_expires_at<=clock_timestamp() "
                "FROM ifpmic.commands_outbox WHERE command_id=%s", (command_id,),
            ).fetchone()
        assert row is not None and row[:3] == ("leased", claim["generation"], claim["token"])
        if row[3]:
            return row
        time.sleep(0.1)
    raise TimeoutError("original delivery claim did not expire by database clock")


def cleanup_case(case: dict[str, object], expected_killed=(), expected_exit_codes=None):
    expected_exit_codes = expected_exit_codes or {}
    cleanup_errors = []
    for barrier, _barrier_dir in case["barriers"]:
        try:
            barrier.close()
        except BaseException as error:
            cleanup_errors.append(type(error).__name__)
        try:
            barrier.path.parent.rmdir()
        except OSError:
            pass
    pre_stop_codes = {process.pid: process.poll() for process in case["processes"]}
    for process in case["processes"]:
        try:
            normal._append_private_journal(case["journal"], {
                "event": "stop_requested", "pid": process.pid,
                "start_ticks": getattr(process, "_ifpmic_start_ticks", None),
                "pre_stop_exit_code": pre_stop_codes[process.pid],
                "mode": ("already_sigkilled" if process in expected_killed else
                         "already_exited" if process.pid in expected_exit_codes else "graceful"),
            })
        except BaseException as error:
            cleanup_errors.append(type(error).__name__)
    try:
        outcomes = normal.stop_all_owned(case["processes"], total_timeout=15)
    except BaseException as error:
        cleanup_errors.append(type(error).__name__)
        outcomes = []
        for process in case["processes"]:
            forced = False
            try:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=4)
                    except subprocess.TimeoutExpired:
                        forced = True
                        process.kill()
                        process.wait(timeout=4)
                outcomes.append({
                    "returncode": process.poll(), "forced": forced,
                    "absent": normal.process_identity(process.pid) !=
                    getattr(process, "_ifpmic_start_ticks", None),
                })
            except BaseException as fallback_error:
                cleanup_errors.append(type(fallback_error).__name__)
                outcomes.append({"returncode": process.poll(), "forced": forced, "absent": False})
    records = {record["pid"]: record for record in case["records"]}
    cleanup_oracle_errors = []
    for process, result in zip(case["processes"], outcomes):
        try:
            normal._append_private_journal(case["journal"], {
                "event": "stopped", "pid": process.pid,
                "start_ticks": getattr(process, "_ifpmic_start_ticks", None),
                "exit_code": result["returncode"], "absent": result["absent"],
                "forced": result["forced"],
            })
        except BaseException as error:
            cleanup_errors.append(type(error).__name__)
        if process in expected_killed:
            if result["returncode"] != -signal.SIGKILL or result["absent"] is not True:
                cleanup_oracle_errors.append("EXPECTED_SIGKILL_OUTCOME_MISMATCH")
        elif process.pid in expected_exit_codes:
            if (result["returncode"] != expected_exit_codes[process.pid]
                    or result["absent"] is not True):
                cleanup_oracle_errors.append("EXPECTED_EXIT_OUTCOME_MISMATCH")
        else:
            if (result["returncode"] != 0 or result["absent"] is not True
                    or result["forced"] is not False):
                cleanup_oracle_errors.append("GRACEFUL_EXIT_OUTCOME_MISMATCH")
    try:
        normal._write_private(case["root"] / "process-cleanup.json",
                              normal._canonical({"processes": [
                                  {"role": records[p.pid]["role"], "pid": p.pid, **item}
                                  for p, item in zip(case["processes"], outcomes)]}) + b"\n")
    except BaseException as error:
        cleanup_errors.append(type(error).__name__)
    if cleanup_errors or cleanup_oracle_errors:
        raise AssertionError("owned-process cleanup evidence: " +
                             ",".join(cleanup_errors + cleanup_oracle_errors))
