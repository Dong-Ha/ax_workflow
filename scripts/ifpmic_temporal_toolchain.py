"""Pinned, loopback-only Temporal qualification tooling; no application execution."""
from __future__ import annotations

import hashlib
import ipaddress
import os
from pathlib import Path
import signal
import stat
import subprocess
import time

CLI_SHA = '712217694cac9f786a72d4b6c876cd15f3dcf1bf31434d9fed6af25242a327a0'


class ToolchainError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def verify_binary(path, expected_sha256):
    path = Path(path)
    try:
        info = path.lstat()
        if not path.is_absolute() or not stat.S_ISREG(info.st_mode) or path.is_symlink():
            raise ToolchainError('ARTIFACT_INVALID')
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != expected_sha256:
            raise ToolchainError('HASH_MISMATCH')
        if (len(raw) < 64 or raw[:6] != b'\x7fELF\x02\x01' or
                int.from_bytes(raw[18:20], 'little') != 62 or not info.st_mode & 0o100):
            raise ToolchainError('ARTIFACT_INVALID')
    except (OSError, ValueError):
        raise ToolchainError('ARTIFACT_INVALID') from None
    return path


def process_identity(pid):
    try:
        raw = Path(f'/proc/{pid}/stat').read_text()
        return raw[raw.rfind(')') + 2:].split()[19]
    except (OSError, IndexError):
        return None


def remember(process):
    process._ifpmic_start_ticks = process_identity(process.pid)
    if process._ifpmic_start_ticks is None:
        process.poll()
        raise ToolchainError('PROCESS_IDENTITY_UNAVAILABLE')
    return process


def start_server(binary, expected_sha256, data_dir, ports, *, log_name='server.log'):
    binary = verify_binary(binary, expected_sha256)
    if (len(ports) != 3 or len(set(ports)) != 3 or
            any(type(p) is not int or not 1 <= p <= 65535 for p in ports) or
            Path(log_name).name != log_name or log_name in ('', '.', '..')):
        raise ToolchainError('CONFIG_INVALID')
    directory = Path(data_dir)
    if not directory.is_absolute() or directory.is_symlink():
        raise ToolchainError('CONFIG_INVALID')
    directory.mkdir(mode=0o700, exist_ok=True)
    if not directory.is_dir() or stat.S_IMODE(directory.stat().st_mode) != 0o700:
        raise ToolchainError('CONFIG_INVALID')
    env_path = directory / 'isolated-env.json'
    if env_path.exists() or env_path.is_symlink():
        if env_path.is_symlink() or env_path.read_bytes() != b'{}':
            raise ToolchainError('CONFIG_INVALID')
    else:
        descriptor = os.open(env_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(b'{}')
    env_path.chmod(0o600)
    argv = [str(binary), '--disable-config-env', '--disable-config-file', '--env-file', str(env_path),
            'server', 'start-dev', '--ip', '127.0.0.1', '--port', str(ports[0]),
            '--http-port', str(ports[1]), '--metrics-port', str(ports[2]),
            '--db-filename', str(directory / 'temporal.sqlite'), '--headless']
    descriptor = os.open(directory / log_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        process = subprocess.Popen(argv, cwd=directory, stdin=subprocess.DEVNULL,
                                   stdout=stream, stderr=subprocess.STDOUT,
                                   env={'PATH': os.defpath, 'PYTHONDONTWRITEBYTECODE': '1'},
                                   start_new_session=True)
    return remember(process)


def open_owned_pidfd(pid, start_ticks):
    """Pin the OS process before checking identity; never signal a reused PID."""
    try:
        descriptor = os.pidfd_open(pid, 0)
    except ProcessLookupError:
        return None
    if start_ticks is None or process_identity(pid) != str(start_ticks):
        os.close(descriptor)
        return None
    return descriptor


def signal_owned(process, sig):
    descriptor = open_owned_pidfd(process.pid, getattr(process, '_ifpmic_start_ticks', None))
    if descriptor is None:
        process.poll()
        return
    try:
        try:
            signal.pidfd_send_signal(descriptor, sig)
        except ProcessLookupError:
            pass
    finally:
        os.close(descriptor)


def stop_all_owned(handles, total_timeout=25):
    """Use a shared deadline, and signal only handles with the saved identity."""
    deadline = time.monotonic() + total_timeout
    active = []
    for process in handles:
        saved = getattr(process, '_ifpmic_start_ticks', None)
        if process.poll() is None:
            if saved is None or process_identity(process.pid) != saved:
                raise ToolchainError('PROCESS_IDENTITY_MISMATCH')
            signal_owned(process, signal.SIGTERM)
            active.append(process)
    grace_end = min(deadline, time.monotonic() + min(10, max(0, total_timeout - 1)))
    while any(p.poll() is None for p in active) and time.monotonic() < grace_end:
        time.sleep(min(0.05, max(0, grace_end - time.monotonic())))
    forced = set()
    for process in active:
        if process.poll() is None:
            if process_identity(process.pid) != process._ifpmic_start_ticks:
                raise ToolchainError('PROCESS_IDENTITY_MISMATCH')
            signal_owned(process, signal.SIGKILL)
            forced.add(process.pid)
    result = []
    for process in handles:
        try:
            process.wait(timeout=max(0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            raise ToolchainError('PROCESS_CLEANUP_TIMEOUT') from None
        saved = getattr(process, '_ifpmic_start_ticks', None)
        result.append({'pid': process.pid, 'start_ticks': saved, 'returncode': process.returncode,
                       'forced': process.pid in forced,
                       'absent': process_identity(process.pid) != saved})
    return result


def stop_owned(process, grace=10):
    return stop_all_owned([process], total_timeout=grace + 5)[0]


def owned_listeners(process):
    """Match socket inodes to this exact owned process rather than all host ports."""
    if process_identity(process.pid) != getattr(process, '_ifpmic_start_ticks', None):
        raise ToolchainError('PROCESS_IDENTITY_MISMATCH')
    inodes = set()
    for fd in Path(f'/proc/{process.pid}/fd').iterdir():
        try:
            target = os.readlink(fd)
            if target.startswith('socket:['):
                inodes.add(target[8:-1])
        except FileNotFoundError:
            continue
    result = []
    for family in ('tcp', 'tcp6'):
        for row in Path(f'/proc/{process.pid}/net/{family}').read_text().splitlines()[1:]:
            fields = row.split()
            if fields[3] != '0A' or fields[9] not in inodes:
                continue
            address, port = fields[1].split(':')
            raw = bytes.fromhex(address)
            raw = raw[::-1] if family == 'tcp' else b''.join(raw[i:i+4][::-1] for i in range(0, 16, 4))
            decoded = str(ipaddress.ip_address(raw))
            result.append({'address': decoded, 'port': int(port, 16),
                           'loopback': ipaddress.ip_address(decoded).is_loopback})
    return result
