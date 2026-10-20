# I03 원본 증빙 검사 통합 — 실행 전 검증 보완

기존 주기03 계획과 H2 full25+5 의무/490 literal IDs를 유지한다. 이번 변경은 case별 원본 검사를 각 phase 종료와 공개 결과 생성 전에 강제하는 것이다. old407·신규83·SQL/auth fence4개와 모의 fixture의 적용 범위를 축소하지 않는다.

## 통합과 시간 예산

- machine rules는 기존83 additions와 retained SQL/auth4개, 총87개의 정확한 node ID를 독립 실행 계약에 다시 묶는다. 설명형 이전 계약은 역사적 작성 근거이며 조건·파일명을 실제 소스에서 수정한 이유를 기록한다. `unresolved`가 남거나 node/phase가 다르면 실행 전에 거절한다.
- root/full runner는 global paired gate 이후에만 원본 검사기를 import/실행한다. phase 테스트·fixture 종료와 owned child 정리 확인 후, 해당 phase interpreter로 `ifpmic_h2_raw_audit.py`를 실행한다. 입력은 private0600, 결과·로그도 private다.
- history가 있는 phase는 이미 봉인된 qualified36 환경의 실제 `HistoryEvent.FromString`으로 원본 프레임을 해석한다. SQL/auth-only phase는 원래32 환경에서 Temporal을 import하지 않는다. unit의 합성 decoder를 실제 gate에 사용할 수 없다.
- 매 raw audit의 command timeout10초, 기존 owned-command timeout 시 kill/wait 최대5초와 reaper join2초다.10개 대상 phase의 최대17초씩170초 및 설정/증빙 검증 여유30초를 합해 **추가 overhead200초**를 명시한다. 기존 collection450초/other150초, test phase cap 합15420초는 그대로다. 새 전체 cap은15420+800=**16220초**다. case의25+5/215+25초나 phase별 test cap을 늘리는 변경은 아니다. full gate 실패 시 별도 기존 cleanup 의무를 따른다.
- 공개 proposal은87개 node가 실제 개별 audit에 정확히 한 번 포함되고, 모든 private audit manifest와 원본 파일 해시가 재검증된 뒤에만 만든다. raw rows/history/private경로는 공개하지 않고 규칙 해시와 카운트만 정제한다. 기존 c10 계약/407 근거/I02 toolchain 참조는 유지하며, 새 full candidate는 versioned ledger/contract와 별도 리뷰로 고정한다.

## 단계별 검증

| 단계 | 목적 | 대상 | 방법 | 담당 | 합격 기준 | 예상 결과·증빙 | 실패 복구·재검증 |
|---|---|---|---|---|---|---|---|
| RAW-PLAN | 검사/예산/소유권 변경 타당성 | 본 보완·I03 PLAN | 독립 정적 검토 | Code-dev/독립 reviewer | case/phase test cap 유지, 추가 audit200초와 한계 명시 | exact SHA 검토 | 실행 전 지적 수정·재검토 |
| RAW-UNIT | 파일/identity/history/link 적용 오류 거절 | 신규 artifact/phase-rule checker + base28 | TC 합성 stdlib 단위, 먼저 exact source 승인 | TC 작성/Code-dev 실행/독립 reviewer | 정상·빈 결과·누락·교차 node·공유 journal·잘못된 frame/decoder·digest·권한·경로 예외 검증; 원래28 유지 | private unit ID/log/source-before/after, 정제 결과 | 실패 attempt 보존·원인 수정·전체 checker 단위 재실행 |
| RAW-MAPPING | 87 node의 정확한 조건/경로 | machine rules·실제 producer | TC literal mapping + Code-dev 검토 + 독립 대조 | TC/Code-dev/독립 reviewer | unresolved0, sourcepins·phase·실제 파일명/조건 일치; worker UUID root는 실제 node marker로 선택 | source locations·corrections·검토 해시 | 잘못된 규칙 수정 후 재고정·리뷰; 존재하지 않는 파일 생성으로 회피0 |
| RAW-RUNNER | source gate 이전 실행·증빙 누락 승인 방지 | versioned contract/ledger/full runner/child | 소스/TC inventory/paired pre-gate | Code-dev/TC/독립 reviewer | 원래490 유지,10 phase bounded audit,87 정확 union, proposal 전 원본 재검사 | 새 frozen pins·리뷰·정적 기준 | 승인 전 실행0; 변경 후보별 역사 보존·재검토 |
| RAW-LIVE | 실제 원본 검증과 정리 | fresh full490 및 raw auditor | 기존 전체 검증+phase audit+최종 재확인 | TC/Code-dev/독립 결과 reviewer | 전건 pass/skip0, raw schema·history·ID·receipt·SQL oracles·자원/환경 불변성 모두 통과 | 실제 private SQL/history/process/파일 manifest와 정제 결과 | owned process만 정리·실패 증빙 보존·해당 원인 단계 복귀·fresh full 재검증 |

## 적용 한계와 필수 잔여 검증

파일 구조나 protobuf 해석이 업무 불변식 전체를 증명하지 않는다. 기존490의 실제 SQL·인가·run·복구·lease·projection oracle와 독립 결과 검토는 필수다. checker는 raw files가 quiescent인 시점에 실행하며 모든 호출의 인과 완전성이나 동시 공격자가 있는 파일 시스템을 단독 인증하지 않는다. 공유 fixture journal은 nodeid로 필터링하고, 같은 파일을 다른 node의 효과 증빙으로 무단 재사용하면 거절한다.

실제 UI/Agent/장비/배포는 이번 검사기 단위 시험에서 실행하지 않는다. API 저장 화면과 원본 AX/설계·환경은 유지한다. 영향 없는 제품 build/browser를 unit 단계에서 반복하지 않되, full H2 필수 회귀와 실제 UI 연결 단계의 관련 회귀는 생략하지 않는다. 이 보완과 합성 시험 통과로 H2/주기03/최종 Goal을 완료하지 않는다.
