"""Literal H2 Temporal start and activation proposal protocol oracles."""

from __future__ import annotations

import pytest

from services.ifpmic_api.execution_protocol import (
    ProtocolError,
    activation_proposal,
    canonical,
    proposal_digest,
    start_input,
    validate_start,
)

JOB_ID = "11111111-1111-4111-8111-111111111111"
OTHER_JOB_ID = "44444444-4444-4444-8444-444444444444"
RUN_ID = "22222222-2222-4222-8222-222222222222"
COMMAND_ID = "33333333-3333-4333-8333-333333333333"
BUILD_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
BINDING_SHA256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
PAYLOAD_SHA256 = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
TRANSITION_SHA256 = "b57c4106fda564c77e0b8af54e06dd62c1aaec119238df28e0f07ba94db8dd2f"
CHANGED_JOB_TRANSITION_SHA256 = "ee30ec9830018a8eb9363520f8668ceefaa340285550d7dc73d852592f556aa7"


def test_start_input_is_exact_four_field_canonical_unicode_payload():
    value = start_input({
        "job_id": JOB_ID,
        "project_id": "project-雪",
        "binding_sha256": BINDING_SHA256,
    })

    assert value == {
        "protocol_version": "h2-v1",
        "job_id": JOB_ID,
        "project_id": "project-雪",
        "binding_sha256": BINDING_SHA256,
    }
    assert set(value) == {"protocol_version", "job_id", "project_id", "binding_sha256"}
    assert canonical(value) == (
        b'{"binding_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",'
        b'"job_id":"11111111-1111-4111-8111-111111111111",'
        b'"project_id":"project-\\u96ea","protocol_version":"h2-v1"}'
    )
    assert validate_start(value) is value


def test_start_input_rejects_missing_or_unknown_fields():
    valid = {
        "protocol_version": "h2-v1",
        "job_id": JOB_ID,
        "project_id": "project-a",
        "binding_sha256": BINDING_SHA256,
    }
    missing = {key: value for key, value in valid.items() if key != "project_id"}
    extra = {**valid, "command_payload": "must-not-enter-history"}

    for candidate in (missing, extra):
        with pytest.raises(ProtocolError) as raised:
            validate_start(candidate)
        assert raised.value.code == "BINDING_CONFLICT"


def test_start_input_rejects_noncanonical_uuid_and_sha256():
    valid = {
        "protocol_version": "h2-v1",
        "job_id": JOB_ID,
        "project_id": "project-a",
        "binding_sha256": BINDING_SHA256,
    }
    uppercase_uuid = {**valid, "job_id": JOB_ID.upper()}
    uppercase_sha = {**valid, "binding_sha256": "A" * 64}

    for candidate in (uppercase_uuid, uppercase_sha):
        with pytest.raises(ProtocolError) as raised:
            validate_start(candidate)
        assert raised.value.code == "BINDING_CONFLICT"


def test_start_input_rejects_control_character_project_id():
    with pytest.raises(ProtocolError) as raised:
        validate_start({
            "protocol_version": "h2-v1",
            "job_id": JOB_ID,
            "project_id": "project\nname",
            "binding_sha256": BINDING_SHA256,
        })
    assert raised.value.code == "BINDING_CONFLICT"


def test_start_input_rejects_unpaired_surrogate_project_id():
    with pytest.raises(ProtocolError) as raised:
        validate_start({
            "protocol_version": "h2-v1",
            "job_id": JOB_ID,
            "project_id": "project-\ud800",
            "binding_sha256": BINDING_SHA256,
        })
    assert raised.value.code == "BINDING_CONFLICT"


def test_canonical_rejects_finite_float_values():
    with pytest.raises(ProtocolError) as raised:
        canonical({"revision": 1.25})
    assert raised.value.code == "BINDING_CONFLICT"


def test_activation_proposal_is_exact_ten_field_literal():
    proposal = activation_proposal(
        JOB_ID, RUN_ID, BUILD_ID, BINDING_SHA256, COMMAND_ID, PAYLOAD_SHA256,
    )

    assert proposal == {
        "protocol_version": "h2-v1",
        "kind": "activate_create",
        "job_id": JOB_ID,
        "run_id": RUN_ID,
        "build_id": BUILD_ID,
        "binding_sha256": BINDING_SHA256,
        "transition_sequence": 1,
        "expected_revision": 0,
        "command_id": COMMAND_ID,
        "command_payload_sha256": PAYLOAD_SHA256,
    }
    assert len(proposal) == 10


def test_proposal_digest_matches_literal_transition_domain_hash():
    proposal = activation_proposal(
        JOB_ID, RUN_ID, BUILD_ID, BINDING_SHA256, COMMAND_ID, PAYLOAD_SHA256,
    )

    assert proposal_digest(proposal) == TRANSITION_SHA256


def test_changed_proposal_job_id_has_different_literal_digest():
    changed = activation_proposal(
        OTHER_JOB_ID, RUN_ID, BUILD_ID, BINDING_SHA256, COMMAND_ID, PAYLOAD_SHA256,
    )

    assert proposal_digest(changed) == CHANGED_JOB_TRANSITION_SHA256
    assert proposal_digest(changed) != TRANSITION_SHA256


def test_proposal_digest_rejects_extra_field_and_changed_sequence():
    proposal = activation_proposal(
        JOB_ID, RUN_ID, BUILD_ID, BINDING_SHA256, COMMAND_ID, PAYLOAD_SHA256,
    )
    extra = {**proposal, "outcome": "QUEUED"}
    missing = {key: value for key, value in proposal.items() if key != "run_id"}
    changed_sequence = {**proposal, "transition_sequence": 2}
    boolean_sequence = {**proposal, "transition_sequence": True}
    float_sequence = {**proposal, "transition_sequence": 1.0}

    for candidate in (extra, missing, changed_sequence, boolean_sequence, float_sequence):
        with pytest.raises(ProtocolError) as raised:
            proposal_digest(candidate)
        assert raised.value.code == "PROPOSAL_COLLISION"
