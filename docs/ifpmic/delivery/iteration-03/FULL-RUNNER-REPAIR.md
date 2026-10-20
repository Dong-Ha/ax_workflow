# Full490 실행기 검토 결함 복구

연결: 기존 RAW-RUNNER/RAW-LIVE, FULL-EXECUTE/AUDIT, B03 H2의 시간·소스·프로세스 정리 의무.490개/25+5 의무와 case/phase cap은 유지한다. 구현 전 독립 계획 검토 후 진행한다.

| 단계 | 목적 | 대상 | 방법 | 담당 Agent | 합격 기준 | 예상 결과·증빙 | 실패 복구·재검증 |
|---|---|---|---|---|---|---|---|
| R-PLAN | 발견 결함의 복구 범위 확정 | 본 보완 및 전체 실행기 지적 | 독립 정적 검토 | Code-dev/독립 reviewer | 기존 예산·승인 경계 유지, 아래 복구와 시험 일치 | 정확한 계획 SHA 검토 | 지적 수정·재검토 |
| R-SOURCE | 전건 통과 후 오판정·검증 우회·무한 지연 방지 | runner 집계, 고정 helper closure, 단일 deadline/TERM/정리 | stdlib budget helper와 runner 통합 작성, TC 합성 시험 작성, 독립 exact source 검토 | Code-dev 구현/TC 작성/독립 reviewer | phase counts 저장/소비 일치; import 전 필수 helper pin 존재·실제SHA; parent/collection/raw-child/preflight는 fresh private pycache prefix와 -B로 기존 pyc를 읽거나 쓰지 않음; owned_children triple 처리; 단일 부모 deadline으로 command·감사·proposal·pass 제한 | 소스·수정 근거·검토 pin | 실행 전 결함 수정·재승인 |
| R-UNIT | 정상·예외·시간 경계·회귀 검증 | 신규 stdlib budget helper 및 해당 guarded pure runner 함수 | exact 소스 승인 후 합성 unittest, 기존93 포함, private timeout60 | TC 작성/Code-dev 실행/독립 결과 reviewer | 남은 시간 부족 시 launch 거절/timeout 축소; deadline 초과 pass0; TERM/반복 TERM 제어; 실제 서비스 없이 합성 owned process identity/clock로 원래 deadline 정리 경계 확인; 원래93 유지 | 실제 ID/log/before-after·보존 증거 | 실패 attempt 보존·원인 단계 복귀·source 재검토·합성 회귀 재실행 |
| R-FULL | 실제 연결된 실행·증빙·정리 확인 | 새 versioned490 후보와 전체 runner | paired source/pre-gate 뒤 fresh490, 실제 SQL/SDK/history/프로세스/환경 검증 | Code-dev/TC/독립 결과 reviewer |490pass/skip0, 전체 증빙·원래 시간/정리·개인정보 규칙 통과 | 실제 private 증거와 정제 결과·독립 인수 | 실패 정리·기록 보존·관련 단계 수정 후 fresh490 |

전체 outer16220초와 기존 case/phase 시간은 늘리지 않는다. 기존 overhead800초 안에서 마지막15초를 실패 정리/최종 기록 여유로 보존한다. 작업 deadline은 최초 monotonic start+16220-15이며 command timeout은 남은 작업 시간에서 기존 owned-command kill/wait/reaper 여유7초를 제외한 값으로 제한한다. 모든 실제 case 한도는 그대로이며 전체 한도에 여유가 없으면 새 작업을 시작하지 않고 실패한다. 준비/최종 감사/ZIP도 단일 작업 alarm과 명시적 deadline 확인을 받는다.

TERM/INT는 첫 요청을 실패 경로로 전달하고 반복 요청이 원래 deadline의 정리를 중단하지 않도록 제어한다. 실패 정리는 PID/start-tick/pidfd로 확인된 자신의 자식만 신호하며 최초 outer deadline이 지난 뒤 새 신호나 대기 시간을 만들지 않는다. SIGKILL이나 커널의 중단 불가능 I/O에 대한 Python 수준 보장은 하지 않는다. 기록이 늦어져 outer를 넘으면 통과로 반환하지 않는다. 이전 pass 증거를 새 바이트의 승인으로 재사용하지 않는다.

합성 시험에서 제품/SDK/pytest/SQL/서비스를 실행하지 않는다. 부작용 없는 stdlib helper와 full runner의 순수 함수만 exact 별도 승인 범위로 가져온다. budget signal unit은 별도 실제 서비스 없이 자신의 프로세스 handler 경로를 호출하거나 짧은 소유 subprocess에서 확인할 수 있다. 제품/UI/의존성 변경이 없어 이 단위 checkpoint의 build/browser는 생략하며, 실제 화면 연결 회귀와 전체490은 계속 필수다.

추가 소스 권위 경계: `-B`만으로 기존 pyc 읽기는 차단되지 않는다. parent는 post-gate helper import 전에 새 private cache prefix를 설정하고, 모든 Python child(collection/preflight/raw auditor/test)에 동일하게 새 빈 prefix를 전달한다. 종료 시 모두 비었는지 확인한다. 합성 회귀 자체도 새 prefix를 사용해 현재 원본 bytes를 실행한다. 기존93건의 역사 로그는 보존하되 새 후보의 cache-isolated proof로 재사용하지 않는다.
