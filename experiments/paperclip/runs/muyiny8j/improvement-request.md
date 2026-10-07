# Accepted feature improvement

Parent workflow: muyhf5a7
Parent case: 0076c1b6-f03a-417a-b21f-14191a84cb32

검색 결과 이동 시 현재 몇 번째 항목인지 알 수 있도록 필터 영역에 위치 표시를 추가하세요. role=status, aria-label=일치 항목 이동 위치, aria-live=polite인 접근 가능한 요소에 이동 위치 k / N을 정확히 표시합니다. 이동 전과 검색·상태·초기화·공급자·세션 변경 후는 k=0이고 N은 실제 일치 개수입니다. 다음·이전 이동과 순환 후에는 화면 순서 기준 1부터 시작하는 위치를 표시하세요. 동일 세션 갱신은 유효한 현재 항목 위치를 유지하고, 항목이 더 이상 일치하지 않으면 0으로 표시하며 자동 이동하지 마세요. 결과가 없으면 이동 위치 0 / 0입니다. 기존 버튼·단축키·초점·스크롤·선택 및 상세 유지·개수·실제 부모 관계·개인정보 보호 계약과 모든 검증을 유지하세요.

Preserve all accepted functional and privacy behavior. Development edits product source only. QA independently verifies the existing tests, build, browser scenarios and deterministic graph comparisons.
