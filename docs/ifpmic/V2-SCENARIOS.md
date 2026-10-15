# V2 모의 사건 재생 설계와 검증 범위

V2는 Paperclip의 IFPMIC 페이지에서 합성 사건을 앞뒤로 탐색하는 읽기 전용 관측 모델이다. Temporal 실행기, 명령 수락 API, 장비 lease 서버 또는 publisher를 대신하지 않는다. 실제 서비스의 권한·중복 실행·재시작·원격 영수증 시험은 B 단계에 그대로 남는다. 원본 계약과 실제 AT 실행 ledger는 변경하지 않는다.

요구사항: REQ-02,05,08,10,12,14. 기준은 승인된 `VERIFICATION.md` V2 gate 및 원본 workflow/state/agent/bridge 계약이다. code-dev가 구현·통합하고 TC가 독립 테스트를 작성하며, 기존 독립 검토자가 계획과 최종 증거를 감사한다. SAM/TEM/정적분석과 SQE는 각각 원래 담당과 판정을 모의 자료에 보존하고 실제 도구를 호출하지 않는다.

## 관측 모델

- `createScenarioCatalog(workflow, stateContract)`는 고정된 합성 시나리오 목록을 만든다. 각 항목에는 id, 이름, 요구사항, 모의 사건 목록이 있다.
- `replayScenario(scenario, workflow, stateContract, cursor)`는 처음부터 cursor까지 사건을 순서대로 투영한다. 원본·입력·과거 attempt/cycle을 수정하지 않으며, cursor를 뒤로 옮기면 동일한 앞부분을 재계산한다.
- 사건에는 event_id, source_id/source_seq, job_id, step_id, cycle, attempt, execution_id, mode=mock이 있다. 공개 요약·증거 ID와 승인/후보 식별자만 사용하고 추론·원시 명령·도구 입출력·인증 자료는 투영하지 않는다.
- 결과에는 mock 표시, job 상태, 현재 단계/cycle/후보, 단계 상태, 별도 agent 상태·gate 판정, 사람 대기 사유, 장비 관측값, 사건 timeline, 무시/차단 사유, 과거 시도 이력을 둔다.
- 단계 상태는 원본 `step_transitions`로 검사한다. 에이전트 completed는 agent 상태만 갱신하며 사람 증거나 품질 판정을 생성하지 않는다. 사람 단계에는 담당·task/plan version·증거가 일치하는 모의 human submission이 필요하다.
- 측정 증거는 cycle/attempt/execution/candidate/rule 및 mock 모드를 확인한다. PASS는 완전한 증거가 있을 때만 표시하고 ERROR/INCONCLUSIVE/EXEMPT와 구분한다. 현재 cycle·attempt·execution이 아닌 결과는 과거 기록으로만 남긴다.
- 동일 event_id 또는 source_id/source_seq는 한 번만 timeline에 반영하고 중복 수를 별도 표시한다. 서로 다른 payload의 중복은 충돌로 기록한다. 사건 수신과 applied/ignored 판정을 구분한다.

구현 API는 `src/ifpmic/replay.mjs`에 둔다. `isAllowedStepTransition(from,to,stateContract)`, `evidenceCurrent(evidence,context)`, `projectDeviceClock(observation)`의 순수 guard를 공개해 TC가 별도로 시험할 수 있게 한다. 장비 관측 입력은 now_ms, last_heartbeat_ms, lease_expires_ms, operation_state이며 clock과 프로파일 경계값을 사용한다. evidence/context는 job_id, step_id, cycle, attempt, execution_id, candidate_fingerprint, rule_version, mode를 비교한다.

시나리오는 `{id,title,requirement_ids,events}` 형태다. 사건별 부가 관측은 `payload`에 두고 type별 허용 필드만 읽는다. 재생 결과는 `{mode,scenario_id,job_id,status,cycle,candidate_fingerprint,current_step,steps,history,timeline,ignored,duplicate_count,conflict_count,device,release,wait_reason,real_publish_allowed:false}` 형태다. 각 steps 항목은 state, agent_status, gate_verdict, attempt, execution_id, evidence_ids를 분리한다. 단위시험의 실제 필드 및 type별 의미는 TC와 code-dev가 착수 전에 확인하며 알려지지 않은 type·필드는 통과 근거가 될 수 없다.

## 모의 시나리오와 독립 기대값

| 시나리오 ID | 목적·대상·방법 | 합격 기준·예상 표시 | 실패 복귀·재검증 |
|---|---|---|---|
| happy-path | 29개 단계의 정상·사람 제출·gate 결과를 순서대로 재생 | END, mock COMPLETED, 모든 원본 단계·확장 단계, 승인과 제출 증거는 모두 mock | 사건 생성/전이로 복귀, 정상 전체 재생 |
| human-wait | P07/P21에서 agent completed만 전달한 뒤 담당 human 제출 | 제출 전 WAITING_HUMAN 유지, 제출 후에만 완료. 미해결 P03도 사람 대기로 표시 | 사람 guard/상태 검사 수정 후 관련 정상·부정 시험 |
| agent-wait | code-dev의 tc 대기와 자식 execution 결과 | WAITING_AGENT와 자식 ID 표시, 다른 자식 결과 무시 | identity guard와 tc 시나리오 재검증 |
| sam-failure / tem-failure / static-failure | P16/P18/P20의 모의 측정 실패 | 각각 P07/P11/P11 복귀, 새 cycle 및 필수 재평가 구간. 이전 실패 이력 보존 | 원본 gate 복귀 경로부터 재생 |
| sqe-failure | P22 시험 실패, P23 보고 후 P24 판정 | 보고서가 먼저 표시되고 P24 FAIL 뒤 P07 복귀 | SQE 보고 순서부터 재검증 |
| plan-rejection / release-rejections | X01 및 X03 반려 사유 | P02, P11/P07/X02의 원본 경로. 승인되지 않은 제출 0 | 특수 결과 매핑/승인 guard로 복귀 |
| metric-missing | exit=0이나 결과 불완전 | ERROR/INCONCLUSIVE, PASS 및 후속 해제 없음 | parser/evidence 검사부터 정상·누락 비교 |
| skipped-baseline / skip-rejected / policy-exempt | BUGFIX의 재사용·근거 누락·정책 면제를 모의 비교 | 승인자/사유/해시/plan version 필요. SKIPPED 및 EXEMPT, PASS 아님. COUPLED는 P15/P16, P17/P18, P19/P20, P22/P24의 수행·판정을 짝으로 면제하고 근거를 함께 기록한다. 기본 pilot 품질 면제 금지. NEW_HW 문서 생략 금지 | skip 검증/프로파일로 복귀, REUSE/POLICY/COUPLED 각각 재시험 |
| stale-result / stale-candidate / stale-approval | 이전 cycle/attempt/execution, 후보 A 결과, 옛 manifest 승인 주입 | 현재 gate/승인 해제 0, 무시 사유와 과거 기록 표시, 실제 제출 가능=false | 증거 identity/digest 검사 재검증 |
| duplicate-events | 같은 event와 source sequence를 재전달, payload 충돌도 주입 | timeline 중복 표시 0, duplicate/conflict 수만 증가, cursor 탐색 결정적 | dedup 투영부터 전체 시나리오 회귀 |
| retry-limit / cycle-limit | 인프라 총 3 attempt와 추가 재작업 3회 및 한도 초과 요청 | attempt 1~3만 실행. 1/2회 오류 뒤 10초/30초 대기, 3회 오류 뒤 사람 대기이고 4번째 실행 없음. 업무 초기 cycle=1/rework_count=0; 추가 재작업은 최대 3회(cycle 2~4). 재작업 3회 실패 뒤 추가 요청은 사람 대기, cycle/attempt를 늘리지 않는다 | retry/route 검사부터 한도 -1/동일/+1 재검증 |
| device-boundaries / flash-unknown | heartbeat·offline·lease 경계를 합성 시간으로 재생 | heartbeat due 10초, offline 30초, lease 60초. 활동/불명확 중 만료는 격리·RECONCILING, 재할당/재flash 없음 | 장비 관측/격리 guard로 복귀 |
| manual-device | 자동 조작 불가 후 모의 사람 증거 제출 | performer, device identity, image hash, script version, timestamps, expected cases, 결과 artifact가 모두 필요. 누락/다른 이미지 차단, 사람 수행임을 표시하고 자동 실행 주장 0 | 수동 증거 검사로 복귀 |
| pause-resume / cancel-unknown | 대기 상태 pause/resume, paused 중 in-flight 완료, 불명확 작업 중 cancel | resume_state/resume_step 저장, 사람·장비 대기 복원 또는 새 attempt. paused 중 안전하게 끝난 결과는 보존하고 job은 PAUSED 유지. cancel은 CANCEL_REQUESTED 뒤 안전 경계·실제 종료 확인 전 RECONCILING을 표시한다. late receipt 보존, 조정 완료 전 lease 해제/재할당 금지. 완료 확인 후 CANCELED. rollback 또는 부작용 자동 재실행을 주장하지 않는다 | 제어 투영/대기 복원/안전 경계/영수증/lease 순서부터 재시험 |
| notes-only | P25 mock 완료 뒤 P26 실패·노트 재시도 | RELEASED_PENDING_NOTES, P25 관측 1회 유지, 노트만 새 attempt | notes 투영부터 재시험 |
| no-change | 코드/TC가 기존 요구를 충족한 모의 사람 확인 | NO_CHANGE, 빈 commit·가짜 release 없음 | no-change 조건 재검증 |

## 경계와 UI 기준

장비 시간은 합성 clock이며 실제 타이머를 실행하지 않는다. 이 모형의 경계 규칙은 `elapsed >= threshold`다. 각 10/30/60초 기준의 바로 전·정확히 동일·바로 뒤(1ms)를 TC가 검사한다. 동시 heartbeat와 offline tick의 서버 정렬 규칙은 B09에서 확정하며 모의 관측의 정렬을 실환경 계약으로 확대하지 않는다. active/unknown 작업은 lease가 끝나도 즉시 재할당하지 않는다.

재시도 횟수는 초기 실행을 포함한 총 attempt 수, 업무 재작업 한도는 초기 실행 이후의 추가 rework 수로 이 합성 모형에서 구분한다. 이는 `infrastructure_max_attempts`와 `business_rework_cycles`를 별도 필드로 유지하려는 표시 규칙이며 실환경의 cycle 번호 체계를 확정하지 않는다. B03에서는 버전이 있는 프로파일과 담당자 확인으로 실제 번호·한도 해석을 고정하고 원본 AT-24를 검증한다. 원본 `VERIFICATION.md`의 3회 한도를 완화하지 않으며 UI에는 cycle 번호와 rework_count를 함께 보여준다.

pause/resume/cancel fixture에서도 각 step 전이는 원본 상태 인접표를 따른다. 대기 복원에 중간 READY/RUNNING 관측이 필요하면 이를 명시적으로 기록하고 숨은 실행을 만들지 않는다. 완료된 step을 다시 RUNNING으로 덮어쓰지 않고 새 attempt 또는 다음 단계로 표시한다. 외부 결과 불명확 중의 취소는 안전한 command 경계와 reconciliation 증거가 있기 전 완료나 lease 해제를 표시할 수 없다.

사용자는 ‘설계 보기’와 ‘모의 시나리오’를 명시적으로 전환한다. 초기 화면은 기존 설계 보기로 유지한다. 시나리오 선택, 이전/다음/처음/끝 관측 이동과 cycle/attempt 이력을 제공하고 실제 제어 버튼처럼 보이는 실행·배포·장비 조작은 제공하지 않는다. 모의 화면·사건·증거의 mock 표시가 빠지면 불합격이다. 단계/agent/gate/장비 상태를 별도로 읽을 수 있어야 한다.

TC는 고정된 경로·담당·상태 oracle과 부정 사건을 작성한다. 단위 검증은 원본 상태 인접표의 허용/금지 조합, 위 시나리오 전부, stale/dedup/증거/시간 경계를 검사한다. browser는 standalone 및 실제 Paperclip page에서 시나리오 선택·앞뒤 재생·상태/사유·구간 이동·375/1440px·외부 요청 및 쓰기 0을 검사한다. 기존 V1·AX 단위/화면 회귀를 함께 수행한다.

증거는 `workflow-artifacts/verification/V2/`의 시나리오 manifest, 사건별 적용/거절 기록, 명령 결과, source/build/plugin 해시와 화면으로 보존한다. 합격은 등록된 시나리오 전부 검사, 경로/guard 불일치 0, 외부 side effect 0, 실제 AT ledger 변경 0 및 독립 수용 판정이다. 실패 시 분류·수정 후 관련 시나리오부터 전체 영향 범위를 재검증하며, 검증 중 소스가 바뀐 결과로 후보를 수락하지 않는다.
