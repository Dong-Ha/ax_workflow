import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = 'http://ifpmic-admission.invalid';
const outputRoot = path.resolve('workflow-artifacts/delivery/admission-mock');
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const runDir = path.join(outputRoot, runId);
const timeoutMs = 8_000;
const ids = {
  a1: '10000000-0000-4000-8000-000000000001',
  a2: '10000000-0000-4000-8000-000000000002',
  b: '20000000-0000-4000-8000-000000000001',
};
const accountA = 'synthetic-user-a';
const accountB = 'synthetic-user-b';
const contextDto = {
  project_id: 'ifpmic-local-demo', profile_version: 'local-demo-v1',
  release_modes: ['team_github_tag'], execution_connected: false,
  storage: 'postgresql', identity: 'local-demo-oidc',
};

const report = { kind: 'ifpmic.admission-mock.browser.v1', verdict: 'fail', checks: [], failures: [], unexpectedRequests: [], writes: [], screenshots: [] };
let browser;
let browserContext;
let page;
let account = accountA;
let holdA1Detail = false;
let releaseHeldA1;
let heldA1Seen;
let jobDetailReads = 0;

function record(name) { report.checks.push({ name, verdict: 'pass' }); }

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

function json(route, status, body) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body), headers: { 'cache-control': 'no-store' } });
}

function job(jobId) {
  return { job_id: jobId, status: 'DRAFT', current_step_ids: [], cycle: 0, revision: 1,
    workflow_version: 'synthetic-workflow-v1', profile_version: 'local-demo-v1' };
}

async function routeRequest(route) {
  const request = route.request();
  let url;
  try { url = new URL(request.url()); } catch { report.unexpectedRequests.push('invalid-url'); return route.abort(); }
  if (url.origin !== origin || url.protocol !== 'http:') {
    report.unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
    return route.abort();
  }

  const method = request.method();
  const pathname = url.pathname;
  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: await readFile(new URL('../experiments/ifpmic-live/web/index.html', import.meta.url)) });
  }
  const staticFiles = new Map([
    ['/app.js', ['../experiments/ifpmic-live/web/app.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['../experiments/ifpmic-live/web/style.css', 'text/css; charset=utf-8']],
    ['/admission.js', ['../experiments/ifpmic-live/web/admission.js', 'text/javascript; charset=utf-8']],
    ['/admission.css', ['../experiments/ifpmic-live/web/admission.css', 'text/css; charset=utf-8']],
  ]);
  if (method === 'GET' && staticFiles.has(pathname)) {
    const [relative, contentType] = staticFiles.get(pathname);
    let bytes;
    try { bytes = await readFile(new URL(relative, import.meta.url)); }
    catch { return route.fulfill({ status: 404, body: 'not found' }); }
    return route.fulfill({ status: 200, contentType, body: bytes });
  }
  if (pathname.startsWith('/api/') || pathname.startsWith('/auth/') || pathname === '/demo/context') {
    if (method !== 'GET') {
      report.writes.push(`${method} ${pathname}`);
      if (method === 'POST' && pathname === '/auth/logout') {
        account = null;
        return route.fulfill({ status: 204 });
      }
      return json(route, 405, { code: 'METHOD_NOT_ALLOWED' });
    }
    if (pathname === '/api/v1/session') {
      return account
        ? json(route, 200, { user_id: account, csrf_token: 'synthetic-csrf', mode: 'mock' })
        : json(route, 401, { code: 'AUTH_REQUIRED' });
    }
    if (pathname === '/demo/context') return json(route, 200, contextDto);
    if (pathname === '/api/v1/jobs') {
      const items = account === accountA ? [job(ids.a1), job(ids.a2)] : account === accountB ? [job(ids.b)] : [];
      return json(route, 200, { items, next_cursor: null });
    }
    const match = pathname.match(/^\/api\/v1\/jobs\/([^/]+)$/);
    if (match) {
      const jobId = decodeURIComponent(match[1]);
      jobDetailReads += 1;
      if (holdA1Detail && account === accountA && jobId === ids.a1) {
        heldA1Seen?.();
        await new Promise(resolve => { releaseHeldA1 = resolve; });
        holdA1Detail = false;
      }
      const own = account === accountA ? [ids.a1, ids.a2] : account === accountB ? [ids.b] : [];
      return own.includes(jobId) ? json(route, 200, { job: job(jobId), steps: [] }) : json(route, 403, { code: 'FORBIDDEN' });
    }
    const commandMatch = pathname.match(/^\/api\/v1\/commands\/([^/]+)$/);
    if (commandMatch) return json(route, 200, { command_id: decodeURIComponent(commandMatch[1]), status: 'accepted' });
    return json(route, 404, { code: 'NOT_FOUND' });
  }
  report.unexpectedRequests.push(`${method} ${pathname}`);
  return route.abort();
}

async function check(name, action) {
  try { await action(); record(name); }
  catch (error) {
    report.failures.push({ name, error: error?.name || 'Error', finding: String(error?.message || error).slice(0, 240) });
    throw error;
  }
}

try {
  await mkdir(runDir, { recursive: true });
  browser = await chromium.launch({ headless: true });
  browserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  browserContext.setDefaultTimeout(timeoutMs);
  await browserContext.route('**/*', routeRequest);
  page = await browserContext.newPage();
  page.setDefaultTimeout(timeoutMs);
  page.on('pageerror', error => report.failures.push({ name: 'page-error', error: error?.name || 'Error' }));
  await bounded(page.goto(origin, { waitUntil: 'domcontentloaded' }), 'open app');
  await page.locator('#signed-in').waitFor({ state: 'visible' });
  const panel = page.getByTestId('admission-panel');
  const status = page.getByTestId('admission-status');
  const description = page.getByTestId('admission-description');
  const scenario = page.getByTestId('admission-scenario');
  const waitAdmissionStatus = value => page.waitForFunction(expected => document.querySelector('[data-testid="admission-status"]')?.textContent === expected, value);

  await check('admission panel starts hidden until selecting a persisted job detail', async () => {
    await panel.waitFor({ state: 'hidden' });
    await page.locator(`[data-testid="job-row"][data-job-id="${ids.a1}"]`).click();
    await page.getByTestId('job-detail').waitFor({ state: 'visible' });
    await panel.waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('heading', { name: '모의 접수 상태' }).innerText(), '모의 접수 상태');
    await waitAdmissionStatus('접수 대기 · 모의');
  });

  await check('pending, admitted, error, refresh and recovery remain mock-only and preserve DRAFT', async () => {
    await scenario.selectOption('admitted');
    await waitAdmissionStatus('접수됨 · 모의');
    assert.equal(await page.getByTestId('detail-status').innerText(), 'DRAFT');
    await scenario.selectOption('error');
    await waitAdmissionStatus('조회 실패 · 모의');
    await scenario.selectOption('pending');
    await waitAdmissionStatus('접수 대기 · 모의');
    const readsBeforeRefresh = jobDetailReads;
    await page.getByTestId('admission-refresh').click();
    assert.equal(await page.getByTestId('admission-panel').getAttribute('aria-busy'), 'true');
    await page.waitForFunction(() => document.querySelector('[data-testid="admission-panel"]')?.getAttribute('aria-busy') === 'false');
    await waitAdmissionStatus('접수 대기 · 모의');
    assert.equal(jobDetailReads, readsBeforeRefresh, 'admission refresh uses only its mock provider');
    assert.ok((await description.innerText()).length > 0, 'mock provider description is shown');
    assert.equal(await page.getByTestId('detail-status').innerText(), 'DRAFT');
    assert.equal(await page.getByTestId('detail-status').innerText(), 'DRAFT');
  });

  await check('selecting another job clears old admission state before reading the new detail', async () => {
    await scenario.selectOption('admitted');
    await page.locator(`[data-testid="job-row"][data-job-id="${ids.a2}"]`).click();
    await page.waitForFunction(expected => document.querySelector('[data-testid="detail-job-id"]')?.textContent === expected, ids.a2);
    await panel.waitFor({ state: 'visible' });
    await waitAdmissionStatus('접수 대기 · 모의');
    assert.equal(await page.getByTestId('detail-status').innerText(), 'DRAFT');
  });

  await check('late detail response for the previous selection is discarded', async () => {
    let markSeen;
    heldA1Seen = () => markSeen?.();
    const seen = new Promise(resolve => { markSeen = resolve; });
    holdA1Detail = true;
    await page.locator(`[data-testid="job-row"][data-job-id="${ids.a1}"]`).click();
    await bounded(seen, 'observe delayed old detail request');
    await page.locator(`[data-testid="job-row"][data-job-id="${ids.a2}"]`).click();
    await page.waitForFunction(expected => document.querySelector('[data-testid="detail-job-id"]')?.textContent === expected, ids.a2);
    releaseHeldA1?.();
    await page.waitForTimeout(50);
    assert.equal(await page.getByTestId('detail-job-id').innerText(), ids.a2);
    assert.equal(await page.getByTestId('detail-status').innerText(), 'DRAFT');
  });

  await check('reload restores selected job and scenario, then rereads its detail', async () => {
    await scenario.selectOption('admitted');
    const readsBeforeReload = jobDetailReads;
    await bounded(page.reload({ waitUntil: 'domcontentloaded' }), 'reload selected job');
    await page.getByTestId('job-detail').waitFor({ state: 'visible' });
    await panel.waitFor({ state: 'visible' });
    assert.equal(await page.getByTestId('detail-job-id').innerText(), ids.a2);
    assert.equal(await page.getByTestId('detail-status').innerText(), 'DRAFT');
    await waitAdmissionStatus('접수됨 · 모의');
    assert.ok(jobDetailReads > readsBeforeReload, 'reload rereads detail from the mock API');
  });

  await check('logout clears admission panel and late old-account detail cannot appear after account switch', async () => {
    let markSeen;
    heldA1Seen = () => markSeen?.();
    const seen = new Promise(resolve => { markSeen = resolve; });
    holdA1Detail = true;
    await page.locator(`[data-testid="job-row"][data-job-id="${ids.a1}"]`).click();
    await bounded(seen, 'observe delayed old-account detail request');
    await page.getByTestId('logout-button').click();
    await page.locator('#auth-gate').waitFor({ state: 'visible' });
    await panel.waitFor({ state: 'hidden' });
    releaseHeldA1?.();
    account = accountB;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#signed-in').waitFor({ state: 'visible' });
    assert.equal(await page.locator(`[data-testid="job-row"][data-job-id="${ids.a1}"]`).count(), 0);
    await page.locator(`[data-testid="job-row"][data-job-id="${ids.b}"]`).click();
    await page.getByTestId('job-detail').waitFor({ state: 'visible' });
    await panel.waitFor({ state: 'visible' });
    assert.equal(await page.getByTestId('detail-job-id').innerText(), ids.b);
    await waitAdmissionStatus('접수 대기 · 모의');
  });

  await check('desktop and mobile synthetic views have no horizontal overflow', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const desktop = path.join(runDir, 'desktop.png');
    await page.screenshot({ path: desktop, fullPage: true });
    report.screenshots.push(path.relative(process.cwd(), desktop));
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const mobile = path.join(runDir, 'mobile-375.png');
    await page.screenshot({ path: mobile, fullPage: true });
    report.screenshots.push(path.relative(process.cwd(), mobile));
  });

  await check('network stayed in the explicit static/API allowlist and writes were logout only', async () => {
    assert.deepEqual(report.unexpectedRequests, []);
    assert.deepEqual(report.writes, ['POST /auth/logout']);
  });
} catch (error) {
  report.failures.push({ name: 'harness', error: error?.name || 'Error', finding: String(error?.message || error).slice(0, 240) });
} finally {
  releaseHeldA1?.();
  if (browserContext) await browserContext.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  report.verdict = report.failures.length === 0 && report.checks.length > 0 ? 'pass' : 'fail';
  await mkdir(runDir, { recursive: true });
  const outputFile = path.join(runDir, 'report.json');
  await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ verdict: report.verdict, report: path.relative(process.cwd(), outputFile), checks: report.checks.length, failures: report.failures.length, screenshots: report.screenshots.length })}\n`);
  if (report.verdict !== 'pass') process.exitCode = 1;
}
