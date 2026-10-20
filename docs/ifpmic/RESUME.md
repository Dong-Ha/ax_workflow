# IFPMIC AX 재개 안내 — 2026-10-21

## 먼저 볼 결과

| 결과 | 직접 확인 | 검증된 범위 |
|---|---|---|
| 설계 workflow 탐색 | http://127.0.0.1:4173/ifpmic.html | 29단계·6구간·41연결,74개 합성 시나리오 |
| 요청 등록·저장 | http://127.0.0.1:8769/ | 실제 로컬 API/PostgreSQL 저장·조회·재시작 유지; 합성 계정/mock 프로파일 |
| 실제 실행 접수 | 다음 전달 대상 | 아직 미완료 |

위 두 주소는 이번 세션에서 HTTP200을 확인했다. 브라우저 기능 검증을 다시 실행한 것은 아니다. 로컬 주소에 접근할 수 없으면 [workflow 캡처](./delivery/iteration-01/workflow-desktop.png), [요청 화면 캡처](./delivery/iteration-02/iteration-02-user-a-desktop.png)를 본다. 재실행 방법은 각 [주기01](./delivery/iteration-01/README.md)·[주기02](./delivery/iteration-02/README.md) 안내에 있다.

**전체 필수 단계 완료율:2/16=12.5%.** 같은 비중으로 센 단계 완료율이며 작업량/남은 시간 추정이 아니다. 이번 체크포인트에 새 화면 기능은 없다.

## 다음에 완성할 사용자 흐름 하나

**저장 요청 → 실제 실행 엔진 접수 → 같은 작업의 run/receipt와 QUEUED 표시.** 정상 접수·중복 접수·권한 오류·새로고침 유지를 확인한다. QUEUED는 접수 상태다. [애자일 계획](./AGILE-DELIVERY.md)과 [주기03](./delivery/iteration-03/README.md)을 따른다.

## 현재 기술 체크포인트

- 87/87개 규칙의 소스 대조 완료,475개 기존 source annotation 해소,953 artifact 규칙·10 phase·38 machine source pins. 실제490 실행 증명이 아니다.
- 확정된 테스트 도우미 오류5건 수정,4개 모듈의 기존269 assertion 정적 보존. [현재 규칙 대조 기록](./evidence/b03/h2-machine-resolution-progress-v2.json).
- 기존119 합성 단위 검사는 과거 정확한 소스에 한정해 독립 수용됐다. 실행기 바이트를 바꾸면 새 정확한 승인과 관련 재검증이 필요하다. [증빙](./delivery/iteration-03/full-runner-repair-verification.json).
- 새 별도 v2 후보: [ledger](./evidence/b03/h2-runtime-full-integrated-ledger-v2.json), [실행 계약](./evidence/b03/h2-runtime-full-execution-contract-v2.json).104 source pins(103 code+machine),490 ID(407+83),25업무 의무+5fixture 전제,15phase를 유지한다. phase cap15420초+overhead800초=outer16220초. 독립·TC paired 작성 검토는 완료됐으며 실제 실행·인수는 미승인이다. [정적 검사와 검토 연결](./delivery/iteration-03/full-candidate-v2-static-verification.json).
- 원래 c10 계약/cf4 ledger와 주기02 toolchain 참조는 보존한다. active runner는 ledger에 넣지 않아 hash cycle을 피하고 별도 source/pre-gate에서 고정한다.

## 이어서 수행할 순서

1. 실제 Git 상태와 새 v2 paired authoring review를 확인한다. 정확한 SHA가 바뀌면 과거 승인을 적용하지 않는다.
2. runner-only 두 수정의8필드 계획과 독립 계획 검토를 먼저 작성한다: 공개 결과 생성 직전 runner 자체 SHA 재확인, 실제 watchdog5종의 total_seconds 부재에 대한 형식 적응(원래 시각/구간/예산 검증 유지). 승인 뒤 v2 경로·해시·리뷰 연결과 함께 수정하고 exact source 검토·관련 합성 재검증을 마친다. 아직 코드는 수정하지 않았다.
3. 독립/TC exact source·paired pre-gates 이후에만 fresh490을 실행한다. 현재까지 이번 v2 후보의 SDK import/collection/test/SQL/service/main 실행은 없다.
4. 실패 원인과 private 증빙을 보존하고 수정·재검토한다. 전건 통과와 독립 실제 결과 수용 뒤 실제 접수 UI를 연결하고 브라우저 시연한다.
5. 변경을 검토·커밋하고 현재 브랜치에 push한다. 매 체크포인트는 새 화면 기능 유무·확인 위치·실제 검증·남은 한 가지를 먼저 전달한다.

## 유지할 경계

- 브랜치: `experiment/paperclip-workflow`. 원본 ZIP/DOCX는 untracked 입력이며 커밋하지 않는다.
- 기준: 현재 AX 자료·원본 IFPMIC 설계, 참고: Paperclip. Code-dev/TC/SAM/TEM/SQE/사람의 책임·승인 게이트·원래 AT32를 유지한다.
- H2 이후 H3–H7·실제 Agent/장비/배포·최종 인수는 계속 남아 있다. 전체 목표는 진행 중이다.
- SQL/history/log/인증/PID/source snapshot은 gitignored `workflow-artifacts/`의0700/0600에만 보존한다. 보호 AX96/89 inventory·설계17+원본2·Python 환경을 유지한다.
- 원래32 venv와 qualified36 venv는 별도다. exact toolchain/환경 기준과 실행 전 계획은 [RAW 통합 계획](./delivery/iteration-03/RAW-AUDIT-INTEGRATION.md), v2 계약과 기존 source 리뷰를 따른다. 설치·다운로드·원본 기록 수정 없이 진행한다.

[이전 상세 인계 기록](./RESUME-HISTORY-2026-10-21.md)은 역사 자료다. 그 안의 과거 미해결 수와 실행 순서를 현재 지시로 사용하지 않는다.
