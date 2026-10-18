import { ChildObservations, StepChildDetails } from './ChildObservations';
import { ControlObservations } from './ControlObservations';
import { useEffect, useState } from 'react';
import { SqeObservations, StepSqeDetails } from './SqeObservations';
import { RoutingObservations, RoutingHistory, StepRoutingDetails } from './RoutingObservations';
import type { MockScenario, MockSpecReview, ReplaySnapshot, ReplayStep } from './replay.mjs';

const labels: Record<string, string> = {
  PAUSE_REQUESTED: '일시정지 요청', PAUSED: '일시정지', CANCEL_REQUESTED: '취소 요청', CANCELED: '취소됨', QUIESCENT: '안전 경계 확인',
  SKIPPED: '생략', EXEMPT: '정책 면제', NO_CHANGE: '변경 없음 종료', PENDING: '미시작', READY: '준비', RUNNING: '진행 중', SUCCEEDED: '완료', FAILED: '실패',
  WAITING_HUMAN: '사람 대기', WAITING_AGENT: 'Agent 대기', WAITING_DEVICE: '장비 대기',
  WAITING_RETRY: '재시도 대기', RECONCILING: '결과 확인 필요', COMPLETED: '모의 완료',
  RELEASED_PENDING_NOTES: '발행 관측 완료 · 노트 대기', INCONCLUSIVE: '근거 불완전',
};
export const observationLabel = (value: string | null) => value ? `${value}${labels[value] ? ` · ${labels[value]}` : ''}` : '미판정';

export function ObservationDetail({ step, snapshot }: { step: ReplayStep; snapshot: ReplaySnapshot }) {
  return <section className="ifpmic-observation" data-testid="ifpmic-observation-detail" aria-label="선택 단계 모의 관측">
    <h3><span className="ifpmic-mock">MOCK</span> 현재 선택 단계 관측</h3>
    <dl><dt>단계 상태</dt><dd>{observationLabel(step.state)}</dd><dt>Agent 상태</dt><dd>{step.agent_status}</dd>
      <dt>Gate 판정</dt><dd>{observationLabel(step.gate_verdict)}</dd><dt>측정 완료</dt><dd>{String(step.gate_complete)}</dd><dt>Cycle · attempt</dt><dd>{step.cycle} · {step.attempt}</dd>
      <dt>작업 ID</dt><dd><code>{snapshot.job_id}</code></dd><dt>실행 좌표</dt><dd><code>{step.execution_id}</code></dd><dt>현재 후보</dt><dd><code>{snapshot.candidate_fingerprint}</code></dd>
      {step.retry_due_ms !== null && <><dt>합성 재시도 시각</dt><dd>{step.retry_due_ms}ms</dd></>}
    </dl>
    <StepRoutingDetails step={step} /><StepChildDetails step={step} snapshot={snapshot} /><StepSqeDetails step={step} stepId={Object.entries(snapshot.steps).find(([, value]) => value === step)?.[0] ?? ''} sqeAssociated={Boolean(snapshot.steps.P22.sqe_context || snapshot.steps.P22.sqe_result || snapshot.steps.P23.sqe_report || snapshot.steps.P24.gate_sqe_report_evidence_id)} /><p>모의 증거 · 실제 승인/측정 결과로 사용할 수 없습니다.</p>
    {step.evidence_ids.length ? <ul>{step.evidence_ids.map(id => <li key={id}><span className="ifpmic-mock">MOCK</span> <code>{id}</code></li>)}</ul> : <p>이 관측까지 증거 없음</p>}
  </section>;
}

function SpecHistory({ question }: { question: MockSpecReview }) {
  return <div data-testid="ifpmic-spec-history" data-question-id={question.question_id} data-review-attempt={question.review_attempt ?? ''}>
    <dl><dt>질문 ID</dt><dd>{question.question_id}</dd><dt>배정 task</dt><dd>{question.task_id}</dd>
      <dt>질문 원래 좌표</dt><dd>cycle {question.cycle} · attempt {question.attempt}</dd><dt>질문 당시 버전</dt><dd>{question.requirements_version}</dd><dt>질문 원래 실행</dt><dd>{question.execution_id}</dd><dt>질문 증거</dt><dd>{question.question_evidence_id}</dd>
      <dt>답변 반영 버전</dt><dd>{question.resolved_requirements_version ?? '없음'}</dd><dt>답변 증거</dt><dd>{question.resolution_evidence_id ?? '없음'}</dd>
      <dt>기록된 검토 attempt</dt><dd>{question.review_attempt ?? '없음'}</dd><dt>기록된 검토 실행</dt><dd>{question.review_execution_id ?? '없음'}</dd><dt>검토 증거</dt><dd>{question.review_evidence_id ?? '없음'}</dd>
    </dl>
  </div>;
}

function ExceptionObservations({ snapshot }: { snapshot: ReplaySnapshot }) {
  const question = snapshot.spec_review;
  const remote = snapshot.remote_reconciliation;
  const specStep = snapshot.steps.P03;
  const currentReview = Boolean(question?.resolved && question.reviewed && question.cycle === snapshot.cycle
    && question.candidate_fingerprint === snapshot.candidate_fingerprint
    && question.review_attempt === specStep.attempt && question.review_execution_id === specStep.execution_id
    && question.resolved_requirements_version === snapshot.requirements_version);
  return <>
    {question && <section className="ifpmic-observation" aria-label="사양 질문 모의 관측" data-testid="ifpmic-spec-observation"
      data-question-id={question.question_id} data-requirements-version={snapshot.requirements_version} data-question-attempt={question.attempt}
      data-review-attempt={question.review_attempt ?? ''} data-current-review={String(currentReview)}>
      <h3><span className="ifpmic-mock">MOCK</span> 사양 질문·답변과 재검토</h3>
      <dl><dt>요구사항 현재 버전</dt><dd>{snapshot.requirements_version}</dd><dt>질문 ID</dt><dd>{question.question_id}</dd>
        <dt>배정 task</dt><dd>{question.task_id}</dd><dt>질문 당시 버전</dt><dd>{question.requirements_version}</dd><dt>질문 원래 실행</dt><dd>{question.execution_id}</dd>
        <dt>질문 증거</dt><dd>{question.question_evidence_id}</dd><dt>질문 범위</dt><dd>{question.cycle === snapshot.cycle ? '현재 cycle' : '이전 cycle'} · cycle {question.cycle} · attempt {question.attempt}</dd>
        <dt>답변 상태</dt><dd>{question.resolved ? '해결됨' : '미해결'}</dd><dt>답변 반영 버전</dt><dd>{question.resolved_requirements_version ?? '없음'}</dd>
        <dt>답변 증거</dt><dd>{question.resolution_evidence_id ?? '없음'}</dd><dt>현재 P03 attempt</dt><dd>{specStep.attempt}</dd><dt>현재 P03 실행</dt><dd>{specStep.execution_id}</dd>
        <dt>현재 실행 검토</dt><dd><strong>{currentReview ? '유효' : '미완료'}</strong></dd>
        <dt>기록된 검토 attempt</dt><dd>{question.review_attempt ?? '없음'}</dd><dt>기록된 검토 실행</dt><dd>{question.review_execution_id ?? '없음'}</dd><dt>검토 증거</dt><dd>{question.review_evidence_id ?? '없음'}</dd>
      </dl>
      {question.reviewed && !currentReview && <p>이전 검토 기록은 보존하지만 현재 실행의 검토를 대신하지 않습니다.</p>}
      <p>질문·답변과 spec-gen 재검토의 합성 관측입니다. 사람 제출이나 실제 검토를 실행하지 않습니다.</p>
    </section>}
    {remote && <section className="ifpmic-observation" aria-label="원격 결과 모의 관측" data-testid="ifpmic-remote-observation"
      data-operation-key={remote.operation_key} data-query-seq={remote.query_seq} data-outcome={remote.outcome}>
      <h3><span className="ifpmic-mock">MOCK</span> 원격 결과 조회 관측</h3>
      <dl><dt>동작 key</dt><dd>{remote.operation_key}</dd><dt>명세 ID</dt><dd>{remote.manifest_id}</dd><dt>digest</dt><dd>{remote.digest}</dd>
        <dt>후보</dt><dd>{remote.candidate_fingerprint}</dd><dt>P25 단계 상태</dt><dd>{snapshot.steps.P25.state}</dd>
        <dt>조회 순번</dt><dd>{remote.query_seq}</dd><dt>조회 결과</dt><dd>{remote.outcome}</dd><dt>모의 영수증</dt><dd>{snapshot.release.receipt_id ?? '없음'}</dd>
        <dt>실제 제출 허용</dt><dd>false</dd></dl>
      <ol className="ifpmic-journal" aria-label="모의 원격 조회 기록">{remote.observations.map(row => <li key={row.query_seq}><span>MOCK · {row.query_seq} · {row.outcome}</span><code>{row.evidence_id}</code></li>)}</ol>
      <p>수용된 조회 기록만 표시합니다. 미발견·충돌은 재제출 허가가 아니며, 원격 결과가 장비 격리를 해제하지 않습니다.</p>
    </section>}
  </>;
}

interface Props {
  catalog: readonly MockScenario[]; scenario: MockScenario; cursor: number; snapshot: ReplaySnapshot;
  onScenario: (id: string) => void; onCursor: (cursor: number) => void; onCurrent: () => void;
}
export function ReplayPanel({ catalog, scenario, cursor, snapshot, onScenario, onCursor, onCurrent }: Props) {
  const [historyExpanded, setHistoryExpanded] = useState(false);
  useEffect(() => setHistoryExpanded(false), [snapshot.job_id]);
  const current = snapshot.steps[snapshot.current_step === 'END' ? 'P26' : snapshot.current_step];
  const checkpoint = scenario.checkpoints.find(item => item.cursor === cursor)?.id ?? '';
  const lastIgnored = snapshot.ignored[snapshot.ignored.length - 1];
  return <section className="ifpmic-replay" aria-label="모의 사건 재생">
    <div className="ifpmic-replay-heading"><div><p className="ifpmic-eyebrow">MOCK · 관측 탐색</p><h2>진행과 복귀를 사건 단위로</h2></div><span className="ifpmic-mock">{catalog.length}개 시나리오 · V2 진행 중</span></div>
    <p>합성 기록의 앞부분을 탐색합니다. 실제 업무·승인·장비·배포에는 연결되지 않습니다.</p>
    <div className="ifpmic-replay-controls">
      <label>모의 시나리오 선택<select aria-label="모의 시나리오 선택" value={scenario.id} onChange={e => onScenario(e.target.value)}>{catalog.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <label>주요 관측 이동<select aria-label="주요 관측 이동" value={checkpoint} onChange={e => { const point = scenario.checkpoints.find(item => item.id === e.target.value); if (point) onCursor(point.cursor); }}><option value="">사건 사이 관측</option>{scenario.checkpoints.map(point => <option key={point.id} value={point.id}>{point.title}</option>)}</select></label>
    </div>
    <div className="ifpmic-playback" aria-label="모의 관측 이동">
      <button disabled={cursor === 0} onClick={() => onCursor(0)}>처음 관측</button><button disabled={cursor === 0} onClick={() => onCursor(cursor - 1)}>이전 관측</button>
      <output aria-live="polite">관측 {cursor} / {scenario.events.length}</output>
      <button disabled={cursor === scenario.events.length} onClick={() => onCursor(cursor + 1)}>다음 관측</button><button disabled={cursor === scenario.events.length} onClick={() => onCursor(scenario.events.length)}>끝 관측</button>
      <button onClick={onCurrent}>현재 단계 보기</button>
    </div>
    <div className="ifpmic-replay-summary" data-testid="ifpmic-replay-summary" data-status={snapshot.status} data-current-step={snapshot.current_step} data-cycle={snapshot.cycle} data-rework={snapshot.rework_count} data-attempt={current.attempt} aria-live="polite">
      <div><span>전체 작업 · MOCK</span><strong>{observationLabel(snapshot.status)}</strong></div><div><span>현재 단계</span><strong>{snapshot.current_step}</strong></div>
      <div><span>Cycle · 재작업</span><strong>{snapshot.cycle} · {snapshot.rework_count} / 3</strong></div><div><span>현재 attempt</span><strong>{current.attempt}</strong></div>
      <div><span>모의 발행 관측</span><strong>{snapshot.release.publication_count}회</strong></div>
    </div>
    <p className="ifpmic-replay-coordinates"><span className="ifpmic-mock">MOCK</span> {snapshot.job_id} · 후보 {snapshot.candidate_fingerprint}<br />요구사항 버전 {snapshot.requirements_version}<br /><span data-testid="ifpmic-catalog-version">{scenario.catalog_version ?? 'mock:ifpmic:legacy'}</span><br />요구사항 {scenario.requirement_ids.join(', ')}</p>
    <p className="ifpmic-replay-reason" data-testid="ifpmic-replay-reason">대기·차단 사유: <code>{snapshot.wait_reason || lastIgnored?.reason || '없음'}</code> · 중복 {snapshot.duplicate_count} · 충돌 {snapshot.conflict_count}</p>
    {(scenario.catalog_version === 'mock:ifpmic:controls:v1' || snapshot.control.commands.length > 0) && <ControlObservations snapshot={snapshot} />}
    {snapshot.required_revalidation.length > 0 && <p className="ifpmic-revalidation">필수 재평가 구간: {snapshot.required_revalidation.join(' → ')}</p>}
    <div className="ifpmic-replay-grid">
      <ChildObservations snapshot={snapshot} /><ExceptionObservations snapshot={snapshot} /><RoutingObservations snapshot={snapshot} /><SqeObservations snapshot={snapshot} />
      <section className="ifpmic-observation" aria-label="장비 모의 관측"><h3><span className="ifpmic-mock">MOCK</span> 장비 관측</h3>
        {snapshot.device ? <dl><dt>상태</dt><dd>{snapshot.device.status}</dd><dt>로컬 활동</dt><dd>{snapshot.device.operation_state ?? 'UNKNOWN'}</dd>
          <dt>연결</dt><dd>{snapshot.device.offline ? 'OFFLINE' : snapshot.device.status === 'UNKNOWN' ? 'UNKNOWN' : 'ONLINE'}</dd><dt>Heartbeat 기한</dt><dd>{snapshot.device.heartbeat_due ? '도달' : '미도달'}</dd>
          <dt>Lease 만료</dt><dd>{String(snapshot.device.lease_expired)}</dd><dt>격리</dt><dd>{String(snapshot.device.quarantined)}</dd><dt>재할당 허용</dt><dd>false</dd></dl> : <p>이 관측까지 장비 기록 없음</p>}</section>
      <section className="ifpmic-observation" aria-label="배포 모의 관측"><h3><span className="ifpmic-mock">MOCK</span> 승인·영수증 관측</h3>
        <dl><dt>현재 명세</dt><dd>{snapshot.release.manifest?.manifest_id ?? '없음'}</dd><dt>모의 digest</dt><dd>{snapshot.release.manifest?.digest ?? '없음'}</dd><dt>모의 승인</dt><dd>{String(snapshot.release.approved)}</dd><dt>모의 영수증</dt><dd>{snapshot.release.receipt_id ?? '없음'}</dd><dt>실제 제출 허용</dt><dd>false</dd></dl>
        <dl><dt>Gate 처분</dt><dd>{snapshot.release.manifest?.gate_dispositions.map((verdict, index) => `${['P16', 'P18', 'P20', 'P24'][index]} ${verdict}`).join(', ') || '없음'}</dd></dl>
        <p>digest는 합성 관측 토큰입니다. 실제 암호학적 서명 검증이 아닙니다.</p></section>
      <section className="ifpmic-observation" aria-label="모의 사건 목록"><h3>사건 · MOCK</h3><ol className="ifpmic-journal" aria-label="모의 사건 목록">{snapshot.timeline.map(row => <li key={row.event_id} className={row.applied ? '' : 'ignored'}>
        <button aria-label={`${row.event_id} 사건 보기`} onClick={() => onCursor(scenario.events.findIndex(event => event.event_id === row.event_id) + 1)}><span className="ifpmic-mock">MOCK</span> {row.step_id} · {row.type}</button><span>{row.applied ? '적용' : `거절 · ${row.reason}`}</span>
      </li>)}</ol>{snapshot.timeline.length === 0 && <p>아직 재생한 사건이 없습니다.</p>}</section>
      <section className="ifpmic-observation" aria-label="모의 과거 이력"><h3>이전 cycle·attempt · MOCK</h3>{snapshot.history.length > 0 && <button type="button" aria-expanded={historyExpanded} aria-controls="ifpmic-replay-history" onClick={() => setHistoryExpanded(value => !value)}>{historyExpanded ? '이력 영역 접기' : '이력 영역 펼치기'}</button>}<div id="ifpmic-replay-history" className={`ifpmic-history${historyExpanded ? ' expanded' : ''}`}>{snapshot.history.map((entry, index) => {
        const steps = entry.steps ? Object.entries(entry.steps).filter(([, step]) => step.state !== 'PENDING') : entry.step && entry.step_id ? [[entry.step_id, entry.step] as const] : [];
        return <details key={index} open={index === snapshot.history.length - 1}><summary>MOCK · {entry.kind} · cycle {entry.cycle}{entry.step_id ? ` · ${entry.step_id}` : ''}{steps.some(([, step]) => step.state === 'FAILED') ? ` · 실패 ${steps.filter(([, step]) => step.state === 'FAILED').map(([id]) => id).join(', ')}` : ''}</summary>
          <ul>{steps.map(([id, step]) => <li key={id}>{id} · {step.state} · attempt {step.attempt}{step.gate_verdict ? ` · gate ${step.gate_verdict}` : ''}{step.evidence_ids.length > 0 && <small>MOCK 증거 {step.evidence_ids.join(', ')}</small>}<StepRoutingDetails step={step} /><StepChildDetails step={step} snapshot={snapshot} historical /><StepSqeDetails step={step} stepId={id} historical /></li>)}</ul>
          {entry.route_plan && <RoutingHistory plan={entry.route_plan} />}
          {entry.spec_review && <SpecHistory question={entry.spec_review} />}
          {entry.release && <p>MOCK · 이전 명세 {entry.release.manifest?.manifest_id} · 반려 {entry.release.rejection} · 과거 Gate 처분 {entry.release.manifest?.gate_dispositions.join(', ') || '없음'}</p>}
        </details>;
      })}</div>{snapshot.history.length === 0 && <p>이 관측까지 과거 이력 없음</p>}
      {snapshot.failure_bundle.length > 0 && <p>MOCK · 한도 도달 증거 {snapshot.failure_bundle.map(item => `${item.step_id} c${item.cycle} a${item.attempt} ${item.evidence_id}`).join(', ')}</p>}</section>
    </div>
    <p className="ifpmic-replay-pending"><strong>전체 V2 미완료</strong> · 후속 범위: 실제 자식 Agent 실행과 작업 제어 연동 및 전체 V2 검증. 실제 수동 장비·SQE 실행 연동은 별도 범위. 실제 AT 미실행.</p>
  </section>;
}
