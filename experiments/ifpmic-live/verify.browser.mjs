import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const apiOrigin = 'http://127.0.0.1:8769';
const issuerOrigin = 'http://127.0.0.1:8770';
const allowedOrigins = new Set([apiOrigin, issuerOrigin]);
const evidenceBase = path.join(repoRoot, 'workflow-artifacts/verification/agile/iteration-02');
const phase = process.argv.includes('--persist-read') ? 'persist-read' : 'create-and-read';
const privateRoot = path.resolve(process.env.IFPMIC_I02_EVIDENCE_ROOT || evidenceBase);
const priorReceiptPath = process.env.IFPMIC_I02_PERSIST_STATE;
const timeoutMs = 180_000;

const report = {
  kind: 'ifpmic.agile.iteration-02.browser-private-evidence.v1',
  phase,
  verdict: 'fail',
  checks: [],
  requests: [],
  apiTransactions: [],
  unexpectedOrigins: [],
  routeErrors: [],
  expectedBrowserErrors: [],
  observedHttpResponses: [],
  pageErrors: [],
  consoleErrors: [],
  screenshots: [],
  sourceBefore: null,
  sourceAfter: null,
  secretsRecorded: false,
  note: 'Private raw browser evidence. Cookies, session tokens and CSRF values are deliberately never serialized.',
};

let browser;
let page;
let context;
let activeRouteState = {
  loseFirstUiPost: false, uiPostCount: 0, firstReceipt: null,
  jobPostCount: 0, expectedAbortedApiPosts: 0, profileProbe503InFlight: false,
};
let privateRunRoot;
let primaryError;

function assertLoopbackRoot(value, expectedBase) {
  const relative = path.relative(expectedBase, value);
  assert.ok(relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)),
    'evidence root must remain under workflow-artifacts/verification/agile/iteration-02');
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'private evidence path must be a real directory');
  assert.equal(info.uid, process.getuid(), 'private evidence directory owner must be current user');
  assert.equal(info.mode & 0o777, 0o700, 'private evidence directory must have mode 0700');
}

async function writePrivate(filePath, bytes) {
  await ensurePrivateDirectory(path.dirname(filePath));
  const handle = await open(filePath, 'wx', 0o600);
  try {
    await handle.chmod(0o600);
    const info = await handle.stat();
    assert.ok(info.isFile() && info.nlink === 1 && info.uid === process.getuid());
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writePrivateJson(filePath, value) {
  await writePrivate(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

async function readPrivateJson(filePath) {
  const info = await lstat(filePath);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid());
  assert.equal(info.mode & 0o777, 0o600, 'prior receipt file must have mode 0600');
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function walkSourceFiles(directory, result = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return result;
    throw error;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const current = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`source tree contains an unexpected symlink: ${path.relative(repoRoot, current)}`);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', '__pycache__'].includes(entry.name)) continue;
      await walkSourceFiles(current, result);
    } else if (entry.isFile()) {
      result.push(current);
    }
  }
  return result;
}

async function sourceSnapshot() {
  const paths = [
    path.join(repoRoot, 'experiments/ifpmic-live'),
    path.join(repoRoot, 'services/ifpmic_api'),
    path.join(repoRoot, 'src/ifpmic'),
    path.join(repoRoot, 'docs/ifpmic/design-v1/specs'),
  ];
  const files = [];
  for (const directory of paths) await walkSourceFiles(directory, files);
  files.push(path.join(repoRoot, 'package.json'));
  files.sort((a, b) => a.localeCompare(b));
  const rows = [];
  for (const file of files) {
    const bytes = await readFile(file);
    rows.push({ path: path.relative(repoRoot, file), sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const canonical = Buffer.from(JSON.stringify(rows));
  return { sha256: createHash('sha256').update(canonical).digest('hex'), file_count: rows.length, files: rows };
}

function recordCheck(name, details = {}) {
  report.checks.push({ name, verdict: 'pass', ...details });
}

function recordFailure(name, error) {
  // Keep callback URLs, request text, cookie values and framework diagnostics
  // out of the report. The failure category is enough for the public summary.
  report.checks.push({ name, verdict: 'fail', error_type: error?.name || 'Error', finding: 'flow did not meet its assertion' });
}

async function bounded(promise, label, ms = 15_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonText(text) {
  try { return text ? JSON.parse(text) : null; } catch { return { non_json_response: true }; }
}

function safePath(url) {
  try { return new URL(url).pathname; } catch { return '<invalid-url>'; }
}

function attachNetworkGuard(browserContext) {
  browserContext.on('response', response => {
    let parsed;
    try { parsed = new URL(response.url()); } catch { return; }
    if (!allowedOrigins.has(parsed.origin)) return;
    const request = response.request();
    report.requests.push({ origin: parsed.origin, path: parsed.pathname, method: request.method(), status: response.status() });
    report.observedHttpResponses.push({ origin: parsed.origin, path: parsed.pathname, method: request.method(), status: response.status() });
  });
  browserContext.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    let location;
    try { location = new URL(message.location().url); } catch { /* classify below as unexpected */ }
    if (text.startsWith('Failed to load resource:') && location?.origin === apiOrigin &&
        location.pathname === '/api/v1/jobs' && activeRouteState.expectedAbortedApiPosts > 0) {
      activeRouteState.expectedAbortedApiPosts -= 1;
      report.expectedBrowserErrors.push({ category: 'intentional-create-response-abort', path: location.pathname });
      return;
    }
    const rejectedStatus = text.match(/server responded with (?:a )?status(?: of)? (401|403|409|422|503)\b/i)?.[1];
    if (rejectedStatus && location?.origin === apiOrigin) {
      const matched = report.observedHttpResponses.some(response => response.origin === location.origin &&
        response.path === location.pathname && response.status === Number(rejectedStatus));
      const expectedStatus = Number(rejectedStatus) !== 503 ||
        (location.pathname === '/api/v1/jobs' && activeRouteState.profileProbe503InFlight);
      if (matched && expectedStatus) {
        report.expectedBrowserErrors.push({ category: 'observed-api-rejection', path: location.pathname, status: Number(rejectedStatus) });
        return;
      }
    }
    report.consoleErrors.push('console-error');
  });
  browserContext.route('**/*', async route => {
    const request = route.request();
    let parsed;
    try { parsed = new URL(request.url()); } catch {
      report.unexpectedOrigins.push({ origin: '<invalid-url>', path: '<invalid-url>', method: request.method() });
      await route.abort();
      return;
    }
    if (!allowedOrigins.has(parsed.origin) || parsed.protocol !== 'http:') {
      report.unexpectedOrigins.push({ origin: parsed.origin, path: parsed.pathname, method: request.method() });
      await route.abort();
      return;
    }

    try {
      if (parsed.origin === apiOrigin && parsed.pathname === '/api/v1/jobs' && request.method() === 'POST') {
        activeRouteState.jobPostCount += 1;
      }
      if (activeRouteState.loseFirstUiPost && parsed.origin === apiOrigin && parsed.pathname === '/api/v1/jobs' && request.method() === 'POST') {
        activeRouteState.uiPostCount += 1;
        const requestRecord = {
          attempt: activeRouteState.uiPostCount,
          method: request.method(),
          path: parsed.pathname,
          idempotency_key: request.headers()['idempotency-key'] || null,
          body: parseJsonText(request.postData() || ''),
        };
        if (activeRouteState.uiPostCount === 1) {
          const upstream = await bounded(route.fetch(), 'initial create request', 20_000);
          const responseText = await upstream.text();
          const responseBody = parseJsonText(responseText);
          requestRecord.upstream_response = { status: upstream.status(), body: responseBody };
          report.apiTransactions.push({ kind: 'ui-create-response-deliberately-lost', ...requestRecord });
          activeRouteState.firstReceipt = responseBody;
          activeRouteState.expectedAbortedApiPosts += 1;
          await route.abort('failed');
          return;
        }
        if (activeRouteState.uiPostCount === 2) {
          const upstream = await bounded(route.fetch(), 'same-key retry request', 20_000);
          const responseText = await upstream.text();
          const responseBody = parseJsonText(responseText);
          requestRecord.upstream_response = { status: upstream.status(), body: responseBody };
          report.apiTransactions.push({ kind: 'ui-same-key-retry', ...requestRecord });
          await route.fulfill({ response: upstream, body: responseText });
          return;
        }
      }
      await route.continue();
    } catch (error) {
      report.routeErrors.push({ error_type: error?.name || 'Error' });
      await route.abort().catch(() => {});
    }
  });
}

async function newPageContext(viewport = { width: 1440, height: 1000 }) {
  const browserContext = await browser.newContext({ viewport, serviceWorkers: 'block' });
  attachNetworkGuard(browserContext);
  const newPage = await browserContext.newPage();
  newPage.setDefaultTimeout(10_000);
  newPage.on('pageerror', error => report.pageErrors.push(error?.name || 'page-error'));
  return { browserContext, page: newPage };
}

async function openUnauthenticatedPage() {
  const created = await newPageContext();
  await bounded(created.page.goto(`${apiOrigin}/`, { waitUntil: 'domcontentloaded' }), 'load unauthenticated app');
  await created.page.locator('#auth-gate').waitFor({ state: 'visible' });
  return created;
}

async function loginAs(targetPage, account) {
  await targetPage.getByTestId('login-button').click();
  await bounded(targetPage.waitForURL(url => url.origin === issuerOrigin && url.pathname === '/authorize'), 'open local OIDC issuer');
  await targetPage.getByTestId(account === 'a' ? 'login-a' : 'login-b').click();
  await bounded(targetPage.waitForURL(url => url.origin === apiOrigin && url.pathname === '/'), 'complete actual API OIDC callback');
  await targetPage.locator('#signed-in').waitFor({ state: 'visible' });
  await targetPage.getByTestId('context-project').waitFor({ state: 'visible' });
  await bounded(targetPage.waitForFunction(() =>
    document.querySelector('[data-testid="context-project"]')?.textContent === 'ifpmic-local-demo' &&
    document.querySelector('[data-testid="profile-version"]')?.textContent === 'local-demo-v1' &&
    document.querySelector('[data-testid="context-identity"]')?.textContent === '로컬 데모 OIDC'),
  'wait for actual demo context values');
  assert.equal(await targetPage.getByTestId('context-project').innerText(), 'ifpmic-local-demo');
  assert.equal(await targetPage.getByTestId('profile-version').innerText(), 'local-demo-v1');
  const session = await targetPage.evaluate(async () => {
    const response = await fetch('/api/v1/session', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return { status: response.status };
    const data = await response.json();
    return { status: response.status, user_id: data.user_id, mode: data.mode };
  });
  assert.equal(session.status, 200, 'actual API session endpoint accepts the callback-created session');
  assert.equal(typeof session.user_id, 'string');
  assert.equal(session.mode, 'mock', 'synthetic profile is visibly marked as mock');
  assert.equal(await targetPage.getByTestId('context-identity').innerText(), '로컬 데모 OIDC');
  assert.match(await targetPage.getByTestId('scope-notice').innerText(), /합성 계정/);
  return session;
}

async function apiCall(targetPage, { method = 'GET', path: apiPath, body, idempotencyKey, csrf = 'valid' }) {
  return targetPage.evaluate(async ({ method, apiPath, body, idempotencyKey, csrf }) => {
    let csrfToken = null;
    if (csrf === 'valid') {
      const sessionResponse = await fetch('/api/v1/session', { credentials: 'same-origin', cache: 'no-store' });
      if (sessionResponse.ok) csrfToken = (await sessionResponse.json()).csrf_token;
    }
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['X-CSRF-Token'] = csrf === 'valid' ? csrfToken : 'invalid-csrf-for-iteration-02';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const response = await fetch(apiPath, {
      method, headers, credentials: 'same-origin', cache: 'no-store',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { non_json_response: true }; }
    return { status: response.status, body: parsed };
  }, { method, apiPath, body, idempotencyKey, csrf });
}

async function writeScreenshot(targetPage, fileName) {
  const target = path.join(privateRunRoot, fileName);
  await bounded(targetPage.screenshot({ path: target, fullPage: true }), `screenshot ${fileName}`);
  await chmod(target, 0o600);
  const info = await lstat(target);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid());
  assert.equal(info.mode & 0o777, 0o600);
  const bytes = await readFile(target);
  report.screenshots.push({
    path: path.relative(repoRoot, target),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  });
}

async function assertSavedJobUi(targetPage, receipt) {
  await targetPage.getByTestId('job-detail').waitFor({ state: 'visible' });
  await bounded(targetPage.waitForFunction(() =>
    document.querySelector('[data-testid="command-status"]')?.textContent === 'accepted'),
  'wait for accepted command status');
  const matchingRow = targetPage.getByTestId('job-list').locator(`[data-job-id="${receipt.resource_id}"]`);
  await matchingRow.waitFor({ state: 'visible' });
  assert.equal(await targetPage.getByTestId('detail-job-id').innerText(), receipt.resource_id);
  assert.equal(await targetPage.getByTestId('detail-status').innerText(), 'DRAFT');
  assert.equal(await targetPage.getByTestId('detail-current-steps').innerText(), '아직 시작된 단계 없음');
  assert.equal(await targetPage.getByTestId('detail-wait-reason').innerText(), 'API에서 제공하지 않음');
  assert.equal(await targetPage.getByTestId('command-id').innerText(), receipt.command_id);
  assert.equal(await targetPage.getByTestId('command-status').innerText(), 'accepted');
  assert.equal(await targetPage.getByTestId('job-list').locator('[data-testid="job-row"]').count(), 1,
    'same-key retry produces one visible job row in this fresh isolated database');
  assert.equal(await targetPage.getByTestId('job-list').locator(`[data-job-id="${receipt.resource_id}"]`).count(), 1);
}

async function runCreateAndRead() {
  const anonymous = await openUnauthenticatedPage();
  const unauthSession = await apiCall(anonymous.page, { path: '/api/v1/session' });
  const unauthJobs = await apiCall(anonymous.page, { path: '/api/v1/jobs' });
  assert.equal(unauthSession.status, 401);
  assert.equal(unauthJobs.status, 401);
  report.apiTransactions.push(
    { kind: 'unauthenticated-session', request: { method: 'GET', path: '/api/v1/session' }, response: unauthSession },
    { kind: 'unauthenticated-jobs', request: { method: 'GET', path: '/api/v1/jobs' }, response: unauthJobs },
  );
  recordCheck('unauthenticated API session and job list are rejected with 401');
  await anonymous.browserContext.close();

  const created = await newPageContext();
  context = created.browserContext;
  page = created.page;
  await bounded(page.goto(`${apiOrigin}/`, { waitUntil: 'domcontentloaded' }), 'load request app');
  const userA = await loginAs(page, 'a');
  report.synthetic_account_ids = { user_a: userA.user_id };
  assert.ok(page.getByTestId('account-name'));
  recordCheck('user A signs in through the local OIDC issuer and real API callback', { api_mode: userA.mode });

  const badCsrfPayload = {
    project_id: 'ifpmic-local-demo', title: `CSRF reject ${randomUUID()}`,
    request_text: 'This request must be rejected before persistence.', change_type: 'FEATURE',
    base_ref: 'refs/heads/main', input_artifact_ids: [], profile_version: 'local-demo-v1',
    release_mode: 'team_github_tag',
  };
  const badCsrfKey = `ifpmic-${randomUUID()}`;
  const badCsrf = await apiCall(page, {
    method: 'POST', path: '/api/v1/jobs', body: badCsrfPayload,
    idempotencyKey: badCsrfKey, csrf: 'invalid',
  });
  assert.equal(badCsrf.status, 403);
  assert.equal(badCsrf.body?.code, 'CSRF_INVALID');
  report.apiTransactions.push({
    kind: 'invalid-csrf-rejected',
    request: { method: 'POST', path: '/api/v1/jobs', idempotency_key: badCsrfKey, body: badCsrfPayload,
               csrf_header: '<redacted; invalid synthetic value>' },
    response: badCsrf,
  });
  recordCheck('authenticated write with invalid CSRF is rejected with 403 before creating a job');

  const validProbePayload = {
    project_id: 'ifpmic-local-demo', title: `DTO probe ${randomUUID()}`,
    request_text: 'This probe must be rejected before persistence.', change_type: 'FEATURE',
    base_ref: 'refs/heads/main', input_artifact_ids: [], profile_version: 'local-demo-v1',
    release_mode: 'team_github_tag',
  };
  const dtoProbes = [
    {
      name: 'invalid-change-type', body: { ...validProbePayload, change_type: 'NOT_A_CHANGE_TYPE' },
      status: 422, code: 'INVALID_REQUEST',
    },
    {
      name: 'missing-required-request-text', body: Object.fromEntries(
        Object.entries(validProbePayload).filter(([key]) => key !== 'request_text')),
      status: 422, code: 'INVALID_REQUEST',
    },
    {
      name: 'unknown-profile-version', body: { ...validProbePayload, profile_version: 'not-a-real-profile' },
      status: 503, code: 'DEPENDENCY_UNAVAILABLE',
    },
  ];
  for (const probe of dtoProbes) {
    activeRouteState.profileProbe503InFlight = probe.name === 'unknown-profile-version';
    let result;
    try {
      result = await apiCall(page, {
        method: 'POST', path: '/api/v1/jobs', body: probe.body,
        idempotencyKey: `ifpmic-${randomUUID()}`,
      });
    } finally {
      activeRouteState.profileProbe503InFlight = false;
    }
    assert.equal(result.status, probe.status, `${probe.name} status`);
    assert.equal(result.body?.code, probe.code, `${probe.name} error code`);
    report.apiTransactions.push({
      kind: probe.name,
      request: { method: 'POST', path: '/api/v1/jobs', body: probe.body },
      response: result,
    });
  }
  recordCheck('invalid enum, missing required field, and unknown profile are rejected by the actual API DTO');

  const nonce = randomUUID();
  const title = `I02 request <img src=x onerror="window.__i02_xss=1"> ${nonce}`;
  const requestText = `Synthetic verification request ${nonce}. Literal markup: <script>window.__i02_script=1</script>`;
  await page.evaluate(() => { window.__i02_xss = 0; window.__i02_script = 0; });
  await page.getByTestId('field-title').fill(title);
  await page.getByTestId('field-request-text').fill(requestText);
  await page.getByTestId('field-change-type').selectOption('FEATURE');
  await page.getByTestId('field-base-ref').fill('refs/heads/main');
  activeRouteState = {
    ...activeRouteState,
    loseFirstUiPost: true,
    uiPostCount: 0,
    firstReceipt: null,
  };
  await page.getByTestId('submit-request').click();
  await page.getByTestId('pending-card').waitFor({ state: 'visible' });
  await bounded(page.waitForFunction(() =>
    document.querySelector('#pending-title')?.textContent === '접수 결과를 확인하지 못했습니다'),
  'wait until lost-response UI records an uncertain receipt');
  assert.equal(activeRouteState.uiPostCount, 1, 'first actual API response is lost only after upstream returned');
  assert.equal(activeRouteState.firstReceipt?.status, 'accepted');
  assert.equal(typeof activeRouteState.firstReceipt?.command_id, 'string');
  assert.equal(typeof activeRouteState.firstReceipt?.resource_id, 'string');
  const firstPost = report.apiTransactions.find(item => item.kind === 'ui-create-response-deliberately-lost');
  assert.ok(firstPost);
  assert.equal(firstPost.upstream_response.status, 202);
  const firstKey = firstPost.idempotency_key;
  const firstBody = firstPost.body;
  assert.ok(firstKey && typeof firstBody?.title === 'string');
  assert.equal(firstBody.title, title);
  assert.equal(firstBody.request_text, requestText);
  recordCheck('UI retains the original key and body when an actual post-commit 202 response is lost');

  await page.getByTestId('retry-request').click();
  await page.getByTestId('job-detail').waitFor({ state: 'visible' });
  assert.equal(activeRouteState.uiPostCount, 2);
  const retryPost = report.apiTransactions.find(item => item.kind === 'ui-same-key-retry');
  assert.ok(retryPost);
  assert.equal(retryPost.idempotency_key, firstKey);
  assert.deepEqual(retryPost.body, firstBody, 'retry reuses byte-equivalent JSON semantics and the same idempotency key');
  assert.equal(retryPost.upstream_response.status, 202);
  assert.deepEqual(retryPost.upstream_response.body, firstPost.upstream_response.body);
  const receipt = firstPost.upstream_response.body;
  assert.equal(receipt.status, 'accepted');
  await assertSavedJobUi(page, receipt);
  recordCheck('same-key/body retry returns the original receipt and the UI shows one saved DRAFT job');

  await bounded(page.reload({ waitUntil: 'domcontentloaded' }), 'reload after accepted receipt');
  await page.locator('#signed-in').waitFor({ state: 'visible' });
  await assertSavedJobUi(page, receipt);
  recordCheck('reload restores the same job and command receipt from the actual API');

  const ownerSnapshot = await apiCall(page, { path: `/api/v1/jobs/${encodeURIComponent(receipt.resource_id)}` });
  const commandSnapshot = await apiCall(page, { path: `/api/v1/commands/${encodeURIComponent(receipt.command_id)}` });
  assert.equal(ownerSnapshot.status, 200);
  assert.equal(ownerSnapshot.body?.job?.job_id, receipt.resource_id);
  assert.equal(ownerSnapshot.body?.job?.status, 'DRAFT');
  assert.deepEqual(ownerSnapshot.body?.job?.current_step_ids, []);
  assert.deepEqual(ownerSnapshot.body?.steps, []);
  assert.equal(commandSnapshot.status, 200);
  assert.equal(commandSnapshot.body?.command_id, receipt.command_id);
  assert.equal(commandSnapshot.body?.status, 'accepted');
  report.apiTransactions.push(
    { kind: 'owner-job-detail', request: { method: 'GET', path: `/api/v1/jobs/${receipt.resource_id}` }, response: ownerSnapshot },
    { kind: 'owner-command-status', request: { method: 'GET', path: `/api/v1/commands/${receipt.command_id}` }, response: commandSnapshot },
  );
  recordCheck('owner can read exact job snapshot and command status from the actual API');

  const replay = await apiCall(page, {
    method: 'POST', path: '/api/v1/jobs', body: firstBody, idempotencyKey: firstKey,
  });
  assert.equal(replay.status, 202);
  assert.deepEqual(replay.body, receipt);
  report.apiTransactions.push({
    kind: 'same-key-same-body-replay',
    request: { method: 'POST', path: '/api/v1/jobs', idempotency_key: firstKey, body: firstBody },
    response: replay,
  });
  const changedReplay = await apiCall(page, {
    method: 'POST', path: '/api/v1/jobs', body: { ...firstBody, title: `${firstBody.title} changed` },
    idempotencyKey: firstKey,
  });
  assert.equal(changedReplay.status, 409);
  assert.equal(changedReplay.body?.code, 'IDEMPOTENCY_CONFLICT');
  report.apiTransactions.push({
    kind: 'same-key-changed-body-conflict',
    request: { method: 'POST', path: '/api/v1/jobs', idempotency_key: firstKey,
               body: { ...firstBody, title: `${firstBody.title} changed` } },
    response: changedReplay,
  });
  const ownedList = await apiCall(page, { path: '/api/v1/jobs?limit=25' });
  assert.equal(ownedList.status, 200);
  assert.equal(ownedList.body?.items?.filter(job => job.job_id === receipt.resource_id).length, 1);
  report.apiTransactions.push({
    kind: 'same-key-replay-and-changed-payload-conflict',
    replay: { status: replay.status, receipt_equal: true },
    changed_payload: { status: changedReplay.status, code: changedReplay.body?.code },
    matching_jobs_in_owner_list: 1,
  });
  recordCheck('same key/body returns one original receipt; same key/changed body returns 409 without duplicate job');

  const xssState = await page.evaluate(() => ({
    handlerRan: window.__i02_xss === 1,
    scriptRan: window.__i02_script === 1,
    injectedImageCount: document.querySelectorAll('img[src="x"]').length,
    injectedScriptCount: [...document.scripts].filter(script => script.textContent.includes('window.__i02_script=1')).length,
  }));
  assert.deepEqual(xssState, { handlerRan: false, scriptRan: false, injectedImageCount: 0, injectedScriptCount: 0 });
  recordCheck('literal HTML in submitted text is not parsed or executed by the UI');

  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await writeScreenshot(page, 'iteration-02-user-a-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.getByTestId('job-detail').isVisible());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await writeScreenshot(page, 'iteration-02-user-a-mobile.png');
  recordCheck('desktop and mobile persisted-job detail render without page overflow');

  await page.getByTestId('logout-button').click();
  await page.locator('#auth-gate').waitFor({ state: 'visible' });
  const userB = await loginAs(page, 'b');
  assert.notEqual(userB.user_id, userA.user_id);
  report.synthetic_account_ids.user_b = userB.user_id;
  assert.equal(await page.getByTestId('job-detail').isVisible(), false, 'A detail is hidden after account switch');
  assert.equal(await page.getByTestId('detail-job-id').innerText(), '');
  const listB = await apiCall(page, { path: '/api/v1/jobs?limit=25' });
  assert.equal(listB.status, 200);
  assert.ok(!listB.body?.items?.some(job => job.job_id === receipt.resource_id));
  const directJobB = await apiCall(page, { path: `/api/v1/jobs/${encodeURIComponent(receipt.resource_id)}` });
  const directCommandB = await apiCall(page, { path: `/api/v1/commands/${encodeURIComponent(receipt.command_id)}` });
  assert.equal(directJobB.status, 403);
  assert.equal(directCommandB.status, 403);
  report.apiTransactions.push(
    { kind: 'user-b-list-excludes-user-a-job', request: { method: 'GET', path: '/api/v1/jobs?limit=25' },
      response: { status: listB.status, contains_a_job: false } },
    { kind: 'user-b-direct-job-read-forbidden', request: { method: 'GET', path: `/api/v1/jobs/${receipt.resource_id}` },
      response: directJobB },
    { kind: 'user-b-direct-command-read-forbidden', request: { method: 'GET', path: `/api/v1/commands/${receipt.command_id}` },
      response: directCommandB },
  );
  recordCheck('user B callback/session cannot see A detail or command by list or direct URL');

  const titleAfterSwitch = await page.getByTestId('field-title').inputValue();
  const requestTextAfterSwitch = await page.getByTestId('field-request-text').inputValue();
  assert.equal(titleAfterSwitch, '', 'account switch clears A request title from B composer');
  assert.equal(requestTextAfterSwitch, '', 'account switch clears A request body from B composer');
  recordCheck('account switch does not retain A request input in B composer');

  const beforeDoubleSubmit = activeRouteState.jobPostCount;
  await page.getByTestId('field-title').fill(`Double submit guard ${randomUUID()}`);
  await page.getByTestId('field-request-text').fill('Two same-tick form submissions must produce one API POST.');
  await page.evaluate(() => {
    const form = document.querySelector('[data-testid="request-form"]');
    form.requestSubmit();
    form.requestSubmit();
  });
  await page.getByTestId('job-detail').waitFor({ state: 'visible' });
  assert.equal(activeRouteState.jobPostCount - beforeDoubleSubmit, 1,
    'busy/pending guards permit only one POST for same-tick duplicate submit events');
  const bJobId = await page.getByTestId('detail-job-id').innerText();
  const bCommandId = await page.getByTestId('command-id').innerText();
  assert.ok(bJobId && bCommandId);
  report.apiTransactions.push({
    kind: 'user-b-double-submit-coalesces-to-one-post',
    response: { job_id: bJobId, command_id: bCommandId },
    post_count_delta: activeRouteState.jobPostCount - beforeDoubleSubmit,
  });
  recordCheck('same-tick duplicate submit events issue one POST and one receipt');

  const persistState = {
    kind: 'ifpmic.iteration-02.persisted-receipt.v1',
    user_id: userA.user_id,
    job_id: receipt.resource_id,
    command_id: receipt.command_id,
    job_status: 'DRAFT',
    command_status: 'accepted',
    title_sha256: createHash('sha256').update(firstBody.title).digest('hex'),
    request_sha256: createHash('sha256').update(firstBody.request_text).digest('hex'),
  };
  report.persist_state_path = path.relative(repoRoot, path.join(privateRunRoot, 'persist-receipt.json'));
  report.persist_state_sha256 = createHash('sha256').update(JSON.stringify(persistState)).digest('hex');
  await writePrivateJson(path.join(privateRunRoot, 'persist-receipt.json'), persistState);
  recordCheck('private restart receipt contains identifiers and content hashes only, never session credentials');
}

async function runPersistRead() {
  assert.ok(priorReceiptPath, 'IFPMIC_I02_PERSIST_STATE is required for --persist-read');
  const resolvedPrior = path.resolve(priorReceiptPath);
  assertLoopbackRoot(resolvedPrior, evidenceBase);
  const prior = await readPrivateJson(resolvedPrior);
  assert.equal(prior.kind, 'ifpmic.iteration-02.persisted-receipt.v1');
  assert.ok(typeof prior.job_id === 'string' && typeof prior.command_id === 'string');

  const created = await newPageContext();
  context = created.browserContext;
  page = created.page;
  await bounded(page.goto(`${apiOrigin}/`, { waitUntil: 'domcontentloaded' }), 'load persistence browser');
  const userA = await loginAs(page, 'a');
  assert.equal(userA.user_id, prior.user_id, 'new OIDC session resolves to the same synthetic account');
  const job = await apiCall(page, { path: `/api/v1/jobs/${encodeURIComponent(prior.job_id)}` });
  const command = await apiCall(page, { path: `/api/v1/commands/${encodeURIComponent(prior.command_id)}` });
  const list = await apiCall(page, { path: '/api/v1/jobs?limit=25' });
  assert.equal(job.status, 200);
  assert.equal(job.body?.job?.job_id, prior.job_id);
  assert.equal(job.body?.job?.status, 'DRAFT');
  assert.deepEqual(job.body?.job?.current_step_ids, []);
  assert.equal(command.status, 200);
  assert.equal(command.body?.command_id, prior.command_id);
  assert.equal(command.body?.status, 'accepted');
  assert.ok(list.body?.items?.some(item => item.job_id === prior.job_id));
  const priorRow = page.locator(`[data-testid="job-row"][data-job-id="${prior.job_id}"]`);
  await priorRow.waitFor({ state: 'visible' });
  await priorRow.click();
  await page.getByTestId('job-detail').waitFor({ state: 'visible' });
  assert.equal(await page.getByTestId('detail-job-id').innerText(), prior.job_id);
  assert.equal(await page.getByTestId('detail-status').innerText(), 'DRAFT');
  assert.equal(await page.getByTestId('detail-current-steps').innerText(), '아직 시작된 단계 없음');
  report.apiTransactions.push(
    { kind: 'api-restart-same-job-persisted', request: { method: 'GET', path: `/api/v1/jobs/${prior.job_id}` }, response: job },
    { kind: 'api-restart-same-command-persisted', request: { method: 'GET', path: `/api/v1/commands/${prior.command_id}` }, response: command },
    { kind: 'api-restart-owner-list-still-contains-job', request: { method: 'GET', path: '/api/v1/jobs?limit=25' },
      response: { status: list.status, contains_job: true } },
  );
  recordCheck('after externally orchestrated API restart, a new OIDC session reads the same persisted DRAFT job and accepted receipt');
  report.previous_persist_state_sha256 = createHash('sha256').update(JSON.stringify(prior)).digest('hex');
}

async function runStorageUnavailableProbe() {
  const created = await newPageContext();
  const probeContext = created.browserContext;
  const probePage = created.page;
  try {
    await bounded(probePage.goto(`${apiOrigin}/`, { waitUntil: 'domcontentloaded' }), 'load storage probe app');
    await loginAs(probePage, 'a');
    await probePage.evaluate(() => {
      const original = Storage.prototype.setItem;
      Object.defineProperty(Storage.prototype, 'setItem', {
        configurable: true,
        value() { throw new DOMException('storage denied by test probe', 'SecurityError'); },
      });
      window.__i02_restoreStorageWrite = () => Object.defineProperty(Storage.prototype, 'setItem', {
        configurable: true, value: original,
      });
    });
    await probePage.getByTestId('field-title').fill(`Storage unavailable ${randomUUID()}`);
    await probePage.getByTestId('field-request-text').fill('No API request may be sent without durable retry state.');
    const before = activeRouteState.jobPostCount;
    await probePage.getByTestId('submit-request').click();
    await probePage.getByTestId('global-status').getByText(/요청을 보내지 않았습니다/).waitFor({ state: 'visible' });
    assert.equal(activeRouteState.jobPostCount, before, 'storage write failure must fail closed before POST');
    report.apiTransactions.push({ kind: 'storage-unavailable-fails-before-create', post_count_delta: 0 });
    recordCheck('unavailable sessionStorage prevents a POST and leaves the request unsent');
  } finally {
    await bounded(probePage.evaluate(() => window.__i02_restoreStorageWrite?.()), 'restore storage probe override', 2_000).catch(() => {});
    await bounded(probeContext.close(), 'close storage probe context', 10_000);
  }
}

async function main() {
  assertLoopbackRoot(privateRoot, evidenceBase);
  await ensurePrivateDirectory(privateRoot);
  privateRunRoot = path.join(privateRoot, `run-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
  await ensurePrivateDirectory(privateRunRoot);
  report.evidence_root = path.relative(repoRoot, privateRunRoot);
  report.sourceBefore = await sourceSnapshot();
  await writePrivateJson(path.join(privateRunRoot, 'source-before.json'), report.sourceBefore);
  browser = await chromium.launch({ headless: true, timeout: 20_000 });
  if (phase === 'persist-read') await runPersistRead();
  else {
    await runCreateAndRead();
    await runStorageUnavailableProbe();
  }
}

try {
  const watchdog = setTimeout(() => {
    report.deadline_expired = true;
    void context?.close().catch(() => {});
    void browser?.close().catch(() => {});
  }, timeoutMs);
  watchdog.unref();
  try {
    await main();
  } finally {
    clearTimeout(watchdog);
  }
} catch (error) {
  primaryError = error;
  recordFailure('iteration-02 browser flow', error);
} finally {
  if (context) {
    try { await bounded(context.close(), 'close browser context', 10_000); }
    catch (error) {
      recordFailure('browser context cleanup completed', error);
      primaryError ||= error;
    }
  }
  if (browser) {
    try { await bounded(browser.close(), 'close browser', 10_000); }
    catch (error) {
      recordFailure('browser process cleanup completed', error);
      primaryError ||= error;
    }
  }
  try {
    if (privateRunRoot) {
      report.sourceAfter = await sourceSnapshot();
      await writePrivateJson(path.join(privateRunRoot, 'source-after.json'), report.sourceAfter);
      const sourceUnchanged = report.sourceBefore?.sha256 === report.sourceAfter.sha256;
      report.source_unchanged = sourceUnchanged;
      if (!sourceUnchanged) recordFailure('source tree remains unchanged during browser evidence capture', new Error('source hashes changed during test'));
      else recordCheck('source tree hashes remain unchanged across browser evidence capture', { file_count: report.sourceAfter.file_count });
      report.verdict = !primaryError && report.checks.every(item => item.verdict === 'pass') &&
        report.unexpectedOrigins.length === 0 && report.routeErrors.length === 0 &&
        report.pageErrors.length === 0 && report.consoleErrors.length === 0 && !report.deadline_expired
        ? 'pass' : 'fail';
      await writePrivateJson(path.join(privateRunRoot, 'browser-private.json'), report);
      console.log(`IFPMIC iteration-02 browser: ${report.checks.filter(item => item.verdict === 'pass').length} passed, ${report.checks.filter(item => item.verdict === 'fail').length} failed (${report.verdict}); private evidence at ${report.evidence_root}`);
    }
  } catch (evidenceError) {
    console.error(`IFPMIC iteration-02 private evidence write failed (${evidenceError?.name || 'Error'}).`);
    primaryError ||= evidenceError;
  }
}

if (report.verdict !== 'pass') process.exitCode = 1;
