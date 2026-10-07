# Accepted feature improvement

Parent workflow: muy8gyek
Parent case: 1cb435b9-b305-4fa6-834c-86d0d9d4bc22

합성 그래프 검증에서 3000개 모두 일치하는 연결 목록의 필터 계산 중앙값이 약 544ms였습니다. src/agent-filter.mjs의 반복 조상 순회를 줄여 선형 규모로 개선하세요. 기존 matched/visible/context 집합, 상태 집계, 순환·중복·누락 부모 처리와 모든 기능을 보존하고 테스트 기대값은 바꾸지 마세요. 시스템과 인수 QA는 고정된 500개 그래프 비교 및 기존 테스트·빌드·브라우저 검증을 모두 수행합니다.

Preserve all accepted functional and privacy behavior. Development edits product source only. QA independently verifies the existing tests, build, browser scenarios and deterministic graph comparisons.
