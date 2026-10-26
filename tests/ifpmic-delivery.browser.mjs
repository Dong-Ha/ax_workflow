import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const evidence = path.join(root, 'workflow-artifacts/delivery/browser');
const origin = 'http://delivery-smoke.invalid';
const report = { route: '/delivery.html', results: [], pageErrors: [], consoleErrors: [], apiRequests: [], externalRequests: [], captures: [] };
let browser;
let context;

try {
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const request = new URL(route.request().url());
    if (request.origin !== origin) {
      report.externalRequests.push(request.href);
      await route.abort();
      return;
    }
    if (request.pathname.startsWith('/api/')) {
      report.apiRequests.push(request.href);
      await route.abort();
      return;
    }
    const relative = decodeURIComponent(request.pathname).replace(/^\/+/, '');
    const target = path.resolve(dist, relative || 'delivery.html');
    if (!target.startsWith(`${dist}${path.sep}`)) { await route.abort(); return; }
    try {
      const body = await readFile(target);
      const contentType = target.endsWith('.js') ? 'application/javascript'
        : target.endsWith('.css') ? 'text/css'
          : target.endsWith('.json') ? 'application/json' : 'text/html';
      await route.fulfill({ status: 200, contentType, body });
    } catch { await route.abort(); }
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.goto(`${origin}/delivery.html`, { waitUntil: 'networkidle' });

  const body = await page.locator('body').innerText();
  for (const required of [
    '저장한 요청의 실행 접수', '완료 조건', '마지막 실제 엔진 검증 · V9',
    '7 통과 · 1 실패', '482건 미실행', '2 / 16',
  ]) assert.ok(body.includes(required), `current plan shows ${required}`);
  report.results.push({ name: 'current outcome, original acceptance progress, and latest V9 evidence are visible', verdict: 'pass' });

  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'desktop page has no horizontal overflow');
  await page.screenshot({ path: path.join(evidence, 'desktop.png'), fullPage: true });
  report.captures.push('workflow-artifacts/delivery/browser/desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile page has no horizontal overflow');
  await page.screenshot({ path: path.join(evidence, 'mobile.png'), fullPage: true });
  report.captures.push('workflow-artifacts/delivery/browser/mobile.png');
  report.results.push({ name: 'desktop and mobile fit without horizontal page overflow', verdict: 'pass' });
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.apiRequests, []);
  assert.deepEqual(report.externalRequests, []);
  report.results.push({ name: 'offline page has no script errors, API calls, or external requests', verdict: 'pass' });
} catch (error) {
  report.harnessError = String(error?.stack || error?.message || error);
} finally {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  report.verdict = report.harnessError || report.results.some(item => item.verdict !== 'pass')
    || report.pageErrors.length || report.consoleErrors.length || report.apiRequests.length || report.externalRequests.length ? 'fail' : 'pass';
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  await writeFile(path.join(evidence, 'result.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

console.log(`Delivery dashboard offline browser check: ${report.results.filter(item => item.verdict === 'pass').length} passed, ${report.verdict}.`);
if (report.verdict !== 'pass') process.exitCode = 1;
