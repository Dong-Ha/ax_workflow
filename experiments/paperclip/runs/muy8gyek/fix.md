# Native select 키보드 결함 수정

현재 단계: fix. 구현 수정 완료, 검증 게이트는 미통과이며 QA 재검증이 필요하다.

requirements-amendment.md, requirements.md, prototype.md, design.md, test-plan.md와 기존 QA JSON 및 operator-review-AXM-11.md를 검토했다. 기존 문서의 대기 분류 및 다섯 옵션 제안은 보완 문서와 현재 제품 계약의 여섯 상태 옵션으로 대체된다. unknown은 상태 미확인이며 대기로 추정하지 않는다. 새 공급자·세션의 자동 선택 없이 선택 안내를 표시하는 계약을 유지한다.

원인은 상태 select의 사용자 정의 onKeyDown이 Enter 기본 동작을 차단한 것이다. 독립 운영 검토는 이전 입력 순서의 실패를 AX 코드 없는 native HTML에서도 재현했으며, 현재 테스트는 Space로 팝업을 열고 Home/ArrowDown/Enter/Tab을 실행한다. src/App.tsx에서 Enter preventDefault 처리와 해당 주석을 제거하여 팝업 열기·선택 확정을 브라우저 표준 동작에 맡겼다. 명시적 접근성 이름과 onChange 필터 갱신은 유지했다.

테스트 파일과 기대값, 서버·어댑터를 변경하지 않았다. 이전 단계 명세, QA 보고, 승인, 출시, 운영 검토, verified 보고를 보존했다. 기존 브라우저 보고와 스크린샷을 덮어쓰지 않도록 별도 증거 경로만 연결한 실행 hook을 사용했으며 테스트 로직은 수정하지 않았다.

검증 결과:

- npm run build: 통과.
- 에이전트 필터 단위 검증: 24개 모두 통과.
- npm test: 실패. 전체 회귀 진단은 46개 중 43개 통과했으며, 네트워크/Paperclip 실행을 금지하는 격리 가드가 나머지 3개를 차단했다. 테스트를 제외하거나 기대값을 완화하지 않았다.
- 기존 오프라인 브라우저 테스트: 샌드박스의 Chromium 시작 거부로 미검증. 새 스크린샷을 저장하지 못했다.
- 보호 산출물·테스트·서버 파일 해시 보존 확인: 통과.

상세 요약은 fix-validation.json과 fix-native-select-3igdr1nu/의 현재 단계 증거에 기록했다. npm test와 빌드의 동시 통과 요구는 충족하지 못했으므로 통과·출시 승인을 주장하지 않는다. QA는 현재 테스트의 모든 단언을 유지한 채 키보드 및 전체 수용 시나리오를 독립 재검증해야 한다. 네트워크, Paperclip, 배포, 커밋, push는 수행하지 않았다.
