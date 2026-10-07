# Paperclip로 고정 워크플로 실행하기

이 브랜치는 **미리 정의된 워크플로 안의 에이전트를 순서대로 호출하고 진행 상황을 확인**하는 실험입니다. AX의 읽기 전용 관제 서버와 별도로 Paperclip `2026.1005.0`을 실행합니다.

## 실행

Node.js 24.11 이상이 필요합니다. 설치 파일, 데이터베이스, Paperclip 자체 키, 예제 산출물은 Git에서 제외된 `.paperclip-lab/` 안에 저장합니다. 기존 `~/.paperclip` 설정이나 코딩 도구의 인증 파일을 수정하지 않습니다.

```sh
npm run paperclip:install
npm run paperclip:start
```

두 번째 명령은 서버를 현재 터미널에서 실행합니다. 브라우저에서 **http://127.0.0.1:3100**을 열고, 다른 터미널에서 워크플로를 준비합니다.

```sh
npm run paperclip:seed
npm run paperclip:run
npm run paperclip:status
```

기본 `smoke` 모드는 **모델 없는 시뮬레이션**입니다. 각 에이전트가 약 6초간 작업하고 예제 파일을 만들어 Paperclip의 실제 실행·작업 상태·파이프라인 연결을 검증합니다.

실제 Codex를 호출하려면 로컬 `codex` 명령이 설치되고 로그인되어 있어야 합니다. 현재 CLI의 모델 설정을 사용합니다.

```sh
codex login status
npm run paperclip:seed -- --mode codex
npm run paperclip:run -- --mode codex
npm run paperclip:status -- --mode codex
```

`codex` 모드는 실제 모델을 호출하므로 로그인한 계정의 사용량을 소비합니다. 각 단계는 격리된 예제 프로젝트에서 `codex exec --ephemeral --sandbox workspace-write`로 실행하고 최대 180초까지 기다립니다. 코딩 도구의 원본 인증 파일을 복사하거나 수정하지 않습니다.

완료된 실행을 다시 보고 싶으면 새 인스턴스 데이터를 유지한 채 **새 회사와 예제 프로젝트**를 만듭니다. 이전 결과도 UI에 남습니다.

```sh
npm run paperclip:seed -- --mode codex --fresh
npm run paperclip:run -- --mode codex
```

## 화면에서 확인하기

1. 왼쪽 위 회사 선택에서 이름에 `smoke` 또는 `codex`가 붙은 **AX · 고정 워크플로 테스트**를 선택합니다.
2. **Pipelines → 요구사항 → 구현 → 검증**에서 현재 단계와 케이스를 확인합니다.
3. **Dashboard**에서 실행 중인 에이전트와 최근 실행을 확인합니다.
4. **Tasks**에서 단계별 담당 에이전트, 선행 작업, 상태와 완료 기록을 확인합니다.
5. **Agents**에서 미리 등록된 Planner, Builder, Reviewer와 실행 기록을 확인합니다.

준비 명령이 실험용 인스턴스의 `enablePipelines` 옵션을 켭니다. 서버는 localhost에만 바인딩하며 별도 서비스를 설치하지 않습니다. 종료할 때 서버 터미널에서 Ctrl+C를 누릅니다.

## 워크플로와 실제 동작

[workflow.json](./workflow.json)은 단계 순서, 표시 이름, 에이전트 이름·역할·산출물 정의입니다. 예제는 다음의 세 단계로 고정되어 있습니다.

| 단계 | 에이전트 | 입력 | 산출물 |
|---|---|---|---|
| 요구사항 정리 | Planner | Slugify 요구사항 | `requirements.md` |
| 구현 | Builder | `requirements.md` | `slugify.mjs` |
| 검증 | Reviewer | 요구사항과 구현 | `test/slugify.test.mjs`, `report.md` |

Paperclip의 `process` 어댑터가 [stage-agent.mjs](./stage-agent.mjs)를 호출하고, 실제 모델 모드에서는 이 프로세스가 Codex를 실행합니다. 에이전트는 Paperclip 작업을 checkout하고 산출물을 확인한 뒤 `done`을 기록합니다. 검증 단계는 생성된 테스트뿐 아니라 별도의 최소 계약 검사도 통과해야 완료됩니다. 실패하면 작업이 `blocked`가 됩니다.

[lab.mjs](./lab.mjs)가 순서를 제어합니다. 선행 작업의 `done`, 실행의 `succeeded`를 모두 확인해야 파이프라인을 다음 단계로 이동하고 다음 에이전트를 호출합니다. 작업 의존 관계도 Paperclip의 `blockedByIssueIds`에 저장합니다. 에이전트의 주기 실행과 일반 할당 wakeup은 끄고, 실행할 단계만 수동 wakeup을 허용합니다. 동시 실행은 로컬 잠금 파일로 막습니다.

실패 후 원인을 해결하고 같은 `run` 명령을 실행하면 완료된 단계를 건너뛰고 미완료 단계부터 재시도합니다. 프로세스를 강제 종료해 잠금 파일이 남았다면 실행 중인 컨트롤러와 Paperclip run이 없는 것을 확인한 후 `.paperclip-lab/workflow.lock`을 제거합니다.

## 적합성과 한계

Paperclip의 파이프라인은 단계 전환과 작업 상태를 시각화하므로 이 목표에 사용할 수 있습니다. 다만 이번 순차 호출과 산출물 검증은 **실험용 컨트롤러가 구현**했고, Paperclip 기본 기능만으로 자동 구성되는 것은 아닙니다. 파이프라인은 실험 기능입니다. 임의 DAG를 그리는 노드 편집기와는 UI 형태가 다릅니다. 단계에 네이티브 routine을 연결하지 않았으므로 UI의 “Nothing runs here automatically” 경고는 남습니다. 이 실험에서는 `paperclip:run` 컨트롤러가 해당 단계를 실행합니다.

이 예제는 세 가지 작업 유형을 검증합니다. 실제 워크플로를 적용할 때는 `workflow.json`뿐 아니라 `stage-agent.mjs`의 단계 프롬프트·산출물 검증도 함께 바꿉니다. 분기·병렬·반복·사람 승인 단계는 이번 실험 범위에 포함하지 않습니다.

`process` 어댑터 경유 Codex 실행은 모델 사용량을 Paperclip에 별도로 보고하지 않습니다. 따라서 Paperclip의 비용 표시 `0`을 실제 무료 실행으로 해석하면 안 됩니다. 정확한 토큰·비용 추적과 세션 재사용은 추후 네이티브 `codex_local` 어댑터를 적용해 확인할 항목입니다. 원시 추론과 도구 출력은 프로세스 로그로 전달하지 않으며, 단계별 시작·종료와 검증 요약만 표시합니다.

## 검증

- 모델 없는 3단계 실행과 실제 Codex 3단계 실행이 모두 완료됐습니다. 실제 생성된 예제의 테스트 17개가 통과했습니다.
- 단위 검증은 선행 작업 미완료, checkout 충돌, 검증 실패가 잘못된 완료로 이어지지 않는지 확인합니다.
- 브라우저에서 Dashboard, Pipelines와 단계 상세 화면을 확인했습니다. 정의된 순서를 건너뛰는 전환은 API가 409로 거부했습니다.

공식 참고: [어댑터](https://docs.paperclip.ing/reference/adapters/overview/), [파이프라인 튜토리얼](https://github.com/paperclipai/paperclip/blob/master/docs/pipelines-tutorial.md).
