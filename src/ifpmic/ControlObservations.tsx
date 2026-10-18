import { mockHumanTaskId } from './protocols.mjs';
import type { ReplaySnapshot } from './replay.mjs';
import workflow from '../../docs/ifpmic/design-v1/specs/workflow.v1.json' with { type: 'json' };

type RecordValue = Readonly<Record<string, unknown>>;
const last = <T,>(values: readonly T[]): T | undefined => values[values.length - 1];
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown): string => value === null || value === undefined ? '없음'
  : ['string', 'number', 'boolean'].includes(typeof value) ? String(value)
  : Array.isArray(value) ? value.map(text).join(' · ') || '없음' : '별도 근거 참조';
function Fields({ rows }: { rows: readonly (readonly [string, unknown])[] }) {
  return <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{text(value)}</dd></div>)}</dl>;
}
const phaseLabel = (phase: string | null) => ({ PAUSE_REQUESTED: '일시정지 요청 · fence 대기', PAUSED: '일시정지 확인',
  CANCEL_REQUESTED: '취소 요청 · 종료 확인 중', QUIESCENT: '안전 경계 확인 · 취소 확정 전', CANCELED: '취소 확정' }[phase ?? ''] ?? '제어 latch 없음');

export function ControlObservations({ snapshot }: { snapshot: ReplaySnapshot }) {
  const c = snapshot.control, latest = last(c.commands), anchor = c.pause_anchor;
  const rejectedControlEvent = last(snapshot.ignored.filter(row => row.type.startsWith('control_')));
  const step = snapshot.steps[snapshot.current_step === 'END' ? 'P26' : snapshot.current_step];
  const child = step.child_coordination;
  const humanTask = child?.human_task?.task_id ?? step.sqe_manual_task?.task_id
    ?? (snapshot.current_step === 'P03' ? snapshot.spec_review?.task_id : null)
    ?? (step.state === 'WAITING_HUMAN' && workflow.nodes.some(node => node.id === snapshot.current_step && node.owner === 'human')
      ? mockHumanTaskId(snapshot.current_step, step.cycle, step.attempt) : null);
  const bridge = last(c.bridges), bridgeCommand = record(bridge?.command), observation = record(bridge?.observation);
  const reconciliation = record(bridge?.reconciliation), release = record(bridge?.release);
  const remote = last(c.remotes), query = record(remote?.last_query), terminal = record(remote?.terminal);
  const childFacts = c.facts.filter(fact => fact.type === 'child_result');
  return <div className="ifpmic-control-observations">
    <section className="ifpmic-observation ifpmic-control-summary" aria-label="작업 제어 모의 관측" data-testid="ifpmic-control-observation"
      data-phase={c.phase ?? ''} data-admission={String(c.admission_open)} data-revision={snapshot.revision}
      data-resume-step={c.resume_step ?? ''} data-resume-state={c.resume_state ?? ''} data-command-status={latest?.status ?? ''}
      data-job-status={snapshot.status} data-reconciliation-required={String(c.reconciliation_required)}>
      <h3><span className="ifpmic-mock">MOCK</span> 작업 제어 관측</h3>
      <div className="ifpmic-control-status"><strong>{phaseLabel(c.phase)}</strong><span>제어에 의한 신규 실행 {c.admission_open ? '차단 없음' : '차단 중'}</span><span>revision {snapshot.revision}</span></div>
      <p>전체 작업 {snapshot.status} · 제어 phase {c.phase ?? '없음'}. 명령 접수는 정지·취소 완료가 아닙니다. 합성 사건을 읽는 관측 화면입니다.</p>
      {c.reconciliation_required && <p role="status">추가 조정 필요 · 기존 종료 상태와 영수증을 보존하며 신규 실행을 허가하지 않습니다.</p>}
      {snapshot.device?.quarantined && <p role="status">장비 격리 중 · 조정·해제 근거가 필요합니다. 재할당 허용 false.</p>}
    </section>
    <section className="ifpmic-observation" aria-label="명령 접수·적용 모의 관측" data-testid="ifpmic-control-command">
      <h3>명령 접수·적용 <span className="ifpmic-mock">MOCK</span></h3>
      {latest ? <Fields rows={[
        ['명령 ID', latest.command_id], ['요청', latest.body.action], ['접수·적용 상태', latest.status],
        ['요청 revision', latest.body.expected_revision], ['적용 revision', latest.applied_revision],
        ['요청자', latest.actor], ['멱등 key', latest.idempotency_key], ['적용 관측 근거', latest.decision?.evidence_id],
        ['거절 코드', latest.error?.code], ['거절 사유', latest.error?.message],
      ]} /> : <p>이 관측까지 제어 명령 접수 없음</p>}
      <p>accepted는 접수, applied는 명령 적용입니다. 실제 안전 경계는 별도 종료·조정 근거로 확인합니다.</p>
      {rejectedControlEvent && <p>최근 거절된 제어 관측: <code>{rejectedControlEvent.reason}</code> · <code>{rejectedControlEvent.event_id}</code></p>}
      {c.commands.length > 1 && <details><summary>명령 이력 {c.commands.length}개 · 동일 key 재전달은 기존 접수 보존</summary>
        <ol>{c.commands.map(command => <li key={command.command_id}>{command.body.action} · {command.status} · <code>{command.command_id}</code>
          <Fields rows={[[ '요청 / 적용 revision', `${command.body.expected_revision} / ${command.applied_revision ?? '없음'}`], ['거절 코드', command.error?.code]]} /></li>)}</ol>
      </details>}
    </section>
    <section className="ifpmic-observation" aria-label="제어·대기 복원 모의 관측" data-testid="ifpmic-control-frontier"
      data-step-state={step.state} data-agent-status={step.agent_status} data-attempt={step.attempt}>
      <h3>제어·대기 복원 <span className="ifpmic-mock">MOCK</span></h3>
      <Fields rows={[
        ['제어 phase', `${c.phase ?? '없음'} · ${phaseLabel(c.phase)}`], ['신규 실행 허가', c.admission_open],
        ['현재 단계 / 상태', `${snapshot.current_step} / ${step.state}`], ['Agent 상태', step.agent_status],
        ['현재 cycle / attempt', `${step.cycle} / ${step.attempt}`], ['현재 실행', step.execution_id],
        ['원래 업무 상태', c.underlying_status], ['원래 대기 사유', c.underlying_wait_reason || '없음'],
        ['집계 대기 사유', snapshot.wait_reason || '없음'], ['실제 재개 frontier', `${c.resume_step ?? '없음'} / ${c.resume_state ?? '없음'}`],
        ['처음 정지 anchor', anchor ? `${text(anchor.step_id)} / c${text(anchor.cycle)} / a${text(anchor.attempt)}` : null],
        ['Anchor 실행', anchor?.execution_id], ['미할당 요청', c.pending_request_ids],
        ['Fence', c.fence?.fence_id], ['재시도 기한', step.retry_due_ms === null ? null : `${step.retry_due_ms}ms`],
      ]} />
      {humanTask && <p>기존 사람 task: {humanTask} · {c.admission_open ? '원래 승인·제출 규칙 적용' : '기존 근거 보존 · 신규 실행 권한 없음'}</p>}
      {child && <p>기존 자식 실행: {child.requests.map(request => `${request.assignment?.child_execution_id ?? '미할당'} · ${request.result?.status ?? '결과 대기'}`).join(' / ')} · TC 결과와 부모 수집·통합을 구분합니다.</p>}
      {child && <Fields rows={[
        ['부모 coordinator 상태', child.status], ['자식 Patch artifact', child.requests.map(request => request.result?.patch_artifact_id ?? '없음')],
        ['수집 근거', child.requests.map(request => request.collection?.evidence_id ?? '없음')],
        ['통합 근거', child.requests.map(request => request.integration?.evidence_id ?? '없음')],
      ]} />}
      {step.sqe_manual_task && <Fields rows={[
        ['수동 SQE task', step.sqe_manual_task.task_id], ['수동 결과 근거', step.sqe_result?.evidence_id],
      ]} />}
      <p>재개는 저장된 실제 frontier의 대기·task·attempt를 유지합니다. 다음 단계 실행과 재시도는 각각의 허가와 근거가 필요합니다.</p>
    </section>
    <section className="ifpmic-observation" aria-label="실행·부작용 모의 관측" data-testid="ifpmic-control-effects"
      data-publication-count={snapshot.release.publication_count} data-bridge-state={text(observation.state ?? (bridge ? 'QUEUED' : ''))}
      data-remote-outcome={query.outcome === undefined ? '' : text(query.outcome)} data-released={String(bridge?.released ?? false)}>
      <h3>실행·부작용 <span className="ifpmic-mock">MOCK</span></h3>
      <Fields rows={[
        ['등록 실행 / 종료 근거', `${c.executions.length} / ${c.execution_ends.length}`],
        ['안전 경계 근거', c.boundary?.evidence_id], ['추가 조정 필요', c.reconciliation_required],
        ['장비 격리 / 재할당', `${snapshot.device?.quarantined ?? false} / false`], ['미식별 격리', c.unscoped_quarantine],
        ['발행 효과 관측', snapshot.release.publication_count], ['보존 영수증', snapshot.release.receipt_id],
      ]} />
      {bridge && <div className="ifpmic-control-proof" data-testid="ifpmic-control-bridge">
        <h4>장비 명령 · {text(observation.state ?? 'QUEUED')}</h4>
        <Fields rows={[
          ['근거 범위', bridge.candidate_fingerprint === snapshot.candidate_fingerprint && bridge.requirements_version === snapshot.requirements_version
            && bridge.step_execution_id === snapshot.steps.P22.execution_id ? '현재 입력과 일치' : '과거 실행 또는 다른 입력'],
          ['Bridge 명령', bridgeCommand.command_id], ['동작 / profile', `${text(bridgeCommand.action)} / ${text(bridgeCommand.profile_ref)}`],
          ['장비 / bridge', `${text(bridgeCommand.device_id)} / ${text(bridgeCommand.bridge_id)}`],
          ['Lease / fencing', `${text(bridgeCommand.lease_id)} / ${text(bridgeCommand.fencing_token)}`],
          ['결과 identity', observation.device_identity], ['이미지 identity', observation.image_identity],
          ['결과 순번 / 근거', `${text(bridge.last_sequence)} / ${text(observation.evidence_id)}`],
          ['조정 근거', reconciliation.evidence_id], ['Lock / lease 해제', `${text(release.os_lock_released ?? false)} / ${text(release.lease_released ?? false)}`],
          ['해제 근거', release.evidence_id],
        ]} />
        <details><summary>이미지·실행·profile 결속 근거</summary><Fields rows={[
          ['후보', bridge.candidate_fingerprint], ['요구사항', bridge.requirements_version], ['단계 실행', bridge.step_execution_id],
          ['이미지 artifact', bridgeCommand.artifact_id], ['이미지 SHA256', bridgeCommand.artifact_sha256],
          ['기대 boot identity', bridge.expected_image_identity], ['Profile version', bridgeCommand.profile_version],
          ['Deadline', bridgeCommand.deadline], ['등록 근거', bridge.registered_evidence_id],
          ['결과 artifact', observation.test_result_artifact_id], ['표준 출력 artifact', observation.stdout_artifact_id],
        ]} /></details>
      </div>}
      {remote && <div className="ifpmic-control-proof" data-testid="ifpmic-control-remote">
        <h4>원격 효과 · {text(query.outcome ?? '조회 전')}</h4><Fields rows={[
          ['근거 범위', remote.cycle === snapshot.cycle && remote.candidate_fingerprint === snapshot.candidate_fingerprint
            && remote.execution_id === snapshot.steps.P25.execution_id ? '현재 입력과 일치' : '과거 실행 또는 다른 입력'],
          ['동작 key', remote.operation_key], ['명세', remote.manifest_id], ['단계 실행', remote.execution_id],
          ['조회 순번 / 결과', `${text(remote.query_seq)} / ${text(query.outcome)}`],
          ['Provider 종료', terminal.provider_state], ['종료 근거', terminal.evidence_id],
          ['동일 동작 영수증', remote.canonical_receipt_id], ['충돌 수', Array.isArray(remote.conflicts) ? remote.conflicts.length : 0],
          ['보존 관측 수', Array.isArray(remote.history) ? remote.history.length : 0],
        ]} /><details><summary>명세·실행 결속 근거</summary><Fields rows={[
          ['Digest', remote.digest], ['후보', remote.candidate_fingerprint], ['Cycle / attempt', `${text(remote.cycle)} / ${text(remote.attempt)}`],
          ['조회 근거', query.evidence_id], ['종료가 참조한 조회', terminal.query_evidence_id],
        ]} /></details><p>unknown·absent는 종료가 아닙니다. 같은 영수증의 늦은 관측은 발행 횟수를 늘리거나 취소된 단계를 진행시키지 않습니다.</p>
      </div>}
      {childFacts.map((fact, index) => { const payload = record(fact.payload); return <div className="ifpmic-control-proof" key={index}>
        <h4>취소 중 반환 · 업무 진행과 별도 보존</h4><Fields rows={[
          ['자식 실행', payload.child_execution_id], ['실행 결과', payload.status], ['Patch artifact', payload.patch_artifact_id], ['반환 근거', payload.evidence_id],
        ]} /></div>; })}
      {!bridge && !remote && childFacts.length === 0 && <p>이 관측까지 장비·원격·늦은 자식 결과 근거 없음</p>}
      {(c.bridges.length > 0 || c.remotes.length > 0) && <details><summary>등록된 모든 장비·원격 동작과 관측 이력</summary>
        {c.bridges.map((entry, index) => { const command = record(entry.command), result = record(entry.observation); return <div key={`bridge-${index}`}>
          <Fields rows={[[ '장비 명령', command.command_id], ['실행 / lease', `${text(entry.step_execution_id)} / ${text(command.lease_id)}`],
            ['상태 / 해제', `${text(result.state ?? 'QUEUED')} / ${text(entry.released)}`], ['조정 근거', record(entry.reconciliation).evidence_id]]} />
          <ol>{(Array.isArray(entry.observation_history) ? entry.observation_history : []).map((value, n) => { const row = record(value); return <li key={n}>
            {text(row.sequence)} · {text(row.state)} · <code>{text(row.evidence_id)}</code>
          </li>; })}</ol>
        </div>; })}
        {c.remotes.map((entry, index) => <div key={`remote-${index}`}>
          <Fields rows={[[ '원격 동작', entry.operation_key], ['실행', entry.execution_id], ['보존 영수증', entry.canonical_receipt_id],
            ['종료 근거', record(entry.terminal).evidence_id], ['충돌 수', Array.isArray(entry.conflicts) ? entry.conflicts.length : 0]]} />
          <ol>{(Array.isArray(entry.history) ? entry.history : []).map((value, n) => { const row = record(value), fact = record(row.fact); return <li key={n}>
            {text(row.kind)} · {text(fact.outcome ?? fact.provider_state)} · <code>{text(fact.evidence_id)}</code>
          </li>; })}</ol>
        </div>)}
      </details>}
      {c.executions.length > 0 && <details><summary>등록 실행·종료와 안전 경계 근거</summary>
        {c.executions.map((execution, index) => <Fields key={index} rows={[
          ['실행 종류 / 단계', `${text(execution.kind)} / ${text(execution.step_id)}`], ['실행 ID', execution.agent_execution_id],
          ['실행 좌표', execution.step_execution_id],
        ]} />)}
        {c.execution_ends.map((end, index) => <Fields key={index} rows={[
          ['종료 실행', end.agent_execution_id], ['종료 상태', end.status], ['기존 결과 근거', end.prior_result_evidence_id], ['종료 근거', end.evidence_id],
        ]} />)}
        <Fields rows={[[ 'Drained 요청', c.boundary?.drained_request_ids], ['종료 근거 집합', c.boundary?.execution_result_ids],
          ['장비 조정 근거 집합', c.boundary?.bridge_reconciliation_ids], ['장비 해제 근거 집합', c.boundary?.bridge_release_ids], ['원격 종료 근거 집합', c.boundary?.remote_terminal_ids]]} />
      </details>}
      <p>이 식별자는 모의 참조입니다. 장비 실행·파일 열기·외부 제출 기능을 제공하지 않습니다.</p>
    </section>
  </div>;
}
