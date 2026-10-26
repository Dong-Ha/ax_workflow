"""H2-only real PostgreSQL helpers; G1 keeps its historical trust fixture."""

from __future__ import annotations

import os
import subprocess
import json
import signal
import threading
import time
import traceback
from pathlib import Path

import psycopg
import pytest

from services.ifpmic_api.migrate import MigrationError, apply_migrations


CURRENT_VERSIONS = ["001_initial", "002_auth_retention", "003_workflow_execution", "004_prebinding_incident", "005_admission_read", "006_mock_preflight"]
_H2_DEADLINES: dict[str, dict[str, object]] = {}


def _is_h2_test(item) -> bool:
    item_path = getattr(item, "path", None)
    if item_path is None:
        return False
    watched_paths = {
        Path(__file__).with_name("test_workflow_schema.py").resolve(),
        Path(__file__).with_name("test_prebinding_incident.py").resolve(),
        Path(__file__).with_name("test_execution_protocol.py").resolve(),
        Path(__file__).with_name("test_execution_workspace.py").resolve(),
        Path(__file__).with_name("test_execution_manifest.py").resolve(),
    }
    return Path(item_path).resolve() in watched_paths


def _append_h2_deadline(record: dict[str, object]) -> None:
    raw_path = os.environ.get("IFPMIC_H2_SCHEMA_TIMINGS_PATH")
    if not raw_path:
        return
    path = Path(raw_path)
    if path.is_symlink():
        raise AssertionError("H2 timing evidence path must not be a symlink")
    previous = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    if not isinstance(previous, list):
        raise AssertionError("H2 timing evidence must be a JSON array")
    payload = (json.dumps(previous + [record], sort_keys=True, separators=(",", ":")) + "\n").encode()
    temporary = path.with_name(f"{path.name}.tmp.{os.getpid()}.{time.monotonic_ns()}")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.fchmod(fd, 0o600)
        view = memoryview(payload)
        while view:
            count = os.write(fd, view)
            if count <= 0:
                raise OSError("short H2 timing evidence write")
            view = view[count:]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temporary, path)


def capture_private_migration_context(error: MigrationError, case_id: str) -> None:
    """Persist private root-cause details behind the migration's fixed public code."""
    raw_path = os.environ.get("IFPMIC_H2_SCHEMA_DIAGNOSTICS_PATH")
    if not raw_path:
        return
    path = Path(raw_path)
    if path.is_symlink():
        raise AssertionError("H2 migration diagnostic path must not be a symlink")
    existing = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    if not isinstance(existing, list):
        raise AssertionError("H2 migration diagnostic evidence must be an array")
    chain = []
    current = error.__context__
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        frames = traceback.extract_tb(current.__traceback__) if current.__traceback__ else []
        chain.append({
            "type": type(current).__name__,
            "message": str(current),
            "frames": [{"file": Path(frame.filename).name, "line": frame.lineno, "function": frame.name}
                       for frame in frames],
        })
        current = current.__context__
    record = {"case_id": case_id, "fixed_code": error.code, "cause_chain": chain}
    payload = (json.dumps(existing + [record], sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    temporary = path.with_name(f"{path.name}.tmp.{os.getpid()}.{time.monotonic_ns()}")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.fchmod(fd, 0o600)
        view = memoryview(payload)
        while view:
            count = os.write(fd, view)
            if count <= 0:
                raise OSError("short H2 migration diagnostic write")
            view = view[count:]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temporary, path)


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    if not _is_h2_test(item) or not report.failed or call.excinfo is None:
        return
    error = call.excinfo.value
    if isinstance(error, MigrationError):
        try:
            capture_private_migration_context(error, item.nodeid)
        except OSError:
            # Preserve the original test failure if private evidence storage
            # itself is unavailable; the runner still records its failure log.
            pass


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_setup(item):
    if not _is_h2_test(item):
        return
    if threading.current_thread() is not threading.main_thread():
        raise AssertionError("H2 per-test watchdog requires the main thread")
    state = {
        "nodeid": item.nodeid,
        "monotonic_body_start": time.monotonic(),
        "monotonic_body_end": None,
        "monotonic_cleanup_start": None,
        "monotonic_cleanup_end": None,
        "body_timeout_triggered": False,
        "cleanup_timeout_triggered": False,
        "timeout_outcome": "none",
        "_prior_handler": signal.getsignal(signal.SIGALRM),
        "_prior_timer": signal.getitimer(signal.ITIMER_REAL),
    }

    def body_timeout(_signum, _frame):
        state["body_timeout_triggered"] = True
        state["timeout_outcome"] = "body_timeout"
        raise TimeoutError("H2 test body exceeded 25 seconds")

    state["_body_timeout"] = body_timeout
    _H2_DEADLINES[item.nodeid] = state
    signal.signal(signal.SIGALRM, body_timeout)
    signal.setitimer(signal.ITIMER_REAL, 25)


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_call(item):
    state = _H2_DEADLINES.get(item.nodeid) if _is_h2_test(item) else None
    try:
        yield
    finally:
        if state is not None:
            signal.setitimer(signal.ITIMER_REAL, 0)
            state["monotonic_body_end"] = time.monotonic()
            signal.signal(signal.SIGALRM, state["_prior_handler"])
            prior = state["_prior_timer"]
            if prior[0] > 0:
                signal.setitimer(signal.ITIMER_REAL, *prior)


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_teardown(item):
    state = _H2_DEADLINES.get(item.nodeid) if _is_h2_test(item) else None
    if state is None:
        yield
        return
    state["monotonic_cleanup_start"] = time.monotonic()

    def cleanup_timeout(_signum, _frame):
        state["cleanup_timeout_triggered"] = True
        state["timeout_outcome"] = "cleanup_timeout"
        raise TimeoutError("H2 fixture cleanup exceeded 5 seconds")

    prior_handler = signal.getsignal(signal.SIGALRM)
    prior_timer = signal.getitimer(signal.ITIMER_REAL)
    signal.signal(signal.SIGALRM, cleanup_timeout)
    signal.setitimer(signal.ITIMER_REAL, 5)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        state["monotonic_cleanup_end"] = time.monotonic()
        signal.signal(signal.SIGALRM, prior_handler)
        if prior_timer[0] > 0:
            signal.setitimer(signal.ITIMER_REAL, *prior_timer)


def pytest_runtest_logfinish(nodeid, location):
    state = _H2_DEADLINES.pop(nodeid, None)
    if state is None:
        return
    now = time.monotonic()
    if state["monotonic_body_end"] is None:
        state["monotonic_body_end"] = now
    if state["monotonic_cleanup_start"] is None:
        state["monotonic_cleanup_start"] = now
    if state["monotonic_cleanup_end"] is None:
        state["monotonic_cleanup_end"] = now
    signal.setitimer(signal.ITIMER_REAL, 0)
    signal.signal(signal.SIGALRM, state["_prior_handler"])
    prior = state["_prior_timer"]
    if prior[0] > 0:
        signal.setitimer(signal.ITIMER_REAL, *prior)
    record = {key: value for key, value in state.items() if not key.startswith("_")}
    record["elapsed_seconds"] = float(record["monotonic_cleanup_end"]) - float(record["monotonic_body_start"])
    _append_h2_deadline(record)


def _pg_ctl(cluster, *args: str, cleanup_config=None) -> subprocess.CompletedProcess:
    from tests.ifpmic_api.h2_fixture_cleanup import remaining

    env = {
        "PATH": f"{cluster.binaries['pg_ctl'].parent}{os.pathsep}/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }
    return subprocess.run(
        [str(cluster.binaries["pg_ctl"]), "-D", str(cluster.data_dir), *args],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=remaining(cleanup_config, 10),
        check=False,
        env=env,
    )


def _reload_hba(cluster, *, cleanup_config=None) -> None:
    completed = _pg_ctl(cluster, "reload", cleanup_config=cleanup_config)
    if completed.returncode != 0:
        raise RuntimeError("private PostgreSQL HBA reload failed")


@pytest.fixture
def workflow_scram_hba(pg_cluster, pg_roles, request):
    """Require password authentication for every H2 service principal.

    The dedicated rules precede the historical local-trust fallback, so a
    service role can never accidentally authenticate through that rule.
    The migration owner and bootstrap user retain the isolated G1 trust path.
    """
    path = pg_cluster.data_dir / "pg_hba.conf"
    original = path.read_bytes()
    rules = "".join(
        f"local all {role} scram-sha-256\n"
        for role in (pg_roles.runtime, pg_roles.operator, pg_roles.dispatcher, pg_roles.projector)
    ).encode("ascii")
    path.write_bytes(rules + original)
    try:
        _reload_hba(pg_cluster)
        with psycopg.connect(pg_cluster.dsn(), autocommit=True) as bootstrap:
            rows = bootstrap.execute(
                "SELECT line_number,type,database,user_name,auth_method FROM pg_hba_file_rules "
                "WHERE line_number <= 4 ORDER BY line_number"
            ).fetchall()
        expected = [
            (line_number, "local", ["all"], [role], "scram-sha-256")
            for line_number, role in enumerate(
                (pg_roles.runtime, pg_roles.operator, pg_roles.dispatcher, pg_roles.projector), start=1
            )
        ]
        assert rows == expected
        # Confirm the reloaded rules are active for a fresh connection before
        # any test starts migrations or relies on catalog inspection.
        with psycopg.connect(
            pg_cluster.dsn(user=pg_roles.dispatcher, password=pg_roles.dispatcher_password),
            connect_timeout=2,
        ) as dispatcher:
            assert dispatcher.execute("SELECT session_user").fetchone() == (pg_roles.dispatcher,)
        with pytest.raises(psycopg.OperationalError):
            psycopg.connect(
                pg_cluster.dsn(user=pg_roles.dispatcher),
                connect_timeout=2,
            )
        yield
    finally:
        from tests.ifpmic_api import h2_fixture_cleanup as cleanup

        restored = False
        try:
            path.write_bytes(original)
            _reload_hba(pg_cluster, cleanup_config=request.config)
            restored = True
        finally:
            cleanup.record_finalizer(request.config, "hba_restored", restored=restored)


@pytest.fixture
def workflow_schema_db(pg_cluster, migration_db, workflow_scram_hba):
    applied = migration_db.migrate_current(pg_cluster)
    assert applied == {"applied": CURRENT_VERSIONS, "unchanged": []}
    return migration_db, pg_cluster


def seed_legacy_create(connection, *, owner_id: str, project_id: str, snapshot_id: str,
                       command_id: str, job_id: str, command_key: str = "legacy-create") -> dict[str, str]:
    """Seed one internally consistent 001/002 job/command before 003 backfill."""
    version_key = "1" * 64
    record_bytes = b'{"fixture":"h2-backfill"}'
    import hashlib

    record_hash = hashlib.sha256(record_bytes).hexdigest()
    payload_text = r'{"request_text":"\u03a9 \ud83d\ude00 quote \" slash \\ nul \u0000"}'
    payload_hash = hashlib.sha256(payload_text.encode("ascii")).hexdigest()
    connection.execute(
        "INSERT INTO ifpmic.users(user_id,identity_subject,display_name) VALUES(%s,%s,%s)",
        (owner_id, f"subject:{owner_id}", "Synthetic H2 Owner"),
    )
    connection.execute("INSERT INTO ifpmic.projects(project_id) VALUES(%s)", (project_id,))
    connection.execute(
        "INSERT INTO ifpmic.profile_catalog(project_id,version_key,snapshot_id,record_bytes,record_bytes_sha256,"
        "profile_version_json,mode,enabled,configuration_complete) VALUES(%s,%s,%s,%s,%s,%s,'mock',true,true)",
        (project_id, version_key, snapshot_id, record_bytes, record_hash, '"v1"'),
    )
    connection.execute(
        "INSERT INTO ifpmic.jobs(job_id,owner_id,project_id,snapshot_id,workflow_id) VALUES(%s,%s,%s,%s,'ifpmic-sw-v1')",
        (job_id, owner_id, project_id, snapshot_id),
    )
    connection.execute(
        "INSERT INTO ifpmic.commands(command_id,actor_id,route,idempotency_key,project_id,job_id,"
        "command_payload_json,payload_sha256) VALUES(%s,%s,'POST /api/v1/jobs',%s,%s,%s,%s,%s)",
        (command_id, owner_id, command_key, project_id, job_id, payload_text, payload_hash),
    )
    connection.execute("INSERT INTO ifpmic.commands_outbox(command_id) VALUES(%s)", (command_id,))
    connection.execute("INSERT INTO ifpmic.workspace_intents(job_id,command_id) VALUES(%s,%s)", (job_id, command_id))
    return {
        "owner_id": owner_id,
        "project_id": project_id,
        "snapshot_id": snapshot_id,
        "job_id": job_id,
        "command_id": command_id,
        "version_key": version_key,
        "record_hash": record_hash,
        "payload_text": payload_text,
        "payload_hash": payload_hash,
    }
