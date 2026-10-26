from __future__ import annotations

import importlib
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'experiments/ifpmic-live'))
execution = importlib.import_module('execution')
prepare_module = importlib.import_module('services.ifpmic_api.local_execution_prepare')


def _private_json(path: Path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.parent.chmod(0o700)
    path.write_text(json.dumps(value), encoding='utf-8')
    path.chmod(0o600)


def test_invalid_saved_identity_fails_before_any_database_or_child_activity(tmp_path):
    state = tmp_path / 'state'
    pin = state / 'execution' / 'identity.json'
    _private_json(pin, {'format': 'ifpmic.local.execution.identity.v1', 'ports': [1]})

    class NoDatabaseCalls:
        calls = 0

        def dsn(self, *_args):
            self.calls += 1
            raise AssertionError('database must not be contacted')

    cluster = NoDatabaseCalls()
    supervisor = execution.LocalExecution(
        state, tmp_path / 'missing-h1.json', cluster, {'passwords': {}}, {},
        'ifpmic', tmp_path / 'api-config.json')

    with pytest.raises(RuntimeError, match='invalid saved execution identity'):
        supervisor.prepare()

    assert cluster.calls == 0
    assert supervisor._handles == []
    assert pin.exists()


def test_h1_metadata_preserves_fractional_timing_value(tmp_path):
    tmp_path.chmod(0o700)
    manifest = tmp_path / 'h1.json'
    _private_json(manifest, {'format': 'ifpmic.h1.toolchain.v1', 'toolchain_root': '/tmp/toolchain',
                             'elapsed_seconds': 1.625})

    value = prepare_module.read_toolchain_manifest(str(manifest))

    assert value['elapsed_seconds'] == 1.625
    assert type(value['elapsed_seconds']) is float


@pytest.mark.parametrize('ports', ([1023, 2000, 2001], [2000, 2000, 2001], [2000, 2001, 65536]))
def test_runtime_prepare_spec_rejects_ports_outside_unique_range(tmp_path, monkeypatch, ports):
    output = tmp_path / 'attempt'
    output.mkdir(mode=0o700)
    spec = {'format': 'ifpmic.local.execution.prepare.v1',
            'toolchain_manifest_path': '/unused/manifest.json', 'output_root': str(output),
            'deployment_id': 'ifpmic.local.test', 'ports': list(ports)}
    monkeypatch.setattr(prepare_module, 'verify_loaded_environment', lambda: None)
    monkeypatch.setattr(prepare_module, 'private_json', lambda _path: spec)
    monkeypatch.setattr(prepare_module, 'qualified_toolchain',
                        lambda _path: (tmp_path, tmp_path / 'temporal'))

    with pytest.raises(ValueError, match='invalid execution identity'):
        prepare_module.prepare(tmp_path / 'ignored-spec.json')


def test_role_dsn_discards_owner_only_libpq_options(monkeypatch):
    conninfo = importlib.import_module('psycopg.conninfo')
    monkeypatch.setattr(conninfo, 'conninfo_to_dict', lambda _value: {
        'host': '127.0.0.1', 'port': '55432', 'dbname': 'ifpmic', 'user': 'runtime',
        'password': 'test-password', 'sslmode': 'verify-full', 'options': '-c role=owner',
    })
    monkeypatch.setattr(conninfo, 'make_conninfo', lambda **fields: fields)
    supervisor = execution.LocalExecution(
        '/tmp/state', '/tmp/toolchain.json', SimpleNamespace(dsn=lambda *_args: 'dsn'),
        {'passwords': {'runtime': 'test-password'}}, {'runtime': 'runtime'}, 'ifpmic',
        '/tmp/api-config.json')

    assert supervisor._role_dsn('runtime') == {
        'host': '127.0.0.1', 'port': '55432', 'dbname': 'ifpmic', 'user': 'runtime',
        'password': 'test-password'}


def test_spawn_environment_has_no_inherited_postgres_variables(tmp_path, monkeypatch):
    attempt = tmp_path / 'attempt'
    attempt.mkdir(mode=0o700)
    supervisor = execution.LocalExecution(
        tmp_path, tmp_path / 'toolchain.json', SimpleNamespace(), {}, {}, 'ifpmic',
        tmp_path / 'api-config.json')
    supervisor._attempt = attempt
    captured = {}
    fake_process = SimpleNamespace(pid=12345)

    def fake_popen(_args, **kwargs):
        captured.update(kwargs)
        return fake_process

    monkeypatch.setattr(execution.subprocess, 'Popen', fake_popen)
    monkeypatch.setattr(execution, 'remember', lambda process: setattr(process, '_ifpmic_start_ticks', 'tick') or process)
    monkeypatch.setattr(execution, 'write_new_private', lambda *_args: None)

    supervisor._spawn('worker', '/qualified/venv/bin/python', 'module',
                      tmp_path / 'config.json', 'IFPMIC_EXECUTION_CONFIG')

    assert not any(key.startswith('PG') for key in captured['env'])
    assert captured['env']['IFPMIC_EXECUTION_CONFIG'] == str(tmp_path / 'config.json')
    assert captured['stdin'] is execution.subprocess.DEVNULL


def test_connected_context_is_process_health_not_a_receipt(monkeypatch):
    class Alive:
        def poll(self):
            return None

    supervisor = execution.LocalExecution(
        '/tmp/state', '/tmp/toolchain.json', SimpleNamespace(), {}, {}, 'ifpmic',
        '/tmp/api-config.json')
    supervisor._status = 'supervised'
    supervisor._children = {role: Alive() for role in ('temporal', 'workspace', 'worker', 'dispatcher')}
    monkeypatch.setattr(supervisor, '_listeners_ready', lambda: True)

    context = supervisor.context()

    assert context['execution_connected'] is True
    assert 'admission_status' not in context
    assert 'receipt' not in context
    assert 'job_status' not in context


def test_listener_probe_requires_configured_ports_but_accepts_extra_owned_loopback(monkeypatch):
    class Alive:
        def poll(self):
            return None

    supervisor = execution.LocalExecution(
        '/tmp/state', '/tmp/toolchain.json', SimpleNamespace(), {}, {}, 'ifpmic',
        '/tmp/api-config.json')
    supervisor.ports = [21001, 21002, 21003]
    supervisor._children = {'temporal': Alive()}
    listeners = [
        {'port': 21001, 'address': '127.0.0.1', 'loopback': True},
        {'port': 21002, 'address': '127.0.0.1', 'loopback': True},
        {'port': 21003, 'address': '127.0.0.1', 'loopback': True},
        {'port': 22001, 'address': '127.0.0.1', 'loopback': True},
        {'port': 22002, 'address': '127.0.0.1', 'loopback': True},
        {'port': 22003, 'address': '127.0.0.1', 'loopback': True},
    ]
    monkeypatch.setattr(execution, 'owned_listeners', lambda _process: listeners)

    assert supervisor._listeners_ready() is True

    listeners.pop(2)
    assert supervisor._listeners_ready() is False
    listeners.append({'port': 21003, 'address': '192.0.2.10', 'loopback': False})
    with pytest.raises(RuntimeError, match='unexpected Temporal listener'):
        supervisor._listeners_ready()
    listeners[-1] = {'port': 21003, 'address': '127.0.0.2', 'loopback': True}
    with pytest.raises(RuntimeError, match='unexpected Temporal listener'):
        supervisor._listeners_ready()


def test_cleanup_runs_in_reverse_and_reports_forced_stop(tmp_path, monkeypatch):
    supervisor = execution.LocalExecution(
        tmp_path, tmp_path / 'toolchain.json', SimpleNamespace(), {}, {}, 'ifpmic',
        tmp_path / 'api-config.json')
    supervisor._status = 'supervised'
    supervisor._attempt = tmp_path
    supervisor._handles = [('first', object()), ('second', object())]
    stopped, writes = [], []

    def stop(handles, total_timeout):
        process = handles[0]
        role = next(name for name, candidate in supervisor._handles if candidate is process)
        stopped.append(role)
        return [{'forced': role == 'second', 'absent': True, 'returncode': 0}]

    monkeypatch.setattr(execution, 'stop_all_owned', stop)
    monkeypatch.setattr(execution, 'write_new_private', lambda path, value: writes.append((path, value)))

    with pytest.raises(RuntimeError, match='cleanup unconfirmed'):
        supervisor.close()

    assert stopped == ['second', 'first']
    assert supervisor._status == 'cleanup_failed'
    assert writes[0][1]['status'] == 'cleanup_failed'
    assert writes[0][1]['errors'] == ['second']
