# IFPMIC AX 애자일 전달 계획

최종 제품 목표와 원본 요구사항·역할·승인·AT 인수 기준은 [PLAN](./PLAN.md) 및 설계 계약에 둔다. 이 문서는 사용자에게 결과를 전달하는 순서와 회차 운영만 정한다. 개발 중간 결과와 원본 업무의 최종 인수를 별도로 기록한다.

## 현재 체크포인트 · 2026-10-26

- 필수 단계 완료: **2/16 = 12.5%**(동일 가중치 단계 수, 작업량 추정이 아님).
- 전달된 사용자 흐름: 29단계·6구간의 설계 탐색 및 74개 합성 시나리오, 합성 계정/mock으로 요청을 저장·재조회하는 로컬 흐름.
- 다음 전달 목표: 아직 구현되지 않은 `admission-mock`으로 I02 admission UI에서 저장 요청 상태를 조회한다. 격리된 실제 PostgreSQL/Temporal 접수는 `admission-live` 후속 slice다. [V4 구현·검증 계획](./delivery/iteration-03/ADMISSION-UI-PLAN-v4.md)
- 최신 실제 H2 시도 V9: 490건 중 8건 실행, 7통과·1실패, 482건 미실행. 실패 원인은 DB 시간 기준 claim 만료 관측 timeout이며 아직 확정되지 않았다. [결과](./delivery/iteration-03/runtime-v9-execution-status.json) · [독립 실패 검토](./delivery/iteration-03/runtime-v9-attempt-01-result-review.json)
- V9 실제 엔진 실행은 자동 재시도하지 않는다. timeout 진단은 30분 checkpoint가 있는 지원 작업이며 관련 실제 runtime 실행만 차단한다. 원인 미확정이어도 독립 UI/API/mock 개발은 진행한다. 진단 시간이 넘으면 범위·소요시간과 다음 조치 한 가지를 보고하고 전체 검증을 자동 반복하지 않는다.
- 현재 제품 WIP는 1 slice다. 다음 활성 slice는 아직 구현되지 않은 `admission-mock`: I02 admission UI에서 저장된 요청 상태를 조회하는 mock-backed 흐름이다. `admission-read`는 실제 read-only API와 SQL ACL tuple, `admission-live`는 격리된 실제 엔진 receipt 확인을 각각 후속 slice로 둔다. 진단은 제품 WIP와 별도 지원 작업이다.

## 다음 사용자 흐름 순서

| 순서 | 한 회차의 사용자 결과 | 완료 신호와 경계 |
|---|---|---|
| 1. 요청 상태 표시 (`admission-mock`) | mock 상태 제공자로 저장된 I02 요청 상태를 UI에서 조회 | 다음 활성 slice이며 아직 구현되지 않았다. 명시적 mock 표기를 유지하고 실제 접수로 표시하지 않는다. |
| 2. 실제 read API (`admission-read`) | read-only API와 SQL ACL tuple로 같은 요청 상태 확인 | V3 tuple 의미를 보존하고 변경된 DB/API/ACL 경계를 검토한다. 실제 엔진 receipt를 만들거나 `QUEUED`로 승격하지 않는다. |
| 3. 실제 접수 (`admission-live`) | 저장 요청 하나를 격리된 PostgreSQL/Temporal에 접수하고 같은 job/run/receipt를 I02 화면에서 확인 | 변경된 source·환경·계약·ACL과 격리·cleanup 절차를 고정하고 독립 검토한 뒤 좁은 통합 검사. full490은 이 통합의 선행조건이 아니며 전체 H2/AT/운영 수용은 별도다. |
| 4. 모의 작업 완주 | 실제 로컬 서비스에서 제한된 모의 작업 한 건의 실행·결과 저장·조회 연결 | 실제 작업과 분리된 mock 모드임을 표시하고 상태 이력·재시작 경계를 확인한다. |
| 5. 사람 대기와 재개 | 질문/사람 제출 후 같은 작업이 이어지고 새로고침·재시작 뒤에도 상태를 복구 | 사람 역할과 원래 gate를 보존하며 응답 없는 자동 통과를 금지한다. |
| 6. 첫 실제 사례 | I2C 읽기 오류 처리와 정상·실패 KUnit 사례 확인 | 승인된 저장소·toolchain·품질 환경을 사용하고 소스, TC, 실제 실행 증거를 함께 수용한다. 장비·배포는 별도 승인이다. |

각 회차에서는 표의 행동 하나만 목표로 고정한다. 기술 기반 작업은 그 행동을 완료하는 데 필요한 범위로 제한하고, 독립적으로 보여줄 수 있는 사용자 결과가 생기면 다음 기반 작업 전에 전달한다.

## 진행 현황과 검사 도구

현재 흐름·완료 조건·상태는 저장소의 단일 기준 파일 `docs/ifpmic/delivery-plan.json`에 기록하고, 루트 `/delivery.html`에서 같은 데이터를 보여준다. 흐름이나 상태를 바꾸면 JSON을 함께 갱신한다. 대시보드에 표시된 단계 완료 수는 원본 필수 단계의 수용 상태를 대체하지 않는다.

- `npm run ifpmic:delivery`: 기본 목표 행동과 검사 범위를 출력한다. `--slice` 생략 시 `delivery-plan.json`의 `plan.current_slice`를 사용한다. `--profile`은 선택 사항이며 slice allowlist의 부분집합을 지정한다. 현재 `admission-mock`은 기본 `delivery-tool`만, `admission-read/live`는 기본 `delivery-tool`과 `admission-local`을 선택한다. mock의 미구현 UI browser 검사는 `checks_to_add`에 표시한다.
- `npm run ifpmic:delivery:check`: 현재 slice/profile에서 선택된 검사만 실행하며 DB/Temporal/서비스를 시작하지 않는다. `admission-mock` 기본 실행은 Node 전달 도구 검사만 수행하고 Python protocol/workspace 검사를 항상 함께 실행하지 않는다. `admission-read/live` 기본 실행은 두 profile을 수행한다.
- `--level integration` 또는 `--level acceptance`: 해당 단계의 남은 필수 조건을 출력한다. `--level integration|acceptance --run` 실행기는 미구현이며 종료 코드 2로 실패한다. 이 CLI 제한은 V4 절차에 맞게 준비·검토된 별도 실제 DB/Temporal 통합 실행을 막지 않는다.
- slice별 필수 검사는 작업 전에 고정한다. 추가·반복은 변경 코드, 실패 재현 또는 미해결 우려에만 한정하고 통과하면 멈춘다. 각 명령의 피드백 목표는 60초 이내다. browser 및 build 검사는 별도 명시 선택이며 기본 묶음에 포함된 것으로 간주하지 않는다. 검토는 변경된 코드·trust boundary와 그 영향 경로에 한정하고 손대지 않은 전체 source의 반복 검토를 요구하지 않는다. 실제 DB/Temporal 연결 전 변경된 SQL/ACL/권한·개인정보 경계는 독립 검토한다.

선택한 검사의 통과는 개발 피드백이다. 사용자 흐름·UI 상태나 전체 인수 상태를 자동 승격하지 않는다. 기존 full490 runner와 원본 H2 수용 조건은 별도로 보존한다.

## 검증과 완료 보고

개발 중에는 각 slice 시작 시 정한 변경 경계의 검사와 필요한 회귀만 선택한다. 좁은 mock 검증은 화면 흐름·상태 연결을 개발하는 데 쓸 수 있다. browser/build는 필요한 경우 각각 명시해서 실행한다. source·환경·계약·권한·격리·자원 정리가 준비되고 실제 DB/Temporal 경계를 독립 검토한 뒤 제한된 로컬 통합 검사를 허용하며, 결과와 범위를 보고한다. 이는 실제 전체 H2, AT, 장비 실행 또는 운영 준비를 수용했다는 뜻이 아니다. 실제 경로의 보안·권한·개인정보·멱등성 조건은 해당 단계의 계약과 검증을 유지한다.

한 번 실패하면 원시/private 증거와 실행 후보를 고정하고, 해당 실패를 작은 재현으로 좁힌다. 원인·변경 범위·영향받는 검사·복구 방법을 기록한다. 검사 범위를 넓히거나 반복하는 경우는 변경 코드, 실패 조건 또는 미해결 우려가 근거여야 하며 관련 검사 통과 뒤 멈춘다. 진단의 30분은 checkpoint와 범위 재설정 기준이지 테스트나 승인 완화가 아니다. 초과 시 범위·소요시간과 다음 한 조치를 보고한다. full490은 slice의 자체 준비·검토 완료 전 실행하지 않으며 통합/수용 단계에서 수행한다. `admission-mock`과 `admission-read` 각각의 완료는 사용자 결과로 전달·기록할 수 있지만 전체 admission이나 AT 수용으로 표시하지 않는다. 기존 V9 승인·실패 결과는 후속 후보의 승인으로 재사용하지 않는다.

회차 종료 시 다음 항목을 짧게 보고한다.

- 사용자가 새로 할 수 있는 행동과 URL/캡처
- mock/실제 구분, 목표·통과·실패한 검사와 아직 검증하지 않은 경계
- 완료된 사용자 흐름과 16단계 완료 수를 별도 표기
- 실패 원인과 다음 조치 한 가지
- 관련 커밋과 push 상태

새 사용자 기능이 없으면 **새 기능 없음**이라고 밝힌다. 테스트 건수·문서 수·커밋 수를 제품 진척률로 환산하지 않는다. 기존 증거와 역사적 세부는 [주기03 기록](./delivery/iteration-03/README.md), [재개 안내](./RESUME.md), 커밋 이력에서 확인한다.
