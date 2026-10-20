# 주기03 — 저장 요청의 실제 실행 접수

**다음에 보여줄 결과:** 저장한 요청 한 건을 실제 실행 엔진에 접수하고, 같은 작업의 실행 ID·receipt·QUEUED 상태를 화면에서 확인한다.

| 사용자 흐름 | 현재 상태 | 직접 확인 |
|---|---|---|
| 설계 탐색·74개 모의 시나리오 | 공개·검증 완료, 합성 시연 | http://127.0.0.1:4173/ifpmic.html |
| 로그인·요청 등록·목록/상세·재시작 유지 | 실제 로컬 API/DB 검증 완료, 합성 계정/mock 프로파일 | http://127.0.0.1:8769/ |
| 저장 요청·실제 실행 접수·run/receipt | 진행 중 | 아직 시연할 수 없음 |
| 실제 업무·사람·품질·장비·배포 경로 | 후속 구현/인수 필요 | 미완료 |

전체 필수 단계 완료율은 **2/16=12.5%**다. 같은 비중의 단계 수이며 작업량 추정치는 아니다. 이번 세션에서 두 주소의 HTTP200을 확인했다. 새 화면 기능이나 새 브라우저 검증 결과는 없다.

## 최신 실행기 복구 결과

두 결함과v2 binding을 수정하고 **131/131 합성 단위(기존119+새12)**를 실제 실행했다. [정확한 소스 승인](./runner-v2-repair-source-review.json) 뒤 private cache 격리로 실행했으며, [결과](./runner-v2-repair-verification.json)와 [독립 수용](./runner-v2-repair-result-review.json)이 exact131 IDs·skip0·22개 입력/소스·원본96/89/17+2·환경1777/3072 전후 보존을 확인한다. 아직 전체 main/실제490은 실행하지 않았다.

공개 직전 runner 자체 SHA 검사는 구현됐고 초기 source gate도 고정 regular/nonsymlink 파일을 검사한다. 실제 watchdog5종·40node의 total 누락은 검증된 finish-start에서만 파생하며 명시된 잘못된 total·unknown kind·다른 kind의 total 누락은 거절한다. exact/초과 예산·기록 오류 회귀가 통과했다. 새 TC는 별도 파일이므로 기존 ledger104·machine38 pins를 바꾸지 않았다.

## 이번에 해결한 장애

87개 규칙·475개 기존 source annotation의 소스 대조를 완료했다. 최종953 artifact 규칙·10 phase·38 source pins를 확인했고, 외부490 inventory의83 new+4 retained fence ID와 정확히 일치한다. 확정 도우미 오류5건을 수정하고4개 모듈의269 assertion을 정적으로 보존했다. [대조 기록](../../evidence/b03/h2-machine-resolution-progress-v2.json)과 각 exact review에 근거를 남겼다.

이 결과를 별도 [v2 ledger](../../evidence/b03/h2-runtime-full-integrated-ledger-v2.json)와 [v2 계약](../../evidence/b03/h2-runtime-full-execution-contract-v2.json)에 연결했다.104개 현재 소스(103 code+machine JSON),490 ID·25업무 의무+5fixture 전제·15phase를 고정한다. 독립·TC의 정확한 작성 검토가 완료됐으며 실제 실행 승인은 포함하지 않는다. 원래 case/phase 예산을 유지하고, 원본 감사 overhead200초를 포함해 전체 cap은16220초다. 기존 c10/cf4와 주기02 참조는 보존했다.

정적 검토에서 실행기 자체의 해시가 마지막 공개 결과 생성 전에 재확인되지 않는 누락도 확인했다. v2 계약에 그 검사를 필수로 명시했다. 또한 실행 시간 검사기가 실제 watchdog5종에 없는 total_seconds 필드를 필수로 요구하는 불일치를 확인했다. 원래 monotonic 시각·구간 길이·예산 검증을 유지하면서 실제 형식에 맞추는 runner 수정이 필요하다. 두 수정의 계획·정확한 소스 검토·관련131개 합성 재검증은 위 최신 결과에서 완료했다. 전체 실행 승인은 별도다. 파일 대조·작성 승인은 실제 실행 통과가 아니다.

## 남은 순서와 완료 조건

1. **실행 후보 연결:** 완료된 v2 계약·ledger·raw rules paired 작성 검토 확인 → 완료된 두 수정·131 합성 수용 확인 → 전체 runner source review → paired execution pre-gates.
2. **필수 실행 검증:** 승인된 현재 후보의 fresh490. 누락·중복·실패·오류·skip0, 실제 SQL/history/resource/환경/개인정보 검증, 독립 실제 결과 수용.
3. **화면 연결:** 저장한 작업의 실제 접수·run/receipt·QUEUED 표시. 정상·중복 접수·권한 오류·새로고침 유지가 같은 API/DB 작업을 가리켜야 한다. QUEUED는 접수이며 업무 완료가 아니다.
4. **전달:** 브라우저 결과·URL·화면 캡처·직접 해볼 순서·제한·커밋/push를 함께 제공한다.

현재 후보의 SDK import/pytest collection/test/SQL/service/full main은 아직 실행하지 않았다. 현재 runner는v2 상수/리뷰에 연결했지만 전체 source/paired execution gates가 없으므로 실행 차단을 유지한다.

## 기존 검증 근거

- [119건 합성 검증](./full-runner-repair-verification.json), [정확한 소스 검토](./full-runner-repair-source-review.json), [독립 결과 검토](./full-runner-repair-result-review.json). 새 private pycache prefix에서119/119 통과했으며 보호 AX96/89 inventory·설계17+원본2·환경1777/3072 항목을 보존했다. 실제 main/SDK/SQL/full490 검증은 아니다. runner 바이트 변경 후에는 해당 소스 승인을 그대로 재사용하지 않는다.
- 계획: [주기03](./PLAN.md), [원본 감사 통합](./RAW-AUDIT-INTEGRATION.md), [실행기 복구](./FULL-RUNNER-REPAIR.md).
- source annotation 진행 중의83/469·58/87 등의 수치는 [과거 인계 기록](../../RESUME-HISTORY-2026-10-21.md)과 Git 이력에 보존했다. 현재 상태는 본 문서와 [progress](../../progress.json)를 따른다.

전체 H2/H3–H7·원래 AT32·실제 Agent/장비/배포·최종 목표는 미완료다. 재개 시 [RESUME](../../RESUME.md)부터 읽는다.
