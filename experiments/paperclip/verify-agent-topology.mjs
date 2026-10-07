#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultBuildRoot = path.join(repoRoot, 'dist');
const defaultOutput = path.join(repoRoot, '.paperclip-lab/evidence/topology-verification.json');
const origin = 'http://ax-topology-verifier.invalid';
const caseTimeoutMs = 11_000;
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
};

function parseArgs(args) {
  const options = { buildRoot: defaultBuildRoot, output: defaultOutput };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== '--build-root' && flag !== '--output') throw new Error('invalid arguments');
    const value = args[index + 1];
    if (!value || value.startsWith('--') || !path.isAbsolute(value)) throw new Error('invalid arguments');
    options[flag === '--build-root' ? 'buildRoot' : 'output'] = path.resolve(value);
    index += 1;
  }
  return options;
}

function makeAgents(size, shape) {
  return Array.from({ length: size }, (_, index) => ({
    id: `probe-${shape}-${String(index).padStart(5, '0')}`,
    parentId: index === 0 ? null : shape === 'chain' ? `probe-chain-${String(index - 1).padStart(5, '0')}` : 'probe-star-00000',
    role: 'worker',
    nickname: `Synthetic ${shape} ${index}`,
    model: 'synthetic-model',
    status: 'inProgress',
    lastActivityAt: null,
    stale: false,
    task: `Synthetic task ${index}`,
    result: '',
  }));
}

function failure(result, code) {
  result.verdict = 'fail';
  if (!result.failureCodes.includes(code)) result.failureCodes.push(code);
}

async function fulfillStatic(route, buildRoot, requestURL) {
  let pathname;
  try { pathname = decodeURIComponent(requestURL.pathname); } catch { await route.abort(); return; }
  const target = path.resolve(buildRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!target.startsWith(`${buildRoot}${path.sep}`)) { await route.abort(); return; }
  try {
    const body = await readFile(target);
    const extension = path.extname(target).toLowerCase();
    await route.fulfill({ status: 200, body, contentType: mime[extension] ?? 'application/octet-stream' });
  } catch {
    await route.fulfill({ status: 404, body: 'not found', contentType: 'text/plain' });
  }
}

async function runCase(browser, buildRoot, shape, size) {
  const started = performance.now();
  const deadline = started + caseTimeoutMs;
  const result = {
    shape, size, verdict: 'fail', failureCodes: [], unexpectedRequestCount: 0,
    pageErrorCount: 0, initialRenderMs: null, initialCardCount: null,
    searchMs: null, matchSummary: null, visibleCardCount: null, contextCardCount: null,
    selectionGuidance: false, selectionDetail: false,
  };
  let context;
  let closePromise;
  let deadlineTimer;
  let resolveDeadline;
  const deadlineResult = new Promise(resolve => { resolveDeadline = resolve; });
  const closeContext = () => {
    if (!closePromise && context) closePromise = context.close().catch(() => {});
    return closePromise ?? Promise.resolve();
  };
  const boundedSnapshot = () => ({ ...result, failureCodes: [...result.failureCodes] });
  deadlineTimer = setTimeout(() => {
    failure(result, 'case-deadline-exceeded');
    const interrupt = closeContext();
    let boundTimer;
    const bound = new Promise(resolve => { boundTimer = setTimeout(resolve, 750); });
    void Promise.race([interrupt, bound]).then(() => {
      clearTimeout(boundTimer);
      resolveDeadline(boundedSnapshot());
    });
  }, caseTimeoutMs);

  const work = (async () => {
    try {
      context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
      if (performance.now() >= deadline) {
        failure(result, 'case-deadline-exceeded');
        await closeContext();
        return boundedSnapshot();
      }
      const page = await context.newPage();
      const agents = makeAgents(size, shape);
      page.on('pageerror', () => { result.pageErrorCount += 1; });
      await context.route('**/*', async route => {
        const requestURL = new URL(route.request().url());
        if (requestURL.origin !== origin) {
          result.unexpectedRequestCount += 1;
          await route.abort();
          return;
        }
        if (requestURL.pathname === '/api/dashboard') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              source: { status: 'ok' }, updatedAt: 1_900_000_000_000,
              sessions: [{ id: 'synthetic-session', title: 'Synthetic session', updatedAt: 1_900_000_000_000 }],
              selectedSessionId: 'synthetic-session', agents,
              edges: agents.filter(agent => agent.parentId).map(agent => ({ parentId: agent.parentId, childId: agent.id, closed: true })),
            }),
          });
          return;
        }
        if (/^\/api\/agents\/[^/]+\/activity$/.test(requestURL.pathname)) {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], nextCursor: null }) });
          return;
        }
        if (requestURL.pathname.startsWith('/api/')) {
          result.unexpectedRequestCount += 1;
          await route.abort();
          return;
        }
        await fulfillStatic(route, buildRoot, requestURL);
      });

      const navBudget = Math.max(500, Math.min(5_000, deadline - performance.now()));
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: navBudget });
      const initialBudget = Math.max(500, Math.min(7_000, deadline - performance.now() - 1_500));
      const initialReady = await page.waitForFunction(
        expected => document.querySelectorAll('.agent-card').length === expected,
        size,
        { timeout: initialBudget },
      ).then(() => true).catch(() => false);
      result.initialRenderMs = Number((performance.now() - started).toFixed(1));
      result.initialCardCount = await page.locator('.agent-card').count().catch(() => null);
      if (!initialReady) failure(result, 'initial-render-timeout');
      if (result.initialCardCount == null) failure(result, 'initial-card-count-unavailable');
      else if (result.initialCardCount !== size) failure(result, 'initial-card-count-mismatch');

      if (initialReady && result.initialCardCount === size && performance.now() < deadline - 2_000) {
        const searchbox = page.getByRole('searchbox', { name: '에이전트 검색' });
        result.selectionGuidance = await page.getByText('에이전트를 선택하면 상세를 볼 수 있습니다', { exact: true }).isVisible().catch(() => false);
        if (!result.selectionGuidance) failure(result, 'selection-guidance-missing');
        await page.locator('.agent-card').first().click({ timeout: Math.max(500, Math.min(2_000, deadline - performance.now())) }).catch(() => {});
        result.selectionDetail = await page.locator('.detail-identity h3').count().then(count => count > 0).catch(() => false);
        if (!result.selectionDetail) failure(result, 'selection-detail-missing');

        const lastId = `probe-${shape}-${String(size - 1).padStart(5, '0')}`;
        const searchStarted = performance.now();
        await searchbox.fill(lastId, { timeout: Math.max(500, Math.min(2_000, deadline - performance.now())) }).catch(() => {});
        const summary = `일치 1 / 전체 ${size}`;
        const searchReady = await page.waitForFunction(
          expected => document.querySelector('.filter-summary strong')?.textContent === expected,
          summary,
          { timeout: Math.max(500, deadline - performance.now()) },
        ).then(() => true).catch(() => false);
        result.searchMs = Number((performance.now() - searchStarted).toFixed(1));
        if (!searchReady) failure(result, 'search-result-timeout');
        const searchStats = await page.evaluate(() => ({
          summary: document.querySelector('.filter-summary strong')?.textContent ?? null,
          visibleCards: document.querySelectorAll('.agent-card').length,
          contextCards: document.querySelectorAll('.agent-card .context-badge').length,
        })).catch(() => null);
        if (searchStats) {
          result.matchSummary = searchStats.summary;
          result.visibleCardCount = searchStats.visibleCards;
          result.contextCardCount = searchStats.contextCards;
          const expectedVisible = shape === 'chain' ? size : 2;
          const expectedContext = shape === 'chain' ? size - 1 : 1;
          if (searchStats.summary !== summary) failure(result, 'match-summary-mismatch');
          if (searchStats.visibleCards !== expectedVisible) failure(result, 'visible-card-count-mismatch');
          if (searchStats.contextCards !== expectedContext) failure(result, 'ancestor-context-count-mismatch');
        } else {
          failure(result, 'search-dom-unavailable');
        }

        const reset = page.locator('.agent-filters').getByRole('button', { name: '필터 초기화', exact: true });
        await reset.click({ timeout: Math.max(500, Math.min(1_500, deadline - performance.now())) }).catch(() => {});
        const resetReady = await page.waitForFunction(
          expected => document.querySelector('.filter-summary strong')?.textContent === expected,
          `일치 ${size} / 전체 ${size}`,
          { timeout: Math.max(500, deadline - performance.now()) },
        ).then(() => true).catch(() => false);
        if (!resetReady) failure(result, 'filter-reset-mismatch');
        const resetStats = await page.evaluate(() => ({
          cards: document.querySelectorAll('.agent-card').length,
          contextCards: document.querySelectorAll('.agent-card .context-badge').length,
        })).catch(() => null);
        if (!resetStats || resetStats.cards !== size) failure(result, 'filter-reset-card-count-mismatch');
        if (!resetStats || resetStats.contextCards !== 0) failure(result, 'filter-reset-context-count-mismatch');
      } else if (initialReady && result.initialCardCount === size) {
        failure(result, 'case-time-budget-exhausted');
      }

      if (result.pageErrorCount > 0) failure(result, 'page-error');
      if (result.unexpectedRequestCount > 0) failure(result, 'unexpected-request');
      if (result.failureCodes.length === 0) result.verdict = 'pass';
    } catch {
      failure(result, 'browser-navigation-or-evaluation-failed');
      if (result.pageErrorCount > 0) failure(result, 'page-error');
      if (result.unexpectedRequestCount > 0) failure(result, 'unexpected-request');
    } finally {
      await closeContext();
    }
    return result;
  })();
  const outcome = await Promise.race([work, deadlineResult]);
  clearTimeout(deadlineTimer);
  return outcome;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const buildRoot = await import('node:fs/promises').then(({ realpath }) => realpath(options.buildRoot));
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const shape of ['chain', 'star']) {
      for (const size of [100, 1_000, 3_000]) results.push(await runCase(browser, buildRoot, shape, size));
    }
  } finally {
    await browser.close();
  }
  const report = {
    schemaVersion: 1,
    suite: 'offline synthetic agent topology verifier',
    verdict: results.length === 6 && results.every(item => item.verdict === 'pass' && item.failureCodes.length === 0 && item.unexpectedRequestCount === 0 && item.pageErrorCount === 0) ? 'pass' : 'fail',
    buildRoot,
    generatedAt: new Date().toISOString(),
    requestPolicy: 'synthetic API and build assets locally fulfilled; all other requests aborted',
    cases: results,
  };
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(JSON.stringify({ evidence: options.output, verdict: report.verdict, cases: results.map(({ shape, size, verdict, failureCodes, initialRenderMs, initialCardCount, searchMs, visibleCardCount, contextCardCount }) => ({ shape, size, verdict, failureCodes, initialRenderMs, initialCardCount, searchMs, visibleCardCount, contextCardCount })) }) + '\n');
  if (report.verdict !== 'pass') process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write('agent topology verification failed to run\n');
  process.exitCode = 2;
});
