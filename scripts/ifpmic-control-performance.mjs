import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import workflow from '../docs/ifpmic/design-v1/specs/workflow.v1.json' with { type: 'json' };
import stateContract from '../docs/ifpmic/design-v1/specs/state-contract.json' with { type: 'json' };
import { createScenarioCatalog, replayScenario } from '../src/ifpmic/replay.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = join(root, 'workflow-artifacts/verification/V2/controls/performance.json');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fileSha256 = async path => sha256(await readFile(join(root, path)));
const selectedIds = [
  'cycle-limit',
  'metadata-recovery',
  'cancel-child',
  'cancel-flash-unknown',
  'cancel-remote-late-receipt',
  'cancel-pending-dispatch',
];
const sourcePaths = [
  'docs/ifpmic/design-v1/specs/workflow.v1.json',
  'docs/ifpmic/design-v1/specs/state-contract.json',
  'src/ifpmic/replay.mjs',
  'src/ifpmic/protocols.mjs',
  'src/ifpmic/controls.mjs',
  'src/ifpmic/control-effects.mjs',
  'src/ifpmic/children.mjs',
  'src/ifpmic/sqe.mjs',
  'src/ifpmic/exceptions.mjs',
  'src/ifpmic/routing.mjs',
  'src/ifpmic/scenarios.mjs',
  'src/ifpmic/control-scenarios.mjs',
];
const durationLimitMs = 120_000;
const report = {
  kind: 'ifpmic-controls-performance-observation',
  mode: 'mock',
  scope: 'Fixed long/max-rework and cancellation scenario full-replay timing and determinism; not a runtime or real-AT performance claim.',
  generated_at: new Date().toISOString(),
  duration_limit_ms_per_replay: durationLimitMs,
  selected_scenario_ids: selectedIds,
  source_sha256: {},
  runner: { path: relative(root, fileURLToPath(import.meta.url)), sha256: null },
  scenarios: [],
  verdict: 'running',
};

let failed = false;
try {
  for (const path of sourcePaths) report.source_sha256[path] = await fileSha256(path);
  report.runner.sha256 = await fileSha256(report.runner.path);

  const catalog = createScenarioCatalog(workflow, stateContract);
  const selected = selectedIds.map(id => {
    const matches = catalog.filter(scenario => scenario.id === id);
    assert.equal(matches.length, 1, `expected one fixed catalog fixture for ${id}`);
    return matches[0];
  });
  const totalStarted = performance.now();

  for (const scenario of selected) {
    const row = {
      id: scenario.id,
      event_count: scenario.events.length,
      checkpoint_count: scenario.checkpoints.length,
      fixture_sha256: sha256(JSON.stringify(scenario)),
      runs: [],
      deterministic: false,
      input_unchanged: false,
      verdict: 'running',
    };
    const initialInputHash = row.fixture_sha256;
    let firstSnapshot;
    try {
      assert.ok(Object.isFrozen(scenario) && Object.isFrozen(scenario.events)
        && scenario.events.every(Object.isFrozen), `${scenario.id} fixture must be immutable`);
      assert.ok(scenario.events.every(event => event.mode === 'mock'), `${scenario.id} fixture events must use mock mode`);
      for (let run = 1; run <= 2; run++) {
        const started = performance.now();
        const snapshot = replayScenario(scenario, workflow, stateContract, scenario.events.length);
        const elapsedMs = performance.now() - started;
        row.runs.push({ ordinal: run, duration_ms: Number(elapsedMs.toFixed(3)),
          snapshot_sha256: sha256(JSON.stringify(snapshot)) });
        assert.ok(elapsedMs <= durationLimitMs, `${scenario.id} full replay ${run} exceeded ${durationLimitMs} ms`);
        assert.equal(snapshot.mode, 'mock', `${scenario.id} replay mode`);
        assert.equal(snapshot.real_publish_allowed, false, `${scenario.id} cannot authorize real publish`);
        if (run === 1) firstSnapshot = snapshot;
        else assert.deepEqual(snapshot, firstSnapshot, `${scenario.id} full replay is deterministic`);
        assert.equal(sha256(JSON.stringify(scenario)), initialInputHash, `${scenario.id} input remains unchanged after run ${run}`);
      }
      row.deterministic = true;
      row.input_unchanged = true;
      row.verdict = 'pass';
    } catch (error) {
      row.verdict = 'fail';
      row.finding = error.message;
      failed = true;
    }
    report.scenarios.push(row);
  }

  report.total_duration_ms = Number((performance.now() - totalStarted).toFixed(3));
  const afterHashes = {};
  for (const path of sourcePaths) afterHashes[path] = await fileSha256(path);
  afterHashes[report.runner.path] = await fileSha256(report.runner.path);
  report.source_unchanged = sourcePaths.every(path => report.source_sha256[path] === afterHashes[path])
    && report.runner.sha256 === afterHashes[report.runner.path];
  if (!report.source_unchanged) {
    failed = true;
    report.source_changes = Object.keys(afterHashes).filter(path =>
      (path === report.runner.path ? report.runner.sha256 : report.source_sha256[path]) !== afterHashes[path]);
  }
  report.verdict = failed ? 'fail' : 'pass';
} catch (error) {
  report.verdict = 'fail';
  report.finding = error.message;
}

report.finished_at = new Date().toISOString();
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(`MOCK control performance ${report.verdict}: ${report.scenarios.length}/${selectedIds.length} scenarios; ${report.total_duration_ms ?? 'incomplete'} ms total.`);
if (report.verdict !== 'pass') process.exitCode = 1;
