"""Synthetic guard tests for the source-only full H2 gate helpers.

The runner module itself is stdlib-only at import time; these tests construct
small private fixtures and never call ``main`` or launch a product process.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import signal
import tempfile
import unittest
from unittest.mock import patch

from scripts import verify_ifpmic_b03_h2_runtime_full as runner


def _private_json(path: Path, value: object) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")
    path.chmod(0o600)


def _process(role: str, pid: int, ticks: int, *, exit_code: int = 0) -> dict:
    return {"role": role, "pid": pid, "start_ticks": ticks,
            "exit_code": exit_code, "forced": False, "absent": True}


def _temporal_roots(root: Path, extra: list[dict] | None = None):
    observations = root / "observations"
    observations.mkdir(mode=0o700)
    runtime_root = root / "runtime"
    _private_json(root / "h1" / "integration" / "result.json", {
        "phases": {"one": {"retention_seconds": 3601},
                   "two": {"retention_seconds": 7200}},
    })
    runtime_processes = [
        _process("dispatcher", 1001, 7001),
        _process("worker", 1002, 7002),
        _process("temporal", 1003, 7003),
    ]
    _private_json(runtime_root / "runtime-normal-flow" / "runtime-observation.json", {
        "status": "passed", "phase": "queued", "execution_count": 1,
        "started_event_count": 1, "raw_history_sha256": "a" * 64,
        "owner_before_sha256": "b" * 64, "owner_after_sha256": "c" * 64,
        "processes": runtime_processes,
    })
    if extra:
        for index, item in enumerate(extra):
            _private_json(observations / f"observation-{index}.json", item)
    return observations, runtime_root


class TemporalProcessNormalizationTests(unittest.TestCase):
    def test_process_count_deduplicates_identity_but_counts_distinct_pid_and_hides_ids(self) -> None:
        with tempfile.TemporaryDirectory(prefix="h2-temporal-guards-") as temp:
            root = Path(temp)
            duplicate = _process("dispatcher", 1001, 7001)
            another_dispatcher = _process("dispatcher", 1004, 7004)
            observations, runtime_root = _temporal_roots(
                root, [duplicate, another_dispatcher])
            result = runner.collect_private_temporal_evidence(
                [observations], root / "h1", runtime_root)

        dispatcher = next(row for row in result["owned_processes"]
                          if row["role"] == "dispatcher")
        self.assertEqual(dispatcher["count"], 2)
        self.assertEqual(result["owned_process_count_scope"],
                         "distinct_saved_pid_start_ticks_with_verified_terminal_observations")
        serialized = json.dumps(result, sort_keys=True)
        for private_identity in ("1001", "7001", "1004", "7004"):
            self.assertNotIn(private_identity, serialized)

    def test_conflicting_or_invalid_process_identities_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="h2-temporal-conflict-") as temp:
            root = Path(temp)
            observations, runtime_root = _temporal_roots(root, [
                _process("dispatcher", 1001, 7001, exit_code=3),
            ])
            with self.assertRaisesRegex(RuntimeError, "Conflicting terminal observations"):
                runner.collect_private_temporal_evidence(
                    [observations], root / "h1", runtime_root)

        for invalid_ticks in (True, "not-a-tick", 0, None):
            with self.subTest(invalid_start_ticks=invalid_ticks), tempfile.TemporaryDirectory(
                    prefix="h2-temporal-invalid-ticks-") as temp:
                root = Path(temp)
                observations, runtime_root = _temporal_roots(root)
                runtime_path = runtime_root / "runtime-normal-flow" / "runtime-observation.json"
                runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
                runtime["processes"][0]["start_ticks"] = invalid_ticks
                _private_json(runtime_path, runtime)
                with self.assertRaisesRegex(RuntimeError,
                                            "Normal runtime process identity missing"):
                    runner.collect_private_temporal_evidence(
                        [observations], root / "h1", runtime_root)

        with tempfile.TemporaryDirectory(prefix="h2-temporal-cross-role-identity-") as temp:
            root = Path(temp)
            observations, runtime_root = _temporal_roots(root)
            runtime_path = runtime_root / "runtime-normal-flow" / "runtime-observation.json"
            runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
            dispatcher = runtime["processes"][0]
            worker = runtime["processes"][1]
            worker["pid"] = dispatcher["pid"]
            worker["start_ticks"] = dispatcher["start_ticks"]
            _private_json(runtime_path, runtime)
            with self.assertRaisesRegex(RuntimeError,
                                        "Conflicting terminal observations"):
                runner.collect_private_temporal_evidence(
                    [observations], root / "h1", runtime_root)

    def test_identityless_terminal_summary_does_not_inflate_process_count(self) -> None:
        with tempfile.TemporaryDirectory(prefix="h2-temporal-summary-") as temp:
            root = Path(temp)
            observations, runtime_root = _temporal_roots(root, [{
                "role": "dispatcher", "exit_code": 3, "forced": False,
                "absent": True,
            }])
            result = runner.collect_private_temporal_evidence(
                [observations], root / "h1", runtime_root)

        dispatcher = next(row for row in result["owned_processes"]
                          if row["role"] == "dispatcher")
        self.assertEqual(dispatcher["count"], 1)
        self.assertEqual(len(result["unidentified_terminal_observation_types"]), 1)


class WatchdogEvidenceTests(unittest.TestCase):
    @staticmethod
    def _worker_fixture(root: Path, *, omit_first_observation: bool = False):
        observations = root / "observations"
        observations.mkdir(mode=0o700)
        plugin_path = root / "tests" / "ifpmic_api" / "h2_worker_api_case_budget.py"
        nodes = [f"tests/ifpmic_api/test_worker.py::case_{number}" for number in range(4)]
        filenames = [f"case-{number}.json" for number in range(4)]
        plugin_path.parent.mkdir(mode=0o700, parents=True)
        plugin_path.write_text(
            "CASE_FILES = {" + ",".join(
                repr(node) + ":" + repr(name) for node, name in zip(nodes, filenames)
            ) + "}\n", encoding="utf-8")
        plugin_path.chmod(0o600)
        for node, filename in zip(nodes, filenames):
            timing = observations / filename
            record = {
                "kind": runner.WATCHDOG_KINDS["h2_worker_api_case_budget"],
                "nodeid": node, "status": "finished",
                "body_timeout_triggered": False, "cleanup_timeout_triggered": False,
                "started_monotonic": 10.0, "cleanup_started_monotonic": 11.0,
                "finished_monotonic": 12.0, "body_seconds": 1.0,
                "cleanup_seconds": 1.0, "total_seconds": 2.0,
                "body_budget_seconds": 215, "cleanup_budget_seconds": 25,
            }
            if omit_first_observation and node == nodes[0]:
                # A matching-looking record exists above the observations
                # directory; the runner must not discover it by fallback.
                _private_json(root / filename, record)
            else:
                _private_json(timing, record)
        return observations, nodes

    def test_worker_watchdog_uses_ast_literal_case_map_and_exact_observation_files(self) -> None:
        with tempfile.TemporaryDirectory(prefix="h2-watchdog-map-") as temp:
            root = Path(temp)
            observations, nodes = self._worker_fixture(root)
            phase = {
                "id": "worker_api_crashes",
                "pytest_plugins": ["tests.ifpmic_api.h2_worker_api_case_budget"],
                "node_ids": nodes,
                "per_case_budgets": {node: {"setup_and_body": 215,
                                             "shared_cleanup": 25} for node in nodes},
            }
            with patch.object(runner, "ROOT", root):
                result = runner.verify_phase_watchdogs(
                    phase, root / "phase", observations, root / "unused-timing.json", {})

        self.assertEqual(len(result), 4)
        self.assertEqual({row["case_id"] for row in result},
                         {f"tests.ifpmic_api.test_worker.case_{number}"
                          for number in range(4)})

    def test_worker_watchdog_does_not_fallback_to_parent_for_missing_observation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="h2-watchdog-no-fallback-") as temp:
            root = Path(temp)
            observations, nodes = self._worker_fixture(root, omit_first_observation=True)
            phase = {
                "id": "worker_api_crashes",
                "pytest_plugins": ["tests.ifpmic_api.h2_worker_api_case_budget"],
                "node_ids": nodes,
                "per_case_budgets": {node: {"setup_and_body": 215,
                                             "shared_cleanup": 25} for node in nodes},
            }
            with patch.object(runner, "ROOT", root):
                with self.assertRaisesRegex(RuntimeError,
                                            "Missing or nonprivate per-case watchdog record"):
                    runner.verify_phase_watchdogs(
                        phase, root / "phase", observations,
                        root / "unused-timing.json", {})


class RawPolicySourceBindingTests(unittest.TestCase):
    REQUIRED_FILES = {
        "rules": "docs/ifpmic/evidence/b03/h2-runtime-full-machine-evidence-rules-v8.json",
        "auditor": "scripts/ifpmic_h2_raw_audit.py",
        "adapter": "scripts/ifpmic_h2_full_raw_adapter.py",
        "artifact_checker": "scripts/ifpmic_h2_artifacts.py",
        "recorder_checker": "scripts/ifpmic_h2_raw_evidence.py",
        "fence_checker": "scripts/ifpmic_h2_fences.py",
    }
    RUNTIME_HELPERS = {
        "scripts/verify_ifpmic_g1.py", "scripts/verify_ifpmic_g4.py",
        "scripts/verify_ifpmic_b03_h1.py", "scripts/ifpmic_temporal_toolchain.py",
        "scripts/verify_ifpmic_b03_h2_runtime_normal.py",
        "scripts/ifpmic_h2_gate_budget.py",
    }

    def _contract_and_ledger(self, root: Path):
        policy = {"runtime_helpers": {}}
        source_pins = {}
        for key, relative in self.REQUIRED_FILES.items():
            path = root / relative
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            raw = ("synthetic source: " + key + "\n").encode()
            path.write_bytes(raw)
            path.chmod(0o600)
            digest = hashlib.sha256(raw).hexdigest()
            policy[key] = {"path": relative, "sha256": digest}
            source_pins[relative] = digest
        for relative in self.RUNTIME_HELPERS:
            path = root / relative
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            raw = ("synthetic helper: " + relative + "\n").encode()
            path.write_bytes(raw)
            path.chmod(0o600)
            digest = hashlib.sha256(raw).hexdigest()
            policy["runtime_helpers"][relative] = digest
            source_pins[relative] = digest
        return {"per_case_raw_evidence": policy}, {"source_pins": source_pins}

    def test_raw_policy_requires_all_pinned_helpers_before_import(self) -> None:
        with tempfile.TemporaryDirectory(prefix="h2-policy-pin-") as temp:
            root = Path(temp)
            contract, ledger = self._contract_and_ledger(root)
            with patch.object(runner, "ROOT", root):
                result = runner.verify_raw_policy_sources(contract, ledger)
        self.assertEqual(set(result["runtime_helpers"]), self.RUNTIME_HELPERS)

    def test_raw_policy_rejects_missing_normal_or_budget_runtime_helper_pin(self) -> None:
        for relative in (
            "scripts/verify_ifpmic_b03_h2_runtime_normal.py",
            "scripts/ifpmic_h2_gate_budget.py",
        ):
            with self.subTest(relative=relative), tempfile.TemporaryDirectory(
                    prefix="h2-policy-missing-pin-") as temp:
                root = Path(temp)
                contract, ledger = self._contract_and_ledger(root)
                del contract["per_case_raw_evidence"]["runtime_helpers"][relative]
                with patch.object(runner, "ROOT", root):
                    with self.assertRaisesRegex(RuntimeError,
                                                "Exact pre-import runtime helper closure missing"):
                        runner.verify_raw_policy_sources(contract, ledger)

    def test_raw_policy_rejects_missing_fence_checker_pin(self) -> None:
        with tempfile.TemporaryDirectory(prefix="h2-policy-missing-fence-") as temp:
            root = Path(temp)
            contract, ledger = self._contract_and_ledger(root)
            del contract["per_case_raw_evidence"]["fence_checker"]
            with patch.object(runner, "ROOT", root):
                with self.assertRaisesRegex(
                        RuntimeError,
                        "Raw-evidence policy/source binding differs: fence_checker"):
                    runner.verify_raw_policy_sources(contract, ledger)

    def test_current_contract_ledger_and_rules_are_accepted_by_real_policy_validator(self) -> None:
        from scripts.ifpmic_h2_full_raw_adapter import validate_policy

        contract_raw = runner.CONTRACT_PATH.read_bytes()
        ledger_raw = runner.LEDGER_PATH.read_bytes()
        self.assertEqual(hashlib.sha256(contract_raw).hexdigest(), runner.CONTRACT_SHA)
        self.assertEqual(hashlib.sha256(ledger_raw).hexdigest(), runner.LEDGER_SHA)
        contract = runner.read_json(runner.CONTRACT_PATH)
        ledger = runner.read_json(runner.LEDGER_PATH)
        phases = runner.verify_contract_ledger(contract, ledger)

        result = validate_policy(runner.ROOT, contract, ledger, phases)

        self.assertEqual(result["rules_sha256"], contract["per_case_raw_evidence"]["rules"]["sha256"])
        self.assertEqual(len(result["cases"]), 87)
        self.assertEqual(len(result["expected_nodes"]), 87)

    def test_real_policy_validator_rejects_v7_status_with_correct_private_digest(self) -> None:
        from copy import deepcopy

        from scripts.ifpmic_h2_full_raw_adapter import validate_policy
        from scripts.ifpmic_h2_raw_evidence import EvidenceError

        contract = runner.read_json(runner.CONTRACT_PATH)
        ledger = runner.read_json(runner.LEDGER_PATH)
        phases = runner.verify_contract_ledger(contract, ledger)
        rules_path = runner.ROOT / contract["per_case_raw_evidence"]["rules"]["path"]
        rules = deepcopy(runner.read_json(rules_path))
        rules["status"] = "candidate_v7_recovery_observation_repair_pending_exact_review_no_execution"
        rules_raw = (json.dumps(rules, sort_keys=True, ensure_ascii=True) + "\n").encode("ascii")
        negative_contract = deepcopy(contract)
        negative_contract["per_case_raw_evidence"]["rules"] = {
            "path": "rules.json",
            "sha256": hashlib.sha256(rules_raw).hexdigest(),
        }

        with tempfile.TemporaryDirectory(prefix="h2-policy-v7-status-") as temp:
            root = Path(temp)
            root.chmod(0o700)
            private_rules = root / "rules.json"
            private_rules.write_bytes(rules_raw)
            private_rules.chmod(0o600)
            with self.assertRaises(EvidenceError) as raised:
                validate_policy(root, negative_contract, ledger, phases)

        self.assertEqual(raised.exception.args, ("RAW_RULES_NOT_FROZEN",))


class BootstrapDeadlineHandoffTests(unittest.TestCase):
    def _patched_signal_api(self, originals):
        current = dict(originals)
        timer = {"seconds": 0.0, "interval": 0.0}

        def install(number, handler):
            current[number] = handler

        def set_timer(_which, seconds, interval=0.0):
            timer.update(seconds=seconds, interval=interval)
            return (seconds, interval)

        patches = [
            patch.object(runner.signal, "getitimer",
                         side_effect=lambda _which: (timer["seconds"], timer["interval"])),
            patch.object(runner.signal, "getsignal", side_effect=lambda number: current[number]),
            patch.object(runner.signal, "signal", side_effect=install),
            patch.object(runner.signal, "setitimer", side_effect=set_timer),
        ]
        return current, timer, patches

    def test_bootstrap_alarm_precedes_main_and_handoff_preserves_start(self) -> None:
        originals = {number: f"saved-{number}" for number in
                     (signal.SIGALRM, signal.SIGTERM, signal.SIGINT)}
        current, timer, patches = self._patched_signal_api(originals)
        with tempfile.TemporaryDirectory(prefix="h2-bootstrap-handoff-"):
            with patches[0], patches[1], patches[2], patches[3], \
                    patch.object(runner.time, "monotonic", side_effect=[100.0, 101.0]), \
                    patch.object(runner, "main") as mocked_main:
                observations = {}

                def fake_main(*, start, release_bootstrap):
                    observations["start"] = start
                    observations["installed_before_main"] = all(
                        current[number] != originals[number] for number in originals)
                    observations["timer_before_main"] = timer["seconds"]
                    release_bootstrap()
                    observations["restored_at_handoff"] = current == originals
                    observations["timer_at_handoff"] = timer["seconds"]
                    return 7

                mocked_main.side_effect = fake_main
                result = runner.run_bootstrapped()

        self.assertEqual(result, 7)
        self.assertEqual(observations["start"], 100.0)
        self.assertTrue(observations["installed_before_main"])
        self.assertEqual(observations["timer_before_main"],
                         runner.OUTER_SECONDS - 16.0)
        self.assertTrue(observations["restored_at_handoff"])
        self.assertEqual(observations["timer_at_handoff"], 0.0)
        self.assertEqual(current, originals)

    def test_bootstrap_exception_restores_handlers_and_disarms_alarm(self) -> None:
        originals = {number: f"saved-{number}" for number in
                     (signal.SIGALRM, signal.SIGTERM, signal.SIGINT)}
        current, timer, patches = self._patched_signal_api(originals)
        with patches[0], patches[1], patches[2], patches[3], \
                patch.object(runner.time, "monotonic", side_effect=[200.0, 200.0]), \
                patch.object(runner, "main", side_effect=ValueError("synthetic gate error")):
            with self.assertRaisesRegex(ValueError, "synthetic gate error"):
                runner.run_bootstrapped()

        self.assertEqual(current, originals)
        self.assertEqual(timer["seconds"], 0.0)
        self.assertEqual(timer["interval"], 0.0)

