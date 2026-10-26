"""Pure V3 admission DTO invariants, independent of SQL implementation."""

from __future__ import annotations

from uuid import uuid4

import pytest

from services.ifpmic_api.admission import validate_admission
from services.ifpmic_api.errors import ApiError


JOB_ID = "18bd95e4-5d59-4f3e-93cf-8bccfb07460d"
COMMAND_ID = "19bcaea1-300b-47d2-a821-cf76d725cbd0"
RUN_ID = "2a0b4d75-5674-4dda-b523-599c8438969a"
JOB_STATUSES = {
    "DRAFT", "QUEUED", "RUNNING", "WAITING_HUMAN", "WAITING_DEVICE", "PAUSED",
    "RECONCILING", "FAILED", "CANCELED", "NO_CHANGE", "RELEASED_PENDING_NOTES", "COMPLETED",
}


def _dto(phase: str) -> dict:
    value = {
        "schema_version": "ifpmic.admission-status.v1",
        "job_id": JOB_ID,
        "command_id": COMMAND_ID,
        "admission_status": phase,
        "job_status": "DRAFT",
        "job_revision": 0,
        "command_status": "accepted",
        "applied_revision": None,
        "admitted_run_id": None,
        "receipt": None,
        "error_code": None,
    }
    if phase == "admitted_pending_projection":
        value["admitted_run_id"] = RUN_ID
    elif phase == "applied":
        value.update(job_status="QUEUED", job_revision=1, command_status="applied",
                     applied_revision=1, admitted_run_id=RUN_ID)
        value["receipt"] = {
            "transition_sequence": 1, "outcome": "applied", "expected_revision": 0,
            "applied_revision": 1, "projected_job_status": "QUEUED", "projected_revision": 1,
        }
    elif phase == "rejected":
        value.update(command_status="rejected", admitted_run_id=RUN_ID,
                     error_code="PROFILE_INELIGIBLE")
        value["receipt"] = {
            "transition_sequence": 1, "outcome": "rejected", "expected_revision": 0,
            "applied_revision": None, "projected_job_status": "DRAFT", "projected_revision": 0,
        }
    elif phase == "quarantined":
        value["error_code"] = "BUILD_UNAVAILABLE"
    return value


@pytest.mark.parametrize(
    "phase", ["pending", "admitted_pending_projection", "applied", "rejected", "quarantined"]
)
def test_all_admission_phases_accept_the_literal_v3_dto(phase):
    dto = _dto(phase)
    assert validate_admission(dto, job_id=JOB_ID, command_id=COMMAND_ID, job_statuses=JOB_STATUSES) == dto


@pytest.mark.parametrize("mutation", [
    lambda value: value.update(extra="private"),
    lambda value: value.update(job_id=str(uuid4())),
    lambda value: value.update(command_id=str(uuid4())),
    lambda value: value.update(job_revision=True),
    lambda value: value.update(error_code=7),
    lambda value: value["receipt"].update(extra="unexpected"),
    lambda value: value["receipt"].update(transition_sequence=2),
    lambda value: value["receipt"].update(applied_revision=True),
])
def test_admission_rejects_identity_type_and_receipt_drift(mutation):
    dto = _dto("applied")
    mutation(dto)
    with pytest.raises(ApiError) as raised:
        validate_admission(dto, job_id=JOB_ID, command_id=COMMAND_ID, job_statuses=JOB_STATUSES)
    assert raised.value.code == "DEPENDENCY_UNAVAILABLE"


@pytest.mark.parametrize("code", ["SQLSTATE_23514", "raw exception", ""])
def test_admission_rejects_unknown_quarantine_codes(code):
    dto = _dto("quarantined")
    dto["error_code"] = code
    with pytest.raises(ApiError) as raised:
        validate_admission(dto, job_id=JOB_ID, command_id=COMMAND_ID, job_statuses=JOB_STATUSES)
    assert raised.value.code == "DEPENDENCY_UNAVAILABLE"


def test_rejected_requires_receipt_and_approved_rejection_code():
    dto = _dto("rejected")
    dto["receipt"] = None
    with pytest.raises(ApiError):
        validate_admission(dto, job_id=JOB_ID, command_id=COMMAND_ID, job_statuses=JOB_STATUSES)
    dto = _dto("rejected")
    dto["error_code"] = "BUILD_UNAVAILABLE"
    with pytest.raises(ApiError):
        validate_admission(dto, job_id=JOB_ID, command_id=COMMAND_ID, job_statuses=JOB_STATUSES)
