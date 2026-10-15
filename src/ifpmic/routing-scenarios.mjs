// Synthetic, fixed event authoring only. Never derives decisions from replay snapshots.
import { mockHumanTaskId } from './protocols.mjs';
const reuseIds = ['P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10', 'P11', 'P12'];
const exemptions = ['P15', 'P16', 'P17', 'P18', 'P19', 'P20', 'P21', 'P22', 'P24'];
function fixture(id, title, workflow, profileKind = 'pilot', changeType = 'FEATURE') {
  const nodes = new Map(workflow.nodes.map(n => [n.id, n]));
  const attempts = Object.fromEntries(workflow.nodes.map(n => [n.id, 1]));
  const events = [], checkpoints = [{ id: 'start', title: '처음 · MOCK', cursor: 0 }];
  let cycle = 1, current = 'P01', sequence = 0, candidate = 'mock:candidate:A', context, manifest;
  const token = name => `mock:${id}:${name}:c${cycle}`;
  const evidence = step => token(`${step}:a${attempts[step]}`);
  const emit = (type, step_id, payload) => events.push({ event_id: token(`e${++sequence}`),
    source_id: 'mock:routing-catalog', source_seq: sequence, type, mode: 'mock', job_id: `mock:${id}`,
    step_id, cycle, attempt: attempts[step_id], execution_id: `mock:${step_id}:c${cycle}:a${attempts[step_id]}`, payload });
  const mark = (key, title) => checkpoints.push({ id: key, title: `${title} · MOCK`, cursor: events.length });
  const state = (step, state) => emit('step', step, { state });
  const start = step => { state(step, 'READY'); state(step, 'RUNNING'); };
  const done = step => { state(step, 'SUCCEEDED'); current = nodes.get(step).on_pass; };
  const human = (step, decision = 'approve') => emit('human', step, { actor: 'mock:human',
    task_id: mockHumanTaskId(step, cycle, attempts[step]), plan_version: context.plan_version,
    evidence_id: evidence(step), decision });
  const wait = step => { start(step); state(step, 'WAITING_HUMAN'); };
  const entry = step_id => ({ step_id,
    baseline_hash: step_id === 'P10' && changeType === 'NEW_HW' ? context.environment_hash : token(`baseline:${step_id}`),
    baseline_input_hash: context.input_hashes[step_id], current_input_hash: context.input_hashes[step_id], reason_id: token(`reuse:${step_id}`) });
  const proposal = () => ({ profile_id: token(`profile:${profileKind}`), profile_hash: token('profile-hash'),
    profile_kind: profileKind, change_type: changeType, plan_version: token('plan'), candidate_fingerprint: candidate,
    requirements_version: 'mock:requirements:v1', source_hash: token('source'), test_hash: token('tests'),
    environment_hash: token('environment'), baseline_environment_hash: token('environment'),
    input_hashes: Object.fromEntries(reuseIds.map(step => [step, token(`input:${step}`)])),
    policy_rule_id: profileKind === 'policy_demo' ? 'mock:policy:exempt:v1' : null,
    policy_approval_id: profileKind === 'policy_demo' ? token('policy-approved') : null });
  const measurement = step => emit('measurement', step, { verdict: 'PASS', evidence: {
    mode: 'mock', job_id: `mock:${id}`, step_id: step, cycle, attempt: attempts[step],
    execution_id: `mock:${step}:c${cycle}:a${attempts[step]}`, candidate_fingerprint: candidate,
    rule_version: 'mock:rules:v1', evidence_id: evidence(step), complete: true } });
  function run(step) {
    start(step);
    if (nodes.get(step).owner === 'human') {
      state(step, 'WAITING_HUMAN');
      if (step === 'X03') approval(); else human(step);
    } else if (nodes.get(step).owner === 'system') measurement(step);
    else emit('agent', step, { status: 'completed' });
    if (step === 'X02') material();
    if (step === 'P25') emit('receipt', step, { manifest_id: manifest.manifest_id, digest: manifest.digest,
      candidate_fingerprint: candidate, receipt_id: token('receipt'), observed: true });
    done(step);
  }
  function until(target) {
    while (current !== target) { if (current === 'END') throw new Error('Invalid routing fixture target'); run(current); }
  }
  const localProof = step => ({ actor: 'mock:human', task_id: `mock:reuse:${step}:c${cycle}:a${attempts[step]}`,
    plan_version: context.plan_version, candidate_fingerprint: candidate, requirements_version: context.requirements_version,
    ...Object.fromEntries(Object.entries(entry(step)).filter(([key]) => key !== 'step_id')), evidence_id: token(`local:${step}`) });
  const skip = (step, evidence_id = evidence('X01')) => { emit('skip', step, { evidence_id }); current = nodes.get(step).on_pass; };
  function begin({ early = true, localCheckpoint = false } = {}) {
    run('P01'); start('P02'); context = proposal(); emit('route_context', 'P02', context); done('P02');
    for (const step of ['P03', 'P04', 'P05']) {
      if (early) {
        emit('reuse_confirmation', step, localProof(step));
        if (step === 'P03' && localCheckpoint) mark('local', '개별 재사용 확인 · 전역 미승인');
        skip(step, token(`local:${step}`));
      } else run(step);
    }
  }
  function confirm(reuse = reuseIds, exempt = [], prior = ['P03', 'P04', 'P05'], extra = {}) {
    emit('plan_confirmation', 'X01', { actor: 'mock:human', task_id: mockHumanTaskId('X01', cycle, attempts.X01),
      plan_version: context.plan_version, candidate_fingerprint: candidate, requirements_version: context.requirements_version,
      evidence_id: evidence('X01'), plan_hash: token('plan-hash'), reason_id: token('plan-reason'),
      prior_reuse: prior.map(step_id => ({ step_id, evidence_id: token(`local:${step_id}`) })),
      reuse_steps: reuse.map(entry), exempt_steps: exempt, ...extra });
  }
  function approvePlan(reuse = reuseIds, exempt = [], prior) {
    wait('X01'); human('X01'); confirm(reuse, exempt, prior); done('X01');
  }
  const analysis = (step, extra = {}) => emit('unchanged_analysis', step, {
    actor: step === 'P11' ? 'mock:code-dev' : 'mock:tc', plan_version: context.plan_version,
    candidate_fingerprint: candidate, requirements_version: context.requirements_version,
    baseline_hash: step === 'P11' ? context.source_hash : context.test_hash,
    current_hash: step === 'P11' ? context.source_hash : context.test_hash,
    needs_changes: false, requirements_satisfied: true, evidence_id: token(`analysis:${step}`), ...extra });
  function reuseTo(target) {
    while (current !== target) {
      if (!reuseIds.includes(current)) throw new Error('Invalid routing reuse target');
      if (['P11', 'P12'].includes(current)) analysis(current);
      skip(current);
    }
  }
  function report() {
    emit('exemption_report', 'P23', { actor: 'mock:sqe', plan_version: context.plan_version,
      candidate_fingerprint: candidate, requirements_version: context.requirements_version,
      exemption_evidence_id: evidence('X01'), performed: false,
      report_id: token('sqe-unperformed-report'), evidence_id: token('sqe-report-evidence') });
  }
  function exemptQuality(checkpoints = false) {
    run('P13'); run('P14');
    for (const step of ['P15', 'P16', 'P17', 'P18', 'P19', 'P20', 'P21', 'P22']) {
      skip(step); if (step === 'P16' && checkpoints) mark('paired', '수행·판정 공동 면제');
    }
    start('P23');
    if (checkpoints) { state('P23', 'SUCCEEDED'); mark('report-blocked', '미수행 보고 없는 성공 차단'); }
    report(); done('P23'); if (checkpoints) mark('reported', 'SQE 시험 미수행 보고');
    skip('P24'); mark('exempt', '네 품질 처분 EXEMPT');
  }
  function material() {
    manifest = { manifest_id: evidence('X02') + ':manifest', digest: evidence('X02') + ':digest',
      candidate_fingerprint: candidate, rule_version: 'mock:rules:v1', destination: 'mock:destination',
      notes_hash: evidence('X02') + ':notes', evidence_bundle: evidence('X02') + ':bundle' };
    emit('manifest', 'X02', manifest);
  }
  const approval = (decision = 'approve') => emit('approval', 'X03', { actor: 'mock:human',
    task_id: mockHumanTaskId('X03', cycle, attempts.X03), plan_version: context.plan_version,
    evidence_id: evidence('X03'), manifest_id: manifest.manifest_id, digest: manifest.digest,
    candidate_fingerprint: candidate, decision });
  function failRoute(step, outcome, target, alreadyFailed = false) {
    if (!alreadyFailed) emit('business_failure', step, { candidate_fingerprint: candidate, evidence_id: evidence(step) });
    emit('route', step, { outcome, target, candidate_fingerprint: candidate, evidence_id: evidence(step) });
    if (outcome === 'reject_release_metadata') { attempts.X02++; attempts.X03++; }
    else { cycle++; Object.keys(attempts).forEach(key => { attempts[key] = 1; }); }
    current = target;
  }
  function close() {
    emit('no_change', 'P12', { actor: 'mock:human', task_id: `mock:no-change:P12:c${cycle}:a${attempts.P12}`,
      plan_version: context.plan_version, candidate_fingerprint: candidate, requirements_version: context.requirements_version,
      reason_id: token('no-change-reason'), evidence_id: token('no-change'),
      production_evidence_id: token('analysis:P11'), tests_evidence_id: token('analysis:P12'), reuse_evidence_id: evidence('X01') });
  }
  return { emit, mark, state, start, done, run, until, wait, human, begin, confirm, approvePlan, analysis, reuseTo,
    skip, exemptQuality, approval, failRoute, close,
    local: step => emit('reuse_confirmation', step, localProof(step)),
    change() { candidate = 'mock:candidate:B'; emit('candidate', 'P13', { candidate_fingerprint: candidate }); },
    recontext(stale = false) { if (!stale) context = proposal(); emit('route_context', 'P02', context); },
    finish() { mark('end', '끝 관측'); return { id, title,
      requirement_ids: ['REQ-01', 'REQ-02', 'REQ-03', 'REQ-04', 'REQ-05', 'REQ-06', 'REQ-10', 'REQ-12', 'REQ-14'], events, checkpoints }; },
  };
}
export function createRoutingScenarios(workflow) {
  const catalog = [];
  const make = (id, title, build, profile, change) => { const f = fixture(id, title, workflow, profile, change); build(f); catalog.push(f.finish()); };
  make('routing-reuse', '재사용 · 개별 확인에서 전체 모의 완료까지', f => {
    f.begin({ localCheckpoint: true }); f.mark('early', '선행 문서 재사용');
    f.approvePlan(); f.mark('confirmed', 'X01 항목별 계획 승인'); f.reuseTo('P13'); f.mark('reused', '문서·생산·TC 재사용'); f.until('END');
  });
  make('routing-new-hw', 'NEW_HW · 동일 환경 P10만 재사용', f => {
    // Begin P02 context, then show the forbidden P03 reuse before real document execution.
    f.run('P01'); f.start('P02'); f.recontext(); f.done('P02'); f.local('P03'); f.mark('early-blocked', 'NEW_HW 문서 재사용 차단');
    for (const step of ['P03', 'P04', 'P05']) f.run(step);
    f.approvePlan(['P10'], [], []); f.mark('confirmed', '동일 검증 환경만 승인');
    for (const step of ['P06', 'P07', 'P08', 'P09']) f.run(step);
    f.skip('P10'); f.mark('reused', 'P10 환경 재사용');
  }, 'pilot', 'NEW_HW');
  make('routing-exempt', '정책 면제 · SQE 보고와 EXEMPT 배포 관측', f => {
    f.begin(); f.approvePlan(reuseIds, exemptions); f.mark('confirmed', '사전 정책과 계획 승인');
    f.reuseTo('P13'); f.exemptQuality(true); f.until('END');
  }, 'policy_demo');
  make('routing-pilot-denied', '기본 정책 · 면제 승인과 생략 차단', f => {
    f.begin(); f.wait('X01'); f.human('X01'); f.confirm(reuseIds, ['P15', 'P16']); f.mark('denied', 'pilot 면제 승인 거절');
    f.confirm(); f.done('X01'); f.mark('confirmed', '면제 없는 계획 승인');
    f.reuseTo('P13'); f.run('P13'); f.run('P14'); f.emit('skip', 'P15', { evidence_id: 'mock:invented:exemption' }); f.mark('blocked', '기본 정책 면제 차단');
  });
  for (const denied of [false, true]) make(denied ? 'routing-no-change-denied' : 'routing-no-change', denied ? '무변경 거절 · TC 변경 필요' : '무변경 종료 · 생산·TC 분석과 사람 확인', f => {
    f.begin(); f.approvePlan(); f.reuseTo('P12'); f.mark('production', '생산 분석과 재사용');
    f.analysis('P12', { needs_changes: denied }); f.mark('analysed', '독립 TC 분석'); f.close();
    f.mark(denied ? 'denied' : 'closed', denied ? '변경 필요로 종료 차단' : '사람 확인 무변경 종료');
    if (!denied) { f.emit('agent', 'P12', { status: 'completed' }); f.mark('terminal', '종료 뒤 관측 차단'); }
  });
  make('routing-candidate', '후보 변경 · 이전 면제 만료와 새 PASS 검증', f => {
    f.begin(); f.approvePlan(reuseIds, exemptions); f.mark('confirmed', '후보 A 계획 승인'); f.reuseTo('P13');
    f.start('P13'); f.change(); f.mark('changed', '후보 B · 기존 권한 만료'); f.done('P13'); f.run('P14');
    f.emit('skip', 'P15', { evidence_id: 'mock:routing-candidate:X01:a1:c1' }); f.mark('blocked', '과거 후보 면제 차단'); f.until('END');
  }, 'policy_demo');
  make('routing-replan', '계획 반려 · 새 cycle과 필수 재검토', f => {
    f.begin(); f.wait('X01'); f.human('X01', 'reject');
    f.emit('business_failure', 'X01', { candidate_fingerprint: 'mock:candidate:A', evidence_id: 'mock:routing-replan:X01:a1:c1' }); f.mark('rejected', '사람 계획 반려');
    // failRoute's failure replay is intentionally omitted: route consumes the already recorded proof.
    f.failRoute('X01', 'rejected', 'P02', true); f.mark('rerouted', '새 cycle 계획 대기');
    f.start('P02'); f.recontext(true); f.mark('stale', '이전 계획 버전 거절'); f.recontext(); f.done('P02');
    for (const step of ['P03', 'P04', 'P05']) f.run(step);
    f.approvePlan([], [], []); f.mark('replanned', '새 계획과 필수 문서 재검토 완료');
  });
  make('routing-metadata', '면제 명세 반려 · 품질 처분 보존과 자료 복구', f => {
    f.begin(); f.approvePlan(reuseIds, exemptions); f.reuseTo('P13'); f.exemptQuality();
    f.run('X02'); f.wait('X03'); f.approval('reject_release_metadata'); f.mark('rejected', '현재 명세 자료 반려');
    f.failRoute('X03', 'reject_release_metadata', 'X02'); f.mark('retried', '같은 cycle 새 자료 attempt'); f.until('END');
  }, 'policy_demo');
  return catalog;
}
