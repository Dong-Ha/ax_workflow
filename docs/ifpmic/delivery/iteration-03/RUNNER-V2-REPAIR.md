# v2 실행기 연결과 두 검증 결함 복구

B03 H2 / REQ-02·13·14 / RAW-RUNNER·RAW-LIVE / FULL-EXECUTE·AUDIT에 연결한다. 독립·TC v2 작성 검토에서 요구한 두 실행기 결함만 수정하고 정확한 v2 경로/해시/리뷰를 연결한다. 기존490 ID·25+5 의무·case/phase/outer16220초·원본/개인정보 경계는 유지한다.

| 단계 | 검증 목적 | 대상 | 방법 | 담당 Agent | 합격 기준 | 예상 결과·증빙 | 실패 복구·재검증 |
|---|---|---|---|---|---|---|---|
| VR-PLAN | 수정·시험 범위가 기존 의무를 보존하는지 확인 | 본 계획·두 exact 작성 검토 | 구현 전에 독립 정적 검토 | Code-dev 작성 / 독립 reviewer | 두 결함·v2 binding 외 제품 변경0, 원래 시간·인가·증빙 조건 완화0 | exact 계획 SHA·검토 | 지적 수정·재검토 후 구현 |
| VR-SOURCE | 실제 watchdog 형식 호환과 실행 중 runner 변경 거절 | full runner·새 stdlib TC 파일 | 알려진5 kind만 total 부재 시 검증된 finish-start 사용. 명시된 total은 항상 원래 숫자/유한/일치/예산 검사. 알려지지 않은 kind 거절. 공개 proposal 직전 고정 runner 파일 자체 SHA 재검증. v2 경로/해시/paired 작성 리뷰만 연결 | Code-dev 구현 / TC 시험 작성 / 독립 source reviewer | 기존 모든 body/cleanup/timeout/event/node/kind 검사 유지. 다른 kind의 total 누락 및 명시적 null/bool/NaN/불일치 거절. runner 변경·삭제·symlink를 공개 전에 거절. ledger/contract/producer는 변경0 | exact runner/TC source pins·AST 차이·독립 source 검토 | 실행 차단 유지·수정·새 exact source 검토 |
| VR-UNIT | 정상·오류·경계·회귀를 실제 소스 형식으로 검증 | 기존119 unit과 새 pure-stdlib watchdog/self-SHA 회귀 | source 승인 후 별도 private0700/0600, /usr/bin/python3 -S -B -X pycache_prefix=<fresh> -m unittest discover -s tests/ifpmic_evidence -v; timeout60. 실제5 producer AST dictionary와 ledger의40 literal IDs로 합성 기록 구성; product/SDK/pytest import·SQL/service/main 실행 금지 | TC 작성 / Code-dev 실행 / 독립 결과 reviewer | 기존119 유지+새 ID 전건pass, skip0. 모든5 schema/40 node 바인딩과25+5/215+25 예산, 정확 경계/초과/순서/비유한/timeout/wrong-node/unknown-kind/명시 total 오류 거절; runner 보존/변조/삭제/symlink 검사. source/cache/protected/env before-after 불변 | 실제 unit IDs/log/timeout·source/cache/보존 manifest·정제 요약·독립 결과 검토 | 실패 attempt 보존·원인 단계 복귀·정확 소스 재검토 후 전체 합성 회귀 재실행 |
| VR-FULL | 단위 통과를 실제 실행 인수로 오해하지 않도록 보장 | 정확한 전체 runner와 기존 v2 후보 | 별도 전체 source 검토 및 paired approve_execution pre-gates 후에만 fresh490/실제 SQL·history·인가·정리·환경 감사 | Code-dev / TC / 독립 실제 결과 reviewer | 기존 full490·25+5·raw87·953규칙 전건 의무 및 독립 실제 결과 인수 | private 원본 증거·정제 결과·정확한 source/paired pre-gates | 실패 증빙과 소유 자원 정리 보존·원인 수정/재검토 후 fresh 전체 재검증 |

## 좁은 변경과 생략 근거

- 새 TC는 `tests/ifpmic_evidence/test_runner_v2_repairs.py`에 작성한다. 기존6 TC 파일·103 code ledger pins와 machine38 pins를 바꾸지 않는다. 새 TC/실행기와 테스트가 읽는5 producer/ledger는 별도 정확한 단위 source review에서 pin한다. 이 파일은 실제 full runner 런타임 import 의존성이 아니다.
- runner는 hash cycle 방지를 위해 ledger에 넣지 않고 source/pre-gate에서 고정한다. 초기 및 공개 직전의 고정 repository 파일을 nonsymlink regular file로 검사한다. 제품 sources·producer·현재 v2 계약/ledger·기존 리뷰는 수정하지 않는다.
- 단위 단계에서 UI/build/browser는 제품 변경이 없어 생략한다. 실제 접수 화면 연결의 browser 회귀, 실제490·자원·환경·원래 AT32 및 최종 인수 위험은 그대로 남는다.
- 원래119 source 승인과 과거407 실제 통과는 새 runner 바이트의 승인/증명이 아니다. 단위 exact source 승인은 stdlib-only 함수/합성 범위에 한정되며 전체 main 실행 권한을 부여하지 않는다.
- 전체 full runner source·paired pre-gate·실제 결과 인수가 끝나기 전에는 실제 SDK/SQL/service/fullmain과 접수 UI를 완료로 처리하지 않는다. 검증 실패를 성공으로 변환하지 않는다.
