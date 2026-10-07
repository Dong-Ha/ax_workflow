# 에이전트 모니터링 대시보드 출시 노트

현재 단계: approval. 검토한 후보의 출시를 승인한다. 이전 승인 보류의 이동 위치 검증 공백은 보강된 정식 시스템 검증으로 해소되었다. 이번 단계는 문서 검토이며 테스트 재실행, 코드 수정, 패키징 또는 배포를 수행하지 않았다.

## 제품 및 후속 범위

- 이름·ID·원본 역할·한국어 표시 역할 검색과 검색/상태 AND 조건을 제공한다.
- 상태는 all/전체, inProgress/진행 중, completed/턴 완료, failed/실패, interrupted/중단, unknown/상태 미확인이다. unknown을 대기로 해석하지 않으며 종료 기록 없이 턴 완료를 추정하지 않는다.
- 일치 후손과 실제 비일치 조상의 맥락 카드, 전체 스냅샷 기준 일치/전체 및 상태 집계, 필터 초기화, 일치 없음과 빈 세션 구분을 유지한다.
- 필터가 숨긴 유효한 선택 상세는 유지한다. 공급자·세션 변경은 필터와 이전 선택·상세·활동을 지우고 선택 안내를 표시하며 자동 선택하지 않는다. 선택 삭제는 오래된 상세를 제거하고 이용 불가 안내를 표시한다.
- 같은 범위 갱신, 지연 응답 차단, 새 요청의 이전 턴 결과 제외, 활동 페이지와 집계의 독립성, 키보드·초점·좁은 화면 및 F01–F09/P01–P06을 유지한다. 서버·어댑터·인증·API·원본 기록의 변경은 허용하지 않는다.
- 이동 위치는 필터 영역의 role=status, aria-label=일치 항목 이동 위치, aria-live=polite 요소에 이동 위치 k / N으로 표시한다. N은 실제 일치 수다. 이동 전과 검색·상태·초기화·공급자·세션 변경 후 k=0이며 다음·이전·순환은 화면 순서의 1부터 시작한다. 같은 세션 갱신은 유효한 항목의 현재 위치를 유지하고, 더 이상 일치하지 않으면 0으로 표시하며 자동 이동하지 않는다. 결과 없음은 0 / 0이다. 기존 버튼·단축키·초점·스크롤·선택·상세·개수·실제 부모 관계·개인정보 계약을 유지한다.

## 검토 및 승인 근거

필수 입력 requirements-amendment.md, requirements.md, prototype.md, design.md, test-plan.md, improvement-request.md와 development-plan.md, development-rules.md, test-cases.md, implementation.md, fix.md 및 fix-validation.json을 검토했다. smoke·acceptance·system 보고서, verified-AXM-41/42/44.json, operator-review-AXM-41/43.md 및 JSON, 정식 브라우저 결과, filter/topology/navigation-verification.json과 fix-current-fcd04745e777의 검증 요약도 검토했다. 운영 입력은 test-environment.md, deployment-plan.md, 기존 승인·출시 노트, release-plan.md, release-checklist.md 및 delivery-review.md/JSON이다.

최신 system.json과 verified-AXM-44.json은 실행 df3dd65c-d6a8-4703-a9ce-50ce59e1954e, 이슈 1bb04d77-74f9-4f95-9869-7958f3e24573에 연결되며 판정과 검사 목록이 일치한다. 전체 회귀, 빌드, 정식 브라우저, 고정 그래프, 계층 및 이동 검사를 포함한 필수 검사가 모두 pass이고 findings는 비어 있다. 파일 존재나 설정 확인만으로 기능 통과를 판단하지 않았다.

정식 브라우저 결과는 지정된 verdict/screenshotSaved/results(name/verdict/finding) 스키마를 충족하며 23개 시나리오 모두 pass, screenshotSaved=true다. 기존 스크린샷의 PNG 서명과 QA findings의 안전 형식을 확인했다. 생성 단위 및 브라우저 테스트의 모든 상태 키·정확한 표시, 공급자/세션 각각의 필터·이전 상세 제거와 선택 안내, 보이는/숨긴 선택 삭제 이용 불가 사례를 확인했다.

고정 그래프 비교는 500개에서 불일치 0이다. 계층 검증은 체인·넓은 트리 각각 100·1,000·3,000개의 여섯 사례 모두 pass다. 최신 이동 검증은 데스크톱·좁은 화면, 양방향 순환, 조건·범위 초기화, 숨긴 선택 보존의 여섯 사례 모두 pass다. 위치 요소의 접근성·정확한 값·초기화와 동일 세션 위치 유지를 확인한다.

operator-review-AXM-43은 이전 승인 보류와 검증기 보강을 보존한다. 최신 이동 검증기의 next-previous-wrap 사례는 107개 검사를 수행하며, 실제 렌더링된 폴링 리비전 확인, 순서 변경 후 같은 대상의 위치 재계산, 현재 항목 이름 변경으로 검색 불일치가 된 뒤 위치 0 / 1, 남은 항목으로 자동 초점 이동 없음 및 명시적 다음 이동을 단언한다. 이 불일치 갱신은 이전 선택 상세 삭제 테스트와 별개이며 이전 정식 QA의 후속 범위 공백을 해소한다. 검증기의 현재 항목은 스냅샷에서 삭제되는 대신 검색 결과에서 제외되는 합성 사례다.

## 역사적 충돌과 제한

초기 요구사항·프로토타입·설계·개발·테스트 및 implementation.md의 다섯 상태·대기·완료 표현과 기본 선택 설명은 requirements-amendment.md 및 현재 제품 계약과 충돌한다. 현재 계약의 여섯 상태·정확한 문구·자동 선택 없는 선택 안내를 적용한다. 보호된 이전 문서를 수정하거나 F01–F09/P01–P06을 축소하지 않았다.

자체 샌드박스 실행의 회귀 실패·브라우저 시작 차단·스크린샷 미확보 이력은 그대로 보존한다. system.json과 verified-AXM-44.json의 독립 컨트롤러 최종 pass 및 정식 브라우저 결과와 구별한다. 미실행을 pass로 바꾸지 않았으며 이번 승인에서 새 실행 성공을 주장하지 않는다.

기존 release-plan.md·release-checklist.md의 과거 verified-AXM-36/37 및 실행 참조, 위치 표시 이전의 이동 범위 설명과 delivery-review의 과거 전달 결과는 현재 후보의 배포 증거가 아니다. deployment-plan.md의 환경 단계 BLOCKED도 역사적 입력으로 보존한다. 운영팀은 현재 승인과 최신 QA 연결 및 이동 위치 후속 범위를 다음 출시 계획에 반영해야 한다.

## 운영 인계

승인은 위 시스템 검증 후보에 한정한다. 후속 release 단계는 deployment-plan.md를 읽고 release-plan.md를 작성하며 deployment-plan.md를 덮어쓰지 않는다. 배포 전에 불변 후보·패키지·검증 연결, 호환성, 이전 검증 패키지와 복구 가능 여부를 확보하고 관찰 기간·시작/종료 조건을 확정한다. 이동 위치와 같은 세션 갱신·불일치 초기화까지 출시 관찰에 포함한다. 이 승인만으로 배포·관찰·롤백 완료를 표시하지 않는다.

후보가 변경되거나 결함이 발견되면 개발팀으로 반환하고 동일 사례 및 영향 범위의 QA 재검증과 재승인을 거친다. 현재 단계에서는 네트워크 요청, 설치, Paperclip 호출, 커밋 또는 push를 수행하지 않았다. 변경은 approval.json과 release-notes.md 두 파일뿐이며 기존 명세·구현·QA·승인 보존본·출시·운영 검토·컨트롤러 보고서를 유지했다.
