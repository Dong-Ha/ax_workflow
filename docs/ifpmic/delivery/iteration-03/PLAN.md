# 주기03 — 실행 엔진 접수와 실제 상태 표시

목표는 주기02에서 API로 저장한 작업을 검증된 workspace/dispatcher/Temporal/worker 경계에 연결하여 실제 run·접수 receipt·조회 상태를 화면에서 확인하는 것이다. H2의 `QUEUED` projection은 업무 단계(P01 등) 완료가 아니다. 화면은 실행 엔진 접수와 업무 단계 시작을 구분한다. Paperclip은 기존 IFPMIC 업무를 감독하는 상위 계층이며 원본 역할·승인·AT32를 유지한다.

## 먼저 해결할 검증 의존성

현재 full H2 후보는 실행할 수 없다. 과거407건은 당시 소스의 증빙이며 현재490건을 증명하지 않는다. 현재 raw-evidence 계약87개(83 additions +4 retained SQL/auth fences)는 설명형 파일명/조건을 포함하고 runner는 전체 파일에서 해시·카운트를 모으므로, 특정 케이스의 누락을 다른 케이스의 자료로 가릴 수 있다. 기존 full plan25개 의무·5 fixture prerequisite·490 literal IDs·모든 예외/회귀를 그대로 유지한다.

첫 구현은 stdlib 기반의 **케이스별 원본 증빙 검사기**다. 실제 파일의 node ID, owner snapshot 원문과 canonical digest, query operation/result, 안전한 private 경로·권한과 파일 식별을 검사한다. 프로파일별 history/list/tree/process/SQL 증빙은 정확한 machine-readable 규칙으로 연결하고, 설명형 placeholder를 임의 glob으로 번역하거나 적용 불가를 임의 추정하지 않는다. raw record가 없는 digest 요약을 통과시키지 않는다. 공통 검사기 단위 검증은 합성 임시 파일만 사용하며 실제 H2 수용을 주장하지 않는다. full runner 연결과 새 계약의 paired 검토 전까지 서비스/SDK/collection 실행은 금지한다.

## 검증 단계

| 단계 | 목적 | 대상 | 방법 | 담당 Agent | 합격 기준 | 예상 결과·증빙 자료 | 실패 시 복구·재검증 |
|---|---|---|---|---|---|---|---|
| I03-PLAN | 검증과 표시 범위 고정 | 본 계획, 기존 H2 full plan·원본 API/상태 계약 | 독립 정적 검토 | Code-dev 작성, 독립 reviewer | 정상/예외/경계/회귀와 다음 단계 조건 명시, 의무 누락0 | exact SHA 계획 검토 | 실행 전에 지적 수정·동일 바이트 재검토 |
| I03-EVIDENCE | 누락·다른 케이스 자료·해시만 있는 증빙 거절 | 신규 stdlib validator,87 case mapping·생성기 | TC 단위 테스트 + 독립 소스 검토; 임시 합성 raw 파일 사용 | Code-dev 구현, TC 테스트 작성, 독립 reviewer | node/operation/원문/digest/path 불일치 fail closed; 설명형 미확정 규칙으로 runtime 승인0 | 합성 정상·변조·누락·교차 node·경로/권한 테스트 결과, reviewed source pins | 실패 자료 유지, checker/규칙 원인 수정 후 전체 checker 단위 회귀 |
| I03-FREEZE | 현재 소스와 필수 시험 고정 | 전체 closure/490 ledger/실행 계약/runner | AST·정적 inventory, 기존 승인 archive, TC+독립 검토·별도 pre-gate | Code-dev 통합, TC inventory, 독립 reviewer | 407+83=490/25+5 유지;87 원본 검사 대응; exact pins·bounded lifecycle/phase cap 일치 | 새 source/ledger/계약/runner/pre-gate 리뷰 | 옛 pin 조용한 교체 금지; 수정 후보별 증빙 보존·재검토 |
| I03-H2 | 실행 경계 실제 입증 | H2 전체와 영향받는 G1–G5/H1 | 승인된 fresh490, 실제 private SQL/history/process/timing 검사 | TC 테스트, Code-dev 실행, 독립 결과 reviewer | 전건 통과·skip0·원본 증빙·정리/환경 불변성; 실패하면 H2 미수용 | private raw archive와 정제 결과, exact case IDs/해시·독립 검토 | owned process만 종료·실패 attempt 보존; 원인 단계로 복귀·새 후보 full 재검증 |
| I03-CONNECT | 등록 작업과 실제 run 연결 | 별도 로컬 demo API/workspace/Temporal/dispatcher/worker 및 UI | 구체 연동/TC 기준과 독립 source review를 먼저 작성한 뒤 한 작업의 실제 전이 확인 | Code-dev, TC, 독립 reviewer | API job/run/receipt ID 일치; DRAFT→실제 QUEUED를 정직하게 표시; 모의 P01 생성0 | API/SQL/run/history/화면 증빙, 기존 생성 key/receipt 유지 | 실제 원인 분석·정상/해당 오류 재실행; job/receipt 임의 reset0 |
| I03-REGRESSION | 원래 자료와 제공 화면 보존 | AX96/89·설계17/upload2·env1777/3072, I01/I02 | exact 비교·빌드·관련 browser/API 회귀 | TC/Code-dev | 원본 변경0·영향 회귀 실패0·무단 외부 전송0 | private raw·공개 카운트/해시 | 변경 영향 확대 시 범위 확대·재검증 |
| I03-REVIEW | 실제로 보인 범위만 수용 | 모든 위 증빙과 UI·요구사항 | 독립 결과 대조 및 local URL/screenshot 확인 | 독립 reviewer | 검증 증거 없는 완료0; H3–H7·business단계·AT16/21/32 전체 수용과 혼동0 | 화면·결과·제한·다음 한 가지·commit/push | 불충분 항목 미수용으로 유지·필요 단계 재실행 |

## 시험과 영향 범위

- 정상: 각 node의 실제 raw owner/query 기록과 올바른 digest, 실제 history/list/tree/process 자료, API 저장 작업과 같은 run/receipt/QUEUED.
- 예외: 파일 누락/잘못된 JSON·digest·operation·node·권한, 다른 node 증빙 차용, hash-only 대체, 유실/크래시·인가/프로파일/lease 실패는 기존490에 따라 검증한다.
- 경계: 빈 query 결과도 원문을 보존한다. SQL/auth-only4개에 Temporal history를 꾸미지 않는다. polling은 실제 기록 수를 보존하며 정적 예상 횟수로 실행을 추정하지 않는다. symlink/hardlink/경로 탈출·중복 node·불명확한 규칙을 거절한다.
- 회귀: 공통 checker 변경은 checker 단위 전체, full runner/서비스/test closure 변경은 원래 full490 및 지정 회귀를 요구한다. UI 연결은 I01/I02 관련 검증을 추가한다. 신규 단위 검사 통과가 H2 runtime/전체 AT를 대체하지 않는다.
- 장비 조작·최종 배포·외부 제출은 이 주기에 수행하지 않는다. 그 업무와 사람 승인 의무를 삭제하지 않으며 이후 원래 단계에서 검증한다. 사내 SSO/운영 profile·실제 Agent 업무는 미수용이다.

다음 한 가지는 case별 증빙 누락을 실제로 거절하는 검사기와 그 독립 TC 증빙이다. 이것만으로 이 주기 전체를 완료하지 않는다. 실제 실행 화면을 전달할 때까지 본 주기는 진행 중이다.
