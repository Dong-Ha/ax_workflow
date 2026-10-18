"""Frozen G5 candidate: real workspace proof plus all accepted API regressions."""
from datetime import datetime, timezone
import builtins
import io
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import symtable
import sys
import xml.etree.ElementTree as ET
import zipfile

from verify_ifpmic_g1 import check_environment, check_unchanged_sources, cleanup_cluster
from verify_ifpmic_g4 import (digest, private_write, enable_subreaper, run_owned_command,
                             cleanup_owned_children, reap_orphans, owned_children)

ROOT = Path(__file__).resolve().parents[1]
CONTRACT_SHA = 'cdbda5b333e0227f7804255d8d430968eec22d89657708fa8c109dea83f73b8b'
G4_ARCHIVE_SHA = '5b7cec3e8e2d6febe0afe5da38744e59fb3a4b77fd3865cefac21bc87a528193'
G5_TC_LEDGER_SHA = 'f0b7164d9125b48db4d276885c22f5af5768b35c8bb55bb5277ad9aee3a9a59f'


def sources():
    paths = [ROOT / p for p in ('.gitignore', 'README.md', 'docs/ifpmic/B02-IDENTITY.md')]
    paths += [ROOT / f'scripts/verify_ifpmic_g{i}.py' for i in range(1, 6)]
    for directory in ('services/ifpmic_api', 'tests/ifpmic_api'):
        paths += [p for p in (ROOT / directory).rglob('*') if p.is_file() and '__pycache__' not in p.parts
                  and p.suffix in {'.py', '.mjs', '.sql', '.json', '.in', '.lock'}]
    paths += list((ROOT / 'docs/ifpmic/evidence/b02').glob('*.json'))
    return {str(p.relative_to(ROOT)): digest(p.read_bytes()) for p in sorted(set(paths))}


def static_globals():
    for name in ('test_jobs.py', 'jobs_fixture.py', 'test_workspace.py', 'workspace_fixture.py'):
        p = ROOT / 'tests/ifpmic_api' / name
        table = symtable.symtable(p.read_text(), str(p), 'exec')
        defined = {s.get_name() for s in table.get_symbols() if s.is_assigned() or s.is_imported() or s.is_namespace()}
        defined |= set(dir(builtins)) | {'__name__', '__file__', '__package__', '__spec__'}

        def inspect(t):
            for s in t.get_symbols():
                if s.is_referenced() and s.is_global() and s.get_name() not in defined:
                    raise RuntimeError('Undefined global in explicit TC test module')
            for child in t.get_children():
                inspect(child)
        inspect(table)


def log_metadata(logs):
    return (type(logs) is dict and set(logs) == {'stdout', 'stderr'} and all(
        type(item) is dict and set(item) == {'sha256', 'bytes'} and
        type(item['sha256']) is str and re.fullmatch('[0-9a-f]{64}', item['sha256']) and
        type(item['bytes']) is int and item['bytes'] >= 0 for item in logs.values()))


def process_record(value, *, worker=False):
    if (type(value) is not dict or value.get('pid_alive') is not False or
            value.get('private_directory_mode') != '0o700' or value.get('stdout_mode') != '0o600' or
            value.get('stderr_mode') != '0o600' or not log_metadata(value.get('logs'))):
        raise RuntimeError('Private process lifecycle/log evidence invalid')
    code = value.get('exit_code')
    if type(code) is not int or (not worker and code != 0):
        raise RuntimeError('Process exit evidence invalid')
    fields = ('exit_code', 'pid_alive', 'logs', 'private_directory_mode', 'stdout_mode', 'stderr_mode')
    return {key: value[key] for key in fields}


def exact_cases(actual, expected):
    return (type(actual) is dict and actual.keys() == expected.keys() and
            all(type(actual[k]) is type(v) and actual[k] == v for k, v in expected.items()))


def main():
    leaf = ROOT / 'workflow-artifacts/verification/B02/G5/gates' / datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S-%fZ')
    leaf.mkdir(mode=0o700, parents=True)
    lifecycle = leaf / 'private-lifecycle.json'
    observations = {name: leaf / f'private-{name}-observation.json' for name in ('auth', 'jobs', 'workspace')}
    report = {'kind': 'ifpmic_b02_g5_frozen_candidate', 'verdict': 'running',
              'started_at': datetime.now(timezone.utc).isoformat(),
              'scope': 'Local G5 workspace provisioning/recovery with G1-G4 and B01 regressions. G6/G7, B03-B13 and original AT remain pending.'}
    try:
        enable_subreaper()
        archive = ROOT / 'docs/ifpmic/evidence/b02/g4-gate.zip'
        if digest(archive.read_bytes()) != G4_ARCHIVE_SHA:
            raise RuntimeError('Accepted G4 archive changed')
        with zipfile.ZipFile(archive) as z:
            base = json.loads(z.read('gate/gate.json'))
        if base['verdict'] != 'pass':
            raise RuntimeError('Accepted G4 evidence missing')
        # Every prior captured byte remains fixed except approved integrations/docs.
        exceptions = {'README.md', 'services/ifpmic_api/app.py', 'services/ifpmic_api/settings.py'}
        previous = {p: h for p, h in base['source_hashes'].items() if p not in exceptions}
        if any(digest((ROOT / p).read_bytes()) != h for p, h in previous.items()):
            raise RuntimeError('Accepted G4 source/test/plan/ledger/runner baseline changed')
        report['accepted_previous_source_hashes'] = previous
        contract_file = ROOT / 'docs/ifpmic/evidence/b02/g5-implementation-contract-v2.json'
        if digest(contract_file.read_bytes()) != CONTRACT_SHA:
            raise RuntimeError('Approved G5 contract changed')
        contract = json.loads(contract_file.read_bytes())
        for p, h in contract['inputs'].items():
            if digest((ROOT / p).read_bytes()) != h:
                raise RuntimeError('G5 original-source/risk/advice evidence changed')
        reviews = {'g5-contract-review-v2.json': 'c4200b52bc1dd7d51788750c84a0e38b97b7c5f526e687e1a878447f0205567d',
                   'g5-tc-contract-review-v2.json': 'a908ec47c4e6ac919797cc2d7fc162778251bdec1e827bd61740c4e3f5d05c09'}
        for name, h in reviews.items():
            raw = (ROOT / 'docs/ifpmic/evidence/b02' / name).read_bytes()
            r = json.loads(raw)
            if digest(raw) != h or not r['decision'].startswith('approve') or r['reviewed_contract']['sha256'] != CONTRACT_SHA:
                raise RuntimeError('Independent G5 approval missing')
        libraries = base['runtime_library_hashes']
        if any(digest((ROOT / p).read_bytes()) != h for p, h in libraries.items()):
            raise RuntimeError('Previously verified runtime libraries changed')
        report['runtime_library_hashes'] = libraries
        report['environment'] = check_environment()
        report['unchanged_existing_sources'] = check_unchanged_sources()
        report['source_hashes'] = sources()
        report['source_fingerprint'] = digest(json.dumps(report['source_hashes'], sort_keys=True).encode())
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for path, expected_sha in report['source_hashes'].items():
                raw = (ROOT / path).read_bytes()
                if digest(raw) != expected_sha:
                    raise RuntimeError('Source changed before private candidate capture')
                archive.writestr(path, raw)
        private_write(leaf / 'private-candidate-source.zip', buffer.getvalue())
        report['private_source_archive'] = {'sha256': digest(buffer.getvalue()), 'entries': len(report['source_hashes'])}
        raw = (ROOT / 'docs/ifpmic/evidence/b02/g5-tc-ledger.json').read_bytes()
        if G5_TC_LEDGER_SHA is None or digest(raw) != G5_TC_LEDGER_SHA:
            raise RuntimeError('Final independent G5 TC ledger not pinned or changed')
        tc = json.loads(raw)
        schema_path = 'docs/ifpmic/evidence/b02/g5-gate-observation-contract.json'
        if tc.get('gate_observation_contract') != {'path': schema_path, 'sha256': digest((ROOT / schema_path).read_bytes())}:
            raise RuntimeError('Independent G5 observation schema pin differs')
        required = {'services/ifpmic_api/' + n for n in ('workspace.py', 'workspace_fs.py', 'settings.py', 'app.py')}
        required |= {'tests/ifpmic_api/' + n for n in ('test_workspace.py', 'workspace_fixture.py', 'test_jobs.py', 'jobs_fixture.py', 'conftest.py')}
        if (tc['approved_contract']['sha256'] != CONTRACT_SHA or not required <= tc['source_pins'].keys() or
                any(digest((ROOT / p).read_bytes()) != h for p, h in tc['source_pins'].items())):
            raise RuntimeError('Independent G5 product/test source pins differ')
        count = tc['expected_g5_pytest_cases']
        ids = tc['expected_g5_case_ids']
        if type(count) is not int or count < 20 or type(ids) is not list or len(ids) != count or len(set(ids)) != count:
            raise RuntimeError('Exact independent G5 testcase inventory missing')
        static_globals()
        modules = {'test_environment.py', 'test_migrations.py', 'test_snapshot_bridge.py', 'test_auth.py', 'test_jobs.py', 'test_workspace.py'}
        if {p.name for p in (ROOT / 'tests/ifpmic_api').glob('test_*.py')} != modules:
            raise RuntimeError('Unexpected Python test module outside fixed split inventory')
        previous_checks = {c['name']: c for c in base['checks']}
        expected = {'legacy_python': previous_checks['legacy_python']['coverage_inventory']['case_ids'],
                    'g4_python': previous_checks['g4_python']['coverage_inventory']['case_ids'], 'g5_python': ids}
        if len(expected['legacy_python']) != 167 or len(expected['g4_python']) != 91:
            raise RuntimeError('Accepted API regression inventory changed')
        commands = [
            ('legacy_python', ['test_environment.py', 'test_migrations.py', 'test_snapshot_bridge.py', 'test_auth.py']),
            ('g4_python', ['test_jobs.py']), ('g5_python', ['test_workspace.py'])]
        report['checks'] = []
        for phase, filenames in [*commands, ('b01_node', None)]:
            timeout = 180 if filenames is None else 300
            junit = leaf / f'private-{phase}.xml'
            command = (['node', '--test', '--test-reporter=tap', 'tests/ifpmic-profile-contract.test.mjs',
                        'tests/ifpmic-profile-store.test.mjs', 'tests/ifpmic-profile-cli.test.mjs'] if filenames is None else
                       [sys.executable, '-m', 'pytest', '-q', *['tests/ifpmic_api/' + n for n in filenames], '--junitxml', str(junit)])
            check = {'name': phase, 'timeout_seconds': timeout}
            report['checks'].append(check)
            if filenames is not None:
                private_write(junit, b'')
            env = {**os.environ, 'PYTHONPATH': str(ROOT), 'IFPMIC_TEST_LIFECYCLE_PATH': str(lifecycle),
                   'IFPMIC_AUTH_TEST_OBSERVATION_PATH': str(observations['auth']),
                   'IFPMIC_JOBS_TEST_OBSERVATION_PATH': str(observations['jobs']),
                   'IFPMIC_WORKSPACE_TEST_OBSERVATION_PATH': str(observations['workspace'])}
            try:
                done = run_owned_command(command, cwd=ROOT, timeout=timeout, env=env)
            except subprocess.TimeoutExpired as error:
                private_write(leaf / f'private-{phase}.log', (error.stdout or b'') + (error.stderr or b''))
                check['result'] = 'timeout'
                raise RuntimeError('Gate command timed out; inspect retained private evidence') from None
            output = done.stdout + done.stderr
            private_write(leaf / f'private-{phase}.log', output)
            check.update(exit_code=done.returncode, raw_log_sha256=digest(output))
            if done.returncode:
                raise RuntimeError('Gate command failed; inspect retained private evidence')
            if filenames is None:
                counts = {k: int(re.search(rb'^# ' + k.encode() + rb' (\d+)\s*$', output, re.M)[1])
                          for k in ('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo')}
                if counts != {'tests': 48, 'pass': 48, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}:
                    raise RuntimeError('B01 Node testcase inventory failed')
                check['counts'] = counts
                continue
            raw = junit.read_bytes()
            tree = ET.fromstring(raw)
            cases = tree.findall('.//testcase')
            observed = sorted(c.get('classname') + '.' + c.get('name') for c in cases)
            counts = {'tests': len(cases), 'failed': sum(c.find('failure') is not None for c in cases),
                      'errors': sum(c.find('error') is not None for c in cases), 'skipped': sum(c.find('skipped') is not None for c in cases)}
            counts['passed'] = counts['tests'] - counts['failed'] - counts['errors'] - counts['skipped']
            check['counts'] = counts
            if observed != sorted(expected[phase]) or counts['passed'] != counts['tests']:
                raise RuntimeError('Exact Python testcase IDs/results differ')
            times = [float(c.get('time', 'nan')) for c in cases]
            if any(not math.isfinite(v) or not 0 <= v <= 30 for v in times):
                raise RuntimeError('Python case exceeds approved30second limit')
            check['maximum_case_seconds'] = max(times)
            check['coverage_inventory'] = {'case_ids': observed}
            for node in tree.iter():
                if 'hostname' in node.attrib:
                    node.attrib['hostname'] = 'redacted-local-host'
            published = ET.tostring(tree, encoding='utf-8', xml_declaration=True)
            (leaf / f'{phase}-pytest.xml').write_bytes(published)
            check['junit'] = {'raw_private_sha256': digest(raw), 'published_sha256': digest(published),
                              'transformation': 'Only hostname replaced with redacted-local-host; XML serialized.'}
            raw = lifecycle.read_bytes()
            private_write(leaf / f'private-{phase}-lifecycle.json', raw)
            data = json.loads(raw)
            if data['stop_status'] != 'stopped' or data['pid_alive'] is not False or any(x['exit_code'] for x in data['lifecycle']):
                raise RuntimeError('Python phase PostgreSQL lifecycle unverified')
            check['postgres_lifecycle'] = {k: data[k] for k in ('stop_status', 'pid_alive', 'binary_versions', 'binary_sha256', 'lifecycle')}
        auth = json.loads(observations['auth'].read_bytes())
        if (auth.get('kind') != 'ifpmic.g3.service-observation.v1' or
                not exact_cases(auth.get('cases'), base['auth_service_observation']['cases']) or auth.get('canaries_absent') is not True):
            raise RuntimeError('Actual auth runtime evidence missing')
        process_record({**auth, 'exit_code': auth.get('service_exit_code')})
        report['auth_service_observation'] = {k: auth[k] for k in base['auth_service_observation']}
        jobs = json.loads(observations['jobs'].read_bytes())
        if (jobs.get('kind') != 'ifpmic.g4.runtime-observation.v1' or
                not exact_cases(jobs.get('cases'), base['jobs_runtime_observation']['cases']) or jobs.get('no_canaries') is not True or
                type(jobs.get('services')) is not list or not 2 <= len(jobs['services']) <= 16):
            raise RuntimeError('Actual G4 runtime evidence missing')
        report['jobs_runtime_observation'] = {'kind': jobs['kind'], 'cases': jobs['cases'], 'no_canaries': True,
            'service': process_record(jobs.get('service')), 'services': [process_record(s) for s in jobs['services']]}
        ws = json.loads(observations['workspace'].read_bytes())
        schema = json.loads((ROOT / 'docs/ifpmic/evidence/b02/g5-gate-observation-contract.json').read_bytes())
        if (ws.get('kind') != schema['observation_kind'] or not exact_cases(ws.get('cases'), schema['cases']) or
                ws.get('no_canaries') is not True or type(ws.get('processes')) is not list or len(ws['processes']) < 2):
            raise RuntimeError('Actual G5 workspace/process evidence missing')
        processes = []
        identities = set()
        log_root = leaf / 'workspace-process-logs'
        log_info = log_root.lstat()
        if not stat.S_ISDIR(log_info.st_mode) or stat.S_IMODE(log_info.st_mode) != 0o700:
            raise RuntimeError('Workspace worker private log directory unsafe')
        expected_logs = {f'process-{i:03d}-{stream}.log' for i in range(len(ws['processes']))
                         for stream in ('stdout', 'stderr')}
        if {p.name for p in log_root.iterdir()} != expected_logs:
            raise RuntimeError('Unaccounted workspace worker raw log files')
        for index, p in enumerate(ws['processes']):
            if p.get('role') not in schema['processes']['allowed_roles']:
                raise RuntimeError('Unexpected workspace process role')
            ident = p.get('process_identity')
            if (type(ident) is not dict or set(ident) != {'pid', 'start_ticks'} or
                    type(ident['pid']) is not int or ident['pid'] <= 0 or
                    type(ident['start_ticks']) is not str or not re.fullmatch('0|[1-9][0-9]*', ident['start_ticks'])):
                raise RuntimeError('Workspace process identity evidence invalid')
            pair = (ident['pid'], ident['start_ticks'])
            if pair in identities:
                raise RuntimeError('Duplicate workspace process identity')
            identities.add(pair)
            processes.append({'role': p['role'], **process_record(p, worker=True)})
            for stream in ('stdout', 'stderr'):
                path = log_root / f'process-{index:03d}-{stream}.log'
                info = path.lstat()
                if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
                    raise RuntimeError('Workspace raw process log unsafe')
                raw = path.read_bytes()
                if p['logs'][stream] != {'sha256': digest(raw), 'bytes': len(raw)}:
                    raise RuntimeError('Workspace raw process log metadata differs')
        if (not any(p['role'] == 'cli_run' and p['exit_code'] == 0 for p in processes) or
                not any(p['role'] == 'crash_worker' and p['exit_code'] == -signal.SIGKILL for p in processes) or
                sum(p['role'] == 'reconciler' and p['exit_code'] == 0 for p in processes) < 2):
            raise RuntimeError('Workspace worker lifecycle/crash evidence missing')
        report['workspace_runtime_observation'] = {'kind': ws['kind'], 'cases': ws['cases'], 'processes': processes, 'no_canaries': True}
        if any(digest((ROOT / p).read_bytes()) != h for p, h in libraries.items()):
            raise RuntimeError('Verified runtime library changed during gate')
        after = sources()
        report['source_changes'] = sorted(p for p in report['source_hashes'].keys() | after.keys() if report['source_hashes'].get(p) != after.get(p))
        if report['source_changes'] or check_unchanged_sources() != report['unchanged_existing_sources']:
            raise RuntimeError('Frozen/protected source or original inventory changed during gate')
        report['protected_sources_verified_before_and_after'] = True
        reap_orphans()
        if any(row[1] != 'Z' for row in owned_children().values()):
            raise RuntimeError('Gate-owned child remains live')
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
                report['failure_cleanup'] = 'unconfirmed; inspect retained private lifecycle'
            report['failure_child_cleanup'] = cleanup_owned_children()
        for p in leaf.glob('private-*'):
            p.chmod(0o600)
        report['private_evidence_permissions'] = {'gate_directory_mode': oct(leaf.stat().st_mode & 0o777),
            'files': {p.name: oct(p.stat().st_mode & 0o777) for p in sorted(leaf.glob('private-*'))}}
        report['finished_at'] = datetime.now(timezone.utc).isoformat()
        (leaf / 'gate.json').write_text(json.dumps(report, indent=2) + '\n')
        print(f"G5 {report['verdict']}: {(leaf / 'gate.json').relative_to(ROOT)}")
    return 0 if report['verdict'] == 'pass' else 1


if __name__ == '__main__':
    sys.exit(main())
