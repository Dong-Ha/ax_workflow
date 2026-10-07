# 에이전트 모니터링 대시보드 릴리스 노트

현재 단계: approval. 현재 시스템 검증 후보의 출시를 승인한다. 이번 단계는 산출물 검토와 승인 기록만 수행했으며 테스트 재실행, 패키징, 로컬 배포 및 상태 점검은 수행하지 않았다.

## 기능과 범위

- 이름, ID, 원본 역할과 한국어 표시 역할 검색을 상태 필터와 AND로 결합한다.
- 상태 키와 표시 문구는 all/전체, inProgress/진행 중, completed/턴 완료, failed/실패, interrupted/중단, unknown/상태 미확인이다. unknown을 대기로 추정하지 않는다.
- 일치 후손과 실제 비일치 조상 맥락을 유지한다. 일치/전체 수와 상태 집계는 전체 스냅샷 기준이며 초기화, 결과 없음, 빈 세션을 구별한다.
- 필터로 숨긴 유효한 선택 상세는 유지한다. 공급자·세션 변경 시 필터와 이전 선택·상세·활동을 지우고 새 세션 선택 안내를 표시하며 자동 선택하지 않는다. 선택 삭제 시 이용 불가 안내를 표시하고 이전 상세를 제거한다.
- 같은 세션 갱신, 늦은 응답 차단, 이전 턴 결과 제거, 활동 페이지와 집계 분리, 키보드·접근성·좁은 화면 계약을 유지한다.
- 선형 조상 순회 개선은 기존 집합·순서·상태 집계·순환·중복·누락 부모 처리와 입력 불변성을 보존한다. 서버·어댑터·인증·API 동작 변경은 범위 밖이다.

## 검토 및 승인 근거

requirements-amendment.md, requirements.md, prototype.md, design.md, development-plan.md, development-rules.md, test-plan.md, test-cases.md, implementation.md, fix.md, improvement-request.md, filter-verification.json, fix-validation.json, smoke.md/json, acceptance.md/json, system.md/json, operator-review-AXM-18.md/json, verified-AXM-18.json, verified-AXM-19.json과 수정 후 재검증 자료를 검토했다. test-environment.md, deployment-plan.md, release-plan.md, release-checklist.md 및 이전 approval.json/release-notes.md도 검토했다.

현재 시스템 실행은 24278a4a-f0dc-4d0e-9acd-49516c35119d이며 system.json과 verified-AXM-19.json의 실행 연결을 확인했다. 해당 컨트롤러 보고는 전체 npm test, npm run build, 브라우저 실행 및 고정 그래프 검증의 통과를 기록한다. verified-AXM-18.json은 수정 단계 통과를 기록한다. 운영 검토의 하네스 격리 결함은 단언을 유지한 수정과 후속 통과 기록으로 검토했다. 현재 시스템 findings는 비어 있다.

수정 후 필터 단위 결과는 24개 모두 통과했다. 고정 시드 500개 그래프 비교는 불일치 0개이며 추가 500개 그래프의 24,500개 조합 비교도 통과했다. agent-filter-browser-results.json은 여섯 상태 키와 정확한 문구, 공급자/세션 각각의 초기화·선택 안내, 보이는/숨긴 선택 삭제를 포함한 23개 시나리오 모두 통과를 기록한다. 지정 스키마, 안전한 finding 문자열, screenshotSaved:true 및 agent-filter-smoke.png의 PNG 파일 존재를 확인했다. 검토한 QA findings는 허용 형식이다.

## 문서 충돌과 증거의 구분

이전 요구사항·프로토타입·설계·개발 문서·테스트 계획 및 초기 구현 보고의 다섯 상태, 대기/완료 표현은 읽기 전용 requirements-amendment.md와 현재 제품 계약으로 대체한다. 기본 선택 허용 설명도 공급자·세션 변경 후 선택 안내 및 자동 선택 금지 계약으로 대체한다. F01–F09/P01–P06을 축소하지 않으며 보호된 이전 문서는 수정하지 않는다.

fix.md, 수정 후 디버그 결과와 system.md/json은 샌드박스에서 전체 테스트 및 브라우저·스크린샷을 자체 검증하지 못한 사실을 남긴다. 이 자료를 통과로 바꾸지 않는다. 승인 근거는 현재 시스템 실행에 연결된 verified-AXM-19.json의 독립 컨트롤러 통과와 정식 브라우저 결과다. 정식 스크린샷의 존재 확인은 이번 단계에서 새 스크린샷을 생성했다는 뜻이 아니다.

이전 approval.json, release-notes.md 및 release-plan.md는 현재 workspace에 없는 verified-AXM-13/14/15.json, qa-contract-review.md, agent-filter-unit-results.json 또는 이전 시스템 실행을 참조한다. 그 참조는 현재 승인 근거로 사용하지 않는다. 이번 승인 기록은 현재 존재하는 검증 산출물과 실행 연결을 사용하며 기존 release-plan.md와 다른 보호 산출물은 보존한다.

## 운영 인계

승인은 검토한 시스템 후보에 한정한다. 후보가 변경되면 개발 수정 → QA 동일 사례와 영향 범위 재검증 → 제품·QA 검토 → 재승인을 진행한다. 후속 출시 단계는 deployment-plan.md를 읽고 허용된 release-plan.md를 작성하며 deployment-plan.md를 보존한다. 배포 전 승인 후보·패키지 체크섬 연결과 이전 검증 패키지의 복구 가능 여부를 확보하고 관찰·롤백 기준을 적용한다. 기존 출시 계획의 이전 실행 참조는 현재 승인과 연결한 후 사용한다.

이번 단계는 approval.json과 release-notes.md만 변경했다. 코드·서버·테스트 및 다른 이전 산출물은 보존했다. 네트워크 요청, 설치, Paperclip 호출, 커밋 및 push는 수행하지 않았다. 패키징·배포·복구 대상 확보·출시 관찰 완료를 주장하지 않는다.
