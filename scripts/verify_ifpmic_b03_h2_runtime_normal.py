#!/usr/bin/env python3
"""H2 real CLI normal-runtime increment; mandatory crash/full H2 acceptance remains pending."""
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
EXECUTION_SHA = '7e730a5936a39d364821df4b1e92afabc36813211f97cbd920aad7db2018260b'  # Exact independent + TC execution approvals.
PHASE_ORDER = ('h2_runtime_python', 'h1_python', 'g5_python', 'h2_schema_python', 'g4_python', 'legacy_python')
PHASE_BUDGETS = {name: (600 if name == 'g5_python' else 300) for name in PHASE_ORDER}
LONG_IDS = {
    'tests.ifpmic_api.test_h2_runtime_normal_flow.test_h2_runtime_real_cli_create_ready_admits_one_run_and_queues_one_receipt',
    'tests.ifpmic_api.test_temporal_toolchain.test_temporal_persistent_history_restart_and_duplicate_policy',
}
RUNTIME_ID = next(name for name in LONG_IDS if '.test_h2_runtime_normal_flow.' in name)



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
                    'docs/ifpmic/**/*', 'scripts/*h2*'):
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


def check_case_progress(path, expected_ids):
    states = {}
    previous = -math.inf
    for line in path.read_text().splitlines():
        event = json.loads(line)
        moment = event['monotonic']
        if type(moment) not in (float, int) or not math.isfinite(moment) or moment < previous:
            raise RuntimeError('Invalid per-case progress clock')
        previous = moment
        filename, name = event['nodeid'].split('::', 1)
        case_id = filename.removesuffix('.py').replace('/', '.') + '.' + name
        kind = event['event']
        if kind == 'start':
            if case_id in states:
                raise RuntimeError('Duplicate testcase start')
            states[case_id] = {'start': moment, 'reports': []}
            continue
        state = states[case_id]
        if 'finish' in state:
            raise RuntimeError('Testcase event after finish')
        if kind == 'report':
            duration = event['duration']
            if (event['outcome'] != 'passed' or type(duration) not in (int, float)
                    or not math.isfinite(duration) or not 0 <= duration <= (
                        {'setup': 215, 'call': 240, 'teardown': 25}.get(event['when'], -1)
                        if case_id in LONG_IDS else 30)):
                raise RuntimeError('Nonpassing testcase progress report')
            state['reports'].append(event['when'])
        elif kind == 'finish':
            if state['reports'] != ['setup', 'call', 'teardown']:
                raise RuntimeError('Incomplete testcase reports')
            state['finish'] = moment
        else:
            raise RuntimeError('Unknown testcase progress event')
    if sorted(states) != sorted(expected_ids):
        raise RuntimeError('Per-case progress inventory differs')
    elapsed = [row['finish'] - row['start'] for row in states.values()]
    if any(not 0 <= row['finish'] - row['start'] <= (240 if case_id in LONG_IDS else 30)
           for case_id, row in states.items()):
        raise RuntimeError('Actual testcase start-to-finish exceeds approved case budget')
    return {'cases': len(states), 'maximum_elapsed_seconds': max(elapsed),
            'sha256': digest(path.read_bytes())}


def case_id(nodeid):
    filename, name = nodeid.split('::', 1)
    return filename.removesuffix('.py').replace('/', '.') + '.' + name


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def check_h1_evidence(observations, expected_ids):
    from ifpmic_temporal_toolchain import process_identity
    timings_path = observations/'case-deadlines.json'
    timings = document(timings_path)
    if len(timings) != 5 or sorted(case_id(r['nodeid']) for r in timings) != sorted(expected_ids):
        raise RuntimeError('Fresh H1 timing inventory differs')
    for row in timings:
        long_case = case_id(row['nodeid']) in LONG_IDS
        bounds = [row[k] for k in ('monotonic_body_start', 'monotonic_body_end',
                                   'monotonic_cleanup_start', 'monotonic_cleanup_end')]
        if (any(not finite(x) for x in bounds) or bounds != sorted(bounds)
                or bounds[1]-bounds[0] > (215 if long_case else 25)
                or bounds[3]-bounds[2] > (25 if long_case else 5)
                or bounds[3]-bounds[0] > (240 if long_case else 30)
                or not finite(row['elapsed_seconds'])
                or not 0 <= row['elapsed_seconds'] <= (240 if long_case else 30)
                or row['timeout_outcome'] != 'none'
                or row['body_timeout_triggered'] is not False
                or row['cleanup_timeout_triggered'] is not False):
            raise RuntimeError('Fresh H1 watchdog evidence failed')
    result_path = observations/'integration/result.json'
    result = document(result_path)
    records_path = observations/'integration/processes.json'
    records = document(records_path)
    if isinstance(records, dict):
        records = records['processes']
    if (result['status'] != 'passed' or result['process_count'] != 6 or len(records) != 6
            or len({(r['pid'], str(r['start_ticks'])) for r in records}) != 6
            or {r['role'] for r in records} != {f'{role}-phase{phase}'
                for role in ('server', 'worker', 'client') for phase in (1, 2)}
            or any(r['absent'] is not True or r['forced'] is not False or r['returncode'] != 0
                   or process_identity(r['pid']) == str(r['start_ticks']) for r in records)):
        raise RuntimeError('Fresh H1 owned lifecycle failed')
    p1, p2 = (result['phases'][name] for name in ('phase1', 'phase2'))
    if (p1['run_id'] != p2['run_id'] or p1['retention_seconds'] <= 3600
            or p2['retention_seconds'] <= 3600 or p1['waiting'] is not True
            or p1['running_duplicate_rejected'] is not True
            or any(p2[k] is not True for k in
                   ('same_history_prefix', 'signal_completed', 'closed_duplicate_rejected'))
            or p2['logical_execution_count'] != 1
            or any(not listener['loopback'] for p in (p1, p2) for listener in p['listeners'])):
        raise RuntimeError('Fresh H1 persistence/history evidence failed')
    return {'result_sha256': digest(result_path.read_bytes()),
            'timings_sha256': digest(timings_path.read_bytes()),
            'processes_sha256': digest(records_path.read_bytes()), 'process_count': 6}


def check_runtime_evidence(observations, timings_path):
    from ifpmic_temporal_toolchain import process_identity
    timing = document(timings_path)
    if (timing['case_id'] != RUNTIME_ID or case_id(timing['nodeid']) != RUNTIME_ID
            or timing['status'] != 'finished' or timing['body_timeout_triggered'] is not False
            or timing['cleanup_timeout_triggered'] is not False):
        raise RuntimeError('Runtime watchdog result failed')
    events = timing['events']
    expected_events = ['setup_start', 'setup_finish', 'call_start', 'cleanup_start',
                       'call_finish', 'teardown_start', 'teardown_finish', 'case_finish']
    moments = [e['monotonic'] for e in events]
    if ([e['event'] for e in events] != expected_events or any(not finite(x) for x in moments)
            or moments != sorted(moments)):
        raise RuntimeError('Runtime fixture deadline boundaries differ')
    start, cleanup, finish = (timing[k] for k in
        ('started_monotonic', 'cleanup_started_monotonic', 'finished_monotonic'))
    if (any(not finite(x) for x in (start, cleanup, finish))
            or not start <= moments[0] <= cleanup <= finish
            or cleanup != moments[3] or finish != moments[-1]):
        raise RuntimeError('Runtime whole-case clock invalid')
    for key, observed, cap in (('body_seconds', cleanup-start, 215),
                               ('cleanup_seconds', finish-cleanup, 25),
                               ('total_seconds', finish-start, 240)):
        if not finite(timing[key]) or not 0 <= timing[key] <= cap or abs(timing[key]-observed) > 0.000001:
            raise RuntimeError('Runtime whole-case budget exceeded')
    root = observations/'runtime-normal-flow'
    path = root/'runtime-observation.json'
    result = document(path)
    records = result['processes']
    if (result['case_id'] != RUNTIME_ID or result['status'] != 'passed'
            or result['body_status'] != 'passed' or result['phase'] != 'queued'
            or result['execution_count'] != 1 or result['started_event_count'] != 1
            or result['workspace_generation'] != 1 or result['temporal_listeners_loopback'] is not True
            or len(records) != 3 or {r['role'] for r in records} != {'dispatcher', 'worker', 'temporal'}
            or len({(r['pid'], str(r['start_ticks'])) for r in records}) != 3
            or any(r['absent'] is not True or r['forced'] is not False or r['exit_code'] != 0
                   or process_identity(r['pid']) == str(r['start_ticks']) for r in records)):
        raise RuntimeError('Actual runtime observation or owned lifecycle failed')
    for filename, field in (('owner-before.json', 'owner_before_sha256'),
                            ('owner-after.json', 'owner_after_sha256'),
                            ('temporal-history.pbseq', 'raw_history_sha256'),
                            ('api-observations.json', 'api_observations_sha256'),
                            ('process-journal.jsonl', 'process_journal_sha256')):
        if digest((root/filename).read_bytes()) != result[field]:
            raise RuntimeError('Runtime private evidence hash changed')
    if (root/'temporal-history.pbseq').stat().st_size != result['raw_history_bytes']:
        raise RuntimeError('Runtime raw history size differs')
    journal = [json.loads(line) for line in (root/'process-journal.jsonl').read_text().splitlines()]
    for record in records:
        matching = [r for r in journal if (r['pid'], str(r['start_ticks'])) ==
                    (record['pid'], str(record['start_ticks']))]
        if ([r['event'] for r in matching] != ['started', 'stop_requested', 'stopped']
                or matching[1]['pre_stop_exit_code'] is not None):
            raise RuntimeError('Runtime immediate process journal incomplete')
        if (matching[0]['role'] != record['role']
                or any(type(matching[2][key]) is not type(record[key])
                       or matching[2][key] != record[key]
                       for key in ('exit_code', 'absent', 'forced'))):
            raise RuntimeError('Runtime process journal and observation disagree')
    if len(journal) != 9:
        raise RuntimeError('Unexpected runtime process journal inventory')
    before, after = (document(root/name) for name in ('owner-before.json', 'owner-after.json'))
    if (before['accepted'][3:8] != ['DRAFT', 0, 0, [], None]
            or after['accepted'][3:8] != ['QUEUED', 1, 0, [], None]
            or before['bindings'] or before['scopes'] or before['receipts'] or before['attempts']
            or any(len(after[k]) != 1 for k in ('bindings', 'scopes', 'receipts', 'attempts'))
            or after['accepted'][12:17] != ['applied', 1, None, 'dispatched', 1]
            or after['bindings'][0][19] != result['run_id']
            or after['receipts'][0][5] != result['proposal_sha256']):
        raise RuntimeError('Runtime preserved owner SQL evidence differs')
    return {'result_sha256': digest(path.read_bytes()), 'timings_sha256': digest(timings_path.read_bytes()),
            'process_count': 3, 'raw_history_sha256': result['raw_history_sha256'],
            'owner_before_sha256': result['owner_before_sha256'],
            'owner_after_sha256': result['owner_after_sha256']}


def main():
    os.umask(0o077)
    leaf = ROOT / 'workflow-artifacts/verification/B03/H2/runtime-normal/gates' / datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S-%fZ')
    leaf.mkdir(parents=True, mode=0o700)
    report = {'kind': 'ifpmic.b03.h2.runtime-normal-gate.v1', 'verdict': 'running',
              'scope': 'Actual local production-CLI normal activation plus fresh H1 and401 SQL/local regressions only. No full H2 crash/history-loss or original AT acceptance.',
              'started_at': datetime.now(timezone.utc).isoformat(), 'checks': [], 'private_temporary_roots': []}
    try:
        if EXECUTION_SHA is None:
            raise RuntimeError('Execution contract not approved/pinned')
        raw = (EVIDENCE/'h2-runtime-normal-execution-contract.json').read_bytes()
        if digest(raw) != EXECUTION_SHA:
            raise RuntimeError('Execution contract changed')
        contract = json.loads(raw)
        if digest((EVIDENCE/'h2-implementation-contract.json').read_bytes()) != IMPLEMENTATION_SHA:
            raise RuntimeError('Implementation contract changed')
        pre_gate = document(EVIDENCE/'h2-runtime-normal-pre-gate-review.json')
        if pre_gate.get('verdict') != 'approve_frozen_runtime_normal_gate' or pre_gate.get('execution_contract_sha256') != EXECUTION_SHA:
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
        if contract['limits']['phase_seconds'] != PHASE_BUDGETS:
            raise RuntimeError('Unreviewed phase budgets')
        with zipfile.ZipFile(ROOT/'docs/ifpmic/evidence/b02/g6-gate.zip') as baseline:
            historical = json.loads(baseline.read('api/gate.json'))
        old = {c['name']: c['coverage_inventory']['case_ids'] for c in historical['checks'] if 'coverage_inventory' in c}
        pinned_pg = next(c['postgres_lifecycle']['binary_sha256'] for c in historical['checks'] if c['name']=='legacy_python')
        for name, count in (('legacy_python', 167), ('g4_python', 91), ('g5_python', 93)):
            if len(phases[name]['case_ids']) != count or sorted(phases[name]['case_ids']) != sorted(old[name]):
                raise RuntimeError('Original351 case IDs changed')
        selected_files = {f for p in phases.values() for f in p['files']}
        existing_files = {str(p.relative_to(ROOT)) for p in (ROOT/'tests/ifpmic_api').glob('test_*.py')}
        if selected_files != existing_files:
            raise RuntimeError('Unlisted API/schema test module')
        ids = [v for p in phases.values() for v in p['case_ids']]
        if len(ids) != len(set(ids)) or len(ids) != 407 or len(ids) != 351 + ledger['expected_new_case_count']:
            raise RuntimeError('Duplicate/missing exact case IDs')
        if set(contract['limits']['integration_exact_ids']) != LONG_IDS:
            raise RuntimeError('Integration case exceptions changed')
        with zipfile.ZipFile(EVIDENCE/'h2-prebinding-gate.zip') as previous:
            previous_ids = sorted(c.get('classname')+'.'+c.get('name') for c in
                                  ET.fromstring(previous.read('gate/pytest.xml')).iter('testcase'))
        retained_ids = sorted(c for n, p in phases.items() if n not in ('h1_python', 'h2_runtime_python') for c in p['case_ids'])
        if retained_ids != previous_ids:
            raise RuntimeError('Accepted401 inventory changed')
        with zipfile.ZipFile(EVIDENCE/'h1-gate.zip') as previous:
            h1_ids = sorted(c.get('classname')+'.'+c.get('name') for c in
                            ET.fromstring(previous.read('gate/pytest.xml')).iter('testcase'))
        if sorted(phases['h1_python']['case_ids']) != h1_ids or phases['h2_runtime_python']['case_ids'] != [RUNTIME_ID]:
            raise RuntimeError('Fresh H1/runtime inventory differs')
        install_prep = document(EVIDENCE/'h1-installation-preparation.json')
        toolchain_root = ROOT/install_prep['private_root']
        installation = toolchain_root/'installation.json'
        if digest(installation.read_bytes()) != install_prep['private_installation_sha256']:
            raise RuntimeError('Private H1 installation changed')
        install = document(installation)
        from ifpmic_temporal_toolchain import verify_binary, CLI_SHA
        verify_binary(toolchain_root/'temporal', CLI_SHA)
        if install['installed'] != install_prep['installed'] or len(install['installed']) != 36:
            raise RuntimeError('Qualified36 installation inventory changed')
        report['installation_sha256'] = digest(installation.read_bytes())
        report['temporal_cli_sha256'] = CLI_SHA
        enable_subreaper()
        if owned_children():
            raise RuntimeError('Unexpected pre-existing runner child')
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
        # Verify the actual qualified interpreter before any runtime service.
        # The independent pre-gate review pins the resolved binary through its
        # relative venv symlink path; package metadata is read, never installed.
        python_path = toolchain_root/'venv/bin/python'
        python_pin = pre_gate['source_pins'].get(str(python_path.relative_to(ROOT)))
        if not python_pin or digest(python_path.read_bytes()) != python_pin:
            raise RuntimeError('Qualified interpreter binary is not independently pinned')
        cache_preflight = leaf/'preflight-pycache'; cache_preflight.mkdir(mode=0o700)
        probe = (
            'import sys,json,hashlib,platform,importlib.metadata;from pathlib import Path;'
            'print(json.dumps({"prefix":str(Path(sys.prefix).resolve()),'
            '"implementation":platform.python_implementation(),"version":list(sys.version_info[:3]),'
            '"interpreter_sha256":hashlib.sha256(Path(sys.executable).resolve().read_bytes()).hexdigest(),'
            '"inventory":{d.metadata["Name"].lower().replace("_","-"):d.version '
            'for d in importlib.metadata.distributions()}},sort_keys=True))'
        )
        preflight = run_owned_command([str(python_path), '-B', '-X',
            'pycache_prefix='+str(cache_preflight), '-c', probe], cwd=ROOT, timeout=30,
            env={'PATH': os.defpath, 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
                 'PYTHONDONTWRITEBYTECODE': '1'})
        save(leaf/'qualified-interpreter-preflight.log', preflight.stdout+preflight.stderr)
        if preflight.returncode:
            raise RuntimeError('Qualified interpreter preflight failed')
        actual_python = json.loads(preflight.stdout)
        if (actual_python['prefix'] != str((toolchain_root/'venv').resolve())
                or actual_python['implementation'] != 'CPython'
                or actual_python['version'] != [3, 12, 3]
                or actual_python['interpreter_sha256'] != python_pin
                or actual_python['inventory'] != install_prep['installed']
                or list(cache_preflight.iterdir())):
            raise RuntimeError('Actual qualified interpreter or36-package inventory differs')
        report['qualified_interpreter'] = actual_python
        report['qualified_interpreter_preflight_log_sha256'] = digest((leaf/'qualified-interpreter-preflight.log').read_bytes())
        report['environment'] = check_environment()
        node = shutil.which('node')
        if not node:
            raise RuntimeError('Pinned fixture Node unavailable')
        path = os.pathsep.join(dict.fromkeys((str(Path(sys.executable).parent), str(Path(node).parent), '/usr/bin', '/bin')))
        for name in PHASE_ORDER:
            phase = phases[name]
            phase_budget = PHASE_BUDGETS[name]
            if phase['timeout_seconds'] != phase_budget or any(not f.startswith('tests/ifpmic_api/test_') or '..' in f or not f.endswith('.py') for f in phase['files']):
                raise RuntimeError('Unreviewed phase command/timeout')
            directory = leaf/name
            directory.mkdir(mode=0o700)
            observations = directory/'observations'; observations.mkdir(mode=0o700)
            cache = directory/'pycache'; cache.mkdir(mode=0o700)
            lifecycle = directory/'lifecycle.json'
            junit = directory/'pytest.xml'
            timings = directory/'case-timings.json'
            diagnostics = directory/'diagnostics.json'
            progress = directory/'case-progress.jsonl'
            env = {'PATH': path, 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
                   'PYTHONPATH': str(ROOT), 'PYTHONDONTWRITEBYTECODE': '1', 'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1',
                   'IFPMIC_TEST_LIFECYCLE_PATH': str(lifecycle),
                   'IFPMIC_AUTH_TEST_OBSERVATION_PATH': str(directory/'auth-observation.json'),
                   'IFPMIC_JOBS_TEST_OBSERVATION_PATH': str(directory/'jobs-observation.json'),
                   'IFPMIC_WORKSPACE_TEST_OBSERVATION_PATH': str(directory/'workspace-observation.json'),
                   'IFPMIC_H2_SCHEMA_TIMINGS_PATH': str(timings),
                   'IFPMIC_H2_SCHEMA_DIAGNOSTICS_PATH': str(diagnostics),
                   'IFPMIC_H2_CASE_PROGRESS_PATH': str(progress)}
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
            interpreter = str(toolchain_root/'venv/bin/python') if name in ('h1_python', 'h2_runtime_python') else sys.executable
            env.update(IFPMIC_H1_TOOLCHAIN_MANIFEST=str(installation),
                       IFPMIC_H1_EVIDENCE_ROOT=str(observations),
                       IFPMIC_H2_RUNTIME_EVIDENCE_ROOT=str(observations),
                       IFPMIC_H2_RUNTIME_TIMINGS_PATH=str(timings))
            plugins = ['-p', 'tests.ifpmic_api.gate_progress']
            if name == 'h2_runtime_python':
                plugins.extend(['-p', 'tests.ifpmic_api.h2_runtime_case_budget'])
            expected_plugins = [plugins[i+1] for i in range(0, len(plugins), 2)]
            if name in ('h1_python', 'h2_runtime_python') and phase['pytest_plugins'] != expected_plugins:
                raise RuntimeError('Runtime/H1 plugins changed')
            command = [interpreter, '-B', '-X', 'pycache_prefix='+str(cache), '-m', 'pytest', '-vv',
                       '-p', 'no:cacheprovider', *plugins, *phase['files'], '--junitxml', str(junit)]
            entry = {'name': name, 'timeout_seconds': phase_budget, 'status': 'running', 'argv': command}
            report['checks'].append(entry)
            started = time.monotonic()
            try:
                result = run_owned_command(command, cwd=ROOT, timeout=phase_budget, env=env)
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
            if any(not math.isfinite(float(c.get('time', 'nan'))) or not 0 <= float(c.get('time','nan')) <=
                   (240 if c.get('classname')+'.'+c.get('name') in LONG_IDS else 30) for c in cases):
                raise RuntimeError('Case outside approved per-ID limit')
            entry['case_progress'] = check_case_progress(progress, phase['case_ids'])
            if name != 'h1_python':
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
                if len(rows) != len(phase['case_ids']):
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
            if name == 'h1_python':
                entry['service_evidence'] = check_h1_evidence(observations, phase['case_ids'])
            elif name == 'h2_runtime_python':
                entry['service_evidence'] = check_runtime_evidence(observations, timings)
            if list(cache.iterdir()):
                raise RuntimeError('Phase pycache prefix changed')
            entry['status'] = 'pass'
            reap_orphans()
            if any(row[1] != 'Z' for row in owned_children().values()):
                raise RuntimeError('Owned phase child remains live')
        if sum(c['seconds'] for c in report['checks']) > contract['limits']['maximum_phase_sum_seconds']:
            raise RuntimeError('Aggregate phase budget exceeded')
        verify_binary(toolchain_root/'temporal', CLI_SHA)
        if digest(python_path.read_bytes()) != report['qualified_interpreter']['interpreter_sha256']:
            raise RuntimeError('Qualified interpreter changed during gate')
        if digest(installation.read_bytes()) != report['installation_sha256']:
            raise RuntimeError('Installation metadata changed during gate')
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
                  ('pytest.xml','pytest.log','lifecycle.json','case-timings.json','diagnostics.json','case-progress.jsonl',
                   'auth-observation.json','jobs-observation.json','workspace-observation.json'))]:
            if p.exists() and not p.is_symlink() and p.is_file() and p.stat().st_nlink == 1:
                p.chmod(0o600)
        report['finished_at'] = datetime.now(timezone.utc).isoformat()
        save(leaf/'gate.json', report)
        print('H2 runtime-normal '+report['verdict']+': '+str((leaf/'gate.json').relative_to(ROOT)))
    return 0 if report['verdict'] == 'pass' else 1


if __name__ == '__main__':
    sys.exit(main())
