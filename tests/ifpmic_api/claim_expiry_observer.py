"""Pure polling logic for observing expiration of one delivery claim."""
from __future__ import annotations

from typing import Callable, TypeVar

T = TypeVar("T")


class BoundedPollSamples:
    """Keep the first poll plus the most recent ``limit - 1`` poll samples."""

    def __init__(self, limit: int = 64):
        if limit < 1:
            raise ValueError("sample limit must be positive")
        self.limit = limit
        self.first: dict[str, object] | None = None
        self.recent: list[dict[str, object]] = []
        self.count = 0

    def append(self, sample: dict[str, object]) -> None:
        self.count += 1
        item = dict(sample)
        if self.first is None:
            self.first = item
        elif self.limit > 1:
            self.recent.append(item)
            if len(self.recent) > self.limit - 1:
                del self.recent[0]

    def update_poll(self, poll: int, event: dict[str, object]) -> None:
        if self.first is not None and self.first.get("poll") == poll:
            self.first.update(event)
            return
        for item in self.recent:
            if item.get("poll") == poll:
                item.update(event)
                return


def wait_claim_expired(*, read: Callable[[], T], is_same_claim: Callable[[T], bool],
                       is_expired: Callable[[T], bool], timeout: float,
                       clock: Callable[[], float], sleep: Callable[[float], None],
                       record: Callable[[dict[str, object]], None] | None = None) -> T:
    """Poll with the historical loop-before-stop and 100ms sleep semantics."""
    started = clock()
    stop = started + timeout
    polls = 0
    while clock() < stop:
        row = read()
        polls += 1
        if not is_same_claim(row):
            raise AssertionError("delivery claim changed while waiting for expiry")
        expired = bool(is_expired(row))
        if record is not None:
            record({"result": "poll", "poll": polls,
                    "elapsed_seconds": max(0.0, clock() - started),
                    "expired": expired})
        if expired:
            if record is not None:
                record({"result": "expired", "polls": polls,
                        "elapsed_seconds": max(0.0, clock() - started),
                        "started_monotonic": started, "stop_monotonic": stop,
                        "stopped_monotonic": clock()})
            return row
        sleep(0.1)
    if record is not None:
        record({"result": "timeout", "polls": polls,
                "elapsed_seconds": max(0.0, clock() - started),
                "started_monotonic": started, "stop_monotonic": stop,
                "stopped_monotonic": clock()})
    raise TimeoutError("original delivery claim did not expire by database clock")
