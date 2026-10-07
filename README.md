# AX 에이전트 관제 페이지

현재 PC의 Codex, Claude Code, OpenCode 기록에서 프로젝트 대화와 하위 에이전트의 상태, 위임 관계, 작업 요청, 완료 응답을 확인하는 로컬 대시보드입니다. 한국어 관제실 화면이며 추가 모델 호출이 없습니다.

## 실행

Node.js 24 이상을 사용합니다.

```sh
npm install
npm run build
npm start
```

브라우저에서 **http://127.0.0.1:3000**을 엽니다. 개발할 때는 `npm run dev`를 사용합니다. 두 명령 모두 localhost에만 바인딩합니다.

## 설정

기본 프로젝트 경로는 이 저장소의 디렉터리입니다. 화면의 **도구 선택**에서 Codex, Claude Code, OpenCode를 전환합니다. 전환하면 세션과 활동 목록도 해당 도구의 기록으로 바뀝니다. 도구를 설치한 같은 PC에서 실행하세요. 설정을 바꾸려면 다음 환경 변수를 사용합니다.

```sh
AX_PROJECT_ROOT=/home/dongha/AX AX_CODEX_HOME=/home/dongha/.codex PORT=3000 npm start
```

- `AX_PROJECT_ROOT`: 조회할 프로젝트의 작업 디렉터리. 기본값은 이 앱의 루트입니다.
- `AX_CODEX_HOME`: Codex 데이터 디렉터리. `CODEX_HOME`을 재정의하지 않습니다.
- `AX_CLAUDE_HOME`: Claude Code 데이터 디렉터리. 기본값은 `CLAUDE_CONFIG_DIR` 또는 `~/.claude`.
- `AX_OPENCODE_HOME`: OpenCode 데이터 디렉터리. 기본값은 `$XDG_DATA_HOME/opencode` 또는 `~/.local/share/opencode`.
- `PORT`: HTTP 포트. 기본값 3000.

다른 작업 폴더를 관제할 때는 다음처럼 실행합니다. 모델 API 키나 추가 모델 호출은 필요하지 않습니다.

```sh
AX_PROJECT_ROOT=/path/to/your/project npm start
```

Claude Code는 `projects/<project>/<session>.jsonl` 대화와 `<session>/subagents/agent-*.jsonl` 하위 기록을 읽습니다. 루트 대화의 `cwd`가 프로젝트 경로와 일치해야 하며, 하위 에이전트는 부모 세션 폴더 관계로 연결합니다. `end_turn`, `stop_sequence` 또는 `turn_duration` 종료 기록이 있어야 턴 완료로 표시합니다. 종료 근거가 없는 응답만으로는 완료로 처리하지 않습니다. Claude Code의 과거 평면 `agent-*.jsonl` 및 agent teams 별도 세션 연결은 지원하지 않습니다. [Claude Code 디렉터리 문서](https://code.claude.com/docs/en/claude-directory), [하위 에이전트 기록 문서](https://code.claude.com/docs/en/hooks#subagentstop).

OpenCode는 데이터 디렉터리의 `opencode.db`에서 `session`, `message`, `part` 테이블을 읽습니다. `directory`로 루트를 제한하고 `parent_id`로 하위 세션을 연결합니다. 메시지의 `time.completed`, `finish`, `error`로 저장된 턴 상태를 표시합니다. SQLite 이전 JSON 저장 형식은 지원하지 않습니다. [OpenCode 저장소 안내](https://opencode.ai/docs/troubleshooting/#storage), [공식 메시지 형식 소스](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/message-v2.ts).

같은 프로젝트의 대화가 여러 개이면 최근 업데이트된 대화를 선택합니다. 하위 에이전트는 작업 디렉터리가 달라도 실제 위임 관계를 따라 포함합니다. 다른 프로젝트 기록은 API로도 조회할 수 없습니다.

## 상태와 기록

조회가 완료된 뒤 2초 후에 다시 기록을 확인합니다. 느린 요청을 중첩하지 않으며, 10초가 넘는 요청은 연결 오류로 표시합니다. ‘진행 중’은 마지막으로 저장된 턴 상태이며 프로세스 생존 확인이 아닙니다. 60초 동안 새 기록이 없으면 ‘새 기록 없음’을 표시하지만 실패로 바꾸지는 않습니다. ‘턴 완료’는 최근 대화 턴이 종료되었다는 뜻이며 전체 과제의 완료를 보장하지 않습니다. 닫힌 위임 관계도 완료 근거로 사용하지 않습니다.

선택한 대화에서 에이전트 이름·ID·원시 역할과 한국어 역할명을 검색하고, 전체·진행 중·턴 완료·실패·중단·상태 미확인으로 필터링할 수 있습니다. 검색과 상태는 함께 적용하며, 일치하는 하위 에이전트의 실제 조상은 맥락 카드로 남습니다. 일치 수는 맥락 카드를 제외한 값이고 전체·상태 집계는 대화 전체 기준입니다. 도구나 대화를 바꾸면 필터와 상세 선택을 초기화합니다. 필터에 숨겨진 선택의 상세는 유지하며, 삭제된 에이전트는 이용 불가로 표시합니다. ‘상태 미확인’을 대기로 추정하지 않습니다.

작업 요청과 완료 응답은 원문 텍스트를 길이 제한 안에서 표시합니다. 사용자에게 보이는 진행 메시지·계획과 활동 유형도 표시합니다. 추론, 인증 파일, 원시 명령 및 도구 출력은 화면으로 전달하지 않습니다. 표시 텍스트의 일반적인 인증 패턴은 가리지만 완전한 비밀정보 탐지 기능은 아닙니다. HTML은 실행하지 않으며 외부 폰트나 분석 서비스도 사용하지 않습니다.

데이터베이스는 읽기 전용으로 엽니다. Codex CLI 0.160.1 환경에서 확인한 `state_5.sqlite` 및 `thread_history_1.sqlite` 내부 형식에 의존합니다. 다른 버전에서 형식이 바뀌면 연결 오류를 표시할 수 있습니다. 저장소가 없거나 잠겨 있거나 형식이 맞지 않으면 연결 오류를 표시하고 마지막 정상 화면을 유지합니다. Codex 어댑터는 `server/store.mjs`, Claude Code는 `server/claude-store.mjs`, OpenCode는 `server/opencode-store.mjs`입니다. 모든 어댑터는 원본 기록을 수정하지 않습니다. 각 도구의 내부 기록 형식이 바뀌면 어댑터 수정이 필요할 수 있습니다.

## API와 검증

- `GET /api/dashboard?provider=codex|claude|opencode&sessionId=...`: AX 대화 목록, 선택된 대화, 에이전트, 위임 관계.
- `GET /api/agents/:id/activity?provider=codex|claude|opencode&sessionId=...&before=...`: 최근 활동 50개와 이전 페이지 커서.

`provider`를 생략하면 Codex를 사용합니다. `sessionId`를 생략하면 가장 최근 AX 대화를 사용합니다. 변경 요청은 지원하지 않습니다.

```sh
npm test
npm run build
npm run test:browser
```

테스트는 별도 임시 SQLite와 JSONL을 사용해 프로젝트 범위, 상태 해석, 페이지 처리, 추론 및 원시 출력 제외, 잘못된 항목과 저장소 누락을 검증합니다. 실행·중지, 토큰 비용, 외부 배포와 로그인 기능은 포함하지 않습니다.

브라우저 검증은 빌드 결과와 합성 API 응답만 사용하며 원본 기록을 읽지 않습니다. Playwright Chromium이 없다면 `npx playwright install chromium`으로 설치합니다. 실행 결과와 스크린샷은 Git에서 제외된 `workflow-artifacts/`에 생성합니다.

## 코딩 도구에서 이 저장소 개발하기

공통 개발 지침은 `AGENTS.md`에 있습니다. Codex와 OpenCode는 이 파일을 사용하고, Claude Code는 `CLAUDE.md`에서 가져옵니다. 프로젝트 루트에서 각 도구를 실행하고 작업을 요청하면 됩니다. 관제 서버는 별도 터미널에서 `npm run dev`로 실행합니다.

## Paperclip 워크플로 실험

정의된 단계와 에이전트를 실제로 호출하면서 진행 상황을 확인하는 별도 실험은 [experiments/paperclip/README.md](experiments/paperclip/README.md)에 있습니다. `npm run paperclip:install`, `npm run paperclip:start`로 localhost:3100의 독립된 Paperclip 인스턴스를 실행하고, `paperclip:seed`와 `paperclip:run`으로 예제 워크플로를 준비·실행합니다. AX 관제 서버는 기존 실행 방법을 사용합니다.

전달된 소프트웨어 개발 프로세스 이미지를 적용한 AX 기능 개발은 `paperclip:ax:seed`, `paperclip:ax:run`으로 실행합니다. 제품부·개발팀·테스트팀·운영팀이 에이전트 검색·상태 필터를 실제로 개발하고, 결함 수정·재검증·출시 승인을 거쳐 localhost에 배포합니다. [팀별 흐름과 단계 대응](experiments/paperclip/FLOW.md), [실행·검증·반영 방법](experiments/paperclip/README.md)을 확인하세요.

검색 결과는 **Alt + ↑ / ↓**로 이전·다음 항목으로 이동하며 현재 위치를 `k/N`으로 확인할 수 있습니다. 검색·상태·범위·필터 초기화 시 이동 위치는 재설정되고, 같은 범위의 유효한 갱신 중에는 유지됩니다. 개발·검증 근거는 [실제 실행 기록](experiments/paperclip/runs/README.md)에 있습니다.
