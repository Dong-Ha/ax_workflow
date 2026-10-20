"""Prerequisite regressions for bounded H2 fixture cleanup semantics."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import hashlib
import json
import os
from pathlib import Path
import sys
import threading

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

pytest_plugins = ("tests.ifpmic_api.h2_fixture_failure_case_budget",)

from tests.ifpmic_api import h2_fixture_cleanup as cleanup
from tests.ifpmic_api import h2_dispatcher_crash_support as crash
from tests.ifpmic_api import oidc_provider
from tests.ifpmic_api.oidc_provider import SyntheticOIDCProvider
from tests.ifpmic_api import test_h2_runtime_normal_flow as normal
from tests.ifpmic_api.h2_snapshot_evidence import record_query_observation


def _deadline(request):
    value = getattr(request.node, "_ifpmic_h2_fixture_failure_deadline", None)
    if value is None:
        pytest.fail("the exact fixture-failure whole-case watchdog is required")
    return value


def test_restore_error_keeps_exact_primary_and_notes_secondary(request):
    _deadline(request)
    primary = LookupError("primary sentinel")
    secondary = OSError("secondary sentinel")

    try:
        raise primary
    except LookupError as caught:
        assert caught is primary
        cleanup.restore_preserving_error(lambda: (_ for _ in ()).throw(secondary))
        assert caught is primary
        assert caught.__notes__ == ["H2 deadline restore also failed: OSError"]
        record_query_observation("fixture.restore_preserving_error", request.node.nodeid,
                                 {"primary_object_id": id(primary), "caught_object_id": id(caught),
                                  "primary_type": type(primary).__qualname__,
                                  "secondary_type": type(secondary).__qualname__,
                                  "notes": caught.__notes__})


def test_restore_only_failure_escapes_by_identity(request):
    _deadline(request)
    expected = RuntimeError("restore sentinel")
    with pytest.raises(RuntimeError) as caught:
        cleanup.restore_preserving_error(lambda: (_ for _ in ()).throw(expected))
    assert caught.value is expected
    record_query_observation("fixture.restore_only_failure", request.node.nodeid,
                             {"expected_object_id": id(expected),
                              "caught_object_id": id(caught.value),
                              "caught_type": type(caught.value).__qualname__})


class _OwnedProcessProbe:
    pid = 74991
    _ifpmic_start_ticks = "saved-test-identity"

    def __init__(self):
        self.actions = []

    def poll(self):
        return None

    def send_signal(self, sig):
        self.actions.append("signal")

    def wait(self, timeout):
        self.actions.append(("wait", timeout))


class _ExhaustedCleanupController:
    def __init__(self):
        self.remaining_checks = 0

    def cleanup_remaining(self, maximum):
        self.remaining_checks += 1
        raise TimeoutError("injected exhausted shared cleanup epoch")


def test_expired_cleanup_budget_performs_no_new_lifecycle_action(request, monkeypatch):
    deadline = _deadline(request)
    assert deadline.body_seconds == 25 and deadline.cleanup_seconds == 5
    # Keep the installed case watchdog's real 25+5 epoch intact. Inject only
    # the exhausted cleanup callback consumed by cleanup_case.
    exhausted = _ExhaustedCleanupController()
    owned = _OwnedProcessProbe()
    case_key = hashlib.sha256(request.node.nodeid.encode("utf-8")).hexdigest()[:16]
    root = normal._runtime_evidence_root() / ("cleanup-fallback-probe-" + case_key)
    root.mkdir(mode=0o700)
    root.chmod(0o700)
    journal = root / "process-journal.jsonl"
    normal._create_private_journal(journal)
    record = {"role": "injected-owned-handle", "pid": owned.pid}
    case = {"cleanup_controller": exhausted, "barriers": [], "processes": [owned],
            "records": [record], "journal": journal, "root": root}

    def fail_stop_all_owned(_processes, *, total_timeout):
        raise TimeoutError("injected bounded stop_all_owned failure")

    identity_lookups = []

    def matching_saved_identity(pid):
        identity_lookups.append(pid)
        return owned._ifpmic_start_ticks if pid == owned.pid else None

    monkeypatch.setattr(crash.normal, "stop_all_owned", fail_stop_all_owned)
    monkeypatch.setattr(crash.normal, "process_identity", matching_saved_identity)
    with pytest.raises(AssertionError, match="owned-process cleanup evidence"):
        crash.cleanup_case(case)

    assert exhausted.remaining_checks >= 2
    assert deadline.cleanup_timeout is False
    assert owned.actions == []
    assert identity_lookups == []
    assert case["processes"][0] is owned
    outcome = json.loads((root / "process-cleanup.json").read_text(encoding="ascii"))
    assert outcome["processes"] == [{"role": "injected-owned-handle", "pid": owned.pid,
                                    "returncode": None, "forced": False, "absent": False}]
    record_query_observation("fixture.exhausted_cleanup", request.node.nodeid,
                             {"synthetic_process_probe": True, "actions": owned.actions,
                              "identity_lookups": identity_lookups,
                              "remaining_checks": exhausted.remaining_checks,
                              "retained_same_object": case["processes"][0] is owned,
                              "physical_process_absence_proven": False})


def test_partial_oidc_start_fails_closed_for_unstarted_thread_handle(
    request, monkeypatch,
):
    deadline = _deadline(request)
    provider = SyntheticOIDCProvider()
    original_thread = threading.Thread
    starts = 0
    close_attempted = False

    class FailSecondStartThread(original_thread):
        def start(self):
            nonlocal starts
            starts += 1
            if starts == 2:
                raise RuntimeError("injected second serving-thread start failure")
            return super().start()

    try:
        with monkeypatch.context() as patch:
            patch.setattr(oidc_provider.threading, "Thread", FailSecondStartThread)
            with pytest.raises(RuntimeError, match="second serving-thread start failure"):
                provider.start()
        assert len(provider._servers) == 2
        assert len(provider._threads) == 2
        sockets = [server.socket for server in provider._servers]
        started = tuple(provider._threads)
        assert all(sock.fileno() >= 0 for sock in sockets)
        assert started[0].ident is not None and started[0].is_alive()
        assert started[1].ident is None and not started[1].is_alive()
        record_query_observation("fixture.partial_oidc_start.before_close", request.node.nodeid,
                                 {"socket_fds": [sock.fileno() for sock in sockets],
                                  "threads": [{"ident": thread.ident, "alive": thread.is_alive()}
                                              for thread in started]})
        cleanup.record(request.config, "partial_oidc_start_owned_handles",
                       socket_count=len(sockets), registered_thread_count=len(started),
                       started_thread_count=1, unstarted_thread_count=1,
                       status="owned")
        deadline.begin_cleanup()
        close_attempted = True
        with pytest.raises(RuntimeError, match="H2 OIDC shutdown unconfirmed"):
            provider.close(remaining_time=lambda maximum: cleanup.remaining(request.config, maximum))
        assert all(sock.fileno() == -1 for sock in sockets)
        assert all(not thread.is_alive() for thread in started)
        assert started[1].ident is None and started[1] in provider._threads
        assert len(provider._servers) == 2 and len(provider._threads) == 2
        saved = tuple(getattr(provider, "_last_h2_threads", ()))
        assert saved and started[1] in saved and all(not thread.is_alive() for thread in saved)
        record_query_observation("fixture.partial_oidc_start.after_close", request.node.nodeid,
                                 {"socket_fds": [sock.fileno() for sock in sockets],
                                  "threads": [{"ident": thread.ident, "alive": thread.is_alive()}
                                              for thread in saved],
                                  "unstarted_handle_retained": started[1] in saved,
                                  "ownership_status": "unknown"})
        cleanup.record(request.config, "partial_oidc_start_finalized",
                       socket_count=len(sockets), started_thread_count=len(started),
                       saved_thread_count=len(saved), unstarted_thread_retained=True,
                       ownership_status="unknown", status="failed_closed")
    finally:
        primary = sys.exc_info()[1]
        if provider._servers and not close_attempted:
            if deadline.cleanup_at is None:
                deadline.begin_cleanup()
            try:
                provider.close(remaining_time=lambda maximum: cleanup.remaining(request.config, maximum))
            except BaseException as error:
                cleanup.record(request.config, "partial_oidc_start_finalizer_failed",
                               server_count=len(provider._servers),
                               serving_thread_count=len(provider._threads),
                               error_type=type(error).__name__, ownership_status="unknown")
                if primary is None:
                    raise
                primary.add_note("partial OIDC provider cleanup also failed: " + type(error).__name__)


@asynccontextmanager
async def _app_lifespan(app):
    app.state.maintenance_task = asyncio.create_task(asyncio.sleep(3600))
    try:
        yield
    finally:
        task = app.state.maintenance_task
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


def test_unconfirmed_testclient_exit_records_unknown_ownership(request, monkeypatch):
    deadline = _deadline(request)
    app = FastAPI(lifespan=_app_lifespan)
    client = TestClient(app, base_url="http://testserver")
    original_exit = client.__exit__
    entered_exit = threading.Event()
    release_exit = threading.Event()

    def held_exit(*args, **kwargs):
        entered_exit.set()
        if not release_exit.wait(timeout=3):
            raise TimeoutError("test exit release gate expired")
        return original_exit(*args, **kwargs)

    monkeypatch.setattr(client, "__exit__", held_exit)
    real_thread_start = threading.Thread.start

    def start_close_then_ack(thread, *args, **kwargs):
        result = real_thread_start(thread, *args, **kwargs)
        if thread.name == "ifpmic-h2-client-close":
            assert entered_exit.wait(timeout=0.25)
        return result

    monkeypatch.setattr(threading.Thread, "start", start_close_then_ack)
    real_remaining = cleanup.remaining
    monkeypatch.setattr(
        cleanup, "remaining",
        lambda config, maximum: real_remaining(config, min(float(maximum), 0.5)),
    )
    try:
        with pytest.raises(RuntimeError, match="TestClient shutdown unconfirmed"):
            with cleanup.managed_test_client(client, app, request.config):
                deadline.begin_cleanup()
        assert entered_exit.is_set()
        helper, portal = client._ifpmic_h2_cleanup_threads
        assert helper.ident is not None and helper.is_alive()
        lines = (Path(os.environ["IFPMIC_H2_RUNTIME_EVIDENCE_ROOT"]) /
                 "fixture-cleanup.jsonl").read_text(encoding="ascii").splitlines()
        entries = [json.loads(line) for line in lines]
        records = [item for item in entries
                   if item.get("nodeid") == request.node.nodeid
                   and item.get("event") == "testclient_closed"]
        assert records and records[-1]["status"] == "failed"
        assert records[-1]["helper_alive"] is True
        assert records[-1]["helper_thread_ident"] == helper.ident
        record_query_observation("fixture.testclient.unconfirmed_exit", request.node.nodeid,
                                 {"helper_ident": helper.ident, "helper_alive": helper.is_alive(),
                                  "portal_ident": portal.ident, "portal_alive": portal.is_alive(),
                                  "close_record": records[-1], "ownership_status": "unknown"})
        cleanup.record(request.config, "testclient_exit_unconfirmed",
                       helper_alive=True, helper_thread_ident=helper.ident,
                       portal_thread_ident=portal.ident, ownership_status="unknown")
    finally:
        release_exit.set()
        monkeypatch.setattr(cleanup, "remaining", real_remaining)
        handles = getattr(client, "_ifpmic_h2_cleanup_threads", ())
        if handles:
            helper, portal = handles
            helper.join(timeout=deadline.cleanup_remaining(3))
            portal.join(timeout=deadline.cleanup_remaining(3))
            assert not helper.is_alive() and not portal.is_alive()
            record_query_observation("fixture.testclient.after_release_and_join", request.node.nodeid,
                                     {"helper_ident": helper.ident, "helper_alive": helper.is_alive(),
                                      "portal_ident": portal.ident, "portal_alive": portal.is_alive()})
