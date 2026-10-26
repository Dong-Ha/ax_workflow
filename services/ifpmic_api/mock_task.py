"""Deterministic mock preflight helper and safe public DTO validation."""
import hashlib
import json
import re
from datetime import datetime

from .errors import ApiError
from .request_contract import canonical_uuid

SCHEMA_VERSION = "ifpmic.mock-task.v1"
TASK_KIND = "request-preflight-v1"
CHECKS = ("request_saved", "workspace_ready", "engine_admitted")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_CANONICAL_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_UTC_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$")
_DTO_KEYS = frozenset({"schema_version", "job_id", "command_id", "admitted_run_id", "status", "result", "completed_at"})
_RESULT_KEYS = frozenset({"task_kind", "mode", "outcome", "checks", "result_sha256"})


def evaluate_preflight(value):
    """Return fixed safe result JSON from bounded metadata; never execute user input."""
    if (type(value) is not dict or set(value) != {
            "job_id", "command_id", "admitted_run_id", "build_id", "change_type",
            "base_ref_present", "request_saved", "workspace_ready", "engine_admitted"}):
        raise ValueError("MOCK_TASK_INPUT_INVALID")
    if any(type(value[key]) is not str or not value[key] for key in
           ("job_id", "command_id", "admitted_run_id", "build_id")):
        raise ValueError("MOCK_TASK_INPUT_INVALID")
    if value["change_type"] not in {"NEW_HW", "FEATURE", "BUGFIX"} or type(value["base_ref_present"]) is not bool:
        raise ValueError("MOCK_TASK_INPUT_INVALID")
    if any(value[key] is not True for key in ("request_saved", "workspace_ready", "engine_admitted")):
        raise ValueError("MOCK_TASK_INPUT_NOT_READY")
    identity = {key: value[key] for key in ("job_id", "command_id", "admitted_run_id", "build_id")}
    canonical = json.dumps({"schema_version": SCHEMA_VERSION, "identity": identity,
                            "task_kind": TASK_KIND, "outcome": "passed"},
                           sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    digest = hashlib.sha256(canonical.encode("ascii")).hexdigest()
    return {"task_kind": TASK_KIND, "mode": "mock", "outcome": "passed",
            "checks": [{"name": name, "status": "passed"} for name in CHECKS],
            "result_sha256": digest}


def _require(condition):
    if not condition:
        raise ApiError("DEPENDENCY_UNAVAILABLE")


def _valid_timestamp(value):
    if type(value) is not str or not _UTC_TIMESTAMP.fullmatch(value):
        return False
    try:
        datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return False
    return True


def validate_mock_task(value, expected_ids):
    """Validate the exact safe DTO and every identity supplied by the query."""
    _require(type(value) is dict and set(value) == _DTO_KEYS)
    _require(value["schema_version"] == SCHEMA_VERSION)
    _require(type(expected_ids) is dict)
    for key in ("job_id", "command_id"):
        _require(type(value[key]) is str and _CANONICAL_UUID.fullmatch(value[key])
                 and canonical_uuid(value[key]) and value[key] == expected_ids.get(key))
    expected_run = expected_ids.get("admitted_run_id")
    run = value["admitted_run_id"]
    _require(run is None or (type(run) is str and _CANONICAL_UUID.fullmatch(run) and canonical_uuid(run)))
    if "admitted_run_id" in expected_ids:
        _require(run == expected_run)
    if value["status"] == "pending":
        _require(run is None and value["result"] is None and value["completed_at"] is None)
        return value
    _require(value["status"] == "completed" and run is not None)
    result = value["result"]
    _require(type(result) is dict and set(result) == _RESULT_KEYS)
    _require(result["task_kind"] == TASK_KIND and result["mode"] == "mock" and result["outcome"] == "passed")
    checks = result["checks"]
    _require(type(checks) is list and len(checks) == len(CHECKS))
    for check, name in zip(checks, CHECKS):
        _require(type(check) is dict and set(check) == {"name", "status"}
                 and check["name"] == name and check["status"] == "passed")
    _require(type(result["result_sha256"]) is str and _SHA256.fullmatch(result["result_sha256"]))
    _require(_valid_timestamp(value["completed_at"]))
    return value
