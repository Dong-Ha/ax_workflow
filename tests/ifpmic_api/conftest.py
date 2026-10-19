"""Isolated real-PostgreSQL fixtures for the IFPMIC API tests.

The fixture never reads or reuses Paperclip database configuration. It starts
only the pinned embedded PostgreSQL 18.1 binaries on a private Unix socket.
"""

from __future__ import annotations

import os
import json
import math
import secrets
import shutil
import subprocess
import stat
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from uuid import uuid4

import pytest
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from tests.ifpmic_api import h2_fixture_cleanup as h2_cleanup


REPO_ROOT = Path(__file__).resolve().parents[2]
PG_BIN_DIR = (
    REPO_ROOT
    / ".paperclip-lab/runtime/node_modules/@embedded-postgres/linux-x64/native/bin"
)
PG_BIN_NAMES = ("initdb", "pg_ctl", "postgres")
PG_PORT = 55491  # Only the Unix socket name uses this; TCP listening is disabled.
PG_BOOTSTRAP_USER = "ifpmic_g1_bootstrap"


@dataclass
class PgCluster:
    root: Path
    data_dir: Path
    socket_dir: Path
    log_path: Path
    port: int
    binaries: dict[str, Path]
    binary_versions: dict[str, str]
    binary_sha256: dict[str, str]
    server_pid: int
    server_start_ticks: str | None = None
    initial_server_pid: int | None = None
    initial_server_start_ticks: str | None = None
    lifecycle_path: Path | None = None
    lifecycle: list[dict[str, object]] = field(default_factory=list)

    def persist_lifecycle(self, *, stop_status: str = "not_stopped", pid_alive: bool | None = None) -> None:
        if self.lifecycle_path is None:
            return
        self.lifecycle_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        document = {
            "private": True,
            "root": str(self.root),
            "data_dir": str(self.data_dir),
            "socket_dir": str(self.socket_dir),
            "pg_ctl_path": str(self.binaries["pg_ctl"]),
            "server_pid": self.server_pid,
            "server_start_ticks": self.server_start_ticks,
            "initial_server_pid": self.initial_server_pid,
            "initial_server_start_ticks": self.initial_server_start_ticks,
            "stop_status": stop_status,
            "pid_alive": pid_alive,
            "binary_versions": self.binary_versions,
            "binary_sha256": self.binary_sha256,
            "lifecycle": self.lifecycle,
        }
        temporary = self.lifecycle_path.with_name(self.lifecycle_path.name + ".tmp")
        temporary.write_text(json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
        temporary.chmod(0o600)
        os.replace(temporary, self.lifecycle_path)

    def dsn(self, *, user: str = PG_BOOTSTRAP_USER, database: str = "postgres", password: str | None = None) -> str:
        """Return a local-socket DSN; callers must not log it."""
        return make_conninfo(
            host=str(self.socket_dir),
            port=self.port,
            dbname=database,
            user=user,
            password=password,
            connect_timeout=3,
        )


@dataclass(frozen=True)
class PgRoles:
    migration: str = "ifpmic_g1_migrator"
    runtime: str = "ifpmic_g1_runtime"
    operator: str = "ifpmic_g1_operator"
    alternate_runtime: str = "ifpmic_g1_runtime_alt"
    dispatcher: str = "ifpmic_h2_dispatcher"
    projector: str = "ifpmic_h2_projector"
    runtime_password: str = field(default="", repr=False)
    operator_password: str = field(default="", repr=False)
    dispatcher_password: str = field(default="", repr=False)
    projector_password: str = field(default="", repr=False)


@dataclass(frozen=True)
class MigrationDatabase:
    name: str
    roles: PgRoles
    legacy_migration_dir: Path

    def owner_dsn(self, cluster: PgCluster) -> str:
        return cluster.dsn(user=self.roles.migration, database=self.name)

    def runtime_dsn(self, cluster: PgCluster) -> str:
        return cluster.dsn(user=self.roles.runtime, database=self.name, password=self.roles.runtime_password)

    def operator_dsn(self, cluster: PgCluster) -> str:
        return cluster.dsn(user=self.roles.operator, database=self.name, password=self.roles.operator_password)

    def dispatcher_dsn(self, cluster: PgCluster) -> str:
        return cluster.dsn(user=self.roles.dispatcher, database=self.name, password=self.roles.dispatcher_password)

    def projector_dsn(self, cluster: PgCluster) -> str:
        return cluster.dsn(user=self.roles.projector, database=self.name, password=self.roles.projector_password)

    def migrate_current(self, cluster: PgCluster):
        """Apply the installed current chain; historical G1 tests use legacy_migration_dir."""
        from services.ifpmic_api.migrate import apply_migrations

        with psycopg.connect(self.owner_dsn(cluster), autocommit=True) as connection:
            return apply_migrations(
                connection,
                runtime_role=self.roles.runtime,
                operator_role=self.roles.operator,
                dispatcher_role=self.roles.dispatcher,
                projector_role=self.roles.projector,
            )


def _run(argv: list[str], *, timeout: float, env: dict[str, str]) -> tuple[subprocess.CompletedProcess[str], float]:
    started = time.monotonic()
    completed = subprocess.run(
        argv,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=False,
        env=env,
    )
    return completed, time.monotonic() - started


def _cleanup_started_cluster(pg_ctl: Path, data_dir: Path, env: dict[str, str]) -> tuple[bool, int | None]:
    """Stop only the cluster identified by this fixture's private data dir."""
    try:
        status = subprocess.run(
            [str(pg_ctl), "-D", str(data_dir), "status"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            env=env,
            check=False,
        )
        if status.returncode != 0:
            return False, status.returncode
        stop = subprocess.run(
            [str(pg_ctl), "-D", str(data_dir), "-m", "immediate", "-w", "-t", "10", "stop"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=15,
            env=env,
            check=False,
        )
        return True, stop.returncode
    except subprocess.TimeoutExpired:
        # A stop command timeout is not proof that the postmaster remains up.
        # Re-query this exact data directory before reporting cleanup failure.
        try:
            status = subprocess.run(
                [str(pg_ctl), "-D", str(data_dir), "status"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                env=env,
                check=False,
            )
            return (False, 0) if status.returncode != 0 else (True, None)
        except subprocess.TimeoutExpired:
            return True, None


def _capture_current_postmaster(cluster):
    path = cluster.data_dir / "postmaster.pid"
    try:
        info = path.lstat()
    except FileNotFoundError:
        # Keep the last known identity: missing metadata alone is not absence.
        return cluster.server_pid, cluster.server_start_ticks
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1):
        raise RuntimeError("Temporary PostgreSQL identity file invalid")
    pid = int(path.read_text(encoding="ascii").splitlines()[0])
    if pid <= 1:
        raise RuntimeError("Temporary PostgreSQL identity PID invalid")
    ticks = h2_cleanup.process_start_ticks(pid)
    if ticks is None:
        raise RuntimeError("Temporary PostgreSQL current identity unconfirmed")
    cluster.server_pid, cluster.server_start_ticks = pid, ticks
    return pid, ticks


def _stop_h2_cluster(cluster, env, config):
    """Last-item session finalization shares that item's existing cleanup clock."""
    pid, ticks = _capture_current_postmaster(cluster)
    if ticks is None:
        raise RuntimeError("Temporary PostgreSQL saved identity unavailable")
    stop_error = None
    absent = False
    try:
        try:
            cluster.persist_lifecycle()
            h2_cleanup.record(config, "postgres_stop_requested", pid=pid, start_ticks=ticks,
                              initial_pid=cluster.initial_server_pid)
        except BaseException as error:
            # Evidence errors still fail the case, after attempting owned stop.
            stop_error = error
        available = h2_cleanup.remaining(config, 20)
        fast_timeout = min(3.0, available * 0.6)
        for mode in ("fast", "immediate"):
            if mode == "immediate" and h2_cleanup.process_start_ticks(pid) != ticks:
                break
            timeout = (fast_timeout if mode == "fast" else
                       h2_cleanup.remaining(config, 3))
            started = time.monotonic()
            code = None
            try:
                result = subprocess.run(
                    [str(cluster.binaries["pg_ctl"]), "-D", str(cluster.data_dir),
                     "-m", mode, "-w", "-t", str(max(1, math.ceil(timeout))), "stop"],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    timeout=timeout, env=env, check=False,
                )
                code = result.returncode
                if code != 0 and stop_error is None:
                    stop_error = RuntimeError("H2 PostgreSQL stop command failed")
            except subprocess.TimeoutExpired as error:
                if stop_error is None:
                    stop_error = error
            finally:
                cluster.lifecycle.append({"operation": "pg_ctl_stop" if mode == "fast" else "pg_ctl_stop_immediate",
                                          "exit_code": code,
                                          "duration_ms": round((time.monotonic() - started) * 1000)})
            if code == 0:
                break
        while h2_cleanup.process_start_ticks(pid) == ticks:
            time.sleep(h2_cleanup.remaining(config, 0.02))
        absent = True
        if stop_error is not None:
            # Successful emergency cleanup does not erase the timeout/failure.
            raise stop_error
    finally:
        primary = sys.exc_info()[0] is not None
        try:
            cluster.persist_lifecycle(stop_status="stopped" if absent else "cleanup_unconfirmed",
                                      pid_alive=not absent)
        except BaseException:
            if not primary:
                raise
        finally:
            h2_cleanup.record_finalizer(config, "postgres_stopped", pid=pid, start_ticks=ticks,
                                        absent=absent, initial_pid=cluster.initial_server_pid)


def _stop_legacy_cluster(cluster, env):
    # Preserve original stop limits; observe the current identity after restarts.
    current_pid, current_ticks = _capture_current_postmaster(cluster)
    started = time.monotonic()
    try:
        result = subprocess.run(
            [str(cluster.binaries["pg_ctl"]), "-D", str(cluster.data_dir),
             "-m", "fast", "-w", "-t", "20", "stop"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=25, env=env, check=False,
        )
        stop_code = result.returncode
    except subprocess.TimeoutExpired:
        stop_code = None
    cluster.lifecycle.append({"operation": "pg_ctl_stop", "exit_code": stop_code,
                              "duration_ms": round((time.monotonic() - started) * 1000)})
    if stop_code != 0:
        running, cleanup_code = _cleanup_started_cluster(cluster.binaries["pg_ctl"], cluster.data_dir, env)
        if running and cleanup_code != 0:
            cluster.persist_lifecycle(stop_status=f"cleanup_failed:{cleanup_code}", pid_alive=True)
            raise RuntimeError("Temporary PostgreSQL cleanup failed; inspect the isolated test process handle")
    pid_alive = h2_cleanup.process_start_ticks(current_pid) == current_ticks
    cluster.persist_lifecycle(stop_status="stopped" if not pid_alive else "still_running", pid_alive=pid_alive)
    if pid_alive:
        raise RuntimeError("Temporary PostgreSQL server PID remains live after bounded cleanup")


@pytest.fixture(scope="session")
def pg_cluster(tmp_path_factory: pytest.TempPathFactory, request) -> PgCluster:
    """Start and reliably stop a fresh temporary PostgreSQL 18.1 cluster."""
    if os.name != "posix":
        pytest.fail("G1 requires the pinned POSIX PostgreSQL test binary")

    binaries = {name: PG_BIN_DIR / name for name in PG_BIN_NAMES}
    missing = [name for name, path in binaries.items() if not path.is_file()]
    if missing:
        pytest.fail(f"Pinned PostgreSQL binaries unavailable: {','.join(missing)}")
    if shutil.which("runuser") is None and os.geteuid() == 0:
        pytest.fail("PostgreSQL initdb must run as an unprivileged workspace user")

    root = tmp_path_factory.mktemp("ifpmic-pg18-")
    root.chmod(0o700)
    data_dir = root / "data"
    socket_dir = root / "socket"
    socket_dir.mkdir(mode=0o700)
    log_path = root / "server.log"
    binary_versions: dict[str, str] = {}
    binary_sha256: dict[str, str] = {}
    lifecycle: list[dict[str, object]] = []
    clean_env = {
        "PATH": f"{PG_BIN_DIR}{os.pathsep}/usr/bin:/bin",
        "HOME": str(root),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PGCONNECT_TIMEOUT": "3",
    }

    import hashlib

    for name, path in binaries.items():
        binary_sha256[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        result, duration = _run([str(path), "--version"], timeout=5, env=clean_env)
        if result.returncode != 0:
            pytest.fail(f"{name} --version failed with exit {result.returncode}")
        version = result.stdout.strip()
        if "18.1" not in version:
            pytest.fail(f"Expected pinned PostgreSQL 18.1 binary; {name} reported another version")
        binary_versions[name] = version
        lifecycle.append({"operation": f"{name}_version", "exit_code": 0, "duration_ms": round(duration * 1000)})

    init_result, init_duration = _run(
        [
            str(binaries["initdb"]),
            "-D",
            str(data_dir),
            "-U",
            PG_BOOTSTRAP_USER,
            "--encoding=UTF8",
            "--no-locale",
            "--auth-local=trust",
            "--auth-host=reject",
        ],
        timeout=30,
        env=clean_env,
    )
    lifecycle.append({"operation": "initdb", "exit_code": init_result.returncode, "duration_ms": round(init_duration * 1000)})
    if init_result.returncode != 0:
        pytest.fail(f"Isolated initdb failed with exit {init_result.returncode}")

    # Empty listen_addresses prohibits TCP. Socket path is unique to this fixture.
    config_path = data_dir / "postgresql.conf"
    with config_path.open("a", encoding="ascii") as config:
        config.write(
            "\nlisten_addresses = ''\n"
            f"unix_socket_directories = '{socket_dir}'\n"
            f"port = {PG_PORT}\n"
            "ssl = off\n"
            "logging_collector = off\n"
            "log_min_messages = warning\n"
        )

    try:
        start_result, start_duration = _run(
            [
                str(binaries["pg_ctl"]),
                "-D",
                str(data_dir),
                "-l",
                str(log_path),
                "-w",
                "-t",
                "20",
                "start",
            ],
            timeout=25,
            env=clean_env,
        )
    except subprocess.TimeoutExpired:
        running, cleanup_code = _cleanup_started_cluster(binaries["pg_ctl"], data_dir, clean_env)
        pytest.fail(
            "Isolated PostgreSQL start timed out; "
            f"verified_running={running}, cleanup_exit={cleanup_code}"
        )
    lifecycle.append({"operation": "pg_ctl_start", "exit_code": start_result.returncode, "duration_ms": round(start_duration * 1000)})
    if start_result.returncode != 0:
        running, cleanup_code = _cleanup_started_cluster(binaries["pg_ctl"], data_dir, clean_env)
        pytest.fail(
            "Isolated PostgreSQL start failed; "
            f"exit={start_result.returncode}, verified_running={running}, cleanup_exit={cleanup_code}"
        )

    pid_path = data_dir / "postmaster.pid"
    try:
        server_pid = int(pid_path.read_text(encoding="ascii").splitlines()[0])
    except (OSError, ValueError, IndexError):
        running, cleanup_code = _cleanup_started_cluster(binaries["pg_ctl"], data_dir, clean_env)
        pytest.fail(
            "PostgreSQL started but its process handle could not be read; "
            f"verified_running={running}, cleanup_exit={cleanup_code}"
        )

    server_ticks = h2_cleanup.process_start_ticks(server_pid)
    if server_ticks is None:
        _cleanup_started_cluster(binaries["pg_ctl"], data_dir, clean_env)
        pytest.fail("Temporary PostgreSQL startup identity unavailable")
    cluster = PgCluster(
        root=root,
        data_dir=data_dir,
        socket_dir=socket_dir,
        log_path=log_path,
        port=PG_PORT,
        binaries=binaries,
        binary_versions=binary_versions,
        binary_sha256=binary_sha256,
        server_pid=server_pid,
        server_start_ticks=server_ticks,
        initial_server_pid=server_pid,
        initial_server_start_ticks=server_ticks,
        lifecycle_path=(Path(os.environ["IFPMIC_TEST_LIFECYCLE_PATH"]) if os.environ.get("IFPMIC_TEST_LIFECYCLE_PATH") else None),
        lifecycle=lifecycle,
    )
    try:
        cluster.persist_lifecycle()
        yield cluster
    finally:
        if h2_cleanup.controller(request.config) is not None:
            _stop_h2_cluster(cluster, clean_env, request.config)
        else:
            _stop_legacy_cluster(cluster, clean_env)


@pytest.fixture(scope="session")
def pg_roles(pg_cluster: PgCluster) -> PgRoles:
    """Create synthetic, least-privileged roles inside the isolated cluster."""
    roles = PgRoles(
        runtime_password=secrets.token_urlsafe(32),
        operator_password=secrets.token_urlsafe(32),
        dispatcher_password=secrets.token_urlsafe(32),
        projector_password=secrets.token_urlsafe(32),
    )
    passwords = {
        roles.runtime: roles.runtime_password,
        roles.operator: roles.operator_password,
        roles.dispatcher: roles.dispatcher_password,
        roles.projector: roles.projector_password,
    }
    with psycopg.connect(pg_cluster.dsn()) as connection:
        for role_name in (roles.migration, roles.runtime, roles.operator, roles.alternate_runtime,
                          roles.dispatcher, roles.projector):
            password = passwords.get(role_name) or secrets.token_urlsafe(32)
            statement = sql.SQL(
                "CREATE ROLE {} LOGIN PASSWORD {} NOSUPERUSER NOCREATEDB NOCREATEROLE "
                "NOBYPASSRLS NOINHERIT"
            ).format(sql.Identifier(role_name), sql.Literal(password))
            connection.execute(statement)
    return roles


@pytest.fixture
def migration_db(pg_cluster: PgCluster, pg_roles: PgRoles, tmp_path: Path, request) -> MigrationDatabase:
    """Create an isolated database owned by a non-superuser migration role."""
    name = f"ifpmic_g1_{uuid4().hex[:16]}"
    with psycopg.connect(pg_cluster.dsn(), autocommit=True) as connection:
        connection.execute(
            sql.SQL("CREATE DATABASE {} OWNER {}").format(
                sql.Identifier(name), sql.Identifier(pg_roles.migration)
            )
        )
    repo_root = Path(__file__).resolve().parents[2]
    legacy_dir = tmp_path / "migrations-001-002"
    legacy_dir.mkdir(mode=0o700)
    shutil.copyfile(repo_root / "services/ifpmic_api/migrations/001_initial.sql", legacy_dir / "001_initial.sql")
    shutil.copyfile(repo_root / "services/ifpmic_api/migrations/002_auth_retention.sql", legacy_dir / "002_auth_retention.sql")
    database = MigrationDatabase(name=name, roles=pg_roles, legacy_migration_dir=legacy_dir)
    try:
        yield database
    finally:
        active = h2_cleanup.controller(request.config)
        if active is None:
            with psycopg.connect(pg_cluster.dsn(), autocommit=True) as connection:
                connection.execute(
                    sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name))
                )
        else:
            dropped = False
            try:
                # libpq's connect_timeout has a minimum effective value of2s.
                # Refuse a new connection without room for SQL and PG stop.
                if h2_cleanup.remaining(request.config, 3) < 2.5:
                    raise TimeoutError("H2 database cleanup has no connection allowance")
                with psycopg.connect(pg_cluster.dsn(), autocommit=True, connect_timeout=2,
                                     options="-c statement_timeout=1000 -c lock_timeout=1000") as connection:
                    milliseconds = int(min(1.0, h2_cleanup.remaining(request.config, 1)) * 1000)
                    if milliseconds < 1:
                        raise TimeoutError("H2 database cleanup SQL allowance exhausted")
                    connection.execute("SELECT set_config('statement_timeout',%s,false),"
                                       "set_config('lock_timeout',%s,false)",
                                       (str(milliseconds), str(milliseconds)))
                    connection.execute(
                        sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name))
                    )
                    dropped = True
            finally:
                h2_cleanup.record_finalizer(request.config, "database_dropped", database=name,
                                            dropped=dropped)
