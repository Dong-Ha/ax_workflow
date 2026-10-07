#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STATUSES = ['inProgress', 'completed', 'failed', 'interrupted', 'unknown'];
const FILTERS = ['all', ...STATUSES];
const ROLE_LABELS = Object.freeze({
  main: '조정자', orchestrator: '조정자', worker: '워커', worker_luna: '워커 · 루나',
  senior_sol: '선임 · 솔', expert_astra: '전문가 · 아스트라', developer: '개발자',
  tester: '테스트 담당자', reviewer: '검토자', operator: '운영자',
});

function parseArgs(argv) {
  const options = { module: path.join(ROOT, 'src/agent-filter.mjs'), output: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key !== '--module' && key !== '--output') throw new Error('unknown option');
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error('missing option value');
    if (key === '--module') options.module = value;
    else options.output = value;
  }
  if (!path.isAbsolute(options.module)) throw new Error('--module must be an absolute path');
  if (options.output && !path.isAbsolute(options.output)) throw new Error('--output must be an absolute path');
  return options;
}

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function choose(random, values) {
  return values[Math.floor(random() * values.length)];
}

function referenceFilter(agents, query, requestedStatus) {
  const rows = new Map();
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (agent && typeof agent.id === 'string' && !rows.has(agent.id)) rows.set(agent.id, agent);
  }
  const normalized = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const status = FILTERS.includes(requestedStatus) ? requestedStatus : 'all';
  const matched = new Set();
  const visible = new Set();
  const counts = Object.fromEntries(STATUSES.map((item) => [item, 0]));

  for (const [id, row] of rows) {
    if (Object.hasOwn(counts, row.status)) counts[row.status] += 1;
    const role = typeof row.role === 'string' ? row.role : '';
    const display = Object.hasOwn(ROLE_LABELS, role.toLowerCase()) ? ROLE_LABELS[role.toLowerCase()] : role;
    const textMatches = normalized === '' || [row.nickname, id, role, display]
      .some((field) => typeof field === 'string' && field.toLowerCase().includes(normalized));
    if (textMatches && (status === 'all' || row.status === status)) matched.add(id);
  }

  for (const id of matched) {
    visible.add(id);
    const seen = new Set([id]);
    let parentId = rows.get(id)?.parentId;
    while (typeof parentId === 'string' && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = rows.get(parentId);
      if (!parent) break;
      visible.add(parentId);
      parentId = parent.parentId;
    }
  }
  const context = new Set([...visible].filter((id) => !matched.has(id)));
  return {
    matched, visible, context,
    totalCount: rows.size,
    matchedCount: matched.size,
    statusCounts: counts,
  };
}

function makeCases() {
  const random = makeRandom(0x7a5b3c1d);
  const roles = ['worker', 'worker_luna', 'tester', 'operator', 'unknown-role', '개발자'];
  const names = ['Alpha', 'beta', '검토자', 'delta', '루나 워커'];
  const queries = ['', ' ', ' ALP ', '검토', 'worker', '조정자', 'absent'];
  const filters = [...FILTERS, 'unsupported'];
  const cases = [];
  let duplicateIdCases = 0;
  let missingParentEdges = 0;
  let explicitCycleGraphs = 0;
  let graphEdges = 0;

  for (let caseIndex = 0; caseIndex < 500; caseIndex += 1) {
    const size = 5 + Math.floor(random() * 55);
    const rows = [];
    for (let i = 0; i < size; i += 1) {
      const parentChoice = random();
      let parentId;
      if (i > 0 && parentChoice < 0.72) parentId = `node-${Math.floor(random() * size)}`;
      else if (parentChoice < 0.88) parentId = `missing-${Math.floor(random() * 12)}`;
      const row = {
        id: `node-${i}`,
        nickname: choose(random, names),
        role: choose(random, roles),
        status: choose(random, [...STATUSES, 'invalid', undefined]),
      };
      if (parentId !== undefined) {
        row.parentId = parentId;
        graphEdges += 1;
        if (!/^node-\d+$/.test(parentId) || Number(parentId.slice(5)) >= size) missingParentEdges += 1;
      }
      rows.push(row);
    }
    if (caseIndex % 4 === 0) {
      const duplicate = rows[Math.floor(random() * rows.length)];
      rows.push({ ...duplicate, nickname: `duplicate-${caseIndex}`, status: choose(random, STATUSES) });
      duplicateIdCases += 1;
    }
    if (caseIndex % 4 === 1 && size > 1) {
      rows[size - 1].parentId = 'node-0';
      rows[0].parentId = `node-${size - 1}`;
      explicitCycleGraphs += 1;
    }
    cases.push({ rows, query: choose(random, queries), status: choose(random, filters) });
  }
  return { cases, duplicateIdCases, missingParentEdges, explicitCycleGraphs, graphEdges };
}

function sameSet(left, right) {
  return left instanceof Set && left.size === right.size && [...right].every((value) => left.has(value));
}

function compareResult(actual, expected) {
  return sameSet(actual.matchedIds, expected.matched)
    && sameSet(actual.visibleIds, expected.visible)
    && sameSet(actual.contextIds, expected.context)
    && actual.totalCount === expected.totalCount
    && actual.matchedCount === expected.matchedCount
    && JSON.stringify(actual.statusCounts) === JSON.stringify(expected.statusCounts);
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

function roundMs(value) {
  return Number(value.toFixed(3));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const moduleUrl = pathToFileURL(options.module);
  moduleUrl.searchParams.set('verify', `${Date.now()}-${process.pid}`);
  const { filterAgents } = await import(moduleUrl.href);
  if (typeof filterAgents !== 'function') throw new Error('module does not export filterAgents');

  const generated = makeCases();
  let mismatches = 0;
  for (const testCase of generated.cases) {
    if (!compareResult(
      filterAgents(testCase.rows, testCase.query, testCase.status),
      referenceFilter(testCase.rows, testCase.query, testCase.status),
    )) mismatches += 1;
  }

  const performanceResults = [];
  for (const size of [100, 1_000, 3_000]) {
    const chain = Array.from({ length: size }, (_, index) => ({
      id: `chain-${index}`,
      parentId: index === 0 ? undefined : `chain-${index - 1}`,
      nickname: `Agent ${index}`,
      role: 'worker',
      status: 'completed',
    }));
    filterAgents(chain, '', 'all');
    const samplesMs = [];
    for (let sample = 0; sample < 7; sample += 1) {
      const start = performance.now();
      const result = filterAgents(chain, '', 'all');
      samplesMs.push(performance.now() - start);
      if (result.matchedCount !== size || result.visibleIds.size !== size) mismatches += 1;
    }
    performanceResults.push({ size, medianMs: roundMs(median(samplesMs)), runs: 7 });
  }

  const report = {
    seed: '0x7a5b3c1d',
    synthetic: {
      cases: generated.cases.length,
      mismatches,
      duplicateIdCases: generated.duplicateIdCases,
      missingParentEdges: generated.missingParentEdges,
      explicitCycleGraphs: generated.explicitCycleGraphs,
      graphEdges: generated.graphEdges,
    },
    chainAllMatch: performanceResults,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) await writeFile(options.output, serialized, { encoding: 'utf8', flag: 'w' });
  else process.stdout.write(serialized);
  if (mismatches > 0) process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write('agent-filter verification failed\n');
  process.exitCode = 2;
});
