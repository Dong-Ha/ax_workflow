"""Test-only cleanup integration; never selects a production runtime mode."""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
import json
import math
import os
from pathlib import Path
import stat
import sys
import threading
import time


CONTROLLER_ATTRIBUTE = "_ifpmic_h2_cleanup_controller"


def ordered_attempt_snapshot(snapshot):
    """Order observed rows only; preserve every generation/result/run field."""
    rows = snapshot["attempts"]
    assert all(type(row[0]) is int and row[0] > 0 for row in rows)
    assert len({row[0] for row in rows}) == len(rows)
    return {**snapshot, "attempts": sorted(rows, key=lambda row: row[0])}


@contextmanager
def installed_controller(config, active):
    marker = object()
    previous = getattr(config, CONTROLLER_ATTRIBUTE, marker)
    if previous is not marker:
        raise RuntimeError("H2 cleanup controller already installed")
    setattr(config, CONTROLLER_ATTRIBUTE, active)
    try:
        yield
    finally:
        delattr(config, CONTROLLER_ATTRIBUTE)



def restore_preserving_error(restore):
    """Always restore, retaining an already propagating primary exception."""
    primary = sys.exc_info()[1]
    try:
        restore()
    except BaseException as secondary:
        if primary is None:
            raise
        primary.add_note("H2 deadline restore also failed: " + type(secondary).__name__)


def controller(config):
    return getattr(config, CONTROLLER_ATTRIBUTE, None)


def remaining(config, maximum):
    active = controller(config)
    result = float(maximum) if active is None else active.cleanup_remaining(maximum)
    if not math.isfinite(result) or result <= 0:
        raise TimeoutError("H2 fixture cleanup budget exhausted")
    return result


def record(config, event, **values):
    active = controller(config)
    if active is None:
        return
    root = Path(os.environ["IFPMIC_H2_RUNTIME_EVIDENCE_ROOT"])
    info = root.lstat()
    if (not root.is_absolute() or root.is_symlink() or not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700):
        raise ValueError("H2 private fixture evidence root invalid")
    raw = json.dumps({"event": event, "nodeid": active.nodeid,
                      "monotonic": time.monotonic(), **values},
                     sort_keys=True, separators=(",", ":"), allow_nan=False).encode("ascii") + b"\n"
    fd = os.open(root / "fixture-cleanup.jsonl",
                 os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        current = os.fstat(fd)
        if (not stat.S_ISREG(current.st_mode) or current.st_uid != os.getuid()
                or stat.S_IMODE(current.st_mode) != 0o600 or current.st_nlink != 1):
            raise ValueError("H2 private fixture journal invalid")
        view = memoryview(raw)
        while view:
            size = os.write(fd, view)
            if size <= 0:
                raise OSError("H2 fixture journal short write")
            view = view[size:]
        os.fsync(fd)
    finally:
        os.close(fd)


def process_start_ticks(pid):
    """Unreadable process metadata is an error, not evidence of absence."""
    try:
        raw = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    except FileNotFoundError:
        return None
    fields = raw[raw.rfind(")") + 2:].split()
    if len(fields) < 20 or not fields[19].isdecimal():
        raise ValueError("H2 process identity unreadable")
    return fields[19]


def record_finalizer(config, event, **values):
    primary = sys.exc_info()[0] is not None
    try:
        record(config, event, **values)
    except BaseException:
        if not primary:
            raise


@contextmanager
def managed_test_client(client, app, config):
    """Quiesce H2 maintenance during setup; close the real context under its clock."""
    active = controller(config)
    if active is None:
        with client:
            yield client
        return
    entered = False
    portal_thread = None
    try:
        client.__enter__()
        entered = True
        portal = client.portal
        portal_ident = portal._event_loop_thread_id
        portal_thread = next(thread for thread in threading.enumerate()
                             if thread.ident == portal_ident)

        async def quiesce():
            task = app.state.maintenance_task
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            if not task.done():
                raise RuntimeError("H2 maintenance task not quiescent")

        # This belongs to setup/body, not a fresh cleanup allowance.
        portal.start_task_soon(quiesce).result(timeout=active.remaining(10))
        record(config, "maintenance_quiesced", portal_thread_ident=portal_ident)
        yield client
    finally:
        if entered:
            primary = sys.exc_info()[0] is not None
            errors = []

            def close():
                try:
                    client.__exit__(None, None, None)
                except BaseException as error:
                    errors.append(type(error).__name__)

            helper = threading.Thread(target=close, name="ifpmic-h2-client-close", daemon=True)
            # Retain handles even when a deadline forces the case to fail.
            client._ifpmic_h2_cleanup_threads = (helper, portal_thread)
            cleanup_error = None
            try:
                timeout = remaining(config, 10)
                helper.start()
                helper.join(timeout=timeout)
                if helper.is_alive() or portal_thread is None or portal_thread.is_alive() or errors:
                    raise RuntimeError("H2 TestClient shutdown unconfirmed")
            except BaseException as error:
                cleanup_error = error
            try:
                record(config, "testclient_closed",
                       helper_thread_ident=helper.ident, helper_alive=helper.is_alive(),
                       portal_thread_ident=None if portal_thread is None else portal_thread.ident,
                       portal_alive=None if portal_thread is None else portal_thread.is_alive(),
                       errors=errors, status="failed" if cleanup_error is not None else "stopped")
            except BaseException as error:
                if cleanup_error is None:
                    cleanup_error = error
            if cleanup_error is not None and not primary:
                raise cleanup_error
