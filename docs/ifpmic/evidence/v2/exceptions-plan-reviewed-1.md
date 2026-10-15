# V2 사양 질문 및 원격 결과 불명확 관측

REQ-02/05/08/10/12/14의 다음 증분이다. 원본 `workflow.v1.json`의 `P03.unresolved=WAITING_HUMAN`, `P25.unknown_remote_state=RECONCILING`, `state-contract.json`의 상태 인접표와 DOCX §7·§13 원격 조회·영수증 규칙을 따른다. 기존 업무 실패 route로 바꾸거나 cycle/attempt를 증가시키지 않는다. 구현 전 독립 계획 검토 후에만 개발한다. code-dev(주 에이전트)는 구현·통합, TC는 시험 작성, 별도 검토자는 계획·소스·시험·고정 후보 증거를 감사한다. SAM/TEM/SQE 업무는 변경하지 않는다. 모든 사건은 기존 mock 좌표·중복 제거·엄격한 필드 검사를 공유한다.

## 관측 계약

- `spec_unresolved`: 현재 RUNNING P03, 현재 후보, mock question_id/evidence_id 및 현재 requirements_version(초기 mock:requirements:v1)이 필요하다. RUNNING→WAITING_HUMAN을 검사하고 배정된 mock 사람 task와 질문을 보존한다. 현재 미해결 질문이 있으면 동일 ID든 새 ID든 추가 spec_unresolved를 거절한다. 현재 질문이 complete=true로 해결된 뒤에만 더 큰 새 ordinal과 한 번도 쓰지 않은 새 question_id를 열 수 있으며, 이때 이전 질문을 history에 보존한다. job WAITING_HUMAN. agent completed/일반 step 전이/infra retry/일반 human 제출은 질문을 해제하지 못한다.
- `spec_resolution`: 같은 현재 P03 WAITING_HUMAN, mock:human, 현재 question_id/task_id/plan_version(`mock:plan:v1`), 후보·기존 requirements_version, 이전에 사용하지 않은 새 mock resolved_requirements_version, complete=true, 새 mock evidence_id를 요구한다. 답변은 판단 증거의 합성 ID이며 원문·명령을 수집하지 않는다. WAITING_HUMAN→READY로 관측하고 답변 증거와 갱신한 요구사항 버전을 현재 질문에 resolved로 보존한다. 일부 답변(complete!=true)은 대기를 해제하지 않는다. task는 `mock:task:P03:c<cycle>:a<attempt>:q<ordinal>`로 배정하고 질문 ordinal을 증가시켜 이전 답변을 재사용하지 않는다. 이후 명시적 RUNNING, 아래 spec_reviewed, SUCCEEDED 사건이 모두 있어야 P04로 이동한다. 이전 질문·시도·후보·다른 task/actor 및 답변 전의 성공을 거절한다. 추가 질문은 새 question_id로만 열며 이전 질문을 history로 남긴다.
- `spec_reviewed`: 답변 후 RUNNING P03에서 mock:spec-gen, 현재 후보·갱신된 requirements_version 및 새 mock evidence_id가 필요하다. 해당 버전 재검토의 완료를 관측한다. 일반 agent completed는 이 증거를 대신하지 않는다. 답변 전·과거 버전·재검토 누락 성공은 거절한다.
- `remote_unknown`: 현재 RUNNING P25에서 현재 유효한 manifest/승인과 일치하는 manifest_id/digest/candidate_fingerprint, mock operation_key/evidence_id를 요구한다. operation_key는 원본 release_actions.idempotency_key에 대응하는 동일 원격 동작의 합성 식별자이며 새 제출 허가가 아니다. RUNNING→RECONCILING을 검사한다. cycle/attempt/영수증/승인은 보존하고 재제출·재시도를 만들지 않는다.
- `remote_reconcile`: 현재 RECONCILING P25, 같은 operation_key와 현재 manifest/승인 좌표, mock evidence_id, 양의 안전한 정수 query_seq 및 outcome(`found`, `unknown`, `absent`, `conflict`)를 요구한다. query_seq는 현재 operation의 서버 조회 순번을 모의한 값으로 직전 수용한 조회 순번(초기 0)보다 커야 한다. 다른 source_id라도 과거·동일 순번 응답을 거절한다. found는 동일 동작에 대한 새 권위 조회 결과를 뜻하며 mock receipt_id를 요구하고 확인된 현재 원격 결과를 재사용한다. RECONCILING→SUCCEEDED 및 P26 이동, publication_count=1을 관측한다. 기존 receipt가 있으면 동일해야 하며 다른 receipt를 덮어쓰지 않는다. unknown/absent/conflict는 receipt_id 없이 RECONCILING을 유지하고 조회 결과·사람 확인 필요 사유를 표시한다. 존재하지 않거나 충돌한다는 관측을 새 제출 허가로 해석하지 않는다. 후속 found는 같은 operation_key에만 적용한다. 늦은 agent 완료, 일반 receipt/step 성공, infra 재시도, 기존 실패 route는 조정 중 상태를 해제할 수 없다.
- 원격 관측은 실행 권한이 아니다. real_publish_allowed/reassign_allowed는 false다. 장비 격리가 함께 있으면 기존 RECONCILING 우선순위와 격리를 유지하고 이 원격 프로토콜로 장비 상태를 해제하지 않는다. 완료 후 늦은 원격 관측은 inactive_step으로 거절한다.

### 사건 payload 필드

기재한 필드 외 입력은 거절한다. 모든 식별자는 mock opaque ID이며 question/task/evidence 본문은 받지 않는다. 공통 실행 좌표는 기존 event envelope를 따른다.

| 유형 | 필드 |
|---|---|
| spec_unresolved | question_id, candidate_fingerprint, requirements_version, evidence_id |
| spec_resolution | actor, question_id, task_id, plan_version, candidate_fingerprint, requirements_version, resolved_requirements_version, complete, evidence_id |
| spec_reviewed | actor(mock:spec-gen), candidate_fingerprint, requirements_version, evidence_id |
| remote_unknown | manifest_id, digest, candidate_fingerprint, operation_key, evidence_id |
| remote_reconcile | manifest_id, digest, candidate_fingerprint, operation_key, evidence_id, query_seq, outcome, receipt_id(found에만 존재) |

## 검증 계획

| 단계 | 목적·대상 | 방법·담당 | 합격 기준·예상 결과 | 증빙·실패 복구 |
|---|---|---|---|---|
| E0 | 원본과 계약·검증 범위 일치 | 독립 검토자: 원본 JSON/DOCX와 이 문서 대조 | 요구사항·전이·승인 및 side effect 규칙 불일치 0, 구현 전 승인 | plan-review JSON과 문서 SHA. 불일치 시 문서부터 수정·재검토 |
| E1 | 정상·예외·경계 guard | TC: 독립 test 파일에서 고정 사건·상태 oracle. P03 답변 전후/반복 질문/새 요구사항 버전의 재검토 증거 누락·과거 버전/과거 actor·task·plan·candidate·execution, P25 unknown→found→P26→완료, unknown/absent/conflict→found, 누락·불일치 승인/digest/key/receipt, 중복·stale 및 source가 다른 순서 역전 원격 query_seq, 직전/동일 상태와 장비 격리 | 질문 답변 없이 진행 0, 원격 확인 없이 성공 0, 1회 영수증, cycle/attempt 불변, history·입력·snapshot 불변 | 단위 명령·로그·소스 SHA. 최초 오관측으로 돌아가 수정하고 관련 부정·정상 전체 재검증 |
| E2 | 기존 행동 회귀·빌드 | TC 실행, 주 에이전트 통합: npm test와 npm run build 및 npm run ifpmic:plugin:build, 25개 카탈로그 checkpoint/endpoint 기존 unit 포함 | 전체 test 실패·skip 0, 빌드 성공, 기존 계약·원본·실제 AT ledger 불변 | 고정 소스 전후 SHA 및 로그. 변경 영향이 replay 공통 guard이므로 전체 unit 필수. 실패 시 관련 프로토콜 수정 후 E1/E2 재수행 |
| E3 | 고정 후보 수용 | 별도 검토자: 소스·TC와 E1/E2 증거 감사, 주 에이전트 해시 재확인 | 검증 중 source drift 0, 구현자와 다른 검토자 승인 | review JSON/검증 보고서, 계획·후보 지문·요구사항 연결. 변경 발생 시 증거 폐기 후 재검증 |

이번 증분에는 화면·카탈로그를 변경하지 않아 host/browser gate는 생략한다. 근거는 새 사건이 기존 고정 25개 fixture에 없고 React/CSS/plugin 코드 변경이 없다는 것이다. 잔여 위험은 새 질문·조회 정보를 UI에 노출할 때의 표시·탐색 회귀이며, 후속 catalog/UI 증분에서 standalone/native host와 375/1440px 검증을 수행한다. 전체 V2 gate에서는 생략하지 않는다. 새 프로토콜을 등록하기 전까지 UI의 후속 범위 안내를 유지한다.

이는 부분 V2 프로토콜 수용이며 전체 V2, skip/manual/child/pause/cancel/no-change/P22 trial 또는 B01–B13·실제 AT 완료가 아니다. 실제 조회·제출·사람 task 서버·장비·인증을 호출하지 않으며 테스트 데이터는 합성이다. absent/conflict의 실제 복구·재제출 권한은 B11의 승인·충돌 처리로 남는다.
