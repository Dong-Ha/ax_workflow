"""Frozen G4 gate: durable user APIs with G1/G2/G3 and B01 regression."""
from datetime import datetime, timezone
from hashlib import sha256
import json
import math
from pathlib import Path
import subprocess
import os
import builtins
import signal
import symtable
import threading
import sys
import time
import xml.etree.ElementTree as ET
import zipfile

from verify_ifpmic_g1 import check_environment, check_unchanged_sources, cleanup_cluster

ROOT = Path(__file__).resolve().parents[1]
PLAN_SHA = 'f53a6d86e3e798d77a23741a923f95f960936179f26c4a2648df9b6178daf96a'
# Set only after TC freezes its independently authored case ledger.
G4_TC_LEDGER_SHA = 'ed7e7fcb517cf3b94bf3d6f32aa63509f827225b85ac55f3d9437235803dc5fc'


def enable_subreaper():
    """Keep orphaned test services owned by this Linux gate on pytest failure."""
    import ctypes
    if sys.platform != 'linux' or not hasattr(os, 'pidfd_open'):
        raise RuntimeError('Linux pidfd child cleanup is required')
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER, linux/prctl.h
        raise RuntimeError('Cannot establish gate child ownership')


def owned_children():
    rows = {}
    for file in Path('/proc').glob('[0-9]*/stat'):
        try:
            fields = file.read_text().rsplit(') ', 1)[1].split()
            rows[int(file.parent.name)] = (int(fields[1]), fields[0], fields[19])
        except (OSError, ValueError, IndexError):
            continue
    owned = {os.getpid()}
    while True:
        found = {pid for pid, (parent, _, _) in rows.items() if parent in owned}
        if found <= owned:
            break
        owned |= found
    return {pid: rows[pid] for pid in owned - {os.getpid()}}


def reap_orphans():
    # Called only after subprocess.run has reaped its direct command handle.
    while True:
        try:
            if os.waitpid(-1, os.WNOHANG)[0] == 0:
                return
        except ChildProcessError:
            return


def cleanup_owned_children():
    """Signal only kernel-owned descendants, with pidfd reuse protection."""
    import select
    signalled = set()
    for sig, grace in ((signal.SIGINT, 3), (signal.SIGTERM, 2), (signal.SIGKILL, 5)):
        for pid, (_, state, started) in owned_children().items():
            if state == 'Z':
                continue
            descriptor = None
            try:
                descriptor = os.pidfd_open(pid)
                current = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()
                if current[19] == started and not select.select([descriptor], [], [], 0)[0]:
                    signal.pidfd_send_signal(descriptor, sig)
                    signalled.add(pid)
            except (ProcessLookupError, FileNotFoundError):
                pass
            finally:
                if descriptor is not None:
                    os.close(descriptor)
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline:
            reap_orphans()
            if not any(row[1] != 'Z' for row in owned_children().values()):
                return {'result': 'stopped', 'signalled_count': len(signalled), 'pid_alive': False}
            time.sleep(0.05)
    return {'result': 'unconfirmed', 'signalled_count': len(signalled),
            'pid_alive': any(row[1] != 'Z' for row in owned_children().values())}


def run_owned_command(command, *, cwd, timeout, env):
    """Reap adopted daemon zombies while preserving the command's wait handle."""
    baseline = {(pid, row[2]) for pid, row in owned_children().items()}
    process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    stop = threading.Event()
    errors = []

    def reap_adopted():
        while not stop.is_set():
            try:
                for pid, (parent, state, started) in owned_children().items():
                    if (parent == os.getpid() and pid != process.pid and state == 'Z'
                            and (pid, started) not in baseline):
                        try:
                            os.waitpid(pid, os.WNOHANG)
                        except ChildProcessError:
                            pass
            except Exception as error:
                errors.append(type(error).__name__)
                return
            stop.wait(0.01)

    reaper = threading.Thread(target=reap_adopted, daemon=True)
    reaper.start()
    try:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
            raise
        if errors:
            raise RuntimeError('Adopted child reaper failed')
        return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
    finally:
        stop.set()
        reaper.join(timeout=2)
        process.stdout.close()
        process.stderr.close()


def digest(raw):
    return sha256(raw).hexdigest()


def private_write(path, raw):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'wb') as output:
        output.write(raw)


def check_test_globals():
    """Narrow static guard for explicit G4 modules; not a general Python linter."""
    for name in ('test_jobs.py', 'jobs_fixture.py'):
        path = ROOT / 'tests/ifpmic_api' / name
        table = symtable.symtable(path.read_text(), str(path), 'exec')
        defined = {item.get_name() for item in table.get_symbols()
                   if item.is_assigned() or item.is_imported() or item.is_namespace()}
        defined |= set(dir(builtins)) | {'__name__', '__file__', '__package__', '__spec__'}

        def inspect(current):
            for item in current.get_symbols():
                if item.is_referenced() and item.is_global() and item.get_name() not in defined:
                    raise RuntimeError('Undefined global in independently authored G4 test module')
            for child in current.get_children():
                inspect(child)
        inspect(table)


def sources():
    paths = [ROOT / name for name in ('.gitignore', 'README.md', 'docs/ifpmic/B02-IDENTITY.md',
                                     'scripts/verify_ifpmic_g1.py', 'scripts/verify_ifpmic_g2.py', 'scripts/verify_ifpmic_g3.py', 'scripts/verify_ifpmic_g4.py')]
    for directory in ('services/ifpmic_api', 'tests/ifpmic_api'):
        paths += [p for p in (ROOT / directory).rglob('*') if p.is_file() and '__pycache__' not in p.parts and
                  p.suffix in {'.py', '.mjs', '.sql', '.json', '.in', '.lock'}]
    paths += list((ROOT / 'docs/ifpmic/evidence/b02').glob('*.json'))
    return {str(p.relative_to(ROOT)): digest(p.read_bytes()) for p in sorted(set(paths))}


def main():
    stamp = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S-%fZ')
    directory = ROOT / 'workflow-artifacts/verification/B02/G4/gates' / stamp
    directory.mkdir(parents=True, mode=0o700)
    lifecycle = directory / 'private-lifecycle.json'
    auth_observation = directory / 'private-auth-observation.json'
    jobs_observation = directory / 'private-jobs-observation.json'
    report = {'kind': 'ifpmic_b02_g4_frozen_candidate', 'verdict': 'running', 'started_at': datetime.now(timezone.utc).isoformat(),
              'scope': 'Local durable user API, permission, idempotency and pagination with G1/G2/G3 and B01 regressions. G5-G7, full B02, corporate SSO and original AT remain pending.'}
    try:
        enable_subreaper()
        if digest((ROOT / 'docs/ifpmic/B02-IDENTITY.md').read_bytes()) != PLAN_SHA:
            raise RuntimeError('Approved B02 plan changed')
        for name in ('plan-review-v3.json', 'tc-plan-review-v3.json'):
            review = json.loads((ROOT / 'docs/ifpmic/evidence/b02' / name).read_bytes())
            if review['reviewed_plan']['sha256'] != PLAN_SHA or not review['decision'].startswith('approve'):
                raise RuntimeError('Independent plan approval missing')
        contract_path = 'docs/ifpmic/evidence/b02/g4-implementation-contract-v2.json'
        contract_sha = '830a98401e9addb3869722134866515183310dd0b86019463e08f6ef4baf2d14'
        if digest((ROOT / contract_path).read_bytes()) != contract_sha:
            raise RuntimeError('Approved G4 contract changed')
        for name, verdict_key in (('g4-contract-review-v2.json', 'decision'), ('g4-tc-contract-review-v2.json', 'verdict')):
            review = json.loads((ROOT / 'docs/ifpmic/evidence/b02' / name).read_bytes())
            if not review[verdict_key].startswith('approve') or review['reviewed_contract']['sha256'] != contract_sha:
                raise RuntimeError('Independent G4 approval missing')
        library_review = ROOT / 'docs/ifpmic/evidence/b02/g3-contract-review-v2.json'
        if digest(library_review.read_bytes()) != 'e5024ecf58665aef6f848ae4b7f514fbf5a0394c007e8a597d74a6b5949b9440':
            raise RuntimeError('Pinned Authlib source review changed')
        libraries = {p: value for p, value in json.loads(library_review.read_bytes())['source_pins'].items() if p.startswith('.ifpmic-venv/')}
        if not libraries or any(digest((ROOT / p).read_bytes()) != value for p, value in libraries.items()):
            raise RuntimeError('Verified authentication library source changed')
        if digest((ROOT / 'services/ifpmic_api/migrations/001_initial.sql').read_bytes()) != 'cf0437a5f32e1589e4ea821afbb2ef2480d780a276667880aa9a08a0f4c77f12':
            raise RuntimeError('Immutable 001 migration changed')
        if digest((ROOT / 'services/ifpmic_api/migrations/002_auth_retention.sql').read_bytes()) != '95c01f06eb586e0c1067f04672edfed8e0a11215752ad859ac9e4744da5a504e':
            raise RuntimeError('Immutable 002 migration changed')
        report['runtime_library_hashes'] = libraries
        report['source_hashes'] = sources()
        report['source_fingerprint'] = digest(json.dumps(report['source_hashes'], sort_keys=True).encode())
        report['environment'] = check_environment()
        import asyncio.unix_events
        import asyncio.base_subprocess
        report['environment']['subprocess_runtime_sources'] = {
            module.__name__: digest(Path(module.__file__).read_bytes())
            for module in (asyncio.unix_events, asyncio.base_subprocess)}
        report['unchanged_existing_sources'] = check_unchanged_sources()
        tc = json.loads((ROOT / 'docs/ifpmic/evidence/b02/g2-tc-ledger.json').read_bytes())
        expected_g2 = tc['expected_g2_pytest_cases']
        auth_tc = json.loads((ROOT / 'docs/ifpmic/evidence/b02/g3-tc-ledger.json').read_bytes())
        expected_g3 = auth_tc['expected_g3_pytest_cases']
        if auth_tc['approved_contract']['sha256'] != '9b01aea9e54d1663aa7ad0bd6d14028292aa85a4e4c7300c5552b3613a810a72' or type(expected_g3) is not int or expected_g3 < 50:
            raise RuntimeError('Independent G3 case inventory missing')
        if type(expected_g2) is not int or expected_g2 < 22:
            raise RuntimeError('Independent G2 case inventory missing')
        ledger_bytes = (ROOT / 'docs/ifpmic/evidence/b02/g4-tc-ledger.json').read_bytes()
        if G4_TC_LEDGER_SHA is None or digest(ledger_bytes) != G4_TC_LEDGER_SHA:
            raise RuntimeError('Final independent G4 ledger is not pinned or changed')
        jobs_tc = json.loads(ledger_bytes)
        pins = jobs_tc['source_pins']
        required_pins = {'tests/ifpmic_api/' + name for name in (
            'test_jobs.py', 'jobs_fixture.py', 'test_auth.py', 'oidc_provider.py', 'conftest.py')}
        required_pins |= {'services/ifpmic_api/' + name for name in (
            'jobs.py', 'request_contract.py', 'authority.py', 'app.py', 'auth.py', 'settings.py', 'errors.py')}
        if not required_pins <= pins.keys() or any(digest((ROOT / p).read_bytes()) != value for p, value in pins.items()):
            raise RuntimeError('Independent G4 implementation/test source pins differ')
        check_test_globals()
        expected_g4 = jobs_tc['expected_g4_pytest_cases']
        if jobs_tc['approved_contract']['sha256'] != contract_sha or type(expected_g4) is not int or expected_g4 < 40:
            raise RuntimeError('Independent G4 case inventory missing')
        expected_ids = jobs_tc['expected_g4_case_ids']
        if (type(expected_ids) is not list or len(expected_ids) != expected_g4 or
                len(set(expected_ids)) != expected_g4 or any(type(item) is not str for item in expected_ids)):
            raise RuntimeError('Exact independent G4 case IDs missing')
        modules = {'test_environment.py', 'test_migrations.py', 'test_snapshot_bridge.py', 'test_auth.py', 'test_jobs.py'}
        if {p.name for p in (ROOT / 'tests/ifpmic_api').glob('test_*.py')} != modules:
            raise RuntimeError('Unexpected test module outside the fixed split inventory')
        legacy_archive = ROOT / 'docs/ifpmic/evidence/b02/g3-gate.zip'
        if digest(legacy_archive.read_bytes()) != '76d5c6377d2dc8a80c8f01fcf5ffe53e083ed109a8a18345ba023ff745067c50':
            raise RuntimeError('Accepted G3 legacy inventory archive changed')
        with zipfile.ZipFile(legacy_archive) as archive:
            legacy_gate = json.loads(archive.read('gate/gate.json'))
        legacy_ids = next(c for c in legacy_gate['checks'] if c['name'] == 'python')['coverage_inventory']['case_ids']
        legacy_sources = {p: value for p, value in legacy_gate['source_hashes'].items()
                          if ((p.startswith(('services/ifpmic_api/', 'tests/ifpmic_api/'))
                               and p not in {'services/ifpmic_api/app.py', 'services/ifpmic_api/settings.py',
                                             'services/ifpmic_api/errors.py'})
                              or p in {'scripts/verify_ifpmic_g1.py', 'scripts/verify_ifpmic_g2.py',
                                       'scripts/verify_ifpmic_g3.py', 'docs/ifpmic/evidence/b02/g2-tc-ledger.json',
                                       'docs/ifpmic/evidence/b02/g3-tc-ledger.json'})}
        if not legacy_sources or any(digest((ROOT / p).read_bytes()) != value for p, value in legacy_sources.items()):
            raise RuntimeError('Accepted legacy implementation/test/ledger source bytes changed')
        report['accepted_legacy_source_hashes'] = legacy_sources
        report['python_split_reason'] = 'G3 legacy measured179.79s plus firstG4 target151.06s exceeds300s. Run both fixed inventories separately under unchanged300s per-command cap; no module/case omitted.'
        commands = [
            ('legacy_python', [sys.executable, '-m', 'pytest', '-q', 'tests/ifpmic_api/test_environment.py',
                               'tests/ifpmic_api/test_migrations.py', 'tests/ifpmic_api/test_snapshot_bridge.py',
                               'tests/ifpmic_api/test_auth.py', '--junitxml', str(directory / 'private-legacy_python.xml')], 300),
            ('g4_python', [sys.executable, '-m', 'pytest', '-q', 'tests/ifpmic_api/test_jobs.py',
                           '--junitxml', str(directory / 'private-g4_python.xml')], 300),
            ('b01_node', ['node', '--test', '--test-reporter=tap', 'tests/ifpmic-profile-contract.test.mjs', 'tests/ifpmic-profile-store.test.mjs',
                          'tests/ifpmic-profile-cli.test.mjs'], 180),
        ]
        report['checks'] = []
        for name, command, timeout in commands:
            check = {'name': name, 'timeout_seconds': timeout}
            report['checks'].append(check)
            if name in ('legacy_python', 'g4_python'):
                private_write(directory / f'private-{name}.xml', b'')
            try:
                result = run_owned_command(command, cwd=ROOT, timeout=timeout,
                                        env={**os.environ, 'PYTHONPATH': str(ROOT), 'IFPMIC_TEST_LIFECYCLE_PATH': str(lifecycle),
                                             'IFPMIC_AUTH_TEST_OBSERVATION_PATH': str(auth_observation),
                                             'IFPMIC_JOBS_TEST_OBSERVATION_PATH': str(jobs_observation)})
                output = result.stdout + result.stderr
            except subprocess.TimeoutExpired as error:
                private_write(directory / f'private-{name}.log', (error.stdout or b'') + (error.stderr or b''))
                check['result'] = 'timeout'
                check['child_cleanup'] = cleanup_owned_children()
                raise RuntimeError('Gate command timed out; inspect private retained evidence') from None
            private_write(directory / f'private-{name}.log', output)
            check.update({'exit_code': result.returncode, 'raw_log_sha256': digest(output)})
            if result.returncode:
                raise RuntimeError('Gate command failed; inspect private retained evidence')
            if name in ('legacy_python', 'g4_python'):
                raw = (directory / f'private-{name}.xml').read_bytes()
                tree = ET.fromstring(raw)
                cases = tree.findall('.//testcase')
                counts = {'tests': len(cases), 'failed': sum(c.find('failure') is not None for c in cases),
                          'errors': sum(c.find('error') is not None for c in cases), 'skipped': sum(c.find('skipped') is not None for c in cases)}
                counts['passed'] = counts['tests'] - counts['failed'] - counts['errors'] - counts['skipped']
                check['counts'] = counts
                times = [float(c.get('time', 'nan')) for c in cases]
                if not times or any(not math.isfinite(value) or not 0 <= value <= 30 for value in times):
                    raise RuntimeError('Python case exceeds approved 30-second limit or lacks timing')
                check['maximum_case_seconds'] = max(times)
                bridge_cases = [c for c in cases if c.get('classname') == 'tests.ifpmic_api.test_snapshot_bridge']
                g1_cases = [c for c in cases if c.get('classname') in {
                    'tests.ifpmic_api.test_environment', 'tests.ifpmic_api.test_migrations'}]
                auth_cases = [c for c in cases if c.get('classname') == 'tests.ifpmic_api.test_auth']
                jobs_cases = [c for c in cases if c.get('classname') == 'tests.ifpmic_api.test_jobs']
                actual_ids = sorted(c.get('classname') + '.' + c.get('name') for c in jobs_cases)
                if name == 'g4_python' and actual_ids != sorted(expected_ids):
                    raise RuntimeError('Observed G4 case IDs differ from independent inventory')
                check['coverage_inventory'] = {'g1_cases': len(g1_cases), 'g2_cases': len(bridge_cases), 'g3_cases': len(auth_cases), 'g4_cases': len(jobs_cases),
                                               'case_ids': [c.get('classname') + '.' + c.get('name') for c in cases]}
                if counts['passed'] != counts['tests']:
                    raise RuntimeError('All Python cases must pass without skips')
                if name == 'legacy_python':
                    if (len(g1_cases) != 12 or len(bridge_cases) != expected_g2 or len(auth_cases) != expected_g3 or
                            len(jobs_cases) != 0 or counts['tests'] != 12 + expected_g2 + expected_g3 or
                            sorted(check['coverage_inventory']['case_ids']) != sorted(legacy_ids)):
                        raise RuntimeError('Legacy Python inventory changed')
                elif (len(g1_cases) or len(bridge_cases) or len(auth_cases) or counts['tests'] != expected_g4):
                    raise RuntimeError('G4 Python inventory changed')
                # Keep raw JUnit private; preserve provenance for the neutral-host publication.
                for node in tree.iter():
                    if 'hostname' in node.attrib:
                        node.attrib['hostname'] = 'redacted-local-host'
                published = ET.tostring(tree, encoding='utf-8', xml_declaration=True)
                (directory / f'{name}-pytest.xml').write_bytes(published)
                check['junit'] = {'raw_private_sha256': digest(raw), 'published_sha256': digest(published),
                                  'transformation': 'Only hostname replaced with redacted-local-host; XML serialized.'}
                phase_lifecycle = lifecycle.read_bytes()
                private_write(directory / f'private-{name}-lifecycle.json', phase_lifecycle)
                phase = json.loads(phase_lifecycle)
                if phase['stop_status'] != 'stopped' or phase['pid_alive'] is not False or any(x['exit_code'] for x in phase['lifecycle']):
                    raise RuntimeError('Python phase PostgreSQL lifecycle not verified')
                check['postgres_lifecycle'] = {key: phase[key] for key in (
                    'stop_status', 'pid_alive', 'binary_versions', 'binary_sha256', 'lifecycle')}
            else:
                # Node test runner prints an aggregate trailer; pin all 48 B01 cases.
                import re
                counts = {key: int(re.search(rb'^# ' + key.encode() + rb' (\d+)\s*$', output, re.M)[1])
                          for key in ('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo')}
                check['counts'] = counts
                if counts != {'tests': 48, 'pass': 48, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}:
                    raise RuntimeError('All 48 B01 Node cases must pass without skips')
        data = json.loads(lifecycle.read_bytes())
        if data['stop_status'] != 'stopped' or data['pid_alive'] is not False or any(x['exit_code'] for x in data['lifecycle']):
            raise RuntimeError('Private PostgreSQL lifecycle not verified')
        report['postgres_lifecycle'] = {key: data[key] for key in ('stop_status', 'pid_alive', 'binary_versions', 'binary_sha256', 'lifecycle')}
        observation = json.loads(auth_observation.read_bytes())
        expected = {'success': 303, 'replay': 401, 'provider_error': 401, 'expired_state': 401, 'invalid_state': 401}
        if (observation.get('kind') != 'ifpmic.g3.service-observation.v1' or observation.get('cases') != expected or
                observation.get('canaries_absent') is not True or observation.get('service_exit_code') != 0 or
                observation.get('pid_alive') is not False or observation.get('private_directory_mode') != '0o700' or
                observation.get('stdout_mode') != '0o600' or observation.get('stderr_mode') != '0o600'):
            raise RuntimeError('Actual service privacy/lifecycle observation missing')
        import re
        logs = observation['logs']
        if set(logs) != {'stdout', 'stderr'} or any(
                set(item) != {'sha256', 'bytes'} or not re.fullmatch('[0-9a-f]{64}', item['sha256']) or
                type(item['bytes']) is not int or item['bytes'] < 0 for item in logs.values()):
            raise RuntimeError('Service log digest evidence invalid')
        report['auth_service_observation'] = {key: observation[key] for key in (
            'kind', 'cases', 'canaries_absent', 'service_exit_code', 'pid_alive', 'logs',
            'private_directory_mode', 'stdout_mode', 'stderr_mode')}
        jobs = json.loads(jobs_observation.read_bytes())
        expected_jobs = {'create': 202, 'same_key_replay': 202, 'same_key_conflict': 409, 'unauthorized': 403,
                         'fault_precommit': 503, 'fault_postcommit': 503, 'pagination_default': 25,
                         'restart_detail': 200, 'concurrent_one_winner': True, 'membership_nowait_no_deadlock': True,
                         'bridge_failure_replay': True, 'cli_grant': 0, 'cli_revoke': 0,
                         'distinct_sessions_same_actor': True, 'cross_project_race': True,
                         'cross_project_unique_contention': True}
        if (jobs.get('kind') != 'ifpmic.g4.runtime-observation.v1' or jobs.get('cases') != expected_jobs or
                jobs.get('no_canaries') is not True or type(jobs.get('services')) is not list or
                not 2 <= len(jobs['services']) <= 16):
            raise RuntimeError('Actual G4 runtime case/restart evidence missing')
        for service in [jobs.get('service'), *jobs['services']]:
            if (type(service) is not dict or service.get('exit_code') != 0 or service.get('pid_alive') is not False or
                    service.get('private_directory_mode') != '0o700' or service.get('stdout_mode') != '0o600' or
                    service.get('stderr_mode') != '0o600'):
                raise RuntimeError('G4 service lifecycle/privacy evidence invalid')
            logs = service.get('logs', {})
            if set(logs) != {'stdout', 'stderr'} or any(
                    set(item) != {'sha256', 'bytes'} or not re.fullmatch('[0-9a-f]{64}', item['sha256']) or
                    type(item['bytes']) is not int or item['bytes'] < 0 for item in logs.values()):
                raise RuntimeError('G4 service log digest evidence invalid')
        # Do not promote additional private fields from a test process.
        fields = ('exit_code', 'pid_alive', 'logs', 'private_directory_mode', 'stdout_mode', 'stderr_mode')
        report['jobs_runtime_observation'] = {'kind': jobs['kind'], 'cases': expected_jobs, 'no_canaries': True,
            'service': {key: jobs['service'][key] for key in fields},
            'services': [{key: item[key] for key in fields} for item in jobs['services']]}
        if any(digest((ROOT / p).read_bytes()) != value for p, value in libraries.items()):
            raise RuntimeError('Verified authentication libraries changed during gate')
        after = sources()
        report['source_changes'] = sorted(p for p in report['source_hashes'].keys() | after.keys() if report['source_hashes'].get(p) != after.get(p))
        if report['source_changes']:
            raise RuntimeError('Frozen source changed during verification')
        if check_unchanged_sources() != report['unchanged_existing_sources']:
            raise RuntimeError('Protected source/original inventory changed during verification')
        report['protected_sources_verified_before_and_after'] = True
        reap_orphans()
        if any(row[1] != 'Z' for row in owned_children().values()):
            raise RuntimeError('Gate-owned child still alive after verification')
        report['owned_children_absent'] = True
        report['verdict'] = 'pass'
    except Exception as error:
        report['verdict'] = 'fail'
        report['finding'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
    finally:
        if report['verdict'] != 'pass':
            try:
                report['failure_cleanup'] = cleanup_cluster(lifecycle)
            except Exception:
                report['failure_cleanup'] = 'unconfirmed; inspect private lifecycle'
            report['failure_child_cleanup'] = cleanup_owned_children()
        for private_file in directory.glob('private-*'):
            private_file.chmod(0o600)
        report['private_evidence_permissions'] = {
            'gate_directory_mode': oct(directory.stat().st_mode & 0o777),
            'files': {p.name: oct(p.stat().st_mode & 0o777) for p in sorted(directory.glob('private-*'))}}
        report['finished_at'] = datetime.now(timezone.utc).isoformat()
        (directory / 'gate.json').write_text(json.dumps(report, indent=2) + '\n')
        print(f"G4 {report['verdict']}: {(directory / 'gate.json').relative_to(ROOT)}")
    return 0 if report['verdict'] == 'pass' else 1


if __name__ == '__main__':
    sys.exit(main())
