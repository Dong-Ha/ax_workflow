# B01 계약·프로파일 registry 및 불변 스냅샷 계획

상태: 구현 전 후보. `evidence/b01/plan-review.json`과 `tc-plan-review.json`의 이 문서 SHA 승인을 확인한 뒤 제품 코드를 작성한다. 근거는 `source-collection.json`과 `snapshot-architecture-advice.json`이다. 원본 ZIP/DOCX·가져온 17개 계약은 수정하지 않는다.

B01은 workflow registry, validator, immutable profile snapshot을 제공한다. 이번 구현은 이후 실제 ingress가 재사용할 Node 라이브러리·로컬 저장소·CLI를 만든다. B02 인증·사용자 DB·workspace, B03 지속 workflow/outbox, B04 SSE·명령 API, B05 모의 서비스 완주를 별도로 유지한다. 이 단계의 성공을 B01–B05 또는 AT-04/28의 실제 수용으로 바꾸지 않는다. Paperclip의 상위 관리 계층과 기존 AX의 GET-only 기록 API를 유지한다.

REQ-01/02/03/04/05/06/07/08/09/10/11/13/14/15의 프로파일 결속 근거를 다루고, REQ-12의 실제 서비스 연결은 후속이다. AT-04는 승인된 생략 근거를 보존하는 실제 실행 흐름, AT-28은 mock 근거로 real 배포를 해제하지 않는 실제 배포 경계까지 필요하다. 이번 단위 검사를 원본 AT 실행으로 집계하지 않는다.

## 책임과 파일

- main/code-dev: 계약·구현·통합·최종 검증. `runtime/ifpmic/`의 새 프로파일 schema/validator/workflow registry/snapshot store, `scripts/ifpmic-profile.mjs`, package 설정과 README를 소유한다. frontend, replay reducer, 기존 `server/` API는 변경하지 않는다.
- TC Luna: `tests/ifpmic-profile*.test.mjs`와 테스트 전용 subprocess/fault fixture를 소유한다. 제품 validator의 필드 목록·판정 함수를 기대값 oracle로 가져오지 않는다. 원본 예제·독립 literal fixture와 고정 기대값을 사용한다.
- 별도 Luna reviewer: 계획과 최종 소스·증거를 검토한다. 영속화 경쟁·불확실성 처리는 수집 근거→main 분석→senior의 좁은 사전 조언을 반영한다.
- 계획·테스트·schema 변경이 판정 의미를 바꾸면 실패 자료를 보존하고 해당 단계로 돌아가 재승인/재검증한다.

## 고정할 프로파일 계약

원본에는 project-profile JSON Schema가 없다. 새 schema는 원본 예제의 필드를 검증하는 구현 계약이며 원본에 이미 존재했다고 주장하지 않는다. JSON Schema 2020-12와 정확히 고정한 Ajv 8.20.0을 사용한다. coercion/default 삽입/추가 필드 제거를 사용하지 않는다. 각 object는 required 및 additionalProperties=false다.

| object | 필수 필드·형식 |
|---|---|
| root | schema_version="1.0.0", project_id:string, mode:mock/real, enabled:boolean, source/runtimes/build/quality/device/release/approval:object, validation:string |
| source | repository_ref,base_ref:string; driver_paths,test_paths:string[] |
| runtimes | primary="claude-code", secondary="opencode", provider_profile_ref,model_id:string; versions:{claude_code,opencode:string} |
| build | profile_ref,toolchain_digest,kernel_config_digest:string; timeout_minutes:positive safe integer; artifact_patterns:string[] |
| quality | sam,tem,static:{program_ref,parser_version,rule_version,thresholds_ref:string} |
| device | bridge_id,device_id,adb_serial,fastboot_serial,board_id,flash_profile_ref,boot_identity_method,sqe_script_ref:string; sqe_expected_cases:string[] |
| release | mode:원본 네 release_modes 중 하나; repository_ref,target_ref,version:string; reviewers:string[] |
| approval | plan_required=true, release_required=true, require_distinct_approver:boolean |

string은 비어 있지 않고 C0/DEL 제어문자가 없으며 원래 값을 정규화·trim해 바꾸지 않는다. 배열은 순서를 보존하고 string 항목을 중복 없이 보존한다. 빈 배열은 schema 단계에서는 허용하지만 real 구성 확인에서 미설정으로 다룬다. validation 문구, enabled, mode 또는 임의 approved 필드는 승인 근거가 아니다. require_distinct_approver=false를 임의로 true로 바꾸지 않으며 실제 사내 정책 확정은 후속 승인 계층의 책임이다.

입력은 UTF-8 JSON text, 최대 1MiB, 중첩 최대64로 한정한다. 파일 loader는 fatal UTF-8 decode를 사용한다. root object/array를 depth1로 세고 container가 중첩될 때마다1 증가한다. JSON 구문 오류, object root가 아닌 값, 중복 object key(Unicode escape로 같은 key가 된 경우 포함)를 거절한다. 숨은 last-wins 의미를 registry에 들이지 않는다. 순수 검증 API는 text를 받아 자체 parse하므로 caller getter/class/cycle을 실행하거나 stringify하지 않는다. unsupported 입력은 고정 오류로 반환한다. 모든 string 길이와 배열 크기는 전체 입력 byte 한도에 포함하며 추가 임의 업무 제한은 만들지 않는다.

검증 결과는 `{schema_valid, issues:[{code,path}], configuration:{mode,enabled,complete,unresolved_paths}, operational_validation:"not_checked", approval:"not_evaluated"}`의 공개 DTO다. path는 schema가 아는 경로만 사용하고 잘못된 key/value, raw JSON, OS 오류의 실제 경로, 환경변수, 자격 자료를 복사하지 않는다. 잘못된 schema 입력에서는 configuration 필드를 null로 두며 실행 가능 상태를 추정하지 않는다.

known 예제 marker `CONFIGURE`, `APPROVED_BEDROCK_PROFILE`, `PIN_AFTER_COMPATIBILITY_TEST`, `INTERNAL_EXISTING_RULES`와 빈 필수 collection은 구성 미해결로 표시한다. marker가 없다고 실제 참조 존재·서명·승인·smoke 통과를 추정하지 않는다. real 구성 확인은 mode=real, enabled=true, schema valid, unresolved_paths=[]만 검사하고 항상 operational_validation/approval 미판정 표기를 유지한다. mock enabled=true도 real 권한으로 해석하지 않는다. 실제 실행·배포 허가는 B02/B03 및 장비·publisher의 별도 승인/검증 근거가 필요하다.

## workflow identity와 canonicalization

registry는 원본 `workflow_id=ifpmic-sw-v1`을 그 원본 raw-file SHA256 한 값에만 결속한다. 원본 manifest를 확인하고 workflow/state/agent 계약을 제공한다. 다른 ID나 같은 ID의 다른 내용은 거절한다. `schema_version=1.0.0`은 문서 형식이며 별도의 semantic workflow version이 아니다. 향후 Job.workflow_version은 이 immutable registry ID를 조회하는 참조로 매핑한다. 원본 Job/Profile API에 없는 조회·승인 route를 AX server에 임의로 추가하지 않는다.

workflow_source_sha256는 원본 파일 bytes의 SHA다. profile_sha256는 parsed profile을 아래 canonical JSON으로 직렬화한 UTF-8 bytes의 SHA다. 두 의미를 구분한다. canonical JSON은 object key를 JS UTF-16 code-unit 정렬하고 재귀 직렬화하며 배열 순서와 string 값을 그대로 유지한다. locale 정렬, Unicode 정규화, RFC8785 준수 또는 디지털 서명이라고 주장하지 않는다. NaN/Infinity/undefined와 JSON 외 값은 받지 않는다.

불변 snapshot의 payload는 정확히 `{format:"ifpmic.profile-snapshot.v1", canonicalization:"ifpmic-json-v1", project_id, profile_version, workflow:{workflow_id,schema_version,source_sha256}, profile_sha256, profile}`이다. profile_version은 외부에서 지정한 nonempty/no-control string이다. project_id는 profile과 같아야 한다. snapshot_id는 canonical(payload)의 SHA256 hex다. 저장 record는 정확히 `{snapshot_id,payload}`이며 canonical(record)+LF만 저장한다. 시간·현재 관측·승인 추측은 digest와 equality에 포함하지 않는다. 모든 반환 객체는 caller 입력과 분리된 deep-frozen 값이다.

프로파일 version key는 canonical([project_id,profile_version])의 SHA256이며 파일명은 `<key>.snapshot.json`이다. 입력 값을 경로에 직접 연결하지 않는다. 같은 key·동일 canonical record는 같은 snapshot을 반환하고, 다른 내용·workflow 결속이면 `PROFILE_VERSION_CONFLICT`다. 명시적 새 version만 새 등록이다. 기존 final이 잘못된 byte 형식·schema·digest·identity·workflow binding이면 `SNAPSHOT_CORRUPT`로 중단하고 덮어쓰지 않는다.

## 로컬 publication과 복구

Node24/Linux의 신뢰된 로컬 동일 filesystem store만 이번 증거 범위다. root는 미리 존재해야 한다. CLI의 명시적 init은 기존 parent 아래 한 root만 mkdir(0700)하고 parent directory sync 후 성공한다. parent 자동 재귀 생성·symlink root는 거절한다. root가 존재할 때도 parent sync를 확인한다. OS 사용자 격리·network FS·Windows backend·전원 손실 수용은 B02/B12의 후속이며 Windows 장비 bridge 범위와 혼합하지 않는다.

1. caller text/version/workflow binding을 동기 검증·capture하고 canonical record bytes를 만든다. 이후 await 중 caller가 바뀌어도 snapshot은 변하지 않는다.
2. root 안 random temp를 wx/0600으로 생성하고 complete bytes write → file sync → close한다. close 후 inode를 다시 쓰지 않는다.
3. `link(temp, final)`로 create-once publish한다. final에 직접 wx write하거나 overwrite 가능한 rename을 쓰지 않는다.
4. link 성공과 EEXIST/equal-content 경로 모두 root directory sync가 성공해야 success를 반환한다. contender가 winner의 directory sync 전 파일을 보더라도 자기 sync를 완료해야 한다.
5. link 호출의 EEXIST 외 I/O 오류는 결과를 추정하지 않고 `PUBLICATION_UNCERTAIN`으로 다룬다. publish 후 sync 실패도 final을 유지하며 `PUBLICATION_UNCERTAIN`을 반환한다. final rollback/unlink는 금지다. retry는 완전한 final을 검증하고 directory sync 후 같은 snapshot으로 확정한다. link 호출 전 write/file-sync/close 실패는 final이 없어야 한다. 실패를 보고한 뒤 다른 process의 final을 삭제하지 않는다.
6. 자기 temp만 정리한다. process-kill로 남은 temp는 조회·등록·승인에 사용하지 않으며 이 단계에서 다른 process의 temp를 자동 삭제하지 않는다. cleanup 실패가 이미 sync된 final을 롤백하지 않는다.

read는 final을 no-follow로 열고 regular file/크기(최대2MiB)/canonical record bytes/정확 schema/digest/버전 key/workflow raw SHA를 검증한 뒤 deep-frozen 값을 반환한다. symlink·corrupt final과 일반 I/O 실패는 고정 코드로 실패하며 기존 bytes를 바꾸지 않는다. failpoint 주입은 temp write, file sync, close, link, directory sync 경계를 테스트하기 위한 dependency seam이며 실제 CLI가 임의 fault flag를 받지 않는다.

CLI는 JSON 한 줄을 출력하며 기본 read-only validate다. `--profile <path>` 생략 시 원본 비활성 mock 예제를 읽는다. `--read --project-id <id> --profile-version <ref> --store <root>`는 profile 원문 대신 snapshot_id/hash만 출력한다. `--init-store --store <root>`는 init만 수행한다. validate/read/snapshot/init은 상호 배타적이며 unknown/중복 flag와 잘못된 조합은 exit2다. `--require-real-config`는 구성 조건에 한해 exit0/2를 나누며 권한을 발급하지 않는다. `--snapshot --profile-version <ref> --store <existing-root>`만 로컬 snapshot을 생성한다. init은 별도 명시 flag다. stdout은 위 공개 DTO와 snapshot_id/해시만 반환하고 profile 원문은 출력하지 않는다. 구문/구성 오류 exit2, I/O·corruption·publication uncertainty exit3이다. 기본 예제는 disabled mock을 그대로 보존한다. Node module/CLI는 network, child-process, 장비·빌드·publisher 호출을 하지 않는다.

## 단계별 검증 및 합격 조건

| 단계 | 목적·대상 | 방법·담당 | 합격 기준·예상 결과 | 증빙 | 실패 시 복구·재검증 |
|---|---|---|---|---|---|
| P0 | 원본·프로파일 schema·identity·검증 계획 | Luna source collection → main 계획 → senior 경쟁 조언 → 별도 reviewer+TC 사전 독립 검토 | 정확 SHA 승인, 없는 원본 schema/승인 권한 추정0, AT04/28 전체 범위 유지 | source/advice/plan-review/TC-review JSON | 문서·정책 불일치는 원본/계획으로 돌아가 수정·재승인; 제품 선구현 금지 |
| P1 | schema/parser/config 경계 | TC 원본 example+literal valid real fixture, 각 필드 missing/null/extra/type/empty, 잘못된 enum·승인 false, duplicate/escaped duplicate key, depth64/65, 1MiB±1, 비JSON 숫자/불완전UTF8·오류 출력 sentinel | 예제 schema valid·mock disabled 유지; 구성 확인과 operational 승인 구분; invalid 입력 거절·원문 미출력 | targeted unit·case ledger·source SHA | parser/schema/DTO로 복귀, 첫 실패부터 모든 관련 matrix 재검증 |
| P2 | canonical workflow/snapshot 계약 | TC 고정 SHA oracle·key order/array order/다른 project/version/workflow/내용·입력 capture·deepfreeze·변조 read | 동일 의미 object key 순서만 바뀌어도 같은 digest; 배열 순서/업무 값 바뀌면 다른 digest; known workflow 원본 불변 | canonical bytes/hash vectors·snapshot JSON safe fixture | digest/domain identity 정의 재검토; expectation 자동 생성 금지 |
| P3 | create-once 저장·복구·경쟁 | TC 임시 root; 독립 Node process들의 동시 동일/다른 등록; write/sync/close/link/dir-sync fault; EEXIST pre-sync barrier; publication 직전/직후 process kill; corrupt/symlink/oversized files | partial final0, overwrite0, 동일 등록 같은 ID, 다른 등록 한 winner+conflict, sync 없는 success0, uncertain final 보존·retry 확정, orphan 무권한 | process exit/event ledger·file hashes·fault reports | failure 자료/디렉토리 보존 후 publication 경계로 복귀; 관련 fault+race+전체단위 재검증 |
| P4 | CLI 실제 경계·비밀 제외 | TC spawn CLI(temp fixture), 예제 validate/require-real/mock-enabled/real-configured/snapshot/read/init/실패 path; egress·process 호출 없음 static+seam, sentinel stdout/stderr 검사 | exit0/2/3 고정; local flags 외 filesystem write0; 원본/AX provider/API 변경0; configured≠approved 명시 | CLI transcript(안전한 fixture만)/I/O ledger | CLI 전달/DTO 수정 후 모든 CLI·原본 hash/readonly 회귀 |
| P5 | 영향 회귀·고정 후보 | main source/test/plan/lock before→targeted→전체 npm test→build→plugin build→after; TC 원본17+ZIP/DOCX·accepted controls source/UI artifact byte 비교 | 단위 fail/skip0, 예전339 포함; 원본 byte 불변; frontend/replay/server 소스 불변·UI/plugin 산출물 기존 accepted SHA와 동일; 새 dependency/lock 범위 설명 | gate JSON/logs/counts/before-after/snapshot artifact | source 변경/timeout/바이트 차이는 영향 재분석; 아래 UI 검증 범위 확대 후 새 고정 후보 검증 |
| P6 | 독립 감사·요구사항·commit/push | 별도 reviewer가 source/TC/fault/race/gate/원본·공개사본 SHA 검토, main 통합 | P0~P5 실증 + 독립 부분 수용; 목표/AT/B01–B05 전체 완료 주장0 | review/traceability/evidence/commit·push | 반려 단계 복귀·실패 보존·필요한 전체 재검증 후 수용 |

P5의 기존 UI 11-command/browser gate 생략 조건은 엄격하다: 새 runtime 코드가 frontend/replay/server에서 import되지 않고, 해당 소스와 build/plugin output bytes가 controls accepted candidate와 완전히 같아야 한다. Ajv는 Node 전용이며 lock의 기존 dependency resolution 변경 여부를 기록한다. 하나라도 달라지면 영향받는 UI·host·AX browser 검사를 추가하고, 상태 해석·원래 catalog·화면 변경이면 기존 전체11 gate로 확대한다. 생략 조건이 성립해도 실제 service/UI 연결 및 dependency 공급망의 운영 수용은 후속 위험으로 기록한다. parser/store/CLI의 정상·예외·경계·회귀·경쟁 검사는 생략하지 않는다.

## 외부 기술 근거와 남은 수용

Node 공식 [fs.link](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromiseslinkexistingpath-newpath), [FileHandle.sync](https://nodejs.org/docs/latest-v24.x/api/fs.html#filehandlesync) 및 [Ajv 2020-12](https://ajv.js.org/json-schema.html#draft-2020-12)를 확인했다. 실제 개발 환경은 Node24.17.0, 신규 Ajv는8.20.0을 정확히 고정한다. file sync와 directory sync, OS/filesystem별 보장 범위를 구분하며 전원 손실·배포 복구를 단위 fault injection으로 입증했다고 표시하지 않는다.

B01의 operational 승인·실제 ingress 연결, B02 사용자 격리/DB/workspace, B03–B05 지속 모의 완주와 이후 B06–B13/32AT를 계속 추적한다. 실제 저장소/ref·TC 경로, toolchain/config, 내부 품질 기준, 승인된 Bedrock/runtime/SSO, 장비·SQE·제출 profile이 제공되기 전에는 기존 example을 활성화하지 않는다. Git push는 상시 승인 범위이며 실제 배포·외부 제출 승인이 아니다.
