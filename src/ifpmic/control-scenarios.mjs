// Fixed synthetic authoring. Command revisions count declared accepted transactions;
// no replay result is consulted to choose events, checkpoints or expected outcomes.
const clone = value => structuredClone(value);
export const controlCatalogVersion = 'mock:ifpmic:controls:v1';
const image = Object.freeze({ candidate: 'mock:cancel-flash-unknown:candidate:c1',
  alias: 'mock:cancel-flash-unknown:image:c1', device: 'mock:cancel-flash-unknown:device',
  bridge: 'mock:cancel-flash-unknown:bridge', boot: 'mock:cancel-flash-unknown:boot:c1',
  digest: '38a3b557f6c86100a0180fd612c57332aa650ee4cf43abe5e1674726c2bf165b' });
const is = (type, node, state) => event => event.type === type && event.step_id === node
  && (state === undefined || event.payload.state === state);
const replaceCandidate = value => {
  if (typeof value === 'string') return value === 'mock:candidate:A' ? image.candidate : value;
  if (Array.isArray(value)) return value.map(replaceCandidate);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceCandidate(child)]));
  return value;
};
function author(template, id, title, registeredImage = false) {
  const base = JSON.parse(JSON.stringify(template.events).replaceAll(template.id, id));
  if (registeredImage) {
    const candidateIndex = base.findIndex(is('step', 'P13', 'RUNNING')) + 1;
    if (candidateIndex === 0) throw new Error('Missing P13 candidate authoring anchor');
    base.splice(candidateIndex, 0, { type: 'candidate', mode: 'mock', step_id: 'P13', cycle: 1, attempt: 1,
      execution_id: 'mock:P13:c1:a1', payload: { candidate_fingerprint: image.candidate } });
    for (let n = candidateIndex; n < base.length; n++) base[n] = replaceCandidate(base[n]);
    const ctx = base.find(is('sqe_context', 'P22')).payload;
    Object.assign(ctx, { image_hash: image.alias, expected_image_identity: image.boot, device_id: image.device, bridge_id: image.bridge });
  }
  const events = [], checkpoints = [{ id: 'start', title: '처음 · MOCK', cursor: 0 }];
  let index = 0, revision = 0, serial = 0, candidate = 'mock:candidate:A';
  const attempts = {};
  const uid = name => `mock:${id}:control:${name}:${++serial}`;
  const mark = name => checkpoints.push({ id: name, title: `${name} · MOCK`, cursor: events.length });
  function add(event, changed = true) {
    const value = clone(event);
    value.event_id = uid('event'); value.source_id = 'mock:controls-catalog'; value.source_seq = events.length + 1;
    value.job_id = `mock:${id}`;
    events.push(value);
    if (changed) revision++;
    return value;
  }
  const step = (type, node, payload, changed = true) => add({ type, mode: 'mock', step_id: node, cycle: 1,
    attempt: attempts[node] ?? 1, execution_id: `mock:${node}:c1:a${attempts[node] ?? 1}`, payload }, changed);
  const state = (node, value, changed = true) => step('step', node, { state: value }, changed);
  const job = (type, payload, changed = true) => add({ type, mode: 'mock', payload }, changed);
  function raw(event) {
    let value = clone(event);
    const node = value.step_id;
    if (attempts[node] && attempts[node] !== value.attempt) {
      const old = `:${node}:c1:a${value.attempt}`, next = `:${node}:c1:a${attempts[node]}`;
      const adjusted = JSON.parse(JSON.stringify(value).replaceAll(old, next));
      adjusted.attempt = attempts[node];
      if (adjusted.payload.evidence?.step_id === node) adjusted.payload.evidence.attempt = attempts[node];
      value = adjusted;
    }
    let changed = !(value.type === 'agent' && node === 'P12');
    if (value.type === 'candidate') { changed = candidate !== value.payload.candidate_fingerprint; candidate = value.payload.candidate_fingerprint; }
    return add(value, changed);
  }
  function through(predicate) {
    while (index < base.length) { const event = base[index++], value = raw(event); if (predicate(value)) return value; }
    throw new Error(`Missing control authoring anchor: ${id}`);
  }
  function finish() { while (index < base.length) raw(base[index++]); }
  function submit(action, key = action, expected = revision) {
    return job('control_submitted', { command_id: `mock:${id}:command:${key}`, actor: 'mock:human',
      route: `/jobs/mock:${id}/controls`, idempotency_key: `mock:${id}:key:${key}`,
      authorization_ref: 'mock:authorization:owner-control:v1', csrf_ref: 'mock:csrf:validated:v1',
      body: { expected_revision: expected, action, reason: `mock:${id}:reason:${key}` } }, false);
  }
  function apply(command, changed = true, now = 1000) {
    return job('control_apply', { command_id: command.payload.command_id, actor: 'mock:system',
      observed_now_ms: now, evidence_id: uid('apply') }, changed);
  }
  const command = (action, key = action, now = 1000) => { const submission = submit(action, key); apply(submission, true, now); return submission; };
  function pause() {
    const c = command('pause'); job('control_pause_ack', { command_id: c.payload.command_id, actor: 'mock:system',
      fence_id: uid('pause-fence'), drained_request_ids: [], evidence_id: uid('pause-ack') }); return c;
  }
  function end(c, kind, node, execution, status = 'canceled', prior = null) {
    return job('control_execution_end', { actor: 'mock:adapter', control_command_id: c.payload.command_id,
      kind, step_id: node, cycle: 1, attempt: attempts[node] ?? 1,
      step_execution_id: `mock:${node}:c1:a${attempts[node] ?? 1}`, agent_execution_id: execution,
      status, prior_result_evidence_id: prior, evidence_id: uid('end') });
  }
  function boundary(c, ends = [], extras = {}, changed = true) {
    return job('control_cancel_boundary', { command_id: c.payload.command_id, actor: 'mock:system',
      fence_id: `mock:${id}:cancel-fence`, drained_request_ids: [], execution_result_ids: ends.map(event => event.payload.evidence_id),
      bridge_reconciliation_ids: [], bridge_release_ids: [], remote_terminal_ids: [], ...extras, evidence_id: uid('boundary') }, changed);
  }
  const complete = (c, b) => job('control_cancel_complete', { command_id: c.payload.command_id, actor: 'mock:system',
    boundary_evidence_id: b.payload.evidence_id, evidence_id: uid('cancel-complete') });
  const proof = type => clone(base.find(event => event.type === type).payload);
  function bridge(action = 'flash_profile') {
    const command = { command_id: uid('bridge-command'), job_id: `mock:${id}`, step_id: 'P22', cycle: 1, attempt: 1,
      bridge_id: image.bridge, device_id: image.device, lease_id: uid('lease'), fencing_token: 0, action,
      profile_ref: action === 'flash_profile' ? 'mock:bridge:flash' : 'mock:bridge:sqe', profile_version: 'mock:bridge:profile:v1',
      artifact_id: action === 'flash_profile' ? `mock:artifact:image:${image.digest}` : null,
      artifact_sha256: action === 'flash_profile' ? image.digest : null, deadline: '2026-10-16T00:00:00.000Z', idempotency_key: uid('bridge-key') };
    job('bridge_registered', { actor: 'mock:bridge', command, step_execution_id: 'mock:P22:c1:a1',
      candidate_fingerprint: image.candidate, requirements_version: 'mock:requirements:v1', evidence_id: uid('bridge-registration') });
    return command;
  }
  function bridgeResult(c, seq, status, overrides = {}, changed = true) {
    const terminal = ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(status);
    return job('bridge_observed', { actor: 'mock:bridge', command_id: c.command_id, lease_id: c.lease_id,
      fencing_token: c.fencing_token, bridge_id: c.bridge_id, device_id: c.device_id, sequence: seq, state: status,
      observed_mode: 'adb', device_identity: c.device_id, exit_code: status === 'SUCCEEDED' ? 0 : null,
      stdout_artifact_id: terminal ? uid('bridge-stdout') : null, stderr_artifact_id: terminal ? uid('bridge-stderr') : null,
      test_result_artifact_id: null, image_identity: image.boot, started_at: status === 'ACKED' ? null : 0,
      finished_at: terminal ? 2000 : null, evidence_id: uid('bridge-result'), ...overrides }, changed);
  }
  function remoteIntent() {
    const m = proof('manifest');
    return job('remote_intent', { actor: 'mock:publisher', operation_key: uid('remote-operation'), manifest_id: m.manifest_id,
      digest: m.digest, candidate_fingerprint: m.candidate_fingerprint, rule_version: m.rule_version, destination: m.destination,
      step_id: 'P25', cycle: 1, attempt: 1, execution_id: 'mock:P25:c1:a1', evidence_id: uid('remote-intent') });
  }
  const remoteQuery = (intent, seq, outcome, receipt = null) => job('remote_observed', { actor: 'mock:publisher',
    operation_key: intent.payload.operation_key, query_seq: seq, outcome, manifest_id: intent.payload.manifest_id,
    digest: intent.payload.digest, candidate_fingerprint: intent.payload.candidate_fingerprint, cycle: 1, attempt: 1,
    execution_id: 'mock:P25:c1:a1', receipt_id: receipt, evidence_id: uid('remote-query') });
  function result() {
    mark('end');
    return { id, title: `${title} · MOCK`, catalog_version: controlCatalogVersion, mode: 'mock',
      requirement_ids: ['REQ-02', 'REQ-05', 'REQ-06', 'REQ-08', 'REQ-10', 'REQ-11', 'REQ-12', 'REQ-13', 'REQ-14'], events, checkpoints };
  }
  return { id, base, events, mark, state, step, job, raw, through, finish, submit, apply, command, pause, end, boundary, complete,
    proof, bridge, bridgeResult, remoteIntent, remoteQuery, result, uid, attempts,
    consume(type, node) { while (index < base.length) { const value = base[index++]; if (is(type, node)(value)) return clone(value); } throw new Error('Missing consumed event'); },
    get revision() { return revision; } };
}
export function createControlScenarios(template) {
  const cases = [];
  const make = (id, title, run, registeredImage = false) => { const f = author(template, id, title, registeredImage); run(f); cases.push(f.result()); };
  make('control-command-lifecycle', '명령 접수·적용·일시정지·재개', f => {
    f.through(is('step', 'P01', 'RUNNING')); const c = f.submit('pause'); f.mark('accepted');
    f.apply(c); f.mark('requested'); f.job('control_pause_ack', { command_id: c.payload.command_id, actor: 'mock:system',
      fence_id: f.uid('fence'), drained_request_ids: [], evidence_id: f.uid('ack') }); f.mark('paused');
    f.command('resume'); f.mark('resumed'); f.finish();
  });
  make('control-command-conflicts', '동일 revision 경합·중복·멱등 충돌', f => {
    f.through(is('step', 'P07', 'WAITING_HUMAN')); const r = f.revision;
    const one = f.submit('pause', 'one', r), two = f.submit('pause', 'two', r); f.mark('accepted');
    f.apply(one); f.mark('applied-one'); f.apply(two, false); f.mark('rejected-two');
    f.job('control_pause_ack', { command_id: one.payload.command_id, actor: 'mock:system', fence_id: f.uid('fence'), drained_request_ids: [], evidence_id: f.uid('ack') });
    f.job('control_submitted', one.payload, false); f.mark('duplicate');
    const conflict = clone(one.payload); conflict.body.reason = f.uid('different-reason');
    f.job('control_submitted', conflict, false); f.mark('body-conflict');
  });
  make('control-apply-after-progress', '접수 뒤 단계 이동·적용 시 revision 검사', f => {
    f.through(is('step', 'P01', 'RUNNING')); const c = f.submit('pause'); f.mark('submitted');
    f.through(is('step', 'P01', 'SUCCEEDED')); f.mark('advanced'); f.apply(c, false); f.mark('rejected');
  });
  make('pause-human', '일시정지 중 기존 사람 제출·새 frontier 재개', f => {
    f.through(is('step', 'P07', 'WAITING_HUMAN')); f.pause(); f.mark('paused');
    f.through(is('human', 'P07')); f.mark('submitted'); f.through(is('step', 'P07', 'SUCCEEDED')); f.mark('finished');
    f.command('resume'); f.mark('resumed'); f.finish();
  });
  make('pause-child', '일시정지 중 TC 반환·수집·통합 차단', f => {
    f.through(is('child_assignment', 'P12')); f.pause(); f.mark('paused');
    f.through(is('child_result', 'P12')); f.mark('returned'); f.through(is('child_collect', 'P12')); f.mark('collected');
    f.step('child_integrated', 'P12', f.proof('child_integrated'), false);
    f.step('child_request', 'P12', f.proof('child_request'), false); f.mark('blocked');
    f.command('resume'); f.mark('resumed'); f.finish();
  });
  make('pause-manual-sqe', '일시정지 중 수동 SQE 제출·동일 실행 재개', f => {
    f.through(is('sqe_context', 'P22'));
    f.step('manual_request', 'P22', { actor: 'mock:sqe', task_id: 'mock:manual:P22:c1:a1', assignee: 'mock:human',
      performer_id: 'mock:performer:sqe', reason_id: f.uid('manual-reason'), requested_at_ms: 1000, evidence_id: f.uid('manual-request') });
    f.pause(); f.mark('paused'); const original = f.consume('sqe_result', 'P22');
    f.step('sqe_result', 'P22', { ...original.payload, actor: 'mock:human', execution_mode: 'manual', task_id: 'mock:manual:P22:c1:a1',
      performer_id: 'mock:performer:sqe', started_at_ms: 1000, finished_at_ms: 2000 }); f.mark('submitted');
    f.state('P22', 'RUNNING', false); f.mark('blocked'); f.command('resume'); f.mark('resumed');
    f.state('P22', 'RUNNING'); f.finish();
  });
  make('pause-device-wait', '장비 대기·등록 lease를 보존하는 재개', f => {
    f.through(is('sqe_context', 'P22')); f.bridge('run_sqe_profile'); f.state('P22', 'WAITING_DEVICE');
    f.pause(); f.mark('paused'); f.command('resume'); f.mark('resumed');
  }, true);
  make('pause-retry', '인프라 deadline 유지·재개 뒤 전용 retry', f => {
    f.through(is('step', 'P13', 'RUNNING')); f.step('infra_error', 'P13', { now_ms: 0, operation: 'build' });
    f.pause(); f.mark('paused'); f.step('retry', 'P13', { now_ms: 10000 }, false); f.mark('due-blocked');
    f.command('resume', 'resume', 10000); f.mark('resumed'); f.command('retry', 'retry', 10000);
    f.attempts.P13 = 2; f.mark('retried'); f.state('P13', 'RUNNING'); f.finish();
  });
  make('pause-final', '마지막 단계 완료를 보존하고 재실행 없이 재개', f => {
    f.through(is('step', 'P26', 'RUNNING')); f.pause(); f.mark('paused'); f.finish(); f.mark('finished');
    f.command('resume'); f.mark('resumed');
  });
  make('cancel-child', '취소 중 TC 패치 보존·부모와 자식 종료 확인', f => {
    f.through(is('child_assignment', 'P12')); const c = f.command('cancel'); f.mark('requested');
    const returned = f.through(is('child_result', 'P12')); f.mark('returned');
    f.step('child_integrated', 'P12', f.proof('child_integrated'), false); f.state('P12', 'SUCCEEDED', false); f.mark('blocked');
    const parent = f.proof('p12_coordinator'), child = f.proof('child_assignment');
    const ends = [f.end(c, 'coordinator', 'P12', parent.coordinator_execution_id),
      f.end(c, 'child', 'P12', child.child_execution_id, 'completed', returned.payload.evidence_id)];
    const b = f.boundary(c, ends); f.mark('quiescent'); f.complete(c, b); f.mark('canceled');
  });
  make('cancel-flash-unknown', 'Flash 불명확·정확한 조정과 lock/lease 해제', f => {
    f.through(is('sqe_context', 'P22')); const bridge = f.bridge(); f.mark('registered');
    f.bridgeResult(bridge, 1, 'ACKED'); f.bridgeResult(bridge, 2, 'RUNNING'); f.bridgeResult(bridge, 3, 'UNKNOWN'); f.mark('unknown');
    const c = f.command('cancel'); f.mark('requested');
    f.bridgeResult(bridge, 4, 'SUCCEEDED', { device_identity: 'mock:wrong-device' }, false);
    f.step('device', 'P22', { mode: 'mock', now_ms: 2000, last_heartbeat_ms: 2000, lease_expires_ms: 60000, operation_state: 'idle' }, false);
    f.boundary(c, [], {}, false); f.mark('rejected'); const terminal = f.bridgeResult(bridge, 4, 'SUCCEEDED');
    const reconciliation = f.job('bridge_reconciled', { actor: 'mock:bridge', command_id: bridge.command_id, lease_id: bridge.lease_id,
      fencing_token: bridge.fencing_token, bridge_id: bridge.bridge_id, device_id: bridge.device_id,
      result_evidence_id: terminal.payload.evidence_id, query_seq: 4, safe_boundary: true, observed_mode: 'adb',
      device_identity: bridge.device_id, os_lock_held: true, evidence_id: f.uid('bridge-reconciled') }); f.mark('reconciled');
    const release = f.job('bridge_released', { actor: 'mock:system', command_id: bridge.command_id, lease_id: bridge.lease_id,
      fencing_token: bridge.fencing_token, reconciliation_evidence_id: reconciliation.payload.evidence_id,
      os_lock_released: true, lease_released: true, evidence_id: f.uid('bridge-release') }); f.mark('released');
    const end = f.end(c, 'logical', 'P22', 'mock:P22:c1:a1');
    const b = f.boundary(c, [end], { bridge_reconciliation_ids: [reconciliation.payload.evidence_id], bridge_release_ids: [release.payload.evidence_id] });
    f.complete(c, b); f.mark('canceled');
  }, true);
  make('cancel-remote-late-receipt', '원격 취소 중 영수증 보존·늦은 결과 분리', f => {
    f.through(is('step', 'P25', 'RUNNING')); const intent = f.remoteIntent(); f.mark('intent');
    f.remoteQuery(intent, 1, 'unknown'); const c = f.command('cancel'); f.mark('requested');
    const receipt = f.uid('receipt'), query = f.remoteQuery(intent, 2, 'found', receipt); f.mark('receipt');
    const p = intent.payload;
    const terminal = f.job('remote_terminal', { actor: 'mock:publisher', operation_key: p.operation_key, manifest_id: p.manifest_id,
      digest: p.digest, candidate_fingerprint: p.candidate_fingerprint, cycle: 1, attempt: 1, execution_id: p.execution_id,
      query_evidence_id: query.payload.evidence_id, provider_state: 'completed', receipt_id: receipt, safe_boundary: true, evidence_id: f.uid('remote-terminal') });
    const end = f.end(c, 'logical', 'P25', 'mock:P25:c1:a1', 'completed');
    const b = f.boundary(c, [end], { remote_terminal_ids: [terminal.payload.evidence_id] }); f.mark('quiescent');
    f.complete(c, b); f.mark('canceled'); f.remoteQuery(intent, 3, 'found', receipt); f.mark('late');
  });
  make('cancel-pending-dispatch', '미할당 요청의 dispatch fence·drain 확인', f => {
    const pending = f.through(is('child_request', 'P12')); f.mark('pending'); const c = f.command('cancel'); f.mark('requested');
    f.step('child_assignment', 'P12', f.proof('child_assignment'), false); f.boundary(c, [], {}, false); f.mark('blocked');
    const end = f.end(c, 'coordinator', 'P12', f.proof('p12_coordinator').coordinator_execution_id);
    const b = f.boundary(c, [end], { drained_request_ids: [pending.payload.request_id] }); f.mark('drained');
    f.complete(c, b); f.mark('canceled');
  });
  make('cancel-released-notes', '이미 발행된 작업 취소·노트 실패 이력 보존', f => {
    f.through(is('step', 'P26', 'RUNNING')); f.step('notes_failure', 'P26', { evidence_id: f.uid('notes-failure') }); f.mark('failed');
    const c = f.command('cancel'); f.mark('requested'); const b = f.boundary(c); f.complete(c, b); f.mark('canceled');
    const retry = f.submit('retry'); f.apply(retry, false); f.state('P25', 'RUNNING', false); f.mark('blocked');
  });
  make('control-notes-retry', 'typed 노트 실패에서 P26만 새 attempt로 재시도', f => {
    f.through(is('step', 'P26', 'RUNNING')); f.step('notes_failure', 'P26', { evidence_id: f.uid('notes-failure') }); f.mark('failed');
    const retry = f.submit('retry'); f.mark('accepted'); f.apply(retry); f.attempts.P26 = 2; f.mark('retried');
    f.state('P26', 'RUNNING'); f.finish(); f.mark('completed');
  });
  return cases;
}
