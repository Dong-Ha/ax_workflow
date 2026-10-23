# 실제 실행 실패 두 건의 테스트 관측 보완

REQ-02·13·14 / B03-H2 / CRASH-02 및 STORAGE-RESTART. 목표 흐름은 저장 요청→실제 엔진 접수→run/receipt·QUEUED다. [V4 실패 검토](./runtime-v4-attempt-01-result-review.json)의 두 건만 다룬다. 실제8건 중6통과·2실패,482미실행과 V4/152 합성 증빙은 보존한다.

## 원래 계약과 수정 결정

- `h2-implementation-contract.json`의 transport.claim은 선점 transaction에서 generation+1, token, DB-clock lease30초와 attempts row를 만들고 commit하도록 명시한다. `test_h2_transport_boundaries.py`와 `test_accepted_start_response_loss.py`도 선점 직후 `(1,None,None,None,False)`를 요구한다. 따라서 CRASH-02의 빈 attempts 기대값만 정확한 미완료 generation1 행으로 고친다. 생산 SQL은 변경하지 않는다.
- 원래 `H2-RUNTIME-CRASH-MATRIX.md`와 full verification plan의 독립 재시작 의무는 동일 저장소·command/binding/run/history/receipt를 요구한다. 현재 restart 테스트는 worker/dispatcher를 중지한 뒤 이력 관측에 worker가 필요한 phase query를 호출한다. worker 중지 중에는 기존 `_observe_started_direct`로 실제 서버의 list/describe/history를 독립 조회하고, worker 재기동 후 기존 `_observe_temporal`로 실제 queued query까지 확인한다. 중지 중 phase 값을 추정하거나 만들어 반환하지 않는다.

## 단계별 검증 계획

| 필드 | 구현·정적 검토 | 실제 회귀·수용 |
|---|---|---|
| 목적 | 원래 계약과 맞지 않는 두 관측 오류만 해결 | 바뀐 관측이 실제 실패 경계를 통과하며 기존 전체 의무를 보존함을 증명 |
| 대상 | TC 소유 `test_h2_dispatcher_crashes.py`의 CRASH-02 assertion, `test_h2_runtime_restart_and_history.py`의 downtime history helper 및 두 호출; Code-dev의 successor raw rules/ledger/contract와 runner literal 연결 및 raw auditor의 고정 RULES 파일명 literal | 동일490 ID/407+83,25업무+5fixture,15phase와 정확한 새 source/read closure; 기존152 stdlib 회귀와 actual fresh490 |
| 방법 | 독립 계획 검토 뒤 구현. 미완료 attempt tuple을 정확히 비교. downtime helper는 기존 accepted-start 직접 관측기를 호출하고 exact expected run/count/start input/queue/RUNNING/retention을 확인하며 검증된 실제 framed protobuf bytes를 원래 `temporal-history.pbseq`에0600으로 보존한다. helper의 SHA/bytes를 재대조. 중지된 worker/dispatcher는 중간 재시작하지 않으며, 최종 실제 query는 기존 RPC10초/queued/history equality를 유지한다. 정상·예외·경계·회귀는 아래 분류를 따른다 | source 승인 전 SDK/import/collection/services/main 실행 금지. 새 정확한 source 검토 후 cache 격리152 전체 실행·독립 수용. 전체 source 검토와 독립/TC execution pre-gates 뒤 동일490을 한 번 실행. 각 case/phase/outer와 raw/resource/privacy 검사를 그대로 적용 |
| 담당 Agent | Code-dev(root)는 요구사항/통합 및 versioned 후보, TC(worker_luna)는 테스트 두 파일만 작성, 독립 Agent는 계획과 정확한 변경/영향 범위 검토 | TC는 기존 전체 test source와 결과를 검토하고 Code-dev가 승인된 실제 실행을 관리. 독립 Agent가 raw·정리·환경·개인정보와 최종 결과 수용. SAM/TEM/SQE·사람 경계 유지 |
| 합격 기준 | claim 직후 정확히1개 미완료 gen1, DRAFT0·bindings/scopes/receipts0·noncreate0·Temporal0·live lease 유지. 만료 후 동일 claim과 expiry 확인, gen1 expired/gen2 started 및 단일 run/receipt/scope 검사 유지. downtime 두 시점의 동일 inode·SQL snapshot·run·raw history SHA와 최종 queued/단일 Started/receipt 유지. 일반 helper/생산코드/기존152본문 변경0 | ID 누락·중복·실패·오류·skip0, 기존 시간/역할/원본·환경/승인/소유 자원정리·raw 증빙 기준 충족 및 독립 수용. 단위 통과나 collection490을 실제490 통과로 표시하지 않음 |
| 예상 결과 | 두 테스트가 원래 설계의 관측 경계를 정확히 검사하며 실패 판정 기준을 약화하지 않음 | 새 후보의 실제 전건 통과 증빙 또는 보존된 정확한 실패. 성공 뒤에만 요청 접수 UI 진행 |
| 증빙 자료 | 원래 계약/행·실패 review·두 테스트 diff/AST·독립 source review, 별도 V5 raw rules·ledger·contract 및 관련 exact 리뷰. V4와 기존 raw rules는 불변 보존 | private actual gate/JUnit/protobuf/SQL/identity journals·전후 source/env·timing, 공개 안전 요약과 독립 수용·commit/push. 내부 raw/설정/인증/PID는 외부 전송 금지 |
| 실패 시 복구·재검증 | 실제 실패 leaf를 보존하고 계약/관측 코드 단계로 복귀. 예상과 다르면 원래 계약부터 재판단하고 관련 계획·source 승인을 갱신. 임의 행 삭제·상태 조작·시간 연장·query 오류 삼키기 금지 | 실패 raw·owned cleanup을 보존, 원인 영향 범위 수정 후 exact source/리뷰 갱신 및 전체490과 영향 회귀 재수행. 관찰 timeout만으로 재실행하지 않음 |

## 정상·예외·경계·회귀와 영향도

정상은 generation1 선점·독립 PG/Temporal 재시작·최종 CLI 재시작이다. 예외는 실제 SIGKILL/lease 회수와 중지된 worker의 관측 구간이다. 경계는 DB-clock expiry/token/generation, canonical run 및 원래 RPC/case/phase 예산이다. 회귀는 현재 dispatcher 묶음8건뿐 아니라 기존490 전체와152 합성 단위를 유지한다. helper는 다른 test ID나 normal observer를 바꾸지 않는다.

후속 raw rules는 기존87 cases/953 artifact 규칙/38 source pins를 유지하되 두 TC 소스의 최신 hash와 실제 producer symbol/line만 갱신한다. 추가되는 직접 관측기의 실제 private 출력은 축소·가공하지 않으며 기존 필수 history 경로도 유지한다. 파생 V5 ledger/contract는 predecessor V4를 명시하고 변경된 tests/rules pins와 이 보완을 연결한다. 모든 기존 ID·obligation·fixture·시간/정리/privacy/승인 기준은 유지한다. 역사 source_resolution 검토는 당시 bytes의 기록으로 남기고 새 두 생산자 변경은 별도 독립 source 검토로 증명한다. runner 동작은 바꾸지 않고 새 후보/작성 리뷰 literal만 연결한다. `scripts/ifpmic_h2_raw_audit.py`는 고정 RULES 파일명 literal만 새v5 rules로 연결하고 모든 함수 AST·입력 schema·해시/path 검증은 유지한다. 부모가 선택한 새 rules hash와 child가 읽는 고정 파일을 일치시키며 동적 경로나 검증 우회는 추가하지 않는다. 이 auditor literal의 영향 pins도 새 후보에 갱신하고 독립 source 검토한다.

제품 UI·adapter·생산 SQL/서비스·도구 설치·SDK/환경·원본 설계는 수정하지 않는다. UI 변경0이므로 이번 보완 단계의 build/browser 반복은 생략하며, 실제 요청 접수 UI와 브라우저 검증·H3–H7·장비·배포·AT32는 여전히 미완료다. 이 문서는 구현 계획이며 단위/전체 실행 승인이나 H2 완료 증거가 아니다.
