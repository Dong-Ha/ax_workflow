# 실제 Node 실행 경계 두 누락 보완

REQ-02·13·14 / B03-H2 / FULL-EXECUTE·AUDIT. [v3 전체 소스 검토](../../evidence/b03/attempts/h2-runtime-full-runner-source-review-v3-attempt-01.json)의 두 차단 사항만 수정한다. 기존149 합성 수용과v3 후보/검토는 정확한 역사 bytes로 보존한다. 목표 흐름은 계속 저장 요청→실제 엔진 접수→run/receipt·QUEUED다.

- **목적:** 실제 시험 코드의 `shutil.which('node')`가 이미 고정한 Node24를 찾게 하고, 실제 실행되는 Node bridge도 소스 무결성 검사에 포함한다.
- **대상:** runner의 `safe_environment` PATH와 `verify_static_anchors`의 service/test 확장자 집합, ledger에 빠진 `services/ifpmic_api/snapshot_bridge.mjs`(현재/accepted407 SHA c43822624bb68b7b75a4c13860c78408a80a3de56f10022c0f2591170200fd88). Node bridge·업무·장비·producer 소스 자체는 바꾸지 않는다. 새v4 후보가 v3를 보존한다.
- **방법:** 독립 계획 검토 후 구현. 이미 해시 검증한 `binary_inputs.fixture_node`의 parent를 PATH 앞에 두고 기존 venv/bin·/usr/bin·/bin을 유지한다. 주변 PATH/설치/다운로드를 사용하지 않는다. service/test exact closure는 기존 확장자와 Node의 `.mjs/.js/.cjs`를 포함한다. bridge의 직접/간접 repo import는 기존96/89 보호와 원본17에 포함됨을 재대조한다. 새ledger는 accepted407 manifest의 기존 c438와 현재 bridge를 대조해110 source/read pins로 고정한다.
- **담당:** Code-dev 구현·통합, TC가 새 회귀 작성, 독립 Agent가 계획·정확한 source·실제 결과 검토. source 전체 검토와 paired 실행 전 검토는 별도다.
- **합격 기준:** 정상 synthetic 환경에서 `shutil.which('node',path=env['PATH'])`가 정확한 pinned Node를 반환. 잘못된 Node hash/파일 부재는 거절하며 ambient PATH나 venv의 다른 node가 우선하지 않음. pinned mjs는 통과하고 누락/변조/추가된 mjs/js/cjs는 거절. 기존149 ID/본문·490 ID/25+5/15phase/원래예산16220초·raw87/953/38·19 anchors/7 binaries·원본/역할/승인 유지.
- **예상 결과:** 두 실행 경계의 실제 동작을 검증하는 stdlib 합성 회귀와 전건 통과. 기존 fixture를 우회하거나 시험을 skip하지 않는다. v4 source/read closure와 paired 작성 검토→runner연결→정확한 source/전체 합성→전체 source/paired execution gates 순서로 fresh490을 준비한다. 이전 source 승인을 새 bytes에 적용하지 않는다.
- **증빙:** source-shaped 임시 파일과 기존149+신규 TC의 fresh private cache/60초 실행, exact source/review 전후·원본96/89/17+2·환경1777/3072 비교, 실제 raw/IDs/해시와 독립 결과. 별도v4 ledger/contract/review와 시도별 거절 기록·commit/push. 실제 SDK/pytest collection/SQL/services/main은 full gates 전에 실행하지 않는다.
- **실패 복구·재검증:** 실패 raw와 owned 자원 정리를 보존하고 원인 코드/계약 단계로 복귀. exact source 재검토 후 해당 전체 합성 및 영향 회귀 재실행. 새 baseline·binary·환경 설치·경계 완화로 통과시키지 않는다. UI 제품 변경0이므로 이 합성 단계의 browser/build는 생략하되 기존 화면 제공과 전체490·UI연동·H3–H7·AT32 미검증 위험을 유지한다.

코드 책임은 root의 runner 및v4 후보, TC의 `test_runner_v2_repairs.py` 추가 메서드로 나눈다. 기존149 test 본문은 보존한다. 원래v2/c10/cf4/I02와 모든149 증빙을 수정하지 않는다. 새 증빙은 별도 이름으로 기록한다. 이 계획은 구현 계획이며 단위/전체 실행 승인이 아니다.
