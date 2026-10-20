# I03 retained SQL fence 원문 검사 보완

요구사항 연결: 기존 H2 NEG-PROJECTION-FENCES의 retained4개, RAW-UNIT/RAW-MAPPING/RAW-RUNNER 및 주기03 실행 접수 화면의 필수 선행 검증. 전체490/25+5 의무와 원래 업무 테스트를 유지한다.

현재 일반 JSON 규칙은 envelope 키의 존재만 확인한다. 내부 evidence가 비었거나 digest가 틀려도 구조 검사를 통과할 수 있다. 아직 draft와 실행 pre-gate가 차단하므로 실제 H2 수용은 없었다. 전용 `retained_fence_json` 형식으로 이 결함을 수정한다.

| 단계 | 검증 목적 | 대상 | 방법 | 담당 Agent | 합격 기준 | 예상 결과·증빙 | 실패 시 복구·재검증 |
|---|---|---|---|---|---|---|---|
| F-PLAN | 보완 범위·원문 경계 확정 | 본 계획·producer4개·기존 검사기 | 구현 전 독립 소스/계획 검토 | Code-dev 통합, 독립 reviewer | 네 literal node/case 연결, 원래 업무 oracle/시간 예산 유지 | 정확한 계획 SHA의 검토 | 지적 반영 후 재검토, 승인 전 구현/실행하지 않음 |
| F-SOURCE | 누락·교차 case·변조 거절 | 신규 stdlib fence 검사기·artifact 통합·machine4행 | TC producer 조사·독립 exact source 검토 | Code-dev 구현, TC 테스트 작성, 독립 reviewer | envelope exact키/kind/case/node/양의 정수 시간, 파일명 node해시, canonical evidence SHA 재계산; 네 case별 실제 내부 필드/SQL행 구조 확인 | 소스 pin·TC fixture/검토 | producer와 대조·수정·exact 재검토 |
| F-UNIT | 정상·예외·경계·기존 회귀 확인 | 신규 합성 fence TC + 기존65 단위 | exact source 승인 뒤 system Python -S -B unittest; timeout60s/minimal env/private 로그 | TC 작성, Code-dev 실행, 독립 결과 reviewer | 네 정상 case 통과; 빈/해시만 있는 본문·중첩 누락·틀린 타입/행 폭·case/node/kind 교차·해시 변조·시간 bool/0·파일명 오류·unknown 형식 거절; 기존65 유지; skip0 | 실제 ID/log/exit/source-before/after·정제 결과 | 실패 attempt 보존·원인 수정·소스 재승인·전체 합성 검사 재실행 |
| F-CHECKPOINT | 추적 가능성과 원본 보존 | 공개 결과·machine pin·기존 AX/설계/환경 | 정적 hash/AST/기존 승인 map 비교, 독립 결과 검토 | Code-dev·TC·독립 reviewer | 소스/원문 불변, 보호96/89·설계17/업로드2·환경1777/3072 유지 | 결과 JSON·재개 문서·commit/push | 불일치 원인 확인, 새 baseline으로 우회 금지 |

검사기는 제품/SQL/Temporal을 import하지 않는다. 실제 producer의 JSON 직렬화된 dict/list/원시 타입을 검증하며, 빈 결과가 정상인 OID principal rows는 허용한다. 모든 필드의 업무 의미를 새로 구현하는 대신 필수 내부 관측 구조/원문 존재를 검사한다. SQL 권한·run·projection·복구 의미는 원래 테스트와 전체490 및 독립 결과 검토가 증명해야 한다. 합성 fixture가 실제 SQL 결과를 대체하지 않는다.

이번 source change로 앞선65건 승인 바이트를 재사용하지 않는다. 새 검토 후 전체 합성 단위를 다시 실행한다. 영향은 검사기와 machine 초안에 한정하며 제품/UI/의존성을 바꾸지 않으므로 build/browser는 이 단위 체크포인트에서 생략한다. 잔여 위험인 실제 SDK/SQL/history/lifecycle·전체 mapping/runner는 새 버전 계약·paired pre-gate와 fresh490에서 필수 검증한다. SQL-only case에 Temporal history를 요구하지 않는다. 기존 c10 계약과 주기02 실행 경로는 보존한다.
