import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const evidenceDir = path.join(root, 'workflow-artifacts/verification/V1');
const origin = 'http://ifpmic-smoke.invalid';
const pageUrl = `${origin}/ifpmic.html`;
const nodeIds = [
  'P01', 'P02', 'P03', 'P04', 'P05', 'X01', 'P06', 'P07', 'P08', 'P09', 'P10',
  'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19', 'P20', 'P21',
  'P22', 'P23', 'P24', 'X02', 'X03', 'P25', 'P26',
];
const report = {
  kind: 'ifpmic-v1-offline-browser',
  route: '/ifpmic.html',
  evidence: [],
  unexpectedExternalRequests: [],
  apiRequests: [],
  pageErrors: [],
  consoleErrors: [],
  results: [],
};
let browser;
let context;
let page;

function record(name, action) {
  return action().then(() => report.results.push({ name, verdict: 'pass' })).catch(error => {
    report.results.push({ name, verdict: 'fail', finding: String(error?.message || error) });
  });
}

function failRequest(route, list, url) {
  list.push(url);
  return route.abort();
}

try {
  await mkdir(evidenceDir, { recursive: true });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const requestUrl = route.request().url();
    let parsed;
    try { parsed = new URL(requestUrl); } catch { await failRequest(route, report.unexpectedExternalRequests, requestUrl); return; }
    if (parsed.origin !== origin) { await failRequest(route, report.unexpectedExternalRequests, requestUrl); return; }
    if (parsed.pathname.startsWith('/api/')) { await failRequest(route, report.apiRequests, requestUrl); return; }

    let relative;
    try { relative = decodeURIComponent(parsed.pathname).replace(/^\/+/, ''); } catch { await failRequest(route, report.unexpectedExternalRequests, requestUrl); return; }
    if (!relative || relative === 'ifpmic.html') relative = 'ifpmic.html';
    const target = path.resolve(dist, relative);
    if (!target.startsWith(`${dist}${path.sep}`)) { await failRequest(route, report.unexpectedExternalRequests, requestUrl); return; }
    try {
      const body = await readFile(target);
      const contentType = target.endsWith('.js') ? 'application/javascript'
        : target.endsWith('.css') ? 'text/css'
          : target.endsWith('.svg') ? 'image/svg+xml'
            : target.endsWith('.json') ? 'application/json'
              : 'text/html';
      await route.fulfill({ status: 200, contentType, body });
    } catch {
      await failRequest(route, report.unexpectedExternalRequests, requestUrl);
    }
  });
  page = await context.newPage();
  page.setDefaultTimeout(4000);
  page.on('pageerror', error => report.pageErrors.push(String(error?.message || error)));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.goto(pageUrl, { waitUntil: 'networkidle' });

  const card = id => page.getByTestId(`ifpmic-node-${id}`);
  const detail = page.getByRole('region', { name: '선택 단계 상세' });
  const search = page.getByRole('searchbox', { name: '단계 검색' });
  const owner = page.getByLabel('담당', { exact: true });
  const clear = page.getByRole('button', { name: '필터 초기화' });
  const visibleIds = async () => page.locator('[data-testid^="ifpmic-node-"]').evaluateAll(cards => cards.map(node => node.dataset.testid.replace('ifpmic-node-', '')));

  await record('Standalone preview route serves the IFPMIC page offline', async () => {
    assert.equal(new URL(page.url()).pathname, '/ifpmic.html');
    await page.getByTestId('ifpmic-phase-1').waitFor();
  });

  await record('workflow cards, phases, edges and terminal match the V1 display contract', async () => {
    assert.deepEqual(await visibleIds(), nodeIds);
    assert.equal(await page.locator('[data-testid^="ifpmic-phase-"]').count(), 6);
    assert.equal(await page.locator('[data-edge-from][data-edge-to][data-edge-kind]').count(), 41);
    assert.equal(await page.getByTestId('ifpmic-end').count(), 1);
    assert.match(await page.locator('body').innerText(), /전체\s*29개 단계/);
    for (const id of nodeIds) {
      const button = card(id);
      assert.equal(await button.count(), 1, `node ${id}`);
      assert.equal(await button.getAttribute('aria-pressed'), id === 'P01' ? 'true' : 'false', `initial selection state ${id}`);
    }
    const humanOwners = await page.locator('[data-testid^="ifpmic-node-"]').evaluateAll(cards => cards.filter(node => node.querySelector('.ifpmic-node-owner')?.textContent?.trim().startsWith('human')).length);
    assert.equal(humanOwners, 7);
  });

  await record('selecting a node exposes its public detail fields and requirement links', async () => {
    await card('P01').click();
    assert.equal(await card('P01').getAttribute('aria-pressed'), 'true');
    const text = await detail.innerText();
    for (const required of ['요청 원문과 입력 누락 목록', '필수 입력 식별 및 요청 원문 보존', 'NEVER', 'REQ-']) {
      assert.ok(text.includes(required), `detail contains ${required}`);
    }
  });

  await record('search, owner filtering, result counts and clear operate on the displayed graph', async () => {
    await clear.click();
    await search.fill('SAM');
    assert.deepEqual(await visibleIds(), ['P15', 'P16']);
    await owner.selectOption('arch-runner');
    assert.deepEqual(await visibleIds(), ['P15']);
    assert.match(await page.locator('body').innerText(), /검색 결과\s*1개|표시\s*1\s*\/\s*전체\s*29/);
    await clear.click();
    assert.deepEqual(await visibleIds(), nodeIds);
    assert.equal(await search.inputValue(), '');
  });

  await record('special outcomes and business failure route controls navigate to their target nodes', async () => {
    for (const [source, outcome, target] of [
      ['P03', 'P03.unresolved', 'WAITING_HUMAN'],
      ['X01', 'X01.rejected', 'P02'],
      ['P21', 'P21.design_change_needed', 'P07'],
      ['X03', 'X03.reject_code', 'P11'],
      ['X03', 'X03.reject_design', 'P07'],
      ['X03', 'X03.reject_release_metadata', 'X02'],
      ['P25', 'P25.unknown_remote_state', 'RECONCILING'],
      ['P26', 'P26.failure', 'retry_notes_only'],
    ]) {
      await card(source).click();
      assert.ok((await detail.innerText()).includes(outcome), `${outcome} appears in selected detail`);
      if (/^[PX]\d\d$/.test(target)) {
        await detail.getByRole('button', { name: new RegExp(target) }).click();
        assert.equal(await card(target).getAttribute('aria-pressed'), 'true');
      } else {
        assert.ok((await detail.innerText()).includes(target), `${target} is visible outcome`);
      }
    }
    await card('P16').click();
    await detail.getByRole('button', { name: /P07/ }).click();
    assert.equal(await card('P07').getAttribute('aria-pressed'), 'true');
  });

  await record('workflow cards support ArrowDown, ArrowUp, Home and End while skipping filtered nodes', async () => {
    await clear.click();
    await card('P01').focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await card('P02').getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('ArrowUp');
    assert.equal(await card('P01').getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('End');
    assert.equal(await card('P26').getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Home');
    assert.equal(await card('P01').getAttribute('aria-pressed'), 'true');
    await search.fill('SAM');
    await card('P15').focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await card('P16').getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('ArrowDown');
    assert.equal(await card('P15').getAttribute('aria-pressed'), 'true');
  });

  await record('desktop and 375px mobile layouts expose core details without page overflow', async () => {
    await clear.click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await card('P07').click();
    assert.ok(await detail.isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(evidenceDir, 'desktop.png'), fullPage: true });
    report.evidence.push('workflow-artifacts/verification/V1/desktop.png');

    await page.setViewportSize({ width: 375, height: 812 });
    assert.ok(await search.isVisible());
    assert.ok(await detail.isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page must not overflow horizontally');
    assert.ok(await page.evaluate(() => {
      const board = document.querySelector('.ifpmic-scroll');
      return board && (board.scrollWidth <= board.clientWidth || getComputedStyle(board).overflowX === 'auto' || getComputedStyle(board).overflowX === 'scroll');
    }), 'only the workflow board may use an inner horizontal scroller');
    await page.screenshot({ path: path.join(evidenceDir, 'mobile-375.png'), fullPage: true });
    report.evidence.push('workflow-artifacts/verification/V1/mobile-375.png');
  });

  await record('read-only visualizer sends no API/write requests or external network traffic', async () => {
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
  report.verdict = report.harnessError || report.results.some(result => result.verdict === 'fail')
    || report.apiRequests.length || report.unexpectedExternalRequests.length || report.pageErrors.length || report.consoleErrors.length
    ? 'fail' : 'pass';
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, 'browser.json'), `${JSON.stringify(report, null, 2)}\n`);
}

console.log(`IFPMIC V1 offline browser checks: ${report.results.filter(result => result.verdict === 'pass').length} passed, ${report.results.filter(result => result.verdict === 'fail').length} failed (${report.verdict}).`);
if (report.verdict !== 'pass') process.exitCode = 1;
