"""Real production CLI normal path for the partial H2 runtime gate."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import struct
import subprocess
import sys
import time
from datetime import timedelta
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg.conninfo import make_conninfo
from temporalio.client import Client
from temporalio.api.workflowservice.v1 import DescribeNamespaceRequest

pytest_plugins = (
    "tests.ifpmic_api.jobs_fixture",
    "tests.ifpmic_api.workspace_fixture",
    "tests.ifpmic_api.workflow_schema_fixture",
)

from services.ifpmic_api.execution_manifest import environment_manifest, source_manifest
from services.ifpmic_api.workspace import WorkspaceService
from tests.ifpmic_api.jobs_fixture import operator_dsn, owner_dsn, runtime_dsn, write_headers
from tests.ifpmic_api.workspace_fixture import (
    WORKSPACE_CHILD_NAMES, WORKSPACE_MARKER_NAME, accept_workspace_job,
    expected_marker_bytes, tree_fingerprint, workspace_rows,
)
from scripts.ifpmic_temporal_toolchain import (
    CLI_SHA, owned_listeners, process_identity, start_server, stop_all_owned,
)
from tests.ifpmic_api.h2_runtime_case_budget import BODY_SECONDS, CLEANUP_SECONDS
from tests.ifpmic_api.h2_snapshot_evidence import record_owner_snapshot, record_query_observation

REPO_ROOT = Path.cwd().resolve()
WORKFLOW_TYPE = "IFPMICJobWorkflow"
PROTOCOL_VERSION = "h2-v1"
NAMESPACE = "default"
WORKFLOW_SHA256 = "bab40a7abb3929896add1ef2cd074893dd2a7de14d200a5d6cea4b7a77eb0e89"
STATE_SHA256 = "0248e130017043539319c56af854f5388a95d33e7e687902a3438fdff414244a"
AGENT_SHA256 = "ca6d4bea7abf0fffe7354c482af0d521c3a2e367217a69923a4bfe43fa27ab64"
PROCESS_CLEANUP_SECONDS = 15
assert BODY_SECONDS + CLEANUP_SECONDS == 240
assert PROCESS_CLEANUP_SECONDS < CLEANUP_SECONDS


@pytest.fixture
def h2_runtime_deadline(request):
    """Get the runner-loaded whole-case deadline controller."""
    try:
        return request.node._ifpmic_h2_runtime_deadline
    except AttributeError:
        pytest.fail("the H2 runtime watchdog plugin must be loaded by the runner")


def _canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"),
                      allow_nan=False).encode("ascii")


def _domain_hash(domain: str, value: object) -> str:
    return hashlib.sha256(domain.encode("ascii") + b"\0" + _canonical(value)).hexdigest()


def _manifest_hash(value: object) -> str:
    return hashlib.sha256(_canonical(value)).hexdigest()


def _private_dir(path: Path) -> Path:
    path.mkdir(mode=0o700, parents=False, exist_ok=False)
    path.chmod(0o700)
    assert stat.S_IMODE(path.stat().st_mode) == 0o700
    return path


def _runtime_evidence_root() -> Path:
    raw = os.environ.get("IFPMIC_H2_RUNTIME_EVIDENCE_ROOT")
    assert raw is not None
    path = Path(raw)
    assert path.is_absolute() and not path.is_symlink() and path.is_dir()
    info = path.lstat()
    assert stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
    assert stat.S_IMODE(info.st_mode) == 0o700
    return path


def _write_private(path: Path, raw: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        view = memoryview(raw)
        while view:
            count = os.write(fd, view)
            if count <= 0:
                raise AssertionError("private evidence short write")
            view = view[count:]
        os.fsync(fd)
    finally:
        os.close(fd)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def _create_private_journal(path: Path) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.fsync(fd)
    finally:
        os.close(fd)


def _append_private_journal(path: Path, value: dict[str, object]) -> None:
    raw = _canonical({k: str(v) if isinstance(v, Path) else v for k, v in value.items()}) + b"\n"
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        assert stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
        assert info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600
        view = memoryview(raw)
        while view:
            count = os.write(fd, view)
            if count <= 0:
                raise AssertionError("private process journal short write")
            view = view[count:]
        os.fsync(fd)
    finally:
        os.close(fd)


def _read_h1_toolchain() -> dict[str, object]:
    raw = os.environ.get("IFPMIC_H1_TOOLCHAIN_MANIFEST")
    assert raw is not None
    path = Path(raw)
    assert path.is_absolute() and not path.is_symlink() and path.is_file()
    assert stat.S_IMODE(path.stat().st_mode) & 0o077 == 0
    value = json.loads(path.read_text(encoding="utf-8"))
    assert type(value) is dict
    assert type(value.get("toolchain_root")) is str
    assert type(value.get("cli_binary_sha256")) is str
    root = Path(value["toolchain_root"])
    assert root.is_absolute() and not root.is_symlink()
    assert Path(sys.prefix).resolve() == (root / "venv").resolve()
    assert Path(sys.executable).resolve() == (root / "venv/bin/python").resolve()
    assert value["cli_binary_sha256"] == CLI_SHA
    assert type(value.get("installed")) is dict
    expected_inventory = {}
    for line in (REPO_ROOT / "services/ifpmic_api/requirements-temporal.lock").read_text(
            encoding="utf-8").splitlines():
        match = re.match(r"^([A-Za-z0-9_.-]+)==([^\s\\]+)", line)
        if match:
            name = match.group(1).lower().replace("_", "-")
            assert name not in expected_inventory
            expected_inventory[name] = match.group(2)
    assert len(expected_inventory) == 36
    assert value["installed"] == expected_inventory
    return value


def _allocate_loopback_ports() -> list[int]:
    sockets: list[socket.socket] = []
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


def _wait_for_temporal_listeners(process, ports: list[int], deadline: float) -> list[dict[str, object]]:
    last: list[dict[str, object]] = []
    while time.monotonic() < deadline:
        assert process.poll() is None
        last = owned_listeners(process)
        assert all(item["loopback"] for item in last)
        if set(ports) <= {item["port"] for item in last}:
            return last
        time.sleep(min(0.1, max(0.0, deadline - time.monotonic())))
    raise AssertionError("owned Temporal process did not open its loopback listeners before deadline")


def _register_identity(harness, identity: dict[str, str]) -> dict[str, int]:
    database = harness["database"]
    migration, _cluster = database
    roles = migration.roles
    with psycopg.connect(owner_dsn(database)) as owner:
        role_oids = dict(owner.execute(
            "SELECT rolname,oid::bigint FROM pg_roles WHERE rolname=ANY(%s)",
            ([roles.dispatcher, roles.projector],),
        ).fetchall())
        assert set(role_oids) == {roles.dispatcher, roles.projector}
        owner.execute(
            "INSERT INTO ifpmic.execution_deployments"
            "(deployment_id,namespace,server_endpoint,server_config_sha256) VALUES(%s,%s,%s,%s)",
            (identity["deployment_id"], identity["namespace"], identity["server_endpoint"],
             identity["server_config_sha256"]),
        )
        owner.execute(
            "INSERT INTO ifpmic.engine_builds"
            "(deployment_id,build_id,source_manifest_sha256,environment_manifest_sha256,"
            "workflow_type,task_queue,protocol_version) VALUES(%s,%s,%s,%s,%s,%s,%s)",
            (identity["deployment_id"], identity["build_id"], identity["source_manifest_sha256"],
             identity["environment_manifest_sha256"], WORKFLOW_TYPE,
             "ifpmic.build." + identity["build_id"], PROTOCOL_VERSION),
        )
        owner.execute(
            "INSERT INTO ifpmic.worker_principals"
            "(role_oid,role_name,kind,deployment_id,build_id)"
            "VALUES(%s,%s,'dispatcher',%s,NULL),(%s,%s,'projector',%s,%s)",
            (role_oids[roles.dispatcher], roles.dispatcher, identity["deployment_id"],
             role_oids[roles.projector], roles.projector, identity["deployment_id"], identity["build_id"]),
        )
        registered = owner.execute(
            "SELECT d.namespace,d.server_endpoint,d.server_config_sha256,b.build_id,"
            "b.source_manifest_sha256,b.environment_manifest_sha256,b.workflow_type,b.task_queue,"
            "b.protocol_version,p.role_name,p.kind,p.build_id,p.active "
            "FROM ifpmic.execution_deployments d JOIN ifpmic.engine_builds b USING(deployment_id) "
            "JOIN ifpmic.worker_principals p USING(deployment_id) "
            "WHERE d.deployment_id=%s ORDER BY p.kind", (identity["deployment_id"],),
        ).fetchall()
    assert len(registered) == 2
    assert {(row[9], row[10], row[11], row[12]) for row in registered} == {
        (roles.dispatcher, "dispatcher", None, True),
        (roles.projector, "projector", identity["build_id"], True),
    }
    assert all(row[:9] == (
        identity["namespace"], identity["server_endpoint"], identity["server_config_sha256"],
        identity["build_id"], identity["source_manifest_sha256"], identity["environment_manifest_sha256"],
        WORKFLOW_TYPE, "ifpmic.build." + identity["build_id"], PROTOCOL_VERSION,
    ) for row in registered)
    return {"dispatcher": role_oids[roles.dispatcher], "projector": role_oids[roles.projector]}


def _private_dsn(database, role: str) -> str:
    migration, cluster = database
    if role == "dispatcher":
        user, password = migration.roles.dispatcher, migration.roles.dispatcher_password
    elif role == "projector":
        user, password = migration.roles.projector, migration.roles.projector_password
    else:
        raise AssertionError("unsupported runtime role")
    value = make_conninfo(host=str(cluster.socket_dir), port=str(cluster.port), dbname=migration.name,
                          user=user, password=password)
    from psycopg.conninfo import conninfo_to_dict
    assert set(conninfo_to_dict(value)) == {"host", "port", "dbname", "user", "password"}
    return value


def _write_runtime_config(root: Path, mode: str, identity: dict[str, str], dsn: str,
                          workspace_root: Path, source_path: Path, environment_path: Path) -> Path:
    config = {
        "format": "ifpmic.h2.runtime.v1",
        "mode": mode,
        "identity": identity,
        "dsn": dsn,
        "workspace_root": str(workspace_root),
        "source_manifest_path": str(source_path),
        "environment_manifest_path": str(environment_path),
    }
    path = root / (mode + "-config.json")
    _write_private(path, _canonical(config) + b"\n")
    return path


def _minimal_runtime_env(tmp_root: Path, config_path: Path) -> dict[str, str]:
    tool_bin = str((Path(sys.prefix) / "bin").resolve())
    return {
        "PATH": os.pathsep.join((tool_bin, "/usr/bin", "/bin")),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
        "TMPDIR": str(tmp_root),
        "IFPMIC_EXECUTION_CONFIG": str(config_path),
    }


def _spawn_runtime_cli(role: str, config_path: Path, private_root: Path):
    cache = _private_dir(private_root / ("pycache-" + role))
    log_root = private_root / "process-logs"
    if not log_root.exists():
        _private_dir(log_root)
    stdout_path = log_root / (role + "-stdout.log")
    stderr_path = log_root / (role + "-stderr.log")
    stdout_fd = os.open(stdout_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    stderr_fd = os.open(stderr_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    env = _minimal_runtime_env(private_root, config_path)
    argv = [sys.executable, "-B", "-X", "pycache_prefix=" + str(cache),
            "-m", "services.ifpmic_api.execution_runtime"]
    try:
        process = subprocess.Popen(argv, cwd=REPO_ROOT, stdin=subprocess.DEVNULL,
                                   stdout=stdout_fd, stderr=stderr_fd, env=env, start_new_session=True)
    finally:
        os.close(stdout_fd)
        os.close(stderr_fd)
    ticks = process_identity(process.pid)
    if ticks is None:
        # Keep ownership of the just-created child even if /proc identity
        # capture fails; never let an unjournaled CLI survive this fixture.
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        raise AssertionError("runtime CLI process identity unavailable")
    process._ifpmic_start_ticks = ticks
    return process, {"role": role, "pid": process.pid, "start_ticks": ticks,
                     "stdout": stdout_path, "stderr": stderr_path, "cache": cache}


def _owned_process_descendants(roots: set[int]) -> list[tuple[int, str]]:
    parents: dict[int, tuple[int, str]] = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            raw = (entry / "stat").read_text(encoding="ascii")
            fields = raw[raw.rfind(")") + 2:].split()
            pid = int(entry.name)
            parents[pid] = (int(fields[1]), fields[19])
        except (OSError, ValueError, IndexError):
            continue
    descendants: list[tuple[int, str]] = []
    seen = set(roots)
    while True:
        children = [(pid, ticks) for pid, (ppid, ticks) in parents.items()
                    if ppid in seen and pid not in seen]
        if not children:
            return descendants
        descendants.extend(children)
        seen.update(pid for pid, _ in children)


def _workspace_ready(harness, workspace_root: Path, job_id: str) -> tuple[dict[str, object], list[dict[str, object]]]:
    settings = harness["settings"]
    service = WorkspaceService(
        settings,
        db_factory=lambda: psycopg.connect(runtime_dsn(harness["database"]), autocommit=True),
    )
    result = service.reconcile_once(job_id)
    assert result["status"] == "ready"
    rows = workspace_rows(harness, job_id)
    assert rows is not None and rows[20:22] == ("READY", 1)
    token = rows[19]
    job_path = workspace_root / job_id
    assert (job_path / WORKSPACE_MARKER_NAME).read_bytes() == expected_marker_bytes(job_id, token)
    assert {entry.name for entry in job_path.iterdir()} == {WORKSPACE_MARKER_NAME, *WORKSPACE_CHILD_NAMES}
    assert all((job_path / name).is_dir() and not any((job_path / name).iterdir())
               for name in WORKSPACE_CHILD_NAMES)
    tree = tree_fingerprint(job_path)
    expected_paths = {WORKSPACE_MARKER_NAME, *WORKSPACE_CHILD_NAMES}
    assert {str(row["path"]) for row in tree} == expected_paths
    return {"workspace_token": token, "workspace_generation": rows[21]}, tree


def _add_live_sql_eligibility(harness, job_id: str) -> None:
    rows = workspace_rows(harness, job_id)
    assert rows is not None
    database = harness["database"]
    with psycopg.connect(operator_dsn(database), autocommit=True) as operator:
        operator.execute(
            "INSERT INTO ifpmic.profile_eligibility"
            "(project_id,snapshot_id,mode,evidence_ref,evidence_sha256,granted_at,expires_at) "
            "SELECT %s,%s,mode,%s,%s,clock_timestamp()-interval '1 day',"
            "clock_timestamp()+interval '30 days' FROM ifpmic.profile_catalog "
            "WHERE project_id=%s AND snapshot_id=%s",
            (rows[1], rows[2], "h2-runtime-current-db-clock", "e" * 64, rows[1], rows[2]),
        )
        assert operator.execute(
            "SELECT count(*) FROM ifpmic.profile_eligibility WHERE project_id=%s AND snapshot_id=%s "
            "AND evidence_ref=%s AND granted_at<=clock_timestamp() AND expires_at>clock_timestamp()",
            (rows[1], rows[2], "h2-runtime-current-db-clock"),
        ).fetchone() == (1,)


def _read_owner_snapshot(harness, job_id: str) -> dict[str, object]:
    with psycopg.connect(owner_dsn(harness["database"])) as owner:
        accepted = owner.execute(
            "SELECT j.owner_id::text,j.project_id,j.snapshot_id,j.status,j.revision,j.cycle,"
            "j.current_step_ids,j.candidate_fingerprint,j.create_command_id::text,"
            "c.route,c.command_payload_json,c.payload_sha256,c.status,c.applied_revision,c.error_code,"
            "o.state,o.generation,o.claim_token::text,o.observed_run_id::text,"
            "w.command_id::text,w.workspace_token::text,w.state,w.generation "
            "FROM ifpmic.jobs j JOIN ifpmic.commands c ON c.command_id=j.create_command_id AND c.job_id=j.job_id "
            "JOIN ifpmic.commands_outbox o ON o.command_id=c.command_id "
            "JOIN ifpmic.workspace_intents w ON w.job_id=j.job_id WHERE j.job_id=%s", (job_id,),
        ).fetchone()
        binding = owner.execute(
            "SELECT job_id::text,project_id,create_command_id::text,deployment_id,namespace,"
            "server_config_sha256,temporal_workflow_id,workflow_type,build_id,task_queue,snapshot_id,"
            "catalog_record_sha256,workflow_sha256,state_sha256,agent_sha256,workspace_token::text,"
            "workspace_generation,command_payload_sha256,binding_sha256,admitted_run_id::text,state,"
            "first_start_attempt_at::text,uncertain_until::text,observed_retention_seconds,"
            "uncertain_until-first_start_attempt_at=interval '1 hour',"
            "uncertain_until>clock_timestamp(),quarantine_code "
            "FROM ifpmic.execution_bindings WHERE job_id=%s", (job_id,),
        ).fetchall()
        scopes = owner.execute(
            "SELECT job_id::text,admitted_run_id::text,projector_role_oid::bigint,projector_role_name,"
            "deployment_id,build_id FROM ifpmic.worker_run_scopes WHERE job_id=%s", (job_id,),
        ).fetchall()
        receipts = owner.execute(
            "SELECT job_id::text,transition_sequence,command_id::text,admitted_run_id::text,build_id,"
            "proposal_sha256,expected_revision,outcome,result_json FROM ifpmic.projection_receipts WHERE job_id=%s",
            (job_id,),
        ).fetchall()
        attempts = owner.execute(
            "SELECT generation,result,observed_run_id::text,error_code,completed_at IS NOT NULL "
            "FROM ifpmic.delivery_attempts WHERE command_id=(SELECT create_command_id FROM ifpmic.jobs WHERE job_id=%s)",
            (job_id,),
        ).fetchall()
        noncreate = owner.execute(
            "SELECT count(*) FROM ifpmic.commands WHERE job_id=%s AND command_id<>"
            "(SELECT create_command_id FROM ifpmic.jobs WHERE job_id=%s)", (job_id, job_id),
        ).fetchone()[0]
    snapshot = {"accepted": accepted, "bindings": binding, "scopes": scopes,
                "receipts": receipts, "attempts": attempts, "noncreate_commands": noncreate}
    record_owner_snapshot(job_id, snapshot)
    return snapshot


def _expected_binding(job_id: str, rows: tuple, workspace: dict[str, object], identity: dict[str, str],
                      record, payload_sha: str) -> dict[str, object]:
    document = {
        "job_id": job_id,
        "project_id": rows[1],
        "create_command_id": rows[8],
        "deployment_id": identity["deployment_id"],
        "namespace": identity["namespace"],
        "server_config_sha256": identity["server_config_sha256"],
        "temporal_workflow_id": "ifpmic.job." + job_id,
        "workflow_type": WORKFLOW_TYPE,
        "build_id": identity["build_id"],
        "task_queue": "ifpmic.build." + identity["build_id"],
        "snapshot_id": rows[2],
        "catalog_record_sha256": record.record_bytes_sha256,
        "workflow_sha256": WORKFLOW_SHA256,
        "state_sha256": STATE_SHA256,
        "agent_sha256": AGENT_SHA256,
        "workspace_token": workspace["workspace_token"],
        "workspace_generation": workspace["workspace_generation"],
        "command_payload_sha256": payload_sha,
    }
    assert len(document) == 18
    document["binding_sha256"] = _domain_hash("ifpmic.b03.execution-binding.v1", document.copy())
    return document


async def _observe_real_temporal(identity: dict[str, str], job_id: str, project_id: str,
                                 expected_run_id: str, expected_start: dict[str, object],
                                 deadline_seconds: float, evidence_dir: Path) -> dict[str, object]:
    client = await asyncio.wait_for(
        Client.connect(identity["server_endpoint"], namespace=identity["namespace"]), timeout=10,
    )
    assert client.namespace == identity["namespace"]
    loop = asyncio.get_running_loop()
    deadline = loop.time() + deadline_seconds
    workflow_name = "ifpmic.job." + job_id
    executions: list[dict[str, object]] = []
    last_phase = None
    namespace_info = await asyncio.wait_for(
        client.workflow_service.describe_namespace(
            DescribeNamespaceRequest(namespace=identity["namespace"]), timeout=timedelta(seconds=10),
        ), timeout=10,
    )
    assert namespace_info.namespace_info.name == identity["namespace"]
    retention = namespace_info.config.workflow_execution_retention_ttl
    assert retention.seconds > 3600 and 0 <= retention.nanos < 1_000_000_000
    retention_seconds = int(retention.seconds)
    while loop.time() < deadline:
        async for item in client.list_workflows(
            f'WorkflowId = "{workflow_name}"', limit=10, rpc_timeout=timedelta(seconds=10),
        ):
            executions.append({"workflow_id": item.id, "run_id": item.run_id,
                               "status": getattr(item.status, "name", str(item.status))})
        record_query_observation("temporal.list_workflows", workflow_name,
                                 {"endpoint": identity["server_endpoint"],
                                  "namespace": identity["namespace"], "runs": executions})
        if len(executions) > 1:
            raise AssertionError("more than one logical Temporal execution was observed")
        if executions:
            current = executions[0]
            if current["run_id"] != expected_run_id:
                raise AssertionError("Temporal run differs from SQL-admitted run")
            assert current["status"] == "RUNNING"
            handle = client.get_workflow_handle(workflow_name, run_id=expected_run_id)
            description = await handle.describe(rpc_timeout=timedelta(seconds=10))
            assert description.id == workflow_name
            assert description.run_id == expected_run_id
            assert description.namespace == identity["namespace"]
            assert getattr(description.status, "name", str(description.status)) == "RUNNING"
            assert description.workflow_type == WORKFLOW_TYPE
            assert description.task_queue == "ifpmic.build." + identity["build_id"]
            last_phase = await handle.query("phase", rpc_timeout=timedelta(seconds=10))
            if last_phase == "queued":
                history = await handle.fetch_history(rpc_timeout=timedelta(seconds=10))
                started = [event for event in history.events if event.event_id == 1]
                assert len(started) == 1
                assert sum(event.HasField("workflow_execution_started_event_attributes")
                           for event in history.events) == 1
                assert not any(event.HasField("workflow_execution_continued_as_new_event_attributes")
                               for event in history.events)
                assert not any(event.HasField("workflow_execution_completed_event_attributes")
                               for event in history.events)
                attrs = started[0].workflow_execution_started_event_attributes
                decoded = await client.data_converter.decode_wrapper(attrs.input)
                assert decoded == [expected_start]
                assert attrs.original_execution_run_id == expected_run_id
                assert attrs.workflow_id == workflow_name
                assert attrs.workflow_type.name == WORKFLOW_TYPE
                assert attrs.task_queue.name == "ifpmic.build." + identity["build_id"]
                raw_events = [event.SerializeToString(deterministic=True) for event in history.events]
                raw_history = b"".join(struct.pack(">Q", len(raw)) + raw for raw in raw_events)
                _write_private(evidence_dir / "temporal-history.pbseq", raw_history)
                return {
                    "workflow_id": workflow_name,
                    "run_id": expected_run_id,
                    "execution_count": len(executions),
                    "started_event_count": len(started),
                    "started_input": decoded,
                    "phase": last_phase,
                    "event_ids": [int(event.event_id) for event in history.events],
                    "project_id": project_id,
                    "observed_retention_seconds": retention_seconds,
                    "raw_history_sha256": hashlib.sha256(raw_history).hexdigest(),
                    "raw_history_bytes": len(raw_history),
                }
        executions = []
        await asyncio.sleep(min(0.1, max(0.0, deadline - loop.time())))
    raise TimeoutError("expected real workflow history and queued query before deadline")
    # Temporal 1.34's Client exposes no close method. The client drops out of
    # scope here; the SDK default Runtime owns process-lifetime cleanup.


def _observe_temporal(identity: dict[str, str], job_id: str, project_id: str,
                      run_id: str, expected_start: dict[str, object], deadline: float,
                      evidence_dir: Path):
    remaining = deadline - time.monotonic()
    assert remaining > 0
    return asyncio.run(_observe_real_temporal(
        identity, job_id, project_id, run_id, expected_start, remaining, evidence_dir,
    ))


def _wait_for_sql_outcome(harness, job_id: str, deadline: float, processes=()) -> dict[str, object]:
    while time.monotonic() < deadline:
        if any(process.poll() is not None for process in processes):
            raise AssertionError("owned runtime CLI exited before SQL projection completed")
        snapshot = _read_owner_snapshot(harness, job_id)
        accepted = snapshot["accepted"]
        if accepted and accepted[12] == "rejected":
            raise AssertionError("create command reached rejected terminal state")
        if snapshot["bindings"] and snapshot["bindings"][0][20] == "quarantined":
            raise AssertionError("execution binding was quarantined")
        if (accepted and accepted[3] == "QUEUED" and len(snapshot["bindings"]) == 1
                and len(snapshot["scopes"]) == 1 and len(snapshot["receipts"]) == 1
                and snapshot["bindings"][0][19] is not None
                and snapshot["bindings"][0][20] == "admitted"
                and accepted[15] == "dispatched"
                and accepted[18] == snapshot["bindings"][0][19]
                and snapshot["attempts"] == [(1, "started", snapshot["bindings"][0][19], None, True)]):
            return snapshot
        time.sleep(min(0.1, max(0.0, deadline - time.monotonic())))
    raise TimeoutError("SQL projection did not reach the expected queued outcome before deadline")


def _assert_runtime_oracles(snapshot: dict[str, object], harness, accepted, accepted_group,
                            workspace: dict[str, object], identity: dict[str, str],
                            role_oids: dict[str, int], temporal: dict[str, object]) -> dict[str, object]:
    job_id = accepted["job_id"]
    rows = snapshot["accepted"]
    assert rows is not None
    assert rows[1:8] == (harness["project_id"], harness["record"].snapshot_id,
                         "QUEUED", 1, 0, [], None)
    assert rows[8] == accepted_group[18]
    command_id, route, payload_value, payload_sha = rows[8], rows[9], rows[10], rows[11]
    assert route == "POST /api/v1/jobs"
    assert (rows[0:3], rows[8:12]) == (
        accepted_group[0:3],
        (accepted_group[18], accepted_group[10], accepted_group[12], accepted_group[13]),
    )
    assert accepted_group[4:9] == ("DRAFT", 0, 0, [], None)
    assert accepted_group[14:17] == ("accepted", None, None)
    assert type(payload_value) is str
    assert payload_value == _canonical(accepted["payload"]).decode("ascii")
    assert json.loads(payload_value) == accepted["payload"]
    expected_payload_sha = hashlib.sha256(_canonical({
        "format": "ifpmic.create-job.v1", "payload": accepted["payload"],
    })).hexdigest()
    assert payload_sha == accepted_group[13] == expected_payload_sha
    assert rows[12:15] == ("applied", 1, None)
    assert rows[15:17] == ("dispatched", 1)
    assert rows[18] == temporal["run_id"]
    assert rows[19:23] == (command_id, workspace["workspace_token"], "READY", 1)
    assert snapshot["noncreate_commands"] == 0

    bindings = snapshot["bindings"]
    assert len(bindings) == 1
    binding = bindings[0]
    expected = _expected_binding(job_id, rows, workspace, identity, harness["record"], payload_sha)
    immutable_fields = (
        "job_id", "project_id", "create_command_id", "deployment_id", "namespace",
        "server_config_sha256", "temporal_workflow_id", "workflow_type", "build_id", "task_queue",
        "snapshot_id", "catalog_record_sha256", "workflow_sha256", "state_sha256", "agent_sha256",
        "workspace_token", "workspace_generation", "command_payload_sha256", "binding_sha256",
    )
    actual_map = dict(zip(immutable_fields, binding[:19]))
    for name in immutable_fields:
        assert type(actual_map[name]) is type(expected[name]) and actual_map[name] == expected[name]
    assert binding[19] == temporal["run_id"] and binding[20] == "admitted"
    assert binding[21] is not None and binding[22] > binding[21] and binding[23] > 3600
    assert binding[23] == temporal["observed_retention_seconds"]
    assert binding[24] is True
    assert binding[25] is True
    assert binding[26] is None

    assert snapshot["scopes"] == [(
        job_id, temporal["run_id"], role_oids["projector"],
        harness["database"][0].roles.projector,
        identity["deployment_id"], identity["build_id"],
    )]
    assert len(snapshot["receipts"]) == 1
    receipt = snapshot["receipts"][0]
    proposal = {
        "protocol_version": PROTOCOL_VERSION, "kind": "activate_create", "job_id": job_id,
        "run_id": temporal["run_id"], "build_id": identity["build_id"],
        "binding_sha256": expected["binding_sha256"], "transition_sequence": 1,
        "expected_revision": 0, "command_id": command_id,
        "command_payload_sha256": payload_sha,
    }
    proposal_sha = _domain_hash("ifpmic.b03.transition.v1", proposal)
    assert len(proposal) == 10 and receipt == (
        job_id, 1, command_id, temporal["run_id"], identity["build_id"], proposal_sha,
        0, "applied", {
            "status": "applied", "command_id": command_id, "applied_revision": 1,
            "error_code": None, "job_id": job_id, "job_status": "QUEUED", "revision": 1,
        },
    )
    assert snapshot["attempts"] == [(1, "started", temporal["run_id"], None, True)]
    assert temporal["workflow_id"] == "ifpmic.job." + job_id
    assert temporal["execution_count"] == temporal["started_event_count"] == 1
    assert temporal["phase"] == "queued"
    assert temporal["started_input"] == [{
        "protocol_version": PROTOCOL_VERSION, "job_id": job_id,
        "project_id": harness["project_id"], "binding_sha256": expected["binding_sha256"],
    }]
    assert temporal["project_id"] == harness["project_id"]
    assert len(temporal["event_ids"]) == len(set(temporal["event_ids"]))
    assert temporal["event_ids"] == sorted(temporal["event_ids"])
    assert temporal["event_ids"][0] == 1
    return {"binding_sha256": expected["binding_sha256"], "proposal_sha256": proposal_sha,
            "command_id": command_id, "run_id": temporal["run_id"], "payload_sha256": payload_sha,
            "workflow_id": temporal["workflow_id"], "source_manifest_sha256": identity["source_manifest_sha256"],
            "environment_manifest_sha256": identity["environment_manifest_sha256"]}


@pytest.fixture
def h2_runtime_harness(workflow_scram_hba, workspace_environment):
    """Order the explicit SCRAM HBA fixture before G4/G5 setup."""
    return workspace_environment


def test_h2_runtime_real_cli_create_ready_admits_one_run_and_queues_one_receipt(
    h2_runtime_harness, h2_runtime_deadline,
):
    harness = h2_runtime_harness
    deadline = h2_runtime_deadline
    assert REPO_ROOT.joinpath("services/ifpmic_api/execution_runtime.py").is_file()
    accepted = accept_workspace_job(harness, key="h2-runtime-real-cli-normal-flow")
    job_id = accepted["job_id"]
    assert accepted["payload"] == {
        "project_id": harness["project_id"], "title": "G4 synthetic job",
        "request_text": "Validate isolated acceptance", "change_type": "FEATURE",
        "base_ref": "refs/heads/main", "input_artifact_ids": [],
        "profile_version": harness["profile_version"], "release_mode": "team_github_tag",
    }
    accepted_group = workspace_rows(harness, job_id)
    assert accepted_group is not None
    workspace_root = Path(harness["workspace_root"])
    workspace, tree_before = _workspace_ready(harness, workspace_root, job_id)
    _add_live_sql_eligibility(harness, job_id)

    private_root = _private_dir(_runtime_evidence_root() / "runtime-normal-flow")
    process_journal = private_root / "process-journal.jsonl"
    _create_private_journal(process_journal)
    toolchain = _read_h1_toolchain()
    tool_root = Path(toolchain["toolchain_root"])
    temporal_cli = tool_root / "temporal"
    ports = _allocate_loopback_ports()
    endpoint = f"127.0.0.1:{ports[0]}"
    deployment_id = "h2-runtime-" + uuid4().hex

    source_value = source_manifest()
    environment_value = environment_manifest()
    source_sha = _manifest_hash(source_value)
    environment_sha = _manifest_hash(environment_value)
    source_path = private_root / "source-manifest.json"
    environment_path = private_root / "environment-manifest.json"
    _write_private(source_path, _canonical(source_value) + b"\n")
    _write_private(environment_path, _canonical(environment_value) + b"\n")

    deployment_document = {
        "protocol_version": PROTOCOL_VERSION, "deployment_id": deployment_id,
        "namespace": NAMESPACE, "server_endpoint": endpoint,
    }
    server_sha = _domain_hash("ifpmic.b03.deployment.v1", deployment_document)
    build_document = {
        "protocol_version": PROTOCOL_VERSION, "source_manifest_sha256": source_sha,
        "environment_manifest_sha256": environment_sha, "workflow_type": WORKFLOW_TYPE,
    }
    build_id = _domain_hash("ifpmic.b03.build.v1", build_document)
    identity = {
        # ExecutionIdentity's runtime config is the seven-field constructor
        # shape. protocol_version belongs to the canonical hash document
        # above, not to this serialized identity object.
        "deployment_id": deployment_id,
        "namespace": NAMESPACE,
        "server_endpoint": endpoint,
        "server_config_sha256": server_sha,
        "build_id": build_id,
        "source_manifest_sha256": source_sha,
        "environment_manifest_sha256": environment_sha,
    }

    processes = []
    process_records = []
    cleanup_result = []
    normalized: dict[str, object] = {
        "kind": "ifpmic.b03.h2.runtime.normal-flow-observation.v1",
        "case_id": "tests.ifpmic_api.test_h2_runtime_normal_flow.test_h2_runtime_real_cli_create_ready_admits_one_run_and_queues_one_receipt",
        "status": "running",
        "job_id": job_id,
        "deployment_id": deployment_id,
        "build_id": build_id,
        "server_config_sha256": server_sha,
        "source_manifest_sha256": source_sha,
        "environment_manifest_sha256": environment_sha,
    }
    observation_path = private_root / "runtime-observation.json"
    body_passed = False
    owner_before = _read_owner_snapshot(harness, job_id)
    assert owner_before["accepted"] is not None
    assert owner_before["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
    assert owner_before["accepted"][12:17] == ("accepted", None, None, "pending", 0)
    assert owner_before["accepted"][19:] == (accepted_group[18], workspace["workspace_token"], "READY", 1)
    assert owner_before["bindings"] == owner_before["scopes"] == []
    assert owner_before["receipts"] == owner_before["attempts"] == []
    assert owner_before["noncreate_commands"] == 0
    owner_before_path = private_root / "owner-before.json"
    _write_private(owner_before_path, _canonical(owner_before) + b"\n")
    owner_before_sha = hashlib.sha256(owner_before_path.read_bytes()).hexdigest()
    try:
        temporal_data = private_root / "temporal-data"
        temporal = start_server(temporal_cli, toolchain["cli_binary_sha256"], temporal_data, ports,
                                log_name="server.log")
        processes.append(temporal)
        temporal_record = {"role": "temporal", "pid": temporal.pid,
                           "start_ticks": temporal._ifpmic_start_ticks,
                           "log": temporal_data / "server.log"}
        process_records.append(temporal_record)
        _append_private_journal(process_journal, {"event": "started", **temporal_record})
        server_listeners = _wait_for_temporal_listeners(
            temporal, ports, time.monotonic() + deadline.remaining(30),
        )
        assert all(item["loopback"] for item in server_listeners)

        role_oids = _register_identity(harness, identity)
        dispatcher_config = _write_runtime_config(
            private_root, "dispatcher", identity, _private_dsn(harness["database"], "dispatcher"),
            workspace_root, source_path, environment_path,
        )
        worker_config = _write_runtime_config(
            private_root, "worker", identity, _private_dsn(harness["database"], "projector"),
            workspace_root, source_path, environment_path,
        )
        worker, worker_record = _spawn_runtime_cli("worker", worker_config, private_root)
        processes.append(worker)
        process_records.append(worker_record)
        _append_private_journal(process_journal, {"event": "started", **worker_record})
        dispatcher, dispatcher_record = _spawn_runtime_cli("dispatcher", dispatcher_config, private_root)
        processes.append(dispatcher)
        process_records.append(dispatcher_record)
        _append_private_journal(process_journal, {"event": "started", **dispatcher_record})

        body_deadline = deadline.body_deadline
        sql_snapshot = _wait_for_sql_outcome(harness, job_id, body_deadline, processes)
        initial = sql_snapshot["accepted"]
        command_id = initial[8]
        admitted_run_id = sql_snapshot["bindings"][0][19]
        expected_binding_sha = sql_snapshot["bindings"][0][18]
        assert str(UUID(admitted_run_id)) == admitted_run_id
        expected_start = {
            "protocol_version": PROTOCOL_VERSION, "job_id": job_id,
            "project_id": harness["project_id"], "binding_sha256": expected_binding_sha,
        }
        temporal_observation = _observe_temporal(
            identity, job_id, harness["project_id"], admitted_run_id,
            expected_start, body_deadline, private_root,
        )
        result = _assert_runtime_oracles(
            sql_snapshot, harness, accepted, accepted_group, workspace, identity, role_oids,
            temporal_observation,
        )
        normalized.update(result)

        replay = harness["client"].post(
            "/api/v1/jobs", json=accepted["payload"],
            headers=write_headers(harness, key="h2-runtime-real-cli-normal-flow"),
        )
        assert replay.status_code == 202 and replay.json() == accepted["receipt"]
        owner_after = _read_owner_snapshot(harness, job_id)
        assert owner_after == sql_snapshot
        owner_after_path = private_root / "owner-after.json"
        _write_private(owner_after_path, _canonical(owner_after) + b"\n")
        owner_after_sha = hashlib.sha256(owner_after_path.read_bytes()).hexdigest()
        command_view = harness["client"].get("/api/v1/commands/" + command_id)
        assert command_view.status_code == 200
        assert command_view.json() == {
            "command_id": command_id, "status": "applied", "applied_revision": 1, "error": None,
        }
        detail = harness["client"].get("/api/v1/jobs/" + job_id)
        assert detail.status_code == 200 and detail.json()["job"]["status"] == "QUEUED"
        assert detail.json()["job"]["revision"] == 1
        assert detail.json()["job"]["cycle"] == 0
        assert detail.json()["job"]["current_step_ids"] == []
        assert detail.json()["job"]["candidate_fingerprint"] is None
        assert detail.json()["steps"] == []
        api_observations = {
            "replay": {"status_code": replay.status_code, "body": replay.json()},
            "command": {"status_code": command_view.status_code, "body": command_view.json()},
            "job": {"status_code": detail.status_code, "body": detail.json()},
        }
        api_path = private_root / "api-observations.json"
        _write_private(api_path, _canonical(api_observations) + b"\n")
        assert tree_fingerprint(workspace_root / job_id) == tree_before
        assert all(process.poll() is None for process in processes)
        assert _owned_process_descendants({process.pid for process in processes}) == []
        for record in process_records:
            for log_path in (record.get("stdout"), record.get("stderr"), record.get("log")):
                if log_path is not None and log_path.is_file():
                    assert stat.S_IMODE(log_path.stat().st_mode) == 0o600
                    raw_log = log_path.read_bytes()
                    assert harness["settings"].database_dsn.encode() not in raw_log
                    assert harness["project_id"].encode() not in raw_log
                    assert accepted["payload"]["request_text"].encode() not in raw_log
        normalized["workspace_generation"] = workspace["workspace_generation"]
        normalized["temporal_listeners_loopback"] = True
        normalized["tree_entries"] = len(tree_before)
        normalized["phase"] = temporal_observation["phase"]
        normalized["execution_count"] = temporal_observation["execution_count"]
        normalized["started_event_count"] = temporal_observation["started_event_count"]
        normalized["body_status"] = "passed"
        normalized["owner_before_sha256"] = owner_before_sha
        normalized["owner_after_sha256"] = owner_after_sha
        normalized["raw_history_sha256"] = temporal_observation["raw_history_sha256"]
        normalized["raw_history_bytes"] = temporal_observation["raw_history_bytes"]
        normalized["api_observations_sha256"] = hashlib.sha256(api_path.read_bytes()).hexdigest()
        body_passed = True
    finally:
        body_exception_active = sys.exc_info()[0] is not None
        cleanup_errors: list[str] = []
        pre_stop_exit_codes = []
        try:
            with deadline.cleanup_budget():
                for process in processes:
                    pre_stop_exit_code = process.poll()
                    pre_stop_exit_codes.append(pre_stop_exit_code)
                    try:
                        _append_private_journal(process_journal, {
                            "event": "stop_requested", "pid": process.pid,
                            "start_ticks": getattr(process, "_ifpmic_start_ticks", None),
                            "pre_stop_exit_code": pre_stop_exit_code,
                        })
                    except BaseException as exc:
                        cleanup_errors.append(type(exc).__name__)
                if processes:
                    cleanup_result = stop_all_owned(processes, total_timeout=PROCESS_CLEANUP_SECONDS)
        except BaseException as exc:
            cleanup_errors.append(type(exc).__name__)

        if len(cleanup_result) != len(processes):
            # Keep a record for every child even when cleanup itself failed;
            # the outer gate cleanup owns any remaining live process.
            cleanup_result = [
                {
                    "absent": process_identity(process.pid) !=
                        getattr(process, "_ifpmic_start_ticks", None),
                    "forced": None,
                }
                for process in processes
            ]

        # Persist outcomes and the failed observation before checking the
        # positive-exit/no-force contract, so a bad child cannot erase the
        # primary runtime failure or its diagnostic evidence.
        for process, outcome in zip(processes, cleanup_result):
            try:
                _append_private_journal(process_journal, {
                    "event": "stopped", "pid": process.pid,
                    "start_ticks": getattr(process, "_ifpmic_start_ticks", None),
                    "exit_code": process.poll(), "absent": outcome["absent"],
                    "forced": outcome["forced"],
                })
            except BaseException as exc:
                cleanup_errors.append(type(exc).__name__)

        process_evidence = [
            {"role": record.get("role"), "pid": process.pid,
             "start_ticks": getattr(process, "_ifpmic_start_ticks", None),
             "exit_code": process.poll(), "absent": outcome["absent"],
             "forced": outcome["forced"]}
            for record, process, outcome in zip(process_records, processes, cleanup_result)
        ]
        log_evidence = []
        for record in process_records:
            log_evidence.append({
                "role": record["role"],
                "stdout_sha256": hashlib.sha256(record["stdout"].read_bytes()).hexdigest()
                    if record.get("stdout") and record["stdout"].is_file() else None,
                "stderr_sha256": hashlib.sha256(record["stderr"].read_bytes()).hexdigest()
                    if record.get("stderr") and record["stderr"].is_file() else None,
                "server_log_sha256": hashlib.sha256(record["log"].read_bytes()).hexdigest()
                    if record.get("log") and record["log"].is_file() else None,
            })
        violations = []
        if len(process_records) != len(processes):
            violations.append("process_record_count")
        for process, outcome in zip(processes, cleanup_result):
            if not outcome["absent"]:
                violations.append("process_not_absent")
            if outcome["forced"] is not False:
                violations.append("process_forced_or_unknown")
            if process.returncode != 0:
                violations.append("process_exit_not_zero")
        if len(pre_stop_exit_codes) != len(processes) or any(code is not None for code in pre_stop_exit_codes):
            violations.append("process_exited_before_stop_request")
        for record in process_records:
            for name in ("stdout", "stderr"):
                path = record.get(name)
                if path is not None and (not path.is_file() or stat.S_IMODE(path.stat().st_mode) != 0o600):
                    violations.append("process_log_mode")
            cache = record.get("cache")
            if cache is not None and (not cache.is_dir() or list(cache.iterdir())):
                violations.append("cache_not_empty")
        violations.extend(cleanup_errors)
        if len(process_records) != 3 or any(not record.get("start_ticks") for record in process_records):
            violations.append("process_identity_record")

        normalized["status"] = "passed" if body_passed and not violations else "failed"
        normalized["processes"] = process_evidence
        normalized["process_logs"] = log_evidence
        normalized["process_journal_sha256"] = hashlib.sha256(
            process_journal.read_bytes()).hexdigest()
        if cleanup_errors:
            normalized["cleanup_error_types"] = cleanup_errors
        _write_private(observation_path, _canonical(normalized) + b"\n")

        if violations and not body_exception_active:
            raise AssertionError("runtime cleanup contract failed: " + ",".join(violations))
