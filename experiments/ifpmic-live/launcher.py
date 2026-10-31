"""Isolated live-request demo: production API/PG, local synthetic OIDC/profile.

By default no dispatcher, worker or Temporal is started. --execution explicitly
adds isolated local admission only; no equipment, publisher or company SSO.
Run with the already qualified .ifpmic-venv and pinned Node; no installation.
"""
from __future__ import annotations

import argparse
import base64
from dataclasses import asdict
import asyncio
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import stat
import subprocess
import sys
import time
import traceback
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
STATE_BASE = ROOT / "workflow-artifacts/live-demo"
PROJECT = "ifpmic-local-demo"
PROFILE = "local-demo-v1"
DATABASE = "ifpmic_local_demo"
BOOTSTRAP = "ifpmic_demo_bootstrap"
ROLES = {kind: "ifpmic_demo_" + kind for kind in
         ("owner", "runtime", "operator", "dispatcher", "projector")}


def private_dir(path: Path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if path.is_symlink() or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise RuntimeError("invalid private demo directory")


def private_write(path: Path, value):
    raw = value if isinstance(value, bytes) else (json.dumps(value, ensure_ascii=True, sort_keys=True) + "\n").encode("ascii")
    temporary = path.with_name(path.name + "." + uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def read_private(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise RuntimeError("invalid private demo file")
        return json.load(source)


def identity(pid):
    try:
        raw = Path(f"/proc/{pid}/stat").read_text()
        fields = raw[raw.rfind(")") + 2:].split()
        return None if fields[0] == "Z" else fields[19]
    except FileNotFoundError:
        return None


def hash_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class LocalDatabase:
    def __init__(self, state: Path, pins: dict):
        self.state, self.data = state, state / "postgres"
        # Unix socket paths are bounded independently of a long checkout path.
        self.socket = Path("/tmp") / ("ifpmic-demo-" + hashlib.sha256(str(state).encode()).hexdigest()[:16])
        private_dir(self.socket)
        self.pins = pins
        self.bins = {name: ROOT / pins[name]["path"] for name in ("initdb", "pg_ctl", "postgres")}
        self.env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
                    "PGPASSFILE": str(state / "empty-pgpass"), "PGSERVICEFILE": str(state / "empty-pgservice")}
        private_write(state / "empty-pgpass", b"")
        private_write(state / "empty-pgservice", b"")
        self.pid = self.ticks = None
        self.process = None

    def command(self, name, *args, timeout=20):
        if hash_file(self.bins[name]) != self.pins[name]["sha256"]:
            raise RuntimeError("pinned PostgreSQL binary changed")
        result = subprocess.run([str(self.bins[name]), *map(str, args)], env=self.env,
                                stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)
        private_write(self.state / f"{name}-last-output.log", result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError("local PostgreSQL command failed")

    def dsn(self, user=BOOTSTRAP, database="postgres", password=None):
        from psycopg.conninfo import make_conninfo
        return make_conninfo(host=str(self.socket), port=55493, dbname=database, user=user,
                             password=password, connect_timeout=3,
                             options="-c lock_timeout=5000 -c statement_timeout=30000")

    def start(self):
        if not self.data.exists():
            self.command("initdb", "-D", self.data, "-U", BOOTSTRAP, "--auth-local=trust",
                         "--auth-host=reject", "--no-locale", "--encoding=UTF8", timeout=30)
            with (self.data / "postgresql.conf").open("a") as config:
                config.write("\nlisten_addresses=''\nport=55493\nunix_socket_directories='" + str(self.socket) + "'\n")
            roles = ",".join(ROLES[k] for k in ("runtime", "operator", "dispatcher", "projector"))
            hba = self.data / "pg_hba.conf"
            original = hba.read_bytes()
            private_write(hba, f"local all {roles} scram-sha-256\n".encode() + original)
        if self.data.is_symlink():
            raise RuntimeError("invalid PostgreSQL directory")
        pid_file = self.data / "postmaster.pid"
        if pid_file.exists():
            pid = int(pid_file.read_text().splitlines()[0])
            live = identity(pid)
            if live is not None:
                saved = read_private(self.state / "postgres-ownership.json")
                if saved != {"pid": pid, "start_ticks": live, "data": str(self.data)}:
                    raise RuntimeError("unconfirmed existing PostgreSQL ownership")
                if Path(f"/proc/{pid}/exe").resolve() != self.bins["postgres"].resolve():
                    raise RuntimeError("unexpected PostgreSQL executable")
                self.pid, self.ticks = pid, live
                return
        # Keep a real child handle before any identity/log/readiness operation.
        if hash_file(self.bins["postgres"]) != self.pins["postgres"]["sha256"]:
            raise RuntimeError("pinned PostgreSQL binary changed")
        log_fd = os.open(self.state / "postgres.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            os.fchmod(log_fd, 0o600)
            self.process = subprocess.Popen([str(self.bins["postgres"]), "-D", str(self.data)],
                stdin=subprocess.DEVNULL, stdout=log_fd, stderr=log_fd, env=self.env,
                start_new_session=True)
        finally:
            os.close(log_fd)
        self.pid = self.process.pid
        self.ticks = identity(self.pid)
        deadline = time.monotonic() + 15
        import psycopg
        from psycopg.conninfo import make_conninfo
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError("PostgreSQL child exited during startup")
            self.ticks = self.ticks or identity(self.pid)
            try:
                with psycopg.connect(make_conninfo(self.dsn(), connect_timeout=1,
                        options="-c statement_timeout=1000")) as probe:
                    if probe.execute("SELECT 1").fetchone() == (1,):
                        break
            except psycopg.OperationalError:
                time.sleep(0.05)
        else:
            raise RuntimeError("PostgreSQL startup timed out")
        if self.ticks is None:
            raise RuntimeError("PostgreSQL identity missing")
        private_write(self.state / "postgres-ownership.json",
                      {"pid": self.pid, "start_ticks": self.ticks, "data": str(self.data)})

    def stop(self):
        if self.pid is None and self.process is not None:
            self.pid = self.process.pid
        if self.process is not None and self.process.poll() is not None:
            self.process.wait(timeout=1)
            return
        if self.pid is None:
            return
        if identity(self.pid) is None:
            if self.process is not None:
                self.process.wait(timeout=1)
            return
        if self.process is not None and self.ticks is None:
            # This is our still-unreaped direct child, not a discovered PID.
            self.ticks = identity(self.pid)
        if identity(self.pid) != self.ticks:
            raise RuntimeError("PostgreSQL ownership changed")
        if self.process is not None:
            self.process.send_signal(signal.SIGINT)
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                if identity(self.pid) == self.ticks:
                    self.process.kill()
                    self.process.wait(timeout=3)
                raise RuntimeError("PostgreSQL required forced cleanup")
        else:
            self.command("pg_ctl", "-D", self.data, "-m", "fast", "-w", "-t", "10", "stop", timeout=15)
        if identity(self.pid) is not None:
            raise RuntimeError("PostgreSQL stop unconfirmed")
        private_write(self.state / "postgres-stopped.json", {"absent": True, "data_preserved": True})


def provision(cluster, secrets_doc, node, issuer):
    import psycopg
    from psycopg import sql
    from services.ifpmic_api.migrate import apply_migrations
    from services.ifpmic_api.catalog import import_snapshot
    from services.ifpmic_api.snapshot_bridge import SnapshotBridge

    with psycopg.connect(cluster.dsn(), autocommit=True) as bootstrap:
        for kind, role in ROLES.items():
            exists = bootstrap.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (role,)).fetchone()
            if exists is None:
                bootstrap.execute(sql.SQL("CREATE ROLE {} LOGIN PASSWORD {} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT").format(
                    sql.Identifier(role), sql.Literal(secrets_doc["passwords"][kind])))
        if bootstrap.execute("SELECT 1 FROM pg_database WHERE datname=%s", (DATABASE,)).fetchone() is None:
            bootstrap.execute(sql.SQL("CREATE DATABASE {} OWNER {}").format(sql.Identifier(DATABASE), sql.Identifier(ROLES["owner"])))
    owner_dsn = cluster.dsn(ROLES["owner"], DATABASE, secrets_doc["passwords"]["owner"])
    with psycopg.connect(owner_dsn, autocommit=True) as owner:
        apply_migrations(owner, runtime_role=ROLES["runtime"], operator_role=ROLES["operator"],
                         dispatcher_role=ROLES["dispatcher"], projector_role=ROLES["projector"])
    store = cluster.state / "profiles"
    seed = subprocess.run([str(node), str(Path(__file__).with_name("seed-profile.mjs"))], cwd=ROOT,
                          input=json.dumps({"store": str(store)}).encode(), capture_output=True, timeout=30,
                          env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"})
    private_write(cluster.state / "profile-seed.log", seed.stdout + seed.stderr)
    if seed.returncode or seed.stderr:
        raise RuntimeError("local profile seed failed")
    bridge = SnapshotBridge(node_executable=str(node), store_root=store)
    snapshot = asyncio.run(bridge.read_snapshot(PROJECT, PROFILE))
    operator_dsn = cluster.dsn(ROLES["operator"], DATABASE, secrets_doc["passwords"]["operator"])
    with psycopg.connect(owner_dsn, autocommit=True) as owner:
        for account in ("demo-a", "demo-b"):
            subject = json.dumps([issuer.issuer, account], ensure_ascii=True, separators=(",", ":"))
            owner.execute("INSERT INTO ifpmic.users(identity_subject,display_name) VALUES(%s,%s) "
                          "ON CONFLICT(identity_subject) DO NOTHING", (subject, account))
    with psycopg.connect(operator_dsn, autocommit=True) as operator:
        operator.execute("INSERT INTO ifpmic.projects(project_id) VALUES(%s) ON CONFLICT DO NOTHING", (PROJECT,))
        import_snapshot(operator, snapshot)
        for account in ("demo-a", "demo-b"):
            subject = json.dumps([issuer.issuer, account], ensure_ascii=True, separators=(",", ":"))
            user = operator.execute("SELECT user_id FROM ifpmic.users WHERE identity_subject=%s",
                                    (subject,)).fetchone()[0]
            operator.execute("INSERT INTO ifpmic.memberships(project_id,user_id,capabilities) VALUES(%s,%s,ARRAY['request.create']) ON CONFLICT DO NOTHING", (PROJECT, user))
        existing = operator.execute("SELECT 1 FROM ifpmic.profile_eligibility WHERE project_id=%s AND snapshot_id=%s", (PROJECT, snapshot.snapshot_id)).fetchone()
        if existing is None:
            operator.execute("INSERT INTO ifpmic.profile_eligibility(project_id,snapshot_id,mode,evidence_ref,evidence_sha256,granted_at,expires_at) "
                             "VALUES(%s,%s,'mock','local-demo-only-no-device-or-release',%s,clock_timestamp(),clock_timestamp()+interval '7 days')",
                             (PROJECT, snapshot.snapshot_id, hashlib.sha256(b"local-demo-synthetic-eligibility").hexdigest()))
    return store


def run(args):
    # Qualified environment and immutable tool binaries are checked before startup.
    if Path(sys.prefix).resolve() != (ROOT / ".ifpmic-venv").resolve():
        raise RuntimeError("use qualified original32 environment")
    contract_path = ROOT / "docs/ifpmic/evidence/b03/h2-runtime-full-execution-contract.json"
    if hash_file(contract_path) != "c10c7cb329ea82b758cfa7db34ac330e4b7ec472320b5904e8086f8067865a2d":
        raise RuntimeError("qualified toolchain references changed")
    pins = json.loads(contract_path.read_text())["binary_inputs"]
    for kind in ("initdb", "pg_ctl", "postgres", "original32_python"):
        pin = pins[kind]
        if hash_file(ROOT / pin["path"]) != pin["sha256"]:
            raise RuntimeError("qualified binary changed")
    node = Path.home() / pins["fixture_node"]["path"].removeprefix("~/")
    if hash_file(node) != pins["fixture_node"]["sha256"]:
        raise RuntimeError("qualified Node changed")
    state = STATE_BASE / args.name
    private_dir(STATE_BASE)
    private_dir(state)
    lock = os.open(state / ".launcher.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.fchmod(lock, 0o600)
    secrets_path = state / "secrets.json"
    if not secrets_path.exists():
        private_write(secrets_path, {"passwords": {k: secrets.token_urlsafe(32) for k in ROLES},
                                     "csrf_key": secrets.token_bytes(32).hex(), "oidc_secret": secrets.token_urlsafe(32)})
    secret = read_private(secrets_path)
    cluster = LocalDatabase(state, pins)
    private_dir(state / "empty-pg-system")
    original_home = os.environ.get("HOME")
    os.environ.clear()
    os.environ.update({"PATH": str(node.parent) + ":/usr/bin:/bin", "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1",
        "PGPASSFILE": str(state / "empty-pgpass"),
        "PGSERVICEFILE": str(state / "empty-pgservice"),
        "PGSYSCONFDIR": str(state / "empty-pg-system")})
    if original_home is not None:
        os.environ["HOME"] = original_home  # Preserve it; never point HOME at demo data.
    from local_oidc import LocalIssuer
    from services.ifpmic_api.app import create_app, json_response
    from services.ifpmic_api.settings import Settings
    from starlette.staticfiles import StaticFiles
    import uvicorn

    origin = f"http://127.0.0.1:{args.port}"
    issuer = None
    execution = None
    # Cover startup as well as Uvicorn's restoration/re-raise of TERM.
    def terminate(_signum, _frame):
        raise KeyboardInterrupt()

    signal.signal(signal.SIGTERM, terminate)
    try:
        issuer = LocalIssuer(args.issuer_port, origin, secret["oidc_secret"])
        cluster.start()
        store = provision(cluster, secret, node, issuer)
        if args.execution:
            from execution import LocalExecution
            execution = LocalExecution(state=state, toolchain_manifest=Path(args.execution_toolchain),
                cluster=cluster, secrets_doc=secret, roles=ROLES, database=DATABASE,
                api_config_path=state / "api-config.json", mock_task=args.mock_task)
            private_dir(execution.root)
            private_dir(execution.workspace_root)
        settings = Settings(mode="mock", api_origin=origin, issuer=issuer.issuer,
            client_id=issuer.client_id, client_secret=secret["oidc_secret"],
            authorization_endpoint=issuer.origin + "/authorize", token_endpoint=issuer.origin + "/token",
            jwks_uri=issuer.origin + "/keys", redirect_uri=origin + "/auth/callback",
            post_login_url=origin + "/", allowed_ui_origins=(origin,), csrf_key=bytes.fromhex(secret["csrf_key"]),
            database_dsn=cluster.dsn(ROLES["runtime"], DATABASE, secret["passwords"]["runtime"]),
            node_executable=str(node), profile_store=str(store),
            workspace_root=None if execution is None else str(execution.workspace_root))
        app = create_app(settings)
        if execution is not None:
            serialized = asdict(settings)
            serialized["csrf_key"] = base64.urlsafe_b64encode(settings.csrf_key).rstrip(b"=").decode("ascii")
            private_write(execution.api_config_path, serialized)
            execution.prepare()
            if args.port in execution.ports or args.issuer_port in execution.ports:
                raise RuntimeError("execution ports overlap API or issuer")
            execution.start()

        async def demo_context(request):
            app.state.jobs.pre_authenticate(request)
            value = {"project_id": PROJECT, "profile_version": PROFILE,
                "release_modes": ["team_github_tag"], "execution_connected": False,
                "storage": "postgresql", "identity": "local-demo-oidc"}
            if execution is not None:
                value.update(schema_version="ifpmic.local-context.v2",
                             execution_connected=execution.connected())
            return json_response(value)

        app.add_route("/demo/context", demo_context, methods=["GET"])
        app.mount("/", StaticFiles(directory=Path(__file__).with_name("web"), html=True))
        issuer.start()
        private_write(state / "lifecycle.json", {"api_pid": os.getpid(), "api_start_ticks": identity(os.getpid()),
                      "port": args.port, "issuer_port": args.issuer_port, "storage": "postgresql", "execution_connected": execution is not None})
        print(f"LOCAL_DEMO_STARTING {origin} (PostgreSQL API; synthetic identity/profile; execution={execution is not None})", flush=True)
        uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=False,
                    log_level="warning", proxy_headers=False, server_header=False, timeout_graceful_shutdown=10)
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)  # Repeated TERM must not interrupt cleanup.
        primary = sys.exc_info()[1]
        cleanup_errors = []
        for closer in ([execution.close] if execution is not None else []) + ([issuer.close] if issuer is not None else []) + [cluster.stop]:
            try:
                closer()
            except Exception as error:
                cleanup_errors.append(type(error).__name__)
        os.close(lock)
        if issuer is not None and hasattr(issuer, "closed_observation"):
            private_write(state / "issuer-stopped.json", issuer.closed_observation)
        if cleanup_errors:
            private_write(state / "cleanup-errors.json", {"errors": cleanup_errors})
            raise RuntimeError("local demo cleanup unconfirmed") from primary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", default="iteration-02")
    parser.add_argument("--port", type=int, default=8769)
    parser.add_argument("--issuer-port", type=int, default=8770)
    parser.add_argument("--execution", action="store_true", help="enable isolated local Temporal admission")
    parser.add_argument("--mock-task", action="store_true", help="run one bounded mock preflight after admission; requires --execution")
    parser.add_argument("--execution-toolchain", help="absolute private qualified H1 toolchain manifest")
    args = parser.parse_args()
    if (not args.name or len(args.name) > 40 or not args.name.replace("-", "").isalnum()
            or not args.name.isascii() or not 1024 <= args.port <= 65535
            or not 1024 <= args.issuer_port <= 65535 or args.port == args.issuer_port
            or args.execution != bool(args.execution_toolchain)
            or (args.mock_task and not args.execution)
            or (args.execution_toolchain and not Path(args.execution_toolchain).is_absolute())):
        parser.error("invalid isolated demo arguments")
    try:
        run(args)
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception:
        state = STATE_BASE / args.name
        if state.is_dir() and not state.is_symlink():
            private_write(state / "startup-error.log", traceback.format_exc().encode("utf-8"))
        print("LOCAL_DEMO_FAILED (private diagnostic preserved)", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
