#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultBuildRoot = path.join(repoRoot, 'dist');
const defaultOutput = path.join(repoRoot, '.paperclip-lab/evidence/navigation-verification.json');
const origin = 'http://ax-navigation-verifier.invalid';
const caseTimeoutMs = 15_000;
const requestPolicy = 'synthetic API and build assets locally fulfilled; all other requests aborted';
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const names = { next: '다음 일치 항목', previous: '이전 일치 항목' };

function parseArgs(args) {
  const options = { buildRoot: defaultBuildRoot, output: defaultOutput };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!['--build-root', '--output'].includes(flag) || !value || value.startsWith('--') || !path.isAbsolute(value)) throw new Error('invalid arguments');
    options[flag === '--build-root' ? 'buildRoot' : 'output'] = path.resolve(value);
    index += 1;
  }
  return options;
}

function agent(id, parentId, nickname, role = 'worker', status = 'inProgress') {
  return { id, parentId, nickname, role, status, model: 'synthetic-model', lastActivityAt: null, stale: false, task: `TASK_${id}`, result: `RESULT_${id}` };
}

function deepAgents(size = 3_000) {
  return Array.from({ length: size }, (_, index) => agent(
    `deep-${String(index).padStart(5, '0')}`,
    index === 0 ? null : `deep-${String(index - 1).padStart(5, '0')}`,
    `Deep Agent ${index}`,
  ));
}

function scopedAgents(provider, sessionId) {
  const prefix = `${provider}-${sessionId}`;
  return [
    agent(`selected-${prefix}`, null, 'Selected Old', 'operator', 'failed'),
    agent(`target-${prefix}-a`, null, 'Target Alpha'),
    agent(`target-${prefix}-b`, null, 'Target Beta'),
  ];
}

function scenarioData(name, provider, sessionId) {
  switch (name) {
    case 'deep-desktop':
    case 'deep-mobile': return deepAgents();
    case 'next-previous-wrap': return [
      agent('siblings-root', null, 'Sibling Context', 'orchestrator', 'completed'),
      agent('sibling-alpha', 'siblings-root', 'Sibling Match Alpha'),
      agent('sibling-beta', 'siblings-root', 'Sibling Match Beta'),
      agent('sibling-nonmatch', 'siblings-root', 'Other Child', 'worker', 'failed'),
    ];
    case 'filter-cursor-reset': return [
      agent('topology-root', null, 'Topology Root', 'orchestrator', 'completed'),
      agent('filter-alpha', 'topology-root', 'Filter Alpha'),
      agent('filter-beta', 'topology-root', 'Filter Beta One', 'worker', 'failed'),
      agent('filter-gamma', 'topology-root', 'Filter Beta Two', 'worker', 'failed'),
    ];
    case 'scope-cursor-reset': return scopedAgents(provider, sessionId);
    case 'hidden-selection-retained': return [
      agent('hidden-selected', null, 'Hidden Selected', 'operator', 'completed'),
      agent('visible-match-a', null, 'Navigation Match Alpha'),
      agent('visible-match-b', null, 'Navigation Match Beta'),
    ];
    default: return [];
  }
}

function siblingSnapshot(phase) {
  const root = agent('siblings-root', null, 'Sibling Context', 'orchestrator', 'completed');
  const alpha = agent('sibling-alpha', 'siblings-root', 'Sibling Match Alpha');
  const beta = agent('sibling-beta', 'siblings-root', phase === 'rename-beta' ? 'Renamed Child' : 'Sibling Match Beta');
  const other = agent('sibling-nonmatch', 'siblings-root', 'Other Child', 'worker', 'failed');
  if (phase === 'reorder') return [root, beta, alpha, other];
  if (phase === 'rename-beta') return [root, alpha, beta, other];
  return [root, alpha, beta, other];
}

async function serveStatic(route, buildRoot, requestURL) {
  let pathname;
  try { pathname = decodeURIComponent(requestURL.pathname); } catch { await route.abort(); return; }
  const target = path.resolve(buildRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!target.startsWith(`${buildRoot}${path.sep}`)) { await route.abort(); return; }
  try {
    await route.fulfill({ status: 200, body: await readFile(target), contentType: mime[path.extname(target).toLowerCase()] ?? 'application/octet-stream' });
  } catch {
    await route.fulfill({ status: 404, body: 'not found', contentType: 'text/plain' });
  }
}

function recordCheck(result, passed, code) {
  if (passed) result.checkCount += 1;
  else if (!result.failureCodes.includes(code)) result.failureCodes.push(code);
  return passed;
}

function control(page, direction) {
  return page.locator('.agent-filters').getByRole('button', { name: names[direction], exact: true });
}

async function readState(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('.topology-canvas');
    const cards = [...document.querySelectorAll('.agent-card')];
    const detail = document.querySelector('.detail-panel');
    const position = document.querySelector('.agent-filters [role="status"][aria-label="일치 항목 이동 위치"]');
    return {
      summary: document.querySelector('.filter-summary strong')?.textContent ?? null,
      ids: cards.map(card => card.querySelector('.agent-id')?.textContent ?? ''),
      contextIds: cards.filter(card => card.querySelector('.context-badge')).map(card => card.querySelector('.agent-id')?.textContent ?? ''),
      selectedIds: cards.filter(card => card.getAttribute('aria-pressed') === 'true').map(card => card.querySelector('.agent-id')?.textContent ?? ''),
      detailName: detail?.querySelector('.detail-identity h3')?.textContent ?? null,
      detailTask: detail?.querySelector('.task-text')?.textContent ?? null,
      guidance: !!detail?.innerText.includes('에이전트를 선택하면 상세를 볼 수 있습니다'),
      hiddenSelection: !!detail?.querySelector('.hidden-selection'),
      canvasScrollTop: canvas?.scrollTop ?? null,
      cardCount: cards.length,
      contextCount: document.querySelectorAll('.context-badge').length,
      uniqueCount: new Set(cards.map(card => card.querySelector('.agent-id')?.textContent)).size,
      positionStatusFound: !!position,
      positionLive: position?.getAttribute('aria-live') === 'polite',
      positionText: position?.textContent?.trim() ?? null,
    };
  });
}

function expectPosition(result, state, index, total, code) {
  recordCheck(result, state.positionStatusFound && state.positionLive, `${code}-polite-status`);
  recordCheck(result, state.positionText === `이동 위치 ${index} / ${total}`, `${code}-value`);
}

async function checkPosition(result, page, index, total, code) {
  expectPosition(result, await readState(page), index, total, code);
}

async function cardTarget(page, id) {
  return page.locator('.agent-card').filter({ has: page.locator('.agent-id', { hasText: new RegExp(`^${id}$`) }) }).first();
}

async function waitForSummary(page, matchedCount, totalCount, timeout = 3_000) {
  const text = `일치 ${matchedCount} / 전체 ${totalCount}`;
  await page.waitForFunction(expected => document.querySelector('.filter-summary strong')?.textContent === expected, text, { timeout });
}

async function activate(result, page, direction, expectedId, method = 'click') {
  const locator = control(page, direction);
  const beforeState = await readState(page);
  const count = await locator.count().catch(() => 0);
  if (!recordCheck(result, count === 1, `${direction}-control-count`)) return null;
  const visible = await locator.isVisible().catch(() => false);
  const enabled = await locator.isEnabled().catch(() => false);
  if (!recordCheck(result, visible && enabled, `${direction}-control-unavailable`)) return null;
  try {
    if (method === 'click') await locator.click({ timeout: 2_500 });
    else await locator.press(method, { timeout: 2_500 });
  } catch {
    recordCheck(result, false, `${direction}-activation-failed`);
    return null;
  }
  const target = await cardTarget(page, expectedId);
  const state = await target.evaluate(element => {
    const canvas = document.querySelector('.topology-canvas');
    const rect = element.getBoundingClientRect();
    const clip = canvas.getBoundingClientRect();
    return {
      focused: document.activeElement === element,
      intersectsCanvas: rect.bottom > clip.top && rect.top < clip.bottom && rect.right > clip.left && rect.left < clip.right,
      intersectsWindow: rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth,
      scrollTop: canvas.scrollTop,
    };
  }).catch(() => null);
  if (!recordCheck(result, state?.focused === true, `${direction}-target-not-focused`)) return state;
  recordCheck(result, state?.intersectsCanvas === true, `${direction}-target-not-visible-in-canvas`);
  const afterState = await readState(page);
  recordCheck(result,
    JSON.stringify(afterState.selectedIds) === JSON.stringify(beforeState.selectedIds)
      && afterState.detailName === beforeState.detailName
      && afterState.detailTask === beforeState.detailTask
      && afterState.guidance === beforeState.guidance,
    `${direction}-changed-selection-or-detail`,
  );
  return state;
}

async function controlsUnavailableWithoutMatches(result, page) {
  for (const direction of ['next', 'previous']) {
    const locator = control(page, direction);
    const count = await locator.count().catch(() => 0);
    const unavailable = count === 0 || !(await locator.isVisible().catch(() => false)) || !(await locator.isEnabled().catch(() => false));
    recordCheck(result, unavailable, `${direction}-available-with-no-match`);
  }
}

async function runCase(browser, buildRoot, name) {
  const result = { name, verdict: 'fail', failureCodes: [], unexpectedRequestCount: 0, pageErrorCount: 0, checkCount: 0 };
  let context;
  let closePromise;
  let deadlineTimer;
  let resolveDeadline;
  let deadlineExceeded = false;
  const deadlineResult = new Promise(resolve => { resolveDeadline = resolve; });
  const closeContext = () => {
    if (!closePromise && context) closePromise = context.close().catch(() => {});
    return closePromise ?? Promise.resolve();
  };
  const snapshot = () => ({ ...result, failureCodes: [...result.failureCodes] });
  deadlineTimer = setTimeout(() => {
    deadlineExceeded = true;
    recordCheck(result, false, 'case-deadline-exceeded');
    const close = closeContext();
    let boundTimer;
    const bound = new Promise(resolve => { boundTimer = setTimeout(resolve, 750); });
    void Promise.race([close, bound]).then(() => {
      clearTimeout(boundTimer);
      resolveDeadline(snapshot());
    });
  }, caseTimeoutMs);

  const work = (async () => {
    try {
      const viewport = name === 'deep-mobile' ? { width: 360, height: 850 } : { width: 1440, height: 1000 };
      context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      if (deadlineExceeded) {
        await closeContext();
        return snapshot();
      }
      const page = await context.newPage();
      page.setDefaultTimeout(3_000);
      page.on('pageerror', () => { result.pageErrorCount += 1; });
      let activeProvider = 'codex';
      let initialScopeKey = null;
      let sameScopeDashboardRefreshes = 0;
      let dashboardRequestCount = 0;
      let siblingPhase = 'stable';
      let latestRootRevision = null;
      await context.route('**/*', async route => {
        const requestURL = new URL(route.request().url());
        if (requestURL.origin !== origin) {
          result.unexpectedRequestCount += 1;
          await route.abort();
          return;
        }
        if (requestURL.pathname === '/api/dashboard') {
          dashboardRequestCount += 1;
          const provider = requestURL.searchParams.get('provider') || activeProvider;
          const sessionId = requestURL.searchParams.get('sessionId') || 's1';
          activeProvider = provider;
          const scopeKey = `${provider}/${sessionId}`;
          if (initialScopeKey === null) initialScopeKey = scopeKey;
          else if (scopeKey === initialScopeKey) sameScopeDashboardRefreshes += 1;
          let agents = name === 'next-previous-wrap'
            ? siblingSnapshot(siblingPhase)
            : scenarioData(name, provider, sessionId);
          const updatedAt = 1_900_000_000_000 + dashboardRequestCount;
          if (name === 'next-previous-wrap') {
            latestRootRevision = `synthetic-poll-revision-${dashboardRequestCount}`;
            agents = agents.map(item => item.id === 'siblings-root' ? { ...item, model: latestRootRevision } : item);
          }
          await route.fulfill({ status: 200, json: {
            source: { status: 'ok' }, updatedAt,
            selectedSessionId: sessionId,
            sessions: [{ id: 's1', title: 'Synthetic One', updatedAt: 1_900_000_000_000 }, { id: 's2', title: 'Synthetic Two', updatedAt: 1_900_000_000_000 }],
            agents, edges: agents.filter(item => item.parentId).map(item => ({ parentId: item.parentId, childId: item.id, closed: true })),
          } });
        } else if (/^\/api\/agents\/[^/]+\/activity$/.test(requestURL.pathname)) {
          await route.fulfill({ status: 200, json: { items: [], nextCursor: null } });
        } else if (requestURL.pathname.startsWith('/api/')) {
          result.unexpectedRequestCount += 1;
          await route.abort();
        } else {
          await serveStatic(route, buildRoot, requestURL);
        }
      });

      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 6_000 });
      const initialTotal = name.startsWith('deep-') ? 3_000 : name === 'next-previous-wrap' ? 4 : name === 'filter-cursor-reset' ? 4 : name === 'hidden-selection-retained' ? 3 : 3;
      await page.waitForFunction(expected => document.querySelectorAll('.agent-card').length === expected, initialTotal, { timeout: 6_000 });
      let initial = await readState(page);
      recordCheck(result, initial.cardCount === initialTotal && initial.uniqueCount === initialTotal, 'initial-card-count');
      recordCheck(result, initial.summary === `일치 ${initialTotal} / 전체 ${initialTotal}`, 'initial-count-summary');
      recordCheck(result, initial.selectedIds.length === 0 && initial.guidance, 'initial-no-selection-guidance');
      if (name === 'next-previous-wrap' && latestRootRevision) {
        try {
          await page.waitForFunction(expected => {
            const card = [...document.querySelectorAll('.agent-card')].find(item => item.querySelector('.agent-id')?.textContent === 'siblings-root');
            return card?.querySelector('.agent-model')?.textContent === expected;
          }, latestRootRevision, { timeout: 2_000 });
          recordCheck(result, true, 'initial-sibling-revision-rendered');
        } catch {
          recordCheck(result, false, 'initial-sibling-revision-rendered');
        }
        initial = await readState(page);
      }
      expectPosition(result, initial, 0, initialTotal, 'initial-position');

      const waitForRenderedDashboardPoll = async (requestCount, phaseCode) => {
        const requestDeadline = Date.now() + 3_500;
        while (dashboardRequestCount <= requestCount && Date.now() < requestDeadline) {
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        const observed = dashboardRequestCount > requestCount;
        recordCheck(result, observed, `${phaseCode}-poll-observed`);
        if (!observed || !latestRootRevision) return false;
        try {
          await page.waitForFunction(expected => {
            const card = [...document.querySelectorAll('.agent-card')].find(item => item.querySelector('.agent-id')?.textContent === 'siblings-root');
            return card?.querySelector('.agent-model')?.textContent === expected;
          }, latestRootRevision, { timeout: 2_000 });
          recordCheck(result, true, `${phaseCode}-revision-rendered`);
          return true;
        } catch {
          recordCheck(result, false, `${phaseCode}-revision-rendered`);
          return false;
        }
      };
      const ensureSiblingRevision = async checkCode => {
        if (!latestRootRevision) {
          recordCheck(result, false, `${checkCode}-revision-missing`);
          return false;
        }
        try {
          await page.waitForFunction(expected => {
            const card = [...document.querySelectorAll('.agent-card')].find(item => item.querySelector('.agent-id')?.textContent === 'siblings-root');
            return card?.querySelector('.agent-model')?.textContent === expected;
          }, latestRootRevision, { timeout: 2_000 });
          recordCheck(result, true, `${checkCode}-revision-committed`);
          return true;
        } catch {
          recordCheck(result, false, `${checkCode}-revision-committed`);
          return false;
        }
      };
      const checkSiblingPosition = async (index, total, code) => {
        await ensureSiblingRevision(code);
        await checkPosition(result, page, index, total, code);
      };
      const activateSibling = async (direction, id, method, code) => {
        await ensureSiblingRevision(code);
        return activate(result, page, direction, id, method);
      };

      if (name === 'deep-desktop' || name === 'deep-mobile') {
        const lastId = 'deep-02999';
        await page.getByRole('searchbox', { name: '에이전트 검색' }).fill(lastId);
        await waitForSummary(page, 1, 3_000);
        await checkPosition(result, page, 0, 1, 'deep-query-reset-position');
        let state = await readState(page);
        recordCheck(result, state.ids.length === 3_000 && state.uniqueCount === 3_000, 'deep-card-count');
        recordCheck(result, state.contextCount === 2_999 && state.contextIds.includes('deep-02998'), 'deep-ancestor-context');
        recordCheck(result, state.selectedIds.length === 0 && state.guidance, 'deep-selection-unchanged');
        await activate(result, page, 'next', lastId, 'Enter');
        await checkPosition(result, page, 1, 1, 'deep-next-position');
        state = await readState(page);
        recordCheck(result, state.selectedIds.length === 0 && state.guidance, 'deep-next-does-not-select');
        const previous = await activate(result, page, 'previous', lastId, 'Space');
        await checkPosition(result, page, 1, 1, 'deep-previous-wrap-position');
        recordCheck(result, previous?.focused === true && previous?.intersectsCanvas === true, 'deep-previous-visible');
        state = await readState(page);
        recordCheck(result, state.selectedIds.length === 0 && state.guidance, 'deep-previous-does-not-select');
      }

      if (name === 'next-previous-wrap') {
        await page.getByRole('searchbox', { name: '에이전트 검색' }).fill('Sibling Match');
        await waitForSummary(page, 2, 4);
        await checkSiblingPosition(0, 2, 'sibling-query-reset-position');
        const filtered = await readState(page);
        recordCheck(result, JSON.stringify(filtered.ids.slice().sort()) === JSON.stringify(['siblings-root', 'sibling-alpha', 'sibling-beta'].sort()), 'sibling-visible-ids');
        recordCheck(result, JSON.stringify(filtered.contextIds) === JSON.stringify(['siblings-root']), 'sibling-context-only');
        recordCheck(result, filtered.selectedIds.length === 0 && filtered.guidance, 'sibling-selection-unchanged');
        let target = await activateSibling('next', 'sibling-alpha', 'Enter', 'next-first');
        recordCheck(result, target?.intersectsCanvas === true, 'next-first-match-visible');
        await checkSiblingPosition(1, 2, 'next-first-position');
        const refreshBaseline = dashboardRequestCount;
        const renderedStablePoll = await waitForRenderedDashboardPoll(refreshBaseline, 'stable-same-scope');
        recordCheck(result, sameScopeDashboardRefreshes > 0, 'same-scope-poll-observed');
        recordCheck(result, renderedStablePoll, 'same-scope-dashboard-committed');
        const afterPoll = await readState(page);
        recordCheck(result,
          afterPoll.summary === '일치 2 / 전체 4'
            && JSON.stringify(afterPoll.ids.slice().sort()) === JSON.stringify(['siblings-root', 'sibling-alpha', 'sibling-beta'].sort()),
          'poll-preserves-match-and-card-counts',
        );
        recordCheck(result, JSON.stringify(afterPoll.contextIds) === JSON.stringify(['siblings-root']), 'poll-preserves-context');
        recordCheck(result, afterPoll.selectedIds.length === 0 && afterPoll.guidance, 'poll-preserves-selection-detail');
        expectPosition(result, afterPoll, 1, 2, 'poll-preserves-navigation-position');
        target = await activateSibling('next', 'sibling-beta', 'Space', 'next-second');
        recordCheck(result, target?.intersectsCanvas === true, 'next-second-match-visible');
        await checkSiblingPosition(2, 2, 'next-second-position');
        target = await activateSibling('next', 'sibling-alpha', 'click', 'next-wrap');
        recordCheck(result, target?.intersectsCanvas === true, 'next-wraps-first');
        await checkSiblingPosition(1, 2, 'next-wrap-position');
        target = await activateSibling('previous', 'sibling-beta', 'Enter', 'previous-wrap');
        recordCheck(result, target?.intersectsCanvas === true, 'previous-wraps-last');
        await checkSiblingPosition(2, 2, 'previous-wrap-position');
        target = await activateSibling('previous', 'sibling-alpha', 'Space', 'previous-second');
        recordCheck(result, target?.intersectsCanvas === true, 'previous-second-match');
        await checkSiblingPosition(1, 2, 'previous-second-position');
        target = await activateSibling('previous', 'sibling-beta', 'click', 'previous-last-again');
        recordCheck(result, target?.intersectsCanvas === true, 'previous-wraps-last-again');
        await checkSiblingPosition(2, 2, 'previous-second-wrap-position');
        const after = await readState(page);
        recordCheck(result, after.selectedIds.length === 0 && after.guidance, 'sibling-navigation-does-not-select');

        let requestBaseline = dashboardRequestCount;
        siblingPhase = 'reorder';
        const renderedReorder = await waitForRenderedDashboardPoll(requestBaseline, 'reorder-same-scope');
        await waitForSummary(page, 2, 4);
        const reordered = await readState(page);
        recordCheck(result, renderedReorder, 'reorder-snapshot-committed');
        recordCheck(result,
          JSON.stringify(reordered.ids) === JSON.stringify(['siblings-root', 'sibling-beta', 'sibling-alpha'])
            && JSON.stringify(reordered.contextIds) === JSON.stringify(['siblings-root']),
          'reorder-visible-tree-order',
        );
        expectPosition(result, reordered, 1, 2, 'reorder-preserves-beta-cursor-identity');
        recordCheck(result, reordered.selectedIds.length === 0 && reordered.guidance, 'reorder-preserves-selection-detail');

        requestBaseline = dashboardRequestCount;
        siblingPhase = 'rename-beta';
        const renderedRename = await waitForRenderedDashboardPoll(requestBaseline, 'rename-current-match');
        await waitForSummary(page, 1, 4);
        const renamed = await readState(page);
        recordCheck(result, renderedRename, 'rename-snapshot-committed');
        recordCheck(result,
          JSON.stringify(renamed.ids) === JSON.stringify(['siblings-root', 'sibling-alpha'])
            && JSON.stringify(renamed.contextIds) === JSON.stringify(['siblings-root']),
          'removed-match-leaves-root-and-alpha',
        );
        expectPosition(result, renamed, 0, 1, 'removed-current-match-resets-position');
        recordCheck(result, renamed.selectedIds.length === 0 && renamed.guidance, 'removed-match-preserves-detail-guidance');
        const activeIdAfterRemoval = await page.evaluate(() => document.activeElement?.closest('.agent-card')?.querySelector('.agent-id')?.textContent ?? null);
        recordCheck(result, activeIdAfterRemoval !== 'sibling-alpha', 'removed-match-does-not-autofocus-remaining-match');
        target = await activateSibling('next', 'sibling-alpha', 'click', 'next-after-removal');
        recordCheck(result, target?.intersectsCanvas === true, 'next-after-removal-visible');
        await checkSiblingPosition(1, 1, 'next-after-removal-position');
      }

      if (name === 'filter-cursor-reset') {
        const search = page.getByRole('searchbox', { name: '에이전트 검색' });
        const status = page.getByLabel('상태', { exact: true });
        await search.fill('Filter');
        await waitForSummary(page, 3, 4);
        await checkPosition(result, page, 0, 3, 'query-filter-reset-position');
        await activate(result, page, 'next', 'filter-alpha', 'click');
        await checkPosition(result, page, 1, 3, 'filter-first-position');
        await activate(result, page, 'next', 'filter-beta', 'click');
        await checkPosition(result, page, 2, 3, 'filter-second-position');
        await search.fill('Filter Beta');
        await waitForSummary(page, 2, 4);
        await checkPosition(result, page, 0, 2, 'query-reset-position');
        await activate(result, page, 'next', 'filter-beta', 'click');
        await checkPosition(result, page, 1, 2, 'query-reset-first-position');
        recordCheck(result, (await readState(page)).selectedIds.length === 0, 'query-reset-no-selection');
        await search.fill('Filter');
        await waitForSummary(page, 3, 4);
        await checkPosition(result, page, 0, 3, 'query-restore-reset-position');
        await activate(result, page, 'next', 'filter-alpha', 'click');
        await checkPosition(result, page, 1, 3, 'query-restore-first-position');
        await status.selectOption('failed');
        await waitForSummary(page, 2, 4);
        await checkPosition(result, page, 0, 2, 'status-reset-position');
        await activate(result, page, 'next', 'filter-beta', 'click');
        await checkPosition(result, page, 1, 2, 'status-reset-first-position');
        recordCheck(result, (await readState(page)).summary === '일치 2 / 전체 4', 'status-reset-count');
        await search.fill('no-navigation-match');
        await waitForSummary(page, 0, 4);
        await checkPosition(result, page, 0, 0, 'no-match-position');
        await controlsUnavailableWithoutMatches(result, page);
        await page.locator('.agent-filters').getByRole('button', { name: '필터 초기화', exact: true }).click();
        await waitForSummary(page, 4, 4);
        await checkPosition(result, page, 0, 4, 'clear-reset-position');
        await activate(result, page, 'next', 'topology-root', 'click');
        await checkPosition(result, page, 1, 4, 'clear-first-position');
        const cleared = await readState(page);
        recordCheck(result, cleared.contextCount === 0 && cleared.summary === '일치 4 / 전체 4', 'clear-resets-cursor-and-context');
        recordCheck(result, cleared.selectedIds.length === 0 && cleared.guidance, 'clear-no-selection');
      }

      if (name === 'scope-cursor-reset') {
        const search = page.getByRole('searchbox', { name: '에이전트 검색' });
        const status = page.getByLabel('상태', { exact: true });
        const selected = await cardTarget(page, 'selected-codex-s1');
        await selected.click();
        await search.fill('Target');
        await status.selectOption('failed');
        await waitForSummary(page, 0, 3);
        await checkPosition(result, page, 0, 0, 'scope-no-match-position');
        await controlsUnavailableWithoutMatches(result, page);
        await search.fill('Target');
        await status.selectOption('inProgress');
        await waitForSummary(page, 2, 3);
        await checkPosition(result, page, 0, 2, 'scope-query-status-reset-position');
        await activate(result, page, 'next', 'target-codex-s1-a', 'click');
        await checkPosition(result, page, 1, 2, 'scope-first-position');
        await activate(result, page, 'next', 'target-codex-s1-b', 'click');
        await checkPosition(result, page, 2, 2, 'scope-second-position');
        await page.getByLabel('관제 도구 선택').selectOption('claude');
        await page.waitForFunction(() => document.querySelector('.agent-id')?.textContent === 'selected-claude-s1', null, { timeout: 5_000 }).catch(() => {});
        let state = await readState(page);
        recordCheck(result, state.summary === '일치 3 / 전체 3' && state.selectedIds.length === 0 && state.guidance, 'provider-resets-filter-and-selection');
        expectPosition(result, state, 0, 3, 'provider-reset-position');
        await search.fill('Target');
        await status.selectOption('inProgress');
        await waitForSummary(page, 2, 3);
        await checkPosition(result, page, 0, 2, 'provider-query-reset-position');
        await activate(result, page, 'next', 'target-claude-s1-a', 'click');
        await checkPosition(result, page, 1, 2, 'provider-first-position');
        await page.getByLabel('모니터링 세션 선택').selectOption('s2');
        await page.waitForFunction(() => document.querySelector('.agent-id')?.textContent === 'selected-claude-s2', null, { timeout: 5_000 }).catch(() => {});
        state = await readState(page);
        recordCheck(result, state.summary === '일치 3 / 전체 3' && state.selectedIds.length === 0 && state.guidance, 'session-resets-filter-and-selection');
        expectPosition(result, state, 0, 3, 'session-reset-position');
        await search.fill('Target');
        await status.selectOption('inProgress');
        await waitForSummary(page, 2, 3);
        await checkPosition(result, page, 0, 2, 'session-query-reset-position');
        const focus = await activate(result, page, 'next', 'target-claude-s2-a', 'click');
        await checkPosition(result, page, 1, 2, 'session-first-position');
        recordCheck(result, focus?.focused === true && focus?.intersectsCanvas === true, 'scope-cursor-starts-first-match');
        recordCheck(result, (await readState(page)).selectedIds.length === 0, 'scope-navigation-no-selection');
      }

      if (name === 'hidden-selection-retained') {
        await (await cardTarget(page, 'hidden-selected')).click();
        await page.waitForFunction(() => document.querySelector('.detail-identity h3')?.textContent === 'Hidden Selected', null, { timeout: 3_000 });
        let state = await readState(page);
        const detailBefore = { name: state.detailName, task: state.detailTask };
        await page.getByRole('searchbox', { name: '에이전트 검색' }).fill('Navigation Match Alpha');
        await waitForSummary(page, 1, 3);
        await checkPosition(result, page, 0, 1, 'hidden-selection-query-reset-position');
        state = await readState(page);
        recordCheck(result, state.hiddenSelection && state.detailName === detailBefore.name && state.detailTask === detailBefore.task, 'hidden-detail-retained-before-navigation');
        const focus = await activate(result, page, 'next', 'visible-match-a', 'click');
        await checkPosition(result, page, 1, 1, 'hidden-selection-first-position');
        state = await readState(page);
        recordCheck(result, focus?.focused === true && focus?.intersectsCanvas === true, 'hidden-match-focused-and-visible');
        recordCheck(result, JSON.stringify(state.selectedIds) === JSON.stringify([]), 'hidden-selection-not-rendered');
        recordCheck(result, state.hiddenSelection && state.detailName === detailBefore.name && state.detailTask === detailBefore.task, 'hidden-selection-detail-unchanged');
      }

      if (result.unexpectedRequestCount > 0) recordCheck(result, false, 'unexpected-request');
      if (result.pageErrorCount > 0) recordCheck(result, false, 'page-error');
      if (result.checkCount < 4) recordCheck(result, false, 'insufficient-contract-checks');
      if (result.failureCodes.length === 0 && result.checkCount >= 4 && !result.pageErrorCount && !result.unexpectedRequestCount) result.verdict = 'pass';
    } catch {
      if (!result.failureCodes.includes('case-execution-failed')) result.failureCodes.push('case-execution-failed');
      if (result.unexpectedRequestCount > 0 && !result.failureCodes.includes('unexpected-request')) result.failureCodes.push('unexpected-request');
      if (result.pageErrorCount > 0 && !result.failureCodes.includes('page-error')) result.failureCodes.push('page-error');
    } finally {
      await closeContext();
    }
    return snapshot();
  })();

  const resultSnapshot = await Promise.race([work, deadlineResult]);
  clearTimeout(deadlineTimer);
  return resultSnapshot;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { realpath } = await import('node:fs/promises');
  const buildRoot = await realpath(options.buildRoot);
  const browser = await chromium.launch({ headless: true });
  const caseNames = ['deep-desktop', 'deep-mobile', 'next-previous-wrap', 'filter-cursor-reset', 'scope-cursor-reset', 'hidden-selection-retained'];
  const cases = [];
  try {
    for (const name of caseNames) cases.push(await runCase(browser, buildRoot, name));
  } finally {
    await browser.close();
  }
  const verdict = cases.length === 6 && cases.every(item => item.verdict === 'pass' && item.failureCodes.length === 0 && item.unexpectedRequestCount === 0 && item.pageErrorCount === 0 && item.checkCount >= 4) ? 'pass' : 'fail';
  const report = { schemaVersion: 1, suite: 'offline synthetic match navigation verifier', verdict, buildRoot, generatedAt: new Date().toISOString(), requestPolicy, cases };
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(JSON.stringify({ evidence: options.output, verdict, cases }) + '\n');
  if (verdict !== 'pass') process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write('agent navigation verification failed to start\n');
  process.exitCode = 2;
});
