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
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

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


if __name__ == "__main__":
    unittest.main()
