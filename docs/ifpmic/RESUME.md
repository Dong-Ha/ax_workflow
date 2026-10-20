# IFPMIC AX 재개 안내 — 2026-10-21

## 먼저 볼 결과

**[진행 현황판](./delivery/status.html)**: 기존 두 화면의 캡처,12.5%의 의미,현재 장애3건과 다음 데모를 한 화면에서 확인한다. 새 업무 기능은 추가되지 않았다.

| 결과 | 직접 확인 | 검증된 범위 |
|---|---|---|
| 설계 workflow 탐색 | http://127.0.0.1:4173/ifpmic.html | 29단계·6구간·41연결,74개 합성 시나리오 |
| 요청 등록·저장 | http://127.0.0.1:8769/ | 실제 로컬 API/PostgreSQL 저장·조회·재시작 유지; 합성 계정/mock 프로파일 |
| 실제 실행 접수 | 다음 전달 대상 | 아직 미완료 |

위 두 주소는 이번 세션에서 HTTP200을 확인했다. 브라우저 기능 검증을 다시 실행한 것은 아니다. 로컬 주소에 접근할 수 없으면 [workflow 캡처](./delivery/iteration-01/workflow-desktop.png), [요청 화면 캡처](./delivery/iteration-02/iteration-02-user-a-desktop.png)를 본다. 재실행 방법은 각 [주기01](./delivery/iteration-01/README.md)·[주기02](./delivery/iteration-02/README.md) 안내에 있다.

**전체 필수 단계 완료율:2/16=12.5%.** 같은 비중으로 센 단계 완료율이며 작업량/남은 시간 추정이 아니다. 이번 체크포인트에 새 화면 기능은 없다. 실행기 두 결함과v2 binding을 수정했고 새 소스로131/131을 수용받은 뒤 전체 검토의 추가3종을 수정하고140/140 합성 단위를 독립 수용받았다.

## 다음에 완성할 사용자 흐름 하나

**저장 요청 → 실제 실행 엔진 접수 → 같은 작업의 run/receipt와 QUEUED 표시.** 정상 접수·중복 접수·권한 오류·새로고침 유지를 확인한다. QUEUED는 접수 상태다. [애자일 계획](./AGILE-DELIVERY.md)과 [주기03](./delivery/iteration-03/README.md)을 따른다.

## 현재 기술 체크포인트

- 87/87개 규칙의 소스 대조 완료,475개 기존 source annotation 해소,953 artifact 규칙·10 phase·38 machine source pins. 실제490 실행 증명이 아니다.
- 확정된 테스트 도우미 오류5건 수정,4개 모듈의 기존269 assertion 정적 보존. [현재 규칙 대조 기록](./evidence/b03/h2-machine-resolution-progress-v2.json).
- 최신 합성 단위140/140(기존131+새9) 통과·독립 수용. 원래 ID별 예산·PG 적용13/비적용2·case-local 실제 process 종료 증빙 분류를 복구했다. [결과](./delivery/iteration-03/full-input-repair-verification.json), [독립 수용](./delivery/iteration-03/full-input-repair-result-review.json).24개 입력/소스·빈 cache·원본/환경 before-after 불변. 옛131은 e77e2fa의 과거 소스에만 적용한다.
- 새 별도 v2 후보: [ledger](./evidence/b03/h2-runtime-full-integrated-ledger-v2.json), [실행 계약](./evidence/b03/h2-runtime-full-execution-contract-v2.json).104 source pins(103 code+machine),490 ID(407+83),25업무 의무+5fixture 전제,15phase를 유지한다. phase cap15420초+overhead800초=outer16220초. 독립·TC paired 작성 검토는 완료됐으며 실제 실행·인수는 미승인이다. [정적 검사와 검토 연결](./delivery/iteration-03/full-candidate-v2-static-verification.json).
- 원래 c10 계약/cf4 ledger와 주기02 toolchain 참조는 보존한다. active runner는 ledger에 넣지 않아 hash cycle을 피하고 별도 source/pre-gate에서 고정한다.

## 이어서 수행할 순서

1. 실제 Git 상태와 최신140건 결과·독립 수용을 확인한다. runner SHA는 `8494e13c40b82540d198a0762fb4b392e131860f8a9df5cb0e3a38087141f37c`. 정확한 소스를 바꾸면 관련 승인을 재사용하지 않는다.
2. [전체 소스 검토 attempt02](./evidence/b03/attempts/h2-runtime-full-runner-source-review-v2-attempt-02.json)의 남은3건을 먼저 수정한다: stopped envelope의 경계 label을 canonical role로 오인, synthetic fixture journal을 실제 CLI로 오분류, retained H1 테스트의 README 해시 불일치. 현재 전체 실행 승인은 없다. 첫 시도의3종을 고친140건 수용은 유지하되 이후 바이트 변경에는 재사용하지 않는다. 새 계획/소스/관련 단위 검증·후보 검토 뒤 exact independent/TC execution pre-gates를 받는다.
3. full pre-gates 이후 fresh490을 실행한다. 아직 실제 main/SDK/pytest collection/SQL/service/full490은 실행하지 않았다. 실행이 시작되면 실제 도구 session/handle과 private gate를 기록하고 동일 handle을 관찰한다.
4. 실패 증빙·소유 자원 정리를 보존하고 원인 단계로 복귀한다. 전건 통과·독립 실제 결과 수용 뒤 저장 요청의 실제 접수 UI를 연결하고 브라우저 시연한다.
5. 검토한 변경을 커밋/push하고 새 화면 유무·확인 위치·실제 검증·남은 한 가지를 먼저 전달한다.

## 유지할 경계

- 브랜치: `experiment/paperclip-workflow`. 원본 ZIP/DOCX는 untracked 입력이며 커밋하지 않는다.
- 기준: 현재 AX 자료·원본 IFPMIC 설계, 참고: Paperclip. Code-dev/TC/SAM/TEM/SQE/사람의 책임·승인 게이트·원래 AT32를 유지한다.
- H2 이후 H3–H7·실제 Agent/장비/배포·최종 인수는 계속 남아 있다. 전체 목표는 진행 중이다.
- SQL/history/log/인증/PID/source snapshot은 gitignored `workflow-artifacts/`의0700/0600에만 보존한다. 보호 AX96/89 inventory·설계17+원본2·Python 환경을 유지한다.
- 원래32 venv와 qualified36 venv는 별도다. exact toolchain/환경 기준과 실행 전 계획은 [RAW 통합 계획](./delivery/iteration-03/RAW-AUDIT-INTEGRATION.md), v2 계약과 기존 source 리뷰를 따른다. 설치·다운로드·원본 기록 수정 없이 진행한다.

[이전 상세 인계 기록](./RESUME-HISTORY-2026-10-21.md)은 역사 자료다. 그 안의 과거 미해결 수와 실행 순서를 현재 지시로 사용하지 않는다.

### 세 장애를 수정할 때의 구체 경계

- `stopped-*.json`의 외부 role은 경계 이름이다. 같은 case의 owned metadata에 있는 실제 역할과 nested stop의 PID/start identity를 대조해야 한다. 이름을 일괄 변경해 증빙을 맞추지 않는다.
- cleanup-fallback-probe의 가상 PID/journal은 실제 OS process가 아니다. 해당 시험의 query observation·actions 없음·identity lookup 없음·physical absence 미입증과 함께 좁게 분류한다. 가상 PID를 조회/종료하거나 실제 종료 수에 넣지 않는다.
- H1 test의 README 예상값은 `1aa570…`, 원래 H1 계약은 `0964d4…`, 현재 README는 `ee21e2…`다. 과거 bytes는 각각 Git `09ebf40`/`4fc25fb`에 있다. 현재 문서는 과거1aa 버전에서 주기02 안내2줄이 추가됐다. 역사 승인과 현재 문서 검증을 구분하는 별도 계획을 먼저 검토한다. README 되돌리기·조용한 상수 교체로 통과시키지 않는다. H1 test 수정은 full ledger source pin을 바꾸므로 새 후보 검토가 필요하다. machine38에는 H1 test/README pin이 없다. 기존I02 c10/cf4 참조는 보존한다.
