import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildWorkflowGraph, filterWorkflowNodes, requirementsForNode } from '../src/ifpmic/contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specs = path.join(root, 'docs/ifpmic/design-v1/specs');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const loadJson = async file => JSON.parse(await readFile(path.join(specs, file), 'utf8'));
const workflow = await loadJson('workflow.v1.json');

// Fixed contract oracle: intentionally not derived from workflow.v1.json. Updating
// the source contract alone must cause a reviewable test failure, not bless itself.
const passEdges = [
  ['P01', 'P02'], ['P02', 'P03'], ['P03', 'P04'], ['P04', 'P05'], ['P05', 'X01'],
  ['X01', 'P06'], ['P06', 'P07'], ['P07', 'P08'], ['P08', 'P09'], ['P09', 'P10'],
  ['P10', 'P11'], ['P11', 'P12'], ['P12', 'P13'], ['P13', 'P14'], ['P14', 'P15'],
  ['P15', 'P16'], ['P16', 'P17'], ['P17', 'P18'], ['P18', 'P19'], ['P19', 'P20'],
  ['P20', 'P21'], ['P21', 'P22'], ['P22', 'P23'], ['P23', 'P24'], ['P24', 'X02'],
  ['X02', 'X03'], ['X03', 'P25'], ['P25', 'P26'], ['P26', 'END'],
].map(([from, to]) => ({ from, to, kind: 'pass' }));
const failedEdges = [
  ['P13', 'P11'], ['P14', 'P11'], ['P16', 'P07'], ['P18', 'P11'],
  ['P20', 'P11'], ['P21', 'P11'], ['P24', 'P07'],
].map(([from, to]) => ({ from, to, kind: 'business_fail' }));
const specialEdges = [
  ['X01', 'P02'], ['P21', 'P07'], ['X03', 'P11'], ['X03', 'P07'], ['X03', 'X02'],
].map(([from, to]) => ({ from, to, kind: 'special' }));
const expectedOutcomes = [
  { from: 'P03', event: 'unresolved', target: 'WAITING_HUMAN', isTransition: false },
  { from: 'X01', event: 'rejected', target: 'P02', isTransition: true },
  { from: 'P21', event: 'design_change_needed', target: 'P07', isTransition: true },
  { from: 'X03', event: 'reject_code', target: 'P11', isTransition: true },
  { from: 'X03', event: 'reject_design', target: 'P07', isTransition: true },
  { from: 'X03', event: 'reject_release_metadata', target: 'X02', isTransition: true },
  { from: 'P25', event: 'unknown_remote_state', target: 'RECONCILING', isTransition: false },
  { from: 'P26', event: 'failure', target: 'retry_notes_only', isTransition: false },
];
const expectedNodeIds = [
  'P01', 'P02', 'P03', 'P04', 'P05', 'X01', 'P06', 'P07', 'P08', 'P09', 'P10',
  'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19', 'P20', 'P21',
  'P22', 'P23', 'P24', 'X02', 'X03', 'P25', 'P26',
];
const phaseOracle = [
  { id: 1, label: '기획과 분석', nodes: ['P01', 'P02', 'P03', 'P04'] },
  { id: 2, label: '요구사항과 시험 계획', nodes: ['P05', 'X01', 'P06'] },
  { id: 3, label: '설계', nodes: ['P07', 'P08', 'P09'] },
  { id: 4, label: '개발', nodes: ['P10', 'P11', 'P12', 'P13', 'P14'] },
  { id: 5, label: '품질관리', nodes: ['P15', 'P16', 'P17', 'P18', 'P19', 'P20', 'P21'] },
  { id: 6, label: '검증과 배포', nodes: ['P22', 'P23', 'P24', 'X02', 'X03', 'P25', 'P26'] },
];
const edgeKey = ({ from, to, kind }) => `${from}|${kind}|${to}`;

test('buildWorkflowGraph matches fixed IFPMIC node, phase, edge and outcome oracle', () => {
  const graph = buildWorkflowGraph(workflow);
  assert.deepEqual(graph.nodes.map(node => node.id), expectedNodeIds);
  assert.deepEqual(graph.phases.map(phase => ({
    ...phase,
    nodes: phase.nodes.map(node => typeof node === 'string' ? node : node.id),
  })), phaseOracle);
  assert.deepEqual(graph.outcomes, expectedOutcomes);
  assert.equal(graph.nodes.length, 29);
  assert.equal(graph.phases.length, 6);
  assert.equal(graph.nodes.filter(node => node.owner === 'human').length, 7);
  assert.equal(graph.edges.length, 41);
  assert.deepEqual(
    graph.edges.map(edgeKey).sort(),
    [...passEdges, ...failedEdges, ...specialEdges].map(edgeKey).sort(),
  );
  assert.equal(graph.edges.some(edge => edge.to === 'END'), true);
  assert.equal(graph.nodes.some(node => node.id === 'END'), false);
  assert.equal(graph.outcomes.length, 8);
  assert.equal(graph.outcomes.filter(outcome => !outcome.isTransition).length, 3);
});

test('graph preserves only the public node fields and sanitizes display text without mutating source', () => {
  const raw = structuredClone(workflow);
  raw.hidden_runtime_secret = 'ROOT_PRIVATE_SHOULD_NOT_LEAK';
  raw.nodes[0].tool_input = 'NODE_PRIVATE_SHOULD_NOT_LEAK';
  raw.nodes[0].reasoning = 'REASONING_PRIVATE_SHOULD_NOT_LEAK';
  raw.nodes[0].input = 'Bearer abcdefghijklmnop api_key=topsecret';
  const before = structuredClone(raw);

  const graph = buildWorkflowGraph(raw);
  assert.deepEqual(raw, before);
  assert.deepEqual(Object.keys(graph.nodes[0]).sort(), [
    'id', 'phase', 'label', 'owner', 'input', 'output', 'pass_criterion', 'skip_policy', 'source',
  ].sort());
  const serialized = JSON.stringify(graph);
  assert.doesNotMatch(serialized, /ROOT_PRIVATE_SHOULD_NOT_LEAK|NODE_PRIVATE_SHOULD_NOT_LEAK|REASONING_PRIVATE_SHOULD_NOT_LEAK/);
  assert.match(graph.nodes[0].input, /\[인증 정보 숨김\]/);
  assert.match(graph.nodes[0].input, /api_key=\[숨김\]/);
});

test('filterWorkflowNodes searches visible contract fields and combines owner filter', () => {
  const graph = buildWorkflowGraph(workflow);
  const before = structuredClone(graph);
  assert.deepEqual(filterWorkflowNodes(graph, { query: ' 요구사항 ', owner: 'spec-gen' }).map(node => node.id), ['P01', 'P02']);
  assert.deepEqual(filterWorkflowNodes(graph, { query: 'SAM', owner: 'arch-runner' }).map(node => node.id), ['P15']);
  assert.deepEqual(filterWorkflowNodes(graph, { query: 'not a stage', owner: '' }), []);
  assert.deepEqual(filterWorkflowNodes(graph, { query: '', owner: 'human' }).map(node => node.id), ['X01', 'P06', 'P07', 'P08', 'P10', 'P21', 'X03']);
  assert.deepEqual(graph, before);
});

test('requirementsForNode exposes only requirement.json source references, not inferred evidence trace', async () => {
  const graph = buildWorkflowGraph(workflow);
  const requirements = await loadJson('requirements.json');
  const nodesById = new Map(graph.nodes.map(node => [node.id, node]));
  const fixedCases = {
    P01: ['REQ-01'],
    X01: ['REQ-02'],
    P07: ['REQ-01', 'REQ-05'],
    P19: ['REQ-01'],
    P12: ['REQ-01', 'REQ-06'],
    X03: ['REQ-10'],
    X02: [],
  };
  for (const [nodeId, expected] of Object.entries(fixedCases)) {
    assert.deepEqual(requirementsForNode(nodesById.get(nodeId)), expected, `${nodeId} source references`);
  }

  for (const node of graph.nodes) {
    const directReferences = requirements.filter(requirement => requirementDesignReferencesNode(requirement.design, node.id)).map(requirement => requirement.id);
    assert.deepEqual(requirementsForNode(node), directReferences, `${node.id} must match original design references only`);
  }
});

test('buildWorkflowGraph rejects malformed shape, duplicate IDs and unknown owners or references', () => {
  assert.throws(() => buildWorkflowGraph(null));
  assert.throws(() => buildWorkflowGraph({ ...workflow, nodes: {} }));

  const duplicate = structuredClone(workflow);
  duplicate.nodes[1].id = duplicate.nodes[0].id;
  assert.throws(() => buildWorkflowGraph(duplicate), /duplicate|중복/i);

  const unknownOwner = structuredClone(workflow);
  unknownOwner.nodes[0].owner = 'mystery-agent';
  assert.throws(() => buildWorkflowGraph(unknownOwner), /owner|담당/i);

  const unknownPhase = structuredClone(workflow);
  unknownPhase.nodes[0].phase = 7;
  assert.throws(() => buildWorkflowGraph(unknownPhase), /phase|단계/i);

  const unknownNodeReference = structuredClone(workflow);
  unknownNodeReference.nodes[0].on_pass = 'MISSING';
  assert.throws(() => buildWorkflowGraph(unknownNodeReference), /reference|target|참조/i);

  const unknownSpecialSource = structuredClone(workflow);
  unknownSpecialSource.special_outcomes['MISSING.event'] = 'P02';
  assert.throws(() => buildWorkflowGraph(unknownSpecialSource), /reference|source|참조/i);

  const blankId = structuredClone(workflow);
  blankId.nodes[0].id = '  ';
  assert.throws(() => buildWorkflowGraph(blankId));

  const missingPassEdge = structuredClone(workflow);
  delete missingPassEdge.nodes[0].on_pass;
  assert.throws(() => buildWorkflowGraph(missingPassEdge));

  const emptyLabel = structuredClone(workflow);
  emptyLabel.nodes[0].label = '';
  assert.throws(() => buildWorkflowGraph(emptyLabel));

  const unknownOutcomeTarget = structuredClone(workflow);
  unknownOutcomeTarget.special_outcomes['X01.rejected'] = 'UNKNOWN_TARGET';
  assert.throws(() => buildWorkflowGraph(unknownOutcomeTarget));
});

test('Paperclip host runner rejects unsafe base URLs before any fetch can run', () => {
  const fetchTrap = 'data:text/javascript,globalThis.fetch=()=>{throw new Error(%22NETWORK_TRAP_REACHED%22)}';
  const invalidUrls = [
    'https://127.0.0.1:3100/',
    'http://paperclip.invalid/',
    'http://user:password@127.0.0.1:3100/',
    'http://127.0.0.1:3100/api/health',
    'http://127.0.0.1:3100/?tenant=unexpected',
    'http://127.0.0.1:3100/#fragment',
  ];
  for (const value of invalidUrls) {
    const child = spawnSync(process.execPath, [
      '--import', fetchTrap, 'tests/ifpmic-host.browser.mjs', '--validate-url-only',
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, IFPMIC_PAPERCLIP_URL: value },
    });
    assert.notEqual(child.error?.code, 'ETIMEDOUT', `URL validation timed out: ${value}`);
    assert.equal(child.status, 1, `unsafe URL must fail before runner setup: ${value}`);
    assert.match(child.stderr, /IFPMIC_PAPERCLIP_URL must be a local HTTP root URL/);
    assert.doesNotMatch(child.stderr, /NETWORK_TRAP_REACHED/);
  }
});

test('V0 verification plan matches its independently approved publication fingerprint', async () => {
  const [plan, reviewBytes] = await Promise.all([
    readFile(path.join(root, 'docs/ifpmic/VERIFICATION.md')),
    readFile(path.join(root, 'docs/ifpmic/evidence/plan-review.json')),
  ]);
  const review = JSON.parse(reviewBytes.toString('utf8'));
  const publishedHash = 'b0f1e0dbe74f1a6aae5e84218f672fcb42d0db6133e072d66e92d21d2bb1ef98';
  assert.equal(review.decision, 'approved_for_V0_V1_V2_implementation');
  assert.equal(review.published_plan_sha256, publishedHash, 'published oracle changes require review/test update');
  assert.equal(sha256(plan), review.published_plan_sha256);
});

test('V0 requirement, acceptance and backlog trace coverage is complete', async () => {
  const [requirements, acceptance, backlog] = await Promise.all([
    loadJson('requirements.json'), loadJson('acceptance-cases.json'), loadJson('implementation-backlog.json'),
  ]);
  assert.equal(requirements.length, 15);
  assert.deepEqual(requirements.map(row => row.id), Array.from({ length: 15 }, (_, index) => `REQ-${String(index + 1).padStart(2, '0')}`));
  assert.equal(acceptance.length, 32);
  assert.deepEqual(acceptance.map(row => row.id), Array.from({ length: 32 }, (_, index) => `AT-${String(index + 1).padStart(2, '0')}`));
  assert.equal(backlog.length, 13);
  assert.deepEqual(backlog.map(row => row.id), Array.from({ length: 13 }, (_, index) => `B${String(index + 1).padStart(2, '0')}`));

  const acceptanceIds = new Set(acceptance.map(row => row.id));
  const backlogCovered = new Set(backlog.flatMap(row => row.acceptance));
  for (const requirement of requirements) assert.ok(acceptanceIds.has(requirement.acceptance), `${requirement.id} -> ${requirement.acceptance}`);
  for (const id of acceptanceIds) assert.ok(backlogCovered.has(id), `${id} must be covered by an implementation backlog item`);
  for (const item of backlog) for (const id of item.acceptance) assert.ok(acceptanceIds.has(id), `${item.id} -> ${id}`);
});

function requirementDesignReferencesNode(design, nodeId) {
  const ids = new Set();
  const tokens = String(design).match(/\b[PX]\d{2}(?:-[PX]\d{2})?\b/g) || [];
  for (const token of tokens) {
    const [start, end] = token.split('-');
    if (!end) { ids.add(start); continue; }
    const startPrefix = start[0];
    const endPrefix = end[0];
    if (startPrefix !== endPrefix) continue;
    const from = Number(start.slice(1));
    const to = Number(end.slice(1));
    const step = from <= to ? 1 : -1;
    for (let value = from; ; value += step) {
      ids.add(`${startPrefix}${String(value).padStart(2, '0')}`);
      if (value === to) break;
    }
  }
  return ids.has(nodeId);
}
