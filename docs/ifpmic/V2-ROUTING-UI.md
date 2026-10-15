# V2 재사용·면제·무변경 화면 연결과 검증

REQ-01/02/03/04/05/06/10/12/14. 원본 계약과 독립 승인·검증된 V2-ROUTING.md의 합성 관측을 시각화한다. Paperclip은 원본 IFPMIC의 상위 관제 화면이며 원본 순서·승인·담당을 변경하지 않는다. code-dev(주 에이전트)가 구현·통합하고 TC는 독립 catalog/browser 테스트만 작성·실행하며 별도 검토자가 계획/소스/TC/증빙을 감사한다. 구현은 이 계획의 독립 승인 후 진행한다.

## 고정 시나리오와 독립 oracle

기존 32개 events/checkpoints는 `evidence/v2/routing-ui-baseline-32.json`의 SHA로 보존한다. 기존 25개 기준 파일도 덮어쓰지 않는다. 아래 9개를 더해 41개로 확장한다. checkpoint ID는 고정하며 start/end를 모두 포함한다. 노드 좌표는 기존 mock envelope를 따르고 ID는 mock:<scenario>:… 형식이다. snapshot을 읽어 성공 사건을 생성하지 않는다.

| ID | checkpoint·기대 관측 | 끝 관측 |
|---|---|---|
| routing-reuse | local: P03 확인만 존재/PENDING·전역 미승인; early: P03–P05 SKIPPED/X01 PENDING; confirmed: X01 SUCCEEDED/P06, 10개 재사용 범위; reused: P03–P12 모두 SKIPPED/P13 | 정상 네 PASS와 승인·영수증 뒤 END/COMPLETED·발행1 |
| routing-new-hw | early-blocked: P03 재사용 거절/PENDING; confirmed: P03–P05 실제 수행, X01 승인·P10만 재사용 목록; reused: P10 SKIPPED/P11, 동환경 근거 | P11 PENDING·발행0 |
| routing-exempt | confirmed: demo의 9개 POLICY/COUPLED 승인; paired: P15/P16 SKIPPED, P16 EXEMPT/complete=false; report-blocked: P22 SKIPPED/P23 RUNNING, 보고 없는 성공 거절; reported: SQE performed=false 보고 후 P23 SUCCEEDED/P24; exempt: P24 SKIPPED/X02, 네 EXEMPT | 네 EXEMPT를 manifest에 보존해 END/COMPLETED·발행1 |
| routing-pilot-denied | denied: pilot에서 P15/P16 승인 거절·X01 WAITING_HUMAN/미확정; confirmed: 면제 없는 정확한 승인; blocked: P15 skip 거절/PENDING | P15 PENDING·발행0 |
| routing-no-change | production: P11 별도 분석/재사용 뒤 P12 PENDING; analysed: P12 별도 TC 분석·종료 전; closed: 사람 확인 P12 SKIPPED/NO_CHANGE; terminal: current P12 사건 거절 | P12/NO_CHANGE·발행0, P13 이후 PENDING·manifest/receipt 없음 |
| routing-no-change-denied | production; analysed: P12 needs_changes=true; denied: 올바른 human 종료 제출도 거절 | P12 PENDING/RUNNING·no_change 없음·발행0 |
| routing-candidate | confirmed; changed: P13 RUNNING·후보 B, 과거 A 계획은 현재 권한 아님; blocked: P15에서 예전 면제 거절 | 새 후보 네 PASS로 END/COMPLETED·발행1 |
| routing-replan | rejected: X01 human 반려/FAILED; rerouted: cycle2/P02·old route_plan cycle1 이력; stale: 이전 plan_version 거절; replanned: 새 context/계획 버전, P03–P05 실제 수행 뒤 X01 승인 | cycle2/P06, required_revalidation 전체 suffix 유지·발행0·과거계획 history |
| routing-metadata | exempt; rejected: X03 명세 반려; retried: 같은 cycle X02 a2/PENDING, 네 EXEMPT 유지·기존 manifest/approval 없음 | 새 manifest/승인/receipt로 END/COMPLETED·발행1, X02/X03 a2·release_metadata history |

## 표시와 탐색 계약

- SKIPPED=생략, EXEMPT=정책 면제, NO_CHANGE=변경 없음 종료를 명시한다. 생략·면제는 PASS/SUCCEEDED/측정 완료로 표시하지 않는다. 실제 권한/AT는 항상 미실행이다.
- `재사용·면제 계획 모의 관측` region/testid `ifpmic-routing-observation`은 context가 있을 때 표시한다. data-plan-version/data-context-cycle/data-current-authority(true/false)를 제공한다. `계획 버전`, `프로파일`, `변경 유형`, `계획 원래 cycle`, `계획 후보`, `현재 권한`(유효/미확정·만료), `X01 승인 증거`, `재사용 범위`, `면제 범위`를 표시한다. 현재 권한은 context/confirmed의 현재 cycle·후보·요구사항 및 현재 X01 approval attempt/execution/SUCCEEDED를 모두 비교한다. 선행 local 확인은 global 승인으로 표시하지 않는다. context가 과거여도 원래 좌표를 보존하고 현재로 승격하지 않는다.
- 선택 단계 ObservationDetail은 skip_basis의 종류/actor/사유/baseline·입력/plan/profile/정책/원래 cycle·attempt·execution·후보/증거, 변경불필요 분석의 actor/해시/needs_changes/requirements_satisfied/증거, P23 미수행 보고를 각기 표시한다. 없는 필드는 ‘없음’이며 raw log/tool payload를 표시하지 않는다. gate_complete를 별도로 표시한다.
- `무변경 종료 모의 관측` region/testid `ifpmic-no-change-observation`은 no_change가 있을 때만 표시하고 사람 task/사유/생산·TC·계획 참조/원래좌표/발행0·후속 미실행을 보여준다. 분석만으로 종료 패널을 만들지 않는다.
- manifest의 `Gate 처분`은 P16/P18/P20/P24 각각 PASS/EXEMPT를 표시한다. 이력은 route_plan/route_plan_approval의 원래 버전/cycle/후보/승인 증거, 과거 step 분석/생략 근거와 release_metadata의 과거 처분을 현재와 구분한다. testid `ifpmic-routing-history`를 제공한다.
- 기존 처음/앞뒤/끝/checkpoint/현재 단계/필터·검색/키보드 탐색을 유지한다. 전환·처음 관측에서 이전 계획/종료/분석 패널을 초기화한다. 임의 payload 입력이나 실제 승인·실행·생략·종료 버튼은 추가하지 않는다.

## 검증 단계

| 단계 | 목적·대상 | 방법·담당 | 합격 기준·예상 결과 | 증빙·실패 복구 |
|---|---|---|---|---|
| RU0 | 원본·routing 프로토콜 충실도와 검증 계획 | 별도 reviewer가 계약/계획/32 baseline 대조 | 구현 전 독립 승인·담당/승인/경로 변경0 | 계획 SHA/review. 불일치 시 문서 수정과 재승인 |
| RU1 | 41 catalog와 모든 checkpoint의 정상/부정/경계/이력 | TC 고정 oracle unit: 32 SHA 보존, 9개 모든 checkpoint·mock좌표·예정된 거절 reason, snapshot/input 불변 | 모든 oracle 통과, EXEMPT/PASS 혼동0·NO_CHANGE 후 발행0·old 권한0 | TC/log/fixture·journal SHA. 첫 잘못된 사건부터 fixture 또는 프로토콜로 복귀 후 관련회귀 재검증 |
| RU2 | standalone offline 및 격리 Paperclip 실제 UI | TC browser: 전체41 끝 상태, 새9개 핵심 checkpoint·선택상세·history·시나리오전환/reset·현재단계 이동 | API 쓰기/외부요청/runtime오류0, 과거 권한을 유효로 표시0, 양쪽viewport overflow0/필드 접근가능 | browser JSON과 필수 화면. 소스/TC 원인 분리, 관련 checkpoint와 기존회귀 재수행 |
| RU3 | 원본·AX·V1·재생 회귀와 동일 후보 | 기존 verify-ifpmic-ui.mjs 11명령: 전체단위/build/plugin/원본/design validator/V1/host/catalog/replay offline+host/AX | 전부 exit0, 단위fail/skip0, source 전후 동일, 원본/AT상태 불변 | gate/log/source/build/plugin/report/capture SHA. 후보변경시 이전결과로수용하지않고 새gate |
| RU4 | 독립 증빙 감사·기록 | reviewer가 소스/TC/gate/캡처 동일성 확인, main 최종검토 | 증거 및 구현자와 다른 reviewer 승인 있어야 부분완료 | review/progress/decisions·commit/push. 반려시 해당단계부터 재검증 |

두 환경 각각 필수 캡처는 routing-reuse.local(1440), routing-exempt.exempt(1440/375, P24 선택상세 포함), routing-no-change.closed(1440/375), routing-candidate.blocked(1440), routing-replan.replanned(1440)이다. 모든 checkpoint는 unit에서 검사하고 browser는 위 흐름과 새9개 주요 상태를 검증하며 모든 checkpoint×viewport 캡처를 요구하지 않는다. 기존 질문/원격 필수 캡처도 유지한다. Host 공지는 V2-EXCEPTION-UI-CAPTURE.md의 승인된 읽기전용 캡처 절차를 유지하며 닫기 POST나 예외 허용을 추가하지 않는다.

RU3의 `scripts/verify-ifpmic-ui.mjs`는 catalog count=41을 강제하고 소스 snapshot에 이 계획(`docs/ifpmic/V2-ROUTING-UI.md`), `evidence/v2/routing-ui-baseline-32.json`, 독립 승인 기록 `evidence/v2/routing-ui-plan-review.json`, `V2-ROUTING.md` 및 routing 계획 승인 기록을 반드시 포함하여 gate 보고서에 SHA를 고정한다. 검증 도중 이 입력이 바뀌면 수용하지 않는다. catalog.json의 generated observed_snapshot은 관측 증거이며 TC는 별도 literal checkpoint/endpoint oracle을 작성한다.

단계 생략은 없다. 실제 정책 승인·장비·SSO/runtime/publisher/실제 AT는 이 합성 증분이 완료를 주장하는 대상이 아니며 B01–B13에서 계속 필요하다. 전체 V2 미완료를 유지한다. 잔여 manual/P22 trial/child-agent/pause-resume-cancel 및 전체 V2 검증을 축소하지 않는다.
