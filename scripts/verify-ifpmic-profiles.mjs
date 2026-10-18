import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const attempt = new Date().toISOString().replace(/[:.]/g, '-')
const out = join(root, 'workflow-artifacts/verification/B01/gates', attempt)
await mkdir(out, { recursive: true })
const baseline = JSON.parse(await readFile(join(root, 'docs/ifpmic/evidence/b01/controls-baseline.json'), 'utf8'))
const report = { kind: 'ifpmic_b01_local_profile_candidate', attempt, startedAt: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  scope: 'P1-P5 local parser, registry, immutable snapshot and CLI. No service ingress, original AT execution, device or publisher acceptance.',
  commands: [], verdict: 'running' }
async function files(dir) {
  const entries = await readdir(join(root, dir), { withFileTypes: true })
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(dir, entry.name)) : join(dir, entry.name)))).flat()
}
async function hashes(paths) {
  return Object.fromEntries(await Promise.all([...new Set(paths)].sort().map(async path => [path, sha(await readFile(join(root, path)))])))
}
async function snapshot() {
  const paths = (await Promise.all(['src', 'server', 'plugins', 'scripts', 'tests', 'runtime', 'docs/ifpmic/design-v1', 'docs/ifpmic/evidence/b01'].map(files))).flat()
  paths.push(...Object.keys(baseline.sourceHashes), 'docs/ifpmic/B01-PROFILES.md')
  return hashes(paths)
}
async function uiSources() {
  const dirs = ['src', 'server', 'plugins']
  const current = (await Promise.all(dirs.map(files))).flat().sort()
  const expected = Object.keys(baseline.sourceHashes).filter(path => dirs.some(dir => path.startsWith(`${dir}/`))).sort()
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Protected UI/server source inventory changed: expand UI verification before acceptance')
  const allowed = new Set(['package.json', 'package-lock.json', 'README.md'])
  const mismatches = []
  for (const [path, digest] of Object.entries(baseline.sourceHashes)) {
    if (!allowed.has(path) && sha(await readFile(join(root, path))) !== digest) mismatches.push(path)
  }
  if (mismatches.length) throw new Error(`Protected baseline source changes: ${mismatches.join(', ')}`)
  return { inventory_count: current.length, matching_original_source_pins: Object.keys(baseline.sourceHashes).length - allowed.size,
    allowed_changed_paths: [...allowed], note: 'Exact current package/lock/README hashes are frozen separately. New Node files are outside protected UI/server source inventories.' }
}
async function lockDelta() {
  const original = JSON.parse(execFileSync('git', ['show', `${baseline.accepted_commit}:package-lock.json`], { cwd: root, encoding: 'utf8' }))
  const current = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  const changed = Object.keys(original.packages).filter(path => path && JSON.stringify(original.packages[path]) !== JSON.stringify(current.packages[path]))
  if (changed.length) throw new Error('Existing dependency resolution changed: expand dependency/UI verification')
  const added = Object.keys(current.packages).filter(path => !Object.hasOwn(original.packages, path)).sort()
  const expected = ['node_modules/ajv', 'node_modules/fast-deep-equal', 'node_modules/fast-uri', 'node_modules/json-schema-traverse', 'node_modules/require-from-string']
  if (JSON.stringify(added) !== JSON.stringify(expected) || current.packages['node_modules/ajv'].version !== '8.20.0') throw new Error('Unexpected Node dependency delta')
  const beforeRoot = original.packages[''], afterRoot = current.packages['']
  const sorted = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort()))
  if (sorted(beforeRoot.devDependencies) !== sorted(afterRoot.devDependencies)
      || sorted({ ...beforeRoot.dependencies, ajv: '8.20.0' }) !== sorted(afterRoot.dependencies)) throw new Error('Unexpected root dependencies')
  return { existing_packages_unchanged: true, added_packages: added.map(path => ({ path, version: current.packages[path].version, integrity: current.packages[path].integrity })),
    install_policy: 'npm install --save-exact --ignore-scripts ajv@8.20.0', remaining_risk: 'Registry integrity hashes and no old resolution drift do not establish operational supply-chain acceptance.' }
}
async function run(name, program, args) {
  const startedAt = new Date().toISOString()
  let output = '', failure, signal
  const exitCode = await new Promise(resolveExit => {
    const child = spawn(program, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 })
    child.stdout.on('data', bytes => { output += bytes.toString() })
    child.stderr.on('data', bytes => { output += bytes.toString() })
    child.on('error', error => { failure = error.code ?? 'SPAWN_ERROR' })
    child.on('close', (code, sig) => { signal = sig; resolveExit(code) })
  })
  await writeFile(join(out, `${name}.log`), output)
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].flatMap(key => {
    const match = output.match(new RegExp(`(?:ℹ|#) ${key}\\s+(\\d+)`)); return match ? [[key, Number(match[1])]] : []
  }))
  report.commands.push({ name, command: [program, ...args], startedAt, finishedAt: new Date().toISOString(), exitCode, signal, failure,
    ...(Object.keys(counts).length ? { counts } : {}), log: relative(root, join(out, `${name}.log`)), logSha256: sha(output) })
  console.log(`${name}: ${exitCode === 0 ? 'PASS' : 'FAIL'}`)
  if (exitCode !== 0 || signal || failure) throw new Error(`${name} failed; inspect its retained log`)
  if (name === 'targeted' || name === 'unit') {
    if (!counts.tests || counts.tests !== counts.pass || counts.fail !== 0 || counts.skipped !== 0 || (name === 'unit' && counts.tests < 340)) throw new Error('All tests including original339 must pass without skips')
  }
}
try {
  if (sha(await readFile(join(root, 'docs/ifpmic/evidence/b01/controls-baseline.json'))) !== 'a872346739a4c10f310490b5da1aa5a4dbf58deaec32706929ea64a0a2e16247') throw new Error('Pinned controls baseline changed')
  for (const pin of baseline.pins) if (sha(await readFile(join(root, pin.path))) !== pin.sha256) throw new Error('Accepted controls evidence pin changed')
  const plan = await readFile(join(root, 'docs/ifpmic/B01-PROFILES.md'))
  const approvedSha = '8c22f1ceaf1d0f3ca1cf7113a829d7e4441df1fb5ebebdbe48a9d71c1e20d7a8'
  if (sha(plan) !== approvedSha) throw new Error('Approved B01 plan changed')
  for (const name of ['plan-review-v4.json', 'tc-plan-review-v4.json']) {
    const review = JSON.parse(await readFile(join(root, 'docs/ifpmic/evidence/b01', name), 'utf8'))
    if (review.reviewed_plan?.sha256 !== approvedSha || !review.decision?.startsWith('approve')) throw new Error('Independent plan approval missing')
  }
  report.sourceHashes = await snapshot(); report.sourceFingerprint = sha(JSON.stringify(report.sourceHashes))
  report.uiSourceComparison = await uiSources(); report.dependencyDelta = await lockDelta()
  const tests = (await files('tests')).filter(path => /^tests\/ifpmic-profile.*\.test\.mjs$/.test(path)).sort()
  if (!tests.length) throw new Error('Independent profile tests absent')
  await run('targeted', 'node', ['--test', ...tests])
  await run('unit', 'npm', ['test'])
  await run('build', 'npm', ['run', 'build'])
  await run('plugin-build', 'npm', ['run', 'ifpmic:plugin:build'])
  await run('source-uploads', 'npm', ['run', 'ifpmic:verify-sources'])
  report.buildOutputHashes = await hashes((await Promise.all(['dist', '.paperclip-lab/ifpmic-plugin'].map(files))).flat())
  if (JSON.stringify(report.buildOutputHashes) !== JSON.stringify(baseline.buildOutputHashes)) throw new Error('UI/plugin output inventory or bytes changed: expand UI verification')
  const after = await snapshot()
  report.sourceChanges = [...new Set([...Object.keys(report.sourceHashes), ...Object.keys(after)])].filter(path => report.sourceHashes[path] !== after[path])
  if (report.sourceChanges.length) throw new Error('Candidate changed during verification')
  report.uiGateOmission = { reason: 'All protected baseline source bytes, UI/server inventory, and ten build/plugin outputs equal the accepted controls candidate; only isolated Node runtime/CLI/dependency additions.',
    baseline: 'docs/ifpmic/evidence/b01/controls-baseline.json', remaining_risks: ['Real service/UI integration is not tested.', 'Actual device, approval, publisher and original AT04/28 are not executed.', 'Local process/fault checks do not prove power-loss durability.'] }
  report.verdict = 'pass'
} catch (error) { report.verdict = 'fail'; report.finding = error.message; process.exitCode = 1 }
finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(join(out, 'gate.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`B01 candidate ${report.verdict}: ${relative(root, join(out, 'gate.json'))}`)
}
