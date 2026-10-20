# 주기03 — 저장한 요청을 실행 화면에 연결하는 중

**지금 볼 수 있는 결과:** [실제 요청 등록·저장 화면](http://127.0.0.1:8769/), [29단계 workflow 탐색](http://127.0.0.1:4173/ifpmic.html). 이번 체크포인트에서 두 주소의 HTTP200을 확인했다. 실제 실행 접수와 run/receipt 표시는 아직 연결 중이다.

| 사용자 흐름 | 현재 상태 |
|---|---|
| 설계 흐름 탐색·74개 모의 시나리오 | 공개·검증 완료, 합성 시연 |
| 로그인 → 실제 요청 등록 → 목록·상세 → 재시작 유지 | 실제 로컬 API/DB 검증 완료, 합성 계정·mock 프로파일 |
| 저장 요청 → 실행 엔진 접수 → run/receipt 표시 | 진행 중, 아직 시연할 수 없음 |
| 실제 업무·사람·품질·장비·배포 경로 | 후속 작업 및 최종 인수 미완료 |

전체 필수 단계 완료율은 **2/16=12.5%**다. 동일 비중의 단계 수이며 제품 작업량 추정치는 아니다. 새 단위 검사 통과를 단계 완료율에 더하지 않는다.

## 이번에 실제 검증한 것

retained SQL/auth fence4개의 원문 검증 누락을 수정했다. 실제 producer의 case/node/파일명과 원문 canonical SHA를 연결하고, SQL 행의 모든 열·함수 반환 필드·작업 DTO·오류 본문을 검사한다. 실제 admission이 남기는 scope, primary receipt와 정상적으로 비어 있는 OID principal/conflict receipt를 구분한다. 일반 JSON 규칙으로 검사를 우회하는 변경도 거절한다.

- 신규28 + 기존65, **합성 단위93/93 통과**. 정확한 소스 승인 후 실제 실행했고 독립 결과 검토가 해당 합성 범위와 원본 보존 증거를 수용했다. 이전28·62·65건은 역사 증빙으로 보존하며 누적 수에 더하지 않는다.
- [93건 검증 요약](./fence-verification.json), [소스 승인](./fence-source-review.json), [독립 결과 검토](./fence-result-review.json), [8개 항목 보완 계획](./FENCE-VALIDATION.md).
- 보호 AX96 해시·89 목록, 설계17·업로드2, Python 환경1777/3072가 원래 승인 기준과 before/after 모두 일치했다.
- 87 case·517 artifact·10 phase machine mapping은37개 직접 소스 pin을 포함하는 초안이다. 전체 mapping·full runner·실제 SQL/H2 실행 승인이 아니다. 앞선 [hook 소스 체크포인트 검토](./raw-hooks-checkpoint-review.json)는 해당 과거 소스 범위로만 유효하다.
- 제품/UI/의존성 변경이 없어 이 단위 체크포인트에서 build/browser를 반복하지 않았다. 원본 SQL/로그·환경 map은 비공개로 보존하며, 실행 연결 때 관련 회귀를 수행한다.

## 다음에 보여줄 한 가지

**저장한 요청이 실제 실행 엔진에 접수되어 run/receipt와 QUEUED 상태가 화면에 표시되는 흐름.** QUEUED는 접수 상태이며 P01 등 업무 완료가 아니다.

이번에 확인된 SQL fence 내부 원문 검사 누락은 수정·합성 검증했다. 다음은87개 mapping 전체를 대조하고 별도 버전의490 계약·ledger와 전체 runner/paired pre-gate를 검토한 뒤 fresh490을 실행하는 것이다. 검증·독립 수용 뒤 실제 화면 연결을 진행한다. 기존 c10 계약은 주기02 재실행에 쓰이므로 덮어쓰지 않는다.

## 재개 위치

1. 이번93건 독립 결과 검토를 확인한다. 소스 변경 시 해당 exact 승인을 재사용하지 않는다.
2. 전체 mapping·새 버전 계약·ledger를 고정한다. fence helper와 TC를 새 source closure에 포함하고 옛 c10/cf4 계약·주기02 참조를 보존한다.
3. 전체 runner 검토·정확한 paired pre-gate → fresh490 → 독립 결과 수용.
4. 실제 접수 화면 연결·브라우저 검증·시연 → 커밋/push.

원본 full490 runner는 아직 실행하지 않는다. 현재 초안 status와 옛 pin은 실행을 차단한다. 전체 H2/H3–H7·원래 AT32·실제 Agent/장비/배포 인수 및 최종 목표는 미완료다.
