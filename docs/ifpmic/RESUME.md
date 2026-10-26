# IFPMIC AX 재개 안내 · 2026-10-26

## 목표와 진척

최종 목표는 제공된 IFPMIC 설계 계약의 전체 업무 흐름, 역할, 승인, 보안 경계 및 AT 수용이다. 중간 전달은 한 번에 사용자 흐름 하나를 완성해 확인하며, mock 결과를 실제 실행이나 최종 인수로 계산하지 않는다.

- 필수 단계: **2/16 = 12.5%**(동일 가중치 단계 수). 목표 전체는 미완료다.
- 전달됨: 29단계·6구간·41연결 탐색 화면 및 74개 합성 시나리오, mock 계정 기반 요청 등록·저장·조회.
- 다음 사용자 결과: 저장 요청 한 건의 실제 엔진 접수와 같은 job/run/receipt의 `QUEUED` 확인.
- 최신 V9 실제 H2: 490개 중 8개 실행, 7통과·1실패, 482미실행. 실패는 claim 만료의 DB-clock 관측 timeout이며 원인은 미확정이다. [실행 상태](./delivery/iteration-03/runtime-v9-execution-status.json) · [독립 실패 검토](./delivery/iteration-03/runtime-v9-attempt-01-result-review.json)
- V9 실행은 종료됐으며 자동 재시도하지 않았다. 154개 stdlib 검사 통과는 실제 H2 통과를 뜻하지 않는다. 이전 V5–V9 시도와 증거는 변경 없이 보존한다.

## 승인된 개발 순서

1. 저장된 V9 증거에서 claim expiry 관측 timeout을 작은 재현으로 분석한다. lease나 원래 합격 기준을 완화하지 않는다. 원인이 미확정이면 작은 재현·관측을 보완하고, 원인과 수정 범위가 분명해질 때까지 장시간 전체 실행을 반복하지 않는다.
2. [V4 계획](./delivery/iteration-03/ADMISSION-UI-PLAN-v4.md)과 V3 계약을 따라 기존 I02 저장 흐름에 접수 API·화면을 증분 구현한다. 변경 source·환경·계약·ACL, 격리된 PostgreSQL/Temporal 데이터 경로와 정리 절차를 고정한 뒤, 좁은 실제 통합 시나리오로 저장 요청의 동일 job/run/receipt 연결을 확인한다. full490은 이 국소 통합 smoke의 선행조건이 아니다. 개발 중 mock은 빠른 화면 피드백에만 쓰고 실제 `QUEUED`는 일치하는 DB/Temporal receipt가 확인될 때만 표시한다.
3. 최소 mock 경로를 요청 등록부터 접수·결과 조회까지 끝까지 연결한다. 시연 가능 URL/캡처와 미검증 한계를 같이 전달한다.
4. 같은 job에서 사람 대기·제출·재개 및 새로고침/서비스 재시작 후 복구를 연결한다. 사람 제출 없이 단계를 자동 통과시키지 않는다.
5. 실제 저장소·toolchain·승인 환경이 준비되면 첫 사례인 I2C 읽기 오류 처리와 정상·실패 KUnit 검증을 수행한다. 실제 장비와 배포는 각각의 원래 승인·수용 절차를 따른다.

개발용 mock 흐름은 실제 엔진 수용을 기다리지 않고 구현·시연할 수 있다. 격리된 제한적 실제 DB/Temporal 통합 검사는 관련 계약·소스·환경 준비와 검토를 마친 뒤 수행할 수 있으며 full490보다 먼저 할 수 있다. 실제 엔진 전체 수용·H2 전체 검증·AT 인수 주장은 각각의 전체 증거가 확보될 때까지 보류한다. 전체 490건 및 독립 수용은 H2 통합/수용 게이트로 유지한다. 실제 runtime, DB, 장비를 대상으로 하는 실행은 그 자체의 검토·환경·실행 전 게이트를 통과해야 한다. 기존 V9 승인으로 새 후보 실행을 자동 승인하지 않는다.

## 진행 도구

저장소 루트에서 `npm run ifpmic:delivery`로 목표와 검사 범위를 확인한다. `npm run ifpmic:delivery:check`는 admission protocol/workspace 및 전달 도구의 선택 검사를 실행하고 DB/Temporal은 시작하지 않는다. `--level integration|acceptance`는 남은 조건을 보여준다. 이 높은 단계의 `--run` 실행기는 미구현이며 종료 코드 2로 실패한다. 제한된 실제 통합은 V4의 별도 준비·검토 절차로 수행한다. 준비가 완료된 별도 제한적 DB/Temporal 통합 검사는 V4 계획의 해당 검토·격리 절차로 수행한다. 상태 화면은 `/delivery.html`이고 `docs/ifpmic/delivery-plan.json`을 기준으로 렌더링한다.

## 첫 작업 절차

1. [주기03 기록](./delivery/iteration-03/README.md), V9 실행 상태와 실패 리뷰를 읽는다. private leaf는 로컬의 제한된 경로에만 보존하며 raw SQL, history, 인증, PID 자료를 공개하거나 삭제하지 않는다.
2. 실패 사례의 barrier·SQL snapshot·case timing을 이전 통과 증거와 비교한다. 추측을 확정 원인으로 쓰지 않는다.
3. 원인을 재현하는 가장 작은 검증을 설계하고, 검증의 입력·시간 한도·정리 여부를 기록한다. 코드 수정 전 변경 범위와 영향 검사를 정한다.
4. 현재 회차의 사용자 행동, 합격 조건, 관련 요구/AT, 선택 검증, 화면·캡처, 미검증 범위와 다음 조치 한 가지를 기록한다. 새 기능이 없으면 이를 명시한다.

## 실행 화면 및 증거 보존

과거 demo 재실행 절차는 [주기02 README](./delivery/iteration-02/README.md)를 따른다. 문서의 과거 검증 수치와 명령은 현재 서비스 가동 또는 새 실행 승인으로 간주하지 않는다. 최종 배포/외부 제출은 원래 승인 절차가 필요하다.

브랜치 `experiment/paperclip-workflow`의 최신 인계 지점은 이 문서를 갱신한 커밋으로 확인한다. 원본 ZIP/DOCX는 untracked 로컬 입력으로 유지한다. ignored `workflow-artifacts/`의 private evidence는 `git clean` 등으로 삭제하지 않는다.
