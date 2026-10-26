from __future__ import annotations

import pytest

from tests.ifpmic_api.claim_expiry_observer import BoundedPollSamples, wait_claim_expired


def _observer(row, timeout, clock, sleep, record=None):
    return wait_claim_expired(
        read=lambda: row, is_same_claim=lambda value: value[0] == "leased",
        is_expired=lambda value: value[1], timeout=timeout,
        clock=clock, sleep=sleep, record=record,
    )


def test_expiry_between_last_poll_and_cutoff_can_be_missed():
    now = [0.0]
    expired = [False]
    polls = []

    def sleep(seconds):
        expired[0] = True
        now[0] += seconds

    with pytest.raises(TimeoutError, match="original delivery claim did not expire"):
        _observer(("leased", False), 0.1, lambda: now[0], sleep, polls.append)

    assert not any(item.get("expired") for item in polls if item["result"] == "poll")
    assert polls[-1]["result"] == "timeout"


def test_shortened_budget_has_the_same_bounded_timeout():
    now = [0.0]
    sleeps = []
    events = []

    def sleep(seconds):
        sleeps.append(seconds)
        now[0] += seconds

    with pytest.raises(TimeoutError, match="original delivery claim did not expire"):
        _observer(("leased", False), 0.05, lambda: now[0], sleep, events.append)

    assert sleeps == [0.1]
    assert events[-1]["result"] == "timeout"


def test_expiry_is_returned_and_recorded():
    now = [0.0]
    row = ("leased", True)
    events = []
    assert _observer(row, 1, lambda: now[0], lambda _seconds: None, events.append) is row
    assert events[0]["expired"] is True
    assert events[-1]["result"] == "expired"


def test_claim_identity_assertion_propagates():
    with pytest.raises(AssertionError, match="delivery claim changed"):
        _observer(("reclaimed", False), 1, lambda: 0.0, lambda _seconds: None)


def test_bounded_samples_keep_first_and_latest_polls_and_merge_by_poll_number():
    samples = BoundedPollSamples(limit=4)
    for poll in range(1, 8):
        samples.append({"poll": poll, "db_now": f"db-{poll}"})
    samples.update_poll(1, {"expired": False})
    samples.update_poll(7, {"expired": True})
    samples.update_poll(2, {"should_not_exist": True})

    assert samples.count == 7
    assert samples.first == {"poll": 1, "db_now": "db-1", "expired": False}
    assert samples.recent == [
        {"poll": 5, "db_now": "db-5"},
        {"poll": 6, "db_now": "db-6"},
        {"poll": 7, "db_now": "db-7", "expired": True},
    ]
