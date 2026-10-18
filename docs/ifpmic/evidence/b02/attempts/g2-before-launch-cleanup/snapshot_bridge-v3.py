"""Bounded private Node reader; never log child bytes or re-canonicalize B01."""
from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass
from hashlib import sha256
import json
import re
from pathlib import Path

PROTOCOL = "ifpmic.snapshot-bridge.v1"
RECORD_LIMIT = 2 * 1024 * 1024
STDIN_LIMIT = 6 * 1024 * 1024 + 4096
STDOUT_LIMIT = 3 * 1024 * 1024
STDERR_LIMIT = 4096
SCRIPT_PATH = Path(__file__).with_suffix(".mjs").resolve()
WORKFLOW = {
    "workflow_id": "ifpmic-sw-v1", "schema_version": "1.0.0",
    "source_sha256": "bab40a7abb3929896add1ef2cd074893dd2a7de14d200a5d6cea4b7a77eb0e89",
    "state_source_sha256": "0248e130017043539319c56af854f5388a95d33e7e687902a3438fdff414244a",
    "agent_source_sha256": "ca6d4bea7abf0fffe7354c482af0d521c3a2e367217a69923a4bfe43fa27ab64",
    "bundle_sha256": "83146f468cc425fc5851e179a24781ed4ca62babb5d219b2a95f153d8a0bf873",
}
CHILD_ERRORS = frozenset({"STORE_INVALID", "STORE_IO", "SNAPSHOT_CORRUPT", "CONTRACT_MISMATCH",
                          "PROFILE_VERSION_INVALID", "PROFILE_INVALID", "BRIDGE_INVALID_REQUEST"})


class BridgeError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _identity(value, *, scalar=False):
    return (isinstance(value, str) and bool(value) and
            not any(ord(c) < 32 or ord(c) == 127 or (scalar and 0xD800 <= ord(c) <= 0xDFFF) for c in value))


def _hex(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) is not None


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


def _json(raw):
    def invalid(_):
        raise ValueError()
    return json.loads(raw, object_pairs_hook=_object, parse_constant=invalid)


def _complete(profile):
    markers = ('CONFIGURE', 'APPROVED_BEDROCK_PROFILE', 'PIN_AFTER_COMPATIBILITY_TEST', 'INTERNAL_EXISTING_RULES')
    def resolved(value):
        if isinstance(value, str):
            return not any(marker in value for marker in markers)
        if isinstance(value, list):
            return bool(value) and all(resolved(item) for item in value)
        if isinstance(value, dict):
            return all(resolved(item) for item in value.values())
        return True
    return all(resolved(profile[name]) for name in ('source', 'runtimes', 'build', 'quality', 'device', 'release'))


@dataclass(frozen=True, repr=False)
class SnapshotRecord:
    project_id: str
    profile_version_json: str
    version_key: str
    snapshot_id: str
    record_bytes: bytes
    record_bytes_sha256: str
    mode: str
    enabled: bool
    configuration_complete: bool

    @property
    def profile_version(self):
        return json.loads(self.profile_version_json)

    @property
    def workflow_id(self):
        return WORKFLOW['workflow_id']

    @property
    def workflow(self):
        return dict(WORKFLOW)


def decode_frame(stdout: bytes, *, project_id: str, profile_version: str) -> SnapshotRecord:
    """Validate wire/hash/identity; cryptographic B01 semantics belong to Node."""
    if not _identity(project_id, scalar=True) or not _identity(profile_version):
        raise BridgeError('BRIDGE_INVALID_REQUEST')
    if len(stdout) > STDOUT_LIMIT:
        raise BridgeError('BRIDGE_OUTPUT_LIMIT')
    try:
        if not stdout.endswith(b'\n') or stdout.count(b'\n') != 1 or b'\r' in stdout:
            raise ValueError()
        frame = _json(stdout.decode('utf-8'))
        if not isinstance(frame, dict) or set(frame) != {'protocol', 'record_base64', 'record_bytes_sha256', 'version_key'}:
            raise ValueError()
        if frame['protocol'] != PROTOCOL or not _hex(frame['record_bytes_sha256']) or not _hex(frame['version_key']):
            raise ValueError()
        if not isinstance(frame['record_base64'], str):
            raise ValueError()
        raw = base64.b64decode(frame['record_base64'], validate=True)
        if base64.b64encode(raw).decode('ascii') != frame['record_base64'] or not 1 <= len(raw) <= RECORD_LIMIT:
            raise ValueError()
        if sha256(raw).hexdigest() != frame['record_bytes_sha256'] or not raw.endswith(b'\n') or raw.count(b'\n') != 1:
            raise ValueError()
        record = _json(raw.decode('utf-8'))
        if not isinstance(record, dict) or set(record) != {'snapshot_id', 'payload'} or not _hex(record['snapshot_id']):
            raise ValueError()
        payload = record['payload']
        if not isinstance(payload, dict) or set(payload) != {'format', 'canonicalization', 'project_id', 'profile_version', 'workflow', 'profile_sha256', 'profile'}:
            raise ValueError()
        if (payload['format'] != 'ifpmic.profile-snapshot.v1' or payload['canonicalization'] != 'ifpmic-json-v1' or
                payload['project_id'] != project_id or payload['profile_version'] != profile_version or
                payload['workflow'] != WORKFLOW or not _hex(payload['profile_sha256'])):
            raise ValueError()
        profile = payload['profile']
        if (not isinstance(profile, dict) or profile.get('project_id') != project_id or
                profile.get('mode') not in ('mock', 'real') or type(profile.get('enabled')) is not bool):
            raise ValueError()
        complete = _complete(profile)
        return SnapshotRecord(project_id, json.dumps(profile_version, ensure_ascii=True), frame['version_key'],
                              record['snapshot_id'], raw, frame['record_bytes_sha256'], profile['mode'], profile['enabled'], complete)
    except Exception:
        raise BridgeError('BRIDGE_PROTOCOL') from None


class SnapshotBridge:
    def __init__(self, node_executable, store_root, *, script_path=SCRIPT_PATH, timeout=10, max_active=4, max_queued=16):
        if (type(max_active) is not int or not 1 <= max_active <= 4 or type(max_queued) is not int or
                not 0 <= max_queued <= 16 or isinstance(timeout, bool) or not 0 < timeout <= 10):
            raise BridgeError('BRIDGE_INVALID_REQUEST')
        self.node_executable = str(Path(node_executable).resolve())
        self.store_root = str(Path(store_root).resolve())
        self.script_path = str(Path(script_path).resolve())
        self.timeout = timeout
        self._slots = asyncio.Semaphore(max_active)
        self._capacity = max_active + max_queued
        self._pending = 0

    async def read_snapshot(self, project_id, profile_version):
        if not _identity(project_id, scalar=True) or not _identity(profile_version):
            raise BridgeError('BRIDGE_INVALID_REQUEST')
        request = (json.dumps({'protocol': PROTOCOL, 'operation': 'read_snapshot', 'project_id': project_id,
                               'profile_version': profile_version}, ensure_ascii=True, separators=(',', ':')) + '\n').encode('ascii')
        if len(request) > STDIN_LIMIT:
            raise BridgeError('BRIDGE_INVALID_REQUEST')
        if self._pending >= self._capacity:
            raise BridgeError('BRIDGE_BUSY')
        self._pending += 1
        try:
            async with self._slots:
                return await self._run(request, project_id, profile_version)
        finally:
            self._pending -= 1

    async def _run(self, request, project_id, profile_version):
        child = None
        spawn = None
        tasks = []
        async def read(stream, limit):
            chunks = []; count = 0
            while True:
                chunk = await stream.read(min(65536, limit + 1 - count))
                if not chunk:
                    return b''.join(chunks)
                count += len(chunk)
                if count > limit:
                    raise BridgeError('BRIDGE_OUTPUT_LIMIT')
                chunks.append(chunk)
        try:
            async with asyncio.timeout(self.timeout):
                # Keep the launch task alive until it exposes the process handle.
                # A cancellation at this await must not orphan a successfully
                # spawned child before assignment to `child`.
                spawn = asyncio.create_task(asyncio.create_subprocess_exec(
                    self.node_executable, self.script_path, self.store_root,
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, cwd=str(SCRIPT_PATH.parent)))
                child = await asyncio.shield(spawn)
                async def write():
                    try:
                        child.stdin.write(request)
                        await child.stdin.drain()
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    finally:
                        child.stdin.close()
                tasks = [asyncio.create_task(write()), asyncio.create_task(read(child.stdout, STDOUT_LIMIT)),
                         asyncio.create_task(read(child.stderr, STDERR_LIMIT)), asyncio.create_task(child.wait())]
                _, stdout, _, exit_code = await asyncio.gather(*tasks)
                if exit_code:
                    try:
                        error = _json(stdout.decode('utf-8'))
                        if (isinstance(error, dict) and set(error) == {'error'} and isinstance(error['error'], dict) and
                                set(error['error']) == {'code'} and error['error']['code'] in CHILD_ERRORS):
                            raise BridgeError(error['error']['code'])
                    except BridgeError:
                        raise
                    except Exception:
                        pass
                    raise BridgeError('BRIDGE_UNAVAILABLE')
                return decode_frame(stdout, project_id=project_id, profile_version=profile_version)
        except TimeoutError:
            raise BridgeError('BRIDGE_TIMEOUT') from None
        except (BridgeError, asyncio.CancelledError):
            raise
        except Exception:
            raise BridgeError('BRIDGE_UNAVAILABLE') from None
        finally:
            async def cleanup():
                nonlocal child
                if child is None and spawn is not None:
                    # Abort a launch still waiting for pipe setup. CPython's
                    # subprocess transport closes/kills and waits on cancellation.
                    # Retaining the task also recovers a handle returned in the
                    # cancellation race, which is then killed/reaped below.
                    if not spawn.done():
                        spawn.cancel()
                    try:
                        child = await spawn
                    except (Exception, asyncio.CancelledError):
                        pass
                for task in tasks:
                    if not task.done():
                        task.cancel()
                if child is not None:
                    if child.returncode is None:
                        try:
                            child.kill()
                        except ProcessLookupError:
                            pass
                    await child.wait()
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)
            # Keep ownership through repeated cancellation, including during
            # launch cleanup or wait/reap. Never release a slot before cleanup.
            cleanup_task = asyncio.create_task(cleanup())
            cancelled = False
            while True:
                try:
                    await asyncio.shield(cleanup_task)
                    break
                except asyncio.CancelledError:
                    cancelled = True
                except Exception:
                    raise BridgeError('BRIDGE_UNAVAILABLE') from None
            if cancelled:
                raise asyncio.CancelledError()
