import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const timeoutMs = 45_000;
const stepTimeoutMs = 8_000;
const report = {
  kind: 'ifpmic.admission-read.postgres-browser.v1',
  verdict: 'fail',
  checks: [],
  unexpectedOriginCount: 0,
  createPostCount: 0,
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
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--read-existing' && !readExisting) {
      readExisting = true;
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

async function runSmoke({ origin, issuerOrigin, evidence, readExisting }) {
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

    const page = await activeContext.newPage();
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

    if (readExisting) {
      const firstSavedJob = page.getByTestId('job-row').first();
      await firstSavedJob.waitFor({ state: 'visible' });
      await firstSavedJob.click();
      safeStep('existing_saved_job_selected_without_create');
    } else {
      await page.getByTestId('field-title').fill('Synthetic admission read browser check');
      await page.getByTestId('field-request-text').fill('Verify one saved request remains pending after a read-only admission lookup.');
      await page.getByTestId('submit-request').click();
    }
    await page.getByTestId('stored-admission-status').filter({ hasText: /^실행 접수 대기$/ })
      .waitFor({ state: 'visible' });
    await page.getByTestId('detail-status').filter({ hasText: /^DRAFT$/ }).waitFor({ state: 'visible' });

    const jobId = await page.getByTestId('detail-job-id').innerText();
    const domCommandId = await page.getByTestId('command-id').innerText();
    if (!readExisting) await page.getByTestId('command-status').filter({ hasText: /^accepted$/ }).waitFor({ state: 'visible' });
    assert.match(jobId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    if (!readExisting) assert.match(domCommandId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const expectedCreatePostCount = readExisting ? 0 : 1;
    assert.equal(report.createPostCount, expectedCreatePostCount);
    if (!readExisting) safeStep('one_create_saved_and_ui_shows_draft_pending');

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
    assertPendingDto(direct.body, jobId, commandId);
    safeStep('authenticated_same_job_admission_tuple_is_pending_null_run_null_receipt');

    await page.getByTestId('stored-admission-refresh').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="stored-admission-status"]')?.textContent === '실행 접수 대기');
    assert.equal(await page.getByTestId('detail-job-id').innerText(), jobId);
    assert.equal(await page.getByTestId('detail-status').innerText(), 'DRAFT');
    safeStep('ui_refresh_preserves_same_job_pending');

    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const jobAlias = '00000000-0000-4000-8000-000000000001';
    const commandAlias = '00000000-0000-4000-8000-000000000002';
    const originalHash = await page.evaluate(() => location.hash);
    const originalAccountName = await page.locator('#account-name').innerText();
    const originalRowTitles = await page.locator('.row-info strong').allInnerTexts();
    await page.evaluate(({ jobId, commandId, jobAlias, commandAlias, originalRowTitles }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        node.textContent = node.textContent.replaceAll(jobId, jobAlias).replaceAll(commandId, commandAlias);
      }
      document.querySelector('#account-name').textContent = '계정 synthetic-user';
      document.querySelectorAll('.row-info strong').forEach((title, index) => {
        if (originalRowTitles[index]) title.textContent = `요청 synthetic-job-${index + 1}`;
      });
      history.replaceState(null, '', `${location.pathname}#job/${jobAlias}`);
    }, { jobId, commandId, jobAlias, commandAlias, originalRowTitles });
    const captureContainsIdentifiers = await page.evaluate(({ jobId, commandId }) => {
      const visible = document.body.innerText;
      return visible.includes(jobId) || visible.includes(jobId.slice(0, 8)) || visible.includes(commandId);
    }, { jobId, commandId });
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
    await page.evaluate(({ jobId, commandId, originalHash, originalAccountName, originalRowTitles }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        node.textContent = node.textContent.replaceAll('00000000-0000-4000-8000-000000000001', jobId)
          .replaceAll('00000000-0000-4000-8000-000000000002', commandId);
      }
      document.querySelector('#account-name').textContent = originalAccountName;
      document.querySelectorAll('.row-info strong').forEach((title, index) => {
        if (originalRowTitles[index]) title.textContent = originalRowTitles[index];
      });
      history.replaceState(null, '', `${location.pathname}${originalHash}`);
    }, { jobId, commandId, originalHash, originalAccountName, originalRowTitles });
    safeStep('desktop_and_375px_captures_use_synthetic_identifier_aliases');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#signed-in').waitFor({ state: 'visible' });
    await page.getByTestId('detail-job-id').filter({ hasText: new RegExp(`^${jobId}$`) }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('[data-testid="stored-admission-status"]')?.textContent === '실행 접수 대기');
    if (await page.getByTestId('command-id').innerText()) {
      assert.equal(await page.getByTestId('command-id').innerText(), commandId);
    }
    assert.equal(await page.getByTestId('detail-status').innerText(), 'DRAFT');
    assert.equal(report.createPostCount, expectedCreatePostCount);
    const afterReload = await readAdmission();
    assert.equal(afterReload.status, 200);
    assertPendingDto(afterReload.body, jobId, commandId);
    assert.equal(report.unexpectedOriginCount, 0);
    safeStep('reload_restores_same_job_pending_without_second_create');
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
  evidencePath = args.evidence;
  const overallDeadline = new Promise((_, reject) => {
    overallTimer = setTimeout(() => {
      stopRequested = true;
      reject(new Error('deadline'));
    }, timeoutMs);
  });
  runPromise = runSmoke(args).then(value => { runSettled = true; return value; }, error => {
    runSettled = true;
    throw error;
  });
  await Promise.race([runPromise, overallDeadline, sigterm]);
} catch {
  failure = 'browser-smoke-failed';
  report.verdict = 'fail';
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
