"""Private drafts for actual Started-history and deployment isolation cases."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
import pytest
from temporalio.client import Client
from temporalio.common import WorkflowIDConflictPolicy, WorkflowIDReusePolicy

from tests.ifpmic_api import h2_dispatcher_crash_support as crash
from tests.ifpmic_api import test_accepted_start_response_loss as accepted_start
from tests.ifpmic_api import test_h2_runtime_normal_flow as normal
from tests.ifpmic_api.h2_started_deployment_case_budget import STARTED_VARIANTS
from tests.ifpmic_api.jobs_fixture import owner_dsn
from tests.ifpmic_api.h2_fixture_cleanup import restore_preserving_error

pytest_plugins = (
    "tests.ifpmic_api.jobs_fixture",
    "tests.ifpmic_api.workspace_fixture",
    "tests.ifpmic_api.workflow_schema_fixture",
)

EXPECTED_START_CODE = {
    "workflow_type": "RUN_CONFLICT",
    "task_queue": "RUN_CONFLICT",
    "build_id": "RUN_CONFLICT",
}


async def _create_rogue_started(case, variant: str, binding: tuple) -> str:
    endpoint = case["identity"]["server_endpoint"]
    namespace = case["identity"]["namespace"]
    workflow_id = binding[6]
    task_queue = binding[9]
    value = {
        "protocol_version": normal.PROTOCOL_VERSION,
        "job_id": binding[0],
        "project_id": binding[1],
        "binding_sha256": binding[18],
    }
    workflow_type = normal.WORKFLOW_TYPE
    if variant == "missing_input":
        args = ()
    elif variant == "extra_input":
        args = (value, "extra")
    elif variant == "malformed_input":
        args = ({"unexpected": ["shape"]},)
    elif variant == "binding_digest":
        value["binding_sha256"] = "0" * 64 if binding[18] != "0" * 64 else "1" * 64
        args = (value,)
    elif variant == "job_id":
        value["job_id"] = str(uuid4())
        args = (value,)
    elif variant == "project_id":
        value["project_id"] = "foreign-project"
        args = (value,)
    elif variant == "workflow_type":
        workflow_type = "IFPMICJobWorkflowForeign"
        args = (value,)
    elif variant == "task_queue":
        task_queue = "ifpmic.foreign.queue"
        args = (value,)
    elif variant == "build_id":
        task_queue = "ifpmic.build." + ("0" * 64 if case["identity"]["build_id"] != "0" * 64 else "1" * 64)
        args = (value,)
    else:
        raise AssertionError("unrecognized literal Started variant")
    client = await asyncio.wait_for(Client.connect(endpoint, namespace=namespace), 10)
    handle = await asyncio.wait_for(client.start_workflow(
        workflow_type, args=args, id=workflow_id, task_queue=task_queue,
        id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
        id_conflict_policy=WorkflowIDConflictPolicy.FAIL,
        retry_policy=None, rpc_timeout=normal.timedelta(seconds=10),
    ), 10)
    return handle.first_execution_run_id


def _wait_process(process, deadline):
    while time.monotonic() < deadline:
        code = process.poll()
        if code is not None:
            return code
        time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))
    raise TimeoutError("production dispatcher did not finish after the rogue Started event")


def _wait_sql_retry_ready(database, command_id, deadline):
    while time.monotonic() < deadline:
        with _bounded_connect(owner_dsn(database)) as owner:
            row = owner.execute(
                "SELECT state,generation,next_attempt_at<=clock_timestamp() "
                "FROM ifpmic.commands_outbox WHERE command_id=%s", (command_id,),
            ).fetchone()
        assert row is not None and row[0:2] == ("pending", 1)
        if row[2]:
            return row
        time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))
    raise TimeoutError("database clock did not reach the real retry boundary")


def _bounded_connect(dsn, **kwargs):
    # Match the approved native limits; callers may supply tighter cleanup limits.
    kwargs.setdefault("connect_timeout", 3)
    kwargs.setdefault("options", "-c lock_timeout=5000 -c statement_timeout=30000")
    return psycopg.connect(dsn, **kwargs)


def _registered_deployment_rows(database, deployment_id):
    with _bounded_connect(owner_dsn(database)) as owner:
        deployment = owner.execute(
            "SELECT deployment_id,namespace,server_endpoint,server_config_sha256,enabled "
            "FROM ifpmic.execution_deployments WHERE deployment_id=%s", (deployment_id,),
        ).fetchone()
        build = owner.execute(
            "SELECT deployment_id,build_id,source_manifest_sha256,environment_manifest_sha256,"
            "workflow_type,task_queue,protocol_version,enabled FROM ifpmic.engine_builds "
            "WHERE deployment_id=%s", (deployment_id,),
        ).fetchall()
    return {"deployment": deployment, "builds": build}


def _register_foreign_principals(harness, identity, remaining):
    """Create separate non-member logins for the other deployment's real RPCs."""
    migration, cluster = harness["database"]
    suffix = uuid4().hex[:16]
    dispatcher_name, projector_name = "h2fd_" + suffix, "h2fp_" + suffix
    dispatcher_password, projector_password = uuid4().hex + uuid4().hex, uuid4().hex + uuid4().hex
    try:
        with _bounded_connect(cluster.dsn(database=migration.name),
                             autocommit=True) as bootstrap:
            for role_name, password in ((dispatcher_name, dispatcher_password),
                                        (projector_name, projector_password)):
                bootstrap.execute(sql.SQL(
                    "CREATE ROLE {} LOGIN PASSWORD {} NOSUPERUSER NOCREATEDB NOCREATEROLE "
                    "NOBYPASSRLS NOINHERIT"
                ).format(sql.Identifier(role_name), sql.Literal(password)))
                bootstrap.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(
                    sql.Identifier(migration.name), sql.Identifier(role_name)))
        with _bounded_connect(owner_dsn(harness["database"]), autocommit=True) as owner:
            for role_name in (dispatcher_name, projector_name):
                owner.execute(sql.SQL("GRANT USAGE ON SCHEMA ifpmic TO {}").format(
                    sql.Identifier(role_name)))
            owner.execute(sql.SQL(
                "GRANT EXECUTE ON FUNCTION ifpmic.read_dispatch_config(),"
                "ifpmic.claim_delivery(uuid),ifpmic.reserve_execution(uuid,bigint,uuid,text,uuid,bigint),"
                "ifpmic.record_start_attempt(uuid,bigint,uuid,bigint),"
                "ifpmic.admit_run(uuid,bigint,uuid,text,text),"
                "ifpmic.record_delivery(uuid,bigint,uuid,text,text,text),"
                "ifpmic.report_dispatch_incident(uuid,bigint,uuid,text) TO {}"
            ).format(sql.Identifier(dispatcher_name)))
            owner.execute(sql.SQL(
                "GRANT EXECUTE ON FUNCTION ifpmic.read_registered_build(text),"
                "ifpmic.read_activation(uuid,text,text),"
                "ifpmic.project_activation(uuid,text,text,bigint,bigint,uuid,text),"
                "ifpmic.report_projection_incident(uuid,text,text,text) TO {}"
            ).format(sql.Identifier(projector_name)))
            role_oids = dict(owner.execute(
                "SELECT rolname,oid::bigint FROM pg_roles WHERE rolname=ANY(%s)",
                ([dispatcher_name, projector_name],),
            ).fetchall())
            assert set(role_oids) == {dispatcher_name, projector_name}
            owner.execute(
                "INSERT INTO ifpmic.execution_deployments"
                "(deployment_id,namespace,server_endpoint,server_config_sha256) VALUES(%s,%s,%s,%s)",
                (identity["deployment_id"], identity["namespace"], identity["server_endpoint"],
                 identity["server_config_sha256"]))
            owner.execute(
                "INSERT INTO ifpmic.engine_builds"
                "(deployment_id,build_id,source_manifest_sha256,environment_manifest_sha256,"
                "workflow_type,task_queue,protocol_version) VALUES(%s,%s,%s,%s,%s,%s,%s)",
                (identity["deployment_id"], identity["build_id"], identity["source_manifest_sha256"],
                 identity["environment_manifest_sha256"], normal.WORKFLOW_TYPE,
                 "ifpmic.build." + identity["build_id"], normal.PROTOCOL_VERSION))
            owner.execute(
                "INSERT INTO ifpmic.worker_principals"
                "(role_oid,role_name,kind,deployment_id,build_id)"
                "VALUES(%s,%s,'dispatcher',%s,NULL),(%s,%s,'projector',%s,%s)",
                (role_oids[dispatcher_name], dispatcher_name, identity["deployment_id"],
                 role_oids[projector_name], projector_name, identity["deployment_id"], identity["build_id"]))
    except BaseException:
        restore_preserving_error(
            lambda: _drop_foreign_principals(harness, (dispatcher_name, projector_name), remaining))
        raise
    def dsn(role, password):
        return make_conninfo(host=str(cluster.socket_dir), port=str(cluster.port), dbname=migration.name,
                             user=role, password=password)
    return {
        "dispatcher_dsn": dsn(dispatcher_name, dispatcher_password),
        "projector_dsn": dsn(projector_name, projector_password),
        "dispatcher_role": dispatcher_name,
        "projector_role": projector_name,
        "dispatcher_password": dispatcher_password,
        "projector_password": projector_password,
    }


def _cleanup_connect(dsn, remaining):
    left = remaining()
    if left < 3.5:
        raise TimeoutError("foreign role cleanup has insufficient native-call allowance")
    native_ms = min(500, int((left - 2) * 1000))
    return _bounded_connect(dsn, autocommit=True, connect_timeout=2,
        options=f"-c statement_timeout={native_ms} -c lock_timeout={native_ms}")


def _drop_foreign_principals(harness, role_names, remaining):
    """Remove only these test-created roles after their isolated DB is retired."""
    migration, cluster = harness["database"]
    with _cleanup_connect(cluster.dsn(database=migration.name), remaining) as owner:
        existing = [row[0] for row in owner.execute(
            "SELECT rolname FROM pg_roles WHERE rolname=ANY(%s)", (list(role_names),),
        ).fetchall()]
        if existing:
            joined = sql.SQL(",").join(sql.Identifier(name) for name in existing)
            owner.execute(sql.SQL("DROP OWNED BY {} CASCADE").format(joined))
    if existing:
        with _cleanup_connect(cluster.dsn(database="postgres"), remaining) as bootstrap:
            for name in existing:
                bootstrap.execute(sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(name)))
    with _cleanup_connect(cluster.dsn(database="postgres"), remaining) as bootstrap:
        survivors = bootstrap.execute(
            "SELECT rolname FROM pg_roles WHERE rolname=ANY(%s)", (list(role_names),),
        ).fetchall()
    assert survivors == []
    return True


def _foreign_scram_rules(harness, roles, passwords, deadline, state):
    """Temporarily put strict rules ahead of the fixture's trust fallback."""
    migration, cluster = harness["database"]
    path = cluster.data_dir / "pg_hba.conf"
    original = path.read_bytes()
    state["original_hba"] = original
    rules = "".join(f"local all {role} scram-sha-256\n" for role in roles).encode("ascii")
    path.write_bytes(rules + original)
    # This is a body operation, so bound pg_ctl with the same whole-case clock.
    completed = subprocess.run(
        [str(cluster.binaries["pg_ctl"]), "-D", str(cluster.data_dir), "reload"],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=deadline.remaining(10), check=False,
        env={"PATH": f"{cluster.binaries['pg_ctl'].parent}{os.pathsep}/usr/bin:/bin",
             "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
    )
    assert completed.returncode == 0
    with _bounded_connect(cluster.dsn(database=migration.name), autocommit=True) as bootstrap:
        rows = bootstrap.execute(
            "SELECT line_number,type,database,user_name,auth_method FROM pg_hba_file_rules "
            "WHERE line_number<=2 ORDER BY line_number").fetchall()
    assert rows == [(i + 1, "local", ["all"], [role], "scram-sha-256")
                    for i, role in enumerate(roles)]
    for role, password in zip(roles, passwords):
        with _bounded_connect(cluster.dsn(user=role, database=migration.name, password=password),
                             connect_timeout=2) as authenticated:
            assert authenticated.execute("SELECT session_user").fetchone() == (role,)
        with pytest.raises(psycopg.OperationalError):
            with _bounded_connect(cluster.dsn(user=role, database=migration.name,
                    password="wrong-" + password), connect_timeout=2):
                pass
        with pytest.raises(psycopg.OperationalError):
            with _bounded_connect(cluster.dsn(user=role, database=migration.name),
                    password="", passfile=os.devnull, connect_timeout=2):
                pass
    return original


def _restore_foreign_hba(harness, original, request_config):
    from tests.ifpmic_api.workflow_schema_fixture import _reload_hba

    cluster = harness["database"][1]
    path = cluster.data_dir / "pg_hba.conf"
    path.write_bytes(original)
    # Fixture helper uses the already-installed whole-case cleanup deadline.
    _reload_hba(cluster, cleanup_config=request_config)


def _spawn_foreign_dispatcher(case, config_path, command_id):
    """Launch the owned child that treats an actual scoped no-claim as success."""
    root = case["root"]
    stdout_path = root / "foreign-dispatcher.stdout"
    stderr_path = root / "foreign-dispatcher.stderr"
    cache = normal._private_dir(root / "foreign-dispatcher-pycache")
    out_fd = os.open(stdout_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    err_fd = os.open(stderr_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    env = normal._minimal_runtime_env(root, config_path)
    env["IFPMIC_EXECUTION_CONFIG"] = str(config_path)
    helper = Path(__file__).with_name("h2_foreign_dispatcher_child.py")
    try:
        process = subprocess.Popen(
            [sys.executable, "-B", "-X", "pycache_prefix=" + str(cache), str(helper),
             "--command-id", command_id,
             "--repo-root", str(Path(__file__).resolve().parents[2])],
            cwd=str(Path(__file__).resolve().parents[2]), stdin=subprocess.DEVNULL,
            stdout=out_fd, stderr=err_fd, env=env, close_fds=True, start_new_session=True,
        )
    finally:
        os.close(out_fd)
        os.close(err_fd)
    record = {"role": "foreign-dispatcher-child", "pid": process.pid,
              "start_ticks": normal.process_identity(process.pid),
              "stdout": stdout_path, "stderr": stderr_path, "config": config_path,
              "cache": cache}
    if record["start_ticks"] is None:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        raise AssertionError("foreign dispatcher process identity unavailable")
    process._ifpmic_start_ticks = record["start_ticks"]
    case["processes"].append(process)
    case["records"].append(record)
    normal._append_private_journal(case["journal"], {"event": "started", **record})
    return process, record


async def _observe_persisted_started(case, binding, evidence_path: Path, deadline: float):
    """Read the real server history and return its actual first Started fields."""
    from datetime import timedelta

    client = await asyncio.wait_for(Client.connect(case["identity"]["server_endpoint"],
                                  namespace=case["identity"]["namespace"]), 10)
    workflow_id = binding[6]
    runs = []
    async for item in client.list_workflows(
            f'WorkflowId = "{workflow_id}"', limit=10,
            rpc_timeout=timedelta(seconds=min(5, deadline - time.monotonic()))):
        runs.append(item)
    assert len(runs) == 1
    handle = client.get_workflow_handle(workflow_id, run_id=runs[0].run_id)
    description = await handle.describe(rpc_timeout=timedelta(seconds=5))
    history = await handle.fetch_history(rpc_timeout=timedelta(seconds=5))
    starts = [event for event in history.events if event.event_id == 1]
    assert len(starts) == 1
    event = starts[0]
    assert event.HasField("workflow_execution_started_event_attributes")
    attributes = event.workflow_execution_started_event_attributes
    decoded = await client.data_converter.decode_wrapper(attributes.input)
    raw = b"".join(
        len(event.SerializeToString(deterministic=True)).to_bytes(8, "big")
        + event.SerializeToString(deterministic=True) for event in history.events)
    normal._write_private(evidence_path, raw)
    return {
        "workflow_id": description.id,
        "run_id": description.run_id,
        "namespace": description.namespace,
        "workflow_type": description.workflow_type,
        "status": description.status.name,
        "task_queue": attributes.task_queue.name,
        "started_workflow_id": attributes.workflow_id,
        "started_workflow_type": attributes.workflow_type.name,
        "started_task_queue": attributes.task_queue.name,
        "original_execution_run_id": attributes.original_execution_run_id,
        "decoded_input": decoded,
        "event_ids": [int(item.event_id) for item in history.events],
        "raw_history_sha256": hashlib.sha256(raw).hexdigest(),
        "raw_history_bytes": len(raw),
    }


@pytest.mark.parametrize("variant", STARTED_VARIANTS, ids=STARTED_VARIANTS)
def test_started_history_mismatch_fails_closed(workspace_environment, request, variant):
    """Place one actual malformed Started event at the production pre-Start cut."""
    from tests.ifpmic_api import h2_fixture_cleanup as cleanup

    deadline = cleanup.controller(request.config)
    assert deadline is not None
    case = crash.prepare_case(workspace_environment, deadline.body_deadline, "started-" + variant,
                              cleanup_controller=deadline)
    process = barrier = None
    expected = EXPECTED_START_CODE.get(variant, "BINDING_CONFLICT")
    try:
        process, process_record, barrier = crash.start_barrier_dispatcher(case, "before_start_rpc")
        barrier.wait(deadline.remaining(30))
        at_cut = crash.read_owner_snapshot(case["harness"], case["job_id"])
        assert len(at_cut["bindings"]) == 1
        binding = at_cut["bindings"][0]
        assert binding[19:21] == (None, "reserved")
        assert binding[21] is not None and binding[22] is not None
        rogue_run_id = asyncio.run(_create_rogue_started(case, variant, binding))
        observed = asyncio.run(_observe_persisted_started(
            case, binding, case["root"] / "rogue-started-history.pbseq",
            deadline.body_deadline))
        assert observed["run_id"] == rogue_run_id
        assert observed["status"] == "RUNNING"
        assert observed["workflow_id"] == binding[6]
        assert observed["started_workflow_id"] == binding[6]
        assert observed["original_execution_run_id"] == rogue_run_id
        assert observed["namespace"] == case["identity"]["namespace"]
        assert observed["event_ids"][0] == 1
        if variant == "workflow_type":
            assert observed["workflow_type"] == observed["started_workflow_type"] == "IFPMICJobWorkflowForeign"
        else:
            assert observed["started_workflow_type"] == normal.WORKFLOW_TYPE
        if variant in ("task_queue", "build_id"):
            assert observed["started_task_queue"] != binding[9]
        if variant in ("missing_input", "extra_input", "malformed_input", "binding_digest", "job_id", "project_id"):
            assert observed["decoded_input"] != [{
                "protocol_version": normal.PROTOCOL_VERSION,
                "job_id": binding[0], "project_id": binding[1], "binding_sha256": binding[18],
            }]
        expected_started = {
            "protocol_version": normal.PROTOCOL_VERSION,
            "job_id": binding[0], "project_id": binding[1], "binding_sha256": binding[18],
        }
        if variant == "missing_input":
            assert observed["decoded_input"] == []
        elif variant == "extra_input":
            assert observed["decoded_input"] == [expected_started, "extra"]
        elif variant == "malformed_input":
            assert observed["decoded_input"] == [{"unexpected": ["shape"]}]
        elif variant == "binding_digest":
            assert observed["decoded_input"][0]["binding_sha256"] != binding[18]
        elif variant == "job_id":
            assert observed["decoded_input"][0]["job_id"] != binding[0]
        elif variant == "project_id":
            assert observed["decoded_input"][0]["project_id"] != binding[1]
        barrier.release()
        assert _wait_process(process, deadline.body_deadline) == 3
        assert Path(process_record["stdout"]).read_bytes() == b'{"status":"quarantined"}\n'
        assert Path(process_record["stderr"]).read_bytes() == b""
        after = crash.read_owner_snapshot(case["harness"], case["job_id"])
        assert after["accepted"][:8] == at_cut["accepted"][:8]
        assert after["accepted"][12:15] == ("accepted", None, None)
        assert after["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
        assert after["bindings"][0][0:19] == binding[0:19]
        assert after["bindings"][0][19] is None
        assert after["bindings"][0][20] == "quarantined"
        assert after["bindings"][0][26] == expected
        assert after["scopes"] == after["receipts"] == []
        assert after["attempts"][-1][1:4] == ("quarantined", None, expected)
        assert after["accepted"][15] == "quarantined"
        assert after["noncreate_commands"] == 0
        normal._write_private(case["root"] / "owner-after-quarantine.json",
                              normal._canonical(after) + b"\n")
        normal._write_private(case["root"] / "rogue-started-summary.json", normal._canonical({
            "variant": variant, "run_id": rogue_run_id,
            "history_sha256": observed["raw_history_sha256"],
            "history_bytes": observed["raw_history_bytes"],
            "actual_workflow_type": observed["workflow_type"],
            "actual_task_queue": observed["started_task_queue"],
            "actual_decoded_argument_count": len(observed["decoded_input"]),
        }) + b"\n")
    finally:
        deadline.begin_cleanup()
        if barrier is not None:
            barrier.release_requested.set()
        crash.cleanup_case(case, expected_exit_codes={} if process is None else {process.pid: 3})


def test_foreign_deployment_cannot_start_old_binding(workspace_environment, workflow_scram_hba, request):
    """A second real server and registered deployment cannot claim the old binding."""
    from tests.ifpmic_api import h2_fixture_cleanup as cleanup
    from tests.ifpmic_api.h2_dispatcher_crash_support import start_owned_temporal_server

    deadline = cleanup.controller(request.config)
    assert deadline is not None
    case = crash.prepare_case(workspace_environment, deadline.body_deadline, "foreign-deployment",
                              cleanup_controller=deadline)
    process = None
    foreign_roles = None
    hba_state = {}
    try:
        toolchain = normal._read_h1_toolchain()
        ports2 = normal._allocate_loopback_ports()
        root2 = normal._private_dir(case["root"] / "foreign-temporal-data")
        server2 = start_owned_temporal_server(
            Path(toolchain["toolchain_root"]) / "temporal", toolchain["cli_binary_sha256"],
            root2, ports2, log_name="foreign-temporal-server.log")
        case["processes"].append(server2)
        record2 = {"role": "foreign-temporal", "pid": server2.pid,
                   "start_ticks": server2._ifpmic_start_ticks,
                   "log": root2 / "foreign-temporal-server.log"}
        case["records"].append(record2)
        normal._append_private_journal(case["journal"], {"event": "started", **record2})
        normal._wait_for_temporal_listeners(server2, ports2,
                                            time.monotonic() + deadline.remaining(30))
        endpoint2 = f"127.0.0.1:{ports2[0]}"
        temporal_store2 = root2 / "temporal.sqlite"
        assert temporal_store2.is_file()
        store_identity2 = (temporal_store2.stat().st_dev, temporal_store2.stat().st_ino)
        assert store_identity2 != case["temporal_store_identity"]
        assert endpoint2 != case["identity"]["server_endpoint"]
        deployment_id2 = "h2-foreign-" + uuid4().hex
        server_doc2 = {"protocol_version": normal.PROTOCOL_VERSION,
                       "deployment_id": deployment_id2,
                       "namespace": case["identity"]["namespace"],
                       "server_endpoint": endpoint2}
        source_sha = case["identity"]["source_manifest_sha256"]
        environment_sha = case["identity"]["environment_manifest_sha256"]
        build_doc2 = {"protocol_version": normal.PROTOCOL_VERSION,
                      "source_manifest_sha256": source_sha,
                      "environment_manifest_sha256": environment_sha,
                      "workflow_type": normal.WORKFLOW_TYPE}
        foreign_identity = {
            "deployment_id": deployment_id2,
            "namespace": case["identity"]["namespace"],
            "server_endpoint": endpoint2,
            "server_config_sha256": normal._domain_hash("ifpmic.b03.deployment.v1", server_doc2),
            "build_id": normal._domain_hash("ifpmic.b03.build.v1", build_doc2),
            "source_manifest_sha256": source_sha,
            "environment_manifest_sha256": environment_sha,
        }
        foreign_roles = _register_foreign_principals(
            case["harness"], foreign_identity,
            lambda: cleanup.remaining(request.config, 5),
        )
        _foreign_scram_rules(
            case["harness"],
            (foreign_roles["dispatcher_role"], foreign_roles["projector_role"]),
            (foreign_roles["dispatcher_password"], foreign_roles["projector_password"]),
            deadline, state=hba_state,
        )
        registry_before = _registered_deployment_rows(
            case["harness"]["database"], case["identity"]["deployment_id"])
        foreign_config = normal._write_runtime_config(
            case["root"], "foreign-dispatcher", foreign_identity,
            foreign_roles["dispatcher_dsn"],
            Path(case["harness"]["workspace_root"]), case["root"] / "source-manifest.json",
            case["root"] / "environment-manifest.json")
        # Create a real reserved binding under deployment one, then return its
        # lease to pending while preserving that immutable binding.
        command_id = case["group"][18]
        with _bounded_connect(normal._private_dsn(case["harness"]["database"], "dispatcher"),
                             autocommit=True) as dispatcher:
            claim = dispatcher.execute("SELECT ifpmic.claim_delivery(%s)", (command_id,)).fetchone()[0]
            assert claim["status"] == "claimed"
            reserved = dispatcher.execute(
                "SELECT ifpmic.reserve_execution(%s,%s,%s,%s,%s,%s)",
                (command_id, claim["generation"], claim["claim_token"],
                 case["identity"]["build_id"], case["workspace"]["workspace_token"],
                 case["workspace"]["workspace_generation"]),
            ).fetchone()[0]
            assert reserved["status"] == "reserved"
            foreign_reserve_sqlstate = None
            with _bounded_connect(foreign_roles["dispatcher_dsn"], autocommit=True) as foreign_dispatcher:
                try:
                    foreign_dispatcher.execute(
                        "SELECT ifpmic.reserve_execution(%s,%s,%s,%s,%s,%s)",
                        (command_id, claim["generation"], claim["claim_token"],
                         foreign_identity["build_id"], case["workspace"]["workspace_token"],
                         case["workspace"]["workspace_generation"]),
                    ).fetchone()
                except psycopg.errors.InsufficientPrivilege as error:
                    foreign_reserve_sqlstate = error.sqlstate
            assert foreign_reserve_sqlstate == "42501"
            returned = dispatcher.execute(
                "SELECT ifpmic.record_delivery(%s,%s,%s,%s,%s,%s)",
                (command_id, claim["generation"], claim["claim_token"], "retry", None,
                 "DEPENDENCY_UNAVAILABLE"),
            ).fetchone()[0]
            assert returned["status"] == "pending"
        before = crash.read_owner_snapshot(case["harness"], case["job_id"])
        assert len(before["bindings"]) == 1 and before["bindings"][0][20] == "reserved"
        _wait_sql_retry_ready(case["harness"]["database"], command_id, deadline.started + 215)
        process, process_record = _spawn_foreign_dispatcher(case, foreign_config, command_id)
        code = _wait_process(process, deadline.body_deadline)
        assert code == 0
        assert Path(process_record["stdout"]).read_bytes() == b'{"status":"idle"}\n'
        assert Path(process_record["stderr"]).read_bytes() == b""
        after = crash.read_owner_snapshot(case["harness"], case["job_id"])
        assert after["accepted"][16] == before["accepted"][16] == 1
        assert after["bindings"] == before["bindings"]
        assert after["attempts"] == before["attempts"]
        assert after["scopes"] == after["receipts"] == []
        assert after["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
        assert after["accepted"][12:15] == ("accepted", None, None)
        foreign_runs = asyncio.run(accepted_start._list_workflow_runs(
            endpoint2, foreign_identity["namespace"], "ifpmic.job." + case["job_id"],
            deadline.body_deadline))
        normal._write_private(case["root"] / "foreign-server-list-response.json",
                              normal._canonical({"workflow_id": "ifpmic.job." + case["job_id"],
                                                 "runs": foreign_runs}) + b"\n")
        assert foreign_runs == []
        # Admit the same pending command only through deployment one. Stop at
        # the real post-admission hook so the valid run exists while no worker
        # has yet produced a projection receipt.
        dispatcher, dispatcher_record, admission_barrier = crash.start_barrier_dispatcher(
            case, "after_run_admitted")
        admission_barrier.wait(deadline.remaining(30))
        admitted = crash.read_owner_snapshot(case["harness"], case["job_id"])
        assert admitted["bindings"][0][20] == "admitted"
        admitted_run_id = admitted["bindings"][0][19]
        observed_started = asyncio.run(accepted_start._observe_started_direct(
            case["identity"]["server_endpoint"], case["identity"]["namespace"],
            "ifpmic.job." + case["job_id"], {
                "protocol_version": normal.PROTOCOL_VERSION,
                "job_id": case["job_id"], "project_id": case["harness"]["project_id"],
                "binding_sha256": admitted["bindings"][0][18],
            }, "ifpmic.build." + case["identity"]["build_id"], deadline.body_deadline,
            case["root"],
        ))
        assert observed_started["run_id"] == admitted_run_id
        admission_barrier.release()
        assert _wait_process(dispatcher, deadline.body_deadline) == 0
        assert Path(dispatcher_record["stdout"]).read_bytes() == b'{"status":"dispatched"}\n'
        assert Path(dispatcher_record["stderr"]).read_bytes() == b""
        admitted = crash.read_owner_snapshot(case["harness"], case["job_id"])
        assert admitted["bindings"][0][20] == "admitted"
        assert admitted["bindings"][0][19] == admitted_run_id
        assert admitted["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
        assert admitted["receipts"] == []

        binding = admitted["bindings"][0]
        proposal = {
            "protocol_version": normal.PROTOCOL_VERSION, "kind": "activate_create",
            "job_id": case["job_id"], "run_id": admitted_run_id,
            "build_id": case["identity"]["build_id"], "binding_sha256": binding[18],
            "transition_sequence": 1, "expected_revision": 0,
            "command_id": case["group"][18], "command_payload_sha256": case["group"][13],
        }
        proposal_sha = normal._domain_hash("ifpmic.b03.transition.v1", proposal)
        assert proposal_sha == hashlib.sha256(
            b"ifpmic.b03.transition.v1\0" + normal._canonical(proposal)).hexdigest()
        before_projector = crash.read_owner_snapshot(case["harness"], case["job_id"])
        projector_sqlstate = None
        with _bounded_connect(foreign_roles["projector_dsn"],
                             autocommit=True) as projector:
            try:
                projector.execute(
                    "SELECT ifpmic.project_activation(%s,%s,%s,%s,%s,%s,%s)",
                    (case["job_id"], admitted_run_id, case["identity"]["build_id"],
                     1, 0, case["group"][18], proposal_sha),
                ).fetchone()
            except psycopg.errors.InsufficientPrivilege as error:
                projector_sqlstate = error.sqlstate
        assert projector_sqlstate == "42501"
        after_projector = crash.read_owner_snapshot(case["harness"], case["job_id"])
        assert after_projector == before_projector
        # The identical valid proposal succeeds under the owning deployment's
        # projector principal, proving the prior denial was scoped authority.
        with _bounded_connect(normal._private_dsn(case["harness"]["database"], "projector"),
                             autocommit=True) as projector:
            applied = projector.execute(
                "SELECT ifpmic.project_activation(%s,%s,%s,%s,%s,%s,%s)",
                (case["job_id"], admitted_run_id, case["identity"]["build_id"],
                 1, 0, case["group"][18], proposal_sha),
            ).fetchone()[0]
        assert applied["status"] == "applied" and applied["revision"] == 1
        positive = crash.read_owner_snapshot(case["harness"], case["job_id"])
        assert positive["accepted"][3:8] == ("QUEUED", 1, 0, [], None)
        assert positive["bindings"] == before_projector["bindings"]
        assert len(positive["receipts"]) == 1
        assert positive["receipts"][0][4:8] == (
            case["identity"]["build_id"], proposal_sha, 0, "applied")
        registry_after = _registered_deployment_rows(
            case["harness"]["database"], case["identity"]["deployment_id"])
        normal._write_private(case["root"] / "foreign-deployment-sql-observations.json",
                              normal._canonical({"registry_before": registry_before,
                                                 "registry_after": registry_after,
                                                 "foreign_reserve_sqlstate": foreign_reserve_sqlstate,
                                                 "foreign_projector_sqlstate": projector_sqlstate,
                                                 "owning_projector_result": applied,
                                                 "proposal": proposal}) + b"\n")
        assert registry_after == registry_before
        # The current child helper reads this private path at launch; this check
        # guards that the real foreign config was the one selected.
        assert foreign_config.is_file() and foreign_config != case["dispatcher_config"]
        normal._write_private(case["root"] / "foreign-deployment-summary.json", normal._canonical({
            "namespace_shared": True,
            "registered_deployments": sorted([case["identity"]["deployment_id"], deployment_id2]),
            "distinct_loopback_endpoints": sorted([case["identity"]["server_endpoint"], endpoint2]),
            "temporal_store_identity_one": list(case["temporal_store_identity"]),
            "temporal_store_identity_two": list(store_identity2),
            "distinct_storage_directories": store_identity2 != case["temporal_store_identity"],
            "old_binding_preserved": after["bindings"] == before["bindings"],
            "old_deployment_build_immutable": registry_after == registry_before,
            "foreign_outbox_generation": after["accepted"][16],
            "foreign_projector_sqlstate": projector_sqlstate,
            "right_projector_positive_control": applied["status"],
            "valid_proposal_sha256": proposal_sha,
            "foreign_reserve_sqlstate": foreign_reserve_sqlstate,
            "foreign_server_runs": len(foreign_runs),
            "admitted_run_id": admitted_run_id,
        }) + b"\n")
    finally:
        deadline.begin_cleanup()
        try:
            crash.cleanup_case(case)
        finally:
            try:
                if "original_hba" in hba_state:
                    restore_preserving_error(lambda: _restore_foreign_hba(
                        case["harness"], hba_state["original_hba"], request.config))
            finally:
                if foreign_roles is not None:
                    def remove_foreign_logins():
                        removed = _drop_foreign_principals(
                            case["harness"],
                            (foreign_roles["dispatcher_role"], foreign_roles["projector_role"]),
                            lambda: cleanup.remaining(request.config, 4),
                        )
                        assert removed
                        normal._write_private(case["root"] / "foreign-login-cleanup.json",
                                              b'{"foreign_test_logins_dropped":true}\n')
                    restore_preserving_error(remove_foreign_logins)
