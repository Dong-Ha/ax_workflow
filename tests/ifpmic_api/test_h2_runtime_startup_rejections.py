"""Real CLI startup rejection cases: no claim and no Temporal connection."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import select
import signal
import socket
import stat
import subprocess
import sys
import time
from uuid import uuid4

import psycopg
from tests.ifpmic_api.h2_native_bounds import bounded_connect, bounded_harness
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg import sql
import pytest

from tests.ifpmic_api import test_h2_runtime_normal_flow as normal
from tests.ifpmic_api.h2_startup_case_budget import CASE_IDS
from tests.ifpmic_api.jobs_fixture import owner_dsn

pytest_plugins = (
    "tests.ifpmic_api.jobs_fixture",
    "tests.ifpmic_api.workspace_fixture",
    "tests.ifpmic_api.workflow_schema_fixture",
)

EXPECTED_STDOUT = b'{"error":{"code":"DEPENDENCY_UNAVAILABLE"}}\n'
MAX_OPERATION_SECONDS = 30


class PassiveLoopbackListener:
    """A private TCP listener that counts incoming connects but serves nothing."""

    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(16)
        self.sock.setblocking(False)
        self.port = self.sock.getsockname()[1]
        self.connections = 0

    @property
    def endpoint(self):
        return f"127.0.0.1:{self.port}"

    def drain(self, duration=0.15):
        until = time.monotonic() + duration
        while time.monotonic() < until:
            readable, _, _ = select.select([self.sock], [], [], min(0.02, until - time.monotonic()))
            if not readable:
                continue
            while True:
                try:
                    connection, _address = self.sock.accept()
                except BlockingIOError:
                    break
                self.connections += 1
                connection.close()
        return self.connections

    def close(self):
        self.sock.close()


def _startup_evidence_root():
    raw = os.environ.get("IFPMIC_H2_RUNTIME_EVIDENCE_ROOT")
    assert raw is not None
    path = Path(raw)
    info = path.lstat()
    assert path.is_absolute() and stat.S_ISDIR(info.st_mode)
    assert info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700
    assert not path.is_symlink()
    return path


def _new_private_dir(path):
    path.mkdir(mode=0o700, parents=False, exist_ok=False)
    path.chmod(0o700)
    info = path.lstat()
    assert stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
    assert stat.S_IMODE(info.st_mode) == 0o700
    return path


def _write_private(path: Path, raw: bytes):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        view = memoryview(raw)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError("short private startup evidence write")
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)


def _write_journal(path, value):
    raw = normal._canonical({key: str(item) if isinstance(item, Path) else item
                             for key, item in value.items()}) + b"\n"
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        assert stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
        assert info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600
        view = memoryview(raw)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError("short process journal write")
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)


def _register_startup_identity(harness, identity, variant):
    migration, _cluster = harness["database"]
    roles = migration.roles
    with bounded_connect(owner_dsn(harness["database"]), autocommit=True) as owner:
        role_oids = dict(owner.execute(
            "SELECT rolname,oid::bigint FROM pg_roles WHERE rolname=ANY(%s)",
            ([roles.dispatcher, roles.projector],),
        ).fetchall())
        assert set(role_oids) == {roles.dispatcher, roles.projector}
        if variant in ("missing_deployment_dispatcher", "no_job_missing_registration"):
            return {"dispatcher": role_oids[roles.dispatcher], "projector": role_oids[roles.projector]}
        owner.execute(
            "INSERT INTO ifpmic.execution_deployments"
            "(deployment_id,namespace,server_endpoint,server_config_sha256,enabled) "
            "VALUES(%s,%s,%s,%s,%s)",
            (identity["deployment_id"], identity["namespace"], identity["server_endpoint"],
             identity["server_config_sha256"], variant != "disabled_deployment_dispatcher"),
        )
        expected_build = identity["build_id"]
        registry_build = _alternate_build_id() if variant in (
            "build_mismatch_dispatcher", "build_mismatch_projector") else expected_build
        build_present = variant not in ("missing_dispatcher_build",)
        if build_present:
            disabled = variant in ("disabled_dispatcher_build", "disabled_projector_build")
            source_hash = identity["source_manifest_sha256"] if registry_build == expected_build else "a" * 64
            environment_hash = (identity["environment_manifest_sha256"]
                                if registry_build == expected_build else "b" * 64)
            owner.execute(
                "INSERT INTO ifpmic.engine_builds"
                "(deployment_id,build_id,source_manifest_sha256,environment_manifest_sha256,"
                "workflow_type,task_queue,protocol_version,enabled) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)",
                (identity["deployment_id"], registry_build, source_hash, environment_hash,
                 normal.WORKFLOW_TYPE, "ifpmic.build." + registry_build,
                 normal.PROTOCOL_VERSION, not disabled),
            )
        if variant != "missing_dispatcher_principal":
            owner.execute(
                "INSERT INTO ifpmic.worker_principals(role_oid,role_name,kind,deployment_id,build_id,active) "
                "VALUES(%s,%s,'dispatcher',%s,NULL,%s)",
                (role_oids[roles.dispatcher], roles.dispatcher, identity["deployment_id"],
                 variant != "disabled_dispatcher_principal"),
            )
        if (build_present and variant not in (
                "missing_projector_principal", "missing_dispatcher_build", "build_mismatch_dispatcher")):
            projector_build = (registry_build if variant == "build_mismatch_projector" else expected_build)
            owner.execute(
                "INSERT INTO ifpmic.worker_principals(role_oid,role_name,kind,deployment_id,build_id,active) "
                "VALUES(%s,%s,'projector',%s,%s,%s)",
                (role_oids[roles.projector], roles.projector, identity["deployment_id"], projector_build,
                 variant != "disabled_projector_principal"),
            )
    return {"dispatcher": role_oids[roles.dispatcher], "projector": role_oids[roles.projector]}


def _owner_counts(harness):
    tables = (
        "jobs", "commands", "commands_outbox", "workspace_intents",
        "execution_bindings", "worker_run_scopes", "projection_receipts", "delivery_attempts",
    )
    counts = {}
    with bounded_connect(owner_dsn(harness["database"])) as owner:
        for table in tables:
            counts[table] = owner.execute(
                sql.SQL("SELECT count(*) FROM ifpmic.{}").format(sql.Identifier(table))
            ).fetchone()[0]
    return counts


def _deployment_digest(identity):
    document = {
        "protocol_version": normal.PROTOCOL_VERSION,
        "deployment_id": identity["deployment_id"],
        "namespace": identity["namespace"],
        "server_endpoint": identity["server_endpoint"],
    }
    return normal._domain_hash("ifpmic.b03.deployment.v1", document)


def _alternate_build_id():
    return normal._domain_hash("ifpmic.b03.startup.alternate-build.v1", {"case": "fixed-other-build"})


def _recreate_dispatcher_role(case):
    harness, database, cluster = case["harness"], case["harness"]["database"][0], case["harness"]["database"][1]
    role_name = database.roles.dispatcher
    new_password = uuid4().hex + uuid4().hex
    case["recreated_role"] = {"name": role_name, "password": new_password,
                              "original_password": database.roles.dispatcher_password,
                              "new_oid": None}
    with bounded_connect(cluster.dsn(database=database.name), autocommit=True) as bootstrap:
        bootstrap.execute(sql.SQL("DROP OWNED BY {}").format(sql.Identifier(role_name)))
    with bounded_connect(cluster.dsn(), autocommit=True) as bootstrap:
        bootstrap.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(role_name)))
        bootstrap.execute(sql.SQL(
            "CREATE ROLE {} LOGIN PASSWORD {} NOSUPERUSER NOCREATEDB NOCREATEROLE "
            "NOBYPASSRLS NOINHERIT"
        ).format(sql.Identifier(role_name), sql.Literal(new_password)))
    with bounded_connect(owner_dsn(case["harness"]["database"]), autocommit=True) as owner:
        owner.execute(sql.SQL("GRANT USAGE ON SCHEMA ifpmic TO {}").format(sql.Identifier(role_name)))
        owner.execute(sql.SQL("GRANT EXECUTE ON FUNCTION ifpmic.read_dispatch_config() TO {}").format(
            sql.Identifier(role_name)))
        oid = owner.execute("SELECT oid::bigint FROM pg_roles WHERE rolname=%s", (role_name,)).fetchone()[0]
    case["recreated_role"]["new_oid"] = oid
    return case["recreated_role"]


def _restore_recreated_dispatcher_role(case):
    info = case.get("recreated_role")
    if info is None:
        return
    database, cluster = case["harness"]["database"]
    role_name, password = info["name"], info["original_password"]
    with bounded_connect(cluster.dsn(), autocommit=True) as bootstrap:
        exists = bootstrap.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (role_name,)).fetchone()
        if exists is None:
            bootstrap.execute(sql.SQL(
                "CREATE ROLE {} LOGIN PASSWORD {} NOSUPERUSER NOCREATEDB NOCREATEROLE "
                "NOBYPASSRLS NOINHERIT"
            ).format(sql.Identifier(role_name), sql.Literal(password)))
        else:
            bootstrap.execute(sql.SQL("ALTER ROLE {} PASSWORD {}").format(
                sql.Identifier(role_name), sql.Literal(password)))
    with bounded_connect(owner_dsn(case["harness"]["database"]), autocommit=True) as owner:
        owner.execute(sql.SQL("GRANT USAGE ON SCHEMA ifpmic TO {}").format(sql.Identifier(role_name)))
        owner.execute(sql.SQL("GRANT EXECUTE ON FUNCTION ifpmic.read_dispatch_config() TO {}").format(
            sql.Identifier(role_name)))


def _make_case(harness, variant, deadline):
    harness = bounded_harness(harness)
    case = {"harness": harness, "variant": variant, "process": None,
            "listener": None, "listeners": [], "registry_listener": None,
            "recreated_role": None}
    try:
        if variant == "no_job_missing_registration":
            before_counts = _owner_counts(harness)
            assert before_counts == {table: 0 for table in before_counts}
            case["before_counts"] = before_counts
        else:
            accepted = normal.accept_workspace_job(harness, key="h2-startup-rejection-" + variant)
            job_id = accepted["job_id"]
            group = normal.workspace_rows(harness, job_id)
            assert group is not None
            workspace, tree_before = normal._workspace_ready(
                harness, Path(harness["workspace_root"]), job_id)
            before = normal._read_owner_snapshot(harness, job_id)
            assert before["accepted"][3:8] == ("DRAFT", 0, 0, [], None)
            assert before["accepted"][12:17] == ("accepted", None, None, "pending", 0)
            assert before["bindings"] == before["scopes"] == before["receipts"] == before["attempts"] == []
            assert before["noncreate_commands"] == 0
            case.update({"accepted": accepted, "job_id": job_id, "group": group,
                         "workspace": workspace, "tree_before": tree_before, "before": before})

        evidence_root = _startup_evidence_root()
        case_root = _new_private_dir(evidence_root / ("startup-" + variant))
        case["root"] = case_root
        journal = case_root / "process-journal.jsonl"
        normal._create_private_journal(journal)
        case["journal"] = journal
        listener = PassiveLoopbackListener()
        case["listener"] = listener
        case["listeners"].append(listener)
        registry_listener = None
        if variant == "endpoint_mismatch":
            registry_listener = PassiveLoopbackListener()
            case["registry_listener"] = registry_listener
            case["listeners"].append(registry_listener)

        source_value, env_value = normal.source_manifest(), normal.environment_manifest()
        source_sha, env_sha = normal._manifest_hash(source_value), normal._manifest_hash(env_value)
        source_path, env_path = case_root / "source.json", case_root / "environment.json"
        normal._write_private(source_path, normal._canonical(source_value) + b"\n")
        normal._write_private(env_path, normal._canonical(env_value) + b"\n")
        deployment_id = "h2-startup-" + uuid4().hex
        registry_endpoint = registry_listener.endpoint if registry_listener is not None else listener.endpoint
        registry_identity = {
            "deployment_id": deployment_id, "namespace": normal.NAMESPACE,
            "server_endpoint": registry_endpoint,
            "source_manifest_sha256": source_sha, "environment_manifest_sha256": env_sha,
        }
        registry_identity["server_config_sha256"] = _deployment_digest(registry_identity)
        build_document = {
            "protocol_version": normal.PROTOCOL_VERSION,
            "source_manifest_sha256": source_sha,
            "environment_manifest_sha256": env_sha,
            "workflow_type": normal.WORKFLOW_TYPE,
        }
        registry_identity["build_id"] = normal._domain_hash("ifpmic.b03.build.v1", build_document)
        case["roles"] = _register_startup_identity(harness, registry_identity, variant)
        identity = dict(registry_identity)
        if variant == "endpoint_mismatch":
            identity["server_endpoint"] = listener.endpoint
            identity["server_config_sha256"] = _deployment_digest(identity)
        elif variant == "namespace_mismatch":
            identity["namespace"] = "startup-other-namespace"
            identity["server_config_sha256"] = _deployment_digest(identity)
        elif variant == "deployment_mismatch":
            identity["deployment_id"] = "other-" + uuid4().hex
            identity["server_config_sha256"] = _deployment_digest(identity)
        case["identity"] = identity

        if variant == "source_manifest_mismatch":
            altered = dict(source_value)
            altered["files"] = {**source_value["files"], "untrusted/source.py": "a" * 64}
            source_path = case_root / "source-mismatch.json"
            normal._write_private(source_path, normal._canonical(altered) + b"\n")
        elif variant == "environment_manifest_mismatch":
            altered = dict(env_value)
            altered["files"] = {**env_value["files"], "untrusted/module.py": "b" * 64}
            env_path = case_root / "environment-mismatch.json"
            normal._write_private(env_path, normal._canonical(altered) + b"\n")
        dispatcher_dsn = normal._private_dsn(harness["database"], "dispatcher")
        worker_dsn = normal._private_dsn(harness["database"], "projector")
        mode = ("worker" if variant in {
            "missing_projector_principal", "disabled_projector_principal",
            "disabled_projector_build", "build_mismatch_projector", "wrong_projector_role",
        } else "dispatcher")
        if variant == "wrong_dispatcher_role":
            dispatcher_dsn = worker_dsn
        elif variant == "wrong_projector_role":
            worker_dsn = dispatcher_dsn
        elif variant == "wrong_dispatcher_password":
            fields = conninfo_to_dict(dispatcher_dsn)
            fields["password"] = "incorrect-startup-password"
            dispatcher_dsn = make_conninfo(**fields)
        if variant == "recreated_dispatcher_role_oid":
            recreated = _recreate_dispatcher_role(case)
            with bounded_connect(owner_dsn(harness["database"])) as owner:
                owner.execute(sql.SQL("GRANT USAGE ON SCHEMA ifpmic TO {}").format(
                    sql.Identifier(recreated["name"])))
                owner.execute(sql.SQL("GRANT EXECUTE ON FUNCTION ifpmic.read_dispatch_config() TO {}").format(
                    sql.Identifier(recreated["name"])))
            fields = conninfo_to_dict(dispatcher_dsn)
            fields["password"] = recreated["password"]
            dispatcher_dsn = make_conninfo(**fields)
        config_dsn = worker_dsn if mode == "worker" else dispatcher_dsn
        config = normal._write_runtime_config(
            case_root, mode, identity, config_dsn, Path(harness["workspace_root"]), source_path, env_path,
        )
        case.update({"mode": mode, "config": config, "source_path": source_path,
                     "environment_path": env_path, "registry_identity": registry_identity})
        return case
    except BaseException:
        _cleanup_case(case, deadline, preserve_primary=True)
        raise


def _launch_rejected_cli(case, deadline):
    variant, config = case["variant"], case["config"]
    cache = _new_private_dir(case["root"] / "pycache")
    env = normal._minimal_runtime_env(case["root"], config)
    args = [sys.executable, "-B", "-X", "pycache_prefix=" + str(cache),
            "-m", "services.ifpmic_api.execution_runtime"]
    process = subprocess.Popen(args, cwd=normal.REPO_ROOT, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               env=env, start_new_session=True)
    case["process"] = process
    ticks = normal.process_identity(process.pid)
    case["process_start_ticks"] = ticks
    _write_journal(case["journal"], {"event": "started", "role": case["mode"],
                                      "pid": process.pid, "start_ticks": ticks})
    _write_journal(case["journal"], {"event": "stop_requested", "pid": process.pid,
                                      "start_ticks": ticks, "pre_stop_exit_code": process.poll(),
                                      "mode": "await-fixed-startup-rejection"})
    forced = False
    try:
        stdout, stderr = process.communicate(timeout=deadline.remaining(MAX_OPERATION_SECONDS))
    except subprocess.TimeoutExpired:
        forced = True
        process.kill()
        stdout, stderr = process.communicate(timeout=5)
    absent = normal.process_identity(process.pid) != ticks
    _write_journal(case["journal"], {"event": "stopped", "pid": process.pid,
                                      "start_ticks": ticks, "exit_code": process.returncode,
                                      "absent": absent, "forced": forced})
    connection_counts = {
        "configured_endpoint": case["listener"].drain(),
        "registered_endpoint": (case["registry_listener"].drain()
                                if case["registry_listener"] is not None else 0),
    }
    _write_journal(case["journal"], {"event": "listeners_drained", "counts": connection_counts})
    connections = connection_counts["configured_endpoint"]
    case["process_outcome"] = {"returncode": process.returncode, "forced": forced,
                               "absent": absent, "stdout": stdout, "stderr": stderr,
                               "listener_connections": connections,
                               "listener_connection_counts": connection_counts}
    case["listener_connections"] = connections
    case["listener_connection_counts"] = connection_counts
    assert process.returncode == 3 and forced is False and absent is True
    assert stdout == EXPECTED_STDOUT and stderr == b""
    assert all(value == 0 for value in connection_counts.values())
    return {"returncode": process.returncode, "forced": forced, "absent": absent,
            "stdout_sha256": hashlib.sha256(stdout).hexdigest(),
            "stderr_sha256": hashlib.sha256(stderr).hexdigest(),
            "listener_connection_count": connections,
            "listener_connection_counts": connection_counts}


def _cleanup_case(case, deadline, *, preserve_primary=False):
    errors = []
    if not deadline.cleanup_started:
        deadline.begin_cleanup()
    process = case.get("process")
    if process is not None:
        try:
            if process.poll() is None:
                _write_journal(case["journal"], {
                    "event": "stop_requested", "pid": process.pid,
                    "start_ticks": case.get("process_start_ticks"),
                    "pre_stop_exit_code": None, "mode": "cleanup-kill",
                })
                process.kill()
                process.wait(timeout=5)
            if case.get("process_outcome") is None:
                _write_journal(case["journal"], {
                    "event": "stopped", "pid": process.pid,
                    "start_ticks": case.get("process_start_ticks"),
                    "exit_code": process.poll(),
                    "absent": normal.process_identity(process.pid) != case.get("process_start_ticks"),
                    "forced": process.returncode == -signal.SIGKILL,
                })
        except BaseException as error:
            errors.append(type(error).__name__)
    listeners = {
        "configured_endpoint": case.get("listener"),
        "registered_endpoint": case.get("registry_listener"),
    }
    cleanup_counts = {}
    for label, listener in listeners.items():
        if listener is None:
            cleanup_counts[label] = 0
            continue
        try:
            cleanup_counts[label] = listener.drain(0.05)
            if cleanup_counts[label] and not preserve_primary:
                errors.append("UNEXPECTED_LISTENER_CONNECTION")
        except BaseException as error:
            errors.append(type(error).__name__)
            cleanup_counts[label] = "drain_error"
        finally:
            try:
                listener.close()
            except BaseException as error:
                errors.append(type(error).__name__)
    case["cleanup_listener_connection_counts"] = cleanup_counts
    if case.get("journal") is not None:
        try:
            _write_journal(case["journal"], {"event": "cleanup_listeners_drained",
                                              "counts": cleanup_counts})
        except BaseException as error:
            errors.append(type(error).__name__)
    try:
        _restore_recreated_dispatcher_role(case)
    except BaseException as error:
        errors.append(type(error).__name__)
    if case.get("root") is not None:
        try:
            before = case.get("before")
            if before is not None:
                after = normal._read_owner_snapshot(case["harness"], case["job_id"])
                assert after == before
                assert normal.tree_fingerprint(
                    Path(case["harness"]["workspace_root"]) / case["job_id"]
                ) == case["tree_before"]
                result = case.get("process_outcome", {})
                evidence = {
                    "case_id": case["variant"], "snapshot_unchanged": after == before,
                    "snapshot_sha256": hashlib.sha256(normal._canonical(after)).hexdigest(),
                    "workspace_unchanged": True, "process": {
                        "returncode": result.get("returncode"), "forced": result.get("forced"),
                        "absent": result.get("absent"),
                        "stdout_sha256": hashlib.sha256(result.get("stdout", b"")).hexdigest(),
                        "stderr_sha256": hashlib.sha256(result.get("stderr", b"")).hexdigest(),
                    },
                    "listener_connection_count": case.get("listener_connections", 0),
                    "listener_connection_counts": case.get("listener_connection_counts", {}),
                    "cleanup_listener_connection_counts": case.get("cleanup_listener_connection_counts", {}),
                }
                normal._write_private(case["root"] / "startup-rejection-result.json",
                                      normal._canonical(evidence) + b"\n")
            elif case.get("before_counts") is not None:
                after_counts = _owner_counts(case["harness"])
                assert after_counts == case["before_counts"]
                assert after_counts == {table: 0 for table in after_counts}
                result = case.get("process_outcome", {})
                evidence = {
                    "case_id": case["variant"], "no_job_bootstrap": True,
                    "counts_before": case["before_counts"], "counts_after": after_counts,
                    "counts_unchanged": after_counts == case["before_counts"],
                    "process": {
                        "returncode": result.get("returncode"), "forced": result.get("forced"),
                        "absent": result.get("absent"),
                        "stdout_sha256": hashlib.sha256(result.get("stdout", b"")).hexdigest(),
                        "stderr_sha256": hashlib.sha256(result.get("stderr", b"")).hexdigest(),
                    },
                    "listener_connection_count": case.get("listener_connections", 0),
                    "listener_connection_counts": case.get("listener_connection_counts", {}),
                    "cleanup_listener_connection_counts": case.get("cleanup_listener_connection_counts", {}),
                }
                normal._write_private(case["root"] / "startup-rejection-result.json",
                                      normal._canonical(evidence) + b"\n")
        except BaseException as error:
            errors.append(type(error).__name__)
    if errors and not preserve_primary:
        raise AssertionError("startup case cleanup evidence: " + ",".join(errors))


@pytest.fixture
def h2_startup_case_deadline(request):
    try:
        return request.node._ifpmic_h2_startup_deadline
    except AttributeError:
        pytest.fail("the H2 startup watchdog plugin must be loaded by the runner")


@pytest.mark.parametrize("startup_variant", CASE_IDS, ids=CASE_IDS)
def test_runtime_cli_rejects_registry_and_identity_mismatches(
    workflow_scram_hba, workspace_environment, h2_startup_case_deadline, startup_variant,
):
    deadline = h2_startup_case_deadline
    case = {"variant": startup_variant, "harness": workspace_environment,
            "process": None, "listener": None, "process_outcome": None}
    primary_failed = False
    try:
        case = _make_case(workspace_environment, startup_variant, deadline)
        process_evidence = _launch_rejected_cli(case, deadline)
        case["listener_connections"] = process_evidence["listener_connection_count"]
        case["listener_connection_counts"] = process_evidence["listener_connection_counts"]
        if startup_variant == "no_job_missing_registration":
            after_counts = _owner_counts(workspace_environment)
            assert after_counts == case["before_counts"]
            assert after_counts == {table: 0 for table in after_counts}
            case["after_counts"] = after_counts
        else:
            after = normal._read_owner_snapshot(case["harness"], case["job_id"])
            assert after == case["before"]
            assert after["accepted"][12:17] == ("accepted", None, None, "pending", 0)
            assert after["bindings"] == after["scopes"] == after["receipts"] == after["attempts"] == []
            assert after["noncreate_commands"] == 0
        assert all(value == 0 for value in process_evidence["listener_connection_counts"].values())
    except BaseException:
        primary_failed = True
        raise
    finally:
        deadline.begin_cleanup()
        _cleanup_case(case, deadline, preserve_primary=primary_failed)
