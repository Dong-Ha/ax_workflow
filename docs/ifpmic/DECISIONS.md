# IFPMIC 구현 결정과 검증 이력

각 결정은 원본 IFPMIC 계약을 유지하면서 구현·검증 방법을 구체화한다. 제품 업무 승인과 개발 단계의 기계적 검증 판정은 별도로 기록한다.

| 결정 | 요구사항 | 선택과 근거 | 검증 및 잔여 범위 |
|---|---|---|---|
| D01 검증 계획을 구현 선행 조건으로 적용 | REQ-01–15, 사용자 Goal | 계획 작성자, code-dev 구현자, 독립 검토자를 분리했다. V0–V2 및 B01–B13의 목적·방법·담당·기준·증거·복귀를 먼저 정의한다. | `evidence/plan-review.json`. V단계 승인으로 실제 AT·업무 승인·배포를 승인하지 않는다. |
| D02 Paperclip 전용 page 플러그인 사용 | REQ-12 | 고정 설치 버전 2026.1005.0의 공식 page slot으로 React 컴포넌트를 실제 host 안에 장착한다. V1 capability는 `ui.page.register`만 사용한다. | 실제 host route의 29노드·41전이·CSS·필터·모바일 검증. 실행·제어 연결은 V2/B단계 후속 작업이다. |
| D03 원본 계약을 실행 서비스와 분리 | REQ-02,05,06,10,14 | 그래프는 P/X ID와 담당·입출력·통과조건·생략정책·전이만 투영한다. END와 비노드 특수 결과 3개는 각각 별도 표현한다. | 고정 oracle unit 및 browser 검증. 정적 그래프의 정상 전이는 실제 step 성공을 의미하지 않는다. |
| D04 원본 요구사항 참조만 표시 | REQ-01,02,03,04,05,06,09,10,12 | 독립 리뷰에서 역할 기반 추정 연결을 제거했다. 원본 requirements의 design에 직접 적힌 ID/범위만 ‘원본 요구사항 참조’로 표시한다. | P19에 REQ-03을 추가하지 않고 X02는 미등록으로 표시하는 회귀검사. 실제 job·코드·TC·증거 trace는 B단계에서 구성한다. |
| D05 별도 로컬 검증 인스턴스 사용 | REQ-11,13 | 기존 실험의 회사·기록·설정을 변경하지 않고 `ifpmic-verification-data`를 사용한다. telemetry와 update check를 프로세스 환경으로 끄며 모델을 설정하지 않는다. | host test는 버전·local_trusted·데이터 경로 확인 후 합성 회사/로컬 플러그인만 준비한다. 실제 issue/agent가 0개임을 검사한다. |
| D06 검증 도구도 외부 요청을 제한 | REQ-11 | host URL은 loopback HTTP origin만 허용하고 자격증명·경로·query·fragment를 거절한다. API redirect를 거절하고 browser의 외부 요청을 차단한다. | 잘못된 URL 6종을 fetch trap으로 검사하고 host/browser의 외부 요청·쓰기·runtime 오류를 기록한다. |
| D07 소스 고정 후보에 검증 증거 귀속 | REQ-02,10,12,14 | 모든 필수 명령의 종료 코드와 소스/원본/빌드/plugin 해시를 저장한다. 실행 중 소스 변경은 테스트가 통과해도 후보 수락을 거절한다. | `npm run ifpmic:verify:v1`. 제품·시험·설계 기준 변경 시 새 후보 전체 gate를 수행한다. |
| D08 제공 바이너리와 일반 회귀 분리 | REQ-01 | 일반 `npm test`는 커밋된 참조 파일 17개의 해시를 검사한다. 제공 ZIP·DOCX 바이트 검사는 별도 필수 V0 runner로 수행한다. | 원본 없는 checkout의 일반 테스트 가용성을 유지한다. V0 후보 수락은 원본 검사까지 통과해야 하며 검사 생략으로 처리하지 않는다. |

## V1 실패 분석과 재검증

| 항목 | 원인 및 분류 | 조치 | 재검증 |
|---|---|---|---|
| 초기 browser assertion 불일치 | 초기 선택 P01 및 방향키 순환에 대한 TC 기대값 오류, 이전 빌드 사용 | TC가 원래 계약에 맞게 oracle을 바로잡고 최신 후보를 빌드했다. 기대 기능이나 합격 기준을 완화하지 않았다. | 초기 attempt 보고서를 보존하고 새 빌드의 전체 browser 세트를 수행한다. |
| host 첫 마운트 직후 노드 0개 관측 | plugin 비동기 mount 완료 전 assertion을 수행한 TC 동기화 오류 | 명시적으로 첫 card 준비를 기다리도록 수정했다. | 같은 합성 회사를 재사용해 host 전체 세트를 수행한다. |
| 추정 요구사항 연결과 전이 라벨 | 제품 표현 결함 | D04의 직접 참조로 제한하고 41개를 정상·실패·반려 전체 전이로 표시했다. | 직접 참조 oracle과 상세·전이 browser 회귀를 수행한다. |
| URL 입력·redirect 제한 누락 | 검증 도구의 환경 경계 결함 | D06의 URL guard, timeout, redirect 거절과 부정 테스트를 추가했다. | 단위 전체와 실제 host 검증을 다시 수행한다. |
| 검증 중 소스 변경으로 후보 거절 | 첫 후보 검증 중 위 보완을 수행해 source fingerprint 변경 | 변경된 후보를 이전 테스트 결과로 수락하지 않고 새 gate를 수행한다. | 실패 gate를 보존하고 최종 source hash가 동일한 실행만 수락한다. |

실패한 attempt를 삭제하거나 최종 통과 결과로 덮어써 완료 근거를 만들지 않는다. 원본 실행 기록은 Git에서 제외된 `workflow-artifacts/verification/`에 남기고, 커밋에는 합성 검증 결과와 출처 해시를 담은 검토 가능한 증빙을 보존한다. 실제 내부 로그·자격증명은 커밋하지 않는다.

## V2 첫 재생 증분의 검토와 복귀

- REQ-02/05/08/10/12/14: 우선 읽기 전용 관측·좌표·근거 검사를 구현한다. 전체 시나리오와 UI를 완료 처리하지 않으며, 미지원 skip/control/배포는 거절한다. 담당과 잔여 범위는 `V2-IMPLEMENTATION.md`에 기록한다.
- TC 초안의 PENDING→RUNNING 사건은 원본의 READY 경계를 생략했다. fixture에 READY 관측을 추가했고 실제 전이 기준은 완화하지 않았다. 미등록 필드 수락과 자유 형식 type 출력은 제품 결함으로 수정했다.
- 첫 고정 후보는 전체 180개 테스트와 build가 통과했으나 독립 검토에서 source sequence 역행, telemetry에 의한 격리 표시 해제, 미지원 reconciliation 제어 수락, 자유 형식 식별자 출력 문제가 발견되어 수락을 보류했다. 해당 후보와 반려 사유는 `evidence/v2/core-attempt-1.json`에 보존한다.
- 수정은 원본 업무 규칙으로 복귀해 수행한다. source watermark와 clock 역행 거절, 격리 latch, 전용 프로토콜 없는 RECONCILING 거절, 제한된 ID 문법을 추가하고 TC가 각각의 재현 시험을 작성한다. source/candidate가 바뀌므로 이전 통과 결과를 새 후보의 증거로 사용하지 않는다.
- 장비 연결 상태와 활동 상태를 구분해 보존한다. 시간은 안전한 정수 밀리초로 제한하고 장비 재할당 및 실제 제출 권한은 항상 false로 유지한다. 이는 실제 장비·사람 승인·배포 증거가 아니다.
- 두 번째 후보도 전체 186개 테스트와 build는 통과했지만, 독립 검토가 workflow 담당·경로 변조와 거절된 높은 sequence에 의한 watermark 오염을 발견해 보류했다. `evidence/v2/core-attempt-2.json`에 보존한다. workflow의 원본 서명을 고정하고 성공적으로 적용한 사건만 watermark를 높이도록 수정했다. 별도 재현 TC 후 소스 독립 검토가 부분 core만 승인했으며 새 고정 후보로 회귀를 다시 수행한다.

## V2 복귀·재시도 프로토콜의 구현 단위

- REQ-02/05/08/10/12/14: `V2-PROTOCOLS.md`에서 새 사건 필드, 실패 증거, 고정 복귀 12쌍, attempt/cycle 경계, mock manifest/approval/receipt와 notes-only를 구현 전에 정의하고 독립 계획 검토의 지적을 반영했다. 구현·TC·읽기 전용 검토의 책임은 분리한다.
- 원본 비노드 결과를 업무 재작업으로 처리하지 않는다. cycle은 초기 1에 추가 재작업 3회만 허용한다. 인프라 오류는 gate FAIL과 다르며 이전 attempt를 덮어쓰지 않고 10초/30초 후 새 READY record를 만든다. 일반 step 사건으로 이전 실패 attempt를 다시 READY로 만들 수 없다.
- digest는 합성 실행기의 관측 토큰이다. 실제 암호학적 manifest 생성·권한 확인·원격 조회를 구현한 것으로 주장하지 않는다. 관측 토큰은 현재 후보·규칙·증거·cycle·X02 실행에 불변으로 묶고 실제 제출 권한은 false로 유지한다.
- TC의 SQE 관련 확인은 P22 관측과 P23 보고 뒤 P24 판정을 내리는 순서다. 실제 단말 시험 또는 P22의 원시 trial 결과 포맷 검증은 이번 증거의 범위가 아니며 장비/시나리오 프로토콜과 B09/B10 검증에 남는다.
- UI·서버·플러그인 진입점을 바꾸지 않은 순수 모듈 증분이므로 이번 후보는 전체 단위 회귀와 build로 확인한다. standalone/native host 화면은 재생 UI 연결 뒤 전체 V2 gate에서 필수로 실행하며 생략 승인이나 완료로 치환하지 않는다.
- 첫 프로토콜 후보의 199개 테스트와 build는 통과했으나 독립 TC 검토에서 같은 manifest/digest의 다른 cycle 재사용을 직접 거절하는 사례가 부족했다. 구현 기준을 완화하지 않고 별도 부정 TC를 추가한 뒤 새 고정 후보를 검증한다. 초기 통과 결과는 `evidence/v2/protocol-attempt-1.json`에 남기며 최종 수용 증거로 재사용하지 않는다.
- 200개 통과 후보에 대해 독립 증거 감사는 통과했으나 부모 통합 검토가 metadata 반려 후 완주 불가를 찾아 최종 수용을 보류했다(`protocol-attempt-2.json`). 복귀 target까지의 검사 범위가 원인이므로 end-to-end 복구 TC를 추가해 실패를 먼저 재현했다. 원본 DOCX/workflow 및 별도 senior_sol의 설계 검토로 돌아가 metadata만 같은 cycle의 새 X02/X03 attempt로 처리하는 예외를 정했다. 품질 판정·후보를 승격하거나 상한을 완화하지 않고 기존 공유 재작업 한도를 유지한다. 독립 계획 재검토 후 새 후보로 재검증한다.
- 보완한 후보는 전체 204개 단위시험, TypeScript/Vite build와 소스 74개 해시 고정을 통과했다. 독립 검토자가 소스·TC·로그·snapshot을 감사해 metadata 복구를 포함한 부분 protocol을 수용했다(`evidence/v2/protocol-review.json`). 전체 V2/실제 AT 완료는 아니다.

## V2 카탈로그·재생 화면 연결

- REQ-02/05/08/10/12/14: 25개 모의 시나리오에 원본의 구현된 7개 업무 실패와 5개 반려 경로를 모두 포함했다. P21의 OSS reject/design_change_needed는 X03의 코드/설계/자료 반려와 각각 구분한다. 미구현 V2 범위는 UI에 명시하고 실제 AT ledger를 변경하지 않는다.
- 관측 prefix 이동은 순수 snapshot 재계산이다. 현재 cycle 상태와 과거 실패 snapshot을 서로 덮어쓰지 않는다. TC의 초기 과거 FAIL 기대는 현재 PENDING과 혼동한 것이므로 원래 계약대로 oracle을 정정하고 history 검사를 유지했다.
- 필터가 숨긴 현재 노드로 이동할 때 이전 DOM ref를 조회해 focus/scroll을 놓치는 제품 결함을 재현했다. 새 visibleIds/selectedId의 layout effect에서 대상을 찾도록 수정했다. 시나리오 변경 시 inner board를 처음으로 돌리고 현재 모드 버튼의 반복 클릭은 관측을 초기화하지 않는다. 실제 포커스와 가로 영역 내 노출을 standalone/host에서 검사한다.
- 검증 runner는 이전 V1 gate를 유지하고 별도의 `ifpmic:verify:ui`로 확장했다. 원본 자료·기존 회귀·plugin과 실제 host, 25개 mock journal 및 의미 있는 실패/metadata/장비 화면을 같은 소스 후보 해시로 묶는다. 하위 명령별 timeout은 없으므로 실행 상태를 도구 handle로 확인하며, 멈춘 명령을 통과로 치환하지 않는다.

- 2026-10-15: 25개 모의 시나리오/UI 고정 후보의 11개 검증 명령이 모두 종료 코드 0으로 완료됐다. 단위 검사 209/209, 재생 브라우저 standalone 11/11·native host 12/12 통과. 독립 검토자가 소스 97개, 보고서 18개, 명령 로그 11개, 공개 사본 7개의 해시와 후보 동일성을 확인하고 부분 범위를 수용했다. 증빙: `evidence/v2/ui-verification.json`, `evidence/v2/ui-review.json`, `evidence/v2/ui-published-artifacts.json`. 전체 V2·B01–B13·실제 AT는 미완료로 유지한다.

- 2026-10-15: P03 미해결 질문과 P25 원격 결과 불명확 관측을 다음 부분 V2 증분으로 선택했다(`V2-EXCEPTIONS.md`; REQ-02/05/08/10/12/14). 원본의 질문/요구사항 버전 및 원격 조회·영수증 규칙을 보존하며, no-change는 계획·생략 근거와 결합해 후속 설계한다. 새 사건을 기존 25개 화면에 연결하기 전까지 UI 지원 범위를 확장하지 않는다.
- 독립 검토에서 P03 답변 뒤 infra retry가 질문의 attempt binding을 잃어 검토 없이 성공하는 실제 우회를 확인했다. TC가 실패를 재현하고 `evidence/v2/exceptions-attempt-1.json`에 증거를 남겼다. 승인 계획 보완 후 답변은 원래 실행에 보존하고 검토만 현재 attempt/execution으로 결속한다. 질문·답변·검토 증거 ID를 전역 분리하고, 재시도 후 새 검토로 정상 복구까지 시험한다. 원본 상태표나 retry 한도를 변경하지 않는다.
- 고정 후보의 전체 단위 225/225 및 build/plugin-build가 통과했다. 독립 검토자가 현재 소스 104개·명령 로그 3개의 해시와 후보 동일성을 확인해 P03/P25 모의 예외 프로토콜을 부분 수용했다(`evidence/v2/exceptions-verification.json`, `evidence/v2/exceptions-review.json`). 새 UI 사건은 미연결이며 browser/native-host 후속 검증, 나머지 V2·B 단계·실제 AT는 미완료다.

- 2026-10-15: 승인된 `V2-EXCEPTION-UI.md`에 따라 기존 25개 사건 fixture를 보존하고 질문·원격 조회의 7개 시나리오를 더해 32개로 확장한다(REQ-02/05/08/10/12/14). 화면에서 원 질문/답변과 현재 실행 검토를 구분하며, 재시도 a2의 성공에 a1 검토가 유효하다고 표시하지 않는다. 현재 P03 attempt를 별도로 명시하고 과거 질문 버전·cycle·attempt·검토 실행을 이력에 표시한다.
- 카탈로그 증거는 `observed_snapshot`으로 명명해 재생 관측값을 TC 고정 oracle과 구분한다. 기존 25개 fixture hash 기준도 gate 소스 지문에 포함한다. TC 기대값 오류와 캡처 가림 문제는 `evidence/v2/exception-ui-attempt-1.json`에 기록하고, host 안내 닫기는 검증 브라우저 안의 UI 동작으로만 수행한다. 실제 승인·제출·장비 권한이나 원본 계약은 변경하지 않는다.
- 안내 닫기가 로컬 동작이라는 부모 판단은 틀렸으며 실제 host POST가 발생해 진단을 불합격 처리했다. API 쓰기 0 기준은 완화하지 않는다. `V2-EXCEPTION-UI-CAPTURE.md`와 독립 검토에 따라 닫기 클릭/POST 예외 없이 공지 identity를 확인한 캡처 전용 visibility 조정 또는 없음 ledger를 사용한다. 현재 검증 host에는 공지가 없어 숨김 분기의 실호스트 실행 증거가 없다는 한계를 기록한다.
- 32개 모의 시나리오/UI 고정 후보의 전체 단위 226/226, 11개 명령, standalone 14/14·native host 15/15 검사가 통과했다. 독립 검토자가 현재 소스 107개·로그 11개·보고서/캡처 30개의 해시와 후보 동일성을 확인해 부분 증분을 수용했다(`evidence/v2/exception-ui-verification.json`, `evidence/v2/exception-ui-review.json`). host GET 조회는 허용되며 API 쓰기·외부 요청·runtime 오류는 0이다. 실제 host 공지 count=0/none이며 새 6개 필수 캡처를 두 환경에서 각각 확인했다. 전체 V2·B 단계·실제 AT 미완료 상태는 유지한다.

- 2026-10-15: 원본 skip_policy와 별도 설계/계획 검토(`V2-ROUTING.md`, `evidence/v2/routing-design-review.json`, `routing-plan-review.json`)에 따라 재사용·정책 공동 면제·NO_CHANGE를 순수 mock 프로토콜로 구현한다. X01 이전 P03–P05에는 개별 human 확인을, 후행 REUSE에는 X01 항목별 승인을 사용하며 P11 code-dev/P12 TC 분석을 분리한다. P22 면제 시 P23 SQE 미수행 보고를 생략하지 않으며 EXEMPT를 PASS로 기록하지 않는다. 네 mock 정책 결정은 B01 실제 정책의 사람 승인을 대신하지 않는다.
- 독립 소스 검토의 context 누락 TypeError 지적은 공통 contextCurrent guard를 누락한 검토 오류로 철회됐다. 구현을 불필요하게 변경하지 않고 누락 context 거절 TC를 추가한다. 초기 9개 TC 통과만으로 수용하지 않고 실제 면제 배포 완주, 후보 변경 및 부정 입력 검증을 보강한다.
- 새 cycle에서 이전 plan_version 재제출을 거절한 뒤에도 cycle-1 route_plan snapshot을 보존하는 것을 TC가 재승인으로 오해했다. 사건의 applied=false/invalid_route_context 및 snapshot 불변으로 oracle를 정정했고 최초 실패 로그 해시를 `evidence/v2/routing-attempt-1.json`에 보존했다. 제품 코드 변경이나 기준 완화 없이 새 버전 계획과 필수 실제 모의 재검토를 확인한다.
- 첫 전체 gate는 241/241과 build/plugin-build가 통과했으나 부모 통합 검토가 NO_CHANGE 뒤 P13 요청만으로는 inactive-step 검사만 덮는다는 TC 누락을 발견했다. 첫 gate를 최종 수용으로 쓰지 않고, 현재 P12의 step/agent/human/device/no_change 다섯 유형 모두 terminal_no_change로 거절하며 업무 projection 불변·발행0인 검사를 추가했다. 새 TC 후보로 전체 gate를 다시 수행한다.
- 최종 routing 후보의 단위 241/241, build/plugin-build가 통과했다. 독립 검토자가 현재 소스 111개·로그 3개·dist 6개·plugin 4개의 해시 및 보고서 사본 동일성을 확인해 부분 증분을 수용했다(`evidence/v2/routing-verification.json`, `routing-review.json`). 새 routing UI와 나머지 프로토콜, 전체 V2·B01–B13·실제 AT는 미완료로 유지한다.

- 2026-10-15: `V2-ROUTING-UI.md`의 독립 승인 후 기존 32개 events/checkpoints SHA를 `routing-ui-baseline-32.json`에 보존하고 새 9개 routing 관측을 더해 41개로 확장한다. local 확인·X01 승인·현재 권한·과거 계획, SKIPPED/EXEMPT/PASS, 사람 NO_CHANGE와 분석만 있는 상태를 구분한다. TC는 화면·카탈로그 검사를 맡고 main은 구현·통합을 맡는다. 초기 계획 검토에서 새 계획/baseline/review가 gate 입력에 빠질 위험을 지적해 계획과 runner를 보완했다. 생성된 catalog 관측은 독립 TC oracle를 대신하지 않는다.
- 41개 UI 후보의 11명령 gate가 통과했다(단위242/242, standalone15/15·native-host16/16). 첫 진단의 raw 필드명 기대 오류는 표시 계약에 맞춰 정정하고 결과를 보존했다. 독립 TC 검토에서 계획 후보 A와 현재 후보 B의 필드별 비교를 보강했다.
- 자동 gate 이후 시각 검토가 host mobile fullPage 캡처에서 고정 탐색 영역이 P24 상세를 가리는 문제를 발견했다. 원래 PNG를 보존하고 같은 고정 후보에서 host UI를 숨기지 않는 375×1800 viewport 캡처를 추가했다. 사전 script 독립 검토 후 117개 source/6 dist/4 plugin before-after 대조, fixed/sticky 교차0·hit-grid9/9·GET만80건과 쓰기/외부/runtime오류0을 확인했다. 제품 소스·테스트 변경이 없어 RU2 캡처만 보완하고 RU3 결과를 동일 후보로 유지했다. 전체 UI 증분은 독립 이미지·해시 감사 뒤 부분 수용됐다(`routing-ui-review.json`). 전체 V2·B01–B13·실제 AT 미완료를 유지한다.

- 2026-10-15: 원본 P22/P23/P24 조사에서 generic SUCCEEDED/complete만으로 시험 근거 없이 진행 가능한 경계를 확인했다. Luna 근거와 별도 senior_sol의 좁은 아키텍처 검토 후, opt-in이 아닌 모든 비면제 SQE 경로에 결과·보고·판정 근거를 필수화하는 `V2-SQE.md` 계획을 독립 승인했다. 기존41 원래 사건은 별도 source SQE proof 삽입 후 정규화 복원으로 보존하며 과거 불변 수용을 새 증거로 대체하지 않는다. 수동 제출·인프라 재시도·단일 bundle·불완전 판정의 세부 oracle를 TC 의견으로 보완해 재승인했다. 실제 사례 수·기준·장비·인증·수동 증빙 정책과 실 AT는 B 단계에서 계속 필요하다.
