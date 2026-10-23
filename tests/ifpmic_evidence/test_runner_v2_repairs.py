"""Synthetic stdlib regressions for the bounded full-runner v2 repairs.

These tests read the five pinned watchdog producer sources and the v2 ledger
as text/JSON, construct synthetic records, and never invoke the runner main,
pytest, product code, an SDK, SQL, or a service.
"""
from __future__ import annotations

import ast
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from scripts import ifpmic_readme_qualification
from scripts import verify_ifpmic_b03_h2_runtime_full as runner


ROOT = Path(__file__).resolve().parents[2]
LEDGER_PATH = ROOT / "docs/ifpmic/evidence/b03/h2-runtime-full-integrated-ledger-v2.json"
PRIOR_UNIT_RESULT = ROOT / "docs/ifpmic/delivery/iteration-03/full-runner-repair-verification.json"
PRIOR_UNIT_FILES = (
    "test_raw_observations.py",
    "test_raw_artifacts.py",
    "test_private_values.py",
    "test_retained_fences.py",
    "test_gate_budget.py",
    "test_full_runner_guards.py",
)
PRODUCER_PHASES = {
    "h2_window_case_budget": "window",
    "h2_activity_runtime_case_budget": "activity_runtime",
    "h2_transport_case_budget": "transport",
    "h2_workspace_activation_case_budget": "workspace",
    "h2_fixture_failure_case_budget": "fixture_failure",
}
PRODUCER_FILES = {
    plugin: ROOT / "tests/ifpmic_api" / (plugin + ".py")
    for plugin in PRODUCER_PHASES
}


def _assigned_value(tree: ast.Module, name: str) -> ast.expr | None:
    """Return the last top-level assignment value for a literal producer name."""
    found = None
    for statement in tree.body:
        if isinstance(statement, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == name
                for target in statement.targets):
            found = statement.value
    return found


def _producer_nodes(tree: ast.Module) -> set[str]:
    budget_expr = _assigned_value(tree, "CASE_BUDGETS")
    if isinstance(budget_expr, ast.Dict):
        return {ast.literal_eval(key) for key in budget_expr.keys}
    node_expr = _assigned_value(tree, "CASE_NODE_IDS")
    if isinstance(node_expr, ast.Call) and node_expr.args:
        return set(ast.literal_eval(node_expr.args[0]))
    raise AssertionError("watchdog source lacks a literal case ID inventory")


def _producer_budgets(tree: ast.Module, nodes: set[str]) -> dict[str, tuple[int, int]]:
    """Resolve literal dict/comprehension budgets and later literal overrides."""
    expression = _assigned_value(tree, "CASE_BUDGETS")
    if isinstance(expression, ast.Dict):
        result = {ast.literal_eval(key): tuple(ast.literal_eval(value))
                  for key, value in zip(expression.keys, expression.values)}
    elif isinstance(expression, ast.DictComp):
        base = tuple(ast.literal_eval(expression.value))
        result = {node: base for node in nodes}
    else:
        raise AssertionError("watchdog source lacks literal CASE_BUDGETS")

    for statement in tree.body:
        if not isinstance(statement, ast.Assign):
            continue
        for target in statement.targets:
            if (isinstance(target, ast.Subscript)
                    and isinstance(target.value, ast.Name)
                    and target.value.id == "CASE_BUDGETS"):
                node = ast.literal_eval(target.slice)
                result[node] = tuple(ast.literal_eval(statement.value))
    return result


def _writer_value_keys(tree: ast.Module) -> set[str]:
    for cls in (node for node in tree.body if isinstance(node, ast.ClassDef)):
        method = next((node for node in cls.body
                       if isinstance(node, ast.FunctionDef) and node.name == "_write"), None)
        if method is None:
            continue
        for node in ast.walk(method):
            if (isinstance(node, ast.Assign)
                    and any(isinstance(target, ast.Name) and target.id == "value"
                            for target in node.targets)
                    and isinstance(node.value, ast.Dict)):
                return {ast.literal_eval(key) for key in node.value.keys}
    raise AssertionError("watchdog source lacks its literal JSON value writer")


def _ledger_watchdogs() -> dict[str, dict]:
    ledger = json.loads(LEDGER_PATH.read_text(encoding="utf-8"))
    phases = ledger["additional_phases"] + ledger["retained_phases"]
    by_plugin = {}
    for phase in phases:
        for plugin_path in phase.get("pytest_plugins", []):
            plugin = plugin_path.rsplit(".", 1)[-1]
            if plugin in PRODUCER_PHASES:
                if plugin in by_plugin:
                    raise AssertionError("a producer is bound to multiple ledger phases")
                by_plugin[plugin] = phase
    return by_plugin


def _synthetic_record(nodeid: str, budget: dict, expected_kind: str,
                      writer_keys: set[str], *, body: float | None = None,
                      cleanup: float | None = None) -> dict:
    body_limit = budget["setup_and_body"]
    cleanup_limit = budget["shared_cleanup"]
    body = float(body_limit if body is None else body)
    cleanup = float(cleanup_limit if cleanup is None else cleanup)
    record = {
        "kind": expected_kind,
        "nodeid": nodeid,
        "started_monotonic": 10.0,
        "cleanup_started_monotonic": 10.0 + body,
        "finished_monotonic": 10.0 + body + cleanup,
        "body_timeout_triggered": False,
        "cleanup_timeout_triggered": False,
        "body_budget_seconds": body_limit,
        "cleanup_budget_seconds": cleanup_limit,
    }
    body_key = "body_seconds" if "body_seconds" in writer_keys else "body_elapsed_seconds"
    cleanup_key = "cleanup_seconds" if "cleanup_seconds" in writer_keys else "cleanup_elapsed_seconds"
    record[body_key] = body
    record[cleanup_key] = cleanup
    return record


class ActualProducerSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.phases = _ledger_watchdogs()
        cls.producers = {}
        for plugin, path in PRODUCER_FILES.items():
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            nodes = _producer_nodes(tree)
            budgets = _producer_budgets(tree, nodes)
            cls.producers[plugin] = {
                "tree": tree,
                "nodes": nodes,
                "budgets": budgets,
                "writer_keys": _writer_value_keys(tree),
            }

    def test_five_actual_writers_bind_exactly_40_literal_ledger_nodes_and_budgets(self) -> None:
        self.assertEqual(set(self.phases), set(PRODUCER_PHASES))
        self.assertEqual(sum(len(item["nodes"]) for item in self.producers.values()), 40)
        all_nodes = set()
        for plugin, phase_name in PRODUCER_PHASES.items():
            with self.subTest(plugin=plugin):
                source = self.producers[plugin]
                phase = self.phases[plugin]
                self.assertEqual(phase["id"], phase_name)
                self.assertEqual(source["nodes"], set(phase["node_ids"]))
                self.assertEqual(set(source["budgets"]), source["nodes"])
                self.assertEqual(set(phase["per_case_budgets"]), source["nodes"])
                for nodeid in source["nodes"]:
                    budget = source["budgets"][nodeid]
                    ledger_budget = phase["per_case_budgets"][nodeid]
                    self.assertEqual(budget, (ledger_budget["setup_and_body"],
                                              ledger_budget["shared_cleanup"]))
                    self.assertIn(budget, ((25, 5), (215, 25)))
                    self.assertNotIn(nodeid, all_nodes)
                    all_nodes.add(nodeid)


                keys = source["writer_keys"]
                self.assertNotIn("total_seconds", keys)
                self.assertTrue({"started_monotonic", "cleanup_started_monotonic",
                                 "finished_monotonic", "body_timeout_triggered",
                                 "cleanup_timeout_triggered", "body_budget_seconds",
                                 "cleanup_budget_seconds"} <= keys)
                self.assertTrue({"body_seconds", "body_elapsed_seconds"} & keys)
                self.assertTrue({"cleanup_seconds", "cleanup_elapsed_seconds"} & keys)
        self.assertEqual(len(all_nodes), 40)

    def test_previous_119_unittest_ids_are_preserved_exactly(self) -> None:
        expected = json.loads(PRIOR_UNIT_RESULT.read_text(encoding="utf-8"))["test_ids"]
        actual = set()
        for filename in PRIOR_UNIT_FILES:
            tree = ast.parse((ROOT / "tests/ifpmic_evidence" / filename).read_text(
                encoding="utf-8"), filename=filename)
            for cls in (node for node in tree.body if isinstance(node, ast.ClassDef)):
                for method in cls.body:
                    if isinstance(method, ast.FunctionDef) and method.name.startswith("test_"):
                        actual.add(f"{Path(filename).stem}.{cls.name}.{method.name}")
        self.assertEqual(len(expected), 119)
        self.assertEqual(len(actual), 119)
        self.assertEqual(actual, set(expected))

    def test_missing_total_derives_elapsed_at_each_exact_producer_boundary(self) -> None:
        count = 0
        for plugin, source in self.producers.items():
            phase = self.phases[plugin]
            expected_kind = runner.WATCHDOG_KINDS[plugin]
            for nodeid, pair in source["budgets"].items():
                with self.subTest(plugin=plugin, nodeid=nodeid):
                    budget = phase["per_case_budgets"][nodeid]
                    record = _synthetic_record(nodeid, budget, expected_kind,
                                               source["writer_keys"],
                                               body=float(pair[0]), cleanup=float(pair[1]))
                    self.assertNotIn("total_seconds", record)
                    result = runner.validate_watchdog_record(record, nodeid, budget,
                                                             expected_kind)
                    self.assertEqual(result["body_seconds"], float(pair[0]))
                    self.assertEqual(result["cleanup_seconds"], float(pair[1]))
                    self.assertEqual(result["elapsed_seconds"], float(sum(pair)))
                    count += 1
        self.assertEqual(count, 40)

    def test_explicit_consistent_total_remains_valid_for_known_kind(self) -> None:
        plugin = "h2_window_case_budget"
        source = self.producers[plugin]
        phase = self.phases[plugin]
        nodeid = sorted(source["nodes"])[0]
        budget = phase["per_case_budgets"][nodeid]
        record = _synthetic_record(nodeid, budget, runner.WATCHDOG_KINDS[plugin],
                                   source["writer_keys"], body=1, cleanup=1)
        record["total_seconds"] = 2.0
        result = runner.validate_watchdog_record(record, nodeid, budget,
                                                 runner.WATCHDOG_KINDS[plugin])
        self.assertEqual(result["elapsed_seconds"], 2.0)

    def test_invalid_explicit_totals_are_rejected_even_when_clocks_are_valid(self) -> None:
        plugin = "h2_window_case_budget"
        source = self.producers[plugin]
        phase = self.phases[plugin]
        nodeid = sorted(source["nodes"])[0]
        budget = phase["per_case_budgets"][nodeid]
        for total in (None, True, float("nan"), float("inf"), -1.0, 3.0):
            with self.subTest(total=total):
                record = _synthetic_record(nodeid, budget,
                    runner.WATCHDOG_KINDS[plugin], source["writer_keys"], body=1, cleanup=1)
                record["total_seconds"] = total
                with self.assertRaisesRegex(RuntimeError, "Watchdog body, cleanup, or total"):
                    runner.validate_watchdog_record(record, nodeid, budget,
                                                    runner.WATCHDOG_KINDS[plugin])

    def test_unknown_kind_wrong_identity_bad_clock_and_timeout_fail_closed(self) -> None:
        plugin = "h2_transport_case_budget"
        source = self.producers[plugin]
        phase = self.phases[plugin]
        nodeid = sorted(source["nodes"])[0]
        budget = phase["per_case_budgets"][nodeid]
        kind = runner.WATCHDOG_KINDS[plugin]
        base = _synthetic_record(nodeid, budget, kind, source["writer_keys"],
                                 body=1, cleanup=1)

        unknown_kind = "unknown.watchdog.kind"
        unknown_record = dict(base, kind=unknown_kind, total_seconds=2.0)
        with self.assertRaisesRegex(RuntimeError, "kind"):
            runner.validate_watchdog_record(unknown_record, nodeid, budget, unknown_kind)
        wrong_node = dict(base, nodeid=nodeid + "-other")
        with self.assertRaisesRegex(RuntimeError, "node ID"):
            runner.validate_watchdog_record(wrong_node, nodeid, budget, kind)
        wrong_kind = dict(base, kind="other.kind")
        with self.assertRaisesRegex(RuntimeError, "kind"):
            runner.validate_watchdog_record(wrong_kind, nodeid, budget, kind)

        for changes in (
                {"finished_monotonic": 9.0},
                {"finished_monotonic": float("nan")},
                {"body_timeout_triggered": True},
                {"cleanup_timeout_triggered": True},
                {"body_seconds": math.inf},
                {"cleanup_seconds": -1.0},
        ):
            with self.subTest(changes=changes):
                record = dict(base, **changes)
                with self.assertRaises(RuntimeError):
                    runner.validate_watchdog_record(record, nodeid, budget, kind)

    def test_nonexempt_worker_api_kind_still_requires_explicit_total(self) -> None:
        worker_kind = runner.WATCHDOG_KINDS["h2_worker_api_case_budget"]
        nodeid = ("tests/ifpmic_api/test_h2_worker_api_crashes.py::"
                  "test_h2_api_commit_before_response_sigkill_retry_applies_once")
        budget = {"setup_and_body": 215, "shared_cleanup": 25}
        record = _synthetic_record(nodeid, budget, worker_kind,
                                   {"body_seconds", "cleanup_seconds"},
                                   body=1, cleanup=1)
        self.assertNotIn("total_seconds", record)
        with self.assertRaisesRegex(RuntimeError, "Watchdog body, cleanup, or total"):
            runner.validate_watchdog_record(record, nodeid, budget, worker_kind)

    def test_body_and_cleanup_overruns_fail_at_both_reviewed_budget_pairs(self) -> None:
        for plugin, pair in (("h2_fixture_failure_case_budget", (25, 5)),
                             ("h2_transport_case_budget", (215, 25))):
            source = self.producers[plugin]
            phase = self.phases[plugin]
            nodeid = next(node for node, budget_pair in source["budgets"].items()
                          if budget_pair == pair)
            budget = phase["per_case_budgets"][nodeid]
            kind = runner.WATCHDOG_KINDS[plugin]
            with self.subTest(pair=pair, component="body"):
                over = pair[0] + 0.001
                record = _synthetic_record(nodeid, budget, kind, source["writer_keys"],
                                           body=over, cleanup=1)
                with self.assertRaisesRegex(RuntimeError, "Watchdog body, cleanup, or total"):
                    runner.validate_watchdog_record(record, nodeid, budget, kind)
            with self.subTest(pair=pair, component="cleanup"):
                over = pair[1] + 0.001
                record = _synthetic_record(nodeid, budget, kind, source["writer_keys"],
                                           body=1, cleanup=over)
                with self.assertRaisesRegex(RuntimeError, "Watchdog body, cleanup, or total"):
                    runner.validate_watchdog_record(record, nodeid, budget, kind)

    def test_component_mismatch_boolean_clock_and_missing_timeout_flag_are_rejected(self) -> None:
        plugin = "h2_activity_runtime_case_budget"
        source = self.producers[plugin]
        phase = self.phases[plugin]
        nodeid = sorted(source["nodes"])[0]
        budget = phase["per_case_budgets"][nodeid]
        kind = runner.WATCHDOG_KINDS[plugin]
        base = _synthetic_record(nodeid, budget, kind, source["writer_keys"],
                                 body=1, cleanup=1)
        body_key = "body_seconds" if "body_seconds" in source["writer_keys"] else "body_elapsed_seconds"
        cases = {
            "component_duration_disagrees_with_clock": dict(base, **{body_key: 1.5}),
            "boolean_clock": dict(base, started_monotonic=True),
        }
        missing_timeout = dict(base)
        missing_timeout.pop("cleanup_timeout_triggered")
        cases["missing_timeout_flag"] = missing_timeout
        for label, record in cases.items():
            with self.subTest(case=label):
                with self.assertRaises(RuntimeError):
                    runner.validate_watchdog_record(record, nodeid, budget, kind)


class FixedRunnerSourceGuardTests(unittest.TestCase):
    @staticmethod
    def _write_runner(root: Path, contents: bytes = b"synthetic runner source\n") -> Path:
        path = root / "scripts" / "verify_ifpmic_b03_h2_runtime_full.py"
        path.parent.mkdir(mode=0o700, parents=True)
        path.write_bytes(contents)
        path.chmod(0o600)
        return path

    def test_fixed_runner_file_returns_current_hash_and_checks_expected_hash(self) -> None:
        with tempfile.TemporaryDirectory(prefix="h2-runner-source-guard-") as temp:
            root = Path(temp)
            path = self._write_runner(root)
            expected = hashlib.sha256(path.read_bytes()).hexdigest()
            with patch.object(runner, "ROOT", root):
                self.assertEqual(runner.verify_runner_source(), expected)
                self.assertEqual(runner.verify_runner_source(expected), expected)
                with self.assertRaisesRegex(RuntimeError, "[Rr]unner"):
                    runner.verify_runner_source("0" * 64)

    def test_fixed_runner_guard_rejects_changed_deleted_symlink_and_nonregular_files(self) -> None:
        with tempfile.TemporaryDirectory(prefix="h2-runner-source-states-") as temp:
            root = Path(temp)
            path = self._write_runner(root, b"before\n")
            expected = hashlib.sha256(path.read_bytes()).hexdigest()
            with patch.object(runner, "ROOT", root):
                path.write_bytes(b"changed\n")
                path.chmod(0o600)
                with self.assertRaisesRegex(RuntimeError, "[Rr]unner"):
                    runner.verify_runner_source(expected)

                path.unlink()
                with self.assertRaises((RuntimeError, OSError)):
                    runner.verify_runner_source()

                target = root / "real-source.py"
                target.write_bytes(b"target\n")
                target.chmod(0o600)
                path.symlink_to(target)
                with self.assertRaisesRegex(RuntimeError, "[Rr]unner"):
                    runner.verify_runner_source()

                path.unlink()
                path.mkdir(mode=0o700)
                with self.assertRaisesRegex(RuntimeError, "[Rr]unner"):
                    runner.verify_runner_source()

    def test_main_hashes_runner_before_gate_and_again_before_public_proposal(self) -> None:
        path = Path(runner.__file__)
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        main = next(node for node in tree.body
                    if isinstance(node, ast.FunctionDef) and node.name == "main")
        calls = [node for node in ast.walk(main)
                 if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                 and node.func.id == "verify_runner_source"]
        proposal = next(node for node in ast.walk(main)
                        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                        and node.func.id == "build_public_proposal")
        gate = next(node for node in ast.walk(main)
                    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                    and node.func.id == "execution_gate")
        self.assertGreaterEqual(len(calls), 2)
        self.assertLess(min(node.lineno for node in calls), gate.lineno)
        self.assertLess(max(node.lineno for node in calls), proposal.lineno)
        self.assertTrue(any(node.args or node.keywords for node in calls),
                        "the final source check must bind the initial runner SHA")


def _private_mkdir(path: Path) -> None:
    missing = []
    current = path
    while not current.exists():
        missing.append(current)
        current = current.parent
    for directory in reversed(missing):
        directory.mkdir(mode=0o700)
        directory.chmod(0o700)


def _write_json(path: Path, value) -> None:
    _private_mkdir(path.parent)
    path.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")
    path.chmod(0o600)


def _write_temporal_baselines(root: Path) -> tuple[Path, Path]:
    h1 = root / "h1"
    runtime = root / "runtime"
    _write_json(h1 / "integration" / "result.json", {
        "phases": {"one": {"retention_seconds": 3601},
                   "two": {"retention_seconds": 3602}},
        "cleanup": [{"pid": 509, "start_ticks": "8709", "returncode": 0,
                     "forced": False, "absent": True}],
    })
    digest = "a" * 64
    _write_json(runtime / "runtime-normal-flow" / "runtime-observation.json", {
        "status": "passed", "phase": "queued", "execution_count": 1,
        "started_event_count": 1, "raw_history_sha256": digest,
        "owner_before_sha256": "b" * 64, "owner_after_sha256": "c" * 64,
        "processes": [
            {"role": role, "pid": pid, "start_ticks": str(pid + 100),
             "exit_code": 0, "forced": False, "absent": True}
            for role, pid in (("dispatcher", 501), ("worker", 502), ("temporal", 503))
        ],
    })
    return h1, runtime


def _progress_lines(phase: dict, normal_contract: dict, *, overrides: dict | None = None) -> str:
    overrides = overrides or {}
    events = []
    moment = 1.0
    exceptions = set(normal_contract["limits"]["integration_exact_ids"])
    for nodeid in phase["node_ids"]:
        identifier = runner.case_id(nodeid)
        budget = phase.get("per_case_budgets", {}).get(nodeid, {})
        body_cap = 215 if identifier in exceptions else budget.get("setup_and_body", 25)
        cleanup_cap = 25 if identifier in exceptions else budget.get("shared_cleanup", 5)
        setup, call, teardown = overrides.get(identifier, (0.0, float(body_cap), float(cleanup_cap)))
        setup_finish = moment + setup
        call_finish = setup_finish + call
        teardown_finish = call_finish + teardown
        for event in (
            {"event": "start", "nodeid": nodeid, "monotonic": moment},
            {"event": "report", "nodeid": nodeid, "monotonic": setup_finish,
             "when": "setup", "duration": setup, "outcome": "passed"},
            {"event": "report", "nodeid": nodeid, "monotonic": call_finish,
             "when": "call", "duration": call, "outcome": "passed"},
            {"event": "report", "nodeid": nodeid, "monotonic": teardown_finish,
             "when": "teardown", "duration": teardown, "outcome": "passed"},
            {"event": "finish", "nodeid": nodeid,
             "monotonic": teardown_finish},
        ):
            events.append(json.dumps(event, sort_keys=True))
        moment = teardown_finish + 1.0
    return "\n".join(events) + "\n"


class ProgressAndLifecycleRepairTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.ledger = json.loads(LEDGER_PATH.read_text(encoding="utf-8"))
        cls.contract = json.loads((ROOT / "docs/ifpmic/evidence/b03/"
                                   "h2-runtime-full-execution-contract-v2.json").read_text(
                                       encoding="utf-8"))
        timing_path = ROOT / cls.contract["attestation_inputs"][
            "historical407_timing_contract"]["path"]
        cls.normal_contract = json.loads(timing_path.read_text(encoding="utf-8"))
        cls.phases = cls.ledger["additional_phases"] + cls.ledger["retained_phases"]

    def test_all_83_additional_progress_nodes_use_literal_phase_budgets(self) -> None:
        additional = self.ledger["additional_phases"]
        self.assertEqual(sum(len(phase["node_ids"]) for phase in additional), 83)
        extended_count = sum(
            budget["setup_and_body"] == 215
            for phase in additional for budget in phase.get("per_case_budgets", {}).values()
        )
        self.assertEqual(extended_count, 49)
        seen = set()
        with tempfile.TemporaryDirectory(prefix="h2-progress-83-") as temp:
            path = Path(temp) / "progress.jsonl"
            for phase in additional:
                with self.subTest(phase=phase["id"]):
                    self.assertTrue(set(phase["node_ids"]) <= set(phase["per_case_budgets"]))
                    self.assertFalse(seen.intersection(phase["node_ids"]))
                    seen.update(phase["node_ids"])
                    path.write_text(_progress_lines(phase, self.normal_contract), encoding="utf-8")
                    path.chmod(0o600)
                    result = runner.verify_progress(path, phase, self.normal_contract)
                    self.assertEqual(len(result["normalized_cases"]), len(phase["node_ids"]))
                    by_id = {row["case_id"]: row for row in result["normalized_cases"]}
                    for nodeid in phase["node_ids"]:
                        node_id = runner.case_id(nodeid)
                        budget = phase["per_case_budgets"][nodeid]
                        with self.subTest(nodeid=node_id):
                            self.assertEqual(by_id[node_id]["body_limit_seconds"],
                                             budget["setup_and_body"])
                            self.assertEqual(by_id[node_id]["cleanup_limit_seconds"],
                                             budget["shared_cleanup"])
                            self.assertEqual(by_id[node_id]["setup_seconds"], 0.0)
                            self.assertEqual(by_id[node_id]["call_seconds"],
                                             float(budget["setup_and_body"]))
                            self.assertEqual(by_id[node_id]["teardown_seconds"],
                                             float(budget["shared_cleanup"]))
                            self.assertEqual(by_id[node_id]["elapsed_seconds"],
                                             float(budget["setup_and_body"] + budget["shared_cleanup"]))
            self.assertEqual(len(seen), 83)

    def test_progress_accepts_exact_default_and_extended_component_boundaries(self) -> None:
        for pair in ((25, 5), (215, 25)):
            phase = next(row for row in self.ledger["additional_phases"]
                         if any((budget["setup_and_body"], budget["shared_cleanup"]) == pair
                                for budget in row.get("per_case_budgets", {}).values()))
            nodeid = next(node for node, budget in phase["per_case_budgets"].items()
                          if (budget["setup_and_body"], budget["shared_cleanup"]) == pair)
            with self.subTest(pair=pair):
                with tempfile.TemporaryDirectory(prefix="h2-progress-boundary-") as temp:
                    path = Path(temp) / "progress.jsonl"
                    identifier = runner.case_id(nodeid)
                    body = 215 if pair == (215, 25) else 25
                    cleanup = pair[1]
                    path.write_text(_progress_lines(
                        phase, self.normal_contract,
                        overrides={identifier: (0.0, body, cleanup)}),
                        encoding="utf-8")
                    path.chmod(0o600)
                    self.assertEqual(len(runner.verify_progress(path, phase, self.normal_contract)[
                        "normalized_cases"]), len(phase["node_ids"]))

                    path.write_text(_progress_lines(
                        phase, self.normal_contract,
                        overrides={identifier: (0.0, body + 0.001, cleanup)}), encoding="utf-8")
                    path.chmod(0o600)
                    with self.assertRaises(RuntimeError):
                        runner.verify_progress(path, phase, self.normal_contract)

                    path.write_text(_progress_lines(
                        phase, self.normal_contract,
                        overrides={identifier: (0.0, body, cleanup + 0.001)}),
                        encoding="utf-8")
                    path.chmod(0o600)
                    with self.assertRaises(RuntimeError):
                        runner.verify_progress(path, phase, self.normal_contract)

                    split = body / 2
                    path.write_text(_progress_lines(
                        phase, self.normal_contract,
                        overrides={identifier: (split, split + 0.001, cleanup)}),
                        encoding="utf-8")
                    path.chmod(0o600)
                    with self.assertRaises(RuntimeError):
                        runner.verify_progress(path, phase, self.normal_contract)

        for exact_id in self.normal_contract["limits"]["integration_exact_ids"]:
            nodeid = next(node for phase in self.ledger["retained_phases"]
                          for node in phase["node_ids"] if runner.case_id(node) == exact_id)
            phase = next(row for row in self.ledger["retained_phases"] if nodeid in row["node_ids"])
            with self.subTest(integration_case=exact_id):
                with tempfile.TemporaryDirectory(prefix="h2-progress-retained-exception-") as temp:
                    path = Path(temp) / "progress.jsonl"
                    path.write_text(_progress_lines(
                        phase, self.normal_contract,
                        overrides={exact_id: (0.0, 215.0, 25.0)}), encoding="utf-8")
                    path.chmod(0o600)
                    runner.verify_progress(path, phase, self.normal_contract)
                    for invalid in ((0.0, 215.001, 25.0), (0.0, 215.0, 25.001),
                                    (108.0, 107.001, 25.0)):
                        path.write_text(_progress_lines(
                            phase, self.normal_contract, overrides={exact_id: invalid}),
                            encoding="utf-8")
                        path.chmod(0o600)
                        with self.assertRaises(RuntimeError):
                            runner.verify_progress(path, phase, self.normal_contract)

    def test_postgres_lifecycle_applicability_is_explicit_for_only_two_non_pg_phases(self) -> None:
        method = getattr(runner, "verify_phase_postgres_evidence")
        contract = self.contract
        with tempfile.TemporaryDirectory(prefix="h2-pg-applicability-") as temp:
            root = Path(temp)
            for phase_id in ("h1_python", "fixture_failure"):
                path = root / (phase_id + ".json")
                result = method(phase_id, path, contract)
                self.assertIs(result["applicable"], False)
                self.assertIsInstance(result.get("reason"), str)
                path.write_text("{}\n", encoding="utf-8")
                path.chmod(0o600)
                with self.assertRaises(RuntimeError):
                    method(phase_id, path, contract)
                path.unlink()
                path.symlink_to(root / "missing-target")
                with self.assertRaises((RuntimeError, OSError)):
                    method(phase_id, path, contract)

    def test_postgres_lifecycle_applies_to_other_phases_and_unknown_phase_fails(self) -> None:
        method = getattr(runner, "verify_phase_postgres_evidence")
        with tempfile.TemporaryDirectory(prefix="h2-pg-required-") as temp:
            sentinel = {"stopped": True}
            with patch.object(runner, "verify_postgres_lifecycle", return_value=sentinel) as verify:
                applicable = set(runner.ORDER) - {"h1_python", "fixture_failure"}
                self.assertEqual(len(applicable), 13)
                for phase_id in runner.ORDER:
                    path = Path(temp) / (phase_id + ".json")
                    if phase_id in applicable:
                        path.write_text("{}\n", encoding="utf-8")
                        path.chmod(0o600)
                        result = method(phase_id, path, self.contract)
                        self.assertEqual(result, {"applicable": True, "lifecycle": sentinel})
                    else:
                        self.assertIs(method(phase_id, path, self.contract)["applicable"], False)
                self.assertEqual(verify.call_count, 13)
                self.assertEqual({call.args[0].name for call in verify.call_args_list},
                                 {phase_id + ".json" for phase_id in applicable})
            with self.assertRaises(RuntimeError):
                method("unknown-phase", Path(temp) / "unknown.json", self.contract)
            with self.assertRaises(RuntimeError):
                method("activity_runtime", Path(temp) / "missing.json", self.contract)
            target = Path(temp) / "target.json"
            target.write_text("{}\n", encoding="utf-8")
            target.chmod(0o600)
            link = Path(temp) / "lifecycle-link.json"
            link.symlink_to(target)
            with self.assertRaises(RuntimeError):
                method("activity_runtime", link, self.contract)
            path = Path(temp) / "lifecycle-directory"
            path.mkdir(mode=0o700)
            with self.assertRaises(RuntimeError):
                method("activity_runtime", path, self.contract)


class ProcessEvidenceJoinRepairTests(unittest.TestCase):
    @staticmethod
    def _line(path: Path, value: dict) -> None:
        _private_mkdir(path.parent)
        with path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(value, sort_keys=True) + "\n")
        path.chmod(0o600)

    @staticmethod
    def _observe(root: Path) -> dict:
        h1, runtime = _write_temporal_baselines(root)
        return runner.collect_private_temporal_evidence([root / "observations"], h1, runtime)

    @staticmethod
    def _write_stopped_boundary_fixture(
        root: Path, *, owned_case: str | None = "case-a",
        started_case: str | None = None, envelope_case: str = "case-a",
        outer_updates: dict | None = None, stop_updates: dict | None = None,
        filename_label: str = "dispatcher-before-activity-result-cut",
    ) -> None:
        observations = root / "observations"
        pid, ticks = 804, "8804"
        if owned_case is not None:
            _write_json(observations / owned_case / "owned-process-00.json", {
                "role": "dispatcher", "pid": pid, "start_ticks": ticks,
            })
        if started_case is not None:
            ProcessEvidenceJoinRepairTests._line(
                observations / started_case / "process-journal.jsonl",
                {"event": "started", "role": "dispatcher", "pid": pid,
                 "start_ticks": ticks},
            )
        outer = {"role": "dispatcher-before-activity-result-cut", "pid": pid,
                 "start_ticks": ticks}
        if outer_updates:
            outer.update(outer_updates)
        stopped = {"pid": pid, "start_ticks": ticks, "returncode": 0,
                   "forced": False, "absent": True}
        if stop_updates:
            stopped.update(stop_updates)
        outer["stop"] = stopped
        _write_json(observations / envelope_case / ("stopped-" + filename_label + ".json"), outer)

    def test_stopped_boundary_label_joins_and_deduplicates_canonical_owned_role(self) -> None:
        with tempfile.TemporaryDirectory(prefix="h2-stopped-boundary-join-") as temp:
            base = Path(temp)
            self._write_stopped_boundary_fixture(base)
            result = self._observe(base)
            dispatcher = [row for row in result["owned_processes"]
                          if row["role"] == "dispatcher" and row["expected_exit_code"] == 0]
            self.assertEqual(dispatcher, [{
                "role": "dispatcher", "count": 2, "expected_exit_code": 0,
                "expected_signal": None, "forced_cleanup": False, "absent": True,
            }])
            self.assertNotIn("dispatcher-before-activity-result-cut",
                             json.dumps(result["owned_processes"]))
            self.assertNotIn("804", json.dumps(result["owned_processes"]))
            self.assertNotIn("8804", json.dumps(result["owned_processes"]))

    def test_stopped_boundary_rejects_unowned_cross_case_and_bad_nested_stop(self) -> None:
        invalid = (
            ("missing-owned", {"owned_case": None}),
            ("started-only", {"owned_case": None, "started_case": "case-a"}),
            ("cross-case", {"owned_case": "case-a", "envelope_case": "case-b"}),
            ("outer-pid", {"outer_updates": {"pid": 805}}),
            ("outer-ticks", {"outer_updates": {"start_ticks": "8805"}}),
            ("nested-pid", {"stop_updates": {"pid": 805}}),
            ("nested-ticks", {"stop_updates": {"start_ticks": "8805"}}),
            ("forced", {"stop_updates": {"forced": True}}),
            ("not-absent", {"stop_updates": {"absent": False}}),
            ("unexpected-code", {"stop_updates": {"returncode": 2}}),
            ("malformed-stop", {"stop_updates": {"absent": None}}),
            ("filename-role-mismatch", {"filename_label": "dispatcher"}),
        )
        for name, options in invalid:
            with self.subTest(case=name):
                with tempfile.TemporaryDirectory(prefix="h2-stopped-boundary-invalid-") as temp:
                    base = Path(temp)
                    self._write_stopped_boundary_fixture(base, **options)
                    with self.assertRaises(RuntimeError):
                        self._observe(base)

    def test_roleless_terminal_journal_joins_only_to_same_case_started_identity(self) -> None:
        with tempfile.TemporaryDirectory(prefix="h2-process-join-") as temp:
            root = Path(temp) / "observations"
            journal = root / "case-a" / "process-journal.jsonl"
            for offset, kill_event in enumerate(("killed", "killed_at_production_hook")):
                pid, ticks = 701 + offset, str(8701 + offset)
                self._line(journal, {"event": "started", "role": "worker", "pid": pid,
                                     "start_ticks": ticks})
                kill_row = {"event": kill_event, "pid": pid, "start_ticks": ticks,
                            "signal": "SIGKILL", "absent": True}
                if kill_event == "killed":
                    kill_row.update(role="worker", exit_code=-9)
                else:
                    kill_row["returncode"] = -9
                self._line(journal, kill_row)
                self._line(journal, {"event": "stopped", "pid": pid, "start_ticks": ticks,
                                     "exit_code": -9, "forced": False, "absent": True})
            result = self._observe(Path(temp))
            rows = result["owned_processes"]
            self.assertIn({"role": "worker", "count": 2, "expected_exit_code": -9,
                           "expected_signal": "SIGKILL", "forced_cleanup": False,
                           "absent": True}, rows)
            self.assertNotIn("701", json.dumps(rows))
            self.assertNotIn("8701", json.dumps(rows))

    def test_cleanup_rows_join_to_case_local_role_metadata_and_h1_typed_rows(self) -> None:
        with tempfile.TemporaryDirectory(prefix="h2-process-cleanup-join-") as temp:
            base = Path(temp)
            obs = base / "observations"
            case = obs / "worker-api-case"
            _write_json(case / "owned-process-00.json", {
                "role": "api-child", "pid": 702, "start_ticks": "8702"})
            _write_json(case / "owned-process-cleanup.json", [{
                "pid": 702, "start_ticks": "8702", "returncode": -9,
                "forced": False, "absent": True}])

            dispatcher_case = obs / "dispatcher-case"
            journal = dispatcher_case / "process-journal.jsonl"
            self._line(journal, {"event": "started", "role": "dispatcher-cut-api_commit",
                                 "pid": 704, "start_ticks": "8704"})
            self._line(journal, {"event": "stopped", "pid": 704,
                                 "start_ticks": "8704", "exit_code": 0,
                                 "forced": False, "absent": True})
            _write_json(dispatcher_case / "process-cleanup.json", {"processes": [{
                "role": "dispatcher-cut-api_commit", "pid": 704,
                "returncode": 0, "forced": False, "absent": True,
            }]})

            summary_case = obs / "identityless-role-summary"
            _write_json(summary_case / "owned-process-cleanup.json", [{
                "role": "summary-only-cli", "pid": 705, "returncode": 0,
                "forced": False, "absent": True,
            }])

            unknown_case = obs / "fixture-cleanup-fallback"
            _write_json(unknown_case / "process-cleanup.json", {"processes": [{
                "role": "injected-owned-handle", "pid": 706, "returncode": None,
                "forced": False, "absent": False,
            }]})

            h1_case = obs / "h1" / "integration"
            _write_json(h1_case / "processes.json", {
                "kind": "ifpmic.b03.h1.processes.v1",
                "processes": [{"role": "server-phase2", "pid": 703,
                               "start_ticks": 8703, "returncode": 0,
                               "forced": False, "absent": True}],
            })
            result = self._observe(base)
            self.assertIn({"role": "api-child", "count": 1, "expected_exit_code": -9,
                           "expected_signal": "SIGKILL", "forced_cleanup": False,
                           "absent": True}, result["owned_processes"])
            self.assertIn({"role": "server-phase2", "count": 1, "expected_exit_code": 0,
                           "expected_signal": None, "forced_cleanup": False,
                           "absent": True}, result["owned_processes"])
            self.assertIn({"role": "dispatcher-cut-api_commit", "count": 1,
                           "expected_exit_code": 0, "expected_signal": None,
                           "forced_cleanup": False, "absent": True},
                          result["owned_processes"])
            self.assertIn({"role": "summary-only-cli", "expected_exit_code": 0,
                           "expected_signal": None, "forced_cleanup": False,
                           "absent": True}, result["unidentified_terminal_observation_types"])
            self.assertEqual(result["expected_fixture_unknown_records"], 1)
            self.assertNotIn("704", json.dumps(result["owned_processes"]))
            self.assertNotIn("8704", json.dumps(result["owned_processes"]))

    def test_orphan_mismatch_and_cross_case_terminal_rows_are_rejected(self) -> None:
        fixtures = (
            {"case-a": [{"event": "stopped", "pid": 704, "start_ticks": "8704",
                          "exit_code": 0, "forced": False, "absent": True}]},
            {"case-a": [{"event": "stopped", "role": "worker", "pid": 704,
                          "start_ticks": "8704", "exit_code": 0,
                          "forced": False, "absent": True}]},
            {"case-a": [{"event": "started", "role": "worker", "pid": 704,
                          "start_ticks": "8704"}],
             "case-b": [{"event": "stopped", "pid": 704, "start_ticks": "8704",
                          "exit_code": 0, "forced": False, "absent": True}]},
            {"case-a": [{"event": "started", "role": "worker", "pid": 704,
                          "start_ticks": "8704"}],
             "case-b": [{"event": "stopped", "role": "worker", "pid": 704,
                          "start_ticks": "8704", "exit_code": 0,
                          "forced": False, "absent": True}]},
            {"case-a": [{"event": "started", "role": "worker", "pid": 704,
                          "start_ticks": "8704"},
                         {"event": "stopped", "pid": 704, "start_ticks": "8704",
                          "exit_code": 0, "forced": True, "absent": True}]},
            {"case-a": [{"event": "started", "role": "worker", "pid": 704,
                          "start_ticks": "8704"},
                         {"event": "stopped", "role": "dispatcher", "pid": 704,
                          "start_ticks": "8704", "exit_code": 0,
                          "forced": False, "absent": True}]},
            {"case-a": [{"event": "killed_at_production_hook", "pid": 704,
                          "start_ticks": "8704", "signal": "SIGKILL", "returncode": -9,
                          "absent": True}]},
            {"case-a": [{"event": "started", "role": "worker", "pid": 704,
                          "start_ticks": "8704"},
                         {"event": "killed_at_production_hook", "pid": 704,
                          "start_ticks": "8704", "signal": "SIGKILL", "returncode": -9,
                          "absent": True}]},
        )
        for fixture in fixtures:
            with self.subTest(case_names=tuple(fixture)):
                with tempfile.TemporaryDirectory(prefix="h2-process-invalid-join-") as temp:
                    base = Path(temp)
                    for case, rows in fixture.items():
                        path = base / "observations" / case / "process-journal.jsonl"
                        for row in rows:
                            self._line(path, row)
                    with self.assertRaises(RuntimeError):
                        self._observe(base)

        with tempfile.TemporaryDirectory(prefix="h2-process-invalid-exit-") as temp:
            base = Path(temp)
            _write_json(base / "observations" / "fixture-cleanup" / "process-cleanup.json", {
                "processes": [{"role": "injected-owned-handle", "pid": 707,
                               "returncode": 2, "forced": False, "absent": False}],
            })
            with self.assertRaises(RuntimeError):
                self._observe(base)

    @staticmethod
    def _write_cleanup_fallback_probe(
        root: Path, *, include_query: bool = True, probe_suffix: str | None = None,
        pid: int = 74991, ticks: str = "saved-test-identity",
        journal_rows: list[dict] | None = None, cleanup: dict | None = None,
        query_updates: dict | None = None, result_updates: dict | None = None,
        duplicate_query: bool = False,
    ) -> None:
        node_id = ("tests/ifpmic_api/test_h2_fixture_cleanup_failures.py::"
                   "test_expired_cleanup_budget_performs_no_new_lifecycle_action")
        observations = root / "observations"
        node_hash = hashlib.sha256(node_id.encode("utf-8")).hexdigest()[:16]
        probe_name = "cleanup-fallback-probe-" + (probe_suffix or node_hash)
        probe = observations / probe_name
        default_journal = [
            {"event": "stop_requested", "pid": 74991,
             "start_ticks": "saved-test-identity", "pre_stop_exit_code": None,
             "mode": "graceful"},
            {"event": "stopped", "pid": 74991, "start_ticks": "saved-test-identity",
             "exit_code": None, "forced": False, "absent": False},
        ]
        if journal_rows is None:
            journal_rows = default_journal
        else:
            # Copy caller-provided rows so each negative fixture is independent.
            journal_rows = [dict(row) for row in journal_rows]
        if pid != 74991 or ticks != "saved-test-identity":
            for row in journal_rows:
                if "pid" in row:
                    row["pid"] = pid
                if "start_ticks" in row:
                    row["start_ticks"] = ticks
        journal = probe / "process-journal.jsonl"
        for row in journal_rows:
            ProcessEvidenceJoinRepairTests._line(journal, row)
        if cleanup is None:
            cleanup = {"processes": [{"role": "injected-owned-handle", "pid": 74991,
                                       "returncode": None, "forced": False,
                                       "absent": False}]}
        else:
            cleanup = json.loads(json.dumps(cleanup))
        if pid != 74991 or ticks != "saved-test-identity":
            for row in cleanup.get("processes", []):
                if "pid" in row:
                    row["pid"] = pid
                if "start_ticks" in row:
                    row["start_ticks"] = ticks
        _write_json(probe / "process-cleanup.json", cleanup)
        if not include_query:
            return

        source_path = ROOT / "tests/ifpmic_api/test_h2_fixture_cleanup_failures.py"
        source_tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
        function = next(node for node in source_tree.body
                        if isinstance(node, ast.FunctionDef)
                        and node.name == "test_expired_cleanup_budget_performs_no_new_lifecycle_action")
        query_call = next(node for node in ast.walk(function)
                          if isinstance(node, ast.Call)
                          and isinstance(node.func, ast.Name)
                          and node.func.id == "record_query_observation")
        query = {
            "kind": "ifpmic.b03.h2.query-observation.v1",
            "operation": "fixture.exhausted_cleanup",
            "subject": node_id,
            "result": {
                "synthetic_process_probe": True,
                "actions": [],
                "identity_lookups": [],
                "remaining_checks": 2,
                "retained_same_object": True,
                "physical_process_absence_proven": False,
            },
            "pytest_current_test": node_id + " (call)",
            "observed_monotonic_ns": 1700000000000000000,
            "caller": {"file": source_path.name, "function": function.name,
                       "line": query_call.lineno},
        }
        if result_updates:
            query["result"].update(result_updates)
        if query_updates:
            query.update(query_updates)
        query_dir = observations / "query-observations"
        query_path = query_dir / (str(query["observed_monotonic_ns"]) + "-" + "a" * 32 + ".json")
        _write_json(query_path, query)
        if duplicate_query:
            _write_json(query_dir / (str(query["observed_monotonic_ns"]) + "-" + "b" * 32 + ".json"), query)

    def test_exact_cleanup_fallback_probe_is_two_unknown_records_and_zero_processes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="h2-cleanup-fallback-exact-") as temp:
            base = Path(temp)
            self._write_cleanup_fallback_probe(base)
            result = self._observe(base)
            self.assertEqual(result["expected_fixture_unknown_records"], 2)
            self.assertEqual(result["owned_processes"], [
                {"role": role, "count": 1, "expected_exit_code": 0,
                 "expected_signal": None, "forced_cleanup": False, "absent": True}
                for role in ("dispatcher", "temporal", "worker")
            ])
            self.assertNotIn("74991", json.dumps(result["owned_processes"]))
            self.assertNotIn("saved-test-identity", json.dumps(result["owned_processes"]))

    def test_cleanup_fallback_requires_exact_probe_journal_summary_and_query(self) -> None:
        invalid = [
            ("missing-query", {"include_query": False}),
            ("wrong-probe-context", {"probe_suffix": "0000000000000000"}),
            ("wrong-phase", {"query_updates": {"pytest_current_test":
                "tests/ifpmic_api/test_h2_fixture_cleanup_failures.py::"
                "test_expired_cleanup_budget_performs_no_new_lifecycle_action (setup)"}}),
            ("wrong-node", {"query_updates": {"subject": "other-node"}}),
            ("wrong-query-kind", {"query_updates": {"kind": "other-kind"}}),
            ("wrong-operation", {"query_updates": {"operation": "fixture.other"}}),
            ("wrong-caller-file", {"query_updates": {"caller": {
                "file": "other.py", "function": "test_expired_cleanup_budget_performs_no_new_lifecycle_action",
                "line": 130}}}),
            ("invalid-caller-line", {"query_updates": {"caller": {
                "file": "test_h2_fixture_cleanup_failures.py",
                "function": "test_expired_cleanup_budget_performs_no_new_lifecycle_action",
                "line": True}}}),
            ("duplicate-query", {"duplicate_query": True}),
            ("actions", {"result_updates": {"actions": ["signal"]}}),
            ("identity-lookup", {"result_updates": {"identity_lookups": [74991]}}),
            ("absence-claimed", {"result_updates": {"physical_process_absence_proven": True}}),
            ("not-retained", {"result_updates": {"retained_same_object": False}}),
            ("too-few-checks", {"result_updates": {"remaining_checks": 1}}),
            ("nonphysical-ticks-changed", {"pid": 74991, "ticks": "870491"}),
            ("real-identity-substitution", {"pid": 804, "ticks": "8804"}),
            ("summary-success-claim", {"cleanup": {"processes": [{
                "role": "injected-owned-handle", "pid": 74991,
                "returncode": 0, "forced": False, "absent": True}]}}),
            ("journal-missing-stop-request", {"journal_rows": [{
                "event": "stopped", "pid": 74991, "start_ticks": "saved-test-identity",
                "exit_code": None, "forced": False, "absent": False}]}),
        ]
        for name, options in invalid:
            with self.subTest(case=name):
                with tempfile.TemporaryDirectory(prefix="h2-cleanup-fallback-invalid-") as temp:
                    base = Path(temp)
                    self._write_cleanup_fallback_probe(base, **options)
                    with self.assertRaises(RuntimeError):
                        self._observe(base)

        with tempfile.TemporaryDirectory(prefix="h2-cleanup-fallback-cross-phase-") as temp:
            base = Path(temp)
            self._write_cleanup_fallback_probe(base)
            source_query_dir = base / "observations" / "query-observations"
            query_path = next(source_query_dir.glob("*.json"))
            other_phase = base / "other-phase-observations"
            destination_query_dir = other_phase / "query-observations"
            _private_mkdir(destination_query_dir)
            query_path.rename(destination_query_dir / query_path.name)
            h1, runtime = _write_temporal_baselines(base)
            with self.assertRaises(RuntimeError):
                runner.collect_private_temporal_evidence(
                    [base / "observations", other_phase], h1, runtime)


    def test_postgres_server_and_backend_identities_are_not_owned_cli_processes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="h2-process-pg-separation-") as temp:
            base = Path(temp)
            case = base / "observations" / "activity"
            self._line(case / "process-journal.jsonl", {
                "event": "service_stopped", "role": "postgres", "pid": 705,
                "start_ticks": "8705", "absent": True,
            })
            _write_json(case / "hung-driver-rollback.json", {
                "pg_backend_after_kill": {"backend_pid": 9705, "role": "projector",
                                           "absent": True, "observed_monotonic": 12.5},
            })
            result = self._observe(base)
            self.assertEqual(result["owned_processes"], [
                {"role": role, "count": 1, "expected_exit_code": 0,
                 "expected_signal": None, "forced_cleanup": False, "absent": True}
                for role in ("dispatcher", "temporal", "worker")
            ])

            h1, runtime = _write_temporal_baselines(base)
            # The historical H1 summary has roleless cleanup results; only its
            # typed processes.json rows may contribute CLI identities.
            result = runner.collect_private_temporal_evidence(
                [base / "observations", h1], h1, runtime)
            self.assertEqual(result["owned_processes"], [
                {"role": role, "count": 1, "expected_exit_code": 0,
                 "expected_signal": None, "forced_cleanup": False, "absent": True}
                for role in ("dispatcher", "temporal", "worker")
            ])

    def test_malformed_postgres_observation_types_fail_closed(self) -> None:
        bad_rows = (
            ("process-journal.jsonl", {"event": "service_stopped", "role": "postgres",
              "pid": True, "start_ticks": "8705", "absent": True}),
            ("hung-driver-rollback.json", {"pg_backend_after_kill": {
              "backend_pid": True, "role": "projector", "absent": True,
              "observed_monotonic": 12.5}}),
            ("hung-driver-rollback.json", {"pg_backend_after_kill": {
              "backend_pid": 9705, "role": "projector", "absent": True,
              "observed_monotonic": float("nan")}}),
        )
        for index, (filename, value) in enumerate(bad_rows):
            with self.subTest(index=index):
                with tempfile.TemporaryDirectory(prefix="h2-pg-observation-invalid-") as temp:
                    base = Path(temp)
                    case = base / "observations" / "activity"
                    if filename.endswith(".jsonl"):
                        self._line(case / filename, value)
                    else:
                        _write_json(case / filename, value)
                    with self.assertRaises(RuntimeError):
                        self._observe(base)

class ReadmeQualificationRepairTests(unittest.TestCase):
    INPUTS = {
        "docs/ifpmic/evidence/b03/qualification/h1-readme.md":
            ifpmic_readme_qualification.H1_README_SHA256,
        "docs/ifpmic/evidence/b03/qualification/h2-readme.md":
            ifpmic_readme_qualification.H2_README_SHA256,
        "README.md": ifpmic_readme_qualification.CURRENT_README_SHA256,
        "docs/ifpmic/evidence/b03/h1-execution-contract.json":
            ifpmic_readme_qualification.H1_CONTRACT_SHA256,
    }

    @classmethod
    def _fixture(cls, root: Path) -> dict[str, Path]:
        paths: dict[str, Path] = {}
        for relative, expected in cls.INPUTS.items():
            source = ROOT / relative
            raw = source.read_bytes()
            if hashlib.sha256(raw).hexdigest() != expected:
                raise AssertionError(f"test fixture source pin changed: {relative}")
            target = root / relative
            _private_mkdir(target.parent)
            target.write_bytes(raw)
            target.chmod(0o600)
            paths[relative] = target
        return paths

    def test_exact_historical_and_current_readmes_are_qualified_separately(self) -> None:
        with tempfile.TemporaryDirectory(prefix="h2-readme-qualification-") as temp:
            root = Path(temp)
            paths = self._fixture(root)
            result = ifpmic_readme_qualification.verify_readme_qualification(root)
            self.assertEqual(result, {
                "historical_h1_sha256": self.INPUTS[
                    "docs/ifpmic/evidence/b03/qualification/h1-readme.md"],
                "historical_h2_sha256": self.INPUTS[
                    "docs/ifpmic/evidence/b03/qualification/h2-readme.md"],
                "current_sha256": self.INPUTS["README.md"],
                "current_change_verified": True,
            })

            source = (ROOT / "tests/ifpmic_api/test_temporal_toolchain.py").read_text(
                encoding="utf-8")
            tree = ast.parse(source)
            function = next(node for node in tree.body
                            if isinstance(node, ast.FunctionDef)
                            and node.name == "test_installed_toolchain_pins")
            self.assertTrue(any(isinstance(node, ast.Call)
                                and isinstance(node.func, ast.Name)
                                and node.func.id == "verify_readme_qualification"
                                for node in ast.walk(function)))
            self.assertTrue(any(isinstance(node, ast.Compare)
                                and isinstance(node.left, ast.Subscript)
                                and isinstance(node.left.slice, ast.Constant)
                                and node.left.slice.value == "historical_h2_sha256"
                                and any(isinstance(item, ast.Name)
                                        and item.id == "EXPECTED_README_SHA256"
                                        for item in node.comparators)
                                for node in ast.walk(function)))
            self.assertTrue(any(isinstance(node, ast.Compare)
                                and isinstance(node.left, ast.Subscript)
                                and isinstance(node.left.slice, ast.Constant)
                                and node.left.slice.value == "current_change_verified"
                                and any(isinstance(item, ast.Constant) and item.value is True
                                        for item in node.comparators)
                                for node in ast.walk(function)))
            expected_sha = next(node.value for node in tree.body
                                if isinstance(node, ast.Assign)
                                and any(isinstance(target, ast.Name)
                                        and target.id == "EXPECTED_README_SHA256"
                                        for target in node.targets))
            self.assertEqual(ast.literal_eval(expected_sha),
                             ifpmic_readme_qualification.H2_README_SHA256)
            self.assertTrue(paths["README.md"].is_file())

    def test_each_qualification_input_rejects_tampering_missing_symlink_and_nonfile(self) -> None:
        for relative, expected in self.INPUTS.items():
            with self.subTest(input=relative):
                for mode in ("tamper", "missing", "symlink", "nonfile"):
                    with self.subTest(mode=mode), tempfile.TemporaryDirectory(
                            prefix="h2-readme-input-invalid-") as temp:
                        root = Path(temp)
                        paths = self._fixture(root)
                        target = paths[relative]
                        if mode == "tamper":
                            target.write_bytes(target.read_bytes() + b"extra\n")
                            target.chmod(0o600)
                        elif mode == "missing":
                            target.unlink()
                        elif mode == "symlink":
                            replacement = root / "replacement-input"
                            replacement.write_bytes((ROOT / relative).read_bytes())
                            replacement.chmod(0o600)
                            target.unlink()
                            target.symlink_to(replacement)
                        else:
                            target.unlink()
                            target.mkdir(mode=0o700)
                        with self.assertRaises(RuntimeError):
                            ifpmic_readme_qualification.verify_readme_qualification(root)

    def test_readme_semantics_reject_hash_pinned_unreviewed_additions(self) -> None:
        with tempfile.TemporaryDirectory(prefix="h2-readme-semantic-extra-") as temp:
            root = Path(temp)
            paths = self._fixture(root)
            current = paths["README.md"]
            raw = current.read_bytes() + b"Unreviewed text.\n"
            current.write_bytes(raw)
            current.chmod(0o600)
            with patch.object(ifpmic_readme_qualification, "CURRENT_README_SHA256",
                              hashlib.sha256(raw).hexdigest()):
                with self.assertRaisesRegex(RuntimeError, "reviewed delivery addition"):
                    ifpmic_readme_qualification.verify_readme_qualification(root)

    def test_h1_contract_semantics_reject_hash_pinned_readme_substitution(self) -> None:
        with tempfile.TemporaryDirectory(prefix="h2-readme-contract-semantic-") as temp:
            root = Path(temp)
            paths = self._fixture(root)
            contract_path = paths["docs/ifpmic/evidence/b03/h1-execution-contract.json"]
            contract = json.loads(contract_path.read_text(encoding="utf-8"))
            next(row for row in contract["inputs"] if row.get("path") == "README.md")[
                "sha256"] = ifpmic_readme_qualification.H2_README_SHA256
            raw = (json.dumps(contract, sort_keys=True, indent=2) + "\n").encode("utf-8")
            contract_path.write_bytes(raw)
            contract_path.chmod(0o600)
            with patch.object(ifpmic_readme_qualification, "H1_CONTRACT_SHA256",
                              hashlib.sha256(raw).hexdigest()):
                with self.assertRaisesRegex(RuntimeError, "Historical H1 README attestation"):
                    ifpmic_readme_qualification.verify_readme_qualification(root)

    def test_noncanonical_or_symlink_root_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="h2-readme-root-") as temp:
            parent = Path(temp)
            root = parent / "root"
            root.mkdir(mode=0o700)
            self._fixture(root)
            with self.assertRaisesRegex(RuntimeError, "not canonical"):
                ifpmic_readme_qualification.verify_readme_qualification(
                    root / "unneeded-component" / "..")
            link = parent / "root-link"
            link.symlink_to(root, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, "not canonical"):
                ifpmic_readme_qualification.verify_readme_qualification(link)


class NodeClosureRepairTests(unittest.TestCase):
    @staticmethod
    def _safe_environment_fixture(root: Path, *, bad_hash: bool = False,
                                  missing_node: bool = False):
        home = root / "fake-home"
        base = root / "qualified-python"
        py = base / "bin/python"
        py.parent.mkdir(parents=True)
        py.write_bytes(b"synthetic interpreter placeholder")
        py.chmod(0o700)
        node = home / "node/bin/node"
        node.parent.mkdir(parents=True)
        node_bytes = b"synthetic pinned node placeholder"
        if not missing_node:
            node.write_bytes(node_bytes)
            node.chmod(0o700)
        ambient = root / "ambient-bin"
        other_venv_node = py.parent / "node"
        ambient.mkdir()
        ambient_node_bytes = b"ambient node must not win"
        (ambient / "node").write_bytes(ambient_node_bytes)
        (other_venv_node).write_bytes(b"other venv node must not win")
        other_venv_node.chmod(0o700)
        (ambient / "node").chmod(0o700)
        observations = root / "capture/case/observations.json"
        observations.parent.mkdir(parents=True)
        contract = {
            "attestation_inputs": {
                "qualified_private_installation": {"path": "private/toolchain/installation.json"}
            },
            "binary_inputs": {
                "fixture_node": {
                    "path": "~/node/bin/node",
                    "sha256": "0" * 64 if bad_hash else hashlib.sha256(node_bytes).hexdigest(),
                }
            },
        }
        phase = {"pytest_plugins": []}
        return home, base, node, ambient, observations, contract, phase

    def _safe_environment(self, root: Path, *, bad_hash: bool = False,
                          missing_node: bool = False):
        home, base, node, ambient, observations, contract, phase = (
            self._safe_environment_fixture(root, bad_hash=bad_hash, missing_node=missing_node))
        created: list[str] = []
        real_mkdtemp = runner.tempfile.mkdtemp

        def tracked_mkdtemp(*args, **kwargs):
            path = real_mkdtemp(*args, **kwargs)
            created.append(path)
            return path

        try:
            with (patch.object(runner.Path, "home", return_value=home),
                  patch.object(runner.tempfile, "mkdtemp", side_effect=tracked_mkdtemp),
                  patch.dict(os.environ, {"PATH": str(ambient), "DATABASE_URL": "ambient-secret"})):
                result = runner.safe_environment(
                    base, phase, contract, observations, root / "lifecycle.jsonl",
                    root / "progress.jsonl", root / "timings.json")
            return result, node, ambient, base, created
        except BaseException:
            for path in created:
                shutil.rmtree(path, ignore_errors=True)
            raise

    @staticmethod
    def _static_fixture(root: Path, *, bridge: str = "present",
                        extra: tuple[str, str, str] | None = None):
        service = root / "services/ifpmic_api"
        tests = root / "tests/ifpmic_api"
        service.mkdir(parents=True)
        tests.mkdir(parents=True)
        bridge_path = service / "snapshot_bridge.mjs"
        if bridge != "missing":
            bridge_path.write_text("// synthetic pinned bridge\n", encoding="utf-8")
        bridge_sha = hashlib.sha256(bridge_path.read_bytes()).hexdigest() if bridge_path.exists() else "0" * 64
        if bridge == "altered":
            bridge_path.write_text("// altered pinned bridge\n", encoding="utf-8")
        elif bridge == "symlink":
            bridge_path.unlink()
            target = root / "outside-bridge.mjs"
            target.write_text("// symlink target\n", encoding="utf-8")
            bridge_path.symlink_to(target)
        if extra is not None:
            folder, name, kind = extra
            extra_path = root / folder / name
            if kind == "broken-symlink":
                extra_path.symlink_to(service / "absent-target.js")
            elif kind == "symlink":
                target = root / ("target" + extra_path.suffix)
                target.write_text("// extra symlink target\n", encoding="utf-8")
                extra_path.symlink_to(target)
            else:
                extra_path.write_text("// unpinned node source\n", encoding="utf-8")
        contract = {
            "attestation_inputs": {
                f"unrelated_anchor_{index}": {"path": f"anchors/{index}", "sha256": "0" * 64}
                for index in range(19)
            },
            "binary_inputs": {
                f"unrelated_binary_{index}": {"path": f"binaries/{index}", "sha256": "0" * 64}
                for index in range(7)
            },
            "attestation_policy": {"environment_roots": {"synthetic": "environment"}},
        }
        (root / "environment").mkdir()
        ledger = {
            "source_pins": {"services/ifpmic_api/snapshot_bridge.mjs": bridge_sha},
            "derivative_ledgers": {},
        }
        return contract, ledger

    def _verify_static_anchors(self, root: Path, contract: dict, ledger: dict) -> None:
        def mocked_anchor_hash(path: Path, expected: str, what: str) -> bytes:
            self.assertTrue(path.is_absolute())
            self.assertEqual(expected, "0" * 64)
            return b"synthetic unrelated anchor"

        with (patch.object(runner, "ROOT", root),
              patch.object(runner, "require_file_hash", side_effect=mocked_anchor_hash)):
            runner.verify_static_anchors(contract, ledger)

    def test_safe_environment_uses_only_hash_pinned_node_before_other_nodes(self) -> None:
        for case, bad_hash, missing_node in (
                ("valid", False, False), ("bad-hash", True, False), ("missing", False, True)):
            with self.subTest(case=case), tempfile.TemporaryDirectory(prefix="h2-node-path-") as temp:
                root = Path(temp)
                if case != "valid":
                    with self.assertRaisesRegex(RuntimeError, "pinned Node executable"):
                        self._safe_environment(root, bad_hash=bad_hash, missing_node=missing_node)
                    continue
                (env, _), node, ambient, base, created = self._safe_environment(root)
                try:
                    self.assertEqual(shutil.which("node", path=env["PATH"]), str(node))
                    self.assertEqual(env["PATH"].split(os.pathsep),
                                     [str(node.parent), str(base / "bin"), "/usr/bin", "/bin"])
                    self.assertNotEqual(shutil.which("node", path=str(ambient)), str(node))
                    self.assertEqual(env["IFPMIC_NODE_EXECUTABLE"], str(node))
                    self.assertEqual(env["PGPASSFILE"], str(root / "capture/case/empty-pgpass"))
                    self.assertEqual(env["PGSERVICEFILE"],
                                     str(root / "capture/case/empty-pg-service.conf"))
                    self.assertEqual(env["PGSYSCONFDIR"], str(root / "capture/case/empty-pg-system"))
                    self.assertEqual(env["PYTHONPATH"], str(runner.ROOT))
                    self.assertEqual(env["PYTHONDONTWRITEBYTECODE"], "1")
                    self.assertEqual(env["PYTEST_DISABLE_PLUGIN_AUTOLOAD"], "1")
                    self.assertEqual(env["LANG"], "C.UTF-8")
                    self.assertEqual(env["LC_ALL"], "C.UTF-8")
                    self.assertTrue(Path(env["TMPDIR"]).is_dir())
                    self.assertEqual(Path(env["TMPDIR"]).stat().st_mode & 0o777, 0o700)
                    self.assertNotIn("DATABASE_URL", env)
                    self.assertNotIn(str(ambient), env["PATH"])
                finally:
                    for path in created:
                        shutil.rmtree(path, ignore_errors=True)

    def test_static_source_closure_accepts_pinned_bridge_and_rejects_missing_or_changed(self) -> None:
        for case in ("present", "missing", "altered", "symlink"):
            with self.subTest(case=case), tempfile.TemporaryDirectory(prefix="h2-node-bridge-") as temp:
                root = Path(temp)
                contract, ledger = self._static_fixture(root, bridge=case)
                if case == "present":
                    self._verify_static_anchors(root, contract, ledger)
                else:
                    with self.assertRaises(RuntimeError):
                        self._verify_static_anchors(root, contract, ledger)

        with tempfile.TemporaryDirectory(prefix="h2-node-bridge-omitted-pin-") as temp:
            root = Path(temp)
            contract, ledger = self._static_fixture(root, bridge="present")
            self.assertTrue((root / "services/ifpmic_api/snapshot_bridge.mjs").is_file())
            ledger["source_pins"].clear()
            with self.assertRaisesRegex(RuntimeError, "source closure"):
                self._verify_static_anchors(root, contract, ledger)

    def test_static_source_closure_rejects_unpinned_node_source_suffixes_and_symlinks(self) -> None:
        folders = ("services/ifpmic_api", "tests/ifpmic_api")
        cases = [(folder, f"extra{suffix}", "file")
                 for folder in folders for suffix in (".mjs", ".js", ".cjs")]
        cases.extend((folder, name, kind) for folder in folders for name, kind in (
            ("extra.mjs", "symlink"), ("extra.js", "broken-symlink"),
            ("extra.cjs", "symlink")))
        for folder, name, kind in cases:
            with self.subTest(folder=folder, name=name, kind=kind), tempfile.TemporaryDirectory(
                    prefix="h2-node-extra-") as temp:
                root = Path(temp)
                contract, ledger = self._static_fixture(root, extra=(folder, name, kind))
                with self.assertRaisesRegex(RuntimeError, "source closure"):
                    self._verify_static_anchors(root, contract, ledger)


class CurrentCandidatePolicyTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
