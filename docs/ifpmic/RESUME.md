# IFPMIC AX 재개 안내 — 2026-10-23

전체 필수 단계는 **2/16 = 12.5%** 완료다. 단계 수를 같은 비중으로 센 값이며 작업량이나 남은 시간의 추정치가 아니다.

## 현재 상태

- 설계 workflow 탐색 화면: http://127.0.0.1:4173/ifpmic.html — 29단계·6구간·41연결·74개 합성 시나리오. 실제 업무 실행이 아니다.
- [진척 현황판](./delivery/status.html): [캡처](./delivery/status-desktop-2026-10-23.png)와 [검증·수용](./delivery/status-result-review-2026-10-23.json)은 커밋 `18e3bf7`의 **실행 직전 기록**이다. 4173 preview는 재기동했고 요청 API8769는 정지 상태다.
- 로컬 API/DB 요청 저장 흐름은 주기02에서 검증했지만, 실제 실행 접수 화면은 아직 미완료다.
- Node 경로와 bridge 소스 누락을 수정한 현재 runner의 **152개 합성 검사**를 [독립 수용](./delivery/iteration-03/node-closure-repair-result-review.json)했다. 이는 실제490의 결과가 아니다.
- V4 전체 소스와 독립·TC 실행 전 검토를 승인받고, **2026-10-23 03:07:59 UTC에 실제490을 한 번 시작했다.** [현재 실행 기록](./delivery/iteration-03/runtime-v4-execution-status.json)을 먼저 확인한다. 시작 기록만으로 통과·최종 수용을 주장하지 않는다.

## 다음 행동

1. 기존 실행을 먼저 관찰한다. 실제 handle과 private leaf는 `workflow-artifacts/verification/B03/H2/runtime-full/preparations/v4-execution/tool-session.json`에 있다. 관찰 timeout을 실행 종료로 해석하거나 새 실행을 시작하지 않는다. 원래16220초 예산·owned cleanup을 유지한다.
2. 실제 terminal gate/JUnit과490 inventory, raw·정리·환경·개인정보 증빙을 확인한다. 실패하면 해당 leaf를 보존하고 원인을 수정한다. 성공해도 독립 결과 수용 전에는 H2 완료나 공개 proposal로 집계하지 않는다.
3. 다음 공개 결과는 **저장 요청 한 건 → 실제 엔진 접수 → 같은 작업의 run/receipt·QUEUED**다. 정상·중복 접수·권한 오류·새로고침 유지를 검증한다. QUEUED는 접수 상태다.
4. 화면·URL·직접 해볼 순서·실제/모의 구분·남은 한 가지를 전달하고 검증된 변경을 커밋·push한다.

## 고정 기준과 보존

현재 코드/검토 체크포인트는 `18e3bf7`이며 runner SHA는 `29be6f277fb624f82042a5f65a4c976298785e378cc42a61659397f129c00762`다. V4 ledger110 source pins·490 ID(407+83)·15phase·raw87/953/38pins와 원래 예산을 유지한다. 실행 중 core source·환경을 바꾸지 않는다.

브랜치는 `experiment/paperclip-workflow`다. 원본 ZIP/DOCX는 untracked 입력이며 커밋하지 않는다. SQL/history/log/인증/PID/source snapshot은 gitignored workflow-artifacts의0700/0600에만 보존한다. 원래32/qualified36 환경, 원본AX/설계·승인 경계를 유지한다.

전체 목표는 진행 중이다. H3–H7, Code-dev·TC·SAM·TEM·SQE·사람, 실제 장비·배포·AT32 인수는 남았다. 현재 계획은 [AGILE-DELIVERY](./AGILE-DELIVERY.md), 과거 상세는 [인계 기록](./RESUME-HISTORY-2026-10-21.md)과 커밋 `18e3bf7`의 문서에 있다.
