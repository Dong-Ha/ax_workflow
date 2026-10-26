import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  createMockTaskController, mockTaskFixture, validateMockTask,
} from '../experiments/ifpmic-live/web/mock-task.js';

const JOB = '00000000-0000-4000-8000-000000000010';
const OTHER_JOB = '00000000-0000-4000-8000-000000000011';
const COMMAND = '00000000-0000-4000-8000-000000000012';
const RUN = '00000000-0000-4000-8000-000000000013';
const clone = value => structuredClone(value);

test('published schema agrees with pending/completed fixtures and rejects extra result data', () => {
  const schema = JSON.parse(readFileSync(new URL('../docs/ifpmic/api-extensions/mock-task.v1.json', import.meta.url)));
  // Calendar validity is checked by validateMockTask, not the JSON schema format annotation.
  const validate = new Ajv2020({ validateFormats: false }).compile(schema);
  for (const status of ['pending', 'completed']) assert.equal(validate(mockTaskFixture(JOB, status)), true);
  const value = mockTaskFixture(JOB, 'completed');
  value.result.raw_output = 'private';
  assert.equal(validate(value), false);
});

test('fixtures satisfy the exact pending and completed contracts', () => {
  const pending = mockTaskFixture(JOB, 'pending');
  const completed = mockTaskFixture(JOB, 'completed');
  assert.deepEqual(Object.keys(pending), ['schema_version', 'job_id', 'command_id', 'admitted_run_id', 'status', 'result', 'completed_at']);
  assert.equal(validateMockTask(pending, { jobId: JOB }), pending);
  assert.equal(pending.admitted_run_id, null);
  assert.equal(pending.result, null);
  assert.equal(pending.completed_at, null);
  assert.equal(validateMockTask(completed, { jobId: JOB }).status, 'completed');
  assert.deepEqual(completed.result.checks.map(check => check.name), ['request_saved', 'workspace_ready', 'engine_admitted']);
});

test('validator rejects extra keys, identity mismatch, malformed dates, run IDs, checks, and results', () => {
  const valid = mockTaskFixture(JOB, 'completed');
  const invalids = [];
  invalids.push({ ...valid, private_data: 'secret' });
  invalids.push({ ...valid, job_id: OTHER_JOB });
  invalids.push({ ...valid, command_id: 'not-a-uuid' });
  invalids.push({ ...valid, completed_at: '2026-02-30T00:00:00Z' });
  invalids.push({ ...valid, result: { ...valid.result, checks: valid.result.checks.slice(1) } });
  invalids.push({ ...valid, result: { ...valid.result, result_sha256: 'z'.repeat(64) } });
  for (const candidate of invalids) assert.throws(() => validateMockTask(candidate, { jobId: JOB }), /Invalid mock task/);
  assert.throws(() => validateMockTask(valid, { jobId: JOB, commandId: COMMAND }), /Invalid mock task/);
  assert.throws(() => validateMockTask(valid, { jobId: JOB, runId: RUN }), /Invalid mock task/);
  assert.throws(() => validateMockTask({ ...valid, admitted_run_id: '00000000-0000-4000-8000-000000000014' }, { jobId: JOB, runId: RUN }), /Invalid mock task/);
});

function harness(read) {
  const requests = [];
  const views = [];
  const controller = createMockTaskController({
    read(args) { return read ? read(args, requests) : new Promise((resolve, reject) => requests.push({ ...args, resolve, reject })); },
    onChange(view) { views.push(view); },
  });
  return { controller, requests, views, last: () => views.at(-1) };
}

test('controller moves pending to completed and retains confirmation across refresh errors', async () => {
  const h = harness();
  const first = h.controller.select({ userId: 'A', jobId: JOB });
  h.requests[0].resolve(mockTaskFixture(JOB, 'pending'));
  await first;
  assert.deepEqual(h.last(), { phase: 'pending', jobId: JOB, value: mockTaskFixture(JOB, 'pending'), lastConfirmed: mockTaskFixture(JOB, 'pending') });
  const second = h.controller.refresh('completed');
  h.requests[1].resolve(mockTaskFixture(JOB, 'completed'));
  await second;
  const confirmed = h.last().value;
  const failed = h.controller.refresh('error');
  h.requests[2].reject(new Error('secret provider token'));
  await failed;
  assert.equal(h.last().phase, 'error');
  assert.equal(h.last().lastConfirmed, confirmed);
  assert.doesNotMatch(JSON.stringify(h.views), /secret provider token/);
});

test('new account selection clears confirmation; refresh cancels old result and clear ignores stale completion', async () => {
  const h = harness();
  const first = h.controller.select({ userId: 'A', jobId: JOB });
  h.requests[0].resolve(mockTaskFixture(JOB, 'completed'));
  await first;
  const stale = h.controller.refresh('completed');
  const current = h.controller.select({ userId: 'B', jobId: JOB, scenario: 'pending' });
  assert.equal(h.requests[1].signal.aborted, true);
  assert.equal(h.last().lastConfirmed, null);
  h.requests[2].resolve(mockTaskFixture(JOB, 'pending'));
  await current;
  h.requests[1].resolve(mockTaskFixture(JOB, 'completed'));
  await stale;
  assert.equal(h.last().phase, 'pending');
  assert.equal(h.last().value.status, 'pending');
  const late = h.controller.refresh('completed');
  h.controller.clear();
  assert.equal(h.last().phase, 'empty');
  h.requests[3].resolve(mockTaskFixture(JOB, 'completed'));
  await late;
  assert.deepEqual(h.last(), { phase: 'empty', jobId: null, value: null, lastConfirmed: null });
});

test('selection rejects late response or rejection from another job and error text remains private', async () => {
  const h = harness();
  const old = h.controller.select({ userId: 'A', jobId: JOB });
  const next = h.controller.select({ userId: 'A', jobId: OTHER_JOB });
  h.requests[1].resolve(mockTaskFixture(OTHER_JOB, 'pending'));
  await next;
  h.requests[0].reject(new Error('private provider failure'));
  await old;
  assert.equal(h.last().jobId, OTHER_JOB);
  assert.equal(h.last().phase, 'pending');
  assert.doesNotMatch(JSON.stringify(h.views), /private provider failure/);
});
