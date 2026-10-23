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

[같은152 본문 합성 검증](./runtime-oracle-repair-verification.json)·[독립 수용](./runtime-oracle-repair-result-review.json)·[전체 소스 승인](../../evidence/b03/h2-runtime-full-runner-source-review-v5.json)을 완료했다. 실제490 재실행은 별도 paired execution pre-gates 뒤 진행하며 [현재 V5 실행 상태](./runtime-v5-execution-status.json)를 따른다. 새 업무 화면 기능은 없다.

## 남은 완료 조건

1. exact V5 독립·TC 실행 전 게이트 뒤 새490을 한 번 실행한다. 기존 실패 증거는 보존하며 같은 actual handle을 관찰한다.
2. 실제 raw·정리·환경·개인정보와490 결과를 독립 수용한다. 실패하면 해당 경계로 돌아가 검토·수정·재검증한다.
3. 요청 접수·run/receipt·QUEUED를 연결하고 정상·중복·권한·새로고침을 확인한다. 현재 UI의 조회 DTO에 실행 ID/receipt가 없고 실제 접수는 내부 dispatcher/worker가 수행한다. 검토된 UI/API 계획으로 필요한 조회 정보·갱신을 추가한다.
4. URL·캡처·직접 해볼 순서·실제/모의 구분·커밋/push를 전달한다.

## 유지하는 범위

현재 runner는 V4 ledger110 pins,490 ID(407+83),25업무 의무+5fixture,15phase, phase15420초+overhead800초=16220초를 유지한다. raw87개 규칙·953 artifact 규칙·38pins와 원본 설계·AX·실행 환경은 보존한다. 전체source/실행 승인과 실제 최종 인수는 각각 별도 증거다.

과거 상세는 커밋 `18e3bf7`의 이 문서와 [재개 이력](../../RESUME-HISTORY-2026-10-21.md), 이 폴더의 개별 계획·검토·검증 파일에 보존했다. 과거의 미수정 상태나 실행 금지 지시를 현재 승인 상태로 해석하지 않는다. 재개 절차는 [RESUME](../../RESUME.md)를 따른다.
