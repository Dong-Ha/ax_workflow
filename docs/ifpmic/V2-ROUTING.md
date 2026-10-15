# V2 근거 있는 생략·정책 면제·무변경 관측

REQ-01/02/03/04/05/06/10/12/14. 원본 workflow/state/agent 계약, DOCX §8 및 AT-04/30을 기준으로 한다. 실제 프로파일 registry/승인 서비스/실행기는 B01 이후의 필수 항목이며 이 증분은 순수 mock 관측이다. 실제 기준·승인·수용시험을 대체하지 않는다. code-dev(주 에이전트)는 구현·통합, TC는 독립 시험 작성, 별도 검토자는 구현 전 계획과 소스/TC/고정 후보 증거를 감사한다. SAM/TEM/SQE 역할과 원본 skip_policy/step_transitions는 변경하지 않는다.

## 원본과 모의 정책 결정

NEVER=P01/P02/X01/P13/P14/P23/X02/X03/P25/P26. REUSE=P03~P12(X01 제외). POLICY=P15/P17/P19/P21/P22. COUPLED=P16/P18/P20/P24. SKIPPED는 SUCCEEDED/PASS가 아니고 면제 gate는 EXEMPT이며 gate_complete=false다. 원본 정의의 지문/해시는 이 모형에서 mock opaque 토큰으로 비교하며 실제 SHA 검증을 주장하지 않는다.

원본은 P03~P05 REUSE와 P05 뒤 X01 계획 확정을 함께 정의하지만 선행 재사용 승인 시점은 상세히 정하지 않았다. Luna 근거 조사와 별도 senior_sol 검토에 따라 다음을 **명시적인 모의 정책**으로 채택한다: P03~P05에는 현재 노드에 한정한 별도 human reuse_confirmation을 관측하고, X01은 원래 위치에서 수행해 선행 SKIPPED의 동일 계획 버전/증거를 빠짐없이 전역 계획에 포함한다. node-local 재사용은 global X01 승인이나 POLICY 허가가 아니다. P06~P12의 후행 REUSE는 X01이 baseline·입력·사유를 항목별 승인한 목록만으로 허용하며 추가 node-local 사람 확인을 요구하지 않는다. P11/P12 변경불필요 분석과 NO_CHANGE 종료 확인은 별도다. 기존 SKIPPED를 계획 교체로 소급 수정하지 않는다. 계획 가정 변경은 X01 반려→P02 새 cycle로 재계획한다.

P22/P24 공동 면제는 승인 목록에 쌍으로 선언하되 P22→P23→P24 순서대로 소비한다. P22만 SKIPPED인 중간 관측에서 P24는 PENDING이다. P23은 NEVER이며 시험 미실행·면제 사유를 SQE 보고서로 명시한 뒤 SUCCEEDED여야 P24를 SKIPPED/EXEMPT로 처리한다. 정상 실행 P22의 보고·gate 동작은 유지한다.

EXEMPT 뒤의 모의 manifest는 gate별 PASS/EXEMPT 종류와 증거를 불변으로 결속한다. 기본 pilot의 품질/장비 면제 금지는 유지하고, 별도 policy_demo mock profile의 사전승인 규칙 및 X01 확인이 있는 경우만 면제 처분을 인정한다. NO_CHANGE는 P12 SKIPPED와 job NO_CHANGE를 원자적으로 확정하고 current_step=P12로 멈추며 후속 단계는 PENDING으로 남긴다.

위 네 사항(선행 REUSE 시점, 면제 P23 보고, EXEMPT 포함 manifest, NO_CHANGE 말단)은 실제 B01 계약 확정 전에 사람의 정책 결정이 필요하다. 이 모의 증분 승인으로 실정책이 승인됐다고 기록하지 않는다.

## 공통 결속과 사건 schema

기존 event envelope의 mode=mock/job/step/cycle/attempt/execution/source sequence/dedup 및 type별 엄격한 필드 검사를 유지한다. 식별자는 모두 mock opaque ID이고 원문·명령·로그·자격증명을 받지 않는다. 모든 거절은 현재 업무 상태를 바꾸지 않는다. step 전이는 원본 인접표를 검사한다. 기본 replay에는 context가 없어 기존 32개 시나리오 동작을 유지한다.

| 유형 | payload 필드 | 적용 조건·결과 |
|---|---|---|
| route_context | profile_id, profile_hash, profile_kind, change_type, plan_version, candidate_fingerprint, requirements_version, source_hash, test_hash, environment_hash, baseline_environment_hash, input_hashes, policy_rule_id, policy_approval_id | 현재 RUNNING P02에서 cycle당 한 번 불변 제안 snapshot. profile_kind=pilot/policy_demo; change_type=NEW_HW/FEATURE/BUGFIX. input_hashes는 REUSE 10개 노드 ID 모두의 mock 입력 해시 map이며 그 외 key 불가. 현재 후보/요구사항에 결속. pilot은 두 policy 필드 null; policy_demo는 policy_rule_id=mock:policy:exempt:v1 및 mock 사전승인 증거 필요. 다음 cycle은 새 plan_version 필요, 이전 context/확정 계획/재사용 확인은 history 보존. |
| reuse_confirmation | actor, task_id, plan_version, candidate_fingerprint, requirements_version, baseline_hash, baseline_input_hash, current_input_hash, reason_id, evidence_id | 현재 P03/P04/P05 PENDING의 mock:human 확인. task_id=mock:reuse:<step>:c<cycle>:a<attempt>. 불변 context 및 current_input_hash=input_hashes[step]에 결속. baseline/input 동일 여부를 기록하고, 다를 때에도 명시적 이 human 확인과 사유가 필요하다. 이것만으로 step을 바꾸지 않는다. X01 전 세 문서 노드에만 적용하며 후행 REUSE는 이 사건을 사용하지 않는다. |
| plan_confirmation | actor, task_id, plan_version, candidate_fingerprint, requirements_version, evidence_id, plan_hash, reason_id, prior_reuse, reuse_steps, exempt_steps | 현재 WAITING_HUMAN X01의 배정 mock human approve 제출이 먼저 필요하다. actor/task/version/evidence는 제출과 동일하며 source 후보/요구사항/context가 현재여야 한다. prior_reuse는 {step_id,evidence_id} 배열이며 실제 선행 P03~P05 SKIPPED 전부와 정확히 일치한다. reuse_steps는 {step_id,baseline_hash,baseline_input_hash,current_input_hash,reason_id} 배열이며 선행 SKIPPED와 선택한 P06~P12만 선언한다. 선행 항목은 local 확인 내용과 모두 같고, 후행 항목의 current_input_hash는 context.input_hashes[step]와 같아야 한다. baseline/input이 다를 때에도 이 항목별 X01 human 확인이 명시적 재사용 근거다. 이미 SUCCEEDED인 선행 단계를 skip으로 선언할 수 없다. exempt_steps는 POLICY/COUPLED ID 목록이며 P15/P16,P17/P18,P19/P20,P22/P24 쌍이 함께 있어야 한다(P21은 독립). 기본 pilot 및 NEW_HW의 면제 불가. 같은 plan_hash/version에 다른 scope 금지. X01은 별도 SUCCEEDED 사건으로만 진행하며 확정 증거가 없으면 진행 불가. 인프라 재시도는 동일 불변 scope를 새 task/evidence로 다시 확인해야 한다. |
| unchanged_analysis | actor, plan_version, candidate_fingerprint, requirements_version, baseline_hash, current_hash, needs_changes, requirements_satisfied, evidence_id | P11/P12 PENDING에서 각각 mock:code-dev/mock:tc만 해당 분야 분석을 남긴다. boolean needs_changes/requirements_satisfied 필수. 재사용·NO_CHANGE에는 needs_changes=false, requirements_satisfied=true, baseline_hash=current_hash=현재 context의 source_hash(P11)/test_hash(P12)가 필요하다. 분석 자체는 step 성공/생략이 아니다. |
| skip | evidence_id | 현재 PENDING만. P03~P05 REUSE는 해당 현재 reuse_confirmation ID를, P06~P12는 항목별 baseline/입력/사유를 포함한 현재 X01 plan_confirmation ID를 소비하고 PENDING→SKIPPED 뒤 원본 on_pass로 이동한다. P11/P12는 해당 code-dev/tc 변경불필요 분석도 별도로 요구한다. POLICY/COUPLED는 현재 승인 plan evidence_id를 소비하고 scope/rule/profile/후보/요구사항을 재확인한다. COUPLED는 짝 수행 단계가 같은 승인으로 SKIPPED여야 하며, 수행 단계가 생략되면 그 gate를 일반 RUNNING/PASS로 위장하지 못한다. P24에는 P23 보고도 필수. 모든 skip에 actor/reason/baseline/profile/plan/cycle/attempt/execution 및 근거를 남긴다. |
| exemption_report | actor, plan_version, candidate_fingerprint, requirements_version, exemption_evidence_id, performed, report_id, evidence_id | RUNNING P23의 mock:sqe만 가능. P22가 같은 승인으로 SKIPPED이고 P24 공동 면제 승인, performed=false가 필요하다. 시험 미실행 및 면제 승인 근거를 기록한다. 이 보고 없이는 P23 일반 성공/agent 완료로 gate를 해제할 수 없다. |
| no_change | actor, task_id, plan_version, candidate_fingerprint, requirements_version, reason_id, evidence_id, production_evidence_id, tests_evidence_id, reuse_evidence_id | 현재 P12 PENDING에서 별도 mock:human 종료 확인; task_id=mock:no-change:P12:c<cycle>:a<attempt>. P11 SKIPPED 및 현재 code-dev 분석, P12 tc 분석·X01의 해당 REUSE 승인 항목, 현재 X01 계획/동일 입력·후보가 모두 필요하다. 두 분야 모두 변경불필요/요구 충족이어야 하며 NEW_HW/강제 재검증 구간에서는 불가. 모든 P13 이후 단계 PENDING, 명세·승인·영수증 없음/발행0 확인 후 P12를 SKIPPED, job NO_CHANGE로 확정한다. X01 승인이나 일반 재사용 확인으로 자동 종료하지 않는다. 이후 모든 관측 사건을 거절해 빈 commit·가짜 release·후속 진행을 만들지 않는다. |

모든 표의 필드는 필수다. null은 pilot의 policy_rule_id/policy_approval_id 두 필드에서만 허용하고 나머지는 생략/null을 거절한다. 식별자·해시 토큰은 기존 mockId 규칙(`mock:` prefix, 전체 1~128자, `[A-Za-z0-9:._/-]`, safeText 처리 전후 동일)을 사용하며 input_hashes의 각 값도 같다. actor/task는 표의 고정 값과 완전히 일치해야 한다. 배열의 중복·알 수 없는 ID 및 객체의 추가 필드는 거절한다.

P11/P12는 X01의 항목별 REUSE 승인 이후 unchanged_analysis→skip 순서이며, NO_CHANGE 경로에서는 P12 분석 뒤 skip 대신 no_change를 사용한다. no_change.reuse_evidence_id는 P12를 포함하는 현재 plan_confirmation evidence_id다. 각 분석/확인/계획 확인/면제 보고/종료 확인의 새 evidence_id는 현재 및 과거 routing 증거와 중복될 수 없다. skip·prior_reuse·exemption_evidence_id·no_change의 세 참조 필드는 기존 증거를 정확히 참조하는 용도이며 새 증거를 생성하지 않는다. 서로 다른 역할의 생산/TC 분석, 전역 계획 확인 및 종료 확인은 각각 다른 ID다. artifact/baseline/profile/policy 참조 토큰의 재사용과 새로운 작업 증거의 ID 재사용을 구분한다.

NEW_HW는 P10 동일 검증 환경 재사용만 허용한다. P10 baseline_hash=현재 environment_hash=baseline_environment_hash 및 입력 동일을 요구하며 사람 확인으로 다른 환경을 허용하지 않는다. NEW_HW의 문서/코드/TC 생략은 불가하다. FEATURE/BUGFIX도 NEVER를 생략하지 못한다. 업무 복귀 후 required_revalidation에 든 노드는 이전/신규 plan이나 baseline으로도 skip/NO_CHANGE 불가하며 현재 cycle의 실제 재검토를 요구한다.

required_revalidation은 이벤트 payload로 받지 않는다. 기존 business_failure/route가 원본 workflow의 target에서 on_pass를 END 직전까지 따라 결정적으로 계산한 결과다. 고정 범위는 다음과 같으며 소비되지 않고 해당 cycle 내내 강제 재검증 목록으로 유지한다.

- P13/P14/P18/P20/P21 business_fail 및 X03.reject_code→P11: P11,P12,P13,P14,P15,P16,P17,P18,P19,P20,P21,P22,P23,P24,X02,X03,P25,P26.
- P16/P24 business_fail, P21.design_change_needed, X03.reject_design→P07: P07,P08,P09,P10 및 위 P11부터의 전체 suffix.
- X01.rejected→P02: P02,P03,P04,P05,X01,P06 및 위 P07부터의 전체 suffix.
- X03.reject_release_metadata→X02: 기존 같은 cycle의 metadata-only 예외대로 X02,X03,P25,P26. 이전 품질 처분은 같은 cycle에서만 보존한다.
- P22 시험 실패는 직접 복귀시키지 않는다. P23에 증거를 보고한 뒤 P24 FAIL→P07이며, 그 이후 사람 설계 재검토·실패 gate·수행/판정 쌍을 포함한 위 suffix의 skip/NO_CHANGE를 모두 금지한다. 이전/새 context 또는 사람 확인으로 이 집합을 줄일 수 없다.

현재 human 단계와 P03 질문 답변의 plan_version은 route_context가 있으면 그 제안 버전에, 없으면 기존 mock:plan:v1에 결속한다. 요구사항이 X01 전에 바뀌어 선행 재사용의 가정이 달라지면 기존 확인을 확정할 수 없으며 X01 반려 후 새 cycle 계획이 필요하다. P13의 정상 후보 변경은 이후의 기존 후보용 skip/NO_CHANGE/EXEMPT 허가를 무효화하지만 정상 수행을 막거나 숨은 복귀를 만들지 않는다. 이 경우 후속 품질/단말을 모두 실제 모의 수행해 새 후보의 완전한 PASS를 모으고 새 digest의 X03 확인을 받아 진행할 수 있다. 이전 EXEMPT를 새 후보 PASS로 승격하지 않는다. X01의 old attempt 승인은 새 attempt의 plan_confirmation을 해제하지 못한다.

품질 처분 검사는 gate별로 (a) 기존 완전한 현재 PASS 또는 (b) 현재 SKIPPED/EXEMPT와 같은 계획·후보·규칙·cycle의 수행/gate 공동 면제 및 P23 근거를 확인한다. manifest의 gate_evidence_ids뿐 아니라 gate_dispositions도 결속하고, EXEMPT를 PASS로 바꿔 재사용할 수 없다. 실제 발행 허용과 재할당 허용은 계속 false다.

## 단계별 검증과 수용

| 단계 | 목적·대상·방법 | 담당·합격 기준·예상 결과 | 증거·실패 복구 |
|---|---|---|---|
| R0 | 원본 노드/승인/상태 및 네 모의 정책 결정·schema 검토 | 독립 reviewer, 필요시 senior 설계 검토. 구현 전 승인, 원본과 mock 선택의 경계·미정 사항 명시 | 계획/review SHA와 설계 검토 기록. 불일치 시 계획 수정부터 재검토 |
| R1 | TC 고정 oracle로 정상: 모든 REUSE, NEW_HW P10, demo 4쌍+P21 면제 및 P23 보고→4 EXEMPT 포함 manifest/승인/영수증/완료, P11/P12 양쪽 분석과 human NO_CHANGE | TC 작성·실행. 원본 전이/경로 정확, SKIPPED/EXEMPT/PASS 구분, 원 후보/계획/증거 불변, 실제 side effect0 | 전용 test와 상태 snapshot·로그 SHA. 첫 잘못된 사건으로 복귀해 관련 정상/부정 전체 재검증 |
| R2 | 예외·경계: 미승인/누락/다른 baseline·입력·프로파일·버전·후보·cycle/attempt/execution, X01 선행증거 누락/추가/교체, 인프라 재시도 old 확인, NEW_HW 문서 skip/다른 환경, pilot 면제/한쪽 면제/P23 누락·가짜시험, business loop 우회, 생산/TC 한쪽 변경 필요, human 없는 no-change·종료 후 사건, 중복·과거순번·변조 payload | TC. 무근거 skip/잘못된 성공/현재 gate 해제/실제 AT 완료0, 거절 상태 불변, pair·source/hash 경계 고정 oracle 100% 분류 | 부정 시험·실패 재현 기록. 구현/TC/원본 원인 구분 후 R0/R1/R2 재수행 |
| R3 | 공통 guard/manifest에 영향: 전체 npm test, npm run build, npm run ifpmic:plugin:build 및 검증 전후 source hash 고정 | TC 실행, code-dev 통합. test 실패/skip0, 3명령 exit0, 원본/기존32 fixture bytes 불변 | routing gate/각 로그/source·build/plugin SHA. 검증 중 소스 변경 시 후보 수용 금지; 수정 후 전체 영향 시험 재수행 |
| R4 | 독립 소스/TC/고정 후보 증거 감사 | 구현자와 다른 reviewer의 수용 필수, main 최종 hash/변경 검토 | review/progress/decisions/commit. 증거 없이 완료 처리하지 않음 |

이번 증분은 새 catalog/React/CSS/plugin UI를 추가하지 않는다. 새로운 상태를 화면에서 지원한다고 표시하지 않으며, 신규 routing catalog/UI 증분에서 standalone/native host·375/1440px·전체 UI 회귀를 필수 수행한다. 이번 R3에서 browser를 실행하지 않는 기술적 근거는 기존 32개 fixture가 새 routing 사건을 쓰지 않고 화면 소스가 바뀌지 않기 때문이다. 잔여 위험은 새 SKIPPED/EXEMPT/NO_CHANGE 패널·탐색/초기화·manifest 처분 표시이며 후속 및 전체 V2 gate에서는 생략하지 않는다.

이 증분은 부분 V2이다. 실제 B01/AT-04/30 실행, 수동 장비/P22 trial/child-agent/pause-resume-cancel/전체 V2 및 B01~B13·실환경 인수 검증은 계속 남는다.
