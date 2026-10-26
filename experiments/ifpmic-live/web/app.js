import { createAdmissionPanel } from './admission.js';
import { createStoredAdmissionPanel } from './admission-read.js';

const API = '';
const DEMO_CONTEXT = Object.freeze({
  project_id: 'ifpmic-local-demo',
  profile_version: 'local-demo-v1',
  release_modes: ['team_github_tag'],
  execution_connected: false,
  storage: 'postgresql',
  identity: 'local-demo-oidc',
});

const el = (id) => document.getElementById(id);
const state = {
  userId: null,
  csrf: null,
  context: null,
  pending: null,
  receipt: null,
  items: [],
  cursor: null,
  busy: false,
  selectedJobId: null,
  accountEpoch: 0,
  listEpoch: 0,
  detailEpoch: 0,
  commandEpoch: 0,
};

const storedAdmission = createStoredAdmissionPanel(document, {
  read: async (jobId, signal) => {
    const { data } = await request(`/api/v1/jobs/${encodeURIComponent(jobId)}/admission`, { signal });
    const receipt = findReceiptForJob(jobId);
    if (receipt && data?.command_id !== receipt.command_id) throw new Error('접수 명령이 일치하지 않습니다.');
    return data;
  },
  onConfirmed: value => {
    setDetailText('detail-status', value.job_status);
    setDetailText('detail-revision', String(value.job_revision));
    document.querySelector('[data-testid="detail-status"]').classList.toggle('is-draft', value.job_status === 'DRAFT');
    document.querySelector('.status-explainer').textContent = humanStatus(value.job_status);
  },
  onDenied: status => {
    if (status === 401) resetAccountView();
    else {
      clearDetail();
      el('detail-error').textContent = '이 작업을 확인할 권한이 없습니다.';
      el('detail-error').hidden = false;
    }
  },
});
const admissionPanel = createAdmissionPanel(document, { saveScenario: value => writeUserStorage('admission-demo', value) });

const storageKey = (kind, userId = state.userId) => `ifpmic-live:${encodeURIComponent(userId)}:${kind}`;
const statusMessages = {
  AUTH_REQUIRED: '로그인이 필요합니다. 세션을 확인해 주세요.',
  CSRF_INVALID: '요청 검증이 만료되었습니다. 세션을 새로고침한 뒤 다시 확인해 주세요.',
  ORIGIN_FORBIDDEN: '요청 출처를 확인할 수 없습니다.',
  INVALID_REQUEST: '입력 내용을 확인해 주세요. 요청은 저장되지 않았습니다.',
  REQUEST_TOO_LARGE: '요청 내용이 허용 크기를 넘었습니다. 내용을 줄여 주세요.',
  PROFILE_INELIGIBLE: '현재 데모 프로파일은 요청 접수에 사용할 수 없습니다.',
  PROFILE_VERSION_CONFLICT: '프로파일 버전이 바뀌었습니다. 설정을 확인해 주세요.',
  IDEMPOTENCY_CONFLICT: '접수 키가 다른 요청에 사용되었습니다. 같은 키와 내용을 보존하고 운영자에게 문의하세요.',
  FORBIDDEN: '이 작업을 확인할 권한이 없습니다.',
  DEPENDENCY_UNAVAILABLE: '저장 서비스에 연결할 수 없습니다. 접수 여부를 확인한 뒤 같은 요청을 재시도해 주세요.',
  COMMIT_UNCERTAIN: '저장 결과를 확인할 수 없습니다. 새 요청을 만들지 말고 같은 요청을 재시도해 주세요.',
};

function setStatus(message, kind = '') {
  const box = el('global-status');
  box.textContent = message;
  box.dataset.kind = kind;
}

function setConnection(connected) {
  const label = document.querySelector('[data-testid="connection-state"]');
  label.textContent = connected ? 'API 연결됨' : 'API 상태 확인 필요';
  label.closest('.connection').dataset.connected = String(connected);
}

function apiErrorMessage(data, fallback) {
  const code = data && typeof data.code === 'string' ? data.code : '';
  return statusMessages[code] || fallback;
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.write) {
    if (!state.csrf) throw new Error('세션 검증 정보가 없습니다. 페이지를 새로고침해 주세요.');
    headers.set('X-CSRF-Token', state.csrf);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(() => controller.abort(), 30_000);
  let response;
  let data = null;
  try {
    response = await fetch(`${API}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
    });
    const type = response.headers.get('content-type') || '';
    if (type.includes('application/json')) {
      try { data = await response.json(); } catch { data = null; }
    }
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('요청 제한 시간을 넘겼습니다. 저장 여부는 불명확할 수 있어 같은 요청 키로 다시 확인해야 합니다.');
    if (error instanceof TypeError) throw new Error('API 연결을 확인할 수 없습니다. 저장 여부는 불명확할 수 있습니다.');
    throw error;
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', abort);
  }
  if (!response.ok) {
    const error = new Error(apiErrorMessage(data, `요청 실패 (${response.status})`));
    error.status = response.status;
    error.code = data && data.code;
    throw error;
  }
  return { response, data };
}

function readUserStorage(key) {
  try {
    const raw = sessionStorage.getItem(storageKey(key));
    return raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error('탭의 요청 복구 정보를 읽을 수 없습니다. 새 요청을 전송하지 말고 저장소 접근 상태를 확인해 주세요.');
  }
}

function writeUserStorage(key, value) {
  try {
    const serialized = JSON.stringify(value);
    sessionStorage.setItem(storageKey(key), serialized);
    if (sessionStorage.getItem(storageKey(key)) !== serialized) throw new Error('storage readback mismatch');
    return true;
  } catch {
    setStatus('이 탭에서 요청 복구 정보를 안전하게 저장할 수 없습니다. 저장소 설정을 확인한 뒤 다시 시도하세요.', 'error');
    return false;
  }
}

function removeUserStorage(key) {
  try { sessionStorage.removeItem(storageKey(key)); } catch { /* Storage can be unavailable. */ }
}

function resetAccountView() {
  // Never leave one account's unsent request visible after logout, expiry, or a
  // different account being discovered. Pending retry material stays isolated
  // under that user's sessionStorage key and is restored only after auth.
  el('request-form').reset();
  el('field-base-ref').value = 'refs/heads/main';
  for (const field of ['field-title', 'field-request-text', 'field-base-ref']) {
    el(field).setCustomValidity('');
  }
  if (location.hash.startsWith('#job/')) history.replaceState(null, '', location.pathname);
  state.accountEpoch += 1;
  state.listEpoch += 1;
  state.detailEpoch += 1;
  state.commandEpoch += 1;
  state.userId = null;
  state.csrf = null;
  state.context = null;
  state.pending = null;
  state.receipt = null;
  state.items = [];
  state.cursor = null;
  state.selectedJobId = null;
  el('account-name').textContent = '로그인 필요';
  el('logout-button').hidden = true;
  el('signed-in').hidden = true;
  el('auth-gate').hidden = false;
  clearDetail();
  renderList();
}

function clearDetail() {
  admissionPanel.clear();
  storedAdmission.clear();
  el('job-detail').hidden = true;
  el('empty-detail').hidden = false;
  el('command-receipt').hidden = true;
  el('detail-error').hidden = true;
  el('detail-job-id').textContent = '';
  state.selectedJobId = null;
}

function validateContext(context) {
  return context && context.project_id === DEMO_CONTEXT.project_id &&
    context.profile_version === DEMO_CONTEXT.profile_version &&
    Array.isArray(context.release_modes) && context.release_modes.length === 1 &&
    context.release_modes[0] === 'team_github_tag' && context.execution_connected === false &&
    context.storage === 'postgresql' && context.identity === 'local-demo-oidc';
}

function updatePendingUI() {
  const pending = Boolean(state.pending);
  el('request-form').hidden = pending;
  el('pending-card').hidden = !pending || Boolean(state.pending && state.pending.rejected);
  el('rejected-card').hidden = !pending || !state.pending?.rejected;
  if (pending) {
    el('pending-title').textContent = state.pending.uncertain
      ? '접수 결과를 확인하지 못했습니다'
      : '요청을 보낼 준비가 되었습니다';
    el('pending-message').textContent = state.pending.uncertain
      ? '새 요청을 만들지 마세요. 저장된 내용과 같은 접수 키로 다시 확인합니다.'
      : '접수 요청이 진행 중입니다.';
    el('rejected-message').textContent = state.pending.rejectionMessage || '요청이 명확히 거절되었습니다.';
  }
}

function currentFormPayload() {
  return {
    project_id: state.context.project_id,
    title: el('field-title').value.trim(),
    request_text: el('field-request-text').value.trim(),
    change_type: el('field-change-type').value,
    base_ref: el('field-base-ref').value.trim(),
    input_artifact_ids: [],
    profile_version: state.context.profile_version,
    release_mode: 'team_github_tag',
  };
}

function validateForm(payload) {
  const title = el('field-title');
  const description = el('field-request-text');
  const baseRef = el('field-base-ref');
  for (const field of [title, description, baseRef]) field.setCustomValidity('');
  if (!payload.title) title.setCustomValidity('요청 제목을 입력해 주세요.');
  else if (/[\u0000-\u001f\u007f]/u.test(payload.title)) title.setCustomValidity('제어 문자는 사용할 수 없습니다.');
  if (!payload.request_text) description.setCustomValidity('요청 설명을 입력해 주세요.');
  else if (payload.request_text.includes('\u0000')) description.setCustomValidity('NUL 문자는 사용할 수 없습니다.');
  if (!payload.base_ref) baseRef.setCustomValidity('기준 브랜치를 입력해 주세요.');
  else if (/[\u0000-\u001f\u007f]/u.test(payload.base_ref)) baseRef.setCustomValidity('제어 문자는 사용할 수 없습니다.');
  return el('request-form').reportValidity();
}

function newIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return `ifpmic-${crypto.randomUUID()}`;
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `ifpmic-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function submitNewRequest(event) {
  event.preventDefault();
  if (state.busy || state.pending || !state.userId || !state.context) return;
  const payload = currentFormPayload();
  if (!validateForm(payload)) return;
  state.pending = { key: newIdempotencyKey(), payload, uncertain: false };
  if (!writeUserStorage('pending', state.pending)) {
    state.pending = null;
    updatePendingUI();
    setStatus('요청을 보내지 않았습니다. 브라우저가 복구용 접수 키와 내용을 저장할 수 없습니다.', 'error');
    return;
  }
  updatePendingUI();
  await sendPending();
}

function definitiveRejection(error) {
  return (error.status === 400 || error.status === 422) &&
    ['INVALID_REQUEST', 'REQUEST_TOO_LARGE', 'PROFILE_INELIGIBLE'].includes(error.code) ||
    (error.status === 409 && error.code === 'PROFILE_VERSION_CONFLICT');
}

async function sendPending() {
  if (state.busy || !state.pending || !state.userId) return;
  const owner = state.userId;
  const accountEpoch = state.accountEpoch;
  state.busy = true;
  el('retry-request').disabled = true;
  el('submit-request').disabled = true;
  setStatus('같은 접수 키로 요청을 확인하고 있습니다…');
  try {
    const { response, data } = await request('/api/v1/jobs', {
      method: 'POST', write: true, body: state.pending.payload,
      headers: { 'Idempotency-Key': state.pending.key },
    });
    if (state.userId !== owner || state.accountEpoch !== accountEpoch) return;
    if (response.status !== 202 || !data || typeof data.command_id !== 'string' ||
        typeof data.resource_id !== 'string' || data.status !== 'accepted') {
      state.pending.uncertain = true;
      writeUserStorage('pending', state.pending);
      updatePendingUI();
      setStatus('접수 응답 형식을 확인할 수 없습니다. 같은 요청으로 다시 확인하세요.', 'error');
      return;
    }
    state.receipt = { command_id: data.command_id, job_id: data.resource_id, status: data.status };
    const receiptStored = writeUserStorage('receipt', state.receipt);
    writeUserStorage('lastJob', data.resource_id);
    if (receiptStored) {
      removeUserStorage('pending');
      state.pending = null;
    } else if (state.pending) {
      state.pending.uncertain = true;
      writeUserStorage('pending', state.pending);
    }
    updatePendingUI();
    if (receiptStored) setStatus('접수 명령을 저장했습니다. 작업 상세를 API에서 확인합니다.', 'success');
    await selectJob(data.resource_id, { updateHash: true, refreshList: true });
    if (!receiptStored && state.userId === owner && state.accountEpoch === accountEpoch) {
      setStatus('서버는 접수를 확인했지만 브라우저가 영수증을 저장하지 못했습니다. 새 요청을 만들지 말고 같은 접수를 다시 확인하세요.', 'error');
    }
  } catch (error) {
    if (state.userId !== owner || state.accountEpoch !== accountEpoch) return;
    if (error.status === 401) {
      resetAccountView();
      setStatus('로그인 세션이 만료되었습니다. 다시 로그인한 뒤 요청 상태를 확인하세요.', 'error');
      return;
    }
    if (definitiveRejection(error)) {
      state.pending.rejected = true;
      state.pending.rejectionMessage = error.message;
      state.pending.uncertain = false;
      writeUserStorage('pending', state.pending);
      updatePendingUI();
      setStatus('요청이 저장되지 않았습니다. 거절된 초안을 확인해 주세요.', 'error');
      return;
    }
    state.pending.uncertain = true;
    writeUserStorage('pending', state.pending);
    updatePendingUI();
    setStatus(`${error.message || '응답을 받지 못했습니다'} 새 요청을 만들지 말고 같은 요청을 재시도하세요.`, 'error');
  } finally {
    state.busy = false;
    if (state.userId === owner && state.accountEpoch === accountEpoch) {
      el('retry-request').disabled = false;
      el('submit-request').disabled = false;
    }
  }
}

function discardRejected() {
  if (!state.pending?.rejected) return;
  removeUserStorage('pending');
  state.pending = null;
  el('request-form').reset();
  el('field-base-ref').value = 'refs/heads/main';
  updatePendingUI();
  setStatus('거절된 초안을 지웠습니다. 새 요청을 작성할 수 있습니다.');
}

function humanStatus(status) {
  const labels = { DRAFT: '요청 저장됨 · 실행 전', QUEUED: '대기열', RUNNING: '실행 중', WAITING_HUMAN: '사람 확인 대기', WAITING_DEVICE: '장비 대기', PAUSED: '일시 중지', FAILED: '실패', CANCELED: '취소', COMPLETED: '완료' };
  return labels[status] || status || '상태 미제공';
}

function renderList() {
  const list = el('job-list');
  list.replaceChildren();
  if (!state.userId) {
    const empty = document.createElement('p');
    empty.className = 'list-empty';
    empty.textContent = '로그인 후 허용된 작업을 확인할 수 있습니다.';
    list.append(empty);
    el('load-more').hidden = true;
    return;
  }
  if (!state.items.length) {
    const empty = document.createElement('div');
    empty.className = 'list-empty list-empty-card';
    empty.textContent = '저장된 작업이 없습니다. 요청을 등록하면 여기에 표시됩니다.';
    list.append(empty);
  }
  for (const job of state.items) {
    if (!job || typeof job.job_id !== 'string') continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'job-row';
    button.dataset.testid = 'job-row';
    button.dataset.jobId = job.job_id;
    button.setAttribute('aria-current', String(job.job_id === state.selectedJobId));
    const mark = document.createElement('span');
    mark.className = 'row-mark';
    mark.textContent = '↳';
    const info = document.createElement('span');
    info.className = 'row-info';
    const title = document.createElement('strong');
    title.textContent = `요청 ${job.job_id.slice(0, 8)}`;
    const sub = document.createElement('small');
    sub.textContent = `${job.workflow_version || '워크플로 미제공'} · ${job.current_step_ids?.length ? job.current_step_ids.join(', ') : '단계 시작 전'}`;
    info.append(title, sub);
    const badge = document.createElement('span');
    badge.className = `row-status${job.status === 'DRAFT' ? ' is-draft' : ''}`;
    badge.textContent = job.status || '—';
    button.append(mark, info, badge);
    button.addEventListener('click', () => selectJob(job.job_id, { updateHash: true }));
    list.append(button);
  }
  el('load-more').hidden = !state.cursor;
}

async function loadJobs({ append = false } = {}) {
  if (!state.userId) return;
  const owner = state.userId;
  const accountEpoch = state.accountEpoch;
  const listEpoch = ++state.listEpoch;
  const params = new URLSearchParams({ limit: '25' });
  if (append && state.cursor) params.set('cursor', state.cursor);
  try {
    const { data } = await request(`/api/v1/jobs?${params.toString()}`);
    if (state.userId !== owner || state.accountEpoch !== accountEpoch || state.listEpoch !== listEpoch) return;
    if (!data || !Array.isArray(data.items)) throw new Error('작업 목록 응답을 확인할 수 없습니다.');
    state.items = append ? [...state.items, ...data.items] : data.items;
    state.cursor = data.next_cursor || null;
    renderList();
  } catch (error) {
    if (state.userId !== owner || state.accountEpoch !== accountEpoch || state.listEpoch !== listEpoch) return;
    if (error.status === 401) resetAccountView();
    setStatus(error.message, 'error');
  }
}

function setDetailText(testId, value) {
  document.querySelector(`[data-testid="${testId}"]`).textContent = value;
}

function findReceiptForJob(jobId) {
  if (state.receipt?.job_id === jobId) return state.receipt;
  const stored = readUserStorage('receipt');
  return stored?.job_id === jobId ? stored : null;
}

async function refreshCommand(receipt, guard) {
  const commandEpoch = ++state.commandEpoch;
  const current = () => state.userId === guard.owner && state.accountEpoch === guard.accountEpoch &&
    state.detailEpoch === guard.detailEpoch && state.commandEpoch === commandEpoch;
  if (!receipt || !state.userId) {
    if (current()) el('command-receipt').hidden = true;
    return;
  }
  if (!current()) return;
  el('command-receipt').hidden = false;
  setDetailText('command-id', receipt.command_id);
  setDetailText('command-status', '확인 중');
  try {
    const { data } = await request(`/api/v1/commands/${encodeURIComponent(receipt.command_id)}`);
    if (!current()) return;
    setDetailText('command-status', data && typeof data.status === 'string' ? data.status : '상태 미제공');
  } catch (error) {
    if (!current()) return;
    setDetailText('command-status', error.status === 401 ? '세션 확인 필요' : '상태 조회 실패');
  }
}

async function selectJob(jobId, { updateHash = false, refreshList = false } = {}) {
  if (!state.userId || typeof jobId !== 'string') return;
  const owner = state.userId;
  const accountEpoch = state.accountEpoch;
  const detailEpoch = ++state.detailEpoch;
  const current = () => state.userId === owner && state.accountEpoch === accountEpoch &&
    state.detailEpoch === detailEpoch && state.selectedJobId === jobId;
  admissionPanel.clear();
  storedAdmission.clear();
  state.selectedJobId = jobId;
  el('empty-detail').hidden = true;
  el('job-detail').hidden = true;
  el('detail-error').hidden = true;
  renderList();
  if (updateHash) history.replaceState(null, '', `#job/${encodeURIComponent(jobId)}`);
  writeUserStorage('lastJob', jobId);
  try {
    const { data } = await request(`/api/v1/jobs/${encodeURIComponent(jobId)}`);
    if (!current()) return;
    const job = data && data.job;
    if (!job || job.job_id !== jobId) throw new Error('작업 상세 응답을 확인할 수 없습니다.');
    setDetailText('detail-job-id', job.job_id);
    setDetailText('detail-status', job.status === 'QUEUED' ? '접수 확인 중' : job.status || '상태 미제공');
    document.querySelector('[data-testid="detail-status"]').classList.toggle('is-draft', job.status === 'DRAFT');
    document.querySelector('.status-explainer').textContent = job.status === 'QUEUED' ? '첫 접수 영수증 확인 필요' : humanStatus(job.status);
    const steps = Array.isArray(job.current_step_ids) ? job.current_step_ids : [];
    setDetailText('detail-current-steps', steps.length ? steps.join(', ') : '아직 시작된 단계 없음');
    setDetailText('detail-cycle', Number.isInteger(job.cycle) ? String(job.cycle) : '—');
    setDetailText('detail-revision', Number.isInteger(job.revision) ? String(job.revision) : '—');
    setDetailText('detail-workflow', typeof job.workflow_version === 'string' ? job.workflow_version : '—');
    setDetailText('detail-profile', typeof job.profile_version === 'string' ? job.profile_version : '—');
    const mockPreference = readUserStorage('admission-demo');
    el('job-detail').hidden = false;
    admissionPanel.show({ userId: owner, jobId, scenario: mockPreference?.job_id === jobId ? mockPreference.scenario : 'pending' });
    storedAdmission.select(jobId);
    await refreshCommand(findReceiptForJob(jobId), { owner, accountEpoch, detailEpoch });
    if (!current()) return;
    if (refreshList) await loadJobs();
    if (!current()) return;
    setStatus('작업 상세를 API에서 불러왔습니다.', 'success');
  } catch (error) {
    if (!current()) return;
    if (error.status === 401) resetAccountView();
    else {
      el('detail-error').textContent = error.message;
      el('detail-error').hidden = false;
      el('job-detail').hidden = true;
      admissionPanel.clear();
      storedAdmission.clear();
    }
    setStatus(error.message, 'error');
  }
}

async function initializeSession() {
  try {
    const { data } = await request('/api/v1/session');
    if (!data || typeof data.user_id !== 'string' || typeof data.csrf_token !== 'string') throw new Error('세션 응답을 확인할 수 없습니다.');
    const previousUser = state.userId;
    if (previousUser && previousUser !== data.user_id) resetAccountView();
    state.userId = data.user_id;
    state.csrf = data.csrf_token;
    const owner = state.userId;
    const accountEpoch = state.accountEpoch;
    el('account-name').textContent = `계정 ${data.user_id.slice(0, 8)}`;
    el('logout-button').hidden = false;
    el('auth-gate').hidden = true;
    el('signed-in').hidden = false;
    setDetailText('demo-mode', data.mode === 'mock' ? 'MOCK 모드 · OIDC 세션 확인됨' : `${data.mode} 모드 · OIDC 세션 확인됨`);
    const { data: context } = await request('/demo/context');
    if (state.userId !== owner || state.accountEpoch !== accountEpoch) return;
    if (!validateContext(context)) throw new Error('데모 프로젝트 설정이 예상한 값과 일치하지 않습니다.');
    state.context = context;
    el('context-project').textContent = context.project_id;
    el('context-storage').textContent = 'PostgreSQL 저장';
    el('context-identity').textContent = '로컬 데모 OIDC';
    el('profile-version').textContent = context.profile_version;
    setConnection(true);
    state.pending = readUserStorage('pending');
    state.receipt = readUserStorage('receipt');
    updatePendingUI();
    await loadJobs();
    if (state.userId !== owner || state.accountEpoch !== accountEpoch) return;
    const hashJob = location.hash.startsWith('#job/') ? decodeURIComponent(location.hash.slice(5)) : null;
    const lastJob = readUserStorage('lastJob');
    const requestedJob = hashJob || lastJob || state.receipt?.job_id;
    if (requestedJob) await selectJob(requestedJob);
    else setStatus('로그인됨. 데모 요청을 작성하거나 최근 저장 작업을 선택하세요.', 'success');
  } catch (error) {
    setConnection(false);
    if (error.status === 401) {
      resetAccountView();
      setStatus('로그인 후 프로젝트 요청을 확인할 수 있습니다.');
    } else {
      resetAccountView();
      setStatus(error.message || 'API 또는 데모 설정을 확인할 수 없습니다.', 'error');
    }
  }
}

async function logout() {
  if (!state.userId || state.busy) return;
  state.busy = true;
  try {
    await request('/auth/logout', { method: 'POST', write: true });
    resetAccountView();
    history.replaceState(null, '', location.pathname);
    setStatus('로그아웃했습니다. 보류된 요청 복구 정보는 해당 계정의 탭 세션에 남아 있습니다.');
  } catch (error) {
    if (error.status === 401) resetAccountView();
    setStatus(error.message, 'error');
  } finally {
    state.busy = false;
  }
}

el('request-form').addEventListener('submit', submitNewRequest);
el('retry-request').addEventListener('click', sendPending);
el('discard-rejected').addEventListener('click', discardRejected);
el('refresh-jobs').addEventListener('click', () => loadJobs());
el('load-more').addEventListener('click', () => loadJobs({ append: true }));
el('refresh-detail').addEventListener('click', () => state.selectedJobId && selectJob(state.selectedJobId));
el('logout-button').addEventListener('click', logout);
el('login-button').addEventListener('click', () => { location.assign('/auth/login'); });
el('copy-job-id').addEventListener('click', async () => {
  const value = el('detail-job-id').textContent;
  try {
    await navigator.clipboard.writeText(value);
    setStatus('작업 ID를 복사했습니다.', 'success');
  } catch {
    setStatus('클립보드에 복사하지 못했습니다. 작업 ID를 선택해 복사해 주세요.', 'error');
  }
});

setConnection(false);
initializeSession();
