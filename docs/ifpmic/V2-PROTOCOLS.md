# V2 복귀·재시도·배포 관측 프로토콜

REQ-02/05/08/10/12/14의 다음 구현 증분이다. 상위 기준 `VERIFICATION.md`, `V2-SCENARIOS.md`와 원본 workflow/state 계약을 유지한다. code-dev는 구현, TC는 아래 정상·부정 시험, 독립 검토자는 소스와 증거를 담당한다. 실제 명령·타이머·장비·원격 제출은 실행하지 않는다.

모든 사건은 기존 공통 mock 좌표와 유형별 allowlist를 따른다. 신규 유형은 다음과 같다. 기록 좌표는 사건 직전의 현재 step/cycle/attempt/execution이다.

| 유형 | payload | 적용 조건과 결과 |
|---|---|---|
| business_failure | candidate_fingerprint, evidence_id | 원본 업무 실패 또는 노드 반려 경로가 있는 현재 단계에만 적용. 현재 후보와 mock 증거가 필요하며 system은 현재 완전한 FAIL 증거 ID, human은 현재 배정된 negative decision 증거 ID와 일치해야 한다. 코드 실패는 P13/P14에서만 관측한다. 원본 전이 RUNNING/WAITING_HUMAN→FAILED를 확인하고 실패 근거를 별도 보존한다. |
| route | outcome, target, candidate_fingerprint, evidence_id | 현재 FAILED 단계의 business_fail 또는 원본 특수 반려 결과. business_failure에서 기록한 현재 후보·실패 증거 ID가 정확히 일치해야 한다. system 업무 실패는 완전한 FAIL 측정, 사람 반려는 해당 WAITING_HUMAN에서 배정된 mock human의 명시적 negative decision이 선행되어야 한다. target은 원본과 정확히 같아야 한다. 업무 실패 7개와 노드 반려 5개만 복귀 대상으로 삼는다. 아래 metadata-only 예외를 제외한 복귀는 새 cycle을 만들며 이전 단계 전체를 history에 보존하고 현재 단계들을 PENDING으로 새로 생성한다. 현재 위치는 target이고 숨은 READY/RUNNING 실행은 만들지 않는다. target부터 END까지 required_revalidation에 기록한다. 초기 cycle=1/rework_count=0이고 추가 재작업은 cycle 2~4/rework_count 1~3이다. 3번째 재작업도 실패한 뒤의 추가 복귀 요청은 더 늘리지 않고 WAITING_HUMAN 및 failure_bundle을 남긴다. |
| infra_error | now_ms, operation | RUNNING 단계에만 적용. operation은 agent/build/metric/notes. 위험한 flash/remote_push/create_pr/create_tag/release_publish는 재시도 금지. 실패한 현재 attempt 1/2를 WAITING_RETRY로 관측하고 각각 now+10초/now+30초 retry_due_ms를 기록한다. attempt 3 오류는 WAITING_HUMAN이며 attempt 4는 없다. gate FAIL을 만들지 않는다. |
| retry | now_ms | WAITING_RETRY 및 due 시각 이후에만 새 attempt READY를 만든다. attempt 1 오류 후 due 시각에 attempt 2, attempt 2 오류 후 due 시각에 attempt 3을 생성한다. 이전 attempt WAITING_RETRY snapshot은 history에 그대로 남기고 새 record에서 PENDING→READY를 확인한다. execution_id는 mock:<step>:c<cycle>:a<new_attempt>다. 실패했던 기존 attempt를 READY로 덮어쓰지 않는다. attempt 4는 생성하지 않는다. clock은 안전한 정수이며 사건 간 역행하지 않는다. |
| candidate | candidate_fingerprint | 현재 RUNNING P13에서 고정한 새 mock 후보 관측. 동일 후보는 유지. 변경하면 이전 측정·manifest·승인을 무효화하며 후속 gate는 새 후보의 증거가 필요하다. 과거 증거는 history로 보존한다. |
| manifest | manifest_id, digest, candidate_fingerprint, rule_version, destination, notes_hash, evidence_bundle | RUNNING X02에서만 수신. 네 품질 gate P16/P18/P20/P24가 현재 cycle·후보·규칙의 완전한 PASS여야 한다. 모든 식별자는 mock opaque ID다. digest는 외부 실행기의 합성 관측 토큰이며 실제 SHA256 계산이나 실제 manifest 승인 주장이 아니다. 동일 digest 또는 manifest ID에 다른 내용을 붙일 수 없다. 새 관측은 이전 승인을 폐기한다. |
| approval | actor, task_id, plan_version, evidence_id, manifest_id, digest, candidate_fingerprint, decision | WAITING_HUMAN X03, mock:human, 현재 task/plan, approve 결정, 현 manifest digest와 후보가 모두 일치해야 한다. generic human 제출로 X03를 해제하지 않는다. |
| receipt | manifest_id, digest, candidate_fingerprint, receipt_id, observed | RUNNING P25에서 현재 승인과 manifest에 맞는 mock 원격 결과 관측. observed=true와 mock receipt ID 필요. 성공 기록은 1회만 허용하고 generic agent/step 성공으로 영수증을 만들 수 없다. P25가 SUCCEEDED 되면 publication_count=1로 고정한다. |
| notes_failure | evidence_id | RUNNING P26 및 이미 관측된 발행 1회. 원본 RUNNING→FAILED를 기록하고 job을 RELEASED_PENDING_NOTES로 유지한다. |
| notes_retry | evidence_id | FAILED P26 및 발행 1회인 경우에만 별도의 새 attempt를 생성하고 새 record의 PENDING→READY를 검사한다. 기존 FAILED→READY 전이를 허용하는 것이 아니다. 새 execution_id와 attempt를 사용한다. 이전 실패는 history 보존. P25와 기존 원격 영수증은 그대로 유지한다. 재시도 중에도 job은 RELEASED_PENDING_NOTES이며 P26 성공 때에만 COMPLETED가 된다. |

human payload에는 선택 필드 decision을 추가하며 생략 시 approve다. X01/P21은 reject 또는 design_change_needed를 명시한 human 제출을 근거로 business_failure 후 route하며, X03 반려는 `approval`의 decision이 원본 reject_code/reject_design/reject_release_metadata인 사건으로 기록한다. 그 다음 business_failure와 route(outcome=같은 decision)만 적용할 수 있다. negative decision은 human SUCCEEDED를 해제하지 않는다. 반려는 approved=false이며 발행을 허용하지 않는다. SQE는 P22 시험 실패 증거도 수집 완료로 관측하고 P23 보고를 거친 다음 P24 FAIL에 따라 복귀한다.

비노드 결과 P03.unresolved, P25.unknown_remote_state, P26.failure는 route로 허용하지 않는다. P26만 이 증분의 notes_failure/notes_retry로 처리하고 나머지 두 결과의 전용 프로토콜은 후속 작업으로 남는다. 이들 사건으로 cycle을 늘릴 수 없다.

manifest/approval/receipt도 event_id/source_id/source_seq/job_id/step_id/cycle/attempt/execution_id/mode 공통 좌표를 모두 검사한다. manifest snapshot은 X02 cycle/attempt/execution, 후보·규칙, 목적지·노트·증거 묶음과 gate 증거에 묶인다. approval은 X03 좌표와 현재 manifest_id/digest/candidate를, receipt는 P25 좌표와 동일한 manifest/approval을 확인한다. 일반 human 승인과 실제 제품 인증·서명 권한은 별개다.

기존 step 성공 guard도 확장한다. X02는 현재 manifest, X03는 현재 approve, P25는 일치하는 원격 영수증이 필요하다. system 성공은 현재 완전한 PASS가 필요하며 측정은 candidate/rule/cycle/attempt/execution으로 묶는다. step record에 cycle 및 gate 후보·규칙을 별도로 보존한다. real_publish_allowed와 reassign_allowed는 항상 false다. history는 이전 cycle/attempt의 동결 snapshot이며, 새 cycle로 실패 이력을 덮어쓰지 않는다.

TC는 정상 29단계 완주, 원본 업무 실패 7개와 반려 5개 target의 고정 oracle, SQE 보고 순서, cycle 추가 3회/초과, attempt 1~3 및 10초/30초 경계 -1/동일/+1, 잘못된 operation/clock, 과거 좌표·후보·규칙·digest 승인, manifest ID/digest 재사용, 영수증 누락·중복, notes-only 재시도와 history 불변을 검사한다. 독립 검토 및 고정 후보의 전체 단위/빌드 검증이 필수이며 실패하면 해당 프로토콜의 첫 잘못된 관측부터 복귀한다. 증거는 `evidence/v2/protocol-*.json`에 보존한다. 이 증분은 V2 전체 또는 실제 AT 완료가 아니며 skip/manual/agent-child/pause/cancel/no-change 및 카탈로그·UI·전체 host gate가 남는다.

고정 복귀 쌍은 업무 실패 출발 노드 7개 `(P13,P11), (P14,P11), (P16,P07), (P18,P11), (P20,P11), (P21,P11), (P24,P07)`이며 outcome은 business_fail이다. 노드 반려 쌍은 `X01.rejected→P02`, `P21.design_change_needed→P07`, `X03.reject_code→P11`, `X03.reject_design→P07`, `X03.reject_release_metadata→X02`다. 출발/결과/목표 어느 하나라도 다르면 거절한다.

human decision은 기본 approve 외에 X01의 reject(실패 outcome=rejected), P21의 reject(business_fail) 및 design_change_needed(동일 outcome)만 허용한다. 다른 human 단계의 negative decision은 허용하지 않는다. X03는 approval에서 approve 또는 reject_code/reject_design/reject_release_metadata만 허용하며 동일 값을 실패 outcome으로 고정한다. business_failure는 이 decision과 evidence_id 및 당시 candidate를 기록하고 route는 그 outcome과 evidence를 재확인한다. P21 reject 증거를 design_change_needed로 다시 해석할 수 없다.

## Metadata-only 복구 보완

부모 통합 검토와 별도 senior_sol 검토에서 `X03.reject_release_metadata→X02`를 새 cycle로 처리하면 이전 품질 gate가 모두 PENDING이 되고 X02 manifest가 그 gate들을 요구해 진행이 막히는 결함을 확인했다. 원본 workflow는 이 경로를 업무 실패와 별도의 특수 결과로 정의한다. DOCX §7은 인프라 attempt와 업무 cycle을 구분하고 §8은 이미 수행한 가정이 바뀐 계획에 새 cycle을 요구한다. 따라서 후보·품질 가정을 바꾸지 않는 metadata-only 복구를 다음의 제한된 모의 규칙으로 정한다. 이는 실제 B03/B11 정책을 확정하는 주장이 아니다.

- 현재 X03의 negative decision·실패 증거·정확한 target을 확인하는 기존 guard를 그대로 적용한다. 현재 네 quality gate가 해당 cycle/candidate/rule의 완전한 PASS여야 하며 발행 수는 0, 원격 영수증은 없어야 한다.
- cycle·candidate·rule과 quality gate record를 그대로 보존한다. 과거 cycle의 PASS를 현재 cycle로 복사하지 않는다. X02의 SUCCEEDED attempt와 X03의 FAILED attempt는 각각 immutable attempt history에 보존하고 기존 release snapshot도 history(kind=release_metadata)에 남긴다.
- X02/X03만 attempt+1의 새 PENDING record 및 execution_id로 교체한다. P25/P26의 미실행 PENDING record를 바꾸거나 숨은 실행을 만들지 않는다. 현재 위치는 X02, required_revalidation은 X02/X03/P25/P26이다. 현재 release material과 X03 submission은 폐기한다.
- 기존 rework_count 상한 3을 공동으로 유지하며 metadata 복구도 1회 사용한다. rework_count는 승인된 복귀 사건 수이며 metadata 예외에서는 cycle을 늘리지 않으므로 cycle−1과 항상 같지는 않다. 기본 업무 복귀만 있는 경우의 cycle 1~4와 재작업 3회 한도는 그대로다. 한도 초과는 WAITING_HUMAN+failure_bundle이며 어떤 기록도 새로 만들지 않는다. 별도 무제한 metadata budget을 도입하지 않는다.
- 새 X02 attempt의 binding이 다르므로 이전 manifest ID/digest는 재사용할 수 없다. 새 X03 attempt는 새 mock task ID가 필요하다. attempt 1은 기존 `mock:task:<step>:c<cycle>`, 이후 attempt는 `mock:task:<step>:c<cycle>:a<attempt>`로 식별한다. event execution/attempt와 task/evidence를 모두 검사한다. 이전 승인이나 일반 human 제출로 해제할 수 없다.
- TC는 metadata 반려부터 새 manifest·approval·단일 receipt·P26 COMPLETED까지 끝까지 검사한다. quality snapshot 불변, X02/X03 이력, 이전 좌표·토큰·task 승인 차단, 반복/혼합 복귀의 공동 3회 한도, metadata 이후 infra 재시도와 부작용 0도 검증한다. 단순 target 도착만으로 복구 성공을 판정하지 않는다.
