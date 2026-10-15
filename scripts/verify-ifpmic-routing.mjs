import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const attempt = new Date().toISOString().replace(/[:.]/g, '-');
const directory = join(root, 'workflow-artifacts/verification/V2/routing/gates', attempt);
await mkdir(directory, { recursive: true });
async function files(directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : join(directory, entry.name)))).flat();
}
async function snapshot() {
  const paths = (await Promise.all(['src', 'server', 'tests', 'scripts', 'plugins', 'docs/ifpmic/design-v1'].map(files))).flat();
  paths.push('docs/ifpmic/V2-ROUTING.md', 'docs/ifpmic/evidence/v2/routing-plan-review.json', 'docs/ifpmic/evidence/v2/routing-design-review.json', 'docs/ifpmic/evidence/v2/ui-catalog.json', 'docs/ifpmic/evidence/v2/exceptions-plan-review-2.json', 'docs/ifpmic/evidence/v2/exceptions-plan-reviewed-1.md', 'docs/ifpmic/V2-EXCEPTIONS.md', 'docs/ifpmic/evidence/v2/exceptions-plan-review.json', 'README.md', 'docs/ifpmic/V2-UI.md', 'docs/ifpmic/V2-SCENARIOS.md', 'docs/ifpmic/V2-PROTOCOLS.md', 'docs/ifpmic/V2-IMPLEMENTATION.md', 'docs/ifpmic/evidence/v2/ui-plan-review.json', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'index.html', 'ifpmic.html', 'docs/ifpmic/PLAN.md', 'docs/ifpmic/VERIFICATION.md', 'docs/ifpmic/evidence/plan-review.json', 'docs/ifpmic/source-manifest.json', 'IFPMIC_AX_Design_Package_v1.zip', 'IFPMIC_AX_Design_v1.docx');
  for (const name of await readdir(join(root, 'experiments/paperclip'))) if (/\.(mjs|json)$/.test(name)) paths.push(join('experiments/paperclip', name));
  return Object.fromEntries(await Promise.all([...new Set(paths)].sort().map(async path => [path, sha256(await readFile(join(root, path)))])));
}
const before = await snapshot();
const report = { kind: 'ifpmic_v2_partial_routing_candidate_verification', scope: 'Approved mock reuse, policy exemption, coupled gates and NO_CHANGE protocols; full unit/build/plugin regression; partial V2, no new UI or real AT', attempt, startedAt: new Date().toISOString(), sourceHashes: before, sourceFingerprint: sha256(JSON.stringify(before)), commands: [], reports: {}, verdict: 'running' };
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
  await run('build', 'npm', ['run', 'build']);
  await run('plugin-build', 'npm', ['run', 'ifpmic:plugin:build']);
  const unit = report.commands.find(command => command.name === 'unit');
  if (!unit.counts || unit.counts.tests < 1 || unit.counts.pass !== unit.counts.tests
      || unit.counts.fail !== 0 || unit.counts.skipped !== 0) throw new Error('All unit tests must pass without skips');
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
  await writeFile(join(root, 'workflow-artifacts/verification/V2/routing/latest-gate.json'), bytes);
  console.log(`V2 routing candidate ${report.verdict}: ${relative(root, join(directory, 'gate.json'))}`);
}
