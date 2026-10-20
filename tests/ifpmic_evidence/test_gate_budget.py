"""Synthetic stdlib tests for the bounded full-gate deadline helper.

No product code, SDK, pytest plugin, or service is used. The stale-bytecode
test launches two short Python probes against a synthetic stdlib-only module;
all gate clocks, signal operations, and process-identity observations are patched.
"""
from __future__ import annotations

import signal
import os
from pathlib import Path
import py_compile
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import call, patch

from scripts import ifpmic_h2_gate_budget as gate


class ManualClock:
    def __init__(self, now: float = 0.0) -> None:
        self.now = now
        self.sleep_calls: list[tuple[float, float]] = []
        self.targets: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep_to_next_target(self, requested: float) -> None:
        self.sleep_calls.append((self.now, requested))
        if self.targets:
            self.now = max(self.now, self.targets.pop(0))
        else:
            self.now += requested


def owned(pid: int = 4101, ticks: str = "12345", state: str = "S"):
    return {pid: (("dispatcher", pid), state, ticks)}


def proc_stat(ticks: str) -> str:
    # cleanup reads the post-command fields and compares token 19 (start time).
    fields = ["S"] + ["0"] * 18 + [ticks]
    return "4101 (synthetic-child) " + " ".join(fields)


class GateBudgetConstructionTests(unittest.TestCase):
    def test_deadline_and_work_reserve_are_absolute(self) -> None:
        clock = ManualClock(84.0)
        budget = gate.GateBudget(100.0, recovery_reserve=15.0,
                                 command_recovery=7.0, clock=clock)

        self.assertEqual(budget.deadline, 100.0)
        self.assertEqual(budget.work_deadline, 85.0)
        budget.require_work_time()
        clock.now = 85.0
        with self.assertRaisesRegex(gate.GateBudgetError, "GATE_WORK_DEADLINE_EXCEEDED"):
            budget.require_work_time()
        self.assertTrue(budget.finished_in_time())

    def test_nonfinite_and_boolean_budget_values_are_rejected(self) -> None:
        invalid = (True, False, float("nan"), float("inf"), -float("inf"), "10")
        for field in ("deadline", "recovery_reserve", "command_recovery"):
            for value in invalid:
                with self.subTest(field=field, value=value):
                    values = {"deadline": 100.0, "recovery_reserve": 15.0,
                              "command_recovery": 7.0}
                    values[field] = value
                    with self.assertRaisesRegex(gate.GateBudgetError,
                                                "INVALID_GATE_BUDGET"):
                        gate.GateBudget(**values, clock=lambda: 0.0)

    def test_nonpositive_reserves_are_rejected(self) -> None:
        for field in ("recovery_reserve", "command_recovery"):
            for value in (0, -0.1):
                with self.subTest(field=field, value=value):
                    values = {"deadline": 100.0, "recovery_reserve": 15.0,
                              "command_recovery": 7.0}
                    values[field] = value
                    with self.assertRaisesRegex(gate.GateBudgetError,
                                                "INVALID_GATE_BUDGET"):
                        gate.GateBudget(**values, clock=lambda: 0.0)

    def test_command_timeout_is_capped_and_preserves_seven_second_recovery(self) -> None:
        clock = ManualClock(20.0)
        budget = gate.GateBudget(100.0, recovery_reserve=15.0,
                                 command_recovery=7.0, clock=clock)

        self.assertEqual(budget.command_timeout(90.0), 58.0)
        self.assertEqual(budget.command_timeout(30.0), 30.0)
        clock.now = 77.9
        self.assertAlmostEqual(budget.command_timeout(30.0), 0.1)
        clock.now = 78.0
        with self.assertRaisesRegex(gate.GateBudgetError,
                                    "GATE_COMMAND_RECOVERY_RESERVE_EXHAUSTED"):
            budget.command_timeout(30.0)

    def test_invalid_command_timeout_never_launches(self) -> None:
        budget = gate.GateBudget(100.0, clock=lambda: 0.0)
        for value in (True, False, 0, -1, float("nan"), float("inf"), "2"):
            with self.subTest(timeout=value):
                with self.assertRaisesRegex(gate.GateBudgetError,
                                            "INVALID_COMMAND_TIMEOUT"):
                    budget.command_timeout(value)

    def test_no_command_launch_when_recovery_reserve_would_be_consumed(self) -> None:
        clock = ManualClock(78.0)
        budget = gate.GateBudget(100.0, recovery_reserve=15.0,
                                 command_recovery=7.0, clock=clock)
        launched = []

        with self.assertRaisesRegex(gate.GateBudgetError,
                                    "GATE_COMMAND_RECOVERY_RESERVE_EXHAUSTED"):
            budget.run(lambda *args, **kwargs: launched.append(args), ["auditor"],
                       cwd="/private", timeout=10.0, env={})
        self.assertEqual(launched, [])

    def test_runner_return_after_work_deadline_is_failure(self) -> None:
        clock = ManualClock(10.0)
        budget = gate.GateBudget(100.0, recovery_reserve=15.0,
                                 command_recovery=7.0, clock=clock)
        seen = []

        def runner(command, **kwargs):
            seen.append((command, kwargs))
            clock.now = budget.work_deadline
            return {"returncode": 0}

        with self.assertRaisesRegex(gate.GateBudgetError,
                                    "GATE_WORK_DEADLINE_EXCEEDED"):
            budget.run(runner, ["auditor"], cwd="/private", timeout=90.0, env={})
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0][1]["timeout"], 68.0)

    def test_fresh_private_cache_prefix_ignores_local_stale_pyc(self) -> None:
        with tempfile.TemporaryDirectory(prefix="h2-gate-pycache-") as temp:
            root = Path(temp)
            source_root = root / "sources"
            source_root.mkdir(mode=0o700)
            source = source_root / "stale_probe.py"
            source.write_text("VALUE = 'stale'\n", encoding="utf-8")
            fixed_mtime_ns = 1_700_000_000_000_000_000
            os.utime(source, ns=(fixed_mtime_ns, fixed_mtime_ns))
            local_pyc = source_root / "__pycache__" / (
                "stale_probe." + sys.implementation.cache_tag + ".pyc"
            )
            local_pyc.parent.mkdir(mode=0o700)
            py_compile.compile(str(source), cfile=str(local_pyc), doraise=True)
            local_pyc.chmod(0o600)

            # Same-size source and timestamp leave a valid timestamp-based local
            # pyc that a plain -S -B interpreter would still read.
            source.write_text("VALUE = 'fresh'\n", encoding="utf-8")
            source.chmod(0o600)
            os.utime(source, ns=(fixed_mtime_ns, fixed_mtime_ns))
            self.assertTrue(local_pyc.is_file())
            self.assertEqual(local_pyc.stat().st_mode & 0o777, 0o600)
            self.assertEqual(source.stat().st_size, 16)

            env = {
                "PATH": "/usr/bin:/bin",
                "LC_ALL": "C.UTF-8",
                "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONPATH": str(source_root),
            }
            code = "import stale_probe; print(stale_probe.VALUE)"
            stale = subprocess.run(
                [sys.executable, "-S", "-B", "-c", code], cwd=root,
                env=env, capture_output=True, text=True, timeout=10, check=True,
            )
            cache_prefix = root / "fresh-private-pycache"
            cache_prefix.mkdir(mode=0o700)
            isolated = subprocess.run(
                [sys.executable, "-S", "-B", "-X",
                 "pycache_prefix=" + str(cache_prefix), "-c", code],
                cwd=root, env=env, capture_output=True, text=True,
                timeout=10, check=True,
            )

        self.assertEqual(stale.stdout.strip(), "stale")
        self.assertEqual(isolated.stdout.strip(), "fresh")


class GateBudgetSignalTests(unittest.TestCase):
    def test_first_term_int_or_alarm_requests_failure_but_repeats_do_not_interrupt(self) -> None:
        cases = (
            (signal.SIGTERM, "GATE_TERMINATION_REQUESTED"),
            (signal.SIGINT, "GATE_TERMINATION_REQUESTED"),
            (signal.SIGALRM, "GATE_WORK_DEADLINE_EXCEEDED"),
        )
        for number, expected in cases:
            with self.subTest(signal=number):
                budget = gate.GateBudget(100.0, clock=lambda: 0.0)
                with self.assertRaisesRegex(gate.GateBudgetError, expected):
                    budget._request_stop(number, None)
                self.assertTrue(budget.recovering)
                # Repeated external requests during the same cleanup epoch are ignored.
                budget._request_stop(number, None)
                budget._request_stop(signal.SIGTERM, None)
                self.assertTrue(budget.recovering)

    def test_arm_restore_and_repeat_arm_use_only_patched_signal_api(self) -> None:
        old = {signal.SIGALRM: object(), signal.SIGTERM: object(),
               signal.SIGINT: object()}
        clock = ManualClock(100.0)
        budget = gate.GateBudget(130.0, recovery_reserve=15.0, clock=clock)
        with patch.object(gate.signal, "getitimer", return_value=(0.0, 0.0)), \
                patch.object(gate.signal, "getsignal",
                             side_effect=lambda number: old[number]), \
                patch.object(gate.signal, "signal") as install, \
                patch.object(gate.signal, "setitimer") as timer:
            budget.arm()
            self.assertEqual(timer.call_args_list[0],
                             call(signal.ITIMER_REAL, 15.0))
            with self.assertRaisesRegex(gate.GateBudgetError, "EXISTING_GATE_ALARM"):
                budget.arm()
            budget.restore()

        installed = [entry.args for entry in install.call_args_list]
        for number in old:
            self.assertIn((number, old[number]), installed)
        self.assertEqual(timer.call_args_list[-1], call(signal.ITIMER_REAL, 0))
        self.assertIsNone(budget._handlers)

    def test_existing_alarm_is_rejected_before_handlers_are_changed(self) -> None:
        budget = gate.GateBudget(100.0, clock=lambda: 0.0)
        with patch.object(gate.signal, "getitimer", return_value=(0.25, 0.0)), \
                patch.object(gate.signal, "signal") as install:
            with self.assertRaisesRegex(gate.GateBudgetError, "EXISTING_GATE_ALARM"):
                budget.arm()
        install.assert_not_called()
        self.assertIsNone(budget._handlers)


class GateBudgetCleanupTests(unittest.TestCase):
    def _cleanup_with_mocks(self, budget, clock, child_map, *, stat_ticks="12345",
                            on_signal=None):
        child_map_fn = lambda: child_map
        signals = []

        def send(_fd, number):
            signals.append((number, clock.now))
            if on_signal is not None:
                on_signal(number, clock.now)

        cleanup_times = []

        def reap():
            cleanup_times.append(clock.now)

        with patch.object(gate.os, "pidfd_open", return_value=81) as pidfd_open, \
                patch.object(gate.os, "close") as close_fd, \
                patch.object(gate.signal, "pidfd_send_signal", side_effect=send), \
                patch.object(gate.Path, "read_text", return_value=proc_stat(stat_ticks)), \
                patch.object(gate.select, "select", return_value=([], [], [])) as select_call:
            result = budget.cleanup(child_map_fn, reap)
        return result, signals, cleanup_times, pidfd_open, close_fd, select_call

    def test_cleanup_uses_one_parent_deadline_with_cumulative_three_five_ten_stages(self) -> None:
        clock = ManualClock(0.0)
        clock.targets = [3.0, 5.0, 10.0]
        budget = gate.GateBudget(20.0, recovery_reserve=3.0, clock=clock,
                                 sleep=clock.sleep_to_next_target)

        result, signals, cleanup_times, pidfd_open, close_fd, _ = self._cleanup_with_mocks(
            budget, clock, owned())

        self.assertEqual(signals, [(signal.SIGINT, 0.0),
                                   (signal.SIGTERM, 3.0),
                                   (signal.SIGKILL, 5.0)])
        self.assertEqual(clock.now, 10.0)
        self.assertEqual(result["result"], "unconfirmed")
        self.assertEqual(result["signalled_count"], 1)
        self.assertFalse(result["outer_deadline_exhausted"])
        self.assertEqual(pidfd_open.call_count, 3)
        self.assertEqual(close_fd.call_count, 3)
        self.assertTrue(cleanup_times)

    def test_wrong_start_ticks_prevent_signalling_reused_pid(self) -> None:
        clock = ManualClock(0.0)
        clock.targets = [3.0, 5.0, 10.0]
        budget = gate.GateBudget(20.0, clock=clock, sleep=clock.sleep_to_next_target)

        result, signals, _, pidfd_open, close_fd, _ = self._cleanup_with_mocks(
            budget, clock, owned(ticks="old-start-ticks"), stat_ticks="new-start-ticks")

        self.assertEqual(signals, [])
        self.assertEqual(pidfd_open.call_count, 3)
        self.assertEqual(close_fd.call_count, 3)
        self.assertEqual(result["signalled_count"], 0)
        self.assertEqual(result["result"], "unconfirmed")

    def test_zombie_identity_remains_unconfirmed_and_is_not_signalled(self) -> None:
        clock = ManualClock(0.0)
        clock.targets = [3.0, 5.0, 10.0]
        budget = gate.GateBudget(20.0, clock=clock, sleep=clock.sleep_to_next_target)

        result, signals, _, pidfd_open, _, _ = self._cleanup_with_mocks(
            budget, clock, owned(state="Z"))

        self.assertEqual(signals, [])
        pidfd_open.assert_not_called()
        self.assertEqual(result, {
            "result": "unconfirmed", "signalled_count": 0,
            "pid_alive": True, "outer_deadline_exhausted": False,
        })

    def test_at_outer_deadline_cleanup_never_signals_or_waits(self) -> None:
        clock = ManualClock(10.0)
        budget = gate.GateBudget(10.0, clock=clock, sleep=clock.sleep_to_next_target)

        result, signals, cleanup_times, pidfd_open, _, _ = self._cleanup_with_mocks(
            budget, clock, owned(), on_signal=lambda *_: self.fail("signal after deadline"))

        self.assertEqual(signals, [])
        self.assertEqual(cleanup_times, [])
        pidfd_open.assert_not_called()
        self.assertEqual(result["result"], "unconfirmed")
        self.assertTrue(result["outer_deadline_exhausted"])

    def test_crossing_outer_deadline_stops_all_later_signal_and_wait_stages(self) -> None:
        clock = ManualClock(9.9)
        clock.targets = [10.0]
        budget = gate.GateBudget(10.0, clock=clock, sleep=clock.sleep_to_next_target)

        result, signals, cleanup_times, _, _, _ = self._cleanup_with_mocks(
            budget, clock, owned())

        self.assertEqual(signals, [(signal.SIGINT, 9.9)])
        self.assertTrue(all(t < budget.deadline for t in cleanup_times))
        self.assertEqual(result["result"], "unconfirmed")
        self.assertTrue(result["outer_deadline_exhausted"])


if __name__ == "__main__":
    unittest.main()
