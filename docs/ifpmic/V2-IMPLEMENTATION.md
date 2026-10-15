# V2 구현 진행 기록

V2 전체 기준은 `V2-SCENARIOS.md`와 `VERIFICATION.md`다. 이 기록은 완료 기준을 축소하지 않고 구현 증분과 남은 작업을 구분한다. 구현은 UI에 연결하기 전의 순수 재생 모델부터 진행한다.

## 첫 증분: 관측과 통과 근거 분리

대상 요구사항은 REQ-02,05,08,10,12,14다. 구현은 code-dev(`/root`), 테스트 작성은 TC(`/root/verification_plan`), 읽기 전용 독립 검토는 `/root/paperclip_ui_extension`이 맡는다. 원본 계약 파일과 실제 AT ledger를 수정하지 않는다.

`src/ifpmic/replay.mjs`는 `replayScenario(scenario, workflow, stateContract, cursor)`로 앞부분의 사건을 매번 재계산한다. 시나리오는 `{id,title,requirement_ids,events}`이며 cursor는 0부터 사건 수까지의 정수다. 최초 job ID는 `mock:<scenario.id>`, candidate는 `mock:candidate:A`, rule은 `mock:rules:v1`, cycle/attempt는 1이다. 각 단계 execution은 `mock:<step_id>:c1:a1`이다. 이 규칙은 합성 관측의 좌표이며 실환경 식별자 계약이 아니다.

공통 사건 필드는 event_id, source_id, 양의 정수 source_seq, type, mode=`mock`, job_id, step_id, cycle, attempt, execution_id, payload다. 미등록 최상위 필드나 유형별 payload 필드는 사건 전체를 거절한다. ID는 128자 이내의 영문·숫자와 `:._/-`만 허용하며 인증 패턴이 감지되면 거절한다. 잘못된 사건 ID는 `[invalid]`로 표시하고 잘못된 시나리오 ID는 내용 없는 형식 오류로 거절한다. timeline은 식별자·유형·mock 표시·적용 여부·상수 사유만 반환한다. 원시 payload·명령·추론·인증 자료는 반환하지 않는다.

| 유형 | 허용 payload | 현재 통과 조건 |
|---|---|---|
| step | state | 원본 인접표 및 현 단계·실행 좌표 일치. SUCCEEDED는 담당별 별도 근거 필요 |
| agent | status | running/completed/failed 관측만 갱신. 단계·사람 업무·gate 완료를 대신하지 않음 |
| human | actor, task_id, plan_version, evidence_id | WAITING_HUMAN의 사람 담당 단계, mock:human, 현재 모의 task와 plan, mock 증거 ID |
| measurement | evidence, verdict | system 담당 RUNNING 단계, 현재 job/step/cycle/attempt/execution/candidate/rule/mock 일치. 불완전 증거는 INCONCLUSIVE |
| device | mode, now_ms, last_heartbeat_ms, lease_expires_ms, operation_state, profile | 합성 정수 시간과 heartbeat/offline/lease 경계. 실제 할당 권한 없음 |

장비 시간 및 profile threshold는 안전한 정수 밀리초만 받는다. future heartbeat나 잘못된 값은 UNKNOWN·격리로 표시한다. OFFLINE 상태에서도 operation_state를 별도로 보존하여 로컬 작업이 여전히 활동 중일 수 있음을 잃지 않는다. 불명확 작업 또는 활동 중 lease 만료는 RECONCILING이며, 사람 대기 사건으로 전체 격리 상태를 덮어쓸 수 없다. 이후 telemetry가 idle이어도 격리를 유지한다. 격리 해제 프로토콜은 아직 지원하지 않으며 `reassign_allowed`는 항상 false다.

동일 event_id 또는 source_id/source_seq는 한 번만 관측한다. 전달 식별자를 제외한 사건 내용이 달라지면 충돌 수도 증가한다. 새로운 전달 별칭을 붙여 중복 사건을 다시 적용하지 않는다. 중복이 아닌 과거 source sequence도 적용하지 않으며 장비 clock이 뒤로 가는 관측을 거절한다. sequence watermark는 적용한 사건으로만 높이고 거절한 사건은 중복 키만 예약한다. 따라서 잘못된 seq=999 사건 때문에 뒤의 정상 seq=1이 거절되지 않는다. 출력은 재귀적으로 동결하며 입력을 수정하지 않는다. SUCCEEDED 뒤에는 원본 다음 단계 ID만 바뀌고 다음 단계의 실행 상태를 자동 생성하지 않는다. 전이 검사는 전달된 계약과 커밋된 원본 인접표를 함께 확인하여 호출자가 새 전이를 삽입해도 허용하지 않는다. workflow 전체는 모듈 초기화 시 고정한 원본 서명과 비교하므로 담당·경로·정책 변경으로 사람 또는 품질 gate를 우회할 수 없다.

## 검증과 미완료 범위

검증 목적은 잘못된 근거로 단계가 성공하거나 과거 관측이 현재 단계를 해제하는 것을 막는 것이다. TC는 원본의 고정 인접표 전체 조합, 정상·부정 좌표, 사람 제출, 측정 누락, 중복/충돌, cursor 복원, 장비 시간 경계 및 개인정보 제외를 검사한다. 합격 기준은 해당 단위시험 전부 통과, 기존 회귀 및 build 성공, 실행 전후 소스 해시 일치와 독립 검토다. 결과는 `evidence/v2/core-verification.json` 및 별도 검토 기록에 귀속한다. 실패하면 최초 잘못된 전이/fixture로 돌아가 수정하고 영향을 받는 세트와 회귀를 다시 실행한다.

첫 증분 수락 시 전체 V2는 미완료였다. 당시 잔여 범위는 시나리오 카탈로그, cycle/attempt 이력, 업무 실패 복귀, 자식 agent, 생략 정책, 수동 장비 증거, pause/resume/cancel, digest 승인과 영수증, notes-only/no-change, standalone/native host의 재생 UI 및 전체 V2 gate가 남는다. 전용 근거 프로토콜이 없는 제어·생략은 거절한다. X03 일반 human 제출과 P25 성공도 거절하며 `real_publish_allowed`는 항상 false다. 실제 AT는 미실행 상태를 유지한다.

## 다음 증분: 실패 복귀·재시도·배포 관측

상세 필드와 검증 기준은 `V2-PROTOCOLS.md`, 계획 승인 근거는 `evidence/v2/protocol-plan-review.json`이다. `protocols.mjs`와 replay의 유형별 allowlist는 업무 실패/반려 증거, 새 cycle·attempt snapshot, 원본의 10초/30초 재시도, 후보 무효화, 현재 네 gate의 PASS에 묶인 mock manifest, digest 승인 및 영수증, P26 노트 전용 재시도를 구현한다. 일반 step·agent 관측만으로 이 근거를 만들지 않는다.

manifest digest는 합성 사건에 기록된 불투명 토큰이다. 실제 암호학적 manifest 생성·서명·원격 조회를 구현한 것으로 표시하지 않는다. 토큰과 manifest ID는 candidate/rule/destination/notes/bundle뿐 아니라 cycle/X02 attempt/execution 및 gate evidence ID에 불변으로 묶는다. 실제 작업 승인·발행 권한은 항상 false다.

TC는 별도 `tests/ifpmic-protocols.test.mjs`에서 고정된 12개 복귀 경로, 인프라/notes 이력, 한도와 시간 경계, 잘못된 승인·영수증, 정상 완주 및 과거 후보 차단을 검사한다. 기존 재생·AX 회귀와 build도 새 소스 후보로 수행한다. 수용 증거는 `evidence/v2/protocol-verification.json`과 독립 검토 기록으로 보존하며 전체 V2는 계속 진행 중이다. 다음 잔여 범위는 skip/manual/agent-child/pause/cancel/no-change와 비노드 P03/P25 프로토콜, 카탈로그·재생 UI 및 전체 standalone/native host gate다.

### Metadata-only 복구 결함과 보완

단순 복귀 target 검사와 정상 29단계 완주만으로는 반려 뒤 복구를 증명하지 못했다. 200개 테스트와 독립 증거 감사 뒤에도 부모 통합 검토가 X03 자료 반려→X02의 진행 불가를 발견했다. 초기 후보는 `protocol-attempt-2.json`으로 보존하고, TC가 end-to-end 복구 실패를 재현한 뒤 원본과 별도 senior_sol의 좁은 설계 검토로 복귀했다.

보완 규칙은 `V2-PROTOCOLS.md`의 metadata-only 예외와 독립 계획 재검토(`protocol-plan-review-2.json`)를 따른다. 같은 cycle의 품질 결과를 그대로 유지하고 X02/X03만 새 PENDING attempt로 바꾼다. 공유 재작업 한도를 계속 적용하고 이전 승인·manifest·task를 폐기한다. 사람 제출도 실행/attempt에 묶으며 인프라 retry가 기존 제출을 재사용할 수 없다. TC는 반려부터 수정 manifest·새 승인·영수증·노트 완료까지 및 혼합 재시도/한도를 검증한다. 실제 B03/B11 정책과 전체 V2 수용은 여전히 별개다.

## 카탈로그·재생 UI 증분

`V2-UI.md`의 독립 승인된 25개 카탈로그와 checkpoint를 standalone 및 공식 Paperclip page에서 탐색한다. 기본 설계 보기, 시나리오 변경의 cursor/필터 초기화, 관측 앞뒤 이동, 현재 job/단계/Agent/Gate 및 과거 이력의 분리, 명세·승인·영수증과 장비 활동·연결·격리 표시를 제공한다. 모든 사건·증거는 MOCK이며 실제 AT를 완료로 바꾸지 않는다.

TC가 독립적인 25개 끝 상태와 checkpoint oracle, 실제 host/offline browser를 작성한다. 초기 browser 자료의 과거 FAIL 기대값은 현재 cycle의 PENDING과 혼동하지 않도록 정정했고, 과거 실패는 history에서 확인한다. 부모 검토에서 필터가 현재 단계를 숨겼을 때 focus/scroll을 놓치는 결함을 재현했다. layout effect에서 새 DOM을 확인한 뒤 이동하도록 수정하고 실제 focus와 scroller 교차 여부로 재검증한다. 반려 진단은 `evidence/v2/ui-attempt-1.json`에 보존한다.

고정 후보 gate는 `npm run ifpmic:verify:ui`다. 단위/build/plugin/원본/원본 validator/V1 화면 및 실제 host/재생 offline·host/기존 AX 화면을 모두 수행한다. source/build/plugin, 25개 mock fixture·사건 journal, 명령·browser 보고서·desktop/mobile 화면 해시를 보존하고 소스 변경 시 거절한다. 증거는 `evidence/v2/ui-verification.json`과 독립 수용 기록에 연결한다. 이 증분 통과 후에도 skip/manual/trial 상세/자식 Agent/pause/cancel/no-change/P03/P25 전용 프로토콜과 전체 V2 gate 및 B 단계는 남는다.

## 사양 질문·원격 조회 증분

승인된 `V2-EXCEPTIONS.md`에 따라 P03 질문→사람 답변→새 요구사항 버전의 spec-gen 재검토 및 P25 불명확→동일 operation의 최신 원격 receipt 재사용을 추가한다. 사건은 합성이며 실제 질문 서버·원격 조회·제출을 호출하지 않는다. 전용 TC와 전체 단위/build/plugin-build, 소스 고정 및 독립 수용을 거친 뒤 부분 증분으로 기록한다. 검증 명령은 `node scripts/verify-ifpmic-exceptions.mjs`이고 결과는 `workflow-artifacts/verification/V2/exceptions/gates/`에 남긴다.

이번 증분은 새 UI·카탈로그를 추가하지 않으므로 기존 25개 화면 시나리오의 지원 범위를 확장했다고 표시하지 않는다. 새 질문/원격 조회의 화면 연결, 나머지 skip/manual/child/pause/cancel/no-change/P22 trial과 전체 V2 gate는 계속 필요하다.

## 질문·원격 조회 화면 연결

`V2-EXCEPTION-UI.md` 계획에 따라 기존 25개 fixture를 유지하고 P03 질문/답변/재시도/추가 질문 및 P25 불명확/복구/장비 격리 7개를 추가한다. 전체 32개와 주요 checkpoint를 탐색하며, 질문 원래 좌표·답변 버전·현재 실행의 검토 좌표 및 원격 동작·순번·결과·증거를 별도 패널로 표시한다. catalog evidence의 `observed_snapshot`은 재생에서 관측한 값이며, TC의 독립 고정 oracle을 대신하지 않는다.

32개 catalog/unit, standalone/isolated native-host의 새 예외 관측과 기존 화면, 375/1440px, 전체 AX 회귀를 같은 고정 후보에서 검증한다. 전체 V2와 B 단계/실제 AT는 여전히 별도다.

## 재사용·면제·무변경 종료 프로토콜 증분

독립 승인된 `V2-ROUTING.md`에 따라 합성 route context, X01 이전 P03–P05의 개별 사람 재사용 확인, X01 전체 계획 승인, P06–P12 재사용 근거, POLICY/COUPLED 면제와 P23 미수행 보고, P11 code-dev·P12 TC의 별도 분석 및 사람 NO_CHANGE 종료를 추가한다. 계획과 근거는 cycle/attempt/execution, 후보와 요구사항 버전에 결속한다. 원본 복귀 경로에서 계산한 필수 재검증 구간은 생략하지 않는다. 후보 변경은 기존 생략 권한을 폐기하면서 정상 신규 PASS 검증 경로를 유지한다.

면제된 gate는 PASS가 아닌 EXEMPT이며 측정 완료를 주장하지 않는다. mock manifest에도 네 gate의 disposition을 보존한다. NO_CHANGE는 P12에서 멈추고 이후 빌드·배포·빈 커밋을 만들지 않는다. 실제 사람 승인·장비·발행 API 호출은 없다. X01 이전 재사용 시점, 면제 시 SQE 보고, EXEMPT 배포 정책, NO_CHANGE 종료 위치는 mock 설계 결정이며 실제 B01 정책 승인과 구분한다.

검증은 별도 TC와 `node scripts/verify-ifpmic-routing.mjs`의 전체 단위/build/plugin-build, 소스 고정 및 독립 수용이다. 이 증분은 React/CSS/기존 32개 카탈로그를 변경하지 않으며 새 routing 화면을 검증했다고 표시하지 않는다. 후속 routing 카탈로그·standalone/native-host 화면, manual/trial/child-agent/pause/resume/cancel과 전체 V2·B01–B13·실제 AT는 계속 필요하다.

## 재사용·면제·무변경 화면 연결

`V2-ROUTING-UI.md`의 독립 승인 후 기존 32개 events/checkpoints 해시를 고정하고 새 routing 시나리오 9개를 추가한다. 별도 합성 fixture 모듈은 replay 결과를 읽어 결정을 만들지 않는다. local 확인과 X01 승인을 분리하고 원래 cycle/후보/승인 실행을 표시하며 현재 권한을 비교한다. 선택 상세는 생략 근거·별도 분석·SQE 미수행 보고와 측정 완료 여부를 표시한다. NO_CHANGE는 사람 확인 뒤에만 전용 패널을 만들고 manifest 처분과 과거 계획/품질 처분을 구분한다.

TC의 41개 literal endpoint/checkpoint oracle, 기존 32개 사건/checkpoint SHA 보존, standalone/native-host 주요 경계와 375/1440px 캡처, 11명령 전체 UI gate 및 독립 증빙 감사로 수용한다. 실제 정책/장비/AT와 전체 V2는 계속 미완료다.

## 필수 SQE 증거와 기존 카탈로그 이관

`V2-SQE.md`의 독립 승인에 따라 모든 비면제 P22/P23/P24에서 현재 결과·보고서·규칙 판정 참조를 요구한다. 고정 합성 profile의 두 필수 사례는 실제 사례 수나 기준이 아니다. P22의 수집 완료는 품질 PASS와 다르고, P23은 실패/불완전 결과도 작업 내 보고서로 남기며 P24가 PASS/FAIL/ERROR/INCONCLUSIVE를 구분한다. manual_request는 사람 대기로 이동하고 배정된 수동 결과를 기록해 READY로 돌아간다. 실제 장비 조작·격리 해제·점유·실행 또는 인증을 구현한 것으로 표시하지 않는다.

기존 41개 원래 사건/체크포인트는 `sqe-baseline-41.json`으로 보존한다. 별도 source의 명시적 SQE proof만 삽입하고 TC가 이를 제거했을 때 원래 SHA와 checkpoint cursor가 복원되는지 검증한다. 과거의 사건 byte 불변 수용을 새 실행의 검증으로 재사용하지 않는다. 전용 수동/시험 unit와 전체 단위/11명령 UI gate를 새로운 고정 후보에서 실행하며, 별도 migration ledger와 보고/manifest 참조를 기록한다. 새 수동/trial panel·시나리오·전용 화면 검증, child/control 및 전체 V2·B/실 AT는 남는다.

## SQE 수동·결과·보고·판정 화면 연결

독립 승인된 `V2-SQE-UI.md`에 따라 기존41 events/checkpoints의 SHA를2d6319f 기준으로 보존하고 새9개를 추가한다. 원본 SQE protocol 코어는 변경하지 않는다. UI는 accepted current record와 history만 읽으며 수동 제출의 READY, 수집/보고 완료, P24 판정/complete와 report/manifest 참조를 구분한다. 기대/관측 identity·버전·사례 누락·파서 오류·task/performer·시각·artifact 식별자를 현재/과거 좌표와 함께 표시한다. 원시 결과나 실제 링크·실행·수동 제출 API는 만들지 않는다.

TC가 독립 고정 oracle로 모든50 끝상태·새9 checkpoint·기존41 byte 보존을 검사하고 standalone/native host의 상세·history/reset·375/1440px 및 전체11명령 gate로 검증한다. 긴 상세 mobile 캡처는 host UI를 가리지 않는 viewport 또는 분할 캡처로 읽힘을 확인한다. 전체 V2, child/control, B01–B13/실제 장비·정책·AT는 계속 미완료다.

긴 SQE 과거 기록의 기존200px clipping은 사용자용 이력 펼치기/접기와 시나리오 전환 초기화로 해소한다. 이 보기 상태는 workflow나 승인/실행 사건을 만들지 않는다. TC의 전체 bbox·fixed/sticky 교차·hit-grid 검사를 약화하지 않고 확장한 실제 이력을 캡처한다.
