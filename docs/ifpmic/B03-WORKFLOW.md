# B03 지속 워크플로우 실행과 검증 계획

상태: 구현 전 검토 후보. 이 문서의 동일 SHA에 대한 독립 계획 검토와 TC 검토가 승인되기 전에는 제품·테스트 코드 작성, 의존성 설치, DB migration, Temporal 서버 실행을 시작하지 않는다. `evidence/b03/source-collection.json`, `tc-risk-matrix.json`, `dependency-candidate-metadata.json`, `protocol-advice.json`을 판단 근거로 사용한다. 공개 기술 문서는 참고이며 설치·호환성·실행 통과 증거를 대신하지 않는다.

## 목표와 범위

원본 backlog B03의 산출물인 Temporal workflow, outbox, 사람 대기, version pin을 구현한다. AT-05는 P07/P21에서 에이전트 완료만으로 진행하지 못하고 사람 작업함이 생성되는 것, AT-16은 명령 수락 후 전달 전 장애와 재시작에서 command_id로 재전달·중복 제거되는 것, AT-29는 v1 사람이 대기하는 동안 v2를 배포해도 v1 정의와 호환 worker로 재개되는 것이다. B03 backlog의 직접 수용 항목은 AT-05/16/29이고 REQ-05를 직접 검증한다. REQ-14의 실패 복귀·재평가 의미와 REQ-02/13 및 기존 B01/B02의 프로파일·권한·불변 증거 경계를 보존한다. H3는 P16 FAIL → 새 cycle P07 사람 재검토 → P08–P16 필수 재평가를 명시적으로 검사하며 이전 cycle의 PASS/skip으로 이를 건너뛰지 못하게 한다. 이 로컬 전이 증거는 B05의 실제 통합 AT-09 수용 완료를 뜻하지 않는다.

Paperclip은 상위 관리·감독 UI다. IFPMIC FastAPI는 인증·명령 수락·조회, PostgreSQL은 durable command/outbox와 투영, Temporal은 업무 전이의 단일 결정자다. 기존 AX `server/`는 localhost GET-only를 유지한다. G5 workspace READY는 실행 완료나 명령 applied가 아니다. 원본 설계 계약 17개와 두 업로드를 수정하지 않는다.

B03은 실제 로컬 Temporal과 실제 PostgreSQL을 사용하는 모의 실행 기반을 구현한다. 업무 전이 코어는 원본 29개 노드·실패 복귀·사람 단계·재시도·cycle·불확실한 부작용 상태를 보존한다. Agent/build/SAM/TEM/SQE/device/publisher 실제 adapter는 B05 이후의 별도 연결이다. 연결이 없는 실행을 PASS로 만들지 않으며 대기 또는 명시적인 dependency failure로 남긴다. TC의 synthetic adapter는 mock profile에서만 독립 fixture로 증거를 만든다. mock proof와 실제 품질·장비·배포 승인을 섞지 않는다. 실제 환경 및 원본 AT의 최종 수용은 각 계약 전체를 실행한 별도 증빙 없이는 완료로 바꾸지 않는다.

사람 대기를 API로 검증하려면 원본에 이미 정의된 `POST /api/v1/jobs/{job_id}/human-submissions`, `POST .../plan-decision`, `GET /api/v1/notifications`, `POST /api/v1/notifications/{notification_id}/read`의 최소 서버 구현을 B03에 포함한다. B04의 웹 작업함·SSE·artifact 전송을 앞당겨 완료 처리하지 않는다. 원본 DTO에 임의 필드를 추가하지 않으며 job projection은 기존 Job schema를 따른다. 장비·release approval·controls·runtime-event 외부 ingress는 후속 단계이며 이 계획의 사람 제출로 대체하지 않는다.

## 책임과 변경 소유권

Code-dev/main은 실행 흐름·새 migration·dispatcher·Temporal workflow/activities·사람 명령/조회 API·실행/검증 scripts·도구 lock·README 통합을 소유한다. TC는 `tests/ifpmic_api/`의 independent literal fixtures, local Temporal/PG harness, crash/restart·human·version·replay tests와 case ledger를 소유한다. 별도 reviewer가 동일 SHA 계획과 고정 후보 증거를 검토한다. 아키텍처 자문은 좁은 프로토콜 판단의 근거이며 최종 수용 검토를 대신하지 않는다.

Code-dev가 TC 호출과 패치 통합을 관리하며 TC는 production patch나 acceptance threshold를 바꾸지 않는다. SAM/TEM은 측정과 판정을, SQE는 별도 검증·보고·품질 판정을 보존한다. 에이전트 `completed`, step `SUCCEEDED`, gate `PASS`는 다르다. 사람 담당 노드와 X03 digest 승인은 에이전트 권한으로 소비하지 않는다.

## 도구와 실행 환경 후보

CPython3.12와 기존 PostgreSQL18.1 private Unix socket fixture를 유지한다. 후보는 Temporal Python SDK1.34.0과 Temporal CLI1.9.1 Linux amd64다. 패키지·binary의 공식 배포 metadata/hash는 별도 수집 문서로 고정한다. SDK 기본 의존성만 우선 검토하며 필요가 입증되지 않은 grpc extra·telemetry exporter·pytest plugin은 추가하지 않는다. 현재 Python32개 lock을 제약으로 사용하는 사전 resolver 결과와 모든 wheel SHA를 검토하고, 호환성 때문에 기존 package 변경이 필요하면 조용히 업그레이드하지 않고 계획을 재검토한다. Node lock은 유지한다.

H1에서 승인된 wheel/CLI archive를 격리 경로로 내려받고 해시 검증 후 설치·압축 해제·실행한다. SDK의 implicit server download를 금지하고 기존 binary 경로를 명시한다. 원격 Temporal·기존 Paperclip DB·회사 IdP에 연결하지 않는다. Temporal test server는 loopback의 별도 port와 private persistent DB를 사용한다. CLI의 SQLite는 Temporal 개발 서버 자체의 저장소이며 IFPMIC 업무 DB PostgreSQL을 대체하지 않는다. 기본 in-memory 서버만으로 재시작 내구성을 입증하지 않는다. production Temporal topology/availability는 별도 환경 수용이다. SDK API와 CLI 옵션은 설치한 정확 버전의 실제 검증 결과로 확정한다.

## 명령 전달과 전이 권한

CreateJob의 기존 accepted receipt는 영구적으로 같은 값으로 재생한다. commands의 payload/actor/route/idempotency identity는 불변이며, GET command에서만 이후 applied/rejected가 보인다. 새 사람 명령도 원본 DTO를 엄격 검증하고 같은 actor/route/key의 durable command + outbox를 한 PG transaction으로 수락한다. 기존 `commands.job_id UNIQUE`와 create-only route constraint는 새 migration에서 명시적으로 확장하되 create command의 job별 유일성은 partial unique index로 보존한다. 기존 migration001/002 bytes와 과거 snapshot은 수정하지 않는다. `jobs.create_command_id`를 기존 유일한 create 명령으로 backfill하고 NOT NULL 및 create route까지 포함한 deferred composite FK(command_id,job_id,route)를 건다. jobs 쪽 create route는 `POST /api/v1/jobs` 고정 CHECK/default로 두고 commands 쪽 대응 composite unique key로 존재뿐 아니라 create-route 의미를 강제한다. runtime/projector/dispatcher는 이 참조/route를 UPDATE할 수 없고 잘못된 human-command relink를 검사한다. 새 job은 생성 시 미리 정한 create command UUID를 함께 넣는다. JobService의 list/snapshot/profile_version 조회는 이 create-command 참조에만 join하며 사람 명령 payload가 job profile로 해석되거나 목록을 중복시키지 않는다. 기존 snapshot의 DRAFT/revision0 전용 거절은 원본 Job schema와 legal state/revision 검증으로 교체한다. 과거 create/list/detail 회귀와 실행 후 조회를 모두 검사한다.

API runtime은 명령 수락만 가능하다. dispatcher는 outbox claim/ack와 delivery mapping에만, projection activity는 등록된 workflow/transition의 projection에만 쓰기 권한을 갖는다. 별도 migration-owner가 역할을 provision한다. runtime/operator/dispatcher/projector가 권한·snapshot·build 등록을 임의 변경하거나 schema owner가 되지 못하도록 SQL grants와 실패 검사로 입증한다. 연결 문자열·worker 자격증명은 요청/Temporal history/로그/public evidence에 넣지 않는다. 구체적 SQL 역할 확장과 backfill/rollback 계약은 H2 전에 별도 exact-SHA 검토한다.

outbox 전달은 PG의 짧은 `FOR UPDATE SKIP LOCKED` transaction에서 claim generation/token/expiry와 시도 기록을 얻고 commit한 뒤 network I/O를 수행한다. 기본 claim lease30초, RPC deadline10초, dispatcher concurrency4, retry backoff1/5/30초를 후보 운영값으로 고정한다. stale token의 ack/reject는 영향을 주지 않는다. timeout은 원격 실패 판정이 아니다. 오래된 worker도 같은 deterministic ID와 immutable command를 사용하며 새 semantic 실행을 만들 수 없어야 한다.

Temporal workflow ID는 `ifpmic.job.<canonical job UUID>`로 job당 하나다. workflow type/build/task queue, snapshot ID/hash, workflow/state/agent bundle hash와 start command ID/hash를 PG의 immutable execution binding에 기록한다. start 중복은 기존 실행의 binding과 대조하고, Temporal의 실행 중 중복 및 종료 후 ID 재사용을 모두 금지한다. ID 충돌에서 다른 입력을 채택하거나 새 UUID로 우회하지 않는다. start response 유실 시 exact ID의 실행/history를 조회한다. PG binding은 영구적으로 재사용하지 않으며 최초 admitted Temporal run_id를 CAS로 고정하고 모든 projection/activity effect에 같은 run_id fence를 검사한다. Temporal reject-duplicate만으로 retention 이후까지 영구적인 물리 run 유일성을 보장한다고 주장하지 않는다. 알려진 run의 history가 없어지면 격리하고 다시 만들지 않는다. 최초 start의 응답만 불확실한 경우에도 실제 namespace retention을 확인한 유한 reconciliation window 안에서만 NotFound 후 같은 ID/no-reuse 정책으로 재시도한다. window는1시간 이하이며 확인한 retention보다 짧아야 한다. retention/config를 확인하지 못하거나 window가 지나면 RECONCILING으로 격리하고 사람 운영 판단 없이 새 start를 하지 않는다. H1/H2에서 이 전제와 run fence의 반례를 검사한다. at-most-one effective business execution을 보장하며 physical run이 이례적으로 생겨도 다른 run_id는 어떤 projection/부작용도 만들지 못해야 한다. closed execution을 새 run으로 재시작하지 않는다. reset/termination/manual migration은 별도 운영 승인 대상이다. 이 버전은 continue-as-new와 workflow retry로 run을 교체하지 않는다. 향후 필요하면 영구 binding/run fence의 계승 계약과 새 crash/replay 검증을 먼저 승인받는다.

outbox dispatched는 Temporal이 start/signal을 수락한 것일 뿐 command applied가 아니다. 업무 상태·command 적용은 Temporal이 결정하며 idempotent projection activity가 durable outcome과 job revision을 기록한 뒤 관측된다. projection마다 `(job_id, transition_sequence)` unique identity, 이전 revision, payload digest를 저장한다. 같은 identity/same digest는 재생, 다른 digest는 오류로 격리한다. command의 terminal outcome과 applied_revision은 projection transaction에 함께 기록하고 바꾸지 않는다. workflow main loop가 업무 전이를 직렬로 제안하며 signal handler는 command ID를 큐에 넣을 뿐 독립 전이를 적용하지 않는다. projection transaction의 lock 순서는 project authority guard → job → 해당 task다. idempotent receipt lookup을 현재 권한 재검사보다 먼저 수행한다. 이미 commit된 receipt는 membership/eligibility가 이후 폐기되어도 같은 결과로 반환하며 과거 applied를 rejected로 뒤집지 않는다. 최초 적용에만 current authority/task/revision을 검증하고 projection+task consumption+command terminal receipt를 한 transaction으로 commit한다. PG commit 후 activity 응답 유실은 같은 transition 재시도로 복구한다. Temporal history에 projection 결과가 기록되기 전 후속 business action을 진행하지 않는다. PG 장애에서 projection만 먼저/나중 임의 적용하는 대체 실행기를 만들지 않는다.

activation에서 workspace READY의 intent identity, pinned catalog bytes, 현재 eligibility/membership을 다시 검사한다. API 수락 당시 자격이 미래 실행을 자동 승인하지 않는다. 준비되지 않은 workspace는 accepted로 대기하며 workspace ERROR나 복구 중이라는 사실만으로 job을 실행하지 않는다. 최초 활성화 승인과 authority 변경은 project guard에서 직렬화하며 revocation이 먼저 commit되면 거절한다. 승인된 activation receipt가 먼저 commit되면 이후 revoke는 과거 승인을 소급 변경하지 않지만 다음 새 privileged action은 재검사한다. Create command의 최초 적용은 DRAFT/revision0 → QUEUED/revision1과 applied/applied_revision1을 원자적으로 기록한다. P01 시작은 이후 별도 전이/revision이다. 처음부터 자격 부적합이면 command rejected/applied_revision null, job DRAFT/revision0을 보존하고 오류 receipt를 기록하여 실행하지 않는다. 새 자격 부여로 같은 rejected command를 다시 살리지 않는다. 준비되지 않은 workspace는 terminal outcome을 만들지 않고 accepted로 유지한다. 정확한 고정 error-code table·SQL predicate/receipt schema와 fixture는 H2 contract에 고정한다. 결정되지 않은 oracle을 제품이나 TC가 임의로 선택하지 않는다.

## 사람 대기와 증거

workflow의 사람 노드는 durable WAITING_HUMAN을 결정하고 projection으로 task와 notification을 같은 transaction에서 생성한다. task는 job/step_run/cycle/attempt/plan version/definition hash/assignee에 묶이며 actor는 해당 job의 owner를 기본으로 한다. job.read delegation은 사람 승인 권한이 아니다. task 생성·알림 중복 방지는 transition identity와 `(task,recipient,kind,reminder_window)` unique key로 수행한다. GET notifications는 현재 session·활성 membership·소유/할당을 매번 확인하고 auth-bound cursor pagination을 사용한다. read 표시는 workflow 완료가 아니다.

HumanSubmission 원본 필드는 `expected_revision,task_id,outcome,artifact_ids,comment`이며 outcome은 `complete/reject/needs_design/manual_result`다. CSRF+Origin과 actor/task/project/evidence 접근 권한을 수락 시 확인한다. 제출 증거는 서버가 검증한 available artifact의 불변 참조만 허용한다. 업로드는 B04이므로 TC는 migration owner가 만든 명확한 synthetic available artifact fixture를 사용하며 실제 upload 성공으로 세지 않는다. raw comment/artifact contents를 Temporal history나 notification에 복사하지 않는다. 워크플로우에는 command ID/hash와 검증된 최소 참조를 전달한다.

사람 명령의 expected_revision과 task-currentness는 수락 및 실제 적용 시 확인한다. stale revision/이미 소비된 task의 새로운 충돌 제출은409, 이미 수락한 동일 key/body는 최초 receipt를 돌려준다. 두 valid submission이 경합해도 하나만 effective completion이며 후속 command는 rejected outcome을 보인다. 최초 적용은 project guard → job → task lock 하에서 current membership/assignment와 exact predecessor revision을 검사한다. effective completion은 task 소비와 projection/revision+1 및 applied receipt를 원자적으로 기록한다. 적용 시 뒤늦게 stale/권한 소멸이면 rejected/applied_revision null이며 job/task를 소비하지 않는다. 이미 commit된 같은 command receipt는 그 뒤 권한 변동과 무관하게 재생하되 외부 조회는 항상 현재 권한을 검사한다. 에이전트 완료나 session/userId 위조로 task를 소비하지 못한다.

P07 complete는 P08, P21 complete는 P22, P21 reject는 P11, P21 needs_design은 P07이다. 원본 P07에는 business-fail target과 reject special outcome이 없으므로 P07 document-review task는 complete만 지원한다. 그 task의 reject/needs_design/manual_result는422로 거절하고 task/step/command를 수락·소비하지 않는다. P21 review task는 complete/reject/needs_design만 지원하며 manual_result는422다. 이는 B03의 fail-closed task-kind 정책이고 원본이 추가 경로를 명시했다고 주장하지 않는다. 일반 사람 제출을 X03 release digest 승인 대신 쓰지 않는다. P06/P08/P10의 문서 증거, X01 plan-decision, P03 질문/답변, 수동 SQE 결과는 task kind와 해당 단계 계약에 맞아야 한다. 지원하지 않는 outcome/task-kind 조합은422다. 정확한 task-kind별 route/evidence table과 business-fail cycle/attempt 규칙을 H3/H4 구현 전에 별도 reviewed contract로 고정한다.

## workflow와 버전 고정

Workflow 안에서는 외부 I/O, DB, wall clock, 임의 파일 조회나 non-deterministic random을 사용하지 않는다. immutable input과 Temporal의 replay-safe 시간·타이머·signal을 사용하고 외부 작업은 activity로 분리한다. 29개 node의 기본 pass/fail과 special_outcomes, skip policy, retry defaults를 원본과 대조한 독립 literal transition matrix로 검증한다. 원본 JSON을 실행 가능한 엔진이라고 가정하거나 mock UI의 상태를 권위로 사용하지 않는다.

실패한 attempt는 FAILED로 보존하고 retry는 새 attempt다. business rework는 새 cycle이며 이전 결과·skip·후보 증거가 현 cycle을 통과시키지 못한다. REUSE/POLICY/COUPLED는 reason/baseline hash/actor/plan_version과 필요한 사람 확인을 보존하고 SKIPPED/EXEMPT를 PASS로 바꾸지 않는다. three-attempt infrastructure retry와 backoff10/30초, business cycle 한도3을 원본대로 처리하며 한도 이후 자동 무한 재시작하지 않는다. flash/remote_push/create_pr/create_tag/release_publish의 불확실한 결과는 RECONCILING이며 blind retry하지 않는다. B03 adapter 미연결을 자동 성공으로 메우지 않는다.

B01 `workflow_id=ifpmic-sw-v1`과 schema_version1.0.0을 그대로 유지한다. document schema_version을 executable code version으로 오인하지 않는다. execution binding은 definition bundle hash와 engine build ID/hash, build별 task queue를 별도로 pin한다. worker는 등록된 동일 build의 immutable source/env에서만 해당 queue를 poll한다. v2 배포가 old queue를 poll하거나 old binding을 수정하지 않는다. old build가 없으면 기다리며 v2로 fallback하지 않는다. 기본 정책은 호환 v1 worker 유지이며 implicit migration/auto-upgrade는 없다.

H5는 실제 v1 history가 P07/P21에 대기할 때 별도 v2 test build/queue를 띄운다. v2의 의도적으로 다른 fixture 동작을 control로 확인하고 old worker 중단 시 진행하지 못함, 동일 pinned v1 worker 재시작 시 v1 next route로 재개함, old history replay 성공을 입증한다. test v2 fixture는 원본 v1 JSON·B01 registry·job.workflow_version을 덮어쓰지 않는다. 실제 신규 v2 업무 정의/등록 변경과 migration은 별도 B01/버전 계약 재검토가 필요하며 이 시험으로 지원 완료를 과장하지 않는다.

## 단계별 필수 검증

각 H 단계는 독립 TC ledger의 정상·예외·경계·회귀 식별자와 연결한다. 제품·TC·도구 변경은 영향도를 기록하고 고정 후보를 다시 만든다. 개발 후 선택적인 검사가 아니라 다음 단계 진행의 조건이다.

| 단계 | 목적·대상 | 방법·담당 | 합격 기준·예상 결과 | 증빙 | 실패 시 복구·재검증 |
|---|---|---|---|---|---|
| H0 | 원본·프로토콜·시험 계획 | Luna 수집, main 통합, 좁은 senior 자문, 독립 plan/TC reviewer exact SHA | 원본 B03/AT05/16/29와 경계 일치, open oracle의 담당/후속 gate 명시, 동일 SHA 승인2건; 실행 미착수 | source/metadata/advice/risk matrix/plan reviews | 반려본 보존·정책 보완 후 같은 SHA 재검토 |
| H1 | SDK/CLI/lock·실제 local Temporal | main isolated download/hash lock; TC version/import/connect/history/persistent restart/cleanup | 기존32 Python 제약 유지 또는 재승인, binary/hash 일치, implicit download0, PG 업무 DB 유지, 실제 server history가 restart 뒤 보존 | wheel/CLI/lock/env/tool manifest, private lifecycle/history, 정확 명령 | hash/API 충돌은 실행 금지, 후보/계획 재검토; H1 전체 재검증 |
| H2 | DB 역할·outbox·activation/projection protocol | main 별도 exact-SHA contract + TC review 후 구현; TC PG/Temporal 실제 process kill/race | accepted≠dispatched≠applied, 모든 cut point에서 command 유실0·effective start1, stale ack 영향0, no ID reuse, role 우회0 | 새 migration/grants, DB before/after, start/history binding, crash ledger | 실패 DB/history/log/source 보존; 해당 transaction/dispatch/ack 단계 복귀, H2 전체와 G4/G5 영향 검사 |
| H3 | 결정적 workflow·29노드 전이 | TC literal matrix+실제 Temporal, mock adapters/typed evidence, timer/retry/cycle/stale result/projection failure | 원본 pass/fail/special/skip/human 경계 일치, completed≠PASS, old cycle unlock0, 단일 writer; 미연결은 PASS 아님 | case ledger/history/replay, versioned step/projection/evidence rows | 원본 routing/evidence 처리로 복귀, H3 전체와 H2 idempotency 재검증 |
| H4 | 사람 P07/P21·API·작업 알림 | TC auth/PG/Temporal 실제 사용자2명, 원본 schema와 task table, restart/duplicate/revocation/stale revision/artifact 검증 | 사람 제출 없이는 진행0, durable task/notification1, owner/assignee 외 접근0, valid proof1회 적용·원본 next route, DTO exact | authenticated DTO/JUnit, task+command+projection rows, wait/restart history | task/authority/revision 경계 복귀, H4 전체 및 auth/G4/H2 회귀 |
| H5 | v1/v2·old wait·replay | TC 실제 별도 build/queue와 retained history; old worker stop/restart, v2 negative control | v2로 old wait 진행0, same v1 source/env로 재개·v1 route 유지, history replay 성공; unknown build fail closed | 두 build/definition/env hashes, queue/history IDs, replay 결과, process lifecycle | old worker/history 보존, version 선택·compatibility 정책 복귀, H5+H3 재검증 |
| H6 | 고정 통합 후보 회귀 | main before→Python+B01 target→전체 Node387 이상→build/plugin→원본 hashes→after; TC/reviewer route/AT matrix | fail/error/skip0, exact inventory, source/lock 중간변경0, 원본17+2 불변, owned cleanup; UI 조건 또는 확대 검사 충족 | fresh JUnit/logs/gate ZIP/source+output fingerprints/privacy ledger | 변경/timeout은 실패 후보 보존·원인 분석·관련 H 및 H6 전체 재검증 |
| H7 | 독립 최종 audit·기록 | 독립 reviewer raw/private+public/current/source/requirements 대조, main commit/push | 실제 증거로만 부분/전체 범위 판정, 원본 AT 완료 과장0, public raw input/log/credential0 | final verification/review/progress reconciliation/commit/push | 반려 단계로 복귀, 실패 보존·새 고정 후보·독립 재검토 |

H2/H3/H4의 상세 implementation contract와 TC ledger는 그 gate를 구현하기 전에 같은 SHA로 재검토한다. H0 승인만으로 미정 oracle을 마음대로 코드화하지 않는다. H6의 명령·timeout·정확한 Node/Python inventory·UI source/dependency/output baseline·publication transformation은 candidate runner 구현 전에 고정하고 독립 검토한다. 단일 시험 기본 제한30초, PG fixture/Python phase300초, Node180초, build/plugin120초를 시작 기준으로 하며 시간 가속/서비스 준비·history polling 예외가 필요하면 실행 전에 구체적 상한과 근거를 contract에서 검토한다. 관측 timeout은 프로세스 종료로 추정하지 않고 같은 live handle을 확인한다.

## 영향도와 생략·미수용

H1–H5는 실제 PG/Temporal/API를 fake로 대체하여 생략하지 않는다. test time skipping은 타이머 시험에만 쓰며 crash persistence와 서버/worker restart 증거를 대신하지 않는다. H6에서는 G6의 Python351와 Node387을 하한으로 하고 새 테스트의 정확 ID를 더한다. 기존48 B01 Node는 전체387의 부분집합이므로 합산해서 고유 개수를 부풀리지 않는다.

B03은 API/상태 저장과 worker authority를 바꾸므로 auth/session/CSRF/profile/bridge/job/command/workspace 회귀를 모두 수행한다. UI source·server/plugin/config/dependency 또는 실제 연결이 달라지면 영향에 맞는 브라우저/native-host 검사를 추가한다. 기존11 UI 명령의 조건부 생략은 accepted controls 대비 UI/server/plugin/config 실제 inventory와 resolved dependency, 실제 재빌드10 outputs의 byte identity, 새 API가 UI에 연결되지 않았음이 모두 증명될 때만 허용한다. UI 의미 변화 시 전체11을 수행한다. 생략 기술 근거와 실제 IFPMIC UI 미수용 위험을 evidence에 남긴다. 순수 문서 상태 변경만 있으면 해당 SHA/참조/JSON/source reconciliation을 검사하며 의미 없는 서비스 재실행은 하지 않는다.

회사 OIDC/TLS/proxy/provisioning, production Temporal·DB 운영, 실제 Agent/build/SAM/TEM/SQE/device 연결, 웹/SSE/artifact upload, 승인된 publisher/외부 제출과 원본32 AT 전체는 후속 수용이다. 이 계획은 실제 장비 조작·최종 배포·외부 제출을 승인하지 않는다. 내부 코드·로그·기밀은 허가되지 않은 외부 서비스로 전송하지 않는다. 공개 증빙은 정제 synthetic 요약과 해시/개수로 제한하고 raw histories/service logs/source ZIP/credentials는 mode0700/0600의 로컬 private evidence로 보존한다.
