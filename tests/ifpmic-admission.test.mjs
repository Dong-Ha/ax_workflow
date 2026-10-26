import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdmissionController } from '../experiments/ifpmic-live/web/admission.js';

function harness() {
  const requests = [];
  const views = [];
  const controller = createAdmissionController({
    read(value) {
      return new Promise((resolve, reject) => requests.push({ ...value, resolve, reject }));
    },
    onChange(value) { views.push(value); },
  });
  return { controller, requests, views, last: () => views.at(-1) };
}
const result = (job_id, status = 'admitted') => ({ mode: 'mock', job_id, status });

test('late response from another job cannot overwrite the selected job', async () => {
  const h = harness();
  const old = h.controller.select({ userId: 'A', jobId: 'first' });
  const current = h.controller.select({ userId: 'A', jobId: 'second' });
  assert.equal(h.requests[0].signal.aborted, true);
  h.requests[1].resolve(result('second', 'pending'));
  await current;
  h.requests[0].resolve(result('first'));
  await old;
  assert.equal(h.last().jobId, 'second');
  assert.equal(h.last().phase, 'pending');
});

test('account reset rejects late responses even when another user selects the same job ID', async () => {
  const h = harness();
  const old = h.controller.select({ userId: 'A', jobId: 'shared' });
  h.controller.clear();
  assert.equal(h.last().phase, 'empty');
  const current = h.controller.select({ userId: 'B', jobId: 'shared' });
  h.requests[1].resolve(result('shared', 'pending'));
  await current;
  h.requests[0].resolve(result('shared'));
  await old;
  assert.equal(h.last().phase, 'pending');
});

test('refresh replaces an outstanding lookup; provider errors never leak raw details', async () => {
  const h = harness();
  const old = h.controller.select({ userId: 'A', jobId: 'job' });
  const current = h.controller.refresh('admitted');
  h.requests[1].resolve(result('job'));
  await current;
  h.requests[0].reject(new Error('private exception'));
  await old;
  assert.equal(h.last().phase, 'admitted');
  const failure = h.controller.refresh('error');
  h.requests[2].reject(new Error('secret credential exception'));
  await failure;
  assert.deepEqual(h.last(), { phase: 'error', jobId: 'job', lastConfirmed: 'admitted' });
  assert.doesNotMatch(JSON.stringify(h.views), /private exception|secret credential/);
});

test('a wrong-job or real-mode result cannot become a simulated admission', async () => {
  for (const value of [result('other'), { ...result('job'), mode: 'real' }, result('job', 'QUEUED')]) {
    const h = harness();
    const selected = h.controller.select({ userId: 'A', jobId: 'job' });
    h.requests[0].resolve(value);
    await selected;
    assert.equal(h.last().phase, 'error');
    assert.equal(h.last().lastConfirmed, null);
  }
});

test('selection restores only a valid scenario and clearing removes last confirmed state', async () => {
  const h = harness();
  const selected = h.controller.select({ userId: 'A', jobId: 'job', scenario: 'admitted' });
  assert.equal(h.requests[0].scenario, 'admitted');
  h.requests[0].resolve(result('job'));
  await selected;
  h.controller.clear();
  await h.controller.refresh();
  assert.equal(h.requests.length, 1);
  const again = h.controller.select({ userId: 'A', jobId: 'job', scenario: 'unexpected' });
  assert.equal(h.requests[1].scenario, 'pending');
  assert.equal(h.last().lastConfirmed, null);
  h.requests[1].resolve(result('job', 'pending'));
  await again;
});
