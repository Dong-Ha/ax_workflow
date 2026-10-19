"""Private draft: real Temporal acceptance followed by dispatcher response loss.

This is not integrated or executed. It imports helpers from the reviewed normal
case when later integrated, but injects the fault only through a test-only
Dispatcher constructor hook in a separate child process.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import stat
import subprocess
import sys
import threading
import time
from datetime import timedelta
from uuid import uuid4

import psycopg
import pytest
from temporalio.client import Client
from temporalio.api.workflowservice.v1 import DescribeNamespaceRequest

from tests.ifpmic_api import test_h2_runtime_normal_flow as normal
import importlib.util
_PROXY_PATH = Path(__file__).with_name("response_loss_proxy.py")
_PROXY_SPEC = importlib.util.spec_from_file_location("_h2_response_loss_proxy", _PROXY_PATH)
assert _PROXY_SPEC is not None and _PROXY_SPEC.loader is not None
_PROXY_MODULE = importlib.util.module_from_spec(_PROXY_SPEC)
_PROXY_SPEC.loader.exec_module(_PROXY_MODULE)
TCPResponseHoldingProxy = _PROXY_MODULE.TCPResponseHoldingProxy

pytest_plugins = (
    "tests.ifpmic_api.jobs_fixture",
    "tests.ifpmic_api.workspace_fixture",
    "tests.ifpmic_api.workflow_schema_fixture",
)

CASE_ID = "tests.ifpmic_api.test_accepted_start_response_loss.test_actual_started_event_survives_lost_start_response_and_recovers_same_run"
BODY_SECONDS = 215
MAXIMUM_WAIT_PER_OPERATION = 30


class StartRPCBarrier:
    """One-use private Unix socket that arms proxy then releases real hook."""
    def __init__(self, path: Path, proxy: TCPResponseHoldingProxy):
        self.path = path
        self.proxy = proxy
        self.hit = threading.Event()
        self.release_requested = threading.Event()
        self.released = threading.Event()
        self.error = None
        self.listener = None
        self.thread = None
        self.connection = None
        self.armed_monotonic = None
        self.barrier_hit_monotonic = None
        self.release_requested_monotonic = None
        self.released_monotonic = None
        self.events = []

    def start(self) -> None:
        if len(os.fsencode(self.path)) >= 100:
            raise AssertionError("barrier socket path exceeds the portable local bound")
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(str(self.path))
        os.chmod(self.path, 0o600)
        info = self.path.lstat()
        assert stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid()
        assert stat.S_IMODE(info.st_mode) == 0o600
        self.listener.listen(1)
        self.listener.settimeout(1.0)
        self.thread = threading.Thread(target=self._serve, name="h2-start-rpc-barrier", daemon=True)
        self.thread.start()

    def _serve(self) -> None:
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
            request_bytes = bytearray()
            while b"\n" not in request_bytes and len(request_bytes) < 64:
                chunk = connection.recv(64 - len(request_bytes))
                if not chunk:
                    raise ConnectionError("dispatcher closed the barrier before the hook token")
                request_bytes.extend(chunk)
            request = bytes(request_bytes)
            received = time.monotonic()
            self.events.append({"event": "before_start_rpc_received", "monotonic": received})
            if request != b"before_start_rpc\n":
                raise AssertionError("child reached an unexpected fault hook")
            self.proxy.arm_after_barrier()
            self.armed_monotonic = time.monotonic()
            self.events.append({"event": "proxy_armed", "monotonic": self.armed_monotonic})
            self.barrier_hit_monotonic = time.monotonic()
            self.events.append({"event": "barrier_hit_acknowledged", "monotonic": self.barrier_hit_monotonic})
            self.hit.set()
            if not self.release_requested.wait(BODY_SECONDS):
                raise TimeoutError("test did not release the start-RPC barrier")
            connection.sendall(b"continue\n")
            self.released_monotonic = time.monotonic()
            self.events.append({"event": "child_released", "monotonic": self.released_monotonic})
            self.released.set()
        except BaseException as error:
            self.error = error
            self.hit.set()
        finally:
            if self.connection is not None:
                self.connection.close()

    def wait_hit(self, timeout: float) -> None:
        if not self.hit.wait(timeout):
            raise TimeoutError("dispatcher did not reach before_start_rpc")
        if self.error is not None:
            raise AssertionError("private start-RPC barrier failed") from self.error

    def release_child(self) -> None:
        self.release_requested_monotonic = time.monotonic()
        self.events.append({"event": "release_requested", "monotonic": self.release_requested_monotonic})
        self.release_requested.set()
        if not self.released.wait(2.0):
            raise TimeoutError("dispatcher did not leave the private start-RPC barrier")

    def close(self) -> None:
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
                raise TimeoutError("barrier thread did not stop")
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass

    def snapshot(self) -> dict[str, object]:
        return {
            "events": list(self.events),
            "armed_monotonic": self.armed_monotonic,
            "barrier_hit_monotonic": self.barrier_hit_monotonic,
            "release_requested_monotonic": self.release_requested_monotonic,
            "released_monotonic": self.released_monotonic,
        }


def _remaining(deadline: float, maximum: float = MAXIMUM_WAIT_PER_OPERATION) -> float:
    result = min(maximum, deadline - time.monotonic())
    if result <= 0:
        raise TimeoutError("accepted-start response-loss case body deadline exceeded")
    return result


def _sha256_if_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _runtime_root() -> Path:
    raw = os.environ.get("IFPMIC_H2_RUNTIME_EVIDENCE_ROOT")
    assert raw is not None
    root = Path(raw)
    assert root.is_absolute() and not root.is_symlink() and root.is_dir()
    info = root.lstat()
    assert stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
    assert stat.S_IMODE(info.st_mode) == 0o700
    return root


def _spawn_barrier_dispatcher(config: Path, command_id: str, barrier_socket: Path,
                              private_root: Path, child_source: Path,
                              hook_phase: str = "before_start_rpc"):
    cache = normal._private_dir(private_root / "pycache-start-loss-child")
    logs = private_root / "process-logs"
    if not logs.exists():
        normal._private_dir(logs)
    stdout_path = logs / "start-loss-child-stdout.log"
    stderr_path = logs / "start-loss-child-stderr.log"
    out_fd = os.open(stdout_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    err_fd = os.open(stderr_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    env = normal._minimal_runtime_env(private_root, config)
    argv = [sys.executable, "-B", "-X", "pycache_prefix=" + str(cache), str(child_source),
            "--command-id", command_id, "--barrier-socket", str(barrier_socket),
            "--hook-phase", hook_phase,
            "--repo-root", str(normal.REPO_ROOT)]
    try:
        process = subprocess.Popen(argv, cwd=normal.REPO_ROOT, stdin=subprocess.DEVNULL,
                                   stdout=out_fd, stderr=err_fd, env=env, start_new_session=True)
    finally:
        os.close(out_fd)
        os.close(err_fd)
    ticks = normal.process_identity(process.pid)
    if ticks is None:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        raise AssertionError("start-loss child identity unavailable")
    process._ifpmic_start_ticks = ticks
    return process, {"role": "start-loss-dispatcher", "pid": process.pid,
                     "start_ticks": ticks, "stdout": stdout_path,
                     "stderr": stderr_path, "cache": cache}


def _fresh_clock_claim_state(harness, command_id: str):
    with psycopg.connect(normal.owner_dsn(harness["database"])) as owner:
        return owner.execute(
            "SELECT state,generation,claim_token::text,claim_expires_at<=clock_timestamp() "
            "FROM ifpmic.commands_outbox WHERE command_id=%s", (command_id,),
        ).fetchone()


def _await_expired_first_claim(harness, command_id: str, original_token: str, deadline: float) -> None:
    while time.monotonic() < deadline:
        row = _fresh_clock_claim_state(harness, command_id)
        assert row is not None and row[:3] == ("leased", 1, original_token)
        if row[3]:
            return
        time.sleep(min(0.1, max(0.0, deadline - time.monotonic())))
    raise TimeoutError("original dispatcher lease did not expire before deadline")


async def _observe_started_direct(endpoint: str, namespace: str, workflow_id: str,
                                  expected_input: dict[str, object], expected_queue: str, deadline: float,
                                  evidence_root: Path) -> dict[str, object]:
    """Observe backend history directly, bypassing the response-holding proxy."""
    from services.ifpmic_api.execution_temporal import DATA_CONVERTER, WORKFLOW_TYPE
    from datetime import timedelta
    client = await asyncio.wait_for(Client.connect(
        endpoint, namespace=namespace, data_converter=DATA_CONVERTER,
        identity="ifpmic-h2-independent-start-observer"), timeout=min(10, _remaining(deadline)))
    assert client.namespace == namespace
    retention = await asyncio.wait_for(client.workflow_service.describe_namespace(
        DescribeNamespaceRequest(namespace=namespace), timeout=timedelta(seconds=5)),
        timeout=min(10, _remaining(deadline)))
    ttl = retention.config.workflow_execution_retention_ttl
    assert retention.namespace_info.name == namespace and ttl.seconds > 3600
    assert 0 <= ttl.nanos < 1_000_000_000
    while time.monotonic() < deadline:
        runs = []
        async for item in client.list_workflows(
            f'WorkflowId = "{workflow_id}"', limit=10,
            rpc_timeout=timedelta(seconds=min(5, _remaining(deadline))),
        ):
            runs.append(item)
        if len(runs) > 1:
            raise AssertionError("direct backend observer found multiple logical executions")
        if runs:
            desc = await client.get_workflow_handle(workflow_id, run_id=runs[0].run_id).describe(
                rpc_timeout=timedelta(seconds=min(5, _remaining(deadline))))
            assert desc.namespace == namespace and desc.id == workflow_id
            assert desc.run_id == runs[0].run_id and desc.workflow_type == WORKFLOW_TYPE
            from uuid import UUID
            assert str(UUID(desc.run_id)) == desc.run_id
            assert desc.status.name == "RUNNING"
            history = await client.get_workflow_handle(workflow_id, run_id=desc.run_id).fetch_history(
                rpc_timeout=timedelta(seconds=min(5, _remaining(deadline))))
            started = [event for event in history.events if event.event_id == 1]
            assert len(started) == 1 and started[0].HasField("workflow_execution_started_event_attributes")
            assert sum(event.HasField("workflow_execution_started_event_attributes")
                       for event in history.events) == 1
            assert not any(event.HasField("workflow_execution_completed_event_attributes")
                           or event.HasField("workflow_execution_continued_as_new_event_attributes")
                           for event in history.events)
            attrs = started[0].workflow_execution_started_event_attributes
            decoded = await client.data_converter.decode_wrapper(attrs.input)
            assert decoded == [expected_input]
            assert attrs.original_execution_run_id == desc.run_id
            assert attrs.workflow_id == workflow_id
            assert attrs.workflow_type.name == WORKFLOW_TYPE
            assert attrs.task_queue.name == expected_queue
            raw = b"".join(len(item.SerializeToString(deterministic=True)).to_bytes(8, "big")
                           + item.SerializeToString(deterministic=True) for item in history.events)
            normal._write_private(evidence_root / "accepted-start-history-before-kill.pbseq", raw)
            result = {
                "workflow_id": desc.id, "run_id": desc.run_id,
                "observed_started_monotonic": time.monotonic(),
                "execution_count": len(runs), "started_event_count": len(started),
                "started_input": decoded, "event_ids": [int(event.event_id) for event in history.events],
                "status": desc.status.name, "retention_seconds": int(ttl.seconds),
                "raw_history_sha256": hashlib.sha256(raw).hexdigest(), "raw_history_bytes": len(raw),
            }
            normal._write_private(evidence_root / "accepted-start-observer.json",
                                  normal._canonical(result) + b"\n")
            return result
        await asyncio.sleep(min(0.1, max(0.0, deadline - time.monotonic())))
    raise TimeoutError("independent backend observer did not see persisted Started history")


async def _list_workflow_runs(endpoint: str, namespace: str, workflow_id: str,
                              deadline: float) -> list[dict[str, object]]:
    client = await asyncio.wait_for(Client.connect(
        endpoint, namespace=namespace, identity="ifpmic-h2-independent-empty-history-observer"),
        timeout=min(10, _remaining(deadline)))
    found = []
    async for item in client.list_workflows(
        f'WorkflowId = "{workflow_id}"', limit=10,
        rpc_timeout=timedelta(seconds=min(5, _remaining(deadline))),
    ):
        found.append({"workflow_id": item.id, "run_id": item.run_id,
                      "status": getattr(item.status, "name", str(item.status))})
    return found


def _await_admitted_run(harness, job_id: str, expected_run_id: str, deadline: float):
    while time.monotonic() < deadline:
        snapshot = normal._read_owner_snapshot(harness, job_id)
        accepted = snapshot["accepted"]
        if accepted and accepted[12] == "rejected":
            raise AssertionError("accepted create command was rejected during reconciliation")
        if snapshot["bindings"] and snapshot["bindings"][0][20] == "quarantined":
            raise AssertionError("known persisted Started run was quarantined")
        if (accepted and accepted[16] == 2
                and len(snapshot["bindings"]) == 1 and snapshot["bindings"][0][19] == expected_run_id
                and snapshot["bindings"][0][20] == "admitted"
                and len(snapshot["scopes"]) == 1 and accepted[15] == "dispatched"
                and accepted[18] == expected_run_id):
            assert snapshot["receipts"] == []  # worker remains stopped through recovery/admission
            assert sorted(snapshot["attempts"]) == [
                (1, "expired", None, None, True),
                (2, "started", expected_run_id, None, True),
            ]
            return snapshot
        time.sleep(min(0.1, max(0.0, deadline - time.monotonic())))
    raise TimeoutError("recovery dispatcher did not admit the original observed run")


def _await_projection(harness, job_id: str, expected_run_id: str, deadline: float):
    while time.monotonic() < deadline:
        snapshot = normal._read_owner_snapshot(harness, job_id)
        accepted = snapshot["accepted"]
        if accepted and accepted[12] == "rejected":
            raise AssertionError("command rejected instead of projecting original run")
        if snapshot["bindings"] and snapshot["bindings"][0][20] == "quarantined":
            raise AssertionError("original run binding was quarantined")
        if (accepted and accepted[3:8] == ("QUEUED", 1, 0, [], None)
                and accepted[12:15] == ("applied", 1, None)
                and accepted[15] == "dispatched" and accepted[18] == expected_run_id
                and snapshot["bindings"][0][19:21] == (expected_run_id, "admitted")
                and len(snapshot["scopes"]) == 1 and len(snapshot["receipts"]) == 1
                and sorted(snapshot["attempts"]) == [
                    (1, "expired", None, None, True),
                    (2, "started", expected_run_id, None, True),
                ]):
            return snapshot
        time.sleep(min(0.1, max(0.0, deadline - time.monotonic())))
    raise TimeoutError("projector did not apply once after the same run was admitted")


def test_actual_started_event_survives_lost_start_response_and_recovers_same_run(
    workflow_scram_hba, workspace_environment, accepted_start_case_deadline,
):
    """Persisted Started is observed independently before killing the real caller."""
    harness = workspace_environment
    case_deadline = accepted_start_case_deadline
    deadline = case_deadline.body_deadline
    evidence_root = normal._private_dir(_runtime_root() / "accepted-start-loss")
    process_journal = evidence_root / "process-journal.jsonl"
    normal._create_private_journal(process_journal)
    server = None
    proxy = None
    barrier = None
    short_barrier_dir = None
    children = []
    clean_processes = []
    records = []
    cleanup_outcomes = []
    body_passed = False
    result_path = evidence_root / "response-loss-observation.json"
    outcome = {"case_id": CASE_ID, "status": "running"}
    try:
        accepted = normal.accept_workspace_job(harness, key="h2-runtime-accepted-start-loss")
        job_id = accepted["job_id"]
        accepted_group = normal.workspace_rows(harness, job_id)
        assert accepted_group is not None
        workspace_root = Path(harness["workspace_root"])
        workspace, tree_before = normal._workspace_ready(harness, workspace_root, job_id)
        normal._add_live_sql_eligibility(harness, job_id)
        before = normal._read_owner_snapshot(harness, job_id)
        assert before["accepted"] is not None and before["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
        assert before["bindings"] == before["scopes"] == before["receipts"] == before["attempts"] == []
        assert before["noncreate_commands"] == 0
        normal._write_private(evidence_root / "owner-before-dispatch.json",
                              normal._canonical(before) + b"\n")

        toolchain = normal._read_h1_toolchain()
        tool_root = Path(toolchain["toolchain_root"])
        server_ports = normal._allocate_loopback_ports()
        temporal_data = evidence_root / "temporal-data"
        server = normal.start_server(tool_root / "temporal", toolchain["cli_binary_sha256"],
                                     temporal_data, server_ports, log_name="temporal-server.log")
        clean_processes.append(server)
        server_record = {"role": "temporal", "pid": server.pid,
                         "start_ticks": server._ifpmic_start_ticks,
                         "log": temporal_data / "temporal-server.log"}
        records.append(server_record)
        normal._append_private_journal(process_journal, {"event": "started", **server_record})
        backend_endpoint = f"127.0.0.1:{server_ports[0]}"
        proxy = TCPResponseHoldingProxy("127.0.0.1", server_ports[0])
        proxy_address = proxy.start(timeout=min(5.0, _remaining(deadline)))
        endpoint = f"{proxy_address[0]}:{proxy_address[1]}"
        server_listeners = normal._wait_for_temporal_listeners(
            server, server_ports, time.monotonic() + _remaining(deadline, 30))
        assert all(item["loopback"] for item in server_listeners)
        temporal_store = temporal_data / "temporal.sqlite"
        assert temporal_store.is_file()
        store_stat = temporal_store.stat()
        temporal_store_identity = (store_stat.st_dev, store_stat.st_ino)

        source_value = normal.source_manifest()
        environment_value = normal.environment_manifest()
        source_sha = normal._manifest_hash(source_value)
        environment_sha = normal._manifest_hash(environment_value)
        source_path = evidence_root / "source-manifest.json"
        environment_path = evidence_root / "environment-manifest.json"
        normal._write_private(source_path, normal._canonical(source_value) + b"\n")
        normal._write_private(environment_path, normal._canonical(environment_value) + b"\n")
        deployment_id = "h2-start-loss-" + uuid4().hex
        deployment_doc = {"protocol_version": normal.PROTOCOL_VERSION, "deployment_id": deployment_id,
                          "namespace": normal.NAMESPACE, "server_endpoint": endpoint}
        server_sha = normal._domain_hash("ifpmic.b03.deployment.v1", deployment_doc)
        build_doc = {"protocol_version": normal.PROTOCOL_VERSION,
                     "source_manifest_sha256": source_sha,
                     "environment_manifest_sha256": environment_sha,
                     "workflow_type": normal.WORKFLOW_TYPE}
        build_id = normal._domain_hash("ifpmic.b03.build.v1", build_doc)
        identity = {
            "deployment_id": deployment_id,
            "namespace": normal.NAMESPACE,
            "server_endpoint": endpoint,
            "server_config_sha256": server_sha,
            "build_id": build_id,
            "source_manifest_sha256": source_sha,
            "environment_manifest_sha256": environment_sha,
        }
        role_oids = normal._register_identity(harness, identity)
        dispatcher_config = normal._write_runtime_config(
            evidence_root, "dispatcher", identity,
            normal._private_dsn(harness["database"], "dispatcher"), workspace_root,
            source_path, environment_path)
        worker_config = normal._write_runtime_config(
            evidence_root, "worker", identity,
            normal._private_dsn(harness["database"], "projector"), workspace_root,
            source_path, environment_path)
        expected_initial = normal._read_owner_snapshot(harness, job_id)
        assert expected_initial == before
        assert expected_initial["bindings"] == expected_initial["scopes"] == expected_initial["receipts"] == []

        tmp_root = Path(os.environ["TMPDIR"])
        assert tmp_root.is_absolute() and not tmp_root.is_symlink()
        tmp_info = tmp_root.lstat()
        assert stat.S_ISDIR(tmp_info.st_mode) and tmp_info.st_uid == os.getuid()
        assert stat.S_IMODE(tmp_info.st_mode) == 0o700
        short_barrier_dir = normal._private_dir(tmp_root / ("h2b-" + uuid4().hex[:8]))
        barrier_socket = short_barrier_dir / "s.sock"
        barrier = StartRPCBarrier(barrier_socket, proxy)
        barrier.start()
        child_source = Path(__file__).with_name("accepted_start_dispatcher_child.py").resolve()
        assert child_source.is_file()
        child, child_record = _spawn_barrier_dispatcher(
            dispatcher_config, accepted_group[18], barrier_socket, evidence_root, child_source)
        children.append(child)
        records.append(child_record)
        normal._append_private_journal(process_journal, {"event": "started", **child_record})

        barrier.wait_hit(_remaining(deadline, 30))
        held_sequence_before_start_request = proxy.response_sequence
        barrier.release_child()
        assert proxy.wait_for_request(_remaining(deadline, 10))
        assert proxy.wait_for_held_response(_remaining(deadline, 10))
        assert proxy.response_sequence > held_sequence_before_start_request
        assert proxy.held_response_bytes > 0 and not proxy.overflowed.is_set()

        at_start = normal._read_owner_snapshot(harness, job_id)
        row = at_start["accepted"]
        assert row is not None and row[3:8] == ("DRAFT", 0, 0, [], None)
        assert type(row[10]) is str
        assert row[10] == normal._canonical(accepted["payload"]).decode("ascii")
        assert json.loads(row[10]) == accepted["payload"]
        assert row[11] == accepted_group[13] == hashlib.sha256(normal._canonical({
            "format": "ifpmic.create-job.v1", "payload": accepted["payload"],
        })).hexdigest()
        assert row[8] == accepted_group[18] and row[12:15] == ("accepted", None, None)
        assert row[15] == "leased" and row[16] == 1 and row[17] is not None and row[18] is None
        from uuid import UUID
        assert str(UUID(row[17])) == row[17]
        assert len(at_start["bindings"]) == 1
        assert at_start["bindings"][0][19] is None and at_start["bindings"][0][20] == "reserved"
        assert at_start["bindings"][0][21] is not None and at_start["bindings"][0][23] > 3600
        assert at_start["bindings"][0][24:27] == (True, True, None)
        assert at_start["scopes"] == at_start["receipts"] == []
        assert at_start["attempts"] == [(1, None, None, None, False)]
        expected_binding = normal._expected_binding(
            job_id, row, workspace, identity, harness["record"], row[11])
        immutable_fields = (
            "job_id", "project_id", "create_command_id", "deployment_id", "namespace",
            "server_config_sha256", "temporal_workflow_id", "workflow_type", "build_id", "task_queue",
            "snapshot_id", "catalog_record_sha256", "workflow_sha256", "state_sha256", "agent_sha256",
            "workspace_token", "workspace_generation", "command_payload_sha256", "binding_sha256",
        )
        actual_binding = dict(zip(immutable_fields, at_start["bindings"][0][:19]))
        assert actual_binding == expected_binding
        expected_start = {"protocol_version": normal.PROTOCOL_VERSION, "job_id": job_id,
                          "project_id": harness["project_id"],
                          "binding_sha256": expected_binding["binding_sha256"]}

        # This direct observer connects to the backend, not the proxy path used
        # by the dispatcher. Seeing event1 proves backend-persisted acceptance.
        started = asyncio.run(_observe_started_direct(
            backend_endpoint, identity["namespace"], "ifpmic.job." + job_id,
            expected_start, "ifpmic.build." + identity["build_id"], deadline, evidence_root))
        observed_run_id = started["run_id"]
        assert barrier.released_monotonic is not None
        assert time.monotonic() - barrier.released_monotonic < 9.0  # before the production 10s RPC timeout
        assert started["execution_count"] == started["started_event_count"] == 1
        assert started["started_input"] == [expected_start]
        assert started["observed_started_monotonic"] < time.monotonic()
        assert at_start["bindings"][0][19] is None
        assert at_start["scopes"] == at_start["receipts"] == []
        assert child.poll() is None and normal.process_identity(child.pid) == child_record["start_ticks"]
        assert proxy.held_response_bytes > 0 and not proxy.overflowed.is_set()
        proxy_cut = proxy.snapshot()
        assert proxy_cut["armed"] is True
        assert proxy_cut["request_forwarded_bytes_after_arm"] > 0
        assert proxy_cut["server_response_bytes_held_after_arm"] > 0
        assert proxy_cut["server_response_bytes_forwarded_after_arm"] == 0
        assert proxy_cut["overflowed"] is False
        connections = proxy_cut["connection_records"]
        assert connections and len({c["connection_id"] for c in connections}) == len(connections)
        assert all(c["client_peer"][0] == "127.0.0.1"
                   and c["client_local"][0] == "127.0.0.1"
                   and c["backend_peer"][0] == "127.0.0.1"
                   and c["backend_local"][0] == "127.0.0.1" for c in connections)
        request_connections = {e["connection_id"] for e in proxy_cut["events"]
                               if e["direction"] == "client_to_server"
                               and e["action"] == "forwarded" and e["after_arm"]}
        held_connections = {e["connection_id"] for e in proxy_cut["events"]
                            if e["direction"] == "server_to_client"
                            and e["action"] == "held" and e["after_arm"]}
        assert request_connections & held_connections
        assert proxy_cut["http2_or_grpc_frames_decoded"] is False
        normal._write_private(evidence_root / "proxy-before-kill.json",
                              normal._canonical(proxy_cut) + b"\n")
        assert normal._read_owner_snapshot(harness, job_id) == at_start
        live_claim = _fresh_clock_claim_state(harness, accepted_group[18])
        assert live_claim == ("leased", 1, row[17], False)
        barrier_trace = barrier.snapshot()
        assert barrier_trace["armed_monotonic"] <= barrier_trace["barrier_hit_monotonic"]
        assert barrier_trace["barrier_hit_monotonic"] <= barrier_trace["release_requested_monotonic"]
        assert barrier_trace["release_requested_monotonic"] <= barrier_trace["released_monotonic"]
        request_events = [e for e in proxy_cut["events"]
                          if e["direction"] == "client_to_server"
                          and e["action"] == "forwarded" and e["after_arm"]]
        held_events = [e for e in proxy_cut["events"]
                       if e["direction"] == "server_to_client"
                       and e["action"] == "held" and e["after_arm"]]
        assert request_events and held_events
        assert any(e["monotonic"] >= barrier_trace["released_monotonic"] for e in request_events)
        assert any(e["monotonic"] <= started["observed_started_monotonic"] for e in held_events)
        post_release_requests = [e for e in request_events
                                 if e["monotonic"] >= barrier_trace["released_monotonic"]]
        assert post_release_requests
        assert any(
            held["connection_id"] == request["connection_id"]
            and held["monotonic"] >= request["monotonic"]
            for request in post_release_requests for held in held_events
        )
        normal._write_private(evidence_root / "barrier-sequence.json",
                              normal._canonical(barrier_trace) + b"\n")

        # Kill only the saved, still-matching dispatcher identity while its
        # real StartWorkflow await is blocked on the held TCP response.
        assert child.poll() is None and normal.process_identity(child.pid) == child_record["start_ticks"]
        kill_requested_monotonic = time.monotonic()
        normal._append_private_journal(process_journal, {
            "event": "kill_requested", "pid": child.pid,
            "start_ticks": child_record["start_ticks"],
            "pre_kill_exit_code": child.poll(), "signal": "SIGKILL",
            "monotonic": kill_requested_monotonic,
        })
        assert time.monotonic() - barrier_trace["released_monotonic"] < 9.0
        assert child.poll() is None and normal.process_identity(child.pid) == child_record["start_ticks"]
        os.kill(child.pid, signal.SIGKILL)
        child.wait(timeout=min(5, _remaining(deadline, 5)))
        assert child.returncode == -signal.SIGKILL
        assert normal.process_identity(child.pid) is None
        proxy_through_kill = proxy.snapshot()
        assert proxy_through_kill["armed"] is True
        assert proxy_through_kill["server_response_bytes_held_after_arm"] > 0
        assert proxy_through_kill["server_response_bytes_forwarded_after_arm"] == 0
        assert not proxy_through_kill["overflowed"]
        assert proxy_through_kill["response_sequence"] > held_sequence_before_start_request
        assert not any(e["direction"] == "server_to_client" and e["action"] == "forwarded"
                       and e["after_arm"] for e in proxy_through_kill["events"])
        assert barrier_trace["release_requested_monotonic"] < kill_requested_monotonic
        assert started["observed_started_monotonic"] < kill_requested_monotonic
        normal._write_private(evidence_root / "proxy-through-kill.json",
                              normal._canonical(proxy_through_kill) + b"\n")
        normal._append_private_journal(process_journal, {
            "event": "killed_after_independent_started_observation", "pid": child.pid,
            "start_ticks": child_record["start_ticks"], "signal": "SIGKILL",
            "returncode": child.returncode, "absent": True,
        })
        assert normal._owned_process_descendants({child.pid}) == []
        after_kill = normal._read_owner_snapshot(harness, job_id)
        assert after_kill == at_start
        normal._write_private(evidence_root / "owner-at-start-attempt.json",
                              normal._canonical(at_start) + b"\n")
        normal._write_private(evidence_root / "owner-after-kill.json",
                              normal._canonical(after_kill) + b"\n")
        proxy.release()
        barrier.close()

        # The first lease is immutable and remains live until fresh DB-clock
        # expiry. No timestamps/tokens are rewritten by the test.
        original_token = row[17]
        _await_expired_first_claim(harness, accepted_group[18], original_token, deadline)
        recovery_dispatcher, recovery_record = normal._spawn_runtime_cli(
            "dispatcher", dispatcher_config, evidence_root)
        clean_processes.append(recovery_dispatcher)
        records.append(recovery_record)
        normal._append_private_journal(process_journal, {"event": "started", **recovery_record})
        recovered = _await_admitted_run(harness, job_id, observed_run_id, deadline)
        assert recovered["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
        assert recovered["accepted"][16] == 2
        assert recovered["bindings"][0][19:21] == (observed_run_id, "admitted")
        assert recovered["receipts"] == []
        assert normal.process_identity(server.pid) == server_record["start_ticks"]
        assert (temporal_store.stat().st_dev, temporal_store.stat().st_ino) == temporal_store_identity

        # Only after the production dispatcher reconciles and admits the exact
        # observed run may the real projector worker start.
        worker, worker_record = normal._spawn_runtime_cli("worker", worker_config, evidence_root)
        clean_processes.append(worker)
        records.append(worker_record)
        normal._append_private_journal(process_journal, {"event": "started", **worker_record})
        projected = _await_projection(harness, job_id, observed_run_id, deadline)
        assert projected["accepted"][3:8] == ("QUEUED", 1, 0, [], None)
        assert projected["accepted"][16] == 2
        assert projected["accepted"][12:15] == ("applied", 1, None)
        assert projected["bindings"][0][19:21] == (observed_run_id, "admitted")
        assert projected["bindings"][0][:19] == at_start["bindings"][0][:19]
        assert projected["bindings"][0][21:26] == at_start["bindings"][0][21:26]
        assert projected["bindings"][0][23] == started["retention_seconds"]
        assert len(projected["receipts"]) == 1
        proposal = {"protocol_version": normal.PROTOCOL_VERSION, "kind": "activate_create",
                    "job_id": job_id, "run_id": observed_run_id, "build_id": identity["build_id"],
                    "binding_sha256": expected_binding["binding_sha256"],
                    "transition_sequence": 1, "expected_revision": 0,
                    "command_id": accepted_group[18], "command_payload_sha256": row[11]}
        proposal_sha = normal._domain_hash("ifpmic.b03.transition.v1", proposal)
        assert len(proposal) == 10
        assert projected["receipts"][0] == (
            job_id, 1, accepted_group[18], observed_run_id, identity["build_id"], proposal_sha,
            0, "applied", {"status": "applied", "command_id": accepted_group[18],
                          "applied_revision": 1, "error_code": None, "job_id": job_id,
                          "job_status": "QUEUED", "revision": 1})
        assert projected["scopes"] == [(
            job_id, observed_run_id, role_oids["projector"], harness["database"][0].roles.projector,
            identity["deployment_id"], identity["build_id"]) ]
        assert sorted(projected["attempts"]) == [
            (1, "expired", None, None, True),
            (2, "started", observed_run_id, None, True),
        ]

        history_after_root = normal._private_dir(evidence_root / "history-after-projection")
        final_temporal = normal._observe_temporal(
            identity, job_id, harness["project_id"], observed_run_id,
            expected_start, deadline, history_after_root)
        assert final_temporal["execution_count"] == final_temporal["started_event_count"] == 1
        assert final_temporal["run_id"] == started["run_id"]
        assert final_temporal["phase"] == "queued"
        replay = harness["client"].post(
            "/api/v1/jobs", json=accepted["payload"],
            headers=normal.write_headers(harness, key="h2-runtime-accepted-start-loss"))
        assert replay.status_code == 202 and replay.json() == accepted["receipt"]
        command = harness["client"].get("/api/v1/commands/" + accepted_group[18])
        assert command.status_code == 200
        assert command.json() == {"command_id": accepted_group[18], "status": "applied",
                                  "applied_revision": 1, "error": None}
        job = harness["client"].get("/api/v1/jobs/" + job_id)
        assert job.status_code == 200 and job.json()["job"]["status"] == "QUEUED"
        assert job.json()["job"]["revision"] == 1 and job.json()["steps"] == []
        assert job.json()["job"]["current_step_ids"] == []
        assert job.json()["job"]["candidate_fingerprint"] is None
        after_replay = normal._read_owner_snapshot(harness, job_id)
        assert after_replay == projected
        normal._write_private(evidence_root / "owner-after-projection-replay.json",
                              normal._canonical(after_replay) + b"\n")
        assert normal.tree_fingerprint(workspace_root / job_id) == tree_before
        assert all(process.poll() is None for process in clean_processes)
        assert normal.process_identity(server.pid) == server_record["start_ticks"]
        assert (temporal_store.stat().st_dev, temporal_store.stat().st_ino) == temporal_store_identity
        outcome.update({
            "status": "passed", "job_id": job_id, "command_id": accepted_group[18],
            "deployment_id": identity["deployment_id"], "build_id": identity["build_id"],
            "first_started_run_id": started["run_id"], "recovered_admitted_run_id": observed_run_id,
            "execution_count": final_temporal["execution_count"],
            "started_event_count": final_temporal["started_event_count"],
            "projector_receipt_count": len(projected["receipts"]),
            "attempt_results": ["expired", "started"],
            "start_response_bytes_held": proxy.held_response_bytes,
            "server_response_bytes_forwarded_after_arm":
                proxy_through_kill["server_response_bytes_forwarded_after_arm"],
            "server_response_bytes_held_after_arm":
                proxy_through_kill["server_response_bytes_held_after_arm"],
            "kill_requested_monotonic": kill_requested_monotonic,
            "started_observed_monotonic": started["observed_started_monotonic"],
            "direct_backend_observer": True, "worker_started_after_admission": True,
            "workspace_tree_unchanged": True,
            "temporal_server_identity_unchanged": True,
            "temporal_store_device_inode_unchanged": True,
            "same_identity_config_sha256": hashlib.sha256(dispatcher_config.read_bytes()).hexdigest(),
            "owner_initial_sha256": hashlib.sha256((evidence_root / "owner-before-dispatch.json").read_bytes()).hexdigest(),
            "owner_before_start_sha256": hashlib.sha256((evidence_root / "owner-at-start-attempt.json").read_bytes()).hexdigest(),
            "owner_after_kill_sha256": hashlib.sha256((evidence_root / "owner-after-kill.json").read_bytes()).hexdigest(),
            "owner_after_projection_sha256": hashlib.sha256((evidence_root / "owner-after-projection-replay.json").read_bytes()).hexdigest(),
            "raw_history_before_sha256": started["raw_history_sha256"],
            "raw_history_after_sha256": final_temporal["raw_history_sha256"],
            "proxy_before_kill_sha256": hashlib.sha256(
                (evidence_root / "proxy-before-kill.json").read_bytes()).hexdigest(),
            "proxy_through_kill_sha256": hashlib.sha256(
                (evidence_root / "proxy-through-kill.json").read_bytes()).hexdigest(),
            "barrier_sequence_sha256": hashlib.sha256(
                (evidence_root / "barrier-sequence.json").read_bytes()).hexdigest(),
            "response_frame_identity_claimed": False,
        })
        body_passed = True
    finally:
        body_exception_active = sys.exc_info()[0] is not None
        with case_deadline.cleanup_budget():
            cleanup_deadline = case_deadline.cleanup_deadline
            cleanup_errors = []
            cleanup_violations = []
            if proxy is not None:
                try:
                    proxy.release()
                except Exception:
                    pass
            if barrier is not None:
                try:
                    barrier.close()
                except Exception:
                    pass
            if short_barrier_dir is not None:
                try:
                    short_barrier_dir.rmdir()
                except OSError:
                    outcome["barrier_dir_cleanup_error"] = True
            # Include the intentionally SIGKILLed first dispatcher handle; the
            # owner helper does not resend a signal once its process is already absent.
            all_handles = children + clean_processes
            pre_stop_codes = {}
            for proc in all_handles:
                pre_stop_code = proc.poll()
                pre_stop_codes[proc.pid] = pre_stop_code
                already_killed = proc in children and pre_stop_code == -signal.SIGKILL
                normal._append_private_journal(process_journal, {
                    "event": "stop_requested", "pid": proc.pid,
                    "start_ticks": getattr(proc, "_ifpmic_start_ticks", None),
                    "pre_stop_exit_code": pre_stop_code,
                    "mode": "already_sigkilled" if already_killed else "graceful",
                })
                if proc in children:
                    if not already_killed:
                        cleanup_violations.append("dispatcher_not_sigkilled_before_cleanup")
                elif pre_stop_code is not None:
                    cleanup_violations.append("service_exited_before_graceful_cleanup")
            if all_handles:
                remaining = max(0.1, min(12.0, cleanup_deadline - time.monotonic()))
                try:
                    cleanup_outcomes = normal.stop_all_owned(all_handles, total_timeout=remaining)
                except BaseException as exc:
                    cleanup_errors.append(type(exc).__name__)
                    cleanup_outcomes = [
                        {"absent": normal.process_identity(proc.pid) !=
                         getattr(proc, "_ifpmic_start_ticks", None),
                         "forced": None, "returncode": proc.poll()}
                        for proc in all_handles
                    ]
                for proc, result in zip(all_handles, cleanup_outcomes):
                    normal._append_private_journal(process_journal, {
                        "event": "stopped", "pid": proc.pid,
                        "start_ticks": getattr(proc, "_ifpmic_start_ticks", None),
                        "exit_code": result["returncode"], "absent": result["absent"],
                        "forced": result["forced"],
                    })
                    if proc in children:
                        if not result["absent"] or result["returncode"] != -signal.SIGKILL:
                            cleanup_violations.append("killed_dispatcher_cleanup_mismatch")
                    elif (not result["absent"] or result["forced"] is not False
                          or result["returncode"] != 0):
                        cleanup_violations.append("service_graceful_exit_mismatch")
            if proxy is not None:
                proxy.close()
            records_by_pid = {record["pid"]: record for record in records}
            outcome["processes"] = [
                {
                    "role": records_by_pid.get(proc.pid, {}).get("role", "unknown"),
                    "pid": proc.pid,
                    "start_ticks": getattr(proc, "_ifpmic_start_ticks", None),
                    "pre_stop_exit_code": pre_stop_codes.get(proc.pid),
                    "exit_code": result["returncode"],
                    "absent": result["absent"],
                    "forced": result["forced"],
                    "termination": "already_sigkilled" if proc in children else "graceful",
                }
                for proc, result in zip(all_handles, cleanup_outcomes)
            ]
            for record in records:
                for key in ("stdout", "stderr", "log"):
                    path = record.get(key)
                    if path is not None and path.is_file():
                        if stat.S_IMODE(path.stat().st_mode) != 0o600:
                            cleanup_violations.append("process_log_mode")
            outcome["status"] = "passed" if body_passed and not cleanup_violations and not cleanup_errors else "failed"
            outcome["cleanup_process_count"] = len(cleanup_outcomes)
            outcome["process_journal_sha256"] = hashlib.sha256(process_journal.read_bytes()).hexdigest()
            outcome["proxy_journal_sha256"] = _sha256_if_file(
                evidence_root / "proxy-through-kill.json")
            outcome["barrier_sequence_sha256"] = _sha256_if_file(
                evidence_root / "barrier-sequence.json")
            outcome["cleanup_error_types"] = cleanup_errors
            outcome["cleanup_violations"] = cleanup_violations
            normal._write_private(result_path, normal._canonical(outcome) + b"\n")
            if (cleanup_violations or cleanup_errors) and not body_exception_active:
                raise AssertionError("accepted-start cleanup contract failed")
