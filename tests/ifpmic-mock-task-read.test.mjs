import assert from 'node:assert/strict';
import test from 'node:test';
import { createStoredMockTaskController } from '../experiments/ifpmic-live/web/mock-task-read.js';
import { mockTaskFixture } from '../experiments/ifpmic-live/web/mock-task.js';

const job = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
function harness(read) {
  let clock = 0;
  let nextId = 0;
  const timers = new Map();
  const changes = [];
  const denied = [];
  const controller = createStoredMockTaskController({ read,
    onChange: value => changes.push(value), onDenied: status => denied.push(status), now: () => clock,
    schedule: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    cancel: id => timers.delete(id) });
  return { controller, changes, denied, timers, advance: ms => { clock += ms; }, async tick() {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id); clock += timer.delay; return timer.callback();
  } };
}

test('pending is polled and a completed stored result stops automatic reads', async () => {
  let count = 0;
  const h = harness(async id => mockTaskFixture(id, ++count === 1 ? 'pending' : 'completed'));
  await h.controller.select(job);
  assert.equal(h.changes.at(-1).value.status, 'pending');
  assert.equal([...h.timers.values()][0].delay, 1000);
  await h.tick();
  assert.equal(h.changes.at(-1).value.status, 'completed');
  assert.equal(h.timers.size, 0);
  assert.equal(count, 2);
});

test('503 preserves last stored result; manual refresh recovers without exposing exception text', async () => {
  let fail = false;
  const h = harness(async id => {
    if (fail) throw Object.assign(new Error('private DSN and raw output'), { status: 503 });
    return mockTaskFixture(id, 'completed');
  });
  await h.controller.select(job);
  fail = true;
  await h.controller.refresh();
  assert.equal(h.changes.at(-1).phase, 'error');
  assert.equal(h.changes.at(-1).value.status, 'completed');
  assert.equal(h.timers.size, 0);
  assert.doesNotMatch(JSON.stringify(h.changes), /private DSN|raw output/);
  fail = false;
  await h.controller.refresh();
  assert.equal(h.changes.at(-1).phase, 'ready');
});

test('a changed selection or cleared account cannot receive a late result', async () => {
  let resolveOld;
  let oldSignal;
  const h = harness((id, signal) => id === job
    ? new Promise(resolve => { resolveOld = resolve; oldSignal = signal; })
    : Promise.resolve(mockTaskFixture(id, 'pending')));
  const old = h.controller.select(job);
  await h.controller.select(other);
  assert.equal(oldSignal.aborted, true);
  h.controller.clear();
  resolveOld(mockTaskFixture(job, 'completed'));
  await old;
  assert.deepEqual(h.changes.at(-1), { phase: 'empty', value: null });
  assert.equal(h.timers.size, 0);
});

test('401 and 403 clear confirmed data, stop polling, and notify the account boundary', async () => {
  for (const status of [401, 403]) {
    let fail = false;
    const h = harness(async id => {
      if (fail) throw Object.assign(new Error('denied'), { status });
      return mockTaskFixture(id, 'completed');
    });
    await h.controller.select(job);
    fail = true;
    await h.controller.refresh();
    assert.deepEqual(h.changes.at(-1), { phase: 'error', value: null });
    assert.deepEqual(h.denied, [status]);
    assert.equal(h.timers.size, 0);
  }
});

test('a hanging read is cancelled at the bounded deadline', async () => {
  let signal;
  const h = harness((_id, value) => { signal = value; return new Promise(() => {}); });
  void h.controller.select(job);
  await h.tick();
  assert.equal(signal.aborted, true);
  assert.deepEqual(h.changes.at(-1), { phase: 'timedout', value: null });
  assert.equal(h.timers.size, 0);
});

test('wrong-job and private-field responses fail closed and never become confirmed results', async () => {
  for (const dto of [mockTaskFixture(other, 'completed'), { ...mockTaskFixture(job, 'completed'), raw: 'secret' }]) {
    const h = harness(async () => dto);
    await h.controller.select(job);
    assert.deepEqual(h.changes.at(-1), { phase: 'error', value: null });
    assert.equal(h.timers.size, 0);
    assert.doesNotMatch(JSON.stringify(h.changes), /secret/);
  }
});
