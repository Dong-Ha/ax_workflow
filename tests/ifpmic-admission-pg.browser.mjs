import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const timeoutMs = 45_000;
const stepTimeoutMs = 8_000;
const queuedTimeoutMs = 90_000;
const report = {
  kind: 'ifpmic.admission-read.postgres-browser.v1',
  verdict: 'fail',
  checks: [],
  unexpectedOriginCount: 0,
  createPostCount: 0,
  expectedMode: 'pending',
  screenshots: [],
  cleanup: { contextClosed: false, browserClosed: false },
};
let activeBrowser;
let activeContext;
let privateEvidenceReady = false;
let stopRequested = false;

function parseArgs(argv) {
  const values = new Map();
  let readExisting = false;
  let expectQueued = false;
  let expectMockTaskRead = false;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--expect-mock-task-read' && !expectMockTaskRead) {
      expectMockTaskRead = true;
      continue;
    }
    if (key === '--read-existing' && !readExisting) {
      readExisting = true;
      continue;
    }
    if (key === '--expect-queued' && !expectQueued) {
      expectQueued = true;
      continue;
    }
    if (!['--origin', '--issuer-origin', '--evidence'].includes(key) || values.has(key) || !argv[index + 1]) {
      throw new Error('invalid arguments');
    }
    values.set(key, argv[++index]);
  }
  if (values.size !== 3) throw new Error('missing arguments');
  return {
    origin: parseLoopbackOrigin(values.get('--origin')),
    issuerOrigin: parseLoopbackOrigin(values.get('--issuer-origin')),
    evidence: path.resolve(values.get('--evidence')),
    readExisting,
    expectQueued,
    expectMockTaskRead,
  };
}

function parseLoopbackOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.origin !== value && `${url.origin}/` !== value)) {
    throw new Error('origin must be a literal loopback HTTP origin with a port');
  }
  return url.origin;
}

function safeStep(name) {
  report.checks.push(name);
}

function assertPendingDto(dto, jobId, commandId) {
  assert.equal(dto?.schema_version, 'ifpmic.admission-status.v1');
  assert.deepEqual(Object.keys(dto).sort(), [
    'admission_status', 'admitted_run_id', 'applied_revision', 'command_id', 'command_status',
    'error_code', 'job_id', 'job_revision', 'job_status', 'receipt', 'schema_version',
  ].sort());
  assert.equal(dto.job_id, jobId);
  assert.equal(dto.command_id, commandId);
  assert.equal(dto.admission_status, 'pending');
  assert.equal(dto.job_status, 'DRAFT');
  assert.equal(dto.job_revision, 0);
  assert.equal(dto.command_status, 'accepted');
  assert.equal(dto.applied_revision, null);
  assert.equal(dto.admitted_run_id, null);
  assert.equal(dto.receipt, null);
  assert.equal(dto.error_code, null);
}

function assertAppliedDto(dto, jobId, commandId) {
  assert.equal(dto?.schema_version, 'ifpmic.admission-status.v1');
  assert.deepEqual(Object.keys(dto).sort(), [
    'admission_status', 'admitted_run_id', 'applied_revision', 'command_id', 'command_status',
    'error_code', 'job_id', 'job_revision', 'job_status', 'receipt', 'schema_version',
  ].sort());
  assert.equal(dto.job_id, jobId);
  assert.equal(dto.command_id, commandId);
  assert.equal(dto.admission_status, 'applied');
  assert.equal(dto.job_status, 'QUEUED');
  assert.equal(dto.job_revision, 1);
  assert.equal(dto.command_status, 'applied');
  assert.equal(dto.applied_revision, 1);
  assert.match(dto.admitted_run_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(dto.receipt, {
    transition_sequence: 1, outcome: 'applied', expected_revision: 0,
    applied_revision: 1, projected_job_status: 'QUEUED', projected_revision: 1,
  });
  assert.equal(dto.error_code, null);
}

async function runSmoke({ origin, issuerOrigin, evidence, readExisting, expectQueued, expectMockTaskRead }) {
  let queuedPage = null;
  let createReplay = null;
  if (stopRequested) throw new Error('stopped');
  if (origin === issuerOrigin) throw new Error('origins must be distinct');
  const ignoredRoot = path.resolve('workflow-artifacts');
  const rootInfo = await lstat(ignoredRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('artifact root must be a real directory');
  const parent = path.dirname(evidence);
  const parentRelative = path.relative(ignoredRoot, parent);
  if (!parentRelative || parentRelative.startsWith(`..${path.sep}`) || parentRelative === '..' || path.isAbsolute(parentRelative)) {
    throw new Error('evidence parent must be inside workflow-artifacts');
  }
  let current = ignoredRoot;
  for (const segment of parentRelative.split(path.sep)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('evidence ancestry must be real directories');
  }
  const parentInfo = await lstat(parent);
  if ((parentInfo.mode & 0o077) !== 0) throw new Error('evidence parent must be owner-only');
  const relativeEvidence = path.relative(ignoredRoot, evidence);
  if (!relativeEvidence || relativeEvidence.startsWith(`..${path.sep}`) || relativeEvidence === '..' || path.isAbsolute(relativeEvidence)) {
    throw new Error('evidence path must be a new directory under workflow-artifacts');
  }
  await mkdir(evidence, { mode: 0o700 });
  const evidenceInfo = await lstat(evidence);
  if (evidenceInfo.isSymbolicLink() || !evidenceInfo.isDirectory()) throw new Error('evidence path must be new');
  await chmod(evidence, 0o700);
  privateEvidenceReady = true;

  try {
    activeBrowser = await chromium.launch({ headless: true });
    if (stopRequested) throw new Error('stopped');
    activeContext = await activeBrowser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    if (stopRequested) throw new Error('stopped');
    activeContext.setDefaultTimeout(stepTimeoutMs);
    if (expectQueued && !readExisting) {
      queuedPage = await activeContext.newPage();
      queuedPage.setDefaultTimeout(stepTimeoutMs);
      queuedPage.on('request', request => {
        if (createReplay || request.method() !== 'POST' ||
            new URL(request.url()).origin !== origin || new URL(request.url()).pathname !== '/api/v1/jobs') return;
        const headers = request.headers();
        createReplay = {
          body: request.postData(),
          idempotencyKey: headers['idempotency-key'],
          csrf: headers['x-csrf-token'],
        };
      });
    }
    await activeContext.route('**/*', async route => {
      let requestOrigin;
      try { requestOrigin = new URL(route.request().url()).origin; }
      catch {
        report.unexpectedOriginCount += 1;
        await route.abort();
        return;
      }
      if (requestOrigin !== origin && requestOrigin !== issuerOrigin) {
        report.unexpectedOriginCount += 1;
        await route.abort();
        return;
      }
      const requestUrl = new URL(route.request().url());
      if (requestOrigin === origin && route.request().method() === 'POST' && requestUrl.pathname === '/api/v1/jobs') {
        report.createPostCount += 1;
      }
      await route.continue();
    });

    const page = queuedPage || await activeContext.newPage();
    page.setDefaultTimeout(stepTimeoutMs);
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const login = page.getByTestId('login-button');
    await login.waitFor({ state: 'visible' });
    await login.click();
    await page.waitForURL(url => url.origin === issuerOrigin && url.pathname === '/authorize');
    await page.getByTestId('login-a').click();
    await page.waitForURL(url => url.origin === origin && url.pathname === '/');
    await page.locator('#signed-in').waitFor({ state: 'visible' });
    safeStep('local_oidc_login_a_completed');

    if (expectQueued) {
      const contextResult = await page.evaluate(async () => {
        const response = await fetch('/demo/context', { credentials: 'same-origin', cache: 'no-store' });
        return { status: response.status, body: await response.json() };
      });
      assert.equal(contextResult.status, 200);
      assert.equal(contextResult.body?.schema_version, 'ifpmic.local-context.v2');
      assert.equal(contextResult.body?.execution_connected, true);
      assert.equal(contextResult.body?.project_id, 'ifpmic-local-demo');
      assert.equal(contextResult.body?.profile_version, 'local-demo-v1');
      safeStep('versioned_local_execution_context_connected');
    }

    if (readExisting) {
      const firstSavedJob = page.getByTestId('job-row').first();
      await firstSavedJob.waitFor({ state: 'visible' });
      await firstSavedJob.click();
      safeStep('existing_saved_job_selected_without_create');
    } else {
      await page.getByTestId('field-title').fill(expectQueued
        ? 'Synthetic local execution admission check' : 'Synthetic admission read browser check');
      await page.getByTestId('field-request-text').fill(expectQueued
        ? 'Check one local execution admission and its first state receipt.'
        : 'Verify one saved request remains pending after a read-only admission lookup.');
      await page.getByTestId('submit-request').click();
    }
    const expectedStoredStatus = expectQueued ? '접수 상태 확인됨' : '실행 접수 대기';
    const expectedJobStatus = expectQueued ? 'QUEUED' : 'DRAFT';
    await page.getByTestId('stored-admission-status').filter({ hasText: new RegExp(`^${expectedStoredStatus}$`) })
      .waitFor({ state: 'visible', timeout: expectQueued ? 60_000 : stepTimeoutMs });
    await page.getByTestId('detail-status').filter({ hasText: new RegExp(`^${expectedJobStatus}$`) })
      .waitFor({ state: 'visible', timeout: expectQueued ? 60_000 : stepTimeoutMs });

    const jobId = await page.getByTestId('detail-job-id').innerText();
    const domCommandId = await page.getByTestId('command-id').innerText();
    if (!readExisting) await page.getByTestId('command-status')
      .filter({ hasText: new RegExp(`^${expectQueued ? 'applied' : 'accepted'}$`) })
      .waitFor({ state: 'visible', timeout: expectQueued ? 60_000 : stepTimeoutMs });
    assert.match(jobId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    if (!readExisting) assert.match(domCommandId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const expectedInitialCreatePostCount = readExisting ? 0 : 1;
    assert.equal(report.createPostCount, expectedInitialCreatePostCount);
    if (!readExisting && !expectQueued) safeStep('one_create_saved_and_ui_shows_draft_pending');

    if (expectQueued && !readExisting) {
      assert.ok(createReplay?.body && createReplay.idempotencyKey && createReplay.csrf);
      const replay = await page.evaluate(async ({ body, idempotencyKey, csrf }) => {
        const response = await fetch('/api/v1/jobs', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey, 'X-CSRF-Token': csrf },
          body,
        });
        return { status: response.status, body: await response.json() };
      }, createReplay);
      assert.equal(replay.status, 202);
      assert.equal(replay.body?.status, 'accepted');
      assert.equal(replay.body?.resource_id, jobId);
      assert.equal(replay.body?.command_id, domCommandId);
      assert.equal(report.createPostCount, 2);
      safeStep('exact_same_key_and_body_replay_returns_original_create');
    }

    const readAdmission = async () => page.evaluate(async selectedJobId => {
      const response = await fetch(`/api/v1/jobs/${encodeURIComponent(selectedJobId)}/admission`, {
        credentials: 'same-origin', cache: 'no-store',
      });
      return { status: response.status, body: await response.json() };
    }, jobId);
    const direct = await readAdmission();
    assert.equal(direct.status, 200);
    const commandId = direct.body?.command_id;
    assert.match(commandId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    if (domCommandId) assert.equal(domCommandId, commandId);
    if (expectQueued) assertAppliedDto(direct.body, jobId, commandId);
    else assertPendingDto(direct.body, jobId, commandId);
    if (expectQueued) {
      const tuple = { job_id: jobId, command_id: commandId, admitted_run_id: direct.body.admitted_run_id };
      const tupleHandle = await open(path.join(evidence, 'admission-tuple.json'), 'wx', 0o600);
      await tupleHandle.writeFile(`${JSON.stringify(tuple)}\n`, 'utf8');
      await tupleHandle.sync();
      await tupleHandle.close();
      await chmod(path.join(evidence, 'admission-tuple.json'), 0o600);
      report.expectedMode = 'queued';
      safeStep('authenticated_same_job_command_run_and_first_applied_receipt_confirmed');
    } else {
      safeStep('authenticated_same_job_admission_tuple_is_pending_null_run_null_receipt');
    }

    await page.getByTestId('stored-admission-refresh').click();
    await page.waitForFunction(expected => document.querySelector('[data-testid="stored-admission-status"]')?.textContent === expected,
      expectedStoredStatus, { timeout: expectQueued ? 60_000 : stepTimeoutMs });
    assert.equal(await page.getByTestId('detail-job-id').innerText(), jobId);
    assert.equal(await page.getByTestId('detail-status').innerText(), expectedJobStatus);
    safeStep(expectQueued ? 'ui_refresh_preserves_same_job_queued' : 'ui_refresh_preserves_same_job_pending');

    const readMockTask = async () => page.evaluate(async selectedJobId => {
      const response = await fetch(`/api/v1/jobs/${encodeURIComponent(selectedJobId)}/mock-task`, {
        credentials: 'same-origin', cache: 'no-store',
      });
      return { status: response.status, body: await response.json() };
    }, jobId);
    const assertMockPending = response => {
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { schema_version: 'ifpmic.mock-task.v1', job_id: jobId,
        command_id: commandId, admitted_run_id: null, status: 'pending', result: null, completed_at: null });
    };
    if (expectMockTaskRead) {
      assertMockPending(await readMockTask());
      await page.getByTestId('stored-mock-task-refresh').click();
      await page.waitForFunction(() => document.getElementById('stored-mock-task-status')?.textContent === '저장된 모의 결과 없음');
      assert.equal(await page.locator('#stored-mock-task-run').isVisible(), false);
      assert.equal(await page.getByTestId('detail-status').innerText(), expectedJobStatus);
      safeStep('actual_api_pg_mock_result_pending_matches_same_job_command_without_execution');
    }

    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const jobAlias = '00000000-0000-4000-8000-000000000001';
    const commandAlias = '00000000-0000-4000-8000-000000000002';
    const runAlias = '00000000-0000-4000-8000-000000000003';
    const admittedRunId = expectQueued ? direct.body.admitted_run_id : null;
    const originalHash = await page.evaluate(() => location.hash);
    const originalAccountName = await page.locator('#account-name').innerText();
    const originalRowTitles = await page.locator('.row-info strong').allInnerTexts();
    await page.evaluate(({ jobId, commandId, admittedRunId, jobAlias, commandAlias, runAlias, originalRowTitles }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) node.textContent = node.textContent
        .replaceAll(jobId, jobAlias).replaceAll(commandId, commandAlias)
        .replaceAll(admittedRunId || '\u0000', runAlias);
      document.querySelector('#account-name').textContent = '계정 synthetic-user';
      document.querySelectorAll('.row-info strong').forEach((title, index) => {
        if (originalRowTitles[index]) title.textContent = `요청 synthetic-job-${index + 1}`;
      });
      history.replaceState(null, '', `${location.pathname}#job/${jobAlias}`);
    }, { jobId, commandId, admittedRunId, jobAlias, commandAlias, runAlias, originalRowTitles });
    const captureContainsIdentifiers = await page.evaluate(({ jobId, commandId, admittedRunId }) => {
      const visible = document.body.innerText;
      return visible.includes(jobId) || visible.includes(jobId.slice(0, 8)) || visible.includes(commandId) ||
        (Boolean(admittedRunId) && visible.includes(admittedRunId));
    }, { jobId, commandId, admittedRunId });
    assert.equal(captureContainsIdentifiers, false);
    const desktopPath = path.join(evidence, 'desktop.png');
    await page.screenshot({ path: desktopPath, fullPage: true });
    await chmod(desktopPath, 0o600);
    report.screenshots.push(path.relative(process.cwd(), desktopPath));
    await page.setViewportSize({ width: 375, height: 812 });
    const mobilePath = path.join(evidence, 'mobile-375.png');
    await page.screenshot({ path: mobilePath, fullPage: true });
    await chmod(mobilePath, 0o600);
    report.screenshots.push(path.relative(process.cwd(), mobilePath));
    await page.setViewportSize(viewport);
    await page.evaluate(({ jobId, commandId, admittedRunId, originalHash, originalAccountName, originalRowTitles }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        node.textContent = node.textContent.replaceAll('00000000-0000-4000-8000-000000000001', jobId)
          .replaceAll('00000000-0000-4000-8000-000000000002', commandId)
          .replaceAll('00000000-0000-4000-8000-000000000003', admittedRunId || '');
      }
      document.querySelector('#account-name').textContent = originalAccountName;
      document.querySelectorAll('.row-info strong').forEach((title, index) => {
        if (originalRowTitles[index]) title.textContent = originalRowTitles[index];
      });
      history.replaceState(null, '', `${location.pathname}${originalHash}`);
    }, { jobId, commandId, admittedRunId, originalHash, originalAccountName, originalRowTitles });
    safeStep('desktop_and_375px_captures_use_synthetic_identifier_aliases');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#signed-in').waitFor({ state: 'visible' });
    await page.getByTestId('detail-job-id').filter({ hasText: new RegExp(`^${jobId}$`) }).waitFor({ state: 'visible' });
    await page.waitForFunction(expected => document.querySelector('[data-testid="stored-admission-status"]')?.textContent === expected,
      expectedStoredStatus, { timeout: expectQueued ? 60_000 : stepTimeoutMs });
    if (await page.getByTestId('command-id').innerText()) {
      assert.equal(await page.getByTestId('command-id').innerText(), commandId);
    }
    assert.equal(await page.getByTestId('detail-status').innerText(), expectedJobStatus);
    const expectedCreatePostCount = readExisting ? 0 : expectQueued ? 2 : 1;
    assert.equal(report.createPostCount, expectedCreatePostCount);
    const afterReload = await readAdmission();
    assert.equal(afterReload.status, 200);
    if (expectQueued) {
      assertAppliedDto(afterReload.body, jobId, commandId);
      assert.equal(afterReload.body.admitted_run_id, direct.body.admitted_run_id);
    } else assertPendingDto(afterReload.body, jobId, commandId);
    assert.equal(report.unexpectedOriginCount, 0);
    safeStep(expectQueued ? 'reload_restores_same_job_command_run_receipt_without_create'
      : 'reload_restores_same_job_pending_without_second_create');
    if (expectMockTaskRead) {
      assertMockPending(await readMockTask());
      await page.waitForFunction(() => document.getElementById('stored-mock-task-status')?.textContent === '저장된 모의 결과 없음');
      safeStep('reload_rereads_same_stored_mock_result_without_new_create');
    }

    if (expectQueued || expectMockTaskRead) {
      await page.getByTestId('logout-button').click();
      await page.getByTestId('login-button').waitFor({ state: 'visible' });
      await page.getByTestId('login-button').click();
      await page.waitForURL(url => url.origin === issuerOrigin && url.pathname === '/authorize');
      await page.getByTestId('login-b').click();
      await page.waitForURL(url => url.origin === origin && url.pathname === '/');
      await page.locator('#signed-in').waitFor({ state: 'visible' });
      const denied = await page.evaluate(async selectedJobId => {
        const response = await fetch(`/api/v1/jobs/${encodeURIComponent(selectedJobId)}/admission`, {
          credentials: 'same-origin', cache: 'no-store',
        });
        const listing = await fetch('/api/v1/jobs?limit=50', { credentials: 'same-origin', cache: 'no-store' });
        return { status: response.status, listing: await listing.json() };
      }, jobId);
      assert.equal(denied.status, 403);
      if (expectMockTaskRead) assert.equal((await readMockTask()).status, 403);
      assert.equal(denied.listing.items.some(item => item.job_id === jobId), false);
      assert.equal(report.createPostCount, expectedCreatePostCount);
      safeStep('account_b_cannot_read_account_a_admission_or_job');
    }
  } catch (error) {
    if (stopRequested) {
      if (activeContext) await activeContext.close().catch(() => {});
      if (activeBrowser) await activeBrowser.close().catch(() => {});
    }
    throw error;
  }
}

let evidencePath;
let failure = null;
let reportHandle;
let overallTimer;
let runPromise;
let runSettled = false;
let rejectSignal;
const sigterm = new Promise((_, reject) => { rejectSignal = reject; });
const onSigterm = () => {
  stopRequested = true;
  rejectSignal(new Error('terminated'));
};
process.on('SIGTERM', onSigterm);

try {
  const args = parseArgs(process.argv.slice(2));
  report.expectedMode = args.expectQueued ? 'queued' : 'pending';
  evidencePath = args.evidence;
  const overallDeadline = new Promise((_, reject) => {
    overallTimer = setTimeout(() => {
      stopRequested = true;
      reject(new Error('deadline'));
  }, args.expectQueued ? queuedTimeoutMs : timeoutMs);
  });
  runPromise = runSmoke(args).then(value => { runSettled = true; return value; }, error => {
    runSettled = true;
    throw error;
  });
  await Promise.race([runPromise, overallDeadline, sigterm]);
} catch (error) {
  failure = 'browser-smoke-failed';
  report.verdict = 'fail';
  // Keep diagnostics private; the public report and stdout retain fixed codes.
  if (evidencePath && privateEvidenceReady) {
    const diagnostic = await open(path.join(evidencePath, 'failure-private.json'), 'wx', 0o600);
    try {
      await diagnostic.writeFile(JSON.stringify({ name: error?.name, message: error?.message,
        stack: error?.stack }) + '\n', 'utf8');
    } finally { await diagnostic.close(); }
  }
} finally {
  clearTimeout(overallTimer);
  if (!runSettled) stopRequested = true;
  if (activeContext) {
    await activeContext.close().catch(() => {});
    report.cleanup.contextClosed = activeContext.pages().length === 0;
  }
  if (activeBrowser) {
    await activeBrowser.close().catch(() => {});
    report.cleanup.browserClosed = !activeBrowser.isConnected();
  }
  if (runPromise && !runSettled) {
    await runPromise.catch(() => {});
    runSettled = true;
  }
  if (!failure) report.verdict = report.cleanup.contextClosed && report.cleanup.browserClosed ? 'pass' : 'fail';
  if (failure) report.failure = failure;
  if (evidencePath && privateEvidenceReady) {
    try {
      if ((await lstat(evidencePath)).isSymbolicLink()) throw new Error('evidence directory must not be a symlink');
      reportHandle = await open(path.join(evidencePath, 'result.json'), 'wx', 0o600);
      await reportHandle.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
      await reportHandle.sync();
      await reportHandle.close();
    } catch {
      failure = 'evidence-write-failed';
      report.verdict = 'fail';
      await reportHandle?.close().catch(() => {});
    }
  }
  process.off('SIGTERM', onSigterm);
}

console.log(JSON.stringify({
  verdict: report.verdict,
  checks: report.checks.length,
  unexpectedOriginCount: report.unexpectedOriginCount,
  createPostCount: report.createPostCount,
  screenshots: report.screenshots,
  cleanup: report.cleanup,
  failure,
}));
if (report.verdict !== 'pass') process.exitCode = 1;
