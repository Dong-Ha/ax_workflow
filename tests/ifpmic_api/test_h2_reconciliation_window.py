"""NEG-WINDOW boundary cases; authored only, not runtime-qualified."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from pathlib import Path
import time
from uuid import uuid4

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

_CLOCK_ASSIGNMENT = "instant:=clock_timestamp();"
_FROZEN_ASSIGNMENT_PREFIX = "instant:=TIMESTAMPTZ '"
_FUNCTION_IDENTITY = "ifpmic.record_start_attempt(uuid,bigint,uuid,bigint)"


def _case_name(node_id: str) -> str:
    return "neg-window-" + node_id.rsplit("::", 1)[-1].replace("[", "-").replace("]", "")


def _prepare_sql_case(harness, case_name: str):
    """Prepare a real accepted command and reservation without a Temporal service."""
    accepted = normal.accept_workspace_job(harness, key=case_name)
    job_id = accepted["job_id"]
    group = normal.workspace_rows(harness, job_id)
    assert group is not None
    workspace, _tree = normal._workspace_ready(
        harness, Path(harness["workspace_root"]), job_id,
    )
    normal._add_live_sql_eligibility(harness, job_id)
    root = normal._private_dir(normal._runtime_evidence_root() / case_name)
    source_value = normal.source_manifest()
    environment_value = normal.environment_manifest()
    source_sha = normal._manifest_hash(source_value)
    environment_sha = normal._manifest_hash(environment_value)
    normal._write_private(root / "source-manifest.json", normal._canonical(source_value) + b"\n")
    normal._write_private(root / "environment-manifest.json",
                          normal._canonical(environment_value) + b"\n")
    deployment_id = "h2-neg-window-" + uuid4().hex
    deployment_document = {
        "protocol_version": normal.PROTOCOL_VERSION,
        "deployment_id": deployment_id,
        "namespace": normal.NAMESPACE,
        "server_endpoint": "127.0.0.1:7233",
    }
    server_sha = normal._domain_hash("ifpmic.b03.deployment.v1", deployment_document)
    build_document = {
        "protocol_version": normal.PROTOCOL_VERSION,
        "source_manifest_sha256": source_sha,
        "environment_manifest_sha256": environment_sha,
        "workflow_type": normal.WORKFLOW_TYPE,
    }
    build_id = normal._domain_hash("ifpmic.b03.build.v1", build_document)
    identity = {
        "deployment_id": deployment_id,
        "namespace": normal.NAMESPACE,
        "server_endpoint": deployment_document["server_endpoint"],
        "server_config_sha256": server_sha,
        "build_id": build_id,
        "source_manifest_sha256": source_sha,
        "environment_manifest_sha256": environment_sha,
    }
    normal._register_identity(harness, identity)
    return {"harness": harness, "accepted": accepted, "job_id": job_id,
            "group": group, "workspace": workspace, "identity": identity,
            "root": root}


def _claim_and_reserve(case):
    harness = case["harness"]
    command_id = case["group"][18]
    workspace = case["workspace"]
    with psycopg.connect(normal._private_dsn(harness["database"], "dispatcher"), autocommit=True) as dispatcher:
        claim = dispatcher.execute(
            "SELECT ifpmic.claim_delivery(%s)", (command_id,),
        ).fetchone()[0]
        assert claim["status"] == "claimed" and str(claim["command_id"]) == command_id
        generation = claim["generation"]
        token = str(claim["claim_token"])
        assert type(generation) is int and generation >= 1
        assert len(token) == 36
        reserved = dispatcher.execute(
            "SELECT ifpmic.reserve_execution(%s,%s,%s,%s,%s,%s)",
            (command_id, generation, token, case["identity"]["build_id"],
             workspace["workspace_token"], workspace["workspace_generation"]),
        ).fetchone()[0]
    assert reserved["status"] == "reserved"
    assert reserved["binding"]["state"] == "reserved"
    assert reserved["binding"]["first_start_attempt_at"] is None
    assert reserved["binding"]["uncertain_until"] is None
    assert reserved["binding"]["observed_retention_seconds"] is None
    return {"command_id": command_id, "generation": generation, "token": token,
            "claim": claim, "binding": reserved["binding"]}


def _owner_window(case, first_start, uncertain_until, retention=3601):
    with psycopg.connect(owner_dsn(case["harness"]["database"])) as owner:
        before = owner.execute(
            "SELECT first_start_attempt_at,uncertain_until,observed_retention_seconds "
            "FROM ifpmic.execution_bindings WHERE job_id=%s", (case["job_id"],),
        ).fetchone()
        assert before == (None, None, None)
        updated = owner.execute(
            "UPDATE ifpmic.execution_bindings SET first_start_attempt_at=%s,uncertain_until=%s,"
            "observed_retention_seconds=%s WHERE job_id=%s "
            "RETURNING first_start_attempt_at,uncertain_until,observed_retention_seconds",
            (first_start, uncertain_until, retention, case["job_id"]),
        ).fetchone()
        assert updated == (first_start, uncertain_until, retention)
        assert updated[1] - updated[0] <= timedelta(hours=1)
    return updated


def _owner_window_snapshot(case):
    with psycopg.connect(owner_dsn(case["harness"]["database"])) as owner:
        return owner.execute(
            "SELECT first_start_attempt_at,uncertain_until,observed_retention_seconds "
            "FROM ifpmic.execution_bindings WHERE job_id=%s", (case["job_id"],),
        ).fetchone()


def _iso_window_seed(seed):
    """Serialize real SQL timestamps explicitly; keep unexpected types visible."""
    first_start, uncertain_until, retention = seed
    assert isinstance(first_start, datetime) and isinstance(uncertain_until, datetime)
    assert type(retention) is int
    return {
        "first_start_attempt_at": first_start.isoformat(timespec="microseconds"),
        "uncertain_until": uncertain_until.isoformat(timespec="microseconds"),
        "observed_retention_seconds": retention,
    }


def _write_private_json(case, filename: str, value):
    normal._write_private(case["root"] / filename, normal._canonical(value) + b"\n")


def _read_function_snapshot(owner):
    row = owner.execute(
        "SELECT p.oid::bigint,p.proowner::bigint,r.rolname,p.proacl,p.prosecdef,p.proconfig,"
        "pg_get_functiondef(p.oid) "
        "FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
        "JOIN pg_roles r ON r.oid=p.proowner "
        "WHERE p.oid=%s::regprocedure",
        (_FUNCTION_IDENTITY,),
    ).fetchone()
    assert row is not None
    return {
        "oid": row[0], "owner_oid": row[1], "owner_name": row[2],
        "acl": None if row[3] is None else list(row[3]),
        "security_definer": row[4],
        "proconfig": None if row[5] is None else list(row[5]),
        "definition": row[6],
    }


def _assert_function_metadata_unchanged(before, current):
    for field in ("oid", "owner_oid", "owner_name", "acl", "security_definer", "proconfig"):
        assert current[field] == before[field], "record_start_attempt metadata changed: " + field
    assert current["security_definer"] is True
    assert current["owner_name"]
    assert current["proconfig"] is not None
    assert any(value.startswith("search_path=") for value in current["proconfig"])


def _claim_live_at_frozen_instant(case, claim, instant):
    with psycopg.connect(owner_dsn(case["harness"]["database"])) as owner:
        row = owner.execute(
            "SELECT state,generation,claim_token::text,claim_expires_at>%s,claim_expires_at "
            "FROM ifpmic.commands_outbox WHERE command_id=%s",
            (instant, claim["command_id"]),
        ).fetchone()
    assert row is not None
    assert row[:4] == ("leased", claim["generation"], claim["token"], True)
    return row[4]


def _invoke_record_attempt(case, claim, retention):
    with psycopg.connect(normal._private_dsn(case["harness"]["database"], "dispatcher"),
                         autocommit=True) as dispatcher:
        session_user = dispatcher.execute("SELECT session_user").fetchone()[0]
        expected_user = case["harness"]["database"][0].roles.dispatcher
        assert session_user == expected_user
        return dispatcher.execute(
            "SELECT ifpmic.record_start_attempt(%s,%s,%s,%s)",
            (claim["command_id"], claim["generation"], claim["token"], retention),
        ).fetchone()[0]


def _wait_old_lease_expiry(case, claim, deadline):
    while time.monotonic() < deadline:
        with psycopg.connect(owner_dsn(case["harness"]["database"])) as owner:
            row = owner.execute(
                "SELECT state,generation,claim_token::text,claim_expires_at<=clock_timestamp() "
                "FROM ifpmic.commands_outbox WHERE command_id=%s", (claim["command_id"],),
            ).fetchone()
        assert row is not None and row[:3] == ("leased", claim["generation"], claim["token"])
        if row[3]:
            return
        time.sleep(min(0.1, max(0.0, deadline - time.monotonic())))
    raise TimeoutError("NEG-WINDOW fixture claim did not expire before the bounded deadline")


def _wait_runtime_outcome(case, desired_state, deadline, process):
    while time.monotonic() < deadline:
        assert process.poll() is None, "production dispatcher exited before SQL outcome"
        snapshot = normal._read_owner_snapshot(case["harness"], case["job_id"])
        accepted = snapshot["accepted"]
        binding = snapshot["bindings"]
        target_outbox = "quarantined" if desired_state == "quarantined" else "dispatched"
        if binding and accepted is not None:
            if binding[0][20] == desired_state and accepted[15] == target_outbox:
                return snapshot
        if accepted is not None and accepted[15] == "quarantined" and desired_state != "quarantined":
            raise AssertionError("dispatcher quarantined a window expected to be live")
        time.sleep(min(0.1, max(0.0, deadline - time.monotonic())))
    raise TimeoutError("production dispatcher did not reach the expected NEG-WINDOW state")


def _ordered_attempts(snapshot):
    rows = snapshot["attempts"]
    generations = [row[0] for row in rows]
    assert len(generations) == len(set(generations)), "duplicate attempt generation in owner snapshot"
    return sorted(rows, key=lambda row: row[0])


@pytest.mark.parametrize(
    ("retention", "expected"),
    [(None, "RETENTION_UNVERIFIED"), (3600, "RETENTION_UNVERIFIED"), (3601, "permitted")],
    ids=["retention-null", "retention-3600", "retention-3601"],
)
def test_h2_window_retention(retention, expected, workflow_scram_hba,
                             workspace_environment, h2_window_case_deadline):
    deadline = h2_window_case_deadline
    name = _case_name("tests/ifpmic_api/test_h2_reconciliation_window.py::"
                      "test_h2_window_retention[retention-" +
                      ("null" if retention is None else str(retention)) + "]")
    case = _prepare_sql_case(workspace_environment, name)
    try:
        claim = _claim_and_reserve(case)
        before_cut = normal._read_owner_snapshot(case["harness"], case["job_id"])
        result = _invoke_record_attempt(case, claim, retention)
        snapshot = normal._read_owner_snapshot(case["harness"], case["job_id"])
        assert snapshot["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
        assert snapshot["scopes"] == [] and snapshot["receipts"] == []
        if expected == "RETENTION_UNVERIFIED":
            assert result == {"status": "quarantined", "code": "RETENTION_UNVERIFIED"}
            assert len(snapshot["bindings"]) == 1
            assert snapshot["bindings"][0][20] == "quarantined"
            assert snapshot["bindings"][0][26] == "RETENTION_UNVERIFIED"
            assert snapshot["bindings"][0][21:24] == (None, None, None)
            assert snapshot["accepted"][15] == "quarantined"
            assert snapshot["attempts"] == [(claim["generation"], "quarantined", None,
                                              "RETENTION_UNVERIFIED", True)]
        else:
            assert result["status"] == "permitted"
            binding = snapshot["bindings"][0]
            assert binding[20] == "reserved" and binding[21] is not None
            assert binding[23] == 3601 and binding[24] is True
            assert snapshot["accepted"][15] == "leased"
            assert snapshot["attempts"] == [(claim["generation"], None, None, None, False)]
        _write_private_json(case, "neg-window-retention.json", {
            "retention_seconds": retention,
            "result": result,
            "claim_generation": claim["generation"],
            "claim_token": claim["token"],
            "sql_before_cut": before_cut,
            "sql_after": snapshot,
        })
    finally:
        deadline.begin_cleanup()


def test_h2_window_partial_shape_constraint(workflow_scram_hba, workspace_environment,
                                           h2_window_case_deadline):
    deadline = h2_window_case_deadline
    case = _prepare_sql_case(workspace_environment, "neg-window-partial-shape-constraint")
    try:
        _claim_and_reserve(case)
        before_cut = normal._read_owner_snapshot(case["harness"], case["job_id"])
        partial_assignments = (
            "first_start_attempt_at=clock_timestamp()",
            "first_start_attempt_at=clock_timestamp(),"
            "uncertain_until=clock_timestamp()+interval '30 minutes'",
            "first_start_attempt_at=clock_timestamp(),observed_retention_seconds=3601",
            "uncertain_until=clock_timestamp()+interval '30 minutes'",
            "observed_retention_seconds=3601",
            "uncertain_until=clock_timestamp()+interval '30 minutes',observed_retention_seconds=3601",
        )
        with psycopg.connect(owner_dsn(case["harness"]["database"])) as owner:
            original = owner.execute(
                "SELECT first_start_attempt_at,uncertain_until,observed_retention_seconds "
                "FROM ifpmic.execution_bindings WHERE job_id=%s", (case["job_id"],),
            ).fetchone()
            assert original == (None, None, None)
            for assignment in partial_assignments:
                with pytest.raises(psycopg.errors.CheckViolation) as violation:
                    with owner.transaction():
                        owner.execute(
                            "UPDATE ifpmic.execution_bindings SET " + assignment + " WHERE job_id=%s",
                            (case["job_id"],),
                        )
                assert violation.value.diag.constraint_name == "binding_start_window_shape"
                assert owner.execute(
                    "SELECT first_start_attempt_at,uncertain_until,observed_retention_seconds "
                    "FROM ifpmic.execution_bindings WHERE job_id=%s", (case["job_id"],),
                ).fetchone() == original
        snapshot = normal._read_owner_snapshot(case["harness"], case["job_id"])
        assert snapshot["bindings"][0][21:24] == (None, None, None)
        assert snapshot["bindings"][0][20] == "reserved"
        _write_private_json(case, "neg-window-partial-shape.json", {
            "initial_window": original,
            "invalid_partial_assignments": list(partial_assignments),
            "sql_before_cut": before_cut,
            "sql_after": snapshot,
        })
    finally:
        deadline.begin_cleanup()


@pytest.mark.parametrize(
    ("boundary", "offset_seconds", "expected"),
    [("before-deadline", 1, "permitted"), ("at-deadline", 0, "START_WINDOW_EXPIRED"),
     ("after-deadline", -1, "START_WINDOW_EXPIRED")],
    ids=["before-deadline", "at-deadline", "after-deadline"],
)
def test_h2_window_exact_deadline_with_isolated_clock_seam(
    boundary, offset_seconds, expected, workflow_scram_hba, workspace_environment,
    h2_window_case_deadline,
):
    deadline = h2_window_case_deadline
    case = _prepare_sql_case(workspace_environment, "neg-window-clock-seam-" + boundary)
    original = None
    before = while_replaced = restored = None
    frozen_literal = changed = None
    sql_before_call = None
    claim = before_cut = None
    result_for_evidence = snapshot_for_evidence = None
    claim_live_expiry = None
    primary_error_type = restoration_error = evidence_error = None
    try:
        claim = _claim_and_reserve(case)
        before_cut = normal._read_owner_snapshot(case["harness"], case["job_id"])
        with psycopg.connect(owner_dsn(case["harness"]["database"]), autocommit=True) as owner:
            before = _read_function_snapshot(owner)
            original = before["definition"]
            assert before["owner_name"] == case["harness"]["database"][0].roles.migration
            assert before["security_definer"] is True
            assert original.count(_CLOCK_ASSIGNMENT) == 1
            frozen = owner.execute(
                "SELECT clock_timestamp()+interval '1 second'",
            ).fetchone()[0]
            claim_live_expiry = _claim_live_at_frozen_instant(case, claim, frozen)
            assert claim_live_expiry > frozen
            window_deadline = frozen + timedelta(seconds=offset_seconds)
            first_start = window_deadline - timedelta(hours=1)
            _owner_window(case, first_start, window_deadline, 3601)
            assert claim["generation"] == claim["claim"]["generation"]
            assert claim["token"] == str(claim["claim"]["claim_token"])

            frozen_literal = frozen.isoformat(timespec="microseconds")
            replacement = _FROZEN_ASSIGNMENT_PREFIX + frozen_literal + "';"
            assert original.count(_CLOCK_ASSIGNMENT) == 1
            changed = original.replace(_CLOCK_ASSIGNMENT, replacement)
            assert changed != original
            assert changed.replace(replacement, _CLOCK_ASSIGNMENT) == original
            owner.execute(changed)
            while_replaced = _read_function_snapshot(owner)
            _assert_function_metadata_unchanged(before, while_replaced)
            assert while_replaced["definition"] == changed
            assert while_replaced["definition"].replace(replacement, _CLOCK_ASSIGNMENT) == original
            assert while_replaced["definition"].count(replacement) == 1
            claim_live_expiry = _claim_live_at_frozen_instant(case, claim, frozen)
            sql_before_call = normal._read_owner_snapshot(case["harness"], case["job_id"])

        result = _invoke_record_attempt(case, claim, 3601)
        snapshot = normal._read_owner_snapshot(case["harness"], case["job_id"])
        assert snapshot["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
        assert snapshot["scopes"] == [] and snapshot["receipts"] == []
        binding = snapshot["bindings"][0]
        assert _owner_window_snapshot(case) == (first_start, window_deadline, 3601)
        if expected == "permitted":
            assert result["status"] == "permitted"
            assert binding[20] == "reserved" and binding[26] is None
            assert snapshot["accepted"][15] == "leased"
        else:
            assert result == {"status": "quarantined", "code": "START_WINDOW_EXPIRED"}
            assert binding[20] == "quarantined" and binding[26] == "START_WINDOW_EXPIRED"
            assert snapshot["accepted"][15] == "quarantined"
        result_for_evidence = result
        snapshot_for_evidence = snapshot
    except BaseException as error:
        primary_error_type = type(error).__name__
        raise
    finally:
        try:
            if original is not None:
                try:
                    with psycopg.connect(owner_dsn(case["harness"]["database"]), autocommit=True) as owner:
                        owner.execute(original)
                        restored = _read_function_snapshot(owner)
                    _assert_function_metadata_unchanged(before, restored)
                    assert restored["definition"] == original
                except BaseException as error:
                    restoration_error = type(error).__name__

            if case.get("root") is not None:
                try:
                    normal._write_private(case["root"] / "neg-window-clock-seam.json",
                                          normal._canonical({
                                              "case": boundary,
                                              "status": "failed" if (
                                                  primary_error_type or restoration_error
                                              ) else "complete",
                                              "primary_failure_type": primary_error_type,
                                              "restoration_failure_type": restoration_error,
                                              "frozen_instant": frozen_literal,
                                              "before": before,
                                              "while_replaced": while_replaced,
                                              "after_restore": restored,
                                              "original_definition": original,
                                              "expected_replacement_definition": changed,
                                              "claim_generation": None if claim is None else claim["generation"],
                                              "claim_token": None if claim is None else claim["token"],
                                              "claim_live_expiry_at_frozen_instant": (
                                                  None if claim_live_expiry is None else
                                                  claim_live_expiry.isoformat(timespec="microseconds")
                                              ),
                                              "result": result_for_evidence,
                                              "sql_before_cut": before_cut,
                                              "sql_before_call": sql_before_call,
                                              "sql_after": snapshot_for_evidence,
                                          }) + b"\n")
                except BaseException as error:
                    evidence_error = type(error).__name__
            if primary_error_type is None:
                if restoration_error is not None:
                    raise AssertionError("clock-seam function restoration failed: " + restoration_error)
                if evidence_error is not None:
                    raise AssertionError("clock-seam evidence write failed: " + evidence_error)
        finally:
            deadline.begin_cleanup()


@pytest.mark.parametrize(
    ("boundary", "expired"),
    [("before", False), ("after", True)],
    ids=["actual-before-deadline", "actual-after-deadline"],
)
def test_h2_window_actual_dispatcher_boundary(boundary, expired, workflow_scram_hba,
                                              workspace_environment, h2_window_case_deadline):
    deadline = h2_window_case_deadline
    case = crash.prepare_case(workspace_environment, deadline.body_deadline,
                              "neg-window-actual-" + boundary)
    process = None
    try:
        claim = _claim_and_reserve(case)
        with psycopg.connect(owner_dsn(case["harness"]["database"])) as owner:
            now = owner.execute("SELECT clock_timestamp()").fetchone()[0]
        if expired:
            uncertain_until = now - timedelta(minutes=1)
            first_start = uncertain_until - timedelta(hours=1)
        else:
            first_start = now
            uncertain_until = first_start + timedelta(hours=1)
        seeded = _owner_window(case, first_start, uncertain_until, 3601)
        assert seeded == (first_start, uncertain_until, 3601)
        before_cut = normal._read_owner_snapshot(case["harness"], case["job_id"])
        _wait_old_lease_expiry(case, claim, deadline.body_deadline)
        expiry_cut = normal._read_owner_snapshot(case["harness"], case["job_id"])

        process, record = normal._spawn_runtime_cli("dispatcher", case["dispatcher_config"], case["root"])
        case["processes"].append(process)
        case["records"].append(record)
        normal._append_private_journal(case["journal"], {"event": "started", **record})
        desired_state = "quarantined" if expired else "admitted"
        snapshot = _wait_runtime_outcome(case, desired_state, deadline.body_deadline, process)
        binding = snapshot["bindings"][0]
        assert _owner_window_snapshot(case) == seeded
        assert binding[24] is True
        assert binding[25] is (not expired)
        if expired:
            assert binding[20] == "quarantined" and binding[26] == "START_WINDOW_EXPIRED"
            assert snapshot["accepted"][15] == "quarantined"
            assert snapshot["scopes"] == [] and snapshot["receipts"] == []
            assert _ordered_attempts(snapshot) == [
                (claim["generation"], "expired", None, None, True),
                (claim["generation"] + 1, "quarantined", None, "START_WINDOW_EXPIRED", True),
            ]
            found = asyncio.run(accepted_start._list_workflow_runs(
                case["identity"]["server_endpoint"], case["identity"]["namespace"],
                "ifpmic.job." + case["job_id"], deadline.remaining(10) + time.monotonic(),
            ))
            assert found == []
            history_runs = found
        else:
            assert binding[20] == "admitted" and binding[26] is None
            assert snapshot["accepted"][15] == "dispatched"
            assert len(snapshot["scopes"]) == 1 and snapshot["receipts"] == []
            assert _ordered_attempts(snapshot) == [
                (claim["generation"], "expired", None, None, True),
                (claim["generation"] + 1, "started", binding[19], None, True),
            ]
            expected_input = {
                "protocol_version": normal.PROTOCOL_VERSION,
                "job_id": case["job_id"],
                "project_id": case["harness"]["project_id"],
                "binding_sha256": binding[18],
            }
            history = asyncio.run(accepted_start._observe_started_direct(
                case["identity"]["server_endpoint"], case["identity"]["namespace"],
                "ifpmic.job." + case["job_id"], expected_input,
                "ifpmic.build." + case["identity"]["build_id"],
                deadline.remaining(20) + time.monotonic(), case["root"],
            ))
            assert history["run_id"] == binding[19]
            assert history["execution_count"] == history["started_event_count"] == 1
            assert history["started_input"] == [expected_input]
            assert snapshot["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
            history_runs = [{"run_id": history["run_id"],
                             "execution_count": history["execution_count"],
                             "started_event_count": history["started_event_count"],
                             "started_input": history["started_input"],
                             "raw_history_sha256": history["raw_history_sha256"]}]
        _write_private_json(case, "neg-window-runtime-boundary.json", {
            "boundary": boundary,
            "window_seed": _iso_window_seed(seeded),
            "sql_before_cut": before_cut,
            "sql_lease_expired_cut": expiry_cut,
            "sql_after": snapshot,
            "temporal_history_or_empty_list": history_runs,
            "process_identity": {"pid": record["pid"], "start_ticks": record["start_ticks"]},
        })
    finally:
        deadline.begin_cleanup()
        crash.cleanup_case(case)
