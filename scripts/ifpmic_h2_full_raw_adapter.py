"""Full-runner raw-evidence integration; import only after exact pre-gate.

This module is source-only until the full runner and versioned contract are
reviewed. The checker unit results do not cover these process integration hooks.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import time

from scripts.ifpmic_h2_raw_evidence import _decode, _open_directory, _read_file, _require


FENCE_NODES = {
    'tests/ifpmic_api/test_workflow_schema.py::test_h2_real_create_activation_receipt_replay_and_run_fences',
    'tests/ifpmic_api/test_workflow_schema.py::test_h2_role_registry_and_function_acl_match_static_contract',
    'tests/ifpmic_api/test_workflow_schema.py::test_h2_four_role_oid_recreation_is_drift_and_does_not_rebind',
    'tests/ifpmic_api/test_workflow_schema.py::test_h2_service_roles_use_scram_without_trust_fallthrough',
}


def _private_write(directory, name, data):
    directory_fd = _open_directory(directory)
    try:
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=directory_fd)
        with os.fdopen(fd, 'wb') as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
    finally:
        os.close(directory_fd)


def _private_read(path):
    fd = _open_directory(path.parent)
    try:
        return _read_file(path.name, fd, 64 * 1024 * 1024)
    finally:
        os.close(fd)


def validate_policy(root, contract, ledger, phases):
    policy = contract['per_case_raw_evidence']
    new_nodes = {node for phase in ledger['additional_phases'] for node in phase['node_ids']}
    declared_nodes = [row['node_id'] for row in ledger['new_cases']]
    _require(len(new_nodes) == 83 and len(declared_nodes) == 83 and set(declared_nodes) == new_nodes,
             'RAW_NEW_NODE_INVENTORY_MISMATCH')
    expected = new_nodes | FENCE_NODES
    _require(len(expected) == 87 and type(policy.get('expected_node_ids')) is list and
             len(policy['expected_node_ids']) == 87 and set(policy['expected_node_ids']) == expected,
             'RAW_POLICY_NODE_SET_MISMATCH')
    _require(policy.get('audit_timeout_seconds') == 10 and
             policy.get('audit_phase_count') == 10 and policy.get('extra_overhead_seconds') == 200 and
             contract['limits']['outer_gate_seconds'] == 16220, 'RAW_POLICY_TIMING_MISMATCH')
    rules_path = root / policy['rules']['path']
    raw = rules_path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    _require(digest == policy['rules']['sha256'], 'RAW_RULES_PIN_MISMATCH')
    rules = _decode(raw)
    _require(type(rules) is dict and rules.get('status') == 'candidate_pending_exact_review' and
             rules.get('unresolved') == [], 'RAW_RULES_NOT_FROZEN')
    cases = rules.get('cases')
    _require(type(cases) is list and len(cases) == 87 and
             all(type(row) is dict for row in cases), 'RAW_RULE_CASES_INVALID')
    _require({row.get('node_id') for row in cases} == expected, 'RAW_RULE_NODE_SET_MISMATCH')
    phase_by_node = {node: phase['id'] for phase in phases for node in phase['node_ids']}
    _require(all(row.get('phase') == phase_by_node[row['node_id']] and row.get('unresolved') == []
                 for row in cases), 'RAW_RULE_PHASE_MISMATCH')
    _require(len({row['phase'] for row in cases}) == 10, 'RAW_RULE_PHASE_COUNT_MISMATCH')
    from scripts.ifpmic_h2_artifacts import prepare_phase_rules
    for phase in phases:
        if expected.intersection(phase['node_ids']):
            prepare_phase_rules(rules, phase['id'], set(phase['node_ids']), expected)
    for row in cases:
        paths = {item['path'] for item in row['artifacts']}
        _require(row.get('identity_file') is None or row['identity_file'] in paths,
                 'RAW_IDENTITY_ARTIFACT_MISSING')
        for artifact in row['artifacts']:
            # Every linked read must also be indexed for the final file recheck.
            _require(all(target in paths for target in artifact.get('sha256_links', {}).values()),
                     'RAW_DIGEST_TARGET_NOT_INDEXED')
    return {'policy': policy, 'rules_sha256': digest, 'cases': cases, 'expected_nodes': expected}


def audit_phase(root, phase, directory, observations, interpreter, env, state, run_owned_command):
    expected = {row['node_id'] for row in state['cases'] if row['phase'] == phase['id']}
    if not expected:
        return None
    config = {'kind': 'ifpmic.h2.raw-audit-input.v1', 'rules_sha256': state['rules_sha256'],
              'phase': phase['id'], 'phase_nodes': phase['node_ids'],
              'expected_nodes': sorted(state['expected_nodes']), 'observations': str(observations)}
    payload = (json.dumps(config, ensure_ascii=True, sort_keys=True) + '\n').encode('ascii')
    config_path = directory / 'raw-audit-input.json'
    _private_write(directory, config_path.name, payload)
    cache = directory / 'raw-audit-pycache'
    cache.mkdir(mode=0o700)
    began = time.monotonic()
    result = run_owned_command([str(interpreter), '-B', '-X', 'pycache_prefix='+str(cache),
                                str(root / state['policy']['auditor']['path']),
                                '--config', str(config_path)], cwd=root,
                               timeout=state['policy']['audit_timeout_seconds'], env=env)
    elapsed = time.monotonic() - began
    _require(not list(cache.iterdir()), 'RAW_AUDIT_BYTECODE_CACHE_POPULATED')
    _private_write(directory, 'raw-audit-child.log', result.stdout + result.stderr)
    _require(result.returncode == 0 and elapsed <= state['policy']['audit_timeout_seconds'],
             'RAW_AUDIT_CHILD_FAILED')
    path = directory / 'raw-case-audit.json'
    raw = _private_read(path)
    document = _decode(raw)
    _require(type(document) is dict and document.get('kind') == 'ifpmic.h2.raw-case-audit.v1' and
             document.get('phase') == phase['id'] and document.get('rules_sha256') == state['rules_sha256'] and
             document.get('node_ids') == sorted(expected) and document.get('source_unchanged') is True and
             document.get('all_scoped_raw_rules_satisfied') is True, 'RAW_AUDIT_RESULT_MISMATCH')
    has_history = any(item['format'] == 'pbseq' for row in state['cases']
                      if row['phase'] == phase['id'] for item in row['artifacts'])
    _require(document.get('decoder') ==
             ('qualified-temporalio-HistoryEvent.FromString' if has_history else None),
             'RAW_AUDIT_DECODER_MISMATCH')
    _require(set(document['recorder_audit']['cases']) == expected and
             set(document['artifact_audit']['cases']) == expected, 'RAW_AUDIT_CASE_INDEX_MISMATCH')
    return {'phase': phase['id'], 'node_ids': sorted(expected), 'path': str(path),
            'sha256': hashlib.sha256(raw).hexdigest(), 'seconds': elapsed,
            'rules_sha256': state['rules_sha256'], 'observations': str(observations)}


def recheck_manifests(proofs, state, *, deadline):
    """Rehash all indexed private raw files before constructing a public proposal."""
    _require(len(proofs) == 10 and len({proof['phase'] for proof in proofs}) == 10,
             'RAW_AUDIT_PROOF_COUNT_MISMATCH')
    observed_nodes, checked_files = [], 0
    for proof in proofs:
        _require(time.monotonic() < deadline, 'RAW_RECHECK_DEADLINE')
        raw = _private_read(Path(proof['path']))
        _require(hashlib.sha256(raw).hexdigest() == proof['sha256'], 'RAW_AUDIT_MANIFEST_CHANGED')
        document = _decode(raw)
        observed_nodes.extend(document['node_ids'])
        index = list(document['recorder_audit']['files'])
        for case in document['artifact_audit']['cases'].values():
            index.extend(case['files'])
        by_path = {}
        for item in index:
            path = item['path']
            _require(isinstance(path, str) and bool(path) and not Path(path).is_absolute() and
                     all(part not in ('', '.', '..') for part in path.split('/')),
                     'UNSAFE_RAW_MANIFEST_PATH')
            _require(path not in by_path or
                     (by_path[path]['sha256'], by_path[path]['bytes']) == (item['sha256'], item['bytes']),
                     'RAW_MANIFEST_HASH_CONFLICT')
            by_path[path] = item
        root_fd = _open_directory(Path(proof['observations']))
        try:
            for relative, item in by_path.items():
                _require(time.monotonic() < deadline, 'RAW_RECHECK_DEADLINE')
                current = os.dup(root_fd)
                try:
                    parts = relative.split('/')
                    for part in parts[:-1]:
                        following = _open_directory(part, current)
                        os.close(current)
                        current = following
                    retained = _read_file(parts[-1], current, 64 * 1024 * 1024)
                    _require(len(retained) == item['bytes'] and hashlib.sha256(retained).hexdigest() == item['sha256'],
                             'RAW_FILE_CHANGED_AFTER_AUDIT')
                    checked_files += 1
                finally:
                    os.close(current)
        finally:
            os.close(root_fd)
    _require(len(observed_nodes) == 87 and set(observed_nodes) == state['expected_nodes'],
             'RAW_AUDIT_FINAL_NODE_UNION_MISMATCH')
    return {'rules_sha256': state['rules_sha256'], 'covered_nodes': 87,
            'audited_phases': 10, 'raw_file_rechecks': checked_files, 'all_indexed_raw_files_unchanged': True}
