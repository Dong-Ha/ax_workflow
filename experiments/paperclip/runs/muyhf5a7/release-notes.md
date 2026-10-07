# 에이전트 모니터링 대시보드 릴리스 노트

현재 단계: approval. 현재 시스템 검증 후보의 후속 출시 진행을 승인한다. 산출물과 기존 테스트의 수용 범위를 검토했으며 이번 단계에서 테스트 재실행, 패키징 또는 배포를 수행하지 않았다.

## 수용 범위

- 이름·ID·원본 역할·한국어 표시 역할 검색과 상태 조건을 AND로 결합한다.
- 상태는 all/전체, inProgress/진행 중, completed/턴 완료, failed/실패, interrupted/중단, unknown/상태 미확인이다. unknown을 대기로 해석하거나 종료 기록 없이 턴 완료를 추정하지 않는다.
- 일치 후손과 실제 비일치 조상의 맥락 카드, 전체 스냅샷 기준 일치/전체 수와 상태 집계, 초기화·결과 없음·빈 세션 구분을 유지한다.
- 필터가 숨긴 유효한 선택 상세는 유지한다. 공급자·세션 변경 시 필터와 이전 선택·상세·활동을 지우고 새 세션 선택 안내를 표시하며 자동 선택하지 않는다. 선택 삭제 시 이전 상세를 제거하고 이용 불가 안내를 표시한다.
- 같은 세션 갱신, 늦은 응답 차단, 이전 턴 결과 제거, 활동 페이지와 집계 분리, 키보드·접근성·좁은 화면 및 F01–F09/P01–P06을 유지한다. 서버·어댑터·인증·API 동작과 원본 기록은 변경 대상이 아니다.
- improvement-request.md의 이전 일치 항목·다음 일치 항목 이동을 포함한다. 실제 일치 항목만 순환하고, 다음은 첫 항목·이전은 마지막 항목부터 시작한다. 버튼과 키보드로 대상에 초점과 스크롤을 이동하면서 선택·상세를 유지한다. 검색·상태·공급자·세션·초기화 변경 시 이동 순서를 초기화하고 동일 세션의 주기적 갱신에는 유지한다. 초기화 뒤에도 결과가 있으면 사용 가능하며 결과가 없으면 비활성화하거나 숨긴다. 3,000개 연쇄 트리에서도 모든 카드·실제 부모 관계·개수·개인정보 보호를 유지한다.

## 검토 입력과 통과 증거

requirements-amendment.md, requirements.md, prototype.md, design.md, development-plan.md, development-rules.md, test-plan.md, test-cases.md, improvement-request.md, implementation.md, fix.md를 검토했다. smoke·acceptance·system 보고서, fix-validation.json, filter-verification.json, topology-verification.json, navigation-verification.json, agent-filter-browser-results.json, 현재 workspace의 verified-AXM-33~36.json과 시스템 안전 요약도 검토했다. 출시 입력은 test-environment.md, deployment-plan.md, 기존 approval.json·release-notes.md·release-plan.md·release-checklist.md 및 delivery-review 보고서다.

현재 승인 근거는 시스템 실행 `0aa97225-d58e-4661-879e-c6ff41def966`, 이슈 `0e523b8c-1dd5-4345-92c4-9887e5c5f3a9`다. system.json과 verified-AXM-36.json의 연결과 최종 pass가 일치한다. 독립 컨트롤러는 전체 npm test, npm run build, 필수 브라우저, 고정 그래프, 계층 및 일치 항목 이동 검사를 모두 pass로 기록하며 현재 findings는 비어 있다.

기존 단위·브라우저 테스트를 검토해 여섯 상태 키와 정확한 표시, 공급자·세션 각각의 필터 초기화·이전 상세 제거·선택 안내, 보이는/숨긴 선택 삭제의 이용 불가 상태가 포함됨을 확인했다. 단위 검증은 guidance/unavailable 상태와 agent:null 및 이전 상세 부재를 단언하며 브라우저는 실제 안내 문구를 확인한다.

정식 브라우저 결과의 23개 시나리오는 모두 pass다. verdict/screenshotSaved/results(name/verdict/finding) 지정 스키마, 비어 있지 않은 안전 요약, screenshotSaved:true 및 기존 agent-filter-smoke.png의 PNG 서명을 확인했다. 검토한 QA findings는 안전 문자열 또는 비어 있지 않은 문자열 title/summary 필드만 가진 객체 형식이다.

topology-verification.json은 체인·넓은 트리 각각 100·1,000·3,000개의 여섯 사례 모두 pass다. 전체 카드 수 보존, 실제 조상 맥락, 선택 안내와 상세를 확인했으며 페이지 오류·예상 밖 요청은 0이다. filter-verification.json은 고정 시드 합성 그래프 500개 비교에서 불일치 0과 세 크기의 연쇄 트리 전체 일치 계산을 기록한다.

navigation-verification.json은 deep-desktop, deep-mobile, next-previous-wrap, filter-cursor-reset, scope-cursor-reset, hidden-selection-retained 여섯 사례 모두 pass다. 기존 독립 검증기의 수용 검사를 검토해 3,000개 체인의 초점·화면 내 이동, Enter/Space, 실제 일치 항목 순환, 검색·상태·초기화·공급자·세션의 이동 순서 초기화, 동일 세션 폴링 후 이동 유지, 초기화 후 사용 가능·일치 없음 사용 불가 및 숨긴 선택 상세 보존을 확인했다. 모든 사례의 실패 코드·페이지 오류·예상 밖 요청은 없다.

## 충돌과 이전 기록의 처리

보호된 초기 명세·설계·개발·테스트 문서와 implementation.md에는 다섯 상태, 대기/완료 표현, unknown 분류 제안이 남아 있다. test-plan.md의 기본 선택 허용 설명도 현재 계약과 충돌한다. 읽기 전용 requirements-amendment.md와 현재 제품 계약으로 기대값을 확정하며 다른 F01–F09/P01–P06을 축소하지 않는다. 해당 문서는 보존한다.

이전 approval.json·release-notes.md 및 release-plan.md·release-checklist.md는 현재 workspace에 없는 verified-AXM-28/29 등 과거 실행을 참조하고, 현재 improvement-request.md의 일치 항목 이동 대신 이전 대형 트리 개선을 기술한다. delivery-review는 과거 전달 결과이며 현재 후보의 배포 증거로 사용하지 않는다. 후속 출시 단계는 현재 승인 연결과 이동 범위를 release-plan.md에 반영해야 한다. deployment-plan.md의 과거 BLOCKED 기록은 당시 환경 판정으로 보존한다.

verified-AXM-34.json은 최종 fail과 checks의 pass가 충돌하며, fix.md의 자체 실행 실패와 fix-validation.json의 컨트롤러 pass도 실행 주체가 다르다. 이전 실패와 시스템 안전 요약은 보존한다. 현재 system.md/json과 verified-AXM-36.json에 남은 샌드박스 전체 회귀·브라우저·이동 미검증은 자체 실행 제약이며, 독립 컨트롤러의 현재 통과 증거와 구분한다. 자체 미실행이나 실패를 통과로 변경하거나 이번 단계에서 새 스크린샷을 생성했다고 주장하지 않는다.

## 운영 인계

승인은 현재 검증 후보에 한정한다. 후보 변경 시 개발 수정 → QA 동일 사례 및 영향 범위 재검증 → 제품·QA 검토 → 재승인으로 돌아간다. 후속 release 단계는 deployment-plan.md를 읽고 release-plan.md를 작성하며 deployment-plan.md와 이전 보호 산출물을 보존한다.

배포 전 승인 후보·패키지 체크섬 연결, 이전 검증 패키지의 복구 가능 여부와 관찰·롤백 기준을 확보한다. 출시 관찰에 기존 계약과 일치 항목 이동의 전체 수용 범위를 포함한다. 패키징·로컬 배포·관찰·복구 대상 확보는 이번 승인 단계의 완료 항목이 아니다.

이번 단계는 approval.json과 release-notes.md만 변경했다. 코드·테스트·기존 보호 산출물을 보존했으며 네트워크 요청, 설치, Paperclip 호출, 커밋 또는 push를 수행하지 않았다.
