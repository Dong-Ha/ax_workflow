# Paperclip 구조와 IFPMIC 적용 범위

Paperclip은 AI 에이전트를 역할별로 등록하고 목표, 작업, 실행 이력과 비용을 관리하는 오픈소스 플랫폼이다. Node.js 서버와 React UI를 제공하며, 에이전트 실행기는 adapter로 연결한다. IFPMIC에서는 이 조직·작업 관제 기반 위에 설계서의 단계 흐름과 증거 화면을 추가한다. [공식 소개](https://github.com/paperclipai/paperclip)

## 조사 기준

2026년 10월 15일에 원격 저장소를 별도 임시 디렉터리로 clone하여 읽었다. 조사 기준 commit은 `307c27e3d82008223e1bf10a8aae0eea97cc187d`이다. 아래 소스 링크는 이 commit으로 고정했다. 현재 AX 실험의 설치 기준 `2026.1005.0`과 원격 master를 같은 버전으로 취급하지 않는다.

## 주요 구성

| 구성 | 역할 | IFPMIC 활용 |
|---|---|---|
| Company, Agent, Goal, Project | 조직과 담당 역할, 목표 및 프로젝트 관리 | 프로젝트와 6개 실행 역할 표현 |
| Issue와 작업 관계 | 담당, 상태, 선행 작업과 대화 관리 | 단계 실행과 결과 링크 연결 |
| Heartbeat와 adapter | 실행기를 깨우고 결과·세션·사용량 수집 | job/step/cycle/attempt에 대응하는 실행 추적 |
| Pipeline과 Case | 단계, 전이, 검토, 의존 관계 및 이벤트 | 작업 진행 요약과 업무 이력 탐색 |
| UI | Dashboard, Tasks, Agents 및 Pipeline 화면 | IFPMIC 전용 workflow 상세 화면의 기반 |

소스의 주요 위치는 [`server/src/services`](https://github.com/paperclipai/paperclip/tree/307c27e3d82008223e1bf10a8aae0eea97cc187d/server/src/services), [`packages/db/src/schema`](https://github.com/paperclipai/paperclip/tree/307c27e3d82008223e1bf10a8aae0eea97cc187d/packages/db/src/schema), [`packages/adapters`](https://github.com/paperclipai/paperclip/tree/307c27e3d82008223e1bf10a8aae0eea97cc187d/packages/adapters), [`ui/src`](https://github.com/paperclipai/paperclip/tree/307c27e3d82008223e1bf10a8aae0eea97cc187d/ui/src)이다. DB 계층은 PostgreSQL과 Drizzle 기반이다.

## 실행과 Pipeline에서 확인한 기능

Heartbeat는 할당, 일정 또는 수동 호출 등의 계기로 실행되고 adapter가 실행기를 호출한다. 실행 상태와 업무 완료는 구분해야 한다. `claude_local`, `codex_local`, `opencode_local`과 범용 `process`, `http` 등의 adapter가 존재한다. IFPMIC 설계의 OpenCode HTTP 연동과 Paperclip의 `opencode_local` CLI 실행은 서로 다른 연결 방식이므로 계약 변환과 버전 fixture 검증이 필요하다. [실행 모델](https://github.com/paperclipai/paperclip/blob/307c27e3d82008223e1bf10a8aae0eea97cc187d/docs/guides/agent-developer/how-agents-work.md), [adapter 문서](https://github.com/paperclipai/paperclip/blob/307c27e3d82008223e1bf10a8aae0eea97cc187d/docs/adapters/overview.md)

현재 Pipeline에는 다음 기능이 있다.

- 명시적 단계 전이와 전이 제한, 선행 Case에 의한 차단.
- `reviewerKind: human`인 검토 단계와 승인·반려·수정 요청 경로.
- `expectedVersion`을 통한 오래된 편집 거부.
- 자식 종료에 따른 상위 단계 전이와 routine 연결.

공식 [Pipeline 튜토리얼](https://github.com/paperclipai/paperclip/blob/307c27e3d82008223e1bf10a8aae0eea97cc187d/docs/pipelines-tutorial.md)과 [`reviewCase`](https://github.com/paperclipai/paperclip/blob/307c27e3d82008223e1bf10a8aae0eea97cc187d/server/src/services/pipelines.ts#L4893) 구현에서 확인했다. UI는 [`PipelinesExperimentalGate`](https://github.com/paperclipai/paperclip/blob/307c27e3d82008223e1bf10a8aae0eea97cc187d/ui/src/components/PipelinesExperimentalGate.tsx#L7)의 `enablePipelines` 설정에 의존한다.

따라서 과거 AX 실험의 제한 사항을 Paperclip 전체의 기능 부재로 해석하지 않는다. 기존 실험은 자체 컨트롤러로 순차 실행과 검증을 구현했으며, 현재 upstream은 사람 검토와 복귀 전이도 제공한다. 다만 자식이 terminal인 것만으로 IFPMIC 품질 PASS를 선언할 수는 없다.

## 추가 구현이 필요한 업무 규칙

| IFPMIC 계약 | 필요한 확장 |
|---|---|
| P01–P26 및 X01–X03 | 29개 노드, 정상·실패·반려 경로와 6개 phase의 전용 화면 |
| 후보별 품질 gate | candidate fingerprint, 프로그램·parser·규칙 버전과 판정 근거 |
| 사람 단계 | 담당 사용자, 제출 증거, 계획 버전과 완료 권한 |
| 배포 확인 | release manifest digest와 승인 일치, publisher의 실행 직전 재검사 |
| Windows 단말 | bridge 등록, serial 매핑, lease/fencing, journal, 결과 불명확 처리 |
| 지속 실행 | 장시간 대기, cycle/attempt, outbox, 재시작 복구와 오래된 결과 차단 |
| 관측과 개인정보 | 이벤트 허용 필드, `safeText`, 원시 추론·도구 입출력·인증 자료 제외 |

Paperclip의 일반 승인이나 Case version은 IFPMIC 배포 명세 digest 승인의 대체물이 아니다. Paperclip UI의 원시 transcript를 그대로 사용자에게 노출하지 않고 IFPMIC 정책에 맞는 이벤트 projection을 사용한다. 범용 process adapter는 지정 wrapper만 호출하도록 제한한다.

## 적용 방향

Paperclip 기반의 격리된 IFPMIC 화면을 만들고, 설계서 기본안인 FastAPI·Temporal·PostgreSQL·artifact service를 업무 실행 계층으로 둔다. Paperclip의 작업과 Pipeline은 이 실행 계층의 상태를 반영한다. 업무 단계 전이의 최종 결정은 Temporal 한 곳에서 수행하고, Paperclip의 별도 routine이나 자동 전이가 같은 실행을 중복 시작하지 않도록 한다. 상세 경계와 검증 순서는 [이관 계획](./PLAN.md)에 정의한다.

Paperclip 소스를 이관할 때는 조사 commit과 실제 채택 버전을 고정하고 upstream과의 차이를 기록한다. 저장소의 [라이선스](https://github.com/paperclipai/paperclip/blob/307c27e3d82008223e1bf10a8aae0eea97cc187d/LICENSE)는 MIT이며, 복사한 소스에 해당 고지문을 보존한다.
