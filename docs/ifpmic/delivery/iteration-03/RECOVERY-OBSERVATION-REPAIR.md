# V6 실패 두 건의 관측 보완 계획

상태: 구현 전 독립 검토 대기. V6 실제 시도의 실패는 보존하며, 이 계획은 H2 통과나 제품 완료를 뜻하지 않는다.

## 원인과 영향 범위

실제 V6는 15묶음 목록 수집 뒤 dispatcher8 통과, worker4 중2통과·2실패로 종료했다. 총12건 중10통과·2실패,478건 미실행이다. CRASH10의 실제 pending 관측·복구는 통과했다. 생산 SQL/API/worker·시간 제한·장애 주입을 바꾸지 않고 TC 관측 두 곳만 수정한다.

1. CRASH11: `jobs_fixture.seed_catalog_and_eligibility`의 고정 시각 eligibility와 `normal._add_live_sql_eligibility`의 DB 시각 eligibility가 같은 project/snapshot에 함께 존재한다. 철회 SQL은 둘 다 철회했지만 관측이 `count=1`을 고정해 실제2에서 실패했다. 재시도/replay 전 단계의 실패로, receipt replay가 통과한 증거는 아니다.
2. CRASH12: 프록시 client 요청 카운터는 `_armed`인 동안만 증가하고 release 뒤에는 멈춘다. server 응답 카운터는 arm 이력이 있으면 release 뒤에도 증가한다. 따라서 release 뒤 client 카운터 증가를 요구한 새 관측이 잘못됐다. 실제 journal은 같은 run의 후속 workflow decision과 원래 proxy queued query 성공 이후 실패했음을 보여준다. release 이후 실제 forwarded event bytes는 client4930/server5398, connection2→4, armed/overflow=false였다. 전체 사례는 실패로 유지한다.

## 변경 및 합격 기준

TC는 `tests/ifpmic_api/test_h2_worker_api_crashes.py`만 수정한다.

- CRASH11: 철회 전 같은 project/snapshot의 eligibility ID 집합을 DB에서 읽고 nonempty임을 확인한다. 같은 대상 전체 철회 SQL을 유지한다. 철회 후 membership 비활성과 정확한 eligibility 집합 보존, 해당 집합 전체의 revocation 존재를 확인한다. 기대 ID 집합과 실제 철회 ID 집합은 정확히 같아야 하며 단순 `>=1`로 대체하지 않는다. 기존 artifact의 `membership_active`와 `matching_profile_revocations`를 유지하고 실제 count를 기록한다. 복구 뒤 원래 same run/receipt/SQL/history·최종 activity 완료 조건을 유지한다.
- CRASH12: proxy 구현과 카운터 의미는 바꾸지 않는다. release snapshot의 마지막 event sequence를 기준으로, 원래 queued query 뒤 snapshot에서 그보다 큰 sequence의 `forwarded` event를 검사한다. client→server와 server→client 모두 양수 bytes가 있어야 하고, 해당 connection ID가 실제 snapshot connection records에 있어야 한다. armed/overflow=false, 실제 server 전달 증가, 새 connection, 동일 run/history/receipt 및 원래 proxy query를 유지한다. armed 전용 client counter의 증가 요구만 실제 양방향 event 증거로 교체한다. sequence/overflow/connection 검사는 실패를 숨기지 않으며 실패 시 원래 cleanup을 반드시 실행한다.

## 단계별 검증

| 항목 | 계획 |
|---|---|
| 목적 | 원래 장애·권한 철회·receipt replay 계약을 유지하며 실제 관측과 잘못된 기대값의 차이를 제거 |
| 대상 | B03 H2 CRASH11/12, REQ-05 사람 단계 보존 불변 조건 및 AT-16/29 관련 부분 증거; 전체 AT 인수 아님 |
| 방법 | 정상: 원래 복구 흐름. 예외: membership/profile 철회 뒤 committed receipt replay. 경계: 여러 eligibility와 armed/released event 범위. 회귀: 원래490 ID/15phase/예산과 raw956 predicates 보존, 같은152 합성 본문 및 새 실제490 검증 |
| 담당 | Code-dev 계획·통합, TC 두 관측 구현, 독립 검토자 계획·소스·결과 검토; SAM/TEM/SQE/사람 경계 유지 |
| 합격 기준 | eligibility 기대/실제 집합 완전 일치와 전체 철회, release 이후 양방향 실제 전달, 원래 queued/receipt/history 검증 및 전체 실행·독립 수용 |
| 예상 결과 | 현재 두 관측 실패의 제거 여부를 실제 서버에서 판정; 사용자 화면 연결의 선행 H2 증거 확보 |
| 증빙 | private 원시 SQL/history/journal/JUnit·정리·환경 manifests, 공개 sanitized 요약·해시·독립 검토·커밋 |
| 실패 복구 | V6 원본 leaf 보존, 새 실패도 별도 leaf 보존·소유 자원 정리 확인, 실제 실패 단계로 복귀해 원인 및 영향 범위를 검토하고 재검증 |

계획 승인 뒤에만 TC 변경한다. 변경 후 새 후보의 contract/ledger/rules 바인딩, 합성 실행 승인·결과 수용, 전체 소스 및 paired 실행 전 검토를 각각 현재 bytes로 갱신한다. 이전 승인을 새 후보에 재사용하지 않는다. 원본953+V6추가3 artifact predicates와 원래 환경·설계는 보존한다. 합성152는 새 SDK/DB/proxy 경계의 실제 검증을 대체하지 않는다. 검증 단계 생략은 없다.
