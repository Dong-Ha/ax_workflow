import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { filterAgents, getSelectedDetail, roleDisplay, transitionScope } from '../src/agent-filter.mjs';

const fixture = () => [
  { id: 'lead-1', parentId: null, role: 'orchestrator', nickname: 'Atlas Lead', status: 'inProgress' },
  { id: 'dev-1', parentId: 'lead-1', role: 'developer', nickname: 'Build Agent', status: 'inProgress' },
  { id: 'qa-1', parentId: 'dev-1', role: 'tester', nickname: 'Check Agent', status: 'unknown' },
  { id: 'review-1', parentId: null, role: 'reviewer', nickname: 'Review Agent', status: 'completed' },
  { id: 'dev-2', parentId: 'review-1', role: 'developer', nickname: 'Patch Agent', status: 'failed' },
  { id: 'ops-1', parentId: null, role: 'operator', nickname: 'Local Operator', status: 'interrupted' },
];

test('roleDisplay maps known roles and preserves unknown roles', () => {
  assert.equal(roleDisplay('developer'), '개발자');
  assert.equal(roleDisplay('WORKER_LUNA'), '워커 · 루나');
  assert.equal(roleDisplay('custom-role'), 'custom-role');
  assert.equal(roleDisplay('constructor'), 'constructor');
  assert.equal(roleDisplay('__proto__'), '__proto__');
});

test('searches only the four contract fields, trims and ignores English case', () => {
  const agents = fixture();
  assert.deepEqual([...filterAgents(agents, ' DEVELOPER ').matchedIds], ['dev-1', 'dev-2']);
  assert.deepEqual([...filterAgents(agents, '개발자').matchedIds], ['dev-1', 'dev-2']);
  assert.deepEqual([...filterAgents(agents, 'dev-2').matchedIds], ['dev-2']);
  assert.deepEqual([...filterAgents(agents, 'build').matchedIds], ['dev-1']);
  assert.deepEqual([...filterAgents(agents, 'build agent').matchedIds], ['dev-1']);
  assert.deepEqual([...filterAgents(agents, 'build  agent').matchedIds], []);
  assert.deepEqual([...filterAgents([{ ...agents[1], nickname: 'Build Agent' }], '.').matchedIds], []);
  assert.deepEqual([...filterAgents(agents.map((a) => ({ ...a, task: 'secret-marker' })), 'secret-marker').matchedIds], []);
});

const statusContract = [
  ['all', '전체', ['lead-1', 'dev-1', 'qa-1', 'review-1', 'dev-2', 'ops-1']],
  ['inProgress', '진행 중', ['lead-1', 'dev-1']],
  ['completed', '턴 완료', ['review-1']],
  ['failed', '실패', ['dev-2']],
  ['interrupted', '중단', ['ops-1']],
  ['unknown', '상태 미확인', ['qa-1']],
];
for (const [key, label, ids] of statusContract) {
  test(`status ${key} selects exact agents and keeps full counts`, () => {
    const result = filterAgents(fixture(), '', key);
    assert.deepEqual([...result.matchedIds], ids);
    assert.equal(result.totalCount, 6);
    assert.equal(result.matchedCount, ids.length);
    assert.deepEqual(result.statusCounts, { inProgress: 2, completed: 1, failed: 1, interrupted: 1, unknown: 1 });
  });
  test(`status control ${key} has exact label ${label}`, async () => {
    // Static UI contract supplements behavioral browser checks, without duplicating product mappings.
    const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const option = source.match(new RegExp(`<option value=["']${key}["']>([^<]+)</option>`));
    assert.ok(option, `Missing status option: ${key}`);
    assert.equal(option[1], label);
  });
}
test('status UI never classifies unknown as waiting', async () => {
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /<option value=["']waiting["']/);
});
test('combines search and exact status with AND', () => {
  assert.deepEqual([...filterAgents(fixture(), 'developer', 'failed').matchedIds], ['dev-2']);
  assert.deepEqual([...filterAgents(fixture(), 'developer', 'completed').matchedIds], []);
  assert.deepEqual([...filterAgents(fixture(), 'check', 'unknown').matchedIds], ['qa-1']);
  assert.deepEqual([...filterAgents(fixture(), 'check', 'interrupted').matchedIds], []);
});

test('every status combines with search without counting ancestor context as a match', () => {
  for (const [key, , ids] of statusContract) {
    const result = filterAgents(fixture(), 'developer', key);
    const expected = ids.filter(id => ['dev-1', 'dev-2'].includes(id));
    assert.deepEqual([...result.matchedIds], expected);
    assert.equal(result.matchedCount, expected.length);
    assert.equal(result.totalCount, 6);
    assert.equal(result.contextIds.has('lead-1'), expected.includes('dev-1'));
    assert.equal(result.contextIds.has('review-1'), expected.includes('dev-2'));
  }
});

test('reports whole-snapshot unique counts and actual status counts', () => {
  const agents = fixture();
  const result = filterAgents([...agents, agents[1]], 'developer', 'failed');
  assert.equal(result.totalCount, 6);
  assert.equal(result.matchedCount, 1);
  assert.deepEqual(result.statusCounts, { inProgress: 2, completed: 1, failed: 1, interrupted: 1, unknown: 1 });
});

test('shows matched descendants and their actual ancestors only, guarding missing parents and cycles', () => {
  const agents = fixture();
  const filtered = filterAgents(agents, 'check');
  assert.deepEqual([...filtered.visibleIds], ['qa-1', 'dev-1', 'lead-1']);
  assert.deepEqual([...filtered.contextIds], ['dev-1', 'lead-1']);
  assert.deepEqual(getSelectedDetail(filtered.agentsById, 'dev-1', filtered.visibleIds), {
    kind: 'selected', agent: agents[1], hidden: false,
  });
  const malformed = [
    { id: 'a', parentId: 'b', role: 'x', nickname: 'hit', status: 'unknown' },
    { id: 'b', parentId: 'a', role: 'x', nickname: 'parent', status: 'unknown' },
    { id: 'external-child', parentId: 'external-parent', role: 'x', nickname: 'hit external', status: 'unknown' },
  ];
  assert.deepEqual([...filterAgents(malformed, 'hit').visibleIds], ['a', 'external-child', 'b']);
});

test('handles empty and malformed inputs without mutating snapshot records', () => {
  assert.equal(filterAgents([], '').totalCount, 0);
  assert.equal(filterAgents(null, '').matchedCount, 0);
  const agents = [{ id: 'x', parentId: 0, role: null, nickname: null, status: 'unknown' }];
  const before = structuredClone(agents);
  const result = filterAgents(agents, null, 'invalid');
  assert.deepEqual(agents, before);
  assert.deepEqual([...result.matchedIds], ['x']);
});

test('selection distinguishes guidance, visible and hidden selection, and deleted detail', () => {
  const original = fixture();
  original[1].task = 'OLD_DETAIL task';
  original[1].result = 'OLD_DETAIL result';
  const oldResult = filterAgents(original, 'developer', 'failed');
  assert.deepEqual(getSelectedDetail(oldResult.agentsById, null, oldResult.visibleIds), { kind: 'guidance', agent: null, hidden: false });
  const hiddenDetail = getSelectedDetail(oldResult.agentsById, 'dev-1', oldResult.visibleIds);
  assert.equal(hiddenDetail.kind, 'selected');
  assert.equal(hiddenDetail.hidden, true);
  assert.equal(hiddenDetail.agent.task, 'OLD_DETAIL task');
  assert.equal(hiddenDetail.agent.result, 'OLD_DETAIL result');
  assert.deepEqual(getSelectedDetail(oldResult.agentsById, 'missing', oldResult.visibleIds), { kind: 'unavailable', agent: null, hidden: false });
  for (const visibleIds of [new Set(original.map(agent => agent.id)), oldResult.visibleIds]) {
    const removed = getSelectedDetail(new Map(original.filter((agent) => agent.id !== 'dev-1').map((agent) => [agent.id, agent])), 'dev-1', visibleIds);
    assert.deepEqual(removed, { kind: 'unavailable', agent: null, hidden: false });
    assert.equal(JSON.stringify(removed).includes('OLD_DETAIL'), false);
  }
  const emptyRefresh = { ...original[1], task: 'NEW_DETAIL task', result: '' };
  const refreshed = getSelectedDetail(new Map([['dev-1', emptyRefresh]]), 'dev-1', new Set(['dev-1']));
  assert.equal(refreshed.agent.result, '');
  assert.equal(JSON.stringify(refreshed).includes('OLD_DETAIL'), false);
});

test('provider change resets detail immediately and cannot reuse a same-ID agent', () => {
  const state = { provider: 'codex', sessionId: 's1', query: 'hello', status: 'failed', selectedAgentId: 'same-id' };
  const oldAgent = { id: 'same-id', task: 'OLD_DETAIL task', result: 'OLD_DETAIL result' };
  const oldVisible = new Set(['same-id']);
  assert.equal(transitionScope(state, 'codex', 's1'), state);
  const reset = transitionScope(state, 'claude', 's1');
  assert.deepEqual(reset, {
    provider: 'claude', sessionId: 's1', query: '', status: 'all', selectedAgentId: null,
  });
  const immediateDetail = getSelectedDetail(new Map([['same-id', oldAgent]]), reset.selectedAgentId, oldVisible);
  assert.deepEqual(immediateDetail, { kind: 'guidance', agent: null, hidden: false });
  const newAgent = { id: 'same-id', task: 'NEW_DETAIL task', result: 'NEW_DETAIL result' };
  const newDetail = getSelectedDetail(new Map([['same-id', newAgent]]), reset.selectedAgentId, new Set(['same-id']));
  assert.equal(newDetail.kind, 'guidance');
  assert.equal(JSON.stringify(newDetail).includes('OLD_DETAIL'), false);
  assert.equal(newDetail.agent, null);
});

test('session change resets detail immediately and cannot reuse a same-ID agent', () => {
  const state = { provider: 'codex', sessionId: 's1', query: 'hello', status: 'failed', selectedAgentId: 'same-id' };
  const oldAgent = { id: 'same-id', task: 'OLD_DETAIL task', result: 'OLD_DETAIL result' };
  const oldVisible = new Set(['same-id']);
  const reset = transitionScope(state, 'codex', 's2');
  assert.deepEqual(reset, {
    provider: 'codex', sessionId: 's2', query: '', status: 'all', selectedAgentId: null,
  });
  const immediateDetail = getSelectedDetail(new Map([['same-id', oldAgent]]), reset.selectedAgentId, oldVisible);
  assert.deepEqual(immediateDetail, { kind: 'guidance', agent: null, hidden: false });
  const newAgent = { id: 'same-id', task: 'NEW_DETAIL task', result: 'NEW_DETAIL result' };
  const newDetail = getSelectedDetail(new Map([['same-id', newAgent]]), reset.selectedAgentId, new Set(['same-id']));
  assert.equal(newDetail.kind, 'guidance');
  assert.equal(JSON.stringify(newDetail).includes('OLD_DETAIL'), false);
  assert.equal(newDetail.agent, null);
});

test('same-scope refresh retains filters while clear restores counts and selected detail', () => {
  const state = { provider: 'codex', sessionId: 's1', query: 'developer', status: 'failed', selectedAgentId: 'dev-1' };
  assert.equal(transitionScope(state, 'codex', 's1'), state);
  const before = filterAgents(fixture(), state.query, state.status);
  assert.equal(getSelectedDetail(before.agentsById, state.selectedAgentId, before.visibleIds).hidden, true);
  const cleared = filterAgents(fixture(), '', 'all');
  assert.equal(cleared.matchedCount, 6);
  assert.equal(getSelectedDetail(cleared.agentsById, state.selectedAgentId, cleared.visibleIds).agent.id, 'dev-1');
  assert.equal(getSelectedDetail(cleared.agentsById, state.selectedAgentId, cleared.visibleIds).hidden, false);
  const refreshed = filterAgents(fixture().map(a => a.id === 'dev-2' ? { ...a, status: 'completed' } : a), state.query, state.status);
  assert.equal(refreshed.matchedCount, 0);
  assert.equal(refreshed.totalCount, 6);
  assert.equal(refreshed.statusCounts.completed, 2);
});
