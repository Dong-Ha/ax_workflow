"""Real-process H2 negative activity/runtime boundaries.

The private child injects only barriers or narrowly labeled Worker exits.
Production SQL, dispatcher, transport RPC, workflow history and receipts stay real.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time
from uuid import uuid4

import psycopg
import pytest
from temporalio.client import Client

pytest_plugins = (
    "tests.ifpmic_api.jobs_fixture",
    "tests.ifpmic_api.workspace_fixture",
    "tests.ifpmic_api.workflow_schema_fixture",
)

from tests.ifpmic_api import h2_dispatcher_crash_support as crash
from tests.ifpmic_api import test_h2_runtime_normal_flow as normal
from tests.ifpmic_api.jobs_fixture import operator_dsn, owner_dsn
from tests.ifpmic_api.workspace_fixture import accept_workspace_job


REPO_ROOT = Path.cwd().resolve()
CHILD = Path(__file__).with_name("h2_activity_runtime_boundary_child.py")


@pytest.fixture
def h2_activity_runtime_harness(workflow_scram_hba, workspace_environment):
    return workspace_environment


@pytest.fixture
def h2_activity_runtime_deadline(request):
    try:
        return request.node._ifpmic_h2_activity_runtime_deadline
    except AttributeError:
        pytest.fail("the exact H2 activity/runtime watchdog must be loaded before fixtures")


def _barrier(case, name: str) -> Path:
    path = case["root"] / (name + "-barrier")
    path.mkdir(mode=0o700)
    path.chmod(0o700)
    assert stat.S_IMODE(path.stat().st_mode) == 0o700
    return path


def _write_file(path: Path, value: bytes = b"release\n") -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        view = memoryview(value)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError("short private barrier write")
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)


def _wait_event(path: Path, case, deadline: float) -> dict[str, object]:
    while time.monotonic() < deadline:
        if path.exists():
            info = path.lstat()
            assert (stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                    and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1
                    and not path.is_symlink())
            value = json.loads(path.read_text(encoding="ascii"))
            assert type(value) is dict and type(value.get("event")) is str
            return value
        if case["processes"] and all(process.poll() is not None for process in case["processes"]):
            raise AssertionError("owned processes exited before the expected child barrier")
        time.sleep(min(0.02, max(0.0, deadline - time.monotonic())))
    raise TimeoutError("private activity/runtime boundary was not reached")


def _append_owned(case, process, role: str):
    # Keep the Popen handle owned before reading PID identity or writing evidence.
    case["processes"].append(process)
    try:
        ticks = normal.process_identity(process.pid)
        if ticks is None:
            raise AssertionError("owned process start identity unavailable")
        process._ifpmic_start_ticks = ticks
        record = {"role": role, "pid": process.pid, "start_ticks": ticks}
        case["records"].append(record)
        normal._append_private_journal(case["journal"], {"event": "started", **record})
        return record
    except BaseException:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        raise


def _spawn_child(case, config: Path, mode: str, barrier: Path, label: str):
    cache = normal._private_dir(case["root"] / ("cache-" + label))
    logs = normal._private_dir(case["root"] / ("logs-" + label))
    stdout_path, stderr_path = logs / "stdout.log", logs / "stderr.log"
    out_fd = os.open(stdout_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    err_fd = os.open(stderr_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    process = None
    try:
        env = normal._minimal_runtime_env(case["root"], config)
        argv = [sys.executable, "-B", "-X", "pycache_prefix=" + str(cache), str(CHILD),
                str(config), mode, str(barrier)]
        process = subprocess.Popen(argv, cwd=REPO_ROOT, stdin=subprocess.DEVNULL,
                                   stdout=out_fd, stderr=err_fd, env=env, start_new_session=True)
    finally:
        os.close(out_fd)
        os.close(err_fd)
    if process is None:
        raise AssertionError("private child was not started")
    record = _append_owned(case, process, label)
    record.update({"stdout": stdout_path, "stderr": stderr_path, "cache": cache})
    return process, record


def _start_cli(case, role: str):
    process, record = normal._spawn_runtime_cli(role, case[role + "_config"], case["root"])
    case["processes"].append(process)
    case["records"].append(record)
    normal._append_private_journal(case["journal"], {"event": "started", **record})
    return process


def _kill_saved(case, process, role: str):
    pid, ticks = process.pid, process._ifpmic_start_ticks
    assert process.poll() is None and normal.process_identity(pid) == ticks
    normal._append_private_journal(case["journal"], {
        "event": "kill_requested", "role": role, "pid": pid, "start_ticks": ticks,
        "signal": "SIGKILL", "pre_kill_exit_code": process.poll(),
    })
    os.kill(pid, signal.SIGKILL)
    process.wait(timeout=5)
    assert process.returncode == -signal.SIGKILL and normal.process_identity(pid) is None
    normal._append_private_journal(case["journal"], {
        "event": "killed", "role": role, "pid": pid, "start_ticks": ticks,
        "signal": "SIGKILL", "exit_code": process.returncode, "absent": True,
    })


def _release(barrier: Path, name: str) -> None:
    path = barrier / name
    if not path.exists():
        try:
            _write_file(path)
        except FileExistsError:
            pass


def _wait_snapshot(case, predicate, deadline: float, processes=None):
    active = tuple(processes if processes is not None else case["processes"])
    while time.monotonic() < deadline:
        if any(process.poll() is not None for process in active):
            raise AssertionError("owned service exited before independent SQL oracle")
        snapshot = normal._read_owner_snapshot(case["harness"], case["job_id"])
        if predicate(snapshot):
            return snapshot
        time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))
    raise TimeoutError("activity/runtime SQL oracle was not reached")


def _case_cleanup(deadline, case, **kwargs):
    primary = sys.exc_info()[1]
    expected_killed = set(kwargs.get("expected_killed", ()))
    expected_codes = kwargs.get("expected_exit_codes") or {}
    cleanup_error = None
    outcomes = []
    try:
        deadline.begin_cleanup()
        timeout = deadline.cleanup_remaining(15)
        outcomes = normal.stop_all_owned(case["processes"], total_timeout=timeout)
        failures = []
        for process, result in zip(case["processes"], outcomes):
            wanted = (-signal.SIGKILL if process in expected_killed
                      else expected_codes.get(process.pid, 0))
            if (result["returncode"] != wanted or result["absent"] is not True
                    or (process not in expected_killed and process.pid not in expected_codes
                        and result["forced"] is not False)):
                failures.append("PROCESS_CLEANUP_ORACLE_MISMATCH")
            normal._append_private_journal(case["journal"], {
                "event": "stopped", "pid": process.pid,
                "start_ticks": getattr(process, "_ifpmic_start_ticks", None),
                "exit_code": result["returncode"], "absent": result["absent"],
                "forced": result["forced"],
            })
        if failures:
            raise AssertionError(",".join(failures))
        normal._write_private(case["root"] / "process-cleanup.json",
            normal._canonical({"processes": outcomes, "status": "stopped"}) + b"\n")
    except BaseException as error:
        cleanup_error = error
        try:
            normal._write_private(case["root"] / "process-cleanup-failure.json",
                normal._canonical({"status": "failed", "error_type": type(error).__name__,
                                   "primary_error_type": None if primary is None else type(primary).__name__,
                                   "outcomes": outcomes}) + b"\n")
        except BaseException:
            pass
    if cleanup_error is not None and primary is None:
        raise cleanup_error


async def _history(identity, job_id: str, run_id: str):
    client = await asyncio.wait_for(Client.connect(identity["server_endpoint"],
                                                   namespace=identity["namespace"]), 10)
    handle = client.get_workflow_handle("ifpmic.job." + job_id, run_id=run_id)
    result = await handle.fetch_history(rpc_timeout=normal.timedelta(seconds=10))
    return client, list(result.events)


def _read_history(case, run_id: str):
    return asyncio.run(_history(case["identity"], case["job_id"], run_id))


def _write_history(case, name: str, events):
    raw_events = [event.SerializeToString(deterministic=True) for event in events]
    raw = b"".join(len(part).to_bytes(8, "big") + part for part in raw_events)
    normal._write_private(case["root"] / (name + ".pbseq"), raw)
    return hashlib.sha256(raw).hexdigest()


def _scheduled_names(events):
    return {int(event.event_id): event.activity_task_scheduled_event_attributes.activity_type.name
            for event in events if event.HasField("activity_task_scheduled_event_attributes")}


def _count(events, attribute: str, activity_type: str | None = None):
    scheduled = _scheduled_names(events)
    return sum(1 for event in events if event.HasField(attribute)
               and (activity_type is None or scheduled.get(
                   int(getattr(getattr(event, attribute), "scheduled_event_id", -1))) == activity_type))


def _wait_history(case, run_id: str, predicate, deadline: float):
    while time.monotonic() < deadline:
        try:
            _client, events = _read_history(case, run_id)
        except Exception:
            time.sleep(0.1)
            continue
        if predicate(events):
            return events
        time.sleep(0.1)
    raise TimeoutError("direct Temporal history oracle did not reach its required event")


def _normal_outcome(case, deadline: float):
    snapshot = normal._wait_for_sql_outcome(
        case["harness"], case["job_id"], deadline,
        [p for p in case["processes"] if p.poll() is None],
    )
    run_id = snapshot["bindings"][0][19]
    temporal = normal._observe_temporal(
        case["identity"], case["job_id"], case["harness"]["project_id"], run_id,
        {"protocol_version": normal.PROTOCOL_VERSION, "job_id": case["job_id"],
         "project_id": case["harness"]["project_id"], "binding_sha256": snapshot["bindings"][0][18]},
        deadline, case["root"],
    )
    normal._assert_runtime_oracles(snapshot, case["harness"], case["accepted"], case["group"],
                                   case["workspace"], case["identity"], case["roles"], temporal)
    return snapshot, run_id


def _start_pair(case):
    dispatcher = _start_cli(case, "dispatcher")
    worker = _start_cli(case, "worker")
    return dispatcher, worker


def _revoke_authority(case, authority: str):
    harness = case["harness"]
    with psycopg.connect(operator_dsn(harness["database"])) as operator:
        if authority == "membership":
            operator.execute("UPDATE ifpmic.memberships SET active=false "
                             "WHERE project_id=%s AND user_id=%s",
                             (harness["project_id"], harness["user_id"]))
        else:
            operator.execute(
                "INSERT INTO ifpmic.profile_revocations(project_id,eligibility_id,revoked_at) "
                "SELECT project_id,eligibility_id,clock_timestamp() FROM ifpmic.profile_eligibility "
                "WHERE project_id=%s AND snapshot_id=%s ON CONFLICT DO NOTHING",
                (harness["project_id"], harness["record"].snapshot_id),
            )
        state = operator.execute(
            "SELECT m.active,count(r.eligibility_id) FROM ifpmic.memberships m "
            "JOIN ifpmic.profile_eligibility e ON e.project_id=m.project_id "
            "LEFT JOIN ifpmic.profile_revocations r ON r.project_id=e.project_id "
            "AND r.eligibility_id=e.eligibility_id WHERE m.user_id=%s AND m.project_id=%s "
            "AND e.snapshot_id=%s GROUP BY m.active",
            (harness["user_id"], harness["project_id"], harness["record"].snapshot_id),
        ).fetchone()
    assert state == ((False, 0) if authority == "membership" else (True, 1))
    normal._write_private(case["root"] / ("authority-" + authority + ".json"),
                          normal._canonical({"authority": authority, "state": state}) + b"\n")


def _seed_noncreate(case):
    command_id = str(uuid4())
    route = f"POST /api/v1/jobs/{case['job_id']}/human-submissions"
    with psycopg.connect(owner_dsn(case["harness"]["database"])) as owner:
        actor, project = owner.execute(
            "SELECT actor_id,project_id FROM ifpmic.commands WHERE command_id=%s",
            (case["group"][18],),
        ).fetchone()
        payload_sha = hashlib.sha256(("h2-noncreate:" + command_id).encode("ascii")).hexdigest()
        owner.execute(
            "INSERT INTO ifpmic.commands(command_id,actor_id,route,idempotency_key,project_id,job_id,"
            "command_payload_json,payload_sha256) VALUES(%s,%s,%s,%s,%s,%s,'{}',%s)",
            (command_id, actor, route, "h2-noncreate-" + command_id, project,
             case["job_id"], payload_sha),
        )
        owner.execute("INSERT INTO ifpmic.commands_outbox(command_id) VALUES(%s)", (command_id,))
    return {"command_id": command_id, "route": route, "payload_sha256": payload_sha}


def _wait_noncreate(case, command_id: str, run_id: str, deadline: float):
    while time.monotonic() < deadline:
        if not any(process.poll() is None for process in case["processes"]):
            raise AssertionError("all owned services exited before non-create delivery")
        with psycopg.connect(owner_dsn(case["harness"]["database"])) as owner:
            rows = owner.execute(
                "SELECT c.route,c.status,c.applied_revision,c.error_code,o.state,o.generation,"
                "a.result,a.observed_run_id::text,a.completed_at IS NOT NULL "
                "FROM ifpmic.commands c JOIN ifpmic.commands_outbox o USING(command_id) "
                "JOIN ifpmic.delivery_attempts a USING(command_id) WHERE c.command_id=%s "
                "ORDER BY a.generation", (command_id,),
            ).fetchall()
        if rows and rows[-1][6] == "signaled":
            assert rows == [(rows[0][0], "accepted", None, None, "dispatched", 1,
                             "signaled", run_id, True)]
            return rows
        time.sleep(0.05)
    raise TimeoutError("real non-create signal delivery did not complete")


@pytest.mark.parametrize("authority", ["membership", "eligibility"])
def test_h2_authority_revoked_before_first_projection(
    authority, h2_activity_runtime_harness, h2_activity_runtime_deadline,
):
    deadline = h2_activity_runtime_deadline
    case = crash.prepare_case(h2_activity_runtime_harness, deadline.body_deadline,
                              "activity-authority-before-" + authority)
    barrier = None
    try:
        barrier = _barrier(case, "authority-before")
        _start_cli(case, "dispatcher")
        _worker, _record = _spawn_child(case, case["worker_config"], "authority-before", barrier,
                                        "worker-authority-before")
        event = _wait_event(barrier / "before_first_projection_sql.json", case,
                            min(deadline.body_deadline, time.monotonic() + 180))
        assert event["event"] == "before_first_projection_sql"
        pre = normal._read_owner_snapshot(case["harness"], case["job_id"])
        assert pre["accepted"][3:8] == ("DRAFT", 0, 0, [], None) and pre["receipts"] == []
        _revoke_authority(case, authority)
        access = case["harness"]["client"].get("/api/v1/jobs/" + case["job_id"])
        if authority == "membership":
            assert access.status_code == 403 and access.json()["error"]["code"] == "FORBIDDEN"
        else:
            assert access.status_code == 200 and access.json()["job"]["status"] == "DRAFT"
        _release(barrier, "release-project-activation")
        code = "FORBIDDEN" if authority == "membership" else "PROFILE_INELIGIBLE"
        rejected = _wait_snapshot(
            case, lambda value: bool(value["receipts"]) and value["receipts"][0][7] == "rejected",
            deadline.body_deadline, [p for p in case["processes"] if p.poll() is None],
        )
        assert rejected["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
        assert rejected["accepted"][12:15] == ("rejected", None, code)
        assert len(rejected["bindings"]) == len(rejected["scopes"]) == len(rejected["receipts"]) == 1
        assert rejected["bindings"][0][20] == "admitted"
        receipt = rejected["receipts"][0]
        proposal = {
            "protocol_version": normal.PROTOCOL_VERSION,
            "kind": "activate_create",
            "job_id": case["job_id"],
            "run_id": rejected["bindings"][0][19],
            "build_id": case["identity"]["build_id"],
            "binding_sha256": rejected["bindings"][0][18],
            "transition_sequence": 1,
            "expected_revision": 0,
            "command_id": case["group"][18],
            "command_payload_sha256": case["group"][13],
        }
        proposal_bytes = json.dumps(proposal, ensure_ascii=True, sort_keys=True,
                                    separators=(",", ":"), allow_nan=False).encode("ascii")
        proposal_sha = hashlib.sha256(b"ifpmic.b03.transition.v1\0" + proposal_bytes).hexdigest()
        assert receipt[1:8] == (1, case["group"][18], rejected["bindings"][0][19],
                                case["identity"]["build_id"], proposal_sha, 0, "rejected")
        assert receipt[8] == {"status": "rejected", "command_id": case["group"][18],
            "applied_revision": None, "error_code": code, "job_id": case["job_id"],
            "job_status": "DRAFT", "revision": 0}
        history = _wait_history(case, rejected["bindings"][0][19],
            lambda items: _count(items, "workflow_execution_completed_event_attributes") == 1,
            deadline.body_deadline)
        _write_history(case, "authority-rejected-history", history)
        assert _count(history, "workflow_execution_started_event_attributes") == 1
        assert _count(history, "workflow_execution_failed_event_attributes") == 0
        completed = next(item for item in history
                         if item.HasField("workflow_execution_completed_event_attributes"))
        client, _ = _read_history(case, rejected["bindings"][0][19])
        value = asyncio.run(client.data_converter.decode_wrapper(
            completed.workflow_execution_completed_event_attributes.result))
        assert value == [{"status": "rejected", "code": code}]
    finally:
        if barrier is not None:
            _release(barrier, "release-project-activation")
        _case_cleanup(deadline, case)


@pytest.mark.parametrize("authority", ["membership", "eligibility"])
def test_h2_committed_receipt_replays_after_authority_revoke(
    authority, h2_activity_runtime_harness, h2_activity_runtime_deadline,
):
    deadline = h2_activity_runtime_deadline
    case = crash.prepare_case(h2_activity_runtime_harness, deadline.body_deadline,
                              "activity-receipt-replay-" + authority)
    barrier = None
    killed = []
    try:
        barrier = _barrier(case, "receipt-replay")
        _start_cli(case, "dispatcher")
        first, _record = _spawn_child(case, case["worker_config"], "authority-replay", barrier,
                                      "worker-before-lost-activity-result")
        event = _wait_event(barrier / "projection_commit_complete.json", case,
                            min(deadline.body_deadline, time.monotonic() + 180))
        assert event["event"] == "projection_commit_complete"
        committed = normal._read_owner_snapshot(case["harness"], case["job_id"])
        assert committed["accepted"][3:8] == ("QUEUED", 1, 0, [], None)
        assert len(committed["receipts"]) == 1 and committed["receipts"][0][7] == "applied"
        run_id = committed["bindings"][0][19]
        before = _read_history(case, run_id)[1]
        assert _count(before, "activity_task_completed_event_attributes",
                      "ifpmic.h2.project_activation") == 0
        _write_history(case, "history-before-lost-activity-result", before)
        _revoke_authority(case, authority)
        _kill_saved(case, first, "worker-before-lost-activity-result")
        killed.append(first)
        _start_cli(case, "worker")
        final = _wait_snapshot(
            case, lambda value: len(value["receipts"]) == 1 and value["receipts"][0][7] == "applied",
            deadline.body_deadline, [p for p in case["processes"] if p not in killed],
        )
        assert final["receipts"] == committed["receipts"]
        assert final["bindings"] == committed["bindings"]
        assert final["accepted"][3:8] == ("QUEUED", 1, 0, [], None)
        after = _wait_history(case, run_id, lambda items: _count(
            items, "activity_task_completed_event_attributes", "ifpmic.h2.project_activation") == 1,
            deadline.body_deadline)
        _write_history(case, "history-after-receipt-replay", after)
        assert _count(after, "workflow_execution_started_event_attributes") == 1
        assert _count(after, "workflow_execution_completed_event_attributes") == 0
        assert _count(after, "activity_task_completed_event_attributes",
                      "ifpmic.h2.project_activation") == 1
        assert final["noncreate_commands"] == 0
    finally:
        if barrier is not None:
            _release(barrier, "release-activity-result")
        _case_cleanup(deadline, case, expected_killed=tuple(killed))


def _sql_only_unadmitted_case(harness):
    accepted = accept_workspace_job(harness, key="h2-noncreate-unadmitted-" + uuid4().hex)
    group = normal.workspace_rows(harness, accepted["job_id"])
    assert group is not None
    workspace, _tree = normal._workspace_ready(harness, Path(harness["workspace_root"]), accepted["job_id"])
    normal._add_live_sql_eligibility(harness, accepted["job_id"])
    root = normal._private_dir(normal._runtime_evidence_root() / ("noncreate-unadmitted-" + uuid4().hex))
    deployment_id, endpoint = "h2-sql-only-" + uuid4().hex, "127.0.0.1:1"
    source_sha, env_sha = normal._manifest_hash(normal.source_manifest()), normal._manifest_hash(normal.environment_manifest())
    server_sha = normal._domain_hash("ifpmic.b03.deployment.v1", {
        "protocol_version": normal.PROTOCOL_VERSION, "deployment_id": deployment_id,
        "namespace": normal.NAMESPACE, "server_endpoint": endpoint})
    build_id = normal._domain_hash("ifpmic.b03.build.v1", {
        "protocol_version": normal.PROTOCOL_VERSION, "source_manifest_sha256": source_sha,
        "environment_manifest_sha256": env_sha, "workflow_type": normal.WORKFLOW_TYPE})
    identity = {"deployment_id": deployment_id, "namespace": normal.NAMESPACE,
        "server_endpoint": endpoint, "server_config_sha256": server_sha, "build_id": build_id,
        "source_manifest_sha256": source_sha, "environment_manifest_sha256": env_sha}
    normal._register_identity(harness, identity)
    return {"harness": harness, "accepted": accepted, "job_id": accepted["job_id"],
            "group": group, "workspace": workspace, "root": root, "identity": identity}


def test_h2_noncreate_waits_until_admission(h2_activity_runtime_harness):
    case = _sql_only_unadmitted_case(h2_activity_runtime_harness)
    command = _seed_noncreate(case)
    before = normal._read_owner_snapshot(case["harness"], case["job_id"])
    assert before["bindings"] == before["scopes"] == before["receipts"] == before["attempts"] == []
    assert before["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
    with psycopg.connect(normal._private_dsn(case["harness"]["database"], "dispatcher"),
                         autocommit=True) as dispatcher:
        claim = dispatcher.execute("SELECT ifpmic.claim_delivery(%s)", (command["command_id"],)).fetchone()[0]
    assert claim == {"status": "idle"}
    after = normal._read_owner_snapshot(case["harness"], case["job_id"])
    assert after["accepted"] == before["accepted"]
    assert after["bindings"] == after["scopes"] == after["receipts"] == after["attempts"] == []
    with psycopg.connect(owner_dsn(case["harness"]["database"])) as owner:
        row = owner.execute(
            "SELECT c.status,c.applied_revision,c.error_code,o.state,o.generation,o.claim_token "
            "FROM ifpmic.commands c JOIN ifpmic.commands_outbox o USING(command_id) WHERE c.command_id=%s",
            (command["command_id"],),
        ).fetchone()
    assert row == ("accepted", None, None, "pending", 0, None)
    normal._write_private(case["root"] / "noncreate-not-admitted.json",
        normal._canonical({"claim": claim, "command_id": command["command_id"],
                          "command_status": row[0], "outbox": row[3]}) + b"\n")


def test_h2_noncreate_signal_targets_admitted_run_without_business_consumption(
    h2_activity_runtime_harness, h2_activity_runtime_deadline,
):
    deadline = h2_activity_runtime_deadline
    case = crash.prepare_case(h2_activity_runtime_harness, deadline.body_deadline, "noncreate-signal")
    try:
        _start_pair(case)
        before, run_id = _normal_outcome(case, deadline.body_deadline)
        command = _seed_noncreate(case)
        with psycopg.connect(owner_dsn(case["harness"]["database"])) as owner:
            owner.execute("UPDATE ifpmic.commands_outbox SET next_attempt_at=clock_timestamp() "
                          "WHERE command_id=%s", (command["command_id"],))
        _start_cli(case, "dispatcher")
        state = _wait_noncreate(case, command["command_id"], run_id, deadline.body_deadline)
        assert state[0][0] == command["route"]
        final = normal._read_owner_snapshot(case["harness"], case["job_id"])
        assert final["bindings"] == before["bindings"] and final["scopes"] == before["scopes"]
        assert final["receipts"] == before["receipts"]
        assert final["accepted"][3:8] == ("QUEUED", 1, 0, [], None)
        assert final["accepted"][18] == run_id and final["noncreate_commands"] == 1
        client, events = _read_history(case, run_id)
        _write_history(case, "history-after-real-noncreate-signal", events)
        assert _count(events, "workflow_execution_started_event_attributes") == 1
        signals = [event.workflow_execution_signaled_event_attributes for event in events
                   if event.HasField("workflow_execution_signaled_event_attributes")
                   and event.workflow_execution_signaled_event_attributes.signal_name == "command_available"]
        assert len(signals) == 1
        payloads = asyncio.run(client.data_converter.decode_wrapper(signals[0].input))
        assert payloads == [{"command_id": command["command_id"],
                             "payload_sha256": command["payload_sha256"]}]
        handle = client.get_workflow_handle("ifpmic.job." + case["job_id"], run_id=run_id)
        assert asyncio.run(handle.query("notification_count", rpc_timeout=normal.timedelta(seconds=10))) == 1
    finally:
        _case_cleanup(deadline, case)


async def _list_runs(identity, job_id: str):
    client = await asyncio.wait_for(Client.connect(identity["server_endpoint"],
                                                   namespace=identity["namespace"]), 10)
    values = []
    async for item in client.list_workflows(f'WorkflowId = "ifpmic.job.{job_id}"', limit=10,
                                            rpc_timeout=normal.timedelta(seconds=10)):
        values.append((item.id, item.run_id, getattr(item.status, "name", str(item.status))))
    return values


def test_h2_missing_history_then_retention_rpc_failure_never_starts(
    h2_activity_runtime_harness, h2_activity_runtime_deadline,
):
    deadline = h2_activity_runtime_deadline
    case = crash.prepare_case(h2_activity_runtime_harness, deadline.body_deadline, "retention-rpc-failure")
    barrier = None
    expected_codes = {}
    try:
        barrier = _barrier(case, "retention")
        dispatcher, _record = _spawn_child(case, case["dispatcher_config"], "retention-rpc", barrier,
                                           "dispatcher-real-retention-rpc")
        missing = _wait_event(barrier / "actual_history_not_found.json", case,
                              min(deadline.body_deadline, time.monotonic() + 150))
        assert missing["event"] == "actual_history_not_found"
        assert asyncio.run(_list_runs(case["identity"], case["job_id"])) == []
        server = case["server"]
        normal._append_private_journal(case["journal"], {"event": "stop_temporal_before_retention_rpc",
            "pid": server.pid, "start_ticks": server._ifpmic_start_ticks, "pre_stop_exit_code": server.poll()})
        stop = normal.stop_all_owned([server], total_timeout=5)
        assert server.poll() == 0 and normal.process_identity(server.pid) is None
        expected_codes[server.pid] = 0
        normal._append_private_journal(case["journal"], {"event": "temporal_stopped",
            "pid": server.pid, "start_ticks": server._ifpmic_start_ticks,
            "exit_code": server.returncode, "identity_absent": True, "stop_result": stop})
        _release(barrier, "allow_retention_rpc")
        rpc = _wait_event(barrier / "actual_retention_rpc_begin.json", case,
                          min(deadline.body_deadline, time.monotonic() + 30))
        assert rpc["event"] == "actual_retention_rpc_begin"
        final = _wait_snapshot(case, lambda value: bool(value["bindings"])
            and value["bindings"][0][20] == "quarantined", deadline.body_deadline, (dispatcher,))
        binding = final["bindings"][0]
        assert binding[19] is None and binding[20] == "quarantined"
        assert binding[21:26] == (None, None, None, None, None)
        assert binding[26] == "RETENTION_UNVERIFIED"
        assert final["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
        assert final["receipts"] == final["scopes"] == []
        assert final["attempts"] == [(1, "quarantined", None, "RETENTION_UNVERIFIED", True)]
        normal._write_private(case["root"] / "retention-unavailable.json", normal._canonical({
            "actual_missing_history_event": missing["event"], "actual_retention_rpc_event": rpc["event"],
            "binding_state": binding[20], "quarantine_code": binding[26],
            "start_attempt_at": binding[21], "admitted_run_id": binding[19],
        }) + b"\n")
    finally:
        if barrier is not None:
            _release(barrier, "allow_retention_rpc")
        _case_cleanup(deadline, case, expected_exit_codes=expected_codes)


def _wait_exit(process, deadline: float):
    while process.poll() is None and time.monotonic() < deadline:
        time.sleep(0.02)
    if process.poll() is None:
        raise TimeoutError("runtime child did not exit before case deadline")
    return process.returncode


@pytest.mark.parametrize("mode", ["runtime-return", "runtime-fatal", "runtime-concurrent-fatal"])
def test_h2_execution_runtime_surfaces_unrequested_worker_exit(
    mode, h2_activity_runtime_harness, h2_activity_runtime_deadline,
):
    deadline = h2_activity_runtime_deadline
    case = crash.prepare_case(h2_activity_runtime_harness, deadline.body_deadline,
                              "runtime-exit-" + mode)
    barrier = None
    expected_codes = {}
    try:
        barrier = _barrier(case, "runtime-exit")
        process, record = _spawn_child(case, case["worker_config"], mode, barrier, "runtime-exit-child")
        entered = _wait_event(barrier / "worker_run_entered.json", case,
                              min(deadline.body_deadline, time.monotonic() + 120))
        assert entered["event"] == "worker_run_entered"
        if mode == "runtime-concurrent-fatal":
            armed = _wait_event(barrier / "worker_fatal_armed.json", case,
                                min(deadline.body_deadline, time.monotonic() + 10))
            assert armed["event"] == "worker_fatal_armed"
            _release(barrier, "release-worker-task")
            sent = _wait_event(barrier / "concurrent_sigterm_sent.json", case,
                               min(deadline.body_deadline, time.monotonic() + 10))
            assert sent["event"] == "concurrent_sigterm_sent"
        else:
            _write_file(barrier / "worker-action",
                        ("return" if mode == "runtime-return" else "raise").encode("ascii"))
            _release(barrier, "release-worker-task")
        exit_code = _wait_exit(process, min(deadline.body_deadline, time.monotonic() + 20))
        assert exit_code == 3 and normal.process_identity(process.pid) is None
        expected_codes[process.pid] = 3
        assert record["stdout"].read_bytes() == b'{"error":{"code":"DEPENDENCY_UNAVAILABLE"}}\n'
        assert normal._read_owner_snapshot(case["harness"], case["job_id"])["bindings"] == []
    finally:
        if barrier is not None:
            _release(barrier, "release-worker-task")
        _case_cleanup(deadline, case, expected_exit_codes=expected_codes)


def test_h2_execution_runtime_normal_sigterm_control(
    h2_activity_runtime_harness, h2_activity_runtime_deadline,
):
    deadline = h2_activity_runtime_deadline
    case = crash.prepare_case(h2_activity_runtime_harness, deadline.body_deadline, "runtime-normal-sigterm")
    barrier = None
    expected_codes = {}
    try:
        barrier = _barrier(case, "normal-sigterm")
        process, record = _spawn_child(case, case["worker_config"], "normal-sigterm", barrier,
                                       "runtime-normal-sigterm-child")
        entered = _wait_event(barrier / "worker_run_entered.json", case,
                              min(deadline.body_deadline, time.monotonic() + 120))
        assert entered["event"] == "worker_run_entered"
        assert normal.process_identity(process.pid) == record["start_ticks"]
        os.kill(process.pid, signal.SIGTERM)
        exit_code = _wait_exit(process, min(deadline.body_deadline, time.monotonic() + 10))
        assert exit_code == 0 and normal.process_identity(process.pid) is None
        expected_codes[process.pid] = 0
        assert record["stdout"].read_bytes() == b""
    finally:
        _case_cleanup(deadline, case, expected_exit_codes=expected_codes)


def _wait_hung_projector_query(case, backend_pid: int, deadline: float):
    migration = case["harness"]["database"][0]
    role = migration.roles.projector
    while time.monotonic() < deadline:
        with psycopg.connect(owner_dsn(case["harness"]["database"])) as owner:
            rows = owner.execute(
                "SELECT pid,usename,datname,state,query,xact_start IS NOT NULL "
                "FROM pg_stat_activity WHERE datname=%s AND usename=%s AND pid=%s",
                (migration.name, role, backend_pid),
            ).fetchall()
        if rows == [(backend_pid, role, migration.name, "active",
                     "SELECT pg_sleep(60)", True)]:
            return {"backend_pid": backend_pid, "role": role, "query": rows[0][4],
                    "state": rows[0][3], "transaction_open": rows[0][5]}
        time.sleep(0.05)
    raise TimeoutError("the real projector pg_sleep statement was not visible in pg_stat_activity")


def _wait_projector_backend_gone(case, backend_pid: int, deadline: float):
    migration = case["harness"]["database"][0]
    role = migration.roles.projector
    while time.monotonic() < deadline:
        with psycopg.connect(owner_dsn(case["harness"]["database"])) as owner:
            row = owner.execute(
                "SELECT count(*) FROM pg_stat_activity WHERE datname=%s AND usename=%s AND pid=%s",
                (migration.name, role, backend_pid),
            ).fetchone()
        if row == (0,):
            return {"backend_pid": backend_pid, "role": role, "absent": True}
        time.sleep(0.05)
    raise TimeoutError("killed worker's exact PostgreSQL backend remained in pg_stat_activity")


def test_h2_execution_runtime_kills_hung_real_driver_and_rolls_back(
    h2_activity_runtime_harness, h2_activity_runtime_deadline,
):
    deadline = h2_activity_runtime_deadline
    case = crash.prepare_case(h2_activity_runtime_harness, deadline.body_deadline, "runtime-hung-driver")
    barrier = None
    expected_codes = {}
    try:
        barrier = _barrier(case, "hung-driver")
        _start_cli(case, "dispatcher")
        worker, record = _spawn_child(case, case["worker_config"], "hung-driver", barrier,
                                      "runtime-hung-real-driver")
        event = _wait_event(barrier / "projection_driver_blocked.json", case,
                            min(deadline.body_deadline, time.monotonic() + 150))
        assert event["event"] == "projection_driver_blocked"
        backend_pid = event["backend_pid"]
        pg_during = _wait_hung_projector_query(
            case, backend_pid, min(deadline.body_deadline, time.monotonic() + 5))
        during = normal._read_owner_snapshot(case["harness"], case["job_id"])
        assert during["accepted"][3:8] == ("DRAFT", 0, 0, [], None) and during["receipts"] == []
        assert normal.process_identity(worker.pid) == record["start_ticks"]
        normal._append_private_journal(case["journal"], {
            "event": "sigterm_requested", "role": "runtime-hung-real-driver",
            "pid": worker.pid, "start_ticks": record["start_ticks"],
            "backend_pid": backend_pid, "pg_query": pg_during["query"],
        })
        signal_started = time.monotonic()
        os.kill(worker.pid, signal.SIGTERM)
        exit_code = _wait_exit(worker, min(deadline.body_deadline, time.monotonic() + 18))
        self_exit_seconds = time.monotonic() - signal_started
        assert 12 <= self_exit_seconds <= 18
        assert exit_code == 3 and normal.process_identity(worker.pid) is None
        expected_codes[worker.pid] = 3
        pg_state = _wait_projector_backend_gone(
            case, backend_pid, min(deadline.body_deadline, time.monotonic() + 10))
        after = normal._read_owner_snapshot(case["harness"], case["job_id"])
        assert after["accepted"][3:8] == ("DRAFT", 0, 0, [], None) and after["receipts"] == []
        assert after["bindings"] == during["bindings"] and after["scopes"] == during["scopes"]
        run_id = after["bindings"][0][19]
        history = _read_history(case, run_id)[1]
        assert _count(history, "activity_task_completed_event_attributes",
                      "ifpmic.h2.project_activation") == 0
        _write_history(case, "history-after-hung-driver-kill", history)
        _start_cli(case, "worker")
        final = _wait_snapshot(case, lambda value: value["accepted"][3] == "QUEUED"
            and len(value["receipts"]) == 1, deadline.body_deadline,
            [p for p in case["processes"] if p.poll() is None])
        assert final["accepted"][3:8] == ("QUEUED", 1, 0, [], None)
        assert len(final["receipts"]) == 1 and final["receipts"][0][7] == "applied"
        assert final["bindings"][0][19] == run_id and len(final["bindings"]) == len(final["scopes"]) == 1
        assert final["attempts"] == [(1, "started", run_id, None, True)]
        recovered = _wait_history(case, run_id, lambda items: _count(
            items, "activity_task_completed_event_attributes", "ifpmic.h2.project_activation") == 1,
            deadline.body_deadline)
        _write_history(case, "history-after-driver-rollback-recovery", recovered)
        assert _count(recovered, "workflow_execution_started_event_attributes") == 1
        assert _count(recovered, "activity_task_completed_event_attributes",
                      "ifpmic.h2.project_activation") == 1
        normal._write_private(case["root"] / "hung-driver-rollback.json", normal._canonical({
            "killed_pid": worker.pid, "start_ticks": record["start_ticks"], "exit_code": exit_code,
            "pg_state": pg_during, "pg_backend_after_kill": pg_state,
            "self_exit_seconds": self_exit_seconds, "receipt_count_after_kill": 0,
            "receipt_count_after_recovery": len(final["receipts"]), "run_id": run_id,
        }) + b"\n")
    finally:
        _case_cleanup(deadline, case, expected_exit_codes=expected_codes)
