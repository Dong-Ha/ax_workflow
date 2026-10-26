# IFPMIC AX 단계별 검증 계획

상태: **V0/V1/V2 구현 착수 계획 독립 검토 승인**. [검토 기록](./evidence/plan-review.json)을 따른다. 이 문서는 `PLAN.md`와 `design-v1/specs/`의 구현 순서 및 계약을 시험 가능한 검증 게이트로 구체화한다. 독립 검토자인 `/root/paperclip_ui_extension`의 worker_luna가 이 문서를 검토하고 단계별 진입 조건을 승인하기 전에는 구현을 시작하지 않는다. 검증계획 작성자(`/root/verification_plan`), 구현 총괄(code-dev인 main), TC 작성 담당은 계획의 독립 검토자가 될 수 없다. 구현도 아래 증빙을 확보하고 담당 검증자가 판정하기 전에는 완료 처리하지 않는다.


## 현재 애자일 전달 범위 적용

이 문서의 기존 독립 검토·격리·실행 전·최종 판정 절차는 원본 B 단계, 실제 runtime/장비/배포, 전체 H2 및 AT 수용에 계속 적용한다. 사용자가 승인한 [V4 주기03 계획](./delivery/iteration-03/ADMISSION-UI-PLAN-v4.md)에 따라 국소 코드·mock UI/API 개선은 전체 490건 통과를 기다리지 않고 선택 검사로 진행할 수 있다. 좁은 실제 DB/Temporal 통합 검사는 변경된 source·환경·계약·권한·격리·cleanup 준비와 해당 독립 검토 후 full490 전에 허용되며, 그 결과는 전체 H2나 운영/AT 수용으로 승격하지 않는다. 이 적용 설명은 원본 요구사항·gate나 아래 B 단계 검증 의무를 낮추지 않는다.

2026-10-26부터 한 회차에 사용자 흐름 하나를 목표로 한다. 개발 우선순위와 다음 목표는 [애자일 전달 계획](./AGILE-DELIVERY.md)을 따르며, 좁은 개발 검사나 통합 결과는 최종 수용을 대신하지 않는다. 전체 H2, B 단계 및 AT는 최종 수용 시 원본 기준에 따라 별도로 검증한다. 이전 실패와 수용 증거는 역사 자료로 보존하며, 과거 승인이나 증거를 새 후보의 승인으로 승계하지 않는다.

현재 제품 slice는 `admission-mock`(I02 UI mock 상태 조회), `admission-read`(실제 read-only API와 SQL ACL tuple), `admission-live`(격리 실제 엔진 receipt) 순이다. mock은 모듈 내부 `pending`/`admitted`/`error` 시뮬레이션이며 queue·실행·receipt나 실제 `QUEUED`가 아니다. 계정별 시나리오 선택만 sessionStorage에 보관하고 reload 때 상태 제공자를 다시 조회한다. 실제 저장 요청이나 상태를 변경하지 않는다. V9 timeout 진단은 30분 checkpoint가 있는 별도 지원 작업이며 관련 실제 runtime만 막는다. WIP 1은 제품 slice 하나로 계산한다. 각 slice의 필요한 검사는 시작 전에 고정하며 추가·반복은 변경 코드, 실패 재현 또는 미해결 우려에 한정하고 통과 시 종료한다. 명령 피드백 목표는 60초 이내, 진단 시간 초과 보고는 범위·시간과 다음 한 조치다. 이는 원래 test threshold, 승인, B 단계 또는 최종 gate를 낮추지 않는다. `--slice` 기본은 `plan.current_slice`; 선택 `--profile`은 현재 slice의 허용 목록에서 실행 profile 부분집합을 고른다. mock 기본은 `delivery-tool`과 `admission-state` Node controller regression을 실행한다. 별도 명시 browser 검사는 오프라인 API fixture를 사용하며 `npm run ifpmic:admission:browser`로 실행한다. read 기본은 순수 DTO·브라우저 상태 검사, live 기본은 protocol/workspace 검사이며 실제 DB를 자동 시작하지 않는다. `delivery:check`도 현재 선택된 profile만 실행한다. 검토는 변경된 코드/trust boundary와 영향 경로만 다루며, 실제 DB/Temporal 연결 전 바뀐 SQL/ACL/권한 경계는 독립 검토한다. Browser/build는 별도 명시 검사다. Mock/read slice는 각각 전달 결과로 기록할 수 있지만 전체 admission 또는 AT 인수가 아니다.

Paperclip은 조직·작업·실행 이력의 상위 오케스트레이션/감독 계층이다. IFPMIC workflow, 상태 전이, 담당 경계, 품질 판정 및 승인 계약은 `workflow.v1.json`, `state-contract.json`, `agent-contract.json`, `acceptance-cases.json`이 권위 기준이다. Paperclip 상태 변경만으로 IFPMIC gate를 통과시킬 수 없다.

## 1. 검증 운영 규칙

### 담당

| 담당 Agent/역할 | 검증 책임과 한계 |
|---|---|
| code-dev (main) | 전체 개발 흐름·의존성·후보 fingerprint·검증 증빙 수집과 단계 진행을 관리한다. 품질 규칙을 임의 변경하거나 자기 승인하지 않는다. |
| tc (`/root/verification_plan`) | 테스트 케이스/fixture 및 테스트 코드 작성만 담당한다. 제품 코드, 수용 기준, 품질 임계값, 승인 또는 배포를 맡지 않는다. code-dev가 호출·통합한다. |
| arch-runner | 등록된 wrapper로 SAM/TEM/정적분석 및 측정 결과를 수행·수집한다. 측정 대상 소스와 기준값을 변경하지 않는다. |
| sqe | 지정 Windows bridge/단말의 부팅 후 시험 스크립트 및 결과를 수행한다. 임의 shell/제품 코드/배포 권한을 갖지 않는다. 장비 조작 불가 시 사람 수행으로 전환한다. |
| report | 시험 증거와 결과 보고, release 초안·manifest·notes를 만든다. 승인 및 source patch 권한이 없다. |
| human | 명시된 설계·계획·OSS·수동장비·배포 승인 작업을 직접 제출한다. 에이전트 완료 이벤트로 대체하지 않는다. |
| 독립 검토자 (`/root/paperclip_ui_extension`, worker_luna) | 검증계획 자체와 각 게이트 판정 근거를 작성자·구현 담당자와 독립적으로 검토한다. 계획 작성자나 main이 아닌 별도 Agent가 수행한다. |

### 공통 실행·판정

1. 각 테스트 결과는 `job_id`, `step_id`, `cycle`, `attempt`, `candidate_fingerprint`(해당 시), `workflow/profile/rule/parser/tool 버전`, 실행 시각, 입력 해시, 결과/로그 artifact ID 및 판정자를 기록한다. 증거 원본은 접근 통제된 내부 저장소에 보관한다. 내부 코드·로그·기밀정보를 외부로 전송하지 않는다.
2. 테스트는 승인된 격리 fixture/mock에서 먼저 수행한다. 실제 저장소·사내 SAM/TEM·Bedrock·Windows 단말·원격 제출은 준비된 권한과 승인된 profile을 사용한다. 물리 장비나 제출 경로가 필요한 시험은 mock 통과를 실제 통과로 간주하지 않는다.
3. `PASS`, `FAIL`, `ERROR`, `INCONCLUSIVE`, `EXEMPT`를 구분한다. 결과 누락·파서 오류·환경 장애·불일치·시간 초과는 PASS가 아니다. 측정과 판정이 결합된 gate의 생략은 둘 다 명시된 정책으로 승인해야 하며 EXEMPT는 PASS가 아니다.
4. 정상 시험은 계약의 기대 경로를 한 번 이상 완주한다. 예외 시험은 각 지정 실패 주입을 모두 수행해 허용 상태/복귀를 확인한다. 경계 시험은 하한·상한·동일값/불일치값, 동시 요청, 만료 직전·직후 등 계약 경계를 포함한다. 회귀 시험은 변경 영향 분석이 연결한 기존 acceptance 및 불변조건을 재실행한다.
5. 단계 완료는 계획된 시험 전부 수행, 필수 증거 100% 보존, 중대/높음 미해결 결함 0건을 요구한다. 실제 acceptance execution을 수행하는 B 단계 gate는 해당 실행 범위의 acceptance 통과율 100%를 요구한다. V0~V2는 자료·시각화·모의 재생 자체 기준으로 판정하고 AT 실행 ledger를 변경하지 않는다. B 단계에서도 mock 실행과 real 실행 결과를 별도 보관한다. 하위 심각도 예외는 독립 검토자의 잔여위험 검토 및 사람의 명시 승인 없이는 완료 기준을 낮추지 않는다.
6. 실패하면 우선 해당 시험의 입력·후보·버전·로그를 동결하고 원인을 `제품/계약/시험/환경/인프라`로 분류한다. 제품/계약 원인은 수정된 요구사항부터 영향 분석하여 가장 이른 영향 단계로 되돌아간다. 시험 자체 오류는 TC 작성자와 독립 검토 후 재작성한다. 환경/인프라 장애도 실패 이력과 당시 증거를 보존한다. 불완전하거나 신뢰할 수 없는 측정 증거는 gate 판정에 사용할 수 없으며, 환경 복구 뒤 동일 조건으로 새 attempt를 수행한다. 모든 재실행은 새 attempt/cycle로 남기며 과거 결과를 덮어쓰지 않는다.
7. 어느 검증을 생략할 경우 생략 단계, 기술적 근거, 변경 영향 범위, 잔여 위험, 보완 통제, 승인자와 승인 시각을 `workflow-artifacts/verification/waivers/`에 기록하고 독립 검토와 사람 승인을 받아야 한다. 생략 승인이 없는 미실행은 차단 사유다.

### 변경 영향에 따른 검증 범위

각 PR/변경 후보마다 code-dev가 파일·API·데이터·상태·보안·workflow·외부 부작용에 대한 영향도를 기록한다. `design-v1/specs/` 계약 파일은 영향분석 기준으로 사용한다.

| 영향 등급 | 예시 | 필수 범위 |
|---|---|---|
| I0 문서/표시 전용 | 텍스트, 도움말 | 문서 링크/validator 및 영향받는 화면 smoke, 기본 회귀 |
| I1 단일 모듈 내부 | 비공개 함수/스타일 | 모듈 단위 정상·예외·경계 + 해당 모듈 회귀 |
| I2 계약/상태/권한/저장 | API schema, 상태 전이, artifact, auth, profile | 전체 직접 호출·호출자 경로, 상태/권한/경계, 관련 AT 전부, 데이터 격리/회귀 |
| I3 부작용/외부 경계 | 실행기, 품질 도구, 단말, publisher, credential | I2 전부 + 실패 주입, 중복/응답 유실/재시작 reconciliation, 장비·원격 대상 검증 및 사람 승인 |

등급은 수정 경로 중 최고 위험을 적용한다. 영향 추적이 불완전하거나 인덱스/호출 관계 coverage가 불충분하면 한 단계 상향한다. 부분 실행이나 미실행 AT는 위 waiver 없이는 수용하지 않는다.

## 2. 단계 게이트

표에서 요구사항은 `requirements.json` ID, AT는 `acceptance-cases.json` 및 backlog의 AT ID다. AT의 상세 입력/기대 결과는 해당 JSON을 함께 읽어 테스트 명세에 보존한다. 단계 범위 밖 AT는 의존 단계에서 실행하되 최종 추적표에서 누락시키지 않는다.

| 단계 | 요구사항 / AT 추적 | 검증 목적·대상 | 정상 / 예외 / 경계 / 회귀 방법 | 담당 | 정량 합격 기준 및 예상 결과 | 증빙 자료 | 실패 복귀 및 재검증 |
|---|---|---|---|---|---|---|---|
| **V0 자료·검증기준 고정** | REQ-01~15; AT-01~32 전체 기준선 | DOCX·ZIP 원본과 추출 계약 간 완전성, 추적성, 계획 자체가 실제 계약에 맞는지 확인 | 정상: 요구사항 15개, AT 32개, backlog B01~B13, workflow 29노드/모든 edge를 기계 비교. 예외: 잘못된 참조 ID·누락 파일·수정된 해시 fixture 거절. 경계: 빈 ID/중복 ID/없는 edge/미지 owner fixture. 회귀: 원본 ZIP manifest/SHA256와 저장소 design-v1 패키지 비교 및 기존 validator 재실행 | 주관 spec-gen; code-dev 자료/범위 조정; tc는 추적 검증 fixture 작성만; 독립 검토자 계획 감사; human은 업무 의미에 영향이 있는 미해결 계약을 판단 | 요구사항 15/15, AT 32/32가 최소 한 검증 단계에 매핑; B01~B13 전부 존재; 계약 validator 0 오류; 원본 참조 파일 바이트/hash 불일치 0. 예상: 요구사항-AT-단계 매트릭스 완전, 실제 실행 통과 주장은 없음 | `workflow-artifacts/verification/V0/`에 입력 manifest, hash 목록, trace matrix, validator JSON/stdout, 독립 검토 의견·승인 | 누락/불일치면 근거를 고친 뒤 V0 전체 비교 재실행. 업무 의미에 영향을 주는 미해결 계약이 있으면 사람 결정 전 관련 화면 의미를 확정하지 않는다. 저장소/SRS/I2C/SSO 준비는 V1/V2 진입 조건이 아니다 |
| **V1 계약 기반 정적 시각화** | REQ-01,05,06,10,12,14; AT-03,04,05,06,09,10,11,18,28은 화면 표시/계약 fixture 확인에만 사용(실제 AT 실행 완료로 집계 금지) | Paperclip UI가 IFPMIC 상위 상태를 표현하면서 원본 책임·조건·실패 edge를 손실 없이 표시하는지 확인 | 정상: 원본 29개 업무 노드(END terminal 제외), 6 phase, 29 normal edge + 7 business-fail edge + 5 special-outcome edge(총 41 연결)를 계약과 대조. 예외: 알 수 없는 상태, 승인 대기, 실패 및 반려 경로 표시. 경계: 검색/담당 필터의 빈 결과·중복 담당, 키보드 전용 탐색, 375px/1440px viewport, 긴 라벨/빈 증거. 회귀: JSON fixture 변경 시 UI node/edge snapshot, 원본 패키지 바이트/hash 보존, 기존 AX `npm test`/`npm run build`/browser smoke 및 IFPMIC route에서 Paperclip page mount smoke. 외부 network 호출 0건을 계측한다. | code-dev(main) 총괄·통합; tc(/root/verification_plan) 테스트 작성; spec-gen 요구 trace 확인; 독립 검토자(/root/paperclip_ui_extension, worker_luna) UI 계약 검사; human 설계/업무 의미 확인 | node=29, phase=6, edge=41 수·정체 일치; human owner 노드=7; 누락/추가/담당 오표기 0; 검색·담당 필터·상세 선택·키보드 주요 동작 각 100%; 375px/1440px에서 핵심 정보·상태 접근 가능; source hash 변경 0; 외부 network 0; `npm test`, `npm run build`, browser smoke 및 실제 Paperclip route mount smoke 전부 통과. 독립 local preview만으로 host integration 완료 처리 불가. 예상: Paperclip host 안에 장착된 읽기 전용 계약 시각화 | `workflow-artifacts/verification/V1/`: 화면 캡처(375px/1440px), DOM/accessibility 검사, JSON-UI 비교 report, browser 및 host mount smoke report, network trace, 원본 hash manifest | 계약 표현 오류는 spec-gen/설계로, UI/host 연결 오류는 V1로 복귀; 영향 계약 변경 시 V0 trace matrix 갱신 후 V1 전체 재실행 |
| **V2 모의 상태·실패 경로 재생** | REQ-02,05,08,10,12,14; AT-03~05,07~18,24~30은 mock 화면/fixture 동작 확인에만 사용(실제 AT 실행 완료나 실환경 수용으로 집계 금지) | 실행 서비스와 혼동되지 않는 mock에서 대기·실패·복귀·cycle/attempt·생략을 올바르게 탐색하는지 확인 | 정상: mock 기본 완주 및 P01~P26/확장 노드 흐름 재생. 예외: SAM/TEM/SQE 실패, human 반려, device offline, 불명확 원격 결과. 경계: cycle limit=3, infrastructure attempts=3, lease 60초 전후, 10초 heartbeat/30초 offline, 지연/중복 event. 회귀: 오래된 cycle·candidate·approval이 현재 gate를 해제하지 않는 fixture | code-dev(main) 총괄; tc(/root/verification_plan) 시나리오/fixture 작성; arch-runner mock 측정 결과 fixture 검증; sqe는 물리시험을 가장하지 않는 mock semantics 검토; human 반려·수동 경로 확인; 독립 검토자(/root/paperclip_ui_extension, worker_luna) 계획/fixture 검사 | 등록된 시나리오 100% 재현; mock label/배지 100%; 잘못된 성공·과거 증거 승격 0; mock에서 외부 side effect 0; 각 실패 route 정확 일치; acceptance execution ledger에 실제 완료로 집계할 AT=0 | `workflow-artifacts/verification/V2/`: fixture manifest, event journal, 화면 캡처, route assertion, 외부 요청 차단 로그 | fixture와 구현 원인 구분. 구현이면 가장 이른 잘못된 전이부터 재생, 명세 문제면 spec-gen 수정 및 V0/V1 추적 재검토 후 전체 영향 시나리오 재실행 |
| **B01 계약 및 프로파일** | REQ-02; AT-04, AT-28 | registry/schema validator, immutable profile snapshot, skip/REUSE/POLICY/COUPLED 의미 확인 | 정상: 유효 profile 고정 및 baseline 재사용 승인. 예외: 신규 HW 문서 skip, 미승인 정책, mock-to-real 승격 거절. 경계: baseline hash 동일/1바이트 변경, plan_version 경계·누락, 잘못된 enum/중복 ID. 회귀: V0 validator/AT-04,28 반복 | code-dev; tc validator 테스트 작성; spec-gen schema/요구 연결; human X01 경로 승인; 독립 검토자 | 유효/무효 schema fixture 100% 기대 분류; 불변 snapshot 변경 0; 무근거 skip 0; mock/real 구분 전이 오류 0. 예상: 승인된 plan/profile 버전과 설명 가능한 SKIPPED만 생성 | `workflow-artifacts/verification/B01/`: schema report, snapshot hashes, decision audit, AT logs | 계약 오류면 V0 수정 및 재승인; 코드 오류면 B01 재검증 후 downstream 영향을 가진 V단계/B단계 AT 재실행 |
| **B02 인증 및 요청 저장** | REQ-13; AT-21 | 사용자 소유권/프로젝트 역할 격리, 요청 DB/workspace 및 artifact 접근 | 정상: 소유자/위임 역할이 자기 job 읽기·쓰기. 예외: 타 사용자 ID 위조, 타 프로젝트 ID, 경로 조작, 미인증 다운로드 차단. 경계: 동시 생성, 경계 role, 빈/최대 입력, 같은 idempotency key 동시 요청. 회귀: 기존 AX 읽기 전용 localhost 정책과 데이터 노출 경계 | code-dev; tc API/권한 테스트 작성; 독립 검토자 권한 리뷰; human 접근 정책 승인 | 사용자 격리 부정 테스트 100% 거부; 교차 사용자/프로젝트 데이터 누출 0; 요청 소유자는 인증 subject에서만 설정; 모든 artifact 다운로드마다 권한 검사 | `workflow-artifacts/verification/B02/`: auth test report, redacted audit, DB isolation 결과 | 권한/데이터 모델 문제면 B02 설계 및 관련 B01 재확인; 유출 가능성은 즉시 차단 후 영향받은 모든 endpoint/다운로드 경로 재검증 |
| **B03 워크플로우 실행** | REQ-05,14; AT-05,16,29 | Temporal, outbox, human wait, version pin, 재시작 복구, 담당 인간 단계 유지 | 정상: 사람 제출 이후 정확한 다음 단계 진행. 예외: outbox 전달 전/후 서버 종료, 중복 명령, 에이전트 완료만 있는 P07/P21, workflow version 변경. 경계: 재시작 순간, revision 경합, pause/cancel과 in-flight 완료. 회귀: state-contract 허용 전이 전부 및 금지 전이 | code-dev; tc 상태/재시작 테스트 작성; human P07/P21 제출; 독립 검토자 전이 검토 | 허용 전이 100% 성공·금지 전이 100% 거부; 중복 명령 효과 1회; 재시작 후 상태/대기 증거 손실 0; 사람 없는 사람 단계 통과 0 | `workflow-artifacts/verification/B03/`: event history, DB/outbox snapshot, replay report, human task evidence | 가장 먼저 손상된 transition/outbox 경계부터 수정; 재시작·멱등·인간대기 세트 재실행 및 AT-16/29 회귀 |
| **B04 이벤트 및 웹 기본** | REQ-12,14; AT-03,27 | 4 기본 화면, SSE cursor 재연결/중복 억제, 알림 및 동시 사용자 UI | 정상: event stream 및 snapshot revision 따라잡기. 예외: 연결 끊김/만료 cursor(410)/중복 event/동시 승인 조작. 경계: 마지막 event ID, 페이지/필터 변경, cursor 만료 시 전체 snapshot. 회귀: V1 표시·키보드·좁은 viewport, 권한 격리 UI | code-dev FE/BE 통합; tc SSE/UI 테스트; human 알림 작업 확인; 독립 검토자 이벤트 정합성 검토 | Last-Event-ID 이후 누락 0, 중복 표시 0, snapshot revision 단조 증가, 만료 cursor에서 snapshot 재조회 100%; AT-27 동시 처리 결과 단일 유효 결정 | `workflow-artifacts/verification/B04/`: event sequence, browser test report, network disconnect/reconnect capture, notifications | cursor/revision 원인 모듈로 복귀. 해당 SSE + 스냅샷 동시성 및 권한 회귀 전체 재실행 |
| **B05 모의 완주** | REQ-01,03~05,12,14,15; AT-01,09,10,11 | mock adapters로 실패 복귀가 포함된 end-to-end 완주와 report/gate 분리 | 정상: 요청부터 완료까지 mock 완주. 예외: P16→P07, P18/P20→P11, P24→P07, 미완료 증거, 인프라 실패. 경계: business cycle 3회/그 초과, retry 정책, 이전 candidate 결과. 회귀: V2 전 시나리오 및 B01~B04 AT | code-dev 총괄; tc E2E 및 failure injection 작성; arch-runner mock 지표 fixture; sqe mock 결과 형식 검토; report 결과 공개; human 설계 대기 확인 | AT 01/09/10/11 모두 통과; 모든 실패 route/재평가 필수 노드 정확; gate에 불완전 증거가 통과한 건 0; mock 외부 부작용 0. 실환경 수용으로 표기하지 않음 | `workflow-artifacts/verification/B05/`: 전체 실행 artifact index, cycle/attempt graph, 주입 목록, gate 결과·보고서 | 최초 잘못된 상태 전이 단계(B01~04 포함)로 돌아가 수정하고 end-to-end 전체 재완주; 원인이 시험 명세면 spec-gen/독립 리뷰 후 재실행 |
| **B06 Claude Code 연결** | REQ-11; AT-06,23 | Bedrock profile, streaming adapter, 실행 역할·도구·쓰기 경계, TC 격리 handoff | 정상: 승인 profile로 code-dev 실행, tc가 격리 worktree의 테스트 patch 전달. 예외: tc 제품 경로 수정, 미승인 model/provider/endpoint, prompt/log의 비공개 reasoning, secret 노출. 경계: timeout/budget 제한, patch 허용경로의 경계. 회귀: B03 task identity/cycle/fingerprint, B02 사용자 권한 | code-dev 통합/제한 설정; tc 침해 fixture만 작성; 독립 보안 검토자; human 승인된 runtime/profile 제공 | tc 제품 소스 쓰기·통합 0; 비승인 endpoint 호출 0; credential/reasoning API 노출 0; 실행 ID/task fields 100% 기록; 승인된 Bedrock만 연결 | `workflow-artifacts/verification/B06/`: redacted adapter transcript, allowed-path enforcement, endpoint allowlist logs, profile hash | 권한 경계 실패면 연결을 끄고 B06/B02/B03 재검증; credential 노출은 증거 회수·회전 절차 후 전체 secret 경로 점검 |
| **B07 개발 및 빌드** | REQ-06,15; AT-02,07,30 | patch handoff, candidate manifest/fingerprint, KUnit/build wrapper, no-change 경로 | 정상: 코드+TC 통합 후 기준 빌드/KUnit 실행. 예외: I2C read error 값 사용, 기대 결과 약화, TC 없는 코드 변경, 실패 결과 조작. 경계: candidate의 코드/config/toolchain hash 한 요소 변경, no-change 판단. 회귀: 후보 A 품질 결과가 B에 승계되지 않음; AT-02 오류경로와 단말 회귀 구분 | code-dev 개발/통합/빌드; tc는 TC 설계·시험 patch; 독립 리뷰 세션; human 오류 계약/기준 승인 | manifest canonical SHA256 재현 100%; fingerprint 불일치 결과 gate 승인 0; 요구사항-테스트 링크 100%; 빌드 및 필수 KUnit 통과; 테스트 약화 0 | `workflow-artifacts/verification/B07/`: candidate manifest, build/KUnit log, test diff, review report, I2C failure evidence | 요구·기대결과 오류면 V0/B01로; 테스트/패치 오류는 B07 시작 전 계약으로 돌아가 재실행. 변경 후보 생성 시 모든 후보 의존 품질 증거 무효화 후 재검증 |
| **B08 품질 프로그램 연결** | REQ-03; AT-08,12,31 | SAM/TEM/정적분석 등록 wrapper·parser·규칙 버전, OSS 사람 작업 | 정상: 도구 결과 및 판정 기준 일치. 예외: exit 0 결과 누락, 파서 오류, 제한/장애, OSS 부적합/설계 영향. 경계: 임계값 정확히 같음/바로 밖, 빈 report, 정책 버전 전환. 회귀: fail route SAM→P07, TEM/static→P11, policy 변경 후 재판정 | arch-runner 도구 실행·보고; tc parser/fixture 테스트 작성; spec-gen 요구·trace; human OSS 검토/규칙 소유자 확인; 독립 검토자 기준 감사 | 원본 측정과 파싱 결과 상호 검증 100%; 누락 결과 PASS 0; 버전 고정 기록 100%; 장애와 품질 FAIL 분류 혼동 0; AT-31 구버전 정책 silent 적용 0 | `workflow-artifacts/verification/B08/`: 원본 정제 report, normalized report, parser/rule/tool versions, gate decisions, human OSS evidence | parser/규칙 결함이면 B08과 해당 단계 gate 전체 재실행; 품질 실패는 계약상 복귀 단계로 새 cycle 진행하고 영향 측정 재검증 |
| **B09 Windows bridge** | REQ-07; AT-14,22,32 | enroll, 식별/매핑, SQLite journal, lease/fencing, flash command 및 응답 유실 | 정상: 명시 serial/board 식별, profile에 따른 flash. 예외: 명령 중 단절, 중복 command, 다른 job lease, 장치 식별 모호, side effect 후 UNKNOWN. 경계: heartbeat 10초, offline 30초, lease 60초, 증가 fencing token, bootloader serial 변경. 회귀: 서버/bridge 재기동과 local journal 복구 | code-dev bridge/backend 통합; tc protocol/failure fixture; sqe 장비 식별 및 승인 profile로 실제 수행; human 물리 장비 개입; 독립 검토자 단말 안전 검토 | 장치별 활성 작업 최대 1; fencing token 단조 증가; journal side effect 전 fsync 100%; UNKNOWN 장치 재할당/자동 재flash 0; 모호 identity 명령 0 | `workflow-artifacts/verification/B09/`: bridge journal export, redacted command sequence, device identity/lease log, 실제 단말 영상/결과(내부 보관) | UNKNOWN 발생 시 격리 유지, 장비 상태 수동 reconciliation 후 동일 command 재실행 금지 검증. bridge/backend 양측 복구 뒤 AT-14/22/32 반복 |
| **B10 SQE 및 수동 대체** | REQ-04,08; AT-13,15 | image/board/boot identity 매칭, 부팅 후 스크립트, 수동 증거 제출과 재개 | 정상: 후보 이미지 hash 일치 후 boot 및 등록 스크립트 실행. 예외: 다른 이미지/보드/부트 식별, 단말 미연결, script 실패, 수동 모드 제출 불완전. 경계: 허용된 identity map 경계·timestamp·필수 case 누락 1개. 회귀: 실제 오류경로 시험과 일반 부팅 회귀 구분 | sqe 수행; tc 스크립트 결과 parser fixture; code-dev 후보 연결; human 수동 장비 수행 및 performer/evidence; 독립 검토자 | 후보 이미지·보드·boot identity 일치 100%; 불일치 결과 PASS 0; 수동 수행을 자동 실행으로 표기 0; 필수 case/수행자/시간/버전/증거 100% 존재 | `workflow-artifacts/verification/B10/`: image/board hashes, script profile/version, raw+parsed SQE result, human evidence | mismatch/INCONCLUSIVE는 publish 차단 유지. identity/config 오류는 B09까지 복귀하고 재식별 후 AT-13/15 전체 재시험 |
| **B11 승인 및 배포** | REQ-09,10; AT-18,19,20,26 | 배포 digest 승인, 4 release mode, idempotency, 원격 receipt reconciliation, notes | 정상: 사람이 정확한 manifest digest 승인 후 승인 publisher가 제출하고 receipt 확인. 예외: stale/revoked 승인, 응답 유실/중복 요청, 노트 실패. 경계: digest 한 바이트 변경, 동일 idempotency key 동일/상이 payload. 회귀: P25 unknown은 reconcile, P26 실패는 notes만 재시도; LLM/bridge credential 부재 | report 초안/manifest/notes 및 제출 결과; code-dev publisher 연동; tc publisher 실패 fixture; human 최종 승인; 독립 검토자 제출 전 증거 확인 | 승인 digest==실제 제출 manifest 100%; 무승인·오래된 승인 제출 0; destination/idempotency 중복 부작용 0; 원격 receipt 100%; P26 실패 시 release 재제출 0 | `workflow-artifacts/verification/B11/`: digest, 승인자/결정, 요청 audit, remote 조회/receipt, note retry trace | 불명확 원격 상태는 자동 retry 금지 및 P25 reconciliation. receipt 확인 전 완료 불가. 승인/digest 오류면 X03으로 회귀해 새 승인 받고 AT-18~20/26 실행 |
| **B12 운영 수용** | REQ-12~14; AT-17,24,25,27 및 AT-03,16 회귀 | 지연 이벤트, retry/cycle limit, cancel race, 승인 경합, load/restart/backup 복구 | 정상: 운영 시나리오 전체 drill. 예외: 늦은 이전 결과, 재시도 초과, 취소와 원격 부작용 경합, 동시 승인, backup 복원. 경계: 3회 제한/초과, event cursor limit, lease 만료, 최대 부하 목표(profile에서 고정). 회귀: B03~B11 핵심 AT 재실행 및 데이터 무결성/receipt 보존 | code-dev 운영 drill 총괄; tc chaos/경합 테스트 작성; report 수용 보고서; sqe 장비 상태 정합 검토; human 운영·취소 결정; 독립 검토자 | 모든 drill 예상 상태 일치; 초과 반복 무한 루프 0; 이전 cycle gate unlock 0; 원격 부작용 유실/중복 0; 복구 후 event/evidence/receipt 손실 0; 사전 승인 load 목표 충족 | `workflow-artifacts/verification/B12/`: drill 계획/실행 ID, load profile/results, backup/restore hashes, race traces, 수용 보고서·잔여 위험 승인 | 무결성·외부 부작용 실패면 운영 진입 중지, 첫 영향 B단계로 복귀. 복구/수정 후 실패 drill과 연결된 전체 회귀 재실행 |
| **B13 OpenCode 및 신규 HW** | REQ-01,02,11; AT-01,04,23 | 승인된 OpenCode adapter/runtime compatibility와 NEW_HW 경로에서 원본 노드·필수 gate 실행 확인 | 정상: 지원 runtime fixture 및 신규 HW 전체 필수 단계 실행. 예외: 비승인 endpoint/tool, 지원 안 되는 버전, 문서·단계 무근거 생략 요청. 경계: runtime version matrix 최소/최대, 새 board identity, 신규 HW에서 skip 시도. 회귀: 전체 AT-01 완주, AT-04 skip 제한, AT-23 endpoint 제한 | code-dev adapter/통합 총괄; tc 호환성 fixture 작성; sqe 신규 보드 시험 가능성 확인; arch-runner 등록 tool 검증; human X01 및 신규 HW/배포 판단; 독립 검토자 | 승인 runtime만 연결; 신규 HW에서 원본 26단계+확장 승인 단계를 빠짐없이 수행; 부적절 skip 0; 원격 receipt와 최종 노트 존재; mock/real 혼동 0 | `workflow-artifacts/verification/B13/`: compatibility matrix, NEW_HW plan version, 전체 실행 증거 index, 승인·receipt·최종 보고 | 호환성 실패는 adapter에서 차단하고 B06/B01로 복귀. 신규 보드/절차 변경은 V0 요구 trace 및 B09/B10 profile 갱신 후 AT-01/04/23과 영향받은 장비 시험 전부 재수행 |

## 3. Acceptance 전체 추적 요약

V1의 41개 연결은 업무 노드에서 업무 노드 또는 END terminal로 향하는 전이의 합이다. END는 별도 종료 표시로 그리며 업무 노드 29개 집계에서는 제외한다. `special_outcomes` 8개 중 노드로 향하는 5개는 연결 수에 포함한다. 나머지 3개인 `P03.unresolved → WAITING_HUMAN`, `P25.unknown_remote_state → RECONCILING`, `P26.failure → retry_notes_only`도 선택 단계 상세에서 각각 표시하고 원본 계약과 일치하는지 별도로 검사한다. 이 3개를 누락하거나 임의의 노드 연결로 만드는 경우 V1은 불합격이다.

| AT | 주 검증 단계 | AT | 주 검증 단계 |
|---|---|---|---|
| AT-01 | B05, B13 | AT-17 | B12 |
| AT-02 | B07 | AT-18 | B11 |
| AT-03 | B04 | AT-19 | B11 |
| AT-04 | B01, B13 | AT-20 | B11 |
| AT-05 | B03 | AT-21 | B02 |
| AT-06 | B06 | AT-22 | B09 |
| AT-07 | B07 | AT-23 | B06, B13 |
| AT-08 | B08 | AT-24 | B12 |
| AT-09 | B05 | AT-25 | B12 |
| AT-10 | B05 | AT-26 | B11 |
| AT-11 | B05 | AT-27 | B04, B12 |
| AT-12 | B08 | AT-28 | B01 |
| AT-13 | B10 | AT-29 | B03 |
| AT-14 | B09 | AT-30 | B07 |
| AT-15 | B10 | AT-31 | B08 |
| AT-16 | B03 | AT-32 | B09 |

REQ-01~REQ-15는 V0에서 모두 단계/AT와 연결한 뒤 B 단계별 표의 요구사항 열로 실행 추적한다. 어떤 AT도 전역 회귀 추적에서 제외하지 않는다. AT 기대값은 원본 acceptance JSON의 조건을 유지하며 이 문서의 수치 기준은 이를 약화시키지 않는 추가 게이트다.

## 4. 준비 상태, 차단 항목, 생략 기록

현재 확인된 것은 제공 설계 패키지의 구조/계약이며, 기존 설계 검증기의 53개 구조 assertion 통과는 애플리케이션 동작 검증이나 서비스 수용시험 통과가 아니다. acceptance-cases.json의 AT-01~32는 `not_executed` 상태다. 구현 전 자료 검증(V0) 외 단계는 아직 실행 증빙이 없다.

실환경 단계는 준비 전까지 **BLOCKED(환경 미준비)**로 기록한다. 적어도 다음 조건이 준비되어야 한다.

| 항목 | 영향 단계 | 필요한 증거/준비 |
|---|---|---|
| 독립 검증계획 reviewer `/root/paperclip_ui_extension` worker_luna | 구현 전 | 작성자·구현자와 분리된 검토 의견/승인 기록; 업무 의미 영향 미해결 계약만 사람 결정 필요 |
| 내부 Linux source checkout/ref, 빌드·toolchain·config, KUnit 대상 | B07, B13 | 승인된 profile과 기준 실행 결과 |
| Bedrock/Claude Code/OpenCode 승인 runtime·endpoint·SSO·권한 | B06, B13 | 내부 allowlist, credential 보관·접근 정책 및 fixture |
| 사내 SAM/TEM/정적분석/OSS 도구, parser·threshold·policy 소유자 | B08 | 버전 고정된 실행 샘플과 기대 판정값 |
| Windows bridge PC, ADB/fastboot, 등록 단말/board mapping, flash/boot/SQE profile | B09, B10, B12, B13 | 격리 장비, 식별·복구 절차, 담당 SQE 승인 |
| 내부 원격 제출 대상 4종, 자격증명 분리, 최종 승인자 | B11, B12 | sandbox destination, 권한과 receipt 조회 경로 |
| 내부 artifact/evidence 저장소·접근 권한·보존 정책 | 모든 실행 단계 | 저장 경로와 ACL, hash 검증/감사 로그 확인 |
| SRS/SW 시험 계획/첫 I2C 오류 계약 입력 | B07 및 실제 파일럿 검증 | 오류 반환 기대값, 대상 함수·기준 커밋 확정. 미준비여도 V1 정적 시각화와 V2 일반 계약 mock은 진행 가능 |

실제 저장소/SRS/I2C 사례, SSO, 사내 품질 도구, 단말, publisher 권한의 미준비는 해당 실환경 검증 단계를 BLOCKED로 만들지만 V1 정적 시각화 및 V2 mock 탐색을 막지 않는다. 환경 미준비는 시험 생략이나 PASS로 치환하지 않는다. V1/V2의 AT 참조는 표시 또는 fixture 적합성만 검사하며 acceptance execution ledger에서 실제 AT 완료로 집계하지 않는다. 제품 저장소 변경을 커밋/push하는 프로젝트 작업은 저장소 지침의 사용자 상시 승인을 따른다. 이는 IFPMIC 제품 P25 원격 제출이 아니며 P25 최종 제출은 별도의 X03 digest 승인 이후에만 수행한다.

기계적 독립 검토는 검증계획/테스트/증거의 추적성·완전성·판정 규칙을 확인하는 활동이며 외부 시스템 권한을 부여하지 않는다. 실제 Bedrock, 사내 저장소, 단말 작업, publisher/외부 제출에 필요한 권한 요청은 해당 시스템의 권한 소유자와 사용자/담당자의 승인을 별도로 받아야 한다. 사람 승인 기록을 기계 검토 통과로 대체하거나 그 반대로 하지 않는다.

### 생략/잔여 위험 등록 양식

각 waiver는 `workflow-artifacts/verification/waivers/<id>.json`에 아래 필드를 모두 기록한다. 승인자/기술근거가 비어 있거나 reviewer가 미승인한 waiver는 효력이 없다.

```json
{
  "waiver_id": "",
  "stage": "",
  "requirement_ids": [],
  "acceptance_ids": [],
  "omitted_tests": [],
  "technical_basis": "",
  "impact_scope": "",
  "residual_risks": [],
  "compensating_controls": [],
  "revalidation_trigger": "",
  "requested_by": "",
  "independent_reviewer": "",
  "human_approver": "",
  "approved_at": "",
  "decision": "pending"
}
```

현재 승인된 생략 항목은 없다. 계획의 정적 문서 자체가 서비스 실행 시험, 외부 연동, 장비 조작 시험을 포함하지 않는 것은 범위 구분이며, 해당 시험은 구현/환경 단계에서 필수로 수행한다. 이를 생략 waiver로 기록하지 않는다.

## 5. 독립 검토 및 실행 기록

독립 검토자는 다음 항목을 확인하고 수정 요청 또는 승인, 검토자, 날짜, 근거 링크를 `workflow-artifacts/verification/plan-review.json`에 기록한다.

- DOCX와 모든 JSON 계약의 책임·입출력·통과조건·edge 및 승인 규칙이 왜곡되지 않았는가.
- REQ 15개, AT 32개, B01~B13과 V0~V2가 양방향으로 추적되는가.
- 정상/예외/경계/회귀 테스트와 합격 수치가 기능 위험에 맞는가.
- 담당 경계(code-dev 총괄, tc 테스트 작성만, arch-runner SAM/TEM/정적분석, sqe 단말, report 증거/보고, human 승인)가 지켜지는가.
- 실패 복귀·재검증, 생략 위험 승인, 내부 기밀 보호, 실제 환경 blocked 표시가 충분한가.
- mock 통과나 설계 validator 통과를 실제 수용으로 혼동하지 않는가.

검토 판정: **V0/V1/V2 계획 승인**. 구현 착수 판정: **해당 단계의 선행 검증 조건 확인 후 허용**. 실환경 B 단계의 준비 조건과 수용 기준은 유지한다. 현재 예상 결과 및 증빙 경로는 계획된 산출물이며 실행 증거가 아니다. 실제 완료 판정은 각 단계의 증빙 링크와 판정자가 채워진 후에만 내린다.
