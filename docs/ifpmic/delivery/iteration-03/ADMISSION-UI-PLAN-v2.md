# I02 저장 요청의 실제 실행 접수 표시 · V2

상태: **DRAFT · 독립 계약 검토 및 실제 H2 수용 전에는 구현 금지**. V1 초안은 수정하지 않고 [독립 검토](./admission-ui-plan-review.json)와 함께 lineage로 보존한다. 이 V2는 API/SQL/launcher/UI의 구체 검토 계약이다. 현재 검토 대상 H2 후보의 실제490 전체 통과·독립 수용과 이 V2의 독립 검토가 모두 끝나기 전까지 이 UI/API 변경에 속한 제품 코드·tests·migration·실행환경·서비스를 구현하지 않는다. 이미 실패한 V6의 성공을 가정하지 않으며, 별도 검토된 H2 복구 수정과 새 후보 검증은 이 UI 구현 금지의 대상이 아니다. 152개 합성 결과와 실행 전 gates는 490건 실제 수용이 아니다.

## 목적과 원본 범위

기존 I02 요청 화면에서 저장된 CreateJob 하나가 G5 workspace 준비 후 실제 B03 dispatcher/Temporal worker에 전달되고, 같은 job·create command·admitted run·sequence 1 projection receipt로 `QUEUED`가 반영된 것을 읽기 전용 API에서 확인해 표시한다. `QUEUED`는 최초 실행 projection이다. 완료, P07/P21 사람 제출, 품질 판정, 장비 검증, release 또는 전체 acceptance가 아니다.

변경 대상은 `experiments/ifpmic-live/web/index.html`, `experiments/ifpmic-live/web/app.js`, `experiments/ifpmic-live/launcher.py`와 IFPMIC API/migration 및 별도 additive API schema다. 현재 I02 UI는 `POST /api/v1/jobs`의 `202 accepted`를 저장하고 `GET /api/v1/jobs`, `/api/v1/jobs/{job_id}`, `/api/v1/commands/{command_id}`로 다시 읽는다. 세션별 pending key/body, CSRF, account/list/detail/command epoch guard가 이미 있다. `src/ifpmic/WorkflowPage.tsx`의 설계/모의 화면은 이 요청 흐름과 분리해 유지한다.

직접 추적은 **B02 / REQ-13 / AT-21(사용자 작업 격리)**, **B03 / AT-16(전달 전 장애·재시작과 command_id 재전달)** 및 초기 admission의 관련 구간이다. **REQ-05 / AT-05**는 P07/P21의 사람 담당 단계를 보존하며 사람 제출 없이는 진행하지 않는 조건이다. 초기 `QUEUED`가 이를 수행하거나 AT-05를 통과했다고 뜻하지 않는다. **B03 / AT-29** 버전 호환 재개도 별도 범위다. **REQ-12 / AT-03**는 웹 실시간 확인과 SSE 재연결/중복 억제다. 이번 GET 기반 표시가 SSE를 추가하거나 AT-03을 완료하지 않으며, 별도 B04 검증으로 남긴다. **AT-21 전체**(로그/image/device 포함), **AT-16 전체**, **AT-29**, **AT-32** 및 원본 acceptance는 각각의 원래 시나리오를 별도로 수용해야 한다.

원본 `docs/ifpmic/design-v1/specs/`와 OpenAPI V1 bytes는 변경하지 않는다. 새 계약은 `docs/ifpmic/api-extensions/admission-status.v1.json`에 additive version으로 기록하고, 구현·browser 연결 전에 계약 검토를 받는다. 현재 변경 차단 중인 H2 source/test files는 V6 시도가 종결되고 결과 수용 및 후속 source pin 절차가 끝나기 전 수정하지 않는다.

## 확정할 API 계약

하나의 새 GET 경로를 선택한다: **`GET /api/v1/jobs/{job_id}/admission`**. 기존 `POST /api/v1/jobs`, job snapshot, command DTO는 그대로 둔다. GET은 side effect/CSRF write 동작을 하지 않는다. `202` 수락, same actor/key/body replay, changed body `409`는 기존 의미를 보존한다.

성공은 항상 HTTP **200**이며, 실행이 아직 시작되지 않았거나 receipt가 기다리는 경우도 safe pending DTO를 반환한다. `425`를 새로 도입하지 않는다. 경계 응답은 다음으로 고정한다.

| HTTP | 의미 |
|---|---|
| 200 | 현재 세션에서 볼 수 있는 job의 pending 또는 일관된 admission projection DTO |
| 401 `AUTH_REQUIRED` | 없거나 만료/폐기된 세션 |
| 403 `FORBIDDEN` | 잘못된 UUID, 없는 job, 비가시 job; 세 경우를 구분하지 않음 |
| 503 `DEPENDENCY_UNAVAILABLE` | DB/function 의존성 장애 또는 보안·상태 tuple 모순/예상치 않은 cardinality; 내부 오류 세부 내용은 반환하지 않음 |

V1 additive schema의 성공 필드는 아래로 고정한다. UUID와 순번은 내부 리소스 식별자이고 bearer credential이 아니다.

```json
{
  "schema_version": "ifpmic.admission-status.v1",
  "job_id": "uuid",
  "command_id": "uuid",
  "admission_status": "pending | admitted_pending_projection | applied | rejected | quarantined",
  "job_status": "current job status",
  "job_revision": 0,
  "command_status": "accepted | applied | rejected",
  "applied_revision": null,
  "admitted_run_id": null,
  "receipt": null,
  "error_code": null
}
```

DTO 상태와 null/cardinality 의미:

| `admission_status` | 필수 저장 tuple | 반환 규칙 |
|---|---|---|
| `pending` | CreateJob command `accepted`, `applied_revision=NULL`; job `DRAFT`, revision 0; binding 없음 또는 `reserved`/run 없음; outbox가 정상 pending/leased/uncertain/dispatched 상태; sequence 1 receipt 없음 | `admitted_run_id=null`, `receipt=null`, `error_code=null`. Workspace가 READY 전이거나 deployment가 아직 준비되지 않은 저장 요청도 여기에 머문다. |
| `admitted_pending_projection` | 위와 같은 accepted/DRAFT revision 0; binding `admitted`와 정확한 non-null run; sequence 1 receipt 없음 | run UUID를 반환하고 receipt/error는 null. 이는 접수된 history가 있으나 projection 완료는 아직 아님을 뜻한다. |
| `applied` | 같은 project/job/create command/run의 sequence 1 receipt 하나, `outcome='applied'`, `expected_revision=0`; immutable result JSON의 command/job/run 연계 및 `applied_revision=1`, 초기 `job_status='QUEUED'`, `revision=1`, `error_code=null` 일치; command `applied/applied_revision=1`; 현재 job revision≥1 | `receipt={transition_sequence:1,outcome:"applied",expected_revision:0,applied_revision:1,projected_job_status:"QUEUED",projected_revision:1}`와 admitted run을 반환한다. `job_status/job_revision`는 현재 job 상태/버전이다. UI는 현재 상태가 `QUEUED`일 때만 그 배지를 보이고, 이후 현재 상태가 바뀌었다면 그 상태를 표시한다. |
| `rejected` | 같은 job/create command/run의 seq1 receipt 하나, `outcome='rejected'`, expected revision 0; receipt result가 DRAFT/revision0/applied revision null의 command/job 결과와 일치; command `rejected/applied_revision=NULL`; job `DRAFT` revision 0 | receipt의 초기 투영은 `DRAFT`로 표시하고 QUEUED는 표시하지 않는다. `error_code`는 고정 승인 enum만 허용한다. 원시 예외/SQL 메시지는 금지한다. |
| `quarantined` | 유효한 sequence 1 receipt가 없어야 한다. (a) binding `quarantined`와 outbox `quarantined` 또는 이미 `dispatched`인 bound case, 또는 (b) migration 004의 승인된 **pre-binding** 경로: binding 없음, outbox `quarantined`, code `WORKSPACE_IDENTITY_CONFLICT`; command accepted/job DRAFT revision0 | bound binding에 run이 이미 있으면 UUID, 아니면 null. Pre-binding 경로는 반드시 `admitted_run_id=null`. receipt는 null. quarantine code가 있으면 고정 enum만 반환한다. QUEUED는 표시하지 않는다. Binding quarantine 전 생성된 valid seq1 receipt가 있으면 이 행이 아니라 immutable receipt의 `applied`/`rejected` 결과를 유지한다. |

고정 `error_code` enum은 rejected에 `FORBIDDEN`, `PROFILE_INELIGIBLE`; pre-binding quarantine에 `WORKSPACE_IDENTITY_CONFLICT`; bound quarantine에 `BINDING_CONFLICT`, `BUILD_UNAVAILABLE`, `RUN_CONFLICT`, `HISTORY_MISSING`, `START_WINDOW_EXPIRED`, `RETENTION_UNVERIFIED`, `CATALOG_IDENTITY_CONFLICT`, `PROPOSAL_COLLISION`, `PREDECESSOR_CONFLICT`, `COMMAND_IDENTITY_CONFLICT`다. 이 집합 밖의 저장 code는 503 consistency failure로 처리한다. UI는 각 허용 code를 로컬라이즈된 문구로 매핑하고 원시 DB/SQL 문자열을 표시하지 않는다.

위 표의 어느 행에도 맞지 않는 cross-project/job/command/run, create-route, result JSON, revision/state, outbox/binding quarantine 불일치, 복수 row 또는 cardinality 충돌은 억지로 pending/rejected로 정규화하지 않고 HTTP 503 `DEPENDENCY_UNAVAILABLE`로 fail closed한다. DB 장애와 consistency failure는 동일한 외부 error shape를 쓰고 trace ID 외부에 raw error를 싣지 않는다. 읽기 함수는 정상 row에 대해 정확히 한 결과를 내야 하며 그 결과가 누락되면 API는 503으로 처리한다. receipt lookup은 sequence 1만 본다. 미래 전이의 receipt를 초기 CreateJob receipt로 바꾸지 않는다.

## 세션·SQL 권한 계약

API의 기존 `JobService.transaction()` 안에서 `auth.authenticate(db, request)`로 브라우저 세션을 검증하고 `current.user_id`만 end-user actor로 사용한다. PostgreSQL의 shared API runtime login/`session_user`는 browser user가 아니다. HTTP actor/owner/project/grant parameter, `SET ROLE`, caller GUC, Paperclip user ID, dispatcher/projector credential로 end-user identity를 위장하지 않는다.

가시성은 현재 `services/ifpmic_api/jobs.py`의 `VISIBLE`을 그대로 쓴다: 활성 membership이 있어야 하고, `(j.owner_id=current.user_id)` 또는 같은 project/job의 `job.read` delegation이 존재하며 `revoked_at IS NULL`이고 `expires_at > auth.now()`여야 한다. Job owner만으로 inactive membership을 우회하지 않는다. 이 GET은 사람 approval 권한이나 write delegation을 추가하지 않는다.

API는 **한 SQL statement**에서 `jobs j`를 visibility 기준 행으로 두고 `LEFT JOIN commands c ON c.command_id=j.create_command_id AND c.job_id=j.job_id AND c.project_id=j.project_id AND c.route='POST /api/v1/jobs'`, 이후 `LEFT JOIN LATERAL ifpmic.read_job_admission(j.job_id)`를 호출한다. 같은 statement의 `WHERE j.job_id=%s AND <기존 VISIBLE>`가 visibility와 admission row를 같은 PostgreSQL statement snapshot에서 판정한다. `jobs`가 없거나 invisible이면 query row가 없어 403이다. 반면 visible job은 있는데 exact create-command join, admission function row, job/project/create-command/owner tuple이 빠지거나 어긋나면 existence와 권한 정보를 세분화해 노출하지 않고 503 consistency failure로 처리한다. 별도 “ID 존재” precheck 이후 다른 query로 receipt를 읽는 구현은 허용하지 않는다. API runtime이 받은 결과의 `job_id/project_id/create_command_id` 및 command actor=job owner identity를 이 query에서 검사하고 결과는 정확히 한 row여야 한다.

새 migration `005_admission_read.sql`에서 `ifpmic.read_job_admission(uuid)` 한 함수만 추가하는 안을 확정한다. 함수는 read-only `STABLE SECURITY DEFINER`, 고정 `search_path=pg_catalog,ifpmic,pg_temp`, 완전 수식 schema/table/function 참조, dynamic SQL 없음, 입력은 `job_id` 하나다. 함수 소유자는 별도 `ifpmic_admission_reader` NOLOGIN/NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOINHERIT/NOBYPASSRLS 역할이다. 이 역할에는 schema USAGE와 함수에 필요한 최소 column-level SELECT만 `jobs`, `commands`, `commands_outbox`, `execution_bindings`, `projection_receipts`에 준다. `commands_outbox`의 `state/last_error`와 binding quarantine code를 사용해 실제 004 pre-binding quarantine과 binding quarantine를 구별한다. `result_json` 전체를 반환하지 않고 고정 key만 추출해 검증/반환한다. `PUBLIC`, operator, dispatcher, projector에는 함수 EXECUTE를 revoke하고 **API runtime role에만** EXECUTE를 준다. Runtime은 별도 owner 권한이나 직접 execution table SELECT를 받지 않는다. API가 shared service trust boundary라는 점은 문서와 threat model에 명시한다. Migration 검토는 owner, grant, `search_path`, function body, cardinality, fixed result enum을 함께 확인한다.

## Existing I02 UI와 process path

`experiments/ifpmic-live/launcher.py`의 현재 구현은 PostgreSQL/API/합성 OIDC를 시작하며 Temporal, workspace worker, dispatcher, worker는 시작하지 않는다. `/demo/context` 및 `validateContext()`는 현재 `execution_connected:false`를 고정하므로 화면에 표시만 바꾸면 연결을 위조하게 된다. Code-dev는 별도 versioned context contract를 추가하고 browser validator를 함께 갱신한다. Context는 reviewed configuration/capability/readiness 정도만 알려주며 actual run/receipt를 증명하는 근거가 아니다. UI의 유일한 QUEUED 근거는 위 admission GET의 consistent `applied` tuple이다.

Launcher 변경은 다음 순서와 분리된 권한/환경을 구현하는 것으로 검토한다.

1. 기존 `--name` private state, PostgreSQL job rows, OIDC/profile/workspace 데이터는 보존한다. owner bootstrap은 schema와 등록 identity만 provisioning하며 API runtime credential을 owner/dispatcher/projector로 승격하지 않는다. deployment/build/principal role OID와 source/environment manifest hash는 private persistent DB에서 한 번 등록하고 startup마다 exact read-back 검증한다. 서로 다른 deployment/build, 역할 OID 변경, disabled registration이면 fail closed한다.
2. 기존 원본32 `.ifpmic-venv`/`requirements.lock` 경로는 launcher/API/G5 workspace reconciler에 유지한다. Dispatcher/Temporal worker는 승인된 H1 qualified SDK interpreter/lock과 exact toolchain, source/environment manifest, role-specific config만 사용한다. PATH fallback, package installation, endpoint fallback, ambient credential은 금지한다.
3. 동일한 private per-`--name` root 아래 loopback Temporal endpoint와 persistent Temporal data를 시작·확인한다. H2 normal-flow 구현처럼 private immutable deployment/build identity와 7-field runtime config를 생성하되 실제 identity는 registered deployment/build/namespace/server-config SHA/task queue/principal OID와 일치시킨다. Temporal data, PG state, workspace root/config가 존재하면 초기화/삭제/재생성하지 않고 그 identity가 맞는지 확인한다.
4. 기존 `WorkspaceService`의 run reconciler를 최소 권한 runtime 환경의 별도 소유 process로 시작한다. API acceptance가 생성한 `workspace_intents.RESERVED`를 actual G5 provisioner가 claim generation/token과 실제 root 내 marker/path 검사로 처리해야 한다. `READY`는 reconciler의 DB transition과 실제 token/generation/marker 증명만 인정한다. 직접 SQL UPDATE, launcher의 가짜 READY, 테스트 helper 호출로 대체하지 않는다. ERROR는 자동 retry하지 않고 기존 승인된 recovery 절차에 둔다.
5. workspace root/reconciler 준비가 확인되면 projector worker와 dispatcher를 각기 고정된 역할 config/DB credential로 시작한다. worker는 projector role/OID로 실행하고 dispatcher는 dispatcher role/OID로 outbox 처리한다. process journal은 private 0600, 디렉터리는 0700이며 launcher는 PID와 process start-ticks를 같이 기록해 자기 child만 정지한다. 동일 deterministic workflow ID, admitted run, outbox retry semantics를 유지한다.
6. API/issuer/PG와 함께 launcher가 위 process들의 liveness/readiness, exact binary/interpreter/config/registered identity, persistent state를 검증한다. 어느 구성 요소라도 미준비/실패면 context는 비활성/오류이고 저장 command는 accepted/pending으로 남는다. API가 직접 workflow start하지 않는다. Shutdown은 공유 deadline 아래 dispatcher admission을 멈춘 후 dispatcher/worker/reconciler/Temporal/API/issuer/PG의 승인된 순서로 중지하고 exact owned identities만 정리한다. 불확실한 process 종료, commit 또는 Temporal 응답은 success로 기록하지 않고 private recovery evidence를 남긴다.

같은 `--name` 재시작은 기존 Postgres DB, G5 workspace marker/token/generation, Temporal persistence, registered role OID/build/deployment, pending idempotency receipts를 모두 유지해야 한다. Startup recovery는 기존 accepted CreateJob을 같은 command_id와 deterministic workflow identity로 재개한다. 중복 새 job/run 생성, data reset, DB/Temporal store 초기화, workspace overwrite 금지. `AT-16`은 이에 대한 전체 crash/restart gate이며 단일 happy path만으로 완료 처리하지 않는다.

## 세부 사용자·개인정보 정책

- 로그인 세션과 `/api/v1/session` CSRF 발급 흐름은 유지한다. browser local/session storage에 세션/CSRF token을 넣지 않는다. 기존 세션별 sessionStorage pending key/body, receipt, lastJob 및 `accountEpoch/listEpoch/detailEpoch/commandEpoch` stale 응답 guard는 그대로 적용한다.
- UI는 기존 승인된 계정의 job만 표시한다. 인증된 화면의 `job_id`, `command_id`, `admitted_run_id`는 가시성 검사를 통과한 current-account 작업 detail 안에서만 표시 가능하며 그 값은 권한 token이 아니다. public Git, public screenshot, share URL, public logs에는 모든 real ID, user/project label, request content를 redacted/일회성 합성 alias로 바꾼다. 내부 private verification leaf에는 exact ID만 접근 제한으로 보존한다. ID를 public-safe 또는 모두 금지라고 일괄 가정하지 않는다.
- UI는 한 시점에 하나의 admission GET만 진행하고 account/detail/command epoch가 달라지면 응답을 폐기한다. 첫 조회 후 `pending`/`admitted_pending_projection`이면 bounded GET polling(간격 1, 2, 4, 이후 최대 5초, 최대 60초 총 기간)으로 확인한다. 터미널 `applied/rejected/quarantined`, `401/403/503`, epoch 변경에는 polling을 중지한다. 503은 기존 accepted 값을 유지하면서 “상태 조회 실패, 다시 확인”으로 나타낸다. 60초 대기 뒤 자동 재요청은 멈추고 기존 수동 새로고침만 허용한다.
- 현재 submit receipt는 `202` body에서 memory/storage에 복사된다. UI context version을 올려 `execution_connected:false` 강제 validation을 제거하되, 새로운 version 필드/다른 고정 demo context 값은 exact allowlist로 검증한다. 이 flag가 true여도 admission GET의 tuple 전에는 `QUEUED`를 표시하지 않는다.
- 같은 탭 reload 시 sessionStorage와 서버 GET으로 기존 key/receipt를 복원한다. API/launcher restart는 server DB/Temporal persistence를 통해 같은 command/job/run을 조회한다. **새 탭/브라우저 context/저장소 삭제로 key/body가 유실된 경우 자동 같은-key 재시도가 불가능하다.** 이때 새 key를 발명하거나 title/body 유사도로 command를 자동 매칭하지 않는다. 현재 세션으로 인증된 `/api/v1/jobs` 목록과 선택한 job detail/admission만 조회해 사용자가 명시적으로 기존 저장 job을 고르게 한다. 기존 job이 특정되지 않으면 “저장 여부를 안전히 확인할 수 없음” 상태를 유지하고 자동 submit하지 않는다. 저장소 접근 실패는 현재처럼 POST 이전에 중단한다.

## 검증 계약

실제 H2 full490 acceptance와 V2 independent contract review가 모두 승인된 뒤, source version/ledger를 다시 고정하고 그에 맞는 pre-gates를 통과한 환경에서만 구현 검증을 한다. V6 runner가 가리키는 모든 source/test bytes를 실행 중 수정하지 않는다. 새 migration, `jobs.py`, UI, launcher, workspace/worker/runtime 또는 H2 test change가 full runner closure를 바꾸면 승인된 후속 ledger/independent source review와 필요한 새 full H2 gate가 선행한다. 어떠한 경우도 490 source closure와 raw evidence 규칙을 무시해 이 plan 증거만으로 H2를 통과시키지 않는다.

| 범위 | 필수 정상·오류·경계·회귀 증거 |
|---|---|
| HTTP/DTO | pending200, admitted-without-receipt200, applied exact seq1, rejected seq1, quarantined, malformed UUID/없는/비가시 동일403, missing/contradictory tuple503, DB outage503, unauthenticated401. No425. Verify no raw JSON/DSN/SQL/error leaks. |
| 인증/ACL | A owner+active membership success; A membership inactive deny; active member not owner without delegation deny; exact active/unexpired job.read delegate read-only success; revoked/expired delegate deny; cross project/job and forged header/body/GUC attempts deny. Revocation commit before read snapshot is denied; read-snapshot races are documented using exact VISIBLE SQL statement semantics. |
| SQL privileges | `ifpmic_admission_reader` has only needed column SELECT on jobs/commands/outbox/binding/receipt; no login/superuser/bypass RLS; fixed safe search path; no PUBLIC/dispatcher/projector/operator execute; API runtime alone EXECUTE. Direct API runtime SELECT from execution tables remains denied. Function takes only job UUID and has one result per existing job. Unknown identity/cardinality conflict maps 503. |
| Idempotency | same actor/key/body preserves same202 command/job; same key/different body409; post-commit response loss reuses identical key/body; no status GET can enqueue/start or create receipt/run. |
| G5/runtime | fresh accepted request remains DRAFT/accepted while workspace RESERVED; only actual reconciler provisions exact root marker/token/generation and READY; workspace failure does not start engine. After registration/readiness, exact local Temporal + worker + dispatcher create exactly one matching admitted run and actual projection receipt. Check outbox/command/job/binding/receipt, existing H2 normal-flow oracle and user API DTO agree. |
| Restart/recovery | process crash at preclaim, post-claim, uncertain Temporal start and post-admission; restart same `--name`, preserve PG/Temporal/workspace/config/registration; no duplicate start or changed run; process lifecycle journal/start ticks and reverse cleanup prove no owned child remains. Include G5 reconciler restart and workspace marker invalidation/error behavior. Full AT-16 remains separate acceptance. |
| Browser | existing real I02 login/context/form/list/detail and new admission panel at desktop/mobile; same 202/idempotency behavior, 1/2/4/5s bounded polling, manual refresh, pending and terminal/error states; A/B transition while list/detail/command/admission calls are in flight proves stale responses are discarded; reload and server restart; new browser context/storage loss follows fail-closed path. Public capture redacts IDs while authenticated authorized view behaves as specified. |
| Regression | original I02 17 browser + 2 server-restart evidence remains historical, not auto-reused as V2 proof. Rerun affected I02 auth/401/403/CSRF/A-B/idempotency/storage/reload/browser tests, B02 visibility and B03 exact H2 impacted tests; full H2 reacceptance if any frozen source bytes change. REQ-05 human stages, B04/REQ-12/AT-03 SSE and later workflow stages must remain untouched and explicitly unaccepted. |

Launcher acceptance additionally requires no auto install/download; pinned original32 launcher/API/workspace and qualified SDK runtime; loopback-only API/issuer/Temporal ports; exact process role, PID/start-tick and persistent-state verification; same-name restart with retained DB/workspace/Temporal history; clean exit or explicit failure proof and no orphan child. A boolean context value or browser screenshot alone cannot satisfy launcher/runtime proof.

## 담당·통과·증거·복구

- **Code-dev**: H2 actual490 수용과 V2 independent plan/contract review 뒤에만 additive migration/API/launcher/UI 변경을 구현한다. 구현 전에 schema/function ownership/grants, context version, poll/error semantics, source pin delta를 freeze한다.
- **TC**: 별도 `tests/ifpmic_api/` API/ACL/tuple/launcher/runtime/SQL/browser 케이스와 A/B fixture를 작성한다. 제품 helper를 구현하거나 기대값·acceptance threshold를 변경하지 않는다.
- **독립 검토자**: V2 contract와 SQL function privilege/trust model, source/environment/build/process identity, full normal-path actual DB tuple, UI privacy/current-account state, test result를 author와 분리해 review한다. 기존 V1 review와 TC authored review만으로 승인을 주장하지 않는다.

**합격**은 모두 충족해야 한다. (1) workspace는 실제 G5 reconciler가 READY이고 marker/token/generation이 일치한다. (2) 동일 accepted command ID가 등록된 exact deployment/build에서 단일 run으로 admitted된다. (3) API 한 statement snapshot이 visible predicate와 function 결과를 확인해 command/job/create-command/run/sequence1 receipt/result_json의 exact applied tuple을 반환한다. (4) UI는 현재 `job_status=QUEUED`일 때만 QUEUED badge를, 그 외에는 현재 API job 상태를 보여준다. (5) same-key duplicate effect 0, A/B unauthorized read/data leak 0, stale-account update 0, credential/raw error/public real ID exposure 0. (6) same-name launcher/browser/server restart와 storage-loss 경계가 기대한 fail-closed/reconciliation 동작이다. No claim of completed workflow/AT05/16/21/29/32 from initial queue proof.

**예상 사용자 결과**: 기존 I02 요청 화면에서 “저장됨/실행 접수 대기”, “실행 접수됨·projection 대기”, “QUEUED”, rejected/quarantined/조회 실패를 근거에 맞춰 구분한다. `QUEUED`는 실제 accepted `202` receipt와 별도로 확인되는 결과다.

**증거**: private verification leaf에 request/command/job/run/receipt raw IDs, process start ticks, exact Temporal/PG rows/SQL snapshots, session/ACL cases, real workspace marker and fingerprints, config/build/role OIDs, launcher lifecycle, raw browser/API payloads를 보존한다. private evidence는 접근 제한/0600, leaf 0700. 공개 report/screenshot/URL/log는 ID와 사용자·프로젝트·요청 본문을 redacted 또는 비연결 합성 alias로 기록하고 hash/result summary만 공유한다.

**실패 복구**: 첫 실제 실패와 owned-resource 종료/uncertain evidence를 보존하며 자동 재시도나 두 번째 attempt를 만들지 않는다. 동일 key가 유지되면 그 key/job command receipt를 조회해 reconcile한다. key가 유실된 경우 list/detail을 통해 사용자가 특정한 기존 job만 조회하고 자동 body matching/new key submit은 금지한다. G5 ERROR에는 기존 승인된 retry 절차를 쓰며 READY 직접 수정은 금지한다. Temporal/DB 모순은 격리·503으로 fail closed하고 identity/receipt/ACL을 원인 수정한다. 수정이 고정 source를 바꾸면 exact source review와 해당 full H2/runtime 회귀를 새 후보에 수행한다.

## 8 validation fields

| 항목 | V2 기록 |
|---|---|
| 목적 | 기존 I02 저장 요청 하나의 actual H2 admission과 same run/seq1 receipt 기반 상태 표시 |
| 대상 | `experiments/ifpmic-live` UI/launcher, additive GET/API/migration; B02/B03, REQ-05/12/13 및 AT-03/05/16/21/29 경계 |
| 방법 | 정상 accepted→workspace READY→admitted/applied, ACL/idempotency/SQL conflict 오류, workspace/runtime/browser storage·restart 경계와 I02/B03 회귀 |
| 담당 | Code-dev 구현; 독립 TC; 계약/SQL/source/result independent reviewer; human role은 향후 원래 사람 단계에서만 수행 |
| 합격 기준 | same visible job/project/create command/run/sequence1 applied receipt tuple; current state only; duplicate/leak/stale response zero |
| 예상 결과 | 기존 I02 화면에 저장·대기·실제 QUEUED·오류를 분리해 표현; queue를 완료로 표시하지 않음 |
| 증빙 | private PG/Temporal/workspace/process/API/browser 결과; 공개 redacted 캡처/hash 및 독립 리뷰 |
| 실패 복구 | evidence 보존, 기존 key/run reconciliation, workspace 승인 복구, source delta 재검토·영향 회귀; 수동 start/DB update 금지 |
