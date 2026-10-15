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

  await record('catalog exposes all 32 frozen scenarios and starts each at cursor zero', async () => {
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

  await record('all 32 scenarios reach their fixed endpoint through the end-observation control', async () => {
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
