"""Native SQL bounds for new H2 boundary fixtures; no SQL results are replaced."""
from __future__ import annotations

import psycopg
from psycopg.conninfo import make_conninfo

OPTIONS = "-c lock_timeout=5000 -c statement_timeout=30000"


def bounded_connect(dsn, **kwargs):
    kwargs.setdefault("connect_timeout", 3)
    kwargs.setdefault("options", OPTIONS)
    return psycopg.connect(dsn, **kwargs)


class BoundedDatabase:
    """Delegate fixture identity/data unchanged, adding options to its DSNs only."""
    def __init__(self, original):
        self.original = original

    def __getattr__(self, name):
        return getattr(self.original, name)

    def _dsn(self, method, cluster):
        return make_conninfo(getattr(self.original, method)(cluster), options=OPTIONS)

    def owner_dsn(self, cluster):
        return self._dsn("owner_dsn", cluster)

    def runtime_dsn(self, cluster):
        return self._dsn("runtime_dsn", cluster)

    def operator_dsn(self, cluster):
        return self._dsn("operator_dsn", cluster)

    def dispatcher_dsn(self, cluster):
        return self._dsn("dispatcher_dsn", cluster)

    def projector_dsn(self, cluster):
        return self._dsn("projector_dsn", cluster)


def bounded_harness(harness):
    database, cluster = harness["database"]
    if isinstance(database, BoundedDatabase):
        return harness
    return {**harness, "database": (BoundedDatabase(database), cluster)}
