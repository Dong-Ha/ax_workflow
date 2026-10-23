# IFPMIC AX 재개 안내 — 2026-10-23

전체 필수 단계는 **2/16 = 12.5%** 완료다. 단계 수 기준이며 작업량이나 남은 시간 추정이 아니다. 전체 목표는 진행 중이고 새 실행 접수 화면은 없다.

## 현재 상태

- [workflow 화면](http://127.0.0.1:4173/ifpmic.html)은29단계·6구간·41연결·74합성 시나리오다. [캡처](./delivery/iteration-01/workflow-desktop.png)도 있다. 실제 업무 실행이 아니다.
- [I02 API/DB 요청 저장](./delivery/iteration-02/README.md)은 과거 로컬 합성 계정/mock 프로파일 범위 검증이다. API8769는 중지 상태다. 정적 진행 현황판 캡처는18e3bf7의 과거 실행 전 기록이다.
- V6 실제12건 중10통과·2실패·478미실행 뒤 두 TC 관측을 수정했다. [V6 실패 검토](./delivery/iteration-03/runtime-v6-attempt-01-result-review.json)와 원본 leaf는 보존한다. worker 현재SHA는7cab7aeb…다.
- V7의 [기존152 검사](./delivery/iteration-03/recovery-observation-unit-verification.json)는 [독립 수용](./delivery/iteration-03/recovery-observation-unit-result-review.json)됐고 source/pregates도 승인됐다. 그러나 [V7 실제 실행](./delivery/iteration-03/runtime-v7-execution-status.json)은2.156초 만에 **EvidenceError로 종료**했다. 목록 수집·테스트0,490미실행이다. [독립 실패 검토](./delivery/iteration-03/runtime-v7-attempt-01-result-review.json)는 이를 전체 수용으로 인정하지 않는다.
- V7 actual handle70202는 종료됐다. private pointer: `workflow-artifacts/verification/B03/H2/runtime-full/preparations/v7-execution/tool-session.json`. V6 handle44336도 종료됐다. 기존 승인을 재사용해 같은 시도를 반복하지 않는다.

## 원인과 다음 행동

1. V7 raw rules.status를 버전 설명 문자열로 바꿨지만 실제 raw adapter와 phase rule preparer는 `candidate_pending_exact_review`라는 고정 프로토콜 값을 요구한다. 원래152 fixture 검사에는 현재 C/L/rules를 실제 validate_policy에 연결하는 검사가 없었다. source review도 이 결합 조건을 놓쳤다. 실패 코드 구체값은 source-derived 진단이며 실제 gate에는 일반 EvidenceError만 기록됐다.
2. [상태 프로토콜 보완 계획](./delivery/iteration-03/RAW-POLICY-STATUS-REPAIR.md)을 독립 검토한 뒤 V8에 protocolstatus를 복원한다. 생산 checker를 완화하지 않는다. 기존152 메서드 본문은 유지하고 실제 현재 metadata 수용·올바른 해시의 잘못된 status 거부2개를 추가해154개로 검증한다. 새 capture는 새로 실행되는 raw adapter와 transitive helper source도 정확히 pin해야 한다.
3. 새 후보/154 capture의 정확한 source 승인·실행·독립 결과 수용·whole source/paired invocation gates를 갱신한 뒤 원래 실제490 한 번을 실행한다. V7 모든 bytes와 실패를 보존한다. 이후 실패도 leaf 보존·소유 자원 정리·원인 및 영향 범위 재검증으로 복귀한다. 실제 raw/환경/정리 최종 독립 수용 전 H2를 완료하지 않는다.
4. 다음 제품 목표는 **저장 요청 → 실제 엔진 접수 → 같은 job/command/run/receipt·QUEUED 표시**다. [UI V3 계획](./delivery/iteration-03/ADMISSION-UI-PLAN-v3.md)은 [독립 승인](./delivery/iteration-03/admission-ui-plan-review-v3.json)됐다. 실제 fullH2 수용 뒤에만 API/SQL/launcher/UI 구현을 진행하며, workspaceREADY·정확한 권한·중복·재시작·화면/증거를 검증한다. QUEUED는 업무 완료가 아니다.

## 고정 기준과 보존

현재 V7 실행 후보 커밋88b31b7, 실행 기록b646966. runner SHA `b23bd4e8fe5e443c0d8de57016b0ad7085df3bdd1d16226e6a87ee2caa3528aa`. 490ID(407+83)·15phase·16220초·raw87/956/38pins·ledger110pins를 유지한다. V7 source/pregates의 승인은 실제 실패를 취소하거나 후속 후보를 승인하지 않는다.

브랜치는 `experiment/paperclip-workflow`. 원본 ZIP/DOCX는 untracked 입력으로 커밋하지 않는다. 원시 SQL/history/log/인증/PID/source snapshot은 ignored workflow-artifacts의0700/0600에 보존한다. 원래32/qualified36 환경, 원본 AX·설계·역할·승인을 유지한다.

H3–H7, Code-dev·TC·SAM·TEM·SQE·사람, 실제 장비·배포·AT32 인수는 남았다. [AGILE-DELIVERY](./AGILE-DELIVERY.md), [이전 인계](./RESUME-HISTORY-2026-10-21.md)와 git 이력으로 추적한다. 각 회차에 화면/URL 또는 캡처·검증·제한·다음 조치 하나·커밋/push를 전달한다.

## 최신 V8 단위 실행 및 V9 배치 보완

V8에서 protocolstatus를 복원하고 현재metadata 연결 검사2개를 추가했다. [정확한154 실행](./delivery/iteration-03/raw-policy-status-unit-verification.json)은 **153통과·1실패**로 종료했다. 새 정상/거부2개는 모두 통과했고 원래152 중151통과·1실패다. 실패는 기존 strict119 목록 보존 검사가 새2개를 포함해121을 센 것이다. actual SDK/SQL/서비스/main/490은 실행하지 않았다. unit handle57758은 종료됐다. 원시 leaf는 `workflow-artifacts/verification/agile/iteration-03/raw-policy-status-unit-2026-10-23T05-53-15-987082Z`다.

다음은 [V2 보완 계획](./delivery/iteration-03/RAW-POLICY-STATUS-REPAIR-v2.md)을 독립 검토한 뒤 새2개만 기존 확장 모듈의 새 CurrentCandidatePolicyTests 클래스로 옮기는 것이다. 원래152 AST/ID와119 완전 일치 assertion은 바꾸지 않는다. 후속V9 capture도 비확장 모듈 집합==원래119를 그대로 확인하고, 전체 baseline152+확장2==154를 확인해야 한다. 신규adapter와 transitive helpers/확장 unit source를 모두 pin한다. V8 모든후보·검토·실패 bytes를 git체크포인트로 먼저 보존하고, V9 exact approvals/새154 실제 통과/whole source/paired pre-gates 후 원래490을 실행한다. 단위 실행 실패를 통과로 집계하지 않는다.

## 최신 V9 준비 · 154 수용 및 실행 승인

V8 실패 source/metadata는 커밋 `cce0e33`으로 보존했다. V9에서 새2개를 기존 확장 모듈의 새 클래스로 옮겼고, 원래152 AST/ID와 strict119를 유지했다. [154 실제 stdlib 검사](./delivery/iteration-03/raw-policy-inventory-unit-verification.json)가 모두 통과해 [독립 수용](./delivery/iteration-03/raw-policy-inventory-unit-result-review.json)됐다. 새2개 현재metadata 검사는 SDK/SQL/서비스/실제490을 대신하지 않는다.

[전체 sourceV9](./evidence/b03/h2-runtime-full-runner-source-review-v9.json)·[독립 실행 전](./evidence/b03/h2-runtime-full-pre-gate-review-v9.json)·[TC 실행 전](./evidence/b03/h2-runtime-full-pre-gate-tc-review-v9.json) 검토가 승인됐고,253개 핀·7target hashes·실제 HOME/cleanenv/원래 실행 명령을 다시 확인했다. 다음은 `workflow-artifacts/verification/B03/H2/runtime-full/preparations/v9-execution/invocation.json`의 정확한 명령으로 새490을 한 번 실행하는 것이다. V9은 아직 실제490 시작 전이다. runner SHA `c528080e66b5dcd727acbb06fd6334da70401c3e54b02ce11c676541b06608c2`. 위의 V8 배치 보완 대기 설명은 이전 체크포인트다. 실제 V9 handle은 시작 뒤 새 private pointer에 기록한다. 이전 handle57758/6642(단위),70202/44336(실제)는 모두 종료됐다.
