import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const evidenceDir = path.join(root, 'workflow-artifacts/verification/V2/ui');
const hostMode = process.argv.includes('--host');
const base = hostMode ? parseAllowedBaseUrl(process.env.IFPMIC_PAPERCLIP_URL || 'http://127.0.0.1:3100') : null;
const origin = hostMode ? base.origin : 'http://ifpmic-replay-smoke.invalid';
const report = {
  kind: hostMode ? 'ifpmic-v2-replay-host-browser' : 'ifpmic-v2-replay-standalone-offline-browser',
  route: null,
  checks: [],
  unexpectedExternalRequests: [],
  browserWriteRequests: [],
  apiRequests: [],
  pageErrors: [],
  consoleErrors: [],
  evidence: [],
};

const scenarioOracle = {
  'happy-path': { current: 'END', status: 'COMPLETED', cycle: 1 },
  'human-wait': { current: 'P07', status: 'WAITING_HUMAN', cycle: 1 },
  'human-wait-oss': { current: 'P21', status: 'WAITING_HUMAN', cycle: 1 },
  'debug-failure': { current: 'P11', status: 'RUNNING', cycle: 2, rework: 1 },
  'review-failure': { current: 'P11', status: 'RUNNING', cycle: 2, rework: 1 },
  'oss-failure': { current: 'P11', status: 'RUNNING', cycle: 2, rework: 1 },
  'oss-design-change': { current: 'P07', status: 'RUNNING', cycle: 2, rework: 1 },
  'sam-failure': { current: 'P07', status: 'RUNNING', cycle: 2, rework: 1 },
  'tem-failure': { current: 'P11', status: 'RUNNING', cycle: 2, rework: 1 },
  'static-failure': { current: 'P11', status: 'RUNNING', cycle: 2, rework: 1 },
  'sqe-failure': { current: 'P07', status: 'RUNNING', cycle: 2, rework: 1 },
  'plan-rejection': { current: 'P02', status: 'RUNNING', cycle: 2, rework: 1 },
  'release-reject-code': { current: 'P11', status: 'RUNNING', cycle: 2, rework: 1 },
  'release-reject-design': { current: 'P07', status: 'RUNNING', cycle: 2, rework: 1 },
  'metadata-recovery': { current: 'END', status: 'COMPLETED', cycle: 1, rework: 1 },
  'metric-missing': { current: 'P16', status: 'RUNNING', cycle: 1 },
  'stale-result': { current: 'P16', status: 'RUNNING', cycle: 1 },
  'stale-candidate': { current: 'P16', status: 'RUNNING', cycle: 1 },
  'stale-approval': { current: 'X03', status: 'WAITING_HUMAN', cycle: 1 },
  'duplicate-events': { current: 'P01', status: 'RUNNING', cycle: 1 },
  'retry-limit': { current: 'P13', status: 'WAITING_HUMAN', cycle: 1 },
  'cycle-limit': { current: 'P13', status: 'WAITING_HUMAN', cycle: 4, rework: 3 },
  'device-boundaries': { current: 'P22', status: 'RECONCILING', cycle: 1 },
  'flash-unknown': { current: 'P22', status: 'RECONCILING', cycle: 1 },
  'notes-only': { current: 'END', status: 'COMPLETED', cycle: 1 },
};

let browser;
let context;
let page;
let company;
let routePath;

function parseAllowedBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch {
    throw new Error('IFPMIC_PAPERCLIP_URL must be a local HTTP root URL (127.0.0.1 or localhost).');
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('IFPMIC_PAPERCLIP_URL must be a local HTTP root URL without credentials, path, query, or fragment.');
  }
  return url;
}

async function requestJson(apiPath) {
  const response = await fetch(new URL(apiPath, base), {
    headers: { Origin: origin, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`GET ${apiPath} returned ${response.status}`);
  return body ? JSON.parse(body) : null;
}

function asList(response, key) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.[key])) return response[key];
  throw new Error(`Expected ${key} list response`);
}

async function hostPrerequisites() {
  const health = await requestJson('/api/health');
  assert.equal(health.version, '2026.1005.0');
  assert.equal(health.deploymentMode, 'local_trusted');
  const backupRoot = `${path.join(root, '.paperclip-lab/ifpmic-verification-data')}${path.sep}`;
  assert.ok(health.databaseBackup?.backupDir?.startsWith(backupRoot), 'must be isolated IFPMIC verification Paperclip instance');
  const companies = asList(await requestJson('/api/companies'), 'companies');
  company = companies.find(item => item.name === 'IFPMIC AX Verification');
  assert.ok(company?.id, 'pre-existing synthetic verification company must exist');
  assert.ok(company.issuePrefix, 'verification company issuePrefix exists');
  const plugins = asList(await requestJson('/api/plugins'), 'plugins');
  const plugin = plugins.find(item => item.pluginKey === 'ax.ifpmic-workflow' && item.status === 'ready');
  assert.ok(plugin?.id, 'pre-existing native IFPMIC page plugin must be ready');
  report.host = { version: health.version, deploymentMode: health.deploymentMode, companyId: company.id, pluginId: plugin.id };
  routePath = `/${String(company.issuePrefix).replace(/^\/+|\/+$/g, '')}/ifpmic-ax`;
  return { routePath, setupWrites: 0 };
}

async function record(name, action) {
  try {
    const details = await action();
    report.checks.push({ name, verdict: 'pass', ...(details === undefined ? {} : { details }) });
  } catch (error) {
    report.checks.push({ name, verdict: 'fail', finding: String(error?.message || error) });
  }
}

function summary() { return page.getByTestId('ifpmic-replay-summary'); }
function replayPanel() { return page.getByRole('region', { name: '모의 사건 재생' }); }
function scenarioSelect() { return page.getByLabel('모의 시나리오 선택', { exact: true }); }
function checkpointSelect() { return page.getByLabel('주요 관측 이동', { exact: true }); }
function card(id) { return page.getByTestId(`ifpmic-node-${id}`); }

async function selectScenario(id) {
  await scenarioSelect().selectOption(id);
  await assertSummary({ current: 'P01', status: 'RUNNING', cycle: 1 });
}

async function assertSummary(expected) {
  const output = summary();
  for (const [attr, value] of Object.entries({
    'data-current-step': expected.current,
    'data-status': expected.status,
    'data-cycle': String(expected.cycle),
    ...(expected.rework === undefined ? {} : { 'data-rework': String(expected.rework) }),
  })) assert.equal(await output.getAttribute(attr), value);
}

async function moveCheckpoint(id) {
  const option = checkpointSelect().locator(`option[value="${id}"]`);
  assert.equal(await option.count(), 1, `checkpoint ${id} is exposed`);
  await checkpointSelect().selectOption(id);
}

async function bootBrowser() {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const request = route.request();
    let url;
    try { url = new URL(request.url()); } catch {
      report.unexpectedExternalRequests.push(request.url());
      await route.abort();
      return;
    }
    if (url.origin !== origin) {
      report.unexpectedExternalRequests.push(request.url());
      await route.abort();
      return;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) report.browserWriteRequests.push({ method: request.method(), url: request.url() });
    if (!hostMode && url.pathname.startsWith('/api/')) {
      report.apiRequests.push(request.url());
      await route.abort();
      return;
    }
    if (hostMode) {
      await route.continue();
      return;
    }
    let relative;
    try { relative = decodeURIComponent(url.pathname).replace(/^\/+/, ''); } catch {
      report.unexpectedExternalRequests.push(request.url());
      await route.abort();
      return;
    }
    if (!relative || relative === 'ifpmic.html') relative = 'ifpmic.html';
    const target = path.resolve(dist, relative);
    if (!target.startsWith(`${dist}${path.sep}`)) {
      report.unexpectedExternalRequests.push(request.url());
      await route.abort();
      return;
    }
    try {
      const body = await readFile(target);
      const contentType = target.endsWith('.js') ? 'application/javascript'
        : target.endsWith('.css') ? 'text/css'
          : target.endsWith('.svg') ? 'image/svg+xml'
            : target.endsWith('.json') ? 'application/json' : 'text/html';
      await route.fulfill({ status: 200, contentType, body });
    } catch {
      report.unexpectedExternalRequests.push(request.url());
      await route.abort();
    }
  });
  page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => report.pageErrors.push(String(error?.message || error)));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  const url = hostMode ? new URL(routePath, base).href : `${origin}/ifpmic.html`;
  await page.goto(url, { waitUntil: 'networkidle' });
  report.route = hostMode ? routePath : '/ifpmic.html';
}

try {
  await mkdir(evidenceDir, { recursive: true });
  if (hostMode) {
    const readiness = await hostPrerequisites();
    report.checks.push({ name: 'isolated existing Paperclip host prerequisites are ready (GET-only)', verdict: 'pass', details: readiness });
  }
  await bootBrowser();

  await record('design view is the default and replay view requires explicit selection', async () => {
    assert.equal(new URL(page.url()).pathname, hostMode ? routePath : '/ifpmic.html');
    await page.getByRole('button', { name: '설계 보기', exact: true }).waitFor();
    assert.equal(await replayPanel().count(), 0);
    await page.getByRole('button', { name: '모의 시나리오', exact: true }).click();
    await replayPanel().waitFor();
    assert.ok((await replayPanel().innerText()).includes('MOCK'));
  });

  await record('catalog exposes all 25 frozen scenarios and starts each at cursor zero', async () => {
    const expectedIds = Object.keys(scenarioOracle);
    const options = await scenarioSelect().locator('option').evaluateAll(items => items.map(item => item.value).filter(Boolean));
    assert.deepEqual([...options].sort(), [...expectedIds].sort());
    for (const id of expectedIds) {
      await selectScenario(id);
      assert.equal(await scenarioSelect().inputValue(), id);
      assert.equal(await summary().getAttribute('data-rework'), '0');
      assert.ok((await replayPanel().innerText()).includes('MOCK'));
    }
  });

  await record('all 25 scenarios reach their fixed endpoint through the end-observation control', async () => {
    for (const [id, expected] of Object.entries(scenarioOracle)) {
      await selectScenario(id);
      await replayPanel().getByRole('button', { name: '끝 관측', exact: true }).click();
      await assertSummary(expected);
      const current = expected.current === 'END' ? page.getByTestId('ifpmic-end') : card(expected.current);
      assert.equal(await current.getAttribute('data-current'), 'true', `${id} current node`);
    }
  });

  await record('scenario change clears display filters and resets selection and cursor', async () => {
    await selectScenario('sam-failure');
    const search = page.getByRole('searchbox', { name: '단계 검색' });
    const owner = page.getByLabel('담당', { exact: true });
    await search.fill('SAM');
    await owner.selectOption('arch-runner');
    await selectScenario('human-wait');
    assert.equal(await search.inputValue(), '');
    assert.equal(await owner.inputValue(), 'all');
    assert.equal(await card('P01').getAttribute('aria-pressed'), 'true');
    await assertSummary({ current: 'P01', status: 'RUNNING', cycle: 1 });
  });

  await record('previous/next/first/last and checkpoint selection move stored prefixes only', async () => {
    await selectScenario('happy-path');
    await replayPanel().getByRole('button', { name: '끝 관측', exact: true }).click();
    await assertSummary({ current: 'END', status: 'COMPLETED', cycle: 1 });
    await replayPanel().getByRole('button', { name: '이전 관측', exact: true }).click();
    assert.notEqual(await summary().getAttribute('data-current-step'), 'END');
    await replayPanel().getByRole('button', { name: '처음 관측', exact: true }).click();
    await assertSummary({ current: 'P01', status: 'RUNNING', cycle: 1 });
    await replayPanel().getByRole('button', { name: '다음 관측', exact: true }).click();
    assert.equal(await summary().getAttribute('data-current-step'), 'P01');
    await moveCheckpoint('quality');
    assert.ok(await summary().getAttribute('data-current-step'));
    const afterCheckpoint = await summary().getAttribute('data-current-step');
    await moveCheckpoint('completed');
    await assertSummary({ current: 'END', status: 'COMPLETED', cycle: 1 });
    assert.notEqual(afterCheckpoint, 'END');
    await selectScenario('stale-result');
    await assertSummary({ current: 'P01', status: 'RUNNING', cycle: 1 });
  });

  await record('observation panel separates mock job, step, agent and gate data and opens current node', async () => {
    await selectScenario('sam-failure');
    await moveCheckpoint('returned');
    const detail = page.getByTestId('ifpmic-observation-detail');
    await detail.waitFor();
    const detailText = await detail.innerText();
    for (const text of ['MOCK', 'mock:sam-failure', '단계 상태', 'Agent 상태', 'Gate 판정']) assert.ok(detailText.includes(text), `detail shows ${text}`);
    await replayPanel().getByRole('button', { name: '현재 단계 보기', exact: true }).click();
    assert.equal(await card('P07').getAttribute('aria-pressed'), 'true');
    const timeline = page.getByRole('list', { name: '모의 사건 목록' });
    await timeline.waitFor();
    assert.match(await timeline.innerText(), /mock/i);
    const history = page.getByRole('region', { name: '모의 과거 이력' });
    await history.waitFor();
    assert.ok((await history.innerText()).includes('FAIL'));
    await card('P16').click();
    const currentGateDetail = await detail.innerText();
    assert.ok(currentGateDetail.includes('단계 상태'));
    assert.ok(currentGateDetail.includes('PENDING'), 'selected detail shows the current cycle; the old FAIL remains only in history');
  });

  await record('metadata recovery and notes checkpoints keep current approval and publication observability', async () => {
    await selectScenario('metadata-recovery');
    await moveCheckpoint('returned');
    await assertSummary({ current: 'X02', status: 'RUNNING', cycle: 1, rework: 1 });
    assert.equal(await card('P16').getAttribute('data-gate'), 'PASS');
    await moveCheckpoint('completed');
    await assertSummary({ current: 'END', status: 'COMPLETED', cycle: 1, rework: 1 });
    const releaseText = await page.getByRole('region', { name: '배포 모의 관측' }).innerText();
    assert.ok(releaseText.includes('receipt') || releaseText.includes('영수증'));

    await selectScenario('notes-only');
    await moveCheckpoint('notes-failed');
    assert.equal(await summary().getAttribute('data-status'), 'RELEASED_PENDING_NOTES');
    assert.equal(await card('P25').getAttribute('data-state'), 'SUCCEEDED');
    await moveCheckpoint('completed');
    assert.equal(await card('P26').getAttribute('data-state'), 'SUCCEEDED');
  });

  await record('retry, cycle and device telemetry are distinct and never expose allocatable authority', async () => {
    await selectScenario('retry-limit');
    await moveCheckpoint('limit');
    assert.equal(await summary().getAttribute('data-current-step'), 'P13');
    assert.equal(await card('P13').getAttribute('data-attempt'), '3');
    assert.equal(await summary().getAttribute('data-status'), 'WAITING_HUMAN');
    await selectScenario('cycle-limit');
    await moveCheckpoint('limit');
    await assertSummary({ current: 'P13', status: 'WAITING_HUMAN', cycle: 4, rework: 3 });
    await selectScenario('device-boundaries');
    await moveCheckpoint('time-60000');
    const observation = page.getByRole('region', { name: '장비 모의 관측' });
    const text = await observation.innerText();
    assert.ok(text.includes('RECONCILING'));
    assert.ok(text.includes('false') || text.includes('아니오'));
    assert.equal(await card('P22').getAttribute('data-state'), 'RUNNING');
  });

  await record('current-stage navigation reveals, focuses and scrolls a node hidden by active filters', async () => {
    await selectScenario('flash-unknown');
    await replayPanel().getByRole('button', { name: '끝 관측', exact: true }).click();
    await assertSummary({ current: 'P22', status: 'RECONCILING', cycle: 1 });
    const search = page.getByRole('searchbox', { name: '단계 검색' });
    const owner = page.getByLabel('담당', { exact: true });
    await search.fill('SAM');
    await owner.selectOption('arch-runner');
    assert.equal(await card('P22').count(), 0, 'current target is hidden by active filter');
    await replayPanel().getByRole('button', { name: '현재 단계 보기', exact: true }).click();
    assert.equal(await search.inputValue(), '');
    assert.equal(await owner.inputValue(), 'all');
    const target = card('P22');
    assert.equal(await target.getAttribute('aria-pressed'), 'true');
    const geometry = await page.evaluate(() => {
      const scroller = document.querySelector('.ifpmic-scroll');
      const targetNode = document.querySelector('[data-testid="ifpmic-node-P22"]');
      if (!scroller || !targetNode) return null;
      const viewport = scroller.getBoundingClientRect();
      const node = targetNode.getBoundingClientRect();
      return {
        focused: document.activeElement === targetNode,
        viewport: { left: viewport.left + scroller.clientLeft, right: viewport.left + scroller.clientLeft + scroller.clientWidth },
        node: { left: node.left, right: node.right },
        scrollLeft: scroller.scrollLeft,
      };
    });
    assert.ok(geometry, 'workflow scroll viewport and P22 exist after filters clear');
    assert.equal(geometry.focused, true, `P22 focus: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.node.left >= geometry.viewport.left - 1 && geometry.node.right <= geometry.viewport.right + 1,
      `P22 is visible in workflow scroller: ${JSON.stringify(geometry)}`);
  });

  await record('1440px and 375px layouts expose replay controls and details without horizontal page overflow', async () => {
    await selectScenario('happy-path');
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.ok(await replayPanel().isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(evidenceDir, `${hostMode ? 'host' : 'standalone'}-desktop.png`), fullPage: true });
    report.evidence.push(`workflow-artifacts/verification/V2/ui/${hostMode ? 'host' : 'standalone'}-desktop.png`);

    await selectScenario('sam-failure');
    await moveCheckpoint('returned');
    await card('P16').click();
    await page.screenshot({ path: path.join(evidenceDir, `${hostMode ? 'host' : 'standalone'}-sam-failure-returned-desktop.png`), fullPage: true });
    report.evidence.push(`workflow-artifacts/verification/V2/ui/${hostMode ? 'host' : 'standalone'}-sam-failure-returned-desktop.png`);

    await selectScenario('metadata-recovery');
    await moveCheckpoint('completed');
    await card('X03').click();
    await page.screenshot({ path: path.join(evidenceDir, `${hostMode ? 'host' : 'standalone'}-metadata-completed-desktop.png`), fullPage: true });
    report.evidence.push(`workflow-artifacts/verification/V2/ui/${hostMode ? 'host' : 'standalone'}-metadata-completed-desktop.png`);

    await selectScenario('device-boundaries');
    await moveCheckpoint('time-60000');
    await page.getByRole('region', { name: '장비 모의 관측' }).waitFor();
    await page.screenshot({ path: path.join(evidenceDir, `${hostMode ? 'host' : 'standalone'}-device-time-60000-desktop.png`), fullPage: true });
    report.evidence.push(`workflow-artifacts/verification/V2/ui/${hostMode ? 'host' : 'standalone'}-device-time-60000-desktop.png`);

    await page.setViewportSize({ width: 375, height: 812 });
    assert.ok(await scenarioSelect().isVisible());
    assert.ok(await replayPanel().getByRole('button', { name: '다음 관측' }).isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(evidenceDir, `${hostMode ? 'host' : 'standalone'}-device-time-60000-mobile-375.png`), fullPage: true });
    report.evidence.push(`workflow-artifacts/verification/V2/ui/${hostMode ? 'host' : 'standalone'}-device-time-60000-mobile-375.png`);
  });

  await record('browser replay makes no API writes, external requests or runtime errors', async () => {
    assert.deepEqual(report.browserWriteRequests, []);
    assert.deepEqual(report.apiRequests, []);
    assert.deepEqual(report.unexpectedExternalRequests, []);
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []);
  });
} catch (error) {
  report.harnessError = String(error?.stack || error?.message || error);
} finally {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  report.verdict = report.harnessError || report.checks.some(item => item.verdict === 'fail')
    || report.browserWriteRequests.length || report.apiRequests.length || report.unexpectedExternalRequests.length
    || report.pageErrors.length || report.consoleErrors.length ? 'fail' : 'pass';
  const filename = hostMode ? 'host-browser.json' : 'standalone-browser.json';
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, filename), `${JSON.stringify(report, null, 2)}\n`);
}

console.log(`IFPMIC V2 replay ${hostMode ? 'host' : 'standalone'} browser checks: ${report.checks.filter(item => item.verdict === 'pass').length} passed, ${report.checks.filter(item => item.verdict === 'fail').length} failed (${report.verdict}).`);
if (report.verdict !== 'pass') process.exitCode = 1;
