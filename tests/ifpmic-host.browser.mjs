import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = parseAllowedBaseUrl(process.env.IFPMIC_PAPERCLIP_URL || 'http://127.0.0.1:3100');
if (process.argv.includes('--validate-url-only')) {
  console.log(`Allowed Paperclip URL: ${base.origin}`);
  process.exit(0);
}
const origin = base.origin;
const evidenceDir = path.join(root, 'workflow-artifacts/verification/V1');
const syntheticCompanyName = 'IFPMIC AX Verification';
const pluginKey = 'ax.ifpmic-workflow';
const localPluginPath = path.join(root, '.paperclip-lab/ifpmic-plugin');
const expectedNodeIds = [
  'P01', 'P02', 'P03', 'P04', 'P05', 'X01', 'P06', 'P07', 'P08', 'P09', 'P10',
  'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19', 'P20', 'P21',
  'P22', 'P23', 'P24', 'X02', 'X03', 'P25', 'P26',
];
const report = {
  kind: 'ifpmic-v1-paperclip-host-browser',
  server: origin,
  checks: [],
  setupActions: [],
  unexpectedExternalRequests: [],
  browserWriteRequests: [],
  pageErrors: [],
  consoleErrors: [],
  evidence: [],
};
let browser;
let context;
let page;
let company;
let issuePrefix;

async function requestJson(apiPath, method = 'GET', body) {
  const headers = { Origin: origin, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL(apiPath, base), {
    method,
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!response.ok) throw new Error(`${method} ${apiPath} returned ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

function parseAllowedBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch {
    throw new Error('IFPMIC_PAPERCLIP_URL must be a local HTTP root URL (127.0.0.1 or localhost).');
  }
  if (url.protocol !== 'http:'
    || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== '') {
    throw new Error('IFPMIC_PAPERCLIP_URL must be a local HTTP root URL (127.0.0.1 or localhost), without credentials, path, query, or fragment.');
  }
  return url;
}

function listFrom(response, key) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.[key])) return response[key];
  throw new Error(`Expected ${key} list response`);
}

async function check(name, action) {
  try {
    const details = await action();
    report.checks.push({ name, verdict: 'pass', ...(details === undefined ? {} : { details }) });
  } catch (error) {
    report.checks.push({ name, verdict: 'fail', finding: String(error?.message || error) });
  }
}

async function ensureLab() {
  const health = await requestJson('/api/health');
  assert.equal(health.version, '2026.1005.0');
  assert.equal(health.deploymentMode, 'local_trusted');
  const allowedBackupPrefix = `${path.join(root, '.paperclip-lab/ifpmic-verification-data')}${path.sep}`;
  assert.ok(health.databaseBackup?.backupDir?.startsWith(allowedBackupPrefix), 'Paperclip DB must be the isolated IFPMIC verification instance');
  report.serverVersion = health.version;
  report.serverCommit = health.serverInfo?.git?.shortSha;
  report.databaseBackupDir = health.databaseBackup.backupDir;

  const companies = listFrom(await requestJson('/api/companies'), 'companies');
  company = companies.find(item => item.name === syntheticCompanyName);
  if (!company) {
    assert.equal(companies.length, 0, 'Only create the synthetic company in an empty verification instance');
    company = await requestJson('/api/companies', 'POST', {
      name: syntheticCompanyName,
      description: 'Synthetic read-only UI verification company. No jobs or agents are created.',
    });
    if (!company?.id) {
      const refreshed = listFrom(await requestJson('/api/companies'), 'companies');
      company = refreshed.find(item => item.name === syntheticCompanyName);
    }
    report.setupActions.push({ action: 'created_synthetic_company', name: syntheticCompanyName, companyId: company?.id });
  } else {
    report.setupActions.push({ action: 'reused_synthetic_company', name: syntheticCompanyName, companyId: company.id });
  }
  assert.ok(company?.id, 'Synthetic company ID is available');
  issuePrefix = String(company.issuePrefix || '').replace(/^\/+|\/+$/g, '');
  assert.ok(issuePrefix, 'company issuePrefix is available');

  let plugins = listFrom(await requestJson('/api/plugins'), 'plugins');
  let plugin = plugins.find(item => item.pluginKey === pluginKey);
  if (!plugin) {
    plugin = await requestJson('/api/plugins/install', 'POST', { packageName: localPluginPath, isLocalPath: true });
    report.setupActions.push({ action: 'installed_local_ui_plugin', pluginKey, status: plugin?.status });
  }
  const deadline = Date.now() + 30000;
  while (plugin?.status !== 'ready' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
    plugins = listFrom(await requestJson('/api/plugins'), 'plugins');
    plugin = plugins.find(item => item.pluginKey === pluginKey);
  }
  assert.equal(plugin?.status, 'ready', `plugin ${pluginKey} is ready`);
  report.plugin = { pluginKey, status: plugin.status, id: plugin.id };
  return { serverVersion: health.version, deploymentMode: health.deploymentMode, issuePrefix, pluginStatus: plugin.status };
}

function resolveAssetPath(url) {
  const parsed = new URL(url);
  if (parsed.origin !== origin) return null;
  return parsed.pathname;
}

try {
  await mkdir(evidenceDir, { recursive: true });
  await check('isolated local Paperclip server, synthetic company and native UI plugin are ready', ensureLab);
  if (!report.checks.every(item => item.verdict === 'pass')) throw new Error('Host setup did not meet the isolated local verification prerequisites');

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = request.url();
    const pathname = resolveAssetPath(url);
    if (pathname === null) {
      report.unexpectedExternalRequests.push(url);
      await route.abort();
      return;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) report.browserWriteRequests.push({ method: request.method(), url });
    await route.continue();
  });
  page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => report.pageErrors.push(String(error?.message || error)));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });

  const routePath = `/${issuePrefix}/ifpmic-ax`;
  await page.goto(new URL(routePath, base).href, { waitUntil: 'networkidle' });
  report.routePath = routePath;
  const card = id => page.getByTestId(`ifpmic-node-${id}`);
  const search = page.getByRole('searchbox', { name: '단계 검색' });
  const owner = page.getByLabel('담당', { exact: true });
  const detail = page.getByRole('region', { name: '선택 단계 상세' });
  const listVisibleIds = async () => page.locator('[data-testid^="ifpmic-node-"]').evaluateAll(cards => cards.map(node => node.dataset.testid.replace('ifpmic-node-', '')));

  await check('native Paperclip page renders the full workflow with host-scoped styles', async () => {
    await card('P01').waitFor();
    assert.deepEqual(await listVisibleIds(), expectedNodeIds);
    assert.equal(await page.locator('[data-testid^="ifpmic-phase-"]').count(), 6);
    assert.equal(await page.locator('[data-edge-from][data-edge-to][data-edge-kind]').count(), 41);
    assert.equal(await page.getByTestId('ifpmic-end').count(), 1);
    assert.equal(await page.locator('.ifpmic-node.human').count(), 7);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.ifpmic-shell')).backgroundColor), 'rgb(11, 17, 27)');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="ifpmic-node-P02"]')).backgroundColor), 'rgb(24, 38, 58)');
    assert.equal(await page.getByRole('region', { name: '선택 단계 상세' }).count(), 1);
  });

  await check('native page shows non-node outcomes and linked path navigation', async () => {
    for (const [source, outcome, target] of [
      ['P03', 'P03.unresolved', 'WAITING_HUMAN'],
      ['P25', 'P25.unknown_remote_state', 'RECONCILING'],
      ['P26', 'P26.failure', 'retry_notes_only'],
    ]) {
      await card(source).click();
      const body = await detail.innerText();
      assert.ok(body.includes(outcome), `${outcome} is visible`);
      assert.ok(body.includes(target), `${target} is visible`);
    }
    await card('P16').click();
    await detail.getByRole('button', { name: /P07/ }).click();
    assert.equal(await card('P07').getAttribute('aria-pressed'), 'true');
  });

  await check('native page search and owner filter preserve expected nodes and counts', async () => {
    await search.fill('SAM');
    assert.deepEqual(await listVisibleIds(), ['P15', 'P16']);
    await owner.selectOption('arch-runner');
    assert.deepEqual(await listVisibleIds(), ['P15']);
    assert.match(await page.locator('body').innerText(), /표시\s*1\s*\/\s*전체\s*29/);
    await page.getByRole('button', { name: '필터 초기화' }).click();
    assert.deepEqual(await listVisibleIds(), expectedNodeIds);
  });

  await check('native page remains usable at 1440px and 375px with screenshots', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await card('P07').click();
    assert.ok(await detail.isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(evidenceDir, 'host-desktop.png'), fullPage: true });
    report.evidence.push('workflow-artifacts/verification/V1/host-desktop.png');
    await page.setViewportSize({ width: 375, height: 812 });
    assert.ok(await search.isVisible());
    assert.ok(await detail.isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(evidenceDir, 'host-mobile.png'), fullPage: true });
    report.evidence.push('workflow-artifacts/verification/V1/host-mobile.png');
  });

  await check('host page performs no writes, external network requests or runtime errors', async () => {
    assert.deepEqual(report.browserWriteRequests, []);
    assert.deepEqual(report.unexpectedExternalRequests, []);
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []);
  });

  await check('synthetic verification company still has no issues or agents', async () => {
    const [issues, agents, companies] = await Promise.all([
      requestJson(`/api/companies/${company.id}/issues`),
      requestJson(`/api/companies/${company.id}/agents`),
      requestJson('/api/companies'),
    ]);
    assert.deepEqual(listFrom(issues, 'issues'), []);
    assert.deepEqual(listFrom(agents, 'agents'), []);
    const current = listFrom(companies, 'companies').find(item => item.id === company.id);
    assert.equal(current?.issueCounter, 0);
    return { issueCount: 0, agentCount: 0, issueCounter: 0 };
  });
} catch (error) {
  report.harnessError = String(error?.stack || error?.message || error);
} finally {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  report.verdict = report.harnessError || report.checks.some(result => result.verdict === 'fail')
    || report.browserWriteRequests.length || report.unexpectedExternalRequests.length || report.pageErrors.length || report.consoleErrors.length
    ? 'fail' : 'pass';
  report.evidence.push('workflow-artifacts/verification/V1/host-browser.json');
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, 'host-browser.json'), `${JSON.stringify(report, null, 2)}\n`);
}

console.log(`IFPMIC Paperclip host browser checks: ${report.checks.filter(result => result.verdict === 'pass').length} passed, ${report.checks.filter(result => result.verdict === 'fail').length} failed (${report.verdict}).`);
if (report.verdict !== 'pass') process.exitCode = 1;
