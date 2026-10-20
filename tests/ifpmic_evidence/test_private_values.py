"""Regression tests for private JSON conversion of retained path values.

These tests exercise only synthetic Python values and the stdlib JSON encoder.
They do not import product, SDK, pytest-plugin, or service code.
"""
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from tests.ifpmic_api.h2_private_values import private_json_values


class PrivateJsonValuesTests(unittest.TestCase):
    def test_nested_process_paths_round_trip_as_strings(self) -> None:
        with tempfile.TemporaryDirectory(prefix="h2-private-paths-") as temp:
            root = Path(temp)
            stdout_path = root / "stdout.log"
            stderr_path = root / "stderr.log"
            cache_path = root / "cache" / "run"
            event_path = root / "events" / "worker.log"
            record = {
                "process": {
                    "stdout": stdout_path,
                    "stderr": stderr_path,
                    "cache": {"directory": cache_path},
                    "logs": [event_path, (stdout_path, stderr_path)],
                }
            }

            encoded = json.dumps(private_json_values(record), allow_nan=False)
            decoded = json.loads(encoded)

        self.assertEqual(decoded["process"]["stdout"], str(stdout_path))
        self.assertEqual(decoded["process"]["stderr"], str(stderr_path))
        self.assertEqual(decoded["process"]["cache"]["directory"], str(cache_path))
        self.assertEqual(decoded["process"]["logs"], [
            str(event_path), [str(stdout_path), str(stderr_path)]
        ])

    def test_conversion_does_not_mutate_paths_needed_for_cleanup(self) -> None:
        with tempfile.TemporaryDirectory(prefix="h2-private-cleanup-") as temp:
            stdout_path = Path(temp) / "stdout.log"
            payload = b"captured child output"
            stdout_path.write_bytes(payload)
            process = {"stdout": stdout_path, "nested": [stdout_path]}

            converted = private_json_values(process)

            self.assertIs(process["stdout"], stdout_path)
            self.assertIs(process["nested"][0], stdout_path)
            self.assertEqual(stdout_path.read_bytes(), payload)
            self.assertEqual(converted, {"stdout": str(stdout_path), "nested": [str(stdout_path)]})

    def test_unsupported_objects_and_exceptions_are_not_stringified(self) -> None:
        class Unsupported:
            pass

        values = {"unsupported": Unsupported(), "failure": RuntimeError("private detail")}
        converted = private_json_values(values)

        self.assertIs(converted["unsupported"], values["unsupported"])
        self.assertIs(converted["failure"], values["failure"])
        with self.assertRaises(TypeError):
            json.dumps(converted, allow_nan=False)


if __name__ == "__main__":
    unittest.main()
