# IFPMIC AX 재개 안내 · 2026-10-27

## 목표와 진척

최종 목표는 제공된 IFPMIC 설계 계약의 전체 업무 흐름, 역할, 승인, 보안 경계 및 AT 수용이다. 중간 전달은 사용자 흐름 하나씩 확인하며 mock 결과를 실제 실행이나 최종 인수로 계산하지 않는다.

- 필수 단계: **2/16 = 12.5%**(동일 가중치 단계 수). 목표 전체는 미완료다.
- 전달됨: 29단계·6구간·41연결 탐색 화면 및 74개 합성 시나리오, 요청 저장·조회, 실제 pending API/DB/UI read flow.
- `admission-live` normal-path candidate3에서 격리 PostgreSQL/Temporal의 실제 SDK run 1건/start 1건/phase `queued`, SQL job/command/binding/receipt 각 1건을 확인했다. Browser는 8개 확인을 통과했고 동일 키 POST 2회에도 실행 효과는 1회였다. A/B 권한 거부와 reload도 통과했다. clean restart에서는 POST 없이 같은 job/command/run/identity/count를 복원했다. 증거: `workflow-artifacts/delivery/admission-live/normal-20261027-03/`.
- candidate3의 다섯 자식(각 2회 실행 포함), API/issuer/PostgreSQL은 강제 종료 없이 정리됐다. API/runtime 45개 source는 actual run 전후 동일했다. execution context v2 `execution_connected` boolean은 연결 상태 관찰이지 receipt 증명이 아니다.
- 최신 V9 H2는 490건 중 8건 실행, 7통과·1실패·482미실행이다. claim-expiry DB-clock 관측 timeout 원인은 미확정이며 자동 재시도하지 않았다. candidate3 normal path는 V9 재시도, crash/reclaim 수용, full H2, AT32 또는 운영 인수가 아니다. 이전 V5–V9 후보와 실패 증거는 보존한다. [V9 상태](./delivery/iteration-03/runtime-v9-execution-status.json) · [독립 실패 검토](./delivery/iteration-03/runtime-v9-attempt-01-result-review.json)

## 다음 작업

다음 제품 흐름은 실제 서비스가 통제하는 최소 mock 실행 → 결과 저장 → 화면 조회다. mock 결과는 전체 29단계 실행이나 실제 IFPMIC 업무 결과로 표시하지 않는다. V9 claim-expiry 진단은 30분 checkpoint의 별도 지원 작업으로 진행할 수 있으며 관련 crash/reclaim 실행만 막는다.

1. `npm run ifpmic:delivery -- --flow minimal-mock`으로 다음 기본 slice `mock-result-contract`와 미구현 기능 검사를 확인한다. 합성 결과 조회 → 실제 저장 결과 조회 → 제한된 모의 실행 순이다. 구현 착수 시에만 JSON의 current flow/slice와 WIP를 갱신한다. 현재 선택은 마지막 전달인 admission-live다. `feedback_profiles`는 기본 검사, `allowed_feedback_profiles`는 필요 시 선택할 검사다. `npm run ifpmic:delivery:check`는 선택 profile만 실행하며 DB/Temporal을 시작하지 않는다.
2. 제품 코드 변경에는 해당 DTO/controller 등 관련 profile을 선택한다. 전달 도구 변경 시 `--profile delivery-tool`, supervisor 변경 시 live slice의 `--profile execution-owner`를 명시한다. 실행 시간/로그를 확인하고 통과한 검사를 보고용으로 반복하지 않는다. offline fixture browser가 필요할 때 `npm run ifpmic:admission:browser`를 명시 실행한다.
3. `--level integration|acceptance`는 남은 조건만 출력한다. 해당 수준의 `--run`은 미구현이고 종료 코드 2로 실패한다. candidate3 실행은 별도 명시된 launcher 경로 `--execution --execution-toolchain <absolute-private-H1-installation.json>`을 사용했다. 이는 재실행 승인으로 간주하지 않는다.
4. 다음 회차에서 화면/캡처, 실제와 mock의 구분, 미검증 범위, 다음 조치 하나를 기록한다. mock/read/live 중간 결과는 전체 admission이나 AT 인수가 아니다.

제품 WIP는 하나다. 전체 H2/full490과 독립 수용은 통합/수용 단계에 남으며 과거 검토·증거를 새 후보 승인으로 승계하지 않는다. 자세한 slice 경계와 결과는 [애자일 전달 계획](./AGILE-DELIVERY.md), [V4 계획](./delivery/iteration-03/ADMISSION-UI-PLAN-v4.md), [canonical delivery plan](./delivery-plan.json)을 따른다.

## 증거와 private 자료

V9 raw/private SQL, history, 인증 및 process identity 자료를 공개하거나 삭제하지 않는다. ignored `workflow-artifacts/`는 `git clean` 등으로 지우지 않는다. 최종 배포 및 외부 제출은 원래 승인 절차를 따른다.
