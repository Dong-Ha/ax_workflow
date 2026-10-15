import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import registry from '../../docs/ifpmic/design-v1/specs/workflow.v1.json' with { type: 'json' };
import requirements from '../../docs/ifpmic/design-v1/specs/requirements.json';
import { buildWorkflowGraph, filterWorkflowNodes, ownerLabels, requirementsForNode, type WorkflowEdge } from './contract.mjs';
import stylesheet from './workflow.css?raw';
import stateContract from '../../docs/ifpmic/design-v1/specs/state-contract.json' with { type: 'json' };
import { createScenarioCatalog, replayScenario } from './replay.mjs';
import { ReplayPanel, ObservationDetail } from './ReplayPanel';

const graph = buildWorkflowGraph(registry);
const catalog = createScenarioCatalog(registry, stateContract);
const edgeLabels = { pass: '정상 진행', business_fail: '업무 실패 복귀', special: '반려·설계 변경' };
const outcomeLabels: Record<string, string> = { unresolved: '미해결 질문', rejected: '경로 반려', design_change_needed: '설계 영향', reject_code: '코드 반려', reject_design: '설계 반려', reject_release_metadata: '배포 자료 반려', unknown_remote_state: '원격 결과 불명확', failure: '노트 작성 실패' };

export function AxWorkflowPage() {
  const [mode, setMode] = useState<'design' | 'replay'>('design');
  const [scenarioId, setScenarioId] = useState('happy-path');
  const [cursor, setCursor] = useState(0);
  const [selectedId, setSelectedId] = useState('P01');
  const [query, setQuery] = useState('');
  const [owner, setOwner] = useState('all');
  const [showReturns, setShowReturns] = useState(true);
  const [paths, setPaths] = useState<{ edge: WorkflowEdge; d: string }[]>([]);
  const board = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const terminal = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => filterWorkflowNodes(graph, { query, owner }), [query, owner]);
  const visibleIds = useMemo(() => new Set(visible.map(node => node.id)), [visible]);
  const selected = graph.nodes.find(node => node.id === selectedId)!;
  const selectedEdges = graph.edges.filter(edge => edge.from === selectedId);
  const selectedOutcomes = graph.outcomes.filter(outcome => outcome.from === selectedId);
  const scenario = catalog.find(item => item.id === scenarioId)!;
  const snapshot = useMemo(() => mode === 'replay' ? replayScenario(scenario, registry, stateContract, cursor) : null, [mode, scenario, cursor]);

  useLayoutEffect(() => {
    const measure = () => {
      if (!board.current) return;
      const base = board.current.getBoundingClientRect();
      const next = graph.edges.filter(edge => visibleIds.has(edge.from) && (edge.to === 'END' || visibleIds.has(edge.to)) && (showReturns || edge.kind === 'pass')).flatMap(edge => {
        const a = nodeRefs.current.get(edge.from)?.getBoundingClientRect();
        const b = (edge.to === 'END' ? terminal.current : nodeRefs.current.get(edge.to))?.getBoundingClientRect();
        if (!a || !b) return [];
        const sameColumn = Math.abs(a.left - b.left) < 4;
        let x1, y1, x2, y2, d;
        if (sameColumn && edge.kind === 'pass') {
          x1 = a.left + a.width / 2 - base.left; y1 = a.bottom - base.top;
          x2 = b.left + b.width / 2 - base.left; y2 = b.top - base.top;
          d = `M ${x1} ${y1} L ${x2} ${y2}`;
        } else {
          const forward = b.left > a.left;
          x1 = (forward ? a.right : a.left) - base.left; y1 = a.top + a.height / 2 - base.top;
          x2 = (forward ? b.left : b.right) - base.left; y2 = b.top + b.height / 2 - base.top;
          const bend = Math.max(26, Math.abs(x2 - x1) * .38);
          d = `M ${x1} ${y1} C ${x1 + (forward ? bend : -bend)} ${y1}, ${x2 - (forward ? bend : -bend)} ${y2}, ${x2} ${y2}`;
        }
        return [{ edge, d }];
      });
      setPaths(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (board.current) observer.observe(board.current);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [visibleIds, showReturns, snapshot]);

  function select(id: string, focus = false) {
    setSelectedId(id);
    pendingFocus.current = null;
    if (focus) {
      const element = nodeRefs.current.get(id);
      if (element) {
        element.focus({ preventScroll: true });
        element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      } else pendingFocus.current = id;
    }
  }

  useLayoutEffect(() => {
    const id = pendingFocus.current;
    const element = id && visibleIds.has(id) ? nodeRefs.current.get(id) : null;
    if (element) {
      pendingFocus.current = null;
      element.focus({ preventScroll: true });
      element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
  }, [selectedId, visibleIds]);

  useLayoutEffect(() => {
    if (mode === 'replay') {
      pendingFocus.current = null;
      scroller.current?.scrollTo({ left: 0, top: 0, behavior: 'instant' });
    }
  }, [scenarioId, mode]);

  function navigate(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    const position = visible.findIndex(node => node.id === id);
    let next: number;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (position + 1) % visible.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (position - 1 + visible.length) % visible.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = visible.length - 1;
    else return;
    event.preventDefault(); select(visible[next].id, true);
  }

  useEffect(() => {
    if (visible.length && !visibleIds.has(selectedId)) setSelectedId(visible[0].id);
  }, [visible, visibleIds, selectedId]);

  return <main className="ifpmic-shell">
    <style>{stylesheet}</style>
    <header className="ifpmic-header">
      <div><p className="ifpmic-eyebrow">IFPMIC · AX WORKFLOW</p><h1>설계에서 검증, 승인까지</h1><p>업무 흐름과 각 단계의 통과 조건을 한곳에서 확인합니다.</p></div>
      <div className="ifpmic-mode"><span className="ifpmic-dot" /> {mode === 'design' ? '설계 보기' : 'MOCK · 모의 관측'} <small>실제 작업 미연결</small></div>
    </header>
    <nav className="ifpmic-view-switch" aria-label="보기 선택"><button aria-pressed={mode === 'design'} onClick={() => setMode('design')}>설계 보기</button><button aria-pressed={mode === 'replay'} onClick={() => { if (mode === 'replay') return; setMode('replay'); setCursor(0); setQuery(''); setOwner('all'); setSelectedId('P01'); }}>모의 시나리오</button></nav>
    <section className="ifpmic-stats" aria-label="계약 요약">
      <div><strong>29</strong><span>전체 29개 단계</span></div><div><strong>6</strong><span>업무 구간</span></div><div><strong>41</strong><span>전체 전이 · 정상·실패·반려</span></div><div><strong>7</strong><span>사람 담당 단계</span></div>
    </section>
    <div className="ifpmic-notice"><strong>원본 IFPMIC v1 기준</strong><span>에이전트 종료·품질 판정·사람 승인을 각각 확인합니다. 현재 화면은 읽기 전용 계약 시각화입니다.</span></div>
    {snapshot && <ReplayPanel catalog={catalog} scenario={scenario} cursor={cursor} snapshot={snapshot}
      onScenario={id => { setScenarioId(id); setCursor(0); setSelectedId('P01'); setQuery(''); setOwner('all'); }}
      onCursor={setCursor} onCurrent={() => { setQuery(''); setOwner('all'); select(snapshot.current_step === 'END' ? 'P26' : snapshot.current_step, true); }} />}
    <section className="ifpmic-toolbar" aria-label="흐름 필터">
      <label className="ifpmic-search">단계 검색<input type="search" aria-label="단계 검색" placeholder="단계 이름, ID, 역할 검색" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <label>담당<select aria-label="담당" value={owner} onChange={e => setOwner(e.target.value)}><option value="all">전체 담당</option>{Object.entries(ownerLabels).map(([id, label]) => <option key={id} value={id}>{label} · {id}</option>)}</select></label>
      <label className="ifpmic-toggle"><input type="checkbox" checked={showReturns} onChange={e => setShowReturns(e.target.checked)} />복귀 경로 표시</label>
      <button className="ifpmic-quiet" onClick={() => { setQuery(''); setOwner('all'); }}>필터 초기화</button>
      <output aria-live="polite">표시 {visible.length} / 전체 29</output>
    </section>
    <div className="ifpmic-workspace">
      <section className="ifpmic-flow" aria-label="IFPMIC 단계 흐름">
        <div className="ifpmic-flow-heading"><h2>워크플로우</h2><span>단계를 선택하면 입력·결과·판정 조건을 확인할 수 있습니다.</span></div>
        <div className="ifpmic-legend"><span className="pass">정상 진행</span><span className="business_fail">업무 실패 복귀</span><span className="special">반려·설계 변경</span></div>
        {visible.length === 0 && <p role="status" className="ifpmic-empty">일치하는 단계가 없습니다. 필터를 초기화해 전체 흐름을 확인하세요.</p>}
        <div className="ifpmic-scroll" ref={scroller} tabIndex={0} aria-label="흐름 가로 스크롤">
          <div className="ifpmic-board" ref={board}>
            <svg className="ifpmic-connections" aria-label="단계 연결" role="img">
              <defs>{(['pass', 'business_fail', 'special'] as const).map(kind => <marker key={kind} id={`ifpmic-arrow-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className={kind} /></marker>)}</defs>
              {paths.map(({ edge, d }) => <path key={edge.id} d={d} className={`${edge.kind} ${edge.from === selectedId || edge.to === selectedId ? 'selected' : ''}`} data-edge-from={edge.from} data-edge-to={edge.to} data-edge-kind={edge.kind} markerEnd={`url(#ifpmic-arrow-${edge.kind})`}><title>{edge.from} → {edge.to} · {edgeLabels[edge.kind]}{edge.outcome ? ` · ${edge.outcome}` : ''}</title></path>)}
            </svg>
            {graph.phases.map(phase => <section key={phase.id} className="ifpmic-phase" data-testid={`ifpmic-phase-${phase.id}`} aria-label={`${phase.id} ${phase.label}`}>
              <h3><span>0{phase.id}</span>{phase.label}</h3>
              {phase.nodes.filter(node => visibleIds.has(node.id)).map(node => <button key={node.id} ref={element => { if (element) nodeRefs.current.set(node.id, element); else nodeRefs.current.delete(node.id); }} className={`ifpmic-node ${node.owner === 'human' ? 'human' : node.owner === 'system' ? 'system' : ''} ${snapshot?.current_step === node.id ? 'current' : ''}`} data-testid={`ifpmic-node-${node.id}`} data-state={snapshot?.steps[node.id].state} data-attempt={snapshot?.steps[node.id].attempt} data-agent={snapshot?.steps[node.id].agent_status} data-gate={snapshot?.steps[node.id].gate_verdict ?? undefined} data-current={snapshot ? snapshot.current_step === node.id : undefined} aria-pressed={selectedId === node.id} onClick={() => select(node.id)} onKeyDown={e => navigate(e, node.id)}>
                <span className="ifpmic-node-top"><code>{node.id}</code><span>{node.owner === 'human' ? '사람 작업' : node.owner === 'system' ? '품질 gate' : 'Agent'}</span></span>
                <strong>{node.label}</strong><span className="ifpmic-node-owner">{node.owner}<small>{ownerLabels[node.owner]}</small></span>
                {snapshot && <span className="ifpmic-node-observation">MOCK · {snapshot.steps[node.id].state}<small>Agent {snapshot.steps[node.id].agent_status} · gate {snapshot.steps[node.id].gate_verdict ?? '미판정'} · a{snapshot.steps[node.id].attempt}</small></span>}
              </button>)}
              {phase.id === 6 && <div className="ifpmic-end" ref={terminal} data-testid="ifpmic-end" data-current={snapshot ? snapshot.current_step === 'END' : undefined}>END · 완료 경로</div>}
            </section>)}
          </div>
        </div>
        <p className="ifpmic-keyboard">방향키로 단계 이동 · Home 첫 단계 · End 마지막 단계 · 구간 이름은 화면 표시용이며 단계 소속은 원본 계약을 따릅니다.</p>
      </section>
      <aside className="ifpmic-detail" role="region" aria-label="선택 단계 상세">
        <div className="ifpmic-detail-top"><span>선택한 단계</span><code>{selected.id}</code></div><h2>{selected.label}</h2><p className="ifpmic-owner-detail">{ownerLabels[selected.owner]} <code>{selected.owner}</code></p>
        {snapshot && <ObservationDetail step={snapshot.steps[selectedId]} snapshot={snapshot} />}
        {!visibleIds.has(selectedId) && <p role="status">선택 단계가 필터에 숨겨져 있습니다.</p>}
        <dl><dt>입력</dt><dd>{selected.input}</dd><dt>결과</dt><dd>{selected.output}</dd><dt>통과 조건</dt><dd>{selected.pass_criterion}</dd><dt>생략 정책</dt><dd><code>{selected.skip_policy}</code><span>{selected.skip_policy === 'NEVER' ? '필수 수행 단계' : '기술적 근거·baseline·승인자·계획 버전을 기록해야 합니다.'}</span></dd></dl>
        {selected.owner === 'human' && <p className="ifpmic-human-note">사람이 제출한 증거와 권한 확인이 필요합니다. 에이전트의 완료 응답으로 통과시키지 않습니다.</p>}
        {selected.owner === 'system' && <p className="ifpmic-human-note">도구 결과와 사내 기준으로 판정합니다. 결과 누락·파싱 오류는 PASS가 아닙니다.</p>}
        <h3>다음 경로</h3><ul className="ifpmic-routes">{selectedEdges.map(edge => <li key={edge.id} className={edge.kind}><span>{edgeLabels[edge.kind]}{edge.outcome ? ` · ${outcomeLabels[edge.outcome] || edge.outcome}` : ''}</span>{edge.to === 'END' ? <strong>END · 완료 경로</strong> : <button onClick={() => { setQuery(''); setOwner('all'); select(edge.to); }} aria-label={`${edge.to} 단계 열기`}>{edge.to} → {graph.nodes.find(node => node.id === edge.to)?.label}</button>}</li>)}</ul>
        {selectedOutcomes.length > 0 && <><h3>특수 결과</h3><ul className="ifpmic-outcomes">{selectedOutcomes.map(outcome => <li key={outcome.event}><code>{outcome.from}.{outcome.event}</code><span>{outcome.target}</span>{outcome.target === 'retry_notes_only' && <small>이미 끝난 배포를 반복하지 않고 노트만 재시도합니다.</small>}</li>)}</ul></>}
        <h3>원본 요구사항 참조</h3><p className="ifpmic-trace-note">원본의 설계 참조에 단계 ID가 명시된 항목입니다. 실행 증거의 추적 링크는 후속 단계에서 연결합니다.</p><ul className="ifpmic-requirements">{requirementsForNode(selected).map(id => <li key={id}><code>{id}</code> {requirements.find(req => req.id === id)?.text}</li>)}</ul>{requirementsForNode(selected).length === 0 && <p className="ifpmic-trace-note">원본에 이 단계의 명시적 요구사항 ID 참조가 없습니다.</p>}
        <p className="ifpmic-evidence-empty">실제 실행 증빙: 아직 연결되지 않았습니다.<br />정적 계약과 모의 관측을 실제 업무 완료나 품질 통과로 집계하지 않습니다.</p>
      </aside>
    </div>
    <footer className="ifpmic-footer"><span>IFPMIC AX · workflow v{registry.schema_version}</span><span>Paperclip 상위 오케스트레이션 · 원본 절차와 승인 규칙 유지</span></footer>
  </main>;
}

export default AxWorkflowPage;
