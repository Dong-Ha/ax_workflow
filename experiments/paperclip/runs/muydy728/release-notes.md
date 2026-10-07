# 에이전트 모니터링 대시보드 릴리스 노트

현재 단계: approval. 현재 시스템 검증 후보의 출시를 승인한다. 이번 단계는 산출물 검토와 승인 기록만 수행했으며 테스트 재실행, 패키징 또는 로컬 배포를 수행하지 않았다.

## 수용 범위

- 이름, ID, 원본 역할과 한국어 표시 역할 검색을 상태 조건과 AND로 결합한다.
- 상태는 all/전체, inProgress/진행 중, completed/턴 완료, failed/실패, interrupted/중단, unknown/상태 미확인이다. unknown을 대기로 추정하지 않는다.
- 일치 후손과 실제 비일치 조상의 맥락 카드, 전체 스냅샷 기준 일치/전체 수와 상태 집계, 초기화와 결과 없음·빈 세션 구분을 유지한다.
- 필터에 숨겨진 유효한 선택 상세는 유지한다. 공급자·세션 변경 시 필터와 이전 선택·상세·활동을 지우고 선택 안내를 표시하며 자동 선택하지 않는다. 선택 삭제 시 이전 상세를 제거하고 이용 불가 안내를 표시한다.
- 같은 세션 갱신, 늦은 응답 차단, 이전 턴 결과 제거, 활동 페이지와 집계 분리, 키보드·접근성·좁은 화면 및 F01–F09/P01–P06을 유지한다.
- improvement-request.md의 큰 트리 범위를 포함한다. 체인과 넓은 트리 각각 100·1,000·3,000개에서 카드 누락이나 임의 상한 없이 실제 부모 관계·접근 가능한 깊이 표현·조상 맥락·검색·상태·선택·상세·초기화와 기존 사용성을 보존한다. 서버·어댑터·인증·API 동작은 변경 대상이 아니다.

## 검토 입력과 현재 증거

requirements-amendment.md, requirements.md, prototype.md, design.md, development-plan.md, development-rules.md, test-plan.md, test-cases.md, improvement-request.md, implementation.md와 fix.md를 검토했다. smoke.md/json, acceptance.md/json, system.md/json, filter-verification.json, topology-verification.json, fix-validation.json, agent-filter-browser-results.json, 수정 후 안전 요약, operator-review-AXM-27.md/json 및 verified-AXM-23부터 verified-AXM-28까지의 기록을 검토했다. test-environment.md, deployment-plan.md, 기존 release-plan.md·release-checklist.md·approval.json·release-notes.md도 검토했다.

현재 시스템 실행은 8042c6a9-eb45-4e14-868c-fce89865729c이다. system.json과 verified-AXM-28.json의 실행 및 이슈 연결이 일치한다. 독립 컨트롤러는 전체 npm test, npm run build, 필터 브라우저, 고정 그래프 및 대형 트리 검증을 모두 pass로 기록하며 현재 시스템 findings는 비어 있다. 필수 단위·브라우저 검증은 여섯 상태 키와 정확한 문구, 공급자·세션 각각의 초기화·이전 상세 제거·선택 안내, 선택 삭제의 이용 불가 상태를 유지하는 계약으로 검토했다.

정식 브라우저 결과는 23개 시나리오 모두 pass다. 지정된 verdict/screenshotSaved/results(name/verdict/finding) 구조, 비어 있지 않은 안전 요약, screenshotSaved:true와 기존 agent-filter-smoke.png의 PNG 서명을 확인했다. 검토한 QA findings는 안전 문자열 또는 허용된 title/summary 객체 형식이다.

topology-verification.json은 체인·넓은 트리 각각 100·1,000·3,000개 여섯 사례 전부 pass다. 최초 카드 수는 각 전체 크기와 같고, 체인의 조상 맥락 수는 크기−1이며 넓은 트리의 맥락 수는 1이다. 선택 안내와 상세 검증이 통과했고 페이지 오류·예상 밖 요청은 0이다. 현재 검증기 해시는 운영 검토의 검토된 검증기 해시와 일치한다. filter-verification.json의 고정 시드 합성 그래프 500개 비교는 불일치 0이며 세 체인 크기의 전체 일치 계산도 포함한다.

## 문서 충돌과 이전 실패 처리

이전 요구사항·프로토타입·설계·개발·테스트 문서와 초기 구현 보고의 다섯 상태, 대기/완료 표현은 읽기 전용 requirements-amendment.md와 현재 여섯 상태 계약을 적용한다. 기본 선택 허용 설명은 새 범위 선택 안내 및 자동 선택 금지 계약으로 정정해 판정한다. 보호된 문서는 수정하지 않고 나머지 F01–F09/P01–P06과 대형 트리 범위를 축소하지 않는다.

verified-AXM-24/26.json의 이전 대형 트리 실패와 운영 검토의 취소 기록은 보존한다. 운영 검토는 수천 카드에서 전역 accessible-role 초기화 로케이터가 클릭 전에 시간 초과한 문제를 기록한다. 필터 패널 안의 정확한 이름 로케이터로 범위를 제한한 검증기는 11초 제한, 여섯 사례, 카드·맥락·초기화 검사와 기대값을 유지한다. 진단 자체를 최종 통과로 간주하지 않으며 후속 verified-AXM-28.json과 정식 여섯 사례 통과를 승인 근거로 사용한다.

fix.md와 system.md/json의 샌드박스 전체 테스트·브라우저·신규 스크린샷 미검증은 자체 실행의 제약 기록이다. 이를 통과로 바꾸지 않고 독립 컨트롤러의 현재 실행 통과와 구별한다. 이번 승인 단계에서 신규 테스트나 스크린샷을 생성했다고 주장하지 않는다.

기존 승인·릴리스 문서는 이전 시스템 실행과 현재 workspace에 없는 verified-AXM-19/20.json 등을 참조한다. 해당 참조는 이번 승인 근거로 사용하지 않는다. deployment-plan.md의 과거 BLOCKED 판정도 당시 기록으로 보존한다. 보호된 release-plan.md와 release-checklist.md는 현재 승인 연결 및 대형 트리 후속 범위를 반영하는 후속 출시 검토가 필요하다.

## 운영 인계

승인은 현재 검증 후보에 한정한다. 후보 변경 시 개발 수정 → QA 동일 사례와 영향 범위 재검증 → 제품·QA 검토 → 재승인을 진행한다. 후속 출시 단계는 deployment-plan.md를 읽고 허용된 release-plan.md를 작성하며 deployment-plan.md를 보존한다. 실행 전에 승인 후보·패키지 체크섬 연결과 이전 검증 패키지의 복구 가능 여부를 확보하고 관찰·롤백 기준을 적용한다. 배포·복구 대상 확보·출시 관찰 완료는 이번 승인에 포함되지 않는다.

이번 단계는 approval.json과 release-notes.md만 변경했다. 코드와 이전 보호 산출물을 보존했으며 네트워크 요청, 설치, Paperclip 호출, 커밋 또는 push를 수행하지 않았다.
