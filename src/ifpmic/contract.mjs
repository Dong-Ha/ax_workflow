// Read-only projection of the supplied IFPMIC v1 design. This does not execute steps.
const owners = ['spec-gen', 'tc', 'code-dev', 'arch-runner', 'sqe', 'report', 'human', 'system'];
const phaseLabels = ['기획과 분석', '요구사항과 시험 계획', '설계', '개발', '품질관리', '검증과 배포'];
const requiredIds = [...Array.from({ length: 26 }, (_, i) => `P${String(i + 1).padStart(2, '0')}`), 'X01', 'X02', 'X03'];

export function safeText(value, limit = 12000) {
  if (typeof value !== 'string') return '';
  return value.slice(0, limit).replace(/\b(?:sk-[\w-]{12,}|Bearer\s+[\w.\/-]{12,})/g, '[인증 정보 숨김]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[숨김]');
}

function assert(condition, message) {
  if (!condition) throw new Error(`IFPMIC 계약 오류: ${message}`);
}

export function buildWorkflowGraph(workflow) {
  assert(workflow && typeof workflow === 'object', 'workflow is required');
  assert(Array.isArray(workflow.nodes) && workflow.nodes.length === 29, '29 nodes required');
  assert(workflow.start === 'P01' && workflow.terminal === 'END', 'invalid start or terminal');
  assert(Array.isArray(workflow.roles) && owners.every(owner => workflow.roles.includes(owner)) && workflow.roles.every(owner => owners.includes(owner)), 'unknown owner/roles');
  const ids = new Set();
  const nodes = workflow.nodes.map(node => {
    assert(node && typeof node === 'object' && requiredIds.includes(node.id) && !ids.has(node.id), 'duplicate or unknown node ID');
    ids.add(node.id);
    assert(Number.isInteger(node.phase) && node.phase >= 1 && node.phase <= 6, 'unknown phase');
    assert(owners.includes(node.owner), 'unknown owner');
    assert(['NEVER', 'REUSE', 'POLICY', 'COUPLED'].includes(node.skip_policy), 'unknown skip policy');
    assert(['original', 'extension'].includes(node.source), 'unknown source');
    const result = { id: node.id, phase: node.phase, owner: node.owner, skip_policy: node.skip_policy, source: node.source };
    for (const field of ['label', 'input', 'output', 'pass_criterion']) {
      assert(typeof node[field] === 'string' && node[field].trim().length > 0, `missing ${field}`);
      result[field] = safeText(node[field], field === 'label' ? 240 : 12000);
    }
    return Object.freeze(result);
  });
  assert(requiredIds.every(id => ids.has(id)), 'missing node ID');
  const edges = [];
  for (const node of workflow.nodes) {
    assert(typeof node.on_pass === 'string' && (ids.has(node.on_pass) || node.on_pass === 'END'), 'unknown pass target');
    edges.push(Object.freeze({ id: `${node.id}:pass:${node.on_pass}`, from: node.id, to: node.on_pass, kind: 'pass' }));
    assert(node.on_business_fail === null || ids.has(node.on_business_fail), 'unknown failure target');
    if (node.on_business_fail !== null) edges.push(Object.freeze({ id: `${node.id}:business_fail:${node.on_business_fail}`, from: node.id, to: node.on_business_fail, kind: 'business_fail' }));
  }
  const visited = new Set();
  let current = 'P01';
  while (current !== 'END' && !visited.has(current)) {
    visited.add(current);
    current = workflow.nodes.find(node => node.id === current).on_pass;
  }
  assert(current === 'END' && visited.size === 29, 'success path must reach END through all nodes');
  assert(workflow.special_outcomes && typeof workflow.special_outcomes === 'object' && !Array.isArray(workflow.special_outcomes), 'special outcomes required');
  const outcomes = Object.entries(workflow.special_outcomes).map(([key, target]) => {
    const [from, event, ...extra] = key.split('.');
    assert(ids.has(from) && event && extra.length === 0, 'unknown special outcome source');
    const isTransition = ids.has(target);
    assert(isTransition || ['WAITING_HUMAN', 'RECONCILING', 'retry_notes_only'].includes(target), 'unknown special outcome target');
    if (isTransition) edges.push(Object.freeze({ id: `${from}:special:${event}:${target}`, from, to: target, kind: 'special', outcome: event }));
    return Object.freeze({ from, event, target, isTransition });
  });
  const phases = phaseLabels.map((label, i) => Object.freeze({ id: i + 1, label, nodes: Object.freeze(nodes.filter(node => node.phase === i + 1)) }));
  assert(phases.every(phase => phase.nodes.length), 'empty phase');
  return Object.freeze({ nodes: Object.freeze(nodes), edges: Object.freeze(edges), phases: Object.freeze(phases), outcomes: Object.freeze(outcomes) });
}

export function filterWorkflowNodes(graph, { query = '', owner = 'all' } = {}) {
  const needle = safeText(query).trim().toLocaleLowerCase();
  return graph.nodes.filter(node => (owner === 'all' || owner === '' || node.owner === owner)
    && (!needle || `${node.id} ${node.label} ${node.owner}`.toLocaleLowerCase().includes(needle)));
}

export const ownerLabels = Object.freeze({ 'spec-gen': '사양 분석', tc: 'TC 작성', 'code-dev': '개발 총괄', 'arch-runner': '품질 측정', sqe: '단말 검증', report: '보고·배포자료', human: '사람', system: '시스템 판정' });

// Only step IDs explicitly named by requirements.json's `design` field.
// These are source-document references, not execution evidence or generated trace links.
export function requirementsForNode(node) {
  const refs = {
    'REQ-01': Array.from({ length: 26 }, (_, index) => `P${String(index + 1).padStart(2, '0')}`),
    'REQ-02': ['P02', 'X01'],
    'REQ-03': ['P15', 'P16', 'P17', 'P18'],
    'REQ-04': ['P22', 'P23', 'P24'],
    'REQ-05': ['P06', 'P07', 'P08', 'P10', 'P21'],
    'REQ-06': ['P09', 'P12'],
    'REQ-09': ['P25'],
    'REQ-10': ['X03'],
  };
  return Object.entries(refs).filter(([, ids]) => ids.includes(node.id)).map(([id]) => id);
}
