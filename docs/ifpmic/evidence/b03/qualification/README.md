# H1 역사 문서와 현재 안내의 분리 검증

이 디렉터리는 현재 README를 되돌리는 용도가 아니다. 같은 retained H1 시험이 역사 toolchain 문서와 현재 문서를 각각 검증하도록 고정 입력을 보존한다. [검토된 계획](../../../delivery/iteration-03/REMAINING-INPUT-REPAIR.md)과 그 독립 검토에 연결된다.

| 입력 | 출처/역할 | SHA256 |
|---|---|---|
| `h1-readme.md` | `git show 4fc25fb0c488ddb22ff22127fe3b18946e862a91:README.md`; 원래 H1 실행 계약의 문서 | `0964d4dae840f9a433d88ee92132efedb7e17c77ac815d0e955c6fdbc65c7100` |
| `h2-readme.md` | `git show 09ebf40e9386bf32cfa8b9b3fb5a1983279337f3:README.md`; 기존 H1 test 상수의 문서 | `1aa570dc948ffd83a15097535f3456eb24eea6a947c22a4aa49aa12f5b05605a` |
| root `README.md` | 현재 요청 저장 화면 안내를 포함하는 문서; 이번에 수정하지 않음 | `ee21e2fd36e6db1d4542d1ae8ee0403c44d3eaaf36958b58f1bab0a98f2371bf` |
| `h1-execution-contract.json` | 기존 H1 실행 계약, README input은0964d4 | `7860ccc5e7527ef37f6e1f26d07b7b2df4bb2f55d721b14ae5e635492153b801` |

중간1aa 문서에서 현재ee21 문서로의 변경은 `## IFPMIC 흐름 보기` 뒤의 **주기02 실행 안내 paragraph와 빈 줄 추가2줄**뿐이다. 이 안내는 로컬8769 주소·데모 계정·실제 API/PostgreSQL 저장·합성/mock·실행 전 상태·기존 AX 기록 API의 읽기 전용 경계를 설명한다. 기존 실행 명령·의존성/버전·검증 규칙은 변경하지 않는다.

`scripts/ifpmic_readme_qualification.py`가 위 네 입력의 고정 SHA와 regular/nonsymlink 경로를 확인한다. 역사 계약의 README input도 대조하고, 중간 snapshot에 정확한 안내 추가만 적용하면 현재 bytes가 되는지 검증한다. hash만 현재 값으로 바꾸는 방식으로 의미 검증을 우회하지 않는다. H1 test의 기존1aa 상수는 역사 중간 snapshot에 대조하며 현재 문서 검증도 반드시 수행한다.

이 별도 qualification은 원래 H1 계약/실행/인수 기록을 수정하거나 과거 통과를 현재 통과로 바꾸지 않는다. 신규 helper·수정 H1 test·추가 read dependency는 새v3 source ledger/계약·검토에 고정해야 한다. 합성 단위와 별도 exact 승인 뒤의 fresh490에서 같은 retained H1 literal ID를 실행하기 전에는 현재 full H2를 수용하지 않는다.
