# 다음 세션 재개 안내 — 2026-10-20

> 최신 개발 체크포인트: [주기03 진행 기록](./delivery/iteration-03/README.md), [65건 검증 요약](./delivery/iteration-03/artifact-verification.json). 합성 단위65/65와 독립 결과 검토 완료.87-case mapping 및 phase hook은 초안/범위 한정 소스 검토이며 전체 실행 승인이 아니다. **다음 수정은 retained SQL fence 내부 evidence schema·canonical digest·정확한 kind/case/node 검사 누락**이다. 그 뒤 새 버전 계약/ledger·전체 runner/paired pre-gate → fresh490 → 실제 run/receipt 화면 연결. 기존 c10 계약은 주기02가 사용하므로 보존한다. 아래 오래된28건/원본490 계약 내용은 역사 기록으로만 읽는다.

> 최신 제품 결과: [주기02 실제 요청 저장 화면](./delivery/iteration-02/README.md), http://127.0.0.1:8769/ . 실제 API/DB 저장·재시작 유지 검증 완료, 독립 결과 검토 상태는 해당 증빙을 확인한다. 다음 단위는 필수 H2 검증 후 실제 실행 한 구간 연결이다.

> 최신 사용자 지시: [애자일 전달 계획](./AGILE-DELIVERY.md)을 우선한다. 목표는 재개되었으며, [첫 화면 공개](./delivery/iteration-01/README.md)에 이어 [실제 요청 저장 흐름](./delivery/iteration-02/README.md)을 전달했다. 이후에도 한 사용자 흐름씩 구현·시연·검증한다. H2 소스 증빙 보완은 `fa3fe7e`에 보존했으며 아직 실행 승인이 없다. 아래 내용은 중단 당시의 상세 기술 인계다.

이전에는 weekly limit 때문에 중단·인계를 요청했으나, 이후 사용자 지시로 애자일 개발을 재개했다. 현재 목표는 진행 중이다. 이 파일과 `AGENTS.md`, `docs/ifpmic/progress.json`, 실제 Git 상태를 확인하고 최신 제품 주기를 이어간다. 아래 과거 중단 기록의 정지 문구를 현재 실행 지시로 해석하지 않는다.

## 목표와 유지할 경계

- 현재 폴더의 AX 자료와 `IFPMIC_AX_Design_Package_v1.zip`, `IFPMIC_AX_Design_v1.docx`가 기준이다. 가져온 설계17개와 원본2개를 보존한다.
- Paperclip은 기존 IFPMIC AX의 FastAPI/PostgreSQL/Temporal 업무를 실행·관리·감독하고 workflow를 시각화하는 상위 계층이다. 원래 설계의 업무·승인 게이트를 대체하지 않는다.
- Code-dev가 통합 관리, TC가 테스트 작성. SAM/TEM/SQE/사람의 책임과 원래 AT32를 유지한다. 실제 장비 조작 및 최종 배포/외부 제출 승인은 사람에게 있다.
- 검증 통과와 독립적인 증빙 검토가 완료 조건이다. 테스트 수집·JUnit·해시·정적 검토를 실제 통과로 취급하지 않는다.
- 기존 AX localhost/읽기 전용/개인정보 제외 조건을 유지한다. 비공개 원본 SQL·로그·history·인증·PID·설정은 gitignored `workflow-artifacts/`의0700/0600에만 둔다. 원본 업로드와 private artifact는 커밋하지 않는다.
- 사용자 상시 승인에 따라 검토한 작업은 커밋하고 현재 브랜치에 push한다. 강제 push는 금지한다. 싼 worker부터 좁게 위임한다.

## 위치와 완료한 체크포인트

브랜치: `experiment/paperclip-workflow`.

- `8f20eb0`: fixture 정리와 negative draft 이전 체크포인트.
- `ea5055a`: `test(ifpmic): freeze full H2 inventory and runner authoring contract` — 원격 push 완료. 490개 소스 inventory, 실행 계약, paired authoring 리뷰를 기록했다.
- 이번 인계 커밋은 **미실행 초안과 발견한 결함을 보존하는 체크포인트**다. 실행/완료 승인이 아니다. 정확한 커밋 ID는 `git log -3 --oneline`에서 확인한다.

## 실제 검증 상태

과거 frozen candidate의 runtime-normal **407 passed /0 failed /0 error /0 skipped** 증빙만 존재한다.

- private gate: `workflow-artifacts/verification/B03/H2/runtime-normal/gates/2026-10-19T13-14-17-430254Z`
- fingerprint: `7a66f653bfca7bf04ed84fe89627f3d88c91f608493402c0e48e4ba7a259c49a`
- public proof: `docs/ifpmic/evidence/b03/h2-runtime-normal-verification.json`, `h2-runtime-normal-final-review.json`, `h2-runtime-normal-gate.zip`.
- 이것은 과거 소스에 한정된 partial normal 승인이다. 현재 변경한 소스의 통과 증명이 아니다.

이번 작업에서는 제품/SDK import, pytest collection, 테스트, SQL, 서비스 실행을 하지 않았다. AST/JSON/해시/Git 정적 검사만 했다. **전체 H2, B03, H3–H7, 원래 AT32 및 최종 AX workflow 시각화는 미완료**다.

## 현재490개 후보와 기존 승인 바이트

`docs/ifpmic/evidence/b03/` 기준:

| 파일 | SHA256 / 상태 |
|---|---|
| `h2-runtime-full-verification-plan.json` | `c6964bccff0d4cec1ac00f18fbb267d5d1a4a5887e53844c604333b7c059486c` |
| `h2-runtime-full-integrated-ledger.json` | `cf4f3bfc023341c22e0c8fc7c072c54838d62f7adeb39d817a4ce3b6589f8d60` |
| `h2-runtime-full-execution-contract.json` | `c10c7cb329ea82b758cfa7db34ac330e4b7ec472320b5904e8086f8067865a2d` |
| `h2-runtime-full-inventory-source-review.json` | 독립 source review, 원래 후보만 |
| `h2-runtime-full-inventory-tc-review.json` | TC inventory review, 원래 후보만 |
| `h2-runtime-full-execution-contract-review.json` | `481604abb4cfe602e16cbd65fae8f290f5a61f3ec405d350c9ebbbf6b7fe7c79` |
| `h2-runtime-full-execution-tc-review.json` | `17da5950d52deed48d454b026e152415d4e3eadd9eba20da4503009a41bf46b9` |

25개 business group +5개 fixture prerequisite. 407 retained +83 additions =490 literal IDs. additions 중49개215+25초,34개25+5초. 전체15 phase, 실행 cap 합15420초 +별도 overhead600초 =16020초. collection은15개 모두 먼저30초씩, 총450초를 overhead에서 사용한다.

기존 리뷰는 runner **작성만** 승인했다. 이후 발견한 증빙 누락과 이번 소스 수정 때문에 기존 pin/리뷰를 현재 바이트에 적용할 수 없다. 이전 승인 문서를 조용히 repin하거나 실제 테스트 통과로 재해석하지 않는다.

## 이번 커밋에 보존하는 변경

1. `h2-runtime-full-case-evidence-index.json`: TC의 ea5055a 대상 정적 audit. 83 additions 및5 retained controls의 원본 증빙 저장 위치/누락을 기록. 이후 수정된 소스의 최신 증명은 아니다.
2. `h2-runtime-full-evidence-amendment.json`: 발견한 결함, 수정 초안 pin, 재검토/재검증 경로. 아직 독립 리뷰 전이다.
3. `h2_crash_case_budget.py`:8개 crash test가 하나의 O_EXCL 파일을 공유하던 결함 수정. 이제 `IFPMIC_H2_CRASH_TIMINGS_ROOT/<sha256(nodeid)>.json`; private root 검사와215+25초 계약 유지.
4. `test_h2_started_deployment_boundaries.py`: 정의되지 않은 `foreign_reserve_rejected` 제거. 실제 SQLSTATE42501 검사는 유지. 실제 foreign-server list 응답과 registry before/after·proposal·projector 결과를 private JSON으로 저장하는 초안 추가.
5. `h2_snapshot_evidence.py` + `test_h2_runtime_normal_flow.py`: 공통 실제 owner SQL 조회 결과를 private `owner-snapshots/<job_uuid>/<monotonic_ns>-<uuid>.json`에 저장하는 초안. 원래 rows/순서/객체/검사는 그대로 반환. node/caller/time/hash 포함,0700/0600/O_EXCL/O_NOFOLLOW/fsync. env root가 없는 다른 suite는 기존 동작 유지. **정적 검사만 수행했다.**
6. `scripts/verify_ifpmic_b03_h2_runtime_full.py`: TC와 별도 runner worker가 작성한 전체 실행기 초안. stdlib 최초 import, exact pin 검사, collection/timing/resources/environment/private archive 검증 구조. **미실행·독립 리뷰 전이며 상수는 옛 ledger/contract/review SHA를 가리킨다. 실행하면 안 된다.**
7. progress/coverage 상태를 source/evidence amendment pending으로 변경. frozen inventory는 현재 실행 가능 상태가 아니다.

## 반드시 이어서 할 순서

1. 실제 worktree를 확인한다. 중단한 worker 모두 추가 수정이 없음을 보고했다. 옛 대화의 에이전트가 계속 실행 중이라고 가정하지 않는다.
2. 공통 SQL observer와 이번 두 결함 수정을 검토한다. helper는 모든 owner 조회를 저장하지만, 직접 SQL metadata·Temporal history/list·filesystem tree/sentinel·process lifecycle 증빙은 별도다.
3. evidence index를 기준으로 실제 누락을 해결한다. workspace 대상의 정확한 파일은 **`test_h2_workspace_activation_boundaries.py`**다. 존재하지 않는 `test_h2_workspace_boundaries.py`에는 작업하지 않는다. TC는 workspace/schema 수정에 착수하기 전에 중단했고 **이 두 파일을 수정하지 않았다**.
4. `test_workflow_schema.py`의 retained NEG-PROJECTION-FENCES4개는 **SQL/auth-only**다. 실제 role OID/ACL/HBA/auth 결과를 보존하되 Temporal 조회를 꾸며내지 않는다. startup rejection의 수동 TCP trap은 실제 서버가 아니므로 이미 저장하는 zero-connection 관찰이 적절한 no-connect oracle이다.
5. 나머지 activity/transport/crash/restart/started/deployment에서 owner snapshot으로 해결된 부분과 여전히 필요한 raw history/list/tree 증빙을 구분한다. 메모리에서 비교한 뒤 해시만 저장하는 것은 원본 증빙을 대체하지 못한다.
6. 변경한 source closure/ledger/derivative ledger/contract를 정합하게 재작성한다. 기존 ea5055a 승인 바이트는 historical attempt로 보존한다.490 literal IDs/기존407/25+5 의무를 누락하지 않는다.
7. 새 source와 inventory의 독립/TC 리뷰를 얻고 runner의 provisional pins를 갱신한다. runner 전체를 별도로 검토한다. 정확한 바이트에 묶인 독립/TC pre-gate **이후에만** import/collection/tests/services를 실행한다.
8. 전체490 fresh 실행, 실제 SQL/history/resource 증빙과 cleanup/환경 불변성 확인, 독립 final review. 실패 시 attempt를 보존하고 원인 수정 후 해당 단계로 복귀한다. 옛407 runner를 확장된 디렉터리에 실행하지 않는다.
9. 다음 H2/B03/H3–H7/AT32/시각화 단계를 계속한다. 실제 증빙 없이 goal을 완료 처리하지 않는다. 각 일관된 체크포인트를 commit/push한다.

## 실행 환경의 중요한 함정

- H1 qualified toolchain: `workflow-artifacts/toolchains/B03/H1/2026-10-18T19-43-43-523587Z`.
- PostgreSQL은 실제 **18.1**, Temporal SDK1.34.0 /CLI1.9.1 /server1.32.0, Python3.12.3. 원래32-package venv와 qualified36-package venv는 별도다.
- resolved36 lock은 private `workflow-artifacts/verification/B03/H1/preparations/2026-10-18T19-40-54Z-uv-resolution-retry/candidate-requirements.lock`, SHA `9c6141efe9ccb7cd9a94e3663c2faf9049eb10b883c93f492bb3e46c3a8883f7`. source `requirements-temporal.lock`과 같다고 검사하면 안 된다.
- accepted env map1777/3072 entries와 before/after를 정확하게 비교한다. 새 baseline을 임의 생성하지 않는다.
- 보호 원본 AX96파일/89 inventory, 설계17+upload2를 보존한다. 원본 ZIP SHA `34946eda4c85fd9706b40e218a233a3fdd5ab0a00b2538778c9b9cf047e19080`, DOCX SHA `18a14876a689beae0599b5d4014bf95db79bef047d0e4ceafa60d9a9417624fc`.
- SDK Client에는 close()가 없다. decode_wrapper는 list 반환, 다중 인자는 args=, query result_type은 keyword.
- shared cleanup은 하나의 원래 deadline 사용, PID/start ticks 확인 후 신호. 기한 만료 후 신호/대기 금지. primary error를 cleanup error로 덮지 않는다.
- worker의 hung-driver PostgreSQL query는 client 종료 후에도 남을 수 있다. SIGTERM self-exit12–18초와 pre-query event부터40초 이내 backend 소멸을 별도로 확인하는 계약을 유지한다.

재개 요청 예: `docs/ifpmic/RESUME.md를 읽고, 현재 미실행 증빙 보완 단계부터 이어서 진행해. 기존 승인 바이트를 재사용하지 말고 검증 및 커밋/push까지 진행해.`
