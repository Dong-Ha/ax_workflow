# V2 필수 SQE 결과·보고·수동 수행 근거

REQ-01/02/04/05/06/07/08/10/12/14, 원본 AT-11/12/13/14/15/17/22/30/32의 모의 검증이다. 실 AT 상태는 변경하지 않는다. code-dev(main)는 설계·구현·통합, TC는 별도 테스트 작성·실행, 독립 reviewer는 계획·소스·TC·고정 후보와 화면 증거를 감사한다. 이 계획의 독립 승인 전에 구현하지 않는다.

## 기준과 필수화 결정

기준은 원본 workflow P22/P23/P24, bridge-contract manual/identity/lease, agent-contract sqe, project-profile 예시 및 DOCX의 시험·수동 결과 규칙이다. P22는 SQE가 실제 완료 또는 명시적 시험 실패의 원본 결과를 수집하고, P23은 성공/실패를 작업 내 보고서 링크로 공개하고, P24 시스템이 현재 보고서와 필수 사례에 기준을 적용한다. 시험 FAIL이어도 P22→P23을 먼저 거치며 P24 FAIL에서 원래 P07 복귀를 사용한다. 도구 중단·장비 단절을 품질 FAIL로 바꾸지 않는다.

Luna 조사 및 main 검토에서 현재 generic P22/P23 SUCCEEDED와 P24 complete=true만으로 원본 시험 근거 없이 진행할 수 있음을 확인했다. 별도 senior_sol은 opt-in guard가 이 우회를 남기므로 모든 비면제 P22/P23/P24에 필수 guard를 권고했다. 이 증분은 이를 필수화한다. 기존 POLICY/COUPLED 면제는 유지하며 P23 SQE 미수행 보고를 계속 요구한다. baseline compatibility를 이유로 무근거 성공 경로를 남기지 않는다.

원본은 실제 SQE 사례 개수·반복 횟수·수치 기준·manual metadata의 상세 JSON schema를 정하지 않았다. 이 계획의 두 사례와 필드는 **명시적인 합성 fixture 결정**이며 실제 B01/B10 정책 승인이 아니다. 기존 infra 3 attempts/10·30초와 업무 재작업 3 cycles는 유지하고 SQE trial 반복 상한으로 해석하지 않는다. 실제 승인 profile·장비·실행기·hash registry·인증·lease/fencing/journal·수동 증빙 검증은 B 단계에서 계속 필요하다.

## 버전 고정 mock 프로파일과 공통 경계

프로파일은 코드의 불변 registry 한 개다: profile_ref=`mock:sqe:profile`, profile_version=`mock:sqe:profile:v1`, script_version=`mock:sqe:script:v1`, parser_version=`mock:sqe:parser:v1`, rule_version=`mock:rules:v1`. 필수 사례는 정확히 `mock:sqe:case:boot`, `mock:sqe:case:function`이다. case별 PASS/FAIL은 합성 판정 입력이며 실제 수치 기준을 대신하지 않는다. 사건이 필수 사례 목록을 바꿀 수 없다.

모든 사건은 기존 mock job/step/cycle/attempt/execution/source-sequence/dedup 경계를 따른다. 모든 표 필드는 필수, 추가 필드는 거절한다. ID/해시는 기존 mockId(opaque mock 토큰 ≤128, safeText 처리 전후 동일), 시각은 nonnegative safe integer ms다. 실 SHA 검증을 주장하지 않는다. 새 SQE 증거 ID는 모든 현재/과거 SQE proof에서 중복 불가하며 참조 ID는 정확히 기존 근거를 참조한다. 입력/출력 snapshot은 기존처럼 불변이다. 거절은 현재 업무 projection을 변경하지 않는다(관측 journal/dedup 제외). raw stdout/stderr, shell, log, 인증·경로·자유 텍스트는 받지 않고 artifact ID만 받는다. 실제 호출·장비 할당·발행은 없다.

context와 result는 P22 step record에, 보고서는 P23 step record에, 판정의 report reference는 P24 step record에 보관한다. 원래 cycle/attempt/execution/후보/프로파일 버전을 함께 저장한다. retry/cycle 이력은 원래 record를 보존한다. 어떤 수동 사건도 장비 격리를 해제하거나 재할당을 허용하지 않는다. 기존 장비 quarantine/RECONCILING이 모든 성공·새 SQE 근거 적용보다 우선한다.

| 사건 | payload 필드 | 적용·결과 |
|---|---|---|
| sqe_context | actor, candidate_fingerprint, profile_ref, profile_version, script_version, parser_version, rule_version, device_id, bridge_id, image_hash, expected_image_identity, evidence_id | actor=mock:sqe, 현재 RUNNING P22에서 attempt당 1회 불변. 현재 후보와 고정 registry/rule 버전 일치. target device/bridge/image/boot identity를 명시. 실행 모드는 처음 bridge_mock이며 이 사건이 실행·성공을 만들지 않는다. |
| manual_request | actor, task_id, assignee, performer_id, reason_id, requested_at_ms, evidence_id | 현재 context가 있는 RUNNING P22, 아직 결과/수동 task 없음. actor=mock:sqe, assignee=mock:human, task=mock:manual:P22:c<cycle>:a<attempt>, performer_id는 mock:performer:sqe로 고정한 mock 배정. 원본 RUNNING→WAITING_HUMAN 전이를 검사하고 task를 기록한다. 장비가 active/unknown/quarantined이면 거절하며 중단/점유 해제를 가장하지 않는다. OFFLINE 자체는 자동 실행 중단이나 격리 해제를 뜻하지 않는다. |
| sqe_result | actor, execution_mode, task_id, performer_id, candidate_fingerprint, profile_ref, profile_version, script_version, parser_version, rule_version, device_id, bridge_id, image_hash, observed_device_id, observed_image_identity, started_at_ms, finished_at_ms, execution_status, parser_status, exit_code, cases, stdout_artifact_id, stderr_artifact_id, result_artifact_id, evidence_id | context에 결속된 P22 attempt당 결과 bundle 1개. bridge_mock는 RUNNING에서 actor/performer_id=mock:sqe, task_id=null이며 manual task 없어야 한다. manual은 WAITING_HUMAN에서 actor=mock:human, 배정 task/performer와 일치, started>=requested 및 finished>=started. 모든 identity/profile/버전 필드는 context와 동일하며 observed_device/image는 별도 opaque 관측으로 보존한다. execution_status=completed/infrastructure_error, parser_status=complete/error, exit_code는 safe integer 또는 null. cases는 {case_id,outcome} 객체 배열; case_id는 고정 목록, 중복/미지/extra key 거절, outcome=PASS/FAIL/ERROR/INCONCLUSIVE. 누락 사례는 수집 불완전으로 보존하며 PASS 근거가 아니다. stdout/stderr/result artifact는 서로 다른 mock ID. 수동 수락 시 원본 WAITING_HUMAN→READY로 이동, mode=manual 보존; 별도 READY→RUNNING→SUCCEEDED가 필요하며 자동 수행으로 바꾸지 않는다. |
| sqe_report | actor, candidate_fingerprint, result_evidence_id, result_execution_id, profile_ref, profile_version, report_artifact_id, report_link_id, evidence_id | 현재 RUNNING P23, P22 SUCCEEDED 및 현재 유효한 결과 참조. actor=mock:sqe. 결과의 P22 execution_id/evidence_id, 현재 후보와 profile version 일치. 보고서 artifact/link는 mock 토큰, 작업 내 열람 링크 식별자이며 외부 발송이 아니다. P23 attempt당 한 보고서, 별도 SUCCEEDED가 필요하다. |

P22 성공은 현재 context+result가 있고 execution_status=completed여야 한다. Agent completed, 장비 idle, generic human 제출, generic step 전이만으로 이 근거를 만들지 않는다. infrastructure_error는 P22 성공/품질 FAIL로 진행하지 않고 기존 infra_error/retry 프로토콜의 새 attempt와 새 context/result가 필요하다. 수동 task가 미완료일 때 generic READY/RUNNING/SUCCEEDED 전이로 사람 대기를 해제하지 못한다.

P23 성공은 현재 P22 결과에 정확히 묶인 현재 P23 report가 있어야 한다. P22 SKIPPED 경로에는 이 보고서를 만들지 않고 기존 exemption_report를 요구한다. P23 infra retry는 P22 결과를 보존하되 새 P23 attempt/report 증거를 요구하고 P22를 재실행하지 않는다.

### 수집 종료와 재시도 oracle 보완

각 attempt의 sqe_result는 단 한 번 기록하는 불변 bundle이다. 부분 사례/파서 오류를 같은 attempt의 두 번째 결과로 덧붙여 통과시키지 않는다. 수동 결과는 유효한 배정 제출을 수락하는 순간 bundle 저장과 WAITING_HUMAN→READY를 원자적으로 적용한다. 이는 사람 task 완료이지 시험 PASS 또는 자동 실행이 아니다. 이후 명시적인 READY→RUNNING→SUCCEEDED를 요구한다. 수동 전이의 새 step 사건은 전용 TC/후속 수동 시나리오에서만 작성하며, 기존41 이관에는 새 step 사건을 삽입하지 않는다.

| 수집 관측 | P22 / P23 진행 | P24 / 복귀 |
|---|---|---|
| completed, 필수2사례 PASS, parser complete, 일치 identity, exit0 | P22 수집 성공→P23 보고 성공 | PASS/complete=true, X02 가능 |
| completed, 필수사례 중 FAIL, 나머지 PASS/FAIL, parser complete, 일치 identity, exit0 또는1 | P22 수집 성공→P23 실패 증거 보고 성공 | FAIL/complete=true, 원본 business_failure+route로 P07 |
| completed, 사례 누락/INCONCLUSIVE 또는 boot/device 불일치 | 결과와 불완전성을 수집해 P23 보고 가능 | INCONCLUSIVE/complete=false, 통과·품질 FAIL 복귀 불가 |
| completed, parser error/exit null/case ERROR (identity 일치) | 결과와 파싱/기술 오류를 P23 보고 가능 | ERROR/complete=false, 통과·품질 FAIL 복귀 불가 |
| infrastructure_error | P22 성공 금지, P23로 진행 불가 | P24 판정 자체 없음, 기존 infra retry만 |

infrastructure_error bundle의 자동 경로는 RUNNING P22에서 기존 infra_error(operation=agent, now_ms)→WAITING_RETRY→10초 뒤 retry→새 attempt READY→RUNNING→새 context/result다. 수동 경로는 WAITING_HUMAN에서 배정된 human의 infrastructure_error bundle 제출→READY(수동 표시는 보존)→명시적 RUNNING→기존 infra_error(operation=agent)→동일 retry 규칙이다. 이 agent 값은 기존 SQE 수집 worker 장애 분류이며 수동 시험을 자동 수행으로 기록하지 않는다. 새 P22 attempt에는 새 context와 manual_request/task/result가 필요하며 예전 task·결과는 재사용하지 않는다. 3번째 attempt의 한도 처리는 기존 WAITING_HUMAN/알림 관측을 유지한다.

completed지만 불완전/ERROR인 bundle은 P24에서 차단을 관측한다. 이를 수정하려고 새 숨은 P24→P22 경로나 임의 반복 실행을 만들지 않는다. 같은 유효 보고서의 P24 인프라 재시도도 불완전 결과를 PASS로 바꾸지 못한다. 실제 보완·작업 재개 정책은 원본 B 단계의 profile/human 정책에서 별도 확정한다.

## P24와 배포 증거 결속

P24의 기존 measurement envelope/evidence는 유지하되 아래에서 결정한 처분과 payload verdict/complete가 정확히 맞아야 수용한다. 모든 비면제 P24 measurement 및 SUCCEEDED는 현재 P22 context/result와 SUCCEEDED, P23 report와 SUCCEEDED, 현재 후보/규칙·report attempt/execution 일치를 요구한다. generic complete=true는 이 조건을 대신하지 못한다.

1. observed device 또는 boot image identity 불일치 → INCONCLUSIVE, complete=false.
2. parser error, exit_code=null 또는 case ERROR → ERROR, complete=false.
3. 필수 사례 누락/case INCONCLUSIVE, exit_code가 0/1 이외, 전부 PASS인데 exit_code!=0 → INCONCLUSIVE, complete=false.
4. 모든 필수 사례가 PASS/FAIL, parser complete, 식별 일치 및 exit_code 0/1이면 하나라도 FAIL → FAIL/complete=true, 전부 PASS+exit0 → PASS/complete=true.

불완전/ERROR는 실제 업무 FAIL 복귀를 만들지 않는다. P24는 통과하지 않으며 이 모의 증분에서 새 복귀 edge나 자동 재실행·격리 해제를 만들지 않는다. P24 infra retry는 원래 규칙에 따라 새 판정 attempt를 만들고 같은 유효 보고서를 참조할 수 있다.

판정에 `gate_sqe_report_evidence_id`를 기록하고 release의 current-gate 검사는 이를 현재 P23 보고서와 비교한다. mock manifest에도 `sqe_report_evidence_id`를 결속해 후보·cycle·gate 처분·보고서가 다른 자료에 같은 digest를 재사용하지 못하게 한다. P22/P24 공동 EXEMPT manifest에서는 이 필드 null이며 기존 공동 면제·P23 미수행 보고 조건으로만 허용한다. 과거 PASS/보고서는 새 candidate/cycle/관련 attempt를 해제하지 않는다. metadata-only 복구는 같은 cycle의 품질 증거와 report 참조를 보존한다.

## 기존 41개 fixture의 명시적 이관

기존 수용 기록과 baseline 파일은 수정하지 않는다. 이관 전 41개 사건 SHA/checkpoint 목록은 `evidence/v2/sqe-baseline-41.json`에 commit d8c4757 기준으로 고정한다. 현행 카탈로그를 SQE 증거를 포함하는 새 버전으로 이관하며 기존 41개 ID/순서/단계·역할·경로·끝 상태는 유지한다. 과거 ‘events byte 불변’ 수용을 새 실행의 증거로 재사용하지 않는다.

허용 변경은 별도 source_id=mock:sqe-catalog의 sqe_context/result/report 사건을 해당 P22 RUNNING/완료 직전/P23 완료 직전에 삽입하는 것이다. 기존 사건의 event_id/source_id/source_seq/envelope/payload는 그대로 보존한다. 새 사건은 기존 generic PASS에서 결과를 계산하지 않고 독립적으로 작성한 고정 fixture다: sqe-failure의 명시적 case FAIL, 그 밖의 정상 실행은 명시적 두 PASS를 사용한다. P22가 SKIPPED인 면제 흐름에는 삽입하지 않는다. 후보·cycle/attempt 좌표는 원래 사건의 authoring 좌표를 따라 작성한다. 결과를 내지 않는 device 대기/격리 prefix에는 결과/보고서를 삽입하지 않는다.

checkpoints의 ID/제목/상대 순서는 유지하고 같은 기존 사건 prefix를 가리키도록 cursor만 이동한다. TC는 신규 source 사건만 제거했을 때 이전 41개 원래 사건 SHA 및 checkpoint cursor/목록이 정확히 복원되는지 검사한다. 이전25/32 hash 검사는 그 원래 view로 계속 검증한다. source ID만 붙인 임의 사건/다른 source 수정/기존 사건 누락은 이관으로 허용하지 않는다. 이관 ledger는 before/after fixture·checkpoint SHA와 삽입 사건 목록을 기록한다. 생성 관측은 독립 oracle를 대신하지 않는다.

## 검증과 수용

| 단계 | 목적·대상 | 방법·담당 | 합격 기준·예상 결과 | 증거·실패 복구 |
|---|---|---|---|---|
| S0 | 원본 의미·필수화·schema·이관 범위 | 독립 reviewer가 원본/아키텍처 조언/계획·baseline41 검토 | 구현 전 승인, opt-in 우회0·역할/원본전이/정책변경0 | 계획SHA/review. 불명확하면 원본/계획으로 복귀해 재승인 |
| S1 | 정상·업무실패·수동·불완전 결과 | TC 독립 fixture: bridge_mock PASS와 명시적 FAIL→보고→P24→P07, human task→수동 결과→보고→판정, parser/identity/누락 case의 ERROR/INCONCLUSIVE | generic P22/P23/P24 우회0, 누락/기술오류를PASS·업무FAIL로승격0, 자동표시0, 원본P07복귀 정확 | 전용test·현재/과거snapshot. 최초틀린사건으로복귀해결과/guard수정후관련전체재검증 |
| S2 | 예외·경계·이력·원자성 | TC: schema missing/null/extra/unknown profile/중복·미지 cases/ID재사용/잘못된actor·task·performer·hash·script·device·시각, stale candidate/cycle/attempt/execution/source, 격리중수동, manual generic탈출, P22/P23/P24재시도·metadata복구 | 거절업무projection불변, 근거없는성공0, 옛근거현재승격0, release/report결속 일치 | 부정/retry통합로그·진단SHA. 실패원인구현/TC/원본분류후S0~S2 재수행 |
| S3 | 41개 이관·단계·화면·AX 회귀 | TC가 literal original endpoint/checkpoint+이관정규화/삽입allowlist/원본41 SHA, 전체prefix 불변·mock/no-side-effect, 전체 unit/build/plugin 및 11명령 기존UI gate | 기존41 기대상태/41원래사건복원100%, 모든명령 exit0, test fail/skip0, source 전후동일, offline/native-host API쓰기·외부·오류0, 원본/실AT불변 | migration ledger·catalog journal·화면·gate/log/source/build/plugin SHA. 소스후보바뀌면새고정gate, 실패관련단계부터회귀재검증 |
| S4 | 독립 수용·요구사항 추적·커밋 | reviewer source/TC/gate/이관/증빙·main 최종검증 | 구현자와다른reviewer승인·통과증거있어야부분수용 | review/progress/decisions/commit+push. 반려하면관련단계복귀 |

S3 runner는 이 계획, sqe-baseline-41.json, 독립 계획 승인 기록, 고정 mock registry 및 모든 source/tests/scripts를 source snapshot에 포함한다. baseline 정규화는 test가 독립적으로 검증한다. 이관으로 cursor와 내부 증거가 달라지므로 기존41 UI 회귀를 생략하지 않는다. 기존 host mobile fullPage 가림은 승인된 routing supplemental viewport 증거 절차를 유지하며 새 캡처가 가려지면 숨김 없이 보완한다.

이 core 증분은 수동/시험 전용 새 UI·카탈로그를 지원했다고 주장하지 않는다. 새 manual/trial 관측 panel·사람 task/증거·보고/처분 표시와 별도 시나리오/viewport/native-host 검증은 다음 UI 증분에서 필수이며 이 잔여 위험을 기록한다. 나머지 child-agent/pause/resume/cancel과 전체 V2·B01–B13·실 AT는 계속 미완료다. 실행 서비스·실장비·실정책을 mock 성공으로 대체하지 않는다.
