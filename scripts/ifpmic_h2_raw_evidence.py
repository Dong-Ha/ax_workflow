"""Read-only H2 owner/query recorder audit; not a full H2 acceptance gate.

Only stdlib imports. Source-declared artifact/history/process checks and the
reviewed full-490 runner remain separate mandatory integration work.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
import os
from pathlib import Path
import re
import stat
from uuid import UUID


class EvidenceError(ValueError):
    """Fixed, non-sensitive failure code; never include raw observation values."""


@dataclass(frozen=True)
class RecorderRequirement:
    node_id: str
    minimum_owner: int = 0
    queries_min: dict[str, int] = field(default_factory=dict)
    queries_max: dict[str, int] = field(default_factory=dict)


def _require(condition, code):
    if not condition:
        raise EvidenceError(code)


def _node(value):
    return (isinstance(value, str) and '::' in value and
            not any(c in value for c in ('\n', '\r', '\x00')) and
            not re.search(r' \((?:setup|call|teardown)\)$', value))


def _natural(value):
    return type(value) is int and value >= 0


def _canonical(value):
    try:
        return json.dumps(value, ensure_ascii=True, sort_keys=True,
                          separators=(',', ':'), allow_nan=False).encode('ascii')
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise EvidenceError('INVALID_JSON_VALUE') from None


def _pairs(values):
    result = {}
    for key, value in values:
        _require(key not in result, 'DUPLICATE_JSON_KEY')
        result[key] = value
    return result


def _reject_constant(_value):
    raise EvidenceError('NONFINITE_JSON')


def _decode(raw):
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=_pairs,
                           parse_constant=_reject_constant)
        _canonical(value)  # Also reject overflowed floats such as 1e999.
        return value
    except EvidenceError:
        raise
    except (UnicodeError, ValueError, RecursionError):
        raise EvidenceError('INVALID_JSON') from None


def _directory(fd):
    info = os.fstat(fd)
    _require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and
             stat.S_IMODE(info.st_mode) == 0o700, 'INVALID_PRIVATE_DIRECTORY')


def _open_directory(name, parent_fd=None):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                     dir_fd=parent_fd)
    except OSError:
        raise EvidenceError('PRIVATE_DIRECTORY_UNAVAILABLE') from None
    try:
        _directory(fd)
        return fd
    except BaseException:
        os.close(fd)
        raise


def _read_file(name, parent_fd, max_bytes):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
                     dir_fd=parent_fd)
    except OSError:
        raise EvidenceError('PRIVATE_FILE_UNAVAILABLE') from None
    try:
        before = os.fstat(fd)
        _require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid() and
                 stat.S_IMODE(before.st_mode) == 0o600 and before.st_nlink == 1,
                 'INVALID_PRIVATE_FILE')
        _require(before.st_size <= max_bytes, 'RECORD_TOO_LARGE')
        chunks, count = [], 0
        while True:
            chunk = os.read(fd, min(65536, max_bytes + 1 - count))
            if not chunk:
                break
            chunks.append(chunk)
            count += len(chunk)
            _require(count <= max_bytes, 'RECORD_TOO_LARGE')
        after = os.fstat(fd)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_uid, s.st_mode, s.st_nlink,
                              s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        _require(identity(before) == identity(after) and count == before.st_size,
                 'RECORD_CHANGED_DURING_READ')
        return b''.join(chunks)
    finally:
        os.close(fd)


def _uuid(value):
    try:
        return isinstance(value, str) and str(UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def _metadata(record, filename, known_nodes):
    _require(type(record) is dict, 'INVALID_RECORD')
    current = record.get('pytest_current_test')
    _require(isinstance(current, str), 'INVALID_TEST_ID')
    match = re.fullmatch(r'(.+) \((setup|call|teardown)\)', current)
    _require(match is not None, 'INVALID_TEST_PHASE')
    node, phase = match.groups()
    _require(node in known_nodes, 'UNEXPECTED_TEST_ID')
    observed = record.get('observed_monotonic_ns')
    _require(type(observed) is int and observed > 0, 'INVALID_OBSERVATION_TIME')
    _require(re.fullmatch(rf'{observed}-[0-9a-f]{{32}}\.json', filename) is not None,
             'INVALID_RECORD_FILENAME')
    caller = record.get('caller')
    _require(type(caller) is dict and set(caller) == {'file', 'function', 'line'}, 'INVALID_CALLER')
    _require(isinstance(caller['file'], str) and caller['file'].endswith('.py') and
             '/' not in caller['file'] and '\\' not in caller['file'] and
             isinstance(caller['function'], str) and bool(caller['function']) and
             type(caller['line']) is int and caller['line'] > 0, 'INVALID_CALLER')
    return node, phase


def _owner(record, job_id):
    _require(set(record) == {'kind', 'job_id', 'pytest_current_test', 'observed_monotonic_ns',
                             'caller', 'snapshot_sha256', 'snapshot'}, 'INVALID_OWNER_RECORD')
    _require(record['kind'] == 'ifpmic.b03.h2.owner-snapshot-observation.v1' and
             _uuid(job_id) and record['job_id'] == job_id, 'INVALID_OWNER_IDENTITY')
    snapshot = record['snapshot']
    widths = {'bindings': 27, 'scopes': 6, 'receipts': 9, 'attempts': 5}
    _require(type(snapshot) is dict and set(snapshot) ==
             {'accepted', 'bindings', 'scopes', 'receipts', 'attempts', 'noncreate_commands'},
             'MISSING_RAW_SNAPSHOT')
    _require(snapshot['accepted'] is None or
             (type(snapshot['accepted']) is list and len(snapshot['accepted']) == 23),
             'INVALID_ACCEPTED_ROW')
    _require(_natural(snapshot['noncreate_commands']), 'INVALID_NONCREATE_COUNT')
    for name, width in widths.items():
        rows = snapshot[name]
        _require(type(rows) is list and all(type(row) is list and len(row) == width for row in rows),
                 'INVALID_SNAPSHOT_ROWS')
    actual = hashlib.sha256(_canonical(snapshot)).hexdigest()
    _require(record['snapshot_sha256'] == actual, 'SNAPSHOT_DIGEST_MISMATCH')


def _query(record):
    _require(set(record) == {'kind', 'operation', 'subject', 'result', 'pytest_current_test',
                             'observed_monotonic_ns', 'caller'}, 'MISSING_RAW_QUERY')
    _require(record['kind'] == 'ifpmic.b03.h2.query-observation.v1', 'INVALID_QUERY_KIND')
    operation = record['operation']
    _require(isinstance(operation, str) and bool(operation) and len(operation) <= 256 and
             operation.strip() == operation and all(ord(c) >= 32 for c in operation),
             'INVALID_QUERY_OPERATION')
    _require(isinstance(record['subject'], str), 'INVALID_QUERY_SUBJECT')
    return operation


def audit_recorders(root: Path, requirements: list[RecorderRequirement], *,
                    known_nodes: set[str] | None = None, max_bytes: int = 64 * 1024 * 1024) -> dict:
    """Validate every retained owner/query record, applying each node's own minima.

    Returns a private file hash index and counts only. Raw rows/results remain in
    the inspected files. It never certifies history, lifecycle, SQL semantics,
    invocation completeness, test success, or full H2 acceptance.
    """
    _require(type(max_bytes) is int and max_bytes > 0, 'INVALID_SIZE_LIMIT')
    expected = {}
    for requirement in requirements:
        _require(isinstance(requirement, RecorderRequirement) and _node(requirement.node_id),
                 'INVALID_REQUIREMENT')
        _require(requirement.node_id not in expected, 'DUPLICATE_REQUIREMENT')
        _require(_natural(requirement.minimum_owner), 'INVALID_OWNER_MINIMUM')
        _require(type(requirement.queries_min) is dict and type(requirement.queries_max) is dict,
                 'INVALID_QUERY_LIMITS')
        for operation, minimum in requirement.queries_min.items():
            _require(isinstance(operation, str) and bool(operation) and _natural(minimum) and minimum > 0,
                     'INVALID_QUERY_MINIMUM')
        for operation, maximum in requirement.queries_max.items():
            _require(operation in requirement.queries_min and _natural(maximum) and
                     maximum >= requirement.queries_min[operation], 'INVALID_QUERY_MAXIMUM')
        expected[requirement.node_id] = requirement
    _require(bool(expected), 'EMPTY_REQUIREMENTS')
    known = set(expected) if known_nodes is None else known_nodes
    _require(isinstance(known, set) and all(_node(node) for node in known) and set(expected) <= known,
             'INVALID_KNOWN_NODES')
    root = Path(root)
    _require(root.is_absolute() and '..' not in root.parts, 'INVALID_ROOT_PATH')
    try:
        _require(root.resolve(strict=True) == root, 'SYMLINK_ROOT_PATH')
        root_identity = root.lstat()
    except (OSError, RuntimeError):
        raise EvidenceError('PRIVATE_ROOT_UNAVAILABLE') from None
    root_fd = _open_directory(root)
    counts = {node: {'owner_records': 0, 'query_records': {}} for node in known}
    manifest = []
    seen_observations = set()

    def read_records(directory_fd, prefix, job_id=None):
        for name in sorted(os.listdir(directory_fd)):
            raw = _read_file(name, directory_fd, max_bytes)
            record = _decode(raw)
            node, phase = _metadata(record, name, known)
            identity = hashlib.sha256(_canonical(record)).hexdigest()
            _require(identity not in seen_observations, 'DUPLICATE_OBSERVATION')
            seen_observations.add(identity)
            if job_id is not None:
                _owner(record, job_id)
                counts[node]['owner_records'] += 1
            else:
                operation = _query(record)
                queries = counts[node]['query_records']
                queries[operation] = queries.get(operation, 0) + 1
            manifest.append({'path': prefix + '/' + name, 'sha256': hashlib.sha256(raw).hexdigest(),
                             'bytes': len(raw), 'node_id': node, 'pytest_phase': phase,
                             'kind': record['kind']})

    try:
        opened_root = os.fstat(root_fd)
        _require((opened_root.st_dev, opened_root.st_ino) ==
                 (root_identity.st_dev, root_identity.st_ino), 'ROOT_CHANGED_DURING_OPEN')
        names = os.listdir(root_fd)
        if 'owner-snapshots' in names:
            owners_fd = _open_directory('owner-snapshots', root_fd)
            try:
                for job_id in sorted(os.listdir(owners_fd)):
                    _require(_uuid(job_id), 'INVALID_OWNER_DIRECTORY')
                    job_fd = _open_directory(job_id, owners_fd)
                    try:
                        read_records(job_fd, 'owner-snapshots/' + job_id, job_id)
                    finally:
                        os.close(job_fd)
            finally:
                os.close(owners_fd)
        if 'query-observations' in names:
            query_fd = _open_directory('query-observations', root_fd)
            try:
                read_records(query_fd, 'query-observations')
            finally:
                os.close(query_fd)
        for node, requirement in expected.items():
            own = counts[node]
            _require(own['owner_records'] >= requirement.minimum_owner, 'OWNER_OBSERVATIONS_MISSING')
            for operation, minimum in requirement.queries_min.items():
                count = own['query_records'].get(operation, 0)
                _require(count >= minimum, 'QUERY_OBSERVATIONS_MISSING')
                _require(count <= requirement.queries_max.get(operation, count), 'QUERY_OBSERVATIONS_EXCESS')
        return {'scope': 'owner_query_recorders_only', 'h2_accepted': False,
                'cases': {node: counts[node] for node in expected}, 'files': manifest}
    except OSError:
        raise EvidenceError('PRIVATE_EVIDENCE_IO_FAILED') from None
    finally:
        os.close(root_fd)
