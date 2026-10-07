import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type AgentStatus = 'inProgress' | 'completed' | 'failed' | 'interrupted' | 'unknown';
type Agent = {
  id: string;
  parentId: string | null;
  role: string;
  nickname: string;
  model: string;
  status: AgentStatus;
  lastActivityAt: number | null;
  stale: boolean;
  task: string;
  result: string;
};
type Session = { id: string; title: string; updatedAt: number };
type Edge = { parentId: string; childId: string; closed: boolean };
type Dashboard = {
  updatedAt: number;
  source: { status: 'ok' | 'error'; message?: string };
  sessions: Session[];
  selectedSessionId: string | null;
  agents: Agent[];
  edges: Edge[];
};
type Activity = { id: string; type: string; label: string; timestamp: number | null; text: string };
type ActivityResponse = { items: Activity[]; nextCursor: number | null };

type Provider = 'codex' | 'claude' | 'opencode';
const providerNames = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode' };
const POLL_MS = 2000;
const statusText: Record<AgentStatus, string> = {
  inProgress: '진행 중', completed: '턴 완료', failed: '실패', interrupted: '중단', unknown: '상태 미확인',
};
const roleColors: Record<string, string> = {
  main: 'teal', orchestrator: 'teal', worker: 'amber', worker_luna: 'amber',
  senior_sol: 'violet', expert_astra: 'rose',
};
const roleNames: Record<string, string> = {
  main: 'ORCHESTRATOR', orchestrator: 'ORCHESTRATOR', worker: 'WORKER', worker_luna: 'WORKER · LUNA',
  senior_sol: 'SENIOR · SOL', expert_astra: 'EXPERT · ASTRA',
};

function formatTime(value: string | number | null | undefined) {
  if (value == null) return '—';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
}

function relativeTime(value: number | null) {
  if (value == null) return '활동 기록 없음';
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 60) return `${seconds}초 전`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  return `${Math.floor(seconds / 3600)}시간 전`;
}

function Icon({ name }: { name: 'spark' | 'chevron' | 'clock' | 'arrow' | 'layers' | 'refresh' }) {
  const common = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  if (name === 'spark') return <svg {...common}><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/><path d="m19 16 .9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9L19 16Z"/></svg>;
  if (name === 'chevron') return <svg {...common}><path d="m9 18 6-6-6-6"/></svg>;
  if (name === 'clock') return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>;
  if (name === 'arrow') return <svg {...common}><path d="M7 17 17 7M7 7h10v10"/></svg>;
  if (name === 'layers') return <svg {...common}><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></svg>;
  return <svg {...common}><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2"/></svg>;
}

export default function App() {
  const [provider, setProvider] = useState<Provider>('codex');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [selectedSession, setSelectedSession] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [dashboardError, setDashboardError] = useState('');
  const [activities, setActivities] = useState<Activity[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [activityError, setActivityError] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const activityRequest = useRef(0);
  const dashboardRequest = useRef(0);
  const hasOlder = useRef(false);
  const olderBusy = useRef(false);

  const fetchDashboard = useCallback(async (sessionId?: string) => {
    const requestId = ++dashboardRequest.current;
    try {
      const query = `?${new URLSearchParams({provider, ...(sessionId ? {sessionId} : {})})}`;
      const response = await fetch(`/api/dashboard${query}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`대시보드 응답 오류 (${response.status})`);
      const data = await response.json() as Dashboard;
      if (requestId !== dashboardRequest.current) return;
      setDashboard(data);
      setDashboardError(data.source?.status === 'error' ? (data.source.message || '데이터 소스 연결에 문제가 있습니다.') : '');
      setSelectedSession(data.selectedSessionId || sessionId || '');
      setSelectedAgentId((current) => data.agents.some((agent) => agent.id === current) ? current : (data.agents[0]?.id ?? ''));
    } catch (error) {
      if (requestId !== dashboardRequest.current) return;
      setDashboardError(error instanceof Error ? error.message : '대시보드를 불러오지 못했습니다.');
    }
  }, [provider]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await fetchDashboard(selectedSession || undefined);
      if (!cancelled) timer = window.setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); dashboardRequest.current += 1; };
  }, [fetchDashboard, selectedSession]);

  const selectedAgent = dashboard?.agents.find((agent) => agent.id === selectedAgentId) ?? null;
  const fetchActivity = useCallback(async (agentId: string, sessionId: string, before?: number, append = false) => {
    if (!append && olderBusy.current) return;
    const requestId = ++activityRequest.current;
    try {
      const params = new URLSearchParams({ sessionId, provider });
      if (before != null) params.set('before', String(before));
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/activity?${params}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`활동 기록 응답 오류 (${response.status})`);
      const data = await response.json() as ActivityResponse;
      if (requestId !== activityRequest.current) return;
      if (append) hasOlder.current = true;
      setActivities((current) => {
        const incoming = new Set(data.items.map(item => item.id));
        return append ? [...current, ...data.items.filter(item => !current.some(old => old.id === item.id))] : [...data.items, ...current.filter(item => !incoming.has(item.id))];
      });
      if (append || !hasOlder.current) setNextCursor(data.nextCursor);
      setActivityError('');
    } catch (error) {
      if (requestId !== activityRequest.current) return;
      setActivityError(error instanceof Error ? error.message : '활동 기록을 불러오지 못했습니다.');
    } finally {
      if (requestId === activityRequest.current) { setLoadingOlder(false); olderBusy.current = false; }
    }
  }, [provider]);

  useEffect(() => {
    setActivities([]); setNextCursor(null); setActivityError('');
    hasOlder.current = false; olderBusy.current = false; setLoadingOlder(false);
    if (!selectedAgentId || !selectedSession) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await fetchActivity(selectedAgentId, selectedSession);
      if (!cancelled) timer = window.setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); activityRequest.current += 1; };
  }, [fetchActivity, selectedAgentId, selectedSession]);

  const agentMap = useMemo(() => new Map((dashboard?.agents ?? []).map((agent) => [agent.id, agent])), [dashboard]);
  const roots = useMemo(() => (dashboard?.agents ?? []).filter((agent) => !agent.parentId || !agentMap.has(agent.parentId)), [dashboard, agentMap]);
  const childrenByParent = useMemo(() => {
    const map = new Map<string, Agent[]>();
    for (const agent of dashboard?.agents ?? []) {
      if (!agent.parentId) continue;
      map.set(agent.parentId, [...(map.get(agent.parentId) ?? []), agent]);
    }
    return map;
  }, [dashboard]);
  const counts = useMemo(() => {
    const agents = dashboard?.agents ?? [];
    return {
      total: agents.length,
      active: agents.filter((agent) => agent.status === 'inProgress').length,
      completed: agents.filter((agent) => agent.status === 'completed').length,
      failed: agents.filter((agent) => agent.status === 'failed').length,
    };
  }, [dashboard]);

  function renderAgent(agent: Agent, depth = 0, path: string[] = []) {
    if (path.includes(agent.id)) return null;
    const children = childrenByParent.get(agent.id) ?? [];
    const tone = roleColors[agent.role.toLowerCase()] ?? (depth === 0 ? 'teal' : 'amber');
    return <div className={`tree-branch depth-${Math.min(depth, 2)}`} key={agent.id}>
      <button className={`agent-card ${tone} ${selectedAgentId === agent.id ? 'selected' : ''}`} onClick={() => setSelectedAgentId(agent.id)} aria-pressed={selectedAgentId === agent.id}>
        <span className="agent-card-top"><span className="role-label">{roleNames[agent.role.toLowerCase()] ?? agent.role}</span><span className={`status-dot ${agent.status}`} aria-label={statusText[agent.status]} /></span>
        <span className="agent-name">{agent.nickname || agent.id}</span>
        <span className="agent-model">{agent.model || '모델 정보 없음'}</span>
        <span className="agent-card-foot"><span>{statusText[agent.status]}{agent.stale && <em className="stale-tag">새 기록 없음</em>}</span><span>{relativeTime(agent.lastActivityAt)}</span></span>
      </button>
      {children.length > 0 && <div className="tree-children" role="group" aria-label={`${agent.nickname} 하위 에이전트`}>
        {children.map((child) => renderAgent(child, depth + 1, [...path, agent.id]))}
      </div>}
    </div>;
  }

  return <main className="app-shell">
    <header className="topbar">
      <a className="brand" href="#top" aria-label="AX Mission Control 홈"><span className="brand-mark"><Icon name="spark" /></span><span className="brand-word">AX<span>AGENTS</span></span><span className="brand-divider"/><span className="brand-context">MISSION CONTROL</span></a>
      <div className="topbar-right"><span className="local-indicator"><i /> LOCAL INSTANCE</span><span className="topbar-divider"/><span className="clock-readout"><Icon name="clock" /> {formatTime(Date.now())}</span></div>
    </header>

    <div className="page-content" id="top">
      {(dashboardError || dashboard?.source.status === 'error') && <div className="alert-banner" role="alert"><span className="alert-mark">!</span><div><strong>데이터 연결 확인 필요</strong><span>{dashboardError || dashboard?.source.message}</span></div><button onClick={() => void fetchDashboard(selectedSession || undefined)} aria-label="다시 불러오기"><Icon name="refresh" /></button></div>}

      <section className="hero-row">
        <div><div className="eyebrow"><span className="eyebrow-line"/> LIVE SYSTEM OVERVIEW</div><h1>미션 컨트롤<span className="title-period">.</span></h1><p className="hero-copy">에이전트의 작업 흐름과 위임 상태를 한눈에 확인합니다.</p></div>
        <label className="session-select-wrap"><span>도구 선택</span><span className="select-control"><select value={provider} onChange={(event) => {
          dashboardRequest.current += 1; activityRequest.current += 1;
          setProvider(event.target.value as Provider); setDashboard(null); setSelectedSession(''); setSelectedAgentId('');
          setActivities([]); setNextCursor(null); setDashboardError(''); setActivityError('');
          hasOlder.current = false; olderBusy.current = false; setLoadingOlder(false);
        }} aria-label="관제 도구 선택">{Object.entries(providerNames).map(([id,name]) => <option key={id} value={id}>{name}</option>)}</select><Icon name="chevron" /></span></label>
        <label className="session-select-wrap"><span>세션 선택</span><span className="select-control"><select value={selectedSession} onChange={(event) => { setSelectedSession(event.target.value); }} aria-label="모니터링 세션 선택"><option value="">세션 선택</option>{dashboard?.sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}</select><Icon name="chevron" /></span></label>
      </section>

      <section className="metrics-grid" aria-label="에이전트 요약">
        <Metric label="전체 에이전트" value={counts.total} caption="현재 세션 기준" tone="neutral" />
        <Metric label="진행 중" value={counts.active} caption="저장된 턴 상태 기준" tone="teal" />
        <Metric label="턴 완료" value={counts.completed} caption="최근 턴 종료 기준" tone="green" />
        <Metric label="실패" value={counts.failed} caption="실패로 종료된 최근 턴" tone="amber" />
      </section>

      <div className="workspace-grid">
        <section className="panel topology-panel" aria-labelledby="topology-title">
          <div className="panel-heading"><div><div className="section-kicker">AGENT TOPOLOGY <span className="live-pip"/></div><h2 id="topology-title">위임 구조</h2></div><div className="panel-meta"><span className="topology-count"><Icon name="layers"/> {counts.total} AGENTS</span><span className="updated-label">업데이트 {formatTime(dashboard?.updatedAt)}</span></div></div>
          <div className="tree-legend"><span><i className="legend-dot teal-dot"/> 오케스트레이터</span><span><i className="legend-dot amber-dot"/> 워커</span><span>진행 중 상태는 저장 기록 기준입니다</span></div>
          <div className="topology-canvas">
            {roots.length ? <div className="tree-roots">{roots.map((root) => renderAgent(root))}</div> : <EmptyState title={dashboard ? '표시할 에이전트가 없습니다' : '대시보드 연결 중'} detail={dashboard ? '선택한 세션에 등록된 에이전트가 없습니다.' : '로컬 AX 서비스에서 첫 스냅샷을 기다리고 있습니다.'} />}
          </div>
          <div className="topology-footer"><span><b>{dashboard?.agents.length ?? 0}</b>개 에이전트 노드</span><span>카드를 선택해 상세 정보 확인 <Icon name="arrow"/></span></div>
        </section>

        <aside className="panel detail-panel" aria-labelledby="detail-title">
          <div className="panel-heading detail-heading"><div><div className="section-kicker">AGENT INSPECTOR</div><h2 id="detail-title">상세 정보</h2></div>{selectedAgent && <span className={`detail-status ${selectedAgent.status}`}>{statusText[selectedAgent.status]}</span>}</div>
          {selectedAgent ? <>
            <div className="detail-identity"><div className={`avatar ${roleColors[selectedAgent.role.toLowerCase()] ?? 'teal'}`}>{(selectedAgent.nickname || selectedAgent.id).slice(0, 1).toUpperCase()}</div><div><h3>{selectedAgent.nickname || selectedAgent.id}</h3><p>{roleNames[selectedAgent.role.toLowerCase()] ?? selectedAgent.role}<span>·</span>{selectedAgent.model}</p></div></div>
            <div className="detail-block"><div className="detail-label">TASK <span>작업 지시</span></div><p className="task-text">{selectedAgent.task || '등록된 작업 설명이 없습니다.'}</p></div>
            <div className="detail-block result-block"><div className="detail-label">RESULT <span>결과</span></div><p className="result-text">{selectedAgent.result || '아직 보고된 결과가 없습니다.'}</p></div>
            <div className="activity-heading"><div><div className="detail-label">ACTIVITY LOG <span>활동 타임라인</span></div></div><span className="activity-count">{activities.length} EVENTS</span></div>
            {activityError && <div className="inline-error" role="status">{activityError}</div>}
            <div className="activity-list" aria-live="polite">{activities.length ? activities.map((item) => <article className="activity-item" key={item.id}><span className="activity-rail"><i/></span><div className="activity-content"><div className="activity-item-head"><strong>{item.label || item.type}</strong><time>{formatTime(item.timestamp)}</time></div>{item.text && <p>{item.text}</p>}</div></article>) : <p className="activity-empty">{activityError ? '활동 기록을 확인할 수 없습니다.' : '아직 활동 기록이 없습니다.'}</p>}</div>
            {nextCursor != null && <button className="load-older" disabled={loadingOlder} onClick={() => { olderBusy.current = true; setLoadingOlder(true); void fetchActivity(selectedAgent.id, selectedSession, nextCursor, true); }}>{loadingOlder ? '불러오는 중…' : '이전 활동 불러오기'}<Icon name="chevron"/></button>}
          </> : <EmptyState title="에이전트를 선택하세요" detail="위임 구조에서 카드를 선택하면 작업과 활동 기록이 표시됩니다."/>}
        </aside>
      </div>

      {provider === 'codex' && <section className="roles-section" aria-label="사용 가능한 역할"><div className="roles-head"><div><div className="section-kicker">AVAILABLE ROLES</div><h2>미사용 역할</h2></div><span>현재 세션에 아직 배정되지 않은 역할</span></div><div className="role-chips">{[{role:'worker_luna',label:'Luna',description:'탐색 · 실행'},{role:'senior_sol',label:'Sol',description:'심층 분석'},{role:'expert_astra',label:'Astra',description:'전문 리뷰'}].filter(item => !dashboard?.agents.some(agent => agent.role === item.role)).map(item => <RoleChip key={item.role} {...item}/>)}</div></section>}

      <footer className="footer"><span>AX AGENTS <i/> LOCAL OBSERVABILITY</span><span><i className="footer-live"/> POLLING EVERY 2 SEC <b>·</b> 마지막 동기화 {formatTime(dashboard?.updatedAt)}</span></footer>
    </div>
  </main>;
}

function Metric({ label, value, caption, tone }: { label: string; value: number; caption: string; tone: string }) {
  return <article className={`metric-card ${tone}`}><div className="metric-top"><span>{label}</span><i/></div><div className="metric-value">{value.toString().padStart(2, '0')}</div><div className="metric-caption">{caption}</div></article>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name="layers"/></span><strong>{title}</strong><p>{detail}</p></div>;
}

function RoleChip({ role, label, description }: { role: string; label: string; description: string }) {
  return <div className="role-chip"><span className={`role-avatar ${roleColors[role]}`}><Icon name="spark"/></span><span className="role-chip-copy"><strong>{label}</strong><small>{description}</small></span><span className="role-idle">미사용</span></div>;
}
