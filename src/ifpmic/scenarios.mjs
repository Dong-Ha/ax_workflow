import { replayScenario } from './replay.mjs';
import { mockHumanTaskId } from './protocols.mjs';

const requirements = ['REQ-02', 'REQ-05', 'REQ-08', 'REQ-10', 'REQ-12', 'REQ-14'];
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

// Fixture authoring coordinates, not an execution engine. Only synthetic literals leave this file.
function fixture(id, title, workflow) {
  const nodes = new Map(workflow.nodes.map(node => [node.id, node]));
  const events = [], checkpoints = [{ id: 'start', title: '처음 · MOCK', cursor: 0 }];
  let cycle = 1, current = 'P01', sequence = 0;
  const attempts = Object.fromEntries(workflow.nodes.map(node => [node.id, 1]));
  let manifest;
  const candidate = 'mock:candidate:A';
  const emit = (type, step_id, payload, overrides = {}) => {
    const event = { event_id: `mock:${id}:e${++sequence}`, source_id: 'mock:catalog', source_seq: sequence,
      type, mode: 'mock', job_id: `mock:${id}`, step_id, cycle, attempt: attempts[step_id],
      execution_id: `mock:${step_id}:c${cycle}:a${attempts[step_id]}`, payload, ...overrides };
    events.push(event);
    return event;
  };
  const mark = (key, label) => checkpoints.push({ id: key, title: `${label} · MOCK`, cursor: events.length });
  const evidenceId = step => `mock:${id}:${step}:c${cycle}:a${attempts[step]}`;
  const state = (step, value) => emit('step', step, { state: value });
  const start = step => { state(step, 'READY'); state(step, 'RUNNING'); };
  const done = step => { state(step, 'SUCCEEDED'); current = nodes.get(step).on_pass; };
  const human = (step, decision = 'approve') => emit('human', step, {
    actor: 'mock:human', task_id: mockHumanTaskId(step, cycle, attempts[step]), plan_version: 'mock:plan:v1',
    evidence_id: evidenceId(step), decision,
  });
  const measurement = (step, verdict = 'PASS', extra = {}) => emit('measurement', step, {
    verdict, evidence: { mode: 'mock', job_id: `mock:${id}`, step_id: step, cycle,
      attempt: attempts[step], execution_id: `mock:${step}:c${cycle}:a${attempts[step]}`,
      candidate_fingerprint: candidate, rule_version: 'mock:rules:v1', evidence_id: evidenceId(step), complete: true, ...extra },
  });
  const material = () => {
    const key = `mock:${id}:c${cycle}:a${attempts.X02}`;
    manifest = { manifest_id: `${key}:manifest`, digest: `${key}:digest`, candidate_fingerprint: candidate,
      rule_version: 'mock:rules:v1', destination: 'mock:destination', notes_hash: `${key}:notes`, evidence_bundle: `${key}:bundle` };
    emit('manifest', 'X02', manifest);
  };
  const approval = (decision = 'approve', extra = {}) => emit('approval', 'X03', {
    actor: 'mock:human', task_id: mockHumanTaskId('X03', cycle, attempts.X03), plan_version: 'mock:plan:v1',
    evidence_id: evidenceId('X03'), manifest_id: manifest.manifest_id, digest: manifest.digest,
    candidate_fingerprint: candidate, decision, ...extra,
  });
  function run(step) {
    const node = nodes.get(step);
    start(step);
    if (node.owner === 'human') {
      state(step, 'WAITING_HUMAN');
      if (step === 'X03') approval(); else human(step);
    } else if (node.owner === 'system') measurement(step);
    else emit('agent', step, { status: 'completed' });
    if (step === 'X02') material();
    if (step === 'P25') emit('receipt', step, { manifest_id: manifest.manifest_id, digest: manifest.digest,
      candidate_fingerprint: candidate, receipt_id: `mock:${id}:receipt`, observed: true });
    done(step);
  }
  function until(target) {
    while (current !== target) {
      if (current === 'END') throw new Error('Invalid mock fixture target');
      run(current);
    }
  }
  function failure(step, outcome = 'business_fail') {
    until(step); start(step);
    const owner = nodes.get(step).owner;
    if (owner === 'system') measurement(step, 'FAIL');
    else if (owner === 'human') {
      state(step, 'WAITING_HUMAN');
      if (step === 'X03') approval(outcome);
      else human(step, outcome === 'design_change_needed' ? outcome : 'reject');
      mark('rejected', `${step} 사람 반려`);
    }
    emit('business_failure', step, { candidate_fingerprint: candidate, evidence_id: evidenceId(step) });
  }
  function route(step, target, outcome = 'business_fail', advance = true) {
    emit('route', step, { outcome, target, candidate_fingerprint: candidate, evidence_id: evidenceId(step) });
    if (advance) {
      if (outcome === 'reject_release_metadata') { attempts.X02++; attempts.X03++; }
      else { cycle++; Object.keys(attempts).forEach(key => { attempts[key] = 1; }); }
      current = target;
    }
  }
  return { events, mark, emit, state, start, done, human, measurement, material, approval, run, until, failure, route,
    retry(step, now) { emit('retry', step, { now_ms: now }); attempts[step]++; },
    nextAttempt(step) { attempts[step]++; },
    finish() { mark('end', '끝 관측'); return { id, title, requirement_ids: [...requirements], events, checkpoints }; },
  };
}

export function createScenarioCatalog(workflow, stateContract) {
  replayScenario({ id: 'catalog-contract', events: [] }, workflow, stateContract, 0);
  const catalog = [];
  const make = (id, title, build) => { const f = fixture(id, title, workflow); build(f); catalog.push(f.finish()); };
  make('happy-path', '정상 · 요구사항부터 최종 노트까지', f => {
    f.until('X01'); f.mark('planning', '요구사항과 실행 계획');
    f.until('P15'); f.mark('development', '개발과 TC 통합');
    f.until('X02'); f.mark('quality', '품질 판정 완료');
    f.run('X02'); f.run('X03'); f.mark('approved', '현재 명세 모의 승인');
    f.run('P25'); f.mark('published', '모의 영수증 확인');
    f.run('P26'); f.mark('completed', '모의 전체 완료');
  });
  for (const [id, step] of [['human-wait', 'P07'], ['human-wait-oss', 'P21']]) make(id, `${step} · 사람 제출 대기`, f => {
    f.until(step); f.start(step); f.state(step, 'WAITING_HUMAN'); f.mark('wait', '배정된 사람 작업 대기');
    f.emit('agent', step, { status: 'completed' }); f.mark('agent-completed', 'Agent 완료 관측');
    f.state(step, 'SUCCEEDED'); f.mark('blocked', '사람 증거 없이 성공 차단');
  });
  for (const [id, step, target, outcome, title] of [
    ['debug-failure', 'P13', 'P11', 'business_fail', '빌드·UT 실패 → 코드 수정'],
    ['review-failure', 'P14', 'P11', 'business_fail', '코드 리뷰 불합격 → 코드 수정'],
    ['sam-failure', 'P16', 'P07', 'business_fail', 'SAM 불합격 → 아키텍처 재검토'],
    ['tem-failure', 'P18', 'P11', 'business_fail', 'TEM 불합격 → 코드 수정'],
    ['static-failure', 'P20', 'P11', 'business_fail', '정적분석 불합격 → 코드 수정'],
    ['sqe-failure', 'P24', 'P07', 'business_fail', 'SQE 보고 후 불합격 → 설계 재검토'],
    ['oss-failure', 'P21', 'P11', 'business_fail', 'OSS 사람 반려 → 코드 수정'],
    ['oss-design-change', 'P21', 'P07', 'design_change_needed', 'OSS 설계 영향 → 아키텍처 재검토'],
    ['plan-rejection', 'X01', 'P02', 'rejected', '실행 계획 반려 → 요구사항 분석'],
    ['release-reject-code', 'X03', 'P11', 'reject_code', '배포 승인 반려 → 코드 수정'],
    ['release-reject-design', 'X03', 'P07', 'reject_design', '배포 승인 반려 → 설계 재검토'],
  ]) make(id, title, f => { f.failure(step, outcome); f.mark('failed', `${step} 실패 증거`); f.route(step, target, outcome); f.mark('returned', `${target} 복귀`); });
  make('metadata-recovery', '배포 자료 반려 · 품질 보존 후 수정 완료', f => {
    f.failure('X03', 'reject_release_metadata'); f.route('X03', 'X02', 'reject_release_metadata'); f.mark('returned', '같은 cycle의 자료 재작성');
    f.run('X02'); f.mark('corrected', '새 명세·digest 관측');
    f.run('X03'); f.mark('approved', '새 task의 모의 승인');
    f.run('P25'); f.run('P26'); f.mark('completed', '영수증 1회로 모의 완료');
  });
  make('metric-missing', '지표 누락 · exit 0으로 PASS를 추정하지 않음', f => {
    f.until('P16'); f.start('P16'); f.measurement('P16', 'PASS', { complete: false }); f.mark('incomplete', '측정 불완전');
    f.state('P16', 'SUCCEEDED'); f.mark('blocked', 'PASS 근거 부족으로 차단');
  });
  for (const id of ['stale-result', 'stale-candidate']) make(id, id === 'stale-result' ? '이전 cycle 결과 차단' : '다른 후보의 측정 차단', f => {
    f.until('P16'); f.start('P16');
    f.measurement('P16', 'PASS', id === 'stale-result' ? { cycle: 0 } : { candidate_fingerprint: 'mock:candidate:old' });
    f.mark('stale', '과거 증거 거절'); f.state('P16', 'SUCCEEDED'); f.mark('blocked', '현재 gate 해제 없음');
  });
  make('stale-approval', '이전 digest의 승인 차단', f => {
    f.until('X03'); f.start('X03'); f.state('X03', 'WAITING_HUMAN');
    f.approval('approve', { digest: 'mock:digest:old' }); f.mark('stale', '현재 명세와 다른 승인 거절');
  });
  make('duplicate-events', '중복·충돌 사건 · 한 번만 표시', f => {
    const event = f.emit('step', 'P01', { state: 'READY' }); f.mark('first', '최초 관측');
    f.events.push(structuredClone(event), { ...structuredClone(event), event_id: 'mock:alias' },
      { ...structuredClone(event), payload: { state: 'RUNNING' } }); f.mark('duplicates', '중복 3 · 충돌 1');
  });
  make('retry-limit', '인프라 재시도 · 10초·30초 후 사람 판단', f => {
    f.until('P13'); f.start('P13'); f.emit('infra_error', 'P13', { now_ms: 0, operation: 'build' }); f.mark('wait-first', '10초 대기');
    f.emit('retry', 'P13', { now_ms: 9999 }); f.retry('P13', 10000); f.mark('attempt-two', '새 attempt 2');
    f.state('P13', 'RUNNING'); f.emit('infra_error', 'P13', { now_ms: 10000, operation: 'build' }); f.mark('wait-second', '30초 대기');
    f.emit('retry', 'P13', { now_ms: 39999 }); f.retry('P13', 40000);
    f.state('P13', 'RUNNING'); f.emit('infra_error', 'P13', { now_ms: 40000, operation: 'build' });
    f.emit('retry', 'P13', { now_ms: 70000 }); f.mark('limit', 'attempt 4 생성 없이 사람 대기');
  });
  make('cycle-limit', '재작업 한도 · 추가 3회 후 사람 판단', f => {
    for (let index = 0; index < 4; index++) {
      f.failure('P13'); f.route('P13', 'P11', 'business_fail', index < 3);
      f.mark(index < 3 ? ['return-one', 'return-two', 'return-three'][index] : 'limit', index < 3 ? `재작업 ${index + 1}` : '추가 복귀 차단');
    }
  });
  make('device-boundaries', '장비 · heartbeat·offline·lease 경계', f => {
    f.until('P22'); f.start('P22');
    for (const now of [9999, 10000, 10001, 29999, 30000, 30001, 59999, 60000, 60001]) {
      f.emit('device', 'P22', { mode: 'mock', now_ms: now, last_heartbeat_ms: 0, lease_expires_ms: 60000, operation_state: 'active' });
      f.mark(`time-${now}`, `${now}ms 관측`);
    }
  });
  make('flash-unknown', '장비 작업 불명확 · 격리 유지', f => {
    f.until('P22'); f.start('P22');
    f.emit('device', 'P22', { mode: 'mock', now_ms: 5000, last_heartbeat_ms: 0, lease_expires_ms: 60000, operation_state: 'unknown' }); f.mark('unknown', '작업 결과 불명확');
    f.emit('device', 'P22', { mode: 'mock', now_ms: 10000, last_heartbeat_ms: 10000, lease_expires_ms: 60000, operation_state: 'idle' }); f.mark('idle', '새 idle 관측만으로 격리 해제하지 않음');
  });
  make('notes-only', '발행 뒤 노트 실패 · 노트만 재시도', f => {
    f.until('P26'); f.start('P26'); f.emit('notes_failure', 'P26', { evidence_id: 'mock:notes:failure' }); f.mark('notes-failed', '발행 완료 · 노트 대기');
    f.emit('notes_retry', 'P26', { evidence_id: 'mock:notes:retry' }); f.mark('notes-retry', '노트 새 attempt');
    // notes_retry creates READY, rather than a new business cycle or publication.
    f.nextAttempt('P26'); f.state('P26', 'RUNNING'); f.state('P26', 'SUCCEEDED');
    f.mark('completed', '노트만 모의 완료');
  });
  return freeze(catalog);
}
