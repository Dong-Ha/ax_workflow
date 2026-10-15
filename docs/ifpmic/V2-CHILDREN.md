# V2 P12 TC 자식 실행·통합 근거 및 시각화 검증 계획

REQ-01/02/05/06/10/11/12/13/14, 원본 AT-03/05/06/07/16/17/24/29의 **합성 관측 검증**이다. 원본 실제 AT ledger는 `not_executed`를 유지한다. Paperclip은 IFPMIC 업무의 상위 관제이며 P11 code-dev→P12 tc→P13 code-dev, 사람 단계, SAM/TEM/SQE와 품질·배포 승인 규칙을 바꾸지 않는다. code-dev(main)는 구현·통합, TC는 테스트 작성·실행, 구현/TC와 별도 reviewer는 계획·소스·검증 증거를 감사한다. 구현 전에 독립 계획 승인이 필요하다.

## 원본 근거와 아키텍처 결정

DOCX §9: “code-dev는 TC 작업 요청을 구조화된 child-task 요청으로 제출한다. 서버는 P12를 tc에 배정하고 code-dev 상태를 WAITING_AGENT로 표시한다. 테스트용 분리 worktree에서 나온 패치는 code-dev가 단독으로 통합한다.” §7/§13은 업무 단계와 agent 실행 상태 분리, 실제 자식 execution ID, 알 수 없는 관계의 추정 금지를 요구한다. P09의 기대 결과는 제품 수정 전에 고정되고, P12 구현은 최신 인터페이스를 따른다.

`agent-contract.json`은 code-dev.children=[tc], TC의 production_source/threshold/release 금지, workspace당 1 writer, 격리 test worktree와 code-dev 직렬 통합, completed≠quality PASS를 정한다. `workflow.v1.json`은 P11 완료→P12 TC 산출물/통합 가능한 패치→P13 통합된 코드/TC 빌드를 정한다. `state-contract.json`에는 SUCCEEDED P11을 다시 RUNNING으로 여는 전이가 없다. 별도 senior_sol의 좁은 설계 검토 후 다음을 결정했다.

- P12 attempt마다 별도 `purpose=p12_coordination`, `role=code-dev` coordinator task/execution을 기록한다. 완료된 P11 execution은 입력 provenance로만 참조한다. P12.owner=tc는 산출물 책임이며 coordinator 실행 역할과 구분한다. P13 code-dev는 다음 단계의 별도 실행이다.
- coordinator는 TC 요청·결과 수집·테스트 패치 통합에 한정한다. 새로운 production 변경을 P12에서 허용하지 않는다. 원본에 없는 P12→P11 경로를 임의 추가하지 않는다.
- 모든 **비재사용 P12**는 현재 coordinator→요청→서버 할당→TC 결과→code-dev 수집→통합 근거를 필수로 요구한다. generic agent completed/step SUCCEEDED만으로 통과하는 호환 우회를 남기지 않는다. 합법적인 P12 REUSE/NO_CHANGE는 기존 검증을 통과할 때만 child를 생략한다. P09 TC 설계는 그대로 두며 임의 다른 역할·중첩·동시 자식으로 확대하지 않는다.
- 부모/자식 Task/Result binding·coordinator 목적·세부 사건은 원본에 없는 **명시적 mock 구현 계약 확장**이다. 원본에 이미 해당 schema가 있었다고 주장하지 않는다. 실제 OS/worktree/credential/패치 파일 검사·runtime start/resume/collect는 B03/B06의 실제 증거가 필요하다.

현재 AX server의 provider 세션/부모 관계·원본 로그는 읽기 전용으로 유지한다. IFPMIC child는 별도 합성 사건만 읽으며 이름이나 근접 시간으로 부모를 추정하지 않는다. 실제 에이전트·패치·worktree·알림·장비·publisher를 실행하지 않는다.

## 식별·범위·불변 경계

P11 provenance의 p11_execution_id 역시 기존 P11 step attempt 좌표이며, 완료된 실제 code-dev runtime 세션을 부모로 재사용한다는 뜻이 아니다.

기존 mock envelope는 job_id/step_id/cycle/attempt/step execution_id를 가리킨다. **외부 envelope execution_id는 P12 step attempt**, payload coordinator_execution_id/child_execution_id는 각각 별도 agent 실행 ID다. 동일 job/cycle/attempt/candidate/requirements_version과 명시 parent/request/task binding을 모두 검사한다. 현재 active P12에만 새 권한을 적용한다. actor는 합성 역할이며 실제 인증이 아니다.

모든 필드는 strict shape로 검사하고 추가·누락 필드를 거절한다. opaque ID는 기존 mockId(≤128, safeText 전후 동일), 시간/ordinal은 safe integer, 배열은 중복 없는 허용 ID만 받는다. 자유 텍스트, 실제 파일 경로·원시 patch/command/stdout/stderr/로그·추론·인증을 받지 않는다. runtime_profile/schema/tool/write scope는 등록된 합성 참조만 받으며 실제 권한·credential이 아니다. production/test hash도 mock token이며 실제 bytes 검증 주장이 아니다.

Coordinator task ID는 P12 attempt 내 고정이며 execution ID와 구분한다. attempt당 coordinator 하나, 미해결 요청/활성 TC child 하나만 허용한다. 요청 ordinal은1부터 증가한다. 사람 질문 후 resume만 같은 coordinator/task 안에 새 child execution으로 이어질 수 있다. 일반 failed child는 새 P12 attempt로만 재시도한다. canceled/interrupted는 사람의 별도 복구 승인 뒤에만 새 P12 attempt로 재시도하며, job 취소/일시중지 제어 의미로 승격하거나 자동 재시작하지 않는다. child execution/request/result/integration 증거 ID는 현재·과거 전체에서 재사용하지 않는다. 다시 재생해도 같은 입력/결과, 입력·과거 record 불변을 유지한다.

Coordinator의 integration workspace와 child의 test workspace는 다르고, child는 `tests_only`, coordinator는 `tests_integration_only`다. TC 결과 changed_path_refs는 고정 합성 allowlist `mock:path:tests:unit`만 허용한다. production/quality/release 경로 참조, 임의 tool/scope·workspace 공유를 거절한다. 이 선언 검사로 실제 AT-06 OS 접근 제한이 입증되었다고 표시하지 않는다. P09 설계 artifact ref/현재 requirements_version 및 P11 실행·코드 artifact/hash를 입력으로 고정하고, 통합의 production_hash_before/after는 이 입력과 동일해야 한다. 기대값 변경은 이 mock schema에서 거절하며 실제 변경에는 원본 요구사항 연결과 TC 설계 재검토가 필요하다.

## 사건 계약

모든 payload에 표의 필드를 빠짐없이 사용한다. 공통 `evidence_id`는 신규 증거, 각 reference는 기존 정확한 증거를 참조한다. 공통 `candidate_fingerprint`와 `requirements_version`은 현재 값이다. 아래 정의는 schema 고정이며 TC와 독립 reviewer가 구현 전에 검토한다.

| type | payload 필드 | 조건·결과 |
|---|---|---|
| p12_coordinator | actor, role, purpose, coordinator_task_id, coordinator_execution_id, candidate_fingerprint, requirements_version, p11_execution_id, code_artifact_id, production_hash, tc_design_artifact_id, workspace_id, write_scope, runtime_profile_ref, evidence_id | 현재 P12 RUNNING, P11 SUCCEEDED 또는 검증된 SKIPPED, p11 실행 정확. actor=mock:system, role=code-dev, purpose=p12_coordination, write_scope=tests_integration_only, runtime_profile_ref=mock:runtime:code-dev-coordinator:v1. 별도 coordinator RUNNING 기록만 생성한다. |
| child_request | actor, coordinator_task_id, coordinator_execution_id, request_id, child_task_id, ordinal, child_role, candidate_fingerprint, requirements_version, workspace_id, write_scope, runtime_profile_ref, output_schema_ref, code_artifact_id, tc_design_artifact_id, prior_child_execution_id, checkpoint_artifact_id, answer_evidence_id, answer_artifact_id, evidence_id | actor=mock:code-dev, role=tc, scope=tests_only, profile=mock:runtime:tc:v1, schema=mock:schema:tc-patch:v1. P12 RUNNING, 입력 ref/parent 일치·부모와 다른 workspace. 첫 요청 ordinal1 및 prior/checkpoint/answer evidence/artifact=null. ordinal은 새P12 attempt마다1로초기화한다. 재개 요청은 직전 needs_human 결과·수집·답변 evidence와 artifact·checkpoint가 모두 일치, ordinal+1/동일 child_task_id/새 request_id. 요청만으로 execution 생성·WAITING_AGENT 전이를 하지 않는다. |
| child_assignment | actor, coordinator_task_id, coordinator_execution_id, request_id, child_task_id, child_execution_id, candidate_fingerprint, requirements_version, workspace_id, evidence_id | actor=mock:system. 정확한 미해결 요청 및 반환된 신규 child execution ID를 기록하는 합성 start 확인. TC child RUNNING, coordinator WAITING_AGENT, 원본 P12 RUNNING→WAITING_AGENT. 실제 start 호출은 없음. |
| child_result | actor, coordinator_task_id, coordinator_execution_id, request_id, child_task_id, child_execution_id, candidate_fingerprint, requirements_version, workspace_id, status, output_schema_ref, patch_artifact_id, changed_path_refs, production_hash, question_id, checkpoint_artifact_id, failure_class, started_at_ms, finished_at_ms, evidence_id | actor=mock:tc, 할당된 child만, 실행당 불변 결과1개. status=completed/needs_human/failed/canceled/interrupted. completed는 정확한 patch schema, nonnull patch ID, allowlist 경로, question/checkpoint/failure=null. needs_human은 patch=null·paths=[], question/checkpoint nonnull·failure=null. failed/canceled/interrupted는 patch/question/checkpoint=null·paths=[]·failure_class가 각각 agent_failure/canceled/interrupted. 모든 경우 production_hash는 입력과 같고 종료>=시작. child 종료를 기록할 뿐 P12/부모 성공·gate PASS를 만들지 않는다. needs_human 결과는 aggregate human wait 필요성을 보존한다. |
| child_collect | actor, coordinator_task_id, coordinator_execution_id, child_execution_id, result_evidence_id, candidate_fingerprint, requirements_version, evidence_id | actor=mock:code-dev, 현재 child 결과 정확, 실행당 수집1회. completed는 P12 WAITING_AGENT→RUNNING·부모 RUNNING, 이후 통합 필요. failed는 수집 후 RUNNING으로 돌아가 기존 infra_error/retry로 새attempt를 만든다. canceled/interrupted는 P12 WAITING_AGENT→WAITING_HUMAN·부모 WAITING_HUMAN 및 kind=agent_recovery task를 만든다. needs_human은 P12 WAITING_AGENT→WAITING_HUMAN·부모 WAITING_HUMAN, 질문 task 생성(kind=agent_question, assignee=mock:human, task ID는 child execution에 결속), business human task와 구분한다. |
| child_answer | actor, coordinator_task_id, coordinator_execution_id, child_execution_id, task_id, question_id, answer_artifact_id, checkpoint_artifact_id, candidate_fingerprint, requirements_version, evidence_id | 현재 수집된 needs_human 질문의 배정 human만. actor=mock:human·정확한 question/task/checkpoint. 답변을 불변 기록하고 WAITING_HUMAN 유지한다. 별도의 step READY→RUNNING 관측 뒤 child_request(resume)→새 child_assignment가 필요하다. 동일 실행 완료로 덮어쓰거나 숨은 실행을 만들지 않는다. |
| child_recovery | actor, coordinator_task_id, coordinator_execution_id, child_execution_id, task_id, result_evidence_id, action, reason_id, candidate_fingerprint, requirements_version, evidence_id | 수집된 canceled/interrupted의 kind=agent_recovery task만, actor=mock:human·action=retry·모든현재binding일치. 새attempt 재시도에 대한 사람 근거만 기록하고 WAITING_HUMAN 유지. 별도 READY→RUNNING 후 infra_error/retry(원래10/30초·3attempt)가 필요하다. 이 증거 없이 canceled/interrupted를 자동 재실행하지 않는다. 실제 job cancel 요청/terminal job에는 적용할 수 없다. |
| child_integrated | actor, coordinator_task_id, coordinator_execution_id, child_execution_id, result_evidence_id, patch_artifact_id, candidate_fingerprint, requirements_version, production_hash_before, production_hash_after, changed_path_refs, expectations_changed, outcome, integration_artifact_id, evidence_id | actor=mock:code-dev, P12 RUNNING·수집된 completed 결과/patch 정확·활성 writer 자식 없음, production before/after=coordinator 입력, 경로는 결과와 정확히 동일, expectations_changed=false. outcome=conflict이면 artifact=null, 충돌 기록만 보존·P12 통과 금지. outcome=integrated이면 nonnull 통합 artifact와 단일 불변 receipt, coordinator COMPLETED. P12는 별도 step SUCCEEDED를 통해서만 P13으로 간다. 충돌 후 같은 유효 결과의 테스트 범위 통합 증거는 새 ID로 수용할 수 있고 충돌 이력은 보존한다. |

초기 ordinal 요청의 child_task_id와 coordinator_task_id는 별개의 opaque mock ID다. 질문 task ID는 `mock:child-human:<child_execution_id>`, 복구 task ID는 `mock:child-recovery:<child_execution_id>` 형식이며 전체 mockId 길이를 지켜야 한다. 구현 시 ID template가 길이128을 넘지 않게 합성 fixture를 작성하며 잘라서 다른 task로 만드는 방식은 금지한다. ID 생성 표현이 기존 ID grammar의 `:`를 포함해도 정확한 같은 문자열을 참조한다.

RECONCILING 또는 sticky device quarantine 중에는 새로운 coordinator/요청/할당/수집/답변/통합을 적용하지 않는다. 이미 할당된 현재 child의 엄격하게 결속된 child_result 종료 관측은 기록할 수 있지만 job RECONCILING을 유지하고 다음 동작·통합·gate를 열지 않는다. device lease나 실제 writer lock을 해제하지 않는다.

원래 `step` 사건으로 WAITING_AGENT를 직접 만들지 못한다. 비재사용 P12 generic 성공은 현재 coordinator·요청·할당·completed 결과·수집·통합 참조와 입력 버전이 모두 유효할 때만 허용한다. 미해결 child/result/질문을 generic READY/RUNNING/SUCCEEDED/FAILED/human/agent 사건으로 해제하지 못한다. 연결된 child와 모순되는 generic agent status는 거절하며, 일치하는 기존 completed telemetry는 증거를 새로 만들지 않는다. 이관 사건6개는 P12 RUNNING 직후 연속 삽입되어 원래 generic completed 시점에는 이미 child completed/수집/통합이 기록된다. 따라서 보존된 원래 completed telemetry는 applied=true인 무권한 no-op이며 TC가 이 상태와 raw bytes 보존을 함께 검사한다. P12 FAILED는 별도 실패/재시도 근거 없이 직접 설정하지 못한다.

업무 job state는 원본 목록을 유지한다. parent WAITING_AGENT와 P12 WAITING_AGENT는 별도로 표시하며 job을 존재하지 않는 WAITING_AGENT로 바꾸지 않는다. 정상 실행 중 job은 RUNNING + wait_reason=child_execution_pending이고, 질문 human 대기는 WAITING_HUMAN, RECONCILING/기존 device quarantine가 항상 우선한다. 완료·미해결·중단 child를 job COMPLETED/CANCELED나 품질 PASS로 복사하지 않는다.

failed 수집 또는 canceled/interrupted의 명시적 human 복구 승인/READY/RUNNING 후 infra_error(operation=agent)는 원래 P12 RUNNING→WAITING_RETRY와10/30초 후 새 attempt READY를 사용한다. 새 attempt는 새 coordinator/request/task/child/result/통합 근거가 필요하며 이전 record는 기존 history에 보존한다. 세 번째 실패는 기존 WAITING_HUMAN/failure bundle이고 네 번째 attempt는 없다. 현재·이전 cycle/attempt의 늦은 결과는 journal에 거절/좌표를 보존하며 현재 parent·writer·P12·gate·manifest를 해제하지 않는다. 이전 cycle의 이미 보존된 child record는 수정하지 않는다.

## 부모·자식·업무 단계 전이의 고정 oracle

Coordinator status는 RUNNING/WAITING_AGENT/WAITING_HUMAN/COMPLETED/FAILED를 사용하고 child status는 running 및 원본 소문자 result_status를 사용한다. job은 원본 상태 목록을 유지한다. 아래 job 열은 RECONCILING/격리가 없는 경우이며 해당 우선순위를 항상 보존한다.

| 수용 사건 | P12 이전→이후 | Coordinator 이후 | Child 이후 | job 이후/필수 후속 |
|---|---|---|---|---|
| p12_coordinator | RUNNING→RUNNING | RUNNING | 없음 | RUNNING |
| child_request 최초/답변재개 | RUNNING→RUNNING | RUNNING | 미할당, 이전질문실행은이력 | RUNNING·서버할당기다림 |
| child_assignment | RUNNING→WAITING_AGENT | WAITING_AGENT | running | RUNNING·child_execution_pending |
| child_result completed/failed/canceled/interrupted | WAITING_AGENT→WAITING_AGENT | WAITING_AGENT | 해당종료status | RUNNING·code-dev수집필요 |
| child_result needs_human | WAITING_AGENT→WAITING_AGENT | WAITING_AGENT | needs_human | WAITING_HUMAN·질문수집대기(아직task미배정) |
| child_collect completed | WAITING_AGENT→RUNNING | RUNNING | completed | RUNNING·통합필요 |
| child_collect failed | WAITING_AGENT→RUNNING | RUNNING | failed | RUNNING·infra복구필요 |
| child_collect needs_human | WAITING_AGENT→WAITING_HUMAN | WAITING_HUMAN | needs_human | WAITING_HUMAN·agent_question task |
| child_collect canceled/interrupted | WAITING_AGENT→WAITING_HUMAN | WAITING_HUMAN | 해당종료status | WAITING_HUMAN·agent_recovery task |
| child_answer 또는 child_recovery | WAITING_HUMAN→WAITING_HUMAN | WAITING_HUMAN | 원래종료status | WAITING_HUMAN·답변/복구근거기록만 |
| step READY (정확한답변/복구근거필수) | WAITING_HUMAN→READY | WAITING_HUMAN | 원래종료status | RUNNING·업무대기해제관측 |
| step RUNNING (같은근거유지) | READY→RUNNING | RUNNING | 원래종료status | RUNNING·질문이면resume request, 복구면infra_error 필요 |
| child_integrated conflict | RUNNING→RUNNING | RUNNING | completed | RUNNING·충돌수정필요, 성공금지 |
| child_integrated integrated | RUNNING→RUNNING | COMPLETED | completed | RUNNING·별도P12 SUCCEEDED필요 |
| step SUCCEEDED (전체guard통과) | RUNNING→SUCCEEDED | COMPLETED | completed | RUNNING·current=P13 |
| infra_error (허용된기술복구) | RUNNING→WAITING_RETRY 또는 cap WAITING_HUMAN | FAILED | 기존terminal/없음 | 원래10/30초/3attempt, writer현재작업재개없음 |
| retry (정확한deadline) | WAITING_RETRY→새attempt READY | 새record는없음 | 새record는없음 | RUNNING·ordinal1부터새근거, 이전실행history |

未할당 요청이나 running child가 있거나 이미 integrated receipt가 있으면 infra_error로 재시도하지 못한다. context만 있고 요청 전인 worker 시작 오류, completed 수집 뒤 통합 전의 coordinator 기술오류, failed 수집 후, 또는 사람승인된 canceled/interrupted만 기존 infra_error를 허용한다. human 질문 분기는 답변/checkpoint 기반 child_request resume이며 질문을 infrastructure failure로 바꾸지 않는다. 질문 또는 복구 task에 대한 정확한 human 근거만 WAITING_HUMAN→READY를 해제하며 generic human/agent 이벤트는 이를 만들지 못한다. parent FAILED는 기존 infra_error가 실제 수용된 경우만 기록한다.

P09 TC 기대값의 실제 contents/hash를 제품 수정 전에 고정·검사하는 OS/실행 증거는 B06에서 필요하다. 이번 context의 tc_design_artifact_id는 **이미 존재하는 합성 입력 참조**이고 실제 P09 파일 생성 시각이나 내용 검증 증거가 아니다. P12는 그 입력 ref/요구사항 버전 및 expectations_changed=false를 결속하며 실제 파일의 기대값 불변성을 검증했다고 주장하지 않는다.

## 기존50 이관·새9 시나리오·UI

`evidence/v2/children-baseline-50.json`은 commit b2d0aae의 50개 event/checkpoint SHA 및 기존 전체 event archive를 고정한다. 기존 SQE/routing/25개 baseline과 과거 수용 기록은 수정하지 않는다. 부모 증거가 없던 **옛 trace를 실제 실행 증거로 보강했다고 주장하지 않는다**. `mock:ifpmic:children:v1` 명시 버전의 새 합성 fixture를 만든다. 기존50 ID/순서/끝 상태/원래 events는 보존하되 도달한 비재사용 P12 RUNNING 직후 독립 authored source `mock:child-catalog`의 coordinator/request/assignment/result(completed)/collect/integrated 사건을 삽입한다. 기존 generic agent 결과에서 patch 또는 통합 증거를 계산하지 않는다. P12 미도달 prefix·SKIPPED/NO_CHANGE에는 삽입하지 않는다.

기존 checkpoint ID/제목/순서는 같고 같은 기존 사건 prefix를 가리키도록 cursor만 이동한다. 신규 source를 제거했을 때 **이관 전50 raw events/checkpoints SHA**가 정확히 복원되어야 한다. 과거 SQE/25/32/41 검사는 새child source만 먼저 제거한 원래 view로 유지한다. TC가 독립적인 삽입 개수·위치·필드·좌표·적용 여부 및 endpoint/checkpoint oracle를 작성한다. 과거 trace는 이전 버전 불완전 관측으로 보존하고 새 엄격 replay의 성공 근거로 재사용하지 않는다. manifest/journal/UI에서 합성 catalog 버전을 명시한다.

아래9개를 추가해 총59개로 한다. 모든 시나리오에 start/end를 포함하고 다음 checkpoint ID를 고정한다. 아래 checkpoint의 중간 상태·결과는 TC의 독립 literal oracle로 검사한다. 단순 END 일치만으로 수용하지 않는다.

| ID | checkpoint와 독립 기대 | 끝 상태 |
|---|---|---|
| agent-wait | requested: P12 RUNNING·요청만/child 없음; waiting: 할당 뒤 parent/step WAITING_AGENT·TC running; blocked: 다른 child result와 generic 성공 거절 | P12 WAITING_AGENT·job RUNNING·발행0 |
| agent-handoff | waiting; returned: TC completed이나 parent/step 대기; collected: parent/P12 RUNNING·아직 통합 없음; conflict: code-dev 충돌 기록·성공 차단; integrated: 통합 receipt 뒤 coordinator completed·P12 아직 RUNNING; passed: 별도 성공 뒤 P13 | END/COMPLETED·발행1 |
| agent-child-failure | failed: TC failed·부모 대기; collected: P12 RUNNING·성공 불가; backoff: infra retry10초; retried: 새a2 READY·과거a1보존; stale: 새a2에서a1결과 거절; recovered: 새parent/child/result/통합 후 P13 | END/COMPLETED·P12 a2·발행1 |
| agent-child-question | question: child needs_human; waiting-human: 수집 후 P12 WAITING_HUMAN·질문 task; rejected: 다른 질문/task 답변 거절; answered: 유효 답변/P12 대기 유지; resumed: 명시 READY/RUNNING→동일task·새request/ordinal2/child ID·WAITING_AGENT; integrated | END/COMPLETED·P12 a1·과거child 질문/답변 보존·발행1 |
| agent-child-retry-limit | backoff-one/attempt-two/backoff-two/attempt-three: 10/30초와fresh proof; capped: 세 번째 실패 수집/infra 뒤사람대기; blocked-four: retry 거절 | P12 a3·WAITING_HUMAN·failure bundle·발행0 |
| agent-child-stale-cycle | rerouted: 원본 P13 FAIL→cycle2/P11; waiting: cycle2/P12 새parent/child; stale: cycle1 결과 재전송 거절·현재불변; recovered: 새cycle2 결과/통합→P13 | cycle2 END/COMPLETED·재작업1·발행1·과거cycle1 보존 |
| agent-child-permissions | denied: 공유workspace/다른role/production path·해시변경/잘못된parent/request 거절; waiting; collected; integration-denied: TC의통합선언/production hash변경/기대값변경 거절; integrated | END/COMPLETED·발행1·허용된테스트패치만 |
| agent-child-interrupted | interrupted: child interrupted(업무실패아님); collected: 수집 후 P12 WAITING_HUMAN·복구task; denied-retry: 사람근거없는infra/retry와generic탈출거절 | P12 WAITING_HUMAN·recovery_required·발행0 |
| agent-child-canceled | canceled: child canceled이나job CANCELED아님; collected: P12 WAITING_HUMAN·복구task; recovery-approved: human retry근거/P12대기유지; backoff: 별도READY/RUNNING 후infra10초; retried: 새a2 READY; recovered: 새coordinator/child/result/통합 뒤P13 | END/COMPLETED·P12 a2·발행1·사람복구승인보존 |

UI의 `자식 TC 실행 모의 관측`은 현재 P12 coordinator/요청/child/수집/통합이 있으면 나타난다. P11 provenance·후보/요구사항/입력 ref, coordinator 목적/task/execution/role/status/workspace, child task/request/ordinal/execution/parent edge/role/status/격리workspace/scope, patch/changed path refs/결과/질문·checkpoint·human task/답변, 통합 outcome/receipt를 나눠 표시한다. coordinator와 child 상태는 P12 상태·job·품질 판정과 구분한다. 미할당 요청을 running child처럼 표시하지 않고 다른/추정 parent를 연결하지 않는다. 이력에는 원래 cycle/attempt/child ordinal과 parent 관계를 보존하고 현재 권한으로 승격하지 않는다. STEP selected detail와 history에 필요한 proof를 표시한다. 코드/patch/실제 경로·외부 링크는 표시하지 않고 opaque mock refs만 읽는다. 실제 요청·승인·실행 버튼은 추가하지 않는다.

기존 이력 펼치기/접기, scenario/reset/checkpoint/처음·이전·다음·끝/현재노드·검색/필터·키보드 탐색을 유지한다. 전체 V2와 실제 AT 미완료 표시를 유지하고 child 완료를 품질 PASS처럼 색/문구로 표시하지 않는다. 표시 계약은 다음과 같이 고정한다. summary region/testid=`ifpmic-child-observation`, accessible name=`자식 TC 실행 모의 관측`; data-coordinator-status/data-coordinator-execution-id/data-child-status/data-child-execution-id/data-request-ordinal/data-integration-status를 제공한다. 선택 상세는 `ifpmic-child-step-detail`, 과거 상세는 `ifpmic-child-history`이며 둘 다 data-step-id=P12, data-cycle/data-attempt/data-parent-execution-id/data-child-execution-id/data-ordinal/data-result-status로 원래 좌표를 제공한다. 원래 label은 `부모 coordinator`, `TC 자식 실행`, `통합 근거`, `쓰기 범위 · 합성 선언`, `질문 task`, `답변 근거`로 고정한다. `ifpmic-catalog-version`에는 mock:ifpmic:children:v1을 표시한다. 없는 근거는 '없음', 아직 할당되지 않은 실행은 '미할당', 과거는 '과거 · 현재 권한 아님'으로 표시한다. 모든 artifact/patch/path ref는 텍스트이며 href를 생성하지 않는다.

## 단계별 검증 계획

| 단계 | 검증 목적·대상 | 방법·담당 Agent | 합격 기준·예상 결과 | 증빙 | 실패 복구·재검증 |
|---|---|---|---|---|---|
| C0 | 원본 역할·P12 parent 수명·schema·이관·검증계획 | Luna 원본조사→main통합→senior_sol 좁은아키텍처조언→별도 reviewer 원본/계획/50baseline 검토 | 구현 전 승인; P11 재개0·TC생산코드0·호환무근거통과0; 실제권한/AT주장0 | 계획/50baseline/설계조언/review SHA | 모순은 원본·schema·계획으로 복귀해 재승인; 구현 먼저하지 않음 |
| C1 | 모든비재사용P12 강제·정상handoff·질문재개·실패 | TC 독립 literal unit: 요청만/할당/결과/수집/통합 순서, 각각 generic성공시도, child상태5개, 질문task/답변/새exec·충돌후회복 | 모든참조·역할·순서 일치; completed≠step/gatePASS; 거절업무projection불변; 정상 P13/최종완주 가능 | 전용TC/검사로그/current+history snapshot | 최초잘못된사건부터fixture/core/TC분리; 고정oracle 유지 후 정상/예외단계 재검증 |
| C2 | ID·scope·동시writer·stale·retry 경계 | TC: missing/null/extra/unknownrole, task/parent/job/cycle/attempt/候補/要求version/exec/ordinal/patch/ref/production hash변조, 시간정수/역행, source역행·dedup·ID재사용, 질문wronghuman/answer/checkpoint, integrationconflict, 10초/30초±1ms·3attempt/4차거절·fresh recovery | crossjob/cycle/child로현재해제0; production·기대값변경0; 미해결writer다중0; history/input불변·원래한도유지 | 부정/경계/retry journal·TC SHA | schema/역할/전이/버전 해당 C0~2 복귀, 신규소스면관련전체회귀 |
| C3 | 50개새버전이관+9시나리오+기존프로토콜 | TC 고정59 ID/endpoint/모든신규checkpoint, 원래50raw SHA복원·삽입literalcount/anchors/allapplied, 옛25/32/41/SQEbaseline 유지; 전체unit/build/plugin·원본검증 | 59 정확·원래업무경로/역할 변경0; 모든명령 exit0·unit fail/skip0; 원본17파일/ZIP/DOCX/실AT ledger불변 | migration ledger·catalog/version/journal/단위/build증거 | 처음불일치prefix부터 authoring/guard 수정; 원래baseline을변경해맞추지않고 전회귀재검증 |
| C4 | standalone+격리Paperclip UI·시각·AX 회귀 | TC 실제browser 전체59 endpoint/새9핵심checkpoint/current+history·부모edge/선택상세/reset·375/1440; main 기존11명령gate로source/dist/plugin/log/report고정 | 쓰기/API/외부/page/console오류0; 추정parent/과거현재승격0; overflow0; strict target/descendant hit16·모든viewport/clipancestor전체포함·fixedsticky교차0; compact200pxnegative정확 | browser JSON/PNG·source前後SHA·11gate | 현재/과거field·관계·capture clipping원인분리. 이전gate pass라도실제이미지불합격이면수용보류. source/TC변경시새11gate; capture-only보완은동일후보전후해시증명 |
| C5 | 독립 감사·요구사항·commit/push | 별도reviewer가소스/TC/gate/실제이미지/공개사본검토, main최종통합 | 전단계증거+독립수용후에만부분verified; goal전체완료아님 | review/progress/decisions/commit/push | 반려한 C0~4로돌아가복구후재검증; 실패이력보존 |

정상/예외/경계/회귀를 생략하지 않는다. 이관으로기존50과모든P12helper가영향받으므로 전체11명령이필수다. runner source snapshot에는 이계획·50baseline·독립plan review·설계조언을 포함하고 count59를 강제한다. generated observed_snapshot/journal은 관측 증거이며 TC의 독립 literal oracle을 대신하지 않는다. TC helper는 명시적인 독립 fixture를 작성하며 production child-enrichment/normalizer를 호출해 성공 근거나 기대값을 생성하지 않는다.

필수 캡처는 두환경각각 agent-wait.waiting(1440, P12+parent/child), agent-handoff.returned(1440, 아직대기)/integrated(1440), agent-child-question.waiting-human(375)/resumed(1440), agent-child-failure.retried와recovered(375, current+history분할가능), agent-child-permissions.integration-denied(1440), agent-child-stale-cycle.stale(1440,current+history), agent-child-retry-limit.capped(1440)이다. canceled/interrupted는 실제browser상태/복구필요문구검사로확인하고모든checkpoint×viewport PNG를요구하지않는다. 기존 SQE/예외/routing 필수화면회귀도유지한다. 긴상세는native history확장과실제viewport분할캡처로검증하며 DOM/CSS숨김으로통과시키지않는다. 기존별도host공지조정과GET-only routing mobile supplement는승인된좁은절차만유지한다.

## 다음 의존 단계와 잔여 위험

pause/resume/cancel은 원본 safe-boundary·resume_state/resume_step·revision/idempotency·in-flight/receipt/reconciliation에 따라 별도로 구현해야 한다. 특히 child 실행/질문/통합 중 제어 경합은 이번 안정적 task/exec/history binding에 의존한다. 이 child 계획이 제어 구현을 대체하지 않으며, 현재 raw pause/cancel 거절은 유지한다. 제어 계획과 원본 AT-25 경합·늦은remote receipt·장비lease조정은 다음 필수 V2 단계에 남는다.

이는 단계 생략 승인이 아니다. 이번 C0~C5 완료 후에도 전체 V2·실제 B01–B13·원본32 AT는 별도다. 실제 durable server assignment/outbox/restart/version pin·OS격리/patch 검사·승인runtime/profile/SSO/장비/최종배포와외부제출은 아직 증거가 없으며 완료로 표시하지 않는다. 기존 승인 없는 외부 전송은 하지 않는다. 실제 최종배포·외부제출은 승인 이후만 수행하며 git commit/push의상시승인은별도준수한다.

AT-29의 v1 worker가 v2 배포 이후 실제 pending task를 재개하는 시험과 AT-16의 durable outbox/재시작은 이 mock 증분에서 실행하지 않는다. 현재 canonical workflow signature 거절 회귀는 유지하지만 그것을 배포 후 version-pin 검증으로 치환하지 않는다. 실제 Temporal/서버가 없는 것이 기술적 이유이며 B03/B12 검증은 필수로 남는다. 잔여 위험은 배포 후 parent/checkpoint/child 재연결과 command 중복의 실제 정합성 미검증이다.
