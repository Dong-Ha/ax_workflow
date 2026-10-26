import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { feedbackCommands, parseArgs, planPath, selectFlow } from '../scripts/ifpmic-delivery.mjs';

const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const cli = new URL('../scripts/ifpmic-delivery.mjs', import.meta.url);

test('only one active flow; later work cannot silently replace current delivery', () => {
  assert.deepEqual(plan.flows.filter(flow => flow.status === 'in_progress').map(flow => flow.id), [plan.current_flow]);
  assert.equal(selectFlow(plan).id, 'admission');
  assert.throws(() => selectFlow(plan, 'nonexistent'));
});

test('feedback runs only explicit local tests, never the full runtime gate', () => {
  const commands = feedbackCommands(selectFlow(plan));
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[1].args.slice(-2), [
    'tests/ifpmic_api/test_execution_protocol.py', 'tests/ifpmic_api/test_execution_workspace.py',
  ]);
  const altered = structuredClone(selectFlow(plan));
  altered.feedback.python_tests.push('tests/ifpmic_api/test_h2_dispatcher_crashes.py');
  assert.throws(() => feedbackCommands(altered));
  assert.throws(() => feedbackCommands(selectFlow(plan, 'minimal-mock')));
});

test('unknown options and levels cannot become commands', () => {
  for (const args of [['--level', 'full'], ['--flow'], ['--shell', 'true'], ['--level', '--run']]) {
    assert.throws(() => parseArgs(args));
  }
  assert.deepEqual(parseArgs([]), { level: 'feedback', run: false });
});

test('default CLI prints a plan without running test processes', () => {
  const result = spawnSync(process.execPath, [cli.pathname], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /개발 검사 통과는.*수용을 뜻하지 않습니다/);
  assert.doesNotMatch(result.stdout, /검사 기록:/);
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
