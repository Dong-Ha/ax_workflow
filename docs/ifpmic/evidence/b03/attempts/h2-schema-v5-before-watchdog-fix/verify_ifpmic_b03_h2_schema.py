#!/usr/bin/env python3
"""Frozen H2 SQL/API subgate; never starts a Temporal/business workflow."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
import zipfile

from verify_ifpmic_g1 import check_environment, check_unchanged_sources
from verify_ifpmic_g4 import (enable_subreaper, run_owned_command, cleanup_owned_children,
                              reap_orphans, owned_children)
from verify_ifpmic_b03_h1 import environment_hashes

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / 'docs/ifpmic/evidence/b03'
IMPLEMENTATION_SHA = 'f63173ac17ebebd34a15d5966d96b79dc1667a713c00b1b92868b137ba93ded3'
EXECUTION_SHA = 'e3ce56933d89c288d5e7bafc43f73a1220793d2eb719f690a751d2b6d8cfe913'  # Exact-SHA independent/TC execution-plan reviews.
PHASE_ORDER = ('h2_schema_python', 'legacy_python', 'g4_python', 'g5_python')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def document(path):
    return json.loads(Path(path).read_text())


def save(path, raw):
    if not isinstance(raw, bytes):
        raw = (json.dumps(raw, ensure_ascii=False, indent=2) + '\n').encode()
    path.write_bytes(raw)
    path.chmod(0o600)


def sources():
    import subprocess
    names = set(subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0'))
    for pattern in ('services/ifpmic_api/**/*', 'tests/ifpmic_api/**/*',
                    'docs/ifpmic/evidence/b03/**/*', 'scripts/*h2*'):
        names.update(str(p.relative_to(ROOT)) for p in ROOT.glob(pattern)
                     if p.is_file() and '__pycache__' not in p.parts and p.suffix != '.pyc')
    return {n: digest((ROOT/n).read_bytes()) for n in sorted(names) if n and (ROOT/n).is_file()}


def assert_pins(pins):
    for path, value in pins.items():
        if digest((ROOT/path).read_bytes()) != value:
            raise RuntimeError('Reviewed source pin differs: ' + path)


def approve(path, expected_sha, target_sha):
    raw = path.read_bytes()
    value = json.loads(raw)
    if digest(raw) != expected_sha or value.get('verdict') != 'approve_execution' or value.get('contract_sha256') != target_sha:
        raise RuntimeError('Exact independent execution approval missing')


def main():
    os.umask(0o077)
    leaf = ROOT / 'workflow-artifacts/verification/B03/H2/schema/gates' / datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S-%fZ')
    leaf.mkdir(parents=True, mode=0o700)
    report = {'kind': 'ifpmic.b03.h2.schema-gate.v1', 'verdict': 'running',
              'scope': 'H2 SQL/authentication/API regression subgate only. No Temporal, physical crash, full H2 or original AT acceptance.',
              'started_at': datetime.now(timezone.utc).isoformat(), 'checks': [], 'private_temporary_roots': []}
    try:
        if EXECUTION_SHA is None:
            raise RuntimeError('Execution contract not approved/pinned')
        raw = (EVIDENCE/'h2-schema-execution-contract.json').read_bytes()
        if digest(raw) != EXECUTION_SHA:
            raise RuntimeError('Execution contract changed')
        contract = json.loads(raw)
        if digest((EVIDENCE/'h2-implementation-contract.json').read_bytes()) != IMPLEMENTATION_SHA:
            raise RuntimeError('Implementation contract changed')
        pre_gate = document(EVIDENCE/'h2-schema-pre-gate-review.json')
        if pre_gate.get('verdict') != 'approve_frozen_schema_gate' or pre_gate.get('execution_contract_sha256') != EXECUTION_SHA:
            raise RuntimeError('Frozen pre-gate review missing')
        assert_pins(pre_gate['source_pins'])
        if pre_gate['source_pins'].get(str(Path(__file__).resolve().relative_to(ROOT))) != digest(Path(__file__).read_bytes()):
            raise RuntimeError('Runner not source-pinned by independent reviewer')
        if set(pre_gate['review_pins']) != set(contract['required_review_names']):
            raise RuntimeError('Required execution reviews differ')
        for name, value in pre_gate['review_pins'].items():
            approve(EVIDENCE/name, value, EXECUTION_SHA)
        ledger_path = ROOT/contract['tc_ledger']['path']
        if digest(ledger_path.read_bytes()) != contract['tc_ledger']['sha256']:
            raise RuntimeError('TC ledger changed')
        ledger = document(ledger_path)
        assert_pins(ledger['source_pins'])
        phases = ledger['phases']
        if set(phases) != set(PHASE_ORDER):
            raise RuntimeError('Unexpected test phases')
        with zipfile.ZipFile(ROOT/'docs/ifpmic/evidence/b02/g6-gate.zip') as baseline:
            historical = json.loads(baseline.read('api/gate.json'))
        old = {c['name']: c['coverage_inventory']['case_ids'] for c in historical['checks'] if 'coverage_inventory' in c}
        pinned_pg = next(c['postgres_lifecycle']['binary_sha256'] for c in historical['checks'] if c['name']=='legacy_python')
        for name, count in (('legacy_python', 167), ('g4_python', 91), ('g5_python', 93)):
            if len(phases[name]['case_ids']) != count or sorted(phases[name]['case_ids']) != sorted(old[name]):
                raise RuntimeError('Original351 case IDs changed')
        selected_files = {f for p in phases.values() for f in p['files']}
        existing_files = {str(p.relative_to(ROOT)) for p in (ROOT/'tests/ifpmic_api').glob('test_*.py') if p.name != 'test_temporal_toolchain.py'}
        if selected_files != existing_files:
            raise RuntimeError('Unlisted API/schema test module')
        ids = [v for p in phases.values() for v in p['case_ids']]
        if len(ids) != len(set(ids)) or len(ids) != 351 + ledger['expected_new_case_count']:
            raise RuntimeError('Duplicate/missing exact case IDs')
        enable_subreaper()
        if owned_children():
            raise RuntimeError('Unexpected pre-existing runner child')
        report['environment'] = check_environment()
        report['protected_before'] = check_unchanged_sources()
        env_roots = {'original32': ROOT/'.ifpmic-venv', 'qualified36': ROOT/document(EVIDENCE/'h1-installation-preparation.json')['private_root']/'venv'}
        env_before = {k: environment_hashes(p) for k, p in env_roots.items()}
        save(leaf/'environment-before.json', env_before)
        report['environment_before_sha256'] = digest((leaf/'environment-before.json').read_bytes())
        before = sources()
        report['source_hashes'] = before
        report['source_fingerprint'] = digest(json.dumps(before, sort_keys=True).encode())
        with zipfile.ZipFile(leaf/'candidate-source.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
            for name, value in before.items():
                raw = (ROOT/name).read_bytes()
                if digest(raw) != value:
                    raise RuntimeError('Source changed during capture')
                archive.writestr(name, raw)
        (leaf/'candidate-source.zip').chmod(0o600)
        report['source_zip_sha256'] = digest((leaf/'candidate-source.zip').read_bytes())
        node = shutil.which('node')
        if not node:
            raise RuntimeError('Pinned fixture Node unavailable')
        path = os.pathsep.join(dict.fromkeys((str(Path(sys.executable).parent), str(Path(node).parent), '/usr/bin', '/bin')))
        for name in PHASE_ORDER:
            phase = phases[name]
            if phase['timeout_seconds'] != 300 or any(not f.startswith('tests/ifpmic_api/test_') or '..' in f or not f.endswith('.py') for f in phase['files']):
                raise RuntimeError('Unreviewed phase command/timeout')
            directory = leaf/name
            directory.mkdir(mode=0o700)
            lifecycle = directory/'lifecycle.json'
            junit = directory/'pytest.xml'
            timings = directory/'case-timings.json'
            diagnostics = directory/'diagnostics.json'
            env = {'PATH': path, 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
                   'PYTHONPATH': str(ROOT), 'PYTHONDONTWRITEBYTECODE': '1', 'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1',
                   'IFPMIC_TEST_LIFECYCLE_PATH': str(lifecycle),
                   'IFPMIC_AUTH_TEST_OBSERVATION_PATH': str(directory/'auth-observation.json'),
                   'IFPMIC_JOBS_TEST_OBSERVATION_PATH': str(directory/'jobs-observation.json'),
                   'IFPMIC_WORKSPACE_TEST_OBSERVATION_PATH': str(directory/'workspace-observation.json'),
                   'IFPMIC_H2_SCHEMA_TIMINGS_PATH': str(timings),
                   'IFPMIC_H2_SCHEMA_DIAGNOSTICS_PATH': str(diagnostics)}
            # A long evidence path exceeds PostgreSQL's Unix socket limit. Keep
            # a real short private root (not a symlink); retain it as private
            # failure/success evidence and never follow/chmod fixture entries.
            tmp = Path(tempfile.mkdtemp(prefix='ifpmic-h2-', dir='/tmp'))
            report['private_temporary_roots'].append(str(tmp))
            env['TMPDIR'] = str(tmp)
            for key, filename in (('PGPASSFILE','empty-pgpass'),('PGSERVICEFILE','empty-pg-service.conf')):
                save(directory/filename, b'')
                env[key] = str(directory/filename)
            pg_system = directory/'empty-pg-system'; pg_system.mkdir(mode=0o700)
            env['PGSYSCONFDIR'] = str(pg_system)
            command = [sys.executable, '-m', 'pytest', '-q', '-p', 'no:cacheprovider', *phase['files'], '--junitxml', str(junit)]
            entry = {'name': name, 'timeout_seconds': 300, 'status': 'running'}
            report['checks'].append(entry)
            started = time.monotonic()
            try:
                result = run_owned_command(command, cwd=ROOT, timeout=300, env=env)
            except BaseException as error:
                # Actual timeout handle is already killed/reaped by the bounded helper;
                # final cleanup handles only its still-owned descendants.
                save(directory/'pytest.log', (getattr(error, 'stdout', None) or b'') + (getattr(error, 'stderr', None) or b''))
                raise
            save(directory/'pytest.log', result.stdout+result.stderr)
            entry.update(exit_code=result.returncode, seconds=time.monotonic()-started,
                         log_sha256=digest((directory/'pytest.log').read_bytes()))
            if junit.exists():
                junit.chmod(0o600)
                cases = ET.fromstring(junit.read_bytes()).findall('.//testcase')
                actual = sorted(c.get('classname')+'.'+c.get('name') for c in cases)
                counts = {'tests': len(cases), 'failed': sum(c.find('failure') is not None for c in cases),
                          'errors': sum(c.find('error') is not None for c in cases), 'skipped': sum(c.find('skipped') is not None for c in cases)}
                entry['counts'] = counts
                entry['case_ids'] = actual
            if result.returncode or not junit.exists():
                raise RuntimeError('Test phase failed; inspect private evidence')
            if actual != sorted(phase['case_ids']) or any(counts[k] for k in ('failed','errors','skipped')):
                raise RuntimeError('Exact case inventory/result differs')
            if any(not math.isfinite(float(c.get('time', 'nan'))) or not 0 <= float(c.get('time','nan')) <= 30 for c in cases):
                raise RuntimeError('Case outside approved30second limit')
            life = document(lifecycle)
            if life.get('stop_status') != 'stopped' or life.get('pid_alive') is not False or any(row.get('exit_code') != 0 for row in life['lifecycle']):
                raise RuntimeError('PostgreSQL owned lifecycle unverified')
            if life.get('binary_sha256') != pinned_pg:
                raise RuntimeError('Accepted PostgreSQL binary hash changed')
            entry['lifecycle_sha256'] = digest(lifecycle.read_bytes())
            if name == 'h2_schema_python':
                evidence = document(timings)
                rows = evidence['cases'] if isinstance(evidence, dict) else evidence
                entry['timing_evidence_sha256'] = digest(timings.read_bytes())
                if len(rows) != ledger['expected_new_case_count']:
                    raise RuntimeError('Per-case deadline evidence missing')
                # Exact format/flags are pinned by the TC ledger and execution contract.
                timing_ids = []
                for row in rows:
                    node_file, node_name = row['nodeid'].split('::', 1)
                    timing_ids.append(node_file.removesuffix('.py').replace('/', '.')+'.'+node_name)
                    boundaries = [row[k] for k in ('monotonic_body_start','monotonic_body_end','monotonic_cleanup_start','monotonic_cleanup_end')]
                    if (any(type(x) not in (float,int) or not math.isfinite(x) for x in boundaries)
                        or boundaries != sorted(boundaries) or boundaries[1]-boundaries[0] > 25
                        or boundaries[3]-boundaries[2] > 5 or boundaries[3]-boundaries[0] > 30
                        or row.get('timeout_outcome') != 'none' or row.get('body_timeout_triggered') is not False
                        or row.get('cleanup_timeout_triggered') is not False
                        or abs(row['elapsed_seconds']-(boundaries[3]-boundaries[0])) > 0.000001):
                        raise RuntimeError('New test watchdog exceeded or missing')
                if sorted(timing_ids) != sorted(phase['case_ids']):
                    raise RuntimeError('Timing testcase IDs differ')
            entry['status'] = 'pass'
            reap_orphans()
            if any(row[1] != 'Z' for row in owned_children().values()):
                raise RuntimeError('Owned phase child remains live')
        after = sources()
        report['source_changes'] = [n for n in before.keys() | after.keys() if before.get(n) != after.get(n)]
        if report['source_changes'] or check_unchanged_sources() != report['protected_before']:
            raise RuntimeError('Source/protected inventory changed during gate')
        if any(environment_hashes(p) != env_before[k] for k,p in env_roots.items()):
            raise RuntimeError('Original32/qualified36 environment changed')
        report['environments_unchanged'] = True
        report['owned_children_absent'] = not owned_children()
        if not report['owned_children_absent']:
            raise RuntimeError('Owned child cleanup unconfirmed')
        report['verdict'] = 'pass'
    except BaseException as error:
        report['verdict'] = 'fail'
        report['finding'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
    finally:
        if report['verdict'] != 'pass':
            report['failure_cleanup'] = cleanup_owned_children()
        # Test tmp trees intentionally contain unsafe modes/symlinks/hardlinks.
        # Never follow or chmod those fixtures; their private ancestor protects them. Short private /tmp roots
        # are retained verbatim and their paths occur only in this private report.
        for p in [*leaf.iterdir(), *(leaf/n/x for n in PHASE_ORDER for x in
                  ('pytest.xml','pytest.log','lifecycle.json','case-timings.json','diagnostics.json',
                   'auth-observation.json','jobs-observation.json','workspace-observation.json'))]:
            if p.exists() and not p.is_symlink() and p.is_file() and p.stat().st_nlink == 1:
                p.chmod(0o600)
        report['finished_at'] = datetime.now(timezone.utc).isoformat()
        save(leaf/'gate.json', report)
        print('H2 schema '+report['verdict']+': '+str((leaf/'gate.json').relative_to(ROOT)))
    return 0 if report['verdict'] == 'pass' else 1


if __name__ == '__main__':
    sys.exit(main())
