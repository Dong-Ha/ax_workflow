"""G5 request-scoped workspace tests on the real G4 PostgreSQL fixture."""

from __future__ import annotations

pytest_plugins = ("tests.ifpmic_api.jobs_fixture", "tests.ifpmic_api.workspace_fixture")

import errno
import hashlib
import json
import os
import signal
import stat
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import timedelta
from pathlib import Path
from uuid import UUID

import psycopg
import pytest

from services.ifpmic_api.settings import SettingsError
from services.ifpmic_api.workspace import WorkspaceService
from services.ifpmic_api.workspace_fs import WorkspaceError, WorkspaceFilesystem

WORKSPACE_CHILD_NAMES = ("source", "tc", "artifacts", "build")
WORKSPACE_MARKER_NAME = ".ifpmic-workspace.json"


def _jobs_fixture():
    from tests.ifpmic_api import jobs_fixture
    return jobs_fixture


def _workspace_fixture():
    from tests.ifpmic_api import workspace_fixture
    return workspace_fixture


def capture_snapshot(*args, **kwargs): return _jobs_fixture().capture_snapshot(*args, **kwargs)
def client_with(*args, **kwargs): return _jobs_fixture().client_with(*args, **kwargs)
def login(*args, **kwargs): return _jobs_fixture().login(*args, **kwargs)
def owner_dsn(*args, **kwargs): return _jobs_fixture().owner_dsn(*args, **kwargs)
def runtime_dsn(*args, **kwargs): return _jobs_fixture().runtime_dsn(*args, **kwargs)
def seed_catalog_and_eligibility(*args, **kwargs): return _jobs_fixture().seed_catalog_and_eligibility(*args, **kwargs)
def seed_membership(*args, **kwargs): return _jobs_fixture().seed_membership(*args, **kwargs)
def seed_profile_store(*args, **kwargs): return _jobs_fixture().seed_profile_store(*args, **kwargs)
def valid_create_job(*args, **kwargs): return _jobs_fixture().valid_create_job(*args, **kwargs)
def write_headers(*args, **kwargs): return _jobs_fixture().write_headers(*args, **kwargs)
def accept_workspace_job(*args, **kwargs): return _workspace_fixture().accept_workspace_job(*args, **kwargs)
def expected_marker_bytes(*args, **kwargs): return _workspace_fixture().expected_marker_bytes(*args, **kwargs)
def tree_fingerprint(*args, **kwargs): return _workspace_fixture().tree_fingerprint(*args, **kwargs)
def workspace_rows(*args, **kwargs): return _workspace_fixture().workspace_rows(*args, **kwargs)
def write_workspace_settings(*args, **kwargs): return _workspace_fixture().write_workspace_settings(*args, **kwargs)


_OBSERVED_CASES = {}
_ADDITIONAL_CASES = {}
_PROCESS_RECORDS = []
_PROCESS_IDENTITIES = {}
_PRIVATE_CANARY = "workspace-private-canary-do-not-publish"
_CLI_ONCE_EXIT = None


def _mark(case):
    _OBSERVED_CASES[case] = True


def _mark_additional(case):
    _ADDITIONAL_CASES[case] = True


def _capture_process_identity(pid):
    """Capture Linux PID/starttime immediately after spawn to disambiguate reuse."""
    deadline = time.monotonic() + 1.0
    while time.monotonic() < deadline:
        try:
            raw = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
            remainder = raw[raw.rfind(")") + 2:].split()
            start_ticks = remainder[19]  # /proc stat field 22; remainder begins at field 3.
            if start_ticks.isdigit():
                return {"pid": pid, "start_ticks": start_ticks}
        except (FileNotFoundError, IndexError):
            if not Path(f"/proc/{pid}").exists():
                break
        time.sleep(0.002)
    raise AssertionError("spawned process identity unavailable")


def _spawn_process(*args, **kwargs):
    process = subprocess.Popen(*args, **kwargs)
    _PROCESS_IDENTITIES[process.pid] = _capture_process_identity(process.pid)
    return process


def _record_process(role, pid, returncode, stdout, stderr, expected_exit, tmp_path):
    assert returncode == expected_exit
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        alive = False
    else:
        alive = True
    assert not alive
    identity = _PROCESS_IDENTITIES.pop(pid)
    assert identity["pid"] == pid and identity["start_ticks"].isdigit()
    assert _PRIVATE_CANARY.encode() not in stdout and _PRIVATE_CANARY.encode() not in stderr
    observation_path = os.environ.get("IFPMIC_WORKSPACE_TEST_OBSERVATION_PATH")
    private_dir = (Path(observation_path).parent / "workspace-process-logs"
                   if observation_path else tmp_path / "workspace-process-logs")
    private_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    private_dir.chmod(0o700)
    assert stat.S_IMODE(private_dir.stat().st_mode) == 0o700
    prefix = f"process-{len(_PROCESS_RECORDS):03d}"
    stdout_path = private_dir / f"{prefix}-stdout.log"
    stderr_path = private_dir / f"{prefix}-stderr.log"
    for path, data in ((stdout_path, stdout), (stderr_path, stderr)):
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
        with os.fdopen(descriptor, "wb") as target:
            target.write(data)
    assert stat.S_IMODE(stdout_path.stat().st_mode) == 0o600
    assert stat.S_IMODE(stderr_path.stat().st_mode) == 0o600
    _PROCESS_RECORDS.append({
        "role": role,
        "process_identity": identity,
        "exit_code": returncode,
        "pid_alive": alive,
        "logs": {
            "stdout": {"sha256": hashlib.sha256(stdout).hexdigest(), "bytes": len(stdout)},
            "stderr": {"sha256": hashlib.sha256(stderr).hexdigest(), "bytes": len(stderr)},
        },
        "private_directory_mode": "0o700",
        "stdout_mode": "0o600",
        "stderr_mode": "0o600",
    })


def _intent(harness, job_id):
    with psycopg.connect(owner_dsn(harness["database"])) as connection:
        return connection.execute(
            """SELECT state,generation,claim_token::text,claim_expires_at,error_code
                 FROM ifpmic.workspace_intents WHERE job_id=%s""", (job_id,)
        ).fetchone()


def _service(harness, *, root=None, lease=2, fault_hook=None, filesystem=None):
    settings = replace(harness["settings"], workspace_root=str(root) if root is not None else None,
                       workspace_lease_seconds=lease, workspace_poll_seconds=1)
    return WorkspaceService(
        settings,
        db_factory=lambda: psycopg.connect(runtime_dsn(harness["database"]), autocommit=True),
        filesystem=filesystem,
        fault_hook=fault_hook,
    )


def _workspace_path(root: Path, job_id: str) -> Path:
    UUID(job_id)
    return root / job_id


def _assert_acceptance_group_unchanged(before, after):
    # The complete G4 group and stable workspace identity are immutable.
    assert after[:20] == before[:20]


_CRASH_WORKER = r"""
import os, signal, sys, psycopg
from services.ifpmic_api.settings import load_settings
from services.ifpmic_api.workspace import WorkspaceService
from services.ifpmic_api.workspace_fs import WorkspaceFilesystem
settings = load_settings(sys.argv[1])
def hook(name):
    if name == sys.argv[3]:
        os.kill(os.getpid(), signal.SIGKILL)
service = WorkspaceService(settings,
    db_factory=lambda: psycopg.connect(settings.database_dsn, autocommit=True),
    filesystem=WorkspaceFilesystem(settings.workspace_root, fault_hook=hook), fault_hook=hook)
service.reconcile_once(sys.argv[2])
"""


_RACE_WORKER = r"""
import json, os, sys, time, psycopg
from pathlib import Path
from services.ifpmic_api.settings import load_settings
from services.ifpmic_api.workspace import WorkspaceService
settings = load_settings(sys.argv[1])
claimed, release = Path(sys.argv[3]), Path(sys.argv[4])
def hook(name):
    if name == 'workspace_after_claim_commit':
        claimed.write_text('claimed', encoding='ascii')
        deadline = time.monotonic() + 10
        while not release.exists() and time.monotonic() < deadline:
            time.sleep(.01)
service = WorkspaceService(settings,
    db_factory=lambda: psycopg.connect(settings.database_dsn, autocommit=True),
    fault_hook=hook)
print(json.dumps(service.reconcile_once(sys.argv[2]), sort_keys=True, separators=(',', ':')), flush=True)
"""


def test_settings_workspace_path_and_integer_boundaries(g4_harness, tmp_path):
    settings = g4_harness["settings"]
    valid = [str(tmp_path / "workspace"), str(tmp_path / "a" / "b")]
    for path in valid:
        updated = replace(settings, workspace_root=path)
        assert updated.workspace_root == path
    invalid = [None]  # None is valid and disables provisioning.
    assert replace(settings, workspace_root=invalid[0]).workspace_root is None
    for path in ("/", "relative", str(tmp_path) + "/", str(tmp_path) + "//x",
                 str(tmp_path) + "/./x", str(tmp_path) + "/../x", "/tmp/bad\x00path",
                 "/tmp/lone-\ud800"):
        with pytest.raises(SettingsError):
            replace(settings, workspace_root=path)
    for field, bad in (("workspace_lease_seconds", [True, 0, 301, 1.5, "2"]),
                       ("workspace_poll_seconds", [True, 0, 61, 1.5, "1"])):
        for value in bad:
            with pytest.raises(SettingsError):
                replace(settings, **{field: value})
    assert replace(settings, workspace_lease_seconds=1, workspace_poll_seconds=1)
    assert replace(settings, workspace_lease_seconds=300, workspace_poll_seconds=60)


def test_workspace_preflight_rejects_nonprivate_root_without_claim(g4_harness, workspace_root):
    accepted = accept_workspace_job(g4_harness)
    before = _intent(g4_harness, accepted["job_id"])
    workspace_root.chmod(0o755)
    result = _service(g4_harness, root=workspace_root).reconcile_once(accepted["job_id"])
    assert result == {"status": "error", "job_id": None, "error_code": "WORKSPACE_UNSAFE"}
    assert _intent(g4_harness, accepted["job_id"]) == before
    assert list(workspace_root.iterdir()) == []
    workspace_root.chmod(0o700)


def test_real_filesystem_provisions_literal_marker_four_private_children_idempotently(
    g4_harness, workspace_root,
):
    accepted = accept_workspace_job(g4_harness)
    before = workspace_rows(g4_harness, accepted["job_id"])
    service = _service(g4_harness, root=workspace_root)

    first = service.reconcile_once(accepted["job_id"])
    assert first == {"status": "ready", "job_id": accepted["job_id"], "error_code": None}
    ready = _intent(g4_harness, accepted["job_id"])
    assert ready[0] == "READY" and ready[1] == 1 and ready[2:] == (None, None, None)

    path = _workspace_path(workspace_root, accepted["job_id"])
    marker = path / WORKSPACE_MARKER_NAME
    assert marker.read_bytes() == expected_marker_bytes(accepted["job_id"], before[19])
    assert stat.S_IMODE(marker.stat().st_mode) == 0o600
    assert {entry.name for entry in path.iterdir()} == {WORKSPACE_MARKER_NAME, *WORKSPACE_CHILD_NAMES}
    for child in WORKSPACE_CHILD_NAMES:
        child_path = path / child
        assert child_path.is_dir() and not child_path.is_symlink()
        assert stat.S_IMODE(child_path.stat().st_mode) == 0o700
        assert list(child_path.iterdir()) == []

    fingerprint = tree_fingerprint(workspace_root)
    second = service.reconcile_once(accepted["job_id"])
    assert second == {"status": "already_ready", "job_id": accepted["job_id"], "error_code": None}
    assert tree_fingerprint(workspace_root) == fingerprint
    after = workspace_rows(g4_harness, accepted["job_id"])
    _assert_acceptance_group_unchanged(before, after)
    assert after[20:25] == ("READY", 1, None, None, None)
    _mark("durable_layout")
    _mark("g4_acceptance_preserved")


def test_ready_shortcut_does_not_inspect_or_change_future_build_contents(g4_harness, workspace_root):
    accepted = accept_workspace_job(g4_harness)
    service = _service(g4_harness, root=workspace_root)
    assert service.reconcile_once(accepted["job_id"])["status"] == "ready"
    before = workspace_rows(g4_harness, accepted["job_id"])
    build_output = _workspace_path(workspace_root, accepted["job_id"]) / "build" / "future-output.txt"
    build_output.write_text("B07 owned build output", encoding="utf-8")
    build_output.chmod(0o600)
    fingerprint = tree_fingerprint(workspace_root)
    workspace_root.chmod(0o755)
    result = service.reconcile_once(accepted["job_id"])
    assert result["status"] == "already_ready"
    workspace_root.chmod(0o700)
    assert tree_fingerprint(workspace_root) == fingerprint
    _assert_acceptance_group_unchanged(before, workspace_rows(g4_harness, accepted["job_id"]))
    _mark("ready_db_only")


def test_unexpected_file_is_preserved_error_is_explicit_and_retry_does_not_delete(g4_harness, workspace_root):
    accepted = accept_workspace_job(g4_harness)
    service = _service(g4_harness, root=workspace_root)
    job_path = _workspace_path(workspace_root, accepted["job_id"])
    job_path.mkdir(mode=0o700)
    unexpected = job_path / "keep-me.bin"
    unexpected.write_bytes(b"outside workflow content")
    unexpected.chmod(0o600)
    before = tree_fingerprint(workspace_root)
    result = service.reconcile_once(accepted["job_id"])
    assert result == {"status": "error", "job_id": accepted["job_id"],
                      "error_code": "WORKSPACE_UNSAFE"}
    assert tree_fingerprint(workspace_root) == before
    error_row = _intent(g4_harness, accepted["job_id"])
    assert error_row[0] == "ERROR" and error_row[1] == 1
    assert error_row[2:4] == (None, None) and error_row[4] == "WORKSPACE_UNSAFE"

    retry = service.retry_error(accepted["job_id"])
    assert retry == {"status": "retry_queued", "job_id": accepted["job_id"], "error_code": None}
    assert _intent(g4_harness, accepted["job_id"]) == ("RESERVED", 1, None, None, None)
    assert unexpected.read_bytes() == b"outside workflow content"
    assert service.retry_error(accepted["job_id"])["status"] == "not_retryable"
    # Operator correction, rather than the worker, removes the unsafe entry.
    unexpected.unlink()
    assert service.reconcile_once(accepted["job_id"])["status"] == "ready"
    assert _intent(g4_harness, accepted["job_id"])[1] == 2
    _mark("unsafe_entries_preserved")


@pytest.mark.parametrize("damage", ["marker_bytes", "marker_mode", "child_mode", "child_content", "extra_entry"])
def test_existing_workspace_damage_is_fail_closed_and_never_repaired(g4_harness, workspace_root, damage):
    accepted = accept_workspace_job(g4_harness)
    service = _service(g4_harness, root=workspace_root)
    job_path = _workspace_path(workspace_root, accepted["job_id"])
    job_path.mkdir(mode=0o700)
    token = accepted["initial_row"][10]
    marker = job_path / WORKSPACE_MARKER_NAME
    marker.write_bytes(expected_marker_bytes(accepted["job_id"], token))
    marker.chmod(0o600)
    for name in WORKSPACE_CHILD_NAMES:
        (job_path / name).mkdir(mode=0o700)
    if damage == "marker_bytes":
        marker.write_bytes(b'{"format":"wrong"}\n')
    elif damage == "marker_mode":
        marker.chmod(0o644)
    elif damage == "child_mode":
        (job_path / "tc").chmod(0o755)
    elif damage == "child_content":
        (job_path / "source" / "keep.txt").write_text("preserve", encoding="utf-8")
    elif damage == "extra_entry":
        (job_path / "unlisted").write_text("preserve", encoding="utf-8")
    before = tree_fingerprint(workspace_root)
    response = service.reconcile_once(accepted["job_id"])
    assert response == {"status": "error", "job_id": accepted["job_id"], "error_code": "WORKSPACE_UNSAFE"}
    assert tree_fingerprint(workspace_root) == before
    assert _intent(g4_harness, accepted["job_id"])[0] == "ERROR"


def test_symlink_child_and_symlink_root_are_never_followed(g4_harness, workspace_root, tmp_path):
    accepted = accept_workspace_job(g4_harness)
    job_path = _workspace_path(workspace_root, accepted["job_id"])
    job_path.mkdir(mode=0o700)
    outside = tmp_path / "outside"
    outside.mkdir(mode=0o700)
    sentinel = outside / "sentinel"
    sentinel.write_text("do not follow", encoding="utf-8")
    marker = job_path / WORKSPACE_MARKER_NAME
    marker.write_bytes(expected_marker_bytes(accepted["job_id"], accepted["initial_row"][10]))
    marker.chmod(0o600)
    (job_path / "tc").symlink_to(outside, target_is_directory=True)
    before = tree_fingerprint(workspace_root)
    response = _service(g4_harness, root=workspace_root).reconcile_once(accepted["job_id"])
    assert response["status"] == "error" and response["error_code"] == "WORKSPACE_UNSAFE"
    assert tree_fingerprint(workspace_root) == before
    assert sentinel.read_text(encoding="utf-8") == "do not follow"

    other = tmp_path / "other-root"
    other.mkdir(mode=0o700)
    link = tmp_path / "root-link"
    link.symlink_to(other, target_is_directory=True)
    invalid_fs = WorkspaceFilesystem(str(link))
    with pytest.raises(WorkspaceError) as exc:
        invalid_fs.check_root()
    assert exc.value.code == "WORKSPACE_UNSAFE"
    assert list(other.iterdir()) == []


@pytest.mark.parametrize("entry_kind", [
    "marker_symlink", "marker_fifo", "job_symlink", "job_fifo", "ancestor_symlink", "ancestor_fifo",
])
def test_marker_job_and_ancestor_special_entries_are_never_followed(
    g4_harness, workspace_root, tmp_path, entry_kind,
):
    accepted = accept_workspace_job(g4_harness)
    job_id = accepted["job_id"]
    outside = tmp_path / "outside-special-entry"
    outside.mkdir(mode=0o700)
    sentinel = outside / "sentinel"
    sentinel.write_bytes(b"preserve-outside")
    sentinel.chmod(0o600)
    configured_root = workspace_root

    if entry_kind == "job_symlink":
        (workspace_root / job_id).symlink_to(outside, target_is_directory=True)
    elif entry_kind == "job_fifo":
        os.mkfifo(workspace_root / job_id, 0o600)
    elif entry_kind == "ancestor_symlink":
        alias = tmp_path / "workspace-alias"
        alias.symlink_to(workspace_root, target_is_directory=True)
        configured_root = alias
    elif entry_kind == "ancestor_fifo":
        ancestor = tmp_path / "workspace-ancestor"
        ancestor.mkdir(mode=0o700)
        fifo = ancestor / "root-entry"
        os.mkfifo(fifo, 0o600)
        configured_root = fifo / "root"
    else:
        job_path = workspace_root / job_id
        job_path.mkdir(mode=0o700)
        marker = job_path / WORKSPACE_MARKER_NAME
        if entry_kind == "marker_symlink":
            marker.symlink_to(sentinel)
        else:
            os.mkfifo(marker, 0o600)

    before_workspace = tree_fingerprint(workspace_root)
    fifo_before = (configured_root.parent.lstat().st_ino, configured_root.parent.lstat().st_mode) \
        if entry_kind == "ancestor_fifo" else None
    before_outside = sentinel.read_bytes()
    intent_before = _intent(g4_harness, job_id)
    result = _service(g4_harness, root=configured_root).reconcile_once(job_id)
    if entry_kind.startswith("ancestor_"):
        # Global configured-root preflight is deliberately before claiming a job.
        assert result == {"status": "error", "job_id": None, "error_code": "WORKSPACE_UNSAFE"}
        assert _intent(g4_harness, job_id) == intent_before
    else:
        assert result == {"status": "error", "job_id": job_id, "error_code": "WORKSPACE_UNSAFE"}
        assert _intent(g4_harness, job_id)[0] == "ERROR"
    assert tree_fingerprint(workspace_root) == before_workspace
    if fifo_before is not None:
        fifo_after = configured_root.parent.lstat()
        assert (fifo_after.st_ino, fifo_after.st_mode) == fifo_before
    assert sentinel.read_bytes() == before_outside
    _mark_additional("special_entry_" + entry_kind)


def test_group_writable_intermediate_ancestor_is_rejected_without_claim(g4_harness, tmp_path):
    accepted = accept_workspace_job(g4_harness)
    parent = tmp_path / "workspace-parent"
    parent.mkdir(mode=0o700)
    parent.chmod(0o770)
    root = parent / "root"
    root.mkdir(mode=0o700)
    before = _intent(g4_harness, accepted["job_id"])
    result = _service(g4_harness, root=root).reconcile_once(accepted["job_id"])
    assert result == {"status": "error", "job_id": None, "error_code": "WORKSPACE_UNSAFE"}
    assert _intent(g4_harness, accepted["job_id"]) == before
    assert list(root.iterdir()) == []
    _mark_additional("unsafe_intermediate_ancestor")


def test_missing_configured_directory_is_io_error_without_claim(g4_harness, tmp_path):
    accepted = accept_workspace_job(g4_harness)
    missing = tmp_path / "not-created"
    before = _intent(g4_harness, accepted["job_id"])
    response = _service(g4_harness, root=missing).reconcile_once(accepted["job_id"])
    assert response == {"status": "error", "job_id": None, "error_code": "WORKSPACE_IO"}
    assert _intent(g4_harness, accepted["job_id"]) == before
    assert not missing.exists()
    _mark_additional("missing_existing_root")


def test_matching_marker_partial_layout_is_completed_without_adopting_unknown_entries(
    g4_harness, workspace_root,
):
    accepted = accept_workspace_job(g4_harness)
    job_id = accepted["job_id"]
    job = _workspace_path(workspace_root, job_id)
    job.mkdir(mode=0o700)
    marker = job / WORKSPACE_MARKER_NAME
    marker.write_bytes(expected_marker_bytes(job_id, accepted["initial_row"][10]))
    marker.chmod(0o600)
    (job / "source").mkdir(mode=0o700)
    before = workspace_rows(g4_harness, job_id)
    result = _service(g4_harness, root=workspace_root).reconcile_once(job_id)
    assert result == {"status": "ready", "job_id": job_id, "error_code": None}
    assert {entry.name for entry in job.iterdir()} == {WORKSPACE_MARKER_NAME, *WORKSPACE_CHILD_NAMES}
    assert all(not list((job / child).iterdir()) for child in WORKSPACE_CHILD_NAMES)
    assert workspace_rows(g4_harness, job_id)[20:25] == ("READY", 1, None, None, None)
    _assert_acceptance_group_unchanged(before, workspace_rows(g4_harness, job_id))
    _mark_additional("partial_marker_layout_recovery")


@pytest.mark.parametrize(("errno_value", "code"), [
    (errno.ENOSPC, "WORKSPACE_NO_SPACE"),
    (errno.EDQUOT, "WORKSPACE_NO_SPACE"),
    (errno.EIO, "WORKSPACE_IO"),
])
def test_actual_os_error_is_fixed_and_fenced_before_retry(g4_harness, workspace_root, errno_value, code):
    accepted = accept_workspace_job(g4_harness)
    def fail(name):
        if name == "workspace_before_marker_write":
            raise OSError(errno_value, "private sentinel must not escape")
    service = _service(g4_harness, root=workspace_root, fault_hook=fail)
    result = service.reconcile_once(accepted["job_id"])
    assert result == {"status": "error", "job_id": accepted["job_id"], "error_code": code}
    row = _intent(g4_harness, accepted["job_id"])
    assert row[0] == "ERROR" and row[4] == code and row[2:4] == (None, None)
    assert service.retry_error(accepted["job_id"])["status"] == "retry_queued"
    failed_tree = tree_fingerprint(workspace_root)
    failed_job_dir = _workspace_path(workspace_root, accepted["job_id"])
    assert failed_job_dir.is_dir() and list(failed_job_dir.iterdir()) == []
    assert service.retry_error(accepted["job_id"])["status"] == "not_retryable"
    assert tree_fingerprint(workspace_root) == failed_tree
    if errno_value == errno.ENOSPC:
        _mark("controlled_enospc")


@pytest.mark.parametrize("hook", [
    "workspace_before_marker_fsync",
    "workspace_before_children_sync",
    "workspace_before_directory_sync",
    "workspace_before_parent_sync",
])
def test_sync_boundary_io_errors_never_report_ready(g4_harness, workspace_root, hook):
    accepted = accept_workspace_job(g4_harness)
    def fail_at_boundary(name):
        if name == hook:
            raise OSError(errno.EIO, "private sync detail")
    result = _service(g4_harness, root=workspace_root, fault_hook=fail_at_boundary).reconcile_once(
        accepted["job_id"])
    assert result == {"status": "error", "job_id": accepted["job_id"], "error_code": "WORKSPACE_IO"}
    row = _intent(g4_harness, accepted["job_id"])
    assert row[0] == "ERROR" and row[2:4] == (None, None) and row[4] == "WORKSPACE_IO"


@pytest.mark.parametrize("syscall", ["fsync_file", "fsync_directory", "link", "unlink"])
def test_real_filesystem_syscall_faults_are_fenced_and_preserved(
    g4_harness, workspace_root, monkeypatch, syscall,
):
    import services.ifpmic_api.workspace_fs as workspace_fs_module

    accepted = accept_workspace_job(g4_harness)
    original_fsync = os.fsync
    original_link = os.link
    original_unlink = os.unlink
    fired = {"value": False}

    def fail_fsync(fd):
        info = os.fstat(fd)
        target = ("fsync_file" if stat.S_ISREG(info.st_mode) else
                  "fsync_directory" if stat.S_ISDIR(info.st_mode) else "other")
        if target == syscall and not fired["value"]:
            fired["value"] = True
            raise OSError(errno.EIO, "private syscall sentinel")
        return original_fsync(fd)

    def fail_link(*args, **kwargs):
        if syscall == "link" and not fired["value"]:
            fired["value"] = True
            raise OSError(errno.EIO, "private syscall sentinel")
        return original_link(*args, **kwargs)

    def fail_unlink(path, *args, **kwargs):
        if syscall == "unlink" and not fired["value"] and str(path).startswith(".ifpmic-marker-"):
            fired["value"] = True
            raise OSError(errno.EIO, "private syscall sentinel")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(workspace_fs_module.os, "fsync", fail_fsync)
    monkeypatch.setattr(workspace_fs_module.os, "link", fail_link)
    monkeypatch.setattr(workspace_fs_module.os, "unlink", fail_unlink)
    result = _service(g4_harness, root=workspace_root).reconcile_once(accepted["job_id"])
    assert fired["value"] is True
    assert result == {"status": "error", "job_id": accepted["job_id"], "error_code": "WORKSPACE_IO"}
    assert _intent(g4_harness, accepted["job_id"])[0:2] == ("ERROR", 1)
    job = _workspace_path(workspace_root, accepted["job_id"])
    if syscall == "unlink":
        # Publication precedes unlinking the staging alias. If unlink fails,
        # retain the exact published marker and the staging alias for review.
        marker = job / WORKSPACE_MARKER_NAME
        assert marker.is_file() and not marker.is_symlink()
        assert marker.read_bytes() == expected_marker_bytes(accepted["job_id"], accepted["initial_row"][10])
        assert stat.S_IMODE(marker.stat().st_mode) == 0o600
        staging = [p for p in workspace_root.iterdir() if p.name.startswith(".ifpmic-marker-")]
        assert len(staging) == 1 and staging[0].is_file() and not staging[0].is_symlink()
        assert stat.S_IMODE(staging[0].stat().st_mode) == 0o600
        assert not [p for p in job.iterdir() if p.name != WORKSPACE_MARKER_NAME]
    elif syscall == "fsync_directory":
        # The first job-directory fsync follows creation of all four children.
        assert set(p.name for p in job.iterdir()) == {WORKSPACE_MARKER_NAME, "source", "tc", "artifacts", "build"}
        for name in ("source", "tc", "artifacts", "build"):
            child = job / name
            assert child.is_dir() and not child.is_symlink() and list(child.iterdir()) == []
            assert stat.S_IMODE(child.stat().st_mode) == 0o700
        marker = job / WORKSPACE_MARKER_NAME
        assert marker.is_file() and marker.read_bytes() == expected_marker_bytes(accepted["job_id"], accepted["initial_row"][10])
        assert not [p for p in workspace_root.iterdir() if p.name.startswith(".ifpmic-marker-")]
    else:
        assert list(job.iterdir()) == []
        assert not [p for p in workspace_root.iterdir() if p.name.startswith(".ifpmic-marker-")]
    _mark_additional("syscall_" + syscall)


def test_short_marker_writes_are_retried_until_exact_bytes_are_complete(
    g4_harness, workspace_root, monkeypatch,
):
    import services.ifpmic_api.workspace_fs as workspace_fs_module

    accepted = accept_workspace_job(g4_harness)
    original_write = os.write
    writes = {"count": 0}

    def short_write(fd, data):
        writes["count"] += 1
        return original_write(fd, data[:3])

    monkeypatch.setattr(workspace_fs_module.os, "write", short_write)
    result = _service(g4_harness, root=workspace_root).reconcile_once(accepted["job_id"])
    assert result == {"status": "ready", "job_id": accepted["job_id"], "error_code": None}
    marker = _workspace_path(workspace_root, accepted["job_id"]) / WORKSPACE_MARKER_NAME
    assert marker.read_bytes() == expected_marker_bytes(accepted["job_id"], accepted["initial_row"][10])
    assert writes["count"] > 1
    _mark_additional("short_write_completion")


def test_marker_close_and_directory_fsync_order_precede_ready(g4_harness, workspace_root, monkeypatch):
    import services.ifpmic_api.workspace_fs as workspace_fs_module

    accepted = accept_workspace_job(g4_harness)
    original_fsync = os.fsync
    original_link = os.link
    sync_targets = []
    link_observations = []

    def record_fsync(fd):
        target = os.readlink(f"/proc/self/fd/{fd}")
        sync_targets.append(Path(target).name)
        return original_fsync(fd)

    def validate_closed_source(src, dst, *args, **kwargs):
        root_fd = kwargs.get("src_dir_fd")
        root_path = Path(os.readlink(f"/proc/self/fd/{root_fd}"))
        stage_path = root_path / src
        open_aliases = []
        for descriptor in Path("/proc/self/fd").iterdir():
            try:
                if Path(os.readlink(descriptor)) == stage_path:
                    open_aliases.append(descriptor.name)
            except (FileNotFoundError, PermissionError):
                continue
        link_observations.append(not open_aliases)
        assert not open_aliases
        return original_link(src, dst, *args, **kwargs)

    monkeypatch.setattr(workspace_fs_module.os, "fsync", record_fsync)
    monkeypatch.setattr(workspace_fs_module.os, "link", validate_closed_source)
    response = _service(g4_harness, root=workspace_root).reconcile_once(accepted["job_id"])
    assert response["status"] == "ready"
    assert link_observations == [True]
    assert sync_targets[0].startswith(".ifpmic-marker-")
    assert sync_targets[1:] == [*WORKSPACE_CHILD_NAMES, accepted["job_id"], workspace_root.name]
    assert _intent(g4_harness, accepted["job_id"])[0] == "READY"
    _mark_additional("marker_close_and_durability_order")


def test_unexpected_filesystem_exception_keeps_claim_provisioning_for_reconciliation(g4_harness, workspace_root):
    accepted = accept_workspace_job(g4_harness)
    def fail_with_unknown(name):
        if name == "workspace_before_marker_write":
            raise RuntimeError(_PRIVATE_CANARY)
    result = _service(g4_harness, root=workspace_root, lease=1,
                      fault_hook=fail_with_unknown).reconcile_once(accepted["job_id"])
    assert result == {"status": "dependency_unavailable", "job_id": accepted["job_id"],
                      "error_code": "WORKSPACE_UNAVAILABLE"}
    assert _intent(g4_harness, accepted["job_id"])[0:2] == ("PROVISIONING", 1)
    job_path = _workspace_path(workspace_root, accepted["job_id"])
    assert list(workspace_root.iterdir()) == [job_path]
    assert list(job_path.iterdir()) == []
    time.sleep(1.15)
    assert _service(g4_harness, root=workspace_root, lease=1).reconcile_once(accepted["job_id"])["status"] == "ready"


def test_claim_commit_ack_loss_performs_no_filesystem_effect(g4_harness, workspace_root):
    accepted = accept_workspace_job(g4_harness)
    def lose_ack(name):
        if name == "workspace_after_claim_commit":
            raise RuntimeError(_PRIVATE_CANARY)
    result = _service(g4_harness, root=workspace_root, lease=1,
                      fault_hook=lose_ack).reconcile_once(accepted["job_id"])
    assert result == {"status": "commit_uncertain", "job_id": accepted["job_id"],
                      "error_code": "WORKSPACE_COMMIT_UNCERTAIN"}
    assert _intent(g4_harness, accepted["job_id"])[0:2] == ("PROVISIONING", 1)
    assert list(workspace_root.iterdir()) == []
    time.sleep(1.15)
    assert _service(g4_harness, root=workspace_root, lease=1).reconcile_once(accepted["job_id"])["status"] == "ready"


@pytest.mark.parametrize(("operation", "hook_name"), [
    ("error", "workspace_after_error_commit"),
    ("retry", "workspace_after_retry_commit"),
])
def test_error_and_retry_commit_ack_losses_require_fresh_state_inspection(
    g4_harness, workspace_root, operation, hook_name,
):
    accepted = accept_workspace_job(g4_harness)
    job_id = accepted["job_id"]
    if operation == "error":
        def fail_filesystem_and_ack(name):
            if name == "workspace_before_marker_write":
                raise OSError(errno.EIO, "private error trigger")
            if name == hook_name:
                raise RuntimeError(_PRIVATE_CANARY)
        service = _service(g4_harness, root=workspace_root, fault_hook=fail_filesystem_and_ack)
        result = service.reconcile_once(job_id)
        expected_job_path = _workspace_path(workspace_root, job_id)
    else:
        def fail_filesystem(name):
            if name == "workspace_before_marker_write":
                raise OSError(errno.EIO, "private error trigger")
        assert _service(g4_harness, root=workspace_root, fault_hook=fail_filesystem).reconcile_once(job_id)[
            "status"] == "error"

        def lose_ack(name):
            if name == hook_name:
                raise RuntimeError(_PRIVATE_CANARY)
        service = _service(g4_harness, root=workspace_root, fault_hook=lose_ack)
        tree_before_retry = tree_fingerprint(workspace_root)
        result = service.retry_error(job_id)
    assert result == {"status": "commit_uncertain", "job_id": job_id,
                      "error_code": "WORKSPACE_COMMIT_UNCERTAIN"}
    row = _intent(g4_harness, job_id)
    if operation == "error":
        assert row[0] == "ERROR" and row[4] == "WORKSPACE_IO"
    else:
        assert row == ("RESERVED", 1, None, None, None)
    if operation == "retry":
        assert tree_fingerprint(workspace_root) == tree_before_retry
    else:
        assert list(workspace_root.iterdir()) == [expected_job_path]
        assert list(expected_job_path.iterdir()) == []
    _mark_additional("commit_ack_loss_" + operation)


@pytest.mark.parametrize("operation", ["claim", "ready", "error", "retry"])
def test_precommit_database_faults_never_infer_commit_or_mutate_g4(
    g4_harness, workspace_root, operation,
):
    accepted = accept_workspace_job(g4_harness, key="g5-precommit-" + operation)
    job_id = accepted["job_id"]
    acceptance_before = workspace_rows(g4_harness, job_id)
    if operation == "retry":
        with psycopg.connect(owner_dsn(g4_harness["database"])) as connection:
            connection.execute(
                "UPDATE ifpmic.workspace_intents SET state='ERROR',error_code='WORKSPACE_IO' WHERE job_id=%s",
                (job_id,),
            )

    def fail(name):
        expected_hook = {
            "claim": "workspace_before_claim_commit",
            "ready": "workspace_before_ready_commit",
            "error": "workspace_before_error_commit",
            "retry": "workspace_before_retry_commit",
        }[operation]
        if operation == "error" and name == "workspace_before_marker_write":
            raise OSError(errno.EIO, "private test trigger")
        if name == expected_hook:
            raise RuntimeError(_PRIVATE_CANARY)

    service = _service(g4_harness, root=workspace_root, lease=1, fault_hook=fail)
    result = service.retry_error(job_id) if operation == "retry" else service.reconcile_once(job_id)
    assert result == {"status": "dependency_unavailable", "job_id": job_id,
                      "error_code": "WORKSPACE_UNAVAILABLE"}
    row = _intent(g4_harness, job_id)
    assert row[0] == {"claim": "RESERVED", "ready": "PROVISIONING", "error": "PROVISIONING", "retry": "ERROR"}[operation]
    if operation == "claim":
        assert row[1:3] == (0, None) and list(workspace_root.iterdir()) == []
    elif operation == "retry":
        assert row[1:3] == (0, None) and row[4] == "WORKSPACE_IO"
        assert list(workspace_root.iterdir()) == []
    elif operation == "error":
        assert row[1] == 1 and row[2] is not None and row[4] is None
        job = _workspace_path(workspace_root, job_id)
        assert job.is_dir() and list(job.iterdir()) == []
    else:
        assert row[1] == 1 and row[2] is not None and row[4] is None
        job = _workspace_path(workspace_root, job_id)
        assert {entry.name for entry in job.iterdir()} == {WORKSPACE_MARKER_NAME, *WORKSPACE_CHILD_NAMES}

    if operation in {"ready", "error"}:
        time.sleep(1.15)
        resumed = _service(g4_harness, root=workspace_root, lease=1).reconcile_once(job_id)
        assert resumed["status"] == "ready"
        assert _intent(g4_harness, job_id)[0:2] == ("READY", 2)
    _assert_acceptance_group_unchanged(acceptance_before, workspace_rows(g4_harness, job_id))
    _mark_additional("precommit_rollback_" + operation)


def test_malformed_claim_becomes_invalid_state_without_filesystem_effect(g4_harness, workspace_root):
    accepted = accept_workspace_job(g4_harness)
    with psycopg.connect(owner_dsn(g4_harness["database"])) as connection:
        connection.execute(
            "UPDATE ifpmic.workspace_intents SET state='PROVISIONING',generation=0,claim_token=NULL,"
            "claim_expires_at=NULL,error_code=NULL WHERE job_id=%s", (accepted["job_id"],)
        )
    before = tree_fingerprint(workspace_root)
    result = _service(g4_harness, root=workspace_root).reconcile_once(accepted["job_id"])
    assert result == {"status": "error", "job_id": accepted["job_id"],
                      "error_code": "WORKSPACE_INVALID_STATE"}
    assert tree_fingerprint(workspace_root) == before
    row = _intent(g4_harness, accepted["job_id"])
    assert row[0] == "ERROR" and row[1] == 0 and row[2:4] == (None, None)
    assert row[4] == "WORKSPACE_INVALID_STATE"
    _mark("malformed_claim_no_fs")


@pytest.mark.parametrize("mutation", [
    "reserved_has_error",
    "reserved_has_token",
    "reserved_has_expiry",
    "reserved_generation_exhausted",
    "provisioning_zero_generation",
    "provisioning_missing_token",
    "provisioning_missing_expiry",
    "provisioning_error_present",
    "expired_generation_exhausted",
])
def test_claim_invariant_matrix_fails_closed_without_filesystem_effect(g4_harness, workspace_root, mutation):
    accepted = accept_workspace_job(g4_harness)
    job_id = accepted["job_id"]
    with psycopg.connect(owner_dsn(g4_harness["database"])) as connection:
        if mutation == "reserved_has_error":
            connection.execute("UPDATE ifpmic.workspace_intents SET error_code='WORKSPACE_IO' WHERE job_id=%s", (job_id,))
        elif mutation == "reserved_has_token":
            connection.execute("UPDATE ifpmic.workspace_intents SET claim_token=gen_random_uuid() WHERE job_id=%s", (job_id,))
        elif mutation == "reserved_has_expiry":
            connection.execute("UPDATE ifpmic.workspace_intents SET claim_expires_at=clock_timestamp()+interval '1 minute' WHERE job_id=%s", (job_id,))
        elif mutation == "reserved_generation_exhausted":
            connection.execute("UPDATE ifpmic.workspace_intents SET generation=9223372036854775807 WHERE job_id=%s", (job_id,))
        else:
            connection.execute(
                "UPDATE ifpmic.workspace_intents SET state='PROVISIONING',generation=1,"
                "claim_token=gen_random_uuid(),claim_expires_at=clock_timestamp()-interval '1 second',"
                "error_code=NULL WHERE job_id=%s", (job_id,)
            )
            if mutation == "provisioning_zero_generation":
                connection.execute("UPDATE ifpmic.workspace_intents SET generation=0 WHERE job_id=%s", (job_id,))
            elif mutation == "provisioning_missing_token":
                connection.execute("UPDATE ifpmic.workspace_intents SET claim_token=NULL WHERE job_id=%s", (job_id,))
            elif mutation == "provisioning_missing_expiry":
                connection.execute("UPDATE ifpmic.workspace_intents SET claim_expires_at=NULL WHERE job_id=%s", (job_id,))
            elif mutation == "provisioning_error_present":
                connection.execute("UPDATE ifpmic.workspace_intents SET error_code='WORKSPACE_IO' WHERE job_id=%s", (job_id,))
            elif mutation == "expired_generation_exhausted":
                connection.execute("UPDATE ifpmic.workspace_intents SET generation=9223372036854775807 WHERE job_id=%s", (job_id,))
    before = tree_fingerprint(workspace_root)
    result = _service(g4_harness, root=workspace_root).reconcile_once(job_id)
    assert result == {"status": "error", "job_id": job_id, "error_code": "WORKSPACE_INVALID_STATE"}
    assert tree_fingerprint(workspace_root) == before
    row = _intent(g4_harness, job_id)
    assert row[0] == "ERROR" and row[2:4] == (None, None)
    assert row[4] == "WORKSPACE_INVALID_STATE"


def test_live_max_generation_claim_is_excluded_without_filesystem_effect(g4_harness, workspace_root):
    accepted = accept_workspace_job(g4_harness)
    job_id = accepted["job_id"]
    with psycopg.connect(owner_dsn(g4_harness["database"])) as connection:
        connection.execute(
            "UPDATE ifpmic.workspace_intents SET state='PROVISIONING',generation=9223372036854775807,"
            "claim_token=gen_random_uuid(),claim_expires_at=clock_timestamp()+interval '1 minute',"
            "error_code=NULL WHERE job_id=%s", (job_id,),
        )
    before = _intent(g4_harness, job_id)
    result = _service(g4_harness, root=workspace_root).reconcile_once(job_id)
    assert result == {"status": "idle", "job_id": None, "error_code": None}
    assert _intent(g4_harness, job_id) == before
    assert list(workspace_root.iterdir()) == []
    _mark_additional("active_max_generation_claim_excluded")


def test_exact_expired_claim_is_reclaimable_by_fresh_database_clock(g4_harness, workspace_root):
    accepted = accept_workspace_job(g4_harness)
    job_id = accepted["job_id"]
    with psycopg.connect(owner_dsn(g4_harness["database"])) as connection:
        connection.execute(
            "UPDATE ifpmic.workspace_intents SET state='PROVISIONING',generation=1,"
            "claim_token=gen_random_uuid(),claim_expires_at=clock_timestamp(),error_code=NULL WHERE job_id=%s",
            (job_id,),
        )
    result = _service(g4_harness, root=workspace_root).reconcile_once(job_id)
    assert result["status"] == "ready"
    assert _intent(g4_harness, job_id)[0:2] == ("READY", 2)


def test_locked_claim_is_idle_then_expired_claim_is_reconciled(g4_harness, workspace_root):
    accepted = accept_workspace_job(g4_harness)
    job_id = accepted["job_id"]
    with psycopg.connect(owner_dsn(g4_harness["database"])) as connection:
        connection.execute(
            "UPDATE ifpmic.workspace_intents SET state='PROVISIONING',generation=1,"
            "claim_token=gen_random_uuid(),claim_expires_at=clock_timestamp()+interval '700 milliseconds',"
            "error_code=NULL WHERE job_id=%s", (job_id,),
        )

    with psycopg.connect(owner_dsn(g4_harness["database"])) as holder:
        holder.execute("SELECT job_id FROM ifpmic.workspace_intents WHERE job_id=%s FOR UPDATE", (job_id,))
        reached_claim = threading.Event()
        result = []

        def hook(name):
            if name == "workspace_before_claim":
                reached_claim.set()

        service = _service(g4_harness, root=workspace_root, fault_hook=hook)
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(service.reconcile_once, job_id)
            assert reached_claim.wait(10)
            # The candidate SELECT uses SKIP LOCKED, so a locked row is not
            # waited on or claimed even when its lease expires during the lock.
            time.sleep(0.1)
            result.append(future.result(timeout=5))
            assert result == [{"status": "idle", "job_id": None, "error_code": None}]
            time.sleep(0.7)
            holder.commit()
        result.append(_service(g4_harness, root=workspace_root).reconcile_once(job_id))
    assert result[-1] == {"status": "ready", "job_id": job_id, "error_code": None}
    assert _intent(g4_harness, job_id)[0:2] == ("READY", 2)
    _mark_additional("skip_locked_claim_idle_then_expired_reconcile")


def test_completion_rechecks_clock_after_waiting_for_row_lock(g4_harness, workspace_root):
    accepted = accept_workspace_job(g4_harness)
    job_id = accepted["job_id"]
    before_ready = threading.Event()
    release_ready = threading.Event()

    def pause_before_ready(name):
        if name == "workspace_before_ready":
            before_ready.set()
            assert release_ready.wait(10)

    service = _service(g4_harness, root=workspace_root, lease=2, fault_hook=pause_before_ready)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(service.reconcile_once, job_id)
        assert before_ready.wait(10)
        with psycopg.connect(owner_dsn(g4_harness["database"])) as holder:
            holder.execute("SELECT job_id FROM ifpmic.workspace_intents WHERE job_id=%s FOR UPDATE", (job_id,))
            release_ready.set()
            time.sleep(2.2)
            holder.commit()
        stale = future.result(timeout=20)
    assert stale == {"status": "stale", "job_id": job_id, "error_code": "WORKSPACE_STALE"}
    assert _intent(g4_harness, job_id)[0:2] == ("PROVISIONING", 1)
    assert _workspace_path(workspace_root, job_id).is_dir()
    _mark_additional("completion_clock_after_row_lock_wait")


def test_ready_completion_is_rejected_when_lease_expires_while_row_lock_is_held(g4_harness, workspace_root):
    accepted = accept_workspace_job(g4_harness)
    job_id = accepted["job_id"]
    entered_completion = threading.Event()
    release_completion = threading.Event()

    def hold_completion_lock(name):
        if name == "workspace_after_completion_lock":
            entered_completion.set()
            assert release_completion.wait(10)

    service = _service(g4_harness, root=workspace_root, lease=1, fault_hook=hold_completion_lock)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(service.reconcile_once, job_id)
        assert entered_completion.wait(10)
        time.sleep(1.15)
        release_completion.set()
        stale = future.result(timeout=20)
    assert stale == {"status": "stale", "job_id": job_id, "error_code": "WORKSPACE_STALE"}
    row = _intent(g4_harness, job_id)
    assert row[0:2] == ("PROVISIONING", 1) and row[2] is not None and row[3] is not None
    assert _workspace_path(workspace_root, job_id).is_dir()
    recovered = _service(g4_harness, root=workspace_root, lease=1).reconcile_once(job_id)
    assert recovered["status"] == "ready"
    assert _intent(g4_harness, job_id)[0:2] == ("READY", 2)
    _mark_additional("completion_clock_after_lock_expiry")


def test_malformed_ready_is_reported_without_inspecting_or_mutating_workspace(g4_harness, workspace_root):
    accepted = accept_workspace_job(g4_harness)
    service = _service(g4_harness, root=workspace_root)
    assert service.reconcile_once(accepted["job_id"])["status"] == "ready"
    with psycopg.connect(owner_dsn(g4_harness["database"])) as connection:
        connection.execute("UPDATE ifpmic.workspace_intents SET generation=0 WHERE job_id=%s",
                           (accepted["job_id"],))
    before_rows = _intent(g4_harness, accepted["job_id"])
    before_tree = tree_fingerprint(workspace_root)
    result = service.reconcile_once(accepted["job_id"])
    assert result == {"status": "error", "job_id": accepted["job_id"],
                      "error_code": "WORKSPACE_INVALID_STATE"}
    assert _intent(g4_harness, accepted["job_id"]) == before_rows
    assert tree_fingerprint(workspace_root) == before_tree


def test_missing_root_and_invalid_target_do_not_claim_or_touch_filesystem(g4_harness, workspace_root):
    accepted = accept_workspace_job(g4_harness)
    before = workspace_rows(g4_harness, accepted["job_id"])
    missing = _service(g4_harness, root=None)
    result = missing.reconcile_once(accepted["job_id"])
    assert result == {"status": "invalid_request", "job_id": None,
                      "error_code": "WORKSPACE_INVALID_REQUEST"}
    invalid = _service(g4_harness, root=workspace_root).reconcile_once("../../bad")
    assert invalid["status"] == "invalid_request" and invalid["job_id"] is None
    assert workspace_rows(g4_harness, accepted["job_id"]) == before
    assert list(workspace_root.iterdir()) == []


def test_two_reconcilers_skip_live_claim_then_one_completes(g4_harness, workspace_root):
    accepted = accept_workspace_job(g4_harness)
    claimed = threading.Event()
    release = threading.Event()
    seen = []

    def pause_after_claim(name):
        if name == "workspace_after_claim_commit":
            claimed.set()
            assert release.wait(10)

    first = _service(g4_harness, root=workspace_root, fault_hook=pause_after_claim)
    second = _service(g4_harness, root=workspace_root)
    with ThreadPoolExecutor(max_workers=2) as pool:
        future = pool.submit(first.reconcile_once, accepted["job_id"])
        assert claimed.wait(10)
        seen.append(second.reconcile_once(accepted["job_id"]))
        release.set()
        seen.append(future.result(timeout=30))
    assert seen[0] == {"status": "idle", "job_id": None, "error_code": None}
    assert seen[1]["status"] == "ready"
    assert _intent(g4_harness, accepted["job_id"])[0:2] == ("READY", 1)
    _mark("active_claim_excluded")


def test_expired_claim_fences_old_worker_and_reuses_only_stable_layout(g4_harness, workspace_root):
    accepted = accept_workspace_job(g4_harness)
    claimed = threading.Event()
    release = threading.Event()
    first_result = []

    def pause_after_claim(name):
        if name == "workspace_after_claim_commit":
            claimed.set()
            assert release.wait(15)

    first = _service(g4_harness, root=workspace_root, lease=1, fault_hook=pause_after_claim)
    second = _service(g4_harness, root=workspace_root, lease=1)
    with ThreadPoolExecutor(max_workers=2) as pool:
        future = pool.submit(first.reconcile_once, accepted["job_id"])
        assert claimed.wait(10)
        time.sleep(1.2)
        winner = second.reconcile_once(accepted["job_id"])
        release.set()
        first_result.append(future.result(timeout=30))
    assert winner["status"] == "ready"
    assert first_result[0]["status"] == "stale"
    row = _intent(g4_harness, accepted["job_id"])
    assert row[0:2] == ("READY", 2)
    path = _workspace_path(workspace_root, accepted["job_id"])
    assert (path / WORKSPACE_MARKER_NAME).read_bytes() == expected_marker_bytes(
        accepted["job_id"], accepted["initial_row"][10]
    )
    assert {entry.name for entry in path.iterdir()} == {WORKSPACE_MARKER_NAME, *WORKSPACE_CHILD_NAMES}
    _mark("stale_claim_fenced")


@pytest.mark.parametrize("hook,staging_expected,layout_complete,ready_committed", [
    ("workspace_before_claim", False, False, False),
    ("workspace_before_claim_commit", False, False, False),
    ("workspace_after_claim_commit", False, False, False),
    ("workspace_before_mkdir", False, False, False),
    ("workspace_after_mkdir", False, False, False),
    ("workspace_before_marker_write", True, False, False),
    ("workspace_after_marker_write", True, False, False),
    ("workspace_before_marker_fsync", True, False, False),
    ("workspace_after_marker_fsync", True, False, False),
    ("workspace_before_marker_close", True, False, False),
    ("workspace_after_marker_close", True, False, False),
    ("workspace_before_marker_publish", True, False, False),
    ("workspace_after_marker_publish", True, False, False),
    ("workspace_before_children", False, False, False),
    ("workspace_after_children", False, True, False),
    ("workspace_before_children_sync", False, True, False),
    ("workspace_after_children_sync", False, True, False),
    ("workspace_before_directory_sync", False, True, False),
    ("workspace_after_directory_sync", False, True, False),
    ("workspace_before_parent_sync", False, True, False),
    ("workspace_after_parent_sync", False, True, False),
    ("workspace_before_ready", False, True, False),
    ("workspace_before_ready_commit", False, True, False),
    ("workspace_after_completion_lock", False, True, False),
    ("workspace_after_ready_commit", False, True, True),
])
def test_sigkill_worker_crash_recovers_only_after_lease_and_preserves_stage(
    g4_harness, workspace_root, tmp_path, hook, staging_expected, layout_complete, ready_committed,
):
    accepted = accept_workspace_job(g4_harness)
    settings = replace(g4_harness["settings"], workspace_root=str(workspace_root),
                       workspace_lease_seconds=1, workspace_poll_seconds=1)
    config = tmp_path / "crash-worker.json"
    write_workspace_settings(settings, config)
    env = {"PATH": os.environ["PATH"], "PYTHONPATH": str(Path(__file__).resolve().parents[2])}
    process = _spawn_process(
        [sys.executable, "-c", _CRASH_WORKER, str(config), accepted["job_id"], hook],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
        cwd=Path(__file__).resolve().parents[2],
    )
    stdout, stderr = process.communicate(timeout=25)
    assert process.returncode == -signal.SIGKILL
    assert stdout == b"" and stderr == b""
    _record_process("crash_worker", process.pid, process.returncode, stdout, stderr,
                    -signal.SIGKILL, tmp_path)
    row = _intent(g4_harness, accepted["job_id"])
    expected_state = "READY" if ready_committed else ("RESERVED" if hook in {
        "workspace_before_claim", "workspace_before_claim_commit"} else "PROVISIONING")
    expected_generation = 0 if expected_state == "RESERVED" else 1
    assert row[0:2] == (expected_state, expected_generation)
    job_path = _workspace_path(workspace_root, accepted["job_id"])
    staging = [path for path in workspace_root.iterdir() if path.name.startswith(".ifpmic-marker-")]
    assert bool(staging) is staging_expected
    if hook in {"workspace_before_claim", "workspace_before_claim_commit", "workspace_after_claim_commit",
                "workspace_before_mkdir"}:
        assert not job_path.exists()
    elif hook == "workspace_after_mkdir":
        assert job_path.is_dir() and list(job_path.iterdir()) == []
    elif hook == "workspace_after_marker_publish":
        assert job_path.is_dir()
        assert {entry.name for entry in job_path.iterdir()} == {WORKSPACE_MARKER_NAME}
    elif hook.startswith("workspace_before_marker_") or hook.startswith("workspace_after_marker_"):
        assert job_path.is_dir() and list(job_path.iterdir()) == []
    else:
        assert job_path.is_dir()
        assert (job_path / WORKSPACE_MARKER_NAME).is_file()
    if layout_complete:
        assert {entry.name for entry in job_path.iterdir()} == {WORKSPACE_MARKER_NAME, *WORKSPACE_CHILD_NAMES}
    if ready_committed:
        recovered = _service(g4_harness, root=workspace_root, lease=1).reconcile_once(accepted["job_id"])
        assert recovered["status"] == "already_ready"
        assert _intent(g4_harness, accepted["job_id"])[0:2] == ("READY", 1)
    elif expected_state == "RESERVED":
        recovered = _service(g4_harness, root=workspace_root, lease=1).reconcile_once(accepted["job_id"])
        assert recovered["status"] == "ready"
        assert _intent(g4_harness, accepted["job_id"])[0:2] == ("READY", 1)
    else:
        # Observe expiry using PostgreSQL's clock, not a wall-clock sleep. Keep
        # the dead owner's lease identity fixed while waiting; the recovery
        # claim gets its own longer lease for durable marker/layout work.
        original = row
        assert original[2] is not None and original[3] is not None
        expiry_deadline = time.monotonic() + 5
        expired = False
        while time.monotonic() < expiry_deadline:
            current = _intent(g4_harness, accepted["job_id"])
            assert current[0:4] == original[0:4]
            with psycopg.connect(owner_dsn(g4_harness["database"])) as connection:
                expired = connection.execute(
                    "SELECT %s::timestamptz <= clock_timestamp()", (original[3],)
                ).fetchone()[0]
            if expired:
                break
            time.sleep(0.02)
        assert expired, "killed worker claim did not expire within the bounded wait"
        recovered = _service(g4_harness, root=workspace_root, lease=10).reconcile_once(accepted["job_id"])
        assert recovered["status"] == "ready"
        assert _intent(g4_harness, accepted["job_id"])[0:2] == ("READY", 2)
    assert bool([path for path in workspace_root.iterdir() if path.name.startswith(".ifpmic-marker-")]) is staging_expected
    _mark("crash_recovery")


def test_independent_worker_processes_contend_for_one_live_claim(g4_harness, workspace_root, tmp_path):
    accepted = accept_workspace_job(g4_harness)
    settings = replace(g4_harness["settings"], workspace_root=str(workspace_root),
                       workspace_lease_seconds=5, workspace_poll_seconds=1)
    config = tmp_path / "race-worker.json"
    write_workspace_settings(settings, config)
    claimed, release = tmp_path / "claimed", tmp_path / "release"
    env = {"PATH": os.environ["PATH"], "PYTHONPATH": str(Path(__file__).resolve().parents[2])}
    worker = _spawn_process(
        [sys.executable, "-c", _RACE_WORKER, str(config), accepted["job_id"], str(claimed), str(release)],
        cwd=Path(__file__).resolve().parents[2], env=env,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    try:
        deadline = time.monotonic() + 10
        while not claimed.exists() and time.monotonic() < deadline and worker.poll() is None:
            time.sleep(.01)
        assert claimed.exists() and worker.poll() is None
        contender = _spawn_process(
            [sys.executable, "-m", "services.ifpmic_api.workspace", "once"],
            stdin=subprocess.PIPE,
            cwd=Path(__file__).resolve().parents[2], env={**env, "IFPMIC_API_CONFIG": str(config)},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        contender_out, contender_err = contender.communicate(
            (json.dumps({"job_id": accepted["job_id"]}) + "\n").encode("ascii"), timeout=20)
        assert contender.returncode == 0 and contender_err == b""
        assert worker.pid != contender.pid
        assert json.loads(contender_out) == {"status": "idle", "job_id": None, "error_code": None}
        _record_process("reconciler", contender.pid, contender.returncode,
                        contender_out, contender_err, 0, tmp_path)
        global _CLI_ONCE_EXIT
        _CLI_ONCE_EXIT = contender.returncode
    finally:
        release.touch()
        try:
            stdout, stderr = worker.communicate(timeout=20)
        except subprocess.TimeoutExpired:
            worker.kill()
            stdout, stderr = worker.communicate(timeout=5)
            pytest.fail("workspace contender did not leave its bounded claim hook")
    assert worker.returncode == 0 and stderr == b""
    assert json.loads(stdout) == {"status": "ready", "job_id": accepted["job_id"], "error_code": None}
    _record_process("reconciler", worker.pid, worker.returncode, stdout, stderr, 0, tmp_path)
    assert _intent(g4_harness, accepted["job_id"])[0:2] == ("READY", 1)
    _mark("two_worker_processes")


def test_retry_error_is_explicit_and_worker_cli_is_bounded_sanitized(g4_harness, workspace_root, tmp_path):
    accepted = accept_workspace_job(g4_harness)
    job_path = _workspace_path(workspace_root, accepted["job_id"])
    job_path.mkdir(mode=0o700)
    (job_path / "untrusted").write_text("retain", encoding="utf-8")
    (job_path / "untrusted").chmod(0o600)
    service = _service(g4_harness, root=workspace_root)
    assert service.reconcile_once(accepted["job_id"])["status"] == "error"
    config = tmp_path / "worker.json"
    settings = replace(g4_harness["settings"], workspace_root=str(workspace_root),
                       workspace_lease_seconds=2, workspace_poll_seconds=1)
    write_workspace_settings(settings, config)
    assert stat.S_IMODE(config.stat().st_mode) == 0o600
    env = {"PATH": os.environ["PATH"], "IFPMIC_API_CONFIG": str(config),
           "PYTHONPATH": str(Path(__file__).resolve().parents[2])}
    command = [sys.executable, "-m", "services.ifpmic_api.workspace", "retry-error"]
    response = _spawn_process(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=env, cwd=Path(__file__).resolve().parents[2])
    response_out, response_err = response.communicate((json.dumps({"job_id": accepted["job_id"]}) + "\n").encode(), timeout=20)
    assert response.returncode == 0 and response_err == b""
    assert response_out == (json.dumps({"status": "retry_queued", "job_id": accepted["job_id"],
                                           "error_code": None}, sort_keys=True,
                                          separators=(",", ":")) + "\n").encode()
    assert (job_path / "untrusted").read_text(encoding="utf-8") == "retain"
    invalid = _spawn_process(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               env=env, cwd=Path(__file__).resolve().parents[2])
    invalid_out, invalid_err = invalid.communicate(b'{"job_id":"../../secret"}\n', timeout=20)
    assert invalid.returncode == 2 and invalid_err == b""
    assert invalid_out == b'{"error_code":"WORKSPACE_INVALID_REQUEST","job_id":null,"status":"invalid_request"}\n'
    _record_process("reconciler", response.pid, response.returncode, response_out, response_err, 0, tmp_path)
    _record_process("reconciler", invalid.pid, invalid.returncode, invalid_out, invalid_err, 2, tmp_path)


def test_worker_cli_rejects_malformed_requests_without_leaking_private_data(
    g4_harness, workspace_root, tmp_path,
):
    config = tmp_path / "cli-matrix.json"
    settings = replace(g4_harness["settings"], workspace_root=str(workspace_root))
    write_workspace_settings(settings, config)
    root = Path(__file__).resolve().parents[2]
    base_env = {"PATH": os.environ["PATH"], "PYTHONPATH": str(root),
                "IFPMIC_API_CONFIG": str(config)}
    invalid_inputs = [
        b'{"job_id":"00000000-0000-4000-8000-000000000001","job_id":"00000000-0000-4000-8000-000000000002"}\n',
        b'{"job_id":"00000000-0000-4000-8000-000000000001","extra":true}\n',
        b'{"job_id":"00000000-0000-4000-8000-000000000001"',
        b'{"job_id":NaN}\n',
        b'{"job_id":"../../' + _PRIVATE_CANARY.encode("ascii") + b'"}\n',
        b"\xff\xfe\n",
        b" " * 65537,
    ]
    for raw in invalid_inputs:
        process = _spawn_process(
            [sys.executable, "-m", "services.ifpmic_api.workspace", "once"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=root, env=base_env,
        )
        stdout, stderr = process.communicate(raw, timeout=15)
        assert process.returncode == 2
        assert stdout == b'{"error_code":"WORKSPACE_INVALID_REQUEST","job_id":null,"status":"invalid_request"}\n'
        assert stderr == b"" and _PRIVATE_CANARY.encode() not in stdout + stderr
        _record_process("reconciler", process.pid, process.returncode, stdout, stderr, 2, tmp_path)

    # The inclusive 65,536-byte limit accepts a valid empty request padded with JSON whitespace.
    exact_limit = b"{}" + b" " * (65536 - 2)
    assert len(exact_limit) == 65536
    process = _spawn_process(
        [sys.executable, "-m", "services.ifpmic_api.workspace", "once"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=root, env=base_env,
    )
    stdout, stderr = process.communicate(exact_limit, timeout=15)
    assert process.returncode == 0 and stderr == b""
    assert stdout == b'{"error_code":null,"job_id":null,"status":"idle"}\n'
    _record_process("reconciler", process.pid, process.returncode, stdout, stderr, 0, tmp_path)

    malformed_config = tmp_path / "malformed-worker.json"
    descriptor = os.open(malformed_config, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    with os.fdopen(descriptor, "wb") as target:
        target.write(b'{"unknown":"private"}\n')
    process = _spawn_process(
        [sys.executable, "-m", "services.ifpmic_api.workspace", "once"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=root, env={**base_env, "IFPMIC_API_CONFIG": str(malformed_config)},
    )
    stdout, stderr = process.communicate(b"{}\n", timeout=15)
    assert process.returncode == 2 and stderr == b""
    assert stdout == b'{"error_code":"WORKSPACE_INVALID_REQUEST","job_id":null,"status":"invalid_request"}\n'
    _record_process("reconciler", process.pid, process.returncode, stdout, stderr, 2, tmp_path)

    accepted = accept_workspace_job(g4_harness, key="g5-cli-fixed-error")
    workspace_root.chmod(0o755)
    process = _spawn_process(
        [sys.executable, "-m", "services.ifpmic_api.workspace", "once"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=root, env=base_env,
    )
    stdout, stderr = process.communicate(
        (json.dumps({"job_id": accepted["job_id"]}) + "\n").encode("ascii"), timeout=15)
    assert process.returncode == 3 and stderr == b""
    assert stdout == b'{"error_code":"WORKSPACE_UNSAFE","job_id":null,"status":"error"}\n'
    assert _intent(g4_harness, accepted["job_id"])[0:2] == ("RESERVED", 0)
    workspace_root.chmod(0o700)
    _record_process("reconciler", process.pid, process.returncode, stdout, stderr, 3, tmp_path)
    _mark_additional("cli_fixed_error_exit_mapping")

    missing_config_env = {"PATH": os.environ["PATH"], "PYTHONPATH": str(root)}
    process = _spawn_process(
        [sys.executable, "-m", "services.ifpmic_api.workspace", "once"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=root, env=missing_config_env,
    )
    stdout, stderr = process.communicate(b"{}\n", timeout=15)
    assert process.returncode == 2 and stderr == b""
    assert stdout == b'{"error_code":"WORKSPACE_INVALID_REQUEST","job_id":null,"status":"invalid_request"}\n'
    _record_process("reconciler", process.pid, process.returncode, stdout, stderr, 2, tmp_path)

    invalid_argv = _spawn_process(
        [sys.executable, "-m", "services.ifpmic_api.workspace", "once", "extra"],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=root, env=missing_config_env,
    )
    stdout, stderr = invalid_argv.communicate(timeout=15)
    assert invalid_argv.returncode == 2 and stderr == b""
    assert stdout == b'{"error_code":"WORKSPACE_INVALID_REQUEST","job_id":null,"status":"invalid_request"}\n'
    _record_process("reconciler", invalid_argv.pid, invalid_argv.returncode, stdout, stderr, 2, tmp_path)
    assert list(workspace_root.iterdir()) == []
    _mark_additional("cli_parser_failclosed_matrix")


def test_worker_cli_run_stops_cleanly_on_sigterm(g4_harness, workspace_root, tmp_path):
    accepted = accept_workspace_job(g4_harness, key="g5-worker-run-ready")
    before = workspace_rows(g4_harness, accepted["job_id"])
    settings = replace(g4_harness["settings"], workspace_root=str(workspace_root),
                       workspace_lease_seconds=2, workspace_poll_seconds=1)
    config = tmp_path / "run-worker.json"
    write_workspace_settings(settings, config)
    env = {"PATH": os.environ["PATH"], "PYTHONPATH": str(Path(__file__).resolve().parents[2]),
           "IFPMIC_API_CONFIG": str(config)}
    process = _spawn_process(
        [sys.executable, "-m", "services.ifpmic_api.workspace", "run"],
        cwd=Path(__file__).resolve().parents[2], env=env,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    deadline = time.monotonic() + 10
    row = _intent(g4_harness, accepted["job_id"])
    while row[0] != "READY" and time.monotonic() < deadline and process.poll() is None:
        time.sleep(.02)
        row = _intent(g4_harness, accepted["job_id"])
    assert row[0:2] == ("READY", 1) and process.poll() is None
    process.send_signal(signal.SIGTERM)
    stdout, stderr = process.communicate(timeout=20)
    assert stdout == b'{"error_code":null,"job_id":null,"status":"stopped"}\n'
    assert stderr == b""
    _record_process("cli_run", process.pid, process.returncode, stdout, stderr, 0, tmp_path)
    _assert_acceptance_group_unchanged(before, workspace_rows(g4_harness, accepted["job_id"]))
    _mark("cli_run_shutdown")


def test_ready_commit_ack_loss_is_uncertain_but_fresh_read_resolves(g4_harness, workspace_root):
    accepted = accept_workspace_job(g4_harness)

    class CommitAckLostConnection:
        def __init__(self, connection, number):
            self.connection = connection
            self.number = number
        def __enter__(self):
            self.connection.__enter__()
            return self
        def __exit__(self, *args):
            return self.connection.__exit__(*args)
        def execute(self, *args, **kwargs):
            return self.connection.execute(*args, **kwargs)
        def transaction(self):
            from contextlib import contextmanager
            @contextmanager
            def transaction_then_lose_ack():
                with self.connection.transaction():
                    yield self
                if self.number == 3:
                    raise RuntimeError(_PRIVATE_CANARY)
            return transaction_then_lose_ack()

    counter = {"connections": 0}
    def db_factory():
        counter["connections"] += 1
        connection = psycopg.connect(runtime_dsn(g4_harness["database"]), autocommit=True)
        return CommitAckLostConnection(connection, counter["connections"])

    settings = replace(g4_harness["settings"], workspace_root=str(workspace_root),
                       workspace_lease_seconds=2, workspace_poll_seconds=1)
    service = WorkspaceService(settings, db_factory=db_factory)
    result = service.reconcile_once(accepted["job_id"])
    assert result == {"status": "commit_uncertain", "job_id": accepted["job_id"],
                      "error_code": "WORKSPACE_COMMIT_UNCERTAIN"}
    assert _intent(g4_harness, accepted["job_id"])[0] == "READY"
    assert _service(g4_harness, root=workspace_root).reconcile_once(accepted["job_id"])["status"] == "already_ready"
    _mark("controlled_ready_ack_loss")


def test_two_accepted_jobs_get_independent_workspace_identities_across_users_and_projects(
    g4_harness, workspace_root, tmp_path,
):
    first = accept_workspace_job(g4_harness, key="g5-isolation-a")
    first_before = workspace_rows(g4_harness, first["job_id"])
    other_project = "g5-isolated-project-b"
    other_version = "g5-isolated-profile-v1"
    seed_profile_store(g4_harness["store_root"], other_project, other_version)
    other_record = capture_snapshot(g4_harness["store_root"], other_project, other_version)
    _, other_eligibility = seed_catalog_and_eligibility(
        g4_harness["database"], other_record,
        granted_at=g4_harness["clock"]() - timedelta(days=1),
        expires_at=g4_harness["clock"]() + timedelta(days=10),
    )
    _, other_client = client_with(g4_harness)
    # client_with intentionally seeds the current session; this second identity must
    # start from a genuinely unauthenticated cookie jar.
    other_client.cookies.clear()
    assert len(other_client.cookies) == 0
    try:
        other_user, other_session, other_csrf = login(
            other_client, g4_harness["provider"], g4_harness["clock"], subject="g5-isolated-user-b")
        assert [cookie.name for cookie in other_client.cookies.jar] == ["ax_session"]
        seed_membership(g4_harness["database"], other_project, other_user)
        other_harness = {
            **g4_harness, "client": other_client, "project_id": other_project,
            "profile_version": other_version, "record": other_record,
            "eligibility_id": other_eligibility, "user_id": other_user,
            "session": other_session, "csrf": other_csrf,
        }
        second = accept_workspace_job(other_harness, key="g5-isolation-b")
        cross_read = other_client.get(f"/api/v1/jobs/{first['job_id']}")
        assert cross_read.status_code == 403
        reverse_cross_read = g4_harness["client"].get(f"/api/v1/jobs/{second['job_id']}")
        assert reverse_cross_read.status_code == 403
        second_before = workspace_rows(other_harness, second["job_id"])
    finally:
        other_client.close()
    service = _service(g4_harness, root=workspace_root)
    selected = service.reconcile_once()
    assert selected["status"] == "ready"
    expected_first = min(first["job_id"], second["job_id"])
    assert selected["job_id"] == expected_first
    next_job = second["job_id"] if expected_first == first["job_id"] else first["job_id"]
    assert service.reconcile_once(next_job)["status"] == "ready"
    a, b = _intent(g4_harness, first["job_id"]), _intent(g4_harness, second["job_id"])
    assert a[0] == b[0] == "READY"
    assert a[1] == b[1] == 1
    assert first["job_id"] != second["job_id"]
    assert (_workspace_path(workspace_root, first["job_id"]) / WORKSPACE_MARKER_NAME).read_bytes() == expected_marker_bytes(
        first["job_id"], first["initial_row"][10])
    assert (_workspace_path(workspace_root, second["job_id"]) / WORKSPACE_MARKER_NAME).read_bytes() == expected_marker_bytes(
        second["job_id"], second["initial_row"][10])
    assert first["initial_row"][10] != second["initial_row"][10]
    assert first["payload"]["project_id"] != second["payload"]["project_id"]
    _assert_acceptance_group_unchanged(first_before, workspace_rows(g4_harness, first["job_id"]))
    # Query the second identity with its own harness after its client has closed; the owner
    # connection remains a direct DB oracle, and the acceptance group must still be exact.
    second_owner = {**g4_harness, "database": g4_harness["database"]}
    _assert_acceptance_group_unchanged(second_before, workspace_rows(second_owner, second["job_id"]))
    _mark("two_jobs_isolated")
    _mark_additional("cross_project_reads_both_directions_denied")


def test_orphan_workspace_is_ignored_and_not_adopted(g4_harness, workspace_root):
    orphan_id = "4a6db73e-70b8-4db7-a719-e5822a282314"
    orphan = workspace_root / orphan_id
    orphan.mkdir(mode=0o700)
    sentinel = orphan / "operator-data.txt"
    sentinel.write_text("preserved", encoding="utf-8")
    sentinel.chmod(0o600)
    before = tree_fingerprint(workspace_root)
    result = _service(g4_harness, root=workspace_root).reconcile_once()
    assert result["status"] == "idle"
    assert tree_fingerprint(workspace_root) == before


def test_g5_observation_is_written_only_after_required_assertions(tmp_path):
    expected = {
        "two_jobs_isolated", "durable_layout", "active_claim_excluded", "malformed_claim_no_fs",
        "stale_claim_fenced", "two_worker_processes", "crash_recovery", "unsafe_entries_preserved",
        "controlled_enospc", "controlled_ready_ack_loss", "ready_db_only", "g4_acceptance_preserved",
    }
    assert set(_OBSERVED_CASES) == expected | {"cli_run_shutdown"}
    assert _OBSERVED_CASES and all(value is True for value in _OBSERVED_CASES.values())
    assert _PROCESS_RECORDS and all(record["pid_alive"] is False for record in _PROCESS_RECORDS)
    assert _ADDITIONAL_CASES and all(value is True for value in _ADDITIONAL_CASES.values())
    identities = [(row["process_identity"]["pid"], row["process_identity"]["start_ticks"])
                  for row in _PROCESS_RECORDS]
    assert len(identities) == len(set(identities))
    assert _PROCESS_IDENTITIES == {}
    assert _CLI_ONCE_EXIT == 0
    assert sum(record["role"] == "reconciler" for record in _PROCESS_RECORDS) >= 2
    assert all(_PRIVATE_CANARY.encode() not in json.dumps(record).encode() for record in _PROCESS_RECORDS)
    path = os.environ.get("IFPMIC_WORKSPACE_TEST_OBSERVATION_PATH")
    if not path:
        return
    destination = Path(path)
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    destination.parent.chmod(0o700)
    cases = {key: True for key in sorted(expected)}
    cases.update({"cli_once": _CLI_ONCE_EXIT, "cli_run_shutdown": 0})
    assert {record["role"] for record in _PROCESS_RECORDS} >= {"cli_run", "crash_worker", "reconciler"}
    observation = {
        "kind": "ifpmic.g5.runtime-observation.v1",
        "cases": cases,
        "additional_cases": dict(sorted(_ADDITIONAL_CASES.items())),
        "processes": _PROCESS_RECORDS,
        "no_canaries": True,
        "limitations": ["controlled OSError and commit-hook ack loss; no physical power-loss claim"],
    }
    payload = (json.dumps(observation, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    with os.fdopen(descriptor, "wb") as target:
        target.write(payload)
    assert stat.S_IMODE(destination.stat().st_mode) == 0o600
