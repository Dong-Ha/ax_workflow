"""Unit tests for private H2 owner/query recorder auditing.

These tests use only synthetic temporary evidence. They deliberately do not
import product, SDK, pytest-plugin, or service code.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from scripts.ifpmic_h2_raw_evidence import (
    EvidenceError,
    RecorderRequirement,
    audit_recorders,
)


NODE = "tests/ifpmic_api/test_example.py::test_recorders"
JOB_ID = "12345678-1234-5678-1234-567812345678"
OWNER_KIND = "ifpmic.b03.h2.owner-snapshot-observation.v1"
QUERY_KIND = "ifpmic.b03.h2.query-observation.v1"
NO_RESULT = object()


def owner_snapshot() -> dict:
    return {
        "accepted": None,
        "bindings": [],
        "scopes": [],
        "receipts": [],
        "attempts": [],
        "noncreate_commands": 0,
    }


def caller() -> dict:
    return {"file": "test_example.py", "function": "_observe", "line": 42}


class RawRecorderAuditTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="h2-raw-audit-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "evidence"
        self.root.mkdir(mode=0o700)
        self.owner_dir = self.root / "owner-snapshots" / JOB_ID
        self.query_dir = self.root / "query-observations"

    def _write(self, directory: Path, timestamp: int, document: dict,
               raw: bytes | None = None, filename_suffix: str | None = None) -> Path:
        relative = directory.relative_to(self.root)
        current = self.root
        for part in relative.parts:
            current = current / part
            current.mkdir(mode=0o700, exist_ok=True)
            current.chmod(0o700)
        suffix = filename_suffix or uuid4().hex
        path = directory / f"{timestamp}-{suffix}.json"
        payload = raw if raw is not None else (
            json.dumps(document, ensure_ascii=True, sort_keys=True,
                       separators=(",", ":"), allow_nan=False).encode("ascii") + b"\n"
        )
        path.write_bytes(payload)
        path.chmod(0o600)
        return path

    def _owner(self, timestamp: int = 100, *, node: str = NODE + " (call)",
               snapshot: dict | None = None, **overrides) -> Path:
        snapshot = owner_snapshot() if snapshot is None else snapshot
        canonical = json.dumps(snapshot, ensure_ascii=True, sort_keys=True,
                               separators=(",", ":"), allow_nan=False).encode("ascii")
        document = {
            "kind": OWNER_KIND,
            "job_id": JOB_ID,
            "pytest_current_test": node,
            "observed_monotonic_ns": timestamp,
            "caller": caller(),
            "snapshot_sha256": hashlib.sha256(canonical).hexdigest(),
            "snapshot": snapshot,
        }
        document.update(overrides)
        return self._write(self.owner_dir, timestamp, document)

    def _query(self, operation: str = "temporal.list_workflows", timestamp: int = 101,
               *, node: str = NODE + " (call)", result=NO_RESULT, **overrides) -> Path:
        document = {
            "kind": QUERY_KIND,
            "operation": operation,
            "subject": "workflow/example",
            "result": [] if result is NO_RESULT else result,
            "pytest_current_test": node,
            "observed_monotonic_ns": timestamp,
            "caller": caller(),
        }
        document.update(overrides)
        return self._write(self.query_dir, timestamp, document)

    def _audit(self, *, requirements=None, known_nodes=None, max_bytes=64 * 1024 * 1024):
        return audit_recorders(
            self.root,
            requirements if requirements is not None else [RecorderRequirement(NODE)],
            known_nodes=known_nodes,
            max_bytes=max_bytes,
        )

    def _assert_code(self, code: str, callback) -> None:
        with self.assertRaises(EvidenceError) as captured:
            callback()
        self.assertEqual(str(captured.exception), code)

    def test_valid_owner_and_query_records_return_private_file_manifest(self) -> None:
        owner_path = self._owner()
        query_path = self._query()

        result = self._audit()

        self.assertEqual(result["scope"], "owner_query_recorders_only")
        self.assertIs(result["h2_accepted"], False)
        self.assertEqual(result["cases"][NODE], {
            "owner_records": 1,
            "query_records": {"temporal.list_workflows": 1},
        })
        manifest = {row["sha256"]: row for row in result["files"]}
        for path in (owner_path, query_path):
            row = manifest[hashlib.sha256(path.read_bytes()).hexdigest()]
            self.assertEqual(row["bytes"], path.stat().st_size)
            self.assertEqual(row["node_id"], NODE)
            self.assertEqual(row["pytest_phase"], "call")

    def test_preserves_setup_call_and_teardown_phase_metadata(self) -> None:
        for timestamp, phase in ((100, "setup"), (101, "call"), (102, "teardown")):
            self._query(timestamp=timestamp, node=f"{NODE} ({phase})")

        result = self._audit(requirements=[RecorderRequirement(
            NODE, queries_min={"temporal.list_workflows": 3})])

        self.assertEqual(result["cases"][NODE]["query_records"],
                         {"temporal.list_workflows": 3})
        self.assertEqual({row["pytest_phase"] for row in result["files"]},
                         {"setup", "call", "teardown"})

    def test_empty_actual_query_result_is_valid(self) -> None:
        self._query(result=[])
        self.assertEqual(self._audit()["cases"][NODE]["query_records"],
                         {"temporal.list_workflows": 1})

    def test_null_actual_query_result_is_valid_and_preserved_as_an_observation(self) -> None:
        self._query(result=None)
        self.assertEqual(self._audit()["cases"][NODE]["query_records"],
                         {"temporal.list_workflows": 1})

    def test_missing_required_owner_record_fails(self) -> None:
        self._assert_code("OWNER_OBSERVATIONS_MISSING", lambda: self._audit(
            requirements=[RecorderRequirement(NODE, minimum_owner=1)]))

    def test_missing_required_query_operation_fails(self) -> None:
        self._owner()
        self._assert_code("QUERY_OBSERVATIONS_MISSING", lambda: self._audit(
            requirements=[RecorderRequirement(
                NODE, queries_min={"temporal.list_workflows": 1})]))

    def test_cross_node_record_cannot_satisfy_requirement(self) -> None:
        other = NODE.replace("test_recorders", "other_test")
        self._owner(node=other + " (call)")
        self._query(node=other + " (call)")
        self._assert_code("OWNER_OBSERVATIONS_MISSING", lambda: self._audit(
            requirements=[RecorderRequirement(NODE, minimum_owner=1,
                queries_min={"temporal.list_workflows": 1})], known_nodes={NODE, other}))

    def test_unknown_node_fails_without_allowlist(self) -> None:
        other = NODE.replace("test_recorders", "other_test")
        self._query(node=other + " (call)")
        self._assert_code("UNEXPECTED_TEST_ID", lambda: self._audit(
            requirements=[RecorderRequirement(NODE)], known_nodes={NODE}))

    def test_owner_snapshot_digest_tampering_fails(self) -> None:
        self._owner(snapshot={**owner_snapshot(), "noncreate_commands": 1})
        path = next(self.owner_dir.glob("*.json"))
        document = json.loads(path.read_bytes())
        document["snapshot"]["noncreate_commands"] = 2
        path.write_text(json.dumps(document), encoding="utf-8")
        path.chmod(0o600)
        self._assert_code("SNAPSHOT_DIGEST_MISMATCH", self._audit)

    def test_duplicate_copied_owner_observation_does_not_count_twice(self) -> None:
        self._owner(timestamp=100)
        self._owner(timestamp=100)
        self._assert_code("DUPLICATE_OBSERVATION", lambda: self._audit(
            requirements=[RecorderRequirement(NODE, minimum_owner=2)]))

    def test_duplicate_copied_query_observation_does_not_count_twice(self) -> None:
        self._query(timestamp=100)
        self._query(timestamp=100)
        self._assert_code("DUPLICATE_OBSERVATION", lambda: self._audit(
            requirements=[RecorderRequirement(
                NODE, queries_min={"temporal.list_workflows": 2})]))

    def test_owner_snapshot_shape_is_enforced(self) -> None:
        bad = {**owner_snapshot(), "accepted": ["wrong", "width"]}
        self._owner(snapshot=bad)
        self._assert_code("INVALID_ACCEPTED_ROW", self._audit)

    def test_required_query_maximum_is_enforced(self) -> None:
        self._query(timestamp=100)
        self._query(timestamp=101)
        requirement = RecorderRequirement(
            NODE, queries_min={"temporal.list_workflows": 1},
            queries_max={"temporal.list_workflows": 1})
        self._assert_code("QUERY_OBSERVATIONS_EXCESS", lambda: self._audit(
            requirements=[requirement]))

    def test_duplicate_requirement_node_is_rejected(self) -> None:
        requirement = RecorderRequirement(NODE)
        self._assert_code("DUPLICATE_REQUIREMENT", lambda: self._audit(
            requirements=[requirement, requirement]))

    def test_invalid_requirement_bounds_are_rejected(self) -> None:
        cases = [
            RecorderRequirement(NODE, minimum_owner=-1),
            RecorderRequirement(NODE, queries_min={"q": -1}),
            RecorderRequirement(NODE, queries_max={"q": -1}),
            RecorderRequirement(NODE, queries_min={"q": 2}, queries_max={"q": 1}),
        ]
        codes = ["INVALID_OWNER_MINIMUM", "INVALID_QUERY_MINIMUM",
                 "INVALID_QUERY_MAXIMUM", "INVALID_QUERY_MAXIMUM"]
        for requirement, code in zip(cases, codes):
            with self.subTest(requirement=requirement):
                self._assert_code(code, lambda r=requirement: self._audit(requirements=[r]))

    def test_duplicate_json_keys_are_rejected(self) -> None:
        raw = (b'{"kind":"ifpmic.b03.h2.query-observation.v1",'
               b'"kind":"ifpmic.b03.h2.query-observation.v1"}')
        self._write(self.query_dir, 100, {}, raw=raw)
        self._assert_code("DUPLICATE_JSON_KEY", lambda: self._audit(
            requirements=[RecorderRequirement(NODE)]))

    def test_nonfinite_json_number_is_rejected(self) -> None:
        self._query()
        path = next(self.query_dir.glob("*.json"))
        path.write_text('{"value":NaN}', encoding="ascii")
        path.chmod(0o600)
        self._assert_code("NONFINITE_JSON", lambda: self._audit(
            requirements=[RecorderRequirement(NODE)]))

    def test_overflowed_json_float_is_rejected(self) -> None:
        self._query()
        path = next(self.query_dir.glob("*.json"))
        path.write_bytes(path.read_bytes().replace(b'"result":[]', b'"result":1e999'))
        path.chmod(0o600)
        self._assert_code("INVALID_JSON_VALUE", lambda: self._audit(
            requirements=[RecorderRequirement(NODE)]))

    def test_very_long_json_integer_is_rejected(self) -> None:
        self._query()
        path = next(self.query_dir.glob("*.json"))
        path.write_bytes(path.read_bytes().replace(b'"result":[]',
                                                    b'"result":' + b'9' * 5000))
        path.chmod(0o600)
        self._assert_code("INVALID_JSON", lambda: self._audit(
            requirements=[RecorderRequirement(NODE)]))

    def test_wrong_filename_timestamp_is_rejected(self) -> None:
        self._query(timestamp=100)
        path = next(self.query_dir.glob("*.json"))
        path.rename(path.with_name(f"999-{uuid4().hex}.json"))
        self._assert_code("INVALID_RECORD_FILENAME", self._audit)

    def test_wrong_file_mode_is_rejected(self) -> None:
        self._query()
        path = next(self.query_dir.glob("*.json"))
        path.chmod(0o640)
        self._assert_code("INVALID_PRIVATE_FILE", self._audit)

    def test_wrong_directory_mode_is_rejected(self) -> None:
        self._query()
        self.query_dir.chmod(0o750)
        self._assert_code("INVALID_PRIVATE_DIRECTORY", self._audit)

    def test_symlinked_record_is_rejected(self) -> None:
        self._query()
        path = next(self.query_dir.glob("*.json"))
        linked = self.query_dir / f"200-{uuid4().hex}.json"
        linked.symlink_to(path.name)
        self._assert_code("PRIVATE_FILE_UNAVAILABLE", self._audit)

    def test_symlinked_observation_directory_is_rejected(self) -> None:
        self._query()
        actual = self.root / "query-observations"
        replacement = self.root / "query-observations-real"
        actual.rename(replacement)
        actual.symlink_to(replacement.name)
        self._assert_code("PRIVATE_DIRECTORY_UNAVAILABLE", self._audit)

    def test_symlinked_root_ancestor_is_rejected(self) -> None:
        self._query()
        alias = Path(self.temp.name) / "alias"
        alias.symlink_to(Path(self.temp.name), target_is_directory=True)
        self._assert_code("SYMLINK_ROOT_PATH", lambda: audit_recorders(
                alias / "evidence",
                [RecorderRequirement(NODE, queries_min={"temporal.list_workflows": 1})],
            ))

    def test_hardlinked_raw_file_is_rejected(self) -> None:
        self._query()
        path = next(self.query_dir.glob("*.json"))
        os.link(path, self.query_dir / f"200-{uuid4().hex}.json")
        self._assert_code("INVALID_PRIVATE_FILE", self._audit)

    def test_oversized_observation_is_rejected(self) -> None:
        self._query()
        self._assert_code("RECORD_TOO_LARGE", lambda: self._audit(max_bytes=8))

    def test_sql_only_case_can_require_no_owner_observations(self) -> None:
        result = self._audit(requirements=[RecorderRequirement(NODE)])
        self.assertEqual(result["cases"][NODE], {
            "owner_records": 0,
            "query_records": {},
        })


if __name__ == "__main__":
    unittest.main()
