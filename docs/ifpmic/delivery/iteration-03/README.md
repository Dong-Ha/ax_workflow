# 주기03 — 저장 요청의 실제 실행 접수

**다음에 보여줄 결과:** 저장한 요청 한 건을 실제 실행 엔진에 접수하고, 같은 작업의 run/receipt·QUEUED를 화면에서 확인한다. QUEUED는 접수 상태이며 업무 완료가 아니다.

전체 필수 단계 완료율은 **2/16 = 12.5%**다. 현재 새 업무 화면 기능은 없다.

## 현재 체크포인트 · 2026-10-23

- workflow 탐색: http://127.0.0.1:4173/ifpmic.html — 29단계·6구간·41연결·74개 합성 시나리오.
- 실제 로컬 API/DB 요청 저장은 [주기02](../iteration-02/README.md)에서 검증했다. 합성 계정/mock 프로파일이며 현재 API8769는 정지 상태다.
- Node PATH와 bridge 소스 누락을 수정하고 [152개 합성 검사](./node-closure-repair-verification.json)를 [독립 수용](./node-closure-repair-result-review.json)했다.
- V4 [전체 소스 검토](../../evidence/b03/h2-runtime-full-runner-source-review-v4.json)와 [독립](../../evidence/b03/h2-runtime-full-pre-gate-review-v4.json)·[TC](../../evidence/b03/h2-runtime-full-pre-gate-tc-review-v4.json) 실행 전 검토를 완료했다.
- **실제490은 2026-10-23 03:07:59 UTC에 한 번 시작했다.** [실행 상태](./runtime-v4-execution-status.json)를 먼저 확인한다. 첫 묶음8건은6통과·2실패·오류/skip0으로 종료했고 나머지482건은 실행하지 않았다. 전체 통과·독립 수용은 미완료다. 152개 합성 결과와 구분한다.
- [진척 현황판](../status.html)과 [캡처 수용](../status-result-review-2026-10-23.json)은 커밋 `18e3bf7`의 실행 직전 기록이다.

## 최신 V5 보완

[보완 계획](./RUNTIME-ORACLE-REPAIR.md)과 독립 검토 뒤 두 관측 오류를 수정했다. 선점 직후 exact generation1 미완료 시도 행을 검증하며, worker 중지 중에는 기존 서버 직접 관측기의 실제 이력을 byte/hash/0600 검사 후 원래 경로에 보존한다. 최종 실제 queued query와 동일 run/history/receipt·원래 시간 제한은 유지한다.

[같은152 본문 합성 검증](./runtime-oracle-repair-verification.json)·[독립 수용](./runtime-oracle-repair-result-review.json)·[전체 소스 승인](../../evidence/b03/h2-runtime-full-runner-source-review-v5.json)을 완료했다. paired execution pre-gates를 통과해2026-10-23 03:52:41 UTC에 실제490을 한 번 시작했으며 [현재 V5 실행 상태](./runtime-v5-execution-status.json)를 따른다. 새 업무 화면 기능은 없다.

## 남은 완료 조건

1. V5 첫 시도는 dispatcher8개+raw 감사 통과 뒤 worker API4개 중3개 실패로 종료했다. 전체12건 중9통과·3실패,478미실행이다. CRASH-10/11의 Started history 기록 시점과 CRASH-12의 복구 query timeout을 원래 계약·실제 관측에 대조하고 좁은 수정 계획으로 복귀한다. 두 시도의 raw/owned cleanup을 보존한다.
2. 실제 raw·정리·환경·개인정보와490 결과를 독립 수용한다. 실패하면 해당 경계로 돌아가 검토·수정·재검증한다.
3. 요청 접수·run/receipt·QUEUED를 연결하고 정상·중복·권한·새로고침을 확인한다. 현재 UI의 조회 DTO에 실행 ID/receipt가 없고 실제 접수는 내부 dispatcher/worker가 수행한다. 검토된 UI/API 계획으로 필요한 조회 정보·갱신을 추가한다.
4. URL·캡처·직접 해볼 순서·실제/모의 구분·커밋/push를 전달한다.

## 유지하는 범위

현재 runner는 V4 ledger110 pins,490 ID(407+83),25업무 의무+5fixture,15phase, phase15420초+overhead800초=16220초를 유지한다. raw87개 규칙·953 artifact 규칙·38pins와 원본 설계·AX·실행 환경은 보존한다. 전체source/실행 승인과 실제 최종 인수는 각각 별도 증거다.

과거 상세는 커밋 `18e3bf7`의 이 문서와 [재개 이력](../../RESUME-HISTORY-2026-10-21.md), 이 폴더의 개별 계획·검토·검증 파일에 보존했다. 과거의 미수정 상태나 실행 금지 지시를 현재 승인 상태로 해석하지 않는다. 재개 절차는 [RESUME](../../RESUME.md)를 따른다.

## 최신 V6 체크포인트

[V6 관측 보완 계획](./WORKER-OBSERVATION-REPAIR.md)을 구현했다. 기존152개 합성 검사 본문을 유지한 한 번의 실행이 통과했다([검증](./worker-observation-repair-verification.json)). 이는 새 worker 관측 helper의 실제 서버 검증을 포함하지 않는다. V6 실제490은 시작하지 않았으며 전체 소스·실행 전 승인과 실제 결과 수용이 남았다. 기존953 artifact 규칙은 그대로 두고3개를 추가했다(956개). 제품 화면 기능은 추가되지 않았다.

다음 사용자 전달은 **같은 요청의 실제 run/receipt·QUEUED 화면**이다. 각 작업 회차에 URL 또는 저장된 캡처, 달라진 행동, 검증·제한, 다음 조치 하나와 커밋을 전달한다. 현재 전체 단계 완료율은 계속12.5%다.

152개 합성 결과는 [독립 수용](./worker-observation-repair-result-review.json)됐다. 수용 범위는 해당 합성 실행뿐이며 실제490·새 helper·실행 접수 화면의 완료 승인이 아니다.

## 실행 중인 최신 상태 · V6

V6 전체 소스 및 독립·TC 실행 전 검토가 승인됐다(커밋 `d5e88ed`). 실제490 한 번을 **2026-10-23 04:49:23 UTC**에 시작했다. [실행 상태](./runtime-v6-execution-status.json)의 private pointer에 실제 handle/leaf를 저장했다. 앞 절의 V6 미실행 설명은 이전 체크포인트다. 관찰 timeout은 종료가 아니므로 같은 handle을 조회하며 재실행하지 않는다. 실제 결과·독립 수용·새 접수 UI는 아직 없다.

## 최신 실제 결과 · V6 종료

[실행 상태](./runtime-v6-execution-status.json):15묶음 목록 수집 후12건 중10통과·2실패·오류/skip0,478미실행으로 종료했다. CRASH10 복구는 통과했다. CRASH11 철회 cardinality 및 CRASH12 armed-only counter 기대를 [새 계획](./RECOVERY-OBSERVATION-REPAIR.md)에서 수정 검토한다. 위의 실행 중/미실행 설명은 과거 체크포인트다. 새 화면은 없으며 실제 전체 H2 수용과 [UI V2 초안](./ADMISSION-UI-PLAN-v2.md)의 독립 검토·구현이 남았다.

두 관측 수정은 독립 계획 승인 뒤 TC 파일에 구현했다. [정적 확인](./recovery-observation-repair-verification.json)은 AST와 변경 범위 확인뿐이다. 새 후보 바인딩·소스 검토·실행 승인·실제 검증은 아직 없으며 V6 승인을 현재 변경에 재사용하지 않는다.

## 최신 V7 준비

[동일152 검사](./recovery-observation-unit-verification.json)·[결과 수용](./recovery-observation-unit-result-review.json)·[전체 소스 승인](../../evidence/b03/h2-runtime-full-runner-source-review-v7.json)이 완료됐다. 원래490/15묶음/956원시 규칙/예산은 유지한다. 정확한 실행 전 검토 뒤 새 실제490을 한 번 실행해야 한다. V7은 아직 실제 실행 전이며 [UI V3 초안](./ADMISSION-UI-PLAN-v3.md)은 독립 검토 전이다. 새 사용자 기능은 없다.

V7 실제 실행을 **2026-10-23 05:34:27 UTC**에 한 번 시작했다(후보 커밋 `88b31b7`). [현재 실행 상태](./runtime-v7-execution-status.json)를 따른다. 위의 V7 실행 전 설명은 이전 기록이다. 같은 actual handle을 조회하며 종료 확인 전 새 시도를 만들지 않는다.

## 최신 실제 상태 · V7 종료

[V7 실행](./runtime-v7-execution-status.json)은 목록 수집 전EvidenceError로 종료했다(0테스트/490미실행). [독립 실패 검토](./runtime-v7-attempt-01-result-review.json)와 [프로토콜 보완 계획](./RAW-POLICY-STATUS-REPAIR.md)을 따른다. 고정 rawstatus 복원과 현재metadata/검사기 연결 회귀2개로154검사를 준비한다. [UI V3 계획 승인](./admission-ui-plan-review-v3.json)은 실제 fullH2 수용 뒤의 조건부 구현 계약이며 새 기능 완료가 아니다.

최신 V8 단위154 실행은153통과·1실패다([증거](./raw-policy-status-unit-verification.json)). 새 실제metadata 연결2개는 통과했고 기존 strict119 목록 보존이121에서 실패했다. [V2 계획](./RAW-POLICY-STATUS-REPAIR-v2.md)은 새2개를 기존 확장 모듈로만 옮겨 원래152/strict119를 유지한다. SDK/서비스/490 및 새 UI는 미실행이다.

## 최신 V9 준비

[154 검사](./raw-policy-inventory-unit-verification.json)·[독립 수용](./raw-policy-inventory-unit-result-review.json)·전체 source/paired 실행 전 검토까지 완료했다. strict119와 기존152를 유지했고 실제metadata2개도 통과했다. 이제 새 실제490 한 번의 결과와 최종 독립 수용이 남았다. SDK/실제 업무·새 UI 수용은 아직 없다.

승인된 V9 실제490을2026-10-23 06:26:25 UTC에 한 번 시작했다(후보 `e33298c`). [실행 상태](./runtime-v9-execution-status.json)의 actualhandle을 계속 조회한다. source/환경은 고정하며 실제 수용 전 완료하지 않는다.

## 사용자 종료 요청

V9 실제490은8건7통과·1실패/482미실행으로 종료했다. [실패 검토](./runtime-v9-attempt-01-result-review.json)·[재개 안내](../../RESUME.md)를 따른다. 원인은 미확정이며 새 수정/재시도를 시작하지 않았다. 기존 I02복원 smoke/캡처를 보존했고 데모를 정상 종료했다([확인](./shutdown-2026-10-23.json)). stdlib154 수용은 전체H2/새 UI 완료가 아니다.
