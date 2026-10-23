# IFPMIC AX 재개 안내 — 2026-10-23 종료 체크포인트

**사용자가 컴퓨터 종료를 위해 일시 중지했다.** 전체 목표는 미완료이며 필수 단계 **2/16 = 12.5%**다(동일 가중치 단계 수, 작업량 추정 아님). 새 수정·테스트를 시작하지 않는다.

## 현재 결과

- 설계 workflow:29단계·6구간·41연결·74합성 시나리오. [기존 캡처](./delivery/iteration-01/workflow-desktop.png).
- 기존 I02 요청 저장 화면을 복원해 실제 POST202 한 번 → 목록/작업/명령GET200 → 같은 작업 reload를 확인했다. 상태 DRAFT/accepted, 실행 연결 false다. [검증](./delivery/iteration-02/restore-2026-10-23-verification.json) · [데스크톱](./delivery/iteration-02/restore-desktop-2026-10-23.png) · [모바일](./delivery/iteration-02/restore-mobile-2026-10-23.png). 식별자는 마스킹했다. 전체17-case 회귀나 엔진 접수 수용은 아니다.
- V9 **154개 stdlib 검사 전부 통과**, [독립 수용](./delivery/iteration-03/raw-policy-inventory-unit-result-review.json). 원래152 본문·ID와 strict119 목록을 유지하고 실제 metadata 수용/거부2개를 확장 모듈에 추가했다. [실행 증거](./delivery/iteration-03/raw-policy-inventory-unit-verification.json).
- V9 실제490은 15묶음/490 목록 확인 후 **첫8건7통과·1실패**, 오류/skip0,482미실행으로 종료했다. [실행 상태](./delivery/iteration-03/runtime-v9-execution-status.json) · [독립 실패 검토](./delivery/iteration-03/runtime-v9-attempt-01-result-review.json). 전체H2는 미수용이다.
- [종료 확인](./delivery/iteration-03/shutdown-2026-10-23.json): 데모 launcher 정상exit0, issuer/PG 종료와 데이터 보존 확인,4173/8769/8770 포트 닫힘.

## 다음 작업 시작점

1. V9 실패 검토와 private leaf `workflow-artifacts/verification/B03/H2/runtime-full/gates/2026-10-23T06-26-25-387466Z`를 읽는다. 실패는 `tests/ifpmic_api/test_h2_dispatcher_crashes.py::test_claim_commit_crash_reclaims_only_after_expiry`257줄 → `h2_dispatcher_crash_support.wait_claim_expired`467줄의 DB-clock 만료 관측 timeout이다. 해당 case43.903초, 전체585.015761초.
2. 저장된 barrier/SQL snapshot/case timing/journal을 과거 V5/V6 통과 증거와 비교한다. 생산 lease30초와 관측 cap30초·0.1초 poll 간격의 경계 문제는 **미확정 가설**이다. I02 복원이 원인이라고 입증되지 않았다. 아직 새 보완 계획·수정 코드·재시작 승인은 없다.
3. 원인 확인 후 영향 범위/검증8항목을 명시한 보완 계획을 독립 검토한다. 원래 업무/lease/전체 예산을 임의로 완화하지 않는다. 변경된 후보의 source/capture/result/whole-source/paired invocation gates를 갱신한 뒤 실제 검증한다. V9 one-attempt 승인은 사용됐으므로 자동 재시도하지 않는다.
4. 실제490·raw/정리/환경 독립 수용 뒤 [UI V3 계획](./delivery/iteration-03/ADMISSION-UI-PLAN-v3.md)과 [승인](./delivery/iteration-03/admission-ui-plan-review-v3.json)에 따라 **저장 요청 → 엔진 접수 → 같은 job/command/run/receipt·QUEUED 표시**를 구현한다. workspaceREADY·권한·중복·재시작·화면 증거를 검증한다. 이 구현은 아직 시작하지 않았다. QUEUED는 업무 완료가 아니다.

## 화면 재시작

`/home/dongha/AX`에서 별도 터미널로 실행한다. **같은 demo 이름**을 사용해야 이번 저장 데이터를 다시 읽는다.

```sh
PYTHONDONTWRITEBYTECODE=1 .ifpmic-venv/bin/python -B experiments/ifpmic-live/launcher.py --name iteration-02-restored-20261023 --port 8769 --issuer-port 8770
```

http://127.0.0.1:8769/ → OIDC Login → demo user A. 종료 Ctrl+C. 데이터는 `workflow-artifacts/live-demo/iteration-02-restored-20261023`에 보존했고 과거 `iteration-02` 데이터도 변경하지 않았다.

설계 화면은 기존 빌드로 다음처럼 연다.

```sh
/home/dongha/.nvm/versions/node/v24.17.0/bin/node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort
```

http://127.0.0.1:4173/ifpmic.html. 과거 정적 현황판18e3bf7 캡처는 최신 실제 결과가 아니다.

## 보존·추적

- 브랜치 `experiment/paperclip-workflow`. V8 실패 checkpoint `cce0e33`, V9 후보 `e33298c`, 실제 시작 기록 `e660c24`. 마지막 인계 커밋은 git log로 확인한다.
- V9 runner SHA `c528080e66b5dcd727acbb06fd6334da70401c3e54b02ce11c676541b06608c2`. core110/raw38/87cases/956predicates/490ID(407+83)/15phase/16220초 유지. 확장 unit source는 별도 repair/capture/whole closure에 pin했다.
- 종료된 핸들: actualV9 `57638`, unitV9 `6642`, unitV8 `57758`, actualV7 `70202`, demo `29662`. 실행 중으로 취급하지 않는다. Private pointers: `workflow-artifacts/verification/B03/H2/runtime-full/preparations/v9-execution/tool-session.json`, `workflow-artifacts/verification/agile/iteration-03/i02-restore-20261023/tool-session.json`.
- 원시 SQL/history/log/인증/PID/source snapshot은 ignored workflow-artifacts의0700/0600에 로컬 보존한다. 원본 ZIP/DOCX도 untracked 로컬 입력으로 남겼고 커밋하지 않았다. 이 자료를 git clean으로 지우지 않는다.
- H3–H7, Code-dev·TC·SAM·TEM·SQE·사람, 실제 장비·배포·AT32 인수는 남았다. 최종 배포/외부 제출은 승인 후 수행한다. 전체 목표 완료로 표시하지 않는다.

재개 요청: **“docs/ifpmic/RESUME.md를 읽고 기록된 실패 분석부터 이어서 진행해.”**
