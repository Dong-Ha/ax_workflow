# 주기03 진행 기록 — 실제 실행 화면 연결 중

주기02의 실제 요청 저장 화면은 `http://127.0.0.1:8769/`, 기존 workflow 화면은 `http://127.0.0.1:4173/ifpmic.html`이다. 이번 체크포인트는 화면 기능을 추가하지 않는다. 실제 실행 연결 전에 필요한 케이스별 원본 증빙 검사 기반을 구현했다. 주기03·H2·최종 목표는 미완료다.

## 실제로 검증한 변경

- 신규 stdlib 검사기 `scripts/ifpmic_h2_raw_evidence.py`: owner SQL/query 기록의 node·setup/call/teardown 구분, 원문 구조와 canonical digest, node별 최소/최대 횟수, private 디렉터리/파일 권한·소유자·symlink/hardlink, 중복 복사 및 파일별 해시 검사.
- TC 작성 합성 테스트28건을 독립 소스 승인 후 실제 실행하여28/28 통과했다. 정상·빈 실제 결과·누락·변조·다른 node 자료·중복 기록·해시만 있는 자료·권한/링크·JSON 경계를 확인했다.
- 증빙: [검증 결과](./recorder-verification.json), [소스 검토](./recorder-source-review.json), [결과 검토](./recorder-result-review.json). 원본 unit 로그·실행 ID·before/after·권한·보존 자료는 비공개 `workflow-artifacts/verification/agile/iteration-03/`에 있다.
- 보호된 AX96 해시/89 목록·설계17/업로드2·원래 Python1777/qualified3072 파일을 실제 기존 승인 map과 비교해 모두 유지됨을 확인했다. 제품/UI/의존성 변경이 없으므로 이 체크포인트에서 build/browser를 반복하지 않았다. 실제 실행 연결 시 관련 회귀는 필수다.

## 다음 한 가지

설명형87 case 계약의 조건부 artifact/history/list/tree/process/SQL-fence 규칙을 실제 파일 경로와 연결하고, full runner의 각 phase 및 공개 결과 생성 전에 전체 규칙을 검사하도록 통합한다. SQL-only/실제 no-run 경로에 Temporal history를 만들어 요구하지 않는다. 다른 case의 증빙이 누락을 가리지 못하게 한다.

그다음 현재490 후보 source/ledger/계약의 paired 리뷰와 전체 runner/pre-gate를 완료하고 fresh490을 실행한다. 통과·원본 증빙 독립 수용 뒤에 주기02 job을 실제 workspace/실행 엔진 접수에 연결한다. `QUEUED`는 P01 등의 업무 수행 완료가 아니며 화면에서도 구분한다.

## 재검증 명령과 제한

저장소 루트에서 승인된 stdlib 단위 범위만 실행하는 명령이다. 합성 임시 파일을 사용하며 API/DB/Temporal을 시작하지 않는다.

```sh
/usr/bin/python3 -S -B -m unittest discover -s tests/ifpmic_evidence -v
```

원본 full490 runner는 여전히 현재 후보의 실행 승인이 없으므로 실행하지 않는다. 이 checker는 owner/query의 구조·원문·횟수만 검사하며 history 의미, 모든 호출의 인과 완전성, process lifecycle, SQL 업무 불변식, concurrent namespace 안전성을 수용하지 않는다. 전체 H225+5 의무/490·H3–H7·원래 AT32·실제 Agent/장비/배포 요구사항은 남아 있다.
