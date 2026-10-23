# I02 요청 화면의 실제 실행 접수 연결 계획

상태: **DRAFT · 독립 API/DB/보안 검토 전 · 구현 불가**. 실제 H2 통합 490건 전체 실행과 독립 결과 수용이 끝나기 전에는 이 작업의 제품 구현이나 실행 연결을 시작하지 않는다. 현재 V5 실행은 12건 중 9통과·3실패, 478건 미실행이며, V6 보완은 아직 실제 실행·수용되지 않았다. 별도 152개 합성 단위 결과는 이를 대체하지 않는다.

## 목적과 대상

사용자가 이미 저장한 한 요청이 실제 Temporal 실행에 접수되고, 같은 command/job에 결속된 run 및 projection receipt가 확인된 뒤 현재 I02 화면에서 `QUEUED`로 보이는 한 흐름을 전달한다. `QUEUED`는 B03의 초기 투영 상태다. 실행 완료, 품질 통과, 사람 승인, 장비 검증 또는 최종 제품 인수를 뜻하지 않는다.

확장 대상은 새 화면이 아니라 기존 I02 저장 요청 UI인 `experiments/ifpmic-live/web/index.html`과 `experiments/ifpmic-live/web/app.js`다. 기존 폼은 `POST /api/v1/jobs`의 `202 accepted`를 저장하고 GET으로 job/command를 다시 읽으며 account/list/detail/command epoch로 오래된 응답을 버린다. `execution_connected:false`를 확인하는 mock/local context가 있어 아직 실행 연결은 의도적으로 비활성화되어 있다. `src/ifpmic/WorkflowPage.tsx`는 읽기 전용 설계/모의 재생 화면으로 유지하며 요청 기능을 중복 구현하지 않는다.

현재 launcher `experiments/ifpmic-live/launcher.py`는 실제 API·PostgreSQL·로컬 합성 OIDC만 띄우고 dispatcher, worker, Temporal은 시작하지 않는다고 명시한다. 승인된 다음 단계에서는 이 실행기를 검토된 private config와 source-pinned identity에 결속된 자체 관리 Temporal endpoint, dispatcher, worker까지 명시적으로 supervise하도록 확장하는 방안을 검토한다. 단순히 `execution_connected` 표시를 바꾸거나 사용자 API에서 직접 workflow start를 호출하는 방식은 허용하지 않는다. API `POST`는 계속 durable command 수락만 한다. dispatcher/outbox가 같은 command를 전달하고 Temporal history/admission을 관찰하며, B03 projection이 durable receipt와 job 상태를 반영한다.

## 요구사항 추적과 변경 경계

- **B03 / REQ-05 / AT-05, AT-16, AT-29**: Temporal 단일 전이 결정, command outbox 재전달·중복 제거, worker 재시작/버전 pin. 이번 표시 목표는 AT-05/16/29 전체 수용을 뜻하지 않으며 각각의 완전한 시나리오 증거가 필요하다.
- **B02 / REQ-13 / AT-21**: 요청·job 권한 및 A/B 정보 격리. I02 회귀에서 확인한 부분 결과를 원본 AT-21 전체 인수로 확대하지 않는다.
- **REQ-02, REQ-14 및 B01/B02 불변 조건**: 승인된 profile/workspace/membership, 실패·대기 상태, 현재 세션 권한과 원본 workflow 경계를 유지한다.
- **기존 UI/API 계약**: `202`는 접수 응답으로 보존한다. 같은 actor/key/body 재시도는 같은 command/job receipt이고, 같은 key의 body 변경은 `409`다. GET은 읽기만 한다. 권한 없는 job/command/receipt 접근은 기존 숨김 규칙의 `403`; admission이 아직 확인되지 않은 경우의 `425`는 독립 계약 검토에서 응답 의미와 DTO를 고정하기 전까지 UI에서 성공으로 처리하지 않는다. 미인증은 `401`, 유효하지 않은 CSRF/Origin은 `403`이다.
- 원본 `docs/ifpmic/design-v1/specs/` 파일은 수정하지 않는다. API 확대가 필요하면 additive 문서를 별도 버전 경로(예: `docs/ifpmic/api-extensions/admission-status.v1.json`)에 작성하고 구현 전 독립 계약 검토를 받는다.

## API, 안전한 DTO와 DB 권한 선택지

현재 `/api/v1/jobs`, `/api/v1/jobs/{job_id}`, `/api/v1/commands/{command_id}`가 저장·job·command 조회 경로다. 별도 admission/receipt API가 필요한지는 구현 전 API·DB·보안 검토로 결정한다. 응답은 현재 인증 주체를 매 요청마다 검증하고, job/command/receipt를 같은 project/job/run 및 유효 owner 또는 membership/delegation에 결속해야 한다. 안전한 최소 DTO 후보는 `{job_id, command_id, command_status, job_status, admitted_run_id, receipt_sequence, receipt_status}`다. 요청 원문, raw command payload, workspace 경로/token, workflow/binding 내부 문서, SQL/Temporal 오류 원문, credential/profile 비밀은 포함하지 않는다.

현재 migration `003_workflow_execution.sql`은 execution binding, attempt, receipt 테이블에 대한 direct table access를 runtime role에서 거부하고 dispatcher/projector에 함수별 `EXECUTE`를 준다. 이 권한 경계를 유지할 두 조회안을 검토한다: (1) 사용자 API가 auth 및 기존 visibility predicate를 먼저 적용한 뒤 job ID 하나로 호출하는 제한 `SECURITY DEFINER` 조회 함수, (2) 실행 영역에서 최소 safe DTO만 사용자 조회 가능한 projection으로 내보내는 전용 읽기 함수/view. 어느 안도 owner 권한, 넓은 `SELECT`, 기존 내부 테이블 grant를 추가하지 않는다. 함수 소유자, `search_path`, 입력 필터, 권한 재검증, 누락/교차 job의 동일 응답, 반환 필드, receipt 불변성을 코드 작성 전에 독립 검토한다.

## 사용자 흐름과 검사

### 정상 동작

1. 실제 I02 화면에서 로그인한 사용자가 요청을 저장한다. 현재 CSRF, 허용 Origin, 단일 Idempotency-Key, body 검증과 private sessionStorage 복구 동작을 유지한다.
2. `202 accepted` 뒤 화면은 먼저 “요청 저장됨 · 실행 접수 대기”를 보인다. API 응답만으로 run 생성이나 `QUEUED`를 추정하지 않는다.
3. 같은 요청을 GET으로 다시 읽는다. API가 같은 command/job과 실제 admitted run을 증명하고, 같은 run에 결속된 durable projection receipt가 확인될 때만 `QUEUED`를 표시한다.
4. 새로고침과 브라우저 재시작 후에도 같은 job을 API에서 다시 가져온다. sessionStorage에는 기존처럼 계정별 pending key/body와 receipt ID만 보관하고 인증/CSRF token은 저장하지 않는다. 계정 변경·로그아웃·401은 account epoch를 회전시켜 이전 계정 요청/응답이 새 화면을 덮지 못하게 한다.

### 실패·경계·회귀

- 정상 단건, 같은 key/body 중복, 같은 key/다른 body의 `409`, POST 응답 유실 후 같은 key 재시도, 동일 run/receipt 중복 생성 방지를 확인한다.
- 미인증 `401`, 잘못된 CSRF와 Origin `403`, A/B 직접 GET 및 목록/상세/command/admission/receipt 교차조회 `403`을 확인한다. B에 A 데이터의 존재·ID가 노출되면 실패다.
- 대기 중 응답은 승인된 계약의 `425` 또는 기존 안전한 pending 상태로 표시하고, run/receipt가 아직 없으면 `QUEUED` 배지는 표시하지 않는다. dispatcher, Temporal, worker, DB 장애·재시작·응답 불명확은 같은 저장 요청을 기준으로 reconcile하며 새 idempotency key나 사용자 start 경로를 만들지 않는다.
- reload/restart/session expiry/account A→B 전환에서 pending 복구, job 상세 및 command 조회, epoch guard, stale network response 폐기를 검증한다. HTML/text 출력은 현재 `textContent` 경계를 유지한다.
- 기존 회귀는 `202`, same-key same-body, changed-body `409`, `401`, CSRF/Origin `403`, GET-only 읽기, A/B 분리, 서버 재시작 후 I02 데이터 지속성, 계정 epoch, 민감 데이터 미노출을 포함한다. B03 AT-16 crash/restart는 실제 outbox/Temporal/PG 재시작 시나리오로 따로 수용한다. UI 지속성 검사로 대체하지 않는다.

## 역할, 합격과 증거

- **Code-dev**: H2 실제 490 전체 통과 및 독립 결과 수용, 본 계획의 독립 리뷰, source/API/DB/launcher/UI 개별 승인 이후에만 좁은 변경을 구현한다. 현재 I02 UI를 확장하고 pinned execution environment를 자체 관리하며, 승인된 API command→outbox→dispatcher→Temporal→projection 경로를 사용한다.
- **TC**: 사전 고정된 HTTP/DB/launcher/worker/Temporal/browser 정상·오류·경계·회귀 케이스와 A/B 계정, 재시작·중복 경합 증거를 담당한다. 생산 구현·합격 기준 완화는 하지 않는다.
- **독립 검토자**: 계획과 고정 source/DTO/SQL grants/launcher process identity/API ACL/UI 표시를 각각 검토하고 실제 결과의 job-command-run-receipt 결속 및 미완료 범위를 판정한다.
- **합격 기준**: 한 `202` command와 job에 대해 정확히 하나의 admitted run과 유효 projection receipt가 존재하고, 화면이 해당 receipt 확인 후에만 같은 job의 `QUEUED`를 표시한다. 중복 side effect와 교차 계정 노출은 0건이며 reload/restart 후에도 API 조회 값이 동일하다. `QUEUED` 뒤 실제 완료나 AT-05/16/29·AT-21·AT-32·16개 단계 전체를 완료했다고 주장하지 않는다.
- **증거**: private verification leaf에 고정 환경/source/config hash, launcher가 시작한 process identity, Temporal admission/history와 DB before/after receipt, sanitized browser/API 결과, A/B 권한 결과, 재시작 기록을 보존한다. 공개 문서에는 redacted 결과, 검토 hash, 필요한 캡처만 연결한다. 합성 152개 결과와 실제 490개 결과를 섞지 않는다.
- **복구**: 실패 leaf를 변경 없이 보존한다. 응답이 불명확하면 기존 key와 job/run을 조회해 reconciliation한다. 임의 workflow start, DB 수동 수정, 새 요청으로 덮기, `QUEUED` 강제 표시를 하지 않는다. 영향받은 인증·idempotency·projection·runtime 경계를 고치고 승인된 관련 회귀를 다시 실행한다.

## 여덟 검증 기록 항목

| 항목 | 이번 계획 |
|---|---|
| 목적 | I02에 저장한 요청의 실제 admission과 같은 run/receipt 기반 `QUEUED` 표시 |
| 대상 | I02 web, 기존 job/command API, reviewed admission DTO, launcher/runtime; B02/B03 및 REQ-05/13, AT-05/16/21/29 |
| 방법 | 정상 단건·중복, 인증/CSRF/A-B 오류, 불명확·지연·재시작 경계, I02와 B03 회귀 |
| 담당 | H2 수용 뒤 Code-dev, 독립 TC, 별도 계약·소스·결과 reviewer |
| 합격 기준 | 동일 command/job/admitted-run/receipt 확인 후 `QUEUED`; 재조회 일치, 개인정보/교차노출/중복 0 |
| 예상 결과 | 기존 요청 화면에서 저장됨·접수 대기·QUEUED를 근거에 따라 구분 |
| 증빙 | redacted UI/API 결과, hash, process/Temporal/DB 결속 및 권한 검토; 원시 자료는 private |
| 복구 | 실패 증거 보존, 같은 key/기존 run reconciliation, 영향 회귀 재검증, 우회 금지 |
