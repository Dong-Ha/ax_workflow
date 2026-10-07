import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Offline Playwright smoke: every request is fulfilled or aborted; never contact the verification host.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'workflow-artifacts');
// Independent verification uses the current canonical npm run build output.
const buildRoot = path.join(root, 'dist');
const verifyURL = new URL(process.env.AX_VERIFY_URL || 'http://ax-smoke.invalid/');
if (!['http:', 'https:'].includes(verifyURL.protocol) || verifyURL.username || verifyURL.password) {
  throw new Error('Verification URL must be an HTTP origin without credentials');
}
const origin = verifyURL.origin;
const contracts = [
  ['all', '전체', 6], ['inProgress', '진행 중', 2], ['completed', '턴 완료', 1],
  ['failed', '실패', 1], ['interrupted', '중단', 1], ['unknown', '상태 미확인', 1],
];
function agents(scope) {
  return [
    ['lead-1', null, 'orchestrator', 'Atlas Lead', 'inProgress'],
    ['dev-1', 'lead-1', 'developer', 'Build Agent', 'inProgress'],
    ['qa-1', 'dev-1', 'tester', 'Check Agent', 'unknown'],
    ['review-1', null, 'reviewer', 'Review Agent', 'completed'],
    ['dev-2', 'review-1', 'developer', 'Patch Agent', 'failed'],
    ['ops-1', null, 'operator', 'Local Operator', 'interrupted'],
  ].map(([id, parentId, role, nickname, status]) => ({
    id, parentId, role, nickname, status, model: 'synthetic-model', stale: false,
    lastActivityAt: null, task: `TASK_${scope}_${id}`, result: `RESULT_${scope}_${id}`,
    reasoning: 'PRIVATE_SYNTHETIC_MARKER', toolInput: 'PRIVATE_SYNTHETIC_MARKER',
  }));
}
async function eventually(check, message, timeout = 5500) {
  const end = Date.now() + timeout;
  do {
    try { await check(); return; } catch { /* Retain contract expectation until UI settles. */ }
    await new Promise(resolve => setTimeout(resolve, 30));
  } while (Date.now() < end);
  throw new Error(message);
}
const results = [];
let browser;
let screenshotSaved = false;
async function harness() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const state = { removed: null, refreshed: false, empty: false, fail: false, gate: null, pending: [], dashboardRequests: 0, unexpected: 0, activityGate: null };
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { state.unexpected++; await route.abort(); return; }
    if (url.pathname === '/api/dashboard') {
      state.dashboardRequests++;
      const provider = url.searchParams.get('provider') || 'codex';
      const session = url.searchParams.get('sessionId') || 's1';
      const scope = `${provider}_${session}`;
      let snapshot = state.empty ? [] : agents(scope).filter(a => a.id !== state.removed);
      if (state.refreshed) snapshot = snapshot.map(a => a.id === 'dev-2' ? { ...a, status: 'completed', result: '' } : a);
      const body = { source: { status: 'ok' }, updatedAt: 1900000000000, selectedSessionId: session,
        sessions: [{ id: 's1', title: 'Synthetic One', updatedAt: 1900000000000 }, { id: 's2', title: 'Synthetic Two', updatedAt: 1900000000000 }],
        agents: snapshot, edges: snapshot.filter(a => a.parentId).map(a => ({ parentId: a.parentId, childId: a.id, closed: true })),
      };
      if (state.gate?.(provider, session)) await new Promise(resolve => state.pending.push(resolve));
      await route.fulfill({ status: state.fail ? 503 : 200, json: body }).catch(() => {});
      return;
    }
    if (/^\/api\/agents\/[^/]+\/activity$/.test(url.pathname)) {
      const scope = `${url.searchParams.get('provider')}_${url.searchParams.get('sessionId')}`;
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      if (state.activityGate) await new Promise(resolve => state.pending.push(resolve));
      const older = url.searchParams.has('before');
      await route.fulfill({ json: { items: [{ id: older ? 'older' : 'recent', type: 'message', label: 'Synthetic activity', timestamp: null, text: `ACTIVITY_${scope}_${id}_${older ? 'older' : 'recent'}` }], nextCursor: older ? null : 1 } }).catch(() => {});
      return;
    }
    if (url.pathname.startsWith('/api/')) { state.unexpected++; await route.abort(); return; }
    let relative;
    try { relative = decodeURIComponent(url.pathname).replace(/^\/+/, ''); } catch { state.unexpected++; await route.abort(); return; }
    if (url.href === verifyURL.href || !relative || relative.endsWith('index.html')) relative = 'index.html';
    const target = path.resolve(buildRoot, relative);
    if (!target.startsWith(buildRoot + path.sep)) { state.unexpected++; await route.abort(); return; }
    try {
      const body = await readFile(target);
      const contentType = target.endsWith('.js') ? 'application/javascript' : target.endsWith('.css') ? 'text/css' : target.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
      await route.fulfill({ contentType, body });
    } catch { state.unexpected++; await route.abort(); }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(2500);
  await page.goto(verifyURL.href, { waitUntil: 'domcontentloaded' });
  await page.locator('.agent-card').first().waitFor();
  const search = page.getByRole('searchbox', { name: '에이전트 검색' });
  const status = page.getByLabel('상태', { exact: true });
  const detail = page.locator('.detail-panel');
  const card = id => page.locator('.agent-card').filter({ has: page.locator('.agent-id', { hasText: new RegExp(`^${id}$`) }) });
  const clear = () => page.locator('.agent-filters').getByRole('button', { name: '필터 초기화' }).click();
  const count = (m, n = 6) => eventually(async () => assert.equal(await page.locator('.filter-summary strong').innerText(), `일치 ${m} / 전체 ${n}`), 'Matching and whole-snapshot counts must be exact');
  const guidance = () => eventually(async () => {
    assert.match(await detail.innerText(), /에이전트를 선택하면 상세를 볼 수 있습니다/);
    assert.doesNotMatch(await detail.innerText(), /TASK_|RESULT_|ACTIVITY_/);
    assert.equal(await page.locator('.agent-card[aria-pressed="true"]').count(), 0);
  }, 'Scope reset must remove detail/activity and show guidance without auto-selection');
  return { page, context, state, search, status, detail, card, clear, count, guidance };
}
async function check(name, action) {
  let h;
  try {
    h = await harness();
    await action(h);
    assert.equal(h.state.unexpected, 0, 'All requests must remain within offline mocked routes');
    results.push({ name, verdict: 'pass' });
  } catch {
    // Findings expose scenario names only, never errors with environment values or raw page/API content.
    results.push({ name, verdict: 'fail', finding: `Acceptance check failed: ${name}` });
  } finally {
    if (h) { h.state.pending.splice(0).forEach(resolve => resolve()); await h.context.close(); }
  }
}
await mkdir(artifacts, { recursive: true });
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update'] });
  await check('Initial guidance and no default selection', async h => { await h.guidance(); await h.count(6); });
  for (const [key, label, amount] of contracts) {
    await check(`Status ${key} exact option label and matching count`, async h => {
      const option = h.status.locator(`option[value="${key}"]`);
      assert.equal(await option.count(), 1, 'Required status key must exist');
      assert.equal(await option.innerText(), label);
      const summary = '진행 중 2 · 턴 완료 1 · 실패 1 · 중단 1 · 상태 미확인 1';
      assert.equal(await h.page.locator('.filter-summary > span').first().innerText(), summary);
      await h.status.selectOption(key); await h.count(amount);
      assert.equal(await h.page.locator('.filter-summary > span').first().innerText(), summary);
      assert.equal(await h.status.inputValue(), key);
      if (key !== 'all') {
        const matchedCards = h.page.locator('.agent-card').filter({ hasNot: h.page.locator('.context-badge') });
        assert.equal(await matchedCards.count(), amount);
        for (const c of await matchedCards.all()) assert.match(await c.locator('.agent-card-foot').innerText(), new RegExp(label));
      }
    });
  }
  await check('No waiting reinterpretation or extra status options', async h => {
    assert.deepEqual(await h.status.locator('option').evaluateAll(nodes => nodes.map(n => [n.value, n.textContent])), contracts.map(([key, label]) => [key, label]));
    assert.doesNotMatch(await h.page.locator('.agent-filters').innerText(), /대기/);
  });
  await check('Name ID original and Korean role searches and normalization', async h => {
    for (const [query, amount, ids] of [['build', 1, ['dev-1']], ['dev-2', 1, ['dev-2']], [' DEVELOPER ', 2, ['dev-1', 'dev-2']], ['개발자', 2, ['dev-1', 'dev-2']], ['테스트 담당자', 1, ['qa-1']]]) {
      await h.search.fill(query); await h.count(amount);
      for (const id of ids) assert.equal(await h.card(id).count(), 1);
      assert.equal(await h.search.evaluate(n => n === document.activeElement), true);
    }
    await h.search.fill('build  agent'); await h.count(0);
  });
  await check('AND filtering and full-snapshot status summary', async h => {
    const summary = await h.page.locator('.filter-summary > span').first().innerText();
    await h.search.fill('developer'); await h.status.selectOption('failed'); await h.count(1);
    assert.equal(await h.card('dev-2').count(), 1); assert.equal(await h.card('dev-1').count(), 0);
    assert.equal(await h.card('review-1').locator('.context-badge').count(), 1);
    assert.equal(await h.page.locator('.filter-summary > span').first().innerText(), summary);
    await h.status.selectOption('completed'); await h.count(0);
  });
  await check('Descendant path retains only real ancestors as context and allows context selection', async h => {
    await h.search.fill('check'); await h.count(1);
    assert.equal(await h.page.locator('.agent-card').count(), 3);
    assert.equal(await h.page.locator('.context-badge').count(), 2);
    for (const id of ['qa-1', 'dev-1', 'lead-1']) assert.equal(await h.card(id).count(), 1);
    assert.equal(await h.card('dev-2').count(), 0);
    await h.card('lead-1').click(); assert.match(await h.detail.innerText(), /TASK_codex_s1_lead-1/);
  });
  await check('Hidden selection survives filters no match and clear without changing counts', async h => {
    await h.card('dev-1').click(); await h.search.fill('developer'); await h.status.selectOption('failed'); await h.count(1);
    assert.match(await h.detail.innerText(), /TASK_codex_s1_dev-1/);
    assert.match(await h.detail.innerText(), /현재 필터에서 숨겨져/);
    await h.search.fill('no-such-agent'); await h.count(0);
    assert.match(await h.page.locator('.list-empty').innerText(), /조건에 맞는 에이전트가 없습니다/);
    assert.match(await h.detail.innerText(), /TASK_codex_s1_dev-1/);
    await h.detail.getByRole('button', { name: '필터 초기화' }).click(); await h.count(6);
    assert.equal(await h.search.inputValue(), ''); assert.equal(await h.status.inputValue(), 'all');
    assert.match(await h.detail.innerText(), /TASK_codex_s1_dev-1/);
    assert.equal(await h.card('dev-1').getAttribute('aria-pressed'), 'true');
  });
  for (const kind of ['provider', 'session']) {
    await check(`${kind} reset immediately clears filters detail activity and retains guidance with same IDs`, async h => {
      await h.card('dev-1').click();
      await eventually(async () => assert.match(await h.detail.innerText(), /ACTIVITY_codex_s1_dev-1/), 'Synthetic activity must render');
      await h.search.fill('developer'); await h.status.selectOption('failed');
      h.state.gate = (p, s) => kind === 'provider' ? p === 'claude' : s === 's2';
      await h.page.getByLabel(kind === 'provider' ? '관제 도구 선택' : '모니터링 세션 선택').selectOption(kind === 'provider' ? 'claude' : 's2');
      assert.equal(await h.search.inputValue(), ''); assert.equal(await h.status.inputValue(), 'all');
      await h.guidance();
      assert.equal(await h.page.locator('.agent-card').count(), 0);
      await eventually(async () => assert.ok(h.state.pending.length > 0), 'New-scope snapshot must be intercepted');
      h.state.gate = null; h.state.pending.splice(0).forEach(resolve => resolve());
      await h.count(6); await h.guidance();
      assert.doesNotMatch(await h.detail.innerText(), /codex_s1/);
    });
  }
  await check('Late old activity response after session reset cannot restore stale detail', async h => {
    h.state.activityGate = true;
    await h.card('dev-1').click();
    await eventually(async () => assert.ok(h.state.pending.length > 0), 'Old activity response must be held');
    await h.search.fill('developer'); await h.status.selectOption('failed');
    await h.page.getByLabel('모니터링 세션 선택').selectOption('s2');
    await h.count(6); await h.guidance();
    h.state.activityGate = null; h.state.pending.splice(0).forEach(resolve => resolve());
    await h.page.waitForTimeout(100); await h.guidance();
    assert.equal(await h.search.inputValue(), ''); assert.equal(await h.status.inputValue(), 'all');
  });
  for (const hidden of [false, true]) {
    await check(`Selected deletion ${hidden ? 'hidden' : 'visible'} removes stale details and shows unavailable state`, async h => {
      await h.card('dev-1').click();
      await eventually(async () => assert.match(await h.detail.innerText(), /ACTIVITY_codex_s1_dev-1/), 'Activity should load');
      if (hidden) { await h.search.fill('developer'); await h.status.selectOption('failed'); }
      h.state.removed = 'dev-1';
      await eventually(async () => {
        const text = await h.detail.innerText();
        assert.match(text, /선택한 에이전트를 더 이상 이용할 수 없습니다/);
        assert.doesNotMatch(text, /TASK_|RESULT_|ACTIVITY_/);
      }, 'Deleted selection must show unavailable state and erase stale detail/activity');
      await h.count(hidden ? 1 : 5, 5);
      assert.equal(await h.page.locator('.agent-card[aria-pressed="true"]').count(), 0);
    });
  }
  await check('Same session refresh preserves filters updates counts and removes previous turn result', async h => {
    await h.card('dev-2').click(); await h.search.fill('developer'); await h.status.selectOption('failed');
    h.state.refreshed = true; await h.count(0);
    assert.equal(await h.search.inputValue(), 'developer'); assert.equal(await h.status.inputValue(), 'failed');
    assert.doesNotMatch(await h.detail.innerText(), /RESULT_codex_s1_dev-2/);
    assert.match(await h.detail.innerText(), /아직 보고된 결과가 없습니다/);
    assert.match(await h.detail.innerText(), /턴 완료/);
  });
  await check('Empty snapshot has separate session-empty message and zero totals', async h => {
    h.state.empty = true; await h.count(0, 0);
    assert.match(await h.page.locator('.list-empty').innerText(), /이 세션에 표시할 에이전트가 없습니다/);
    assert.doesNotMatch(await h.page.locator('.list-empty').innerText(), /조건에 맞는/);
  });
  await check('Keyboard selection status clear accessible live summary and visible focus', async h => {
    await h.card('dev-1').focus(); await h.page.keyboard.press('Enter');
    assert.match(await h.detail.innerText(), /TASK_codex_s1_dev-1/);
    await h.card('dev-2').focus(); await h.page.keyboard.press('Space');
    assert.match(await h.detail.innerText(), /TASK_codex_s1_dev-2/);
    await h.search.focus(); await h.page.keyboard.type('developer'); await h.page.keyboard.press('Tab');
    assert.equal(await h.status.evaluate(n => n === document.activeElement), true);
    await h.page.keyboard.press('Space'); await h.page.keyboard.press('Home'); await h.page.keyboard.press('ArrowDown'); await h.page.keyboard.press('Enter');
    assert.equal(await h.status.inputValue(), 'inProgress'); await h.count(1);
    await h.page.keyboard.press('Tab');
    assert.equal(await h.page.evaluate(() => document.activeElement.textContent), '필터 초기화');
    assert.ok(await h.page.evaluate(() => parseFloat(getComputedStyle(document.activeElement).outlineWidth) > 0));
    await h.page.keyboard.press('Enter'); await h.count(6);
    assert.equal(await h.search.inputValue(), ''); assert.equal(await h.status.inputValue(), 'all');
    assert.equal(await h.page.locator('.filter-summary').getAttribute('aria-live'), 'polite');
  });
  await check('Activity pagination does not alter snapshot counts or match counts', async h => {
    await h.card('dev-1').click(); await h.detail.getByRole('button', { name: '이전 활동 불러오기' }).click();
    await eventually(async () => assert.match(await h.detail.innerText(), /ACTIVITY_codex_s1_dev-1_older/), 'Older synthetic activity must render');
    await h.count(6); await h.search.fill('developer'); await h.count(2);
  });
  await check('Search stays transient excludes sensitive fields and sends no extra requests', async h => {
    const requests = h.state.dashboardRequests;
    await h.search.fill('PRIVATE_SYNTHETIC_MARKER'); await h.count(0);
    assert.equal(h.state.dashboardRequests, requests);
    assert.equal(h.page.url(), verifyURL.href);
    assert.doesNotMatch(await h.page.locator('.topology-panel').innerText(), /PRIVATE_SYNTHETIC_MARKER/);
    assert.doesNotMatch(await h.detail.innerText(), /PRIVATE_SYNTHETIC_MARKER/);
    assert.deepEqual(await h.page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })), { local: [], session: [] });
  });
  await check('Narrow viewport keeps controls usable detail below tree and saves screenshot', async h => {
    await h.page.setViewportSize({ width: 375, height: 812 });
    await h.card('dev-1').click(); await h.search.fill('check'); await h.count(1);
    const tree = await h.page.locator('.topology-panel').boundingBox();
    const detail = await h.detail.boundingBox();
    assert.ok(detail.y >= tree.y + tree.height - 1);
    assert.ok(await h.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await h.search.focus(); assert.equal(await h.search.evaluate(n => n === document.activeElement), true);
    await h.page.screenshot({ path: path.join(artifacts, 'agent-filter-smoke.png'), fullPage: true }); screenshotSaved = true;
  });
} catch (error) {
  const message = String(error?.message || '');
  const reason = /Operation not permitted|Permission denied|EPERM/.test(message) ? 'Sandbox permission denied browser startup.' : /Executable doesn.t exist/.test(message) ? 'Installed browser executable unavailable.' : 'Browser or built-asset harness could not start.';
  results.push({ name: 'Offline Playwright harness', verdict: 'fail', finding: `${reason} Browser acceptance and screenshot remain unverified.` });
} finally {
  if (browser && !screenshotSaved) {
    // Attempt an actual synthetic app capture even when the viewport acceptance check fails.
    let h;
    try { h = await harness(); await h.page.setViewportSize({ width: 375, height: 812 }); await h.page.screenshot({ path: path.join(artifacts, 'agent-filter-smoke.png'), fullPage: true }); screenshotSaved = true; } catch { /* Report evidence gap below. */ }
    finally { if (h) await h.context.close(); }
  }
  if (browser) await browser.close();
  await writeFile(path.join(artifacts, 'agent-filter-browser-results.json'), JSON.stringify({ verdict: results.every(r => r.verdict === 'pass') ? 'pass' : 'fail', screenshotSaved, results }, null, 2) + '\n');
}
const failed = results.filter(r => r.verdict === 'fail').length;
console.log(`Offline browser smoke: ${results.length - failed} passed, ${failed} failed; screenshot ${screenshotSaved ? 'saved' : 'unavailable'}.`);
process.exitCode = failed ? 1 : 0;

// Keep runner findings concise and present for every completed scenario.
const safeBrowserReport = JSON.parse(await readFile(path.join(artifacts, 'agent-filter-browser-results.json'), 'utf8'));
safeBrowserReport.results = safeBrowserReport.results.map(({ name, verdict, finding }) => ({
  name, verdict, finding: finding || `Acceptance check passed: ${name}`,
}));
await writeFile(path.join(artifacts, 'agent-filter-browser-results.json'), JSON.stringify(safeBrowserReport, null, 2) + '\n');
