"""Real dispatcher process cuts at authenticated production hook boundaries."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time

import psycopg
import pytest

from tests.ifpmic_api import h2_dispatcher_crash_support as crash
from tests.ifpmic_api import test_accepted_start_response_loss as accepted_start
from tests.ifpmic_api import test_h2_runtime_normal_flow as normal
from tests.ifpmic_api.jobs_fixture import owner_dsn

pytest_plugins = (
    "tests.ifpmic_api.jobs_fixture",
    "tests.ifpmic_api.workspace_fixture",
    "tests.ifpmic_api.workflow_schema_fixture",
)


def _claim(snapshot):
    accepted = snapshot["accepted"]
    assert accepted is not None and accepted[15] == "leased"
    assert type(accepted[16]) is int and accepted[16] >= 1
    assert type(accepted[17]) is str and len(accepted[17]) == 36
    return {"generation": accepted[16], "token": accepted[17]}


def _expected_start(case, snapshot):
    binding = snapshot["bindings"]
    assert len(binding) == 1
    return {"protocol_version": normal.PROTOCOL_VERSION,
            "job_id": case["job_id"], "project_id": case["harness"]["project_id"],
            "binding_sha256": binding[0][18]}


def _observe_start(case, snapshot, deadline):
    return asyncio.run(accepted_start._observe_started_direct(
        case["identity"]["server_endpoint"], case["identity"]["namespace"],
        "ifpmic.job." + case["job_id"], _expected_start(case, snapshot),
        "ifpmic.build." + case["identity"]["build_id"], deadline,
        case["root"],
    ))


def _assert_crash_final(
    case, deadline, expected_run_id=None, *, expected_attempts=None, start_worker=True,
):
    harness = case["harness"]
    job_id = case["job_id"]
    processes = case["processes"]
    if start_worker:
        worker, record = normal._spawn_runtime_cli("worker", case["worker_config"], case["root"])
        processes.append(worker)
        case["records"].append(record)
        normal._append_private_journal(case["journal"], {"event": "started", **record})
    else:
        worker = next((item for item, record in zip(processes, case["records"])
                       if record["role"] == "worker"), None)
        assert worker is not None
    active = [process for process in processes if process.poll() is None]
    def attempts_for(run):
        if expected_attempts is None:
            return [(1, "started", run, None, True)]
        if callable(expected_attempts):
            return expected_attempts(run)
        return expected_attempts

    final_snapshot = None
    while time.monotonic() < deadline:
        if any(process.poll() is not None for process in active):
            raise AssertionError("owned runtime CLI exited before crash recovery completed")
        candidate = normal._read_owner_snapshot(harness, job_id)
        if candidate["accepted"] and candidate["accepted"][12] == "rejected":
            raise AssertionError("create command reached rejected terminal state")
        if candidate["bindings"] and candidate["bindings"][0][20] == "quarantined":
            raise AssertionError("execution binding was quarantined")
        candidate_binding = candidate["bindings"]
        if candidate_binding and candidate_binding[0][19] is not None:
            candidate_run = candidate_binding[0][19]
            wanted_attempts = attempts_for(candidate_run)
            if (candidate["accepted"] and candidate["accepted"][3] == "QUEUED"
                    and candidate_binding[0][20] == "admitted"
                    and candidate["accepted"][15] == "dispatched"
                    and candidate["accepted"][16] == wanted_attempts[-1][0]
                    and candidate["accepted"][18] == candidate_run
                    and len(candidate["scopes"]) == len(candidate["receipts"]) == 1
                    and candidate["attempts"] == wanted_attempts):
                final_snapshot = candidate
                expected_attempts = wanted_attempts
                break
        time.sleep(min(0.1, max(0.0, deadline - time.monotonic())))
    if final_snapshot is None:
        raise TimeoutError("crash recovery did not reach its literal expected SQL state")
    binding = final_snapshot["bindings"][0]
    run_id = binding[19]
    assert run_id is not None and binding[20] == "admitted"
    if expected_run_id is not None:
        assert run_id == expected_run_id
    # Validate crash-state SQL directly. The frozen normal-flow oracle is
    # deliberately generation-1-only; manufacturing rows to reuse it would
    # erase the recovered generation/outbox evidence this suite must prove.
    rows = final_snapshot["accepted"]
    assert rows is not None
    assert rows[0:3] == case["group"][0:3]
    assert rows[1:8] == (harness["project_id"], harness["record"].snapshot_id,
                         "QUEUED", 1, 0, [], None)
    assert case["group"][4:9] == ("DRAFT", 0, 0, [], None)
    assert case["group"][14:17] == ("accepted", None, None)
    assert rows[8] == case["group"][18]
    assert rows[9] == "POST /api/v1/jobs"
    assert case["accepted"]["payload"] == {
        "project_id": harness["project_id"], "title": "G4 synthetic job",
        "request_text": "Validate isolated acceptance", "change_type": "FEATURE",
        "base_ref": "refs/heads/main", "input_artifact_ids": [],
        "profile_version": harness["profile_version"], "release_mode": "team_github_tag",
    }
    assert type(rows[10]) is str and json.loads(rows[10]) == case["accepted"]["payload"]
    assert rows[10] == normal._canonical(case["accepted"]["payload"]).decode("ascii")
    assert rows[10] == case["group"][12]
    payload_sha = hashlib.sha256(normal._canonical({
        "format": "ifpmic.create-job.v1", "payload": case["accepted"]["payload"],
    })).hexdigest()
    assert rows[11] == payload_sha
    assert rows[11] == case["group"][13]
    assert rows[12:15] == ("applied", 1, None)
    assert rows[15:17] == ("dispatched", expected_attempts[-1][0])
    assert rows[18] == run_id
    assert rows[19:23] == (case["group"][18], case["workspace"]["workspace_token"], "READY", 1)
    assert final_snapshot["noncreate_commands"] == 0
    assert final_snapshot["attempts"] == expected_attempts
    expected_binding = normal._expected_binding(
        job_id, rows, case["workspace"], case["identity"], harness["record"], payload_sha,
    )
    assert len(final_snapshot["bindings"]) == 1
    binding = final_snapshot["bindings"][0]
    binding_fields = (
        "job_id", "project_id", "create_command_id", "deployment_id", "namespace",
        "server_config_sha256", "temporal_workflow_id", "workflow_type", "build_id", "task_queue",
        "snapshot_id", "catalog_record_sha256", "workflow_sha256", "state_sha256", "agent_sha256",
        "workspace_token", "workspace_generation", "command_payload_sha256", "binding_sha256",
    )
    actual_binding = dict(zip(binding_fields, binding[:19]))
    assert set(actual_binding) == set(expected_binding)
    for field in binding_fields:
        assert type(actual_binding[field]) is type(expected_binding[field])
        assert actual_binding[field] == expected_binding[field]
    assert binding[19:21] == (run_id, "admitted")
    assert binding[21] is not None and binding[22] > binding[21]
    assert binding[23] > 3600 and binding[24] is True and binding[25] is True
    assert binding[26] is None
    assert final_snapshot["scopes"] == [(
        job_id, run_id, case["roles"]["projector"], harness["database"][0].roles.projector,
        case["identity"]["deployment_id"], case["identity"]["build_id"],
    )]
    assert len(final_snapshot["receipts"]) == 1
    receipt = final_snapshot["receipts"][0]
    proposal = {
        "protocol_version": normal.PROTOCOL_VERSION, "kind": "activate_create", "job_id": job_id,
        "run_id": run_id, "build_id": case["identity"]["build_id"],
        "binding_sha256": expected_binding["binding_sha256"], "transition_sequence": 1,
        "expected_revision": 0, "command_id": rows[8], "command_payload_sha256": payload_sha,
    }
    proposal_sha = normal._domain_hash("ifpmic.b03.transition.v1", proposal)
    assert receipt == (job_id, 1, rows[8], run_id, case["identity"]["build_id"], proposal_sha,
                       0, "applied", {
                           "status": "applied", "command_id": rows[8], "applied_revision": 1,
                           "error_code": None, "job_id": job_id,
                           "job_status": "QUEUED", "revision": 1,
                       })
    temporal = normal._observe_temporal(
        case["identity"], job_id, harness["project_id"], run_id,
        {"protocol_version": normal.PROTOCOL_VERSION, "job_id": job_id,
         "project_id": harness["project_id"], "binding_sha256": binding[18]},
        deadline, normal._private_dir(case["root"] / "history-after-projection"),
    )
    assert temporal["workflow_id"] == "ifpmic.job." + job_id
    assert temporal["run_id"] == run_id
    assert temporal["execution_count"] == temporal["started_event_count"] == 1
    assert temporal["phase"] == "queued"
    assert temporal["started_input"] == [{
        "protocol_version": normal.PROTOCOL_VERSION, "job_id": job_id,
        "project_id": harness["project_id"], "binding_sha256": expected_binding["binding_sha256"],
    }]
    assert temporal["project_id"] == harness["project_id"]
    assert temporal["observed_retention_seconds"] == binding[23]
    assert normal.tree_fingerprint(Path(harness["workspace_root"]) / job_id) == case["tree_before"]
    assert (case["temporal_store"].stat().st_dev, case["temporal_store"].stat().st_ino) == case["temporal_store_identity"]
    evidence = {"case_id": case["case_name"], "status": "passed",
                "snapshot_sha256": hashlib.sha256(
                    normal._canonical(final_snapshot)).hexdigest(),
                "expected_generation": expected_attempts[-1][0],
                "proposal_sha256": proposal_sha,
                "temporal_history_sha256": temporal["raw_history_sha256"],
                "temporal_run_id": temporal["run_id"], "worker_pid": worker.pid}
    normal._write_private(case["root"] / "case-result.json", normal._canonical(evidence) + b"\n")
    return final_snapshot, temporal, worker


def _kill_cut(case, deadline, phase):
    process, record, barrier = crash.start_barrier_dispatcher(case, phase)
    barrier.wait(min(30, deadline - time.monotonic()))
    before_kill = normal._read_owner_snapshot(case["harness"], case["job_id"])
    cut = crash.kill_at_barrier(case, process, record, barrier, 1)
    case["expected_killed"] = [process]
    normal._write_private(case["root"] / "owner-at-cut.json",
                          normal._canonical(before_kill) + b"\n")
    return process, before_kill, cut


def _recover_dispatcher(case, deadline):
    process, record = normal._spawn_runtime_cli("dispatcher-recovery", case["dispatcher_config"], case["root"])
    case["processes"].append(process)
    case["records"].append(record)
    normal._append_private_journal(case["journal"], {"event": "started", **record})
    return process


def _cleanup(case, deadline):
    with deadline.cleanup_budget():
        crash.cleanup_case(case, case.get("expected_killed", ()),
                           case.get("expected_exit_codes", {}))


def test_claim_commit_crash_reclaims_only_after_expiry(
    workflow_scram_hba, workspace_environment, h2_crash_case_deadline,
):
    deadline = h2_crash_case_deadline
    case = crash.prepare_case(workspace_environment, deadline.body_deadline, "dispatcher-claim-commit")
    case["case_name"] = "test_claim_commit_crash_reclaims_only_after_expiry"
    try:
        child, snapshot, _cut = _kill_cut(case, deadline.body_deadline, "after_claim_commit")
        assert snapshot["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
        claim = _claim(snapshot)
        assert claim["generation"] == 1
        assert snapshot["bindings"] == snapshot["scopes"] == snapshot["receipts"] == []
        assert snapshot["attempts"] == [] and snapshot["noncreate_commands"] == 0
        assert accepted_start._fresh_clock_claim_state(case["harness"], case["group"][18]) == (
            "leased", 1, claim["token"], False)
        # Independently verify that claiming alone did not create a workflow.
        runs = asyncio.run(accepted_start._list_workflow_runs(
            case["identity"]["server_endpoint"], case["identity"]["namespace"],
            "ifpmic.job." + case["job_id"], deadline.body_deadline))
        assert runs == []
        expired = crash.wait_claim_expired(case, claim, min(30, deadline.remaining(30)))
        assert expired[:3] == ("leased", 1, claim["token"]) and expired[3] is True
        _recover_dispatcher(case, deadline.body_deadline)
        final, temporal, _worker = _assert_crash_final(
            case, deadline.body_deadline,
            expected_attempts=lambda run: [(1, "expired", None, None, True),
                                           (2, "started", run, None, True)])
        assert final["accepted"][16] == 2
        assert final["attempts"] == [(1, "expired", None, None, True),
                                    (2, "started", temporal["run_id"], None, True)]
        assert temporal["execution_count"] == temporal["started_event_count"] == 1
    finally:
        _cleanup(case, deadline)


def test_start_response_before_admission_crash_recovers_same_run(
    workflow_scram_hba, workspace_environment, h2_crash_case_deadline,
):
    deadline = h2_crash_case_deadline
    case = crash.prepare_case(workspace_environment, deadline.body_deadline, "dispatcher-response-before-admission")
    case["case_name"] = "test_start_response_before_admission_crash_recovers_same_run"
    try:
        child, cut_snapshot, _cut = _kill_cut(case, deadline.body_deadline, "after_start_response")
        claim = _claim(cut_snapshot)
        assert claim["generation"] == 1
        assert len(cut_snapshot["bindings"]) == 1
        assert cut_snapshot["bindings"][0][19:21] == (None, "reserved")
        assert cut_snapshot["scopes"] == cut_snapshot["receipts"] == []
        assert cut_snapshot["attempts"] == [(1, None, None, None, False)]
        started = _observe_start(case, cut_snapshot, deadline.body_deadline)
        assert started["execution_count"] == started["started_event_count"] == 1
        after_observation = normal._read_owner_snapshot(case["harness"], case["job_id"])
        assert after_observation == cut_snapshot
        crash.wait_claim_expired(case, claim, min(30, deadline.remaining(30)))
        _recover_dispatcher(case, deadline.body_deadline)
        final, temporal, _worker = _assert_crash_final(
            case, deadline.body_deadline, started["run_id"],
            expected_attempts=[(1, "expired", None, None, True),
                               (2, "started", started["run_id"], None, True)])
        assert final["accepted"][16] == 2
        assert final["attempts"] == [(1, "expired", None, None, True),
                                    (2, "started", started["run_id"], None, True)]
        assert temporal["execution_count"] == temporal["started_event_count"] == 1
    finally:
        _cleanup(case, deadline)


def test_admission_before_ack_crash_recovers_same_run(
    workflow_scram_hba, workspace_environment, h2_crash_case_deadline,
):
    deadline = h2_crash_case_deadline
    case = crash.prepare_case(workspace_environment, deadline.body_deadline, "dispatcher-admitted-before-ack")
    case["case_name"] = "test_admission_before_ack_crash_recovers_same_run"
    try:
        _child, cut_snapshot, _cut = _kill_cut(case, deadline.body_deadline, "after_run_admitted")
        claim = _claim(cut_snapshot)
        assert claim["generation"] == 1
        assert len(cut_snapshot["bindings"]) == len(cut_snapshot["scopes"]) == 1
        run_id = cut_snapshot["bindings"][0][19]
        assert run_id and cut_snapshot["bindings"][0][20] == "admitted"
        assert cut_snapshot["scopes"][0][1] == run_id
        assert cut_snapshot["receipts"] == []
        started = _observe_start(case, cut_snapshot, deadline.body_deadline)
        assert started["run_id"] == run_id
        assert normal._read_owner_snapshot(case["harness"], case["job_id"]) == cut_snapshot
        crash.wait_claim_expired(case, claim, min(30, deadline.remaining(30)))
        _recover_dispatcher(case, deadline.body_deadline)
        final, temporal, _worker = _assert_crash_final(
            case, deadline.body_deadline, run_id,
            expected_attempts=[(1, "expired", None, None, True),
                               (2, "started", run_id, None, True)])
        assert final["accepted"][16] == 2
        assert final["attempts"] == [(1, "expired", None, None, True),
                                    (2, "started", run_id, None, True)]
        assert temporal["execution_count"] == temporal["started_event_count"] == 1
    finally:
        _cleanup(case, deadline)


def test_ack_before_worker_activation_projects_once(
    workflow_scram_hba, workspace_environment, h2_crash_case_deadline,
):
    deadline = h2_crash_case_deadline
    case = crash.prepare_case(workspace_environment, deadline.body_deadline, "dispatcher-ack-before-worker")
    case["case_name"] = "test_ack_before_worker_activation_projects_once"
    try:
        _child, cut_snapshot, _cut = _kill_cut(case, deadline.body_deadline, "after_delivery_ack")
        assert cut_snapshot["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
        assert cut_snapshot["accepted"][12:17] == ("accepted", None, None, "dispatched", 1)
        assert len(cut_snapshot["bindings"]) == len(cut_snapshot["scopes"]) == 1
        run_id = cut_snapshot["bindings"][0][19]
        assert run_id and cut_snapshot["bindings"][0][20] == "admitted"
        assert cut_snapshot["scopes"][0][1] == run_id
        assert cut_snapshot["receipts"] == []
        assert cut_snapshot["attempts"] == [(1, "started", run_id, None, True)]
        temporal_started = _observe_start(case, cut_snapshot, deadline.body_deadline)
        assert temporal_started["run_id"] == run_id
        final, temporal, _worker = _assert_crash_final(
            case, deadline.body_deadline, run_id,
            expected_attempts=[(1, "started", run_id, None, True)])
        assert final["accepted"][16] == 1
        assert final["attempts"] == [(1, "started", run_id, None, True)]
        assert temporal["execution_count"] == temporal["started_event_count"] == 1
    finally:
        _cleanup(case, deadline)


def test_two_live_dispatchers_stale_ack_cannot_change_recovered_run(
    workflow_scram_hba, workspace_environment, h2_crash_case_deadline,
):
    """The old generation's actual production ack is stale after a live reclaim."""
    deadline = h2_crash_case_deadline
    case = crash.prepare_case(workspace_environment, deadline.body_deadline, "dispatcher-two-live-stale-ack")
    case["case_name"] = "test_two_live_dispatchers_stale_ack_cannot_change_recovered_run"
    try:
        first, pre_ack, barrier = crash.start_barrier_dispatcher(case, "after_run_admitted")
        barrier.wait(min(30, deadline.remaining(30)))
        pre_ack = normal._read_owner_snapshot(case["harness"], case["job_id"])
        claim = _claim(pre_ack)
        assert claim["generation"] == 1 and len(pre_ack["bindings"]) == 1
        run_id = pre_ack["bindings"][0][19]
        assert run_id and pre_ack["bindings"][0][20] == "admitted"
        assert len(pre_ack["scopes"]) == 1 and pre_ack["scopes"][0][1] == run_id
        observed = _observe_start(case, pre_ack, deadline.body_deadline)
        assert observed["run_id"] == run_id
        crash.wait_claim_expired(case, claim, min(30, deadline.remaining(30)))
        second = _recover_dispatcher(case, deadline.body_deadline)
        recovered = accepted_start._await_admitted_run(
            case["harness"], case["job_id"], run_id, deadline.body_deadline)
        assert recovered["accepted"][16] == 2
        assert recovered["bindings"][0][19:21] == (run_id, "admitted")
        assert recovered["scopes"] == pre_ack["scopes"] and recovered["receipts"] == []
        assert first.poll() is None and normal.process_identity(first.pid) == first._ifpmic_start_ticks
        barrier.release()
        try:
            first.wait(timeout=min(5, deadline.remaining(5)))
        except subprocess.TimeoutExpired:
            raise AssertionError("stale generation acknowledgement did not return promptly")
        assert first.returncode == 3
        after_old_ack = normal._read_owner_snapshot(case["harness"], case["job_id"])
        assert after_old_ack == recovered
        assert second.poll() is None
        final, temporal, _worker = _assert_crash_final(
            case, deadline.body_deadline, run_id,
            expected_attempts=[(1, "expired", None, None, True),
                               (2, "started", run_id, None, True)])
        assert final["accepted"][16] == 2
        assert final["attempts"] == [(1, "expired", None, None, True),
                                    (2, "started", run_id, None, True)]
        assert temporal["execution_count"] == temporal["started_event_count"] == 1
        case["expected_killed"] = []
        case["expected_exit_codes"] = {first.pid: 3}
    finally:
        _cleanup(case, deadline)


def test_admitted_missing_history_is_quarantined_without_replacement(
    workflow_scram_hba, workspace_environment, h2_crash_case_deadline,
):
    """Delete only the exact synthetic admitted run before projection/ack."""
    deadline = h2_crash_case_deadline
    case = crash.prepare_case(workspace_environment, deadline.body_deadline, "dispatcher-admitted-history-deleted")
    case["case_name"] = "test_admitted_missing_history_is_quarantined_without_replacement"
    try:
        _child, before_delete, _cut = _kill_cut(case, deadline.body_deadline, "after_run_admitted")
        claim = _claim(before_delete)
        assert claim["generation"] == 1
        assert len(before_delete["bindings"]) == len(before_delete["scopes"]) == 1
        run_id = before_delete["bindings"][0][19]
        assert run_id and before_delete["bindings"][0][20] == "admitted"
        assert before_delete["scopes"][0][1] == run_id
        assert before_delete["receipts"] == []
        observed = _observe_start(case, before_delete, deadline.body_deadline)
        assert observed["run_id"] == run_id and observed["execution_count"] == 1
        assert normal._read_owner_snapshot(case["harness"], case["job_id"]) == before_delete

        # The pinned Temporal SDK has no high-level delete convenience method.
        # Use its generated first-party WorkflowService RPC with both synthetic
        # execution identifiers. Deletion is asynchronous; require exact raw
        # history lookup to return NOT_FOUND before allowing dispatcher recovery.
        from datetime import timedelta
        from temporalio.api.common.v1 import WorkflowExecution
        from temporalio.api.workflowservice.v1 import (
            DeleteWorkflowExecutionRequest, GetWorkflowExecutionHistoryRequest,
        )
        from temporalio.service import RPCError, RPCStatusCode
        from temporalio.client import Client

        async def delete_exact_run_and_confirm():
            client = await Client.connect(case["identity"]["server_endpoint"],
                                          namespace=case["identity"]["namespace"])
            request = DeleteWorkflowExecutionRequest(
                namespace=case["identity"]["namespace"],
                workflow_execution=WorkflowExecution(
                    workflow_id="ifpmic.job." + case["job_id"], run_id=run_id))
            await client.workflow_service.delete_workflow_execution(
                request, timeout=timedelta(seconds=10))
            exact = GetWorkflowExecutionHistoryRequest(
                namespace=case["identity"]["namespace"],
                execution=WorkflowExecution(
                    workflow_id="ifpmic.job." + case["job_id"], run_id=run_id))
            while time.monotonic() < deadline.body_deadline:
                try:
                    await client.workflow_service.get_workflow_execution_history(
                        exact, timeout=timedelta(seconds=5))
                except RPCError as error:
                    if error.status == RPCStatusCode.NOT_FOUND:
                        return {"workflow_id": "ifpmic.job." + case["job_id"],
                                "run_id": run_id, "rpc": "DeleteWorkflowExecution",
                                "confirmed": "GetWorkflowExecutionHistory/NOT_FOUND"}
                    raise
                await asyncio.sleep(0.1)
            raise TimeoutError("Temporal did not finish deleting the exact admitted run")

        delete_evidence = asyncio.run(delete_exact_run_and_confirm())
        normal._write_private(case["root"] / "exact-owned-history-deletion.json",
                              normal._canonical(delete_evidence) + b"\n")
        claim_state = accepted_start._fresh_clock_claim_state(case["harness"], case["group"][18])
        assert claim_state == ("leased", 1, claim["token"], False)
        crash.wait_claim_expired(case, claim, min(30, deadline.remaining(30)))
        _recover_dispatcher(case, deadline.body_deadline)

        quarantined = None
        while time.monotonic() < deadline.body_deadline:
            quarantined = normal._read_owner_snapshot(case["harness"], case["job_id"])
            binding = quarantined["bindings"]
            if binding and binding[0][20] == "quarantined" and binding[0][26] == "HISTORY_MISSING":
                break
            time.sleep(0.1)
        assert quarantined is not None
        assert quarantined["bindings"][0][19] == run_id
        assert quarantined["bindings"][0][20] == "quarantined"
        assert quarantined["bindings"][0][26] == "HISTORY_MISSING"
        assert quarantined["scopes"] == before_delete["scopes"]
        assert quarantined["receipts"] == []
        assert quarantined["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
        assert quarantined["accepted"][12:15] == ("accepted", None, None)
        assert quarantined["accepted"][15] == "quarantined"
        assert quarantined["accepted"][16] == 2
        assert quarantined["attempts"] == [
            (1, "expired", None, None, True),
            (2, "quarantined", None, "HISTORY_MISSING", True),
        ]
        # Ensure no new execution was started after the exact original run's
        # history disappeared; lookup by logical workflow must remain empty.
        assert asyncio.run(accepted_start._list_workflow_runs(
            case["identity"]["server_endpoint"], case["identity"]["namespace"],
            "ifpmic.job." + case["job_id"], deadline.body_deadline)) == []
        normal._write_private(case["root"] / "owner-after-history-missing-quarantine.json",
                              normal._canonical(quarantined) + b"\n")
    finally:
        _cleanup(case, deadline)
