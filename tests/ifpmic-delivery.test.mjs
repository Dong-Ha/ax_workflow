import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { feedbackCommands, parseArgs, planPath, selectFlow, selectSlice } from '../scripts/ifpmic-delivery.mjs';

const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const cli = new URL('../scripts/ifpmic-delivery.mjs', import.meta.url);

test('at most one active flow; latest completed delivery stays selected until next work starts', () => {
  const active = plan.flows.filter(flow => flow.status === 'in_progress');
  assert.ok(active.length <= 1);
  assert.ok(plan.flows.some(flow => flow.id === plan.current_flow));
  if (active.length) assert.equal(active[0].id, plan.current_flow);
  else assert.equal(selectFlow(plan).status, 'delivered');
  assert.throws(() => selectFlow(plan, 'nonexistent'));
});

test('every flow has a selectable default slice and scoped default profiles', () => {
  for (const flow of plan.flows) {
    const sliceId = flow.id === plan.current_flow ? plan.current_slice : flow.default_slice;
    assert.ok(sliceId, `${flow.id} must declare a default slice`);
    const slice = selectSlice(flow, sliceId);
    const defaults = feedbackCommands(flow, slice).map(command => command.name);
    assert.deepEqual(defaults, slice.feedback_profiles);
    const allowed = slice.allowed_feedback_profiles ?? slice.feedback_profiles;
    assert.deepEqual(feedbackCommands(flow, slice, allowed).map(command => command.name), allowed);
    assert.ok(slice.checks_to_add.every(item => typeof item === 'string' && item.length > 0));
  }
  for (const flow of plan.flows) {
    for (const slice of flow.slices ?? []) {
      if (slice.status === 'not_started') assert.ok(slice.checks_to_add.length > 0, 'pending feature checks remain explicit');
    }
  }
});

test('slice selection isolates mock development from runtime diagnostics', () => {
  const flow = selectFlow(plan, 'admission');
  const slice = selectSlice(flow, 'admission-mock');
  assert.ok(selectSlice(flow, 'admission-live'));
  assert.deepEqual(slice.blockers, []);
  assert.deepEqual(flow.diagnostic.blocks_slices, []);
  assert.ok(flow.diagnostic.blocks_acceptance.some(item => item.includes('crash/reclaim')));
  assert.throws(() => selectSlice(flow, 'missing'));
  assert.throws(() => selectSlice(selectFlow(plan, 'minimal-mock'), slice.id));
});

test('profiles run only allowed local checks and reject injected or stale names', () => {
  const flow = selectFlow(plan, 'admission');
  const mock = selectSlice(flow, 'admission-mock');
  assert.deepEqual(feedbackCommands(flow, mock).map(item => item.name), ['admission-state']);
  assert.ok(mock.allowed_feedback_profiles.includes('delivery-tool'));
  assert.throws(() => feedbackCommands(flow, mock, ['admission-local']));
  const live = selectSlice(flow, 'admission-live');
  assert.equal(feedbackCommands(flow, live).length, 2);
  assert.equal(live.allowed_feedback_profiles.length, 4);
  assert.deepEqual(feedbackCommands(flow, live, ['admission-local'])[0].args.slice(-2), [
    'tests/ifpmic_api/test_execution_protocol.py', 'tests/ifpmic_api/test_execution_workspace.py',
  ]);
  for (const selected of [[], ['delivery-tool', 'delivery-tool'], ['full490'], ['__proto__'], ['echo secret']]) {
    assert.throws(() => feedbackCommands(flow, live, selected));
  }
  const altered = structuredClone(mock);
  altered.feedback_profiles = ['tests/ifpmic_api/test_h2_dispatcher_crashes.py'];
  assert.throws(() => feedbackCommands(flow, altered));
  const newFlow = { id: 'minimal-mock' };
  const mockSlice = { feedback_profiles: ['delivery-tool'], allowed_feedback_profiles: ['delivery-tool', 'admission-dto'] };
  assert.deepEqual(feedbackCommands(newFlow, mockSlice).map(item => item.name), ['delivery-tool']);
  assert.deepEqual(feedbackCommands(newFlow, mockSlice, ['admission-dto']).map(item => item.name), ['admission-dto']);
  const legacySlice = { feedback_profiles: ['delivery-tool'] };
  assert.deepEqual(feedbackCommands(newFlow, legacySlice).map(item => item.name), ['delivery-tool']);
  assert.throws(() => feedbackCommands(newFlow, legacySlice, ['admission-dto']));
  assert.throws(() => feedbackCommands(newFlow, { ...mockSlice, feedback_profiles: ['execution-owner'] }));
  assert.throws(() => feedbackCommands(newFlow, { ...mockSlice, feedback_profiles: ['delivery-tool'], allowed_feedback_profiles: ['admission-dto'] }));
});

test('unknown options and levels cannot become commands', () => {
  for (const args of [['--level', 'full'], ['--flow'], ['--shell', 'true'], ['--level', '--run'], ['--level', 'integration', '--slice', 'admission-mock'], ['--slice', 'admission-mock', '--slice', 'admission-live'], ['--flow', 'admission', '--flow', 'minimal-mock']]) {
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
  assert.ok(result.stdout.includes(selectSlice(selectFlow(plan), plan.current_slice).title));

});

test('a non-current flow uses its declared default slice without starting checks', () => {
  const flow = plan.flows.find(item => item.id !== plan.current_flow);
  const slice = selectSlice(flow, flow.default_slice);
  const result = spawnSync(process.execPath, [cli.pathname, '--flow', flow.id], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes(slice.title));
  for (const profile of slice.feedback_profiles) assert.ok(result.stdout.includes(`${profile}:`));
  assert.doesNotMatch(result.stdout, /검사 기록:/);
});

test('explicit profile selection prints only that profile without starting it', () => {
  const result = spawnSync(process.execPath,
    [cli.pathname, '--flow', 'admission', '--slice', 'admission-live', '--profile', 'admission-local'],
    { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /admission-local:/);
  assert.doesNotMatch(result.stdout, /delivery-tool:|검사 기록:/);
  const invalid = spawnSync(process.execPath,
    [cli.pathname, '--flow', 'admission', '--slice', 'admission-mock', '--profile', 'admission-local', '--run'],
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
  assert.ok(selectFlow(plan, 'admission').final_acceptance.some(item => item.includes('490')));
});
