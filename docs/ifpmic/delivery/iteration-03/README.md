# 주기03 — 저장한 요청을 실행 화면에 연결하는 중

**지금 볼 수 있는 결과:** [실제 요청 등록·저장 화면](http://127.0.0.1:8769/), [29단계 workflow 탐색](http://127.0.0.1:4173/ifpmic.html). 이번 체크포인트에서 두 주소의 HTTP200을 확인했다. 실제 실행 접수와 run/receipt 표시는 아직 연결 중이다.

| 사용자 흐름 | 현재 상태 |
|---|---|
| 설계 흐름 탐색·74개 모의 시나리오 | 공개·검증 완료, 합성 시연 |
| 로그인 → 실제 요청 등록 → 목록·상세 → 재시작 유지 | 실제 로컬 API/DB 검증 완료, 합성 계정·mock 프로파일 |
| 저장 요청 → 실행 엔진 접수 → run/receipt 표시 | 진행 중, 아직 시연할 수 없음 |
| 실제 업무·사람·품질·장비·배포 경로 | 후속 작업 및 최종 인수 미완료 |

전체 필수 단계 완료율은 **2/16=12.5%**다. 동일 비중의 단계 수이며 제품 작업량 추정치는 아니다. 새 단위 검사 통과를 단계 완료율에 더하지 않는다.

## 2026-10-21 소스 대조 체크포인트

새 화면 기능은 없다. startup21·window/fixture14·workspace11·dispatcher8을 실제 생성 코드와 독립 대조하고 규칙에 반영했다. 기존 fence4를 합해 **58/87행의 소스 대조 완료,29행·177항목 미해결**, 현재661개 artifact 규칙이다. 이는 실행 전 source mapping이며 제품 전체 완료율은2/16=12.5%로 유지한다.

workspace stale-generation 테스트가 정의되지 않은 run_id 때문에 증빙 작성에서 실패하던 결함을 단일 필드 삭제로 수정했다. 전체 파일 AST에서 그 필드 하나만 달라지고58개 assertion이 보존됨을 독립 검토했다. [계획·source 검토](../../evidence/b03/h2-workspace-stale-observation-source-review-v2.json)와 [규칙 반영 기록](../../evidence/b03/h2-machine-resolution-progress-v2.json)을 참조한다. 실제 테스트를 실행한 것은 아니다.

dispatcher의 생성되지 않는 파일 요구3개를 바로잡고 실제 분기 출력79개를 추가했다. 거절된 초안과 수정된 exact 승인 문서를 함께 보존했다. 현재119 합성 단위의12개 소스 해시는 그대로지만 단위 검사를 반복 실행하지 않았다. 기존 두 공개 주소의 HTTP200만 재확인했다.

worker의 사전 기동 서버 기록을 같은 O_EXCL 경로에 두 번 작성하는 결함도 발견했다. 별도 수정 계획·exact source·projection 검토를 거쳐 해결한다. transport3/worker4와 activity12/started10이 남았으며 actual main/SDK/SQL/full490/실제 실행 접수는 이번 체크포인트에서 실행하지 않았다. 아래 내용의83행469항목은 이전 체크포인트 기록이다.

## 이번에 실제 검증한 것

전체 실행기 정적 검토에서 찾은 집계·watchdog 경로·helper pin·기존 pyc 읽기·전체 deadline/TERM/정리·프로세스 수 집계 결함을 수정했다. 전체 실행기의 `main`을 실행한 것은 아니며, 별도 승인된 stdlib 함수와 합성 자료로 검사했다.

- **119/119 합성 단위 통과:** 기존93 + budget/cache16 + 실행기 순수 함수10. 새 비공개 pycache prefix에서 실행해 캐시가 비어 있음을 확인했고, 독립 결과 검토가 합성 범위와 원본 보존 증거를 수용했다. 이전 검사 수를 중복 합산하지 않는다.
- [119건 증빙](./full-runner-repair-verification.json), [정확한 소스 승인](./full-runner-repair-source-review.json), [독립 결과 검토](./full-runner-repair-result-review.json), [복구 검증 계획](./FULL-RUNNER-REPAIR.md).
- 보호 AX96 해시·89 목록, 설계17·업로드2, Python 환경1777/3072 항목을 원래 승인 기준과 비교해 before/after 모두 유지했다.
- 실제 생성 코드에서 빠진 조건부 증빙18개를 더 연결해 mapping은87 case·535 artifact·10 phase다. 그러나 **최초87행에 미해결 검토 표시475개가 있었고, 독립 검토 후 SQL fence4행의6개를 근거와 연결해 해소했다. 현재는83행·469개가 남아 있다.** 이전의 미해결0건 요약은 잘못됐으며, [TC의 변경 요청](../../evidence/b03/h2-runtime-full-machine-rules-tc-review-v2.json)이 이를 기록한다. 해당 표시를 실제 소스 근거 없이 지우지 않는다.
- 제품/UI/의존성이 바뀌지 않아 이 단위 checkpoint에서 build/browser를 반복하지 않았다. 실제 SDK/SQL/서비스 및 전체490 검증·주기03 완료는 미수용이다.

## 다음에 보여줄 한 가지

**저장한 요청이 실제 실행 엔진에 접수되어 run/receipt와 QUEUED 상태가 화면에 표시되는 흐름.** QUEUED는 접수 상태이며 P01 등 업무 완료가 아니다.

이번에 확인된 SQL fence 내부 원문 검사 누락은 수정·합성 검증했다. 다음은 mapping에 남은 경로·조건·JSON schema 검토 표시를 실제 producer와 대조해 해소하는 것이다. 그 뒤 별도 버전490 계약·ledger와 전체 runner/paired pre-gate를 검토하고 fresh490을 실행한다. 검증·독립 수용 뒤 실제 화면 연결을 진행한다. 기존 c10 계약은 주기02 재실행에 쓰이므로 덮어쓰지 않는다.

## 재개 위치

1. 이번119건 독립 결과 검토와 mapping TC 변경 요청을 확인한다. 소스 변경 시 exact 승인을 재사용하지 않는다.
2. [mapping 해소 기록](../../evidence/b03/h2-machine-resolution-progress-v2.json)에 따라 startup21행부터 남은83행·469개 표시를 실제 근거와 연결해 해소하고 새 버전 계약·ledger를 고정한다. fence helper와 TC를 새 source closure에 포함하고 옛 c10/cf4 계약·주기02 참조를 보존한다.
3. 전체 runner 검토·정확한 paired pre-gate → fresh490 → 독립 결과 수용.
4. 실제 접수 화면 연결·브라우저 검증·시연 → 커밋/push.

원본 full490 runner는 아직 실행하지 않는다. 현재 초안 status와 옛 pin은 실행을 차단한다. 전체 H2/H3–H7·원래 AT32·실제 Agent/장비/배포 인수 및 최종 목표는 미완료다.
