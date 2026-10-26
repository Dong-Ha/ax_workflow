# AX 에이전트 관제 페이지

현재 PC의 Codex, Claude Code, OpenCode 기록에서 프로젝트 대화와 하위 에이전트의 상태, 위임 관계, 작업 요청, 완료 응답을 확인하는 로컬 대시보드입니다. 한국어 관제실 화면이며 추가 모델 호출이 없습니다.

IFPMIC workflow 시각화로 확장하는 방향은 [기준 자료와 이관 계획](./docs/ifpmic/README.md)에 정리했습니다. 현재 AX 자료를 기반으로 Paperclip을 활용하며, 제공된 IFPMIC 설계서와 JSON 계약을 최종 업무 기준으로 사용합니다. 해당 문서에는 Paperclip 조사, 시각화 우선순위와 B01–B13 구현 순서가 포함되어 있습니다.

## 사용자 흐름 단위로 개발하기

현재 개발 우선순위는 [애자일 전달 계획](./docs/ifpmic/AGILE-DELIVERY.md)과 [전달 기준 데이터](./docs/ifpmic/delivery-plan.json)를 따릅니다. 한 번에 전달 단위 하나를 진행하며, 접수 흐름을 mock 화면 → 실제 조회 API → 실제 엔진 접수로 나눕니다. UI/API 구현과 관련 검사는 전체 490건 수용을 기다리지 않고 진행하며, 실제 엔진 활성화·전체 H2·원본 AT 인수 기준은 유지합니다.

- `npm run ifpmic:delivery`: 현재 목표와 선택 검사 목록을 출력합니다. 실행하지 않습니다.
- `npm run ifpmic:delivery:check`: 현재 전달 단위의 고정 검사만 실행합니다. 기본 mock 단위는 접수 상태 controller만 검사하고, Python profile(`admission-dto`, `admission-local`)에는 `.ifpmic-venv`의 고정 의존성이 필요합니다. DB/Temporal을 시작하지 않습니다. 로그와 요약은 ignored `workflow-artifacts/delivery/`에 보존합니다.
- `npm run ifpmic:delivery -- --flow minimal-mock`: 다음 흐름의 기본 slice와 아직 추가할 기능 검사를 출력합니다. 새 흐름마다 CLI를 수정할 필요가 없습니다. 기본 `feedback_profiles`와 선택 가능한 `allowed_feedback_profiles`를 구분하며 `--profile`로 검사 하나만 선택할 수 있습니다.
- `npm run ifpmic:delivery:check -- --profile delivery-tool`: 전달 계획/도구 변경 시 도구 검사만 실행합니다. 각 profile과 전체 소요시간을 출력합니다.
- `npm run ifpmic:delivery:browser`: 빌드 산출물만 사용하는 offline Chromium 화면 검사이며 API 서버를 시작하지 않습니다.
- `npm run ifpmic:delivery -- --level integration` 또는 `--level acceptance`: 남은 조건을 출력합니다. 이 두 수준에 `--run`을 추가하면 자동 실행 미연결로 실패하며, 통과로 기록하지 않습니다.
- `npm run test:ifpmic:delivery:browser`: 빌드된 현황판의 데스크톱·모바일 표시와 API/외부 요청 없음을 offline Chromium으로 확인합니다.
- `npm run build` 후 `npm exec vite preview -- --host 127.0.0.1 --port 4173`의 `/delivery.html`: 같은 계획 데이터와 실제 보존 결과를 보여주는 현황판입니다. 실시간 서비스 상태가 아닙니다.

선택 검사 통과가 사용자 흐름 전달이나 전체 인수 상태를 자동 변경하지 않습니다. V9 실제 H2는 490건 중 7통과·1실패·482미실행으로 끝났고 claim-expiry 원인은 미확정입니다. 별도 candidate3의 normal-path 실제 접수 결과는 [주기03 기록](./docs/ifpmic/delivery/iteration-03/README.md)에 있으며 V9 재시도·crash/reclaim 수용·전체 H2/AT 인수로 승격하지 않습니다. 기존 `delivery/status.html`은 과거 기록으로 보존합니다.

## IFPMIC 흐름 보기

실제 요청 등록·저장·상세 화면은 [주기02 실행 안내](./docs/ifpmic/delivery/iteration-02/README.md)를 따른다. 로컬 주소는 **http://127.0.0.1:8769/**이며 데모 계정으로 로그인한다. 실제 API/PostgreSQL 저장을 사용하고, 합성 계정/mock 프로파일과 실행 전 상태를 화면에 표시한다. 기존 AX 기록 API는 계속 읽기 전용이다.

B02의 인증·요청 저장·작업 공간은 [독립 검토한 계획](./docs/ifpmic/B02-IDENTITY.md)에 따라 개발 중입니다. 현재 G1 기반은 Python3.12, 고정 Python 의존성, PostgreSQL18.1 migration과 분리된 DB 역할입니다. 실제 로그인·요청 API·작업 공간 reconciler는 후속 단계이며 기존 AX 서버는 계속 읽기 전용입니다.

G2는 B01 스냅샷을 고정 Node subprocess로 검증하고 원본 바이트를 PostgreSQL catalog에 그대로 보관하는 연결 계층입니다. 현재 지원 환경은 Linux CPython3.12이며, 프로세스 시작 취소 때 자식 프로세스를 종료·회수하는 CPython Unix subprocess 동작을 사용합니다. child 실행은 최대10초, 동시4개·대기16개로 제한하며, 종료·회수가 끝나야 슬롯을 반환합니다. profile version의 astral/lone surrogate는 ASCII JSON label로 손실 없이 보존합니다.

운영자가 미리 provision한 프로젝트에 스냅샷을 가져올 때에는 `IFPMIC_NODE_EXECUTABLE`(Node 실행 파일 절대 경로), `IFPMIC_PROFILE_STORE`(신뢰된 B01 저장소), `IFPMIC_OPERATOR_DSN`을 설정하고 `.ifpmic-venv/bin/python -m services.ifpmic_api.catalog`의 stdin에 `{"project_id":"프로젝트ID","profile_version":"버전"}` JSON을 전달합니다. 요청으로 executable·script·저장소 경로나 profile 본문을 선택할 수 없습니다. 결과는 imported 여부와 해시 ID뿐입니다. 같은 버전·원본 바이트는 멱등이며 충돌은 덮어쓰지 않습니다. 가져오기는 eligibility를 부여하지 않습니다. G2 기록의 `scripts/verify_ifpmic_g2.py`는 당시 고정된 G1·G2 Python 검사와 B01 Node48건의 근거입니다. 현재 후보의 검증은 아래 G5 명령을 사용합니다. 전체 서비스·SSO·UI 통합 수용은 후속 검증 대상입니다.

G3 인증은 [독립 검토한 세부 계약](./docs/ifpmic/evidence/b02/g3-implementation-contract-v4.json)과 [검증 결과](./docs/ifpmic/evidence/b02/g3-final-review.json)에 따라 로컬 범위를 수용했습니다. 별도 서비스는 `GET /auth/login`, `GET /auth/callback`, `GET /api/v1/session`, `POST /auth/logout`을 제공하며, 기존 AX 서버의 읽기 전용 API와 분리됩니다. OIDC code+PKCE와 브라우저에 결속한 일회용 state를 사용하고, opaque 세션의 해시만 DB에 저장합니다. 세션 응답의 안정적 CSRF와 허용 Origin을 로그아웃에 함께 요구합니다. 만료된 로그인 자료·세션만 1,000행씩 정리하며, 로그인 대기 기록은 최대1,024행입니다. 정리는 로그인 시점과 서비스 수명주기의 주기 작업(기본60초)에서 수행합니다. 사용자 job API와 작업 공간 처리는 후속 검증 대상입니다.

G4 작업 API는 [구현 전 이중 검토한 계약](./docs/ifpmic/evidence/b02/g4-implementation-contract-v2.json)에 따라 구현합니다. 로컬 수용 범위와 검증 근거는 [G4 검증 기록](./docs/ifpmic/evidence/b02/g4-verification.json)과 [최종 독립 검토](./docs/ifpmic/evidence/b02/g4-final-review.json)에 기록합니다. `POST /api/v1/jobs`는 세션·CSRF·Origin·Idempotency-Key와 원본 CreateJob 본문을 요구합니다. `GET /api/v1/jobs`는 기본25개(1–100)의 접근 가능한 작업을 반환하고, 상세는 원본 Snapshot 형식입니다. 초기 DRAFT는 실행 전이므로 `steps:[]`, `last_event_id:""`이며, 202/accepted는 실행 완료가 아닙니다. 사용자·프로젝트 권한과 검증된 프로파일의 eligibility를 별도로 확인합니다. 생성용 Node 실행 파일과 B01 저장소는 private 설정의 `node_executable`, `profile_store` 절대 경로 쌍으로 고정합니다. 이 설정이 없으면 새로운 수락은 실패하며, 기존 영수증 조회는 현재 프로파일 파일에 의존하지 않습니다. 작업 공간 디렉토리 생성과 Temporal 실행은 후속 단계입니다.

mock eligibility는 운영자가 별도 `IFPMIC_OPERATOR_DSN`과 같은 private `IFPMIC_API_CONFIG`로 `.ifpmic-venv/bin/python -m services.ifpmic_api.authority grant-mock-profile` 또는 `revoke-profile`을 명시적으로 실행할 때만 변경합니다. stdin 필드는 [계약](./docs/ifpmic/evidence/b02/g4-implementation-contract-v2.json)의 `operator_cli`에 정의되어 있습니다. 일반 API는 권한을 발급하지 않으며 real grant 생성 옵션은 없습니다. 기존 catalog import 명령은 그대로 사용합니다. G4 기록의 고정 후보에는 `scripts/verify_ifpmic_g4.py`와 당시 소스 해시가 포함되어 있습니다. 현재 작업 공간 후보의 G1–G5 및 B01 회귀 검증은 `.ifpmic-venv/bin/python scripts/verify_ifpmic_g5.py`로 수행합니다. G4 통합 검증과 최종 독립 검토가 끝나기 전에는 G4 완료나 원본 AT-21 수용을 주장하지 않습니다.

G5 작업 공간은 [구현 전 검토한 복구 계약](./docs/ifpmic/evidence/b02/g5-implementation-contract-v2.json)을 따릅니다. private 설정의 `workspace_root`는 서비스 계정 소유·mode0700인 기존 절대 경로입니다. 미설정 시 작업 공간 처리는 비활성화되며, API를 시작해도 worker가 자동 실행되지 않습니다. 명시적으로 `.ifpmic-venv/bin/python -m services.ifpmic_api.workspace once`의 stdin에 `{}` 또는 `{"job_id":"UUID"}`를 전달해 한 건을 처리하거나, `run`으로 반복 실행합니다. worker는 같은 private `IFPMIC_API_CONFIG`의 runtime DSN을 사용합니다. `workspace_lease_seconds`는1–300초(기본60), `workspace_poll_seconds`는1–60초(기본1)입니다.

작업 공간은 DB job UUID 아래 `source`, `tc`, `artifacts`, `build` 디렉토리와 고정 마커를 생성합니다. 마커와 디렉토리 동기화를 완료한 뒤에만 intent를 READY로 저장합니다. ERROR 재시도는 같은 모듈의 `retry-error`에 `{"job_id":"UUID"}`를 명시적으로 전달하며, 이 명령은 파일을 정리하지 않습니다. 알 수 없는 잔여 파일은 운영자 조사 대상으로 보존됩니다. READY는 작업 공간 준비 상태이고 job/command 실행 완료가 아닙니다. G5 로컬 수용 범위와 증거는 [검증 기록](./docs/ifpmic/evidence/b02/g5-verification.json)과 [최종 독립 검토](./docs/ifpmic/evidence/b02/g5-final-review.json)에 기록합니다. 전체 B02·원본 AT 수용은 후속 G6/G7과 환경 검증에 따릅니다.

서비스 설정 필드는 [Settings](./services/ifpmic_api/settings.py)에 정의되어 있습니다. 별도 owner-only 일반 JSON 파일(mode0600)에 승인된 issuer·client·각 고정 endpoint·API/UI origin·callback/완료 URL·runtime DSN·unpadded base64url csrf_key를 provision하고 `IFPMIC_API_CONFIG`에 그 경로를 지정합니다. `.ifpmic-venv/bin/python -m services.ifpmic_api.serve`는 `127.0.0.1:8768`에서 실행하며, `IFPMIC_API_PORT`로 포트만 바꿀 수 있습니다. Uvicorn access log와 forwarded-header 신뢰는 비활성화합니다. real 모드는 HTTPS 설정을 요구하며 TLS·reverse proxy·사내 SSO 등록의 운영 수용은 별도입니다. mock은 명시적 loopback 설정만 허용합니다. 로그나 명령행 인자에 비밀 설정 값을 넣지 않습니다. G1–G5의 과거 고정 후보 검증 기록은 `docs/ifpmic/evidence/b02/`에 보존합니다. 현재 H2 변경 후보는 아래의 별도 schema 검증을 사용합니다. 사내 SSO·전체 사용자 API·원본 AT-21 수용을 뜻하지 않습니다.

저장소 루트에서 `uv venv .ifpmic-venv --python /usr/bin/python3 --no-managed-python` 후 `uv pip sync --require-hashes --no-build --python .ifpmic-venv/bin/python services/ifpmic_api/requirements.lock`으로 격리 환경을 설치합니다. lock은 시험용 의존성까지 포함합니다. 기존 PostgreSQL에 적용할 때에는 서로 다른 migration owner·runtime·operator·dispatcher·projector 계정과 DB를 먼저 provision하고, 승인된 환경의 `IFPMIC_MIGRATION_DSN`, `IFPMIC_RUNTIME_ROLE`, `IFPMIC_OPERATOR_ROLE`, `IFPMIC_DISPATCHER_ROLE`, `IFPMIC_PROJECTOR_ROLE`을 전달하여 `.ifpmic-venv/bin/python -m services.ifpmic_api.migrate`를 실행합니다. DSN이나 자격 자료는 출력하지 않습니다. 현재 operator는 mock eligibility만 발급할 수 있으며 real authority는 별도 수용 대상입니다.

API와 H2 schema 테스트는 별도 임시 PostgreSQL 클러스터를 사용합니다. 테스트 바이너리는 격리 Paperclip runtime의 pinned PostgreSQL18.1 도구를 사용하고 Paperclip DB·설정을 읽거나 재사용하지 않습니다. `scripts/verify_ifpmic_b03_h2_schema.py`는 커밋 `d8249ec`의 고정 소스·TC 목록을 검증한 과거 runner입니다. 이후 추가된 migration004와 runtime 초안은 그 361건의 통과 범위에 포함되지 않으며, 변경된 작업 트리에서는 새로운 실행 목록·runner 검토가 필요합니다. 과거 private 증거는 `workflow-artifacts/verification/B03/H2/schema/gates/`에 보존합니다. SQL 검사 통과는 실제 Temporal 전달·업무 실행·H2 전체 또는 원본 AT 수용을 뜻하지 않습니다. 과거 G1/G5 runner도 당시 고정 후보의 재현 자료입니다.

H2 runtime 구현과 전체 수용 상태는 [checkpoint](./docs/ifpmic/H2-RUNTIME-CHECKPOINT.md)에 기록합니다. 격리된 normal-path 한 건은 candidate3에서 실제 접수·receipt 및 clean restart까지 확인했지만 crash/reclaim, full H2, AT 또는 운영 인수는 아닙니다. 기존 실행 실험은 기본적으로 API/PostgreSQL만 시작하고 dispatcher·worker·Temporal을 연결하지 않습니다. 실제 runtime은 별도 이름의 격리 상태를 명시해 다음처럼 선택합니다.

```sh
.ifpmic-venv/bin/python experiments/ifpmic-live/launcher.py --name admission-live-01 --execution --execution-toolchain /absolute/path/to/private-H1-installation.json
```

`--execution-toolchain`은 기존 qualified H1 설치 기록을 지정하며 설치·다운로드를 하지 않습니다. API/owner 준비는 original32 `.ifpmic-venv`에서, dispatcher/worker CLI와 환경 manifest 검증은 qualified36 H1 Python에서 실행됩니다. 새 이름마다 PostgreSQL·Temporal SQLite·workspace·deployment/build identity와 role별 private config를 분리합니다. dispatcher와 worker config는 각 전용 DB role만 사용하며 owner DSN을 worker에 넘기지 않습니다. Temporal listener는 loopback으로 제한하고 서버·API·issuer·DB·runtime 자식은 시작 identity를 확인해 소유한 프로세스만 종료합니다. 실행 context의 versioned `execution_connected` boolean은 연결 상태 관찰일 뿐 receipt 증거가 아니며, 화면의 실제 `QUEUED`는 같은 job/command/run/sequence-1 receipt 조회로 확인해야 합니다. 구체적인 범위와 미수용 항목은 [주기03 기록](./docs/ifpmic/delivery/iteration-03/README.md)을 참고하세요.

B03 H1의 Temporal 도구 검증은 위 API 회귀와 별도로 실행합니다. [승인된 계획](./docs/ifpmic/B03-WORKFLOW.md)과 [H1 실행 계약](./docs/ifpmic/evidence/b03/h1-execution-contract.json)에 따라 격리한 36개 패키지 환경의 Python으로 `scripts/verify_ifpmic_b03_h1.py --toolchain-manifest <private installation.json>`을 실행합니다. 이 명령은 고정 CLI의 loopback 개발 서버와 합성 workflow만 검증하며 실제 job·장비·배포를 실행하지 않습니다. private 설치 기록과 고정 binary가 없으면 실패하고 자동 다운로드하지 않습니다. H1 5건은 별도 필수 검증이며 위 API 명령의 제외 옵션이 H1 생략이나 H6 전체 회귀 면제를 뜻하지 않습니다. H1 환경의 [별도 hash lock](./services/ifpmic_api/requirements-temporal.lock)은 기존 32개 버전을 유지하고 Temporal 관련 4개만 더하며, 기존 API 환경과 lock은 유지합니다.

B01의 로컬 프로파일 도구는 [사전 검증 계획](./docs/ifpmic/B01-PROFILES.md)에 따라 개발 중입니다. `npm run ifpmic:profile`은 원본 비활성 mock 예제를 읽어 구조·구성 상태만 출력합니다. `npm run ifpmic:profile -- --profile <JSON파일> --require-real-config`는 real/enabled/구성 완료 여부를 검사하며 실제 참조 확인·운영 smoke·승인을 수행하지 않습니다. 공개 출력의 경로는 JSON Pointer이며 프로파일 원문은 출력하지 않습니다. 이 도구는 기존 AX 기록 API와 독립적이고 네트워크·빌드·장비·배포를 실행하지 않습니다.

스냅샷은 Linux의 신뢰된 로컬 저장소에서 명시적으로 만듭니다. 기존 parent 아래 `npm run ifpmic:profile -- --init-store --store <저장소>`로 초기화한 뒤 `npm run ifpmic:profile -- --snapshot --profile <JSON파일> --profile-version <버전> --store <저장소>`로 등록합니다. 같은 프로젝트·버전·내용은 같은 ID를 반환하고, 다른 내용은 충돌로 거절합니다. `--read --project-id <ID> --profile-version <버전> --store <저장소>`는 해시만 조회합니다. 저장소 파일에는 전체 프로파일이 있으므로 소유자가 관리하는 로컬 경로를 사용합니다. 스냅샷 생성은 승인이나 실행 권한을 부여하지 않습니다.

CLI는 성공0, 입력·구성 오류2, 저장소·파일 I/O·손상·publication 불확실성3으로 종료합니다. 불확실성 이후에는 final을 삭제하지 않고 같은 요청으로 재시도하여 검증·directory sync를 완료합니다. `npm run ifpmic:verify:profiles`는 독립 TC 테스트·전체 단위·build·plugin-build·원본 검사를 수행하고 후보 해시와 로그를 `workflow-artifacts/verification/B01/gates/`에 남깁니다. UI 검사를 생략하려면 기존 승인 후보의 화면·server 소스 목록/바이트와 빌드 결과가 모두 같아야 합니다. 실제 ingress·승인·장비·배포 및 원본 AT-04/28 수용은 후속 검증 대상입니다.

`npm run build` 후 기존 AX 서버의 **http://127.0.0.1:3000/ifpmic.html**에서 IFPMIC v1의 29개 단계, 6개 구간, 41개 정상·복귀 연결과 단계별 담당·입출력·통과 조건을 확인할 수 있습니다. 단계 검색, 담당 필터, 방향키·Home·End 이동과 상세 경로 이동을 지원합니다. 기본 설계 보기에서 ‘모의 시나리오’로 전환하면 74개 합성 시나리오의 관측을 앞뒤로 탐색할 수 있습니다. 사람 대기, 실패 복귀, cycle·attempt 이력, metadata 반려 후 복구, 모의 승인·영수증과 장비 격리를 구분합니다. 재사용 근거·정책 면제(EXEMPT)·사람 확인 무변경 종료(NO_CHANGE), 현재 계획과 과거 계획을 구분합니다. 사양 질문의 답변 버전·현재 실행의 재검토, 원격 조회의 미발견·충돌·확인 결과도 별도로 표시합니다. 실제 작업 및 수용시험 완료로 집계하지 않습니다.

Paperclip 안에서는 전용 page 플러그인으로 장착합니다. 플러그인은 `ui.page.register` 권한만 요청합니다. 실행·배포·외부 전송 권한이 없으며, 기존 실험과 분리한 로컬 데이터 디렉터리를 사용합니다.

```sh
npm run paperclip:install
npm run ifpmic:plugin:build
npm run ifpmic:lab:start
```

마지막 명령은 localhost Paperclip 서버를 시작하고 telemetry와 업데이트 확인을 비활성화합니다. 처음 실행할 때 `.paperclip-lab/ifpmic-verification-data/`에 별도 DB·설정을 만듭니다. 기존 3100 포트의 서버가 있으면 먼저 해당 서버를 정상 종료합니다. 별도 터미널에서 `npm run test:ifpmic:host`를 실행하면 이 격리 서버의 버전과 데이터 경로를 확인한 뒤 로컬 플러그인을 설치하고, 합성 검증 회사의 `/<회사 prefix>/ifpmic-ax` 경로를 검사합니다. 실제 에이전트나 업무 요청은 생성하지 않습니다.

검증은 [단계별 검증 계획](./docs/ifpmic/VERIFICATION.md)의 독립 검토 후 진행합니다. `npm run test:ifpmic:browser`는 빌드된 화면을 네트워크 없이 검사하며, 실제 Paperclip 장착 검증과 구분합니다. `npm run ifpmic:verify-sources`는 루트에 제공한 ZIP·DOCX와 보존 계약의 바이트를 비교합니다. 원본 파일이 없는 checkout에서도 `npm test`는 보존 계약 해시를 검증합니다.

원본 두 파일과 격리 Paperclip 서버가 준비되면 `npm run ifpmic:verify:v1`로 단위·빌드·원본·IFPMIC 화면·실제 Paperclip 장착·기존 AX 화면 회귀를 순서대로 검사합니다. 명령별 결과와 소스/배포 파일 해시를 `workflow-artifacts/verification/V1/gates/<시각>/`에 보존하며, 검증 중 소스가 바뀐 실행은 통과 처리하지 않습니다.

## 실행

Node.js 24 이상을 사용합니다.

```sh
npm install
npm run build
npm start
```

브라우저에서 **http://127.0.0.1:3000**을 엽니다. 개발할 때는 `npm run dev`를 사용합니다. 두 명령 모두 localhost에만 바인딩합니다.

## 설정

기본 프로젝트 경로는 이 저장소의 디렉터리입니다. 화면의 **도구 선택**에서 Codex, Claude Code, OpenCode를 전환합니다. 전환하면 세션과 활동 목록도 해당 도구의 기록으로 바뀝니다. 도구를 설치한 같은 PC에서 실행하세요. 설정을 바꾸려면 다음 환경 변수를 사용합니다.

```sh
AX_PROJECT_ROOT=/home/dongha/AX AX_CODEX_HOME=/home/dongha/.codex PORT=3000 npm start
```

- `AX_PROJECT_ROOT`: 조회할 프로젝트의 작업 디렉터리. 기본값은 이 앱의 루트입니다.
- `AX_CODEX_HOME`: Codex 데이터 디렉터리. `CODEX_HOME`을 재정의하지 않습니다.
- `AX_CLAUDE_HOME`: Claude Code 데이터 디렉터리. 기본값은 `CLAUDE_CONFIG_DIR` 또는 `~/.claude`.
- `AX_OPENCODE_HOME`: OpenCode 데이터 디렉터리. 기본값은 `$XDG_DATA_HOME/opencode` 또는 `~/.local/share/opencode`.
- `PORT`: HTTP 포트. 기본값 3000.

다른 작업 폴더를 관제할 때는 다음처럼 실행합니다. 모델 API 키나 추가 모델 호출은 필요하지 않습니다.

```sh
AX_PROJECT_ROOT=/path/to/your/project npm start
```

Claude Code는 `projects/<project>/<session>.jsonl` 대화와 `<session>/subagents/agent-*.jsonl` 하위 기록을 읽습니다. 루트 대화의 `cwd`가 프로젝트 경로와 일치해야 하며, 하위 에이전트는 부모 세션 폴더 관계로 연결합니다. `end_turn`, `stop_sequence` 또는 `turn_duration` 종료 기록이 있어야 턴 완료로 표시합니다. 종료 근거가 없는 응답만으로는 완료로 처리하지 않습니다. Claude Code의 과거 평면 `agent-*.jsonl` 및 agent teams 별도 세션 연결은 지원하지 않습니다. [Claude Code 디렉터리 문서](https://code.claude.com/docs/en/claude-directory), [하위 에이전트 기록 문서](https://code.claude.com/docs/en/hooks#subagentstop).

OpenCode는 데이터 디렉터리의 `opencode.db`에서 `session`, `message`, `part` 테이블을 읽습니다. `directory`로 루트를 제한하고 `parent_id`로 하위 세션을 연결합니다. 메시지의 `time.completed`, `finish`, `error`로 저장된 턴 상태를 표시합니다. SQLite 이전 JSON 저장 형식은 지원하지 않습니다. [OpenCode 저장소 안내](https://opencode.ai/docs/troubleshooting/#storage), [공식 메시지 형식 소스](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/message-v2.ts).

같은 프로젝트의 대화가 여러 개이면 최근 업데이트된 대화를 선택합니다. 하위 에이전트는 작업 디렉터리가 달라도 실제 위임 관계를 따라 포함합니다. 다른 프로젝트 기록은 API로도 조회할 수 없습니다.

## 상태와 기록

조회가 완료된 뒤 2초 후에 다시 기록을 확인합니다. 느린 요청을 중첩하지 않으며, 10초가 넘는 요청은 연결 오류로 표시합니다. ‘진행 중’은 마지막으로 저장된 턴 상태이며 프로세스 생존 확인이 아닙니다. 60초 동안 새 기록이 없으면 ‘새 기록 없음’을 표시하지만 실패로 바꾸지는 않습니다. ‘턴 완료’는 최근 대화 턴이 종료되었다는 뜻이며 전체 과제의 완료를 보장하지 않습니다. 닫힌 위임 관계도 완료 근거로 사용하지 않습니다.

선택한 대화에서 에이전트 이름·ID·원시 역할과 한국어 역할명을 검색하고, 전체·진행 중·턴 완료·실패·중단·상태 미확인으로 필터링할 수 있습니다. 검색과 상태는 함께 적용하며, 일치하는 하위 에이전트의 실제 조상은 맥락 카드로 남습니다. 일치 수는 맥락 카드를 제외한 값이고 전체·상태 집계는 대화 전체 기준입니다. 도구나 대화를 바꾸면 필터와 상세 선택을 초기화합니다. 필터에 숨겨진 선택의 상세는 유지하며, 삭제된 에이전트는 이용 불가로 표시합니다. ‘상태 미확인’을 대기로 추정하지 않습니다.

작업 요청과 완료 응답은 원문 텍스트를 길이 제한 안에서 표시합니다. 사용자에게 보이는 진행 메시지·계획과 활동 유형도 표시합니다. 추론, 인증 파일, 원시 명령 및 도구 출력은 화면으로 전달하지 않습니다. 표시 텍스트의 일반적인 인증 패턴은 가리지만 완전한 비밀정보 탐지 기능은 아닙니다. HTML은 실행하지 않으며 외부 폰트나 분석 서비스도 사용하지 않습니다.

데이터베이스는 읽기 전용으로 엽니다. Codex CLI 0.160.1 환경에서 확인한 `state_5.sqlite` 및 `thread_history_1.sqlite` 내부 형식에 의존합니다. 다른 버전에서 형식이 바뀌면 연결 오류를 표시할 수 있습니다. 저장소가 없거나 잠겨 있거나 형식이 맞지 않으면 연결 오류를 표시하고 마지막 정상 화면을 유지합니다. Codex 어댑터는 `server/store.mjs`, Claude Code는 `server/claude-store.mjs`, OpenCode는 `server/opencode-store.mjs`입니다. 모든 어댑터는 원본 기록을 수정하지 않습니다. 각 도구의 내부 기록 형식이 바뀌면 어댑터 수정이 필요할 수 있습니다.

## API와 검증

- `GET /api/dashboard?provider=codex|claude|opencode&sessionId=...`: AX 대화 목록, 선택된 대화, 에이전트, 위임 관계.
- `GET /api/agents/:id/activity?provider=codex|claude|opencode&sessionId=...&before=...`: 최근 활동 50개와 이전 페이지 커서.

`provider`를 생략하면 Codex를 사용합니다. `sessionId`를 생략하면 가장 최근 AX 대화를 사용합니다. 변경 요청은 지원하지 않습니다.

```sh
npm test
npm run build
npm run test:browser
```

테스트는 별도 임시 SQLite와 JSONL을 사용해 프로젝트 범위, 상태 해석, 페이지 처리, 추론 및 원시 출력 제외, 잘못된 항목과 저장소 누락을 검증합니다. 실행·중지, 토큰 비용, 외부 배포와 로그인 기능은 포함하지 않습니다.

브라우저 검증은 빌드 결과와 합성 API 응답만 사용하며 원본 기록을 읽지 않습니다. Playwright Chromium이 없다면 `npx playwright install chromium`으로 설치합니다. `npm run test:browser`는 기본 화면 검사와 여섯 탐색 시나리오를 함께 실행합니다. 기본 검사 결과와 스크린샷은 `workflow-artifacts/`, 탐색 보고서는 `.paperclip-lab/evidence/navigation-verification.json`에 생성하며 두 위치 모두 Git에서 제외합니다.

## 코딩 도구에서 이 저장소 개발하기

공통 개발 지침은 `AGENTS.md`에 있습니다. Codex와 OpenCode는 이 파일을 사용하고, Claude Code는 `CLAUDE.md`에서 가져옵니다. 프로젝트 루트에서 각 도구를 실행하고 작업을 요청하면 됩니다. 관제 서버는 별도 터미널에서 `npm run dev`로 실행합니다.

## Paperclip 워크플로 실험

정의된 단계와 에이전트를 실제로 호출하면서 진행 상황을 확인하는 별도 실험은 [experiments/paperclip/README.md](experiments/paperclip/README.md)에 있습니다. `npm run paperclip:install`, `npm run paperclip:start`로 localhost:3100의 독립된 Paperclip 인스턴스를 실행하고, `paperclip:seed`와 `paperclip:run`으로 예제 워크플로를 준비·실행합니다. AX 관제 서버는 기존 실행 방법을 사용합니다.

전달된 소프트웨어 개발 프로세스 이미지를 적용한 AX 기능 개발은 `paperclip:ax:seed`, `paperclip:ax:run`으로 실행합니다. 제품부·개발팀·테스트팀·운영팀이 에이전트 검색·상태 필터를 실제로 개발하고, 결함 수정·재검증·출시 승인을 거쳐 localhost에 배포합니다. [팀별 흐름과 단계 대응](experiments/paperclip/FLOW.md), [실행·검증·반영 방법](experiments/paperclip/README.md)을 확인하세요.

검색 결과는 **Alt + ↑ / ↓**로 이전·다음 항목으로 이동하며 현재 위치를 `k/N`으로 확인할 수 있습니다. 검색·상태·범위·필터 초기화 시 이동 위치는 재설정되고, 같은 범위의 유효한 갱신 중에는 유지됩니다. 개발·검증 근거는 [실제 실행 기록](experiments/paperclip/runs/README.md)에 있습니다.

작업 중 확인한 원본 프로세스 이미지와 실행·검증 화면은 [이미지 모음](experiments/paperclip/screenshots/README.md)에서 볼 수 있습니다.

모의 재생 화면 검증은 `npm run test:ifpmic:replay`(offline)와 `npm run test:ifpmic:replay:host`(기존 격리 host, GET-only 준비 확인)로 실행합니다. `npm run ifpmic:verify:ui`는 원본 파일과 격리 host를 전제로 단위·build·plugin·원본 검증·V1/AX 회귀 및 두 재생 browser 검증을 수행하고 소스/빌드/화면/사건 journal 해시를 `workflow-artifacts/verification/V2/ui/gates/`에 고정합니다. [UI 검증 범위](./docs/ifpmic/V2-UI.md)의 후속 프로토콜과 전체 V2/실제 AT 검증은 별도로 남아 있습니다.

재사용·정책 면제·무변경 종료의 합성 사건 형식은 [routing 프로토콜](./docs/ifpmic/V2-ROUTING.md)에 정의합니다. `node scripts/verify-ifpmic-routing.mjs`는 전용 검사를 포함한 전체 단위·build·plugin-build와 소스 해시를 기록합니다. 새 화면 시나리오와 독립 검증 기준은 [routing 화면 계획](./docs/ifpmic/V2-ROUTING-UI.md)에 정의합니다. 실제 정책·장비·배포는 후속 검증 대상입니다.

비면제 SQE의 P22 결과 수집·P23 보고·P24 판정은 [필수 SQE 증거 계획](./docs/ifpmic/V2-SQE.md)에 따라 별도 근거를 요구합니다. 과거 41개 사건은 별도 출처의 합성 SQE 증거만 삽입해 이관하며 원래 사건·checkpoint를 복원해 검증합니다. `npm run ifpmic:verify:ui`는 이관 ledger(`sqe-migration.json`)와 전체 UI 회귀를 기록합니다. 실제 장비·정책·AT는 후속 범위입니다.

[SQE 관측 화면](./docs/ifpmic/V2-SQE-UI.md)은 수동 배정·결과 수락, SQE 수집·보고와 시스템 판정을 나눠 표시합니다. 기존 41개 사건/체크포인트를 그대로 보존하고 수동 PASS/FAIL, 불완전·오류·이미지 불일치, 단계별 재시도와 격리 관측 9개를 추가한 50개 합성 시나리오를 구성합니다. 긴 과거 기록은 이력 영역 펼치기로 읽을 수 있고, 시나리오를 바꾸면 압축 보기로 돌아옵니다. artifact와 보고 링크는 안전한 식별자이며 실제 파일이나 외부 주소를 열지 않습니다. 실제 장비·사람 요청·실 AT 연동은 후속 범위입니다.

[P12 자식 TC 관측](./docs/ifpmic/V2-CHILDREN.md)은 별도 code-dev coordinator의 요청·서버 할당·TC 반환·code-dev 수집·테스트 통합을 구분합니다. 모든 비재사용 P12는 통합 근거를 요구하며, 자식 완료만으로 업무 단계나 품질 판정을 통과하지 않습니다. `mock:ifpmic:children:v1` 카탈로그는 기존50 사건을 보존하는 합성 근거 이관과 대기·질문 재개·실패 재시도·오래된 결과·권한 위반·취소·중단9개를 합친59개입니다. 질문과 취소·중단 복구는 별도 사람 근거가 필요합니다. `npm run ifpmic:verify:ui`는 `children-migration.json`도 기록합니다. 실제 에이전트/worktree 실행·OS 권한 강제·pause/resume/cancel 및 실제 AT는 후속 범위입니다.

[작업 제어 프로토콜 계획](./docs/ifpmic/V2-CONTROLS.md)에 따라 순수 replay의 명령 접수·적용·revision, pause/fence/resume 및 취소 종료·장비/원격 효과 관측을 개발 중입니다. 합성 job 사건은 step 좌표가 없는 정확한7필드 envelope를 사용하고 기존 step 사건 형식은 유지합니다. snapshot의 `revision`은 명령 외에도 수용된 업무 상태 변경마다 증가합니다. `node --test tests/ifpmic-control*.test.mjs`로 독립 TC의 중간 검사를 실행합니다. 취소는 등록된 실행 종료·미할당 요청 drain·장비 조정과 lease 해제·원격 종료 증거를 모두 요구하며, 늦은 결과와 영수증은 업무 단계 진행과 분리해 보존합니다. 식별 정보 없는 장비 격리는 idle 관측으로 해제하지 않습니다. 기존59 시나리오의 사건·체크포인트를 그대로 보존하고 제어 관측15개를 추가했습니다. retry 경계·명령 충돌·일시정지 중 결과 수집·취소 안전 경계는 독립 TC로 검사합니다. 제어 관측 화면은 명령 접수·적용, 제어·대기 복원, 실행·부작용의 세 영역으로 표시하며 업무 단계·Agent 상태와 제어 phase를 구분합니다. `npm run ifpmic:verify:ui`는 74개 카탈로그와 모바일·데스크톱 관측, Paperclip 호스트, 고정 trace 성능·결정성을 포함한 통합 검증입니다. 실제 제어 API나 작업 실행 기능은 후속 범위입니다.


### IFPMIC의 작은 전달 단위와 선택 검사

`docs/ifpmic/delivery-plan.json`의 `current_slice`가 이번 범위를 정합니다. 접수 흐름은
`admission-mock`, `admission-read`, `admission-live` 순으로 나누며, 각 완료는
전체 admission이나 H2/AT 인수와 별도로 기록합니다. V9 원인 조사는 관련 실제 실행만 차단합니다.

```sh
npm run ifpmic:delivery
npm run ifpmic:delivery:check
npm run ifpmic:delivery -- --slice admission-live --profile admission-local
npm run ifpmic:delivery:check -- --slice admission-live --profile admission-local
```

기본 검사는 현재 slice의 고정 allowlist만 실행합니다. `--slice`와 `--profile`은 feedback 수준에서만 사용합니다. `--profile`은 허용된 검사 묶음을
선택하며 여러 번 지정할 수 있습니다. 현재 mock slice에는 전달 도구와 접수 상태 controller 검사(`admission-state`)가 연결되어 있습니다.
`npm run ifpmic:admission:browser`는 실제 I02 정적 파일에 합성 API 응답을 연결해 상태 전환·작업/계정 전환·reload와 모바일 화면을 검증합니다. 실제 DB/Temporal은 사용하지 않습니다.
CLI는 아직 추가할 기능 검사도 출력합니다. 도구 검사 통과만으로 사용자 기능의 구현·검증을 뜻하지 않습니다.
API/화면 구현 시 해당 경계의 검사를 코드의 allowlist와 함께 추가합니다.
Python protocol/workspace 검사는 `admission-local`이며 실제 DB/Temporal을 시작하지 않습니다.
각 명령은 최대 60초이고 실패 시 중단하며 자동 재시도하지 않습니다. 결과에는 slice·선택 검사·소요 시간·
미연결 기능 검사를 기록합니다. 통과 후 새 변경·실패·미해결 위험 없이 검사를 반복하지 않습니다.
브라우저·build는 변경에 필요할 때 별도로 선택합니다. 실제 통합/전체 인수의 `--run`은 여전히
미구현으로 종료 코드 2를 반환하며, 실제 실행은 V4의 준비·독립 검토 절차를 따릅니다.


### I02 모의 접수 상태

기존 I02 요청 화면(`http://127.0.0.1:8769/`, [시작 안내](docs/ifpmic/delivery/iteration-02/README.md))에서
저장된 작업을 선택하면 **모의 접수 상태**를 확인할 수 있습니다. 상황 선택으로 접수 대기·접수됨·조회 실패를
전환하고 다시 확인할 수 있습니다. 작업을 바꾸거나 로그아웃하면 이전 모의 상태를 지우며,
같은 탭을 새로고침하면 해당 계정의 선택 작업과 모의 상황을 복원하고 응답을 다시 읽습니다.
브라우저에는 모의 상황 선택만 보관하며 실제 접수 결과나 실행 영수증을 저장하지 않습니다.
실제 저장 상태(`DRAFT`)는 바뀌지 않으며 PostgreSQL/Temporal 실행 접수는 후속 구현입니다.
이 화면의 모의 상태는 프런트엔드 로컬 제공자가 반환하며 새로운 실제 API를 호출하지 않습니다.


설정은 `IFPMIC_EXECUTION_CONFIG`가 가리키는 소유자 전용 mode0600 파일이며, 부모 디렉토리는 mode0700입니다. 형식 `ifpmic.h2.runtime.v1`은 `mode`(`dispatcher` 또는 `worker`), `identity`, 해당 역할의 명시적 Unix-socket `dsn`, `workspace_root`, `source_manifest_path`, `environment_manifest_path`를 요구합니다. 각 manifest도 같은 private 파일 규칙을 적용합니다. DSN은 `host`, `port`, `dbname`, `user`, `password`를 모두 명시하고 ambient `PG*` 설정은 허용하지 않습니다. Temporal endpoint는 `127.0.0.1:포트`로 제한합니다. 검증할 실행은 고정된 H1 환경의 Python에 `-B`와 비어 있는 private `-X pycache_prefix=절대경로`를 적용합니다. owner가 등록한 deployment/build 및 실제 소스·환경 manifest를 확인한 뒤에만 Temporal에 연결하며, 서비스가 스스로 역할이나 build를 등록하지 않습니다. 승인된 원본 업무 단계와 Agent·사람의 책임은 그대로 유지합니다.

### I02 저장된 접수 상태 조회

작업 상세의 **실행 접수** 영역은 `GET /api/v1/jobs/{job_id}/admission`으로 실제 PostgreSQL의 상태를 읽습니다.
모의 체험 영역과 별도로 표시하며, 대기·상태 반영 대기에서는 1/2/4/5초 간격으로 최대 60초 확인합니다.
거절·보류·영수증 확인·401/403/503에는 자동 확인을 멈추고, 조회 실패 시 같은 작업의 마지막 확인 상태를 보존합니다.
계정/작업 변경은 진행 중 조회를 취소하고 이전 응답을 폐기합니다. 실제 `QUEUED`는 일치하는 최초 접수 영수증을 확인한 경우에만 표시합니다.

Additive [조회 계약](docs/ifpmic/api-extensions/admission-status.v1.json)과 `005_admission_read.sql`은 기존 migration owner/four-role 절차를 따릅니다.
API runtime에는 읽기 함수 EXECUTE만 추가하며 실행 테이블 직접 SELECT나 다른 역할 권한을 추가하지 않습니다.
기존 I02 launcher는 재시작 시 새 migration을 적용합니다. 기본 모드는 Temporal을 연결하지 않으며, 위의 명시적 `--execution` 모드만 실제 로컬 접수를 연결합니다.
기본 `admission-read` 검사는 `admission-dto`, `admission-read-state`의 순수 검사만 실행합니다. 전달 도구 자체의 검사는 도구/계획을 변경할 때 명시 선택합니다.
실제 DB 통합은 별도 검토된 격리 fixture로 실행하며 기본 개발 명령에서 자동 시작하지 않습니다.

```sh
npm run ifpmic:delivery
npm run ifpmic:delivery:check -- --slice admission-read --profile admission-dto
npm run ifpmic:admission:browser
```

`npm run ifpmic:admission:pg -- --origin http://127.0.0.1:<API포트> --issuer-origin http://127.0.0.1:<OIDC포트> --evidence <새로운-private-하위경로>`는
별도 준비·검토된 격리 I02 launcher를 대상으로 합성 요청 한 건을 저장하고 실제 API/DB의 대기 상태·재조회·reload를 확인합니다.
`--read-existing`은 로그인한 계정의 기존 목록에서 작업을 선택해 POST 없이 조회만 확인합니다.
두 origin은 명시적 loopback HTTP여야 하며 evidence는 `workflow-artifacts/` 아래 owner-only 디렉터리의 새로운 하위 경로여야 합니다.
이 smoke가 PostgreSQL·OIDC·API를 시작하지는 않습니다. 실행 엔진·장비·배포 또는 전체 H2 수용 검사도 아닙니다.
