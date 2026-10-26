"""Prepare local execution manifests in the explicitly selected qualified venv.

The owner launcher supplies a private spec file; this child receives no database
credentials, registers nothing, installs nothing and emits only a fixed summary.
"""
from importlib import metadata
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

from .execution_identity import ExecutionIdentity
from .execution_manifest import (ROOT, absolute_path, environment_manifest, file_sha,
                                 manifest_sha, private_json, source_manifest,
                                 verify_loaded_environment)
from .execution_protocol import PROTOCOL, WORKFLOW_TYPE, canonical, digest
from .request_contract import strict_json
from .workspace_fs import WorkspaceFilesystem, identity, safe_info
from scripts.ifpmic_temporal_toolchain import CLI_SHA, verify_binary


def read_toolchain_manifest(name):
    """H1 includes fractional timing metadata, unlike integer-only wire DTOs."""
    path = absolute_path(str(name))
    with WorkspaceFilesystem(str(path.parent)).open_root() as parent:
        before = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        safe_info(before, stat.S_ISREG, 0o600)
        if before.st_nlink != 1 or before.st_size > 16 * 1024 * 1024:
            raise ValueError('invalid H1 manifest')
        fd = os.open(path.name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC,
                     dir_fd=parent)
        with os.fdopen(fd, 'rb') as stream:
            opened = os.fstat(stream.fileno())
            safe_info(opened, stat.S_ISREG, 0o600)
            if identity(opened) != identity(before) or opened.st_nlink != 1:
                raise ValueError('H1 manifest changed')
            raw = stream.read(16 * 1024 * 1024 + 1)
            after = os.fstat(stream.fileno())
            current = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
            if (identity(current) != identity(opened) or
                    (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) !=
                    (after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
                raise ValueError('H1 manifest changed')
    value = strict_json(raw, limit=16 * 1024 * 1024)
    if type(value) is not dict:
        raise ValueError('invalid H1 manifest')
    return value


def write_new_private(path, value):
    """Create once; never replace a manifest or prior attempt's evidence."""
    path = absolute_path(str(path))
    with WorkspaceFilesystem(str(path.parent)).open_root() as parent:
        fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                     os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(canonical(value) + b'\n')
            stream.flush()
            os.fsync(stream.fileno())


def qualified_toolchain(manifest_path):
    value = read_toolchain_manifest(manifest_path)
    root = absolute_path(value['toolchain_root'])
    WorkspaceFilesystem(str(root)).check_root()
    python = root / 'venv/bin/python'
    contract_path = ROOT / 'docs/ifpmic/evidence/b03/h2-runtime-full-execution-contract.json'
    contract_raw = contract_path.read_bytes()
    if hashlib.sha256(contract_raw).hexdigest() != 'c10c7cb329ea82b758cfa7db34ac330e4b7ec472320b5904e8086f8067865a2d':
        raise ValueError('qualified execution contract changed')
    pin = json.loads(contract_raw)['binary_inputs']['qualified36_python']
    pinned_python = ROOT / pin['path']
    if (python != pinned_python or Path(sys.prefix) != root / 'venv' or Path(sys.executable) != python or
            sys.prefix == sys.base_prefix or
            file_sha(python) != pin['sha256'] or
            not python.is_symlink() or
            hashlib.sha256(os.readlink(python).encode()).hexdigest() != pin['symlink_target_sha256'] or
            value['cli_binary_sha256'] != CLI_SHA):
        raise ValueError('unqualified toolchain')
    expected = {}
    for line in (ROOT / 'services/ifpmic_api/requirements-temporal.lock').read_text().splitlines():
        match = re.match(r'^([A-Za-z0-9_.-]+)==([^\s\\]+)', line)
        if match:
            name = re.sub(r'[-_.]+', '-', match[1]).lower()
            if name in expected:
                raise ValueError('duplicate package')
            expected[name] = match[2]
    installed = {}
    for distribution in metadata.distributions():
        name = re.sub(r'[-_.]+', '-', distribution.metadata['Name']).lower()
        if name in installed:
            raise ValueError('duplicate installed package')
        installed[name] = distribution.version
    if len(expected) != 36 or value['installed'] != expected or installed != expected:
        raise ValueError('inventory mismatch')
    binary = verify_binary(root / 'temporal', CLI_SHA)
    return root, binary


def prepare(spec_path):
    verify_loaded_environment()
    spec = private_json(str(spec_path))
    if (type(spec) is not dict or set(spec) != {
            'format', 'toolchain_manifest_path', 'output_root', 'deployment_id', 'ports'} or
            spec['format'] != 'ifpmic.local.execution.prepare.v1'):
        raise ValueError('invalid prepare spec')
    root, binary = qualified_toolchain(spec['toolchain_manifest_path'])
    output = absolute_path(spec['output_root'])
    WorkspaceFilesystem(str(output)).check_root()
    ports = spec['ports']
    if (type(ports) is not list or len(ports) != 3 or len(set(ports)) != 3 or
            any(type(port) is not int or not 1024 <= port <= 65535 for port in ports) or
            type(spec['deployment_id']) is not str or not 1 <= len(spec['deployment_id']) <= 128):
        raise ValueError('invalid execution identity')
    source, environment = source_manifest(), environment_manifest()
    source_sha, environment_sha = manifest_sha(source), manifest_sha(environment)
    deployment = {'protocol_version': PROTOCOL, 'deployment_id': spec['deployment_id'],
                  'namespace': 'default', 'server_endpoint': f'127.0.0.1:{ports[0]}'}
    build = {'protocol_version': PROTOCOL, 'source_manifest_sha256': source_sha,
             'environment_manifest_sha256': environment_sha, 'workflow_type': WORKFLOW_TYPE}
    execution = {key: deployment[key] for key in ('deployment_id', 'namespace', 'server_endpoint')}
    execution.update(server_config_sha256=digest('ifpmic.b03.deployment.v1', deployment),
                     build_id=digest('ifpmic.b03.build.v1', build),
                     source_manifest_sha256=source_sha, environment_manifest_sha256=environment_sha)
    ExecutionIdentity(**execution).validate()
    write_new_private(output / 'source-manifest.json', source)
    write_new_private(output / 'environment-manifest.json', environment)
    write_new_private(output / 'prepared.json', {
        'format': 'ifpmic.local.execution.prepared.v1', 'identity': execution,
        'toolchain_root': str(root), 'cli_binary_path': str(binary),
        'cli_binary_sha256': CLI_SHA,
        'toolchain_manifest_sha256': file_sha(absolute_path(spec['toolchain_manifest_path']))})


def main():
    try:
        if len(sys.argv) != 1:
            raise ValueError('unexpected arguments')
        prepare(os.environ['IFPMIC_LOCAL_EXECUTION_PREPARE'])
    except Exception:
        print(json.dumps({'status': 'failed', 'code': 'LOCAL_EXECUTION_PREPARE_FAILED'}))
        return 3
    print(json.dumps({'status': 'prepared'}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
