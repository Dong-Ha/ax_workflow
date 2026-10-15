import type { MockRoutePlan, ReplaySnapshot, ReplayStep } from './replay.mjs';

function authority(snapshot: ReplaySnapshot) {
  const { context, confirmed } = snapshot.route_plan;
  const approval = snapshot.steps.X01;
  return Boolean(context && confirmed && context.cycle === snapshot.cycle && confirmed.cycle === snapshot.cycle
    && context.candidate_fingerprint === snapshot.candidate_fingerprint
    && context.requirements_version === snapshot.requirements_version
    && confirmed.candidate_fingerprint === snapshot.candidate_fingerprint
    && confirmed.requirements_version === snapshot.requirements_version
    && confirmed.plan_version === context.plan_version && confirmed.profile_hash === context.profile_hash
    && approval.state === 'SUCCEEDED' && confirmed.approval_attempt === approval.attempt
    && confirmed.approval_execution_id === approval.execution_id);
}

function PlanFields({ plan }: { plan: MockRoutePlan }) {
  const { context, confirmed } = plan;
  if (!context) return null;
  return <dl>
    <dt>계획 버전</dt><dd>{context.plan_version}</dd><dt>프로파일</dt><dd>{context.profile_id} · {context.profile_kind}</dd>
    <dt>변경 유형</dt><dd>{context.change_type}</dd><dt>계획 원래 cycle</dt><dd>{context.cycle}</dd>
    <dt>계획 후보</dt><dd>{context.candidate_fingerprint}</dd><dt>계획 요구사항</dt><dd>{context.requirements_version}</dd>
    <dt>X01 승인 증거</dt><dd>{confirmed?.evidence_id ?? '없음'}</dd>
    <dt>승인 원래 실행</dt><dd>{confirmed?.approval_execution_id ?? '없음'}</dd>
    <dt>재사용 범위</dt><dd>{confirmed?.reuse_steps.map(row => row.step_id).join(', ') || '없음'}</dd>
    <dt>면제 범위</dt><dd>{confirmed?.exempt_steps.join(', ') || '없음'}</dd>
    <dt>개별 재사용 확인</dt><dd>{Object.entries(plan.reuse_confirmations).map(([id, proof]) => `${id} · ${proof.evidence_id}`).join(', ') || '없음'}</dd>
  </dl>;
}

export function RoutingHistory({ plan }: { plan: MockRoutePlan }) {
  return <div data-testid="ifpmic-routing-history" data-plan-version={plan.context?.plan_version ?? ''}>
    <p>MOCK · 과거 계획 기록 · 현재 권한을 뜻하지 않습니다.</p><PlanFields plan={plan} />
  </div>;
}

export function StepRoutingDetails({ step }: { step: ReplayStep }) {
  const basis = step.skip_basis, analysis = step.unchanged_analysis, report = step.exemption_report;
  return <>
    {basis && <div data-testid="ifpmic-skip-basis"><h4>생략 근거 · MOCK</h4><dl>
      <dt>생략 종류</dt><dd>{basis.kind}</dd><dt>확인 담당</dt><dd>{basis.actor}</dd><dt>생략 사유</dt><dd>{basis.reason_id}</dd>
      <dt>기준 해시</dt><dd>{basis.baseline_hash}</dd><dt>이전 입력</dt><dd>{basis.baseline_input_hash ?? '없음'}</dd>
      <dt>현재 입력</dt><dd>{basis.current_input_hash ?? '없음'}</dd><dt>생략 계획</dt><dd>{basis.plan_version}</dd>
      <dt>근거 프로파일</dt><dd>{basis.profile_id} · {basis.profile_hash}</dd><dt>정책 규칙</dt><dd>{basis.policy_rule_id ?? '없음'} · {basis.rule_version}</dd>
      <dt>근거 원래 좌표</dt><dd>cycle {basis.cycle} · attempt {basis.attempt} · {basis.execution_id}</dd>
      <dt>근거 후보</dt><dd>{basis.candidate_fingerprint}</dd><dt>생략 증거</dt><dd>{basis.evidence_id}</dd>
    </dl></div>}
    {analysis && <div data-testid="ifpmic-unchanged-analysis"><h4>변경불필요 분석 · MOCK</h4><dl>
      <dt>분석 담당</dt><dd>{analysis.actor}</dd><dt>분석 기준 해시</dt><dd>{analysis.baseline_hash}</dd>
      <dt>분석 현재 해시</dt><dd>{analysis.current_hash}</dd><dt>변경 필요</dt><dd>{String(analysis.needs_changes)}</dd>
      <dt>요구사항 충족</dt><dd>{String(analysis.requirements_satisfied)}</dd><dt>분석 증거</dt><dd>{analysis.evidence_id}</dd>
    </dl></div>}
    {report && <div data-testid="ifpmic-exemption-report"><h4>SQE 시험 미수행 보고 · MOCK</h4><dl>
      <dt>보고 담당</dt><dd>{report.actor}</dd><dt>시험 수행</dt><dd>{String(report.performed)}</dd>
      <dt>보고서</dt><dd>{report.report_id}</dd><dt>면제 승인 참조</dt><dd>{report.exemption_evidence_id}</dd>
      <dt>보고 증거</dt><dd>{report.evidence_id}</dd>
    </dl></div>}
  </>;
}

export function RoutingObservations({ snapshot }: { snapshot: ReplaySnapshot }) {
  const { route_plan: plan, no_change: closed } = snapshot;
  return <>
    {plan.context && <section className="ifpmic-observation" aria-label="재사용·면제 계획 모의 관측"
      data-testid="ifpmic-routing-observation" data-plan-version={plan.context.plan_version}
      data-context-cycle={plan.context.cycle} data-current-authority={String(authority(snapshot))}>
      <h3><span className="ifpmic-mock">MOCK</span> 재사용·정책 면제 계획</h3>
      <dl><dt>현재 후보</dt><dd>{snapshot.candidate_fingerprint}</dd><dt>현재 권한</dt><dd><strong>{authority(snapshot) ? '유효' : '미확정·만료'}</strong></dd></dl>
      <PlanFields plan={plan} />
      <p>개별 확인과 X01 전역 승인을 구분합니다. 생략은 성공 판정이 아니며 면제는 실제 시험 수행을 뜻하지 않습니다.</p>
    </section>}
    {closed && <section className="ifpmic-observation" aria-label="무변경 종료 모의 관측" data-testid="ifpmic-no-change-observation">
      <h3><span className="ifpmic-mock">MOCK</span> 변경 없음 종료 · NO_CHANGE</h3>
      <dl><dt>종료 확인 담당</dt><dd>{closed.actor}</dd><dt>종료 task</dt><dd>{closed.task_id}</dd>
        <dt>종료 사유</dt><dd>{closed.reason_id}</dd><dt>생산 분석 참조</dt><dd>{closed.production_evidence_id}</dd>
        <dt>TC 분석 참조</dt><dd>{closed.tests_evidence_id}</dd><dt>계획 승인 참조</dt><dd>{closed.reuse_evidence_id}</dd>
        <dt>종료 원래 좌표</dt><dd>cycle {closed.cycle} · attempt {closed.attempt} · {closed.execution_id}</dd>
        <dt>모의 발행 횟수</dt><dd>{snapshot.release.publication_count}</dd><dt>후속 실행</dt><dd>P13 이후 PENDING · 미실행</dd>
      </dl><p>생산·TC의 별도 분석과 사람 확인으로 종료한 합성 기록입니다. 실제 빈 커밋이나 배포를 만들지 않습니다.</p>
    </section>}
  </>;
}
