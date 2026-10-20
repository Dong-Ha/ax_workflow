"""Real-process H2 authority-race and pre-admission transport boundaries.

These are authoring-only tests until included in the reviewed full H2 gate.
They use real PostgreSQL, Temporal, Dispatcher, Worker and projection code;
only the named constructor hooks are paused by test-owned file barriers.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import threading
import time
from datetime import timedelta

import psycopg
from tests.ifpmic_api.h2_native_bounds import bounded_connect
import pytest
from temporalio.client import Client

pytest_plugins = (
    "tests.ifpmic_api.jobs_fixture",
    "tests.ifpmic_api.workspace_fixture",
    "tests.ifpmic_api.workflow_schema_fixture",
)

from tests.ifpmic_api import h2_dispatcher_crash_support as crash
from tests.ifpmic_api import test_h2_runtime_normal_flow as normal
from tests.ifpmic_api.jobs_fixture import owner_dsn

CHILD = Path(__file__).with_name("h2_transport_boundary_child.py")
REPO_ROOT = Path.cwd().resolve()
MACHINE_IDS = (
    "tests/ifpmic_api/test_h2_transport_boundaries.py::test_h2_machine_authority_disable_serializes_with_claim[disable-before-claim]",
    "tests/ifpmic_api/test_h2_transport_boundaries.py::test_h2_machine_authority_disable_serializes_with_claim[claim-before-disable]",
)
PREADMISSION_ID = (
    "tests/ifpmic_api/test_h2_transport_boundaries.py::test_h2_activity_waits_until_admission_same_run"
)


@pytest.fixture
def h2_transport_deadline(request):
    try:
        return request.node._ifpmic_h2_transport_deadline
    except AttributeError:
        pytest.fail("the exact transport watchdog must start before session fixtures")


@pytest.fixture
def h2_transport_harness(workflow_scram_hba, workspace_environment):
    return workspace_environment


def _private_dir(path: Path) -> Path:
    path.mkdir(mode=0o700)
    path.chmod(0o700)
    info = path.lstat()
    assert stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
    assert stat.S_IMODE(info.st_mode) == 0o700 and not path.is_symlink()
    return path


def _write_private(path: Path, raw: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        view = memoryview(raw)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError("short private transport barrier write")
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)


def _event(case, name: str, deadline: float) -> dict[str, object]:
    path = case["control"] / ("reached-" + name)
    while time.monotonic() < deadline:
        if path.exists():
            info = path.lstat()
            assert (stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                    and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1
                    and not path.is_symlink())
            try:
                value = json.loads(path.read_text(encoding="ascii"))
            except json.JSONDecodeError:
                # The owned writer creates before completing/fsyncing JSON.
                # Retry partial publication within the original deadline.
                time.sleep(min(0.01, max(0.0, deadline - time.monotonic())))
                continue
            assert value["event"] == name and type(value["monotonic"]) is float
            return value
        if any(process.poll() is not None for process in case["processes"]):
            raise AssertionError("owned process exited before transport barrier")
        time.sleep(min(0.02, max(0.0, deadline - time.monotonic())))
    raise TimeoutError("transport barrier not reached")


def _release(case, name: str) -> None:
    _write_private(case["control"] / ("release-" + name), b"")


def _spawn_dispatcher(case, *, store_phases=(), dispatcher_phase=""):
    root = case["root"]
    logs = _private_dir(root / "transport-dispatcher-logs")
    cache = _private_dir(root / "transport-dispatcher-cache")
    stdout, stderr = logs / "stdout.log", logs / "stderr.log"
    out_fd = os.open(stdout, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    err_fd = os.open(stderr, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    argv = [sys.executable, "-B", "-X", "pycache_prefix=" + str(cache), str(CHILD),
            "--config", str(case["dispatcher_config"]), "--repo-root", str(REPO_ROOT),
            "--control-dir", str(case["control"]), "--command-id", case["group"][18]]
    for phase in store_phases:
        argv.extend(("--store-phase", phase))
    if dispatcher_phase:
        argv.extend(("--dispatcher-phase", dispatcher_phase))
    try:
        process = subprocess.Popen(argv, cwd=REPO_ROOT, stdin=subprocess.DEVNULL,
            stdout=out_fd, stderr=err_fd, env=normal._minimal_runtime_env(root, case["dispatcher_config"]),
            start_new_session=True)
    finally:
        os.close(out_fd)
        os.close(err_fd)
    case["processes"].append(process)
    ticks = normal.process_identity(process.pid)
    if ticks is None:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        raise AssertionError("owned transport dispatcher PID identity unavailable")
    process._ifpmic_start_ticks = ticks
    record = {"role": "transport-dispatcher", "pid": process.pid, "start_ticks": ticks,
              "stdout": stdout, "stderr": stderr, "cache": cache}
    case["records"].append(record)
    normal._append_private_journal(case["journal"], {"event": "started", **record})
    return process


def _disable_dispatcher(case) -> None:
    with bounded_connect(owner_dsn(case["harness"]["database"]), autocommit=True) as owner:
        changed = owner.execute(
            "UPDATE ifpmic.worker_principals SET active=false "
            "WHERE kind='dispatcher' AND deployment_id=%s AND active RETURNING role_oid::bigint",
            (case["identity"]["deployment_id"],),
        ).fetchall()
        assert changed == [(case["roles"]["dispatcher"],)]


def _assert_no_started(case, deadline):
    from tests.ifpmic_api import test_accepted_start_response_loss as accepted

    runs = asyncio.run(accepted._list_workflow_runs(
        case["identity"]["server_endpoint"], case["identity"]["namespace"],
        "ifpmic.job." + case["job_id"], deadline))
    assert runs == []


def _assert_unbound(case, *, claimed: bool) -> dict[str, object]:
    snapshot = normal._read_owner_snapshot(case["harness"], case["job_id"])
    assert snapshot["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
    assert snapshot["bindings"] == snapshot["scopes"] == snapshot["receipts"] == []
    assert snapshot["noncreate_commands"] == 0
    if claimed:
        assert snapshot["accepted"][15:17] == ("leased", 1)
        assert snapshot["attempts"] == [(1, None, None, None, False)]
    else:
        assert snapshot == case["before"]
    return snapshot


def _cleanup_case(deadline, case, *, expected_codes=None):
    primary = sys.exc_info()[1]
    cleanup_error = None
    outcomes = []
    try:
        deadline.begin_cleanup()
        # Unblock all test-only gates before asking owned children to exit.
        for name in case["barrier_names"]:
            path = case["control"] / ("release-" + name)
            if not path.exists():
                _write_private(path, b"release\n")
        for thread in case.get("threads", ()):
            thread.join(timeout=deadline.cleanup_remaining(5))
            if thread.is_alive():
                raise TimeoutError("owned authority-update thread did not stop")
        for process in case["processes"]:
            prior_code = process.poll()
            normal._append_private_journal(case["journal"], {
                "event": "stop_requested", "pid": process.pid,
                "start_ticks": getattr(process, "_ifpmic_start_ticks", None),
                "pre_stop_exit_code": prior_code,
                "mode": "already_exited" if prior_code is not None else "graceful",
            })
        expected_codes = {**case.get("expected_codes", {}), **(expected_codes or {})}
        outcomes = normal.stop_all_owned(case["processes"],
                                         total_timeout=deadline.cleanup_remaining(15))
        mismatches = []
        for process, outcome in zip(case["processes"], outcomes):
            expected = expected_codes.get(process.pid, 0)
            normal._append_private_journal(case["journal"], {
                "event": "stopped", "pid": process.pid,
                "start_ticks": getattr(process, "_ifpmic_start_ticks", None),
                "exit_code": outcome["returncode"], "absent": outcome["absent"],
                "forced": outcome["forced"],
            })
            if (outcome["returncode"] != expected or outcome["absent"] is not True
                    or (process.pid not in expected_codes and outcome["forced"] is not False)):
                mismatches.append(process.pid)
        normal._write_private(case["root"] / "transport-cleanup.json",
            normal._canonical({"status": "failed" if mismatches else "stopped",
                               "mismatch_pids": mismatches,
                               "outcomes": outcomes}) + b"\n")
        if mismatches:
            raise AssertionError("owned transport process cleanup oracle mismatch")
    except BaseException as error:
        cleanup_error = error
        try:
            normal._write_private(case["root"] / "transport-cleanup-failure.json",
                normal._canonical({"status": "failed", "primary_error":
                    None if primary is None else type(primary).__name__,
                    "cleanup_error": type(error).__name__, "outcomes": outcomes}) + b"\n")
        except BaseException:
            pass
    if cleanup_error is not None and primary is None:
        raise cleanup_error


def _prepare(harness, deadline, label):
    case = crash.prepare_case(harness, deadline.body_deadline, label, cleanup_controller=deadline)
    case["case_name"] = label
    case["dispatcher_config"] = case["dispatcher_config"]
    case["control"] = _private_dir(case["root"] / "transport-control")
    case["barrier_names"] = []
    case["threads"] = []
    case["processes"] = list(case["processes"])
    case["records"] = list(case["records"])
    return case


def _record_barrier(case, name):
    case["barrier_names"].append(name)


@pytest.mark.parametrize("variant", ["disable-before-claim", "claim-before-disable"])
def test_h2_machine_authority_disable_serializes_with_claim(
    variant, h2_transport_harness, h2_transport_deadline,
):
    deadline = h2_transport_deadline
    case = _prepare(h2_transport_harness, deadline, "transport-machine-" + variant)
    try:
        if variant == "disable-before-claim":
            _disable_dispatcher(case)
            before = _assert_unbound(case, claimed=False)
            child = _spawn_dispatcher(case)
            child.wait(timeout=deadline.remaining(10))
            assert child.returncode == 3
            case["expected_codes"] = {child.pid: 3}
            assert (case["root"] / "transport-dispatcher-logs/stdout.log").read_bytes() == (
                b'{"code":"DEPENDENCY_UNAVAILABLE","status":"unavailable"}\n')
            assert (case["root"] / "transport-dispatcher-logs/stderr.log").read_bytes() == b""
            assert _assert_unbound(case, claimed=False) == before
            _assert_no_started(case, deadline.body_deadline)
            normal._write_private(case["root"] / "machine-race-result.json",
                normal._canonical({"variant": variant, "status": "denied_before_claim",
                                   "exit_code": child.returncode}) + b"\n")
            return

        before = case["before"]
        child = _spawn_dispatcher(case, store_phases=(
            "before_claim_delivery_commit", "after_claim_delivery_commit"))
        first = "before_claim_delivery_commit"
        second = "after_claim_delivery_commit"
        _record_barrier(case, first)
        _record_barrier(case, second)
        reached_first = _event(case, first, deadline.body_deadline)
        assert child.poll() is None

        waiter_ready = threading.Event()
        waiter_done = threading.Event()
        waiter_data = {}

        def disable_waiter():
            try:
                with bounded_connect(owner_dsn(case["harness"]["database"])) as owner:
                    waiter_data["pid"] = owner.execute("SELECT pg_backend_pid()").fetchone()[0]
                    waiter_ready.set()
                    changed = owner.execute(
                        "UPDATE ifpmic.worker_principals SET active=false "
                        "WHERE kind='dispatcher' AND deployment_id=%s AND active RETURNING role_oid::bigint",
                        (case["identity"]["deployment_id"],),
                    ).fetchall()
                    waiter_data["changed"] = changed
                    owner.commit()
            except BaseException as error:
                waiter_data["error"] = type(error).__name__
                waiter_ready.set()
            finally:
                waiter_done.set()

        updater = threading.Thread(target=disable_waiter, name="h2-machine-disable", daemon=True)
        case["threads"].append(updater)
        updater.start()
        assert waiter_ready.wait(deadline.remaining(5)) and "error" not in waiter_data
        blocked = False
        while time.monotonic() < deadline.body_deadline:
            with bounded_connect(owner_dsn(case["harness"]["database"])) as observer:
                rows = observer.execute(
                    "SELECT blocker.pid,blocker.usename,waiter.wait_event_type,waiter.wait_event "
                    "FROM pg_stat_activity waiter "
                    "CROSS JOIN LATERAL unnest(pg_blocking_pids(waiter.pid)) blocker_id(pid) "
                    "JOIN pg_stat_activity blocker ON blocker.pid=blocker_id.pid "
                    "WHERE waiter.pid=%s",
                    (waiter_data["pid"],),
                ).fetchall()
            if rows and any(row[1] == case["harness"]["database"][0].roles.dispatcher
                            and row[2] == "Lock" for row in rows):
                blocked = True
                break
            assert not waiter_done.is_set(), "principal disable did not wait for claim transaction"
            time.sleep(0.02)
        assert blocked, "database did not expose the claim/disable lock wait"
        _release(case, first)
        reached_second = _event(case, second, deadline.body_deadline)
        updater.join(timeout=deadline.remaining(5))
        assert not updater.is_alive() and "error" not in waiter_data
        assert waiter_data["changed"] == [(case["roles"]["dispatcher"],)]
        assert reached_first["monotonic"] < reached_second["monotonic"]
        assert _assert_unbound(case, claimed=True)["accepted"][3] == "DRAFT"
        _release(case, second)
        child.wait(timeout=deadline.remaining(10))
        assert child.returncode == 0
        assert (case["root"] / "transport-dispatcher-logs/stdout.log").read_bytes() == (
            b'{"code":"DEPENDENCY_UNAVAILABLE","status":"wait"}\n')
        assert (case["root"] / "transport-dispatcher-logs/stderr.log").read_bytes() == b""
        after = _assert_unbound(case, claimed=True)
        assert after["accepted"][15:17] == ("leased", 1)
        _assert_no_started(case, deadline.body_deadline)
        normal._write_private(case["root"] / "machine-race-result.json",
            normal._canonical({"variant": variant, "status": "claim_then_disable_before_reserve",
                "blocked_update_pid": waiter_data["pid"], "first_barrier": reached_first,
                "second_barrier": reached_second, "before": before, "after": after}) + b"\n")
    finally:
        _cleanup_case(deadline, case)


async def _wait_pre_admission_activity(case, run_id, deadline_seconds):
    client = await asyncio.wait_for(Client.connect(
        case["identity"]["server_endpoint"], namespace=case["identity"]["namespace"]),
        timeout=min(10, deadline_seconds))
    handle = client.get_workflow_handle("ifpmic.job." + case["job_id"], run_id=run_id)
    loop = asyncio.get_running_loop()
    stop = loop.time() + deadline_seconds
    try:
        while loop.time() < stop:
            history = await handle.fetch_history(rpc_timeout=timedelta(seconds=5))
            read_waits = []
            projected = []
            scheduled = {
                int(event.event_id): event.activity_task_scheduled_event_attributes.activity_type.name
                for event in history.events
                if event.HasField("activity_task_scheduled_event_attributes")
            }
            for event in history.events:
                if event.HasField("activity_task_scheduled_event_attributes"):
                    name = event.activity_task_scheduled_event_attributes.activity_type.name
                    if name == "ifpmic.h2.project_activation":
                        projected.append(event.event_id)
                elif event.HasField("activity_task_completed_event_attributes"):
                    attrs = event.activity_task_completed_event_attributes
                    if scheduled.get(int(attrs.scheduled_event_id)) != "ifpmic.h2.read_activation":
                        continue
                    decoded = await client.data_converter.decode_wrapper(attrs.result)
                    if decoded == [{"status": "wait", "code": "DEPENDENCY_UNAVAILABLE"}]:
                        read_waits.append(event.event_id)
            phase = await handle.query("phase", result_type=str, rpc_timeout=timedelta(seconds=5))
            if read_waits and not projected and phase == "admission_wait":
                raw = b"".join(
                    len(encoded).to_bytes(8, "big") + encoded
                    for event in history.events
                    for encoded in (event.SerializeToString(deterministic=True),)
                )
                history_path = case["root"] / "preadmission-wait-history.pbseq"
                _write_private(history_path, raw)
                return {"read_wait_completed_event_ids": read_waits,
                        "project_activation_scheduled_event_ids": projected,
                        "phase": phase,
                        "history_event_ids": [int(event.event_id) for event in history.events],
                        "history_sha256": hashlib.sha256(raw).hexdigest(),
                        "history_bytes": len(raw)}
            await asyncio.sleep(min(0.1, max(0.0, stop - loop.time())))
        raise TimeoutError("worker did not persist its pre-admission wait activity")
    finally:
        # Temporal Python Client has no close method; process lifetime owns this
        # observer socket and the parent process closes it at case exit.
        pass


def test_h2_activity_waits_until_admission_same_run(
    h2_transport_harness, h2_transport_deadline,
):
    deadline = h2_transport_deadline
    case = _prepare(h2_transport_harness, deadline, "transport-preadmission")
    try:
        dispatcher = _spawn_dispatcher(case, dispatcher_phase="after_history_observed")
        phase = "after_history_observed"
        _record_barrier(case, phase)
        reached = _event(case, phase, deadline.body_deadline)
        at_cut = normal._read_owner_snapshot(case["harness"], case["job_id"])
        assert at_cut["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
        assert len(at_cut["bindings"]) == 1
        reserved = at_cut["bindings"][0]
        assert reserved[19:21] == (None, "reserved")
        assert at_cut["scopes"] == at_cut["receipts"] == []
        assert at_cut["accepted"][15:17] == ("leased", 1)
        normal._write_private(case["root"] / "preadmission-owner-at-cut.json",
                              normal._canonical(at_cut) + b"\n")

        worker, worker_record = normal._spawn_runtime_cli(
            "transport-preadmission-worker", case["worker_config"], case["root"])
        case["processes"].append(worker)
        case["records"].append(worker_record)
        normal._append_private_journal(case["journal"], {"event": "started", **worker_record})
        start_observation = asyncio.run(accepted_started(case, deadline.body_deadline))
        run_id = start_observation["run_id"]
        pre_admission = asyncio.run(_wait_pre_admission_activity(
            case, run_id, deadline.remaining(30)))
        during = normal._read_owner_snapshot(case["harness"], case["job_id"])
        assert during["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
        assert len(during["bindings"]) == 1
        assert during["bindings"][0][19:21] == (None, "reserved")
        assert during["scopes"] == during["receipts"] == []
        assert during["attempts"] == at_cut["attempts"]
        normal._write_private(case["root"] / "preadmission-owner-before-admission.json",
                              normal._canonical(during) + b"\n")
        _release(case, phase)
        dispatcher.wait(timeout=deadline.remaining(10))
        assert dispatcher.returncode == 0
        final = normal._wait_for_sql_outcome(case["harness"], case["job_id"],
                                              deadline.body_deadline, (worker,))
        assert final["bindings"][0][19:21] == (run_id, "admitted")
        assert final["attempts"] == [(1, "started", run_id, None, True)]
        temporal = normal._observe_temporal(
            case["identity"], case["job_id"], case["harness"]["project_id"], run_id,
            {"protocol_version": normal.PROTOCOL_VERSION, "job_id": case["job_id"],
             "project_id": case["harness"]["project_id"],
             "binding_sha256": final["bindings"][0][18]},
            deadline.body_deadline, _private_dir(case["root"] / "preadmission-final-history"))
        normal._assert_runtime_oracles(final, case["harness"], case["accepted"], case["group"],
            case["workspace"], case["identity"], case["roles"], temporal)
        normal._write_private(case["root"] / "preadmission-result.json",
            normal._canonical({"phase": reached, "pre_admission": pre_admission,
                "run_id": run_id, "snapshot_sha256": hashlib.sha256(
                    normal._canonical(final)).hexdigest(),
                "temporal_history_sha256": temporal["raw_history_sha256"],
                "started_history_sha256": start_observation["raw_history_sha256"]}) + b"\n")
    finally:
        _cleanup_case(deadline, case)


def accepted_started(case, deadline):
    from tests.ifpmic_api import test_accepted_start_response_loss as accepted

    snapshot = normal._read_owner_snapshot(case["harness"], case["job_id"])
    assert len(snapshot["bindings"]) == 1 and snapshot["bindings"][0][20] == "reserved"
    return accepted._observe_started_direct(
        case["identity"]["server_endpoint"], case["identity"]["namespace"],
        "ifpmic.job." + case["job_id"],
        {"protocol_version": normal.PROTOCOL_VERSION, "job_id": case["job_id"],
         "project_id": case["harness"]["project_id"],
         "binding_sha256": snapshot["bindings"][0][18]},
        "ifpmic.build." + case["identity"]["build_id"], deadline,
        _private_dir(case["root"] / "preadmission-start-history"))
