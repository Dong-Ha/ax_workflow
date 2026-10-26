import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStoredAdmissionController, parseAdmission } from '../experiments/ifpmic-live/web/admission-read.js';

const jobId = '10000000-0000-4000-8000-000000000001';
const commandId = '10000000-0000-4000-8000-000000000002';
const runId = '10000000-0000-4000-8000-000000000003';

function dto(phase = 'pending', overrides = {}) {
  const applied = phase === 'applied';
  const rejected = phase === 'rejected';
  return {
    schema_version: 'ifpmic.admission-status.v1', job_id: jobId, command_id: commandId,
    admission_status: phase, job_status: applied ? 'QUEUED' : 'DRAFT', job_revision: applied ? 1 : 0,
    command_status: applied || rejected ? phase : 'accepted', applied_revision: applied ? 1 : null,
    admitted_run_id: ['admitted_pending_projection', 'applied', 'rejected'].includes(phase) ? runId : null,
    receipt: applied ? { transition_sequence: 1, outcome: 'applied', expected_revision: 0,
      applied_revision: 1, projected_job_status: 'QUEUED', projected_revision: 1 }
      : rejected ? { transition_sequence: 1, outcome: 'rejected', expected_revision: 0,
        applied_revision: null, projected_job_status: 'DRAFT', projected_revision: 0 } : null,
    error_code: rejected ? 'PROFILE_INELIGIBLE' : phase === 'quarantined' ? 'BINDING_CONFLICT' : null,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(read, { start = 0 } = {}) {
  let clock = start;
  let nextTimer = 0;
  const timers = new Map();
  const changes = [];
  const denied = [];
  const controller = createStoredAdmissionController({
    read,
    onChange: view => changes.push(view),
    onDenied: status => denied.push(status),
    now: () => clock,
    schedule: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    cancel: id => timers.delete(id),
  });
  return { controller, changes, denied, timers, advance: ms => { clock += ms; }, tick(id) {
    const timer = timers.get(id); assert.ok(timer, `timer ${id} exists`); timers.delete(id); return timer.callback();
  } };
}

test('parseAdmission accepts each V3 state and permits later current job status after applied', () => {
  for (const phase of ['pending', 'admitted_pending_projection', 'applied', 'rejected', 'quarantined']) {
    assert.equal(parseAdmission(dto(phase), jobId).admission_status, phase);
  }
  const later = dto('applied', { job_status: 'RUNNING', job_revision: 2 });
  assert.equal(parseAdmission(later, jobId).job_status, 'RUNNING');
});

test('parser rejects wrong job, extra fields, and invalid receipt tuples', () => {
  assert.throws(() => parseAdmission(dto(), '20000000-0000-4000-8000-000000000001'));
  assert.throws(() => parseAdmission({ ...dto(), private: 'unexpected' }, jobId));
  assert.throws(() => parseAdmission(dto('applied', { receipt: { ...dto('applied').receipt, transition_sequence: 2 } }), jobId));
});

test('selection change and clear abort and discard a stale response', async () => {
  const pending = deferred();
  const signals = [];
  const h = harness((id, signal) => { signals.push(signal); return id === jobId ? pending.promise : Promise.resolve(dto()); });
  const first = h.controller.select(jobId);
  const otherJob = '20000000-0000-4000-8000-000000000001';
  await h.controller.select(otherJob);
  assert.equal(signals[0].aborted, true);
  const count = h.changes.length;
  pending.resolve(dto('applied'));
  await first;
  assert.equal(h.changes.length, count, 'stale response does not update selected job');
  h.controller.clear();
  assert.equal(h.changes.at(-1).phase, 'empty');
  assert.equal(h.timers.size, 0);
});

test('pending polling uses 1, 2, 4, then 5 second intervals and stops at 60 seconds', async () => {
  const h = harness(async () => dto(), { start: 100 });
  await h.controller.select(jobId);
  const intervals = [];
  for (let index = 0; index < 4; index += 1) {
    const poll = [...h.timers.entries()].find(([, timer]) => timer.delay < 60_000);
    assert.ok(poll);
    intervals.push(poll[1].delay);
    await h.tick(poll[0]);
  }
  assert.deepEqual(intervals, [1000, 2000, 4000, 5000]);
  h.advance(60_000);
  const nextPoll = [...h.timers.entries()].find(([, timer]) => timer.delay < 60_000);
  assert.ok(nextPoll);
  await h.tick(nextPoll[0]);
  assert.equal(h.changes.at(-1).phase, 'timedout');
  assert.equal([...h.timers.values()].some(timer => timer.delay < 60_000), false);
});

test('terminal states stop polling', async () => {
  for (const phase of ['applied', 'rejected', 'quarantined']) {
    const h = harness(async () => dto(phase));
    await h.controller.select(jobId);
    assert.equal(h.timers.size, 0, phase);
    assert.equal(h.changes.at(-1).value.admission_status, phase);
  }
});

test('503 retains the last confirmed value and stops polling; 401/403 clear it and notify', async () => {
  let fail = false;
  const h = harness(async () => { if (fail) throw Object.assign(new Error('unavailable'), { status: 503 }); return dto('applied'); });
  await h.controller.select(jobId);
  fail = true;
  await h.controller.refresh();
  assert.equal(h.changes.at(-1).phase, 'error');
  assert.equal(h.changes.at(-1).value.admission_status, 'applied');
  assert.equal(h.timers.size, 0);

  for (const status of [401, 403]) {
    let denied;
    const gated = harness(async () => { if (denied) throw Object.assign(new Error('denied'), { status: denied }); return dto('applied'); });
    await gated.controller.select(jobId);
    denied = status;
    await gated.controller.refresh();
    assert.equal(gated.changes.at(-1).phase, 'error');
    assert.equal(gated.changes.at(-1).value, null);
    assert.deepEqual(gated.denied, [status]);
    assert.equal(gated.timers.size, 0);
  }
});
