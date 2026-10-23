"""Qualify historical H1 documentation and the explicit current delivery addition.

This is a read-only stdlib check. Historical toolchain approval remains bound
to its historical README; current documentation is qualified separately.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import stat


H1_README_SHA256 = '0964d4dae840f9a433d88ee92132efedb7e17c77ac815d0e955c6fdbc65c7100'
H2_README_SHA256 = '1aa570dc948ffd83a15097535f3456eb24eea6a947c22a4aa49aa12f5b05605a'
CURRENT_README_SHA256 = 'ee21e2fd36e6db1d4542d1ae8ee0403c44d3eaaf36958b58f1bab0a98f2371bf'
H1_CONTRACT_SHA256 = '7860ccc5e7527ef37f6e1f26d07b7b2df4bb2f55d721b14ae5e635492153b801'
QUALIFICATION_DIRECTORY = 'docs/ifpmic/evidence/b03/qualification/'
CURRENT_ADDITION = (
    '실제 요청 등록·저장·상세 화면은 [주기02 실행 안내](./docs/ifpmic/delivery/iteration-02/README.md)를 따른다. '
    '로컬 주소는 **http://127.0.0.1:8769/**이며 데모 계정으로 로그인한다. '
    '실제 API/PostgreSQL 저장을 사용하고, 합성 계정/mock 프로파일과 실행 전 상태를 화면에 표시한다. '
    '기존 AX 기록 API는 계속 읽기 전용이다.\n\n'
).encode('utf-8')


def verify_readme_qualification(root: Path) -> dict:
    root = Path(root)
    if not root.is_absolute() or root.resolve() != root or not root.is_dir():
        raise RuntimeError('README qualification root is not canonical')

    def read_exact(relative: str, expected: str) -> bytes:
        target = root
        try:
            for component in Path(relative).parts:
                target = target / component
                if target.is_symlink():
                    raise RuntimeError('README qualification path is a symlink')
            info = target.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise RuntimeError('README qualification input is not a regular single-link file')
            raw = target.read_bytes()
        except OSError:
            raise RuntimeError('README qualification input unavailable') from None
        if hashlib.sha256(raw).hexdigest() != expected:
            raise RuntimeError('README qualification input hash mismatch')
        return raw

    historical_h1 = read_exact(QUALIFICATION_DIRECTORY + 'h1-readme.md', H1_README_SHA256)
    historical_h2 = read_exact(QUALIFICATION_DIRECTORY + 'h2-readme.md', H2_README_SHA256)
    current = read_exact('README.md', CURRENT_README_SHA256)
    contract = json.loads(read_exact('docs/ifpmic/evidence/b03/h1-execution-contract.json',
                                    H1_CONTRACT_SHA256))
    readme_inputs = [row for row in contract['inputs'] if row.get('path') == 'README.md']
    if readme_inputs != [{'path': 'README.md', 'sha256': H1_README_SHA256}]:
        raise RuntimeError('Historical H1 README attestation differs')
    marker = '## IFPMIC 흐름 보기\n\n'.encode('utf-8')
    if historical_h2.count(marker) != 1 or historical_h2.replace(
            marker, marker + CURRENT_ADDITION, 1) != current:
        raise RuntimeError('Current README exceeds the reviewed delivery addition')
    return {
        'historical_h1_sha256': hashlib.sha256(historical_h1).hexdigest(),
        'historical_h2_sha256': hashlib.sha256(historical_h2).hexdigest(),
        'current_sha256': hashlib.sha256(current).hexdigest(),
        'current_change_verified': True,
    }
