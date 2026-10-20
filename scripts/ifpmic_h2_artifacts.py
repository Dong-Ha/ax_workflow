"""Private case-artifact audit. Full H2 acceptance still requires reviewed runtime oracles.

History decoding is a mandatory injected operation for PBSeq files. The full
runner must bind it to the qualified Temporal protobuf type; stdlib unit tests
may supply synthetic decoders without establishing real history acceptance.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import fnmatch
import hashlib
import os
from pathlib import Path
import struct
from typing import Callable

from scripts.ifpmic_h2_raw_evidence import (
    EvidenceError, _decode, _node, _open_directory, _read_file, _require,
)


@dataclass(frozen=True)
class ArtifactRule:
    path: str
    format: str
    minimum: int = 1
    maximum: int = 1
    required_keys: tuple[str, ...] = ()
    node_field: str | None = None
    sha256_links: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class CaseArtifacts:
    node_id: str
    case_directory: str
    artifacts: tuple[ArtifactRule, ...]
    identity_file: str | None = None


def _segments(pattern, *, directory=False):
    _require(isinstance(pattern, str) and bool(pattern), 'INVALID_ARTIFACT_PATTERN')
    if directory and pattern == '.':
        return []
    parts = pattern.split('/')
    _require(all(part and part not in ('.', '..') and
                 not any(c in part for c in ('\\', '?', '[', ']', '\x00', '\n', '\r')) and
                 '**' not in part for part in parts), 'INVALID_ARTIFACT_PATTERN')
    return parts


def _matches(directory_fd, parts, prefix='', *, directories=False):
    """Resolve only selected components with descriptor-relative, no-follow opens."""
    if not parts:
        yield prefix or '.', os.dup(directory_fd)
        return
    head, *tail = parts
    names = sorted(os.listdir(directory_fd)) if '*' in head else [head]
    for name in names:
        if not fnmatch.fnmatchcase(name, head):
            continue
        relative = prefix + '/' + name if prefix else name
        # A literal absent file is a non-match; an existing unsafe path fails.
        try:
            os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        except FileNotFoundError:
            continue
        if tail or directories:
            child_fd = _open_directory(name, directory_fd)
            try:
                yield from _matches(child_fd, tail, relative, directories=directories)
            finally:
                os.close(child_fd)
        else:
            # Consumer receives an owned parent descriptor for its file read.
            yield relative, os.dup(directory_fd)


def _gather_matches(directory_fd, parts, *, directories=False):
    matches = []
    iterator = _matches(directory_fd, parts, directories=directories)
    try:
        for entry in iterator:
            matches.append(entry)
        return matches
    except BaseException:
        for _, fd in matches:
            os.close(fd)
        raise
    finally:
        iterator.close()


def _read_exact(directory_fd, path, max_bytes):
    parts = _segments(path)
    _require(not any('*' in part for part in parts), 'WILDCARD_DIGEST_TARGET')
    current = os.dup(directory_fd)
    try:
        for part in parts[:-1]:
            next_fd = _open_directory(part, current)
            os.close(current)
            current = next_fd
        return _read_file(parts[-1], current, max_bytes)
    finally:
        os.close(current)


def _pointer(document, pointer):
    _require(isinstance(pointer, str) and pointer.startswith('/'), 'INVALID_DIGEST_POINTER')
    current = document
    for token in pointer[1:].split('/'):
        _require('~' not in token.replace('~0', '').replace('~1', ''), 'INVALID_DIGEST_POINTER')
        key = token.replace('~1', '/').replace('~0', '~')
        if type(current) is list:
            _require(key.isascii() and key.isdecimal() and len(key) <= 20 and str(int(key)) == key and
                     int(key) < len(current), 'DIGEST_FIELD_MISSING')
            current = current[int(key)]
        else:
            _require(type(current) is dict and key in current, 'DIGEST_FIELD_MISSING')
            current = current[key]
    return current


def _history(raw, decoder):
    _require(decoder is not None and callable(decoder), 'HISTORY_DECODER_REQUIRED')
    frames, offset = [], 0
    while offset < len(raw):
        _require(len(raw) - offset >= 8, 'TRUNCATED_HISTORY_FRAME')
        size = struct.unpack_from('>Q', raw, offset)[0]
        offset += 8
        _require(size > 0 and size <= len(raw) - offset, 'INVALID_HISTORY_FRAME_LENGTH')
        frames.append(raw[offset:offset + size])
        offset += size
    _require(bool(frames), 'EMPTY_HISTORY')
    try:
        events = decoder(tuple(frames))
    except Exception:
        raise EvidenceError('HISTORY_DECODE_FAILED') from None
    _require(type(events) is list and len(events) == len(frames), 'HISTORY_EVENT_COUNT_MISMATCH')
    for index, event in enumerate(events, start=1):
        _require(type(event) is dict and type(event.get('event_id')) is int and
                 event['event_id'] == index and type(event.get('event_type')) is int and
                 event['event_type'] > 0, 'INVALID_HISTORY_EVENT')
    _require(events[0]['event_type'] == 1 and
             sum(event['event_type'] == 1 for event in events) == 1,
             'INVALID_WORKFLOW_STARTED_EVENT')
    return {'event_count': len(events), 'frame_sha256': [hashlib.sha256(frame).hexdigest() for frame in frames]}


def _document(raw, rule, node, case_fd, max_bytes):
    if rule.format == 'jsonl':
        lines = raw.splitlines()
        _require(bool(lines) and all(line.strip() for line in lines), 'EMPTY_JSON_JOURNAL')
        documents = [_decode(line) for line in lines]
    else:
        documents = [_decode(raw)]
    if rule.node_field is not None:
        _require(isinstance(rule.node_field, str) and bool(rule.node_field), 'INVALID_NODE_FIELD')
        _require(all(type(row) is dict for row in documents), 'INVALID_NODE_JOURNAL')
        documents = [row for row in documents if row.get(rule.node_field) == node]
        _require(bool(documents), 'CASE_JOURNAL_RECORD_MISSING')
    for document in documents:
        if rule.required_keys:
            _require(type(document) is dict and set(rule.required_keys) <= set(document),
                     'ARTIFACT_FIELDS_MISSING')
        for pointer, target in rule.sha256_links.items():
            actual = hashlib.sha256(_read_exact(case_fd, target, max_bytes)).hexdigest()
            _require(_pointer(document, pointer) == actual, 'ARTIFACT_DIGEST_MISMATCH')
    return {'document_count': len(documents)}


def audit_artifacts(root: Path, cases: list[CaseArtifacts], *,
                    decode_history: Callable | None = None,
                    max_bytes: int = 64 * 1024 * 1024) -> dict:
    """Audit case-specific file presence, format, raw hashes and declared links.

    The private result is an index, not a substitute for the retained files or
    complete source/test/lifecycle evidence. Conditional rules must already be
    resolved from each literal test; this API does not infer applicability.
    """
    _require(type(max_bytes) is int and max_bytes > 0, 'INVALID_SIZE_LIMIT')
    _require(bool(cases), 'EMPTY_ARTIFACT_CASES')
    seen_nodes = set()
    for case in cases:
        _require(isinstance(case, CaseArtifacts) and _node(case.node_id), 'INVALID_ARTIFACT_CASE')
        _require(case.node_id not in seen_nodes, 'DUPLICATE_ARTIFACT_CASE')
        seen_nodes.add(case.node_id)
        _segments(case.case_directory, directory=True)
        if case.identity_file is not None:
            _require(not any('*' in part for part in _segments(case.identity_file)),
                     'INVALID_IDENTITY_PATH')
        _require(bool(case.artifacts), 'EMPTY_CASE_ARTIFACTS')
        seen_paths = set()
        for rule in case.artifacts:
            _require(isinstance(rule, ArtifactRule), 'INVALID_ARTIFACT_RULE')
            _segments(rule.path)
            _require(rule.path not in seen_paths, 'DUPLICATE_ARTIFACT_RULE')
            seen_paths.add(rule.path)
            _require(rule.format in ('json', 'jsonl', 'pbseq', 'bytes'), 'INVALID_ARTIFACT_FORMAT')
            _require(type(rule.minimum) is int and type(rule.maximum) is int and
                     0 < rule.minimum <= rule.maximum, 'INVALID_ARTIFACT_LIMITS')
            _require(type(rule.required_keys) is tuple and all(isinstance(key, str) and key
                     for key in rule.required_keys), 'INVALID_ARTIFACT_KEYS')
            _require(type(rule.sha256_links) is dict, 'INVALID_ARTIFACT_LINKS')
            _require(rule.format in ('json', 'jsonl') or
                     (not rule.required_keys and not rule.sha256_links and rule.node_field is None),
                     'NONJSON_ARTIFACT_CONSTRAINT')
            for pointer, target in rule.sha256_links.items():
                _require(isinstance(pointer, str) and pointer.startswith('/'), 'INVALID_DIGEST_POINTER')
                _segments(target)
    root = Path(root)
    _require(root.is_absolute() and '..' not in root.parts, 'INVALID_ROOT_PATH')
    try:
        _require(root.resolve(strict=True) == root, 'SYMLINK_ROOT_PATH')
        identity = root.lstat()
    except (OSError, RuntimeError):
        raise EvidenceError('PRIVATE_ROOT_UNAVAILABLE') from None
    root_fd = _open_directory(root)
    results = {}
    claimed_paths = {}
    try:
        opened = os.fstat(root_fd)
        _require((identity.st_dev, identity.st_ino) == (opened.st_dev, opened.st_ino), 'ROOT_CHANGED_DURING_OPEN')
        for case in cases:
            directories = _gather_matches(root_fd, _segments(case.case_directory, directory=True), directories=True)
            try:
                selected = directories
                if case.identity_file is not None:
                    selected = []
                    for name, fd in directories:
                        identity_record = _decode(_read_exact(fd, case.identity_file, max_bytes))
                        _require(type(identity_record) is dict and set(identity_record) ==
                                 {'kind', 'node_id', 'pytest_current_test'} and
                                 identity_record['kind'] == 'ifpmic.b03.h2.case-identity.v1' and
                                 _node(identity_record['node_id']) and
                                 identity_record['pytest_current_test'] in
                                 {identity_record['node_id'] + ' (' + stage + ')'
                                  for stage in ('setup', 'call', 'teardown')}, 'INVALID_CASE_IDENTITY')
                        if identity_record['node_id'] == case.node_id:
                            selected.append((name, fd))
                _require(len(selected) == 1, 'CASE_DIRECTORY_MISSING_OR_AMBIGUOUS')
                directory_name, case_fd = selected[0]
                manifest = []
                seen_case_paths = set()
                for rule in case.artifacts:
                    matches = _gather_matches(case_fd, _segments(rule.path))
                    try:
                        _require(rule.minimum <= len(matches) <= rule.maximum, 'ARTIFACT_MATCH_COUNT')
                        for relative, parent_fd in matches:
                            raw = _read_file(relative.rsplit('/', 1)[-1], parent_fd, max_bytes)
                            details = {}
                            if rule.format in ('json', 'jsonl'):
                                details = _document(raw, rule, case.node_id, case_fd, max_bytes)
                            elif rule.format == 'pbseq':
                                details = _history(raw, decode_history)
                            path = relative if directory_name == '.' else directory_name + '/' + relative
                            _require(path not in seen_case_paths, 'DUPLICATE_CASE_ARTIFACT')
                            seen_case_paths.add(path)
                            previous = claimed_paths.get(path)
                            if path in claimed_paths:
                                _require(rule.node_field is not None and previous == rule.node_field,
                                         'UNSCOPED_SHARED_ARTIFACT')
                            claimed_paths[path] = rule.node_field
                            manifest.append({'path': path, 'sha256': hashlib.sha256(raw).hexdigest(),
                                             'bytes': len(raw), 'format': rule.format, **details})
                    finally:
                        for _, fd in matches:
                            os.close(fd)
                results[case.node_id] = {'case_directory': directory_name, 'files': manifest}
            finally:
                for _, fd in directories:
                    os.close(fd)
        return {'scope': 'case_artifact_structure_and_decoded_history_only',
                'h2_accepted': False, 'cases': results}
    except OSError:
        raise EvidenceError('PRIVATE_ARTIFACT_IO_FAILED') from None
    finally:
        os.close(root_fd)


def prepare_phase_rules(document: dict, phase: str, phase_nodes: set[str],
                        expected_nodes: set[str]):
    """Bind one phase to exact reviewed case IDs; unresolved drafts fail closed.

    Expected IDs must come from the separately reviewed full execution contract,
    not be inferred from this document's own rows. Approval lives outside this
    data document, in the full runner's paired source and pre-gate reviews.
    """
    from scripts.ifpmic_h2_raw_evidence import RecorderRequirement

    _require(type(document) is dict and document.get('kind') ==
             'ifpmic.b03.h2.runtime-full-machine-evidence-rules.v1', 'INVALID_MACHINE_RULES')
    _require(document.get('status') == 'candidate_pending_exact_review' and
             document.get('unresolved') == [], 'UNRESOLVED_MACHINE_RULES')
    _require(isinstance(phase, str) and bool(phase) and isinstance(phase_nodes, set) and
             isinstance(expected_nodes, set) and bool(expected_nodes) and
             all(_node(node) for node in phase_nodes | expected_nodes), 'INVALID_PHASE_BINDING')
    rows = document.get('cases')
    _require(type(rows) is list and all(type(row) is dict for row in rows), 'INVALID_MACHINE_CASES')
    identifiers = [row.get('node_id') for row in rows]
    _require(all(_node(node) for node in identifiers) and len(set(identifiers)) == len(identifiers) and
             set(identifiers) == expected_nodes, 'MACHINE_CASE_SET_MISMATCH')
    selected, recorders = [], []
    for row in rows:
        _require(row.get('unresolved') == [], 'UNRESOLVED_CASE_RULES')
        if row.get('phase') != phase:
            _require(row['node_id'] not in phase_nodes, 'CASE_PHASE_MISMATCH')
            continue
        _require(row['node_id'] in phase_nodes, 'CASE_PHASE_MISMATCH')
        _require(type(row.get('artifacts')) is list, 'INVALID_MACHINE_ARTIFACTS')
        artifacts = []
        for item in row['artifacts']:
            _require(type(item) is dict and set(item) <=
                     {'path', 'format', 'minimum', 'maximum', 'required_keys', 'node_field', 'sha256_links'},
                     'UNKNOWN_ARTIFACT_CONSTRAINT')
            _require({'path', 'format', 'minimum', 'maximum', 'required_keys'} <= set(item) and
                     type(item['required_keys']) is list, 'INVALID_MACHINE_ARTIFACT')
            artifacts.append(ArtifactRule(path=item['path'], format=item['format'],
                minimum=item['minimum'], maximum=item['maximum'], required_keys=tuple(item['required_keys']),
                node_field=item.get('node_field'), sha256_links=item.get('sha256_links', {})))
        _require({'minimum_owner', 'queries_min', 'queries_max', 'case_directory'} <= set(row),
                 'MACHINE_RECORDER_RULE_MISSING')
        recorders.append(RecorderRequirement(row['node_id'], row['minimum_owner'],
                                             row['queries_min'], row['queries_max']))
        selected.append(CaseArtifacts(row['node_id'], row['case_directory'], tuple(artifacts),
                                      identity_file=row.get('identity_file')))
    _require(bool(selected), 'NO_RAW_CASES_FOR_PHASE')
    return recorders, selected
