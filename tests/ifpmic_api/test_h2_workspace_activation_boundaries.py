"""Real H2 dispatcher/worker boundaries around durable workspace identity."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import signal
import sys
import time
from uuid import uuid4

import psycopg
from tests.ifpmic_api.h2_native_bounds import bounded_connect
import pytest
from temporalio.client import Client

pytest_plugins = (
    "tests.ifpmic_api.jobs_fixture",
    "tests.ifpmic_api.workspace_fixture",
    "tests.ifpmic_api.workflow_schema_fixture",
)

from services.ifpmic_api.workspace import WorkspaceService
from tests.ifpmic_api import h2_dispatcher_crash_support as crash
from tests.ifpmic_api.h2_fixture_cleanup import restore_preserving_error
from tests.ifpmic_api import test_h2_runtime_normal_flow as normal
from tests.ifpmic_api.jobs_fixture import owner_dsn, runtime_dsn
from tests.ifpmic_api.workspace_fixture import (
    WORKSPACE_MARKER_NAME, expected_marker_bytes, tree_fingerprint,
)


REPO_ROOT = Path.cwd().resolve()


@pytest.fixture
def h2_workspace_harness(workflow_scram_hba, workspace_environment):
    return workspace_environment


@pytest.fixture
def h2_workspace_deadline(request):
    try:
        return request.node._ifpmic_h2_workspace_deadline
    except AttributeError:
        pytest.fail("the exact H2 workspace watchdog must be loaded before fixtures")


def _set_workspace_state(harness, job_id: str, state: str):
    assert state in {"RESERVED", "PROVISIONING", "ERROR"}
    with bounded_connect(owner_dsn(harness["database"])) as owner:
        if state == "RESERVED":
            owner.execute(
                "UPDATE ifpmic.workspace_intents SET state='RESERVED',claim_token=NULL,"
                "claim_expires_at=NULL,error_code=NULL WHERE job_id=%s", (job_id,),
            )
        elif state == "PROVISIONING":
            owner.execute(
                "UPDATE ifpmic.workspace_intents SET state='PROVISIONING',claim_token=gen_random_uuid(),"
                "claim_expires_at=clock_timestamp()+interval '10 minutes',error_code=NULL WHERE job_id=%s",
                (job_id,),
            )
        else:
            owner.execute(
                "UPDATE ifpmic.workspace_intents SET state='ERROR',claim_token=NULL,"
                "claim_expires_at=NULL,error_code='WORKSPACE_IO' WHERE job_id=%s", (job_id,),
            )
        return owner.execute(
            "SELECT state,generation,workspace_token::text,claim_token::text,error_code "
            "FROM ifpmic.workspace_intents WHERE job_id=%s", (job_id,),
        ).fetchone()


def _workspace_row(harness, job_id: str):
    with bounded_connect(owner_dsn(harness["database"])) as owner:
        return owner.execute(
            "SELECT state,generation,workspace_token::text,claim_token::text,error_code "
            "FROM ifpmic.workspace_intents WHERE job_id=%s", (job_id,),
        ).fetchone()


def _assert_draft_without_binding(case, snapshot):
    assert snapshot["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
    assert snapshot["bindings"] == snapshot["scopes"] == snapshot["receipts"] == []
    assert snapshot["noncreate_commands"] == 0


async def _list_runs(identity, job_id: str):
    client = await asyncio.wait_for(Client.connect(identity["server_endpoint"],
                                                   namespace=identity["namespace"]), 10)
    values = []
    async for item in client.list_workflows(
        f'WorkflowId = "ifpmic.job.{job_id}"', limit=10,
        rpc_timeout=normal.timedelta(seconds=10),
    ):
        values.append((item.id, item.run_id, getattr(item.status, "name", str(item.status))))
    return values


def _no_runs(case):
    assert asyncio.run(_list_runs(case["identity"], case["job_id"])) == []


def _start_barrier(case, phase: str, deadline):
    process, record, barrier = crash.start_barrier_dispatcher(case, phase)
    barrier.wait(deadline.remaining(30))
    assert process.poll() is None
    assert normal.process_identity(process.pid) == record["start_ticks"]
    return process, record, barrier


def _wait_process(process, deadline):
    return process.wait(timeout=deadline.remaining(30))


def _assert_delivery_attempt(snapshot, result: str, code: str):
    assert snapshot["attempts"] == [(1, result, None, code, True)]
    assert snapshot["accepted"][16] == 1
    assert snapshot["accepted"][17] is None


def _finish_dispatcher_cut(case, deadline, process, expected_status: str, result: str, code: str):
    snapshot_before = normal._read_owner_snapshot(case["harness"], case["job_id"])
    _assert_draft_without_binding(case, snapshot_before)
    assert snapshot_before["accepted"][15] == "leased"
    assert snapshot_before["accepted"][16] == 1
    assert snapshot_before["accepted"][17] is not None
    barrier = case["barriers"][-1][0]
    barrier.release()
    exit_code = _wait_process(process, deadline)
    assert exit_code == 3
    stdout = case["records"][-1]["stdout"].read_bytes()
    assert json.loads(stdout) == {"status": expected_status}
    final = normal._read_owner_snapshot(case["harness"], case["job_id"])
    _assert_draft_without_binding(case, final)
    _assert_delivery_attempt(final, result, code)
    assert final["accepted"][15] == ("quarantined" if result == "quarantined" else "pending")
    _no_runs(case)
    return final


def _close_case(deadline, case, expected_exit_codes=None):
    primary = sys.exc_info()[1]
    expected_exit_codes = expected_exit_codes or {}
    cleanup_error = None
    outcomes = []
    try:
        deadline.begin_cleanup()
        for barrier, _barrier_dir in case["barriers"]:
            if barrier.hit.is_set() and barrier.error is None and not barrier.released.is_set():
                try:
                    barrier.release(remaining_time=deadline.cleanup_remaining)
                finally:
                    restore_preserving_error(
                        lambda: barrier.close(remaining_time=deadline.cleanup_remaining))
            else:
                barrier.close(remaining_time=deadline.cleanup_remaining)
            try:
                barrier.path.parent.rmdir()
            except OSError:
                pass
        outcomes = normal.stop_all_owned(
            case["processes"], total_timeout=deadline.cleanup_remaining(15),
        )
        errors = []
        for process, outcome in zip(case["processes"], outcomes):
            wanted = expected_exit_codes.get(process.pid, 0)
            if (outcome["returncode"] != wanted or outcome["absent"] is not True
                    or outcome["forced"] is not False):
                errors.append("OWNED_PROCESS_CLEANUP_MISMATCH")
            normal._append_private_journal(case["journal"], {
                "event": "stopped", "pid": process.pid,
                "start_ticks": getattr(process, "_ifpmic_start_ticks", None),
                "exit_code": outcome["returncode"], "absent": outcome["absent"],
                "forced": outcome["forced"],
            })
        if errors:
            raise AssertionError(",".join(errors))
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


def _damage_marker(case, damage: str):
    root = Path(case["harness"]["workspace_root"])
    job_path = root / case["job_id"]
    marker = job_path / WORKSPACE_MARKER_NAME
    token = case["workspace"]["workspace_token"]
    outside = None
    if damage == "marker-missing":
        marker.unlink()
    elif damage == "marker-forged":
        marker.write_bytes(b'{"format":"forged","job_id":"not-the-job"}\n')
        marker.chmod(0o600)
    elif damage == "marker-wrong-token":
        wrong_token = str(uuid4())
        assert wrong_token != token
        marker.write_bytes(expected_marker_bytes(case["job_id"], wrong_token))
        marker.chmod(0o600)
    elif damage == "marker-symlink":
        outside = case["root"] / "external-marker-target.json"
        normal._write_private(outside, expected_marker_bytes(case["job_id"], token))
        marker.unlink()
        marker.symlink_to(outside)
    else:
        raise AssertionError("unknown private workspace damage variant")
    return tree_fingerprint(root), outside


def _assert_workspace_tree_unchanged(case, damaged_tree, outside):
    current = tree_fingerprint(Path(case["harness"]["workspace_root"]))
    assert current == damaged_tree
    if outside is not None:
        assert outside.read_bytes() == expected_marker_bytes(
            case["job_id"], case["workspace"]["workspace_token"])


def _set_g5_error_then_reconcile(case):
    _set_workspace_state(case["harness"], case["job_id"], "ERROR")
    service = WorkspaceService(
        case["harness"]["settings"],
        db_factory=lambda: bounded_connect(
            runtime_dsn(case["harness"]["database"]), autocommit=True),
    )
    assert service.retry_error(case["job_id"]) == {
        "status": "retry_queued", "job_id": case["job_id"], "error_code": None,
    }
    result = service.reconcile_once(case["job_id"])
    assert result == {"status": "ready", "job_id": case["job_id"], "error_code": None}
    return result


async def _history(identity, job_id: str, run_id: str):
    client = await asyncio.wait_for(Client.connect(identity["server_endpoint"],
                                                   namespace=identity["namespace"]), 10)
    handle = client.get_workflow_handle("ifpmic.job." + job_id, run_id=run_id)
    value = await handle.fetch_history(rpc_timeout=normal.timedelta(seconds=10))
    events = list(value.events)
    scheduled = _activity_types(events)
    completions = []
    for event in events:
        if not event.HasField("activity_task_completed_event_attributes"):
            continue
        attrs = event.activity_task_completed_event_attributes
        if scheduled.get(int(attrs.scheduled_event_id)) == "ifpmic.h2.read_activation":
            decoded = await client.data_converter.decode_wrapper(attrs.result)
            assert type(decoded) is list and len(decoded) == 1
            completions.append(decoded[0])
    return events, completions


def _activity_types(events):
    return {
        int(event.event_id): event.activity_task_scheduled_event_attributes.activity_type.name
        for event in events if event.HasField("activity_task_scheduled_event_attributes")
    }


def _wait_for_read_wait(case, run_id: str, deadline: float):
    while time.monotonic() < deadline:
        if any(process.poll() is not None for process in case["processes"]
               if getattr(process, "_ifpmic_role", None) == "worker"):
            raise AssertionError("normal worker exited before workspace read wait")
        try:
            events, completions = asyncio.run(
                _history(case["identity"], case["job_id"], run_id))
        except Exception:
            time.sleep(0.1)
            continue
        for result in completions:
            if result == {"status": "wait", "code": "DEPENDENCY_UNAVAILABLE"}:
                return events, result
        time.sleep(0.1)
    raise TimeoutError("worker history did not record the real workspace read wait")


def _start_cli(case, role: str):
    process, record = normal._spawn_runtime_cli(role, case[role + "_config"], case["root"])
    process._ifpmic_role = role
    case["processes"].append(process)
    case["records"].append(record)
    normal._append_private_journal(case["journal"], {"event": "started", **record})
    return process, record


@pytest.mark.parametrize("state", ["RESERVED", "PROVISIONING", "ERROR"],
                         ids=["state-reserved", "state-provisioning", "state-error"])
def test_h2_workspace_nonready_blocks_dispatcher_before_start(
    state, h2_workspace_harness, h2_workspace_deadline,
):
    deadline = h2_workspace_deadline
    case = crash.prepare_case(h2_workspace_harness, deadline.body_deadline,
                              "workspace-dispatch-nonready-" + state.lower(), cleanup_controller=deadline)
    expected_codes = {}
    try:
        tree = tree_fingerprint(Path(case["harness"]["workspace_root"]))
        workspace = _set_workspace_state(case["harness"], case["job_id"], state)
        assert workspace[0] == state
        process, _record, _barrier = _start_barrier(case, "after_claim_commit", deadline)
        final = _finish_dispatcher_cut(case, deadline, process, "pending", "retry",
                                       "WORKSPACE_NOT_READY")
        assert final["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
        assert _workspace_row(case["harness"], case["job_id"])[0] == state
        assert tree_fingerprint(Path(case["harness"]["workspace_root"])) == tree
        expected_codes[process.pid] = 3
        normal._write_private(case["root"] / "workspace-nonready-dispatcher.json",
            normal._canonical({"state": state, "attempts": final["attempts"],
                              "workflow_runs": 0, "tree_unchanged": True}) + b"\n")
    finally:
        _close_case(deadline, case, expected_codes)


@pytest.mark.parametrize("damage", ["marker-missing", "marker-forged", "marker-wrong-token", "marker-symlink"],
                         ids=["marker-missing", "marker-forged", "marker-wrong-token", "marker-symlink"])
def test_h2_workspace_invalid_ready_fails_closed(
    damage, h2_workspace_harness, h2_workspace_deadline,
):
    deadline = h2_workspace_deadline
    case = crash.prepare_case(h2_workspace_harness, deadline.body_deadline,
                              "workspace-invalid-" + damage, cleanup_controller=deadline)
    expected_codes = {}
    try:
        damaged_tree, outside = _damage_marker(case, damage)
        workspace = _workspace_row(case["harness"], case["job_id"])
        assert workspace[0] == "READY" and workspace[1] == case["workspace"]["workspace_generation"]
        process, _record, _barrier = _start_barrier(case, "after_claim_commit", deadline)
        final = _finish_dispatcher_cut(case, deadline, process, "quarantined", "quarantined",
                                       "WORKSPACE_IDENTITY_CONFLICT")
        assert final["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
        assert _workspace_row(case["harness"], case["job_id"])[0:2] == workspace[0:2]
        _assert_workspace_tree_unchanged(case, damaged_tree, outside)
        expected_codes[process.pid] = 3
        normal._write_private(case["root"] / "workspace-invalid-ready.json",
            normal._canonical({"damage": damage, "workspace_state": workspace[0],
                              "attempts": final["attempts"], "workflow_runs": 0,
                              "damaged_tree_unchanged": True}) + b"\n")
    finally:
        _close_case(deadline, case, expected_codes)


def test_h2_workspace_stale_generation_claim_is_fenced(
    h2_workspace_harness, h2_workspace_deadline,
):
    deadline = h2_workspace_deadline
    case = crash.prepare_case(h2_workspace_harness, deadline.body_deadline,
                              "workspace-stale-generation-claim", cleanup_controller=deadline)
    expected_codes = {}
    try:
        root = Path(case["harness"]["workspace_root"])
        tree_before = tree_fingerprint(root)
        token_before = case["workspace"]["workspace_token"]
        process, _record, barrier = _start_barrier(case, "after_claim_commit", deadline)
        claimed = normal._read_owner_snapshot(case["harness"], case["job_id"])
        _assert_draft_without_binding(case, claimed)
        assert claimed["accepted"][15] == "leased"
        assert claimed["accepted"][16] == 1
        assert claimed["accepted"][17] is not None
        workspace_claimed = _workspace_row(case["harness"], case["job_id"])
        assert workspace_claimed[0:3] == ("READY", 1, token_before)
        g5_result = _set_g5_error_then_reconcile(case)
        workspace_recovered = _workspace_row(case["harness"], case["job_id"])
        assert g5_result["status"] == "ready"
        assert workspace_recovered[0:3] == ("READY", 2, token_before)
        assert tree_fingerprint(root) == tree_before
        with bounded_connect(owner_dsn(case["harness"]["database"])) as owner:
            lease_live = owner.execute(
                "SELECT claim_expires_at>clock_timestamp() FROM ifpmic.commands_outbox WHERE command_id=%s",
                (case["group"][18],),
            ).fetchone()[0]
        assert lease_live
        barrier.release()
        exit_code = _wait_process(process, deadline)
        assert exit_code == 3
        assert json.loads(case["records"][-1]["stdout"].read_bytes()) == {"status": "quarantined"}
        final = normal._read_owner_snapshot(case["harness"], case["job_id"])
        _assert_draft_without_binding(case, final)
        _assert_delivery_attempt(final, "quarantined", "WORKSPACE_IDENTITY_CONFLICT")
        assert final["accepted"][15] == "quarantined"
        assert _workspace_row(case["harness"], case["job_id"])[0:2] == ("READY", 2)
        _no_runs(case)
        expected_codes[process.pid] = 3
        normal._write_private(case["root"] / "workspace-generation-fenced.json",
            normal._canonical({"claimed_generation": 1, "current_generation": 2,
                              "token_unchanged": True, "attempts": final["attempts"],
                              "workflow_runs": 0, "workspace_tree_unchanged": True}) + b"\n")
    finally:
        _close_case(deadline, case, expected_codes)


@pytest.mark.parametrize("state", ["RESERVED", "PROVISIONING", "ERROR"],
                         ids=["state-reserved", "state-provisioning", "state-error"])
def test_h2_workspace_nonready_blocks_admitted_worker(
    state, h2_workspace_harness, h2_workspace_deadline,
):
    deadline = h2_workspace_deadline
    case = crash.prepare_case(h2_workspace_harness, deadline.body_deadline,
                              "workspace-worker-nonready-" + state.lower(), cleanup_controller=deadline)
    expected_codes = {}
    try:
        dispatcher, _record, barrier = _start_barrier(case, "after_run_admitted", deadline)
        admitted = normal._read_owner_snapshot(case["harness"], case["job_id"])
        assert admitted["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
        assert len(admitted["bindings"]) == len(admitted["scopes"]) == 1
        assert admitted["receipts"] == [] and admitted["bindings"][0][20] == "admitted"
        run_id = admitted["bindings"][0][19]
        workspace = _set_workspace_state(case["harness"], case["job_id"], state)
        assert workspace[0] == state
        barrier.release()
        assert _wait_process(dispatcher, deadline) == 0
        expected_codes[dispatcher.pid] = 0
        worker, _worker_record = _start_cli(case, "worker")
        events, read_result = _wait_for_read_wait(
            case, run_id, min(deadline.body_deadline, time.monotonic() + 30))
        scheduled = _activity_types(events)
        assert sum(1 for event in events if event.HasField(
            "workflow_execution_started_event_attributes")) == 1
        assert not any(name == "ifpmic.h2.project_activation" for name in scheduled.values())
        assert any(name == "ifpmic.h2.read_activation" for name in scheduled.values())
        assert read_result == {"status": "wait", "code": "DEPENDENCY_UNAVAILABLE"}
        history_bytes = b"".join(
            len(raw).to_bytes(8, "big") + raw
            for raw in (event.SerializeToString(deterministic=True) for event in events)
        )
        normal._write_private(case["root"] / "workspace-worker-history.pbseq", history_bytes)
        final = normal._read_owner_snapshot(case["harness"], case["job_id"])
        assert final["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
        assert len(final["bindings"]) == len(final["scopes"]) == 1
        assert final["bindings"][0][19] == run_id and final["bindings"][0][20] == "admitted"
        assert final["receipts"] == [] and final["attempts"] == [(1, "started", run_id, None, True)]
        assert _workspace_row(case["harness"], case["job_id"])[0] == state
        normal._write_private(case["root"] / "workspace-worker-wait.json",
            normal._canonical({"state": state, "run_id": run_id,
                              "read_result": read_result, "project_activation_scheduled": False,
                              "receipt_count": 0, "revision": final["accepted"][4]}) + b"\n")
    finally:
        _close_case(deadline, case, expected_codes)
