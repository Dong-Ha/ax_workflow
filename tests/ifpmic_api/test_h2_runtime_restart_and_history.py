"""Persistence checks across independent restarts of the owned PG/Temporal services."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import subprocess
import time

import pytest

from tests.ifpmic_api import h2_dispatcher_crash_support as crash
from tests.ifpmic_api.test_h2_dispatcher_crashes import _assert_crash_final
from tests.ifpmic_api import test_h2_runtime_normal_flow as normal

pytest_plugins = (
    "tests.ifpmic_api.jobs_fixture",
    "tests.ifpmic_api.workspace_fixture",
    "tests.ifpmic_api.workflow_schema_fixture",
)


def _pg_env(cluster):
    return {
        "PATH": os.pathsep.join((str(cluster.binaries["pg_ctl"].parent), "/usr/bin", "/bin")),
        "HOME": str(cluster.root), "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
        "PGCONNECT_TIMEOUT": "3",
    }


def _pg_ctl(cluster, *args):
    result = subprocess.run(
        [str(cluster.binaries["pg_ctl"]), "-D", str(cluster.data_dir), *args],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        timeout=25, check=False, env=_pg_env(cluster),
    )
    assert result.returncode == 0


def _stop_owned(case, process):
    normal._append_private_journal(case["journal"], {
        "event": "stop_requested", "pid": process.pid,
        "start_ticks": process._ifpmic_start_ticks,
        "pre_stop_exit_code": process.poll(), "mode": "graceful",
    })
    result = normal.stop_all_owned([process], total_timeout=15)[0]
    assert result["returncode"] == 0 and result["forced"] is False and result["absent"] is True
    normal._append_private_journal(case["journal"], {
        "event": "stopped", "pid": process.pid,
        "start_ticks": process._ifpmic_start_ticks, "exit_code": result["returncode"],
        "absent": result["absent"], "forced": result["forced"],
    })
    case["processes"].remove(process)
    return result


def test_postgres_and_temporal_restart_preserve_same_execution_and_receipt(
    workflow_scram_hba, workspace_environment, h2_crash_case_deadline,
):
    deadline = h2_crash_case_deadline
    case = crash.prepare_case(workspace_environment, deadline.body_deadline,
                              "runtime-independent-storage-restarts")
    case["case_name"] = "test_postgres_and_temporal_restart_preserve_same_execution_and_receipt"
    cluster = case["harness"]["database"][1]
    expected_run_id = None
    try:
        dispatcher, dispatcher_record = normal._spawn_runtime_cli(
            "dispatcher-initial", case["dispatcher_config"], case["root"])
        case["processes"].append(dispatcher)
        case["records"].append(dispatcher_record)
        normal._append_private_journal(case["journal"], {"event": "started", **dispatcher_record})
        initial, initial_temporal, worker = _assert_crash_final(
            case, deadline.body_deadline,
            expected_attempts=lambda run: [(1, "started", run, None, True)])
        expected_run_id = initial_temporal["run_id"]
        assert initial["accepted"][3:8] == ("QUEUED", 1, 0, [], None)
        assert len(initial["receipts"]) == 1 and initial["receipts"][0][1] == 1
        assert initial_temporal["execution_count"] == initial_temporal["started_event_count"] == 1
        before_restart = normal._read_owner_snapshot(case["harness"], case["job_id"])
        temporal_hash_before = initial_temporal["raw_history_sha256"]
        pg_data_inode = (cluster.data_dir.stat().st_dev, cluster.data_dir.stat().st_ino)
        temporal_inode = (case["temporal_store"].stat().st_dev,
                          case["temporal_store"].stat().st_ino)

        # Stop only the two test-owned runtime CLIs; persist their ordinary exits.
        _stop_owned(case, worker)
        _stop_owned(case, dispatcher)

        # PostgreSQL restart reuses the fixture-owned data directory and exact
        # 18.1 pg_ctl binary. Temporal remains live while SQL is restarted.
        temporal_pid = case["server"].pid
        temporal_ticks = case["server"]._ifpmic_start_ticks
        pg_old_pid = cluster.server_pid
        pg_old_ticks = normal.process_identity(pg_old_pid)
        assert pg_old_ticks is not None
        normal._append_private_journal(case["journal"], {
            "event": "service_stop_requested", "role": "postgres",
            "pid": pg_old_pid, "start_ticks": pg_old_ticks,
            "pre_stop_alive": True, "data_dir": str(cluster.data_dir),
        })
        _pg_ctl(cluster, "-m", "fast", "-w", "-t", "15", "stop")
        assert normal.process_identity(temporal_pid) == temporal_ticks
        assert normal.process_identity(pg_old_pid) is None
        normal._append_private_journal(case["journal"], {
            "event": "service_stopped", "role": "postgres",
            "pid": pg_old_pid, "start_ticks": pg_old_ticks, "absent": True,
        })
        _pg_ctl(cluster, "-l", str(cluster.log_path), "-w", "-t", "20", "start")
        pg_new_pid = int((cluster.data_dir / "postmaster.pid").read_text(encoding="ascii").splitlines()[0])
        pg_new_ticks = normal.process_identity(pg_new_pid)
        assert pg_new_ticks is not None and (pg_new_pid, pg_new_ticks) != (pg_old_pid, pg_old_ticks)
        normal._append_private_journal(case["journal"], {
            "event": "service_started", "role": "postgres", "pid": pg_new_pid,
            "start_ticks": pg_new_ticks, "data_dir": str(cluster.data_dir),
        })
        assert (cluster.data_dir.stat().st_dev, cluster.data_dir.stat().st_ino) == pg_data_inode
        after_pg_restart = normal._read_owner_snapshot(case["harness"], case["job_id"])
        assert after_pg_restart == before_restart
        pg_history = normal._observe_temporal(
            case["identity"], case["job_id"], case["harness"]["project_id"], expected_run_id,
            {"protocol_version": normal.PROTOCOL_VERSION, "job_id": case["job_id"],
             "project_id": case["harness"]["project_id"],
             "binding_sha256": before_restart["bindings"][0][18]},
            deadline.body_deadline, normal._private_dir(case["root"] / "history-after-pg-restart"),
        )
        assert pg_history["run_id"] == expected_run_id
        assert pg_history["raw_history_sha256"] == temporal_hash_before
        assert normal.process_identity(temporal_pid) == temporal_ticks

        # Temporal restart reuses the exact SQLite path and port; PostgreSQL
        # remains available. Re-registering or changing build/deployment would
        # alter source hashes and is therefore not performed.
        normal._append_private_journal(case["journal"], {
            "event": "stop_requested", "role": "temporal", "pid": case["server"].pid,
            "start_ticks": case["server"]._ifpmic_start_ticks,
            "pre_stop_exit_code": case["server"].poll(), "mode": "graceful",
        })
        temporal_stop = normal.stop_all_owned([case["server"]], total_timeout=15)[0]
        assert temporal_stop["returncode"] == 0 and temporal_stop["forced"] is False
        assert temporal_stop["absent"] is True
        normal._append_private_journal(case["journal"], {
            "event": "stopped", "pid": case["server"].pid,
            "start_ticks": case["server"]._ifpmic_start_ticks,
            "exit_code": temporal_stop["returncode"], "absent": True, "forced": False,
        })
        case["processes"].remove(case["server"])
        toolchain = normal._read_h1_toolchain()
        new_server = crash.start_owned_temporal_server(
            Path(toolchain["toolchain_root"]) / "temporal",
            toolchain["cli_binary_sha256"], case["temporal_root"],
            case["ports"], log_name="temporal-server-restart.log")
        case["server"] = new_server
        case["processes"].append(new_server)
        new_server_record = {"role": "temporal-restarted", "pid": new_server.pid,
                             "start_ticks": new_server._ifpmic_start_ticks,
                             "log": case["temporal_root"] / "temporal-server-restart.log"}
        case["records"].append(new_server_record)
        normal._append_private_journal(case["journal"], {"event": "started", **new_server_record})
        normal._wait_for_temporal_listeners(
            new_server, case["ports"], time.monotonic() + min(30, deadline.remaining(30)))
        assert (case["temporal_store"].stat().st_dev,
                case["temporal_store"].stat().st_ino) == temporal_inode
        after_temporal_restart = normal._read_owner_snapshot(case["harness"], case["job_id"])
        assert after_temporal_restart == before_restart
        temporal_history = normal._observe_temporal(
            case["identity"], case["job_id"], case["harness"]["project_id"], expected_run_id,
            {"protocol_version": normal.PROTOCOL_VERSION, "job_id": case["job_id"],
             "project_id": case["harness"]["project_id"],
             "binding_sha256": before_restart["bindings"][0][18]},
            deadline.body_deadline, normal._private_dir(case["root"] / "history-after-temporal-restart"),
        )
        assert temporal_history["run_id"] == expected_run_id
        assert temporal_history["raw_history_sha256"] == temporal_hash_before

        # Actual registered CLI restart against both recovered services is
        # idempotent: one admitted run, one immutable receipt, same history.
        dispatcher, record = normal._spawn_runtime_cli(
            "dispatcher-after-restarts", case["dispatcher_config"], case["root"])
        worker, worker_record = normal._spawn_runtime_cli(
            "worker-after-restarts", case["worker_config"], case["root"])
        for process, item in ((dispatcher, record), (worker, worker_record)):
            case["processes"].append(process)
            case["records"].append(item)
            normal._append_private_journal(case["journal"], {"event": "started", **item})
        time.sleep(min(1.0, deadline.remaining(1)))
        final = normal._read_owner_snapshot(case["harness"], case["job_id"])
        assert final == before_restart
        replayed_history = normal._observe_temporal(
            case["identity"], case["job_id"], case["harness"]["project_id"], expected_run_id,
            {"protocol_version": normal.PROTOCOL_VERSION, "job_id": case["job_id"],
             "project_id": case["harness"]["project_id"],
             "binding_sha256": before_restart["bindings"][0][18]},
            deadline.body_deadline, normal._private_dir(case["root"] / "history-after-cli-restart"),
        )
        assert replayed_history["raw_history_sha256"] == temporal_hash_before
        assert replayed_history["execution_count"] == replayed_history["started_event_count"] == 1
        normal._write_private(case["root"] / "restart-oracle.json", normal._canonical({
            "case_id": case["case_name"], "status": "passed", "run_id": expected_run_id,
            "pg_data_dev_inode": pg_data_inode, "temporal_store_dev_inode": temporal_inode,
            "pg_restart_snapshot_sha256": hashlib.sha256(normal._canonical(after_pg_restart)).hexdigest(),
            "temporal_restart_snapshot_sha256": hashlib.sha256(
                normal._canonical(after_temporal_restart)).hexdigest(),
            "same_history_sha256": temporal_hash_before,
            "execution_count": replayed_history["execution_count"],
            "receipt_count": len(final["receipts"]),
        }) + b"\n")
    finally:
        with deadline.cleanup_budget():
            crash.cleanup_case(case, ())
