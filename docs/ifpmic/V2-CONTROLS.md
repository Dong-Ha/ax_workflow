# V2 job 제어·안전 경계·부작용 관측 및 검증 계획

상태: **검토 전 초안**. 현재 작업 기록을 보존하기 위한 커밋이며 구현 승인이나 검증 통과를 뜻하지 않는다. bridge 결과의 상태별 nullable 필드·전이 조합 등 미확정 계약을 정리하고 K0 독립 검토를 완료한 뒤 구현한다.

REQ-02/05/06/08/10/11/12/13/14 및 원본 AT-03/05/14/16/17/20/24/25/26/27/29의 **합성 관측 모델**이다. Paperclip은 원본 IFPMIC 업무를 실행·관리·감독하는 상위 계층이다. 원본 29노드·역할·품질 판정·사람 승인·복귀 경로를 바꾸지 않는다. 실제 AT는 `not_executed`를 유지한다. code-dev(main)는 구현·통합, TC는 독립 테스트 작성·실행, 별도 reviewer는 계획·소스·증거를 검토한다. K0 독립 승인 전에 제품 구현을 시작하지 않는다.

## 원본·범위·구현 결정

`controls-source-collection.json`은 DOCX §7/10/11/12/14/15와 state/API/agent/bridge/data-model/AT/backlog 근거 및 코드 영향을 고정한다. DOCX §7은 진행 중 작업의 안전한 완료를 허용하면서 다음 단계 시작을 막고, 저장한 대기/단계로 재개하며, 취소 중 완료된 외부 결과를 보존하도록 한다. HTTP202는 접수이며 완료가 아니다. `expected_revision`·actor/route/key 멱등성·동일 key 다른 body 충돌·단일 workflow 권위를 유지한다. 장비 UNKNOWN/활성 lease 만료는 격리이며 즉시 재할당이 아니다.

두 Luna 조사→main 통합→senior_sol의 좁은 아키텍처 검토로 다음을 선택한다. 아래 세부 필드·집계·mock profile·revision 증가 정책은 **명시적인 관측 구현 확장**이며 원본에 완성된 schema가 있었다고 주장하지 않는다.

- job 제어 의도와 canonical step 상태를 분리한다. `control.phase`에 PAUSE_REQUESTED/PAUSED/CANCEL_REQUESTED/QUIESCENT/CANCELED를 표시한다. job enum에는 새 상태를 추가하지 않는다. 실행 중 RUNNING/WAITING_AGENT/WAITING_RETRY와 사람·장비 대기를 제어 latch 아래 그대로 보존한다. PAUSED→WAITING_AGENT/WAITING_RETRY/RUNNING 같은 없는 step edge를 만들지 않는다.
- 명령 적용 즉시 admission을 닫는다. pause는 이미 admitted된 현재 실행의 결과를 받지만 새 dispatch/assignment/integration/attempt/cycle/후속 단계 시작을 막는다. `current_step`의 다음 PENDING 단계 이동은 관측 bookkeeping이며 새 실행 허가가 아니다. 성공/실패한 step을 다시 열거나 최초 pause anchor로 되돌리지 않는다.
- cancel은 종료 확인이 아니다. 현재·기존 실행/부작용 ledger에 결과를 기록하며 step 성공·새 단계 진행으로 승격하지 않는다. 명시적 dispatch fence, pending 요청 drain, 모든 admitted 실행 종료, bridge/remote 조정·release 근거 뒤에만 job을 CANCELED로 표시한다. 결과 UNKNOWN/absent/conflict나 단순 device idle·lease 만료는 종료 근거가 아니다.
- uniform admission pause를 사용한다. pause 자체는 runtime interrupt/resume 호출이 아니다. 기존 needs_human checkpoint 재개와 canceled/interrupted의 human recovery는 유지한다. 종료된 실행을 재개한다면 새 attempt/execution 및 원래 전용 복구 근거가 필요하다. 일반 pause/resume만으로 attempt를 만들지 않는다. 실제 adapter checkpoint/start/resume/중단은 B03/B06 검증이 필요하다.
- control.retry는 기존 infrastructure retry와 **typed notes_failure로 확인된 P26 notes_retry**에 위임한다. 인프라 10/30초·총3attempt와 업무 rework3 한도를 유지한다. notes-only 정책에 원래 없던 인프라 cap을 추가하지 않는다. P25/품질 FAIL/미답변 질문/child recovery/격리를 retry로 우회하지 않는다.
- 실제 HTTP 쓰기 API·SSO/CSRF/outbox/Temporal/장비·publisher·agent 프로세스를 구현하거나 실행한 것으로 표시하지 않는다. 현재 AX provider 원본 로그/인증/설정은 읽기 전용이다. 화면은 관측 탐색만 제공한다. 실제 작업·최종 배포/외부 제출 승인을 이 합성 증분으로 대체하지 않는다.

## 사건 scope·식별·revision

기존 step envelope 11필드와 strict schema를 그대로 유지한다. 새 job 사건은 **정확히** `{event_id,source_id,source_seq,type,mode,job_id,payload}`다. step/cycle/attempt/execution 필드를 추가하면 거절한다. job 사건을 strict 공통 식별·mock mode·job binding 뒤, 활성 step 검사 앞에서 별도 처리한다. 가짜 JOB node를 추가하거나 일반 step 검사를 완화하지 않는다. END/최종 취소 뒤에도 command receipt·기존 실행 late fact를 검사할 수 있다. 일반 업무 사건은 기존 current step/cycle/attempt/execution 제한을 유지한다.

모든 shape는 추가/누락 필드 거절, ID는 mockId≤128·safeText 전후 동일, 숫자는 safe integer, 시간≥0/끝≥시작, sequence/fence는 양수다. enum은 아래 allowlist만 허용한다. actual path/shell/raw patch/stdout/stderr/추론/credential/free text를 받지 않는다. artifact/profile/authorization/CSRF/hash/reason은 합성 참조다. bridge hash도 실제 bytes 검증이 아닌 관측 토큰이다. 참조 배열은 중복 없이 정확한 집합이며 ID를 잘라 맞추지 않는다. 실제 권한은 입력 body의 actor로 결정할 수 없고, 여기 actor는 trusted synthetic transport metadata다.

`revision`은0에서 시작한다. 중앙의 고정 domain DTO 비교로 **수용된 domain transaction**이 달라졌을 때만1 증가한다. DTO는 underlying domain status/wait_reason, current_step/cycle/rework_count/candidate/requirements/rule, steps/history/release/device/spec/route/no_change/required_revalidation/failure_bundle, 제어 latch·실행/부작용 ledger를 포함한다. timeline/ignored/dedup 통계·revision 자체·inbox 접수/반려 상태는 제외한다. 성공적으로 적용된 새 command ID의 순서 기록은 domain transaction에 포함한다(동일 revision 두 effectful 명령의 단일 적용). 같은 command 재전달·접수·반려·동일 Agent telemetry/증거 no-op는 올리지 않는다. 비교 전후는 고정 필드 순서 JSON이며, prior DTO를 cache해 중복 직렬화를 줄인다. 거절 사건의 업무 projection 불변도 검증한다. 장기 trace의 비용을 K7에서 측정한다. 실제 DB/Temporal revision increment 정책을 입증하지 않는다.

`control_submitted`의 idempotency lookup은 현재 revision 검사보다 먼저 한다. scope=(actor,job_id,route,key). 같은 key/body는 기존 canonical command ID·receipt를 반환하고 새 명령/의도를 만들지 않는다. 관측에 다른 command ID가 붙으면 canonical alias 불일치로 거절한다. 같은 key/다른 body와 command ID 재결속은 충돌이다. body를 바꿔 재요청할 때는 새 key가 필요하다. `control_apply`에서 revision과 현재 상태를 원자적으로 검사하고 applied/rejected를 한 번 결정한다. step이 접수 후 이동하거나 완료되어도 조용히 inactive_step로 버리지 않고 command를 rejected로 보존한다. 이미 결정된 command 재전달은 같은 결과다. 새 command의 applied_revision은 실제 적용 뒤 revision이고 rejected는 null이다.

## 고정 사건 계약

아래는 구현 전 고정할 payload schema다. 표의 모든 필드는 필수다. `body`는 원본 Control의 정확한 `{expected_revision,action,reason}`이며 action=pause/resume/cancel/retry, reason은 mock ID다. 공통 evidence_id는 신규 관측 증거이며 이미 수용된 ID 재사용 금지다. original API body에 actor·시각·증거를 끼워 넣지 않는다.

| type | payload 필드 | 검증·의미 |
|---|---|---|
| control_submitted | command_id, actor, route, idempotency_key, authorization_ref, csrf_ref, body | actor=mock:human, route=mock:route:job-controls, authorization_ref=mock:authorization:owner-control:v1, csrf_ref=mock:csrf:validated:v1. body strict. accepted receipt만 기록하며 실제 durable ingress/CSRF/권한 검증 주장이 아니다. |
| control_apply | command_id, actor, observed_now_ms, evidence_id | actor=mock:system. 등록된 canonical command만. revision/eligibility를 검사해 applied/rejected를 도출한다. observed_now_ms는 mock 실행 관측이며 API caller 권한 필드가 아니다. applied intent≠안전 경계/종료 완료. |
| control_pause_ack | command_id, actor, fence_id, drained_request_ids, evidence_id | 현재 pause intent의 server dispatch fence 확인. actor=mock:system. 미할당 요청도 없던 일로 추정하지 않고 pending request ID의 정확한 drain 집합을 요구한다. PAUSED phase/admission 닫힘 유지. 현재 실행 완료를 요구하는 cancel barrier와 다르다. |
| control_execution_end | actor, control_command_id, kind, step_id, cycle, attempt, step_execution_id, agent_execution_id, status, prior_result_evidence_id, evidence_id | actor=mock:adapter, kind=logical/coordinator/child. intent 시 admitted된 정확한 실행만. 일반 step의 logical ID는 실제 runtime session 추정이 아니다. P12 coordinator/child는 기존 명시 ID. status=completed/failed/canceled/interrupted. child는 수용된 typed child_result와 status/evidence가 일치해야 한다. logical/coordinator의 prior_result_evidence_id는 null 또는 수용된 정확한 결과 ref. 실행 종료 확인만 기록하며 업무 성공/품질 판정 권한은 없다. |
| control_cancel_boundary | command_id, actor, fence_id, drained_request_ids, execution_result_ids, bridge_reconciliation_ids, bridge_release_ids, remote_terminal_ids, evidence_id | 현재 cancel intent. actor=mock:system. admitted 실행·pending dispatch·bridge·remote 전체를 빠짐/중복 없이 닫는 증거 집합 필요. QUIESCENT phase. RUNNING/WAITING_AGENT/PAUSE_REQUESTED이면 원본 edge로 CANCEL_REQUESTED를 기록한다. 다른 state는 유지한다. UNKNOWN/absent/conflict/active/미확인 lease는 금지. |
| control_cancel_complete | command_id, actor, boundary_evidence_id, evidence_id | 직전 유효한 quiescent barrier와 동일 집합/입력. 원본 CANCELED edge를 검사한다. 이미 SUCCEEDED/FAILED/SKIPPED는 그 상태를 보존한다(없는 edge 추가 금지). job 취소와 모든 step 취소를 동일시하지 않는다. control phase CANCELED·admission 영구 닫힘. |
| bridge_registered | actor, command, step_execution_id, candidate_fingerprint, requirements_version, evidence_id | actor=mock:bridge. command는 원본 bridge-contract.command_fields 정확한16필드. current P22의 실행/등록 device/bridge/profile 및 artifact ref에 결속하고 side effect/UNKNOWN **이전**에 등록한다. command_id는 원본 장비 명령 ID이며 새 중복 operation ID를 만들지 않는다. |
| bridge_observed | actor, command_id, lease_id, fencing_token, bridge_id, device_id, sequence, state, observed_mode, device_identity, exit_code, stdout_artifact_id, stderr_artifact_id, test_result_artifact_id, image_identity, started_at, finished_at, evidence_id | actor=mock:bridge. 알려진 command·lease·fence·등록 identity와 일치, per-command sequence 증가. 원본 command_states 7개만. opaque artifact ref만 받고 stdout 내용은 받지 않는다. terminal state도 자동 lease 해제/rollback/다음 단계 성공을 만들지 않는다. |
| bridge_reconciled | actor, command_id, lease_id, fencing_token, bridge_id, device_id, result_evidence_id, query_seq, safe_boundary, observed_mode, device_identity, os_lock_held, evidence_id | actor=mock:bridge. 정확한 수용 terminal result와 현재 command sequence, 등록된 mode/identity, safe_boundary=true·os_lock_held=true. typed identity가 UNKNOWN 이전부터 있었을 때만 해당 격리를 조정한다. 후발 임의 registration·일반 idle로 기존 unscoped 격리를 해제하지 않는다. |
| bridge_released | actor, command_id, lease_id, fencing_token, reconciliation_evidence_id, os_lock_released, lease_released, evidence_id | actor=mock:system. 수용 result+reconciliation 뒤 exact ref와 release=true 두 값 필요. mock lease release 관측이며 실제 OS/DB lock 보장이 아니다. reassign_allowed는 계속 false다. |
| remote_intent | actor, operation_key, manifest_id, digest, candidate_fingerprint, rule_version, destination, step_id, cycle, attempt, execution_id, evidence_id | actor=mock:publisher. 현재 RUNNING P25의 승인·manifest/gates/SQE 보고에 정확히 결속. 원격 효과/unknown 전에 등록, operation key 불변. 실제 publisher 호출이 아니다. |
| remote_observed | actor, operation_key, query_seq, outcome, manifest_id, digest, candidate_fingerprint, cycle, attempt, execution_id, receipt_id, evidence_id | actor=mock:publisher. 등록 intent/current 또는 archived binding 및 per-operation query_seq 증가. outcome=unknown/absent/conflict/found; found만 nonnull receipt. receipt 수락·publication 관측과 workflow 전이를 분리한다. 취소 중 수락은 P25 성공/P26 dispatch를 만들지 않는다. absent/conflict는 종료 아님. |
| remote_terminal | actor, operation_key, manifest_id, digest, candidate_fingerprint, cycle, attempt, execution_id, query_evidence_id, provider_state, receipt_id, safe_boundary, evidence_id | actor=mock:publisher. 알려진 intent·직전 수용 조회·safe_boundary=true. provider_state=completed/canceled_no_effect는 명시적 mock provider 종료 확인 확장이다. completed는 found의 동일 receipt, canceled_no_effect는 별도 provider 종료 관측이며 단순 absent로 도출하지 않는다. 실제 vendor가 이 보장을 준다고 주장하지 않는다. |

추가 고정 조건: `bridge_registered.command`의 job_id/step_id/cycle/attempt는 현재 P22, deadline은 mock safe-integer ms, fencing_token 양수, action은 flash_profile/run_sqe_profile만 지원한다. 각각 profile_ref=mock:bridge:flash / mock:bridge:sqe, profile_version=mock:bridge:profile:v1이고 SQE context의 device/bridge/image ref와 연결한다. 실제 profile partition/명령은 없다. observed_mode는 등록 mock mode adb/fastboot만, device_identity/image_identity는 등록 mapping·SQE image와 같아야 한다. command States QUEUED→ACKED→RUNNING, UNKNOWN→terminal 및 순서·동일 terminal 반복은 immutable history로 검사하며 terminal→RUNNING/다른 terminal 덮어쓰기는 금지한다. exit_code는 integer/null, refs는 mockId/null의 상태별 조합을 TC가 K0에서 확정해야 한다. 원본에 세부 result shape/state adjacency가 없는 부분은 해당 mock profile의 확장이다.

## Admission·집계·재개 oracle

`pause_anchor`는 적용 당시 step/cycle/attempt/step execution·candidate/requirements, admitted coordinator/child/bridge/remote 및 미할당 request 집합의 불변 snapshot이다. `resume_step/resume_state`는 수용된 현재 실행 결과 이후의 실제 frontier를 따라 갱신한다. underlying domain status/wait_reason를 별도 보존해 기존 reducer의 RUNNING 설정이 latch를 해제하지 않게 한다.

| 상태/사건 | 수용·차단 및 합격 oracle |
|---|---|
| accepted submission | command accepted만, revision/admission/step 변화 없음. API202 또는 accepted를 PAUSED/CANCELED 성공으로 표시하지 않음. |
| applied pause | phase PAUSE_REQUESTED·admission 즉시 닫힘. 동일 revision 효과ful 적용 하나. safe fence ack 뒤 PAUSED phase. job은 RECONCILING→실제 활성 사람/장비 대기→PAUSED 순서로 표시. phase/각 step/agent를 병렬 표시한다. |
| pause 중 기존 실행 결과 | anchor의 동일 execution·assignment에서 agent/child_result, 기존 human/child_answer/recovery/manual 결과·SQE report·measurement·실패·기존 receipt/query 관측만 수용. 원래 전용 guard 전부 유지. child_collect는 같은 결과의 순수 수집/질문 task 생성까지만 허용; integration/새 child request·assignment는 차단. 새 route/cycle/attempt·후속 step READY/RUNNING도 차단. |
| pause 중 현재 step SUCCEEDED/FAILED | 원래 success/failure 증거와 canonical edge를 검사. 결과/기존 proof 보존. SUCCEEDED이면 current_step만 다음 PENDING으로 이동하고 admission은 닫힌다. 최종 P26 성공이면 END+SUCCEEDED+PAUSED, resume 전 COMPLETED로 승격하지 않는다. |
| resume | PAUSED phase만, cancel/finalized/unknown을 제거하지 않음. 저장된 실제 frontier·동일 wait/attempt/task/lease/deadline을 복원하고 latch만 연다. human 답변/수동 결과로 frontier가 바뀌었다면 최초 anchor를 덮어 복구하지 않는다. END 성공이면 다시 실행 없이 COMPLETED. pause_request 미ack는 resume 부적격, cancel이 supersede 가능. |
| applied cancel | phase CANCEL_REQUESTED·신규 동작 차단. 실제 종료/안전 경계 확인 전 job RECONCILING. child/SQE/system/remote의 종료 fact는 immutable ledger로 수신하며 integration/step 성공·route·새 attempt/다음 단계는 금지한다. child canceled≠job CANCELED. |
| cancel barrier/finalize | 모든 admitted 실행 종료·pending 요청 drain·bridge safe result/reconcile/release·remote terminal 필요. barrier 후 legal step cancellation과 job CANCELED만. 원래 SUCCEEDED/FAILED/SKIPPED는 보존. lease/receipt/manifest/gates/증거 삭제0. |
| late 결과/영수증 | 알려진 현재/archived 실행 identity에 일치하는 신규 fact만 ledger/history에 기록. canceled step을 SUCCEEDED로 바꾸지 않는다. 과거 cycle fact는 현재 gate/manifest/publication을 해제하지 않는다. 동일 receipt 재수락 발행 증가0. 다른 receipt/유효 conflict는 기존 receipt 보존·RECONCILING으로 드러내며 admission은 영구 닫힘. |
| retry | admission 열림·격리/조정 없음. infrastructure WAITING_RETRY만 현재clock/10·30초/총3attempt 전용 retry에 위임. typed notes_failure가 현재 P26 FAILED+RELEASED_PENDING_NOTES에 결속됐을 때만 notes_retry로 새 P26 attempt. 일반 FAILED·publication1만으로 notes 권한 추정 금지. P25/업무실패/질문·recovery/4차는 거절. |
| terminal job commands | COMPLETED/NO_CHANGE는 변경 제어 거절. CANCELED에서 같은 cancel 재전달은 기존 receipt, 새 cancel은 effect 없는 적용 기록만; resume/pause/retry 금지. FAILED의 step 기록을 다시 열지 않으며 안전 확인 후 job cancel은 가능. |

Receipt의 실제 효과 관측·publication count와 P25/P26 단계 진행을 분리한다. 원래59의 raw events/모든 checkpoint/끝 상태는 유지한다. 구버전의 receipt 수락 후 SUCCEEDED 전 prefix에 있던 count0은 새 replay policy에서 receipt fact count1로 정정할 수 있으며, 영향 prefix와 예상값을 TC가 명시적으로 기록한다. 과거 archive/수용 기록을 수정하거나 새 버전으로 소급 검증했다고 주장하지 않는다.

## 카탈로그74·고정 checkpoint·표시 계약

`controls-baseline-59.json`은 d0cd05f의59 ID 순서/events/checkpoint SHA·전체 과거 trace를 고정한다. 기존 source proof 제거 또는 새 insertion은 없다. 새 replay policy/catalog version은 mock:ifpmic:controls:v1, 과거59는 version mapping만 명시하고 원래 사건과 checkpoint cursor를 유지한다. 15개를 뒤에 추가해 총74개다. start/end 공통이며 아래 checkpoint ID/뜻/끝값은 독립 literal oracle다.

| 새 ID | checkpoint ID와 고정 기대 | 끝 |
|---|---|---|
| control-command-lifecycle | accepted: receipt만/신규실행허가유지; requested: 적용 뒤신규허가닫힘; paused: fence ack; resumed: latch해제/원래frontier | END/COMPLETED/pub1 |
| control-command-conflicts | accepted: 동일revision두접수; applied-one: 하나적용; rejected-two: revision충돌; duplicate: 같은canonicalreceipt; body-conflict: key충돌/기존보존 | P07 WAITING_HUMAN·control PAUSED/pub0 |
| control-apply-after-progress | submitted: P01실행중접수; advanced: P02PENDING로진행; rejected: stale revision command거절/현재불변 | P02/RUNNING/pub0 |
| pause-human | paused: P07원래task유지/사람대기우선; submitted: 배정human근거수락; finished: P08PENDING·jobPAUSED; resumed | END/COMPLETED/pub1 |
| pause-child | paused: P12WAITING_AGENT; returned: TC결과보존; collected: 부모RUNNING/P12RUNNING이나jobPAUSED; blocked: 통합·새자식차단; resumed: 기존결과통합가능 | END/COMPLETED/pub1 |
| pause-manual-sqe | paused: P22manual task유지; submitted: 기존결과수락/P22READY; blocked: RUNNING차단; resumed: 같은attempt/기존manual근거 | END/COMPLETED/pub1 |
| pause-device-wait | paused: P22WAITING_DEVICE유지; resumed: 동일wait·attempt·lease/재할당false | P22/WAITING_DEVICE/pub0 |
| pause-retry | paused: P13WAITING_RETRY/기존due; due-blocked: deadline후에도attempt증가0; resumed: 원래wait; retried: controlretry로a2READY·a1history | END/COMPLETED/P13a2/pub1 |
| pause-final | paused: P26현재실행; finished: P26SUCCEEDED·END·jobPAUSED/pub1; resumed: 재실행없이완료 | END/COMPLETED/pub1 |
| cancel-child | requested: P12기존child실행/RECONCILING; returned: patch결과만보존; blocked: 통합/성공금지; quiescent: child/parent종료+fence; canceled | P12/CANCELED/pub0·patch보존 |
| cancel-flash-unknown | registered: 정확command/lease/fence; unknown: 격리; requested: 취소의도/종료아님; rejected: 잘못된identity·idle·earlyboundary차단; reconciled: 정확terminal/safequery; released: lock/lease근거; canceled | P22/CANCELED/pub0·reassignfalse |
| cancel-remote-late-receipt | intent: 현재manifest/operation; requested: 취소중unknown; receipt: 동일op효과만count1/P26시작0; quiescent; canceled; late: 알려진동일receipt이력만/step불변 | P25/CANCELED/pub1·P26PENDING |
| cancel-pending-dispatch | pending: P12요청만/exec없음; requested; blocked: assignment·무drain종료차단; drained: dispatcher미전송/회수근거; canceled | P12/CANCELED/pub0·가짜child없음 |
| cancel-released-notes | failed: 실제typednotes_failure/pub1; requested; canceled: P26FAILED보존; blocked: retry/P25재제출금지 | P26FAILED·jobCANCELED/pub1 |
| control-notes-retry | failed: typednotes_failure; accepted: 재시도접수만; retried: 전용guard로P26a2READY·receipt동일; completed | END/COMPLETED/P26a2/pub1 |

UI는 모의 ‘명령 접수·적용’, ‘제어·대기 복원’, ‘실행·부작용’ 관측을 별도 section으로 표시한다. summary testid=ifpmic-control-observation, accessible name=작업 제어 모의 관측. data-phase/admission/revision/resume-step/resume-state/command-status 제공. 상세 3개 testid=ifpmic-control-command/ifpmic-control-frontier/ifpmic-control-effects. 원래 step/agent/child/gate·현재/과거 identity와 control.phase를 구분한다. accepted/applied/requested/quiescent/finished를 동의어로 표시하지 않는다. 취소된 작업의 기존 사람/자식/SQE task는 근거로 보존하되 신규 권한이 없음을 표시한다. unknown/absent/EXEMPT/품질FAIL/오류/취소를 혼합하지 않는다. artifact/lease/fence/profile/영수증은 opaque mock ref 텍스트이며 href/실행버튼은 없다. 기존graph29/6단계·이력펼치기·선택/검색/필터·키보드·현재단계·모든재생컨트롤을 유지한다.

## 검증 단계와 복구

| 단계 | 검증 목적·대상 | 방법·담당 Agent | 합격 기준·예상 결과 | 증빙 자료 | 실패 복구·재검증 |
|---|---|---|---|---|---|
| K0 | 원본/아키텍처/strict schema/집계/원래59/검증계획 | 두Luna 근거·TC영향도→main계획→senior좁은조언→독립reviewer+TC사전검토 | 구현전승인, 없는step/jobedge0, 모든필드/nullable/state관계고정, 전체목표축소0 | source collection/architecture advice/59baseline/plan/review SHA | 미정은원본/계획으로복귀해고정후재승인, 구현먼저금지 |
| K1 | job scope·접수/적용·revision·멱등성 | TC독립literal fixture, samekey/body·다른body/actor/route/CSRF/extra/missing/null, apply전진행/END, 동일revision경합 | accepted≠applied, 하나의효과ful적용, durable조회형receipt보존, 무권한/원래stepbinding완화0 | unit/command journal/중복·거절/DTO before-after | command schema/dispatch/revision원인분리, 최초오류prefix부터재시험 |
| K2 | pause/admission/집계/resume·현재결과 | TC각wait/run/final, child질문/collection, manualSQE, READY차단, due경계, state모든원본edge | 원래wait/task/attempt/deadline보존, in-flight완료허용·다음실행0, END시PAUSED→resumeCOMPLETED, 질문복구우회0 | current/history/control snapshots·정상/부정 unit | latch/underlying집계/원래protocol해당단계복귀후전체영향회귀 |
| K3 | cancel·fence·장비/원격identity·latefact | TCchild/parent/pending요청, bridge全shape/state/seq/lease/fence/identity, remoteintent/query/receipt/terminal, late현재/과거cycle | 조기CANCELED0, UNKNOWN/absent로종료0, 동일동작재실행0, canonicaledge위반0, receipt/기존SUC/FAILED삭제0, canceledstep성공승격0 | ledger/조정·lease/ref journal/부정경계/이미지 | 잘못된identity/권한/종료판정지점복귀; raw원시출력사용금지; 실제장비실패는사람절차 |
| K4 | retry·source/time/ID·불변성 경계 | TC10/30초±1ms·3/4attempt, notes typed/generic비교, missing/null/extra全13type·nullable조합, ID128/129/재사용·unsafe time/seq·alias/watermark·replay결정성 | 원래한도/notes정책유지, rejected業務DTO불변·history/inputdeepfreeze, actualAPI/private/raw자료0 | 독립TC·실패이력·sourceSHA | 기준완화대신schema/전용guard/DTO 비교를수정, 새후보관련전체회귀 |
| K5 |59byte보존+새15全checkpoint/end+legacy | TC고정74IDs/고정cp/table literal, 원래59events/cp/order/archiveSHA, receipt-prefix정책차이기록, 전체unit/build/plugin·원본17/ZIP/DOCX | 이전baseline수정0·74정확, 원본업무경로/역할/승인불변, 단위fail/skip0 | catalog/version/journal·정책차이ledger·unit/build | 첫불일치prefix부터productfixture/TC분리, 과거baseline변경금지 |
| K6 | standalone/nativePaperclip 실제관측·시각·접근 | TC두환경74끝+15핵심cp/typedwait·history;375/1440, semantic group분할캡처;main실제PNG검토 | 외부/쓰기/console/page오류0, pageoverflow0, target全bbox viewport+모든clipancestor포함, 4×4 target/descendant hit·fixed/sticky overlap0; compact200px負例유지 | browserJSON/PNG/geometry・이력펼치기/필터/키보드회귀 | 실제이미지불합격이면gatepass라도보류, DOM/CSS숨김해결금지, 원본이미지보존후원인복귀 |
| K7 | 전체영향·성능·고정후보 | main기존11명령gate, TC고정긴trace/최대재작업시나리오의duration/이벤트수기록; 전체source/dist/plugin/log/report전후해시 | 모든11명령exit0·unit全pass/skip0·각명령120s이내, 반복동일snapshot, 新plan/baseline/review/advice source pin과74count, 원본AT불변 | gateJSON11logs/sourcefingerprint/perf report/공개사본SHA | timeout/부하/source변경은진단보존, 의미변경없이원인분석·필요시serializer최적화후새전체gate |
| K8 | 독립증거감사·요구사항·commit/push | 별도reviewer가source/TC/gate/실제PNG/공개사본감사,main통합 | 전단계실증+독립수용후에만부분verified·commit/push, 전체V2/실AT완료아님 | review/decisions/검증기록/commit·push | 반려한K0~7단계복귀후재승인/재검증, 반려/중단증거보존 |

필수 캡처는 두환경 각각 command lifecycle accepted/applied/paused(1440), pause-human finished/resumed(375), pause-child returned/collected/blocked(1440), pause-manual-sqe submitted/blocked(375), pause-retry due-blocked/retried(history포함,375), pause-final finished/resumed(1440), cancel-child returned/canceled(1440), cancel-flash-unknown unknown/rejected/released/canceled(1440), cancel-remote-late-receipt receipt/canceled/late(375), cancel-pending-dispatch blocked/drained(1440), cancel-released-notes canceled 및 control-notes-retry retried(1440)다. 각 긴상세는세semanticgroup 분할, 고정header와clipancestor검사유지. 나머지cp도unit전체+실browserstate로확인하고 모든cp×viewport PNG를 요구하지않는 기술근거는중복상태/형식회귀이며 실제시각증거대체주장은하지않는다. 기존SQE/child/routing/예외와V0/V1/AX회귀는전부유지한다. 기존GET-only375 P24 capture supplement는같은고정후보·한값gate pin변경독립검토·소스전후SHA불변절차만유지한다.

## 잔여 의존성과 완료 범위

단계 생략 승인이 아니다. 이관은없지만 job-scope dispatch/전역revision/집계가모든reducer에영향을주므로 K1–K8과전체11gate는필수다. 실제 ingress권한/CSRF·DB+outbox원자성·Temporal재전달/동시성·runtime checkpoint/interrupt・bridge등록/OSlock/fencing/journal・remoteprovider종료·실제장비/품질/배포는 B01–B13/원본32AT의필수후속이다. mock source順序·replay/redelivery TC를 AT-16 durability 또는 AT-27 실제서버동시성 증거로 표시하지 않는다. 잠금해제와 vendor종료근거의진실성은 reducer검사로입증되지않으며 실환경프로파일과사람승인/수용이필요하다. 실제AT ledger/status와원본계약은변경하지않는다. Git commit/push는상시승인을준수하되실제최종배포·외부제출·기밀전송승인으로해석하지않는다.
