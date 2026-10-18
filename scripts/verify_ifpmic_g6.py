"""G6 frozen integration gate; local prerequisites only, G7/real AT still required."""
from contextlib import redirect_stdout
from datetime import datetime, timezone
import io
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import zipfile

import ifpmic_g6_baseline as baseline
import verify_ifpmic_g5 as api_gate
from verify_ifpmic_g1 import check_environment, check_unchanged_sources, cleanup_cluster
from verify_ifpmic_g4 import (private_write, enable_subreaper, run_owned_command,
                             cleanup_owned_children, reap_orphans, owned_children)

ROOT = baseline.ROOT
CONTRACT = 'docs/ifpmic/evidence/b02/g6-execution-contract-v2.json'
CONTRACT_SHA = 'e45256f8f942046645af1f61cbc3c91a504780cb3d8c408a8d35702753c8cd63'
REVIEWS = {'g6-contract-review-v2.json': 'dc60fec3366914494729fb650f45c20dbca1c869906f93367bba064c18109b6b',
           'g6-tc-contract-review-v2.json': '1204d724f789a3848532d9bdd2b766455f870481bb0f5abc3ba34a692645c1bb'}


def now():
    return datetime.now(timezone.utc).isoformat()


def capture_zip(path, hashes):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, expected in hashes.items():
            raw = (ROOT / name).read_bytes()
            if baseline.digest(raw) != expected:
                raise RuntimeError('Captured file changed before archive creation')
            archive.writestr(name, raw)
    raw = buffer.getvalue()
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        if set(archive.namelist()) != set(hashes) or any(baseline.digest(archive.read(p)) != h for p, h in hashes.items()):
            raise RuntimeError('Private exact-byte archive mismatch')
    private_write(path, raw)
    return {'sha256': baseline.digest(raw), 'entries': len(hashes)}


def spec_inventory(raw, expected):
    text = raw.decode('utf-8')
    counts = {}
    for key in ('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'):
        values = re.findall(r'^[ℹ#] ' + key + r'\s+(\d+)\s*$', text, re.M)
        if len(values) != 1:
            raise RuntimeError('Full Node result summary missing or ambiguous')
        counts[key] = int(values[0])
    if counts != {'tests': 387, 'pass': 387, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}:
        raise RuntimeError('Complete Node count/result inventory failed')
    records = re.findall(expected['extraction']['regex'], text, re.M)
    names = sorted(name for name, duration in records)
    if len(records) != len(set(names)) or names != expected['expected_names']:
        raise RuntimeError('Exact accepted Node callback names differ')
    durations = {name: float(ms) / 1000 for name, ms in records}
    if any(not math.isfinite(value) or not 0 <= value <= 30 for value in durations.values()):
        raise RuntimeError('Full Node callback exceeds approved30second limit')
    return {'counts': counts, 'case_names': names, 'case_seconds': durations,
            'maximum_case_seconds': max(durations.values()), 'test_concurrency': 2}


def main():
    leaf = ROOT / 'workflow-artifacts/verification/B02/G6/gates' / datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S-%fZ')
    leaf.mkdir(parents=True, mode=0o700)
    report = {'kind': 'ifpmic_b02_g6_frozen_candidate', 'verdict': 'running', 'started_at': now(),
              'scope': 'Fresh local351Python+48targetedNode, full387Node, frontend/plugin rebuild and conditional UI regression scope. G7/B03-B13 and original32 AT remain pending.', 'checks': []}
    child_leaf = None
    build_started = False

    def run_step(name, command, timeout):
        record = {'name': name, 'command': command, 'timeout_seconds': timeout, 'started_at': now()}
        report['checks'].append(record)
        start = time.monotonic()
        try:
            done = run_owned_command(command, cwd=ROOT, timeout=timeout, env={**os.environ, 'NO_COLOR': '1', 'NODE_DISABLE_COLORS': '1'})
        except subprocess.TimeoutExpired as error:
            raw = (error.stdout or b'') + (error.stderr or b'')
            private_write(leaf / f'private-{name}.log', raw)
            record.update(result='timeout', elapsed_seconds=time.monotonic() - start)
            raise RuntimeError('G6 command timed out; inspect retained private evidence') from None
        raw = done.stdout + done.stderr
        private_write(leaf / f'private-{name}.log', raw)
        record.update(exit_code=done.returncode, elapsed_seconds=time.monotonic() - start,
                      raw_log_sha256=baseline.digest(raw), stdout_sha256=baseline.digest(done.stdout),
                      stderr_sha256=baseline.digest(done.stderr), finished_at=now())
        if done.returncode:
            raise RuntimeError('G6 command failed; inspect retained private evidence')
        return raw, record

    try:
        enable_subreaper()
        raw = (ROOT / CONTRACT).read_bytes()
        if baseline.digest(raw) != CONTRACT_SHA:
            raise RuntimeError('Approved G6 execution contract changed')
        contract = json.loads(raw)
        for name, expected in contract['inputs'].items():
            if baseline.digest((ROOT / name).read_bytes()) != expected:
                raise RuntimeError('Approved G6 input changed')
        for name, expected in REVIEWS.items():
            raw = (ROOT / 'docs/ifpmic/evidence/b02' / name).read_bytes()
            if baseline.digest(raw) != expected or json.loads(raw)['reviewed_contract']['sha256'] != CONTRACT_SHA:
                raise RuntimeError('G6 contract review missing or changed')
        report['source_hashes'] = baseline.source_hashes()
        report['source_fingerprint'] = baseline.digest(json.dumps(report['source_hashes'], sort_keys=True).encode())
        report['private_source_archive'] = capture_zip(leaf / 'private-candidate-source.zip', report['source_hashes'])
        report['baseline_checks'] = baseline.check_baseline()
        if report['baseline_checks'].get('ok') is not True:
            raise RuntimeError('G6 baseline preconditions failed; no execution permitted')
        report['tool_hashes'] = baseline.tool_hashes()
        report['build_outputs_before'] = baseline.output_hashes()
        report['private_build_before'] = capture_zip(leaf / 'private-build-before.zip', report['build_outputs_before'])
        report['environment'] = check_environment()
        report['protected_before'] = check_unchanged_sources()
        node_version, _ = run_step('node-version', ['node', '--version'], 10)
        npm_version, _ = run_step('npm-version', ['npm', '--version'], 10)
        expected_runtime = json.loads((ROOT / 'docs/ifpmic/evidence/b02/g6-source-baseline.json').read_bytes())['dependency_resolution']['runtime']
        if (node_version.decode().strip() != expected_runtime['node'] or
                npm_version.decode().strip() != expected_runtime['npm'] or
                report['environment']['python'] != expected_runtime['python']):
            raise RuntimeError('Reviewed Node/npm/Python toolchain differs')
        report['environment']['node'] = node_version.decode().strip()
        report['environment']['npm'] = npm_version.decode().strip()

        # Accepted G5 orchestrator retains three separate300s pytest subprocesses.
        parent = ROOT / 'workflow-artifacts/verification/B02/G5/gates'
        before = set(parent.iterdir()) if parent.exists() else set()
        output = io.StringIO()
        with redirect_stdout(output):
            code = api_gate.main()
        private_write(leaf / 'private-api-runner.log', output.getvalue().encode())
        created = set(parent.iterdir()) - before
        if len(created) != 1:
            raise RuntimeError('Fresh API gate directory not uniquely identified')
        child_leaf = created.pop()
        child_raw = (child_leaf / 'gate.json').read_bytes()
        child = json.loads(child_raw)
        private_write(leaf / 'private-api-gate.json', child_raw)
        if code != 0 or child['verdict'] != 'pass' or child['source_changes'] or not child['owned_children_absent']:
            raise RuntimeError('Fresh complete G1-G5 regression gate failed')
        checks = {c['name']: c for c in child['checks']}
        if checks['b01_node']['counts'] != {'tests': 48, 'pass': 48, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}:
            raise RuntimeError('Fresh targeted Node regression inventory differs')
        for phase, count in [('legacy_python', 167), ('g4_python', 91), ('g5_python', 93)]:
            if checks[phase]['counts'] != {'tests': count, 'failed': 0, 'errors': 0, 'skipped': 0, 'passed': count}:
                raise RuntimeError('Fresh Python regression counts differ')
            pg = checks[phase]['postgres_lifecycle']
            if pg['stop_status'] != 'stopped' or pg['pid_alive'] is not False:
                raise RuntimeError('Fresh API PostgreSQL lifecycle unverified')
        targeted = (child_leaf / 'private-b01_node.log').read_text()
        durations = [float(v) / 1000 for v in re.findall(r'^\s+duration_ms:\s*([0-9.]+)\s*$', targeted, re.M)]
        if len(durations) != 48 or any(not math.isfinite(v) or not 0 <= v <= 30 for v in durations):
            raise RuntimeError('Targeted Node48 timing inventory invalid')
        report['api_regression'] = {'gate_path': str((child_leaf / 'gate.json').relative_to(ROOT)),
            'gate_sha256': baseline.digest(child_raw), 'source_fingerprint': child['source_fingerprint'],
            'private_source_archive': child['private_source_archive'], 'counts': {k: v['counts'] for k, v in checks.items()},
            'maximum_targeted_node_seconds': max(durations), 'all_three_postgres_stopped': True,
            'actual_auth_jobs_workspace_observations_verified': True, 'private_identities_and_raw_logs_excluded': True}

        package = json.loads((ROOT / 'package.json').read_bytes())
        if package['scripts']['test'] != 'node --test tests/*.test.mjs':
            raise RuntimeError('Accepted npm test script changed')
        files = sorted(str(p.relative_to(ROOT)) for p in (ROOT / 'tests').glob('*.test.mjs'))
        original = json.loads((ROOT / 'docs/ifpmic/evidence/b02/g6-source-baseline.json').read_bytes())
        expected_files = sorted(n for n in original['source_inventory']['files'] if n.startswith('tests/') and n.count('/') == 1 and n.endswith('.test.mjs'))
        if not files or files != expected_files:
            raise RuntimeError('Full Node test file inventory differs')
        raw, record = run_step('full-node', ['node', '--test', '--test-concurrency=2', '--test-reporter=spec', *files], 180)
        inventory = json.loads((ROOT / 'docs/ifpmic/evidence/b02/g6-node-inventory.json').read_bytes())
        record.update(spec_inventory(raw, inventory))
        record['npm_test_equivalence'] = 'Exact unchanged scripts.test glob; only runner concurrency/reporter flags added before operands.'
        build_started = True
        run_step('build', ['npm', 'run', 'build'], 120)
        run_step('plugin-build', ['npm', 'run', 'ifpmic:plugin:build'], 120)
        run_step('source-uploads', ['npm', 'run', 'ifpmic:verify-sources'], 30)
        report['build_outputs_after'] = baseline.output_hashes()
        report['private_build_after'] = capture_zip(leaf / 'private-build-after.zip', report['build_outputs_after'])
        if report['build_outputs_after'] != report['build_outputs_before']:
            raise RuntimeError('Rebuilt UI/plugin output differs; expand browser scope')
        after = baseline.source_hashes()
        report['source_changes'] = sorted(p for p in report['source_hashes'].keys() | after.keys() if report['source_hashes'].get(p) != after.get(p))
        if report['source_changes'] or baseline.tool_hashes() != report['tool_hashes'] or check_unchanged_sources() != report['protected_before']:
            raise RuntimeError('Frozen source/tool/protected inventory changed during G6')
        report['baseline_after'] = baseline.check_baseline()
        if report['baseline_after'].get('ok') is not True:
            raise RuntimeError('G6 baseline changed after execution')
        report['protected_sources_verified_before_and_after'] = True
        report['conditional_ui_omission'] = {'decision': 'eligible_under_approved_parent_plan_condition',
            'basis': 'Exact51sources/46UIinventory and existing lock resolutions unchanged; all10outputs equal controls after actual rebuild; no frontend/API connection added.',
            'omitted': 'Existing11-command browser/native-host gate only.',
            'residual_risks': contract['conditional_ui_omission']['residual_risks'],
            'revalidation_trigger': contract['conditional_ui_omission']['expand_trigger']}
        reap_orphans()
        if any(v[1] != 'Z' for v in owned_children().values()):
            raise RuntimeError('G6-owned child remains live')
        report['owned_children_absent'] = True
        report['verdict'] = 'pass'
    except Exception as error:
        report['verdict'] = 'fail'
        report['finding'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
    finally:
        if report['verdict'] != 'pass':
            if child_leaf is not None:
                try:
                    report['api_failure_cleanup'] = cleanup_cluster(child_leaf / 'private-lifecycle.json')
                except Exception:
                    report['api_failure_cleanup'] = 'unconfirmed; inspect private API lifecycle'
            if build_started:
                try:
                    report['private_failure_build_outputs'] = capture_zip(leaf / 'private-failure-build.zip', baseline.output_hashes())
                except Exception:
                    report['private_failure_build_outputs'] = 'partial output capture unavailable; raw command log retained'
            report['failure_child_cleanup'] = cleanup_owned_children()
        for p in leaf.glob('private-*'):
            p.chmod(0o600)
        report['private_evidence_permissions'] = {'gate_directory_mode': oct(leaf.stat().st_mode & 0o777),
            'files': {p.name: oct(p.stat().st_mode & 0o777) for p in leaf.glob('private-*')}}
        report['post_gate_metadata_policy'] = 'Progress status/evidence links may be updated only after independent acceptance. Captured progress bytes describe the frozen pre-acceptance state; product/tests/runner/plan/lock bytes must remain exact.'
        report['finished_at'] = now()
        (leaf / 'gate.json').write_text(json.dumps(report, indent=2) + '\n')
        print(f"G6 {report['verdict']}: {(leaf / 'gate.json').relative_to(ROOT)}")
    return 0 if report['verdict'] == 'pass' else 1


if __name__ == '__main__':
    sys.exit(main())
