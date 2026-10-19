"""Read-only H2 validation of G5 READY workspace state."""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from services.ifpmic_api.execution_workspace import ReadyWorkspace
from services.ifpmic_api.workspace_fs import WorkspaceError

JOB_ID = "11111111-1111-4111-8111-111111111111"
WORKSPACE_TOKEN = "22222222-2222-4222-8222-222222222222"
WRONG_TOKEN = "33333333-3333-4333-8333-333333333333"
WORKSPACE_CHILDREN = ("source", "tc", "artifacts", "build")
WORKSPACE_MARKER = ".ifpmic-workspace.json"


def _marker_bytes(job_id: str, workspace_token: str) -> bytes:
    return (
        json.dumps(
            {"format": "ifpmic.workspace.v1", "job_id": job_id,
             "workspace_token": workspace_token},
            ensure_ascii=True, sort_keys=True, separators=(",", ":"),
        )
        + "\n"
    ).encode("ascii")


def _make_workspace(
    root: Path,
    *,
    marker: bool = True,
    token: str = WORKSPACE_TOKEN,
    missing_child: str | None = None,
) -> tuple[Path, Path]:
    root.mkdir(mode=0o700)
    job = root / JOB_ID
    job.mkdir(mode=0o700)
    for child in WORKSPACE_CHILDREN:
        if child != missing_child:
            (job / child).mkdir(mode=0o700)
    if marker:
        path = job / WORKSPACE_MARKER
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(_marker_bytes(JOB_ID, token))
    return root, job


def _snapshot(root: Path) -> tuple[tuple[object, ...], ...]:
    rows: list[tuple[object, ...]] = []

    def visit(directory: Path) -> None:
        for path in sorted(directory.iterdir(), key=lambda item: item.name):
            info = path.lstat()
            mode = stat.S_IMODE(info.st_mode)
            if stat.S_ISLNK(info.st_mode):
                payload: object = os.readlink(path)
            elif stat.S_ISREG(info.st_mode):
                payload = path.read_bytes()
            else:
                payload = None
            rows.append((
                path.relative_to(root).as_posix(), info.st_dev, info.st_ino,
                info.st_uid, mode, info.st_mtime_ns, info.st_ctime_ns, payload,
            ))
            if stat.S_ISDIR(info.st_mode):
                visit(path)

    visit(root)
    return tuple(rows)


def test_ready_workspace_validation_is_read_only_and_preserves_snapshot(tmp_path: Path):
    root, _job = _make_workspace(tmp_path / "valid-root")
    before = _snapshot(root)

    assert ReadyWorkspace(str(root)).validate_ready(JOB_ID, WORKSPACE_TOKEN) is None
    assert _snapshot(root) == before


def test_missing_marker_and_child_are_rejected_without_repair(tmp_path: Path):
    missing_marker_root, missing_marker_job = _make_workspace(
        tmp_path / "missing-marker-root", marker=False,
    )
    before_marker = _snapshot(missing_marker_root)
    with pytest.raises(WorkspaceError) as missing_marker:
        ReadyWorkspace(str(missing_marker_root)).validate_ready(JOB_ID, WORKSPACE_TOKEN)
    assert missing_marker.value.code == "WORKSPACE_UNSAFE"
    assert not (missing_marker_job / WORKSPACE_MARKER).exists()
    assert _snapshot(missing_marker_root) == before_marker

    missing_child_root, missing_child_job = _make_workspace(
        tmp_path / "missing-child-root", missing_child="source",
    )
    before_child = _snapshot(missing_child_root)
    with pytest.raises(WorkspaceError) as missing_child:
        ReadyWorkspace(str(missing_child_root)).validate_ready(JOB_ID, WORKSPACE_TOKEN)
    assert missing_child.value.code == "WORKSPACE_UNSAFE"
    assert not (missing_child_job / "source").exists()
    assert _snapshot(missing_child_root) == before_child


def test_wrong_workspace_token_is_rejected_without_mutation(tmp_path: Path):
    root, _job = _make_workspace(tmp_path / "wrong-token-root")
    before = _snapshot(root)

    with pytest.raises(WorkspaceError) as raised:
        ReadyWorkspace(str(root)).validate_ready(JOB_ID, WRONG_TOKEN)

    assert raised.value.code == "WORKSPACE_UNSAFE"
    assert _snapshot(root) == before


def test_symlink_child_is_rejected_without_following_or_repair(tmp_path: Path):
    root, job = _make_workspace(tmp_path / "symlink-root")
    outside = tmp_path / "outside"
    outside.mkdir(mode=0o700)
    link = job / "source"
    link.rmdir()
    link.symlink_to(outside, target_is_directory=True)
    before = _snapshot(root)

    with pytest.raises(WorkspaceError) as raised:
        ReadyWorkspace(str(root)).validate_ready(JOB_ID, WORKSPACE_TOKEN)

    assert raised.value.code == "WORKSPACE_UNSAFE"
    assert link.is_symlink()
    assert _snapshot(root) == before
    assert _snapshot(outside) == ()
    assert outside.exists()


def test_nonprivate_child_mode_is_rejected_without_chmod_repair(tmp_path: Path):
    root, job = _make_workspace(tmp_path / "mode-root")
    child = job / "source"
    child.chmod(0o755)
    before = _snapshot(root)

    with pytest.raises(WorkspaceError) as raised:
        ReadyWorkspace(str(root)).validate_ready(JOB_ID, WORKSPACE_TOKEN)

    assert raised.value.code == "WORKSPACE_UNSAFE"
    assert stat.S_IMODE(child.stat().st_mode) == 0o755
    assert _snapshot(root) == before


def test_nonempty_h2_workspace_child_is_rejected_without_deletion(tmp_path: Path):
    root, job = _make_workspace(tmp_path / "nonempty-root")
    payload = job / "source" / "keep.txt"
    payload.write_bytes(b"synthetic H2 workspace content")
    payload.chmod(0o600)
    before = _snapshot(root)

    with pytest.raises(WorkspaceError) as raised:
        ReadyWorkspace(str(root)).validate_ready(JOB_ID, WORKSPACE_TOKEN)

    assert raised.value.code == "WORKSPACE_UNSAFE"
    assert payload.read_bytes() == b"synthetic H2 workspace content"
    assert _snapshot(root) == before
