import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { mockTaskFixture } from '../experiments/ifpmic-live/web/mock-task.js';

const origin = 'http://ifpmic-admission.invalid';
const taskMode = process.argv.includes('--mock-task');
const readMode = process.argv.includes('--stored-mock-task');
const outputRoot = path.resolve(`workflow-artifacts/delivery/${readMode ? 'mock-result-read' : taskMode ? 'mock-result-contract' : 'admission-mock'}`);
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

const report = { kind: readMode ? 'ifpmic.mock-result-read.browser.v1' : taskMode ? 'ifpmic.mock-result.browser.v1' : 'ifpmic.admission-mock.browser.v1', verdict: 'fail', checks: [], failures: [], unexpectedRequests: [], writes: [], screenshots: [] };
let browser;
let browserContext;
let page;
let account = accountA;
let holdA1Detail = false;
let releaseHeldA1;
let heldA1Seen;
let jobDetailReads = 0;
const admissionModes = new Map();
const admissionReads = new Map();
const taskReadModes = new Map();
const taskReads = new Map();

function admission(jobId) {
  const mode = admissionModes.get(jobId) || 'pending';
  if (mode === 'unavailable') return { status: 503, body: { code: 'DEPENDENCY_UNAVAILABLE' } };
  const applied = mode === 'applied';
  const value = {
    schema_version: 'ifpmic.admission-status.v1', job_id: jobId,
    command_id: jobId === ids.a1 ? '10000000-0000-4000-8000-000000000011'
      : jobId === ids.a2 ? '10000000-0000-4000-8000-000000000012' : '20000000-0000-4000-8000-000000000011',
    admission_status: applied ? 'applied' : 'pending', job_status: applied ? 'QUEUED' : 'DRAFT',
    job_revision: applied ? 1 : 0, command_status: applied ? 'applied' : 'accepted',
    applied_revision: applied ? 1 : null,
    admitted_run_id: applied ? '10000000-0000-4000-8000-000000000021' : null,
    receipt: applied ? { transition_sequence: 1, outcome: 'applied', expected_revision: 0,
      applied_revision: 1, projected_job_status: 'QUEUED', projected_revision: 1 } : null,
    error_code: null,
  };
  if (mode === 'malformed') value.receipt = { ...value.receipt, transition_sequence: 2 };
  return { status: 200, body: value };
}

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
    ['/context.js', ['../experiments/ifpmic-live/web/context.js', 'text/javascript; charset=utf-8']],
    ['/admission-read.js', ['../experiments/ifpmic-live/web/admission-read.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['../experiments/ifpmic-live/web/style.css', 'text/css; charset=utf-8']],
    ['/admission.js', ['../experiments/ifpmic-live/web/admission.js', 'text/javascript; charset=utf-8']],
    ['/resource-read.js', ['../experiments/ifpmic-live/web/resource-read.js', 'text/javascript; charset=utf-8']],
    ['/mock-task-read.js', ['../experiments/ifpmic-live/web/mock-task-read.js', 'text/javascript; charset=utf-8']],
    ['/mock-task.js', ['../experiments/ifpmic-live/web/mock-task.js', 'text/javascript; charset=utf-8']],
    ['/mock-task-panel.js', ['../experiments/ifpmic-live/web/mock-task-panel.js', 'text/javascript; charset=utf-8']],
    ['/mock-task.css', ['../experiments/ifpmic-live/web/mock-task.css', 'text/css; charset=utf-8']],
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
    const taskMatch = pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/mock-task$/);
    if (taskMatch) {
      const jobId = decodeURIComponent(taskMatch[1]);
      taskReads.set(jobId, (taskReads.get(jobId) || 0) + 1);
      const own = account === accountA ? [ids.a1, ids.a2] : account === accountB ? [ids.b] : [];
      if (!own.includes(jobId)) return json(route, 403, { code: 'FORBIDDEN' });
      const mode = taskReadModes.get(jobId) || 'pending';
      if (mode === 'unavailable') return json(route, 503, { code: 'DEPENDENCY_UNAVAILABLE' });
      if (mode === 'denied') return json(route, 403, { code: 'FORBIDDEN' });
      const dto = mockTaskFixture(jobId, mode === 'completed' ? 'completed' : 'pending');
      dto.command_id = admission(jobId).body.command_id;
      if (mode === 'completed') dto.admitted_run_id = admission(jobId).body.admitted_run_id;
      if (mode === 'malformed') dto.raw_output = 'private fixture';
      return json(route, 200, dto);
    }
    const admissionMatch = pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/admission$/);
    if (admissionMatch) {
      const jobId = decodeURIComponent(admissionMatch[1]);
      admissionReads.set(jobId, (admissionReads.get(jobId) || 0) + 1);
      const own = account === accountA ? [ids.a1, ids.a2] : account === accountB ? [ids.b] : [];
      if (!own.includes(jobId)) return json(route, 403, { code: 'FORBIDDEN' });
      const result = admission(jobId);
      return json(route, result.status, result.body);
    }
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
  await mkdir(runDir, { recursive: true, mode: 0o700 });
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

  if (!taskMode && !readMode) {
  await check('admission panel starts hidden until selecting a persisted job detail', async () => {
    await panel.waitFor({ state: 'hidden' });
    await page.locator(`[data-testid="job-row"][data-job-id="${ids.a1}"]`).click();
    await page.getByTestId('job-detail').waitFor({ state: 'visible' });
    await panel.waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('heading', { name: '모의 접수 상태' }).innerText(), '모의 접수 상태');
    await waitAdmissionStatus('접수 대기 · 모의');
    await page.getByTestId('stored-admission').waitFor({ state: 'visible' });
    assert.equal(await page.getByTestId('stored-admission-status').innerText(), '실행 접수 대기');
  });

  await check('canonical applied admission tuple alone updates the current job to QUEUED and exposes its run ID', async () => {
    admissionModes.set(ids.a1, 'applied');
    await page.getByTestId('stored-admission-refresh').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="stored-admission-status"]')?.textContent === '접수 상태 확인됨');
    assert.equal(await page.getByTestId('detail-status').innerText(), 'QUEUED');
    assert.equal(await page.locator(`[data-testid="job-row"][data-job-id="${ids.a1}"] .row-status`).innerText(), 'QUEUED');
    assert.equal(await page.getByTestId('stored-admission-run-id').innerText(), '10000000-0000-4000-8000-000000000021');
  });

  await check('later 503 keeps the confirmed admission and run ID without inventing a new success', async () => {
    admissionModes.set(ids.a1, 'unavailable');
    await page.getByTestId('stored-admission-refresh').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="stored-admission-status"]')?.textContent === '접수 상태 조회 실패');
    assert.equal(await page.getByTestId('detail-status').innerText(), 'QUEUED');
    assert.equal(await page.locator('#stored-admission-confirmed').innerText(), '마지막 확인: 접수 상태 확인됨');
    assert.equal(await page.getByTestId('stored-admission-run-id').innerText(), '10000000-0000-4000-8000-000000000021');
    admissionModes.set(ids.a1, 'pending');
    await page.getByTestId('stored-admission-refresh').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="stored-admission-status"]')?.textContent === '실행 접수 대기');
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
    assert.equal(await page.getByTestId('stored-admission-status').innerText(), '실행 접수 대기');
  });

  await check('malformed receipt tuple fails closed and cannot render QUEUED', async () => {
    admissionModes.set(ids.a2, 'malformed');
    await page.getByTestId('stored-admission-refresh').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="stored-admission-status"]')?.textContent === '접수 상태 조회 실패');
    assert.equal(await page.getByTestId('detail-status').innerText(), 'DRAFT');
    assert.equal(await page.getByTestId('stored-admission-run-id').count(), 1);
    assert.equal(await page.locator('#stored-admission-run').isVisible(), false);
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

  } else if (taskMode) {
    const taskPanel = page.getByTestId('mock-task-panel');
    const taskScenario = page.getByTestId('mock-task-scenario');
    const taskStatus = page.getByTestId('mock-task-status');
    const waitTask = value => page.waitForFunction(expected => document.getElementById('mock-task-status')?.textContent === expected, value);
    const selectJob = async jobId => {
      await page.locator(`[data-testid="job-row"][data-job-id="${jobId}"]`).click();
      await page.waitForFunction(expected => document.getElementById('mock-task-panel')?.dataset.jobId === expected && document.getElementById('mock-task-panel')?.dataset.phase === 'pending', jobId);
    };
    await check('task result is hidden until a visible job is selected; pending is explicitly synthetic', async () => {
      await taskPanel.waitFor({ state: 'hidden' });
      await selectJob(ids.a1);
      await waitTask('모의 결과 대기');
      assert.match(await taskPanel.innerText(), /합성 데이터/);
      assert.equal(await page.locator('#mock-task-checks').isVisible(), false);
    });
    await check('completed example shows three bounded results without changing persisted job or admission', async () => {
      await taskScenario.selectOption('completed');
      await waitTask('모의 확인 완료');
      assert.equal(await page.locator('#mock-task-checks li').count(), 3);
      assert.match(await taskPanel.innerText(), /전체 업무 완료와는 별개/);
      assert.equal(await page.getByTestId('detail-status').innerText(), 'DRAFT');
      assert.equal(await page.getByTestId('stored-admission-status').innerText(), '실행 접수 대기');
      assert.match(await page.locator('#mock-task-run').innerText(), /예시 실행 ID/);
      assert.notEqual(await page.locator('#mock-task-run-id').innerText(), '');
      assert.equal(await page.locator('#stored-admission-run').isVisible(), false);
    });
    await check('result failure retains last confirmation and refresh performs no API request', async () => {
      const readsBefore = jobDetailReads;
      await taskScenario.selectOption('error');
      await waitTask('모의 결과 조회 실패');
      assert.equal(await page.locator('#mock-task-confirmed').innerText(), '마지막 확인: 모의 확인 완료');
      assert.equal(await page.locator('#mock-task-checks li').count(), 3);
      await page.getByTestId('mock-task-refresh').click();
      await waitTask('모의 결과 조회 실패');
      assert.equal(jobDetailReads, readsBefore);
      await taskScenario.selectOption('completed');
      await waitTask('모의 확인 완료');
    });
    await check('reload restores scenario by account and job, without storing results or synthetic run IDs', async () => {
      const values = await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.endsWith(':mock-task-demo')).map(key => JSON.parse(sessionStorage.getItem(key))));
      assert.deepEqual(values, [{ job_id: ids.a1, scenario: 'completed' }]);
      const before = jobDetailReads;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitTask('모의 확인 완료');
      assert.equal(await taskPanel.getAttribute('data-job-id'), ids.a1);
      assert.ok(jobDetailReads > before);
    });
    await check('changing jobs discards the old completion and returns to pending', async () => {
      await taskScenario.selectOption('completed');
      await selectJob(ids.a2);
      await waitTask('모의 결과 대기');
      assert.equal(await page.locator('#mock-task-checks').isVisible(), false);
      assert.equal(await page.locator('#mock-task-run-id').innerText(), '');
      assert.equal(await page.locator('#mock-task-confirmed').isVisible(), false);
    });
    await check('logout clears old results and another account sees its own pending example', async () => {
      await taskScenario.selectOption('completed');
      await waitTask('모의 확인 완료');
      await page.getByTestId('logout-button').click();
      await page.locator('#auth-gate').waitFor({ state: 'visible' });
      await taskPanel.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#mock-task-run-id').innerText(), '');
      account = accountB;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#signed-in').waitFor({ state: 'visible' });
      await selectJob(ids.b);
      await waitTask('모의 결과 대기');
      assert.equal(await taskScenario.inputValue(), 'pending');
      assert.equal(await page.locator(`[data-testid="job-row"][data-job-id="${ids.a1}"]`).count(), 0);
      await taskScenario.selectOption('completed');
      await waitTask('모의 확인 완료');
    });
    await check('keyboard users can focus and operate result controls', async () => {
      await taskScenario.focus();
      assert.equal(await taskScenario.evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('Tab');
      assert.equal(await page.getByTestId('mock-task-refresh').evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('Enter');
      await waitTask('모의 확인 완료');
    });
  }

  if (readMode) {
    const stored = page.getByTestId('stored-mock-task');
    const waitStored = value => page.waitForFunction(expected => document.getElementById('stored-mock-task-status')?.textContent === expected, value);
    await check('real read panel waits for a selected job and displays no stored result independently of the fixture panel', async () => {
      await stored.waitFor({ state: 'hidden' });
      await page.locator(`[data-testid="job-row"][data-job-id="${ids.a1}"]`).click();
      await waitStored('저장된 모의 결과 없음');
      assert.ok(taskReads.get(ids.a1) > 0);
      await page.getByTestId('mock-task-scenario').selectOption('completed');
      await page.waitForFunction(() => document.getElementById('mock-task-status')?.textContent === '모의 확인 완료');
      assert.equal(await page.getByTestId('stored-mock-task-status').innerText(), '저장된 모의 결과 없음');
      assert.equal(await page.locator('#stored-mock-task-run').isVisible(), false);
    });
    await check('canonical stored completion exposes only three safe checks and the same admitted run', async () => {
      admissionModes.set(ids.a1, 'applied');
      taskReadModes.set(ids.a1, 'completed');
      await page.getByTestId('stored-admission-refresh').click();
      await page.waitForFunction(() => document.getElementById('stored-admission-status')?.textContent === '접수 상태 확인됨');
      await page.getByTestId('stored-mock-task-refresh').click();
      await waitStored('모의 작업 확인 완료');
      assert.equal(await page.locator('#stored-mock-task-checks li').count(), 3);
      assert.equal(await page.getByTestId('stored-mock-task-run-id').innerText(), await page.getByTestId('stored-admission-run-id').innerText());
      assert.equal(await page.getByTestId('detail-status').innerText(), 'QUEUED');
      assert.match(await stored.innerText(), /전체 업무 완료와 별개/);
    });
    await check('503 retains the confirmed stored result; malformed response does not leak its raw fields', async () => {
      taskReadModes.set(ids.a1, 'unavailable');
      await page.getByTestId('stored-mock-task-refresh').click();
      await waitStored('저장 결과 조회 실패');
      assert.equal(await page.locator('#stored-mock-task-confirmed').innerText(), '마지막 확인: 모의 작업 확인 완료');
      assert.equal(await page.locator('#stored-mock-task-checks li').count(), 3);
      taskReadModes.set(ids.a1, 'malformed');
      await page.getByTestId('stored-mock-task-refresh').click();
      await waitStored('저장 결과 조회 실패');
      assert.doesNotMatch(await stored.innerText(), /private fixture|raw_output/);
      taskReadModes.set(ids.a1, 'completed');
    });
    await check('reload rereads the same job and result without persisting API result data', async () => {
      const before = taskReads.get(ids.a1);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitStored('모의 작업 확인 완료');
      assert.ok(taskReads.get(ids.a1) > before);
      const values = await page.evaluate(() => Object.values(sessionStorage));
      assert.doesNotMatch(JSON.stringify(values), /ifpmic.mock-task.v1|result_sha256|completed_at/);
    });
    await check('job change clears confirmed result and denied read removes the visible detail', async () => {
      await page.locator(`[data-testid="job-row"][data-job-id="${ids.a2}"]`).click();
      await waitStored('저장된 모의 결과 없음');
      assert.equal(await page.locator('#stored-mock-task-run-id').innerText(), '');
      taskReadModes.set(ids.a2, 'denied');
      await page.getByTestId('stored-mock-task-refresh').click();
      await page.getByTestId('job-detail').waitFor({ state: 'hidden' });
      assert.equal(await stored.isVisible(), false);
      assert.match(await page.getByTestId('detail-error').innerText(), /권한/);
    });
    await check('account change cannot restore a previous account result', async () => {
      await page.getByTestId('logout-button').click();
      await page.locator('#auth-gate').waitFor({ state: 'visible' });
      account = accountB;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#signed-in').waitFor({ state: 'visible' });
      await page.locator(`[data-testid="job-row"][data-job-id="${ids.b}"]`).click();
      await waitStored('저장된 모의 결과 없음');
      assert.equal(await page.locator('#stored-mock-task-run-id').innerText(), '');
      admissionModes.set(ids.b, 'applied');
      taskReadModes.set(ids.b, 'completed');
      await page.getByTestId('stored-admission-refresh').click();
      await page.waitForFunction(() => document.getElementById('stored-admission-status')?.textContent === '접수 상태 확인됨');
      await page.getByTestId('stored-mock-task-refresh').click();
      await waitStored('모의 작업 확인 완료');
    });
  }

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
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const outputFile = path.join(runDir, 'report.json');
  await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ verdict: report.verdict, report: path.relative(process.cwd(), outputFile), checks: report.checks.length, failures: report.failures.length, screenshots: report.screenshots.length })}\n`);
  if (report.verdict !== 'pass') process.exitCode = 1;
}
