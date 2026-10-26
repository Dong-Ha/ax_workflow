// This provider is deliberately local. It cannot enqueue work or manufacture
// an engine run/receipt; actual admission will use a separate reviewed adapter.
const scenarios = new Set(['pending', 'admitted', 'error']);

export async function readMockAdmission({ jobId, scenario, signal }) {
  if (!scenarios.has(scenario)) throw new Error('Unknown mock scenario');
  await new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 180);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  if (scenario === 'error') throw new Error('Simulated lookup failure');
  return { mode: 'mock', job_id: jobId, status: scenario };
}

export function createAdmissionController({ read = readMockAdmission, onChange }) {
  let selection = null;
  let generation = 0;
  let active = null;
  let lastConfirmed = null;

  function clear() {
    generation += 1;
    active?.abort();
    active = null;
    selection = null;
    lastConfirmed = null;
    onChange({ phase: 'empty' });
  }

  async function refresh(scenario = 'pending') {
    if (!selection || !scenarios.has(scenario)) return;
    const current = ++generation;
    active?.abort();
    const controller = new AbortController();
    active = controller;
    const jobId = selection.jobId;
    onChange({ phase: 'loading', jobId, lastConfirmed });
    try {
      const result = await read({ jobId, scenario, signal: controller.signal });
      if (current !== generation) return;
      if (result?.mode !== 'mock' || result.job_id !== jobId || !['pending', 'admitted'].includes(result.status)) {
        throw new Error('Invalid mock status');
      }
      lastConfirmed = result.status;
      onChange({ phase: result.status, jobId, lastConfirmed });
    } catch {
      if (current !== generation) return;
      // Never render a provider's exception text or stale account/job result.
      onChange({ phase: 'error', jobId, lastConfirmed });
    } finally {
      if (current === generation) active = null;
    }
  }

  function select({ userId, jobId, scenario = 'pending' }) {
    clear();
    if (!userId || !jobId) return;
    selection = { userId, jobId };
    return refresh(scenarios.has(scenario) ? scenario : 'pending');
  }

  return { select, refresh, clear };
}

const copy = {
  empty: ['', ''],
  loading: ['모의 상태 확인 중', '선택한 요청의 모의 응답을 읽고 있습니다.'],
  pending: ['접수 대기 · 모의', '요청 저장 뒤 실행 접수를 기다리는 화면입니다.'],
  admitted: ['접수됨 · 모의', '접수된 경우의 화면 예시입니다. 작업 실행이나 완료를 뜻하지 않습니다.'],
  error: ['조회 실패 · 모의', '모의 상태를 읽지 못했습니다. 다시 확인하거나 다른 상황을 선택하세요.'],
};

export function createAdmissionPanel(document, { saveScenario }) {
  const node = id => document.getElementById(id);
  const panel = node('admission-panel');
  const scenario = node('admission-scenario');
  let selected = null;
  const controller = createAdmissionController({
    onChange(view) {
      panel.hidden = view.phase === 'empty';
      panel.dataset.phase = view.phase;
      panel.setAttribute('aria-busy', String(view.phase === 'loading'));
      node('admission-status').textContent = copy[view.phase][0];
      node('admission-description').textContent = copy[view.phase][1];
      node('admission-last-confirmed').hidden = view.phase !== 'error' || !view.lastConfirmed;
      node('admission-last-confirmed').textContent = view.lastConfirmed
        ? `마지막 확인: ${copy[view.lastConfirmed][0]}` : '';
      const position = view.phase === 'admitted' ? 2 : 1;
      for (const step of panel.querySelectorAll('[data-admission-step]')) {
        step.setAttribute('aria-current', Number(step.dataset.admissionStep) === position ? 'step' : 'false');
      }
    },
  });
  scenario.addEventListener('change', () => {
    if (!selected) return;
    saveScenario({ job_id: selected.jobId, scenario: scenario.value });
    controller.refresh(scenario.value);
  });
  node('admission-refresh').addEventListener('click', () => controller.refresh(scenario.value));
  return {
    show(value) {
      selected = value;
      scenario.value = scenarios.has(value.scenario) ? value.scenario : 'pending';
      return controller.select({ ...value, scenario: scenario.value });
    },
    clear() { selected = null; scenario.value = 'pending'; controller.clear(); },
  };
}
