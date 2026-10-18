"""G1 checks for the pinned, isolated PostgreSQL test environment."""

from __future__ import annotations

import os
import stat
import sys

import psycopg


EXPECTED_BINARY_VERSIONS = {
    "initdb": "initdb (PostgreSQL) 18.1",
    "pg_ctl": "pg_ctl (PostgreSQL) 18.1",
    "postgres": "postgres (PostgreSQL) 18.1",
}
EXPECTED_BINARY_SHA256 = {
    "initdb": "7cba14094c5f505f492fd243c5eda04f0dc3be05f12b7bd278f150f1e03b721f",
    "pg_ctl": "24a1f166819e0924319ff3faf752ad2a1ac594e223e2f3b1a2038dc84a2969de",
    "postgres": "c85fa9c977d9e641c2d22d93675a9b7097764b7df2c4c9ea021f5780522b2af2",
}


def test_pinned_postgres_binaries_are_18_1(pg_cluster):
    assert sys.version_info[:2] == (3, 12)
    assert set(pg_cluster.binary_versions) == {"initdb", "pg_ctl", "postgres"}
    assert pg_cluster.binary_versions == EXPECTED_BINARY_VERSIONS
    assert pg_cluster.binary_sha256 == EXPECTED_BINARY_SHA256


def test_cluster_is_fresh_private_and_unix_socket_only(pg_cluster):
    assert pg_cluster.root.name.startswith("ifpmic-pg18-")
    assert pg_cluster.data_dir.parent == pg_cluster.root
    assert pg_cluster.socket_dir.parent == pg_cluster.root
    assert stat.S_IMODE(pg_cluster.root.stat().st_mode) == 0o700
    assert stat.S_IMODE(pg_cluster.socket_dir.stat().st_mode) == 0o700
    assert (pg_cluster.socket_dir / f".s.PGSQL.{pg_cluster.port}").is_socket()
    assert pg_cluster.server_pid > 1
    os.kill(pg_cluster.server_pid, 0)

    with psycopg.connect(pg_cluster.dsn()) as connection:
        row = connection.execute(
            "SELECT current_user, current_database(), current_setting('server_version_num'), "
            "current_setting('listen_addresses'), inet_server_addr()"
        ).fetchone()
    assert row is not None
    assert row[0] == "ifpmic_g1_bootstrap"
    assert row[1] == "postgres"
    assert row[2] == "180001"
    assert row[3] == ""
    assert row[4] is None

    # The test cluster and socket are created beneath pytest's fresh temporary root.
    assert pg_cluster.data_dir.is_dir()
    assert pg_cluster.log_path.parent == pg_cluster.root
