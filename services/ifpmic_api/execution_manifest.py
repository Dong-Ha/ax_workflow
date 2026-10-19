"""Local owner manifests and private launcher configuration; never history data.

These checks assume a trusted local launcher and immutable files during a run.
They are startup consistency checks, not attestation against a hostile host.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

from psycopg.conninfo import conninfo_to_dict

from .execution_identity import ExecutionIdentity
from .execution_protocol import ProtocolError, canonical
from .workspace_fs import WorkspaceFilesystem, identity, safe_info

ROOT = Path(__file__).resolve().parents[2]
MAX_PRIVATE_JSON = 16 * 1024 * 1024


def invalid():
    return ProtocolError('BUILD_UNAVAILABLE')


def absolute_path(value):
    if (type(value) is not str or not value.startswith('/')
            or any(p in ('', '.', '..') for p in value.split('/')[1:])
            or '\x00' in value):
        raise invalid()
    return Path(value)


def private_json(name):
    """Read only a same-owner single-link 0600 regular file in a 0700 parent."""
    path = absolute_path(name)

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise invalid()
            result[key] = value
        return result

    try:
        with WorkspaceFilesystem(str(path.parent)).open_root() as parent:
            before = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
            safe_info(before, stat.S_ISREG, 0o600)
            if before.st_nlink != 1 or before.st_size > MAX_PRIVATE_JSON:
                raise invalid()
            fd = os.open(path.name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC,
                         dir_fd=parent)
            try:
                opened = os.fstat(fd)
                safe_info(opened, stat.S_ISREG, 0o600)
                if identity(opened) != identity(before) or opened.st_nlink != 1:
                    raise invalid()
                with os.fdopen(os.dup(fd), 'rb') as stream:
                    raw = stream.read(MAX_PRIVATE_JSON + 1)
                after = os.fstat(fd)
                current = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
                if (len(raw) > MAX_PRIVATE_JSON or identity(current) != identity(opened)
                        or (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
                        != (after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
                    raise invalid()
            finally:
                os.close(fd)
        value = json.loads(raw, object_pairs_hook=pairs)
        canonical(value)  # Also rejects floats, NaN and infinities.
        return value
    except Exception:
        raise invalid() from None


def file_sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def manifest_sha(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def source_manifest():
    """Include the whole service's Python source, migrations and runtime lock."""
    package = ROOT / 'services/ifpmic_api'
    paths = sorted([*package.glob('*.py'), *package.glob('migrations/*.sql'),
                    package / 'requirements-temporal.lock'])
    files = {}
    for path in paths:
        if not stat.S_ISREG(path.lstat().st_mode):
            raise invalid()
        files[path.relative_to(ROOT).as_posix()] = file_sha(path)
    return {'format': 'ifpmic.h2.source.v1', 'files': files}


def environment_manifest():
    """Hash the active qualified venv; retain H1's cache/symlink policy."""
    prefix = Path(sys.prefix)
    if sys.prefix == sys.base_prefix or not (prefix / 'pyvenv.cfg').is_file():
        raise invalid()
    files = {}
    for path in sorted(prefix.rglob('*')):
        if '__pycache__' in path.parts or path.suffix == '.pyc':
            continue
        name = path.relative_to(prefix).as_posix()
        if path.is_symlink():
            files[name + ':symlink'] = hashlib.sha256(os.readlink(path).encode()).hexdigest()
        elif path.is_file():
            files[name] = file_sha(path)
    return {'format': 'ifpmic.h2.environment.v1', 'files': files,
            'interpreter_sha256': file_sha(Path(sys.executable).resolve()),
            'python_version': list(sys.version_info[:3])}


def verify_loaded_environment():
    # -B alone still reads existing pyc. A fresh, empty private cache prefix
    # makes imports compile current source; -B keeps that prefix empty.
    if (not sys.dont_write_bytecode or not sys.pycache_prefix
            or any(os.environ.get(k) for k in ('PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP'))):
        raise invalid()
    with WorkspaceFilesystem(str(absolute_path(sys.pycache_prefix))).open_root() as fd:
        if os.listdir(fd):
            raise invalid()


def local_dsn(value):
    # Explicit per-role credentials only. No ambient libpq service/password file,
    # host lists, TCP fallback, arbitrary options or caller-selected auth mode.
    try:
        if type(value) is not str or any(k.startswith('PG') for k in os.environ):
            raise invalid()
        fields = conninfo_to_dict(value)
        required = {'host', 'port', 'dbname', 'user', 'password'}
        if set(fields) != required or any(not fields[k] for k in required):
            raise invalid()
        if ',' in fields['host']:
            raise invalid()
        WorkspaceFilesystem(str(absolute_path(fields['host']))).check_root()
        port = fields['port']
        if not port.isascii() or not port.isdecimal() or str(int(port)) != port or not 1 <= int(port) <= 65535:
            raise invalid()
        return value
    except Exception:
        raise invalid() from None


def load_config(name):
    """Validate all files/identity before opening PG or connecting to Temporal."""
    try:
        verify_loaded_environment()
        value = private_json(name)
        if (type(value) is not dict or set(value) != {
                'format', 'mode', 'identity', 'dsn', 'workspace_root',
                'source_manifest_path', 'environment_manifest_path'}
                or value['format'] != 'ifpmic.h2.runtime.v1'
                or value['mode'] not in ('dispatcher', 'worker')):
            raise invalid()
        execution = ExecutionIdentity(**value['identity'])
        execution.validate()
        # This launcher is deliberately limited to the qualified local server.
        host, port = execution.server_endpoint.split(':')
        if (host != '127.0.0.1' or not port.isascii() or not port.isdecimal()
                or str(int(port)) != port or not 1 <= int(port) <= 65535):
            raise invalid()
        for name, actual, expected in (
                (value['source_manifest_path'], source_manifest(), execution.source_manifest_sha256),
                (value['environment_manifest_path'], environment_manifest(), execution.environment_manifest_sha256)):
            pinned = private_json(name)
            if pinned != actual or manifest_sha(pinned) != expected:
                raise invalid()
        local_dsn(value['dsn'])
        WorkspaceFilesystem(str(absolute_path(value['workspace_root']))).check_root()
        return value, execution
    except Exception:
        raise invalid() from None
