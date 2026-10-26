# IFPMIC AX 재개 안내 · 2026-10-26

## 목표와 진척

최종 목표는 제공된 IFPMIC 설계 계약의 전체 업무 흐름, 역할, 승인, 보안 경계 및 AT 수용이다. 중간 전달은 한 번에 사용자 흐름 하나를 완성해 확인하며, mock 결과를 실제 실행이나 최종 인수로 계산하지 않는다.

- 필수 단계: **2/16 = 12.5%**(동일 가중치 단계 수). 목표 전체는 미완료다.
- 전달됨: 29단계·6구간·41연결 탐색 화면 및 74개 합성 시나리오, mock 계정 기반 요청 등록·저장·조회.
- 최근 전달: `admission-mock`으로 I02 admission UI에서 저장 요청 상태를 조회한다. 모듈의 mock `pending`/`admitted`/`error`만 표시하며 queue/실행/receipt나 실제 `QUEUED`가 아니다. 계정별 시나리오 선택만 sessionStorage에 두고 reload 때 상태 제공자를 재조회한다. 실제 요청·계정 상태는 수정하지 않는다. 다음 별도 slice는 실제 read-only API와 SQL ACL tuple 확인(`admission-read`), 이어 격리된 실제 엔진 receipt(`admission-live`)다.
- 최신 V9 실제 H2: 490개 중 8개 실행, 7통과·1실패, 482미실행. 실패는 claim 만료의 DB-clock 관측 timeout이며 원인은 미확정이다. [실행 상태](./delivery/iteration-03/runtime-v9-execution-status.json) · [독립 실패 검토](./delivery/iteration-03/runtime-v9-attempt-01-result-review.json)
- V9 실행은 종료됐으며 자동 재시도하지 않았다. 154개 stdlib 검사 통과는 실제 H2 통과를 뜻하지 않는다. 이전 V5–V9 시도와 증거는 변경 없이 보존한다.

## 승인된 개발 순서

1. 제품 WIP는 하나로 제한한다. `admission-mock` UI 조회 흐름은 전달됐으며 다음은 `admission-read`다. 기본 전달 검사는 `delivery-tool`과 `admission-state` Node controller regression이며, 오프라인 fixture browser 검사는 `npm run ifpmic:admission:browser`로 명시 실행한다. V9 claim-expiry timeout 진단은 30분 checkpoint를 가진 지원 작업으로 별도 진행할 수 있고, 관련 실제 runtime 실행만 막는다.
2. 다음 `admission-read`에서 V3 계약의 실제 read-only API와 SQL ACL tuple을 확인하고, `admission-live`에서는 변경 source·환경·계약·ACL, 격리된 PostgreSQL/Temporal 경로와 정리 절차를 고정하고 독립 검토한 뒤 저장 요청 하나의 실제 receipt 연결을 확인한다. full490은 이 제한 통합의 선행조건이 아니다. 실제 `QUEUED`는 같은 엔진 receipt가 확인될 때만 표시한다.
3. 최소 mock 경로를 요청 등록부터 접수·결과 조회까지 끝까지 연결한다. 시연 가능 URL/캡처와 미검증 한계를 같이 전달한다.
4. 같은 job에서 사람 대기·제출·재개 및 새로고침/서비스 재시작 후 복구를 연결한다. 사람 제출 없이 단계를 자동 통과시키지 않는다.
5. 실제 저장소·toolchain·승인 환경이 준비되면 첫 사례인 I2C 읽기 오류 처리와 정상·실패 KUnit 검증을 수행한다. 실제 장비와 배포는 각각의 원래 승인·수용 절차를 따른다.

개발 slice별 필수 검사는 시작 전에 고정하고, 추가·반복은 변경 코드·실패 재현·미해결 우려에만 한정해 통과 시 멈춘다. 각 명령은 60초 이내 피드백을 목표로 한다. 30분 timeout 진단 초과 시 범위·소요시간 및 다음 한 조치를 보고하며 전체 suite를 자동 실행하지 않는다. 전달 CLI는 `--slice` 미지정 시 `delivery-plan.json`의 `plan.current_slice`를 쓰고, `--profile`은 선택 사항으로 slice allowlist의 부분집합을 고른다. `admission-mock` 기본은 `delivery-tool`과 `admission-state` Node controller 회귀 검사다. 오프라인 fixture UI browser 검사는 `npm run ifpmic:admission:browser`로 명시 선택한다. `admission-read/live` 기본은 두 profile을 실행한다. `delivery:check`는 선택된 profile만 실행한다. browser/build는 명시적 별도 검사다. 변경 경계 및 영향 경로만 검토하고, 실제 DB/Temporal 연결 전 바뀐 SQL/ACL/권한 trust boundary는 독립 검토한다. mock/read slice는 각각 전달 결과로 기록할 수 있지만 전체 admission 또는 AT 인수는 아니다. 전체 490건 및 독립 수용은 H2 통합/수용 게이트로 유지하며 과거 V9 승인으로 새 후보 실행을 승인하지 않는다.

## 진행 도구

저장소 루트에서 `npm run ifpmic:delivery`로 목표와 검사 범위를 확인한다. `npm run ifpmic:delivery:check`는 현재 slice의 선택된 profile만 실행하고 DB/Temporal을 시작하지 않는다. 현재 mock slice 기본은 `delivery-tool`과 `admission-state` Node controller regression이며, 오프라인 fixture browser 검사는 `npm run ifpmic:admission:browser`로 별도 실행한다. 두 검사는 실제 DB/Temporal을 사용하지 않는다. `--level integration|acceptance`는 남은 조건을 보여준다. 이 수준의 `--run`은 미구현이며 종료 코드 2로 실패한다. 실제 제한 통합은 V4의 별도 준비·독립 검토·격리 절차로 수행한다. 상태 화면은 `/delivery.html`이고 `docs/ifpmic/delivery-plan.json`을 기준으로 렌더링한다.

## 첫 작업 절차

1. 제품 구현 시 이 계획과 V4의 해당 slice 수용 기준·범위를 읽는다. 현재 결과와 다음 작업은 `delivery-plan.json`으로 확인한다. V9 private diagnosis evidence는 이 독립 slice의 선행자료가 아니다.
2. claim expiry timeout을 진단할 때에만 V9 실행 상태/리뷰 및 제한된 private evidence를 확인한다. raw SQL/history/인증/PID 자료를 공개하거나 삭제하지 않는다. 진단은 입력·시간 checkpoint·정리를 기록하고 UI/API/mock 개발을 차단하지 않는다.
3. 제품 slice 시작 전에 사용자 행동, 합격 조건, 관련 요구/AT, 필요한 검사만 고정한다. 추가 검사는 변경 코드·실패 재현·미해결 우려에 연결한다.
4. 화면/캡처, mock/real 구분, 미검증 범위와 다음 조치 한 가지를 기록한다. 새 기능이 없으면 이를 명시한다.

## 실행 화면 및 증거 보존

과거 demo 재실행 절차는 [주기02 README](./delivery/iteration-02/README.md)를 따른다. 문서의 과거 검증 수치와 명령은 현재 서비스 가동 또는 새 실행 승인으로 간주하지 않는다. 최종 배포/외부 제출은 원래 승인 절차가 필요하다.

브랜치 `experiment/paperclip-workflow`의 최신 인계 지점은 이 문서를 갱신한 커밋으로 확인한다. 원본 ZIP/DOCX는 untracked 로컬 입력으로 유지한다. ignored `workflow-artifacts/`의 private evidence는 `git clean` 등으로 삭제하지 않는다.
