# 주기02 — 실제 요청 저장과 작업 상세

목표: 사용자가 브라우저에서 요청을 한 건 등록하고 실제 IFPMIC API/PostgreSQL에 저장된 접수 영수증·작업 상태를 조회한다. 새로고침과 API 재시작 후 같은 작업이 남아 있어야 한다. 최종 IFPMIC workflow 실행과 전체 인수 범위는 유지한다.

## 원본과 구현 경계

- 근거: design-v1의 API 계약 `POST /api/v1/jobs`, `GET /api/v1/jobs`, `GET /api/v1/jobs/{job_id}`, `GET /api/v1/commands/{command_id}` 및 인증/CSRF/소유권/멱등성 계약. 인수 연결은 AT21(권한)의 관련 부분과 B01/B02/G3/G4다. 이번 API 재시작 후 재조회는 좁은 저장 지속성 검사다. AT16은 접수 후 outbox 배달 전 중단·재배달·중복 제거까지 요구하므로 이번 범위에서 수용하지 않으며 실제 실행 주기의 필수 검증으로 남긴다. AT21 전체 완료도 주장하지 않는다.
- 기존 `services/ifpmic_api`의 factory·검증·DB migration·Node snapshot bridge를 사용한다. 기존 AX GET-only 서버와 보호된 원본 UI, Paperclip 설정/DB, 원본17개와 ZIP/DOCX는 변경하지 않는다.
- 신규 UI/로컬 실행 지원은 `experiments/ifpmic-live/`에 둔다. 별도 loopback 포트8769, 별도 gitignored0700 데이터 디렉터리, pinned PostgreSQL18.1과 기존32-package Python 환경을 사용한다. 설치·다운로드·사내 접속을 하지 않는다.
- 로컬 데모 OIDC issuer는 합성 사용자 두 명의 authorization code+PKCE/nonce/서명/JWKS를 제공한다. 실제 API의 OIDC callback·세션·CSRF 검증을 통과한다. 세션을 DB에 직접 발급하거나 인증 middleware를 우회하지 않는다. 사내 SSO 수용 증빙으로 집계하지 않는다.
- bootstrap만 프로젝트·계정별 membership·고정 mock profile/catalog/eligibility를 준비한다. API는 비소유 runtime 계정과 실제 SQL 함수를 사용한다. 서비스 계정은 SCRAM, PG TCP는 끈다. 비공개 설정과 비밀번호·세션·raw 로그는 공개 증빙에서 제외한다.
- profile은 기존 검증된 합성 fixture를 별도 store에 고정한다. 실제 장비/배포 프로파일이 아니다. dispatcher/worker/Temporal/장비/Publisher를 시작하지 않는다.
- 신규 route는 격리된 `experiments/ifpmic-live/` launcher/adapter에서만 로컬 데모 context/정적 파일 제공을 추가한다. 기존 `services/ifpmic_api` factory/route 코드는 수정하지 않는다. 운영 API DTO/인가·쓰기를 변경하거나 새 job을 직접 SQL INSERT하지 않는다.

## 화면 동작과 관찰 기준

1. 브라우저는 API의 `/auth/login`에서 시작해 데모 issuer에서 계정을 선택하고 실제 callback으로 로그인한다. UI는 `/api/v1/session`의 CSRF를 메모리에서만 사용한다.
2. 고정 데모 project/profile을 확인하고 title/request_text/change_type/base_ref/release_mode를 입력한다. 첨부는 이번 범위에서 빈 배열만 전송한다. 전송 직전 고유 Idempotency-Key와 동일 payload를 탭 세션에 보존한다.
3. 한 번의 클릭은 한 요청만 보낸다. 응답이 불명확하면 같은 key/body만 재시도한다. 미확정 요청이 남은 상태에서 자동으로 새 key를 만들어 중복 생성하지 않는다. receipt 확보 또는 명확한 입력 거절 이후 새 요청을 시작한다.
4. 202 응답의 resource_id로 실제 GET 상세를 조회하고 command_id로 접수 상태를 조회한다. 상세/목록/선택 작업 ID는 새로고침 후 복구한다. 인증 토큰/CSRF는 storage나 URL에 넣지 않는다.
5. DRAFT는 `요청 저장됨 · 실행 전`, current_step_ids=[]는 `아직 시작된 단계 없음`으로 표시한다. `accepted`를 실행 성공으로 표시하지 않는다. API에 없는 wait_reason/title/request_text를 서버 결과인 것처럼 만들어내지 않는다.
6. 실제 API 오류의 고정 code를 사용자 문구로 표시하며 raw exception/SQL/설정은 표시하지 않는다. textContent로 렌더링하고 요청 내용을 HTML로 실행하지 않는다. 다른 사용자의 작업은 목록/직접 URL에 노출되지 않아야 한다.

## 단계별 검증

| 단계 | 목적 | 대상 | 방법 | 담당 | 합격 기준 | 예상 결과·증빙 | 실패 복구/재검증 |
|---|---|---|---|---|---|---|---|
| I02-PLAN | 구현/시험 범위와 원본 경계 고정 | 본 계획과 실제 API DTO | TC 독립 정적 검토, 구현 전 승인 | Code-dev 작성, TC 검토 | 8항목·정상/오류/경계/회귀·잔여 위험 명시 | exact SHA plan-review | 지적 수정 후 동일 바이트 재검토 |
| I02-SOURCE | 실제 API/인증/DB를 우회하지 않는 구현 | 신규 UI/launcher/OIDC/검증 코드 | root diff·구문/타입 검토, 인증·수명 관리 독립 리뷰 | Code-dev/독립 reviewer | 직접 세션/작업 삽입0, loopback/데이터 격리, 민감 노출0, 지연/종료 bounded | source pins/검토·개인 설정0700/0600 | 실행 전 수정·리뷰, 실패 원인 보존 |
| I02-LIVE | 한 건 저장·조회·중복 방지·소유권 | 실제 browser/API/PG | TC Playwright: OIDC 로그인→POST202→GET 상세/명령; reload; 동일 key/body 재전송; 변경 body409; 무세션401/잘못된 CSRF403; A/B 소유권; HTML 문자열 안전 표시 | TC 작성, Code-dev 실행 | DB job/command/outbox/intent 한 건, same receipt; A/B 목록·직접 조회 격리; DRAFT/accepted/빈 단계 유지; 요청·오류를 가짜 완료로 표시하지 않음 | 합성 데이터만 화면 PNG/정제 결과, raw SQL·HTTP/로그는 비공개 | 실제 경계 원인 수정, 영향 정상/예외 재실행; 원 요청을 임의 삭제·reset하지 않음 |
| I02-PERSIST | 새로고침과 서비스 재시작 후 영속성·정리 | API process·동일 PG data | 새로고침 및 API 중단/재시작 후 같은 job/receipt 조회; 종료 시 소유한 PID/start ticks 확인; 원래 데이터/PG env 보존 | Code-dev/TC | 레코드/receipt/소유권 불변, 비소유 프로세스 종료0, 정지 시 소켓/프로세스 확인 | 비공개 lifecycle/SQL, 공개 상태·카운트/해시 | 불명확한 process를 새로 시작하지 않고 동일 handle 확인; 잔여 자료 보존 |
| I02-REGRESSION | 기존 AX/설계와 화면 전달 유지 | 원본96/inventory89·설계17/upload2, 기존 build/화면 | 원본 hashes 비교, 기존 npm build와 iteration01 관련 browser 검사; 별도 신규 UI browser 정상/오류/mobile | Code-dev/TC | source 변경0, 관련 검사 실패0, 외부 전송0 | 정제 회귀 결과/캡처/소스 해시 | 영향 확대 시 관련 추가 회귀, 실패 보존 |
| I02-REVIEW | 과장 없이 결과 전달 | 실제 증빙과 요구사항 | 독립 Agent가 source/SQL·browser 결과와 시연/실제 범위 대조 | 독립 reviewer | 해당 흐름만 승인; 사내 SSO/H2/AT32/최종 완료 과장0 | 사용자 URL·이미지·검증·한계·다음 한 가지·commit/push | 반려 단계 재검증 |

## 세부 정상·예외·경계·회귀

- 정상: 사용자A의 실제 요청/receipt/detail/list, reload, 사용자A 재로그인, API 재시작 후 조회, mobile.
- 예외: 입력 누락/잘못된 enum·profile, 세션 부재, CSRF 오류, 다른 사용자의 direct detail/command, 같은 key 다른 body409. private 오류가 UI에 새어 나오지 않는다.
- 경계: 반복 클릭/재시도, 응답 유실 상태에서 같은 key/body 재사용, 사용자 전환 시 이전 계정 상세 숨김, 빈 current steps와 미제공 wait reason, HTML 입력 문자열 실행0.
- 회귀: 기존 원본 계약/AX 소스 보존과 workflow viewer/replay. 보호 소스를 바꾸지 않으므로 운영 Paperclip host 장착 전체 gate와 H2 runtime490 전체 실행은 이번 요청 저장 흐름에서 수행하지 않는다. 그 범위의 완료/면제를 주장하지 않으며 실제 실행 연동 전 필수 검증으로 남긴다.
- 신규 데모 bootstrap은 기존 제품 검증을 대체하지 않는다. 표준 회사 SSO/TLS·운영 DB/프로파일·실제 Agent·장비·배포는 미수용이다. 데모의 실제 저장과 합성 계정/프로파일을 화면에 함께 표시한다.

## 제한과 다음 주기

이번 API는 생성 이후 DRAFT/current_step_ids=[]와 빈 steps를 반환한다. 실제 workflow 진행·대기 이유 상세는 아직 연결하지 않았으며 그 한계를 화면에 표시한다. 다음 주기는 현재 H2 후보의 필수 검증을 통과한 실제 실행 한 구간을 화면에 연결하는 것이다. 이 계획은 원래25개 H2 의무·490개 후보·H3–H7·전체 AT32를 삭제하지 않는다.
