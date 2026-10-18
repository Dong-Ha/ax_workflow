"""Isolated real-PostgreSQL fixtures for the IFPMIC API tests.

The fixture never reads or reuses Paperclip database configuration. It starts
only the pinned embedded PostgreSQL 18.1 binaries on a private Unix socket.
"""

from __future__ import annotations

import os
import json
import secrets
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from uuid import uuid4

import pytest
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo


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

    def dsn(self, *, user: str = PG_BOOTSTRAP_USER, database: str = "postgres") -> str:
        """Return a local-socket DSN; callers must not log it."""
        return make_conninfo(
            host=str(self.socket_dir),
            port=self.port,
            dbname=database,
            user=user,
            connect_timeout=3,
        )


@dataclass(frozen=True)
class PgRoles:
    migration: str = "ifpmic_g1_migrator"
    runtime: str = "ifpmic_g1_runtime"
    operator: str = "ifpmic_g1_operator"
    alternate_runtime: str = "ifpmic_g1_runtime_alt"


@dataclass(frozen=True)
class MigrationDatabase:
    name: str
    roles: PgRoles

    def owner_dsn(self, cluster: PgCluster) -> str:
        return cluster.dsn(user=self.roles.migration, database=self.name)

    def runtime_dsn(self, cluster: PgCluster) -> str:
        return cluster.dsn(user=self.roles.runtime, database=self.name)

    def operator_dsn(self, cluster: PgCluster) -> str:
        return cluster.dsn(user=self.roles.operator, database=self.name)


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


@pytest.fixture(scope="session")
def pg_cluster(tmp_path_factory: pytest.TempPathFactory) -> PgCluster:
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
        lifecycle_path=(Path(os.environ["IFPMIC_TEST_LIFECYCLE_PATH"]) if os.environ.get("IFPMIC_TEST_LIFECYCLE_PATH") else None),
        lifecycle=lifecycle,
    )
    cluster.persist_lifecycle()
    try:
        yield cluster
    finally:
        started = time.monotonic()
        try:
            stop_result = subprocess.run(
                [str(binaries["pg_ctl"]), "-D", str(data_dir), "-m", "fast", "-w", "-t", "20", "stop"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=25,
                env=clean_env,
                check=False,
            )
            stop_code = stop_result.returncode
        except subprocess.TimeoutExpired:
            stop_code = None
        cluster.lifecycle.append({"operation": "pg_ctl_stop", "exit_code": stop_code, "duration_ms": round((time.monotonic() - started) * 1000)})
        if stop_code != 0:
            running, cleanup_code = _cleanup_started_cluster(binaries["pg_ctl"], data_dir, clean_env)
            if running and cleanup_code != 0:
                cluster.persist_lifecycle(stop_status=f"cleanup_failed:{cleanup_code}", pid_alive=True)
                raise RuntimeError("Temporary PostgreSQL cleanup failed; inspect the isolated test process handle")
        try:
            os.kill(server_pid, 0)
            pid_alive = True
        except ProcessLookupError:
            pid_alive = False
        cluster.persist_lifecycle(
            stop_status="stopped" if not pid_alive else "still_running",
            pid_alive=pid_alive,
        )
        if pid_alive:
            raise RuntimeError("Temporary PostgreSQL server PID remains live after bounded cleanup")


@pytest.fixture(scope="session")
def pg_roles(pg_cluster: PgCluster) -> PgRoles:
    """Create synthetic, least-privileged roles inside the isolated cluster."""
    roles = PgRoles()
    with psycopg.connect(pg_cluster.dsn()) as connection:
        for role_name in (roles.migration, roles.runtime, roles.operator, roles.alternate_runtime):
            password = secrets.token_urlsafe(32)
            statement = sql.SQL(
                "CREATE ROLE {} LOGIN PASSWORD {} NOSUPERUSER NOCREATEDB NOCREATEROLE "
                "NOBYPASSRLS NOINHERIT"
            ).format(sql.Identifier(role_name), sql.Literal(password))
            connection.execute(statement)
    return roles


@pytest.fixture
def migration_db(pg_cluster: PgCluster, pg_roles: PgRoles) -> MigrationDatabase:
    """Create an isolated database owned by a non-superuser migration role."""
    name = f"ifpmic_g1_{uuid4().hex[:16]}"
    with psycopg.connect(pg_cluster.dsn(), autocommit=True) as connection:
        connection.execute(
            sql.SQL("CREATE DATABASE {} OWNER {}").format(
                sql.Identifier(name), sql.Identifier(pg_roles.migration)
            )
        )
    database = MigrationDatabase(name=name, roles=pg_roles)
    try:
        yield database
    finally:
        with psycopg.connect(pg_cluster.dsn(), autocommit=True) as connection:
            connection.execute(
                sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name))
            )
