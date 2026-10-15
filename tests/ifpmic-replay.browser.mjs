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
  captureAdjustments: [],
  geometryMethod: 'Target full bounding box must fit the viewport and each overflow-clipping ancestor. The 4x4 hit grid counts only the target or its descendants; hits on ancestors are rejected.',
  sqeCaptureGeometry: [],
  childCaptureGeometry: [],
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
  'spec-question-wait': { current: 'P03', status: 'WAITING_HUMAN', cycle: 1 },
  'spec-question-resolution': { current: 'P04', status: 'RUNNING', cycle: 1 },
  'spec-question-retry': { current: 'P04', status: 'RUNNING', cycle: 1 },
  'spec-question-repeat': { current: 'P04', status: 'RUNNING', cycle: 1 },
  'remote-uncertainty': { current: 'P25', status: 'RECONCILING', cycle: 1 },
  'remote-recovery': { current: 'END', status: 'COMPLETED', cycle: 1 },
  'remote-device-quarantine': { current: 'P25', status: 'RECONCILING', cycle: 1 },
  'routing-reuse': { current: 'END', status: 'COMPLETED', cycle: 1 },
  'routing-new-hw': { current: 'P11', status: 'RUNNING', cycle: 1 },
  'routing-exempt': { current: 'END', status: 'COMPLETED', cycle: 1 },
  'routing-pilot-denied': { current: 'P15', status: 'RUNNING', cycle: 1 },
  'routing-no-change': { current: 'P12', status: 'NO_CHANGE', cycle: 1 },
  'routing-no-change-denied': { current: 'P12', status: 'RUNNING', cycle: 1 },
  'routing-candidate': { current: 'END', status: 'COMPLETED', cycle: 1 },
  'routing-replan': { current: 'P06', status: 'RUNNING', cycle: 2, rework: 1 },
  'routing-metadata': { current: 'END', status: 'COMPLETED', cycle: 1, rework: 1 },
  'sqe-manual-pass': { current: 'END', status: 'COMPLETED', cycle: 1 },
  'sqe-manual-fail': { current: 'P07', status: 'RUNNING', cycle: 2, rework: 1 },
  'sqe-incomplete': { current: 'P24', status: 'RUNNING', cycle: 1 },
  'sqe-parser-error': { current: 'P24', status: 'RUNNING', cycle: 1 },
  'sqe-identity-mismatch': { current: 'P24', status: 'RUNNING', cycle: 1 },
  'sqe-manual-retry': { current: 'END', status: 'COMPLETED', cycle: 1 },
  'sqe-report-retry': { current: 'END', status: 'COMPLETED', cycle: 1 },
  'sqe-judgment-retry': { current: 'END', status: 'COMPLETED', cycle: 1 },
  'sqe-manual-quarantine': { current: 'P22', status: 'RECONCILING', cycle: 1 },
  'agent-wait': { current: 'P12', status: 'RUNNING', cycle: 1 },
  'agent-handoff': { current: 'END', status: 'COMPLETED', cycle: 1 },
  'agent-child-failure': { current: 'END', status: 'COMPLETED', cycle: 1 },
  'agent-child-question': { current: 'END', status: 'COMPLETED', cycle: 1 },
  'agent-child-retry-limit': { current: 'P12', status: 'WAITING_HUMAN', cycle: 1 },
  'agent-child-stale-cycle': { current: 'END', status: 'COMPLETED', cycle: 2, rework: 1 },
  'agent-child-permissions': { current: 'END', status: 'COMPLETED', cycle: 1 },
  'agent-child-interrupted': { current: 'P12', status: 'WAITING_HUMAN', cycle: 1 },
  'agent-child-canceled': { current: 'END', status: 'COMPLETED', cycle: 1 },
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
  if (hostMode) {
    const announcement = page.locator('aside[aria-label="Paperclip announcements"]');
    await announcement.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    const count = await announcement.count();
    const selector = 'aside[aria-label="Paperclip announcements"]';
    assert.ok(count === 0 || count === 1, `expected at most one Paperclip announcement container, got ${count}`);
    if (count === 0) {
      report.captureAdjustments.push({ selector, count: 0, action: 'none', observedText: null });
    } else {
      const observedText = await announcement.innerText();
      assert.ok(observedText.includes('Introducing Connectors'), 'announcement title matches expected Paperclip notice');
      assert.ok(observedText.includes('Give your agents the access they need'), 'announcement copy matches expected Paperclip notice');
      const containsIfpmic = await announcement.evaluate(element => Boolean(element.querySelector(
        '#ifpmic-root, main.ifpmic-shell, [data-testid^="ifpmic-"]',
      )));
      assert.equal(containsIfpmic, false, 'announcement is separate from IFPMIC content');
      await announcement.evaluate(element => { element.style.visibility = 'hidden'; });
      report.captureAdjustments.push({
        selector, count, action: 'visibility:hidden for screenshot capture only; no dismissal control or API was invoked',
        observedText,
      });
    }
  }
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

  await record('catalog exposes all 59 frozen scenarios and starts each at cursor zero', async () => {
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

  await record('all 59 scenarios reach their fixed endpoint through the end-observation control', async () => {
    for (const [id, expected] of Object.entries(scenarioOracle)) {
      await selectScenario(id);
      await replayPanel().getByRole('button', { name: '끝 관측', exact: true }).click();
      await assertSummary(expected);
      const current = expected.current === 'END' ? page.getByTestId('ifpmic-end') : card(expected.current);
      assert.equal(await current.getAttribute('data-current'), 'true', `${id} current node`);
    }
  });

  await record('routing scenarios expose reuse, exemption, terminal, candidate and replan authority checkpoints', async () => {
    const routingPanel = () => page.getByTestId('ifpmic-routing-observation');
    const noChangePanel = () => page.getByTestId('ifpmic-no-change-observation');
    const routeHistory = () => page.getByTestId('ifpmic-routing-history');
    const capture = async (stem, width = 1440, height = 1000, target = null) => {
      await page.setViewportSize({ width, height });
      if (target) await target.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${stem} viewport has no page overflow`);
      const filename = `${hostMode ? 'host' : 'standalone'}-${stem}-${width}.png`;
      await page.screenshot({ path: path.join(evidenceDir, filename), fullPage: true });
      report.evidence.push(`workflow-artifacts/verification/V2/ui/${filename}`);
    };

    await selectScenario('routing-reuse');
    await moveCheckpoint('local');
    await assertSummary({ current: 'P03', status: 'RUNNING', cycle: 1 });
    assert.equal(await card('P03').getAttribute('data-state'), 'PENDING');
    assert.equal(await card('P03').getAttribute('data-current'), 'true');
    let plan = routingPanel();
    assert.equal(await plan.getAttribute('data-context-cycle'), '1');
    assert.equal(await plan.getAttribute('data-current-authority'), 'false', 'local P03 confirmation is not global plan authority');
    const localPlanText = await plan.innerText();
    for (const text of ['계획 원래 cycle', '프로파일', '변경 유형', '재사용 범위', '미확정']) assert.ok(localPlanText.includes(text), `local plan panel shows ${text}`);
    await capture('routing-reuse-local', 1440, 1000, plan);
    await moveCheckpoint('early');
    await assertSummary({ current: 'X01', status: 'RUNNING', cycle: 1 });
    for (const id of ['P03', 'P04', 'P05']) assert.equal(await card(id).getAttribute('data-state'), 'SKIPPED');
    await moveCheckpoint('confirmed');
    await assertSummary({ current: 'P06', status: 'RUNNING', cycle: 1 });
    plan = routingPanel();
    assert.equal(await plan.getAttribute('data-current-authority'), 'true');
    const reuseText = await plan.innerText();
    for (const id of ['P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10', 'P11', 'P12']) assert.ok(reuseText.includes(id), `the approved global reuse scope includes ${id}`);
    await moveCheckpoint('reused');
    for (const id of ['P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10', 'P11', 'P12']) {
      assert.equal(await card(id).getAttribute('data-state'), 'SKIPPED', `${id} is visibly skipped`);
    }
    await moveCheckpoint('end');
    await assertSummary(scenarioOracle['routing-reuse']);

    await selectScenario('routing-new-hw');
    await moveCheckpoint('early-blocked');
    assert.equal(await card('P03').getAttribute('data-state'), 'PENDING');
    assert.ok((await page.getByRole('list', { name: '모의 사건 목록' }).innerText()).includes('invalid_reuse_confirmation'));
    await moveCheckpoint('confirmed');
    assert.equal(await card('P03').getAttribute('data-state'), 'SUCCEEDED');
    assert.equal(await card('P04').getAttribute('data-state'), 'SUCCEEDED');
    assert.equal(await card('P05').getAttribute('data-state'), 'SUCCEEDED');
    assert.ok((await routingPanel().innerText()).includes('P10'));
    await moveCheckpoint('reused');
    assert.equal(await card('P10').getAttribute('data-state'), 'SKIPPED');
    await assertSummary(scenarioOracle['routing-new-hw']);

    await selectScenario('routing-exempt');
    await moveCheckpoint('confirmed');
    assert.equal(await routingPanel().getAttribute('data-current-authority'), 'true');
    await moveCheckpoint('paired');
    assert.equal(await card('P16').getAttribute('data-state'), 'SKIPPED');
    assert.equal(await card('P16').getAttribute('data-gate'), 'EXEMPT');
    await moveCheckpoint('report-blocked');
    assert.equal(await card('P23').getAttribute('data-state'), 'RUNNING');
    assert.equal(await card('P24').getAttribute('data-state'), 'PENDING');
    assert.ok((await page.getByRole('list', { name: '모의 사건 목록' }).innerText()).includes('exemption_report_required'));
    await moveCheckpoint('reported');
    assert.equal(await card('P23').getAttribute('data-state'), 'SUCCEEDED');
    await card('P23').click();
    const reportDetail = await page.getByTestId('ifpmic-observation-detail').innerText();
    assert.ok(reportDetail.includes('SQE 시험 미수행 보고'));
    assert.match(reportDetail, /시험 수행[\s\S]*false/);
    await moveCheckpoint('exempt');
    await assertSummary({ current: 'X02', status: 'RUNNING', cycle: 1 });
    for (const id of ['P16', 'P18', 'P20', 'P24']) assert.equal(await card(id).getAttribute('data-gate'), 'EXEMPT', `${id} disposition remains EXEMPT`);
    await card('P24').click();
    const detail = page.getByTestId('ifpmic-observation-detail');
    const detailText = await detail.innerText();
    assert.equal(await page.getByTestId('ifpmic-sqe-step-detail').count(), 0,
      'a paired exemption is not rendered as an SQE measurement or report');
    for (const text of ['EXEMPT', '측정 완료', 'false']) assert.ok(detailText.includes(text), `P24 detail distinguishes exemption evidence: ${text}`);
    const skipBasis = await page.getByTestId('ifpmic-skip-basis').innerText();
    for (const text of ['COUPLED', 'mock:human', 'mock:policy:exempt:v1', 'cycle 1', 'attempt 1', 'mock:P24:c1:a1']) {
      assert.ok(skipBasis.includes(text), `P24 skip basis preserves ${text}`);
    }
    assert.match(skipBasis, /생략 증거[\s\S]*mock:routing-exempt:X01:a1:c1/);
    await capture('routing-exempt-exempt', 1440, 1000, detail);
    await capture('routing-exempt-exempt', 375, 812, detail);
    await moveCheckpoint('end');
    const exemptRelease = await page.getByRole('region', { name: '배포 모의 관측' }).innerText();
    assert.ok(exemptRelease.includes('EXEMPT'));
    await assertSummary(scenarioOracle['routing-exempt']);

    await selectScenario('routing-pilot-denied');
    await moveCheckpoint('denied');
    await assertSummary({ current: 'X01', status: 'WAITING_HUMAN', cycle: 1 });
    assert.equal(await routingPanel().getAttribute('data-current-authority'), 'false');
    await moveCheckpoint('confirmed');
    assert.equal(await routingPanel().getAttribute('data-current-authority'), 'true');
    await moveCheckpoint('blocked');
    assert.equal(await card('P15').getAttribute('data-state'), 'PENDING');
    assert.ok((await page.getByRole('list', { name: '모의 사건 목록' }).innerText()).includes('skip_authorization_required'));
    await assertSummary(scenarioOracle['routing-pilot-denied']);

    await selectScenario('routing-no-change');
    await moveCheckpoint('production');
    assert.equal(await card('P11').getAttribute('data-state'), 'SKIPPED');
    await card('P11').click();
    let analysisDetail = await page.getByTestId('ifpmic-observation-detail').innerText();
    for (const text of ['mock:code-dev', '변경 필요\nfalse', '요구사항 충족\ntrue', 'mock:routing-no-change:source:c1', 'mock:routing-no-change:analysis:P11:c1']) {
      assert.ok(analysisDetail.includes(text), `P11 analysis detail shows ${text}`);
    }
    assert.equal(await card('P12').getAttribute('data-state'), 'PENDING');
    assert.equal(await noChangePanel().count(), 0, 'analysis alone does not show the close panel');
    await moveCheckpoint('analysed');
    assert.equal(await card('P12').getAttribute('data-state'), 'PENDING');
    await card('P12').click();
    analysisDetail = await page.getByTestId('ifpmic-observation-detail').innerText();
    for (const text of ['mock:tc', '변경 필요\nfalse', '요구사항 충족\ntrue', 'mock:routing-no-change:tests:c1', 'mock:routing-no-change:analysis:P12:c1']) {
      assert.ok(analysisDetail.includes(text), `P12 analysis detail shows ${text}`);
    }
    assert.equal(await noChangePanel().count(), 0);
    await moveCheckpoint('closed');
    await assertSummary({ current: 'P12', status: 'NO_CHANGE', cycle: 1 });
    assert.equal(await card('P12').getAttribute('data-state'), 'SKIPPED');
    assert.ok(await noChangePanel().isVisible());
    const closeText = await noChangePanel().innerText();
    for (const text of ['발행', 'P13', 'PENDING', 'mock:no-change:P12:c1:a1']) assert.ok(closeText.includes(text), `NO_CHANGE panel shows ${text}`);
    await capture('routing-no-change-closed', 1440, 1000, noChangePanel());
    await capture('routing-no-change-closed', 375, 812, noChangePanel());
    await moveCheckpoint('terminal');
    assert.ok((await page.getByRole('list', { name: '모의 사건 목록' }).innerText()).includes('terminal_no_change'));
    assert.equal(await page.getByRole('region', { name: '배포 모의 관측' }).innerText().then(text => /실제 제출 허용[\s\S]*?(아니오|false)/.test(text)), true);
    await assertSummary({ current: 'P12', status: 'NO_CHANGE', cycle: 1 });

    await selectScenario('routing-no-change-denied');
    await moveCheckpoint('production');
    await moveCheckpoint('analysed');
    assert.equal(await card('P12').getAttribute('data-state'), 'PENDING');
    await moveCheckpoint('denied');
    assert.equal(await card('P12').getAttribute('data-state'), 'PENDING');
    await card('P12').click();
    const deniedAnalysis = await page.getByTestId('ifpmic-observation-detail').innerText();
    assert.match(deniedAnalysis, /변경 필요[\s\S]*true/);
    assert.equal(await noChangePanel().count(), 0);
    await assertSummary(scenarioOracle['routing-no-change-denied']);

    await selectScenario('routing-candidate');
    await moveCheckpoint('confirmed');
    await moveCheckpoint('changed');
    await assertSummary({ current: 'P13', status: 'RUNNING', cycle: 1 });
    const changedPlan = routingPanel();
    const changedPlanText = await changedPlan.innerText();
    assert.ok(changedPlanText.includes('mock:candidate:B'));
    const planCandidate = changedPlan.locator('dl').locator('dt').filter({ hasText: '계획 후보' });
    assert.equal(await planCandidate.locator('xpath=following-sibling::dd[1]').innerText(), 'mock:candidate:A', 'approved plan remains bound to candidate A');
    const currentCandidate = changedPlan.locator('dl').locator('dt').filter({ hasText: '현재 후보' });
    assert.equal(await currentCandidate.locator('xpath=following-sibling::dd[1]').innerText(), 'mock:candidate:B', 'current candidate is B');
    await moveCheckpoint('blocked');
    await assertSummary({ current: 'P15', status: 'RUNNING', cycle: 1 });
    assert.equal(await card('P15').getAttribute('data-state'), 'PENDING');
    assert.equal(await routingPanel().getAttribute('data-current-authority'), 'false');
    assert.ok((await page.getByRole('list', { name: '모의 사건 목록' }).innerText()).includes('stale_route_context'));
    await capture('routing-candidate-blocked', 1440, 1000, routingPanel());
    await moveCheckpoint('end');
    await assertSummary(scenarioOracle['routing-candidate']);

    await selectScenario('routing-replan');
    await moveCheckpoint('rejected');
    assert.equal(await card('X01').getAttribute('data-state'), 'FAILED');
    await moveCheckpoint('rerouted');
    await assertSummary({ current: 'P02', status: 'RUNNING', cycle: 2, rework: 1 });
    assert.equal(await routeHistory().count(), 0, 'old route plan is preserved as stale context until replacement is confirmed');
    await moveCheckpoint('stale');
    assert.equal(await routingPanel().getAttribute('data-context-cycle'), '1');
    assert.equal(await routingPanel().getAttribute('data-current-authority'), 'false');
    assert.ok((await page.getByRole('list', { name: '모의 사건 목록' }).innerText()).includes('invalid_route_context'));
    await moveCheckpoint('replanned');
    await assertSummary({ current: 'P06', status: 'RUNNING', cycle: 2, rework: 1 });
    for (const id of ['P03', 'P04', 'P05']) assert.equal(await card(id).getAttribute('data-state'), 'SUCCEEDED');
    assert.equal(await routingPanel().getAttribute('data-context-cycle'), '2');
    assert.equal(await routingPanel().getAttribute('data-current-authority'), 'true');
    assert.ok(await routeHistory().count() > 0, 'old route plan moves to history when new context is accepted');
    const historyText = await routeHistory().innerText();
    assert.ok(historyText.includes('mock:routing-replan:plan:c1'), 'history preserves old cycle-1 plan version');
    assert.ok(historyText.includes('mock:candidate:A'), 'history preserves old candidate A');
    assert.ok((await routingPanel().innerText()).includes('mock:routing-replan:plan:c2'), 'current plan displays cycle-2 version separately');
    assert.ok((await routingPanel().innerText()).includes('mock:candidate:A'), 'current cycle-2 plan remains bound to candidate A');
    await capture('routing-replan-replanned', 1440, 1000, routingPanel());
    await moveCheckpoint('end');
    await assertSummary(scenarioOracle['routing-replan']);

    await selectScenario('routing-metadata');
    await moveCheckpoint('exempt');
    await moveCheckpoint('rejected');
    assert.equal(await summary().getAttribute('data-current-step'), 'X03');
    await moveCheckpoint('retried');
    await assertSummary({ current: 'X02', status: 'RUNNING', cycle: 1, rework: 1 });
    for (const id of ['P16', 'P18', 'P20', 'P24']) assert.equal(await card(id).getAttribute('data-gate'), 'EXEMPT');
    assert.equal(await card('X02').getAttribute('data-attempt'), '2');
    await moveCheckpoint('end');
    for (const id of ['P16', 'P18', 'P20', 'P24']) assert.equal(await card(id).getAttribute('data-gate'), 'EXEMPT');
    await assertSummary(scenarioOracle['routing-metadata']);

    await selectScenario('routing-no-change');
    await moveCheckpoint('closed');
    assert.ok(await noChangePanel().isVisible());
    await selectScenario('happy-path');
    await assertSummary({ current: 'P01', status: 'RUNNING', cycle: 1 });
    assert.equal(await routingPanel().count(), 0, 'new scenario clears the old route plan panel');
    assert.equal(await noChangePanel().count(), 0, 'new scenario clears the old NO_CHANGE panel');
    assert.equal(await routeHistory().count(), 0, 'new scenario clears old routing history');
    assert.match(await replayPanel().locator('output').innerText(), /관측\s*0\s*\//, 'scenario switch resets the cursor');
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

  await record('question panels distinguish durable answer, current-attempt review and archived review history', async () => {
    await selectScenario('spec-question-wait');
    await moveCheckpoint('end');
    const waitingQuestion = page.getByTestId('ifpmic-spec-observation');
    assert.equal(await waitingQuestion.getAttribute('data-question-id'), 'mock:question:spec-question-wait:q1');
    assert.equal(await waitingQuestion.getAttribute('data-requirements-version'), 'mock:requirements:v1');
    assert.equal(await waitingQuestion.getAttribute('data-question-attempt'), '1');
    assert.equal(await waitingQuestion.getAttribute('data-current-review'), 'false');
    const waitingQuestionText = await waitingQuestion.innerText();
    for (const text of ['미해결', '질문 당시 버전', 'mock:requirements:v1',
      '배정 task', 'mock:task:P03:c1:a1:q1', '현재 P03 attempt']) {
      assert.ok(waitingQuestionText.includes(text), `unresolved question shows ${text}`);
    }
    assert.match(waitingQuestionText, /현재 P03 attempt\s*1/);

    await selectScenario('spec-question-resolution');
    await moveCheckpoint('answered');
    const answeredQuestion = page.getByTestId('ifpmic-spec-observation');
    assert.equal(await summary().getAttribute('data-current-step'), 'P03');
    assert.equal(await card('P03').getAttribute('data-state'), 'READY');
    assert.equal(await answeredQuestion.getAttribute('data-requirements-version'), 'mock:requirements:v2');
    assert.equal(await answeredQuestion.getAttribute('data-current-review'), 'false');
    assert.ok((await answeredQuestion.innerText()).includes('해결됨'));
    assert.ok((await answeredQuestion.innerText()).includes('미완료'));
    await moveCheckpoint('reviewed');
    assert.equal(await answeredQuestion.getAttribute('data-current-review'), 'true');
    assert.equal(await answeredQuestion.getAttribute('data-review-attempt'), '1');

    await selectScenario('spec-question-retry');
    await moveCheckpoint('review-blocked');
    await assertSummary({ current: 'P03', status: 'RUNNING', cycle: 1 });
    const question = page.getByRole('region', { name: '사양 질문 모의 관측', exact: true });
    assert.equal(await question.getAttribute('data-testid'), 'ifpmic-spec-observation');
    assert.equal(await question.getAttribute('data-question-id'), 'mock:question:spec-question-retry:q1');
    assert.equal(await question.getAttribute('data-requirements-version'), 'mock:requirements:v2');
    assert.equal(await question.getAttribute('data-question-attempt'), '1');
    assert.equal(await question.getAttribute('data-review-attempt'), '1');
    assert.equal(await question.getAttribute('data-current-review'), 'false');
    const questionText = await question.innerText();
    for (const label of ['요구사항 현재 버전', '질문 ID', '배정 task', '질문 원래 실행', '질문 증거',
      '답변 반영 버전', '답변 증거', '현재 P03 실행', '현재 실행 검토', '기록된 검토 실행', '검토 증거']) {
      assert.ok(questionText.includes(label), `question panel exposes ${label}`);
    }
    assert.ok(questionText.includes('미완료'), 'a1 review does not approve current a2 execution');
    const history = page.getByRole('region', { name: '모의 과거 이력' });
    assert.equal(await history.getByTestId('ifpmic-spec-history').count(), 0,
      'the a1 review is still current question metadata until the new a2 review is recorded');

    await moveCheckpoint('reviewed');
    assert.equal(await question.getAttribute('data-review-attempt'), '2');
    assert.equal(await question.getAttribute('data-current-review'), 'true');
    assert.ok((await question.innerText()).includes('유효'), 'current a2 review is valid');
    const specHistory = history.getByTestId('ifpmic-spec-history');
    assert.ok(await specHistory.count() > 0);
    assert.equal(await specHistory.first().getAttribute('data-review-attempt'), '1');
    await moveCheckpoint('review-blocked');
    assert.equal(await question.getAttribute('data-current-review'), 'false');
    assert.equal(await question.getAttribute('data-review-attempt'), '1');
    assert.equal(await history.getByTestId('ifpmic-spec-history').count(), 0,
      'rewinding before the new review restores the prefix without a future history row');
    await moveCheckpoint('reviewed');
    assert.equal(await question.getAttribute('data-current-review'), 'true');
    const oldReviewText = await specHistory.first().innerText();
    for (const text of ['질문 원래 좌표', '질문 당시 버전', '기록된 검토 attempt', 'mock:requirements:v1',
      'mock:requirements:v2', 'mock:P03:c1:a1']) assert.ok(oldReviewText.includes(text), `a1 history shows ${text}`);
    assert.ok(oldReviewText.includes('1'), 'archived review attempt is shown');
    const currentQuestionText = await question.innerText();
    for (const text of ['질문 당시 버전', '기록된 검토 attempt', 'mock:requirements:v1',
      'mock:requirements:v2', 'mock:P03:c1:a2', '현재 P03 attempt']) assert.ok(currentQuestionText.includes(text), `current question shows ${text}`);
    assert.match(currentQuestionText, /현재 P03 attempt\s*2/);

    await selectScenario('spec-question-repeat');
    assert.match(await replayPanel().locator('output').innerText(), /관측\s*0\s*\//,
      'new scenario begins at observation cursor zero');
    assert.equal(await page.getByTestId('ifpmic-spec-observation').count(), 0,
      'switching to another question case starts before its first question event');
    assert.equal(await page.getByTestId('ifpmic-spec-history').count(), 0,
      'switching cases clears prior question history');
    await moveCheckpoint('end');
    const repeated = page.getByRole('region', { name: '사양 질문 모의 관측', exact: true });
    assert.equal(await repeated.getAttribute('data-question-id'), 'mock:question:spec-question-repeat:q2');
    assert.equal(await repeated.getAttribute('data-requirements-version'), 'mock:requirements:v3');
    assert.equal(await repeated.getAttribute('data-question-attempt'), '1');
    const repeatedText = await repeated.innerText();
    for (const text of ['질문 당시 버전', '기록된 검토 attempt', 'mock:requirements:v2',
      'mock:requirements:v3', 'mock:P03:c1:a1']) assert.ok(repeatedText.includes(text), `current q2 shows ${text}`);
    const archivedQuestions = page.getByRole('region', { name: '모의 과거 이력' }).getByTestId('ifpmic-spec-history');
    assert.ok(await archivedQuestions.count() >= 1);
    const repeatHistory = await page.getByRole('region', { name: '모의 과거 이력' }).innerText();
    assert.ok(repeatHistory.includes('mock:question:spec-question-repeat:q1'));
    assert.ok(repeatHistory.includes('mock:requirements:v1'));
    assert.ok(repeatHistory.includes('mock:requirements:v2'));
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await repeated.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await page.screenshot({ path: path.join(evidenceDir, `${hostMode ? 'host' : 'standalone'}-spec-question-repeat-end-desktop.png`), fullPage: true });
    report.evidence.push(`workflow-artifacts/verification/V2/ui/${hostMode ? 'host' : 'standalone'}-spec-question-repeat-end-desktop.png`);
    await replayPanel().getByRole('button', { name: '처음 관측', exact: true }).click();
    assert.equal(await page.getByTestId('ifpmic-spec-observation').count(), 0);
    assert.equal(await page.getByTestId('ifpmic-spec-history').count(), 0);
    assert.ok((await page.getByRole('region', { name: '모의 과거 이력' }).innerText()).includes('과거 이력 없음'));
  });

  await record('remote panel shows stale-query rejection, one found receipt and quarantine independently', async () => {
    await selectScenario('remote-uncertainty');
    await moveCheckpoint('stale');
    await assertSummary({ current: 'P25', status: 'RECONCILING', cycle: 1 });
    const remote = page.getByRole('region', { name: '원격 결과 모의 관측', exact: true });
    assert.equal(await remote.getAttribute('data-testid'), 'ifpmic-remote-observation');
    assert.equal(await remote.getAttribute('data-operation-key'), 'mock:remote-uncertainty:operation');
    assert.equal(await remote.getAttribute('data-query-seq'), '3');
    assert.equal(await remote.getAttribute('data-outcome'), 'conflict');
    const remoteText = await remote.innerText();
    for (const label of ['동작 key', '명세 ID', 'digest', '후보', 'P25 단계 상태', '조회 순번', '조회 결과', '모의 영수증', '실제 제출 허용']) {
      assert.ok(remoteText.includes(label), `remote panel exposes ${label}`);
    }
    const timeline = page.getByRole('list', { name: '모의 사건 목록' });
    assert.ok((await timeline.innerText()).includes('stale_remote_query'));
    assert.equal(await card('P25').getAttribute('data-state'), 'RECONCILING');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await remote.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(evidenceDir, `${hostMode ? 'host' : 'standalone'}-remote-uncertainty-stale-desktop.png`), fullPage: true });
    report.evidence.push(`workflow-artifacts/verification/V2/ui/${hostMode ? 'host' : 'standalone'}-remote-uncertainty-stale-desktop.png`);

    await page.setViewportSize({ width: 375, height: 812 });
    await remote.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.ok(await remote.isVisible());
    await page.screenshot({ path: path.join(evidenceDir, `${hostMode ? 'host' : 'standalone'}-remote-uncertainty-stale-mobile-375.png`), fullPage: true });
    report.evidence.push(`workflow-artifacts/verification/V2/ui/${hostMode ? 'host' : 'standalone'}-remote-uncertainty-stale-mobile-375.png`);

    await selectScenario('remote-recovery');
    await moveCheckpoint('found');
    const recovered = page.getByRole('region', { name: '원격 결과 모의 관측', exact: true });
    assert.equal(await recovered.getAttribute('data-query-seq'), '2');
    assert.equal(await recovered.getAttribute('data-outcome'), 'found');
    assert.ok((await recovered.innerText()).includes('mock:remote-recovery:remote:receipt'));
    assert.equal(await card('P25').getAttribute('data-state'), 'SUCCEEDED');
    assert.equal(await summary().getAttribute('data-current-step'), 'P26');
    assert.equal(await page.getByRole('region', { name: '배포 모의 관측' }).innerText().then(text => /실제 제출 허용[\s\S]*?(아니오|false)/.test(text)), true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await recovered.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await page.screenshot({ path: path.join(evidenceDir, `${hostMode ? 'host' : 'standalone'}-remote-recovery-found-desktop.png`), fullPage: true });
    report.evidence.push(`workflow-artifacts/verification/V2/ui/${hostMode ? 'host' : 'standalone'}-remote-recovery-found-desktop.png`);

    await selectScenario('remote-device-quarantine');
    await moveCheckpoint('blocked');
    const quarantinedRemote = page.getByRole('region', { name: '원격 결과 모의 관측', exact: true });
    assert.equal(await quarantinedRemote.getAttribute('data-query-seq'), '0');
    assert.equal(await quarantinedRemote.getAttribute('data-outcome'), 'unknown');
    assert.equal(await card('P25').getAttribute('data-state'), 'RECONCILING');
    const deviceText = await page.getByRole('region', { name: '장비 모의 관측' }).innerText();
    assert.match(deviceText, /격리[\s\S]*true/);

    await selectScenario('happy-path');
    // Scenario changes already reset the cursor to the first observation.
    assert.equal(await page.getByTestId('ifpmic-spec-observation').count(), 0);
    assert.equal(await page.getByTestId('ifpmic-remote-observation').count(), 0);
    assert.equal(await page.getByTestId('ifpmic-spec-history').count(), 0,
      'switching cases clears question review history');
  });

  await record('SQE manual, report and judgment checkpoints remain separate across retries and history', async () => {
    const panel = () => page.getByTestId('ifpmic-sqe-observation');
    const detail = () => page.getByTestId('ifpmic-sqe-step-detail');
    const history = () => page.getByRole('region', { name: '모의 과거 이력', exact: true });
    const captureSqe = async (name, width, target) => {
      const height = width === 375 ? 1800 : 1000;
      await page.setViewportSize({ width, height });
      await target.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
      const view = await target.evaluate(element => {
        const r = element.getBoundingClientRect();
        const rect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        const points = [];
        for (let row = 1; row <= 4; row++) for (let col = 1; col <= 4; col++) {
          const x = r.left + r.width * col / 5, y = r.top + r.height * row / 5;
          const hit = document.elementFromPoint(x, y);
          points.push({ x, y, insideTargetOrDescendant: Boolean(hit && (hit === element || element.contains(hit))) });
        }
        const overlaps = [];
        for (const candidate of document.querySelectorAll('*')) {
          if (candidate === element || element.contains(candidate) || candidate.contains(element)) continue;
          const style = getComputedStyle(candidate);
          if (!['fixed', 'sticky'].includes(style.position) || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
          const overlay = candidate.getBoundingClientRect();
          if (overlay.width <= 0 || overlay.height <= 0) continue;
          const intersection = { left: Math.max(r.left, overlay.left), top: Math.max(r.top, overlay.top),
            right: Math.min(r.right, overlay.right), bottom: Math.min(r.bottom, overlay.bottom) };
          if (intersection.right > intersection.left && intersection.bottom > intersection.top) {
            overlaps.push({ selector: candidate.id ? `#${candidate.id}`
              : candidate.getAttribute('data-testid') ? `[data-testid="${candidate.getAttribute('data-testid')}"]`
                : `${candidate.tagName.toLowerCase()}${candidate.getAttribute('aria-label') ? `[aria-label="${candidate.getAttribute('aria-label')}"]` : ''}`,
            position: style.position, rect: { left: overlay.left, top: overlay.top, right: overlay.right, bottom: overlay.bottom }, intersection });
          }
        }
        const clippingAncestors = [];
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          const clipsX = ['hidden', 'auto', 'scroll', 'clip'].includes(style.overflowX);
          const clipsY = ['hidden', 'auto', 'scroll', 'clip'].includes(style.overflowY);
          if (!clipsX && !clipsY) continue;
          const a = ancestor.getBoundingClientRect();
          const box = { left: a.left + ancestor.clientLeft, top: a.top + ancestor.clientTop,
            right: a.left + ancestor.clientLeft + ancestor.clientWidth,
            bottom: a.top + ancestor.clientTop + ancestor.clientHeight };
          clippingAncestors.push({ selector: ancestor.id ? `#${ancestor.id}`
            : ancestor.classList?.length ? `${ancestor.tagName.toLowerCase()}.${[...ancestor.classList].join('.')}`
              : ancestor.tagName.toLowerCase(), overflowX: style.overflowX, overflowY: style.overflowY,
          box, clipsX, clipsY,
          fitsX: !clipsX || (r.left >= box.left && r.right <= box.right),
          fitsY: !clipsY || (r.top >= box.top && r.bottom <= box.bottom) });
        }
        return { rect, viewport: { width: innerWidth, height: innerHeight }, points, overlaps, clippingAncestors,
          fullyVisible: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
      });
      assert.equal(view.fullyVisible, true, `${name} target fully fits the actual viewport: ${JSON.stringify(view)}`);
      assert.ok(view.points.every(point => point.insideTargetOrDescendant), `${name} target 4x4 hit-grid hits only the target or its descendants: ${JSON.stringify(view)}`);
      assert.deepEqual(view.overlaps, [], `${name} has no visible fixed/sticky overlap: ${JSON.stringify(view.overlaps)}`);
      assert.ok(view.clippingAncestors.every(ancestor => ancestor.fitsX && ancestor.fitsY),
        `${name} target fits every overflow-clipping ancestor on each clipped axis: ${JSON.stringify(view.clippingAncestors)}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} no horizontal overflow`);
      report.sqeCaptureGeometry.push({ name, width, height, target: await target.getAttribute('data-testid')
        || await target.getAttribute('aria-label') || 'nested SQE section', rect: view.rect,
      hit_grid: { samples: view.points.length, inside_target_or_descendant: view.points.filter(point => point.insideTargetOrDescendant).length },
      fixed_sticky_overlaps: view.overlaps,
      overflow_clipping_ancestors: view.clippingAncestors });
      const filename = `${hostMode ? 'host' : 'standalone'}-sqe-${name}-${width}.png`;
      await page.screenshot({ path: path.join(evidenceDir, filename), fullPage: false });
      report.evidence.push(`workflow-artifacts/verification/V2/ui/${filename}`);
    };
    const assertAttempts = async (values) => {
      for (const [key, value] of Object.entries(values)) assert.equal(await panel().getAttribute(`data-${key}-attempt`), String(value));
    };

    await selectScenario('sqe-manual-pass');
    await moveCheckpoint('waiting');
    let observation = panel();
    assert.equal(await observation.getAttribute('data-mode'), 'manual');
    await assertAttempts({ p22: 1 });
    assert.equal(await card('P22').getAttribute('data-state'), 'WAITING_HUMAN');
    for (const text of ['수동', '사람 결과 대기']) assert.ok((await observation.innerText()).includes(text));
    await card('P22').click();
    let selected = detail();
    assert.equal(await selected.getAttribute('data-step-id'), 'P22');
    assert.equal(await selected.getAttribute('data-mode'), 'manual');
    assert.equal(await selected.getAttribute('data-result-evidence-id'), '');
    for (const text of ['mock:human', 'mock:manual:P22:c1:a1', '배정 수행자']) assert.ok((await selected.innerText()).includes(text));
    await captureSqe('manual-waiting', 1440, selected);
    await moveCheckpoint('rejected');
    assert.equal(await card('P22').getAttribute('data-state'), 'WAITING_HUMAN');
    assert.ok((await page.getByRole('list', { name: '모의 사건 목록' }).innerText()).includes('invalid_manual_submission'));
    await moveCheckpoint('submitted');
    assert.equal(await card('P22').getAttribute('data-state'), 'READY', 'manual acceptance is not completion');
    assert.equal(await card('P23').getAttribute('data-state'), 'PENDING');
    await card('P22').click();
    selected = detail();
    assert.equal(await selected.getAttribute('data-mode'), 'manual');
    assert.ok(await selected.getAttribute('data-result-evidence-id'));
    await captureSqe('manual-submitted', 375, selected);
    for (const [name, region] of [
      ['manual-submitted-target', selected.getByRole('region', { name: 'SQE 시험 대상', exact: true })],
      ['manual-submitted-assignment', selected.getByRole('region', { name: 'SQE 수동 배정', exact: true })],
      ['manual-submitted-result', selected.getByRole('region', { name: 'SQE 수집 결과', exact: true })],
    ]) await captureSqe(name, 375, region);
    await moveCheckpoint('reported');
    await card('P23').click();
    selected = detail();
    assert.equal(await selected.getAttribute('data-step-id'), 'P23');
    assert.equal(await selected.getAttribute('data-mode'), 'manual', 'P23 report preserves manual execution mode');
    assert.ok((await selected.innerText()).includes('수동 · manual'));
    await moveCheckpoint('judged');
    await assertSummary({ current: 'X02', status: 'RUNNING', cycle: 1 });
    observation = panel();
    assert.equal(await observation.getAttribute('data-verdict'), 'PASS');
    await assertAttempts({ p22: 1, p23: 1, p24: 1 });
    await card('P24').click();
    selected = detail();
    assert.equal(await selected.getAttribute('data-step-id'), 'P24');
    assert.ok((await selected.innerText()).includes('PASS'));
    assert.ok(await selected.getAttribute('data-report-evidence-id'));
    await captureSqe('manual-judged', 1440, selected);

    await selectScenario('sqe-manual-fail');
    await moveCheckpoint('rerouted');
    await assertSummary({ current: 'P07', status: 'RUNNING', cycle: 2, rework: 1 });
    assert.equal(await panel().count(), 0, 'cycle-2 SQE current view is reset, with old FAIL in history only');
    assert.ok((await history().innerText()).includes('FAIL'));
    assert.equal(await card('P24').getAttribute('data-state'), 'PENDING', 'cycle-1 FAIL is not promoted into current cycle P24');
    const failHistoryToggle = page.getByRole('button', { name: '이력 영역 펼치기', exact: true });
    assert.equal(await failHistoryToggle.getAttribute('aria-expanded'), 'false');
    await failHistoryToggle.click();
    const archivedP24 = page.locator('[data-testid="ifpmic-sqe-history"][data-step-id="P24"]').first();
    await archivedP24.waitFor();
    await captureSqe('manual-fail-rerouted-history', 1440, archivedP24);

    for (const [id, verdict] of [['sqe-incomplete', 'INCONCLUSIVE'], ['sqe-parser-error', 'ERROR'], ['sqe-identity-mismatch', 'INCONCLUSIVE']]) {
      await selectScenario(id);
      await moveCheckpoint('blocked');
      await assertSummary({ current: 'P24', status: 'RUNNING', cycle: 1 });
      observation = panel();
      assert.equal(await observation.getAttribute('data-verdict'), verdict, id);
      assert.equal(await card('P22').getAttribute('data-state'), 'SUCCEEDED', id);
      assert.equal(await card('P23').getAttribute('data-state'), 'SUCCEEDED', id);
      assert.equal(await card('P24').getAttribute('data-state'), 'RUNNING', id);
      assert.equal(await card('P24').getAttribute('data-gate'), verdict, id);
      assert.ok((await observation.innerText()).includes('false'), `${id} remains incomplete`);
      await card('P22').click();
      const sqeDetail = detail();
      const sqeText = await sqeDetail.innerText();
      if (id === 'sqe-incomplete') {
        assert.ok(sqeText.includes('누락'));
        assert.ok(sqeText.includes('mock:sqe:case:function'));
      } else if (id === 'sqe-parser-error') {
        assert.ok(sqeText.includes('error'));
        assert.match(sqeText, /종료 코드\s*없음/);
      } else {
        assert.ok(sqeText.includes('기대 부팅 식별'));
        assert.ok(sqeText.includes('different-boot'));
      }
    }
    await selectScenario('sqe-incomplete');
    await moveCheckpoint('blocked');
    await card('P22').click();
    selected = detail();
    assert.ok((await selected.innerText()).includes('누락'));
    await captureSqe('incomplete-blocked', 1440, page.getByRole('region', { name: 'SQE 수집 결과', exact: true }));

    await selectScenario('sqe-manual-retry');
    await moveCheckpoint('waiting-two');
    await assertSummary({ current: 'P22', status: 'WAITING_HUMAN', cycle: 1 });
    observation = panel();
    assert.equal(await observation.getAttribute('data-mode'), 'manual');
    await assertAttempts({ p22: 2 });
    await card('P22').click();
    assert.ok((await detail().innerText()).includes('mock:manual:P22:c1:a2'));
    assert.ok((await history().innerText()).includes('mock:manual:P22:c1:a1'));
    await captureSqe('manual-retry-waiting-two', 375, detail().getByRole('region', { name: 'SQE 수동 배정', exact: true }));
    const historyToggle = page.getByRole('button', { name: '이력 영역 펼치기', exact: true });
    assert.equal(await historyToggle.getAttribute('aria-expanded'), 'false');
    const archivedManualAttempt = page.locator('[data-testid="ifpmic-sqe-history"][data-step-id="P22"]').first();
    const compactResult = archivedManualAttempt.getByRole('region', { name: 'SQE 수집 결과', exact: true });
    const compactClips = await compactResult.evaluate(element => {
      const r = element.getBoundingClientRect(), found = [];
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const clipsY = ['hidden', 'auto', 'scroll', 'clip'].includes(style.overflowY);
        if (!clipsY) continue;
        const a = ancestor.getBoundingClientRect();
        const top = a.top + ancestor.clientTop, bottom = top + ancestor.clientHeight;
        found.push({ selector: ancestor.id ? `#${ancestor.id}`
          : ancestor.classList?.length ? `${ancestor.tagName.toLowerCase()}.${[...ancestor.classList].join('.')}`
            : ancestor.tagName.toLowerCase(), overflowY: style.overflowY,
        clip_top: top, clip_bottom: bottom, target_top: r.top, target_bottom: r.bottom,
        fitsY: r.top >= top && r.bottom <= bottom });
      }
      return found;
    });
    const compactHistoryClip = compactClips.find(ancestor => ancestor.selector === '#ifpmic-replay-history');
    assert.ok(compactHistoryClip && compactHistoryClip.overflowY === 'auto' && !compactHistoryClip.fitsY
      && compactHistoryClip.clip_bottom - compactHistoryClip.clip_top === 200,
    `bounded diagnostic confirms the compact 200px history scroller clips archived SQE detail: ${JSON.stringify(compactClips)}`);
    report.sqeCaptureGeometry.push({ name: 'manual-retry-compact-history-negative-diagnostic', width: 375,
      target: 'SQE 수집 결과', expected_clipped: true, overflow_clipping_ancestors: compactClips });
    await historyToggle.click();
    const collapseHistory = page.getByRole('button', { name: '이력 영역 접기', exact: true });
    assert.equal(await collapseHistory.getAttribute('aria-expanded'), 'true');
    assert.equal(await archivedManualAttempt.getAttribute('data-attempt'), '1');
    assert.equal(await archivedManualAttempt.getAttribute('data-mode'), 'manual');
    assert.ok(await archivedManualAttempt.getAttribute('data-result-evidence-id'));
    await captureSqe('manual-retry-a1-history', 375,
      archivedManualAttempt.getByRole('region', { name: 'SQE 수동 배정', exact: true }));
    await captureSqe('manual-retry-a1-result-history', 375,
      archivedManualAttempt.getByRole('region', { name: 'SQE 수집 결과', exact: true }));
    await collapseHistory.click();
    assert.equal(await page.getByRole('button', { name: '이력 영역 펼치기', exact: true }).getAttribute('aria-expanded'), 'false');
    await historyToggle.click();
    assert.equal(await page.getByRole('button', { name: '이력 영역 접기', exact: true }).getAttribute('aria-expanded'), 'true');

    await selectScenario('sqe-report-retry');
    assert.equal(await page.getByRole('button', { name: /이력 영역 (펼치기|접기)/ }).count(), 0,
      'scenario starts at cursor zero with no history control');
    await moveCheckpoint('reported-two');
    assert.equal(await page.getByRole('button', { name: '이력 영역 펼치기', exact: true }).getAttribute('aria-expanded'), 'false',
      'scenario change restores compact history');
    await assertSummary({ current: 'P23', status: 'RUNNING', cycle: 1 });
    observation = panel();
    await assertAttempts({ p22: 1, p23: 2, p24: 1 });
    await card('P23').click();
    selected = detail();
    assert.equal(await selected.getAttribute('data-step-id'), 'P23');
    assert.equal(await selected.getAttribute('data-attempt'), '2');
    assert.equal(await selected.getAttribute('data-mode'), 'bridge_mock');
    assert.ok((await selected.innerText()).includes('bridge mock · 합성'));
    assert.ok(await selected.getAttribute('data-report-evidence-id'));
    await captureSqe('report-retry-current', 1440, selected);

    await selectScenario('sqe-judgment-retry');
    await moveCheckpoint('stale');
    await assertSummary({ current: 'P24', status: 'RUNNING', cycle: 1 });
    observation = panel();
    assert.equal(await observation.getAttribute('data-verdict'), '');
    await assertAttempts({ p22: 1, p23: 1, p24: 2 });
    assert.equal(await card('P24').getAttribute('data-state'), 'RUNNING');
    assert.equal(await card('P24').getAttribute('data-gate'), null);
    assert.ok((await history().innerText()).includes('PASS'));
    assert.ok((await page.getByRole('list', { name: '모의 사건 목록' }).innerText()).includes('stale_execution'));
    await card('P24').click();
    selected = detail();
    assert.equal(await selected.getAttribute('data-step-id'), 'P24');
    assert.equal(await selected.getAttribute('data-attempt'), '2');
    assert.equal(await selected.count(), 1, 'current P24 retry association renders its not-yet-judged SQE detail');
    assert.equal(await selected.getAttribute('data-result-evidence-id'), '');
    assert.ok((await page.getByTestId('ifpmic-observation-detail').innerText()).includes('미판정'));
    await captureSqe('judgment-retry-stale-history', 1440, selected);
    const judgmentHistoryToggle = page.getByRole('button', { name: '이력 영역 펼치기', exact: true });
    assert.equal(await judgmentHistoryToggle.getAttribute('aria-expanded'), 'false');
    await judgmentHistoryToggle.click();
    assert.equal(await page.getByRole('button', { name: '이력 영역 접기', exact: true }).getAttribute('aria-expanded'), 'true');
    const archivedJudgmentAttempt = page.locator('[data-testid="ifpmic-sqe-history"][data-step-id="P24"]').first();
    assert.equal(await archivedJudgmentAttempt.getAttribute('data-attempt'), '1');
    assert.ok((await archivedJudgmentAttempt.innerText()).includes('PASS'));
    await captureSqe('judgment-retry-a1-history', 1440, archivedJudgmentAttempt);

    await selectScenario('sqe-manual-quarantine');
    await moveCheckpoint('blocked');
    await assertSummary({ current: 'P22', status: 'RECONCILING', cycle: 1 });
    observation = panel();
    assert.match(await page.getByRole('region', { name: '장비 모의 관측' }).innerText(), /격리[\s\S]*true/);
    assert.equal(await card('P22').getAttribute('data-state'), 'WAITING_HUMAN');
    await card('P22').click();
    selected = detail();
    assert.equal(await selected.getAttribute('data-result-evidence-id'), '');
    await captureSqe('manual-quarantine-blocked', 1440, selected);

    await selectScenario('sqe-manual-pass');
    await assertSummary({ current: 'P01', status: 'RUNNING', cycle: 1 });
    assert.equal(await panel().count(), 0, 'scenario reset clears SQE observation');
    assert.ok((await history().innerText()).includes('이 관측까지 과거 이력 없음'), 'scenario reset clears SQE history');
  });

  await record('child coordinator and TC execution remain separate, bound, and legible across all nine fixed checkpoints', async () => {
    const childPanel = () => page.getByRole('region', { name: '자식 TC 실행 모의 관측', exact: true });
    const selectedChild = () => page.getByTestId('ifpmic-child-step-detail');
    const childHistory = () => page.getByTestId('ifpmic-child-history');
    const captureChild = async (name, width, detail) => {
      const height = width === 375 ? 1800 : 1440;
      await page.setViewportSize({ width, height });
      const groupSpecs = [
        ['binding', 'ifpmic-child-binding', 'P12 부모·자식 식별'],
        ['result', 'ifpmic-child-result', 'P12 쓰기 범위와 결과'],
        ['integration', 'ifpmic-child-integration', 'P12 질문·복구·통합'],
      ];
      assert.equal(await detail.count(), 1, `${name} detail exists`);
      for (const [groupName, testId, accessibleName] of groupSpecs) {
        const target = detail.getByTestId(testId);
        assert.equal(await target.count(), 1, `${name} contains ${testId}`);
        assert.equal(await target.getAttribute('aria-label'), accessibleName);
        await target.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
        const view = await target.evaluate(element => {
        const r = element.getBoundingClientRect();
        const rect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        const viewport = { width: innerWidth, height: innerHeight };
        const points = [];
        for (let row = 1; row <= 4; row++) for (let col = 1; col <= 4; col++) {
          const x = r.left + r.width * col / 5, y = r.top + r.height * row / 5;
          const hit = document.elementFromPoint(x, y);
          points.push({ x, y, insideTargetOrDescendant: Boolean(hit && (hit === element || element.contains(hit))) });
        }
        const overlaps = [];
        for (const candidate of document.querySelectorAll('*')) {
          if (candidate === element || element.contains(candidate) || candidate.contains(element)) continue;
          const style = getComputedStyle(candidate);
          if (!['fixed', 'sticky'].includes(style.position) || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
          const b = candidate.getBoundingClientRect();
          if (b.width <= 0 || b.height <= 0) continue;
          const intersection = { left: Math.max(r.left, b.left), top: Math.max(r.top, b.top),
            right: Math.min(r.right, b.right), bottom: Math.min(r.bottom, b.bottom) };
          if (intersection.right > intersection.left && intersection.bottom > intersection.top) overlaps.push({
            selector: candidate.id ? `#${candidate.id}` : candidate.getAttribute('data-testid') ? `[data-testid="${candidate.getAttribute('data-testid')}"]` : candidate.tagName.toLowerCase(),
            position: style.position, intersection,
          });
        }
        const clippingAncestors = [];
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor), clipsX = ['hidden', 'auto', 'scroll', 'clip'].includes(style.overflowX),
            clipsY = ['hidden', 'auto', 'scroll', 'clip'].includes(style.overflowY);
          if (!clipsX && !clipsY) continue;
          const a = ancestor.getBoundingClientRect();
          const box = { left: a.left + ancestor.clientLeft, top: a.top + ancestor.clientTop,
            right: a.left + ancestor.clientLeft + ancestor.clientWidth,
            bottom: a.top + ancestor.clientTop + ancestor.clientHeight };
          clippingAncestors.push({ selector: ancestor.id ? `#${ancestor.id}` : ancestor.classList?.length ? `${ancestor.tagName.toLowerCase()}.${[...ancestor.classList].join('.')}` : ancestor.tagName.toLowerCase(),
            overflowX: style.overflowX, overflowY: style.overflowY,
            fitsX: !clipsX || (r.left >= box.left && r.right <= box.right),
            fitsY: !clipsY || (r.top >= box.top && r.bottom <= box.bottom) });
        }
        return { rect, viewport, points, overlaps, clippingAncestors,
          fullyVisible: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
      });
      assert.equal(view.fullyVisible, true, `${name} fully fits viewport: ${JSON.stringify(view)}`);
      assert.ok(view.points.every(point => point.insideTargetOrDescendant), `${name} 4x4 target hit grid: ${JSON.stringify(view.points)}`);
      assert.deepEqual(view.overlaps, [], `${name} fixed/sticky overlaps: ${JSON.stringify(view.overlaps)}`);
      assert.ok(view.clippingAncestors.every(ancestor => ancestor.fitsX && ancestor.fitsY), `${name} overflow clips: ${JSON.stringify(view.clippingAncestors)}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} no page overflow`);
        const filename = `${hostMode ? 'host' : 'standalone'}-child-${name}-${groupName}-${width}.png`;
        await page.screenshot({ path: path.join(evidenceDir, filename), fullPage: false });
        report.evidence.push(`workflow-artifacts/verification/V2/ui/${filename}`);
        report.childCaptureGeometry.push({ name, group: groupName, width, height, target: testId, accessibleName, screenshot: `workflow-artifacts/verification/V2/ui/${filename}`, fullPage: false, ...view });
      }
    };
    const go = async (id, checkpoint) => { await selectScenario(id); await moveCheckpoint(checkpoint); };
    const selectP12 = async () => { await card('P12').click(); assert.equal(await selectedChild().count(), 1); return selectedChild(); };
    const assertChildPanel = async ({ coordinator, child, ordinal, integration }) => {
      const panel = childPanel();
      await panel.waitFor();
      assert.equal(await panel.getAttribute('data-coordinator-status'), coordinator);
      assert.equal(await panel.getAttribute('data-child-status'), child);
      assert.equal(await panel.getAttribute('data-request-ordinal'), ordinal === null ? '' : String(ordinal));
      assert.equal(await panel.getAttribute('data-integration-status'), integration);
      const body = await panel.innerText();
      for (const label of ['부모 coordinator', 'TC 자식 실행', '명시 부모 관계', '통합 근거']) {
        assert.ok(body.includes(label), `child panel includes ${label}`);
      }
      assert.ok(body.includes('품질 판정과 실제 실행 권한은 별도'), 'child completion is explicitly separate from quality and real authority');
      assert.equal(await panel.locator('a').count(), 0, 'mock artifact refs are not links');
      return panel;
    };

    await go('agent-wait', 'waiting');
    await assertSummary({ current: 'P12', status: 'RUNNING', cycle: 1 });
    let panel = await assertChildPanel({ coordinator: 'WAITING_AGENT', child: 'running', ordinal: 1, integration: '없음' });
    let detail = await selectP12();
    assert.equal(await detail.getAttribute('data-step-id'), 'P12');
    assert.equal(await detail.getAttribute('data-cycle'), '1');
    assert.equal(await detail.getAttribute('data-attempt'), '1');
    assert.ok((await detail.innerText()).includes('mock:P12:c1:a1'));
    assert.ok((await detail.innerText()).includes('mock:agent-wait:ch:integration-ws:c1:a1'));
    assert.ok((await detail.innerText()).includes('쓰기 범위 · 합성 선언'));
    await captureChild('agent-wait-waiting', 1440, detail);

    await go('agent-handoff', 'returned');
    await assertSummary({ current: 'P12', status: 'RUNNING', cycle: 1 });
    panel = await assertChildPanel({ coordinator: 'WAITING_AGENT', child: 'completed', ordinal: 1, integration: '없음' });
    detail = await selectP12();
    assert.ok((await detail.innerText()).includes('mock:path:tests:unit'));
    await captureChild('agent-handoff-returned', 1440, detail);
    await moveCheckpoint('integrated');
    panel = await assertChildPanel({ coordinator: 'COMPLETED', child: 'completed', ordinal: 1, integration: 'integrated' });
    await assertSummary({ current: 'P12', status: 'RUNNING', cycle: 1 });
    detail = await selectP12();
    assert.ok((await detail.innerText()).includes('통합 근거'));
    await captureChild('agent-handoff-integrated', 1440, detail);

    await go('agent-child-question', 'waiting-human');
    panel = await assertChildPanel({ coordinator: 'WAITING_HUMAN', child: 'needs_human', ordinal: 1, integration: '없음' });
    assert.ok((await panel.innerText()).includes('사람 복구 승인 필요') === false, 'question is distinct from recovery-required cancellation');
    detail = await selectP12();
    assert.ok((await detail.innerText()).includes('agent_question') || (await detail.innerText()).includes('mock:child-human:'));
    await captureChild('agent-question-waiting-human', 375, detail);
    await moveCheckpoint('resumed');
    panel = await assertChildPanel({ coordinator: 'WAITING_AGENT', child: 'running', ordinal: 2, integration: '없음' });
    detail = await selectP12();
    assert.equal(await detail.getAttribute('data-ordinal'), '2');
    const oldQuestion = childHistory().first();
    assert.equal(await oldQuestion.count(), 1, 'the earlier ordinal remains archived separately');
    assert.equal(await oldQuestion.getAttribute('data-ordinal'), '1');
    assert.equal(await oldQuestion.getAttribute('data-result-status'), 'needs_human');
    assert.ok((await oldQuestion.innerText()).includes('과거 · 현재 권한 아님'));
    await captureChild('agent-question-resumed', 1440, detail);

    await go('agent-child-failure', 'retried');
    await assertSummary({ current: 'P12', status: 'RUNNING', cycle: 1 });
    assert.equal(await childPanel().count(), 0, 'fresh READY attempt has no child assignment yet');
    assert.ok(await card('P12').getAttribute('data-state') === 'READY');
    await page.getByRole('button', { name: '이력 영역 펼치기', exact: true }).click();
    const oldFailure = childHistory().first();
    assert.equal(await oldFailure.getAttribute('data-attempt'), '1');
    assert.equal(await oldFailure.getAttribute('data-result-status'), 'failed');
    await captureChild('agent-failure-retried-history', 375, oldFailure);
    await moveCheckpoint('recovered');
    await assertSummary({ current: 'P13', status: 'RUNNING', cycle: 1 });
    await card('P12').click();
    detail = page.locator('[data-testid="ifpmic-child-step-detail"][data-attempt="2"]');
    assert.equal(await detail.getAttribute('data-attempt'), '2');
    assert.equal(await detail.getAttribute('data-result-status'), 'completed');
    assert.ok((await detail.innerText()).includes('integrated'));
    await captureChild('agent-failure-recovered', 375, detail);

    await go('agent-child-permissions', 'integration-denied');
    panel = await assertChildPanel({ coordinator: 'RUNNING', child: 'completed', ordinal: 1, integration: '없음' });
    detail = await selectP12();
    assert.ok((await detail.innerText()).includes('production hash'));
    assert.ok((await detail.innerText()).includes('없음'));
    await captureChild('agent-permissions-integration-denied', 1440, detail);

    await go('agent-child-stale-cycle', 'stale');
    await assertSummary({ current: 'P12', status: 'RUNNING', cycle: 2, rework: 1 });
    panel = await assertChildPanel({ coordinator: 'WAITING_AGENT', child: 'running', ordinal: 1, integration: '없음' });
    detail = await selectP12();
    await page.getByRole('button', { name: '이력 영역 펼치기', exact: true }).click();
    const staleArchived = childHistory().first();
    assert.equal(await staleArchived.getAttribute('data-cycle'), '1');
    assert.equal(await staleArchived.getAttribute('data-result-status'), 'completed');
    assert.equal(await detail.getAttribute('data-cycle'), '2');
    await captureChild('agent-stale-cycle-current', 1440, detail);
    await captureChild('agent-stale-cycle-history', 1440, staleArchived);

    await go('agent-child-retry-limit', 'capped');
    await assertSummary({ current: 'P12', status: 'WAITING_HUMAN', cycle: 1 });
    panel = await assertChildPanel({ coordinator: 'FAILED', child: 'failed', ordinal: 1, integration: '없음' });
    assert.ok((await panel.innerText()).includes('재시도 상한 · 사람 검토 필요'));
    detail = await selectP12();
    assert.equal(await detail.getAttribute('data-attempt'), '3');
    await captureChild('agent-retry-limit-capped', 1440, detail);

    await go('agent-child-interrupted', 'denied-retry');
    panel = await assertChildPanel({ coordinator: 'WAITING_HUMAN', child: 'interrupted', ordinal: 1, integration: '없음' });
    assert.ok((await panel.innerText()).includes('사람 복구 승인 필요'));
    await go('agent-child-canceled', 'recovery-approved');
    panel = await assertChildPanel({ coordinator: 'WAITING_HUMAN', child: 'canceled', ordinal: 1, integration: '없음' });
    const approvedRecoveryText = await panel.innerText();
    assert.ok(approvedRecoveryText.includes('사람 복구 승인 기록됨'));
    assert.equal(approvedRecoveryText.includes('사람 복구 승인 필요'), false,
      'an accepted retry approval is displayed as recorded rather than still pending');

    await selectScenario('agent-wait');
    assert.equal(await replayPanel().locator('output').innerText().then(text => /관측\s*0\s*\//.test(text)), true,
      'scenario switch returns to cursor zero');
    assert.equal(await childPanel().count(), 0, 'scenario switch clears current child projection');
    assert.equal(await page.getByTestId('ifpmic-child-history').count(), 0, 'scenario switch clears child history projection');
    assert.deepEqual(report.browserWriteRequests, [], 'child mock workflows issue no API writes');
    assert.deepEqual(report.apiRequests, [], 'child mock workflows make no API requests');
  });

  await record('question review-blocked checkpoint remains legible at 1440px and 375px', async () => {
    await selectScenario('spec-question-retry');
    await moveCheckpoint('review-blocked');
    await page.setViewportSize({ width: 1440, height: 1000 });
    const question = page.getByTestId('ifpmic-spec-observation');
    assert.equal(await question.getAttribute('data-current-review'), 'false');
    await question.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(evidenceDir, `${hostMode ? 'host' : 'standalone'}-spec-question-retry-review-blocked-desktop.png`), fullPage: true });
    report.evidence.push(`workflow-artifacts/verification/V2/ui/${hostMode ? 'host' : 'standalone'}-spec-question-retry-review-blocked-desktop.png`);
    await page.setViewportSize({ width: 375, height: 812 });
    await question.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    assert.ok(await question.isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(evidenceDir, `${hostMode ? 'host' : 'standalone'}-spec-question-retry-review-blocked-mobile-375.png`), fullPage: true });
    report.evidence.push(`workflow-artifacts/verification/V2/ui/${hostMode ? 'host' : 'standalone'}-spec-question-retry-review-blocked-mobile-375.png`);
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
