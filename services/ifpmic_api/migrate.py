"""Transactional, hash-pinned schema installation by a separate migration owner."""
from hashlib import sha256
from pathlib import Path

from psycopg import sql
from psycopg.pq import TransactionStatus


class MigrationError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def apply_migrations(connection, *, runtime_role, operator_role, migration_dir=None):
    """Apply immutable SQL files; roles must already exist. No role creation or IO logging.

    migration_dir is an in-process test seam, never a web/CLI input.
    Returns {applied: [version], unchanged: [version]}; errors expose fixed codes.
    """
    directory = Path(migration_dir) if migration_dir is not None else Path(__file__).with_name("migrations")
    try:
        files = sorted(directory.glob("[0-9][0-9][0-9]_*.sql"))
        if not files:
            raise MigrationError("MIGRATION_SOURCE_INVALID")
        if not isinstance(runtime_role, str) or not isinstance(operator_role, str) or runtime_role == operator_role:
            raise MigrationError("MIGRATION_ROLE_INVALID")
        if connection.info.transaction_status != TransactionStatus.IDLE:
            raise MigrationError("MIGRATION_TRANSACTION_ACTIVE")
        sources = [(p.stem, p.read_bytes()) for p in files]
        result = {"applied": [], "unchanged": []}
        with connection.transaction():
            connection.execute("SET LOCAL lock_timeout = '5s'")
            connection.execute("SET LOCAL statement_timeout = '30s'")
            connection.execute("SELECT pg_advisory_xact_lock(7291825371091941)")
            owner = connection.execute("SELECT current_user").fetchone()[0]
            if owner in (runtime_role, operator_role):
                raise MigrationError("MIGRATION_OWNER_INVALID")
            for role in (runtime_role, operator_role):
                row = connection.execute(
                    "SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolcanlogin, rolreplication, "
                    "EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid OR roleid=pg_roles.oid) "
                    "FROM pg_roles WHERE rolname=%s", (role,)
                ).fetchone()
                if row is None or any(row[i] for i in (0, 1, 2, 3, 5, 6)) or not row[4]:
                    raise MigrationError("MIGRATION_ROLE_INVALID")
            existing = connection.execute(
                "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='ifpmic'"
            ).fetchone()
            if existing and existing[0] != owner:
                raise MigrationError("MIGRATION_OWNER_INVALID")
            connection.execute("CREATE SCHEMA IF NOT EXISTS ifpmic")
            connection.execute("""CREATE TABLE IF NOT EXISTS ifpmic.schema_migrations (
                version text PRIMARY KEY, source_sha256 text NOT NULL,
                runtime_role text NOT NULL, operator_role text NOT NULL,
                applied_at timestamptz NOT NULL DEFAULT now())""")
            known_versions = {version for version, _ in sources}
            applied_versions = {row[0] for row in connection.execute("SELECT version FROM ifpmic.schema_migrations").fetchall()}
            if not applied_versions.issubset(known_versions):
                raise MigrationError("MIGRATION_DRIFT")
            for version, source in sources:
                digest = sha256(source).hexdigest()
                previous = connection.execute(
                    "SELECT source_sha256,runtime_role,operator_role FROM ifpmic.schema_migrations WHERE version=%s", (version,)
                ).fetchone()
                if previous:
                    if previous[0] != digest:
                        raise MigrationError("MIGRATION_DRIFT")
                    if tuple(previous[1:]) != (runtime_role, operator_role):
                        raise MigrationError("MIGRATION_ROLE_DRIFT")
                    result["unchanged"].append(version)
                    continue
                statement = sql.SQL(source.decode("utf-8")).format(
                    runtime_role=sql.Identifier(runtime_role), operator_role=sql.Identifier(operator_role)
                )
                connection.execute(statement)
                connection.execute(
                    "INSERT INTO ifpmic.schema_migrations(version,source_sha256,runtime_role,operator_role) VALUES(%s,%s,%s,%s)",
                    (version, digest, runtime_role, operator_role)
                )
                result["applied"].append(version)
        return result
    except MigrationError:
        raise
    except Exception:
        raise MigrationError("MIGRATION_IO") from None


def main():
    """Explicit operator entry point. DSN and role values are never printed."""
    import json
    import os
    import sys
    import psycopg

    try:
        if len(sys.argv) != 1:
            raise MigrationError("MIGRATION_CONFIG_INVALID")
        values = [os.environ.get(name) for name in (
            "IFPMIC_MIGRATION_DSN", "IFPMIC_RUNTIME_ROLE", "IFPMIC_OPERATOR_ROLE")]
        if not all(values):
            raise MigrationError("MIGRATION_CONFIG_INVALID")
        dsn, runtime, operator = values
        with psycopg.connect(dsn, connect_timeout=10, autocommit=True) as connection:
            result = apply_migrations(connection, runtime_role=runtime, operator_role=operator)
        print(json.dumps(result, separators=(",", ":")))
    except Exception as error:
        code = error.code if isinstance(error, MigrationError) else "MIGRATION_IO"
        print(json.dumps({"error": {"code": code}}, separators=(",", ":")))
        sys.exit(3 if code == "MIGRATION_IO" else 2)


if __name__ == "__main__":
    main()
