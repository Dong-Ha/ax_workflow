"""Opt-in owner supervisor for isolated local Temporal admission execution.

This is a process-health helper, not an acceptance oracle. Registrations and
Temporal persistence survive restarts; every attempt gets new private evidence.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import socket
import subprocess
import time
from uuid import uuid4

from services.ifpmic_api.execution_identity import ExecutionIdentity
from services.ifpmic_api.execution_manifest import absolute_path, private_json
from services.ifpmic_api.execution_protocol import PROTOCOL, WORKFLOW_TYPE
from services.ifpmic_api.local_execution_prepare import read_toolchain_manifest, write_new_private
from services.ifpmic_api.workspace_fs import WorkspaceFilesystem
from scripts.ifpmic_temporal_toolchain import (CLI_SHA, owned_listeners, remember,
                                               start_server, stop_all_owned)

ROOT = Path(__file__).resolve().parents[2]


def private_dir(path):
    path.mkdir(mode=0o700, exist_ok=True)
    WorkspaceFilesystem(str(path)).check_root()
    return path


def allocate_ports():
    sockets = []
    try:
        for _ in range(3):
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sockets.append(sock)
            sock.bind(('127.0.0.1', 0))
        return [sock.getsockname()[1] for sock in sockets]
    finally:
        for sock in sockets:
            sock.close()


class LocalExecution:
    def __init__(self, state, toolchain_manifest, cluster, secrets_doc, roles,
                 database, api_config_path, *, mock_task=False):
        if type(mock_task) is not bool:
            raise ValueError('invalid mock task mode')
        self.mock_task_mode = 'request-preflight-v1' if mock_task else None
        self.state = absolute_path(str(state))
        self.root = self.state / 'execution'
        self.workspace_root = self.root / 'workspaces'
        self.toolchain_manifest = absolute_path(str(toolchain_manifest))
        self.cluster, self.secrets_doc = cluster, secrets_doc
        self.roles, self.database = dict(roles), database
        self.api_config_path = absolute_path(str(api_config_path))
        self._handles, self._children = [], {}
        self._status, self._attempt = 'not_started', None
        self.identity = None

    def _spawn(self, role, python, module, config_path, config_key, *arguments):
        cache = private_dir(self._attempt / ('pycache-' + role))
        env = {'PATH': str(Path(python).parent) + ':/usr/bin:/bin',
               'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1',
               'PYTHONUNBUFFERED': '1', 'TMPDIR': str(self._attempt),
               config_key: str(config_path)}
        descriptors = []
        try:
            for kind in ('stdout', 'stderr'):
                descriptors.append(os.open(self._attempt / (role + '-' + kind + '.log'),
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600))
            process = subprocess.Popen([str(python), '-B', '-X', 'pycache_prefix=' + str(cache),
                '-m', module, *arguments], cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                stdout=descriptors[0], stderr=descriptors[1], start_new_session=True)
            self._handles.append((role, process))  # Keep the handle before further IO.
            remember(process)
            write_new_private(self._attempt / (role + '-ownership.json'), {
                'role': role, 'pid': process.pid, 'start_ticks': process._ifpmic_start_ticks})
            return process
        finally:
            for descriptor in descriptors:
                os.close(descriptor)

    def _role_dsn(self, kind):
        from psycopg.conninfo import conninfo_to_dict, make_conninfo
        fields = conninfo_to_dict(self.cluster.dsn(self.roles[kind], self.database,
                                                  self.secrets_doc['passwords'][kind]))
        # Runtime config deliberately excludes the owner's extra libpq options.
        return make_conninfo(**{key: fields[key] for key in ('host', 'port', 'dbname', 'user', 'password')})

    def _register(self, saved):
        """Owner-only exact registration; never update/adopt partial or changed rows."""
        import psycopg
        execution = ExecutionIdentity(**self.identity)
        execution.validate()
        with psycopg.connect(self.cluster.dsn(self.roles['owner'], self.database,
                                             self.secrets_doc['passwords']['owner'])) as owner:
            owner.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',
                          ('ifpmic-local-execution:' + execution.deployment_id,))
            if owner.execute('SELECT current_user').fetchone() != (self.roles['owner'],):
                raise RuntimeError('execution registry owner mismatch')
            role_oids = dict(owner.execute('SELECT rolname,oid::bigint FROM pg_roles WHERE rolname=ANY(%s)',
                                          (list(self.roles.values()),)).fetchall())
            if set(role_oids) != set(self.roles.values()):
                raise RuntimeError('execution registry role missing')
            configured = owner.execute('SELECT migration_version,runtime_role_name,runtime_role_oid::bigint,'
                'operator_role_name,operator_role_oid::bigint,dispatcher_role_name,dispatcher_role_oid::bigint,'
                'projector_role_name,projector_role_oid::bigint FROM ifpmic.execution_role_config').fetchall()
            expected_roles = ['003_workflow_execution']
            for kind in ('runtime', 'operator', 'dispatcher', 'projector'):
                expected_roles.extend((self.roles[kind], role_oids[self.roles[kind]]))
            if configured != [tuple(expected_roles)] or (saved is not None and saved['role_oids'] != role_oids):
                raise RuntimeError('execution registry role identity changed')
            expected_deployment = (execution.deployment_id, execution.namespace, execution.server_endpoint,
                                   execution.server_config_sha256, True)
            expected_build = (execution.deployment_id, execution.build_id, execution.source_manifest_sha256,
                execution.environment_manifest_sha256, WORKFLOW_TYPE, execution.task_queue, PROTOCOL, True)
            expected_principals = sorted([
                (role_oids[self.roles['dispatcher']], self.roles['dispatcher'], 'dispatcher',
                 execution.deployment_id, None, True),
                (role_oids[self.roles['projector']], self.roles['projector'], 'projector',
                 execution.deployment_id, execution.build_id, True)], key=lambda row: row[2])

            def registry():
                return (
                    owner.execute('SELECT deployment_id,namespace,server_endpoint,server_config_sha256,enabled '
                        'FROM ifpmic.execution_deployments WHERE deployment_id=%s',
                        (execution.deployment_id,)).fetchall(),
                    owner.execute('SELECT deployment_id,build_id,source_manifest_sha256,environment_manifest_sha256,'
                        'workflow_type,task_queue,protocol_version,enabled FROM ifpmic.engine_builds '
                        'WHERE deployment_id=%s ORDER BY build_id', (execution.deployment_id,)).fetchall(),
                    owner.execute('SELECT role_oid::bigint,role_name,kind,deployment_id,build_id,active '
                        'FROM ifpmic.worker_principals WHERE deployment_id=%s OR role_oid=ANY(%s::oid[]) '
                        'OR role_name=ANY(%s) ORDER BY kind',
                        (execution.deployment_id, [role_oids[self.roles[k]] for k in ('dispatcher', 'projector')],
                         [self.roles[k] for k in ('dispatcher', 'projector')])).fetchall())

            existing = registry()
            expected = ([expected_deployment], [expected_build], expected_principals)
            expected_mock = ([(execution.deployment_id, execution.build_id, self.mock_task_mode, True)]
                             if self.mock_task_mode is not None else [])

            def mock_registry():
                return owner.execute('SELECT deployment_id,build_id,task_kind,enabled '
                    'FROM ifpmic.mock_task_builds WHERE deployment_id=%s ORDER BY build_id',
                    (execution.deployment_id,)).fetchall()

            if saved is None:
                if existing != ([], [], []) or mock_registry():
                    raise RuntimeError('execution registry exists without immutable local identity')
                owner.execute('INSERT INTO ifpmic.execution_deployments '
                    '(deployment_id,namespace,server_endpoint,server_config_sha256,enabled) VALUES(%s,%s,%s,%s,%s)',
                    expected_deployment)
                owner.execute('INSERT INTO ifpmic.engine_builds '
                    '(deployment_id,build_id,source_manifest_sha256,environment_manifest_sha256,'
                    'workflow_type,task_queue,protocol_version,enabled) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)', expected_build)
                for row in expected_principals:
                    owner.execute('INSERT INTO ifpmic.worker_principals '
                        '(role_oid,role_name,kind,deployment_id,build_id,active) VALUES(%s,%s,%s,%s,%s,%s)', row)
                if expected_mock:
                    owner.execute('INSERT INTO ifpmic.mock_task_builds '
                        '(deployment_id,build_id,task_kind,enabled) VALUES(%s,%s,%s,%s)', expected_mock[0])
                if registry() != expected:
                    raise RuntimeError('execution registry readback failed')
            elif existing != expected:
                raise RuntimeError('execution registry changed or disabled')
            if mock_registry() != expected_mock:
                raise RuntimeError('mock task build opt-in changed or disabled')
        return role_oids

    def prepare(self):
        if self._status != 'not_started':
            raise RuntimeError('execution attempt already prepared')
        self._status = 'preparing'
        private_dir(self.root)
        private_dir(self.workspace_root)
        self._attempt = private_dir(self.root / ('attempt-' + uuid4().hex))
        pin_path = self.root / 'identity.json'
        saved = private_json(str(pin_path)) if pin_path.exists() or pin_path.is_symlink() else None
        fields = {'format', 'identity', 'ports', 'toolchain_root', 'toolchain_manifest_sha256', 'role_oids'}
        if saved is not None:
            legacy = (type(saved) is dict and set(saved) == fields
                      and saved['format'] == 'ifpmic.local.execution.identity.v1'
                      and self.mock_task_mode is None)
            current = (type(saved) is dict and set(saved) == fields | {'mock_task_mode'}
                       and saved['format'] == 'ifpmic.local.execution.identity.v2'
                       and saved['mock_task_mode'] == self.mock_task_mode)
            if not (legacy or current):
                raise RuntimeError('invalid saved execution identity or changed mock task mode')
        self.ports = saved['ports'] if saved else allocate_ports()
        deployment_id = 'ifpmic.local.' + hashlib.sha256(str(self.state).encode()).hexdigest()[:32]
        # Reading metadata here selects only the explicit interpreter. Environment
        # manifests and inventory verification happen exclusively in its child.
        toolchain = read_toolchain_manifest(self.toolchain_manifest)
        toolchain_root = absolute_path(toolchain['toolchain_root'])
        self.python = toolchain_root / 'venv/bin/python'
        spec_path = self._attempt / 'prepare-spec.json'
        write_new_private(spec_path, {'format': 'ifpmic.local.execution.prepare.v1',
            'toolchain_manifest_path': str(self.toolchain_manifest), 'output_root': str(self._attempt),
            'deployment_id': deployment_id, 'ports': self.ports})
        process = self._spawn('prepare', self.python, 'services.ifpmic_api.local_execution_prepare',
                              spec_path, 'IFPMIC_LOCAL_EXECUTION_PREPARE')
        try:
            process.wait(timeout=55)
        except subprocess.TimeoutExpired:
            raise RuntimeError('execution preparation timed out') from None
        if process.returncode:
            raise RuntimeError('qualified execution preparation failed')
        prepared = private_json(str(self._attempt / 'prepared.json'))
        self.identity = prepared['identity']
        ExecutionIdentity(**self.identity).validate()
        if (prepared['format'] != 'ifpmic.local.execution.prepared.v1' or
                prepared['toolchain_root'] != str(toolchain_root) or prepared['cli_binary_sha256'] != CLI_SHA or
                prepared['cli_binary_path'] != str(toolchain_root / 'temporal')):
            raise RuntimeError('qualified execution preparation mismatch')
        identity_format = saved['format'] if saved is not None else 'ifpmic.local.execution.identity.v2'
        candidate = {'format': identity_format, 'identity': self.identity,
            'ports': self.ports, 'toolchain_root': prepared['toolchain_root'],
            'toolchain_manifest_sha256': prepared['toolchain_manifest_sha256']}
        if identity_format == 'ifpmic.local.execution.identity.v2':
            candidate['mock_task_mode'] = self.mock_task_mode
        if saved is not None and candidate != {key: value for key, value in saved.items() if key != 'role_oids'}:
            raise RuntimeError('immutable execution source, environment or toolchain changed')
        candidate['role_oids'] = self._register(saved)
        if saved is None:
            write_new_private(pin_path, candidate)
        self.binary = absolute_path(prepared['cli_binary_path'])
        for mode, kind in (('worker', 'projector'), ('dispatcher', 'dispatcher')):
            config = {
                'format': 'ifpmic.h2.runtime.v1', 'mode': mode, 'identity': self.identity,
                'dsn': self._role_dsn(kind), 'workspace_root': str(self.workspace_root),
                'source_manifest_path': str(self._attempt / 'source-manifest.json'),
                'environment_manifest_path': str(self._attempt / 'environment-manifest.json')}
            if mode == 'worker' and self.mock_task_mode is not None:
                config.update(format='ifpmic.h2.runtime.v2', mock_task_mode=self.mock_task_mode)
            write_new_private(self._attempt / (mode + '-config.json'), config)
        self._status = 'prepared'
        return self.workspace_root

    def _listeners_ready(self):
        process = self._children.get('temporal')
        if process is None or process.poll() is not None:
            return False
        listeners = owned_listeners(process)
        if any(not row['loopback'] or row['address'] != '127.0.0.1' for row in listeners):
            raise RuntimeError('unexpected Temporal listener')
        # The pinned Temporal dev server also owns internal loopback listeners.
        # H1 requires the configured ports as a subset, with every listener local.
        return set(self.ports) <= {row['port'] for row in listeners}

    def start(self):
        if self._status != 'prepared':
            raise RuntimeError('execution not prepared')
        # Refuse mismatched G5 settings before starting any execution child.
        from services.ifpmic_api.settings import load_settings
        from psycopg.conninfo import conninfo_to_dict
        settings = load_settings(str(self.api_config_path))
        if (settings.workspace_root != str(self.workspace_root) or
                conninfo_to_dict(settings.database_dsn) != conninfo_to_dict(self.cluster.dsn(
                    self.roles['runtime'], self.database, self.secrets_doc['passwords']['runtime']))):
            raise RuntimeError('workspace API configuration mismatch')
        self._status = 'starting'
        data = private_dir(self.root / 'temporal')
        process = start_server(self.binary, CLI_SHA, data, self.ports,
                               log_name=self._attempt.name + '-server.log')
        self._handles.append(('temporal', process))
        self._children['temporal'] = process
        write_new_private(self._attempt / 'temporal-ownership.json', {
            'role': 'temporal', 'pid': process.pid, 'start_ticks': process._ifpmic_start_ticks})
        deadline = time.monotonic() + 30
        while not self._listeners_ready():
            if process.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError('owned Temporal listener startup failed')
            time.sleep(0.05)
        self._children['workspace'] = self._spawn('workspace', ROOT / '.ifpmic-venv/bin/python',
            'services.ifpmic_api.workspace', self.api_config_path, 'IFPMIC_API_CONFIG', 'run')
        for mode in ('worker', 'dispatcher'):
            self._children[mode] = self._spawn(mode, self.python, 'services.ifpmic_api.execution_runtime',
                self._attempt / (mode + '-config.json'), 'IFPMIC_EXECUTION_CONFIG')
        self._status = 'supervised'
        if not self.connected():
            raise RuntimeError('execution child exited during startup')

    def connected(self):
        if self._status != 'supervised' or set(self._children) != {'temporal', 'workspace', 'worker', 'dispatcher'}:
            return False
        try:
            return all(process.poll() is None for process in self._children.values()) and self._listeners_ready()
        except Exception:
            return False

    def context(self):
        connected = self.connected()
        return {'execution_mode': 'local-temporal', 'execution_connected': connected,
                'execution_status': ('child_exited' if self._status == 'supervised' and not connected else self._status)}

    def close(self):
        if self._status == 'stopped':
            return
        if self._status == 'cleanup_failed':
            raise RuntimeError('local execution cleanup unconfirmed')
        results, errors = [], []
        deadline = time.monotonic() + 55
        for role, process in reversed(self._handles):
            try:
                result = stop_all_owned([process], total_timeout=min(18, max(1, deadline - time.monotonic())))[0]
                results.append({'role': role, **result})
                if result['forced'] or not result['absent'] or result['returncode'] not in (0, -15):
                    errors.append(role)
            except Exception:
                errors.append(role)
        self._status = 'cleanup_failed' if errors else 'stopped'
        if self._attempt is not None:
            write_new_private(self._attempt / 'cleanup.json', {'status': self._status, 'processes': results,
                                                             'errors': errors, 'persistence_preserved': True})
        if errors:
            raise RuntimeError('local execution cleanup unconfirmed')
