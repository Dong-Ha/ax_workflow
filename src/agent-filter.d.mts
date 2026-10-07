export type FilterStatus = 'all' | 'inProgress' | 'completed' | 'failed' | 'interrupted' | 'unknown';
export type AgentFilterStatus = FilterStatus;

export interface FilterAgent {
  id: string;
  parentId?: string | null;
  role?: string;
  nickname?: string;
  status?: string;
  [field: string]: unknown;
}

export interface AgentFilterResult<T extends FilterAgent = FilterAgent> {
  agentsById: Map<string, T>;
  matchedIds: Set<string>;
  visibleIds: Set<string>;
  contextIds: Set<string>;
  totalCount: number;
  matchedCount: number;
  statusCounts: Record<'inProgress' | 'completed' | 'failed' | 'interrupted' | 'unknown', number>;
}

export function roleDisplay(role: string): string;
export function filterAgents<T extends FilterAgent>(
  agents: readonly T[],
  query?: string,
  status?: FilterStatus,
): AgentFilterResult<T>;
export function getSelectedDetail<T extends FilterAgent>(
  agents: Map<string, T> | readonly T[],
  selectedId: string | null | undefined,
  visibleIds: Set<string>,
): { kind: 'guidance' | 'unavailable'; agent: null; hidden: false } | { kind: 'selected'; agent: T; hidden: boolean };
export interface ScopeState {
  provider: string;
  sessionId: string;
  query: string;
  status: FilterStatus;
  selectedAgentId: string | null;
}

export function transitionScope<T extends ScopeState>(
  state: T,
  provider: string,
  sessionId: string,
): Omit<T, 'provider' | 'sessionId' | 'query' | 'status' | 'selectedAgentId'> & ScopeState;
