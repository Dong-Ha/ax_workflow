"""Test-evidence value conversion; preserve objects retained for process cleanup."""
from pathlib import Path


def private_json_values(value):
    """Copy nested containers, converting only concrete filesystem paths.

    Leave unsupported values unsupported so the strict canonical JSON writer
    rejects them. Never stringify arbitrary objects or exception messages.
    """
    if isinstance(value, Path):
        return str(value)
    if type(value) is dict:
        return {key: private_json_values(item) for key, item in value.items()}
    if type(value) in (list, tuple):
        return [private_json_values(item) for item in value]
    return value
