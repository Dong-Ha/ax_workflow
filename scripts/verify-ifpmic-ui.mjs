import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const attempt = new Date().toISOString().replace(/[:.]/g, '-');
const directory = join(root, 'workflow-artifacts/verification/V2/ui/gates', attempt);
await mkdir(directory, { recursive: true });
async function files(directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : join(directory, entry.name)))).flat();
}
async function snapshot() {
  const paths = (await Promise.all(['src', 'server', 'tests', 'scripts', 'plugins', 'docs/ifpmic/design-v1'].map(files))).flat();
  paths.push('docs/ifpmic/V2-CONTROLS.md', 'docs/ifpmic/evidence/v2/controls-baseline-59.json', 'docs/ifpmic/evidence/v2/controls-plan-review.json', 'docs/ifpmic/evidence/v2/controls-catalog-plan-clarification.json', 'docs/ifpmic/evidence/v2/controls-artifact-registry.json', 'docs/ifpmic/V2-CHILDREN.md', 'docs/ifpmic/evidence/v2/children-baseline-50.json', 'docs/ifpmic/evidence/v2/children-plan-review.json', 'docs/ifpmic/evidence/v2/children-design-review.json', 'docs/ifpmic/V2-SQE-UI.md', 'docs/ifpmic/evidence/v2/sqe-ui-baseline-41.json', 'docs/ifpmic/evidence/v2/sqe-ui-plan-review.json', 'docs/ifpmic/V2-SQE.md', 'docs/ifpmic/evidence/v2/sqe-baseline-41.json', 'docs/ifpmic/evidence/v2/sqe-plan-review.json', 'docs/ifpmic/evidence/v2/sqe-design-review.json', 'docs/ifpmic/V2-ROUTING-UI.md', 'docs/ifpmic/evidence/v2/routing-ui-baseline-32.json', 'docs/ifpmic/evidence/v2/routing-ui-plan-review.json', 'docs/ifpmic/V2-ROUTING.md', 'docs/ifpmic/evidence/v2/routing-plan-review.json', 'docs/ifpmic/V2-EXCEPTION-UI-CAPTURE.md', 'docs/ifpmic/evidence/v2/exception-ui-capture-review.json', 'docs/ifpmic/evidence/v2/ui-catalog.json', 'docs/ifpmic/V2-EXCEPTION-UI.md', 'docs/ifpmic/V2-EXCEPTIONS.md', 'docs/ifpmic/evidence/v2/exception-ui-plan-review.json', 'docs/ifpmic/evidence/v2/exceptions-plan-review-2.json', 'README.md', 'docs/ifpmic/V2-UI.md', 'docs/ifpmic/V2-SCENARIOS.md', 'docs/ifpmic/V2-PROTOCOLS.md', 'docs/ifpmic/V2-IMPLEMENTATION.md', 'docs/ifpmic/evidence/v2/ui-plan-review.json', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'index.html', 'ifpmic.html', 'docs/ifpmic/PLAN.md', 'docs/ifpmic/VERIFICATION.md', 'docs/ifpmic/evidence/plan-review.json', 'docs/ifpmic/source-manifest.json', 'IFPMIC_AX_Design_Package_v1.zip', 'IFPMIC_AX_Design_v1.docx');
  for (const name of await readdir(join(root, 'experiments/paperclip'))) if (/\.(mjs|json)$/.test(name)) paths.push(join('experiments/paperclip', name));
  return Object.fromEntries(await Promise.all([...new Set(paths)].sort().map(async path => [path, sha256(await readFile(join(root, path)))])));
}
const before = await snapshot();
const report = { kind: 'ifpmic_v2_partial_ui_candidate_verification', scope: 'P12 child observations and 74-scenario inventory/endpoints including 15 controls examples, with V0/V1/AX regression; controls interaction UI acceptance and real AT remain pending', attempt, startedAt: new Date().toISOString(), sourceHashes: before, sourceFingerprint: sha256(JSON.stringify(before)), commands: [], reports: {}, verdict: 'running' };
async function run(name, command, args) {
  const log = join(directory, `${name}.log`);
  const startedAt = new Date().toISOString();
  let output = '';
  const exitCode = await new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    child.stdout.on('data', data => { output += data.toString(); });
    child.stderr.on('data', data => { output += data.toString(); });
    child.on('error', reject);
    child.on('close', code => accept(code));
  });
  await writeFile(log, output);
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].flatMap(key => {
    const match = output.match(new RegExp(`(?:ℹ|#) ${key}\\s+(\\d+)`));
    return match ? [[key, Number(match[1])]] : [];
  }));
  report.commands.push({ name, command: [command, ...args], startedAt, finishedAt: new Date().toISOString(), exitCode, ...(Object.keys(counts).length ? { counts } : {}), log: relative(root, log), logSha256: sha256(output) });
  console.log(`${name}: ${exitCode === 0 ? 'PASS' : 'FAIL'}`);
  if (exitCode !== 0) throw new Error(`${name} failed; see ${relative(root, log)}`);
}
try {
  await run('unit', 'npm', ['test']);
  const unit = report.commands.find(command => command.name === 'unit');
  if (!unit.counts || unit.counts.tests < 1 || unit.counts.pass !== unit.counts.tests
      || unit.counts.fail !== 0 || unit.counts.skipped !== 0) throw new Error('All unit tests must pass without skips');
  const sqeBytes = await readFile(join(root, 'workflow-artifacts/verification/V2/sqe/unit-observations.json'));
  const sqe = JSON.parse(sqeBytes);
  const sqeCases = ['manual-pass', 'typed-fail', 'incomplete', 'parser-error', 'identity-mismatch', 'manual-retry'];
  if (sqe.kind !== 'synthetic-sqe-observation-samples' || sqe.mode !== 'mock'
      || !Number.isFinite(Date.parse(sqe.generated_at)) || Date.parse(sqe.generated_at) < Date.parse(report.startedAt)
      || sqe.test_file !== 'tests/ifpmic-sqe.test.mjs' || sqe.test_file_sha256 !== before[sqe.test_file]
      || JSON.stringify(Object.keys(sqe.cases || {}).sort()) !== JSON.stringify(sqeCases.sort())) {
    throw new Error('SQE unit observations must be fresh and bound to this tested candidate');
  }
  await writeFile(join(directory, 'sqe-unit-observations.json'), sqeBytes);
  report.reports['sqe-unit-observations.json'] = { path: relative(root, join(directory, 'sqe-unit-observations.json')), sha256: sha256(sqeBytes) };
  await run('build', 'npm', ['run', 'build']);
  await run('plugin-build', 'npm', ['run', 'ifpmic:plugin:build']);
  await run('source-uploads', 'npm', ['run', 'ifpmic:verify-sources']);
  await run('design-validator', 'python3', ['-c', 'import pathlib, tempfile, shutil, subprocess\nwith tempfile.TemporaryDirectory(prefix="ifpmic-gate-") as temp:\n target=pathlib.Path(temp)/"design"\n shutil.copytree("docs/ifpmic/design-v1",target)\n subprocess.run(["python3",str(target/"verify_design.py")],check=True)']);
  await run('ifpmic-browser', 'npm', ['run', 'test:ifpmic:browser']);
  await run('paperclip-host', 'npm', ['run', 'test:ifpmic:host']);
  await run('catalog-evidence', 'node', ['scripts/ifpmic-catalog-evidence.mjs']);
  await run('replay-browser', 'npm', ['run', 'test:ifpmic:replay']);
  await run('replay-host', 'npm', ['run', 'test:ifpmic:replay:host']);
  await run('legacy-browser', 'npm', ['run', 'test:browser']);
  for (const name of ['browser.json', 'host-browser.json']) {
    const bytes = await readFile(join(root, 'workflow-artifacts/verification/V1', name));
    const value = JSON.parse(bytes);
    if (value.verdict !== 'pass') throw new Error(`${name} did not pass`);
    await writeFile(join(directory, name), bytes);
    report.reports[name] = { path: relative(root, join(directory, name)), sha256: sha256(bytes) };
  }
  for (const name of ['source-upload.json', 'negative-fixtures.json']) {
    const bytes = await readFile(join(root, 'workflow-artifacts/verification/V0', name));
    const value = JSON.parse(bytes);
    if (name === 'source-upload.json' ? value.verdict !== 'pass' : value.cases?.length !== 4 || value.networkCalls !== 0) throw new Error(`${name} evidence incomplete`);
    await writeFile(join(directory, name), bytes);
    report.reports[name] = { path: relative(root, join(directory, name)), sha256: sha256(bytes) };
  }
  for (const name of ['standalone-browser.json', 'host-browser.json', 'catalog.json', 'catalog-journal.json', 'sqe-migration.json', 'children-migration.json']) {
    const bytes = await readFile(join(root, 'workflow-artifacts/verification/V2/ui', name));
    const value = JSON.parse(bytes);
    if (name.includes('browser') && value.verdict !== 'pass') throw new Error(`${name} did not pass`);
    if (name === 'catalog.json' && (value.scenario_count !== 74 || value.mode !== 'mock')) throw new Error('Catalog manifest incomplete');
    await writeFile(join(directory, `ui-${name}`), bytes);
    report.reports[`ui-${name}`] = { path: relative(root, join(directory, `ui-${name}`)), sha256: sha256(bytes) };
    if (name.includes('browser')) for (const screenshot of value.evidence || []) {
      const image = await readFile(join(root, screenshot));
      const filename = screenshot.split('/').pop();
      await writeFile(join(directory, filename), image);
      report.reports[filename] = { path: relative(root, join(directory, filename)), sha256: sha256(image) };
    }
  }
  const after = await snapshot();
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    report.sourceChanges = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path]);
    report.afterSourceFingerprint = sha256(JSON.stringify(after));
    throw new Error('Source changed during verification; this attempt cannot approve the new candidate');
  }
  report.buildAssets = Object.fromEntries(await Promise.all((await files('dist')).sort().map(async path => [path, sha256(await readFile(join(root, path)))])));
  report.pluginAssets = Object.fromEntries(await Promise.all((await files('.paperclip-lab/ifpmic-plugin')).sort().map(async path => [path, sha256(await readFile(join(root, path)))])));
  report.verdict = 'pass';
} catch (error) {
  report.verdict = 'fail'; report.finding = error.message; process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  const bytes = JSON.stringify(report, null, 2) + '\n';
  await writeFile(join(directory, 'gate.json'), bytes);
  await writeFile(join(root, 'workflow-artifacts/verification/V2/ui/latest-gate.json'), bytes);
  console.log(`V2 UI candidate ${report.verdict}: ${relative(root, join(directory, 'gate.json'))}`);
}
