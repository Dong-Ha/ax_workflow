import { childEvidenceCurrent } from './children.mjs';
import type { MockChildCoordination, MockChildRequest, ReplaySnapshot, ReplayStep } from './replay.mjs';
const text = (value: string | null | undefined) => value ?? '없음';
const childStatus = (request: MockChildRequest | undefined) => request?.result?.status ?? (request?.assignment ? 'running' : '미할당');
const integrationStatus = (request: MockChildRequest | undefined) => request?.integration ? 'integrated' : request?.conflicts.length ? 'conflict' : '없음';

export function ChildObservations({ snapshot }: { snapshot: ReplaySnapshot }) {
  const c = snapshot.steps.P12.child_coordination;
  if (!c) return null;
  const r = c.requests[c.requests.length - 1];
  const current = childEvidenceCurrent(c.context, snapshot);
  return <section className="ifpmic-observation" aria-label="자식 TC 실행 모의 관측" data-testid="ifpmic-child-observation"
    data-current-evidence={String(current)} data-coordinator-status={c.status} data-coordinator-execution-id={c.context.coordinator_execution_id}
    data-child-status={childStatus(r)} data-child-execution-id={r?.assignment?.child_execution_id ?? ''}
    data-request-ordinal={r?.ordinal ?? ''} data-integration-status={integrationStatus(r)}>
    <h3><span className="ifpmic-mock">MOCK</span> 자식 TC 실행</h3>
    <dl><dt>근거 범위</dt><dd>{current ? '현재 입력과 일치' : '과거 · 현재 권한 아님'} · {c.context.candidate_fingerprint} / 현재 {snapshot.candidate_fingerprint}</dd><dt>P12 업무 단계</dt><dd>{snapshot.steps.P12.state}</dd>
      <dt>부모 coordinator</dt><dd>code-dev · {c.status}</dd><dt>부모 실행</dt><dd>{c.context.coordinator_execution_id}</dd>
      <dt>TC 자식 실행</dt><dd>{childStatus(r)} · {r?.assignment?.child_execution_id ?? '미할당'}</dd>
      <dt>명시 부모 관계</dt><dd>{c.context.coordinator_execution_id} → {r?.assignment?.child_execution_id ?? '미할당'}</dd>
      <dt>쓰기 범위 · 합성 선언</dt><dd>부모 {c.context.write_scope} · TC {r?.write_scope ?? '미할당'}</dd>
      <dt>요청 순번</dt><dd>{r?.ordinal ?? '없음'}</dd><dt>결과 수집</dt><dd>{text(r?.collection?.evidence_id)}</dd>
      <dt>통합 근거</dt><dd>{integrationStatus(r)} · {text(r?.integration?.evidence_id)}</dd>
      <dt>질문 task</dt><dd>{text(c.human_task?.task_id)}</dd><dt>복구 필요</dt><dd>{r?.recovery ? '사람 복구 승인 기록됨' : c.human_task?.kind === 'agent_recovery' ? '사람 복구 승인 필요 · 자동 재실행 없음' : snapshot.steps.P12.infrastructure_error && snapshot.steps.P12.state === 'WAITING_HUMAN' ? '재시도 상한 · 사람 검토 필요' : '없음'}</dd>
    </dl><p>테스트 범위의 합성 선언이며, 자식 반환·수집·통합은 별도 관측입니다. 품질 판정과 실제 실행 권한은 별도입니다.</p>
  </section>;
}

function RequestDetails({ c, r, historical }: { c: MockChildCoordination; r: MockChildRequest; historical: boolean }) {
  return <section className="ifpmic-child-detail" data-testid={historical ? 'ifpmic-child-history' : 'ifpmic-child-step-detail'} data-step-id="P12"
    data-cycle={c.context.cycle} data-attempt={c.context.attempt} data-parent-execution-id={c.context.coordinator_execution_id}
    data-child-execution-id={r.assignment?.child_execution_id ?? ''} data-ordinal={r.ordinal} data-result-status={r.result?.status ?? ''}>
    <h4>{historical ? '과거 · 현재 권한 아님' : '현재 P12 근거'} · cycle {c.context.cycle} · attempt {c.context.attempt} · 자식 {r.ordinal}</h4>
    <section aria-label="P12 부모·자식 식별" data-testid="ifpmic-child-binding"><h5>부모·자식 식별과 입력</h5><dl><dt>부모 coordinator</dt><dd>{c.context.role} · {c.context.purpose} · {c.status}</dd>
      <dt>부모 task</dt><dd>{c.context.coordinator_task_id}</dd><dt>부모 실행</dt><dd>{c.context.coordinator_execution_id}</dd>
      <dt>TC 자식 실행</dt><dd>{childStatus(r)} · {r.assignment?.child_execution_id ?? '미할당'}</dd>
      <dt>명시 부모 관계</dt><dd>{c.context.coordinator_execution_id} → {r.assignment?.child_execution_id ?? '미할당'}</dd>
      <dt>자식 task · 요청</dt><dd>{r.child_task_id} · {r.request_id} · ordinal {r.ordinal}</dd>
      <dt>후보 · 요구사항</dt><dd>{c.context.candidate_fingerprint} · {c.context.requirements_version}</dd>
      <dt>P12 실행 좌표</dt><dd>{c.context.execution_id}</dd>
      <dt>P11 입력 provenance</dt><dd>{c.context.p11_execution_id} · {c.context.code_artifact_id}</dd>
      <dt>TC 설계 입력 참조</dt><dd>{c.context.tc_design_artifact_id}</dd>
      </dl></section><section aria-label="P12 쓰기 범위와 결과" data-testid="ifpmic-child-result"><h5>쓰기 범위와 반환·수집</h5><dl><dt>쓰기 범위 · 합성 선언</dt><dd>부모 {c.context.write_scope} · {c.context.workspace_id}<br />TC {r.write_scope} · {r.workspace_id}</dd>
      <dt>실행 profile · schema</dt><dd>{r.runtime_profile_ref} · {r.output_schema_ref}</dd>
      <dt>원래 production hash</dt><dd>{c.context.production_hash}</dd>
      <dt>결과 근거 · 시각</dt><dd>{text(r.result?.evidence_id)} · {r.result ? `${r.result.started_at_ms}–${r.result.finished_at_ms}ms` : '없음'}</dd>
      <dt>테스트 patch 참조</dt><dd>{text(r.result?.patch_artifact_id)}</dd><dt>변경 경로 참조</dt><dd>{r.result?.changed_path_refs.join(', ') || '없음'}</dd>
      <dt>결과 수집 근거</dt><dd>{text(r.collection?.evidence_id)}</dd>
      </dl></section><section aria-label="P12 질문·복구·통합" data-testid="ifpmic-child-integration"><h5>질문·복구와 통합</h5><dl><dt>질문 task</dt><dd>{r.result?.status === 'needs_human' && r.collection ? `mock:child-human:${r.assignment?.child_execution_id}` : '없음'}</dd>
      <dt>질문 · checkpoint</dt><dd>{text(r.result?.question_id)} · {text(r.result?.checkpoint_artifact_id)}</dd>
      <dt>답변 근거</dt><dd>{text(r.answer?.evidence_id)} · {text(r.answer?.answer_artifact_id)}</dd>
      <dt>재개한 이전 실행</dt><dd>{text(r.prior_child_execution_id)} · {text(r.answer_evidence_id)}</dd>
      <dt>복구 task · 사람 승인</dt><dd>{r.result && ['canceled', 'interrupted'].includes(r.result.status) && r.collection ? `mock:child-recovery:${r.assignment?.child_execution_id}` : '없음'} · {text(r.recovery?.evidence_id)}</dd>
      <dt>통합 충돌 근거</dt><dd>{r.conflicts.map(p => p.evidence_id).join(', ') || '없음'}</dd>
      <dt>통합 근거</dt><dd>{integrationStatus(r)} · {text(r.integration?.evidence_id)} · {text(r.integration?.integration_artifact_id)}</dd>
    </dl></section><p>테스트 범위의 합성 선언입니다. 실제 파일·OS 권한 검사 또는 품질 PASS의 증거가 아닙니다.</p>
  </section>;
}

export function StepChildDetails({ step, snapshot, historical = false }: { step: ReplayStep; snapshot: ReplaySnapshot; historical?: boolean }) {
  const c = step.child_coordination;
  if (!c) return null;
  if (c.requests.length === 0) return <section className="ifpmic-child-detail"
    data-testid={historical || !childEvidenceCurrent(c.context, snapshot) ? 'ifpmic-child-history' : 'ifpmic-child-step-detail'}
    data-step-id="P12" data-cycle={c.context.cycle} data-attempt={c.context.attempt}
    data-parent-execution-id={c.context.coordinator_execution_id} data-child-execution-id="" data-ordinal="" data-result-status="">
    <h4>{historical || !childEvidenceCurrent(c.context, snapshot) ? '과거 · 현재 권한 아님' : '부모 coordinator'} · {c.status}</h4>
    <dl><dt>부모 coordinator</dt><dd>{c.context.role} · {c.context.purpose}</dd>
      <dt>부모 task · 실행</dt><dd>{c.context.coordinator_task_id} · {c.context.coordinator_execution_id}</dd>
      <dt>P12 실행 좌표</dt><dd>{c.context.execution_id}</dd><dt>TC 자식 실행</dt><dd>미할당</dd>
      <dt>후보 · 요구사항</dt><dd>{c.context.candidate_fingerprint} · {c.context.requirements_version}</dd>
      <dt>P11 입력 provenance</dt><dd>{c.context.p11_execution_id} · {c.context.code_artifact_id}</dd>
      <dt>TC 설계 입력 참조</dt><dd>{c.context.tc_design_artifact_id}</dd>
      <dt>쓰기 범위 · 합성 선언</dt><dd>{c.context.write_scope} · {c.context.workspace_id}</dd>
      <dt>입력 hash · profile</dt><dd>{c.context.production_hash} · {c.context.runtime_profile_ref}</dd>
      <dt>부모 근거</dt><dd>{c.context.evidence_id}</dd></dl>
  </section>;
  return <>{c.requests.map((r, index) => <RequestDetails key={r.request_id} c={c} r={r} historical={historical || !childEvidenceCurrent(c.context, snapshot) || index < c.requests.length - 1} />)}</>;
}
