# 에이전트 모니터링 대시보드 릴리스 노트

현재 단계: approval. 검토 후보의 출시 승인을 기록했다. 로컬 배포·패키징·상태 점검은 수행하지 않았다.

## 제공 기능

- 이름, ID, 원본 역할, 한국어 표시 역할 검색과 상태 필터를 AND로 결합한다.
- 상태는 all/전체, inProgress/진행 중, completed/턴 완료, failed/실패, interrupted/중단, unknown/상태 미확인이다. unknown을 대기로 추정하지 않는다.
- 일치 후손과 실제 비일치 조상 맥락을 표시하고, 일치 수와 전체 스냅샷 수를 구분한다. 초기화, 결과 없음, 빈 세션 안내를 제공한다.
- 필터가 숨긴 유효한 선택 상세는 유지한다. 공급자·세션 변경은 필터와 이전 선택·상세·활동을 지우고 선택 안내를 표시하며 자동 선택하지 않는다. 선택 삭제는 이전 상세를 제거하고 이용 불가를 표시한다.
- 같은 범위 갱신, 이전 응답 차단, 이전 턴 결과 제거, 활동 페이지와 집계 분리, 키보드·접근성·좁은 화면 동작을 검증했다.

## 검토 및 검증 근거

requirements-amendment.md, requirements.md, prototype.md, design.md, development-plan.md, development-rules.md, test-plan.md, test-cases.md, implementation.md, fix.md, fix-validation.json, qa-contract-review.md, test-environment.md, deployment-plan.md와 스모크·시스템 QA, 운영 검토 및 verified 보고를 검토했다. 이전 릴리스 노트와 승인 파일은 없었다.

현재 시스템 실행 ID는 5aee8642-a516-48fc-b6a7-ad2c589077b0이다. system.json과 verified-AXM-14.json의 실행 연결을 확인했다. 컨트롤러의 독립 검증에서 전체 npm test, npm run build, 브라우저 검사가 모두 통과했고 현재 findings는 비어 있다. verified-AXM-13.json의 수정 후 스모크도 통과했다. 과거 접근성 이름과 native select 키보드 결함은 수정 후 재검증 결과로 해소된 것으로 판단한다.

agent-filter-unit-results.json과 현재 시스템 단위 요약은 24개 통과를 기록한다. agent-filter-browser-results.json은 필수 여섯 상태 키·정확한 문구, 공급자/세션 각각의 초기화와 선택 안내, 보이는/숨겨진 선택 삭제를 포함한 23개 시나리오가 모두 통과했다. 브라우저 결과의 지정 스키마, 안전한 요약, screenshotSaved=true와 agent-filter-smoke.png 존재를 확인했다. QA findings는 허용된 안전 문자열 형식을 유지한다.

시스템 단계의 보호 산출물 보존 확인과 구현·수정 보고의 서버/어댑터/API 경계 유지 기록을 검토했다. 이번 승인 단계에서도 코드와 기존 보호 산출물을 변경하지 않았다.

## 계약 충돌 및 실행 제약

기존 요구사항·프로토타입·설계·개발 문서·테스트 계획 및 초기 구현 보고에는 다섯 상태와 대기/완료 표현이 남아 있다. 이 역사적 제안은 requirements-amendment.md와 현재 제품 계약의 여섯 상태 및 정확한 문구로 대체한다. 기본 선택을 허용하던 이전 설명도 공급자·세션 변경 후 선택 안내와 자동 선택 금지 기준으로 대체한다. 보호 문서는 수정하지 않았으며 이 충돌을 출시 검토에 명시한다. 강화된 QA 계약과 현재 검증 결과를 채택하고 범위를 축소하지 않았다.

system.md 및 system-current-229b320fe7/의 샌드박스 실행은 전체 회귀와 브라우저를 자체 검증하지 못했다. 이를 통과로 바꾸지 않는다. 승인 근거는 해당 시스템 실행과 연결된 verified-AXM-14.json의 컨트롤러 독립 통과와 정식 브라우저 결과다. 이전 실패·미검증 보고는 그대로 보존한다.

## 운영 인계

approval.json의 승인은 검토 후보에 한정한다. 배포 후보가 변경되면 영향 범위 재검증과 재승인이 필요하다. 운영팀은 후속 출시 단계에서 deployment-plan.md를 읽고 release-plan.md를 작성하며 기존 deployment-plan.md를 보존한다. 배포 전 후보·패키지 체크섬 연결, 이전 검증 패키지와 복구 가능 여부를 확보하고 계획의 관찰·롤백 기준을 적용한다. 이 승인 기록은 패키지 생성, 복구 대상 확보, 로컬 배포 또는 출시 관찰 완료의 증거가 아니다.
