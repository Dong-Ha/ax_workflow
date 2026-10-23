# 상태 프로토콜 및 기존 검사 목록 보존 · 보완 계획 V2

상태: 검사 배치 보완에 대한 독립 검토 대기. V1 계획·V8 후보·154 실행 원본은 변경하지 않는다. V7 실제 시도는2.156초 만에 EvidenceError로 종료했고 검사 목록 수집·실제 테스트·서비스 실행은0이다. 실패 원본과 모든 V7 후보/승인 bytes를 보존한다. 전체 H2/제품 완료는 미수용이다.

## 원인과 변경 범위

`ifpmic_h2_full_raw_adapter.validate_policy`는 raw rules의 `status == candidate_pending_exact_review`와 `unresolved == []`를 프로토콜 조건으로 검사한다. V7 생성 시 status를 버전 설명용 문자열로 바꿨다. 노드·해시·예산은 맞지만 freeze 조건이 거부된다. 이는 코드/메타데이터 경계 결함이며 현재152개의 합성 fixture 검사는 실제 후보 명세를 이 함수에 연결하지 않아 놓쳤다. 버전/수정 설명은 별도 provenance 필드에만 적는다.

1. V8 rules는 정확한 프로토콜 status를 복원한다. V7의87 cases/956 ordered artifact predicates/38 source pins와490 IDs/15 phases/원래 예산·원본 설계·환경은 유지한다. 파일명/소스 해시/이미 존재하는 line 바인딩 및 후속 C/L/review 연결만 새 V8에 갱신한다. 생산 SQL/API/worker/dispatcher/proxy와 검사기 판단 코드는 변경하지 않는다.
2. TC는 기존 확장 모듈 `tests/ifpmic_evidence/test_runner_v2_repairs.py`의 새 `CurrentCandidatePolicyTests` 클래스에 표준 라이브러리만 사용하는 명세-검사기 연결 검사 두 개를 둔다. V8에서 `test_full_runner_guards.py`에 추가했던 두 메서드는 제거하되 본래152 메서드·ID·119개 목록 보존 검사는 변경하지 않는다. 파일명 fixture는 후속 V9 rules에 연결한다. 첫 검사는 현재 runner의 실제 C/L과 verify_contract_ledger 결과를 실제 validate_policy에 넣어 수용됨을 확인한다. 둘째는 실제 rules의 status만 V7 실패 문자열로 바꾸고 실제 해시를 갱신한 private 임시 명세를 넣어 `RAW_RULES_NOT_FROZEN`으로 거부됨을 확인한다. hash 오류를 status 거부로 오인하지 않는다. main/SDK/SQL/서비스/하위 프로세스는 호출하지 않는다. 기존152 메서드 본문·ID는 그대로 유지한다.
3. 새 실행기 단위 묶음은 **154 = 기존152 + 신규2**다. 정확한 capture는 기존152 AST의 완전 보존과 신규2 ID를 구분하고, 실제 metadata 연결·원래 before/after 보존·캐시 격리를 포함하도록 검토한다. 기존152 결과를 새154 실행 증거로 대신하지 않는다. 단위 결과 수용 뒤 원래 실제490을 별도로 한 번 실행해야 한다.

## 단계별 검증 계약

| 항목 | 계획 |
|---|---|
| 목적 | 현재 후보 메타데이터가 실제 raw-policy 프로토콜과 맞는지 실행 전 확인하고 동일 결함 재발 방지 |
| 대상 | B03 H2 raw policy/동일490 회귀 기반, REQ-05 사람 경계 보존과 AT-16/29 관련 미완료 범위; 사용자 접수 화면/전체 AT 인수 아님 |
| 방법 | 정상: 실제 현재 명세 수용. 예외·경계: 올바른 해시지만 잘못된 status 거부. 회귀: 기존152 본문·ID 유지+신규2, 동일956 증거 규칙/490 인벤토리와 전체 실제 검증 |
| 담당 | Code-dev 원인/명세 연결·통합, TC 두 연결 검사 작성, 독립 검토자 계획·소스·실제 결과 검토; SAM/TEM/SQE/사람 역할 유지 |
| 합격 기준 | 검사기 변경/조건 완화 없이 V8 status 수용 및 V7 status 거부,154 정확한 실행 통과·독립 수용, 원래 실제490과 raw/정리/환경의 최종 독립 수용 |
| 예상 결과 | 잘못된 status가 SDK/서비스 시작 전 단위 연결 검사에서 드러나며, 다음 실제 검증은 원래 업무 사례까지 진행 |
| 증빙 | V7 failed gate/검토·새 계획과 승인·새 후보 해시·154 ID/AST/출력 요약·소스/환경/캐시 before/after·실제490 원시 증거는 private에 보존 |
| 실패 복구 | 최초 실패 leaf/후보 보존, 실행 중이면 같은 handle 추적·소유 자원 정리 확인, 거부된 정확한 계약 단계로 복귀해 수정·영향 범위 재검증; 자동 재시도/기준 완화 금지 |

계획 승인 뒤 TC 소스와 새 V8 후보를 작성한다. exact source/capture 승인·결과 수용·전체 source 및 paired invocation-bound 실행 전 승인을 거쳐야 한다. 이전 V7 승인을 V8 실행에 재사용하지 않는다. 검증 단계 생략은 없다. 과거 raw/status/검토 기록을 덮어쓰지 않는다.

## V8 실행에서 발견한 배치 충돌

[실제154 검사](./raw-policy-status-unit-verification.json)는153통과·1실패로 종료했다. 새 현재 metadata 수용과 잘못된 status 거부는 모두 통과했고, 원래152 중151통과·1실패다. `test_previous_119_unittest_ids_are_preserved_exactly`는 `PRIOR_UNIT_FILES` 여섯 파일의119 ID를 완전히 보존하는 조건이다. 그 여섯 파일 중 하나에 새 두 검사를 넣어121개가 됐다. 기존 `test_runner_v2_repairs.py`는 이 고정 묶음에서 제외된 확장 모듈이다. 새 두 검사를 그곳의 새 클래스에만 옮기면 원래119 보존 조건과152 AST/ID를 유지하면서154 검증을 할 수 있다. 기존 assertion을152/121/부분집합 검사로 바꾸지 않는다.

후속 후보는 V9로 분리한다. 원래 core490 ledger sourcepins110에는 확장 모듈이 포함되지 않았으며, 이를 임의로 core 런타임 범위로 바꾸지 않는다. 새 두 검사의 확장 모듈은 별도 repair/source 참조와 완전한 unit capture·whole-source import closure에 반드시 pin한다. 기존 V8 rules/승인/실패 source는 git 체크포인트와 private 증거로 보존하며 재사용 승인하지 않는다.

새154 capture는 신규2 ID의 module/class 변경을 정확히 반영한다. 기존119 비확장 모듈 집합과 기존152 메서드의 AST를 완전히 보존하고, 확장 모듈의 신규2만 추가됐음을 확인한다. 새 메타데이터 positive/negative의 구현 의미·SDK/SQL/서비스 금지·before/after/캐시/원래490/956/예산 기준은 V1과 같다. 다시 실패하면 원본 보존 후 해당 검증 계약 단계로 복귀한다. 검증 단계 생략이나 원래 보존 조건 완화는 없다.
