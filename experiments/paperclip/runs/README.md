# 실제 AX 실행 기록

같은 Paperclip 회사의 제품부·개발팀·테스트팀·운영팀이 실제 Codex 실행으로 아래 작업을 수행했습니다. 실행 ID와 작업별 결과는 각 폴더의 `execution.json`에 보존합니다. 작업 상태 `done`과 제품 검증 `pass`는 구분하며, 실패한 QA와 복구 전 실행도 기록에 남깁니다.

| 실행 | 과제 | 결과 근거 |
|---|---|---|
| [muy8gyek](./muy8gyek/execution.json) | 에이전트 검색·상태 필터 추가 | 요구사항부터 로컬 인수까지 진행. 실제 QA 결함 수정과 재검증을 거쳐 승인된 기능을 반영했습니다. |
| [muycf1mz](./muycf1mz/execution.json) | 긴 조상 관계에서 필터 계산 개선 | 합성 그래프 500개가 독립 기준과 일치했습니다. 3,000개 연쇄 구조의 전체 일치 계산 중앙값은 초기 543.805ms에서 2.475ms로 줄었습니다. |
| [muydy728](./muydy728/execution.json) | 대형 에이전트 트리 화면 개선 및 출시 인수 | 최종 topology 검증의 체인·넓은 트리 여섯 사례(100·1,000·3,000개)가 모두 통과했습니다. 실패·취소·복구 이력과 먼저 거절된 미연결 배달 검토를 보존했고, 실행·이슈·워크플로·소스·정적 자산 연결을 확인한 정식 복구 후 배달 검토가 수락됐습니다. |
| [muyhf5a7](./muyhf5a7/execution.json) | 검색·상태 필터와 일치 항목 navigation | 최종 제품부 배달 검토가 수락됐습니다. 여섯 navigation QA 사례가 통과했고 정적 파일 3개의 packaging-time 해시와 전달 결과가 일치했습니다. |
| [muyiny8j](./muyiny8j/execution.json) | 현재 이동 순번 표시와 navigation 동작 개선 | 보조 QA AXM-44 pass/done, 원래 승인 AXM-43 정식 복구 후 pass, release AXM-45, acceptance AXM-46, 최종 제품부 검토 AXM-47이 완료됐습니다. 위치 `k/N`, 검색·상태·범위·초기화 때 위치 재설정, 같은 범위의 유효한 갱신 중 유지가 여섯 navigation 사례에서 검증됐습니다. |

측정은 동일 환경의 합성 데이터이며 일반적인 성능 보장을 뜻하지 않습니다. [초기 계산 기준](./muy8gyek/filter-baseline.json), [개선 후 검증](./muycf1mz/filter-verification.json), [화면 관계 기준](./muycf1mz/ui-graph-baseline.json)을 함께 확인할 수 있습니다. 초기 화면의 대규모 연쇄 구조 실패는 [별도 기준 기록](./muy8gyek/topology-baseline.json)에 남겼습니다.

모델이 샌드박스 제한으로 실행하지 못한 검사는 `agentUnverifiedChecks`에 보존합니다. 최종 통과 판정은 실행기가 별도로 수행한 테스트·빌드·브라우저 검사에 따릅니다. 보고서에는 요약과 검증 식별자만 내보내며 원본 대화, 인증 자료, 원시 도구 출력은 포함하지 않습니다. 출시의 `digest`는 소스 지문입니다. 새 패키지의 정적 파일 기준은 별도의 `assetHashes`와 `assetDigest`로 기록합니다.

실제 패키지와 Paperclip 데이터베이스는 Git에서 제외된 `.paperclip-lab/`에 있습니다. 실행 방법과 복구 절차는 [실험 README](../README.md), 이미지 단계 대응은 [FLOW.md](../FLOW.md)를 확인하세요.

`muydy728`의 대형 트리 결과는 [topology-verification.json](./muydy728/topology-verification.json), 공식 인수와 제품부 배달 검토는 [acceptance.md](./muydy728/acceptance.md)와 [delivery-review.md](./muydy728/delivery-review.md)에 있습니다. 역사적 후보의 자산 해시는 포장 시점 기준이 없는 `verification-time`으로 정직하게 표시했습니다. 후속 navigation 및 packaging-time 기준선 개선은 별도 실행 [muyiny8j](./muyiny8j/execution.json)에서 수락됐습니다.

`muyhf5a7`의 최종 제품부 검토와 인수는 [delivery-review.md](./muyhf5a7/delivery-review.md)에 있습니다. 제품부 수락 뒤 별도로 실행한 런타임 guard 확인은 기록된 서버 파일 5개와 임시 패키지 변조 거부를 검증했습니다. 현재 위치 표시와 reset/poll 동작을 구현한 후속 실행 [muyiny8j](./muyiny8j/delivery-review.md)은 supplemental QA AXM-44 pass, 원래 승인 AXM-43 복구 후 pass, AXM-47 최종 제품부 수락 이력을 보존합니다. navigation position contract는 이 후속 실행에서 새 기준으로 검증됐으며 이전 수락을 소급해 결함 판정하지 않습니다.

최종 저장소 검증은 [unit 148/build/browser 23/navigation 6/graph 500/topology 6 요약](./muyiny8j/final-repository-validation.json), [navigation root report](./muyiny8j/navigation-root-verification.json), [graph report](./muyiny8j/graph-root-verification.json), [topology report](./muyiny8j/topology-root-verification.json)에서 확인할 수 있습니다. [localhost 최종 패키지 전달·런타임 검사](./muyiny8j/final-local-verification.json)와 [이전 후보 rollback readiness](./muyiny8j/rollback-readiness.json)도 별도 기록했습니다.
