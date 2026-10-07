# Paperclip로 고정 워크플로 실행하기

이 브랜치는 **미리 정의된 워크플로 안의 에이전트를 순서대로 호출하고 진행 상황을 확인**하는 실험입니다. AX의 읽기 전용 관제 서버와 별도로 Paperclip `2026.1005.0`을 실행합니다.

## 이미지 기반 AX 기능 개발

[전달된 프로세스 이미지](./reference-process.png)를 적용한 실제 AX 개발 흐름은 [FLOW.md](./FLOW.md)에서 확인합니다. 기존 Slugify 예제와 별도로 제품부·개발팀·테스트팀·운영 유지팀의 네 에이전트를 생성합니다. 각 팀이 실제 Codex CLI로 요구사항, 설계, 구현, 테스트, 결함 수정, 출시 승인과 로컬 배포 검증을 수행합니다.

추가하는 기능은 선택한 대화의 **에이전트 이름·ID·역할 검색과 상태 필터**입니다. 일치하는 하위 에이전트의 조상은 맥락 카드로 남기고, 일치 수와 전체 수를 구분합니다. 공급자·세션 변경 시 필터를 초기화합니다.

```sh
npm install
codex login status
npm run paperclip:start
```

별도 터미널에서 실행합니다. Playwright Chromium이 없다면 먼저 `npx playwright install chromium`으로 설치합니다.

```sh
npm run paperclip:ax:seed
npm run paperclip:ax:run
npm run paperclip:ax:status
```

`seed`는 현재 AX 소스와 설치된 의존성을 `.paperclip-lab/workspaces/ax-*`로 복사하고 별도 Paperclip 회사를 만듭니다. 기존 상태를 유지하며 새 실험은 `paperclip:ax:seed -- --fresh`로 생성합니다. 실행 중에는 새 실험을 만들지 마세요. 에이전트는 서버·어댑터·설정과 원본 기록을 변경하지 않으며, 단계별 파일 수정 경계를 실행기가 확인합니다.

QA는 테스트를 작성·실행하며 제품 코드를 직접 고치지 않습니다. QA 결과가 실패하면 컨트롤러가 개발팀에 결함 수정 작업을 배정하고 같은 검증 단계로 되돌립니다. 출시 후보의 검증이 실패하면 시스템 테스트·제품부 승인·배포를 다시 거칩니다. 한 검증 단계의 자동 수정은 최대 세 번입니다. 모델 실행 오류, checkout 충돌과 QA의 제품 결함 발견은 구분합니다.

에이전트의 보고서와 별도로 테스트·빌드·Playwright 실행 결과를 확인합니다. 검증 서버는 localhost:3200, 출시 후보는 localhost:3201을 사용합니다. 브라우저 기능 테스트에는 합성 API 응답을 사용하며, 로컬 출시 서버의 실제 API는 기존 읽기 전용 어댑터를 사용합니다. 기존 서버가 이 포트를 사용하면 연결하지 않고 실행을 중단합니다.

완료 후 검증된 기능과 보고서를 현재 저장소에 반영합니다. `apply`는 seed 이후 현재 `src/`가 바뀌었으면 거부합니다.

```sh
npm run paperclip:ax:apply
npm test
npm run build
npm run paperclip:ax:serve
```

마지막 명령으로 검증된 AX 출시를 **http://127.0.0.1:3201**에서 실행합니다. 실행 결과는 `experiments/paperclip/runs/<실험 ID>/execution.json`과 단계별 문서에 남습니다. 실제 로컬 패키지·데이터베이스·설치 파일은 `.paperclip-lab/`에만 저장하고 Git에서 제외합니다.

실행 프로세스가 멈췄다가 다시 `run`을 호출하면 저장된 run ID를 조회합니다. 살아 있는 작업을 다시 실행하지 않습니다. 실패 또는 취소가 확인된 모델 실행을 재시도하려면 `node experiments/paperclip/ax-controller.mjs retry`를 사용합니다. `ax-workflow.lock`이 남았다면 파일의 PID가 실제 종료되었는지와 회사의 실행 상태를 먼저 확인하세요. 잠금을 자동으로 제거하지 않습니다.

Paperclip이 `execution_reconciliation_required`로 실행을 보류하면, 실패한 실행이 남긴 변경과 외부 작업 결과를 먼저 검토합니다. 검토 결과에 맞게 `not_performed`, `completed`, `mixed` 중 하나를 지정하고 근거를 남겨 정식 복구 경로를 사용합니다.

```sh
node experiments/paperclip/ax-controller.mjs recover --outcome mixed --evidence '검토한 실제 결과를 20자 이상으로 기록합니다. 일부 산출물이 생성됐지만 단계 완료는 실패했습니다.'
```

복구 요청과 이전 실행 ID를 먼저 저장하고, Paperclip이 중지된 프로세스와 해제된 실행 소유권을 확인한 뒤 생성하는 후속 실행만 추적합니다. 복구 응답이 유실되면 `run`이 저장된 요청을 재개합니다. 인수 테스트에서는 가상 데이터 브라우저 시나리오와 함께 실제 localhost 서버의 모든 배포 정적 파일을 패키지와 SHA-256으로 비교합니다.

시스템 QA가 완료됐지만 승인 작업이 실행 reconciliation 필요 상태로 멈춘 경우, 현재 승인 보류 범위를 다시 검증하려면 다음 명령을 사용합니다.

```sh
node experiments/paperclip/ax-controller.mjs revalidate --reason '승인 보류에 남은 시스템 QA 범위를 현재 기준으로 독립 재검증합니다.'
```

이 명령은 고정된 워크플로 정의의 시스템 테스트 담당자를 사용해 보조 QA 작업을 만듭니다. 완료된 선행 시스템 QA에 의존하고 네이티브 케이스에 연결하며, 기존 PM 의존성을 보존한 채 원래 승인 작업을 보조 작업에도 의존시킵니다. 기본 단계 커서와 주 작업 목록은 바꾸지 않습니다. 보조 QA가 통과해 현재 `system.json`과 저장된 검증 보고서가 일치한 뒤에야 원래 승인 작업의 복구를 진행할 수 있습니다.

보조 QA 실행 자체가 중단되어 reconciliation이 필요한 경우에는 해당 작업의 실행 결과를 검토하고 복구 근거를 남깁니다.

```sh
node experiments/paperclip/ax-controller.mjs revalidate --outcome mixed --evidence '보조 QA 실행에서 일부 검사는 끝났지만 재검증 작업은 완료되지 않았음을 확인했습니다.'
```

이 절차는 기존 작업과 보고서를 유지하며, 보조 QA와 원래 승인의 실행 이력을 각각 추적합니다. 실행 `muyiny8j`에서는 supplemental QA AXM-44가 pass/done으로 완료됐고 원래 승인 작업 AXM-43은 정식 복구 경로로 pass를 확인했습니다. 뒤이어 release AXM-45, acceptance AXM-46 및 최종 제품부 검토 AXM-47이 모두 통과했습니다. 결과는 [실행 기록](./runs/README.md)에 있습니다.

복구 전에 실행기는 출시 후보 서버와 필요한 검증 증거를 준비하고 기록합니다. 복구 후에는 동일한 준비 결과와 바이트 단위로 보존한 증거를 재사용하며, 이미 검토한 결과를 다시 생성해 출처를 바꾸지 않습니다.

새 패키지는 포장 시점의 정적 파일 해시 `assetHashes`와 그 목록의 지문 `assetDigest`를 실행 상태와 출시 포인터에 보존합니다. 인수·최종 제품부 검토·로컬 제공 전에 이 기준으로 파일 목록과 디스크 내용을 확인하고, HTTP 응답도 같은 해시와 비교합니다. 기존 `digest`는 `src/`와 `server/`의 소스 지문이며 정적 파일 지문과 구분합니다. 해시 기준을 저장하지 않았던 이전 패키지는 당시의 디스크·HTTP 비교 방식으로 유지하며, 새 기준을 이전 실행에 소급해 만들지 않습니다.

실행 `muyhf5a7`은 당시 여섯 navigation 사례와 포장 시점 정적 자산 3개를 확인하고 제품부의 최종 배달 검토까지 수락됐습니다. 그 뒤 별도 개선 실행 `muyiny8j`에서 현재 이동 위치 `k/N` 표시, 검색·상태·범위·초기화 시 위치 재설정, 같은 범위의 유효한 갱신 중 위치 보존을 구현해 여섯 navigation 사례와 최종 제품부 검토를 통과했습니다. 이전 수락은 당시 계약 기준으로 유지하며, 후속 position contract는 과거 결함으로 소급하지 않습니다. `muyhf5a7`의 별도 서버 런타임 guard 확인은 제품부 검토 뒤 수행한 검사로 실행 기록에 구분해 두었습니다.

각 실행은 시작 당시의 전체 단계 정의와 지문을 보존합니다. 루트 워크플로에 새 단계를 추가해도 기존 실행의 순서는 바뀌지 않습니다. 이전 상태에 정의가 없다면 격리 작업 공간에 복사된 원래 정의를 Paperclip의 등록 단계·순서와 대조해 복원합니다. 단계 변경이나 정의 지문 불일치가 있으면 복구·재시도 전에 중단하므로, 새로운 전환을 기존 실행에 임의로 끼워 넣지 않습니다.

완료된 결함 수정에 추가 코드 검토가 필요하면 현재 `fix` 단계에서 `node experiments/paperclip/ax-controller.mjs revise --reason '구체적인 검토 근거와 필요한 변경을 20자 이상으로 기록합니다.'`를 사용합니다. 기존 실행을 보존하고 선행 작업으로 연결한 새 개발 작업을 만듭니다. 다음 QA 검증은 계속 필요합니다. 이전 단계 문서와 검증 보고서는 다른 단계에서 수정할 수 없고, 배포 단계는 환경 준비의 `deployment-plan.md`를 보존하면서 별도의 `release-plan.md`를 작성합니다.

반영된 필터의 순환·중복·누락 관계와 집계를 독립 기준으로 확인하고 큰 그래프의 실행 시간을 측정하려면 `node experiments/paperclip/verify-agent-filter.mjs`를 실행합니다. 고정된 합성 사례 500개를 사용하며 원본 대화 기록을 읽지 않습니다.

승인된 기능을 반영한 후 새 개선 작업을 이어가려면 `node experiments/paperclip/ax-controller.mjs improve --reason '관찰한 문제와 필요한 개선을 20자 이상으로 기록합니다.'`를 실행합니다. 기존 회사와 네 팀을 재사용하며, 별도 프로젝트·파이프라인·작업 공간에서 개발 → 시스템 검증 → 승인 → 로컬 출시 → 인수 테스트 → 제품부 배포 검토를 수행합니다. 이전 완료 작업을 선행 관계로 남기고 원래 실행 상태를 보관합니다. 개선 작업의 QA에는 합성 그래프 500개의 독립 비교도 필수이며, 현재 소스가 이전 승인 결과와 다르면 시작하지 않습니다. 최종 제품부 검토는 실제 인수 실행·작업 ID와 후보 패키지 해시가 일치해야 하며, 정적 파일 전달 결과도 확인합니다.

큰 에이전트 구조의 화면 검증은 `node experiments/paperclip/verify-agent-topology.mjs`로 실행합니다. 현재 빌드에 합성 체인·넓은 트리 각 100·1,000·3,000개를 적용해 렌더링, 마지막 노드 검색과 조상 맥락, 선택·초기화를 확인합니다. 실패 코드는 간결한 JSON으로 남기고 외부 요청은 차단합니다. 화면 개선 작업은 `improve --verify-topology --reason '재현한 화면 결함과 필요한 개선을 기록합니다.'`로 시작하면 시스템·인수 QA에 이 검증도 필수가 됩니다.

검색 결과 navigation은 `node experiments/paperclip/verify-agent-navigation.mjs`로 검증합니다. 이 검증은 `deep-desktop`, `deep-mobile`, `next-previous-wrap`, `filter-cursor-reset`, `scope-cursor-reset`, `hidden-selection-retained`의 여섯 합성 사례에서 포커스·스크롤·순환, 필터/범위 변경 후 위치 초기화, 갱신 중 유효한 선택 위치 유지 여부를 확인합니다. 후속 개선 작업에 `improve --verify-navigation`을 지정하면 시스템·인수 QA의 필수 게이트가 됩니다. 이 계약은 실행 `muyiny8j`의 최종 acceptance와 product review에서 통과했습니다. 검증 근거는 [실행 목록](./runs/README.md)과 [navigation root report](./runs/muyiny8j/navigation-root-verification.json)에 연결됩니다.

제품부 승인은 에이전트가 테스트 근거를 검토하는 단계입니다. 외부 서비스 배포를 수행하지 않습니다. Paperclip의 process 어댑터는 CLI 모델 사용량을 비용 화면에 보고하지 않으므로 비용 `0`은 무료 실행을 의미하지 않습니다.

## 기존 Slugify 예제 실행

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
