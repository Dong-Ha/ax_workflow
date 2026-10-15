# V2 질문·원격 조회 시나리오 및 화면 검증

REQ-02/05/08/10/12/14. 승인된 `V2-EXCEPTIONS.md`의 프로토콜을 화면에서 관측하도록 연결한다. 원본 workflow/state/agent 계약, 기존 V2 계획과 25개 시나리오를 유지한다. code-dev(주 에이전트)는 구현·통합, TC는 catalog/browser 검사를 작성하고 실행하며, 별도 검토자는 계획·소스·TC·고정 후보 증거를 감사한다. 구현 전 이 문서의 독립 승인을 받는다. 실제 질문 서버/장비/조회/배포/승인 API는 호출하지 않는다.

## 추가할 고정 시나리오

모든 항목은 기존 start/end checkpoint를 포함한다. ID와 아래 checkpoint ID·상태는 TC의 독립 oracle이며 현재 snapshot에서 기대값을 자동 도출하지 않는다. 기존 25개와 아래 7개를 합쳐 32개다.

| ID | checkpoint와 기대 관측 | 끝 관측 |
|---|---|---|
| spec-question-wait | question: P03 WAITING_HUMAN, q1/v1/미해결; blocked: agent completed와 일반 성공이 답변을 대신하지 못함 | P03 WAITING_HUMAN, cycle1/attempt1, 답변·검토 없음 |
| spec-question-resolution | question; answered: 같은 실행 READY, v2/해결됨/검토 없음; review-blocked: RUNNING에서 검토 없는 성공 거절; reviewed: 현재 실행 spec-gen 검토; continued: P04 이동 | P03 SUCCEEDED/P04, v2, 현재 검토 유효 |
| spec-question-retry | question; answered; reviewed-first: a1 검토; retry-wait: WAITING_RETRY; retried: a2 READY·답변 v2 보존; review-blocked: a2 RUNNING, a1 검토로 성공 차단; reviewed: 새 a2 검토; continued | P03 a2 SUCCEEDED/P04, 원래 질문·답변은 a1, 검토는 a2, 이전 검토 history |
| spec-question-repeat | question; answered; question-two: 새 q2/task ordinal2 WAITING_HUMAN·이전 q1 history; stale-answer: q1/task 답변 거절; answered-two: v3 READY; reviewed; continued | P04, 현재 q2/v3 검토 유효, q1/v2 이력 보존 |
| remote-uncertainty | unknown: 승인된 현재 명세 P25 RECONCILING/query0; queried-unknown: query1; absent: query2; conflict: query3; stale: 다른 source의 과거 query2 found 거절 | P25 RECONCILING/query3/conflict, 영수증 없음·발행0, 자동 재제출 없음 |
| remote-recovery | unknown; absent: query1; found: query2 동일 operation의 현재 영수증, P25 SUCCEEDED/P26·발행1; late: P25 늦은 결과 거절; completed: P26 성공 | END/COMPLETED, 영수증·발행1, cycle/attempt1 유지 |
| remote-device-quarantine | unknown; quarantined: 장비 unknown; idle: 새 idle에도 격리 유지; blocked: found로 장비/원격 조정 해제 불가 | P25 RECONCILING, 장비 격리 true, 원격 query0/unknown 유지·발행0 |

질문 ID는 `mock:question:<scenario>:q1/q2`, 요구사항 버전은 v1=`mock:requirements:v1`, v2=`mock:requirements:v2`, v3=`mock:requirements:v3`를 쓴다. task는 프로토콜이 정의한 cycle/attempt/question ordinal에 결속한다. 새 사건을 기존 snapshot으로 승인해 생성하지 않으며 fixture에는 합성 좌표·사건만 둔다.

## 화면 관측 계약

- 시나리오 수는 실제 catalog.length에서 표시한다. 질문·원격 결과 사건은 MOCK/실제 AT 미실행 표시를 유지한다. 시나리오 변경/처음 관측에서는 이전 질문·조회 패널과 증거를 남기지 않는다.
- 질문 패널은 현재 요구사항 버전, 질문/task, 원 질문의 cycle·attempt·execution, 답변 반영 버전/증거, 현재 P03 실행 좌표, 검토에 기록된 attempt/execution/증거를 구분한다. `reviewed=true` 하나로 현재 검토 통과를 표시하지 않는다. 현재 P03 attempt/execution 및 현재 요구사항 버전에 맞는 검토만 현재 유효다. retry a2 시점의 a1 검토는 이전 기록이며 현재 검토는 미완료로 표시한다.
- 이력 패널은 spec_question/spec_review_attempt에서 질문·task·원래 좌표·답변 버전·검토 좌표와 증거를 표시한다. 과거 질문/검토는 현재 패널의 판단을 해제하지 않는다.
- 원격 패널은 동일 operation_key, 현재 명세/digest/후보, query_seq/outcome 및 조회 증거를 표시한다. unknown/absent/conflict/stale 중에는 영수증·발행이 생기지 않는다. found 후에도 실제 제출 허용은 false이고 모의 발행 관측만 1이다. 장비 격리·로컬 활동·원격 결과를 별개로 표시하며 새 idle이나 found가 격리를 풀지 않는다.
- 사건/처음·이전·다음·끝/checkpoint/현재 단계 이동은 기존 탐색 동작을 유지한다. 실제 답변 제출·재조회·재제출 버튼이나 임의 payload 입력은 만들지 않는다.

### TC 관측 지점과 화면 증거

질문 region의 접근성 이름은 `사양 질문 모의 관측`, testid는 `ifpmic-spec-observation`이다. data-question-id, data-requirements-version(현재), data-question-attempt(원 질문), data-review-attempt(최근 기록 또는 빈 문자열), data-current-review(true/false)를 제공한다. 표시는 `요구사항 현재 버전`, `질문 ID`, `배정 task`, `질문 원래 실행`, `질문 증거`, `답변 반영 버전`, `답변 증거`, `현재 P03 실행`, `현재 실행 검토`(유효/미완료), `기록된 검토 실행`, `검토 증거`를 사용한다. 미존재 식별자는 ‘없음’이다. history의 각 spec 기록은 testid `ifpmic-spec-history`와 data-question-id, data-review-attempt를 제공하며 기존 ‘모의 과거 이력’ region 안에 표시한다.

원격 region은 `원격 결과 모의 관측`, testid는 `ifpmic-remote-observation`, data-operation-key/data-query-seq/data-outcome을 제공한다. `동작 key`, `명세 ID`, `digest`, `후보`, `P25 단계 상태`, `조회 순번`, `조회 결과`, `모의 영수증`, `실제 제출 허용` 및 ‘모의 원격 조회 기록’ ordered list에 수용된 순번·결과·증거 ID를 표시한다. stale checkpoint는 snapshot query3/conflict 유지뿐 아니라 사건 목록에 `stale_remote_query` 거절도 확인한다.

새 필수 캡처는 두 실행 환경(standalone offline 및 isolated Paperclip host) 각각 spec-question-retry.review-blocked(1440/375px), spec-question-repeat.end(1440px), remote-uncertainty.stale(1440/375px), remote-recovery.found(1440px)다. 모든 checkpoint의 snapshot은 단위 검사에서 검증한다. browser는 새 7개 흐름의 주요 상태·이력·이동·초기화와 기존 전체32 끝 상태를 확인하고, 위 대표 대기/조회 상태에서 양쪽 viewport의 overflow·필드 접근성을 확인한다. 모든 checkpoint의 양쪽 viewport 캡처를 요구하는 것이 아니다.

## 단계별 검증

| 단계 | 목적·대상 | 방법·담당 | 합격 기준·예상 결과 | 증거·실패 복구 |
|---|---|---|---|---|
| U0 | 원본 및 승인 프로토콜과 새 fixture/UI 기준 일치 | 별도 검토자의 문서·계약 대조 | 구현 전 계획 승인, 요구사항·업무 경계 불일치0 | 계획 SHA/review JSON. 발견 시 계획 수정부터 재검토 |
| U1 | 정상·예외·경계·이력 상태 | TC의 catalog 단위 검사: 기존25+신규7 ID/모든checkpoint/고정 oracle, 입력·snapshot 불변, mock·새 사건 적용/거절 | 32개 전체와 각 checkpoint 검증, a1 증거의 a2 통과0, 과거질문/과거query 차단, 발행0→1 및 격리 유지 | 단위 로그/fixture·journal 해시. 잘못된 첫 사건으로 돌아가 프로토콜 또는fixture 수정 후 관련 전체 재검증 |
| U2 | 실제 화면·접근성·반응형·부작용 | TC standalone offline 및 격리된 실제 Paperclip host browser. 새 패널·history·현재 단계·앞뒤/전환 초기화·375/1440px 및 기존32 endpoint | 모든 필수 browser check 통과, API 쓰기/외부요청/runtime오류0, 가로overflow0, 과거검토를현재유효로표시0 | browser JSON/주요 checkpoint 화면. 실패 시 원인에 맞는 U1/U2부터 회귀 포함 재검증 |
| U3 | 기존 AX 및 원본 회귀·후보 고정 | TC가 full UI runner 실행: npm test, build, plugin build, 원본자료검사/design validator, 기존 IFPMIC·host·AX browser, catalog evidence, 새 standalone/host replay | 명령 전부 exit0, test 실패·skip0, 원본·실제 AT 상태 불변, 소스 전후 hash 동일 | gate/logs/source·build/plugin SHA. 변경 중 결과는 폐기, 실패 기록 보존 후 영향 범위 재수행 |
| U4 | 독립 수용 및 기록 | 별도 검토자가 소스/TC/gate 동일성 및 증거 확인, 주 에이전트 최종 검증 | 구현자와 다른 검토자 승인 및 증거 없이는 완료 금지 | review JSON, progress/decisions/commit. 변경 시 고정 후보부터 다시 검증 |

기존 `verify-ifpmic-ui.mjs`를 32개 catalog와 이 계획/예외 계획·review 해시를 포함하도록 갱신한다. gate에서 단위 검사 skip0을 강제하고 명령 종료 로그 및 결과를 보존한다. 생략하는 검증 단계는 없다. 실제 장비/SSO/runtime/publisher/AT는 이 모의 증분의 검증 대상이 아니며 원래 B01–B13과 실제 인수 검증에서 계속 필요하다.

이 증분을 통과해도 V2 전체는 미완료다. skip/policy-exempt/manual-device/P22 trial/child-agent/pause-resume-cancel/no-change와 전체 V2 수용은 남아 있다. 신규 7개 화면 증거를 기존 25개만의 과거 수용 증거로 대체하지 않는다.
