const ROLE_LABELS = Object.freeze({
  main: '조정자',
  orchestrator: '조정자',
  worker: '워커',
  worker_luna: '워커 · 루나',
  senior_sol: '선임 · 솔',
  expert_astra: '전문가 · 아스트라',
  developer: '개발자',
  tester: '테스트 담당자',
  reviewer: '검토자',
  operator: '운영자',
});

const STATUS_VALUES = new Set(['all', 'inProgress', 'completed', 'failed', 'interrupted', 'unknown']);

export function roleDisplay(role) {
  const source = typeof role === 'string' ? role : '';
  const key = source.toLowerCase();
  return Object.hasOwn(ROLE_LABELS, key) ? ROLE_LABELS[key] : source;
}

function statusMatches(agent, status) {
  if (status === 'all') return true;
  return agent.status === status;
}

export function filterAgents(agents, query = '', status = 'all') {
  const source = Array.isArray(agents) ? agents : [];
  const normalizedQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const selectedStatus = STATUS_VALUES.has(status) ? status : 'all';
  const agentsById = new Map();
  for (const agent of source) {
    if (agent && typeof agent.id === 'string' && !agentsById.has(agent.id)) {
      agentsById.set(agent.id, agent);
    }
  }

  const statusCounts = { inProgress: 0, completed: 0, failed: 0, interrupted: 0, unknown: 0 };
  for (const agent of agentsById.values()) {
    if (Object.hasOwn(statusCounts, agent.status)) statusCounts[agent.status] += 1;
  }

  const matchedIds = new Set();
  for (const [id, agent] of agentsById) {
    const role = typeof agent.role === 'string' ? agent.role : '';
    const fields = [agent.nickname, id, role, roleDisplay(role)];
    const textMatch = normalizedQuery === '' || fields.some((field) =>
      typeof field === 'string' && field.toLowerCase().includes(normalizedQuery));
    if (textMatch && statusMatches(agent, selectedStatus)) matchedIds.add(id);
  }

  const visibleIds = new Set(matchedIds);
  // Share completed parent walks across matches. Visibility alone cannot mark
  // completion because matched IDs are visible before their parents are visited.
  const expandedIds = new Set();
  for (const id of matchedIds) {
    let current = agentsById.get(id);
    while (current && !expandedIds.has(current.id)) {
      expandedIds.add(current.id);
      const parentId = current.parentId;
      if (typeof parentId !== 'string') break;
      const parent = agentsById.get(parentId);
      if (!parent) break;
      visibleIds.add(parentId);
      current = parent;
    }
  }
  const contextIds = new Set([...visibleIds].filter((id) => !matchedIds.has(id)));

  return {
    agentsById,
    matchedIds,
    visibleIds,
    contextIds,
    totalCount: agentsById.size,
    matchedCount: matchedIds.size,
    statusCounts,
  };
}

export function getSelectedDetail(agents, selectedId, visibleIds) {
  if (selectedId == null) return { kind: 'guidance', agent: null, hidden: false };
  const agent = agents instanceof Map
    ? agents.get(selectedId)
    : Array.isArray(agents)
      ? agents.find((candidate) => candidate?.id === selectedId)
      : undefined;
  if (!agent) return { kind: 'unavailable', agent: null, hidden: false };
  const visible = visibleIds instanceof Set && visibleIds.has(selectedId);
  return { kind: 'selected', agent, hidden: !visible };
}

export function transitionScope(state, provider, sessionId) {
  if (state?.provider === provider && state?.sessionId === sessionId) return state;
  return { ...state, provider, sessionId, query: '', status: 'all', selectedAgentId: null };
}
