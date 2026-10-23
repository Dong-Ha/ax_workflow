# Worker crash 세 실패의 실제 관측 보완

REQ-02·13·14 / B03-H2 / CRASH-10·11·12. [V5 실제 실패 검토](./runtime-v5-attempt-01-result-review.json)를 보존한다. 현재12건 중9통과·3실패,478미실행이며 dispatcher8건과 해당 raw 감사만 통과했다. 전체 완료율2/16=12.5%와 다음 공개 흐름(저장 요청→실제 접수→run/receipt·QUEUED)은 유지한다.

## 근거와 판단 한계

원래 `h2-runtime-full-verification-plan.json`의 CRASH-10/11/12는 실제 named cut·SQL/history·동일 run/receipt와 복구를 요구한다. Temporal의 [공식 이벤트 설명](https://github.com/temporalio/documentation/blob/main/docs/references/events.mdx)은 실행 중 activity의 Started 이벤트가 terminal activity 이벤트와 함께 history에 기록된다고 명시한다. 따라서 CRASH-10/11의 종료 전 persisted Started>=1 기대는 올바른 실행 증명이 아니다. 실제 Scheduled history와 서버 describe의 pending STARTED를 연결해 증명을 보완한다.

CRASH-12의 정확한 원인은 아직 미확정이다. SQL QUEUED는 kill 전부터 성립하므로 기존 SQL 대기는 새 worker의 재생 준비를 증명하지 못한다. 이미 최종 필수조건인 cut ActivityTaskCompleted 이후 WorkflowTaskCompleted를 직접 backend에서 먼저 기다리도록 순서를 정렬한다. 실제 queued query는 원래 proxy 경로와10초 제한으로 유지하고, 실패를 direct query로 대체하지 않는다. 다음 실제 실행이 readiness·proxy·replay 문제를 구분할 증거를 제공해야 한다.

## 단계별 검증 계획

| 필드 | 소스 보완·검토 | 실제 검증·수용 |
|---|---|---|
| 검증 목적 | 잘못된 pre-terminal history 기대를 실제 독립 서버 관측으로 교체하고 recovery 준비 증거를 먼저 확인 | 원래 세 crash 경계와 동일 run/receipt·실제 worker 복구를 증명 |
| 대상 | TC의 `tests/ifpmic_api/test_h2_worker_api_crashes.py`만 동작 변경. Code-dev의 V6 rules/ledger/contract 및 runner·raw auditor·기존 단위 fixture의 고정 파일명 연결 | 기존490 ID/407+83,25업무+5fixture,15phase; 기존152 stdlib 본문과 전체 실제490·raw/privacy/정리/환경 |
| 검증 방법 | 독립 계획 승인 후 구현. CRASH-10/11에서 같은 namespace/workflow/run의 직접 describe pending_activities를 읽고, Scheduled attrs.activity_id 및 activity type으로 정확히 하나의 STARTED 항목을 연결한다. pending에는 scheduled_event_id가 없으므로 가정하지 않는다. 양의 attempt·실제 last_started_time·Scheduled ID/activity ID·실제 pending 상태를 private JSON으로 보존한다. 기존 history bytes와 Completed0·named SQL cut·saved worker identity/barrier는 유지한다. CRASH-12는 기존 cut/kill/release 뒤 같은 production worker를 같은 등록 proxy 설정으로 재시작한다. direct backend에서 같은 run의 cut completion 이후 WorkflowTaskCompleted를 원래 body deadline 안에서 기다린 뒤 기존 final observer/query와 최종 조건을 실행한다 | 정확 source 승인 뒤 fresh private cache로 기존152 전체 실행·독립 수용. 전체 source·독립/TC exact execution pre-gates 뒤 새490을 한 번 실행. 정상·예외·경계·회귀는 아래 범위와 원래 case/phase/outer 예산 적용 |
| 담당 Agent | Code-dev(root) 요구사항·판단·후보 통합, TC(worker_luna) worker test 작성, 독립 Agent 계획/소스 검토. Senior의 관측 경계 자문은 코드·검증 결과 수용과 구분 | Code-dev 승인된 실행 관리, TC 테스트·결과 대조, 독립 Agent 실제 raw/정리/privacy/환경·최종 결과 수용. Code-dev/TC/SAM/TEM/SQE/사람 경계 유지 |
| 합격 기준 | CRASH-10/11은 정확한 pending STARTED+Scheduled 연결, 원래 SQL before/after 상태, 실제 SIGKILL·rollback 또는 immutable receipt replay, 최종 Started>=1/Completed1·단일 run/scope/receipt·QUEUED 유지. CRASH-12는 cut 전후 같은 run/SQL/receipt, kill 전 next completed workflow decision0, 새 worker 재시작 뒤 실제 후속 decision과 실제 queued query, activity completion1을 모두 요구. query/RPC<=10초·원래215+25 및 모든 기존 예산 유지 | 490개 정확 ID, 누락·중복·실패·오류·skip0, 원래 resource/환경/역할/승인/개인정보 기준과 독립 수용. 부분 통과·collection·합성 검사를 전체 실제 통과로 처리하지 않음 |
| 예상 결과 | 기존 의미를 유지한 실제 started/persistence/replay 관측 또는 보존된 실패. CRASH-12 근본 원인 해결을 source 변경만으로 주장하지 않음 | 정확 후보의 전건 통과와 검토 가능한 실제 증거. 성공 뒤에만 실행 접수 UI 계획·연결 진행 |
| 증빙 자료 | V5 실패 gate/JUnit·독립 검토, 공식 문서 URL과 pinned SDK 필드의 로컬 소스 근거, TC diff/AST·독립 계획/소스 검토, V6 후보·paired reviews | private SQL/protobuf/pending/proxy/process/timing/source/env 증거와 공개 안전 요약·독립 결과 수용·commit/push. 원본 코드 archive·로그·인증·PID 등은0700/0600 private로 유지 |
| 실패 복구·재검증 | 실패 증거와 현재 causal cut을 보존하고 해당 계약/관측 단계로 복귀한다. pending이 STARTED가 아니거나 matching이 모호하면 실패한다. query timeout을 삼키거나 임의 sleep·timeout 연장·제2 run·생산 상태 조작으로 통과시키지 않는다 | 실제 실행의 owned identity만 원래 deadline 안에 정리하고 unknown을 성공으로 추정하지 않는다. 영향 수정 뒤 exact source/pins/reviews 갱신, 전체490과 영향 회귀 재검증. 관찰 timeout만으로 중복 실행 금지 |

## 추가 증거와 영향 범위

- CRASH-10/11 각각 `pending-activity-at-worker-cut.json`을 추가한다. 실제 describe 값과 history의 Scheduled 연결을 보존하며 pre-terminal Started count를 만들어 쓰지 않는다. 후속 실제 terminal history의 Started/Completed 검증을 유지한다.
- CRASH-12는 `proxy-recovery-observation.jsonl`에 release 직후와 복구 뒤의 실제 proxy 상태/이벤트/카운터 및 후속 decision 관측을 보존한다. release snapshot은 불확실한 await/query 전에 즉시0600 첫 줄로 보존하고, 기존 private journal append로 실제 후속 snapshot/상태를 추가한다. 실패 시에도 원래 cleanup budget 안의 finally에서 가능한 snapshot을 남기며, 초기 증거를 덮어쓰거나 성공 snapshot을 만들어 쓰지 않는다. release 뒤 armed=false·overflow=false·release event를 확인한다. 복구 뒤 실제 전달량 증가/새 연결은 지원 증거이며, worker 재생 증명은 saved old worker의 부재·같은 run의 실제 후속 decision·queued query다. `held_response_bytes`는 누적 카운터여서 release 후0을 요구하지 않는다.
- 기존953 artifact 규칙을 삭제하거나 약화하지 않고 위 JSON2개와JSONL1개를 추가해956개로 만든다. 87 raw cases·38 source pins·10 raw audit phases는 유지한다. 새 파일은 같은 node/case에 연결한다. 신규 SDK module을 추가 설치하거나 runtime 환경을 변경하지 않는다.
- V6는 V5/V4 및 실패 시도를 불변 보존한다. 변경된 worker test와 새 rules·auditor 고정 filename·unit fixture filename의 pins, 관련 producer 위치/현재 독립 source 검토를 갱신한다. ledger110·원래490 ID·25+5·15phase·15420+800=16220초,19 anchors/7 binaries, 원본AX/설계와152 method AST/ID는 유지한다. runner는 C/L/review/rules 고정 literal 연결 외 동작 변경0, raw auditor는 RULES filename 외 함수 AST 변경0이다.

정상(단일 실행·최종queued), 예외(SIGKILL·결과 응답 손실), 경계(실제 transaction commit 전후·ActivityCompleted/후속 decision·같은 run/attempt·deadline), 회귀(4개 worker cases·기존dispatcher8·전체490·152)를 포함한다. UI/생산 SQL/서비스·장비·외부 배포는 이번 변경 대상이 아니다. UI 소스 변경0이므로 이 보완 단계에서 build/browser 반복을 생략한다. 요청 실행 UI·H3–H7·장비·배포·AT32 인수의 미검증 위험은 그대로 남는다.

이 문서는 구현 계획이며 단위·SDK·collection·SQL/services·main·전체490 실행 승인이나 완료 증거가 아니다.
