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


if __name__ == "__main__":
    unittest.main()
