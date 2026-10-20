"""Unit tests for private H2 case-artifact rules.

All evidence is synthetic and lives in strict-mode temporary directories. The
test decoder below exercises the PBSeq structure gate only; it does not prove
compatibility with the pinned Temporal SDK or full H2 acceptance.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
from uuid import uuid4

from scripts.ifpmic_h2_artifacts import (
    ArtifactRule,
    CaseArtifacts,
    EvidenceError,
    audit_artifacts,
    prepare_phase_rules,
)


NODE_A = "tests/ifpmic_api/test_machine_example.py::test_alpha"
NODE_B = "tests/ifpmic_api/test_machine_example.py::test_beta"
IDENTITY_KIND = "ifpmic.b03.h2.case-identity.v1"


def _json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=True, sort_keys=True,
                       separators=(",", ":"), allow_nan=False) + "\n").encode("ascii")


def _case(node: str = NODE_A, directory: str = "case-a", *,
          rules: tuple[ArtifactRule, ...] | None = None,
          identity_file: str | None = None) -> CaseArtifacts:
    return CaseArtifacts(node, directory, rules or (ArtifactRule("result.json", "json"),),
                         identity_file=identity_file)


def _phase_row(node: str, phase: str, *, artifacts=None, unresolved=None) -> dict:
    row = {
        "node_id": node,
        "phase": phase,
        "case_directory": node.rsplit("::", 1)[-1],
        "unresolved": [] if unresolved is None else unresolved,
        "minimum_owner": 0,
        "queries_min": {},
        "queries_max": {},
        "artifacts": artifacts if artifacts is not None else [
            {"path": "result.json", "format": "json", "minimum": 1,
             "maximum": 1, "required_keys": []}
        ],
    }
    return row


class ArtifactAuditTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="h2-artifact-audit-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "evidence"
        self._mkdir(self.root)

    def _mkdir(self, path: Path) -> Path:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        current = path
        while current == self.root or self.root in current.parents:
            current.chmod(0o700)
            if current == self.root:
                break
            current = current.parent
        return path

    def _write(self, relative: str, raw: bytes, *, mode: int = 0o600) -> Path:
        path = self.root / relative
        self._mkdir(path.parent)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        try:
            os.fchmod(fd, mode)
            view = memoryview(raw)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    raise OSError("short synthetic evidence write")
                view = view[written:]
        finally:
            os.close(fd)
        return path

    def _json(self, relative: str, value: object) -> Path:
        return self._write(relative, _json_bytes(value))

    def _audit(self, cases=None, *, decoder=None, max_bytes=64 * 1024 * 1024):
        return audit_artifacts(self.root, cases if cases is not None else [_case()],
                               decode_history=decoder, max_bytes=max_bytes)

    def _assert_code(self, code: str, callback) -> None:
        with self.assertRaises(EvidenceError) as captured:
            callback()
        self.assertEqual(str(captured.exception), code)

    def test_valid_json_and_manifest_are_indexed_without_acceptance_claim(self) -> None:
        self._json("case-a/result.json", {"status": "observed", "rows": []})
        result = self._audit()
        self.assertEqual(result["scope"], "case_artifact_structure_and_decoded_history_only")
        self.assertIs(result["h2_accepted"], False)
        entry = result["cases"][NODE_A]["files"][0]
        raw = (self.root / "case-a/result.json").read_bytes()
        self.assertEqual(entry["sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(entry["bytes"], len(raw))
        self.assertEqual(entry["document_count"], 1)

    def test_jsonl_filters_records_for_exact_node(self) -> None:
        rows = [
            {"nodeid": NODE_A, "event": "open"},
            {"nodeid": NODE_B, "event": "close"},
        ]
        raw = b"".join(_json_bytes(row) for row in rows)
        self._write("case-a/events.jsonl", raw)
        cases = [_case(rules=(ArtifactRule("events.jsonl", "jsonl",
                                           required_keys=("nodeid", "event"),
                                           node_field="nodeid"),))]
        result = self._audit(cases)
        self.assertEqual(result["cases"][NODE_A]["files"][0]["document_count"], 1)

    def test_required_json_fields_are_enforced(self) -> None:
        self._json("case-a/result.json", {"status": "observed"})
        case = _case(rules=(ArtifactRule("result.json", "json",
                                         required_keys=("status", "evidence")),))
        self._assert_code("ARTIFACT_FIELDS_MISSING", lambda: self._audit([case]))

    def test_strict_json_rejects_duplicate_keys(self) -> None:
        self._write("case-a/result.json", b'{"state":"before","state":"after"}')
        self._assert_code("DUPLICATE_JSON_KEY", self._audit)

    def test_missing_artifact_has_exact_count_failure(self) -> None:
        self._mkdir(self.root / "case-a")
        self._assert_code("ARTIFACT_MATCH_COUNT", self._audit)

    def test_path_traversal_is_rejected_before_read(self) -> None:
        case = _case(rules=(ArtifactRule("../secret.json", "json"),))
        self._assert_code("INVALID_ARTIFACT_PATTERN", lambda: self._audit([case]))

    def test_symlinked_artifact_is_rejected(self) -> None:
        target = self._json("case-a/target.json", {"ok": True})
        (self.root / "case-a/result.json").symlink_to(target.name)
        self._assert_code("PRIVATE_FILE_UNAVAILABLE", self._audit)

    def test_hardlinked_artifact_is_rejected(self) -> None:
        target = self._json("case-a/result.json", {"ok": True})
        os.link(target, self.root / "case-a/second.json")
        case = _case(rules=(ArtifactRule("*.json", "json", minimum=2, maximum=2),))
        self._assert_code("INVALID_PRIVATE_FILE", lambda: self._audit([case]))

    def test_wrong_file_mode_is_rejected(self) -> None:
        path = self._json("case-a/result.json", {"ok": True})
        path.chmod(0o640)
        self._assert_code("INVALID_PRIVATE_FILE", self._audit)

    def test_wrong_root_mode_is_rejected(self) -> None:
        self._json("case-a/result.json", {"ok": True})
        self.root.chmod(0o750)
        self._assert_code("INVALID_PRIVATE_DIRECTORY", self._audit)

    def test_symlinked_case_directory_is_rejected(self) -> None:
        self._json("actual/result.json", {"ok": True})
        (self.root / "case-a").symlink_to("actual", target_is_directory=True)
        self._assert_code("PRIVATE_DIRECTORY_UNAVAILABLE", self._audit)

    def test_symlinked_root_ancestor_is_rejected(self) -> None:
        self._json("case-a/result.json", {"ok": True})
        alias = Path(self.temp.name) / "alias"
        alias.symlink_to(Path(self.temp.name), target_is_directory=True)
        self._assert_code("SYMLINK_ROOT_PATH", lambda: audit_artifacts(
            alias / "evidence", [_case()]))

    def test_ambiguous_case_directories_are_rejected(self) -> None:
        self._json("case-a1/result.json", {"ok": True})
        self._json("case-a2/result.json", {"ok": True})
        case = _case(directory="case-a*")
        self._assert_code("CASE_DIRECTORY_MISSING_OR_AMBIGUOUS",
                          lambda: self._audit([case]))

    def test_artifact_match_maximum_is_enforced(self) -> None:
        self._json("case-a/a.json", {"ok": True})
        self._json("case-a/b.json", {"ok": True})
        case = _case(rules=(ArtifactRule("*.json", "json", minimum=1, maximum=1),))
        self._assert_code("ARTIFACT_MATCH_COUNT", lambda: self._audit([case]))

    def test_overlapping_artifact_patterns_cannot_claim_one_file_twice(self) -> None:
        self._json("case-a/result.json", {"ok": True})
        case = _case(rules=(
            ArtifactRule("*.json", "json"),
            ArtifactRule("result.json", "json"),
        ))
        self._assert_code("DUPLICATE_CASE_ARTIFACT", lambda: self._audit([case]))

    def test_shared_journal_can_be_scoped_to_each_exact_node(self) -> None:
        self._write("events.jsonl", b"".join(_json_bytes(row) for row in (
            {"nodeid": NODE_A, "event": "a"},
            {"nodeid": NODE_B, "event": "b"},
        )))
        rule = ArtifactRule("events.jsonl", "jsonl", required_keys=("nodeid", "event"),
                            node_field="nodeid")
        result = self._audit([
            _case(NODE_A, ".", rules=(rule,)),
            _case(NODE_B, ".", rules=(rule,)),
        ])
        self.assertEqual(result["cases"][NODE_A]["files"][0]["document_count"], 1)
        self.assertEqual(result["cases"][NODE_B]["files"][0]["document_count"], 1)

    def test_shared_journal_missing_exact_node_record_fails(self) -> None:
        self._write("events.jsonl", _json_bytes({"nodeid": NODE_B, "event": "b"}))
        rule = ArtifactRule("events.jsonl", "jsonl", required_keys=("nodeid", "event"),
                            node_field="nodeid")
        self._assert_code("CASE_JOURNAL_RECORD_MISSING", lambda: self._audit([
            _case(NODE_A, ".", rules=(rule,)),
        ]))

    def test_unscoped_shared_artifact_is_rejected(self) -> None:
        self._json("shared.json", {"ok": True})
        case_a = _case(NODE_A, ".", rules=(ArtifactRule("shared.json", "json"),))
        case_b = _case(NODE_B, ".", rules=(ArtifactRule("shared.json", "json"),))
        self._assert_code("UNSCOPED_SHARED_ARTIFACT",
                          lambda: self._audit([case_a, case_b]))

    def test_case_identity_selects_the_matching_dynamic_directory(self) -> None:
        for name, node in (("case-one", NODE_A), ("case-two", NODE_B)):
            self._json(name + "/case-node.json", {
                "kind": IDENTITY_KIND, "node_id": node,
                "pytest_current_test": node + " (call)",
            })
            self._json(name + "/result.json", {"node": node})
        case = _case(directory="case-*", rules=(
            ArtifactRule("case-node.json", "json", required_keys=(
                "kind", "node_id", "pytest_current_test")),
            ArtifactRule("result.json", "json"),
        ), identity_file="case-node.json")
        result = self._audit([case])
        self.assertEqual(result["cases"][NODE_A]["case_directory"], "case-one")

    def test_case_identity_requires_exact_kind_and_matching_node_phase(self) -> None:
        cases = (
            {"kind": "wrong", "node_id": NODE_A, "pytest_current_test": NODE_A + " (call)"},
            {"kind": IDENTITY_KIND, "node_id": NODE_A, "pytest_current_test": NODE_A + " (complete)"},
            {"kind": IDENTITY_KIND, "node_id": NODE_B, "pytest_current_test": NODE_A + " (call)"},
        )
        for index, identity in enumerate(cases):
            with self.subTest(index=index):
                self._json("case-a/case-node.json", identity)
                self._json("case-a/result.json", {"ok": True})
                case = _case(identity_file="case-node.json")
                self._assert_code("INVALID_CASE_IDENTITY", lambda: self._audit([case]))
                # Recreate an isolated root for the next independent negative.
                self.tearDown()
                self.setUp()

    def test_two_matching_identity_directories_are_rejected(self) -> None:
        for name in ("case-one", "case-two"):
            self._json(name + "/case-node.json", {
                "kind": IDENTITY_KIND, "node_id": NODE_A,
                "pytest_current_test": NODE_A + " (teardown)",
            })
            self._json(name + "/result.json", {"ok": True})
        case = _case(directory="case-*", identity_file="case-node.json")
        self._assert_code("CASE_DIRECTORY_MISSING_OR_AMBIGUOUS",
                          lambda: self._audit([case]))

    def test_pbseq_requires_injected_decoder_and_valid_nonempty_frames(self) -> None:
        payload = b"event-one"
        self._write("case-a/history.pbseq", struct.pack(">Q", len(payload)) + payload)
        case = _case(rules=(ArtifactRule("history.pbseq", "pbseq"),))
        self._assert_code("HISTORY_DECODER_REQUIRED", lambda: self._audit([case]))
        result = self._audit([case], decoder=lambda frames: [
            {"event_id": 1, "event_type": 1},
        ])
        self.assertIs(result["h2_accepted"], False)
        self.assertEqual(result["cases"][NODE_A]["files"][0]["event_count"], 1)

    def test_pbseq_rejects_empty_truncated_zero_and_overlong_frames(self) -> None:
        case = _case(rules=(ArtifactRule("history.pbseq", "pbseq"),))
        bad_frames = (
            (b"", "EMPTY_HISTORY"),
            (b"\x00" * 7, "TRUNCATED_HISTORY_FRAME"),
            (struct.pack(">Q", 0), "INVALID_HISTORY_FRAME_LENGTH"),
            (struct.pack(">Q", 4) + b"ab", "INVALID_HISTORY_FRAME_LENGTH"),
        )
        for raw, code in bad_frames:
            with self.subTest(code=code):
                self._write("case-a/history.pbseq", raw)
                self._assert_code(code, lambda: self._audit(
                    [case], decoder=lambda frames: []))
                self.tearDown()
                self.setUp()

    def test_pbseq_rejects_decoder_failure_count_and_event_sequence(self) -> None:
        self._write("case-a/history.pbseq", struct.pack(">Q", 1) + b"x")
        case = _case(rules=(ArtifactRule("history.pbseq", "pbseq"),))
        self._assert_code("HISTORY_DECODE_FAILED", lambda: self._audit(
            [case], decoder=lambda _frames: (_ for _ in ()).throw(RuntimeError())))
        self._assert_code("HISTORY_EVENT_COUNT_MISMATCH", lambda: self._audit(
            [case], decoder=lambda _frames: []))
        invalid_sequences = (
            ([{"event_id": 2, "event_type": 1}], "INVALID_HISTORY_EVENT"),
            ([{"event_id": 1, "event_type": 2}], "INVALID_WORKFLOW_STARTED_EVENT"),
            ([{"event_id": 1, "event_type": 1}, {"event_id": 2, "event_type": 1}],
             "INVALID_WORKFLOW_STARTED_EVENT"),
        )
        for index, (events, code) in enumerate(invalid_sequences):
            with self.subTest(index=index):
                self.setUp()
                frame_count = len(events)
                raw = b"".join(struct.pack(">Q", 1) + b"x" for _ in range(frame_count))
                self._write("case-a/history.pbseq", raw)
                case = _case(rules=(ArtifactRule("history.pbseq", "pbseq"),))
                self._assert_code(code, lambda events=events, case=case: self._audit(
                    [case], decoder=lambda _frames: events))

    def test_sha256_links_follow_object_and_array_pointers(self) -> None:
        raw_target = b"private raw evidence\n"
        self._write("case-a/raw.bin", raw_target)
        digest = hashlib.sha256(raw_target).hexdigest()
        self._json("case-a/summary.json", {"result": {"sha": digest},
                                            "links": [{"sha": digest}]})
        case = _case(rules=(ArtifactRule("summary.json", "json", sha256_links={
            "/result/sha": "raw.bin", "/links/0/sha": "raw.bin",
        }), ArtifactRule("raw.bin", "bytes")))
        result = self._audit([case])
        self.assertEqual(len(result["cases"][NODE_A]["files"]), 2)

    def test_sha256_link_mismatch_and_missing_pointer_fail_closed(self) -> None:
        self._write("case-a/raw.bin", b"actual")
        self._json("case-a/summary.json", {"items": [{"sha": "0" * 64}]})
        mismatch = _case(rules=(ArtifactRule("summary.json", "json", sha256_links={
            "/items/0/sha": "raw.bin",
        }),))
        self._assert_code("ARTIFACT_DIGEST_MISMATCH", lambda: self._audit([mismatch]))
        missing = _case(rules=(ArtifactRule("summary.json", "json", sha256_links={
            "/items/2/sha": "raw.bin",
        }),))
        self._assert_code("DIGEST_FIELD_MISSING", lambda: self._audit([missing]))

    def test_sha256_link_rejects_unsafe_target(self) -> None:
        self._json("case-a/summary.json", {"sha": "0" * 64})
        case = _case(rules=(ArtifactRule("summary.json", "json", sha256_links={
            "/sha": "../secret",
        }),))
        self._assert_code("INVALID_ARTIFACT_PATTERN", lambda: self._audit([case]))


class PhaseRuleBindingTests(unittest.TestCase):
    def _document(self) -> dict:
        return {
            "kind": "ifpmic.b03.h2.runtime-full-machine-evidence-rules.v1",
            "status": "candidate_pending_exact_review",
            "unresolved": [],
            "cases": [_phase_row(NODE_A, "phase-a"), _phase_row(NODE_B, "phase-b")],
        }

    def _bind(self, document=None, *, phase="phase-a", phase_nodes=None,
              expected_nodes=None):
        return prepare_phase_rules(
            document if document is not None else self._document(), phase,
            phase_nodes if phase_nodes is not None else {NODE_A},
            expected_nodes if expected_nodes is not None else {NODE_A, NODE_B},
        )

    def _assert_code(self, code: str, callback) -> None:
        with self.assertRaises(EvidenceError) as captured:
            callback()
        self.assertEqual(str(captured.exception), code)

    def test_exact_phase_and_full_case_set_bind_to_typed_rules(self) -> None:
        recorders, artifacts = self._bind()
        self.assertEqual([row.node_id for row in recorders], [NODE_A])
        self.assertEqual([row.node_id for row in artifacts], [NODE_A])
        self.assertEqual(artifacts[0].artifacts[0].path, "result.json")

    def test_draft_or_global_unresolved_rules_are_rejected(self) -> None:
        document = self._document()
        document["status"] = "draft_no_execution"
        self._assert_code("UNRESOLVED_MACHINE_RULES", lambda: self._bind(document))
        document = self._document()
        document["unresolved"] = ["source gap"]
        self._assert_code("UNRESOLVED_MACHINE_RULES", lambda: self._bind(document))

    def test_case_unresolved_rules_are_rejected(self) -> None:
        document = self._document()
        document["cases"][0]["unresolved"] = ["case gap"]
        self._assert_code("UNRESOLVED_CASE_RULES", lambda: self._bind(document))

    def test_missing_extra_or_duplicate_expected_case_ids_are_rejected(self) -> None:
        self._assert_code("MACHINE_CASE_SET_MISMATCH", lambda: self._bind(
            expected_nodes={NODE_A}))
        document = self._document()
        document["cases"].append(dict(document["cases"][0]))
        self._assert_code("MACHINE_CASE_SET_MISMATCH", lambda: self._bind(document))

    def test_phase_membership_must_match_exact_rows(self) -> None:
        self._assert_code("CASE_PHASE_MISMATCH", lambda: self._bind(
            phase_nodes={NODE_B}))
        self._assert_code("CASE_PHASE_MISMATCH", lambda: self._bind(
            phase_nodes={NODE_A, NODE_B}))

    def test_unknown_artifact_constraint_is_rejected(self) -> None:
        document = self._document()
        document["cases"][0]["artifacts"][0]["optional"] = True
        self._assert_code("UNKNOWN_ARTIFACT_CONSTRAINT", lambda: self._bind(document))

    def test_missing_recorder_or_artifact_fields_are_rejected(self) -> None:
        document = self._document()
        del document["cases"][0]["minimum_owner"]
        self._assert_code("MACHINE_RECORDER_RULE_MISSING", lambda: self._bind(document))
        document = self._document()
        del document["cases"][0]["artifacts"][0]["required_keys"]
        self._assert_code("INVALID_MACHINE_ARTIFACT", lambda: self._bind(document))


if __name__ == "__main__":
    unittest.main()
