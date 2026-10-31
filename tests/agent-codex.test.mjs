import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invokeCodex, codexArguments } from '../runtime/agents/codex.mjs';

const schema = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } };

async function fixture(t, source) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ax-codex-fake-'));
  const workspace = path.join(dir, 'workspace');
  await mkdir(workspace);
  const executable = path.join(dir, 'fake-codex');
  await writeFile(executable, `#!/usr/bin/env node\n${source}\n`);
  await chmod(executable, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, workspace, executable };
}

const successSource = `
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.writeFileSync('argv.json', JSON.stringify(args));
const out = args[args.indexOf('--output-last-message') + 1];
fs.writeFileSync(out, JSON.stringify({answer:'fake result'}));
process.stdin.resume(); process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({type:'turn.completed'}) + '\\n');
});`;

test('uses fixed read-only arguments without shell and parses output file', async (t) => {
  const { workspace, executable } = await fixture(t, successSource);
  const result = await invokeCodex({ prompt: 'safe prompt', schema, workspace, executable, model: 'gpt-6-luna' });
  assert.deepEqual(result, { answer: 'fake result' });
  const args = JSON.parse(await readFile(path.join(workspace, 'argv.json'), 'utf8'));
  assert.equal(args[0], 'exec');
  assert.ok(args.includes('--sandbox') && args.includes('read-only'));
  assert.ok(args.includes('--ignore-user-config') && args.includes('--ephemeral'));
  assert.equal(args.includes('safe prompt'), false);
  assert.equal(args.includes('--output-last-message'), true);
});

test('nonzero exit and missing terminal event reject', async (t) => {
  const failed = await fixture(t, `process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n'); process.exitCode=7; });`);
  await assert.rejects(invokeCodex({ prompt: 'p', schema, workspace: failed.workspace, executable: failed.executable }), { message: 'AGENT_EXECUTION_FAILED' });
  const incomplete = await fixture(t, `process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({type:'turn.started'})+'\\n'); });`);
  await assert.rejects(invokeCodex({ prompt: 'p', schema, workspace: incomplete.workspace, executable: incomplete.executable }), { message: 'AGENT_EXECUTION_FAILED' });
});

test('tool events, malformed JSONL, and invalid answer are rejected', async (t) => {
  const denied = await fixture(t, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({type:'item.started',item:{type:'function_call'}})+'\\n'+JSON.stringify({type:'turn.completed'})+'\\n'));`);
  await assert.rejects(invokeCodex({ prompt: 'p', schema, workspace: denied.workspace, executable: denied.executable }), { message: 'AGENT_TOOL_DENIED' });
  const malformed = await fixture(t, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('not-json\\n'));`);
  await assert.rejects(invokeCodex({ prompt: 'p', schema, workspace: malformed.workspace, executable: malformed.executable }), { message: 'AGENT_OUTPUT_INVALID' });
  const invalidAnswer = await fixture(t, `import fs from 'node:fs'; const a=process.argv.slice(2); fs.writeFileSync(a[a.indexOf('--output-last-message')+1], '{'); process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n'));`);
  await assert.rejects(invokeCodex({ prompt: 'p', schema, workspace: invalidAnswer.workspace, executable: invalidAnswer.executable }), { message: 'AGENT_OUTPUT_INVALID' });
});

test('timeout and aborted signal reject without accepting completion', async (t) => {
  const slow = await fixture(t, `setTimeout(() => {}, 5000);`);
  await assert.rejects(invokeCodex({ prompt: 'p', schema, workspace: slow.workspace, executable: slow.executable, timeoutMs: 100 }), { message: 'AGENT_TIMEOUT' });
  const aborted = await fixture(t, `setTimeout(() => {}, 5000);`);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(invokeCodex({ prompt: 'p', schema, workspace: aborted.workspace, executable: aborted.executable, signal: controller.signal }), { message: 'AGENT_INTERRUPTED' });
});

test('unsafe model config is rejected', () => {
  assert.throws(() => codexArguments({ workspace: '/tmp', model: 'bad model', schemaPath: '/tmp/s', outputPath: '/tmp/o' }), { message: 'AGENT_RUNTIME_INVALID' });
});

test('malformed event objects, incomplete latest turn and trailing data cannot complete', async (t) => {
  for (const events of [
    'null\n', '[]\n', '"scalar"\n',
    '{"type":"turn.completed"}\n{"type":"turn.started"}\n',
    '{"type":"turn.completed"}\ntrailing',
  ]) {
    const fake = await fixture(t, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(events)}));`);
    await assert.rejects(invokeCodex({ prompt: 'p', schema, workspace: fake.workspace, executable: fake.executable }),
      error => ['AGENT_OUTPUT_INVALID', 'AGENT_EXECUTION_FAILED'].includes(error.message));
  }
});
