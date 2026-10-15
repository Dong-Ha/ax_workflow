# V2 SQE 수동 수행·결과·보고·판정 시각화와 검증

REQ-01/02/04/05/06/07/08/10/12/14 및 원본 AT-11/12/13/14/15/17/22/30/32의 모의 관측이다. 원본 workflow/bridge/agent 계약과 독립 승인·수용된 V2-SQE.md를 우선한다. Paperclip은 상위 관제이며 SQE 수집·보고, 시스템 P24 판정, 사람 수행·최종 승인을 바꾸지 않는다. code-dev(main)가 구현·통합하고 TC는 tests/ 작성·실행, 별도 reviewer는 계획·소스·TC·증빙을 읽기 전용으로 검토한다. 구현 전 이 계획의 독립 승인이 필수다.

## 고정 범위와 시나리오

기존 41개의 events/checkpoints는 commit 2d6319f 기준 `evidence/v2/sqe-ui-baseline-41.json`의 SHA로 그대로 보존한다. 과거25/32 및 SQE 이관 전41 baseline도 수정하지 않는다. 기존41에 새9개를 추가해 총50개로 만든다. 새 fixture는 기존 정상 happy-path의 승인된 사건을 복사하되 명시적인 합성 SQE 사건으로 작성하며 replay 결과를 읽어 다음 성공 사건을 만들지 않는다. 새로운 source별 sequence/ID와 step/cycle/attempt/execution 좌표를 고정한다. 새 시나리오의 source는 `mock:sqe-ui`, source_sequence와 evidence ID는 attempt마다 고유하다. 기존41에 새 사건을 삽입하거나 checkpoint를 바꾸지 않는다.

| ID | checkpoint ID와 독립 기대 관측 | 끝 상태 |
|---|---|---|
| sqe-manual-pass | waiting: P22 WAITING_HUMAN, 배정 task/performer; rejected: 잘못된 task 제출 거절/업무불변; submitted: 유효 human bundle 후 READY·manual 보존, 아직 성공 아님; reported: P22/P23 SUCCEEDED·P24 PENDING/보고 참조; judged: P24 PASS/complete=true·X02; end | END/COMPLETED, 발행1·manifest report참조 |
| sqe-manual-fail | submitted: READY, 명시적 필수case FAIL; reported: 수집/보고 SUCCEEDED·품질FAIL 전; judged: P24 FAIL/complete=true; rerouted: 원본 route로 cycle2/P07 및 cycle1 과거 SQE 보존; end | cycle2/P07/RUNNING·재작업1·발행0 |
| sqe-incomplete | collected: P22 completed bundle, 필수case 하나 누락; reported: P23 SUCCEEDED; blocked: P24 INCONCLUSIVE/complete=false, generic 성공 거절; end | P24 RUNNING·발행0 |
| sqe-parser-error | collected: parser error 및 exit null; reported; blocked: P24 ERROR/complete=false, generic 성공 거절; end | P24 RUNNING·발행0 |
| sqe-identity-mismatch | collected: observed boot identity가 expected와 다름; reported; blocked: P24 INCONCLUSIVE/complete=false, generic 성공 거절; end | P24 RUNNING·발행0 |
| sqe-manual-retry | waiting; submitted: manual infrastructure_error→READY; backoff: RUNNING→infra_error→WAITING_RETRY/10초; retried: P22 a2 READY·새 proof 없음/과거a1수동결과 보존; waiting-two: 새 context/task·WAITING_HUMAN; stale: a1 human task 제출 거절; submitted-two: 새a2 human bundle READY; judged: fresh 보고/판정 PASS; end | END/COMPLETED·P22 a2·발행1·수동 mode |
| sqe-report-retry | reported: P23 a1 report, 아직 RUNNING; backoff: infra_error; retried: P23 a2 READY·P22 결과 보존/현재report 없음; stale: a2 RUNNING에서 과거a1 report envelope 재전송 거절; reported-two: 새a2 보고; end | END/COMPLETED·P23 a2·새 report/manifest 참조 |
| sqe-judgment-retry | judged: P24 a1 PASS, 아직 RUNNING; backoff; retried: P24 a2 READY·현재판정없음/보고보존; stale: a2 RUNNING에 실제a1 measurement 재전송 거절; judged-two: fresha2 PASS; end | END/COMPLETED·P24 a2·동일 유효보고·새판정 |
| sqe-manual-quarantine | waiting: 수동 task 대기; quarantined: device operation unknown으로 RECONCILING·sticky격리; blocked: 그 뒤 유효 human 결과도 거절·task대기보존; end | P22 RECONCILING·quarantined=true·result없음·발행0 |

새 source 사건의 event_id는 mock:<scenario>:ui:e<source_seq>, sequence는 시나리오별 1부터 적용 순서대로 증가한다. 수동 request evidence는 mock:<scenario>:ui:manual-request:a<attempt>, context/result/report 증거는 mock:<scenario>:sqe:<kind>:c1:a<attempt>를 사용한다. retry event의 현재 좌표와 a1 재전송 envelope의 과거 좌표를 TC가 literal로 구분한다. quarantine의 blocked는 waiting에서 배정한 같은 task의 human 결과 제출이며 P22 WAITING_HUMAN record와 result=null을 유지하고 reconciliation_required로 거절한다. report-retry와 judgment-retry의 end는 승인·영수증·노트까지 마친 END/COMPLETED/발행1이다.

모든 새 시나리오는 start(0), 위 checkpoint, end를 포함한다. 같은 cursor의 end는 허용한다. 판정 이전 P22/P23 수집 성공을 시험 PASS로 부르지 않는다. infrastructure_error, 불완전/파서오류, 품질 FAIL, EXEMPT와 실제 시험 수행을 구분한다. 원본에 없는 SQE trial 반복 횟수·성공률·수치 기준·자동 보완 루프는 추가하지 않는다. 합성 두 사례는 실제 정책/사례 수가 아니다.

## 표시와 탐색 계약

`ifpmic-sqe-observation` region은 현재 P22 context/result/manual task, P23 report 또는 P24 report reference가 있을 때 나타난다. 현재 P22/P23/P24 상태/attempt, mode(수동/bridge mock), 사람 task 대기/수락, P22 수집 여부, P23 보고 여부, P24 기록된 verdict/complete, report reference/manifest reference를 별도로 표시한다. gate 없으면 미판정이다. UI에서 품질 verdict를 다시 계산하거나 수집 성공을 PASS로 승격하지 않는다.

선택 단계 상세에는 `ifpmic-sqe-step-detail`로 원래 cycle/attempt/execution/후보와 고정 profile/script/parser/rule 버전, 목표 device/bridge/image hash/expected boot, human assignee/performer/task/reason/request시각, 결과 mode/actor/performer/시각/execution_status/parser_status/exit code, expected와 observed identity, 두 필수 사례와 실제 수집 사례/누락 표시, stdout/stderr/result artifact ID, P23 result evidence/execution/profile/report artifact/link ID, P24 report evidence ID를 표시한다. 결과 없는 pending/manual 상태에서는 결과·보고 없음으로 표시한다. 미수행 면제는 기존 exemption_report 패널을 유지하며 SQE 결과를 만들어 표시하지 않는다. artifact/report link ID는 텍스트이고 실제 URL·파일 열기·다운로드·외부 링크를 만들지 않는다. 원시 로그·도구 payload·인증은 표시하지 않는다.

history의 SQE step detail에는 `ifpmic-sqe-history` 표시와 과거 cycle/attempt를 붙이고 같은 필드의 원래 기록을 보존한다. 이전 PASS/manual task/report가 현재 실행의 유효성 또는 제출 권한으로 표시되지 않는다. 현재 snapshot의 accepted record만 읽고 임의 입력·실제 요청·제출·실행 버튼은 추가하지 않는다. 재생 처음/이전/다음/끝/checkpoint/시나리오전환/reset/현재노드/선택상세/키보드/필터를 유지한다. 모의 상태가 처음/다른 시나리오에 남지 않는다.

## 단계별 검증과 수용

| 단계 | 검증 목적·대상 | 방법·담당 Agent | 합격 기준·예상 결과 | 증빙·실패 복구/재검증 |
|---|---|---|---|---|
| SU0 | 원본·프로토콜·계획·41 baseline | 독립 reviewer: 원본/승인SQE/계획/실제catalog 대조 | 구현 전 승인, 원본 경로·담당·상한·승인 변경0 | 계획/baseline SHA/review. 불일치하면 원본 또는계획으로 복귀·재승인 |
| SU1 | 50개 catalog·모든 새 checkpoint의 정상/예외/경계/이력 | TC 독립 literal endpoint/checkpoint/proof좌표/reason oracle, 기존41 SHA/checkpoint byte보존·구25/32/41이관검사, prefix/입력 불변 | 50개 정확한 ID/순서/끝 상태, 새9개 모든 checkpoint/예정거절, false성공0·과거현재승격0·missingcase PASS0 | unit 로그, catalog/journal. 최초 잘못된 사건부터 fixture/core/TC 원인분리→관련unit 전체재검증. core계약변경 필요시 S0로복귀 |
| SU2 | offline standalone/격리 Paperclip native host의 실제 상세·history·탐색 | TC browser: 전체50 endpoint, 새9흐름 핵심checkpoint와 선택P22/P23/P24·history·reset·375/1440px | field 표시·수동모드·배정·보고판정참조·누락/ERROR 구분 정확; 쓰기/외부/console/page오류0·page overflow0·상세읽힘 | browser JSON/PNG. fixture/selector/UI결함 분리→관련UI+회귀재수행 |
| SU3 | AX/원본/V1/전체UI 회귀·후보동일성 | main이 기존11명령 `npm run ifpmic:verify:ui`; TC unit/browser 포함 | 전체 exit0·unit fail/skip0, source125+새파일 전후동일, 원본17파일·uploadSHA·AT미실행불변 | gate/log/source/dist/plugin/reportSHA·6unit관측 fresh SHA. source변경하면 새gate, 실패시기록보존하고관련단계복귀 |
| SU4 | 독립 증거·시각검토·추적성 | reviewer 소스/TC/gate/실제이미지/공개사본 감사; main 최종통합 | 구현/TC담당과 다른 reviewer가 증거 수용 후에만 부분완료, commit/push 성공 | review/progress/decisions/요구사항연계. 반려시 SU0~3 해당단계로 복귀·재검증 |

두 환경 각각 필수 화면: sqe-manual-pass.waiting(P22,1440), submitted(P22,375), judged(P24,1440); sqe-manual-fail.rerouted(history,1440); sqe-incomplete.blocked(P22상세+P24판정,1440); sqe-manual-retry.waiting-two(P22+history,375); sqe-report-retry.reported-two(P23,1440); sqe-judgment-retry.stale(P24+history,1440); sqe-manual-quarantine.blocked(P22,1440). parser/identity는 실제browser state/필드검사로 검증하고 별도모든checkpoint×viewport PNG를 요구하지 않는다. 기존필수 캡처는 유지한다. 긴 mobile 상세는 UI를 숨기지 않는 실제viewport 캡처로 읽을 수 있게 보완한다. 원래 fullPage 증거는 보존한다. host 공지 처리만 기존 V2-EXCEPTION-UI-CAPTURE.md의 정확한읽기전용조정 규칙을 유지한다. 기존 supplement의 samecandidate/source-before-after/GET-only/geometry/hit-grid 원칙을 새SQE상세에도 적용하며 쓰기예외는 없다.

runner의 catalog count를50으로 바꾸고 이계획·새baseline·독립승인JSON을 source snapshot에 추가한다. catalog-evidence의 SQE이관ledger는 기존41에만 적용하고 새9의 SHA/journal은 전체catalog에 기록한다. 생성관측/현재코드에서 계산한 기대값은 TC oracle을 대신하지 않는다. 기존 SQE unit 관측6개는 그대로 신선도·파일SHA와 함께수집한다.

단계 생략없음. 영향은 기존41 보존+catalog 확장+React 상세이므로 전체11명령gate가 필요하다. 실제manual요청/SSO/장비제어/업로드·lease/journal·실행·최종배포/외부제출·정책/프로파일·실AT는 B01–B13 범위로 계속 남는다. child-agent/pause/resume/cancel과 전체V2도 미완료다. 이 증분의 합격을 목표전체완료로 대체하지 않는다.
