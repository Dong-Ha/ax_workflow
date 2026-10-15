// New, explicitly synthetic examples. Authoring does not call replay to fabricate outcomes.
import { childCatalogVersion } from './child-catalog.mjs';
const clone = value => structuredClone(value);
export function createChildScenarios(template) {
  const entries = [
    ['agent-wait', 'TC 자식 할당·대기 · 일반 성공 차단'],
    ['agent-handoff', 'TC 반환·수집·충돌 해결·통합'],
    ['agent-child-failure', 'TC 기술 실패 · 새 attempt에서 복구'],
    ['agent-child-question', 'TC 질문 · 사람 답변·checkpoint 재개'],
    ['agent-child-retry-limit', 'TC 재시도 · 10초/30초·3회 상한'],
    ['agent-child-stale-cycle', '이전 cycle의 TC 결과 · 현재 대기 해제 금지'],
    ['agent-child-permissions', 'TC 테스트 범위 · code-dev 단독 통합'],
    ['agent-child-interrupted', 'TC 중단 · 사람 복구 승인 필요'],
    ['agent-child-canceled', 'TC 취소 · 사람 복구 승인 뒤 새 실행'],
  ];
  return entries.map(([id, title]) => {
    const base = JSON.parse(JSON.stringify(template.events).replaceAll('happy-path', id));
    const anchor = base.findIndex(e => e.type === 'p12_coordinator');
    const templates = Object.fromEntries(base.slice(anchor, anchor + 6).map(e => [e.type, e.payload]));
    const events = base.slice(0, anchor), checkpoints = [{ id: 'start', title: '처음 · MOCK', cursor: 0 }];
    let seq = 0, cycle = 1, attempt = 1, ordinal = 1, p12Passed = false;
    const mark = key => checkpoints.push({ id: key, title: `${key} · MOCK`, cursor: events.length });
    const emit = (type, payload, overrides = {}) => {
      const e = { event_id: `mock:${id}:child-example:${++seq}`, source_id: 'mock:child-examples', source_seq: seq,
        type, mode: 'mock', job_id: `mock:${id}`, step_id: 'P12', cycle, attempt,
        execution_id: `mock:P12:c${cycle}:a${attempt}`, payload: clone(payload), ...overrides };
      events.push(e); return e;
    };
    const proof = (type, overrides = {}) => {
      let p = JSON.parse(JSON.stringify(templates[type]).replaceAll(':c1:a1', `:c${cycle}:a${attempt}`));
      if (type === 'p12_coordinator') p.p11_execution_id = `mock:P11:c${cycle}:a1`;
      // Request/task are stable across question continuation; execution and proof IDs are new.
      if (ordinal > 1 && type !== 'p12_coordinator') {
        if ('request_id' in p) p.request_id += `:n${ordinal}`;
        if ('child_execution_id' in p) p.child_execution_id += `:n${ordinal}`;
        p.evidence_id += `:n${ordinal}`;
        for (const key of ['result_evidence_id', 'patch_artifact_id', 'integration_artifact_id']) if (p[key]) p[key] += `:n${ordinal}`;
      }
      if (type === 'child_request') p.ordinal = ordinal;
      return { ...p, ...clone(overrides) };
    };
    const send = (type, overrides = {}) => emit(type, proof(type, overrides));
    const state = value => emit('step', { state: value });
    const startChild = () => { send('p12_coordinator'); send('child_request'); send('child_assignment'); };
    const terminal = status => send('child_result', status === 'completed' ? {} : {
      status, patch_artifact_id: null, changed_path_refs: [],
      question_id: status === 'needs_human' ? `mock:${id}:question` : null,
      checkpoint_artifact_id: status === 'needs_human' ? `mock:${id}:checkpoint` : null,
      failure_class: status === 'needs_human' ? null : status === 'failed' ? 'agent_failure' : status,
    });
    const complete = () => { terminal('completed'); send('child_collect'); send('child_integrated'); };
    const suffix = () => {
      for (const raw of base.slice(anchor + 6)) {
        const e = clone(raw);
        if (p12Passed && e.step_id === 'P12') continue;
        e.cycle = cycle;
        const a = e.step_id === 'P12' ? attempt : 1;
        e.attempt = a; e.execution_id = `mock:${e.step_id}:c${cycle}:a${a}`;
        // All downstream mock references/embedded measurement envelopes must match the new cycle.
        const adjusted = JSON.parse(JSON.stringify(e).replaceAll(':c1', `:c${cycle}`));
        if (adjusted.type === 'measurement') adjusted.payload.evidence.cycle = cycle;
        events.push(adjusted);
        if (id === 'agent-handoff' && e.type === 'step' && e.step_id === 'P12' && e.payload.state === 'SUCCEEDED') mark('passed');
      }
    };
    const advanceRetry = now => { emit('retry', { now_ms: now }); attempt++; ordinal = 1; };
    const late = e => emit(e.type, e.payload, { cycle: e.cycle, attempt: e.attempt, execution_id: e.execution_id });
    if (id === 'agent-wait') {
      send('p12_coordinator'); send('child_request'); mark('requested'); send('child_assignment'); mark('waiting');
      send('child_result', { child_execution_id: 'mock:unrelated:child' }); state('SUCCEEDED'); mark('blocked');
    } else if (id === 'agent-handoff') {
      startChild(); mark('waiting'); terminal('completed'); mark('returned'); send('child_collect'); mark('collected');
      send('child_integrated', { outcome: 'conflict', integration_artifact_id: null, evidence_id: `mock:${id}:conflict` });
      state('SUCCEEDED'); mark('conflict'); send('child_integrated'); mark('integrated'); suffix();
    } else if (id === 'agent-child-question') {
      startChild(); const question = terminal('needs_human'); mark('question'); send('child_collect'); mark('waiting-human');
      const task = `mock:child-human:${question.payload.child_execution_id}`;
      const answer = { actor: 'mock:human', coordinator_task_id: question.payload.coordinator_task_id,
        coordinator_execution_id: question.payload.coordinator_execution_id, child_execution_id: question.payload.child_execution_id,
        task_id: task, question_id: question.payload.question_id, answer_artifact_id: `mock:${id}:answer-artifact`,
        checkpoint_artifact_id: question.payload.checkpoint_artifact_id, candidate_fingerprint: 'mock:candidate:A',
        requirements_version: 'mock:requirements:v1', evidence_id: `mock:${id}:answer-proof` };
      emit('child_answer', { ...answer, task_id: 'mock:unassigned:task', evidence_id: `mock:${id}:wrong-answer` }); mark('rejected');
      emit('child_answer', answer); mark('answered'); state('READY'); state('RUNNING'); ordinal = 2;
      send('child_request', { prior_child_execution_id: question.payload.child_execution_id,
        checkpoint_artifact_id: question.payload.checkpoint_artifact_id, answer_evidence_id: answer.evidence_id, answer_artifact_id: answer.answer_artifact_id });
      send('child_assignment'); mark('resumed'); complete(); mark('integrated'); suffix();
    } else if (id === 'agent-child-permissions') {
      send('p12_coordinator');
      send('child_request', { workspace_id: proof('p12_coordinator').workspace_id, evidence_id: `mock:${id}:bad-ws` });
      send('child_request', { child_role: 'code-dev', evidence_id: `mock:${id}:bad-role` }); mark('denied');
      send('child_request'); send('child_assignment'); mark('waiting');
      send('child_result', { changed_path_refs: ['mock:path:production'], evidence_id: `mock:${id}:bad-path` });
      send('child_result', { production_hash: 'mock:changed', evidence_id: `mock:${id}:bad-hash` });
      send('child_result', { coordinator_execution_id: 'mock:wrong-parent', evidence_id: `mock:${id}:bad-parent` });
      send('child_result', { request_id: 'mock:wrong-request', evidence_id: `mock:${id}:bad-request` });
      terminal('completed'); send('child_collect'); mark('collected');
      send('child_integrated', { actor: 'mock:tc', evidence_id: `mock:${id}:tc-integrator` });
      send('child_integrated', { production_hash_after: 'mock:changed', evidence_id: `mock:${id}:changed-production` });
      send('child_integrated', { expectations_changed: true, evidence_id: `mock:${id}:changed-expectations` }); mark('integration-denied');
      send('child_integrated'); mark('integrated'); suffix();
    } else if (id === 'agent-child-stale-cycle') {
      startChild(); const old = terminal('completed'); send('child_collect'); send('child_integrated'); state('SUCCEEDED');
      emit('step', { state: 'READY' }, { step_id: 'P13', execution_id: 'mock:P13:c1:a1' });
      emit('step', { state: 'RUNNING' }, { step_id: 'P13', execution_id: 'mock:P13:c1:a1' });
      const failure = { candidate_fingerprint: 'mock:candidate:A', evidence_id: `mock:${id}:build-failure` };
      emit('business_failure', failure, { step_id: 'P13', execution_id: 'mock:P13:c1:a1' });
      emit('route', { ...failure, target: 'P11', outcome: 'business_fail' }, { step_id: 'P13', execution_id: 'mock:P13:c1:a1' }); cycle = 2; mark('rerouted');
      for (const value of ['READY', 'RUNNING', 'SUCCEEDED']) emit('step', { state: value }, { step_id: 'P11', execution_id: 'mock:P11:c2:a1' });
      state('READY'); state('RUNNING'); startChild(); mark('waiting'); late(old); mark('stale'); complete(); state('SUCCEEDED'); p12Passed = true; mark('recovered'); suffix();
    } else if (id === 'agent-child-interrupted') {
      startChild(); terminal('interrupted'); mark('interrupted'); send('child_collect'); mark('collected');
      emit('infra_error', { operation: 'agent', now_ms: 1000 }); emit('retry', { now_ms: 11000 }); state('READY'); mark('denied-retry');
    } else {
      startChild(); const status = id === 'agent-child-canceled' ? 'canceled' : 'failed';
      const failed = terminal(status); if (id !== 'agent-child-retry-limit') mark(status); send('child_collect'); if (id !== 'agent-child-retry-limit') mark('collected');
      if (status === 'canceled') {
        const p = failed.payload;
        emit('child_recovery', { actor: 'mock:human', coordinator_task_id: p.coordinator_task_id,
          coordinator_execution_id: p.coordinator_execution_id, child_execution_id: p.child_execution_id,
          task_id: `mock:child-recovery:${p.child_execution_id}`, result_evidence_id: p.evidence_id, action: 'retry', reason_id: `mock:${id}:recovery-reason`,
          candidate_fingerprint: p.candidate_fingerprint, requirements_version: p.requirements_version, evidence_id: `mock:${id}:human-recovery` });
        mark('recovery-approved'); state('READY'); state('RUNNING');
      }
      emit('infra_error', { operation: 'agent', now_ms: 1000 }); mark(id === 'agent-child-retry-limit' ? 'backoff-one' : 'backoff');
      advanceRetry(11000); mark(id === 'agent-child-retry-limit' ? 'attempt-two' : 'retried');
      if (id === 'agent-child-retry-limit') {
        state('RUNNING'); startChild(); terminal('failed'); send('child_collect'); emit('infra_error', { operation: 'agent', now_ms: 12000 }); mark('backoff-two');
        advanceRetry(42000); mark('attempt-three'); state('RUNNING'); startChild(); terminal('failed'); send('child_collect');
        emit('infra_error', { operation: 'agent', now_ms: 43000 }); mark('capped'); emit('retry', { now_ms: 100000 }); mark('blocked-four');
      } else {
        late(failed); if (id === 'agent-child-failure') mark('stale');
        state('RUNNING'); startChild(); complete(); state('SUCCEEDED'); p12Passed = true; mark('recovered'); suffix();
      }
    }
    mark('end');
    return { id, title, catalog_version: childCatalogVersion, requirement_ids: ['REQ-01', 'REQ-02', 'REQ-05', 'REQ-06', 'REQ-10', 'REQ-11', 'REQ-12', 'REQ-13', 'REQ-14'], events, checkpoints };
  });
}
