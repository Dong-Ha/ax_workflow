import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { feedbackCommands, parseArgs, planPath, selectFlow, selectSlice } from '../scripts/ifpmic-delivery.mjs';

const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const cli = new URL('../scripts/ifpmic-delivery.mjs', import.meta.url);

test('only one active flow; later work cannot silently replace current delivery', () => {
  assert.deepEqual(plan.flows.filter(flow => flow.status === 'in_progress').map(flow => flow.id), [plan.current_flow]);
  assert.equal(selectFlow(plan).id, 'admission');
  assert.throws(() => selectFlow(plan, 'nonexistent'));
});

test('slice selection isolates mock development from runtime diagnostics', () => {
  const flow = selectFlow(plan);
  const slice = selectSlice(flow, plan.current_slice);
  assert.equal(slice.id, 'admission-mock');
  assert.deepEqual(slice.blockers, []);
  assert.deepEqual(flow.diagnostic.blocks_slices, ['admission-live']);
  assert.throws(() => selectSlice(flow, 'missing'));
  assert.throws(() => selectSlice(selectFlow(plan, 'minimal-mock'), slice.id));
});

test('profiles run only allowed local checks and reject injected or stale names', () => {
  const flow = selectFlow(plan);
  const mock = selectSlice(flow, 'admission-mock');
  assert.deepEqual(feedbackCommands(flow, mock).map(item => item.name), ['delivery-tool', 'admission-state']);
  assert.throws(() => feedbackCommands(flow, mock, ['admission-local']));
  const live = selectSlice(flow, 'admission-live');
  assert.equal(feedbackCommands(flow, live).length, 2);
  assert.deepEqual(feedbackCommands(flow, live, ['admission-local'])[0].args.slice(-2), [
    'tests/ifpmic_api/test_execution_protocol.py', 'tests/ifpmic_api/test_execution_workspace.py',
  ]);
  for (const selected of [[], ['delivery-tool', 'delivery-tool'], ['full490'], ['__proto__'], ['echo secret']]) {
    assert.throws(() => feedbackCommands(flow, live, selected));
  }
  const altered = structuredClone(mock);
  altered.feedback_profiles = ['tests/ifpmic_api/test_h2_dispatcher_crashes.py'];
  assert.throws(() => feedbackCommands(flow, altered));
});

test('unknown options and levels cannot become commands', () => {
  for (const args of [['--level', 'full'], ['--flow'], ['--shell', 'true'], ['--level', '--run'], ['--level', 'integration', '--slice', 'admission-mock']]) {
    assert.throws(() => parseArgs(args));
  }
  assert.deepEqual(parseArgs(['--slice', 'admission-live', '--profile', 'admission-local']),
    { level: 'feedback', run: false, slice: 'admission-live', profiles: ['admission-local'] });
  assert.throws(() => parseArgs(['--level', 'integration', '--profile', 'delivery-tool']));
  assert.deepEqual(parseArgs([]), { level: 'feedback', run: false });
});

test('default CLI prints a plan without running test processes', () => {
  const result = spawnSync(process.execPath, [cli.pathname], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /개발 검사 통과는.*수용을 뜻하지 않습니다/);
  assert.doesNotMatch(result.stdout, /검사 기록:/);
  assert.match(result.stdout, /접수 상태 mock 조회·표시/);
  assert.doesNotMatch(result.stdout, /admission-local:/);
});

test('explicit profile selection prints only that profile without starting it', () => {
  const result = spawnSync(process.execPath,
    [cli.pathname, '--slice', 'admission-live', '--profile', 'admission-local'],
    { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /admission-local:/);
  assert.doesNotMatch(result.stdout, /delivery-tool:|검사 기록:/);
  const invalid = spawnSync(process.execPath,
    [cli.pathname, '--slice', 'admission-mock', '--profile', 'admission-local', '--run'],
    { encoding: 'utf8', timeout: 5000 });
  assert.equal(invalid.status, 2);
  assert.doesNotMatch(invalid.stdout, /검사 기록:/);
});

test('unwired integration and acceptance cannot report execution success', () => {
  for (const level of ['integration', 'acceptance']) {
    const result = spawnSync(process.execPath, [cli.pathname, '--level', level, '--run'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /자동 실행은 연결되지 않았습니다/);
    assert.doesNotMatch(result.stdout, /검사 기록:/);
  }
});

test('development feedback does not relax final product acceptance', () => {
  assert.equal(plan.policy.feedback_is_acceptance, false);
  assert.equal(plan.policy.implementation_requires_full490, false);
  assert.equal(plan.policy.final_acceptance_requires_original_gates, true);
  assert.ok(selectFlow(plan).final_acceptance.some(item => item.includes('490')));
});
