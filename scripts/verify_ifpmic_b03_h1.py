#!/usr/bin/env python3
"""Freeze and qualify only the reviewed local Temporal toolchain, never a job."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import xml.etree.ElementTree as ET
import zipfile

from ifpmic_temporal_toolchain import CLI_SHA, open_owned_pidfd, process_identity, verify_binary

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / 'docs/ifpmic/evidence/b03'
CONTRACT_SHA = '7860ccc5e7527ef37f6e1f26d07b7b2df4bb2f55d721b14ae5e635492153b801'
EXPECTED_NAMES = {
    'test_installed_toolchain_pins', 'test_wrong_hash_prevents_execution',
    'test_missing_and_truncated_binary_prevent_execution[missing]',
    'test_missing_and_truncated_binary_prevent_execution[truncated]',
    'test_temporal_persistent_history_restart_and_duplicate_policy',
}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text())


def source_hashes():
    names = set(subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0'))
    for pattern in ('docs/ifpmic/evidence/b03/**/*', 'tests/ifpmic_api/*temporal*',
                    'scripts/*temporal*', 'scripts/verify_ifpmic_b03_h1.py',
                    'services/ifpmic_api/requirements-temporal.lock'):
        names.update(str(p.relative_to(ROOT)) for p in ROOT.glob(pattern) if p.is_file())
    return {n: digest((ROOT/n).read_bytes()) for n in sorted(names) if n and (ROOT/n).is_file()}


def check_g6_baseline():
    with zipfile.ZipFile(ROOT/'docs/ifpmic/evidence/b02/g6-gate.zip') as archive:
        captured = json.loads(archive.read('gate/gate.json'))['source_hashes']
    protected = {n: h for n, h in captured.items()
                 if n not in ('README.md', 'docs/ifpmic/progress.json')
                 and not n.startswith('IFPMIC_AX_')}
    assert len(protected) == 348
    for name, value in protected.items():
        assert digest((ROOT/name).read_bytes()) == value, name
    return len(protected)


def protected_sources():
    document = read_json(ROOT/'docs/ifpmic/source-manifest.json')
    pins = {str(Path('docs/ifpmic/design-v1')/n): h for n, h in document['imported_files'].items()}
    pins.update({v['path']: v['sha256'] for v in document['source_files'].values()})
    for n, value in pins.items():
        assert digest((ROOT/n).read_bytes()) == value, n
    return pins


def environment_hashes(base):
    result = {}
    for path in base.rglob('*'):
        if '__pycache__' in path.parts or path.suffix == '.pyc':
            continue
        name = str(path.relative_to(base))
        if path.is_symlink():
            result[name+':symlink'] = digest(os.readlink(path).encode())
        elif path.is_file():
            result[name] = digest(path.read_bytes())
    return result


def old_environment_hashes():
    return environment_hashes(ROOT/'.ifpmic-venv')


def save(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n')
    path.chmod(0o600)


def descendants(parent):
    rows = {}
    for path in Path('/proc').glob('[0-9]*/stat'):
        try:
            tail = path.read_text().rsplit(')', 1)[1].split()
            rows[int(path.parent.name)] = (int(tail[1]), tail[19])
        except (OSError, ValueError, IndexError):
            continue
    owned = {parent}
    while True:
        expanded = owned | {pid for pid, (ppid, _) in rows.items() if ppid in owned}
        if expanded == owned:
            return {pid: rows[pid][1] for pid in owned if pid in rows}
        owned = expanded


def emergency_cleanup(process, observations):
    saved_root = getattr(process, '_ifpmic_start_ticks', None)
    owned = {}
    if saved_root is not None and process_identity(process.pid) == saved_root:
        snapshot = descendants(process.pid)
        if process_identity(process.pid) == saved_root:
            owned = snapshot
    for path in observations.rglob('processes.json'):
        data = read_json(path)
        records = data if isinstance(data, list) else data.get('processes', [])
        for row in records:
            pid, ticks = row.get('pid'), row.get('start_ticks')
            if isinstance(pid, int) and ticks is not None:
                owned[pid] = str(ticks)
    descriptors = {pid: fd for pid, ticks in owned.items()
                   if (fd := open_owned_pidfd(pid, ticks)) is not None}
    try:
        for sig, duration in ((signal.SIGTERM, 10), (signal.SIGKILL, 5)):
            for descriptor in descriptors.values():
                try:
                    signal.pidfd_send_signal(descriptor, sig)
                except ProcessLookupError:
                    pass
            end = time.monotonic()+duration
            while time.monotonic() < end and any(process_identity(p) == t for p, t in owned.items()):
                process.poll()
                time.sleep(0.05)
    finally:
        for descriptor in descriptors.values():
            os.close(descriptor)
    process.wait(timeout=5)
    return {str(p): {'start_ticks': t, 'same_identity_remains': process_identity(p) == t}
            for p, t in owned.items()}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--toolchain-manifest', type=Path, required=True)
    args = parser.parse_args()
    os.chdir(ROOT)
    contract_path = EVIDENCE/'h1-execution-contract.json'
    assert digest(contract_path.read_bytes()) == CONTRACT_SHA
    contract = read_json(contract_path)
    for item in contract['inputs']:
        assert digest((ROOT/item['path']).read_bytes()) == item['sha256'], item['path']
    for name in ('h1-contract-review.json', 'h1-tc-contract-review.json'):
        review = read_json(EVIDENCE/name)
        assert review['reviewed_contract']['sha256'] == CONTRACT_SHA
        assert 'approve' in review.get('verdict', review.get('decision', ''))
    pre_gate = read_json(EVIDENCE/'h1-pre-gate-review.json')
    assert pre_gate['verdict'] == 'approve_first_frozen_h1_gate'
    for name, value in pre_gate['source_pins'].items():
        assert digest((ROOT/name).read_bytes()) == value, name
    install = read_json(args.toolchain_manifest)
    assert install['status'] == 'installed_pending_runtime_qualification'
    assert digest(args.toolchain_manifest.read_bytes()) == read_json(EVIDENCE/'h1-installation-preparation.json')['private_installation_sha256']
    toolchain = Path(install['toolchain_root'])
    verify_binary(toolchain/'temporal', CLI_SHA)
    g6_preserved = check_g6_baseline()
    old = old_environment_hashes()
    installed_files = environment_hashes(toolchain/'venv')
    before = source_hashes()
    protected = protected_sources()
    leaf = ROOT/'workflow-artifacts/verification/B03/H1/gates'/datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S-%fZ')
    leaf.mkdir(parents=True, mode=0o700)
    observations = leaf/'observations'
    observations.mkdir(mode=0o700)
    with zipfile.ZipFile(leaf/'candidate-source.zip', 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for name in before:
            archive.write(ROOT/name, name)
    result = {'kind': 'ifpmic.b03.h1.gate.v1', 'verdict': 'running', 'scope': 'local toolchain only',
              'source_hashes': before, 'source_fingerprint': digest(json.dumps(before, sort_keys=True).encode()),
              'private_source_zip_sha256': digest((leaf/'candidate-source.zip').read_bytes()),
              'contract_sha256': CONTRACT_SHA, 'protected_sources': protected,
              'old_environment_files_before': len(old), 'g6_preserved_tracked_sources': g6_preserved, 'installation_sha256': digest(args.toolchain_manifest.read_bytes())}
    save(leaf/'old-environment-before.json', old)
    result['old_environment_manifest_sha256'] = digest((leaf/'old-environment-before.json').read_bytes())
    save(leaf/'environment-before.json', installed_files)
    result['installed_environment_manifest_sha256'] = digest((leaf/'environment-before.json').read_bytes())
    result['installed_environment_file_count'] = len(installed_files)
    save(leaf/'gate.json', result)
    argv = [str(toolchain/'venv/bin/python'), '-m', 'pytest', 'tests/ifpmic_api/test_temporal_toolchain.py',
            '-q', '-ra', f'--junitxml={leaf}/pytest.xml']
    env = {'PATH': os.defpath, 'PYTHONDONTWRITEBYTECODE': '1', 'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1',
           'IFPMIC_H1_TOOLCHAIN_MANIFEST': str(args.toolchain_manifest.resolve()),
           'IFPMIC_H1_EVIDENCE_ROOT': str(observations)}
    process = None
    try:
        started = time.monotonic()
        with (leaf/'pytest.log').open('xb') as output:
            process = subprocess.Popen(argv, cwd=ROOT, env=env, stdout=output,
                                       stderr=subprocess.STDOUT, start_new_session=True)
            process._ifpmic_start_ticks = process_identity(process.pid)
            result['pytest_identity'] = {'pid': process.pid, 'start_ticks': process._ifpmic_start_ticks}
            save(leaf/'gate.json', result)
            try:
                exit_code = process.wait(timeout=300)
            except subprocess.TimeoutExpired:
                result['emergency_cleanup'] = emergency_cleanup(process, observations)
                raise AssertionError('PYTEST_PHASE_TIMEOUT') from None
        result['command'] = {'argv': argv, 'exit_code': exit_code, 'seconds': time.monotonic()-started}
        assert exit_code == 0, 'PYTEST_FAILED'
        cases = list(ET.parse(leaf/'pytest.xml').getroot().iter('testcase'))
        assert len(cases) == 5 and {c.get('name') for c in cases} == EXPECTED_NAMES
        assert all(not list(c.iter('failure')) and not list(c.iter('error')) and not list(c.iter('skipped')) for c in cases)
        result['cases'] = [{'name': c.get('name'), 'seconds': float(c.get('time', '0'))} for c in cases]
        for case in result['cases']:
            assert case['seconds'] <= (240 if case['name'].startswith('test_temporal_persistent') else 30)
        timing = read_json(observations/'case-deadlines.json')
        assert len(timing) == 5 and {r['nodeid'].split('::')[-1] for r in timing} == EXPECTED_NAMES
        for row in timing:
            assert row['timeout_outcome'] == 'none'
            assert not row['body_timeout_triggered'] and not row['cleanup_timeout_triggered']
            assert row['monotonic_body_start'] <= row['monotonic_body_end'] <= row['monotonic_cleanup_start'] <= row['monotonic_cleanup_end']
        result['case_deadline_evidence_sha256'] = digest((observations/'case-deadlines.json').read_bytes())
        result['tc_result'] = read_json(observations/'integration/result.json')
        assert result['tc_result']['status'] == 'passed'
        records = read_json(observations/'integration/processes.json')
        if isinstance(records, dict):
            records = records['processes']
        assert len(records) == 6, 'MISSING_PROCESS_OBSERVATIONS'
        assert len({(r['pid'], str(r['start_ticks'])) for r in records}) == 6
        assert {r['role'] for r in records} == {f'{role}-phase{phase}' for role in ('server', 'worker', 'client') for phase in (1, 2)}
        assert all(r['absent'] and not r['forced'] and r['returncode'] == 0 for r in records)
        for row in records:
            assert process_identity(row['pid']) != str(row['start_ticks']), 'OWNED_PROCESS_REMAINS'
        result['owned_process_count'] = len(records)
        result['old_environment_unchanged'] = old_environment_hashes() == old
        assert result['old_environment_unchanged']
        result['source_changes'] = [n for n, h in before.items() if digest((ROOT/n).read_bytes()) != h]
        assert source_hashes() == before, 'SOURCE_CHANGED'
        assert protected_sources() == protected
        assert check_g6_baseline() == g6_preserved
        verify_binary(toolchain/'temporal', CLI_SHA)
        inventory = subprocess.check_output([str(toolchain/'venv/bin/python'), '-c',
            "import importlib.metadata,json;print(json.dumps(dict((d.metadata['Name'].lower().replace('_','-'),d.version) for d in importlib.metadata.distributions())))"], env=env, timeout=30)
        assert json.loads(inventory) == install['installed']
        result['installed_environment_unchanged'] = environment_hashes(toolchain/'venv') == installed_files
        assert result['installed_environment_unchanged']
        result['verdict'] = 'pass'
    except BaseException as error:
        result['verdict'] = 'fail'
        result['failure_type'] = type(error).__name__
        if process is not None:
            result['emergency_cleanup'] = emergency_cleanup(process, observations)
        raise
    finally:
        result['finished_at'] = datetime.now(timezone.utc).isoformat()
        save(leaf/'gate.json', result)
        print(json.dumps({'gate': str(leaf.relative_to(ROOT)), 'verdict': result['verdict']}), flush=True)


if __name__ == '__main__':
    main()
