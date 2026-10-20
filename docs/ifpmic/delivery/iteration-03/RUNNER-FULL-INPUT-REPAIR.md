# 전체 실행 전 증빙 입력 불일치3종 복구

B03 H2 / REQ-02·13·14 / FULL-EXECUTE·AUDIT / RAW-RUNNER·LIVE에 연결한다. e77e2fa의131 합성 검사는 독립 수용됐지만 전체 소스 검토에서 그 범위 밖의 결함3종을 발견했다. [거절된 첫 전체 검토](../../evidence/b03/attempts/h2-runtime-full-runner-source-review-v2-attempt-01.json)를 보존한다. 실제 producer·ledger104 pins·machine38 pins·490 ID·25+5 의무·case/phase/outer 예산은 바꾸지 않는다. 구현 전에 본 계획을 독립 검토한다.

| 단계 | 검증 목적 | 대상 | 방법 | 담당 Agent | 합격 기준 | 예상 결과·증빙 | 실패 복구·재검증 |
|---|---|---|---|---|---|---|---|
| FI-PLAN | 수정 범위와 증빙 의무 보존 확인 | 본 계획·전체 소스 검토 지적 | exact 계획 독립 정적 검토 | Code-dev / 독립 reviewer | 아래3종 외 확장0, 가짜 producer/DB/forced 증거0 | 계획 SHA·검토 | 지적 수정·재검토 후 구현 |
| FI-PROGRESS | extended49개에25+5를 잘못 재적용하지 않음 | verify_progress의 ID별 예산 | 기존 per_case_budgets의 setup_and_body/shared_cleanup 사용. 기존215+25 integration 예외·시각·순서·JUnit·watchdog 비교 유지 | Code-dev 구현 / TC 작성 / 독립 source reviewer | extended의25초 초과가 원래215+25 안이면 통과, 초과는 거절. default25+5 유지 | 실제83 ID/예산·경계 합성 회귀 | 실패 증빙 보존·원인 수정·source 재검토 후 전체 합성 재실행 |
| FI-PG | DB를 요청하지 않는 phase에 가짜 기록을 요구하지 않음 | h1_python / fixture_failure만 PG 비적용 | fixture 도달성 근거로 정확히2 phase만 비적용. 다른13 phase의 실제 PG lifecycle 필수. 비적용 phase의 PG 기록 존재나 unknown phase 거절. 모든 owned descendant/thread/socket/raw 검사 유지 | Code-dev / TC / 독립 reviewer | 기록을 채우기 위한 DB 기동0,13 phase 필수 조건 유지, private report에 비적용 사유 기록 | 적용표·missing/unexpected/unknown 회귀 | 잘못된 적용 수정·source 재검토, 실제 full은 별도 gate 이후 재검증 |
| FI-PROCESS | 중간 동작·DB 관찰과 최종 CLI 종료 증빙 구분 | collect_private_temporal_evidence·실제 journal/cleanup 형식 | 같은 case의 저장된 started(role,PID,start_ticks)와 stopped/cleanup(PID,start_ticks,exit,forced,absent) 결합. killed는 SIGKILL/-9/absent 중간 이벤트로 검증하고 같은 identity/role의 최종 forced=False/absent=True/-9에 반드시 결합. 정확한 postgres service_stopped와 hung-driver-rollback.json의 pg_backend_after_kill은 DB 관찰로 검증해 CLI process 수에서 제외 | Code-dev / TC / 독립 source reviewer | role/identity/exit/absence/forced 모순·최종 cleanup 누락·unknown/잘못된 형식 거절. 실제 기록에 forced를 보충하지 않음. 같은 identity 중복1개/다른 PID·ticks는 별도 집계. SQL role/backend PID 공개0. 기존 정상3 process·unknown fixture 경계 유지 | 실제 source-shaped 합성 journal·결합/분류/익명화 회귀·exact source pins | 오분류·누락 거절과 증빙 보존. producer를 꾸미지 않고 runner만 수정·재검토 |
| FI-UNIT | 정상·예외·경계·회귀 확인 | 기존131 unit + 새3종 회귀 | 새 exact source 승인 후 별도 private wrapper/fresh pycache에서 stdlib unittest discover, timeout60. 기존131 ID 유지, 정확한 실제 ID와 source/cache/원본96/89/17+2/환경1777/3072 전후 비교 | TC 작성 / Code-dev 실행 / 독립 결과 reviewer | 전건pass·skip0·source/cache/원본/환경 불변, 실제 SDK/pytest/SQL/service/main 실행0 | private 실제 로그·manifest·정제 결과·독립 결과 검토 | 실패 attempt 보존·관련 단계로 복귀·source 재승인 후 전체 합성 재검증 |
| FI-FULL | 합성 검사를 실제 full 달성으로 오인하지 않음 | 전체 runner source·paired execution gates·fresh490 | 전체 source와 독립/TC pre-gates를 새 SHA에 고정한 뒤에만 실행 | Code-dev / TC / 독립 결과 reviewer | 기존490/25+5/raw87/953규칙·전체 시간/cleanup/환경/privacy 의무와 실제 결과 독립 수용 | private full 증빙·정제 결과 | 실패 증빙/owned cleanup 보존·원인 수정 후 새 fresh full 재검증 |

새 시험은 기존의 ledger에 고정되지 않은 TC `test_runner_v2_repairs.py`에 추가하고 기존131 method를 유지한다. e77e2fa와 옛131 exact source/결과 검토는 역사 기록으로 보존한다. 옛 source 승인을 변경한 bytes에 적용하지 않는다. 새 capture wrapper는 별도 private 파일을 쓰며 승인된 module 집합 외 discover·symlink·review/source 전후 변경을 거절한다.

구현 대상은 runner와 위 TC뿐이다. source-shaped 시험에서 읽는 activity/restart/conftest 등은 AST/text로만 읽고 exact pin하며 import하지 않는다. private SQL/log/history/PID/role을 공개하지 않고 process 수는 최종 권위 증빙으로만 센다. 선언된 CLI/journal 증빙에 필요한 role/identity가 풀리지 않으면 추정해 통과시키지 않고 실패한다.

UI/build/browser는 제품 변경0이므로 이 합성 단계에서 생략한다. 실제 UI 연결·fresh490·원래 AT32·Agent/장비/배포의 위험과 승인 의무는 남는다. 단위 승인만으로 전체 main을 시작하지 않으며 전체 source/pre-gates 승인을 기다린다.

## process 분류의 정확한 경계

결합 대상은 소스가 선언한 동일 case의 started/stopped journal과 알려진 cleanup 문맥뿐이다. 이미 완전한 proper-role terminal 형식에는 기존 엄격한 검사를 유지한다. PID/ticks/exit 키가 있다는 이유만으로 임의의 roleless JSON을 CLI로 승격하지 않는다. H1의 `processes.json` 최종 registry와 `result.json.cleanup`의 helper 반환값은 다른 문맥이다. 알려진 registry/cleanup 문맥은 실제 소스 경로·형식으로 고정한다. 글로벌·다른 case 간 identity 결합을 금지한다.

선언된 CLI 증빙의 unknown/잘못된 형식은 거절한다. 관련 없는 roleless/DB/helper 메타데이터는 관찰 자료로만 남겨 CLI 수에0을 기여한다. 모든 registry 항목이 개별 CLI terminal 증빙이라는 완전성 조건을 새로 도입하지 않는다. typed journal의 killed는 같은 case에 등록된 role/identity와 실제 -9/absent=True/forced=False terminal이 반드시 있어야 한다. 기존 identityless terminal summary는 명시적인 unidentified outcome type으로만 남기며 물리 process 수에0을 기여한다. 정상 runtime의 정확한3개 distinct identity 조건은 유지한다.
