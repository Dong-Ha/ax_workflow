"""Real-process H2 crash cuts for the API and projector activity boundaries.

The exact IDs are frozen in the H2 worker/API ledger before the bounded runner
is approved. These tests use real Uvicorn, PostgreSQL SCRAM roles, Temporal
history and the production activity/store code. Test-only children inject
constructor hooks; no product runtime switch or mocked SDK result is used.
"""
from __future__ import annotations

import asyncio
from dataclasses import replace
import hashlib
import http.client
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
from uuid import uuid4

import psycopg
from tests.ifpmic_api.h2_native_bounds import bounded_connect, bounded_harness
import pytest
from temporalio.client import Client

pytest_plugins = (
    "tests.ifpmic_api.jobs_fixture",
    "tests.ifpmic_api.workspace_fixture",
    "tests.ifpmic_api.workflow_schema_fixture",
)

from tests.ifpmic_api import test_h2_runtime_normal_flow as normal
from tests.ifpmic_api.jobs_fixture import (
    operator_dsn, private_settings_file, owner_dsn, write_headers,
)
from tests.ifpmic_api.workspace_fixture import accept_workspace_job
from scripts.ifpmic_temporal_toolchain import process_identity, stop_all_owned, verify_binary


REPO_ROOT = Path.cwd().resolve()
WORKFLOW_TYPE = normal.WORKFLOW_TYPE
PROTOCOL_VERSION = normal.PROTOCOL_VERSION
PROCESS_CLEANUP_SECONDS = 15
CASE_IDS = (
    "tests.ifpmic_api.test_h2_worker_api_crashes.test_h2_api_commit_before_response_sigkill_retry_applies_once",
    "tests.ifpmic_api.test_h2_worker_api_crashes.test_h2_worker_projection_before_pg_commit_sigkill_rolls_back_then_retries",
    "tests.ifpmic_api.test_h2_worker_api_crashes.test_h2_worker_projection_after_pg_commit_sigkill_replays_receipt",
    "tests.ifpmic_api.test_h2_worker_api_crashes.test_h2_activity_completed_before_workflow_decision_sigkill_replays_history",
)


@pytest.fixture
def h2_crash_harness(workflow_scram_hba, workspace_environment):
    return bounded_harness(workspace_environment)


@pytest.fixture
def h2_crash_deadline(request):
    try:
        return request.node._ifpmic_h2_worker_api_deadline
    except AttributeError:
        pytest.fail("the explicitly loaded H2 worker/API case watchdog is required")


def _private_child_env(root: Path) -> dict[str, str]:
    return {
        "PATH": os.pathsep.join((str(Path(sys.prefix) / "bin"), "/usr/bin", "/bin")),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
        "TMPDIR": str(root),
    }


def _private_barrier(root: Path, name: str) -> Path:
    path = root / (name + "-barrier")
    path.mkdir(mode=0o700)
    path.chmod(0o700)
    assert stat.S_IMODE(path.stat().st_mode) == 0o700
    return path


def _wait_file(path: Path, process, deadline: float) -> dict[str, object]:
    while time.monotonic() < deadline:
        assert process.poll() is None, "owned child exited before reaching its barrier"
        if path.exists():
            info = path.lstat()
            assert stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
            assert stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1
            try:
                value = json.loads(path.read_text(encoding="ascii"))
            except json.JSONDecodeError:
                # Creation precedes the child write, so retry while the
                # private event file is being completed and fsynced.
                time.sleep(min(0.01, max(0.0, deadline - time.monotonic())))
                continue
            assert type(value) is dict
            return value
        time.sleep(min(0.02, max(0.0, deadline - time.monotonic())))
    raise TimeoutError("private child barrier was not reached before the case deadline")


def _spawn_module(module: str, args: list[str], private_root: Path, label: str):
    cache = normal._private_dir(private_root / ("cache-" + label))
    log_root = private_root / "child-logs"
    if not log_root.exists():
        normal._private_dir(log_root)
    stdout_path, stderr_path = log_root / (label + ".stdout"), log_root / (label + ".stderr")
    stdout_fd = os.open(stdout_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    stderr_fd = os.open(stderr_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    env = _private_child_env(private_root)
    argv = [sys.executable, "-B", "-X", "pycache_prefix=" + str(cache), "-m", module, *args]
    try:
        process = subprocess.Popen(argv, cwd=REPO_ROOT, stdin=subprocess.DEVNULL,
                                   stdout=stdout_fd, stderr=stderr_fd, env=env,
                                   start_new_session=True)
    finally:
        os.close(stdout_fd)
        os.close(stderr_fd)
    ticks = process_identity(process.pid)
    if ticks is None:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        raise AssertionError("could not capture the owned child start identity")
    process._ifpmic_start_ticks = ticks
    process._ifpmic_log_paths = (stdout_path, stderr_path)
    try:
        _record_private(private_root, "owned-" + label + ".json", {
            "role": label, "pid": process.pid, "start_ticks": ticks,
            "stdout": stdout_path, "stderr": stderr_path,
        })
    except BaseException:
        stop_all_owned([process], total_timeout=5)
        raise
    return process


def _kill_saved(process) -> dict[str, object]:
    pid = process.pid
    ticks = process._ifpmic_start_ticks
    assert process_identity(pid) == ticks
    os.kill(pid, signal.SIGKILL)
    process.wait(timeout=5)
    assert process.returncode == -signal.SIGKILL
    assert process_identity(pid) != ticks
    return {"pid": pid, "start_ticks": ticks, "signal": "SIGKILL", "exit_code": process.returncode}


def _record_private(root: Path, name: str, value: object) -> Path:
    path = root / name
    normal._write_private(path, normal._canonical(value) + b"\n")
    return path


def _journal_process(ctx, record: dict[str, object]) -> None:
    records = ctx.setdefault("process_records", [])
    index = len(records)
    records.append(record)
    _record_private(ctx["root"], f"owned-process-{index:02d}.json", record)


def _start_owned_temporal(binary: Path, binary_sha256: str, data_dir: Path, ports: list[int],
                          root: Path, owner_ctx):
    """Start the pinned server while retaining its Popen handle through identity capture."""
    assert owner_ctx is not None
    binary = verify_binary(binary, binary_sha256)
    if (len(ports) != 3 or len(set(ports)) != 3
            or any(type(port) is not int or not 1 <= port <= 65535 for port in ports)):
        raise ValueError("TEMPORAL_PORTS_INVALID")
    data_dir.mkdir(mode=0o700, exist_ok=True)
    if data_dir.is_symlink() or stat.S_IMODE(data_dir.stat().st_mode) != 0o700:
        raise ValueError("TEMPORAL_DATA_DIR_INVALID")
    env_path = data_dir / "isolated-env.json"
    if env_path.exists() or env_path.is_symlink():
        if env_path.is_symlink() or env_path.read_bytes() != b"{}":
            raise ValueError("TEMPORAL_ENV_INVALID")
    else:
        fd = os.open(env_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(b"{}")
    env_path.chmod(0o600)
    log_path = data_dir / "temporal.log"
    log_fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    argv = [str(binary), "--disable-config-env", "--disable-config-file", "--env-file", str(env_path),
            "server", "start-dev", "--ip", "127.0.0.1", "--port", str(ports[0]),
            "--http-port", str(ports[1]), "--metrics-port", str(ports[2]),
            "--db-filename", str(data_dir / "temporal.sqlite"), "--headless"]
    with os.fdopen(log_fd, "wb") as log:
        process = subprocess.Popen(argv, cwd=data_dir, stdin=subprocess.DEVNULL,
                                   stdout=log, stderr=subprocess.STDOUT,
                                   env={"PATH": os.defpath, "PYTHONDONTWRITEBYTECODE": "1"},
                                   start_new_session=True)
    processes = owner_ctx.setdefault("processes", [])
    processes.append(process)
    owner_ctx["server"] = process
    try:
        ticks = process_identity(process.pid)
        if ticks is None:
            raise AssertionError("could not capture the owned Temporal server start identity")
        process._ifpmic_start_ticks = ticks
        return process
    except BaseException:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
        process._ifpmic_start_ticks = process_identity(process.pid) or "identity-unavailable"
        raise


def _record_history(root: Path, name: str, events) -> str:
    raw_events = [event.SerializeToString(deterministic=True) for event in events]
    raw = b"".join(len(part).to_bytes(8, "big") + part for part in raw_events)
    path = root / name
    normal._write_private(path, raw)
    return hashlib.sha256(raw).hexdigest()


def _root() -> Path:
    evidence = normal._runtime_evidence_root()
    root = normal._private_dir(evidence / ("worker-api-" + uuid4().hex))
    return root


def _new_accepted(harness, key: str):
    accepted = accept_workspace_job(harness, key=key)
    return accepted


def _create_runtime_world(harness, accepted, root: Path, *, endpoint_override: str | None = None,
                          prestarted_server=None, prestarted_ports=None, owner_ctx=None):
    """Provision actual READY workspace, deployment, pinned server and manifests."""
    job_id = accepted["job_id"]
    accepted_group = normal.workspace_rows(harness, job_id)
    assert accepted_group is not None and accepted_group[4:9] == ("DRAFT", 0, 0, [], None)
    workspace, tree = normal._workspace_ready(harness, Path(harness["workspace_root"]), job_id)
    normal._add_live_sql_eligibility(harness, job_id)
    toolchain = normal._read_h1_toolchain()
    ports = prestarted_ports or normal._allocate_loopback_ports()
    server = prestarted_server or _start_owned_temporal(
        Path(toolchain["toolchain_root"]) / "temporal",
        toolchain["cli_binary_sha256"], root / "temporal-data", ports, root, owner_ctx,
    )
    server_record = {"role": "temporal", "pid": server.pid,
                     "start_ticks": server._ifpmic_start_ticks,
                     "log": root / "temporal-data" / "temporal.log"}
    if owner_ctx is not None:
        owner_ctx["server"] = server
        owner_ctx["server_record"] = server_record
        processes = owner_ctx.setdefault("processes", [])
        if server not in processes:
            processes.append(server)
        records = owner_ctx.setdefault("process_records", [])
        if server_record not in records:
            _journal_process(owner_ctx, server_record)
    _record_private(root, "owned-temporal-server.json", server_record)
    server_listeners = normal._wait_for_temporal_listeners(
        server, ports, time.monotonic() + 30,
    )
    assert all(item["loopback"] for item in server_listeners)
    backend_endpoint = f"127.0.0.1:{ports[0]}"
    endpoint = endpoint_override or backend_endpoint

    source_value = normal.source_manifest()
    environment_value = normal.environment_manifest()
    source_sha, environment_sha = normal._manifest_hash(source_value), normal._manifest_hash(environment_value)
    source_path = root / "source-manifest.json"
    environment_path = root / "environment-manifest.json"
    normal._write_private(source_path, normal._canonical(source_value) + b"\n")
    normal._write_private(environment_path, normal._canonical(environment_value) + b"\n")
    deployment_id = "h2-crash-" + uuid4().hex
    server_doc = {"protocol_version": PROTOCOL_VERSION, "deployment_id": deployment_id,
                  "namespace": normal.NAMESPACE, "server_endpoint": endpoint}
    server_sha = normal._domain_hash("ifpmic.b03.deployment.v1", server_doc)
    build_doc = {"protocol_version": PROTOCOL_VERSION,
                 "source_manifest_sha256": source_sha,
                 "environment_manifest_sha256": environment_sha,
                 "workflow_type": WORKFLOW_TYPE}
    build_id = normal._domain_hash("ifpmic.b03.build.v1", build_doc)
    identity = {
        "deployment_id": deployment_id, "namespace": normal.NAMESPACE,
        "server_endpoint": endpoint, "server_config_sha256": server_sha,
        "build_id": build_id, "source_manifest_sha256": source_sha,
        "environment_manifest_sha256": environment_sha,
    }
    role_oids = normal._register_identity(harness, identity)
    workspace_root = Path(harness["workspace_root"])
    dispatcher_config = normal._write_runtime_config(
        root, "dispatcher", identity, normal._private_dsn(harness["database"], "dispatcher"),
        workspace_root, source_path, environment_path,
    )
    worker_config = normal._write_runtime_config(
        root, "worker", identity, normal._private_dsn(harness["database"], "projector"),
        workspace_root, source_path, environment_path,
    )
    return {
        "root": root, "job_id": job_id, "workspace": workspace, "tree": tree,
        "toolchain": toolchain, "ports": ports, "server": server,
        "server_record": server_record, "server_listeners": server_listeners,
        "backend_endpoint": backend_endpoint, "identity": identity,
        "role_oids": role_oids, "dispatcher_config": dispatcher_config,
        "worker_config": worker_config, "accepted": accepted,
        "accepted_group": accepted_group,
    }


def _start_dispatcher(ctx):
    process, record = normal._spawn_runtime_cli("dispatcher", ctx["dispatcher_config"], ctx["root"])
    ctx.setdefault("processes", []).append(process)
    _journal_process(ctx, record)
    ctx["dispatcher_process"] = process
    return process


def _start_cli_worker(ctx, suffix="worker-recovery"):
    process, record = normal._spawn_runtime_cli("worker", ctx["worker_config"], ctx["root"])
    ctx.setdefault("processes", []).append(process)
    _journal_process(ctx, record)
    return process


def _start_barrier_worker(ctx, phase: str, barrier: Path):
    process = _spawn_module(
        "tests.ifpmic_api.h2_worker_crash_child",
        [str(ctx["worker_config"]), phase, str(barrier)], ctx["root"], "worker-cut-" + phase,
    )
    ctx.setdefault("processes", []).append(process)
    return process


def _wait_for_snapshot(harness, job_id: str, predicate, deadline: float, processes=()):
    while time.monotonic() < deadline:
        if any(process.poll() is not None for process in processes):
            raise AssertionError("an owned service exited before its required observation")
        snapshot = normal._read_owner_snapshot(harness, job_id)
        if predicate(snapshot):
            return snapshot
        time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))
    raise TimeoutError("independent owner SQL observation missed its deadline")


def _activity_events(identity: dict[str, str], direct_endpoint: str, workflow_id: str, run_id: str):
    async def read():
        client = await asyncio.wait_for(Client.connect(direct_endpoint, namespace=identity["namespace"]), 10)
        handle = client.get_workflow_handle(workflow_id, run_id=run_id)
        history = await handle.fetch_history(rpc_timeout=normal.timedelta(seconds=10))
        return list(history.events)
    return asyncio.run(read())


def _wait_activity_completion(ctx, deadline: float):
    workflow_id = "ifpmic.job." + ctx["job_id"]
    run_id = ctx["owner_at_activity_barrier"]["bindings"][0][19]
    while time.monotonic() < deadline:
        events = _activity_events(ctx["identity"], ctx["backend_endpoint"], workflow_id, run_id)
        completed = _count(events, "activity_task_completed_event_attributes",
                           "ifpmic.h2.project_activation")
        if completed:
            assert completed == 1
            return events
        time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))
    raise TimeoutError("direct Temporal history did not record ActivityTaskCompleted")


def _count(events, attribute: str, activity_type: str | None = None) -> int:
    scheduled = {}
    for event in events:
        if event.HasField("activity_task_scheduled_event_attributes"):
            attrs = event.activity_task_scheduled_event_attributes
            scheduled[int(event.event_id)] = getattr(getattr(attrs, "activity_type", None), "name", None)
    count = 0
    for event in events:
        if not event.HasField(attribute):
            continue
        attrs = getattr(event, attribute)
        if activity_type is None:
            count += 1
        elif scheduled.get(int(getattr(attrs, "scheduled_event_id", -1))) == activity_type:
            count += 1
    return count


def _wait_for_activity_barrier(ctx, barrier: Path, process, deadline: float):
    ready = _wait_file(barrier / "ready.json", process, deadline)
    assert ready["status"] == "ready"
    _start_dispatcher(ctx)
    reached = _wait_file(barrier / "reached.json", process, deadline)
    dispatched = _wait_for_snapshot(
        ctx["harness"], ctx["job_id"],
        lambda value: value["accepted"] is not None and value["accepted"][15] == "dispatched",
        deadline, (process,),
    )
    ctx["owner_after_dispatch_ack"] = dispatched
    return reached


def _await_final_runtime(harness, ctx, deadline: float):
    snapshot = normal._wait_for_sql_outcome(harness, ctx["job_id"], deadline, ctx["processes"])
    run_id = snapshot["bindings"][0][19]
    expected_start = {
        "protocol_version": PROTOCOL_VERSION, "job_id": ctx["job_id"],
        "project_id": harness["project_id"], "binding_sha256": snapshot["bindings"][0][18],
    }
    temporal = normal._observe_temporal(ctx["identity"], ctx["job_id"], harness["project_id"],
                                        run_id, expected_start, deadline, ctx["root"])
    normal._assert_runtime_oracles(snapshot, harness, ctx["accepted"],
                                   ctx["accepted_group"],
                                   ctx["workspace"], ctx["identity"], ctx["role_oids"], temporal)
    # _assert_runtime_oracles takes the API creation tuple separately. Retain
    # the immutable first rows from the accepted create for an exact receipt check.
    assert snapshot["accepted"][3:8] == ("QUEUED", 1, 0, [], None)
    assert len(snapshot["receipts"]) == 1 and snapshot["receipts"][0][7] == "applied"
    assert snapshot["attempts"] == [(1, "started", run_id, None, True)]
    assert temporal["phase"] == "queued" and temporal["execution_count"] == 1
    return snapshot, temporal


def _cleanup(ctx, deadline, extra_processes=(), extra_helpers=()):
    if deadline is not None:
        deadline.cleanup_budget()
    processes = list(dict.fromkeys([*ctx.get("processes", []), *extra_processes]))
    server = ctx.get("server")
    owned = processes + ([server] if server is not None and server not in processes else [])
    alive = [p for p in owned if p.poll() is None and process_identity(p.pid) == getattr(p, "_ifpmic_start_ticks", None)]
    # Leave time inside the shared cleanup budget for the held-proxy thread
    # and pytest's PostgreSQL fixture finalizers.
    result = stop_all_owned(alive, total_timeout=15) if alive else []
    for helper in extra_helpers:
        helper.close()
    if result:
        _record_private(ctx["root"], "owned-process-cleanup.json", result)
    assert all(process.poll() is not None for process in processes)
    assert all(process_identity(process.pid) != getattr(process, "_ifpmic_start_ticks", None)
               for process in processes)
    if server is not None:
        assert server.poll() is not None
        assert process_identity(server.pid) != server._ifpmic_start_ticks
    return result


def test_h2_api_commit_before_response_sigkill_retry_applies_once(h2_crash_harness, h2_crash_deadline):
    harness, deadline = h2_crash_harness, h2_crash_deadline
    root = _root()
    ctx = {"root": root, "processes": [], "process_records": []}
    api_process = None
    try:
        port_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        port_sock.bind(("127.0.0.1", 0))
        port = port_sock.getsockname()[1]
        port_sock.close()
        origin = f"http://127.0.0.1:{port}"
        api_settings = replace(harness["settings"], api_origin=origin,
                               redirect_uri=origin + "/auth/callback")
        settings_path = root / "api-settings.json"
        private_settings_file(api_settings, settings_path)
        barrier = _private_barrier(root, "api-commit")
        api_process = _spawn_module(
            "tests.ifpmic_api.h2_api_crash_child",
            [str(settings_path), "job_after_commit", str(barrier), str(port)], root, "api-commit-child",
        )
        ctx["processes"].append(api_process)
        deadline_at = min(deadline.deadline, time.monotonic() + deadline.remaining(20))
        while time.monotonic() < deadline_at:
            assert api_process.poll() is None
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    break
            except OSError:
                time.sleep(0.05)
        else:
            raise TimeoutError("owned API process did not bind its loopback endpoint")

        payload = {
            "project_id": harness["project_id"], "title": "G4 synthetic job",
            "request_text": "Validate isolated acceptance", "change_type": "FEATURE",
            "base_ref": "refs/heads/main", "input_artifact_ids": [],
            "profile_version": harness["profile_version"], "release_mode": "team_github_tag",
        }
        key = "h2-api-commit-crash-" + uuid4().hex
        api_headers = write_headers(harness, key=key)
        result: dict[str, object] = {}

        def post_blocking_request():
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=60)
            try:
                connection.request("POST", "/api/v1/jobs", body=json.dumps(payload), headers={
                    "Host": f"127.0.0.1:{port}", "Origin": api_settings.allowed_ui_origins[0],
                    "X-CSRF-Token": api_headers["X-CSRF-Token"], "Idempotency-Key": key,
                    "Cookie": api_headers["Cookie"], "Content-Type": "application/json",
                })
                response = connection.getresponse()
                result["status"] = response.status
                result["body"] = response.read()
            except BaseException as error:
                result["error"] = type(error).__name__
            finally:
                connection.close()

        request_thread = threading.Thread(target=post_blocking_request, daemon=True)
        request_thread.start()
        event = _wait_file(barrier / "reached.json", api_process, deadline.deadline)
        assert event["phase"] == "job_after_commit"
        with bounded_connect(owner_dsn(harness["database"])) as owner:
            row = owner.execute(
                "SELECT j.job_id::text,j.create_command_id::text,j.status,j.revision,c.status,o.state,"
                "w.state,w.generation FROM ifpmic.jobs j JOIN ifpmic.commands c "
                "ON c.command_id=j.create_command_id AND c.job_id=j.job_id "
                "JOIN ifpmic.commands_outbox o ON o.command_id=c.command_id "
                "JOIN ifpmic.workspace_intents w ON w.job_id=j.job_id "
                "WHERE c.actor_id=%s AND c.idempotency_key=%s",
                (harness["user_id"], key),
            ).fetchone()
        assert row is not None
        assert row[2:] == ("DRAFT", 0, "accepted", "pending", "RESERVED", 0)
        ctx["api_crash_observation"] = {"row": row, "barrier": event}
        _record_private(root, "api-commit-before-kill.json", ctx["api_crash_observation"])
        kill = _kill_saved(api_process)
        ctx["processes"].remove(api_process)
        request_thread.join(timeout=5)
        assert not request_thread.is_alive()
        assert result.get("status") is None, "the killed API child must not deliver a response"
        accepted = harness["client"].post("/api/v1/jobs", json=payload,
                                           headers=write_headers(harness, key=key))
        assert accepted.status_code == 202
        receipt = accepted.json()
        assert receipt["resource_id"] == row[0]
        assert receipt["command_id"] == row[1]
        assert receipt["status"] == "accepted"
        ctx["accepted"] = {"job_id": row[0], "command_id": row[1], "payload": payload,
                            "receipt": receipt, "key": key}
        _record_private(root, "api-retry-receipt.json", receipt)
        runtime_root = root / "runtime"
        runtime_root.mkdir(mode=0o700)
        runtime_ctx = _create_runtime_world(harness, ctx["accepted"], runtime_root,
                                            owner_ctx=ctx)
        runtime_ctx["processes"] = ctx["processes"]
        runtime_ctx["process_records"] = ctx["process_records"]
        ctx.update(runtime_ctx)
        _start_cli_worker(ctx)
        _start_dispatcher(ctx)
        final, temporal = _await_final_runtime(harness, ctx, deadline.deadline)
        assert final["accepted"][0:3] == (harness["user_id"], harness["project_id"], harness["record"].snapshot_id)
        assert len(final["bindings"]) == len(final["receipts"]) == 1
        assert final["receipts"][0][1] == 1 and final["receipts"][0][7] == "applied"
        _record_private(root, "api-crash-recovery.json", {
            "killed_process": kill, "sql": final, "temporal": temporal,
        })
    finally:
        _cleanup(ctx, deadline)


def _run_projection_crash(harness, deadline, *, phase: str, label: str, ctx):
    root = _root()
    accepted = _new_accepted(harness, "h2-" + label + "-" + uuid4().hex)
    ctx.update({"root": root, "processes": [], "process_records": [], "harness": harness})
    runtime_ctx = _create_runtime_world(harness, accepted, root, owner_ctx=ctx)
    runtime_ctx["processes"] = ctx["processes"]
    runtime_ctx["process_records"] = ctx["process_records"]
    ctx.update(runtime_ctx)
    ctx["barrier"] = _private_barrier(root, label)
    worker = _start_barrier_worker(ctx, phase, ctx["barrier"])
    event = _wait_for_activity_barrier(ctx, ctx["barrier"], worker, deadline.deadline)
    assert event["phase"] == phase
    ctx["worker_child"] = worker
    ctx["phase_event"] = event
    return ctx


def _revoke_authority_after_projection(harness, ctx) -> None:
    """Revoke mutable authorization only after the durable projection receipt exists."""
    with bounded_connect(operator_dsn(harness["database"])) as operator:
        operator.execute(
            "UPDATE ifpmic.memberships SET active=false WHERE user_id=%s AND project_id=%s",
            (harness["user_id"], harness["project_id"]),
        )
        operator.execute(
            "INSERT INTO ifpmic.profile_revocations(project_id,eligibility_id,revoked_at) "
            "SELECT project_id,eligibility_id,clock_timestamp() FROM ifpmic.profile_eligibility "
            "WHERE project_id=%s AND snapshot_id=%s ON CONFLICT DO NOTHING",
            (harness["project_id"], harness["record"].snapshot_id),
        )
        state = operator.execute(
            "SELECT m.active, count(r.eligibility_id) "
            "FROM ifpmic.memberships m JOIN ifpmic.profile_eligibility e "
            "ON e.project_id=m.project_id LEFT JOIN ifpmic.profile_revocations r "
            "ON r.project_id=e.project_id AND r.eligibility_id=e.eligibility_id "
            "WHERE m.user_id=%s AND m.project_id=%s AND e.snapshot_id=%s GROUP BY m.active",
            (harness["user_id"], harness["project_id"], harness["record"].snapshot_id),
        ).fetchone()
    assert state == (False, 1)
    ctx["authority_revoked"] = True
    _record_private(ctx["root"], "authority-revoked-before-replay.json", {
        "membership_active": state[0], "matching_profile_revocations": state[1],
    })


def _stop_saved(process, root: Path, label: str) -> dict[str, object]:
    pid, ticks = process.pid, process._ifpmic_start_ticks
    assert process.poll() is None and process_identity(pid) == ticks
    result = stop_all_owned([process], total_timeout=5)
    assert process.poll() is not None and process_identity(pid) != ticks
    record = {"role": label, "pid": pid, "start_ticks": ticks, "stop": result[0]}
    _record_private(root, "stopped-" + label + ".json", record)
    return record


def _post_crash_recovery(harness, ctx, deadline, *, expect_projection_committed: bool,
                         revoke_authority: bool = False):
    before = normal._read_owner_snapshot(harness, ctx["job_id"])
    assert before["accepted"] is not None
    if expect_projection_committed:
        assert before["accepted"][3:8] == ("QUEUED", 1, 0, [], None)
        assert before["accepted"][12:15] == ("applied", 1, None)
        assert len(before["receipts"]) == 1 and before["receipts"][0][7] == "applied"
    else:
        assert before["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
        assert before["accepted"][12:15] == ("accepted", None, None)
        assert before["receipts"] == []
    run_id = before["bindings"][0][19]
    assert run_id is not None and before["bindings"][0][20] == "admitted"
    workflow_id = "ifpmic.job." + ctx["job_id"]
    events_before = _activity_events(ctx["identity"], ctx["backend_endpoint"], workflow_id, run_id)
    before_history_sha = _record_history(ctx["root"], "history-at-worker-cut.pbseq", events_before)
    assert _count(events_before, "activity_task_completed_event_attributes", "ifpmic.h2.project_activation") == 0
    assert _count(events_before, "activity_task_started_event_attributes",
                  "ifpmic.h2.project_activation") >= 1
    ctx["owner_before_kill"] = before
    _record_private(ctx["root"], "owner-at-worker-cut.json", before)
    if revoke_authority:
        assert expect_projection_committed and len(before["receipts"]) == 1
        _revoke_authority_after_projection(harness, ctx)
    kill = _kill_saved(ctx["worker_child"])
    ctx["worker_kill"] = kill
    ctx["processes"].remove(ctx["worker_child"])
    _record_private(ctx["root"], "worker-cut-history-before-recovery.json", {
        "event_count": len(events_before),
        "project_activity_started": _count(events_before, "activity_task_started_event_attributes",
                                            "ifpmic.h2.project_activation"),
        "project_activity_completed": _count(events_before, "activity_task_completed_event_attributes",
                                              "ifpmic.h2.project_activation"),
    })
    _start_cli_worker(ctx)
    final, temporal = _await_final_runtime(harness, ctx, deadline.deadline)
    assert final["accepted"][3:8] == ("QUEUED", 1, 0, [], None)
    assert len(final["bindings"]) == len(final["scopes"]) == len(final["receipts"]) == 1
    if expect_projection_committed:
        assert final["receipts"] == before["receipts"]
    else:
        assert len(final["receipts"]) == 1
    assert final["receipts"][0][1] == 1
    assert final["attempts"] == before["attempts"]
    events_after = _activity_events(ctx["identity"], ctx["backend_endpoint"], workflow_id, run_id)
    after_history_sha = _record_history(ctx["root"], "history-after-worker-recovery.pbseq", events_after)
    completed = _count(events_after, "activity_task_completed_event_attributes", "ifpmic.h2.project_activation")
    assert completed == 1
    started = _count(events_after, "activity_task_started_event_attributes", "ifpmic.h2.project_activation")
    _record_private(ctx["root"], "worker-crash-recovery.json", {
        "killed_process": kill, "before": before, "after": final,
        "temporal_before_event_count": len(events_before),
        "temporal_after_event_count": len(events_after),
        "temporal_before_sha256": before_history_sha,
        "temporal_after_sha256": after_history_sha,
        "project_activity_started_events": started,
        "project_activity_completed_events": completed,
        "phase": temporal["phase"],
    })
    return final, temporal, events_before, events_after


def test_h2_worker_projection_before_pg_commit_sigkill_rolls_back_then_retries(h2_crash_harness, h2_crash_deadline):
    harness, deadline = h2_crash_harness, h2_crash_deadline
    ctx = {"processes": [], "process_records": []}
    try:
        ctx = _run_projection_crash(harness, deadline, phase="before_project_activation_commit",
                                    label="projection-before-commit", ctx=ctx)
        final, _temporal, before_events, after_events = _post_crash_recovery(
            harness, ctx, deadline, expect_projection_committed=False,
        )
        assert final["accepted"][12:15] == ("applied", 1, None)
        assert _count(before_events, "activity_task_started_event_attributes",
                      "ifpmic.h2.project_activation") >= 1
        assert _count(after_events, "activity_task_completed_event_attributes",
                      "ifpmic.h2.project_activation") == 1
    finally:
        _cleanup(ctx or {}, deadline)


def test_h2_worker_projection_after_pg_commit_sigkill_replays_receipt(h2_crash_harness, h2_crash_deadline):
    harness, deadline = h2_crash_harness, h2_crash_deadline
    ctx = {"processes": [], "process_records": []}
    try:
        ctx = _run_projection_crash(harness, deadline, phase="after_project_activation_commit",
                                    label="projection-after-commit", ctx=ctx)
        final, _temporal, before_events, after_events = _post_crash_recovery(
            harness, ctx, deadline, expect_projection_committed=True, revoke_authority=True,
        )
        assert len(final["receipts"]) == 1
        assert final["receipts"][0] == ctx["owner_before_kill"]["receipts"][0]
        assert _count(before_events, "activity_task_completed_event_attributes",
                      "ifpmic.h2.project_activation") == 0
        assert _count(after_events, "activity_task_completed_event_attributes",
                      "ifpmic.h2.project_activation") == 1
    finally:
        _cleanup(ctx or {}, deadline)


def test_h2_activity_completed_before_workflow_decision_sigkill_replays_history(
    h2_crash_harness, h2_crash_deadline,
):
    harness, deadline = h2_crash_harness, h2_crash_deadline
    ctx = None
    proxy = None
    try:
        # This independently implemented helper owns a byte-direction proxy.
        # The product dispatcher and worker both connect through it; the parent
        # observes history directly at the backend endpoint.
        from tests.ifpmic_api.response_loss_proxy import TCPResponseHoldingProxy

        ports = normal._allocate_loopback_ports()
        root = _root()
        accepted = _new_accepted(harness, "h2-activity-before-decision-" + uuid4().hex)
        toolchain = normal._read_h1_toolchain()
        ctx = {"root": root, "harness": harness, "processes": [], "process_records": []}
        server = _start_owned_temporal(Path(toolchain["toolchain_root"]) / "temporal",
                                       toolchain["cli_binary_sha256"], root / "temporal-data",
                                       ports, root, ctx)
        server_record = {"role": "temporal", "pid": server.pid,
                         "start_ticks": server._ifpmic_start_ticks,
                         "log": root / "temporal-data" / "temporal.log"}
        ctx["server_record"] = server_record
        _record_private(root, "owned-temporal-server.json", server_record)
        listeners = normal._wait_for_temporal_listeners(server, ports, time.monotonic() + 30)
        assert all(item["loopback"] for item in listeners)
        proxy = TCPResponseHoldingProxy("127.0.0.1", ports[0])
        proxy_host, proxy_port = proxy.start(timeout=10)
        proxy_endpoint = f"{proxy_host}:{proxy_port}"
        runtime_ctx = _create_runtime_world(harness, accepted, root, endpoint_override=proxy_endpoint,
                                            prestarted_server=server, prestarted_ports=ports,
                                            owner_ctx=ctx)
        runtime_ctx["processes"] = ctx["processes"]
        runtime_ctx["process_records"] = ctx["process_records"]
        ctx.update(runtime_ctx)
        ctx["barrier"] = _private_barrier(root, "activity-before-decision")
        worker = _start_barrier_worker(ctx, "after_project_activation_commit", ctx["barrier"])
        event = _wait_activity_barrier(ctx, ctx["barrier"], worker, deadline.deadline)
        assert event["phase"] == "after_project_activation_commit"
        at_barrier = ctx["owner_after_dispatch_ack"]
        assert at_barrier["accepted"][3:8] == ("QUEUED", 1, 0, [], None)
        assert len(at_barrier["receipts"]) == 1 and at_barrier["receipts"][0][7] == "applied"
        dispatcher = ctx["dispatcher_process"]
        _stop_saved(dispatcher, root, "dispatcher-before-activity-result-cut")
        ctx["processes"].remove(dispatcher)
        run_id = at_barrier["bindings"][0][19]
        before_history = _activity_events(ctx["identity"], ctx["backend_endpoint"],
                                          "ifpmic.job." + ctx["job_id"], run_id)
        assert _count(before_history, "activity_task_completed_event_attributes",
                      "ifpmic.h2.project_activation") == 0
        ctx["owner_at_activity_barrier"] = at_barrier
        proxy.arm_after_barrier()
        release = ctx["barrier"] / "release"
        fd = os.open(release, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        os.fsync(fd)
        os.close(fd)
        completed_history = _wait_activity_completion(ctx, deadline.deadline)
        _record_history(root, "history-activity-completed-before-decision.pbseq", completed_history)
        assert proxy.wait_for_held_response(timeout=deadline.remaining(10))
        proxy_state = proxy.snapshot()
        # The proxy's counter records a server→worker response withheld after
        # the completion request was forwarded. Keep its raw detail private.
        assert proxy_state["armed"] is True
        assert proxy_state["server_response_bytes_held_after_arm"] > 0
        assert proxy_state["server_response_bytes_forwarded_after_arm"] == 0
        assert proxy_state["request_forwarded_bytes_after_arm"] > 0
        assert proxy_state["held_response_bytes"] > 0
        assert proxy_state["overflowed"] is False
        scheduled_project = {
            int(event.event_id) for event in completed_history
            if event.HasField("activity_task_scheduled_event_attributes")
            and event.activity_task_scheduled_event_attributes.activity_type.name == "ifpmic.h2.project_activation"
        }
        completion_events = [
            event for event in completed_history
            if event.HasField("activity_task_completed_event_attributes")
            and int(event.activity_task_completed_event_attributes.scheduled_event_id) in scheduled_project
        ]
        assert len(completion_events) == 1
        completion_event_id = int(completion_events[0].event_id)
        assert not any(
            int(event.event_id) > completion_event_id
            and event.HasField("workflow_task_completed_event_attributes")
            for event in completed_history
        ), "history must not contain the next completed workflow decision at the crash cut"
        kill = _kill_saved(worker)
        ctx["processes"].remove(worker)
        proxy.release()
        _record_private(root, "activity-completed-cut.json", {
            "killed_process": kill, "owner": at_barrier,
            "history_event_count": len(completed_history),
            "activity_completed_event_id": completion_event_id,
            "proxy": proxy_state,
        })
        _start_cli_worker(ctx)
        final, temporal = _await_final_runtime(harness, ctx, deadline.deadline)
        assert final == at_barrier
        assert temporal["phase"] == "queued"
        after_history = _activity_events(ctx["identity"], ctx["backend_endpoint"],
                                         "ifpmic.job." + ctx["job_id"], run_id)
        _record_history(root, "history-after-workflow-restart.pbseq", after_history)
        assert _count(after_history, "activity_task_completed_event_attributes",
                      "ifpmic.h2.project_activation") == 1
        assert any(
            int(event.event_id) > completion_event_id
            and event.HasField("workflow_task_completed_event_attributes")
            for event in after_history
        ), "the restarted workflow must record a later workflow decision"
        _record_private(root, "activity-completed-restart.json", {
            "sql_before": at_barrier, "sql_after": final,
            "history_before_restart": len(completed_history),
            "history_after_restart": len(after_history),
            "project_activity_completions": _count(
                after_history, "activity_task_completed_event_attributes", "ifpmic.h2.project_activation"),
            "phase": temporal["phase"],
        })
    finally:
        if ctx is not None:
            _cleanup(ctx, deadline, extra_helpers=[proxy] if proxy is not None else [])
        elif proxy is not None:
            proxy.close()
