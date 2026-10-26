const scenarios = new Set(['pending', 'completed', 'error']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const dtoKeys = ['schema_version', 'job_id', 'command_id', 'admitted_run_id', 'status', 'result', 'completed_at'];
const resultKeys = ['task_kind', 'mode', 'outcome', 'checks', 'result_sha256'];
const checkNames = ['request_saved', 'workspace_ready', 'engine_admitted'];
const SYNTHETIC_COMMAND_ID = '00000000-0000-4000-8000-000000000001';
const SYNTHETIC_RUN_ID = '00000000-0000-4000-8000-000000000002';
const SYNTHETIC_RESULT_SHA256 = 'a'.repeat(64);
const FIXTURE_COMPLETED_AT = '2026-01-01T00:00:00.000Z';

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function validUtc(value) {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis)
    && value.slice(0, 19) === new Date(millis).toISOString().slice(0, 19);
}

function invalid() { throw new Error('Invalid mock task'); }

export function validateMockTask(value, { jobId, commandId, runId } = {}) {
  if (!exactKeys(value, dtoKeys)
    || value.schema_version !== 'ifpmic.mock-task.v1'
    || typeof value.job_id !== 'string' || !UUID.test(value.job_id)
    || typeof value.command_id !== 'string' || !UUID.test(value.command_id)
    || !(value.admitted_run_id === null || (typeof value.admitted_run_id === 'string' && UUID.test(value.admitted_run_id)))
    || !['pending', 'completed'].includes(value.status)) invalid();
  if ((jobId !== undefined && value.job_id !== jobId)
    || (commandId !== undefined && value.command_id !== commandId)
    || (runId !== undefined && value.admitted_run_id !== runId)) invalid();

  if (value.status === 'pending') {
    if (value.admitted_run_id !== null || value.result !== null || value.completed_at !== null) invalid();
    return value;
  }
  if (value.admitted_run_id === null || !exactKeys(value.result, resultKeys)
    || value.result.task_kind !== 'request-preflight-v1'
    || value.result.mode !== 'mock'
    || value.result.outcome !== 'passed'
    || !Array.isArray(value.result.checks) || value.result.checks.length !== checkNames.length
    || !value.result.checks.every((check, index) => exactKeys(check, ['name', 'status'])
      && check.name === checkNames[index] && check.status === 'passed')
    || typeof value.result.result_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.result.result_sha256)
    || !validUtc(value.completed_at)) invalid();
  return value;
}

export function mockTaskFixture(jobId, status) {
  if (typeof jobId !== 'string' || !UUID.test(jobId) || !['pending', 'completed'].includes(status)) invalid();
  const value = {
    schema_version: 'ifpmic.mock-task.v1',
    job_id: jobId,
    command_id: SYNTHETIC_COMMAND_ID,
    admitted_run_id: status === 'completed' ? SYNTHETIC_RUN_ID : null,
    status,
    result: status === 'completed' ? {
      task_kind: 'request-preflight-v1', mode: 'mock', outcome: 'passed',
      checks: checkNames.map(name => ({ name, status: 'passed' })),
      result_sha256: SYNTHETIC_RESULT_SHA256,
    } : null,
    completed_at: status === 'completed' ? FIXTURE_COMPLETED_AT : null,
  };
  return validateMockTask(value, { jobId });
}

export async function readMockTask({ jobId, scenario, signal }) {
  if (!scenarios.has(scenario)) throw new Error('Unknown mock scenario');
  await new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 180);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
  if (scenario === 'error') throw new Error('Simulated lookup failure');
  return mockTaskFixture(jobId, scenario);
}

export function createMockTaskController({ read = readMockTask, onChange }) {
  let selection = null;
  let generation = 0;
  let active = null;
  let lastConfirmed = null;

  const emit = (phase, jobId = null, value = null) => onChange({ phase, jobId, value, lastConfirmed });

  function clear() {
    generation += 1;
    active?.abort();
    active = null;
    selection = null;
    lastConfirmed = null;
    emit('empty');
  }

  async function refresh(scenario = 'pending') {
    if (!selection || !scenarios.has(scenario)) return;
    const current = ++generation;
    active?.abort();
    const controller = new AbortController();
    active = controller;
    const { jobId, commandId, runId } = selection;
    emit('loading', jobId);
    try {
      const value = validateMockTask(await read({ jobId, scenario, signal: controller.signal }), { jobId, commandId, runId });
      if (current !== generation) return;
      lastConfirmed = value;
      emit(value.status, jobId, value);
    } catch {
      if (current !== generation) return;
      emit('error', jobId);
    } finally {
      if (current === generation) active = null;
    }
  }

  function select({ userId, jobId, commandId, runId, scenario = 'pending' }) {
    clear();
    if (!userId || !jobId) return;
    selection = { userId, jobId, ...(commandId === undefined ? {} : { commandId }), ...(runId === undefined ? {} : { runId }) };
    return refresh(scenarios.has(scenario) ? scenario : 'pending');
  }

  return { select, refresh, clear };
}
