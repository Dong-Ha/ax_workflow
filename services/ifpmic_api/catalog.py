"""Immutable operator-only catalog insertion. Import never grants eligibility."""
from psycopg.pq import TransactionStatus

from .snapshot_bridge import SnapshotRecord


class CatalogError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def import_snapshot(connection, record: SnapshotRecord):
    """Consume a result from the configured trusted Node bridge, never user JSON."""
    if not isinstance(record, SnapshotRecord):
        raise CatalogError('CATALOG_RECORD_INVALID')
    if connection.info.transaction_status != TransactionStatus.IDLE:
        raise CatalogError('CATALOG_TRANSACTION_ACTIVE')
    columns = ('project_id', 'version_key', 'snapshot_id', 'record_bytes', 'record_bytes_sha256',
               'profile_version_json', 'mode', 'enabled', 'configuration_complete')
    values = tuple(getattr(record, name) for name in columns)
    try:
        with connection.transaction():
            connection.execute("SET LOCAL lock_timeout = '5s'")
            connection.execute("SET LOCAL statement_timeout = '30s'")
            inserted = connection.execute('''INSERT INTO ifpmic.profile_catalog
                (project_id,version_key,snapshot_id,record_bytes,record_bytes_sha256,profile_version_json,mode,enabled,configuration_complete)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING RETURNING snapshot_id''', values).fetchone()
            existing = connection.execute('''SELECT project_id,version_key,snapshot_id,record_bytes,record_bytes_sha256,
                profile_version_json,mode,enabled,configuration_complete FROM ifpmic.profile_catalog
                WHERE project_id=%s AND version_key=%s''', values[:2]).fetchone()
            if existing is None or tuple(existing) != values:
                raise CatalogError('PROFILE_VERSION_CONFLICT')
        return {'imported': inserted is not None, 'snapshot_id': record.snapshot_id, 'version_key': record.version_key}
    except CatalogError:
        raise
    except Exception:
        raise CatalogError('CATALOG_IO') from None


def main():
    """Explicit private operator import. No grant, replacement, or path in stdin."""
    import asyncio
    import json
    import os
    import sys
    import psycopg
    from .snapshot_bridge import BridgeError, SnapshotBridge, STDIN_LIMIT, _json

    try:
        config = [os.environ.get(name) for name in ('IFPMIC_NODE_EXECUTABLE', 'IFPMIC_PROFILE_STORE', 'IFPMIC_OPERATOR_DSN')]
        if len(sys.argv) != 1 or not all(config):
            raise CatalogError('CATALOG_CONFIG_INVALID')
        raw = sys.stdin.buffer.read(STDIN_LIMIT + 1)
        try:
            value = _json(raw.decode('utf-8'))
            if (len(raw) > STDIN_LIMIT or not isinstance(value, dict) or set(value) != {'project_id', 'profile_version'} or
                    any(not isinstance(item, str) for item in value.values())):
                raise ValueError()
        except Exception:
            raise CatalogError('CATALOG_REQUEST_INVALID') from None
        node, store, dsn = config
        record = asyncio.run(SnapshotBridge(node, store).read_snapshot(value['project_id'], value['profile_version']))
        with psycopg.connect(dsn, autocommit=True, connect_timeout=10) as connection:
            result = import_snapshot(connection, record)
        print(json.dumps(result, separators=(',', ':')))
    except Exception as error:
        code = error.code if isinstance(error, (CatalogError, BridgeError)) else 'CATALOG_IO'
        print(json.dumps({'error': {'code': code}}, separators=(',', ':')))
        sys.exit(3 if code in {'CATALOG_IO', 'BRIDGE_UNAVAILABLE', 'BRIDGE_TIMEOUT'} else 2)


if __name__ == '__main__':
    main()
