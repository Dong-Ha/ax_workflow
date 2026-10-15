// Synthetic authoring only: fixed template events, never replay-derived decisions.
const clone = value => structuredClone(value);
export function createSqeUiScenarios(template) {
  const entries = [
    ['sqe-manual-pass', 'SQE 수동 수행 · 배정에서 모의 완료까지'],
    ['sqe-manual-fail', 'SQE 수동 FAIL · 수집·보고 뒤 설계 복귀'],
    ['sqe-incomplete', 'SQE 필수 사례 누락 · 불완전 판정'],
    ['sqe-parser-error', 'SQE 파서 오류 · 품질 FAIL과 구분'],
    ['sqe-identity-mismatch', 'SQE 부팅 이미지 불일치 · 통과 차단'],
    ['sqe-manual-retry', 'SQE 수동 인프라 오류 · 새 배정과 재시도'],
    ['sqe-report-retry', 'SQE 보고 재시도 · 과거 보고서 거절'],
    ['sqe-judgment-retry', 'SQE 판정 재시도 · 과거 판정 거절'],
    ['sqe-manual-quarantine', 'SQE 수동 수행 중 장비 불명확 · 격리 유지'],
  ];
  return entries.map(([id, title]) => {
    const base = JSON.parse(JSON.stringify(template.events).replaceAll('happy-path', id));
    const events = [], checkpoints = [{ id: 'start', title: '처음 · MOCK', cursor: 0 }];
    const attempts = { P22: 1, P23: 1, P24: 1 };
    let index = 0;
    const mark = key => checkpoints.push({ id: key, title: `${key} · MOCK`, cursor: events.length });
    const proofId = (kind, node = 'P22') => `mock:${id}:sqe:${kind}:c1:a${attempts[node]}`;
    const emit = (type, step_id, payload) => {
      const event = { event_id: '', source_id: 'mock:sqe-ui', source_seq: 0, type, mode: 'mock',
        job_id: `mock:${id}`, step_id, cycle: 1, attempt: attempts[step_id] ?? 1,
        execution_id: `mock:${step_id}:c1:a${attempts[step_id] ?? 1}`, payload: clone(payload) };
      events.push(event); return event;
    };
    const step = (node, state) => emit('step', node, { state });
    const copyThrough = predicate => {
      while (index < base.length) {
        const event = clone(base[index++]);
        events.push(event);
        if (predicate(event)) return event;
      }
      throw new Error(`Missing SQE UI authoring anchor ${id}`);
    };
    const is = (type, node, state) => event => event.type === type && event.step_id === node
      && (state === undefined || event.payload.state === state);
    const contextTemplate = base.find(is('sqe_context', 'P22')).payload;
    const resultTemplate = base.find(is('sqe_result', 'P22')).payload;
    const reportTemplate = base.find(is('sqe_report', 'P23')).payload;
    const measurementTemplate = base.find(is('measurement', 'P24')).payload;
    const context = () => ({ ...clone(contextTemplate), evidence_id: proofId('context') });
    const request = () => emit('manual_request', 'P22', { actor: 'mock:sqe', assignee: 'mock:human',
      performer_id: 'mock:performer:sqe', task_id: `mock:manual:P22:c1:a${attempts.P22}`,
      reason_id: `mock:${id}:manual-reason`, requested_at_ms: attempts.P22 === 2 ? 16000 : 1000,
      evidence_id: `mock:${id}:ui:manual-request:a${attempts.P22}` });
    const result = (manual = false, extra = {}) => ({ ...clone(resultTemplate),
      evidence_id: proofId('result'), stdout_artifact_id: proofId('stdout'), stderr_artifact_id: proofId('stderr'),
      result_artifact_id: proofId('results'), ...(manual ? { actor: 'mock:human', execution_mode: 'manual',
        performer_id: 'mock:performer:sqe', task_id: `mock:manual:P22:c1:a${attempts.P22}`,
        started_at_ms: attempts.P22 === 2 ? 16000 : 1000, finished_at_ms: attempts.P22 === 2 ? 17000 : 2000 } : {}), ...extra });
    const report = () => ({ ...clone(reportTemplate), result_evidence_id: proofId('result'),
      result_execution_id: `mock:P22:c1:a${attempts.P22}`, evidence_id: proofId('report', 'P23'),
      report_artifact_id: proofId('report-artifact', 'P23'), report_link_id: proofId('report-link', 'P23') });
    const measurement = (verdict = 'PASS', complete = true) => ({ verdict, evidence: {
      ...clone(measurementTemplate.evidence), attempt: attempts.P24, execution_id: `mock:P24:c1:a${attempts.P24}`,
      evidence_id: `mock:${id}:P24:c1:a${attempts.P24}`, complete } });
    const backoff = node => {
      emit('infra_error', node, { operation: 'agent', now_ms: 5000 }); mark('backoff');
      emit('retry', node, { now_ms: 15000 }); attempts[node] = 2; mark('retried');
      step(node, 'RUNNING');
    };
    copyThrough(is('step', 'P22', 'RUNNING'));
    // Replace the three SQE proofs from the source template with this scenario's explicit proofs.
    copyThrough(is('sqe_context', 'P22')); events.pop(); emit('sqe_context', 'P22', context());
    const manual = id.startsWith('sqe-manual-');
    if (manual) {
      request(); if (id !== 'sqe-manual-fail') mark('waiting');
      if (id === 'sqe-manual-quarantine') {
        emit('device', 'P22', { mode: 'mock', now_ms: 5000, last_heartbeat_ms: 0,
          lease_expires_ms: 60000, operation_state: 'unknown' }); mark('quarantined');
        emit('sqe_result', 'P22', result(true)); mark('blocked');
      } else {
        if (id === 'sqe-manual-pass') {
          emit('sqe_result', 'P22', result(true, { task_id: 'mock:wrong-task' })); mark('rejected');
        }
        const first = result(true, id === 'sqe-manual-retry' ? { execution_status: 'infrastructure_error' }
          : id === 'sqe-manual-fail' ? { exit_code: 1, cases: [
            { case_id: 'mock:sqe:case:boot', outcome: 'PASS' }, { case_id: 'mock:sqe:case:function', outcome: 'FAIL' }] } : {});
        emit('sqe_result', 'P22', first); mark('submitted'); step('P22', 'RUNNING');
        if (id === 'sqe-manual-retry') {
          backoff('P22'); emit('sqe_context', 'P22', context()); request(); mark('waiting-two');
          emit('sqe_result', 'P22', first); mark('stale');
          emit('sqe_result', 'P22', result(true)); mark('submitted-two'); step('P22', 'RUNNING');
        }
      }
    } else {
      const proof = result();
      if (id === 'sqe-incomplete') proof.cases = [{ case_id: 'mock:sqe:case:boot', outcome: 'PASS' }];
      if (id === 'sqe-parser-error') { proof.parser_status = 'error'; proof.exit_code = null; }
      if (id === 'sqe-identity-mismatch') proof.observed_image_identity = `mock:${id}:different-boot`;
      emit('sqe_result', 'P22', proof);
      if (['sqe-incomplete', 'sqe-parser-error', 'sqe-identity-mismatch'].includes(id)) mark('collected');
    }
    if (id !== 'sqe-manual-quarantine') {
      // Omit the original bridge result; resume the unchanged source sequence after it.
      while (!is('sqe_result', 'P22')(base[index])) {
        if (index >= base.length) throw new Error('SQE result anchor missing');
        events.push(clone(base[index++]));
      }
      index++;
      copyThrough(is('step', 'P23', 'RUNNING'));
      // P22 retry changes only P22 records and the report's result execution reference.
      for (const event of events) if (event.source_id !== 'mock:sqe-ui' && event.step_id === 'P22' && event.type !== 'sqe_context') {
        // Prefix events belong to attempt one; suffix begins at the original success/agent observation.
        if (attempts.P22 === 2 && ['agent', 'step'].includes(event.type)
          && (event.type === 'agent' || event.payload.state === 'SUCCEEDED')) {
          event.attempt = 2; event.execution_id = 'mock:P22:c1:a2';
        }
      }
      copyThrough(is('sqe_report', 'P23')); events.pop();
      const firstReport = emit('sqe_report', 'P23', report());
      if (id === 'sqe-report-retry') {
        mark('reported'); backoff('P23'); events.push(clone(firstReport)); mark('stale');
        emit('sqe_report', 'P23', report()); mark('reported-two');
      }
      copyThrough(is('step', 'P23', 'SUCCEEDED'));
      if (!['sqe-report-retry', 'sqe-judgment-retry', 'sqe-manual-retry'].includes(id)) mark('reported');
      copyThrough(is('measurement', 'P24')); events.pop();
      const verdict = id === 'sqe-parser-error' ? 'ERROR' : ['sqe-incomplete', 'sqe-identity-mismatch'].includes(id) ? 'INCONCLUSIVE'
        : id === 'sqe-manual-fail' ? 'FAIL' : 'PASS';
      const firstMeasurement = emit('measurement', 'P24', measurement(verdict, ['PASS', 'FAIL'].includes(verdict)));
      if (['ERROR', 'INCONCLUSIVE'].includes(verdict)) {
        step('P24', 'SUCCEEDED'); mark('blocked');
      } else if (verdict === 'FAIL') {
        mark('judged');
        emit('business_failure', 'P24', { candidate_fingerprint: 'mock:candidate:A', evidence_id: firstMeasurement.payload.evidence.evidence_id });
        emit('route', 'P24', { outcome: 'business_fail', target: 'P07', candidate_fingerprint: 'mock:candidate:A', evidence_id: firstMeasurement.payload.evidence.evidence_id });
        mark('rerouted');
      } else {
        if (id === 'sqe-judgment-retry') {
          mark('judged'); backoff('P24'); events.push(clone(firstMeasurement)); mark('stale');
          emit('measurement', 'P24', measurement()); mark('judged-two');
        }
        // Retain source events after the replaced measurement with fresh attempt coordinates.
        for (const event of base.slice(index)) {
          const value = clone(event);
          if (attempts[value.step_id] > 1) {
            value.attempt = attempts[value.step_id]; value.execution_id = `mock:${value.step_id}:c1:a${value.attempt}`;
          }
          events.push(value);
          if (value.step_id === 'P24' && value.type === 'step' && value.payload.state === 'SUCCEEDED'
            && !['sqe-judgment-retry', 'sqe-report-retry'].includes(id)) mark('judged');
        }
      }
      // Only the original P23 SUCCEEDED suffix needs updated retry coordinates.
      if (attempts.P23 === 2) {
        const success = events.find(event => event.source_id !== 'mock:sqe-ui' && is('step', 'P23', 'SUCCEEDED')(event));
        success.attempt = 2; success.execution_id = 'mock:P23:c1:a2';
      }
    }
    // Every new-source envelope receives a distinct transport ID; stale payload/envelope coordinates remain intact.
    let seq = 0;
    for (const event of events) if (event.source_id === 'mock:sqe-ui') {
      event.source_seq = ++seq; event.event_id = `mock:${id}:ui:e${seq}`;
    }
    mark('end');
    return { id, title, requirement_ids: ['REQ-01', 'REQ-02', 'REQ-04', 'REQ-05', 'REQ-06', 'REQ-07', 'REQ-08', 'REQ-10', 'REQ-12', 'REQ-14'], events, checkpoints };
  });
}
