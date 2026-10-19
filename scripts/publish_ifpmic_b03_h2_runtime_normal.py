"""Publish only normalized successful H2 normal-runtime evidence; no upload."""
from __future__ import annotations

import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
import zipfile

from verify_ifpmic_b03_h2_runtime_normal import (
    ROOT, EVIDENCE, EXECUTION_SHA, PHASE_ORDER, LONG_IDS, digest, document,
    check_case_progress, check_h1_evidence, check_runtime_evidence, sources,
    check_unchanged_sources,
)


def encode(value):
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, indent=2) + '\n').encode()


def normalized_progress(path):
    states = {}
    for line in path.read_text().splitlines():
        row = json.loads(line)
        filename, name = row['nodeid'].split('::', 1)
        key = filename.removesuffix('.py').replace('/', '.') + '.' + name
        if row['event'] == 'start':
            states[key] = row['monotonic']
        elif row['event'] == 'finish':
            yield {'case_id': key, 'elapsed_seconds': row['monotonic'] - states[key],
                   'total_limit_seconds': 240 if key in LONG_IDS else 30}


def main():
    if len(sys.argv) != 2:
        raise RuntimeError('Expected one private terminal gate directory')
    leaf = (ROOT/Path(sys.argv[1])).resolve()
    if not leaf.is_relative_to(ROOT/'workflow-artifacts/verification/B03/H2/runtime-normal/gates'):
        raise RuntimeError('Not a private H2 normal-runtime gate')
    gate_path = leaf/'gate.json'
    gate = document(gate_path)
    assert gate['verdict'] == 'pass' and gate['source_changes'] == []
    assert gate['environments_unchanged'] is True and gate['owned_children_absent'] is True
    assert gate['source_fingerprint'] == digest(json.dumps(gate['source_hashes'], sort_keys=True).encode())
    assert gate['source_zip_sha256'] == digest((leaf/'candidate-source.zip').read_bytes())
    assert sources() == gate['source_hashes']
    assert check_unchanged_sources() == gate['protected_before']
    with zipfile.ZipFile(leaf/'candidate-source.zip') as candidate:
        assert len(candidate.namelist()) == len(set(candidate.namelist()))
        assert set(candidate.namelist()) == set(gate['source_hashes'])
        assert all(digest(candidate.read(name)) == value
                   for name, value in gate['source_hashes'].items())
    contract_path = EVIDENCE/'h2-runtime-normal-execution-contract.json'
    assert digest(contract_path.read_bytes()) == EXECUTION_SHA
    contract = document(contract_path)
    ledger_path = ROOT/contract['tc_ledger']['path']
    assert digest(ledger_path.read_bytes()) == contract['tc_ledger']['sha256']
    ledger = document(ledger_path)
    for p in (Path(__file__).resolve(), ROOT/'scripts/verify_ifpmic_b03_h2_runtime_normal.py',
              contract_path, ledger_path):
        assert digest(p.read_bytes()) == gate['source_hashes'][str(p.relative_to(ROOT))]
    assert [c['name'] for c in gate['checks']] == list(PHASE_ORDER)
    counts = {'passed': 0, 'failed': 0, 'errors': 0, 'skipped': 0}
    suites = ET.Element('testsuites')
    phase_summaries, timings, postgres = [], [], []
    for check in gate['checks']:
        name = check['name']
        directory = leaf/name
        phase = ledger['phases'][name]
        assert check['status'] == 'pass' and check['exit_code'] == 0
        assert not any(check['counts'][key] for key in ('failed', 'errors', 'skipped'))
        assert check['counts']['tests'] == len(phase['case_ids'])
        assert check_case_progress(directory/'case-progress.jsonl', phase['case_ids']) == check['case_progress']
        cases = list(ET.parse(directory/'pytest.xml').iter('testcase'))
        ids = sorted(c.get('classname')+'.'+c.get('name') for c in cases)
        assert ids == sorted(phase['case_ids']) == sorted(check['case_ids'])
        assert all(c.find(k) is None for c in cases for k in ('failure', 'error', 'skipped'))
        counts['passed'] += len(cases)
        suite = ET.SubElement(suites, 'testsuite', name=name, tests=str(len(cases)),
                              failures='0', errors='0', skipped='0')
        for case in cases:
            ET.SubElement(suite, 'testcase', **{k: case.attrib[k] for k in ('classname', 'name', 'time')})
        phase_summaries.append({k: check[k] for k in ('name', 'seconds', 'timeout_seconds', 'counts', 'case_progress')})
        phase_times = list(normalized_progress(directory/'case-progress.jsonl'))
        by_id = {r['case_id']: r for r in phase_times}
        assert len(by_id) == len(cases)
        if name in ('h2_schema_python', 'h1_python'):
            raw_path = directory/'case-timings.json' if name == 'h2_schema_python' else directory/'observations/case-deadlines.json'
            raw = document(raw_path)
            rows = raw['cases'] if type(raw) is dict else raw
            assert len(rows) == len(phase_times)
            for row in rows:
                filename, case_name = row['nodeid'].split('::', 1)
                key = filename.removesuffix('.py').replace('/', '.')+'.'+case_name
                by_id[key].update(body_seconds=row['monotonic_body_end']-row['monotonic_body_start'],
                    cleanup_seconds=row['monotonic_cleanup_end']-row['monotonic_cleanup_start'],
                    timeout_outcome=row['timeout_outcome'])
        elif name == 'h2_runtime_python':
            raw = document(directory/'case-timings.json')
            by_id[raw['case_id']].update({k: raw[k] for k in ('body_seconds', 'cleanup_seconds')})
            by_id[raw['case_id']]['timeout_outcome'] = 'none'
        timings.extend(phase_times)
        if name != 'h1_python':
            life = document(directory/'lifecycle.json')
            assert life['stop_status'] == 'stopped' and life['pid_alive'] is False
            assert all(r['exit_code'] == 0 for r in life['lifecycle'])
            postgres.append({'phase': name, 'stop_status': 'stopped', 'pid_alive': False,
                'binary_versions': life['binary_versions'], 'binary_sha256': life['binary_sha256'],
                'operations': [{k: r[k] for k in ('operation', 'exit_code', 'duration_ms')} for r in life['lifecycle']]})
    assert counts == {'passed': 407, 'failed': 0, 'errors': 0, 'skipped': 0}
    assert len(timings) == len({r['case_id'] for r in timings}) == 407 and len(postgres) == 5
    h1_dir = leaf/'h1_python/observations'
    runtime_dir = leaf/'h2_runtime_python/observations'
    assert check_h1_evidence(h1_dir, ledger['phases']['h1_python']['case_ids']) == gate['checks'][1]['service_evidence']
    assert check_runtime_evidence(runtime_dir, leaf/'h2_runtime_python/case-timings.json') == gate['checks'][0]['service_evidence']
    h1 = document(h1_dir/'integration/result.json')
    runtime = document(runtime_dir/'runtime-normal-flow/runtime-observation.json')
    temporal = {'scope': 'Local synthetic qualification and one actual initial activation only; crash suite and full H2 remain pending.',
        'versions': {'cli': '1.9.1', 'server': '1.32.0', 'sdk': '1.34.0'},
        'cli_sha256': gate['temporal_cli_sha256'],
        'qualified_python': {'version': gate['qualified_interpreter']['version'],
            'interpreter_sha256': gate['qualified_interpreter']['interpreter_sha256'],
            'package_count': len(gate['qualified_interpreter']['inventory'])},
        'h1': {'result_sha256': gate['checks'][1]['service_evidence']['result_sha256'],
            'owned_process_count': 6, 'all_absent': True, 'all_exit_zero': True, 'forced_cleanup': False,
            'phases': {name: {'retention_seconds': row['retention_seconds'],
                'event_types': [e['event_type'] for e in row['events']],
                'events_summary_sha256': digest(encode(row['events']))}
                for name, row in h1['phases'].items()},
            'same_run_after_restart': True, 'running_and_closed_duplicates_rejected': True},
        'runtime': {**{k: runtime[k] for k in ('phase', 'execution_count', 'started_event_count',
                'build_id', 'source_manifest_sha256', 'environment_manifest_sha256', 'binding_sha256',
                'proposal_sha256', 'raw_history_sha256', 'owner_before_sha256', 'owner_after_sha256')},
            'owned_process_count': 3, 'process_roles': sorted(r['role'] for r in runtime['processes']),
            'all_absent': True, 'all_exit_zero': True, 'forced_cleanup': False,
            'job_status': 'QUEUED', 'revision': 1, 'projection_receipt_count': 1,
            'outbox_status': 'dispatched', 'workflow_open': True}}
    summary = {'kind': 'ifpmic.b03.h2.runtime-normal-summary.v1', 'verdict': 'pass',
        'scope': gate['scope'], 'candidate_fingerprint': gate['source_fingerprint'],
        'tests': counts, 'phases': phase_summaries,
        'source_environment_and_cleanup': {'source_changes_during_gate': [],
            'original32_and_qualified36_unchanged': True, 'owned_children_absent': True,
            'postgres_clusters_stopped': 5, 'protected': gate['protected_before']}}
    entries = {'gate/summary.json': encode(summary),
        'gate/pytest.xml': ET.tostring(suites, encoding='utf-8', xml_declaration=True),
        'gate/case-timings.json': encode(sorted(timings, key=lambda r: r['case_id'])),
        'gate/postgres-lifecycle.json': encode(postgres), 'gate/temporal-summary.json': encode(temporal),
        'gate/source-manifest.json': encode(gate['source_hashes'])}
    assert set(entries) == set(contract['publication']['archive_members'])
    for name in gate['source_hashes']:
        assert not name.startswith('/') and '..' not in Path(name).parts
    private_prefixes = [str(ROOT).encode(), *(str(x).encode() for x in gate['private_temporary_roots'])]
    for raw in entries.values():
        assert all(prefix not in raw for prefix in private_prefixes)
        assert b'PRIVATE KEY-----' not in raw and b'password=' not in raw
        assert b'"pid"' not in raw and b'"start_ticks"' not in raw
    archive = EVIDENCE/'h2-runtime-normal-gate.zip'
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED) as z:
        for name, raw in sorted(entries.items()):
            info = zipfile.ZipInfo(name, (2000, 1, 1, 0, 0, 0))
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, raw)
    verification = {'kind': 'ifpmic.b03.h2.runtime-normal-verification.v1',
        'decision': 'pass_pending_independent_final_review', 'goal_status': 'active',
        'real_acceptance_status': 'not_executed', 'scope': gate['scope'], 'tests': counts,
        'candidate_fingerprint': gate['source_fingerprint'], 'phases': phase_summaries,
        'execution_contract': {'path': str(contract_path.relative_to(ROOT)), 'sha256': EXECUTION_SHA},
        'tc_ledger': contract['tc_ledger'],
        'private_gate': {'path': str(gate_path.relative_to(ROOT)), 'sha256': digest(gate_path.read_bytes())},
        'private_candidate_source_zip_sha256': gate['source_zip_sha256'],
        'failed_attempts': {'path': 'docs/ifpmic/evidence/b03/h2-runtime-normal-attempts.json',
            'sha256': digest((EVIDENCE/'h2-runtime-normal-attempts.json').read_bytes())},
        'publication': contract['publication'], 'remaining_mandatory_h2': contract['remaining_mandatory_h2'],
        'limitations': contract['omitted_stages'],
        'archive': {'path': str(archive.relative_to(ROOT)), 'sha256': digest(archive.read_bytes()),
            'entries': {n: {'bytes': len(raw), 'sha256': digest(raw)} for n, raw in entries.items()}}}
    (EVIDENCE/'h2-runtime-normal-verification.json').write_bytes(encode(verification))
    print('Published407 passing cases for partial normal-runtime evidence; full H2 remains incomplete')


if __name__ == '__main__':
    main()
