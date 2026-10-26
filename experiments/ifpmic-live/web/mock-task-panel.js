import { createMockTaskController } from './mock-task.js';

const copy = {
  empty: ['', ''],
  loading: ['예시 결과 확인 중', '선택한 작업의 합성 결과를 읽고 있습니다.'],
  pending: ['모의 결과 대기', '아직 예시 결과가 없습니다. 완료 상황을 선택해 결과 화면을 확인하세요.'],
  completed: ['모의 확인 완료', '예시의 세 항목을 확인했습니다. 전체 업무 완료와는 별개입니다.'],
  error: ['모의 결과 조회 실패', '예시 결과를 읽지 못했습니다. 다른 상황을 선택하거나 다시 확인하세요.'],
};
const checkLabels = {
  request_saved: '요청 저장',
  workspace_ready: '작업 공간 준비',
  engine_admitted: '실행 접수',
};

// Only the selected scenario is persisted. Result data and run IDs stay in memory.
export function createMockTaskPanel(document, { saveScenario }) {
  const node = id => document.getElementById(id);
  const panel = node('mock-task-panel');
  const scenario = node('mock-task-scenario');
  const checks = node('mock-task-checks');
  let selected = null;
  const controller = createMockTaskController({
    onChange(view) {
      panel.hidden = view.phase === 'empty';
      panel.dataset.phase = view.phase;
      panel.dataset.jobId = view.jobId ?? '';
      panel.setAttribute('aria-busy', String(view.phase === 'loading'));
      node('mock-task-status').textContent = copy[view.phase][0];
      node('mock-task-description').textContent = copy[view.phase][1];
      const retained = view.phase === 'error' || view.phase === 'loading';
      const value = retained ? view.lastConfirmed : view.value;
      const completed = value?.status === 'completed';
      node('mock-task-confirmed').hidden = !retained || !value;
      node('mock-task-confirmed').textContent = value
        ? `마지막 확인: ${copy[value.status][0]}` : '';
      checks.replaceChildren();
      checks.hidden = !completed;
      if (completed) {
        for (const check of value.result.checks) {
          const row = document.createElement('li');
          const label = document.createElement('span');
          label.textContent = checkLabels[check.name];
          const status = document.createElement('strong');
          status.textContent = '확인됨 · 예시';
          row.append(label, status);
          checks.append(row);
        }
      }
      node('mock-task-run').hidden = !completed;
      node('mock-task-run-id').textContent = completed ? value.admitted_run_id : '';
      node('mock-task-completed-at').textContent = completed
        ? `예시 완료 시각 ${new Date(value.completed_at).toLocaleString('ko-KR')}` : '';
      node('mock-task-completed-at').hidden = !completed;
    },
  });
  const validScenario = value => ['pending', 'completed', 'error'].includes(value) ? value : 'pending';
  scenario.addEventListener('change', () => {
    if (!selected) return;
    saveScenario({ job_id: selected.jobId, scenario: scenario.value });
    controller.refresh(scenario.value);
  });
  node('mock-task-refresh').addEventListener('click', () => controller.refresh(scenario.value));
  return {
    show(value) {
      selected = value;
      scenario.value = validScenario(value.scenario);
      return controller.select({ ...value, scenario: scenario.value });
    },
    clear() { selected = null; scenario.value = 'pending'; controller.clear(); },
  };
}
