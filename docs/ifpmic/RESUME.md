# IFPMIC AX 재개 안내 — 2026-10-23

전체 필수 단계는 **2/16 = 12.5%** 완료다. 단계 수를 같은 비중으로 센 값이며 작업량이나 남은 시간의 추정치가 아니다.

## 현재 상태

- 설계 workflow 탐색 화면: http://127.0.0.1:4173/ifpmic.html — 29단계·6구간·41연결·74개 합성 시나리오. 실제 업무 실행이 아니다.
- [진척 현황판](./delivery/status.html): [캡처](./delivery/status-desktop-2026-10-23.png)와 [검증·수용](./delivery/status-result-review-2026-10-23.json)은 커밋 `18e3bf7`의 **실행 직전 기록**이다. 4173 preview는 재기동했고 요청 API8769는 정지 상태다.
- 로컬 API/DB 요청 저장 흐름은 주기02에서 검증했지만, 실제 실행 접수 화면은 아직 미완료다.
- Node 경로와 bridge 소스 누락을 수정한 현재 runner의 **152개 합성 검사**를 [독립 수용](./delivery/iteration-03/node-closure-repair-result-review.json)했다. 이는 실제490의 결과가 아니다.
- V4 전체 소스와 독립·TC 실행 전 검토를 승인받고, **2026-10-23 03:07:59 UTC에 실제490을 한 번 시작했고, 첫 묶음8건 중2건 실패로 종료했다(6통과·오류/skip0).** [현재 실행 기록](./delivery/iteration-03/runtime-v4-execution-status.json)을 먼저 확인한다. 나머지482건은 실행하지 않았다. 전체 통과나 최종 수용이 아니다.

## 최신 보완 · V5

V4 실패 두 건을 [검토된 계획](./delivery/iteration-03/RUNTIME-ORACLE-REPAIR.md)에 따라 수정했다. claim 직후에는 원래 계약대로 정확한 미완료 generation1 시도 행을 요구한다. worker 중지 중에는 기존 직접 관측기로 실제 서버 이력을 읽고 원래 경로에 실제 bytes를 보존하며, 최종 worker 재기동 뒤 기존 queued query를 유지한다. 생산 SQL/서비스는 변경하지 않았다.

새 V5 후보는 두 TC 파일·rules 파일명 literal·기존 단위 fixture literal만 변경했고, [같은152개 본문 실행](./delivery/iteration-03/runtime-oracle-repair-verification.json)을 [독립 수용](./delivery/iteration-03/runtime-oracle-repair-result-review.json)받았다. [전체 소스 승인](./evidence/b03/h2-runtime-full-runner-source-review-v5.json)도 완료했다. 두 실제 통합 사례의 통과 증거는 아직 없으며, V4 실패는 그대로 보존한다.

## 다음 행동

1. [V5 실행 상태](./delivery/iteration-03/runtime-v5-execution-status.json)를 먼저 확인한다. 독립·TC 실행 전 게이트가 exact V5 source/manifest를 승인했고 2026-10-23 03:52:41 UTC에 새490을 한 번 시작했다. actual handle/leaf는 위 기록의 private_resume_pointer에 저장했다. 기존 실행을 계속 관찰한다. 관찰 timeout을 종료로 해석하거나 중복 실행하지 않는다.
2. terminal gate/JUnit·raw·정리·환경·개인정보를 독립 수용한다. 실패 시 해당 leaf를 보존하고 원래 계약 단계로 복귀한다. 통과 기록 없이 H2 완료나 공개 proposal로 집계하지 않는다.
3. 다음 공개 결과는 **저장 요청 한 건 → 실제 엔진 접수 → 같은 작업의 run/receipt·QUEUED**다. 정상·중복 접수·권한 오류·새로고침을 검증한다. 현재 I02 UI에는 실행 ID/receipt 조회 DTO가 없고 내부 dispatcher/worker 경로가 실제 접수를 맡는다. 필요한 조회 정보와 갱신은 별도 검토된 UI/API 계획으로 추가한다. QUEUED는 접수 상태다.
4. 화면·URL·직접 해볼 순서·실제/모의 구분·남은 한 가지를 전달하고 검증된 변경을 커밋·push한다.

## 고정 기준과 보존

현재 V5 runner SHA는 `bad746ecdfcfc155e16b2f013810963734627dfd2ee5727c62612a5f25ae9239`다. V5 ledger110 source pins·490 ID(407+83)·15phase·raw87/953/38pins와 원래 예산을 유지한다. 실행 중 core source·환경을 바꾸지 않는다.

브랜치는 `experiment/paperclip-workflow`다. 원본 ZIP/DOCX는 untracked 입력이며 커밋하지 않는다. SQL/history/log/인증/PID/source snapshot은 gitignored workflow-artifacts의0700/0600에만 보존한다. 원래32/qualified36 환경, 원본AX/설계·승인 경계를 유지한다.

전체 목표는 진행 중이다. H3–H7, Code-dev·TC·SAM·TEM·SQE·사람, 실제 장비·배포·AT32 인수는 남았다. 현재 계획은 [AGILE-DELIVERY](./AGILE-DELIVERY.md), 과거 상세는 [인계 기록](./RESUME-HISTORY-2026-10-21.md)과 커밋 `18e3bf7`의 문서에 있다.
