# Accepted feature improvement

Parent workflow: muycf1mz
Parent case: 21660197-c724-4314-9684-0b350d0123b5

실제 오프라인 브라우저에서 3000개 깊이의 체인이 호출 스택 초과로 표시되지 않고 1000개 체인도 불안정했습니다. src/App.tsx의 반복 배열 복사와 재귀 렌더링·경로 복사를 제거해 큰 트리를 안전하게 표시하세요. 모든 카드, 실제 부모 관계·접근 가능한 깊이 표현, 조상 맥락, 검색·상태·선택·상세·초기화 기능과 기존 화면 사용성을 보존하세요. 카드 누락이나 임의 상한으로 우회하지 말고 테스트 기대값을 바꾸지 마세요. 체인·넓은 트리 100/1000/3000의 필수 브라우저 검증과 기존 전체 게이트를 통과해야 합니다.

Preserve all accepted functional and privacy behavior. Development edits product source only. QA independently verifies the existing tests, build, browser scenarios and deterministic graph comparisons.
