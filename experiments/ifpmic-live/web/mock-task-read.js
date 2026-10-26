import { createResourceReadController } from './resource-read.js';
import { validateMockTask } from './mock-task.js';

export function createStoredMockTaskController(options) {
  return createResourceReadController({ ...options,
    parse: (value, jobId) => validateMockTask(value, { jobId }),
    isPending: value => value.status === 'pending' });
}

const checks = { request_saved: '요청 저장', workspace_ready: '작업 공간 준비', engine_admitted: '실행 접수' };
const labels = {
  pending: ['저장된 모의 결과 없음', '아직 저장된 결과가 없습니다. 실행 접수 상태를 함께 확인하세요.'],
  completed: ['모의 작업 확인 완료', '저장된 결과를 확인했습니다. 모의 작업 완료는 전체 업무 완료와 별개입니다.'],
};

export function createStoredMockTaskPanel(document, { read, onDenied }) {
  const node = id => document.getElementById(id);
  const panel = node('stored-mock-task');
  const list = node('stored-mock-task-checks');
  const controller = createStoredMockTaskController({ read, onDenied,
    onChange(view) {
      panel.hidden = view.phase === 'empty';
      panel.dataset.phase = view.phase;
      panel.setAttribute('aria-busy', String(view.phase === 'loading'));
      let title = '저장된 모의 결과 확인 중';
      let description = '선택한 작업의 저장 결과를 조회합니다.';
      if (view.phase === 'ready') [title, description] = labels[view.value.status];
      else if (view.phase === 'error') {
        title = '저장 결과 조회 실패';
        description = '다시 확인해 주세요. 새 작업이나 실행을 만들지 않습니다.';
      } else if (view.phase === 'timedout') {
        title = '결과 자동 확인 종료';
        description = '60초 동안 확인했습니다. 다시 확인 버튼으로 현재 결과를 조회하세요.';
      }
      node('stored-mock-task-status').textContent = title;
      node('stored-mock-task-description').textContent = description;
      node('stored-mock-task-confirmed').hidden = !view.value || view.phase === 'ready';
      node('stored-mock-task-confirmed').textContent = view.value ? `마지막 확인: ${labels[view.value.status][0]}` : '';
      const completed = view.value?.status === 'completed';
      list.replaceChildren();
      list.hidden = !completed;
      if (completed) {
        for (const check of view.value.result.checks) {
          const row = document.createElement('li');
          const name = document.createElement('span');
          const status = document.createElement('strong');
          name.textContent = checks[check.name];
          status.textContent = '확인됨';
          row.append(name, status);
          list.append(row);
        }
      }
      node('stored-mock-task-run').hidden = !completed;
      node('stored-mock-task-run-id').textContent = completed ? view.value.admitted_run_id : '';
      node('stored-mock-task-time').hidden = !completed;
      node('stored-mock-task-time').textContent = completed
        ? `결과 저장 시각 ${new Date(view.value.completed_at).toLocaleString('ko-KR')}` : '';
    },
  });
  node('stored-mock-task-refresh').addEventListener('click', () => controller.refresh());
  return controller;
}
