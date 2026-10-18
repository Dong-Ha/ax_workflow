"""Frozen G2 gate: private bridge/catalog plus G1 and existing B01 regression."""
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import os
import sys
import xml.etree.ElementTree as ET

from verify_ifpmic_g1 import check_environment, check_unchanged_sources, cleanup_cluster

ROOT = Path(__file__).resolve().parents[1]
PLAN_SHA = 'f53a6d86e3e798d77a23741a923f95f960936179f26c4a2648df9b6178daf96a'


def digest(raw):
    return sha256(raw).hexdigest()


def sources():
    paths = [ROOT / name for name in ('.gitignore', 'README.md', 'docs/ifpmic/B02-IDENTITY.md',
                                     'scripts/verify_ifpmic_g1.py', 'scripts/verify_ifpmic_g2.py')]
    for directory in ('services/ifpmic_api', 'tests/ifpmic_api'):
        paths += [p for p in (ROOT / directory).rglob('*') if p.is_file() and '__pycache__' not in p.parts and
                  p.suffix in {'.py', '.mjs', '.sql', '.json', '.in', '.lock'}]
    paths += list((ROOT / 'docs/ifpmic/evidence/b02').glob('*.json'))
    return {str(p.relative_to(ROOT)): digest(p.read_bytes()) for p in sorted(set(paths))}


def main():
    stamp = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S-%fZ')
    directory = ROOT / 'workflow-artifacts/verification/B02/G2/gates' / stamp
    directory.mkdir(parents=True, mode=0o700)
    lifecycle = directory / 'private-lifecycle.json'
    report = {'kind': 'ifpmic_b02_g2_frozen_candidate', 'verdict': 'running', 'started_at': datetime.now(timezone.utc).isoformat(),
              'scope': 'Private Node bridge and immutable operator catalog import; includes G1 and B01 local regressions. G3-G7, full B02 and original AT remain pending.'}
    try:
        if digest((ROOT / 'docs/ifpmic/B02-IDENTITY.md').read_bytes()) != PLAN_SHA:
            raise RuntimeError('Approved B02 plan changed')
        for name in ('plan-review-v3.json', 'tc-plan-review-v3.json'):
            review = json.loads((ROOT / 'docs/ifpmic/evidence/b02' / name).read_bytes())
            if review['reviewed_plan']['sha256'] != PLAN_SHA or not review['decision'].startswith('approve'):
                raise RuntimeError('Independent plan approval missing')
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
        if type(expected_g2) is not int or expected_g2 < 22:
            raise RuntimeError('Independent G2 case inventory missing')
        commands = [
            ('python', [sys.executable, '-m', 'pytest', '-q', 'tests/ifpmic_api', '--junitxml', str(directory / 'private-pytest.xml')], 300),
            ('b01_node', ['node', '--test', '--test-reporter=tap', 'tests/ifpmic-profile-contract.test.mjs', 'tests/ifpmic-profile-store.test.mjs',
                          'tests/ifpmic-profile-cli.test.mjs'], 180),
        ]
        report['checks'] = []
        for name, command, timeout in commands:
            check = {'name': name, 'timeout_seconds': timeout}
            report['checks'].append(check)
            try:
                result = subprocess.run(command, cwd=ROOT, capture_output=True, timeout=timeout,
                                        env={**os.environ, 'PYTHONPATH': str(ROOT), 'IFPMIC_TEST_LIFECYCLE_PATH': str(lifecycle)})
                output = result.stdout + result.stderr
            except subprocess.TimeoutExpired as error:
                (directory / f'private-{name}.log').write_bytes((error.stdout or b'') + (error.stderr or b''))
                check['result'] = 'timeout'
                raise RuntimeError('Gate command timed out; inspect private retained evidence') from None
            (directory / f'private-{name}.log').write_bytes(output)
            check.update({'exit_code': result.returncode, 'raw_log_sha256': digest(output)})
            if result.returncode:
                raise RuntimeError('Gate command failed; inspect private retained evidence')
            if name == 'python':
                raw = (directory / 'private-pytest.xml').read_bytes()
                tree = ET.fromstring(raw)
                cases = tree.findall('.//testcase')
                counts = {'tests': len(cases), 'failed': sum(c.find('failure') is not None for c in cases),
                          'errors': sum(c.find('error') is not None for c in cases), 'skipped': sum(c.find('skipped') is not None for c in cases)}
                counts['passed'] = counts['tests'] - counts['failed'] - counts['errors'] - counts['skipped']
                check['counts'] = counts
                bridge_cases = [c for c in cases if c.get('classname') == 'tests.ifpmic_api.test_snapshot_bridge']
                g1_cases = [c for c in cases if c.get('classname') in {
                    'tests.ifpmic_api.test_environment', 'tests.ifpmic_api.test_migrations'}]
                check['coverage_inventory'] = {'g1_cases': len(g1_cases), 'g2_cases': len(bridge_cases),
                                               'case_ids': [c.get('classname') + '.' + c.get('name') for c in cases]}
                if (counts['passed'] != counts['tests'] or len(g1_cases) != 12 or len(bridge_cases) != expected_g2 or
                        counts['tests'] != len(g1_cases) + len(bridge_cases)):
                    raise RuntimeError('All Python cases must pass without skips')
                # Keep raw JUnit private; preserve provenance for the neutral-host publication.
                for node in tree.iter():
                    if 'hostname' in node.attrib:
                        node.attrib['hostname'] = 'redacted-local-host'
                published = ET.tostring(tree, encoding='utf-8', xml_declaration=True)
                (directory / 'pytest.xml').write_bytes(published)
                check['junit'] = {'raw_private_sha256': digest(raw), 'published_sha256': digest(published),
                                  'transformation': 'Only hostname replaced with redacted-local-host; XML serialized.'}
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
        after = sources()
        report['source_changes'] = sorted(p for p in report['source_hashes'].keys() | after.keys() if report['source_hashes'].get(p) != after.get(p))
        if report['source_changes']:
            raise RuntimeError('Frozen source changed during verification')
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
        for private_file in directory.glob('private-*'):
            private_file.chmod(0o600)
        report['private_evidence_permissions'] = {
            'gate_directory_mode': oct(directory.stat().st_mode & 0o777),
            'files': {p.name: oct(p.stat().st_mode & 0o777) for p in sorted(directory.glob('private-*'))}}
        report['finished_at'] = datetime.now(timezone.utc).isoformat()
        (directory / 'gate.json').write_text(json.dumps(report, indent=2) + '\n')
        print(f"G2 {report['verdict']}: {(directory / 'gate.json').relative_to(ROOT)}")
    return 0 if report['verdict'] == 'pass' else 1


if __name__ == '__main__':
    sys.exit(main())
