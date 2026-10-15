import type { ReplaySnapshot, ReplayStep } from './replay.mjs';
import { mockSqeProfile } from './sqe-profile.mjs';

const modeLabel = (mode: string | null) => mode === 'manual' ? '수동 · manual' : mode === 'bridge_mock' ? 'bridge mock · 합성' : '없음';
function Fields({ values }: { values: readonly (readonly [string, string | number | null | undefined])[] }) {
  return <dl>{values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? '없음'}</dd></div>)}</dl>;
}

export function StepSqeDetails({ step, stepId, historical = false, sqeAssociated = false }: { step: ReplayStep; stepId: string; historical?: boolean; sqeAssociated?: boolean }) {
  const ctx = step.sqe_context, task = step.sqe_manual_task, proof = step.sqe_result, report = step.sqe_report;
  if (!ctx && !task && !proof && !report && !step.gate_sqe_report_evidence_id && !(stepId === 'P24' && sqeAssociated)) return null;
  const mode = step.sqe_execution_mode ?? report?.execution_mode ?? null;
  return <div className="ifpmic-sqe-detail" data-testid={historical ? 'ifpmic-sqe-history' : 'ifpmic-sqe-step-detail'}
    data-step-id={stepId} data-attempt={step.attempt} data-mode={mode ?? ''}
    data-result-evidence-id={proof?.evidence_id ?? ''} data-report-evidence-id={report?.evidence_id ?? step.gate_sqe_report_evidence_id ?? ''}>
    <h4>MOCK · {historical ? '과거 SQE 기록 · 현재 권한 아님' : 'SQE 단계 근거'}</h4>
    <Fields values={[
      ['근거 범위', `${historical ? '과거' : '선택 단계'} · ${stepId} · cycle ${step.cycle} · attempt ${step.attempt}`],
      ['원래 실행', step.execution_id], ['수행 모드', modeLabel(mode)],
    ]} />
    {ctx && <section aria-label="SQE 시험 대상"><h5>시험 대상 · 합성 profile</h5><Fields values={[
      ['대상 후보', ctx.candidate_fingerprint], ['프로파일', ctx.profile_ref], ['프로파일 버전', ctx.profile_version],
      ['스크립트 버전', ctx.script_version], ['파서 버전', ctx.parser_version], ['규칙 버전', ctx.rule_version],
      ['목표 장비', ctx.device_id], ['Bridge', ctx.bridge_id], ['이미지 해시', ctx.image_hash],
      ['기대 부팅 식별', ctx.expected_image_identity], ['Context 증거', ctx.evidence_id],
    ]} /></section>}
    {task && <section aria-label="SQE 수동 배정"><h5>수동 배정</h5><Fields values={[
      ['수동 task', task.task_id], ['배정 담당', task.assignee], ['배정 수행자', task.performer_id],
      ['요청 사유', task.reason_id], ['요청 시각 ms', task.requested_at_ms], ['요청 증거', task.evidence_id],
      ['제출 상태', proof ? '배정 결과 수락 · 품질 판정 별도' : '수동 결과 대기'],
    ]} /></section>}
    {ctx && !proof && <p>결과 없음 · 수집 완료와 품질 PASS를 확인하지 않았습니다.</p>}
    {proof && <section aria-label="SQE 수집 결과"><h5>수집 결과 · 품질 판정 별도</h5><Fields values={[
      ['결과 후보', proof.candidate_fingerprint], ['결과 수행 모드', modeLabel(proof.execution_mode)],
      ['제출 actor', proof.actor], ['수행자', proof.performer_id], ['결과 task', proof.task_id],
      ['결과 프로파일 버전', proof.profile_version], ['결과 스크립트 버전', proof.script_version],
      ['결과 파서 버전', proof.parser_version], ['결과 규칙 버전', proof.rule_version],
      ['시작 ms', proof.started_at_ms], ['종료 ms', proof.finished_at_ms],
      ['수집 실행 상태', proof.execution_status], ['파서 상태', proof.parser_status], ['종료 코드', proof.exit_code],
      ['관측 장비', proof.observed_device_id], ['관측 부팅 식별', proof.observed_image_identity],
      ['결과 증거', proof.evidence_id], ['stdout artifact', proof.stdout_artifact_id],
      ['stderr artifact', proof.stderr_artifact_id], ['result artifact', proof.result_artifact_id],
    ]} />
      <p>필수 사례 · 합성 두 사례, 실제 정책 기준 아님</p>
      <ul aria-label="SQE 필수 사례 결과">{mockSqeProfile.expected_cases.map(caseId => {
        const found = proof.cases.find(row => row.case_id === caseId);
        return <li key={caseId}><code>{caseId}</code> · {found?.outcome ?? '누락 · 미수집'}</li>;
      })}</ul>
    </section>}
    {report && <section aria-label="SQE 작업 내 보고"><h5>작업 내 보고 · 링크 식별자</h5><Fields values={[
      ['보고 후보', report.candidate_fingerprint], ['보고 수행 모드', modeLabel(report.execution_mode)],
      ['보고 프로파일', report.profile_ref], ['보고 프로파일 버전', report.profile_version],
      ['참조 결과', report.result_evidence_id], ['참조 P22 실행', report.result_execution_id],
      ['보고 artifact', report.report_artifact_id], ['보고 link ID', report.report_link_id], ['보고 증거', report.evidence_id],
    ]} /></section>}
    {stepId === 'P24' && <Fields values={[
      ['P24 기록 판정', step.gate_verdict ?? '미판정'], ['P24 측정 완료', String(step.gate_complete)],
      ['P24 참조 보고', step.gate_sqe_report_evidence_id], ['판정 후보', step.gate_candidate_fingerprint],
      ['판정 규칙', step.gate_rule_version], ['판정 증거', step.gate_evidence_id],
    ]} />}
    <p>근거 식별자만 표시합니다. 실제 파일·원시 로그·외부 링크를 열지 않습니다.</p>
  </div>;
}

export function SqeObservations({ snapshot }: { snapshot: ReplaySnapshot }) {
  const p22 = snapshot.steps.P22, p23 = snapshot.steps.P23, p24 = snapshot.steps.P24;
  if (!p22.sqe_context && !p23.sqe_report && !p24.gate_sqe_report_evidence_id) return null;
  return <section className="ifpmic-observation" aria-label="SQE 수행·보고·판정 모의 관측" data-testid="ifpmic-sqe-observation"
    data-mode={p22.sqe_execution_mode ?? ''} data-p22-attempt={p22.attempt} data-p23-attempt={p23.attempt}
    data-p24-attempt={p24.attempt} data-verdict={p24.gate_verdict ?? ''}>
    <h3><span className="ifpmic-mock">MOCK</span> SQE 수행·보고·시스템 판정</h3>
    <Fields values={[
      ['P22 수집 상태', `${p22.state} · attempt ${p22.attempt}`], ['수행 모드', modeLabel(p22.sqe_execution_mode)],
      ['수동 task 상태', p22.sqe_manual_task ? p22.sqe_result ? '배정 결과 수락' : '사람 결과 대기' : '수동 배정 없음'],
      ['수집 bundle', p22.sqe_result?.execution_status ?? '결과 없음'],
      ['P23 보고 상태', `${p23.state} · attempt ${p23.attempt}`], ['현재 보고 증거', p23.sqe_report?.evidence_id],
      ['P24 판정 상태', `${p24.state} · attempt ${p24.attempt}`], ['P24 기록 판정', p24.gate_verdict ?? '미판정'],
      ['P24 측정 완료', String(p24.gate_complete)], ['판정 참조 보고', p24.gate_sqe_report_evidence_id],
      ['명세 참조 보고', snapshot.release.manifest?.sqe_report_evidence_id],
    ]} />
    <p>수집·보고 완료는 품질 PASS가 아닙니다. 수동 결과 수락은 READY로 돌아가는 관측이며, 시스템 판정과 승인은 별도입니다.</p>
    <p>시험 기준과 두 필수 사례는 합성 fixture입니다. 실제 사람 요청·시험·장비 제어·배포와 연결되지 않습니다.</p>
  </section>;
}
