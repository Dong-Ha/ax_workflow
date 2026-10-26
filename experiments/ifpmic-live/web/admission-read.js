const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const keys = ['schema_version', 'job_id', 'command_id', 'admission_status', 'job_status', 'job_revision',
  'command_status', 'applied_revision', 'admitted_run_id', 'receipt', 'error_code'];
const statuses = new Set(['DRAFT', 'QUEUED', 'RUNNING', 'WAITING_HUMAN', 'WAITING_DEVICE', 'PAUSED',
  'RECONCILING', 'FAILED', 'CANCELED', 'NO_CHANGE', 'RELEASED_PENDING_NOTES', 'COMPLETED']);
const quarantine = new Set(['BINDING_CONFLICT', 'BUILD_UNAVAILABLE', 'RUN_CONFLICT', 'HISTORY_MISSING',
  'START_WINDOW_EXPIRED', 'RETENTION_UNVERIFIED', 'WORKSPACE_IDENTITY_CONFLICT', 'CATALOG_IDENTITY_CONFLICT',
  'PROPOSAL_COLLISION', 'PREDECESSOR_CONFLICT', 'COMMAND_IDENTITY_CONFLICT']);

export function parseAdmission(value, jobId) {
  const require = condition => { if (!condition) throw new Error('Invalid admission status'); };
  require(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key)));
  require(value.schema_version === 'ifpmic.admission-status.v1' && value.job_id === jobId && uuid(value.job_id) && uuid(value.command_id));
  require(statuses.has(value.job_status) && Number.isSafeInteger(value.job_revision) && value.job_revision >= 0);
  const phase = value.admission_status;
  require(['pending', 'admitted_pending_projection', 'applied', 'rejected', 'quarantined'].includes(phase));
  require(value.admitted_run_id === null || uuid(value.admitted_run_id));
  if (phase === 'applied') {
    require(value.command_status === 'applied' && value.applied_revision === 1 && value.job_revision >= 1
      && value.error_code === null && uuid(value.admitted_run_id));
  } else {
    require(value.job_status === 'DRAFT' && value.job_revision === 0 && value.applied_revision === null
      && value.command_status === (phase === 'rejected' ? 'rejected' : 'accepted'));
  }
  if (phase === 'applied' || phase === 'rejected') {
    const applied = phase === 'applied';
    const expected = { transition_sequence: 1, outcome: phase, expected_revision: 0,
      applied_revision: applied ? 1 : null, projected_job_status: applied ? 'QUEUED' : 'DRAFT', projected_revision: applied ? 1 : 0 };
    require(uuid(value.admitted_run_id) && value.receipt && Object.keys(value.receipt).length === Object.keys(expected).length
      && Object.entries(expected).every(([key, item]) => value.receipt[key] === item));
    require(applied || ['FORBIDDEN', 'PROFILE_INELIGIBLE'].includes(value.error_code));
  } else {
    require(value.receipt === null);
    if (phase === 'quarantined') require(quarantine.has(value.error_code));
    else require(value.error_code === null && (phase === 'pending' ? value.admitted_run_id === null : uuid(value.admitted_run_id)));
  }
  return value;
}

export function createStoredAdmissionController({ read, onChange, onDenied = () => {}, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout }) {
  let jobId = null;
  let generation = 0;
  let active = null;
  let timer = null;
  let confirmed = null;

  function stop() {
    generation += 1;
    if (timer !== null) cancel(timer);
    timer = null;
    active?.abort();
    active = null;
  }
  function clear() {
    stop();
    jobId = null;
    confirmed = null;
    onChange({ phase: 'empty', value: null });
  }
  async function refresh() {
    if (!jobId) return;
    stop();
    const current = generation;
    const selected = jobId;
    const deadline = now() + 60_000;
    let index = 0;
    const poll = async () => {
      if (current !== generation) return;
      if (now() >= deadline) {
        onChange({ phase: 'timedout', value: confirmed });
        return;
      }
      timer = null;
      active = new AbortController();
      const deadlineTimer = schedule(() => {
        if (current !== generation) return;
        stop();
        onChange({ phase: 'timedout', value: confirmed });
      }, deadline - now());
      onChange({ phase: 'loading', value: confirmed });
      try {
        const data = await read(selected, active.signal);
        if (current !== generation) return;
        if (now() >= deadline) { onChange({ phase: 'timedout', value: confirmed }); return; }
        confirmed = parseAdmission(data, selected);
        onChange({ phase: 'ready', value: confirmed });
        if (['pending', 'admitted_pending_projection'].includes(confirmed.admission_status)) {
          const delay = [1000, 2000, 4000, 5000][Math.min(index++, 3)];
          timer = schedule(poll, Math.max(0, Math.min(delay, deadline - now())));
        }
      } catch (error) {
        if (current !== generation) return;
        const denied = error.status === 401 || error.status === 403;
        if (denied) confirmed = null;
        onChange({ phase: 'error', value: confirmed });
        if (denied) onDenied(error.status);
      } finally {
        cancel(deadlineTimer);
        if (current === generation) active = null;
      }
    };
    return poll();
  }
  return {
    clear, refresh,
    select(selected) { clear(); jobId = selected; return refresh(); },
  };
}

const labels = {
  pending: ['실행 접수 대기', '요청은 저장됐습니다. 실행 엔진의 접수 결과를 기다립니다.'],
  admitted_pending_projection: ['실행 접수됨 · 상태 반영 대기', '실행은 접수됐으며 첫 상태 영수증을 기다립니다.'],
  applied: ['접수 상태 확인됨', '동일 작업의 실행과 첫 상태 영수증을 확인했습니다. 업무 완료를 뜻하지 않습니다.'],
  rejected: ['실행 접수 거절', '접수 조건을 충족하지 못했습니다. 권한과 프로파일 설정을 확인하세요.'],
  quarantined: ['실행 접수 보류', '접수 정보의 일관성을 확인해야 합니다. 새 요청을 만들지 말고 담당자에게 확인하세요.'],
};

const errorMessages = {
  FORBIDDEN: '요청 생성 권한이 변경됐습니다. 담당자에게 현재 권한을 확인하세요.',
  PROFILE_INELIGIBLE: '이 요청의 프로파일을 사용할 수 없습니다. 담당자에게 설정을 확인하세요.',
  BINDING_CONFLICT: '작업과 실행의 연결 정보를 확인해야 합니다.',
  BUILD_UNAVAILABLE: '승인된 실행 버전을 사용할 수 없습니다.',
  RUN_CONFLICT: '같은 작업의 실행 정보가 일치하지 않습니다.',
  HISTORY_MISSING: '저장된 실행 이력을 확인할 수 없습니다.',
  START_WINDOW_EXPIRED: '접수 확인 시간이 지났습니다. 기존 요청의 상태를 담당자에게 확인하세요.',
  RETENTION_UNVERIFIED: '실행 이력의 보존 상태를 확인해야 합니다.',
  WORKSPACE_IDENTITY_CONFLICT: '작업 공간이 저장된 요청과 일치하지 않습니다.',
  CATALOG_IDENTITY_CONFLICT: '저장된 프로파일 정보가 일치하지 않습니다.',
  PROPOSAL_COLLISION: '같은 처리 단계에 서로 다른 결과가 있어 확인이 필요합니다.',
  PREDECESSOR_CONFLICT: '요청의 이전 상태를 확인해야 합니다.',
  COMMAND_IDENTITY_CONFLICT: '저장된 접수 명령이 작업과 일치하지 않습니다.',
};

export function createStoredAdmissionPanel(document, { read, onConfirmed, onDenied }) {
  const node = id => document.getElementById(id);
  const panel = node('stored-admission');
  const controller = createStoredAdmissionController({ read, onDenied,
    onChange(view) {
      panel.hidden = view.phase === 'empty';
      panel.dataset.phase = view.phase;
      panel.setAttribute('aria-busy', String(view.phase === 'loading'));
      let title = '접수 상태 확인 중';
      let description = '저장된 작업의 현재 접수 상태를 조회합니다.';
      if (view.phase === 'ready') {
        [title, description] = labels[view.value.admission_status];
        if (view.value.error_code) description = `${errorMessages[view.value.error_code]} 새 요청은 전송하지 않습니다.`;
        onConfirmed(view.value);
      } else if (view.phase === 'error') {
        title = '접수 상태 조회 실패';
        description = '다시 확인해 주세요. 새 요청을 전송하지 않습니다.';
      } else if (view.phase === 'timedout') {
        title = '자동 확인 종료';
        description = '60초 동안 확인했습니다. 다시 확인 버튼으로 현재 상태를 조회하세요.';
      }
      node('stored-admission-status').textContent = title;
      node('stored-admission-description').textContent = description;
      node('stored-admission-confirmed').hidden = !view.value || view.phase === 'ready';
      node('stored-admission-confirmed').textContent = view.value
        ? `마지막 확인: ${labels[view.value.admission_status][0]}` : '';
      const run = view.value?.admitted_run_id;
      node('stored-admission-run').hidden = !run;
      node('stored-admission-run-id').textContent = run || '';
    },
  });
  node('stored-admission-refresh').addEventListener('click', () => controller.refresh());
  return controller;
}
