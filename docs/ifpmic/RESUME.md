# IFPMIC AX 재개 안내 — 2026-10-23

전체 필수 단계는 **2/16 = 12.5%** 완료다. 단계 수를 같은 비중으로 센 값이며 작업량이나 남은 시간 추정이 아니다. 전체 목표는 진행 중이고 새 실행 접수 화면은 아직 없다.

## 현재 실제 상태

- 설계 workflow: http://127.0.0.1:4173/ifpmic.html — 29단계·6구간·41연결·74개 합성 시나리오. [저장된 캡처](./delivery/iteration-01/workflow-desktop.png)도 있다.
- [요청 API/DB 저장](./delivery/iteration-02/README.md)은 로컬 합성 계정/mock 프로파일 범위에서 검증됐지만 API8769는 중지 상태다.
- [정적 현황판 캡처](./delivery/status-result-review-2026-10-23.json)는 커밋18e3bf7의 과거 실행 전 기록이다. 최신 실행 결과로 해석하지 않는다.
- V6 합성152개는 [독립 수용](./delivery/iteration-03/worker-observation-repair-result-review.json)됐다. 실제 새 helper/490 검증과 다르다.
- V6 전체 소스·독립/TC 실행 전 검토 뒤 실제490을 한 번 시작해 **exit1로 종료**했다. [실행 상태](./delivery/iteration-03/runtime-v6-execution-status.json)를 확인한다. 15묶음 목록 수집,12건 중10통과·2실패·오류/skip0,478미실행이다. dispatcher8+raw 감사 통과, worker4 중2통과·2실패다. CRASH10의 새 pending 관측·복구는 통과했다.
- 실제 handle44336은 종료됐다. private pointer는 `workflow-artifacts/verification/B03/H2/runtime-full/preparations/v6-execution/tool-session.json`이다. 동일 실패 시도를 재실행하지 않는다.

## 두 실패와 다음 행동

1. CRASH11은 실제 두 eligibility를 모두 철회했지만 관측이 count1을 요구해 실패했다. CRASH12는 같은 run 후속 decision과 원래 proxy QUEUED query 성공 후, release 뒤 멈추는 armed-only client counter 증가를 요구해 실패했다. 최종 사례는 실패이며 성공으로 재분류하지 않는다.
2. [V6 실패 독립 검토](./delivery/iteration-03/runtime-v6-attempt-01-result-review.json)는 종료·증거·현재 정리를 확인했다(전체 수용 아님). 이어서 [두 관측 보완 계획](./delivery/iteration-03/RECOVERY-OBSERVATION-REPAIR.md)의 독립 검토를 확인한다. 계획은 [독립 승인](./delivery/iteration-03/recovery-observation-repair-plan-review.json)됐고 TC가 exact eligibility 집합 전체 철회 및 release 이후 실제 양방향 event/connection 증거를 검증하도록 수정했다. [정적 확인](./delivery/iteration-03/recovery-observation-repair-verification.json)은 AST/차이 검사뿐이며 새 실제 실행은 없다. 현재 worker SHA는 `7cab7aebbfe7a6ec35a9e623cc03bd8ca749612bd99799c1330355527715ccdf`다. V6 ledger/rules/승인은 이전 worker bytes를 가리키므로 현재 소스의 실행 승인으로 사용하지 않는다. 생산 SQL/서비스·원래 업무 조건·cleanup·예산은 유지한다.
3. 바뀐 후보의 contract/ledger/rules/source bindings와 영향을 받는 검토를 갱신한다. 합성152는 실제 경계를 대체하지 않는다. 별도 전체 소스·paired 실행 전 검토 뒤 새 실제490을 한 번 실행하고 최종 결과를 독립 수용한다.
4. 그 뒤 [화면 연결 V2 초안](./delivery/iteration-03/ADMISSION-UI-PLAN-v2.md)을 독립 검토해 기존 I02 화면을 확장한다. 목표는 **저장 요청 → 실제 엔진 접수 → 같은 job/command/run/receipt·QUEUED 표시**다. workspace READY 처리, 정확한 권한·최소 조회 DTO, 재시작·중복·격리를 검증한다. QUEUED는 업무 완료가 아니다.
5. 사용자에게 화면·URL·캡처·검증·제한·다음 조치 하나를 전달하고 커밋/push한다.

## 보존과 추적

V6 실행 후보 커밋은d5e88ed, 실행 기록 커밋은a103719다. runner SHA는 `c735c571cb9fb0d77f2907dae97a974f296822707482fb43eb40017a44616828`. source110pins·490ID(407+83)·15phase·16220초·raw87/956/38pins를 유지했다. 과거 V4/V5 실패와 모든 버전별 승인/증거는 변경하지 않는다.

브랜치는 `experiment/paperclip-workflow`. 원본 ZIP/DOCX는 untracked 입력이며 커밋하지 않는다. 원시 SQL/history/log/인증/PID/source snapshot은 gitignored workflow-artifacts의0700/0600에 보존한다. 원래32/qualified36 환경, 원본 AX·설계·역할·승인 경계를 유지한다.

H3–H7, Code-dev·TC·SAM·TEM·SQE·사람, 실제 장비·배포·AT32 인수는 남았다. [AGILE-DELIVERY](./AGILE-DELIVERY.md), [이전 인계](./RESUME-HISTORY-2026-10-21.md), [주기03 기록](./delivery/iteration-03/README.md) 및 git 이력으로 추적한다.

두 TC 관측 수정은 [제한된 소스 검토](./delivery/iteration-03/recovery-observation-repair-source-review.json)를 승인받았다. 이 기록은 worker 소스만 검토한 것이며 합성 capture나 실제 실행 승인이 아니다. 다음 capture 승인은 기존 기록을 덮어쓰지 않고 별도 파일로 작성한다. UI V2는 여전히 독립 검토 전 초안이다.

## 최신 V7 준비 상태

현재 V7 C/L/rules와 runner 바인딩을 작성했고, [새152 합성 결과](./delivery/iteration-03/recovery-observation-unit-verification.json)를 [독립 수용](./delivery/iteration-03/recovery-observation-unit-result-review.json)받았다. [전체 소스](./evidence/b03/h2-runtime-full-runner-source-review-v7.json)도 승인됐으며221개 핀이 현재 bytes와 일치한다. 위의 미바인딩/미실행 설명은 이전 체크포인트다. V7 실제490은 아직 시작하지 않았다.

다음은 `workflow-artifacts/verification/B03/H2/runtime-full/preparations/v7-execution/invocation.json`의 정확한 명령·실제 HOME·clean environment를 독립/TC가 승인한 뒤, 즉시 소스·7target hashes를 재확인하고 실제490을 한 번 실행하는 것이다. 이전 V6 handle44336은 종료됐으며 다시 시작하지 않는다. V7 runner SHA: `b23bd4e8fe5e443c0d8de57016b0ad7085df3bdd1d16226e6a87ee2caa3528aa`. UI 후속 계획의 최신 초안은 [V3](./delivery/iteration-03/ADMISSION-UI-PLAN-v3.md)이며 독립 검토와 실제 H2 수용 전 구현하지 않는다.

## 최신 실제 실행 · V7

V7 소스와 paired 실행 전 검토가 승인됐고, 커밋 `88b31b7`의 후보를 **2026-10-23 05:34:27 UTC**에 한 번 시작했다. [V7 실행 상태](./delivery/iteration-03/runtime-v7-execution-status.json)의 private pointer에 actual handle/leaf가 있다. 위의 V7 미실행 설명은 이전 체크포인트다. 관찰 timeout은 종료가 아니며 같은 handle을 조회한다. source/환경은 실행 중 변경하지 않는다. 실제 전체 결과와 독립 수용, 새 UI는 아직 없다.
