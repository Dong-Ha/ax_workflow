# I02 admission 전달 계획 · V4

상태: **사용자 승인된 점진 구현 및 격리 통합 범위**. V4는 승인된 [V3 DTO·ACL·tuple·오류/privacy 계약](./ADMISSION-UI-PLAN-v3.md)을 참조한다. V3 본문과 검토 hash는 변경하지 않으며 V3의 검토·승인이 V4 코드나 통합 결과의 승인을 뜻하지 않는다.

## 현재 결과와 목표

V9 H2는 490건 중 8건 실행, 7통과·1실패·482미실행으로 종료했다. claim 만료의 DB-clock 관측 timeout 원인은 미확정이며 자동 재시도하지 않는다. 별도 normal-path candidate3는 아래 결과대로 격리 경로의 저장 요청 한 건을 실제 접수했지만 V9 재시도나 crash/reclaim 검증이 아니다. 진단은 30분 checkpoint의 지원 작업이며 관련 crash/reclaim 및 전체 수용만 차단한다. checkpoint 초과는 범위 재설정 보고 기준이지 검사·승인 기준 완화가 아니다.

목표는 기존 저장 요청 한 건을 격리된 로컬 PostgreSQL/Temporal에 실제 접수하고, 같은 job·command·run·sequence-1 receipt를 I02 화면에서 확인하는 것이다. `QUEUED`는 실제 엔진 receipt tuple이 확인된 경우에만 표시한다. mock 화면 상태는 mock으로 표시하며 실제 접수로 취급하지 않는다.

### Normal-path candidate3 결과

`workflow-artifacts/delivery/admission-live/normal-20261027-03/`에서 실제 SDK run 1건, workflow start 1건, phase `queued`, SQL job/command/binding/receipt 각각 1건을 관측했다. Browser의 8개 확인 항목과 두 번의 정확한 idempotency-key POST가 통과했고 실행 효과는 1회였다. 사용자 A/B 조회 거부 및 reload를 확인했다. Clean restart는 POST 0건으로 같은 job/command/run/identity/count와 실제 SDK의 같은 단일 run을 보존했다. 다섯 자식(각 2회 실행 포함)과 API/issuer/PostgreSQL은 force 없이 종료됐고 API/runtime 45개 source는 actual run 전후 같았다. 이전 failed normal-01/-02 증거도 보존했다.

Candidate3는 검토된 격리 launcher와 기존 runtime entry point를 연결했다. 기본 API/PostgreSQL-only 경로는 유지되며 actual runtime을 선택할 때만 original32 parent에 `--execution --execution-toolchain <absolute-private-H1-installation.json>`을 준다. Parent가 owner registry를 준비하고 qualified36 H1 Python/고정 CLI가 source/environment manifest와 dispatcher/worker를 검증·실행한다. 이름별 DB/Temporal SQLite/workspace/identity를 분리하며 owner DSN을 worker config에 전달하지 않는다. Browser 재현 명령은 `npm run ifpmic:admission:pg -- --origin http://127.0.0.1:<api-port> --issuer-origin http://127.0.0.1:<issuer-port> --evidence <fresh-owner-only-0700-child> --expect-queued`이고 clean restart 재조회는 `--read-existing` 모드로 POST 없이 수행한다. 설치/다운로드는 자동 수행하지 않는다.

API context v2의 `execution_connected` boolean은 runtime 연결 상태 관찰일 뿐 receipt 근거가 아니다. 실제 화면의 `QUEUED` 판정에는 동일 job/command/run/sequence-1 receipt GET 결과가 필요하다. Candidate3는 정상 접수만 독립적으로 확인했다. V9 claim-expiry/crash/reclaim, 전체 H2/full490, 원본 AT/AT32, 운영 준비, V3의 전체 복구 시나리오와 원본 인수는 미수용이다. 다음 제품 흐름은 최소 mock 서비스 실행→결과 저장→화면 조회다.

## 제품 slice와 게이트

제품 WIP는 1 slice다. V9 timeout 진단은 제품 WIP와 별도인 지원 작업으로 둘 수 있다.

| slice | 사용자 결과 | 범위와 경계 |
|---|---|---|
| `admission-mock` | I02 admission UI에서 저장된 요청 상태 조회 | 독립 전달 단위. 모듈의 로컬 시뮬레이션 상태 `pending`/`admitted`/`error`를 mock으로 표시하며 실제 접수나 `QUEUED`로 표기하지 않는다. |
| `admission-read` | 실제 read-only API와 SQL ACL tuple로 상태 조회 | V3 DTO/tuple/ACL 계약을 구현·확인한다. 실제 엔진 receipt 생성은 포함하지 않는다. |
| `admission-live` | 격리된 실제 엔진에서 receipt tuple 확인 | DB/Temporal 실제 통합 slice. 자체 준비·독립 검토 뒤 좁은 실행을 수행한다. |

각 slice에서 필요한 검사는 작업 전에 고정한다. 변경 코드, 실패 재현 또는 아직 해소되지 않은 우려가 있을 때만 추가·반복하고, 해당 검사가 통과하면 멈춘다. 각 명령의 빠른 피드백 목표는 60초 이내다. 30분 진단 checkpoint를 넘기면 현재 범위·소요시간과 다음 한 가지 조치를 보고하고 전체 suite나 full490을 자동 실행하지 않는다. 검토는 slice에서 바뀐 코드/trust boundary와 영향 경로만 확인하며 untouched source 전반을 반복 검토하지 않는다. Mock/read slice 결과는 각각 전달 완료로 기록할 수 있지만 전체 admission 또는 AT 수용 판정은 아니다.

## 수용 게이트

1. **선택 개발 검사**: slice 전에 고정한 변경된 protocol, workspace, API/ACL/idempotency 경계만 검사한다. mock fixture를 사용할 수 있고 검증 도구가 UI/프로젝트 수용 상태를 자동 승격하지 않는다. Browser 및 build는 각각 별도 명시 검사이며 숨은 기본 suite로 실행하지 않는다.
2. **격리된 실제 통합 검사**: 좁은 PostgreSQL/Temporal 경로를 full490 이전에 실행할 수 있다. 실행 전 변경 source·환경·계약·role/grant·process identity를 고정하고, private per-run DB/Temporal/workspace 및 port를 분리하며 접근·정리·증거 보존을 검토한다. SQL/role/grant/ACL 및 개인정보 경계는 실제 연결 전에 구현자와 분리해 검토한다. 한 개 admission 흐름부터 실행하고 결과·실패·owned-process cleanup을 기록한다. 미해결 timeout 후보를 자동 재실행하지 않는다. 새로운 실행은 변경된 후보와 자체 검토·준비를 가져야 한다.
3. **전체 H2/운영/원본 AT 수용**: 490 inventory 전체와 원본 raw/resource/privacy/cleanup/result 독립 검토를 요구한다. V3가 참조하는 AT와 B02/B03·전체 인수 조건도 해당 범위에서 완료한다. 이는 제한 통합 결과와 별도로 기록한다. full490은 중간 mock 또는 좁은 통합 검사의 선행조건은 아니지만 전체 수용 및 운영 활성화에는 필수다.

## 준비·검증 책임

- Code-dev는 V3 DTO와 단일 statement visibility/receipt tuple 의미를 보존하며 I02 API/UI를 작은 변경으로 연결한다. queue 요청 자체가 run을 위조하거나 중복 실행을 만들지 않게 한다.
- TC는 바뀐 경계별 선택 검사를 추가·수행하고, 좁은 DB/Temporal 실제 통합 smoke의 기대값·격리·cleanup을 제품 코드와 분리해 검토한다. 최종 threshold와 원본 계약은 바꾸지 않는다.
- 독립 검토는 실제 DB/Temporal 연결에 영향을 주는 SQL, role/grant, ACL, private config, process lifecycle과 개인정보 경계를 구현자와 분리해 검토한다. V3 리뷰 및 단위 검사 통과만으로 이 gate를 대신하지 않는다.
- 사용자 화면 인수는 같은 저장 요청의 job/command/run/receipt, 중복 방지, 사용자 A/B 권한, 계정 전환 중 stale response 차단, reload 이후 표시를 확인한다. mock 결과와 실제 결과를 분명히 나눈다.
- `admission-mock` 화면은 네이비 `#0b111b` 배경과 `#111b29` 표면, `#e7eef9` 본문, `#9aacc5` 보조 텍스트를 사용하고 파랑 `#8ab8ff` 및 민트 `#63d4b4`로 상태 조회 경로를 구분한다. 로컬 한국어 글꼴을 우선하고, mock 배지와 경로 표기를 실제 상태와 시각적으로 구분한다.
- mock 상태는 모듈 내부의 시뮬레이션에 한정하며 `pending`/`admitted`/`error`만 제공한다. 이는 queue·실행·receipt나 실제 `QUEUED`가 아니다. 계정별 시나리오 선택 선호만 `sessionStorage`에 보관하고, 새로고침 시 상태 제공자를 다시 조회한다. 원본 저장 요청, 실제 계정 상태, DB, Temporal을 수정하지 않는다.
- 기본 CLI `npm run ifpmic:delivery`는 목표/조건을 출력하고, `npm run ifpmic:delivery:check`는 DB나 Temporal을 시작하지 않는 선택 검사를 수행한다. `--level integration|acceptance`는 남은 조건을 표시한다. 이 수준의 `--run` runner는 미구현이며 종료 코드 2를 반환한다. 실제 제한 통합은 별도 검토된 좁은 runner/절차로 수행한다.
- CLI는 `--slice` 미지정 시 `delivery-plan.json`의 `plan.current_slice`를 선택한다. `--profile`은 선택 사항으로, 현재 slice가 허용한 profile의 부분집합을 지정한다. `admission-mock` 기본은 `delivery-tool`과 `admission-state` Node controller regression을 실행한다. 오프라인 API fixture를 쓰는 UI browser 검사는 `npm run ifpmic:admission:browser`로 별도 명시 실행하며 DB/Temporal을 사용하지 않는다. slice별 기본 profile은 `delivery-plan.json`의 `feedback_profiles`를 따르며 실제 DB는 자동 시작하지 않는다. `delivery:check`는 선택된 profile만 실행하며 매번 Node와 Python을 함께 실행하지 않는다. Browser와 build는 별도로 명시 선택한다. 명령 시간이 목표를 넘더라도 전체 suite를 자동 확장하지 않는다.

## 보고와 복구

매 회차는 목표 행동, 바뀐 화면/API, 실제/모의 상태, 사전 고정 검사 및 추가 검사 근거, 미검증 사항, 캡처/증거, 다음 조치 하나를 기록한다. 실패하면 증거를 보존하고 해당 실패의 작은 재현부터 수행한다. 원인과 후보 변경·환경이 확인되기 전에 full490이나 장시간 통합을 재반복하지 않는다. 실제 engine 수용이 실패한 상태에서 mock 경로를 운영 가능하다고 표시하지 않는다. Mock/read 각 slice를 사용자 결과로 전달할 수 있지만 이는 admission 전체/AT 인수 판정과 분리해 기록한다. 전체 full490은 slice 자체 준비·검토가 끝난 뒤 통합/수용 단계에서 실행하며, 과거 승인이나 증거를 새 candidate에 승계하지 않는다.

V9 이전 시도와 raw/private 증거는 역사 자료로 보존한다. V9 승인이나 V3 리뷰는 새 V4 candidate의 실행·인수 승인이 아니다. 원본 design-v1 계약, B-stage 역할, 사람 승인, AT 및 최종 배포 기준은 계속 권위 기준이다.
