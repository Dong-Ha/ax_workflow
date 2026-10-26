# 주기03 — 요청 접수 결과를 화면에서 확인

## 사용자 목표

저장 요청 한 건이 실행 엔진에 접수되면, 요청 상세 화면에서 같은 job의 run/receipt와 `QUEUED` 상태를 확인한다. `QUEUED`는 최초 실행 접수 상태이며 업무 완료나 품질 판정이 아니다.

## 현재 상태 · 2026-10-26

- 설계 탐색 29단계·6구간·41연결과 74개 합성 시나리오를 전달했다.
- 주기02에서 합성 OIDC/mock 프로파일로 실제 로컬 API/PostgreSQL 요청 등록·조회·새로고침을 확인했다. 실행 엔진 접수는 연결되지 않았다.
- 전체 필수 단계는 **2/16 = 12.5%**다. 실제 V9 H2는 490건 중 8건을 실행해 7통과·1실패했고, 482건은 미실행이다. 전체 H2는 수용되지 않았다.
- 실패는 dispatcher crash 검사에서 DB clock 기준 claim 만료를 관측하지 못한 timeout이다. 원인은 미확정이며, 저장된 실행을 자동 재시도하지 않는다. [실행 상태](./runtime-v9-execution-status.json) · [독립 검토](./runtime-v9-attempt-01-result-review.json)
- 새 우선순위는 [애자일 전달 계획](../../AGILE-DELIVERY.md)과 [재개 안내](../../RESUME.md)를 따른다. `admission-mock` 상태 표시를 전달했고 다음은 `admission-read`의 실제 조회 API/SQL이다. 실패 원인 분석은 관련 실제 실행만 차단하는 지원 작업이다.

## 회차 합격 기준

상위 admission 흐름의 최종 전달은 기존 I02 저장 요청 하나를 격리된 로컬 PostgreSQL/Temporal에 실제 접수하고, 같은 job/run/receipt를 화면에서 확인하는 것이다. UI/API 계약 [V4](./ADMISSION-UI-PLAN-v4.md)는 [V3](./ADMISSION-UI-PLAN-v3.md)의 DTO·ACL·tuple 기준을 상속한다. 변경 source·환경·계약·권한·격리·정리 절차가 검토되면 좁은 실제 end-to-end 검사를 full490 전에 수행할 수 있다. 개발 중 mock은 화면 피드백용이며 실제 엔진 receipt가 없으면 `QUEUED`로 표시하지 않는다.

후속 실제 엔진 검증에서는 같은 요청의 job/create command/admitted run/sequence 1 receipt가 일치해야 `QUEUED`를 표시한다. 실제 엔진 미수용 상태를 운영 사용 가능으로 표현하지 않는다. AT-03/05/16/21/29/32 및 최종 B 단계 인수는 각 원본 기준에 따라 별도로 남는다.

## 진행 도구

`/delivery.html`과 `docs/ifpmic/delivery-plan.json`에서 현재 흐름 및 완료 조건을 확인한다. `npm run ifpmic:delivery`는 목표와 검사 범위를 출력하고, `npm run ifpmic:delivery:check`는 현재 slice의 선택 검사만 실행한다. `admission-mock`은 전달 도구와 상태 controller 검사에 연결되어 있고, 별도 `npm run ifpmic:admission:browser`로 오프라인 I02 UI를 확인한다. 후속 `admission-read`/`admission-live`에는 protocol/workspace 검사도 연결되어 있다. 이 검사는 DB/Temporal을 시작하지 않는다. `--level integration|acceptance`는 남은 조건을 표시하며, 이 수준의 `--run`은 미구현이다. 제한된 실제 DB/Temporal 통합은 별도 V4 준비·검토 절차로 허용되며, full490은 전체 수용 단계에 남는다.

## 실패 처리와 증거

실패 시 해당 조건만 재현하는 빠른 검증으로 원인을 확인하고, 소스 변경 전 계획·영향 범위·독립 검토를 기록한다. 기존 전체 H2 runner의 범위·개인정보·자원 정리 기준을 느슨하게 하지 않는다. 전체 H2 재실행은 관련 수정과 실행 전 검토가 갖춰지고 통합 수용 단계가 된 뒤 수행한다.

과거 V4–V9 시도, 후보별 변경, 검증과 독립 리뷰는 이 폴더의 개별 증거 및 Git 이력에 보존한다. 과거 문서의 체크포인트는 당시 결과이며 최신 상태로 해석하지 않는다. V9 raw/private 자료는 `workflow-artifacts/`에 보존하고 삭제하거나 공개하지 않는다.
