#!/usr/bin/env python3
"""Fresh full-490 H2 runtime gate. Raw evidence is retained privately."""
from __future__ import annotations

import hashlib
import ast
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import sys
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / 'docs/ifpmic/evidence/b03'
CONTRACT_PATH = EVIDENCE / 'h2-runtime-full-execution-contract-v7.json'
LEDGER_PATH = EVIDENCE / 'h2-runtime-full-integrated-ledger-v7.json'
CONTRACT_SHA = 'f554b232b7c21a77cbe16c23dc86624f4afb9c7de747067e00c79c5309070a3b'
LEDGER_SHA = 'f686e468afe5cb410d31fe194d4e17ee00f08c201509f3e2201215e2f08993d1'
CONTRACT_REVIEW_SHAS = {
    'h2-runtime-full-execution-contract-review-v7.json': 'e702c77b609524b35e3a343c5afdea278fccd347b61fb55e73f203ef966f25db',
    'h2-runtime-full-execution-tc-review-v7.json': '043261a09d0e1659c4bb77534f2a3608ee5d1ecd1f6ae280d9432dba51995b03',
}

ORDER = (
    'dispatcher_crashes', 'worker_api_crashes', 'startup', 'window',
    'activity_runtime', 'transport', 'workspace', 'started_deployment',
    'fixture_failure', 'h2_runtime_python', 'h1_python', 'g5_python',
    'h2_schema_python', 'g4_python', 'legacy_python',
)
CAPS = {
    'dispatcher_crashes': 1980, 'worker_api_crashes': 1020, 'startup': 690,
    'window': 750, 'activity_runtime': 2730, 'transport': 780,
    'workspace': 2700, 'started_deployment': 2460, 'fixture_failure': 210,
    'h2_runtime_python': 300, 'h1_python': 300, 'g5_python': 600,
    'h2_schema_python': 300, 'g4_python': 300, 'legacy_python': 300,
}
COLLECTION_SECONDS = 30
OUTER_SECONDS = 16220  # Existing16020 plus separately reviewed200s raw-audit overhead.
ARCHIVE_MEMBERS = (
    'gate/summary.json', 'gate/pytest.xml', 'gate/case-timings.json',
    'gate/postgres-lifecycle.json', 'gate/temporal-summary.json',
    'gate/source-manifest.json',
)


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def read_json(path: Path):
    return json.loads(path.read_bytes())


def write_private(path: Path, value) -> None:
    raw = value if isinstance(value, bytes) else (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.write_bytes(raw)
    path.chmod(0o600)


def require_file_hash(path: Path, expected: str, what: str) -> bytes:
    raw = path.read_bytes()
    if sha(raw) != expected:
        raise RuntimeError(f'{what} hash differs')
    return raw


def verify_runner_source(expected_sha: str | None = None) -> str:
    """Bind the fixed regular source file before execution and publication."""
    path = ROOT / 'scripts/verify_ifpmic_b03_h2_runtime_full.py'
    if path.is_symlink() or not path.is_file() or path.resolve() != path:
        raise RuntimeError('Runner source is not the fixed regular repository file')
    actual = sha(path.read_bytes())
    if expected_sha is not None and actual != expected_sha:
        raise RuntimeError('Runner source changed before public proposal')
    return actual


def verify_review(path: Path, expected_verdict: str, fields: dict[str, str]) -> tuple[dict, bytes]:
    raw = path.read_bytes()
    item = json.loads(raw)
    if item.get('verdict') != expected_verdict:
        raise RuntimeError(f'Review verdict missing: {path.name}')
    for key, expected in fields.items():
        if item.get(key) != expected:
            raise RuntimeError(f'Review target mismatch: {path.name}:{key}')
    return item, raw


def execution_gate(contract: dict, ledger: dict, runner_sha: str):
    """Resolve all reviews before any dynamic helper import or test collection."""
    protocol = contract['review_protocol']
    if len(protocol.get('contract_reviews', [])) != 2 or len(protocol.get('pre_gate_reviews', [])) != 2:
        raise RuntimeError('Execution protocol must name the exact paired contract and pre-gate reviews')
    independent_path = EVIDENCE / protocol['contract_reviews'][0]['path'].split('/')[-1]
    tc_path = EVIDENCE / protocol['contract_reviews'][1]['path'].split('/')[-1]
    independent_raw = require_file_hash(independent_path, CONTRACT_REVIEW_SHAS[independent_path.name], 'Independent contract review')
    tc_raw = require_file_hash(tc_path, CONTRACT_REVIEW_SHAS[tc_path.name], 'TC contract review')
    for path, raw in ((independent_path, independent_raw), (tc_path, tc_raw)):
        review = json.loads(raw)
        if (review.get('verdict') != 'approve_runner_authoring_only'
                or review.get('contract_sha256') != CONTRACT_SHA
                or review.get('ledger_sha256') != LEDGER_SHA
                or review.get('raw_rules_sha256') != contract['per_case_raw_evidence']['rules']['sha256']):
            raise RuntimeError('Exact contract/ledger runner-authoring review missing')

    source_path = ROOT / protocol['runner_source_review_path']
    pre_paths = [ROOT / p for p in protocol['pre_gate_reviews']]
    source_review_raw = source_path.read_bytes()
    source_review = json.loads(source_review_raw)
    source_review_sha = sha(source_review_raw)
    source_target = {
        'contract_sha256': CONTRACT_SHA,
        'ledger_sha256': LEDGER_SHA,
        'runner_sha256': runner_sha,
        'raw_rules_sha256': contract['per_case_raw_evidence']['rules']['sha256'],
    }
    if source_review.get('verdict') not in ('approve_source', 'approve_execution'):
        raise RuntimeError('Exact independent final runner-source review missing')
    if source_review.get('reviewer', {}).get('independence') is None:
        raise RuntimeError('Runner source review does not declare independent review')
    for key, value in source_target.items():
        if source_review.get(key) != value:
            raise RuntimeError(f'Runner source review target mismatch: {key}')
    source_pins = source_review.get('source_pins', {})
    if source_pins.get('scripts/verify_ifpmic_b03_h2_runtime_full.py') != runner_sha:
        raise RuntimeError('Runner source review does not pin current source bytes')

    reviews = []
    for path in pre_paths:
        item, raw = verify_review(path, 'approve_execution', {
            'contract_sha256': CONTRACT_SHA,
            'ledger_sha256': LEDGER_SHA,
            'runner_sha256': runner_sha,
            'independent_contract_review_sha256': sha(independent_raw),
            'tc_contract_review_sha256': sha(tc_raw),
            'runner_source_review_sha256': source_review_sha,
            'raw_rules_sha256': contract['per_case_raw_evidence']['rules']['sha256'],
        })
        if item.get('reviewer', {}).get('independence') is None and 'tc' not in path.name:
            raise RuntimeError('Independent pre-gate reviewer independence not declared')
        if item.get('source_pins', {}).get('scripts/verify_ifpmic_b03_h2_runtime_full.py') != runner_sha:
            raise RuntimeError('Pre-gate does not pin current runner source')
        reviews.append((path.name, raw))
    return {
        'contract_reviews': [(independent_path.name, independent_raw), (tc_path.name, tc_raw)],
        'source_review': (source_path.name, source_review_raw),
        'pre_gate_reviews': reviews,
    }



def verify_raw_policy_sources(contract: dict, ledger: dict) -> dict:
    """Check exact source bytes before importing any raw-evidence helper."""
    policy = contract.get('per_case_raw_evidence')
    if not isinstance(policy, dict):
        raise RuntimeError('Current execution contract lacks per-case raw evidence policy')
    required = {
        'rules': 'docs/ifpmic/evidence/b03/h2-runtime-full-machine-evidence-rules-v7.json',
        'auditor': 'scripts/ifpmic_h2_raw_audit.py',
        'adapter': 'scripts/ifpmic_h2_full_raw_adapter.py',
        'artifact_checker': 'scripts/ifpmic_h2_artifacts.py',
        'recorder_checker': 'scripts/ifpmic_h2_raw_evidence.py',
        'fence_checker': 'scripts/ifpmic_h2_fences.py',
    }
    for key, relative in required.items():
        item = policy.get(key)
        path = ROOT / relative
        if (not isinstance(item, dict) or item.get('path') != relative
                or not isinstance(item.get('sha256'), str)
                or re.fullmatch('[0-9a-f]{64}', item['sha256']) is None
                or ledger['source_pins'].get(relative) != item['sha256']
                or path.is_symlink() or path.resolve() != path):
            raise RuntimeError('Raw-evidence policy/source binding differs: ' + key)
        require_file_hash(path, item['sha256'], 'Raw evidence ' + key)
    helper_paths = {
        'scripts/verify_ifpmic_g1.py', 'scripts/verify_ifpmic_g4.py',
        'scripts/verify_ifpmic_b03_h1.py', 'scripts/ifpmic_temporal_toolchain.py',
        'scripts/verify_ifpmic_b03_h2_runtime_normal.py', 'scripts/ifpmic_h2_gate_budget.py',
    }
    helpers = policy.get('runtime_helpers')
    if not isinstance(helpers, dict) or set(helpers) != helper_paths:
        raise RuntimeError('Exact pre-import runtime helper closure missing')
    for relative, expected in helpers.items():
        path = ROOT / relative
        if (not isinstance(expected, str) or re.fullmatch('[0-9a-f]{64}', expected) is None
                or ledger['source_pins'].get(relative) != expected
                or path.is_symlink() or path.resolve() != path):
            raise RuntimeError('Runtime helper/source binding differs: ' + relative)
        require_file_hash(path, expected, 'Pre-import runtime helper')
    return policy


def verify_contract_ledger(contract: dict, ledger: dict) -> list[dict]:
    counts = contract['counts']
    phases = ledger['additional_phases'] + ledger['retained_phases']
    if ([p['id'] for p in phases] != list(ORDER)
            or contract['execution_order'] != list(ORDER)
            or contract['phase_caps_seconds'] != CAPS
            or sum(CAPS.values()) != 15420
            or contract['limits']['outer_gate_seconds'] != OUTER_SECONDS
            or contract['collection_policy']['total_collection_seconds'] != 450
            or contract['collection_policy']['per_collection_seconds'] != COLLECTION_SECONDS):
        raise RuntimeError('Contract/ledger phase order or timing policy differs')
    all_ids = []
    for phase in phases:
        if phase.get('phase_timeout_seconds') != CAPS[phase['id']]:
            raise RuntimeError('Ledger phase cap differs: ' + phase['id'])
        ids = phase.get('node_ids')
        if not isinstance(ids, list) or not ids:
            raise RuntimeError('Phase does not have literal node IDs: ' + phase['id'])
        if len(ids) != len(set(ids)):
            raise RuntimeError('Duplicate literal phase ID: ' + phase['id'])
        if any('::' not in nodeid or not nodeid.startswith('tests/ifpmic_api/') for nodeid in ids):
            raise RuntimeError('Unsafe or malformed ledger node ID')
        all_ids.extend(ids)
        files = phase.get('files', [])
        if not files or any(not f.startswith('tests/ifpmic_api/') or '..' in Path(f).parts or not f.endswith('.py') for f in files):
            raise RuntimeError('Unsafe or empty phase file list')
    if len(all_ids) != counts['expected_full_union'] or len(set(all_ids)) != len(all_ids):
        raise RuntimeError('Full ledger inventory is not exactly 490 unique IDs')
    if sum(len(p['node_ids']) for p in ledger['additional_phases']) != 83:
        raise RuntimeError('New inventory is not exactly 83 IDs')
    if sum(len(p['node_ids']) for p in ledger['retained_phases']) != 407:
        raise RuntimeError('Retained inventory is not exactly 407 IDs')
    if len(ledger['obligations']) != 25:
        raise RuntimeError('Obligation group count differs from approved 25')
    budgets = [row for phase in ledger['additional_phases'] for row in phase.get('per_case_budgets', {}).values()]
    if (sum(row.get('setup_and_body') == 215 and row.get('shared_cleanup') == 25 for row in budgets) != counts['extended215_25_ids']
            or sum(row.get('setup_and_body') == 25 and row.get('shared_cleanup') == 5 for row in budgets) != counts['default25_5_ids']
            or sum(phase['id'] == 'fixture_failure' for phase in ledger['additional_phases']) != 1
            or len(next(p for p in ledger['additional_phases'] if p['id'] == 'fixture_failure')['node_ids']) != 5):
        raise RuntimeError('Extended/default watchdog inventory or five fixture prerequisites differ')
    return phases


def verify_static_anchors(contract: dict, ledger: dict) -> None:
    inputs = contract['attestation_inputs']
    if len(inputs) != 19:
        raise RuntimeError('Contract must have exactly 19 attestation anchors')
    for name, pin in inputs.items():
        require_file_hash(ROOT / pin['path'], pin['sha256'], name)
    if len(contract['binary_inputs']) != 7:
        raise RuntimeError('Contract must pin exactly seven binaries')
    for name, pin in contract['binary_inputs'].items():
        path = Path(pin['path'].replace('~', str(Path.home()), 1))
        require_file_hash(ROOT / path if not path.is_absolute() else path, pin['sha256'], name)
        if pin.get('symlink_target_sha256'):
            target = os.readlink(ROOT / pin['path'])
            if sha(target.encode()) != pin['symlink_target_sha256']:
                raise RuntimeError('Binary symlink target changed: ' + name)
    for path, expected in ledger['source_pins'].items():
        if Path(path).is_absolute() or '..' in Path(path).parts:
            raise RuntimeError('Ledger source path escapes repository: ' + path)
        p = ROOT / path
        if p.is_symlink() or not p.is_file() or ROOT not in p.resolve().parents or sha(p.read_bytes()) != expected:
            raise RuntimeError('Ledger source pin differs: ' + path)
    for path, expected in ledger['derivative_ledgers'].items():
        if Path(path).is_absolute() or '..' in Path(path).parts:
            raise RuntimeError('Derivative ledger path escapes repository')
        require_file_hash(ROOT / path, expected, 'Historical derivative ledger')
    suffixes = {'.py', '.sql', '.in', '.lock', '.mjs', '.js', '.cjs'}
    expected_closure = {path for path in ledger['source_pins']
                        if path.startswith(('services/ifpmic_api/', 'tests/ifpmic_api/'))
                        and Path(path).suffix in suffixes}
    actual_closure = {str(path.relative_to(ROOT)) for folder in ('services/ifpmic_api', 'tests/ifpmic_api')
                      for path in (ROOT/folder).rglob('*') if path.is_file() or path.is_symlink()
                      if path.suffix in suffixes
                      and '__pycache__' not in path.parts}
    if actual_closure != expected_closure:
        raise RuntimeError('Current service/test source closure differs from exact ledger inventory')
    for path, expected in contract['attestation_policy']['environment_roots'].items():
        if not (ROOT / expected).is_dir():
            raise RuntimeError('Pinned environment root unavailable: ' + path)


def verify_protected_inventory(contract: dict) -> dict:
    archive_path = ROOT / contract['attestation_inputs']['protected_AX_baseline']['path']
    with zipfile.ZipFile(archive_path) as archive:
        raw = archive.read('gate/gate.json')
    if sha(raw) != '597c3ada698cd20ff9c93a318e1177fe55e43e68844d08a6c56281cf940cb2c6':
        raise RuntimeError('Pinned B01 protected gate member hash differs')
    baseline = json.loads(raw)
    prefixes = ('src/', 'server/', 'plugins/', 'runtime/ifpmic/')
    explicit = {'package.json', 'package-lock.json', 'scripts/build-ifpmic-plugin.mjs',
                'vite.config.ts', 'tsconfig.json', 'index.html', 'ifpmic.html'}
    protected = {path: value for path, value in baseline['sourceHashes'].items()
                 if path.startswith(prefixes) or (path.startswith('tests/') and path.endswith('.mjs')) or path in explicit}
    for path, expected in protected.items():
        item = ROOT / path
        if item.is_symlink() or not item.is_file() or ROOT not in item.resolve().parents or sha(item.read_bytes()) != expected:
            raise RuntimeError('Protected source differs or uses symlink: ' + path)
    current = {str(path.relative_to(ROOT)) for folder in ('src', 'server', 'plugins', 'runtime/ifpmic')
               for path in (ROOT/folder).rglob('*') if path.is_file()}
    current.update(str(path.relative_to(ROOT)) for path in (ROOT/'tests').rglob('*.mjs') if path.is_file())
    expected_inventory = {path for path in protected if path.startswith(prefixes) or path.startswith('tests/')}
    if current != expected_inventory or len(protected) != 96 or len(current) != 89:
        raise RuntimeError('Protected96/89 exact inventory differs')
    return {'protected_hashes': len(protected), 'protected_files': len(current),
            'manifest_sha256': sha(json.dumps(protected, sort_keys=True).encode())}


def case_id(nodeid: str) -> str:
    path, test = nodeid.split('::', 1)
    return path.removesuffix('.py').replace('/', '.') + '.' + test


def safe_environment(base: Path, phase: dict, contract: dict, observations: Path,
                     lifecycle: Path, progress: Path, timings: Path) -> tuple[dict, list[str]]:
    """Build a scrubbed child environment and phase-specific watchdog roots."""
    py = base / 'bin/python'
    if not py.is_file():
        raise RuntimeError('Pinned phase interpreter missing')
    private_tmp = Path(tempfile.mkdtemp(prefix='ifpmic-full-', dir='/tmp'))
    private_tmp.chmod(0o700)
    empty = observations.parent
    for name in ('empty-pgpass', 'empty-pg-service.conf'):
        write_private(empty / name, b'')
    pg_system = empty / 'empty-pg-system'
    pg_system.mkdir(mode=0o700, exist_ok=True)
    root = observations
    env = {
        'PATH': os.pathsep.join((str(py.parent), '/usr/bin', '/bin')),
        'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
        'PYTHONPATH': str(ROOT), 'PYTHONDONTWRITEBYTECODE': '1',
        'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1', 'TMPDIR': str(private_tmp),
        'PGPASSFILE': str(empty / 'empty-pgpass'),
        'PGSERVICEFILE': str(empty / 'empty-pg-service.conf'),
        'PGSYSCONFDIR': str(pg_system),
        'IFPMIC_TEST_LIFECYCLE_PATH': str(lifecycle),
        'IFPMIC_H2_CASE_PROGRESS_PATH': str(progress),
        'IFPMIC_H2_RUNTIME_EVIDENCE_ROOT': str(root),
        'IFPMIC_H2_RUNTIME_TIMINGS_PATH': str(timings),
        'IFPMIC_H1_TOOLCHAIN_MANIFEST': str(ROOT / contract['attestation_inputs']['qualified_private_installation']['path']),
        'IFPMIC_H1_EVIDENCE_ROOT': str(root),
        'IFPMIC_H2_SCHEMA_TIMINGS_PATH': str(timings),
        'IFPMIC_H2_SCHEMA_DIAGNOSTICS_PATH': str(observations.parent / 'diagnostics.json'),
        'IFPMIC_AUTH_TEST_OBSERVATION_PATH': str(observations.parent / 'auth-observation.json'),
        'IFPMIC_JOBS_TEST_OBSERVATION_PATH': str(observations.parent / 'jobs-observation.json'),
        'IFPMIC_WORKSPACE_TEST_OBSERVATION_PATH': str(observations.parent / 'workspace-observation.json'),
    }
    watchdog_map = {
        'h2_crash_case_budget': 'IFPMIC_H2_CRASH_TIMINGS_ROOT',
        'h2_worker_api_case_budget': 'IFPMIC_H2_WORKER_API_TIMINGS_DIR',
        'h2_startup_case_budget': 'IFPMIC_H2_STARTUP_TIMINGS_ROOT',
        'h2_window_case_budget': 'IFPMIC_H2_WINDOW_TIMINGS_ROOT',
        'h2_activity_runtime_case_budget': 'IFPMIC_H2_ACTIVITY_RUNTIME_TIMINGS_ROOT',
        'h2_transport_case_budget': 'IFPMIC_H2_TRANSPORT_TIMINGS_ROOT',
        'h2_workspace_activation_case_budget': 'IFPMIC_H2_WORKSPACE_TIMINGS_ROOT',
        'h2_started_deployment_case_budget': 'IFPMIC_H2_STARTED_DEPLOYMENT_TIMINGS_ROOT',
        'h2_fixture_failure_case_budget': 'IFPMIC_H2_FIXTURE_FAILURE_TIMINGS_ROOT',
        'h2_runtime_case_budget': 'IFPMIC_H2_RUNTIME_TIMINGS_PATH',
    }
    for plugin in phase.get('pytest_plugins', []):
        suffix = plugin.rsplit('.', 1)[-1]
        key = watchdog_map.get(suffix)
        if key:
            # The retained normal runtime watchdog writes one phase-wide JSON
            # timings file; the new case watchdogs each receive their private
            # observation directory as the root for node-specific records.
            env[key] = str(timings if suffix == 'h2_runtime_case_budget' else root)
        # Plugin source is part of the ledger closure; inspect its literal
        # environment accesses before allowing the phase to run.
        plugin_path = ROOT / (plugin.replace('.', '/') + '.py')
        source = plugin_path.read_text()
        used = set(re.findall(r'os\.environ(?:\.get)?\(\s*[\'\"](IFPMIC_[A-Z0-9_]+)', source))
        unresolved = used - set(env)
        if unresolved:
            raise RuntimeError('Unmapped watchdog/plugin environment key(s): ' + ','.join(sorted(unresolved)))
    node_pin = contract['binary_inputs']['fixture_node']
    node_path = Path.home() / node_pin['path'].removeprefix('~/')
    if not node_path.is_file() or sha(node_path.read_bytes()) != node_pin['sha256']:
        raise RuntimeError('Explicit pinned Node executable is unavailable or changed')
    env['IFPMIC_NODE_EXECUTABLE'] = str(node_path)
    env['PATH'] = os.pathsep.join((str(node_path.parent), str(py.parent), '/usr/bin', '/bin'))
    return env, [str(private_tmp)]


def collect_phase(run_owned_command, phase: dict, interpreter: Path, plugins: list[str],
                  directory: Path, env: dict) -> dict:
    command = [str(interpreter), '-B', '-X', 'pycache_prefix='+str(directory/'pycache'),
               '-m', 'pytest', '--collect-only', '-q',
               '-p', 'no:cacheprovider']
    for plugin in plugins:
        command.extend(['-p', plugin])
    command.extend(phase['files'])
    started = time.monotonic()
    result = run_owned_command(command, cwd=ROOT, timeout=COLLECTION_SECONDS, env=env)
    elapsed = time.monotonic() - started
    write_private(directory / 'collect.log', result.stdout + result.stderr)
    if result.returncode:
        raise RuntimeError('Collection failed for ' + phase['id'])
    actual = [line.strip() for line in result.stdout.decode(errors='replace').splitlines()
              if '::' in line and line.strip().startswith('tests/')]
    expected = sorted(phase['node_ids'])
    if sorted(actual) != expected or len(actual) != len(set(actual)):
        raise RuntimeError('Collected IDs differ for ' + phase['id'])
    if elapsed > COLLECTION_SECONDS:
        raise RuntimeError('Collection exceeded 30 second cap')
    return {'phase': phase['id'], 'count': len(actual), 'seconds': elapsed,
            'ids_sha256': sha(('\n'.join(sorted(actual))+'\n').encode()),
            'raw_sha256': sha((directory / 'collect.log').read_bytes())}


def verify_junit(path: Path, phase: dict, normal_contract: dict) -> tuple[list, dict]:
    root = ET.fromstring(path.read_bytes())
    cases = root.findall('.//testcase')
    actual = [c.get('classname') + '.' + c.get('name') for c in cases]
    expected = sorted(case_id(n) for n in phase['node_ids'])
    counts = {
        'tests': len(cases),
        'failures': sum(c.find('failure') is not None for c in cases),
        'errors': sum(c.find('error') is not None for c in cases),
        'skipped': sum(c.find('skipped') is not None for c in cases),
    }
    if sorted(actual) != expected or len(actual) != len(set(actual)) or counts != {
            'tests': len(expected), 'failures': 0, 'errors': 0, 'skipped': 0}:
        raise RuntimeError('JUnit does not show every exact case passing: ' + phase['id'])
    exceptions = set(normal_contract['limits']['integration_exact_ids'])
    extended = {case_id(nodeid) for nodeid, row in phase.get('per_case_budgets', {}).items()
                if row.get('setup_and_body') == 215}
    for testcase in cases:
        try:
            elapsed = float(testcase.get('time', 'nan'))
        except ValueError:
            elapsed = math.nan
        identifier = testcase.get('classname') + '.' + testcase.get('name')
        cap = 240 if identifier in exceptions or identifier in extended else 30
        if not math.isfinite(elapsed) or elapsed < 0 or elapsed > cap:
            raise RuntimeError('Invalid JUnit testcase time')
    return cases, counts


def verify_progress(path: Path, phase: dict, normal_contract: dict) -> dict:
    expected = {case_id(nodeid) for nodeid in phase['node_ids']}
    exceptions = set(normal_contract['limits']['integration_exact_ids'])
    extended = {case_id(nodeid) for nodeid, row in phase.get('per_case_budgets', {}).items()
                if row.get('setup_and_body') == 215}
    defaults = {case_id(nodeid): row for nodeid, row in phase.get('per_case_budgets', {}).items()}
    states = {}
    previous = -math.inf
    for line in path.read_text().splitlines():
        event = json.loads(line)
        moment = event.get('monotonic')
        if type(moment) not in (int, float) or not math.isfinite(moment) or moment < previous:
            raise RuntimeError('Invalid or unordered progress monotonic clock')
        previous = moment
        nodeid = event.get('nodeid')
        if not isinstance(nodeid, str) or '::' not in nodeid:
            raise RuntimeError('Malformed progress node ID')
        identifier = case_id(nodeid)
        if identifier not in expected:
            raise RuntimeError('Unexpected progress case ID')
        kind = event.get('event')
        if kind == 'start':
            if identifier in states:
                raise RuntimeError('Duplicate case start progress event')
            states[identifier] = {'start': moment, 'reports': [], 'finish': None}
        elif identifier not in states or states[identifier]['finish'] is not None:
            raise RuntimeError('Progress event outside case lifecycle')
        elif kind == 'report':
            duration = event.get('duration')
            when = event.get('when')
            if (when not in ('setup', 'call', 'teardown') or event.get('outcome') != 'passed'
                    or type(duration) not in (int, float) or not math.isfinite(duration) or duration < 0):
                raise RuntimeError('Nonpassing or malformed progress report')
            if identifier in exceptions:
                cap = {'setup': 215, 'call': 240, 'teardown': 25}[when]
            elif identifier in extended:
                cap = 25 if when == 'teardown' else 215
            elif identifier in defaults:
                cap = defaults[identifier].get('shared_cleanup', 5) if when == 'teardown' else defaults[identifier].get('setup_and_body', 25)
            else:
                cap = 30
            if duration > cap:
                raise RuntimeError('Progress method timing exceeds reviewed bound')
            states[identifier]['reports'].append((when, duration))
        elif kind == 'finish':
            states[identifier]['finish'] = moment
        else:
            raise RuntimeError('Unknown case progress event')
    if set(states) != expected:
        raise RuntimeError('Progress case inventory differs')
    elapsed = []
    normalized = []
    for identifier, row in states.items():
        total = row['finish'] - row['start'] if row['finish'] is not None else math.inf
        names = [item[0] for item in row['reports']]
        cap = 240 if identifier in exceptions or identifier in extended else 30
        if names != ['setup', 'call', 'teardown'] or not 0 <= total <= cap:
            raise RuntimeError('Incomplete or over-budget whole-case progress record')
        durations = {name: duration for name, duration in row['reports']}
        if identifier in extended and (durations['setup'] + durations['call'] > 215 or durations['teardown'] > 25):
            raise RuntimeError('Extended case setup/body/cleanup limit exceeded')
        if identifier in exceptions and (durations['setup'] + durations['call'] > 215 or durations['teardown'] > 25):
            raise RuntimeError('Retained integration case body/cleanup limit exceeded')
        if identifier in defaults and (
                durations['setup'] + durations['call'] > defaults[identifier]['setup_and_body']
                or durations['teardown'] > defaults[identifier]['shared_cleanup']):
            raise RuntimeError('Per-case setup/body/cleanup limit exceeded')
        elapsed.append(total)
        normalized.append({'case_id': identifier, 'elapsed_seconds': total,
                           'setup_seconds': durations['setup'], 'call_seconds': durations['call'],
                           'teardown_seconds': durations['teardown'],
                           'body_limit_seconds': 215 if identifier in extended or identifier in exceptions else defaults.get(identifier, {}).get('setup_and_body', 25),
                           'cleanup_limit_seconds': 25 if identifier in extended or identifier in exceptions else defaults.get(identifier, {}).get('shared_cleanup', 5)})
    return {'cases': len(states), 'maximum_elapsed_seconds': max(elapsed),
            'sha256': sha(path.read_bytes()), 'normalized_cases': sorted(normalized, key=lambda row: row['case_id'])}


WATCHDOG_KINDS = {
    'h2_crash_case_budget': 'ifpmic.b03.h2.crash-case-timing.v1',
    'h2_worker_api_case_budget': 'ifpmic.b03.h2.worker-api.case-timing.v1',
    'h2_startup_case_budget': 'ifpmic.b03.h2.startup-case-timing.v1',
    'h2_window_case_budget': 'ifpmic.b03.h2.neg-window-case-timing.v1',
    'h2_activity_runtime_case_budget': 'ifpmic.b03.h2.activity-runtime-case-timing.v1',
    'h2_transport_case_budget': 'ifpmic.b03.h2.transport-case-timing.v1',
    'h2_workspace_activation_case_budget': 'ifpmic.b03.h2.workspace-case-timing.v1',
    'h2_started_deployment_case_budget': 'ifpmic.b03.h2.started-deployment.case-timing.v1',
    'h2_fixture_failure_case_budget': 'ifpmic.b03.h2.fixture-failure-case-timing.v1',
    'h2_runtime_case_budget': 'ifpmic.b03.h2.runtime.case-timing.v1',
}


def plugin_literal_map(path: Path, name: str) -> dict:
    """Read a literal plugin map without importing the pytest plugin."""
    tree = ast.parse(path.read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            value = ast.literal_eval(node.value)
            if isinstance(value, dict):
                return value
    raise RuntimeError('Watchdog source lacks expected literal map: ' + name)


def validate_watchdog_record(record: dict, nodeid: str, budget: dict, expected_kind: str) -> dict:
    if expected_kind not in WATCHDOG_KINDS.values():
        raise RuntimeError('Unknown watchdog kind')
    if record.get('kind') != expected_kind or record.get('nodeid') != nodeid:
        raise RuntimeError('Watchdog kind or exact node ID differs')
    if record.get('status', 'finished') != 'finished':
        raise RuntimeError('Watchdog did not finish normally')
    timeout_values = [record[k] for k in ('body_timeout_triggered', 'cleanup_timeout_triggered') if k in record]
    timeout_values.extend(record[k] for k in ('body_timed_out', 'cleanup_timed_out') if k in record)
    if len(timeout_values) < 2 or any(value is not False for value in timeout_values):
        raise RuntimeError('Actual case watchdog reported a timeout or lacks both timeout flags')
    start = record.get('started_monotonic', record.get('started_at'))
    cleanup = record.get('cleanup_started_monotonic', record.get('cleanup_start'))
    finish = record.get('finished_monotonic', record.get('finished'))
    if any(type(x) not in (int, float) or not math.isfinite(x) for x in (start, cleanup, finish)) or not start <= cleanup <= finish:
        raise RuntimeError('Watchdog start/cleanup/finish clocks invalid')
    body = record.get('body_seconds', record.get('body_elapsed_seconds'))
    cleanup_seconds = record.get('cleanup_seconds', record.get('cleanup_elapsed_seconds'))
    # These exact producers record the component durations and original clocks,
    # but no total field. A present invalid total must never use the fallback.
    derived_total_kinds = {
        WATCHDOG_KINDS[name] for name in (
            'h2_window_case_budget', 'h2_activity_runtime_case_budget',
            'h2_transport_case_budget', 'h2_workspace_activation_case_budget',
            'h2_fixture_failure_case_budget',
        )
    }
    total = (finish - start if 'total_seconds' not in record
             and expected_kind in derived_total_kinds else record.get('total_seconds'))
    expected_body, expected_cleanup = budget['setup_and_body'], budget['shared_cleanup']
    derived_body, derived_cleanup = cleanup - start, finish - cleanup
    if (any(type(x) not in (int, float) or not math.isfinite(x) for x in (body, cleanup_seconds, total))
            or body < 0 or cleanup_seconds < 0 or total < 0
            or body > expected_body or cleanup_seconds > expected_cleanup
            or total > expected_body + expected_cleanup
            or abs(body-derived_body) > 1e-6 or abs(cleanup_seconds-derived_cleanup) > 1e-6
            or abs(total-(finish-start)) > 1e-6):
        raise RuntimeError('Watchdog body, cleanup, or total limit/evidence failed')
    if record.get('body_budget_seconds', expected_body) != expected_body or record.get('cleanup_budget_seconds', expected_cleanup) != expected_cleanup:
        raise RuntimeError('Watchdog budget metadata differs from reviewed ledger')
    events = record.get('events')
    if events is not None:
        if not isinstance(events, list) or not events:
            raise RuntimeError('Watchdog event sequence missing')
        names, moments = [], []
        for event in events:
            name, moment = event.get('event'), event.get('monotonic')
            if not isinstance(name, str) or type(moment) not in (int, float) or not math.isfinite(moment):
                raise RuntimeError('Malformed watchdog event')
            names.append(name); moments.append(moment)
        if len(names) != len(set(names)) or moments != sorted(moments) or moments[0] < start or moments[-1] > finish:
            raise RuntimeError('Watchdog events duplicate or fall outside case epoch')
        if not any('cleanup' in name for name in names):
            raise RuntimeError('Watchdog cleanup boundary missing')
    return {'body_seconds': body, 'cleanup_seconds': cleanup_seconds,
            'elapsed_seconds': total, 'body_limit_seconds': expected_body,
            'cleanup_limit_seconds': expected_cleanup, 'timeout': False}


def verify_phase_watchdogs(phase: dict, directory: Path, observations: Path,
                           timing_path: Path, normal_contract: dict) -> list[dict]:
    plugins = [name.rsplit('.', 1)[-1] for name in phase.get('pytest_plugins', [])]
    plugin = next((name for name in plugins if name in WATCHDOG_KINDS), None)
    if plugin is None:
        if phase['id'] in ORDER[:9]:
            raise RuntimeError('New phase has no exact watchdog plugin')
        return []
    budgets = phase.get('per_case_budgets', {})
    expected_nodeids = set(budgets)
    if plugin == 'h2_runtime_case_budget':
        expected_nodeids = set(phase['node_ids'])
        exceptions = set(normal_contract['limits']['integration_exact_ids'])
        budgets = {nodeid: {'setup_and_body': 215, 'shared_cleanup': 25}
                   if case_id(nodeid) in exceptions else {'setup_and_body': 25, 'shared_cleanup': 5}
                   for nodeid in expected_nodeids}
    if not expected_nodeids or expected_nodeids != set(phase['node_ids']):
        raise RuntimeError('Watchdog budget IDs do not exactly cover phase IDs')
    if plugin == 'h2_runtime_case_budget':
        paths = {nodeid: timing_path for nodeid in expected_nodeids}
    elif plugin == 'h2_worker_api_case_budget':
        file_map = plugin_literal_map(ROOT/'tests/ifpmic_api/h2_worker_api_case_budget.py', 'CASE_FILES')
        if set(file_map) != expected_nodeids:
            raise RuntimeError('Worker watchdog literal file map differs from phase IDs')
        paths = {nodeid: observations / file_map[nodeid] for nodeid in expected_nodeids}
    else:
        paths = {nodeid: observations / (hashlib.sha256(nodeid.encode('utf-8')).hexdigest() + '.json')
                 for nodeid in expected_nodeids}
    results = []
    for nodeid in sorted(expected_nodeids):
        path = paths[nodeid]
        if not path.is_file() or path.is_symlink() or path.stat().st_nlink != 1 or (path.stat().st_mode & 0o777) != 0o600:
            raise RuntimeError('Missing or nonprivate per-case watchdog record: ' + phase['id'])
        record = read_json(path)
        result = validate_watchdog_record(record, nodeid, budgets[nodeid], WATCHDOG_KINDS[plugin])
        result.update(case_id=case_id(nodeid), record_sha256=sha(path.read_bytes()))
        results.append(result)
    return results


def process_start_ticks(pid: int) -> str | None:
    try:
        fields = (Path('/proc') / str(pid) / 'stat').read_text().rsplit(')', 1)[1].split()
        return fields[19]
    except (OSError, ValueError, IndexError):
        return None


def verify_postgres_lifecycle(path: Path, contract: dict) -> dict:
    life = read_json(path)
    expected_bins = {name: item['sha256'] for name, item in contract['binary_inputs'].items()
                     if name in ('initdb', 'pg_ctl', 'postgres')}
    if (life.get('private') is not True or life.get('stop_status') != 'stopped'
            or life.get('pid_alive') is not False
            or life.get('binary_sha256') != expected_bins):
        raise RuntimeError('PostgreSQL private identity, stopped state, or binary hashes differ')
    versions = life.get('binary_versions', {})
    if set(versions) != set(expected_bins) or any('18.1' not in value for value in versions.values()):
        raise RuntimeError('PostgreSQL binary version inventory differs')
    pid, ticks = life.get('server_pid'), life.get('server_start_ticks')
    if type(pid) is not int or pid <= 1 or not isinstance(ticks, str) or not ticks:
        raise RuntimeError('Saved current PostgreSQL identity missing')
    if process_start_ticks(pid) == ticks:
        raise RuntimeError('Current PostgreSQL PID/start-tick identity is still live')
    initial_pid, initial_ticks = life.get('initial_server_pid'), life.get('initial_server_start_ticks')
    if initial_pid is not None:
        if type(initial_pid) is not int or not isinstance(initial_ticks, str) or not initial_ticks:
            raise RuntimeError('Saved initial PostgreSQL identity malformed')
        if process_start_ticks(initial_pid) == initial_ticks:
            raise RuntimeError('Initial PostgreSQL identity remains live after phase cleanup')
    operations = life.get('lifecycle')
    if not isinstance(operations, list) or not operations:
        raise RuntimeError('PostgreSQL lifecycle operation journal missing')
    normalized = []
    for row in operations:
        operation, code, elapsed = row.get('operation'), row.get('exit_code'), row.get('duration_ms')
        if (not isinstance(operation, str) or type(code) is not int
                or type(elapsed) not in (int, float) or not math.isfinite(elapsed) or elapsed < 0):
            raise RuntimeError('Malformed PostgreSQL lifecycle operation')
        normalized.append({'operation': operation, 'exit_code': code, 'duration_ms': elapsed})
    stop_ops = [row for row in normalized if row['operation'] in ('pg_ctl_stop', 'pg_ctl_stop_immediate')]
    if not stop_ops or not any(row['exit_code'] == 0 for row in stop_ops):
        raise RuntimeError('PostgreSQL stop command lacks successful exit evidence')
    return {'binary_versions': versions, 'binary_sha256': expected_bins,
            'operations': normalized, 'stopped': True,
            'restart_observed': initial_pid != pid}


def verify_phase_postgres_evidence(phase_id: str, lifecycle: Path, contract: dict) -> dict:
    """Apply the pinned fixture reachability; absence is not invented PG proof."""
    if phase_id not in ORDER:
        raise RuntimeError('Unknown phase for PostgreSQL applicability')
    if phase_id in ('h1_python', 'fixture_failure'):
        if lifecycle.exists() or lifecycle.is_symlink():
            raise RuntimeError('Unexpected PostgreSQL record in non-PG phase')
        return {'applicable': False,
                'reason': 'Pinned phase requests no PostgreSQL fixture; owned-resource and raw audits remain mandatory'}
    if not lifecycle.is_file() or lifecycle.is_symlink():
        raise RuntimeError('PostgreSQL lifecycle record missing or nonregular: ' + phase_id)
    return {'applicable': True, 'lifecycle': verify_postgres_lifecycle(lifecycle, contract)}


def verify_interpreter(run_owned_command, interpreter: Path, prefix: Path, expected_inventory: dict,
                       expected_sha: str, directory: Path, role: str) -> dict:
    code = (
        'import sys,json,hashlib,platform,importlib.metadata;from pathlib import Path;'
        'print(json.dumps({"prefix":str(Path(sys.prefix).resolve()),'
        '"version":list(sys.version_info[:3]),"implementation":platform.python_implementation(),'
        '"interpreter_sha256":hashlib.sha256(Path(sys.executable).resolve().read_bytes()).hexdigest(),'
        '"inventory":{d.metadata["Name"].lower().replace("_","-"):d.version '
        'for d in importlib.metadata.distributions()}},sort_keys=True))'
    )
    cache = directory / (role + '-preflight-pycache')
    cache.mkdir(mode=0o700)
    result = run_owned_command([str(interpreter), '-B', '-X', 'pycache_prefix='+str(cache), '-c', code], cwd=ROOT, timeout=30,
        env={'PATH': os.pathsep.join((str(interpreter.parent), '/usr/bin', '/bin')),
             'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'})
    write_private(directory / (role + '-interpreter-preflight.log'), result.stdout + result.stderr)
    if result.returncode:
        raise RuntimeError('Pinned interpreter preflight failed: ' + role)
    if list(cache.iterdir()):
        raise RuntimeError('Interpreter preflight bytecode cache populated')
    actual = json.loads(result.stdout)
    if (actual['prefix'] != str(prefix.resolve()) or actual['implementation'] != 'CPython'
            or actual['version'][:2] != [3, 12] or actual['interpreter_sha256'] != expected_sha
            or actual['inventory'] != expected_inventory):
        raise RuntimeError('Pinned interpreter prefix/version/package inventory differs: ' + role)
    return {'version': actual['version'], 'implementation': actual['implementation'],
            'interpreter_sha256': actual['interpreter_sha256'],
            'package_count': len(actual['inventory']),
            'package_inventory_sha256': sha(json.dumps(actual['inventory'], sort_keys=True).encode())}


def collect_private_temporal_evidence(observation_roots: list[Path],
                                      h1_root: Path, runtime_root: Path) -> dict:
    hashes = {'history': set(), 'source': set(), 'environment': set(), 'build': set(), 'event_type': set()}
    counts: dict[str, list[int]] = {}
    statuses: set[str] = set()
    process_rows: dict[tuple, tuple] = {}
    outcome_types_without_identity: set[tuple] = set()
    fixture_unknown = 0
    evidence_files = 0

    def observe_process(value, role, exit_value, signal_name):
        outcome = (role, exit_value, signal_name, False, True)
        pid, ticks = value.get('pid'), value.get('start_ticks')
        if (type(pid) is int and pid > 0 and
                (type(ticks) is int and ticks > 0 or
                 type(ticks) is str and ticks.isascii() and ticks.isdecimal() and int(ticks) > 0)):
            identity = (pid, str(int(ticks)))
            previous = process_rows.get(identity)
            if previous is not None and previous != outcome:
                raise RuntimeError('Conflicting terminal observations for one private process identity')
            process_rows[identity] = outcome
            return identity
        else:
            # Summaries without identities are outcome observations, not new
            # processes. Their multiplicity must never inflate process counts.
            outcome_types_without_identity.add(outcome)
            return None

    registrations = {}
    owned_registrations = set()
    terminal_proofs = {}
    killed_events = []

    def identity_of(value):
        pid, ticks = value.get('pid'), value.get('start_ticks')
        if (type(pid) is int and pid > 0 and
                (type(ticks) is int and ticks > 0 or
                 type(ticks) is str and ticks.isascii() and ticks.isdecimal() and int(ticks) > 0)):
            return pid, str(int(ticks))
        return None

    def register(value, path):
        identity, role = identity_of(value), value.get('role')
        if identity is None or not isinstance(role, str) or not role:
            raise RuntimeError('Declared CLI registry lacks role or process identity')
        key = (path.parent, identity)
        if key in registrations and registrations[key] != role:
            raise RuntimeError('Conflicting case-local CLI role registration')
        registrations[key] = role

    def terminal(value, path, *, declared=False):
        identity, role = identity_of(value), value.get('role')
        registered = registrations.get((path.parent, identity))
        if registered is not None and role is not None and role != registered:
            raise RuntimeError('Conflicting case-local CLI terminal role')
        if declared:
            if identity is None:
                raise RuntimeError('Declared CLI terminal lacks process identity')
            if path.name == 'process-journal.jsonl' and registered is None:
                raise RuntimeError('Declared CLI journal terminal lacks case-local registration')
            if role is None:
                role = registered
            if not isinstance(role, str) or not role or registered is not None and role != registered:
                raise RuntimeError('Declared CLI terminal has unresolved or conflicting role')
        code = value.get('exit_code', value.get('returncode'))
        if type(code) is not int or code not in (0, 3, -9):
            raise RuntimeError('Unexpected child exit oracle in private process evidence')
        if value.get('absent') is not True or value.get('forced') is not False:
            raise RuntimeError('Owned child process absence/forced-cleanup proof failed')
        outcome = (role, code, 'SIGKILL' if code == -9 else None, False, True)
        observed = observe_process(value, role, code, outcome[2])
        if observed is not None:
            key = (path.parent, observed)
            if key in terminal_proofs and terminal_proofs[key] != outcome:
                raise RuntimeError('Conflicting case-local CLI terminal observations')
            terminal_proofs[key] = outcome

    def visit(value, path, context=()):
        nonlocal fixture_unknown
        if isinstance(value, dict):
            event = value.get('event')
            journal = path.name == 'process-journal.jsonl'
            if not context and path.suffix == '.json' and path.name.startswith('stopped-'):
                # _stop_saved's outer role is a boundary label, not a process
                # role. Only canonical owned metadata in this case can supply it.
                identity = identity_of(value)
                label, stopped = value.get('role'), value.get('stop')
                if (set(value) != {'role', 'pid', 'start_ticks', 'stop'}
                        or not isinstance(label, str) or not label
                        or path.name != 'stopped-' + label + '.json'
                        or identity is None or not isinstance(stopped, dict)
                        or set(stopped) != {'pid', 'start_ticks', 'returncode', 'forced', 'absent'}
                        or identity_of(stopped) != identity
                        or (path.parent, identity) not in owned_registrations):
                    raise RuntimeError('Malformed or unregistered stopped boundary envelope')
                terminal(stopped, path, declared=True)
                return
            # These exact source-shaped database observations are not CLI
            # lifecycle proofs. Their actual PG checks remain separate.
            if journal and event == 'service_stopped':
                if (set(value) != {'event', 'role', 'pid', 'start_ticks', 'absent'}
                        or value['role'] != 'postgres' or identity_of(value) is None
                        or value['absent'] is not True):
                    raise RuntimeError('Malformed PostgreSQL service observation')
                return
            if path.name == 'hung-driver-rollback.json' and context == ('pg_backend_after_kill',):
                observed = value.get('observed_monotonic')
                if (set(value) != {'backend_pid', 'role', 'absent', 'observed_monotonic'}
                        or type(value['backend_pid']) is not int or value['backend_pid'] <= 0
                        or not isinstance(value['role'], str) or not value['role']
                        or value['absent'] is not True
                        or type(observed) not in (int, float) or not math.isfinite(observed) or observed < 0):
                    raise RuntimeError('Malformed PostgreSQL backend observation')
                return
            if journal and event in ('killed', 'killed_at_production_hook'):
                expected_keys = {'event', 'pid', 'start_ticks', 'signal', 'absent'}
                expected_keys |= {'role', 'exit_code'} if event == 'killed' else {'returncode'}
                identity = identity_of(value)
                role = registrations.get((path.parent, identity))
                code = value.get('exit_code', value.get('returncode'))
                if (set(value) != expected_keys or identity is None or role is None
                        or value.get('role', role) != role or value['signal'] != 'SIGKILL'
                        or type(code) is not int or code != -9 or value['absent'] is not True):
                    raise RuntimeError('Malformed or unregistered intermediate CLI kill event')
                killed_events.append((path.parent, identity, role))
                return
            for key, item in value.items():
                normalized = key.lower()
                if normalized.endswith('_sha256') and isinstance(item, str) and re.fullmatch(r'[0-9a-f]{64}', item):
                    category = next((name for name in hashes if name in normalized), None)
                    if category:
                        hashes[category].add(item)
                if (normalized.endswith(('_count', '_total')) or normalized in ('execution_count', 'receipt_count')) and type(item) is int and item >= 0:
                    counts.setdefault(normalized, []).append(item)
                if normalized in ('status', 'phase', 'ownership_status', 'owner_state') and isinstance(item, str):
                    if item in ('QUEUED', 'OPEN', 'queued', 'open', 'unknown', 'owned', 'failed_closed', 'passed'):
                        statuses.add(item)
                if isinstance(item, (dict, list)):
                    visit(item, path, context + (key,))
            role = value.get('role')
            code = value.get('exit_code', value.get('returncode'))
            absent = value.get('absent')
            if isinstance(role, str) and (type(code) is int or absent is not None):
                if type(code) is int and code not in (0, 3, -9):
                    raise RuntimeError('Unexpected child exit oracle in private process evidence')
                if absent is False and ('ownership_status' in value or role.startswith('injected-')):
                    fixture_unknown += 1
                    return
            known_cleanup = path.name in ('process-cleanup.json', 'owned-process-cleanup.json')
            declared = (journal and event == 'stopped' or known_cleanup and
                        any(key in value for key in ('exit_code', 'returncode', 'forced', 'absent')))
            if declared:
                # Proper-role cleanup summaries without ticks remain explicitly
                # unidentified outcomes. Never invent ticks or join by PID alone.
                needs_identity = journal or not isinstance(role, str)
                terminal(value, path, declared=needs_identity)
                return
            if isinstance(role, str) and (type(code) is int or absent is not None):
                terminal(value, path)
        elif isinstance(value, list):
            for item in value:
                visit(item, path, context)

    paths = [path for root in observation_roots if root.exists()
             for path in sorted(root.rglob('*')) if path.is_file() and not path.is_symlink()]
    synthetic_paths = set()
    probe_node = ('tests/ifpmic_api/test_h2_fixture_cleanup_failures.py::'
                  'test_expired_cleanup_budget_performs_no_new_lifecycle_action')
    probe_name = 'cleanup-fallback-probe-' + sha(probe_node.encode())[:16]
    for root in observation_roots:
        if not root.exists():
            continue
        for probe in root.glob('cleanup-fallback-probe-*'):
            journal, cleanup = probe / 'process-journal.jsonl', probe / 'process-cleanup.json'
            if (probe.name != probe_name or probe.is_symlink() or not probe.is_dir()
                    or set(probe.iterdir()) != {journal, cleanup}
                    or any(p.is_symlink() or not p.is_file() for p in (journal, cleanup))):
                raise RuntimeError('Malformed synthetic cleanup probe context')
            expected_journal = [
                {'event': 'stop_requested', 'pid': 74991, 'start_ticks': 'saved-test-identity',
                 'pre_stop_exit_code': None, 'mode': 'graceful'},
                {'event': 'stopped', 'pid': 74991, 'start_ticks': 'saved-test-identity',
                 'exit_code': None, 'forced': False, 'absent': False},
            ]
            expected_cleanup = {'processes': [{'role': 'injected-owned-handle', 'pid': 74991,
                                             'returncode': None, 'forced': False, 'absent': False}]}
            rows = [json.loads(line) for line in journal.read_text().splitlines() if line.strip()]
            # Canonical JSON comparison also distinguishes bool from int.
            if (json.dumps(rows, sort_keys=True, allow_nan=False)
                    != json.dumps(expected_journal, sort_keys=True)
                    or json.dumps(read_json(cleanup), sort_keys=True, allow_nan=False)
                    != json.dumps(expected_cleanup, sort_keys=True)):
                raise RuntimeError('Malformed synthetic cleanup probe observations')
            proofs = []
            for query in paths:
                if query.parent == root / 'query-observations' and query.suffix == '.json':
                    value = read_json(query)
                    if isinstance(value, dict) and value.get('operation') == 'fixture.exhausted_cleanup':
                        proofs.append((query, value))
            if len(proofs) != 1:
                raise RuntimeError('Synthetic cleanup probe lacks unique same-phase query proof')
            query, proof = proofs[0]
            result, caller = proof.get('result'), proof.get('caller')
            observed = proof.get('observed_monotonic_ns')
            if (set(proof) != {'kind', 'operation', 'subject', 'result', 'pytest_current_test',
                              'observed_monotonic_ns', 'caller'}
                    or proof['kind'] != 'ifpmic.b03.h2.query-observation.v1'
                    or proof['subject'] != probe_node
                    or proof['pytest_current_test'] != probe_node + ' (call)'
                    or type(observed) is not int or observed <= 0
                    or re.fullmatch(str(observed) + r'-[0-9a-f]{32}\.json', query.name) is None
                    or not isinstance(caller, dict) or set(caller) != {'file', 'function', 'line'}
                    or caller['file'] != 'test_h2_fixture_cleanup_failures.py'
                    or caller['function'] != probe_node.split('::')[1]
                    or type(caller['line']) is not int or caller['line'] <= 0
                    or not isinstance(result, dict)
                    or set(result) != {'synthetic_process_probe', 'actions', 'identity_lookups',
                                      'remaining_checks', 'retained_same_object',
                                      'physical_process_absence_proven'}
                    or result['synthetic_process_probe'] is not True
                    or result['actions'] != [] or result['identity_lookups'] != []
                    or type(result['remaining_checks']) is not int or result['remaining_checks'] < 2
                    or result['retained_same_object'] is not True
                    or result['physical_process_absence_proven'] is not False):
                raise RuntimeError('Malformed synthetic cleanup probe no-action query proof')
            synthetic_paths.update((journal, cleanup))
            fixture_unknown += 2  # Two unknown observation records, zero physical processes.
    # Only declared source contexts register roles, never arbitrary JSON fields.
    # Read these small registries first so filesystem ordering cannot affect joins.
    for path in paths:
        if path in synthetic_paths:
            continue
        if path.name == 'process-journal.jsonl':
            for line in path.read_text().splitlines():
                if line.strip():
                    value = json.loads(line)
                    if value.get('event') == 'started':
                        register(value, path)
        elif (path.suffix == '.json' and
              (path.name.startswith('owned-') or path.name == 'processes.json')):
            value = read_json(path)
            if path.name == 'processes.json':
                if isinstance(value, dict) and value.get('kind') == 'ifpmic.b03.h1.processes.v1':
                    for row in value.get('processes', []):
                        register(row, path)
            elif isinstance(value, dict) and 'role' in value and 'pid' in value:
                register(value, path)
                owned_registrations.add((path.parent, identity_of(value)))
    for path in paths:
        evidence_files += 1
        if path in synthetic_paths:
            continue
        if path.suffix == '.pbseq' or 'history' in path.name.lower() and path.suffix not in ('.json', '.jsonl'):
            hashes['history'].add(sha(path.read_bytes()))
        elif path.suffix == '.json':
            visit(read_json(path), path)
        elif path.suffix == '.jsonl':
            for line in path.read_text().splitlines():
                if line.strip():
                    visit(json.loads(line), path)
    for scope, identity, role in killed_events:
        if terminal_proofs.get((scope, identity)) != (role, -9, 'SIGKILL', False, True):
            raise RuntimeError('Intermediate CLI kill lacks matching case-local authoritative cleanup')

    h1_result_path = h1_root / 'integration/result.json'
    if not h1_result_path.is_file():
        raise RuntimeError('H1 private retention result missing')
    h1_result = read_json(h1_result_path)
    retentions = [p.get('retention_seconds') for p in h1_result.get('phases', {}).values()]
    if len(retentions) != 2 or any(type(v) not in (int, float) or v <= 3600 for v in retentions):
        raise RuntimeError('H1 asserted retention evidence incomplete')

    runtime_path = runtime_root / 'runtime-normal-flow/runtime-observation.json'
    if not runtime_path.is_file():
        raise RuntimeError('Runtime private Temporal/receipt observation missing')
    runtime = read_json(runtime_path)
    if (runtime.get('status') != 'passed' or runtime.get('phase') != 'queued'
            or runtime.get('execution_count') != 1 or runtime.get('started_event_count') != 1):
        raise RuntimeError('Runtime queued execution/receipt causal observation failed')
    required_hashes = [runtime.get('raw_history_sha256'), runtime.get('owner_before_sha256'), runtime.get('owner_after_sha256')]
    if any(not isinstance(v, str) or not re.fullmatch(r'[0-9a-f]{64}', v) for v in required_hashes):
        raise RuntimeError('Runtime private causal hashes missing')
    hashes['history'].add(required_hashes[0])
    for key in ('source_sha256', 'environment_sha256', 'build_sha256'):
        value = runtime.get(key)
        if isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value):
            hashes[key.split('_')[0]].add(value)
    normal_process_rows = {
        (row['role'], row.get('exit_code'), None, row.get('forced'), row.get('absent'))
        for row in runtime.get('processes', []) if isinstance(row, dict)
    }
    if len(normal_process_rows) != 3 or {row[0] for row in normal_process_rows} != {
            'dispatcher', 'worker', 'temporal'}:
        raise RuntimeError('Actual normal runtime process inventory missing or duplicated')
    if any(row[1] != 0 or row[3] is not False or row[4] is not True for row in normal_process_rows):
        raise RuntimeError('Actual normal runtime process lifecycle failed')
    normal_identities = set()
    for row in runtime['processes']:
        identity = observe_process(row, row['role'], row['exit_code'], None)
        if identity is None:
            raise RuntimeError('Normal runtime process identity missing')
        normal_identities.add(identity)
    if len(normal_identities) != 3:
        raise RuntimeError('Normal runtime process identities missing or duplicated')
    normalized_processes = []
    grouped = {}
    for role, code, sig, forced, absent in process_rows.values():
        key = (role, code, sig, forced, absent)
        grouped[key] = grouped.get(key, 0) + 1
    for (role, code, sig, forced, absent), count in sorted(grouped.items()):
        normalized_processes.append({'role': role, 'count': count,
            'expected_exit_code': code, 'expected_signal': sig,
            'forced_cleanup': forced, 'absent': absent})
    return {
        'pinned_cli_sha256': None,
        'h1_retention_seconds': retentions,
        'h1_retention_asserted_over_3600': True,
        'runtime': {'execution_count': runtime['execution_count'],
                    'receipt_count': runtime['execution_count'],
                    'started_event_count': runtime['started_event_count'],
                    'workspace_generation': runtime.get('workspace_generation'),
                    'status': 'queued', 'raw_history_sha256': required_hashes[0],
                    'owner_snapshot_sha256': required_hashes[1:]},
        'history_hashes': sorted(hashes['history']),
        'source_hashes': sorted(hashes['source']),
        'environment_hashes': sorted(hashes['environment']),
        'build_hashes': sorted(hashes['build']),
        'event_type_hashes': sorted(hashes['event_type']),
        'owned_processes': normalized_processes,
        'owned_process_count_scope': 'distinct_saved_pid_start_ticks_with_verified_terminal_observations',
        'unidentified_terminal_observation_types': [
            {'role': role, 'expected_exit_code': code, 'expected_signal': sig,
             'forced_cleanup': forced, 'absent': absent}
            for role, code, sig, forced, absent in sorted(
                outcome_types_without_identity, key=lambda row: (row[0], row[1]))],
        'expected_fixture_unknown_records': fixture_unknown,
        'private_observation_file_count': evidence_files,
        'normalized_statuses': sorted(statuses),
        'normalized_counts': {key: sorted(values) for key, values in sorted(counts.items())},
    }


def sanitized_junit(layouts: dict) -> bytes:
    suite = ET.Element('testsuite')
    total = failures = errors = skipped = 0
    duration = 0.0
    for name in ORDER:
        phase, _directory, _obs, _cache, junit, *_rest = layouts[name]
        parsed = ET.fromstring(junit.read_bytes())
        cases = parsed.findall('.//testcase')
        for case in cases:
            ET.SubElement(suite, 'testcase', {'classname': case.get('classname', ''),
                'name': case.get('name', ''), 'time': format(float(case.get('time', '0')), '.6f')})
            duration += float(case.get('time', '0'))
        total += len(cases)
    suite.set('tests', str(total)); suite.set('failures', str(failures))
    suite.set('errors', str(errors)); suite.set('skipped', str(skipped))
    suite.set('time', format(duration, '.6f'))
    return ET.tostring(suite, encoding='utf-8', xml_declaration=True)


def build_public_proposal(leaf: Path, contract: dict, ledger: dict, report: dict,
                          layouts: dict, cases: list[dict], pg_rows: list[dict],
                          temporal: dict, source_hashes: dict[str, str],
                          env_before: dict) -> dict:
    if report.get('verdict') != 'running':
        raise RuntimeError('Public proposal may be constructed only after all checks')
    raw_summary = report.get('raw_case_evidence', {})
    if (raw_summary.get('covered_nodes') != 87 or raw_summary.get('audited_phases') != 10
            or raw_summary.get('all_indexed_raw_files_unchanged') is not True
            or raw_summary.get('rules_sha256') != contract['per_case_raw_evidence']['rules']['sha256']
            or sum(row.get('raw_case_audit', {}).get('nodes', 0) for row in report['checks']) != 87):
        raise RuntimeError('Public proposal lacks exact rechecked per-case raw evidence')
    timing_rows = [{key: row[key] for key in ('case_id', 'elapsed_seconds', 'setup_seconds',
                      'call_seconds', 'teardown_seconds', 'body_limit_seconds', 'cleanup_limit_seconds')}
                   for row in sorted(cases, key=lambda item: item['case_id'])]
    if len(timing_rows) != 490 or len({row['case_id'] for row in timing_rows}) != 490:
        raise RuntimeError('Public case timing inventory is not exactly 490')
    expected_counts = {'tests': 490, 'failures': 0, 'errors': 0, 'skipped': 0}
    phase_summary = []
    for row in report['checks']:
        if row.get('status') != 'passed' or row.get('tests') != sum(1 for phase in ledger['additional_phases']+ledger['retained_phases'] if phase['id'] == row['name'] for _ in phase['node_ids']):
            raise RuntimeError('A phase lacks an exact passing inventory for proposal')
        phase_summary.append({'phase': row['name'], 'tests': row['tests'],
                              'seconds': row['seconds'], 'cap_seconds': CAPS[row['name']]})
    summary = {
        'kind': 'ifpmic.b03.h2.runtime-full-public-summary.v1',
        'verdict': 'candidate_pass_pending_independent_final_review',
        'counts': expected_counts, 'phase_durations': phase_summary,
        'raw_case_evidence': raw_summary,
        'collection_seconds': report['collection_seconds'],
        'execution_seconds': report['execution_seconds'],
        'outer_cap_seconds': OUTER_SECONDS,
        'candidate_source_sha256': report['candidate_source_sha256'],
        'runner_sha256': report['runner_sha256'],
        'contract_sha256': report['contract_sha256'], 'ledger_sha256': report['ledger_sha256'],
        'environment_unchanged': True, 'source_unchanged': True,
        'protected_counts': report['protected_counts'],
        'limitations': ['H2 full candidate only; B03/H3-H7/original AT/full AX remain incomplete.'],
    }
    normalized_pg = [{key: row[key] for key in ('phase', 'binary_versions', 'binary_sha256', 'operations', 'stopped')}
                     for row in pg_rows]
    temporal['pinned_versions'] = {'python': 'CPython 3.12',
        'node': report['node_version'], 'postgres': '18.1',
        'temporal_cli': report['temporal_cli_version'],
        'temporal_sdk': report['temporal_sdk_version'],
        'temporal_cli_sha256': report['temporal_cli_sha256']}
    temporal['source_environment_build_hashes'] = {
        'source_manifest_sha256': sha(json.dumps(source_hashes, sort_keys=True).encode()),
        'environment_manifest_sha256': sha(json.dumps(env_before, sort_keys=True).encode()),
        'build_binary_sha256': sorted(item['sha256'] for item in contract['binary_inputs'].values()),
    }
    temporal['h1_retention_asserted'] = True
    temporal['runtime_execution_receipt'] = {'execution_count': temporal['runtime']['execution_count'],
        'receipt_count': temporal['runtime']['receipt_count'], 'status': temporal['runtime']['status']}
    if temporal.get('expected_fixture_unknown_records', 0) < 1 or 'unknown' not in temporal.get('normalized_statuses', []):
        raise RuntimeError('Expected fixture unknown ownership remains unrepresented in private evidence')
    source_manifest = {'files': [{'path': path, 'sha256': digest} for path, digest in sorted(source_hashes.items())]}
    members = {
        'gate/summary.json': (json.dumps(summary, sort_keys=True, indent=2)+'\n').encode(),
        'gate/pytest.xml': sanitized_junit(layouts),
        'gate/case-timings.json': (json.dumps(timing_rows, sort_keys=True, indent=2)+'\n').encode(),
        'gate/postgres-lifecycle.json': (json.dumps(normalized_pg, sort_keys=True, indent=2)+'\n').encode(),
        'gate/temporal-summary.json': (json.dumps(temporal, sort_keys=True, indent=2)+'\n').encode(),
        'gate/source-manifest.json': (json.dumps(source_manifest, sort_keys=True, indent=2)+'\n').encode(),
    }
    if tuple(sorted(members)) != tuple(sorted(ARCHIVE_MEMBERS)):
        raise RuntimeError('Public candidate member allowlist differs')
    expected_ids = {case_id(nodeid) for phase in ledger['additional_phases']+ledger['retained_phases'] for nodeid in phase['node_ids']}
    for name, raw in members.items():
        if name not in ARCHIVE_MEMBERS:
            raise RuntimeError('Public member outside exact allowlist')
        if name == 'gate/pytest.xml':
            validate_public_junit(raw, expected_ids)
            continue
        parsed = json.loads(raw)
        if contains_private_identity(parsed) or contains_private_material(parsed):
            raise RuntimeError('Public member contains PID/start-tick or private material')
    proposed = leaf / 'public-proposal.zip'
    with zipfile.ZipFile(proposed, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name in ARCHIVE_MEMBERS:
            info = zipfile.ZipInfo(name, date_time=(2000, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, members[name])
    proposed.chmod(0o600)
    with zipfile.ZipFile(proposed) as archive:
        if archive.namelist() != list(ARCHIVE_MEMBERS):
            raise RuntimeError('Public proposal ZIP member order/inventory differs')
        verified = {}
        for name in archive.namelist():
            info = archive.getinfo(name)
            raw = archive.read(name)
            if info.date_time != (2000, 1, 1, 0, 0, 0) or (info.external_attr >> 16) & 0o777 != 0o644 or raw != members[name]:
                raise RuntimeError('Public proposal ZIP metadata/content differs')
            verified[name] = {'bytes': len(raw), 'sha256': sha(raw)}
    proposal = {'kind': 'ifpmic.b03.h2.runtime-full-public-proposal.v1',
                'member_allowlist': verified, 'archive_sha256': sha(proposed.read_bytes()),
                'archive_bytes': proposed.stat().st_size, 'status': 'private_pending_independent_review'}
    write_private(leaf/'public-proposal.json', proposal)
    return proposal


def contains_private_identity(value) -> bool:
    if isinstance(value, dict):
        if any(key.lower() in ('pid', 'pids', 'start_ticks', 'process_id') for key in value):
            return True
        return any(contains_private_identity(item) for item in value.values())
    if isinstance(value, list):
        return any(contains_private_identity(item) for item in value)
    return False


def contains_private_material(value, key: str = '') -> bool:
    if isinstance(value, dict):
        return any(contains_private_material(item, child_key) for child_key, item in value.items())
    if isinstance(value, list):
        return any(contains_private_material(item, key) for item in value)
    if not isinstance(value, str) or key in ('case_id', 'classname', 'name'):
        return False
    absolute = [str(ROOT), str(Path.home()), '/tmp/ifpmic-', str(ROOT/'workflow-artifacts/toolchains')]
    credential = re.search(r'(?i)postgres(?:ql)?://[^\s/:]+:[^\s@]+@|-----BEGIN [A-Z ]*PRIVATE KEY-----', value)
    return bool(credential or any(prefix and prefix in value for prefix in absolute))


def validate_public_junit(raw: bytes, expected_ids: set[str]) -> None:
    root = ET.fromstring(raw)
    if root.tag != 'testsuite' or set(root.attrib) != {'tests', 'failures', 'errors', 'skipped', 'time'}:
        raise RuntimeError('Sanitized JUnit suite schema differs')
    if (root.attrib['tests'] != '490' or root.attrib['failures'] != '0'
            or root.attrib['errors'] != '0' or root.attrib['skipped'] != '0'):
        raise RuntimeError('Sanitized JUnit pass counts differ')
    actual = set()
    count = 0
    for child in root:
        if child.tag != 'testcase' or set(child.attrib) != {'classname', 'name', 'time'} or list(child):
            raise RuntimeError('Sanitized JUnit contains captured fields or output')
        actual.add(child.attrib['classname'] + '.' + child.attrib['name'])
        count += 1
    if count != 490 or len(actual) != 490 or actual != expected_ids:
        raise RuntimeError('Sanitized JUnit IDs differ from reviewed 490')


def main(*, start=None, release_bootstrap=None) -> int:
    os.umask(0o077)
    if start is None:
        start = time.monotonic()
    contract_raw = require_file_hash(CONTRACT_PATH, CONTRACT_SHA, 'Full execution contract')
    ledger_raw = require_file_hash(LEDGER_PATH, LEDGER_SHA, 'Integrated ledger')
    contract, ledger = json.loads(contract_raw), json.loads(ledger_raw)
    phases = verify_contract_ledger(contract, ledger)
    verify_static_anchors(contract, ledger)
    raw_policy = verify_raw_policy_sources(contract, ledger)
    runner_sha = verify_runner_source()
    reviews = execution_gate(contract, ledger, runner_sha)

    # Source and review gates above are complete before any local helper import.
    leaf = ROOT / 'workflow-artifacts/verification/B03/H2/runtime-full/gates' / datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S-%fZ')
    leaf.mkdir(parents=True, mode=0o700)
    parent_cache = leaf / 'parent-pycache'
    parent_cache.mkdir(mode=0o700)
    sys.dont_write_bytecode = True
    sys.pycache_prefix = str(parent_cache)
    sys.path.insert(0, str(ROOT))
    sys.path.insert(0, str(ROOT / 'scripts'))
    from ifpmic_h2_gate_budget import GateBudget
    budget = GateBudget(start + OUTER_SECONDS)
    report = {'kind': 'ifpmic.b03.h2.runtime-full-gate.v1', 'verdict': 'running',
              'contract_sha256': CONTRACT_SHA, 'ledger_sha256': LEDGER_SHA,
              'runner_sha256': runner_sha, 'phase_order': list(ORDER),
              'expected_cases': 490, 'checks': [], 'private_temporary_roots': [],
              'raw_rules_sha256': raw_policy['rules']['sha256'],
              'review_sha256': {name: sha(raw) for group in reviews.values()
                                for name, raw in (group if isinstance(group, list) else [group])}}
    try:
        if release_bootstrap is not None:
            release_bootstrap()
        budget.arm()
        from verify_ifpmic_g1 import check_unchanged_sources
        from verify_ifpmic_b03_h1 import environment_hashes
        from verify_ifpmic_g4 import enable_subreaper, run_owned_command as unbounded_command, reap_orphans, owned_children
        from ifpmic_temporal_toolchain import verify_binary, CLI_SHA
        from verify_ifpmic_b03_h2_runtime_normal import check_h1_evidence, check_runtime_evidence
        from ifpmic_h2_full_raw_adapter import validate_policy, audit_phase, recheck_manifests

        def run_owned_command(command, *, cwd, timeout, env):
            previous_threads = set(threading.enumerate())
            result = budget.run(unbounded_command, command, cwd=cwd, timeout=timeout, env=env)
            if any(thread.is_alive() for thread in set(threading.enumerate()) - previous_threads):
                raise RuntimeError('Owned command helper thread termination unconfirmed')
            return result

        raw_state = validate_policy(ROOT, contract, ledger, phases)
        review_dir = leaf / 'review-records'
        review_dir.mkdir(mode=0o700)
        for group in reviews.values():
            records = group if isinstance(group, list) else [group]
            for name, raw in records:
                write_private(review_dir / name, raw)
        if owned_children():
            raise RuntimeError('Unexpected pre-existing owned descendant')
        protected_before = check_unchanged_sources()
        protected_detail_before = verify_protected_inventory(contract)
        if (protected_before.get('protected_source_count') != 96
                or protected_before.get('protected_inventory_count') != 89
                or protected_before.get('original_imported_files') != 17
                or protected_before.get('original_uploads') != 2):
            raise RuntimeError('Exact protected96/89 and original17/2 counts differ')
        report['protected_counts'] = {
            'protected_hashes': protected_before['protected_source_count'],
            'protected_files': protected_before['protected_inventory_count'],
            'original_imported': protected_before['original_imported_files'],
            'original_uploads': protected_before['original_uploads'],
        }
        report['protected_counts']['manifest_sha256'] = protected_detail_before['manifest_sha256']
        normal_contract = read_json(ROOT / contract['attestation_inputs']['historical407_timing_contract']['path'])
        roots = {name: ROOT / path for name, path in contract['attestation_policy']['environment_roots'].items()}
        accepted_env = read_json(ROOT / contract['attestation_inputs']['accepted407_environment_inventory']['path'])
        env_before = {name: environment_hashes(path) for name, path in roots.items()}
        if env_before != accepted_env:
            raise RuntimeError('Installed environment differs from pinned accepted407 file/symlink maps')
        write_private(leaf / 'environment-before.json', env_before)
        source_before = {p: sha((ROOT/p).read_bytes()) for p in ledger['source_pins']}
        write_private(leaf / 'source-before.json', source_before)
        candidate = leaf / 'candidate-source.zip'
        with zipfile.ZipFile(candidate, 'w', zipfile.ZIP_DEFLATED) as bundle:
            for name, expected in sorted(source_before.items()):
                raw = (ROOT/name).read_bytes()
                if sha(raw) != expected:
                    raise RuntimeError('Source changed during private capture')
                bundle.writestr(name, raw)
        candidate.chmod(0o600)
        report['candidate_source_sha256'] = sha(candidate.read_bytes())

        toolchain_root = ROOT / Path(contract['attestation_inputs']['qualified_private_installation']['path']).parent
        python36 = toolchain_root / 'venv/bin/python'
        python32 = roots['original32'] / 'bin/python'
        verify_binary(toolchain_root / 'temporal', CLI_SHA)
        actual_cli = sha((toolchain_root / 'temporal').read_bytes())
        if actual_cli != contract['binary_inputs']['temporal_cli']['sha256']:
            raise RuntimeError('Temporal CLI binary hash differs')
        report['temporal_cli_sha256'] = actual_cli
        enable_subreaper()
        preflight_dir = leaf / 'preflight'
        preflight_dir.mkdir(mode=0o700)
        original_lock = ROOT / contract['attestation_inputs']['original32_lock']['path']
        original_inventory = {name.lower().replace('_', '-'): version
                              for name, version in re.findall(r'^([\w.-]+)==([^\s\\]+)', original_lock.read_text(), re.M)}
        installation_path = ROOT / contract['attestation_inputs']['qualified_private_installation']['path']
        installation = read_json(installation_path)
        report['interpreter_preflight'] = {
            'original32': verify_interpreter(run_owned_command, python32, roots['original32'],
                original_inventory, contract['binary_inputs']['original32_python']['sha256'], preflight_dir, 'original32'),
            'qualified36': verify_interpreter(run_owned_command, python36, toolchain_root/'venv',
                installation['installed'], contract['binary_inputs']['qualified36_python']['sha256'], preflight_dir, 'qualified36'),
        }
        node = Path.home() / contract['binary_inputs']['fixture_node']['path'].removeprefix('~/')
        node_result = run_owned_command([str(node), '--version'], cwd=ROOT, timeout=10,
            env={'PATH': str(node.parent), 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8'})
        write_private(preflight_dir / 'node-version.log', node_result.stdout + node_result.stderr)
        if node_result.returncode or node_result.stdout.decode().strip() != contract['binary_inputs']['fixture_node']['expected_version']:
            raise RuntimeError('Explicit pinned Node version check failed')
        report['node_version'] = contract['binary_inputs']['fixture_node']['expected_version']
        archive_name = installation.get('archive', {}).get('filename', '')
        match = re.search(r'temporal_cli_(\d+\.\d+\.\d+)', archive_name)
        if not match:
            raise RuntimeError('Pinned Temporal CLI release version missing from accepted installation record')
        report['temporal_cli_version'] = match.group(1)
        report['temporal_sdk_version'] = installation.get('installed', {}).get('temporalio')
        if report['temporal_sdk_version'] != '1.34.0':
            raise RuntimeError('Pinned Temporal SDK version differs')
        cli_version = run_owned_command([str(toolchain_root/'temporal'), '--version'], cwd=ROOT, timeout=10,
            env={'PATH': os.pathsep.join((str(toolchain_root), '/usr/bin', '/bin')),
                 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8'})
        write_private(preflight_dir/'temporal-version.log', cli_version.stdout+cli_version.stderr)
        if cli_version.returncode or report['temporal_cli_version'] not in cli_version.stdout.decode(errors='replace'):
            raise RuntimeError('Pinned Temporal CLI version check failed')
        normalized_cases = []
        normalized_pg = []
        raw_proofs = []
        temporal_evidence = {'owned_process_roles': {}, 'history_hashes': [], 'phase_evidence': {}}

        # Build isolated private phase layouts and collect all fifteen before
        # starting the first test. Collection consumes its own 450-second pool.
        layouts = {}
        collection_total = 0.0
        for phase in phases:
            directory = leaf / phase['id']
            directory.mkdir(mode=0o700)
            observations = directory / 'observations'
            observations.mkdir(mode=0o700)
            cache = directory / 'pycache'
            cache.mkdir(mode=0o700)
            junit = directory / 'pytest.xml'
            lifecycle = directory / 'postgres-lifecycle.json'
            progress = directory / 'case-progress.jsonl'
            timings = directory / 'case-timings.json'
            interpreter = python36 if phase['id'] in ORDER[:11] else python32
            env, tmp_roots = safe_environment(interpreter.parent.parent, phase, contract,
                                               observations, lifecycle, progress, timings)
            report['private_temporary_roots'].extend(tmp_roots)
            plugins = phase.get('pytest_plugins', [])
            collection = collect_phase(run_owned_command, phase, interpreter, plugins, directory, env)
            collection_total += collection['seconds']
            report['checks'].append({'name': phase['id'], 'collection': collection,
                                     'status': 'collected'})
            layouts[phase['id']] = (phase, directory, observations, cache, junit, lifecycle,
                                    progress, timings, interpreter, env, plugins)
        if collection_total > 450:
            raise RuntimeError('All-phase collection pool exceeded 450 seconds')

        execution_total = 0.0
        for name in ORDER:
            phase, directory, observations, cache, junit, lifecycle, progress, timings, interpreter, env, plugins = layouts[name]
            command = [str(interpreter), '-B', '-X', 'pycache_prefix='+str(cache),
                       '-m', 'pytest', '-vv', '-p', 'no:cacheprovider']
            for plugin in plugins:
                command.extend(['-p', plugin])
            command.extend(phase['files'])
            command.extend(['--junitxml', str(junit)])
            began = time.monotonic()
            result = run_owned_command(command, cwd=ROOT, timeout=CAPS[name], env=env)
            duration = time.monotonic() - began
            execution_total += duration
            write_private(directory / 'pytest.log', result.stdout + result.stderr)
            check = next(row for row in report['checks'] if row['name'] == name)
            check.update({'seconds': duration, 'exit_code': result.returncode,
                          'log_sha256': sha((directory/'pytest.log').read_bytes())})
            if duration > CAPS[name] or result.returncode or not junit.is_file():
                raise RuntimeError('Phase exited unsuccessfully: ' + name)
            cases, counts = verify_junit(junit, phase, normal_contract)
            check.update(counts, status='tests_passed_pending_raw_audit')
            if any(not math.isfinite(float(c.get('time', 'nan'))) or float(c.get('time')) > CAPS[name]
                   for c in cases):
                raise RuntimeError('JUnit testcase timing invalid: ' + name)
            progress_result = verify_progress(progress, phase, normal_contract)
            watchdogs = verify_phase_watchdogs(phase, directory, observations, timings, normal_contract)
            watchdog_by_id = {row['case_id']: row for row in watchdogs}
            progress_cases = {}
            for row in progress_result.pop('normalized_cases'):
                checkid = row['case_id']
                progress_cases[checkid] = row
                watched = watchdog_by_id.get(checkid)
                if watched is not None and abs(row['elapsed_seconds']-watched['elapsed_seconds']) > 0.05:
                    raise RuntimeError('Independent progress/watchdog case elapsed times diverge')
                row['watchdog'] = watched or {'timeout': False, 'source': 'independent progress plus JUnit'}
                if name != 'h2_schema_python':
                    normalized_cases.append(row)
            check['case_progress'] = progress_result
            check['watchdogs'] = watchdogs
            # Full progress, fixture causal evidence, timing plugin files and
            # PG/session shutdown are independently source-review requirements.
            # Require their private records; do not treat a parent exit as proof.
            pg_proof = verify_phase_postgres_evidence(name, lifecycle, contract)
            check['postgres_applicability'] = {key: value for key, value in pg_proof.items()
                                               if key != 'lifecycle'}
            if pg_proof['applicable']:
                normalized_pg.append({'phase': name, **pg_proof['lifecycle']})
            if name == 'h1_python':
                check['service_evidence'] = check_h1_evidence(observations,
                    [case_id(nodeid) for nodeid in phase['node_ids']])
                temporal_evidence['phase_evidence'][name] = check['service_evidence']
            elif name == 'h2_runtime_python':
                check['service_evidence'] = check_runtime_evidence(observations, timings)
                temporal_evidence['phase_evidence'][name] = check['service_evidence']
            if name == 'h2_schema_python':
                raw_timing = read_json(timings)
                timing_rows = raw_timing['cases'] if isinstance(raw_timing, dict) else raw_timing
                timing_ids = []
                for row in timing_rows:
                    nodeid = row['nodeid']
                    timing_ids.append(case_id(nodeid))
                    bounds = [row.get(k) for k in ('monotonic_body_start', 'monotonic_body_end',
                                                    'monotonic_cleanup_start', 'monotonic_cleanup_end')]
                    if (any(type(v) not in (int, float) or not math.isfinite(v) for v in bounds)
                            or bounds != sorted(bounds) or bounds[1]-bounds[0] > 25
                            or bounds[3]-bounds[2] > 5 or bounds[3]-bounds[0] > 30
                            or row.get('timeout_outcome') != 'none'
                            or row.get('body_timeout_triggered') is not False
                            or row.get('cleanup_timeout_triggered') is not False):
                        raise RuntimeError('Retained H2 schema watchdog evidence failed')
                    identifier = case_id(nodeid)
                    if identifier not in progress_cases:
                        raise RuntimeError('H2 schema timing lacks independent progress')
                    merged = progress_cases[identifier]
                    if abs(merged['elapsed_seconds']-(bounds[3]-bounds[0])) > 0.05:
                        raise RuntimeError('H2 schema progress and fixture timing differ')
                    merged['watchdog'] = {'timeout': False,
                                          'sha256': sha(json.dumps(row, sort_keys=True).encode())}
                    normalized_cases.append(merged)
                if len(timing_rows) != len(phase['node_ids']) or sorted(timing_ids) != sorted(case_id(n) for n in phase['node_ids']):
                    raise RuntimeError('Retained H2 schema timing inventory differs')
            reap_orphans()
            if owned_children():
                raise RuntimeError('Owned phase descendants remain live: ' + name)
            if list(cache.iterdir()):
                raise RuntimeError('Phase bytecode cache unexpectedly populated')
            proof = audit_phase(ROOT, phase, directory, observations, interpreter, env,
                                raw_state, run_owned_command)
            if proof is not None:
                raw_proofs.append(proof)
                check['raw_case_audit'] = {'nodes': len(proof['node_ids']),
                                          'manifest_sha256': proof['sha256'], 'seconds': proof['seconds']}
            else:
                check['raw_case_audit'] = {'nodes': 0, 'applicability': 'retained phase with existing independent oracles'}
            reap_orphans()
            if owned_children():
                raise RuntimeError('Raw auditor owned descendant remains unconfirmed: ' + name)
            check['status'] = 'passed'
        if time.monotonic() - start > OUTER_SECONDS:
            raise RuntimeError('Outer gate wall budget exceeded')

        # Preserve all original private records and audit exact environment and
        # source state after execution, including symlink maps and resolved tools.
        env_after = {name: environment_hashes(path) for name, path in roots.items()}
        if env_after != env_before:
            raise RuntimeError('Installed environment changed during execution')
        source_after = {p: sha((ROOT/p).read_bytes()) for p in ledger['source_pins']}
        if (source_after != source_before or check_unchanged_sources() != protected_before
                or verify_protected_inventory(contract) != protected_detail_before):
            raise RuntimeError('Ledger or protected source inventory changed during execution')
        verify_static_anchors(contract, ledger)
        if owned_children():
            raise RuntimeError('Owned process identity remains unconfirmed')
        if len(normalized_cases) != 490 or len({row['case_id'] for row in normalized_cases}) != 490:
            raise RuntimeError('Normalized all-case evidence is incomplete or duplicated')
        normalized_cases.sort(key=lambda row: row['case_id'])
        write_private(leaf / 'normalized-case-timings.json', normalized_cases)
        write_private(leaf / 'normalized-postgres-lifecycle.json', normalized_pg)
        obs_roots = [layouts[name][2] for name in ORDER]
        temporal_evidence = collect_private_temporal_evidence(
            obs_roots, layouts['h1_python'][2], layouts['h2_runtime_python'][2])
        temporal_evidence['pinned_cli_sha256'] = actual_cli
        temporal_evidence['phase_count'] = len(temporal_evidence['h1_retention_seconds']) + 1
        temporal_evidence['postgres_lifecycle_phases'] = len(normalized_pg)
        write_private(leaf / 'normalized-temporal-summary.json', temporal_evidence)
        verify_raw_policy_sources(contract, ledger)
        raw_summary = recheck_manifests(raw_proofs, raw_state, deadline=budget.work_deadline)
        write_private(leaf / 'raw-audit-proofs.json', raw_proofs)
        write_private(leaf / 'normalized-raw-case-summary.json', raw_summary)
        report['raw_case_evidence'] = raw_summary
        report['raw_audit_seconds'] = sum(proof['seconds'] for proof in raw_proofs)
        if report['raw_audit_seconds'] > 100 or time.monotonic() - start > OUTER_SECONDS:
            raise RuntimeError('Raw-audit or final outer gate wall budget exceeded')
        report['collection_seconds'] = collection_total
        report['execution_seconds'] = execution_total
        report['verdict'] = 'running'
        verify_runner_source(runner_sha)
        proposal = build_public_proposal(leaf, contract, ledger, report, layouts,
            normalized_cases, normalized_pg, temporal_evidence, source_before, env_before)
        budget.require_work_time()
        if list(parent_cache.iterdir()):
            raise RuntimeError('Parent bytecode cache populated')
        report['public_proposal'] = proposal
        report['acceptance_status'] = 'candidate_only_pending_independent_final_review'
        report.update({'verdict': 'pass', 'collection_seconds': collection_total,
                       'execution_seconds': execution_total, 'environment_unchanged': True,
                       'source_unchanged': True, 'owned_resources_absent': True})
    except BaseException as error:
        report.update(verdict='fail', finding=str(error) if isinstance(error, RuntimeError) else type(error).__name__)
        # This recovery can establish cleanup only; it cannot convert any case
        # or phase result into success.
        budget.begin_recovery()
        if 'owned_children' in locals() and 'reap_orphans' in locals():
            try:
                report['failure_cleanup'] = budget.cleanup(owned_children, reap_orphans)
            except BaseException as cleanup_error:
                report['failure_cleanup'] = {'result': 'unconfirmed',
                                             'error_type': type(cleanup_error).__name__}
    finally:
        budget.restore()
        if not budget.finished_in_time():
            report.update(verdict='fail', outer_deadline_exceeded=True)
        if list(parent_cache.iterdir()):
            report.update(verdict='fail', parent_bytecode_cache_populated=True)
        report['elapsed_seconds'] = time.monotonic() - start
        report['finished_utc'] = datetime.now(timezone.utc).isoformat()
        write_private(leaf / 'gate.json', report)
        if not budget.finished_in_time():
            report.update(verdict='fail', outer_deadline_exceeded=True, elapsed_seconds=time.monotonic()-start)
            write_private(leaf / 'gate.json', report)
        print('H2 runtime-full ' + report['verdict'] + ': ' + str((leaf/'gate.json').relative_to(ROOT)))
    return 0 if report['verdict'] == 'pass' else 1


def run_bootstrapped() -> int:
    # Preparation hashing/review reads are bounded before any local helper can
    # be imported. Handoff to GateBudget preserves this exact original epoch.
    start = time.monotonic()
    work_deadline = start + OUTER_SECONDS - 15
    if signal.getitimer(signal.ITIMER_REAL) != (0.0, 0.0):
        raise RuntimeError('Existing bootstrap alarm is not owned by this gate')
    previous = {number: signal.getsignal(number)
                for number in (signal.SIGALRM, signal.SIGTERM, signal.SIGINT)}

    def stop(number, frame):
        raise RuntimeError('Gate bootstrap deadline or termination request')

    def restore():
        signal.setitimer(signal.ITIMER_REAL, 0)
        for number, handler in previous.items():
            signal.signal(number, handler)

    try:
        for number in previous:
            signal.signal(number, stop)
        signal.setitimer(signal.ITIMER_REAL, max(0.000001, work_deadline-time.monotonic()))
        return main(start=start, release_bootstrap=restore)
    finally:
        restore()


if __name__ == '__main__':
    sys.exit(run_bootstrapped())
