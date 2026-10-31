# IFPMIC AX 애자일 전달 계획

최종 제품 목표와 원본 요구사항·역할·승인·AT 인수 기준은 [PLAN](./PLAN.md) 및 설계 계약에 둔다. 이 문서는 사용자에게 결과를 전달하는 순서와 회차 운영만 정한다. 개발 중간 결과와 원본 업무의 최종 인수를 별도로 기록한다.

## 현재 목표 · 2026-10-31

- 사용자에게 전달할 결과는 **실제로 동작하는 AX 워크플로**와 **실행에 적용되는 에이전트별 지침 파일** 두 가지다. 현재 사용자 흐름은 `agent-analysis`이며, 기존 `mock-task-live`의 부분 구현과 미완료 상태는 후속 작업으로 보존한다. 제품 작업은 동시에 하나만 진행한다.
- 첫 에이전트 pilot은 로컬 Codex CLI adapter로 P01/P02 요청 분석을 수행해 검토·수정 가능한 실제 산출물을 만들고, 사용자가 결과를 확인하는 시연을 제공한다. P03에는 진입하지 않고 멈춘다. 이 pilot은 adapter 연동 확인이며 IFPMIC job, gate, 단계 전이를 생성하거나 완료하지 않는다.
- 다음 흐름은 P03–P05 분석 산출물과 사람 담당 X01 실행 경로다. 이후 code-dev/TC는 사람 담당 P06–P10의 선행 확인을 지킨다. arch-runner는 등록된 도구 wrapper만, SQE는 승인된 bridge 또는 수동 증거만 다룬다. report 역할은 승인·배포 실행을 맡지 않는다.
- Paperclip은 과거 AX 실행의 참고 자료이며 선택 가능한 관제 화면이다. 새 에이전트 실행의 필수 의존성이나 별도 업무 상태 결정 주체로 추가하지 않는다. API/Temporal 연동 뒤에도 기존 IFPMIC runtime만 업무 상태를 결정한다.
- 각 작업 단위는 실제 산출물과 사용자 시연·피드백을 남긴다. 시작 때 변경 경계에 맞는 검사만 정하고, UI 변경은 해당 시연과 browser 검사, 지침 변경은 pilot 산출물과 역할 경계 검사, source/DB/runtime 변경은 영향받는 검사를 선택한다. 일반 변경에서 전체 검사 묶음을 실행하지 않는다. 전체 H2/AT와 보안·권한·개인정보 경계는 원래 수용 단계에서 유지한다.

### 이번 전달: 실제 로컬 분석

`npm run ax:analyze -- --input examples/analysis-request.json`로 실제 로컬 Codex(`gpt-6-luna`)가 공개 합성 요청의 P01/P02를 실행했다. 결과는 요구사항 3개·검증 가능한 기대 동작·변경 영향이며, 두 단계의 지침 해시가 일치한다. 결과와 실패 이력·소스 해시는 `delivery-plan.json`의 `agent-analysis/analysis-local.evidence`에 연결했다. 보고서는 `workflow-artifacts/analysis/a41a3b9f-4316-45c7-a9f9-aa28e41e269c/report.md`다.

첫 호출은 완료 상태와 누락 입력이 함께 반환되어 실패로 보존했다. 짧은 단일 호출로 원인을 확인한 뒤 현재 단계 필수 입력과 후속 환경 준비를 구분하도록 출력 계약과 프롬프트를 수정했다. 모순 응답을 거부하는 조건과 회귀 검사는 유지했다. 실제 업무 job/Temporal·코드 수정·Bedrock·장비·배포·전체 인수는 수행하지 않았다. 다음 행동은 결과와 지침에 대한 사용자 코멘트를 받은 뒤 같은 저장 요청의 분석 실행·결과 화면을 연결하는 것이다.

## 이전 체크포인트 · 2026-10-27 (기록)

- 필수 단계 완료: **2/16 = 12.5%**(동일 가중치 단계 수, 작업량 추정이 아님).
- 현재 제품 흐름: minimal-mock. `mock-result-contract` 합성 화면과 `mock-result-read` 실제 저장 결과 조회를 전달했다. 다음은 실제 제한된 모의 작업 실행이며 상위 흐름은 진행 중이다.
- 전달된 사용자 흐름: 29단계·6구간의 설계 탐색 및 74개 합성 시나리오, 합성 계정/mock으로 요청을 저장·재조회하는 로컬 흐름.
- 최근 전달: `admission-live` normal-path candidate3에서 격리 PostgreSQL/Temporal의 실제 접수와 I02 browser 확인을 마쳤다. 저장 요청 한 건이 동일 job/command/run/sequence-1 receipt로 `QUEUED`가 되었고, browser 8개 확인, 두 번의 정확한 idempotency-key POST에도 효과는 한 번이었다. 사용자 A/B 권한 거부와 reload 확인도 통과했다. 실제 clean restart는 POST 0건으로 기존 job/command/run과 identity/count를 보존했다. [V4 범위·절차](./delivery/iteration-03/ADMISSION-UI-PLAN-v4.md)
- 최신 실제 H2 시도 V9: 490건 중 8건 실행, 7통과·1실패, 482건 미실행. 실패 원인은 DB 시간 기준 claim 만료 관측 timeout이며 아직 확정되지 않았다. [결과](./delivery/iteration-03/runtime-v9-execution-status.json) · [독립 실패 검토](./delivery/iteration-03/runtime-v9-attempt-01-result-review.json)
- V9 실제 엔진 실행은 자동 재시도하지 않는다. timeout 진단은 30분 checkpoint가 있는 지원 작업이며 관련 실제 runtime 실행만 차단한다. 원인 미확정이어도 독립 UI/API/mock 개발은 진행한다. 진단 시간이 넘으면 범위·소요시간과 다음 조치 한 가지를 보고하고 전체 검증을 자동 반복하지 않는다.
- 실행 증거 `workflow-artifacts/delivery/admission-live/normal-20261027-03/`은 실제 SDK run 1건/start 1건/phase `queued`, SQL job/command/binding/receipt 각 1건, A/B deny, clean restart에서 같은 단일 run을 확인한다. 다섯 자식(각 2회 실행 포함)과 API/issuer/PostgreSQL은 force 없이 종료됐다. API/runtime 45개 source는 실제 run 전후 동일했다. context v2 `execution_connected` boolean은 상태 관찰이며 receipt 증거가 아니므로 화면의 `QUEUED` 판정과 분리한다. 최신 V9의 crash/reclaim claim-expiry 원인은 여전히 inconclusive이며 이 candidate는 V9 retry, 전체 H2/full490, 원본 AT, 운영 준비 수용이 아니다. 기존 실패 `normal-01/-02`는 보존됐다.
- 제품 WIP는 하나로 유지한다. 현재 사용자 흐름은 실제 서비스가 통제하는 최소 mock 실행→결과 저장→화면 조회다. 첫 합성 결과 화면 이후 실제 조회·실행을 연결한다. mock 결과는 실제 IFPMIC 작업이나 전체 29단계 실행으로 표시하지 않는다. V9 진단은 별도 지원 작업으로 계속할 수 있으며 관련 crash/reclaim과 전체 수용만 막는다.

## 이전 사용자 흐름 순서 · 2026-10-27 계획 기록

| 순서 | 한 회차의 사용자 결과 | 완료 신호와 경계 |
|---|---|---|
| 1. 요청 상태 표시 (`admission-mock`) | mock 상태 제공자로 저장된 I02 요청 상태를 UI에서 조회 | 독립 전달 단위. mock 표기를 유지하고 실제 접수로 표시하지 않는다. |
| 2. 실제 read API (`admission-read`) | read-only API와 SQL ACL tuple로 같은 요청 상태 확인 | V3 tuple 의미를 보존하고 변경된 DB/API/ACL 경계를 검토한다. 실제 엔진 receipt를 만들거나 `QUEUED`로 승격하지 않는다. |
| 3. 실제 접수 (`admission-live`) | 저장 요청 하나를 격리된 PostgreSQL/Temporal에 접수하고 같은 job/run/receipt를 I02 화면에서 확인 | candidate3 normal path는 별도 후보로 확인했다. crash/reclaim, 전체 H2/AT/운영 수용은 미완료이며 기존 acceptance 게이트와 별도로 남는다. |
| 4. 모의 작업 완주 | 실제 로컬 서비스에서 제한된 모의 작업 한 건의 실행·결과 저장·조회 연결 | 실제 작업과 분리된 mock 모드임을 표시하고 상태 이력·재시작 경계를 확인한다. |
| 5. 사람 대기와 재개 | 질문/사람 제출 후 같은 작업이 이어지고 새로고침·재시작 뒤에도 상태를 복구 | 사람 역할과 원래 gate를 보존하며 응답 없는 자동 통과를 금지한다. |
| 6. 첫 실제 사례 | I2C 읽기 오류 처리와 정상·실패 KUnit 사례 확인 | 승인된 저장소·toolchain·품질 환경을 사용하고 소스, TC, 실제 실행 증거를 함께 수용한다. 장비·배포는 별도 승인이다. |

각 회차에서는 표의 행동 하나만 목표로 고정한다. 기술 기반 작업은 그 행동을 완료하는 데 필요한 범위로 제한하고, 독립적으로 보여줄 수 있는 사용자 결과가 생기면 다음 기반 작업 전에 전달한다.

## 진행 현황과 검사 도구

### 이번 리팩토링의 판단과 실행 순서

기존 규칙은 좁은 개발 검증을 허용하지만 도구는 `admission` 이름에 고정되어 있었다. 다음 흐름에는 slice가 없어 같은 실행 도구로 착수할 수 없었고, 제품 코드만 바뀌어도 전달 도구 자체의 검사와 supervisor 검사가 기본 묶음에 따라붙었다. 이 결합을 제거한다. 과거 모델 사용량의 정확한 비중은 이 자료만으로 산정할 수 없으며, 실행 시간은 검증 비용을 관찰하는 지표로 사용한다.

`delivery-plan.json`의 `feedback_profiles`는 기본 실행 목록이고 `allowed_feedback_profiles`는 필요할 때 명시 선택할 수 있는 목록이다. 새 흐름도 같은 CLI를 쓰며 `--flow`만 선택하면 해당 흐름의 `default_slice`를 출력한다. 현재 선택과 기본 검사는 JSON을 따른다. minimal-mock의 첫 결과 화면 slice를 전달했고 상위 흐름은 진행 중이다.

다음 minimal-mock은 **합성 결과 조회 화면 → 저장 결과의 실제 조회 → 실제 서비스의 제한된 모의 실행**으로 나눈다. 각 slice는 이전 slice의 통과 증거를 보존하고 바뀐 경계만 다시 검사한다. 후속 사람 대기/재개와 I2C 사례도 JSON에 착수 가능한 slice로 나눴다. 아직 구현되지 않은 slice의 기본 `delivery-tool`은 계획/선택 도구만 검사한다. `checks_to_add`의 기능 검사를 구현하고 코드에 고정 profile로 등록하기 전에는 기능 검증 완료로 보고하지 않는다.

| 변경 경계 | 개발 피드백 | 통합 시 확인 |
|---|---|---|
| 결과 DTO·순수 계산 | 정상/오류 identity·금지 필드 등 변경 계약만 검사 | 해당 API 소비 경로 |
| 화면 상태 controller | 대기·완료·오류·계정/작업 전환 | 바뀐 사용자 흐름의 browser/캡처 |
| SQL·권한·API | 순수 DTO와 쿼리 경계 검토 | 변경된 ACL·멱등성·visibility의 격리 DB 검사 |
| Temporal activity·supervisor | 활동 재시도·identity·정리의 관련 검사 | 준비된 단일 실제 경로와 필요한 복구 사례 |
| 전달 계획·검사 도구 | `delivery-tool` | 제품 DB/Temporal 실행 불필요 |

개발 반복마다 browser·build·전체 runtime을 묶지 않는다. UI/사용자 경로 변경에는 해당 시연과 browser 검사를, 역할 지침 변경에는 pilot 산출물과 역할 경계 검사를 선택한다. TypeScript/번들 영향이 있으면 해당 검사 또는 build를 선택하고, 계약 변경이 소비자에 영향을 주면 그 소비 경로까지 넓힌다. 실제 DB/Temporal 연결 전 변경된 보안 경계의 독립 검토와 최종 전체 수용은 유지한다. 같은 source·환경·검사 범위에서 통과한 검사를 마무리 보고용으로 다시 실행하지 않는다. 실패 시 해당 검사 묶음에서 멈추고 기록의 로그와 소요시간으로 작은 재현을 선택한다.

### 다음 실행 계층의 설계 경계

제한된 모의 작업은 순수 evaluator, 저장/권한 repository, Temporal activity, 화면 controller로 분리한다. evaluator는 정제된 입력만 받고 DB·네트워크·장비 없이 검사할 수 있게 한다. 저장 계층은 job/command/run identity와 같은 결과의 재시도 멱등성을 책임지고, activity는 기존 실제 접수 이후에만 이를 호출한다. 실행 모드는 workflow replay에서 재현 가능하도록 기록된 입력/활동 결과로 전달한다.

작업 결과의 pending/completed와 전체 job 상태는 별도 계약으로 둔다. 모의 작업 성공만으로 `QUEUED`를 전체 업무 완료로 바꾸거나 P01·사람 승인 단계를 통과시키지 않는다. API는 기존 visibility 경계를 사용하고 화면은 원시 자료 없이 정제된 모의 결과만 표시한다. 이 구조를 차례로 구현하며 전체 29단계 엔진을 먼저 완성할 필요가 없도록 한다.

2026-10-26 과거 도구 정비 기록: 전달 CLI/계획 집중 검사 10건, `--profile delivery-tool` wrapper 569ms, TypeScript 검사가 통과했다. 결과는 `workflow-artifacts/delivery/2026-10-26T16-00-12.091Z-33518/result.json`에 보존한다. 최초 검사에서 새 작업 단위 식별자와 화면 제목을 혼동한 assertion 하나를 수정한 뒤 해당 검사만 재확인했다. 새 제품 기능은 없었다. DB/Temporal/browser/full490은 당시 변경 검증에 실행하지 않았고 필수 단계 완료는 2/16이었다.

현재 흐름·완료 조건·상태는 저장소의 단일 기준 파일 `docs/ifpmic/delivery-plan.json`에 기록하고, 루트 `/delivery.html`에서 같은 데이터를 보여준다. 흐름이나 상태를 바꾸면 JSON을 함께 갱신한다. 당시 read 작업 단위의 기본 검사는 `mock-task-dto`와 `mock-task-read-state`였으며 Python DTO 17건과 공유 조회 controller의 Node 12건만 실행했다. 대시보드에 표시된 단계 완료 수는 원본 필수 단계의 수용 상태를 대체하지 않는다.

- `npm run ifpmic:delivery`: 기본 목표 행동과 검사 범위를 출력한다. 현재 흐름은 `plan.current_slice`, 다른 `--flow`는 해당 흐름의 `default_slice`를 사용하고 `--slice`로 덮어쓸 수 있다. `--profile`은 해당 slice의 허용 목록에서 선택한다. `admission-mock` 기본은 `admission-state`, `admission-read`는 `admission-dto`·`admission-read-state`, `admission-live`는 `admission-context`·`admission-local`이다. 오프라인 UI browser는 `npm run ifpmic:admission:browser`로 별도 명시한다.
- `npm run ifpmic:delivery:check`: 선택된 검사만 실행하며 DB/Temporal/서비스를 시작하지 않는다. 기본 실행은 JSON의 `feedback_profiles`를 따른다. 전달 도구 변경 시 `--profile delivery-tool`, supervisor 변경 시 `--flow admission --slice admission-live --profile execution-owner`를 명시한다. profile별/전체 실행 시간을 출력하고 private 결과에 남긴다.
- `--level integration` 또는 `--level acceptance`: 해당 단계의 남은 필수 조건을 출력한다. `--level integration|acceptance --run` 실행기는 미구현이며 종료 코드 2로 실패한다. 이 CLI 제한은 V4 절차에 맞게 준비·검토된 별도 실제 DB/Temporal 통합 실행을 막지 않는다.
- slice별 필수 검사는 작업 전에 고정한다. 추가·반복은 변경 코드, 실패 재현 또는 미해결 우려에만 한정하고 통과하면 멈춘다. 각 명령의 피드백 목표는 60초 이내다. browser 및 build 검사는 별도 명시 선택이며 기본 묶음에 포함된 것으로 간주하지 않는다. 검토는 변경된 코드·trust boundary와 그 영향 경로에 한정하고 손대지 않은 전체 source의 반복 검토를 요구하지 않는다. 실제 DB/Temporal 연결 전 변경된 SQL/ACL/권한·개인정보 경계는 독립 검토한다.

선택한 검사의 통과는 개발 피드백이다. 사용자 흐름·UI 상태나 전체 인수 상태를 자동 승격하지 않는다. 기존 full490 runner와 원본 H2 수용 조건은 별도로 보존한다.

## 검증과 완료 보고

개발 중에는 각 작업 단위 시작 시 정한 변경 경계의 검사와 필요한 회귀만 선택한다. 각 전달은 사용자가 확인할 시연과 살펴볼 수 있는 실제 산출물을 포함한다. 좁은 mock 검증은 화면 흐름·상태 연결을 개발하는 데 쓸 수 있다. browser/build는 필요한 경우 각각 명시해서 실행한다. source·환경·계약·권한·격리·자원 정리가 준비되고 실제 DB/Temporal 경계를 독립 검토한 뒤 제한된 로컬 통합 검사를 허용하며, 결과와 범위를 보고한다. 이는 실제 전체 H2, AT, 장비 실행 또는 운영 준비를 수용했다는 뜻이 아니다. 에이전트 pilot 역시 IFPMIC 업무 단계/gate를 완료하지 않는다. 실제 경로의 보안·권한·개인정보·멱등성 조건은 해당 단계의 계약과 검증을 유지한다.

한 번 실패하면 원시/private 증거와 실행 후보를 고정하고, 해당 실패를 작은 재현으로 좁힌다. 원인·변경 범위·영향받는 검사·복구 방법을 기록한다. 검사 범위를 넓히거나 반복하는 경우는 변경 코드, 실패 조건 또는 미해결 우려가 근거여야 하며 관련 검사 통과 뒤 멈춘다. 진단의 30분은 checkpoint와 범위 재설정 기준이지 테스트나 승인 완화가 아니다. 초과 시 범위·소요시간과 다음 한 조치를 보고한다. full490은 slice의 자체 준비·검토 완료 전 실행하지 않으며 통합/수용 단계에서 수행한다. `admission-mock`과 `admission-read` 각각의 완료는 사용자 결과로 전달·기록할 수 있지만 전체 admission이나 AT 수용으로 표시하지 않는다. 기존 V9 승인·실패 결과는 후속 후보의 승인으로 재사용하지 않는다.

회차 종료 시 다음 항목을 짧게 보고한다.

- 사용자가 새로 할 수 있는 행동과 URL/캡처
- mock/실제 구분, 목표·통과·실패한 검사와 아직 검증하지 않은 경계
- 완료된 사용자 흐름과 16단계 완료 수를 별도 표기
- 실패 원인과 다음 조치 한 가지
- 관련 커밋과 push 상태

새 사용자 기능이 없으면 **새 기능 없음**이라고 밝힌다. 테스트 건수·문서 수·커밋 수를 제품 진척률로 환산하지 않는다. 기존 증거와 역사적 세부는 [주기03 기록](./delivery/iteration-03/README.md), [재개 안내](./RESUME.md), 커밋 이력에서 확인한다.

## 이전 전달 · admission-mock

I02 작업 상세에서 모의 접수 대기·접수됨·조회 실패를 선택하고 다시 조회할 수 있다. 작업/계정 변경은 이전 응답을 폐기하고 같은 탭 reload는 해당 계정의 선택 작업·모의 상황을 복원한다. 실제 저장 상태와 엔진은 변경하지 않는다.

관련 Node 검사 13건과 오프라인 I02 browser 8개 확인 항목을 통과했다. 합성 데스크톱·375px 캡처와 report는 `workflow-artifacts/delivery/admission-mock/2026-10-26T14-22-59-553Z/`에 있다. 초기 browser harness의 context route·selector 오류 기록은 별도 보존했고 해당 harness 수정 후 재확인했다. 실제 DB/Temporal 및 full490은 실행하지 않았다. 사용자 흐름 전달만 추가하며 필수 16단계 수용 수는 2/16으로 유지한다. 다음 행동은 `admission-read`의 실제 read API/SQL과 관련 ACL·tuple 검사 구현이다.


## 이번 전달 · admission-read

사용자는 I02 작업 상세에서 실제 저장된 접수 상태를 조회하고, 같은 작업을 다시 확인하거나 reload로 복원할 수 있다. API는 기존 `VISIBLE`과 CREATE command·read function을 한 statement snapshot에서 확인한다. 새 SQL 함수는 정적 STABLE SECURITY DEFINER이고 API runtime에만 EXECUTE를 추가한다. 실제 SQL/권한·격리 launcher·브라우저 정리 경계를 구현자와 별도로 검토한 뒤 실행했다.

순수 DTO 17건과 브라우저 상태 controller 6건, 격리 PostgreSQL의 API/ACL/함수 권한·조회 전용 검사 및 합성 SQL 다섯 상태 분류가 통과했다. 최초 DB 검사 준비 실패는 새 API 검사를 H2 watchdog에 잘못 연결한 fixture 문제였으며, 해당 새 경로만 분리해 원래 H2 시간 기준을 유지했다. 별도 실제 I02 browser는 합성 계정의 요청 한 건을 저장하고 실제 API/DB의 pending·재조회·reload를 확인했다. source 41개 before/after 일치, owned API/OIDC/PG 정리와 브라우저 종료를 확인했다. 증거는 `workflow-artifacts/delivery/admission-read/ui-20261026-01/`에 보존한다. 실제 Temporal 접수나 full490/AT는 실행·수용하지 않았으며 단계 수는 2/16으로 유지한다.

후속 actual normal-path candidate3는 별도 격리 후보로 실행했으며 그 결과와 한계는 위 current checkpoint 및 V4 기록에 둔다. 다음 제품 흐름은 실제 서비스가 통제하는 최소 mock 실행과 결과 조회다. V9 claim-expiry 진단은 별도 지원 작업으로 유지하고 원인 확정 전 full490이나 장시간 runtime suite를 반복하지 않는다.

실제 browser 최초 캡처의 짧은 계정/작업 식별자 표시를 보완해, 같은 격리 작업을 POST 없이 재조회하는 `--read-existing` 모드로 공개용 alias 캡처를 다시 만들었다. `ui-20261026-01/recapture/browser/`의 캡처와 정리 기록이 최종 화면 증거다. 제품 source는 그대로였으며 요청을 추가 저장하지 않았다.

후속 full H2 후보는 새 claim observer module과 private `claim-expiry-observation.json`을 source/raw inventory에 포함해 검토해야 한다. 기존 V9 source pin·raw 정책을 새 코드의 승인으로 재사용하거나 기존 full runner를 자동 재실행하지 않는다. 이는 정상 접수 전달과 별도의 전체 수용 준비다.


## 이번 전달 · mock-result-contract

I02에서 저장 요청을 선택하면 ‘모의 작업 결과’의 대기·완료·조회 실패를 합성 데이터로 체험할 수 있다. 순수 DTO/provider/controller와 DOM panel을 분리했고, 데이터는 정해진 결과 세 항목만 허용한다. 전체 job 상태나 실제 접수 영수증을 수정하지 않는다. 계정/작업 전환은 응답을 취소·폐기하고, 오류에서는 마지막 확인 결과를 표시한다. reload 때 계정별 job/scenario만 복원하며 결과·실행 ID·인증 자료를 저장하지 않는다.

frontend-design 스킬에 따라 기존 네이비/민트 관제 화면을 유지하고 합성 결과는 앰버 테두리와 ‘화면 체험’, ‘예시’ 문구로 구분했다. 데스크톱/375px 캡처를 검토했으며 가로 넘침 없이 표시된다. 결과 계약/상태 검사 6건, 전달 도구 검사 10건, 해당 I02 browser 9개 확인이 통과했다. schema 검사 추가 후 기본 피드백은 `mock-task-state`만 333ms에 통과했다. `npm run build`는 계획 현황판 및 TypeScript/번들 영향을 확인한다.

상태 증거: `workflow-artifacts/delivery/2026-10-26T16-07-16.169Z-34287/result.json`. Browser/capture: `workflow-artifacts/delivery/mock-result-contract/2026-10-26T16-05-16-613Z/`. 최종 계획 반영 뒤 build와 현황판 offline browser 3개 확인도 통과했다. 현황판 증거는 `workflow-artifacts/delivery/browser/2026-10-26T16-09-07-282Z-34400/result.json`에 둔다. 실제 결과 API/DB 저장·Temporal 모의 실행·full490/AT는 이번 slice에서 검증하지 않았다. 상위 minimal-mock은 미완료, 원본 필수 단계는 2/16이다. 다음 행동은 mock-result-read의 visibility·job/command/run 경계를 보존한 실제 조회 API 구현이다.


## 이번 전달 · mock-result-read

저장된 모의 결과를 `GET /api/v1/jobs/{job_id}/mock-task`로 조회한다. API의 한 statement에서 기존 VISIBLE, CREATE command 및 SECURITY DEFINER 읽기 함수의 job/project/command/owner를 맞추고, 결과가 있으면 admission·첫 receipt·binding/run/build·workspace token/generation과 모의 결과 형식을 확인한다. runtime에 읽기 함수 EXECUTE만 추가하며 결과 테이블 직접 권한과 실행·기록 함수는 주지 않았다. 과거 미완성 초안은 private 자료에 보존하고 실행 writer는 다음 migration으로 분리한다.

I02의 실제 저장 결과는 민트, 합성 예시는 앰버로 구분한다. pending은 저장 결과 없음이며 실행 진행을 추정하지 않는다. 공유 GET controller는 대기 때만 1/2/4/5초 간격으로 최대60초 확인하고 완료·오류·권한 거부에 멈춘다. 503은 마지막 결과를 보존하고 계정/작업 변경·401/403은 지운다. 결과·인증 자료를 sessionStorage에 저장하지 않는다. frontend-design 방향을 유지하며 실제 화면의 데스크톱/375px 캡처를 확인했다.

기본 피드백 DTO17+Node12건은 793ms에 통과했다. API annotation이 추가된 JSON schema는 기존 mock 계약 검사6건으로 확인했고 전달 도구10건도 통과했다. 격리 DB/API 5개 case는 fail-fast 실행에서 통과한 case를 다시 돌리지 않고 누적 확인했다. 준비 실패(인터프리터/pytest 경로, fixture UUID 직렬화·중복 seed·불변 command 변경·tuple 역할 접근)를 보존하고 해당 fixture를 수정했다. `focused-db-summary.json`에 case별 JUnit을 연결한다. 실제 연결 전 변경 SQL/권한과 격리/정리를 구현자와 분리해 검토했다.

오프라인 실제 조회 패널 browser는8항목을 통과했다. 실제 API/PG/browser는 첫 저장 요청 한 건 이후 `--read-existing`으로 추가 POST0건, pending 동일 job/command 조회·재조회·reload·B403을 확인했다. 최초 actual capture 검사의 `null !== false`는 실행 ID가 없을 때 조건식이 null을 반환한 도구 오류였으며 순수 JS 재현 후 boolean guard로 수정했다. 정리 뒤 포트 probe의 TIME_WAIT 준비 실패는 listener 부재를 확인하고 HTTP 서버와 같은 SO_REUSEADDR probe로 바로잡았다. 모든 이전 증거는 보존한다.

실제 read 후보03은9항목 통과, DB job/command 각1·mock result/binding/receipt 각0이다. API/issuer/PG/browser는 force 없이 정리됐고 source50개 hash가 실제 실행 전후 일치했다. 독립 결과 검토도 이 범위를 확인했다. 완료 결과는 합성 SQL seed 및 offline UI 근거이며 실제 Temporal 모의 실행·full490/AT는 실행/수용하지 않았다. 필수 단계는2/16을 유지한다.

최종 staged 검사에서 공유 controller의 EOF 빈 줄 하나만 제거했다. archive와 변경 파일의 trailing-whitespace 제외 바이트가 같음을 확인했고 `actual-ui-driver-03/whitespace-followup.json`에 해시 차이를 기록했다. 동작 변경이 없어 실제 서비스를 재실행하지 않았다.

- 기본 피드백: `workflow-artifacts/delivery/2026-10-26T16-28-14.478Z-38241/result.json`
- DB/API case별 누적 근거: `workflow-artifacts/delivery/mock-result-read/focused-db-summary.json`
- Offline browser8항목: `workflow-artifacts/delivery/mock-result-read/2026-10-26T16-17-42-039Z/report.json`
- 실제 pending browser9항목·source·DB readback·cleanup·캡처: `workflow-artifacts/delivery/mock-result-read/actual-ui-driver-03/`

다음 행동은 mock-task-live: 실제 접수 뒤 제한된 모의 activity 한 건을 실행하고 같은 job/run에 결과를 멱등 저장한다. 전체 job/P단계/사람 승인을 완료 처리하지 않는다.
