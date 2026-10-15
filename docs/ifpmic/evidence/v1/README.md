# V0와 V1 검증 증빙

V0 원본 무결성과 V1 계약 시각화·실제 Paperclip 장착을 검증했다. 실제 IFPMIC 작업 실행이나 AT-01–AT-32 수용시험은 이 결과에 포함하지 않는다. [독립 수용 판정](./review.json)과 [전체 진행 상태](../../progress.json)를 함께 확인한다.

| 검증 | 결과 | 증빙 |
|---|---|---|
| 단위·회귀 | 161/161, 실패·생략 0 | [후보 gate](./candidate-verification.json)의 unit 종료 코드·집계·로그 해시 |
| 원본 자료 | ZIP·DOCX, 추출 파일 17/17 바이트 일치 | [원본 검사](./source-upload.json) |
| 부정 자료 | 정상 1건 수락, 해시·바이트 변조·파일 누락 3건 거절 | [임시 fixture 검사](./negative-fixtures.json) |
| 설계 구조 | 53/53 | 후보 gate의 design-validator 실행 결과 |
| 빌드 | TypeScript·Vite와 plugin 번들 통과 | 후보 gate의 build·plugin-build 및 산출물 해시 |
| 독립 화면 | 8/8 | [오프라인 browser](./browser.json), [데스크톱](./desktop.png), [375px](./mobile-375.png) |
| 실제 Paperclip | 7/7, 2026.1005.0 native page | [host browser](./host-browser.json), [데스크톱](./host-desktop.png), [375px](./host-mobile.png) |
| 기존 AX | browser 23건·navigation 6건 통과 | [회귀 결과](./legacy-regression.json) |

실제 host 경로는 검증 인스턴스의 `http://127.0.0.1:3100/IFP/ifpmic-ax`다. 합성 검증 회사에 issue·agent가 없는 상태에서 읽기 전용 UI를 검사했다. browser 페이지 요청의 쓰기·외부 요청·runtime 오류는 0이었다. 검증 준비 단계의 합성 회사 생성과 로컬 플러그인 설치는 별도 setup 동작으로 보고서에 기록한다.

`npm run ifpmic:verify:v1`은 후보 소스 78개 경로를 실행 전후 비교하고 8개 필수 명령을 수행했다. 원본 ZIP·DOCX, 설계 계약 전체, 계획, 구현·테스트·빌드 설정과 plugin을 포함한다. 소스가 달라진 이전 실행은 완료 근거로 채택하지 않았다. 실패와 보완 내역은 [검증 이력](./verification-history.json)과 [결정 기록](../../DECISIONS.md)에 있다.

증빙의 원본 로그는 로컬 `workflow-artifacts/verification/`에 보존한다. 이 디렉터리에는 합성 시험 결과·해시와 화면만 게시하고 실제 대화 기록, 내부 도구 로그, 자격증명은 포함하지 않는다. [증빙 manifest](./evidence-manifest.json)는 게시 파일과 원본의 해시를 연결한다. host 보고서의 절대 로컬 경로를 상대 경로로 바꾸고 screenshot 참조를 게시 경로에 맞췄으며, 시험 결과는 변경하지 않았다.

재현하려면 루트의 제공 ZIP·DOCX와 Node.js 24 이상, 설치된 의존성 및 Playwright Chromium이 필요하다. `npm run paperclip:install`, `npm run ifpmic:plugin:build` 후 별도 터미널에서 `npm run ifpmic:lab:start`를 실행하고 `npm run ifpmic:verify:v1`을 수행한다. 모델 계정이나 실제 장비는 사용하지 않는다.
