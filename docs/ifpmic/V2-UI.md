# V2 카탈로그·재생 화면 구현 및 검증

REQ-02/05/08/10/12/14에 연결하며 승인된 `V2-SCENARIOS.md`와 `V2-PROTOCOLS.md`를 따른다. code-dev는 카탈로그·화면 통합, TC는 독립 단위·browser 시험, 독립 검토자는 소스·시험 oracle·고정 후보 증거를 담당한다. 이 증분은 이미 구현한 관측 프로토콜을 화면에 연결하며 전체 V2 완료 기준을 축소하지 않는다.

`createScenarioCatalog(workflow,stateContract)`는 동결한 `{id,title,requirement_ids,events,checkpoints}` 목록을 반환한다. checkpoint는 `{id,title,cursor}`이고 사건 앞부분만 재생한다. 재생에 실제 clock·명령·API·모델을 사용하지 않는다. 초기 화면은 설계 보기이고 사용자가 ‘모의 시나리오’를 선택하면 명시적인 MOCK 표시, 시나리오 선택, 처음/이전/다음/끝 관측과 checkpoint 이동을 제공한다. 시나리오를 바꾸면 cursor=0이며 이전 결과를 남기지 않는다.

| 시나리오 ID | 끝 관측의 고정 기대값 |
|---|---|
| happy-path | END, COMPLETED, cycle 1, 29 SUCCEEDED, mock 영수증 1 |
| human-wait / human-wait-oss | P07/P21 WAITING_HUMAN, agent completed가 성공을 해제하지 않음 |
| debug-failure / review-failure / oss-failure | P11/P11/P11, cycle 2, rework 1, 코드 실패 및 P21 사람 reject 증거 보존 |
| oss-design-change | P21의 design_change_needed 근거로 P07, cycle 2, rework 1. X03 설계 반려와 별도 |
| sam-failure / tem-failure / static-failure / sqe-failure | 각각 P07/P11/P11/P07, cycle 2, rework 1, 이전 FAIL 보존. SQE는 P22/P23 관측 뒤 P24 FAIL의 순서이며 실제 trial 결과 형식 검증은 아님 |
| plan-rejection / release-reject-code / release-reject-design | P02/P11/P07, cycle 2, 현재 승인 false |
| metadata-recovery | 같은 cycle 1, rework 1, X02/X03 attempt 2, 기존 quality 보존 및 새 승인으로 mock 완료·영수증 1 |
| metric-missing | P16 RUNNING/INCONCLUSIVE, 성공 관측 거절 |
| stale-result / stale-candidate | P16 RUNNING, 현재 gate 해제 0, 과거 좌표/후보 사유 표시 |
| stale-approval | X03 WAITING_HUMAN, 승인 false, digest 불일치 거절 |
| duplicate-events | P01 READY, timeline 1, 중복 3 및 충돌 1 |
| retry-limit | P13 attempt 3 WAITING_HUMAN, 이전 attempt 2개, 4번째 생성 0 |
| cycle-limit | P13 FAILED, cycle 4/rework 3, WAITING_HUMAN 및 failure bundle |
| device-boundaries / flash-unknown | P22 RECONCILING(전체 job), 별도 step RUNNING, 장비 활동·연결·격리 구분. 재할당 false |
| notes-only | notes 실패 checkpoint는 RELEASED_PENDING_NOTES, 끝은 END/COMPLETED, P26 attempt 2, P25 관측 1 유지 |

화면은 job/step/agent/gate/장비 상태를 구분하고 cycle·rework·attempt·현재 후보·mock 영수증·거절 이유·재평가 구간·과거 이력을 표시한다. 노드 선택은 원본 상세와 현재 관측을 함께 보여준다. 사건 이동은 저장된 앞부분의 관측을 바꾸며 실제 재실행 버튼이 아니다. 임의 사건 payload나 사용자 입력을 수집·실행하지 않는다.

TC는 위 25개 시나리오와 모든 checkpoint, 실제 정적 기대값, 불변·결정성·mock 모드·외부 부작용 0을 확인한다. standalone offline 및 실제 격리된 Paperclip host에서 선택/이동/현재 단계/과거 실패·승인·장비 상태/375px·1440px/외부 요청·쓰기·runtime 오류 0을 검사한다. 기본 설계 보기와 기존 AX unit/browser 회귀, build, plugin build, 원본 자료 검증도 수행한다. 통과 기준은 등록 시나리오 및 필수 명령 100%, 소스 고정, 독립 증거 수용이며 불일치하면 첫 잘못된 사건·화면으로 복귀해 수정 및 영향 범위 재검증한다. 증거는 `workflow-artifacts/verification/V2/ui/`와 `evidence/v2/ui-*`에 보존한다.

카탈로그는 화면에도 미완료 범위를 표시한다. skip/policy-exempt, manual-device 및 P22 trial 상세, child-agent, pause/resume/cancel, no-change, 비노드 P03/P25 전용 프로토콜은 후속 작업이다. 전체 V2 gate는 이들까지 완료한 뒤에만 수용하며 실제 AT ledger는 계속 미실행 상태다. UI 증분 통과를 전체 V2 또는 B 단계 완료로 집계하지 않는다.

고정 checkpoint ID는 모든 항목의 start(cursor=0), end(cursor=사건 수)를 포함한다. 정상은 planning/development/quality/approved/published/completed, 사람 대기는 wait/agent-completed/blocked, 실패/반려는 rejected(사람)/failed/returned, metadata는 rejected/returned/corrected/approved/completed, metric은 incomplete/blocked, stale은 stale/blocked(approval은 stale만), duplicate는 first/duplicates, infra retry는 wait-first/attempt-two/wait-second/limit, cycle은 return-one/return-two/return-three/limit, device는 time-9999/time-10000/time-10001/time-29999/time-30000/time-30001/time-59999/time-60000/time-60001, flash는 unknown/idle, notes는 notes-failed/notes-retry/completed를 둔다. 각 ID는 해당 관측 직후의 prefix cursor이며 TC는 시나리오별 고정 상태 기대값과 함께 검사한다.
