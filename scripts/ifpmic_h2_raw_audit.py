"""Full-runner child: audit one quiescent phase's private case evidence.

This entry point is for the separately reviewed full runner/pre-gate only.
Never use a successful child audit as standalone H2 or test acceptance.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
RULES = ROOT / 'docs/ifpmic/evidence/b03/h2-runtime-full-machine-evidence-rules-v5.json'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(ROOT))
    from scripts.ifpmic_h2_raw_evidence import (
        _decode, _open_directory, _read_file, _require, audit_recorders,
    )
    from scripts.ifpmic_h2_artifacts import audit_artifacts, prepare_phase_rules

    config_path = Path(args.config)
    _require(config_path.is_absolute() and config_path.resolve(strict=True) == config_path,
             'INVALID_AUDIT_CONFIG_PATH')
    config_fd = _open_directory(config_path.parent)
    try:
        config = _decode(_read_file(config_path.name, config_fd, 1024 * 1024))
        _require(type(config) is dict and set(config) ==
                 {'kind', 'rules_sha256', 'phase', 'phase_nodes', 'expected_nodes', 'observations'} and
                 config['kind'] == 'ifpmic.h2.raw-audit-input.v1', 'INVALID_AUDIT_CONFIG')
        _require(isinstance(config['rules_sha256'], str) and
                 re.fullmatch('[0-9a-f]{64}', config['rules_sha256']) is not None,
                 'INVALID_RULES_PIN')
        _require(not RULES.is_symlink() and RULES.resolve(strict=True) == RULES, 'UNSAFE_RULES_PATH')
        raw = RULES.read_bytes()
        _require(hashlib.sha256(raw).hexdigest() == config['rules_sha256'], 'RULES_PIN_MISMATCH')
        document = _decode(raw)
        for field in ('phase_nodes', 'expected_nodes'):
            _require(type(config[field]) is list and all(isinstance(node, str) for node in config[field]) and
                     len(set(config[field])) == len(config[field]), 'INVALID_AUDIT_NODE_SET')
        _require(len(config['expected_nodes']) == 87, 'EXPECTED_RAW_NODE_COUNT_MISMATCH')
        recorders, cases = prepare_phase_rules(document, config['phase'], set(config['phase_nodes']),
                                               set(config['expected_nodes']))
        pins = document.get('source_pins')
        _require(type(pins) is dict and bool(pins), 'AUDIT_SOURCE_PINS_MISSING')

        def verify_sources():
            for relative, expected in pins.items():
                _require(isinstance(relative, str) and not Path(relative).is_absolute() and
                         '..' not in Path(relative).parts and isinstance(expected, str) and
                         re.fullmatch('[0-9a-f]{64}', expected) is not None, 'INVALID_AUDIT_SOURCE_PIN')
                path = ROOT / relative
                _require(path.resolve(strict=True) == path and path.is_file(), 'UNSAFE_AUDIT_SOURCE_PATH')
                _require(hashlib.sha256(path.read_bytes()).hexdigest() == expected, 'AUDIT_SOURCE_PIN_MISMATCH')

        verify_sources()
        decoder = None
        if any(rule.format == 'pbseq' for case in cases for rule in case.artifacts):
            # The parent selects and attests qualified36 before launching this child.
            # This is real offline protobuf decoding, not a network/client call.
            from temporalio.api.history.v1 import HistoryEvent

            def decoder(frames):
                events = [HistoryEvent.FromString(frame) for frame in frames]
                return [{'event_id': int(event.event_id), 'event_type': int(event.event_type)}
                        for event in events]

        observations = Path(config['observations'])
        recorder_result = audit_recorders(observations, recorders, known_nodes=set(config['phase_nodes']))
        artifact_result = audit_artifacts(observations, cases, decode_history=decoder)
        verify_sources()
        _require(hashlib.sha256(RULES.read_bytes()).hexdigest() == config['rules_sha256'],
                 'RULES_CHANGED_DURING_AUDIT')
        output = {'kind': 'ifpmic.h2.raw-case-audit.v1', 'phase': config['phase'],
                  'rules_sha256': config['rules_sha256'], 'node_ids': sorted(case.node_id for case in cases),
                  'recorder_audit': recorder_result, 'artifact_audit': artifact_result,
                  'decoder': 'qualified-temporalio-HistoryEvent.FromString' if decoder is not None else None,
                  'all_scoped_raw_rules_satisfied': True, 'source_unchanged': True, 'h2_accepted': False}
        payload = (json.dumps(output, ensure_ascii=True, sort_keys=True, allow_nan=False) + '\n').encode('ascii')
        fd = os.open('raw-case-audit.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=config_fd)
        with os.fdopen(fd, 'wb') as destination:
            os.fchmod(destination.fileno(), 0o600)
            destination.write(payload)
            destination.flush()
            os.fsync(destination.fileno())
    finally:
        os.close(config_fd)
    print('H2_RAW_AUDIT_PASSED', flush=True)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        # Raw paths and observation values are never printed, including on failure.
        print('H2_RAW_AUDIT_FAILED ' + type(error).__name__, flush=True)
        sys.exit(1)
