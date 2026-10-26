import { createRoot } from 'react-dom/client';
import plan from '../../docs/ifpmic/delivery-plan.json';
import progress from '../../docs/ifpmic/progress.json';
import runtime from '../../docs/ifpmic/delivery/iteration-03/runtime-v9-execution-status.json';
import './delivery.css';

const current = plan.flows.find(flow => flow.id === plan.current_flow)!;
const completed = progress.stages.filter(stage => stage.status === 'verified').length;
const labels: Record<string, string> = { in_progress: '진행 중', not_started: '대기' };

function DeliveryPage() {
  return <main>
    <header>
      <p className="eyebrow">IFPMIC AX · 계획 갱신 {plan.updated_on}</p>
      <h1>한 번에 사용자 흐름 하나씩</h1>
      <p>최종 목표는 유지하고, 직접 확인할 수 있는 행동을 하나씩 연결합니다.</p>
      <nav aria-label="전달된 화면">
        <a href="/ifpmic.html">설계 탐색·모의 재생</a>
        <a href="http://127.0.0.1:8769/">요청 저장 화면 · 재시작 필요</a>
      </nav>
    </header>
    <section className="current" aria-labelledby="current-flow">
      <p className="eyebrow">이번 전달 목표 · {labels[current.status]}</p>
      <h2 id="current-flow">{current.title}</h2>
      <p>{current.outcome}</p>
      <h3>완료 조건</h3>
      <ul>{current.acceptance.map(item => <li key={item}>{item}</li>)}</ul>
      <p><strong>다음 행동: </strong>{current.next_action}</p>
      <p className="blocker"><strong>현재 장애: </strong>{current.blocker}</p>
      <p>실제 엔진 접수 화면은 아직 미완료입니다. 이 현황판은 업무 실행 서비스의 가동을 뜻하지 않습니다.</p>
    </section>
    <section aria-labelledby="evidence">
      <h2 id="evidence">제품 진척과 검사 결과</h2>
      <div className="columns">
        <article><h3>전체 인수 단계</h3><p className="number">{completed} / {progress.stages.length}</p>
          <p>동일 가중치 단계 수입니다. 작업량이나 남은 시간의 추정치가 아닙니다.</p>
          <p>설계·합성 재생과 로컬 요청 저장이 전달됐습니다. 실제 업무·장비·배포 인수는 남아 있습니다.</p></article>
        <article><h3>마지막 실제 엔진 검증 · V9</h3>
          <p className="number">{runtime.passed_cases} 통과 · {runtime.failed_cases} 실패</p>
          <p>예정 {runtime.inventory}건 중 {runtime.executed_cases}건 실행, {runtime.remaining_inventory_cases_not_executed}건 미실행.</p>
          <p>2026-10-23의 실패 기록입니다. 전체 H2는 미수용이며 재실행하지 않았습니다.</p></article>
      </div>
    </section>
    <section aria-labelledby="sequence">
      <h2 id="sequence">다음 전달 순서</h2>
      <ol className="flows">{plan.flows.map(flow => <li key={flow.id} aria-current={flow.id === current.id ? 'step' : undefined}>
        <h3>{flow.title} <span>{labels[flow.status]}</span></h3><p>{flow.outcome}</p>
      </li>)}</ol>
    </section>
    <section aria-labelledby="verification">
      <h2 id="verification">검증을 나누는 기준</h2>
      <p>개발 중에는 변경에 직접 관련된 검사를 실행합니다. 로컬 통합 결과를 확인하고, 전체 H2·원본 AT 인수는 별도로 수행합니다.</p>
      <p>일부 검사 통과로 기능 전달이나 전체 인수를 완료 처리하지 않습니다. 원래 승인·품질·격리 기준은 유지합니다.</p>
    </section>
    <footer>빌드에 포함된 계획과 보존된 증거를 표시합니다. 실시간 서비스 상태가 아닙니다.</footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<DeliveryPage />);
