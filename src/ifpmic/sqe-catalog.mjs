// Explicit new synthetic evidence, authored independently of old PASS measurements/replay output.
// Removing only this source recovers every original catalog event byte-for-byte.
const requiredCases = ['mock:sqe:case:boot', 'mock:sqe:case:function'];
const versions = { profile_ref: 'mock:sqe:profile', profile_version: 'mock:sqe:profile:v1',
  script_version: 'mock:sqe:script:v1', parser_version: 'mock:sqe:parser:v1', rule_version: 'mock:rules:v1' };
export function enrichSqeCatalog(catalog) {
  return catalog.map(scenario => {
    const events = [], cursorMap = [0], contexts = new Map(), collected = new Map();
    let sequence = 0, candidate = 'mock:candidate:A';
    const proofId = (event, kind) => `mock:${scenario.id}:sqe:${kind}:c${event.cycle}:a${event.attempt}`;
    const append = (event, type, payload) => events.push({ event_id: `mock:${scenario.id}:sqe-event:${++sequence}`,
      source_id: 'mock:sqe-catalog', source_seq: sequence, type, mode: 'mock', job_id: event.job_id,
      step_id: event.step_id, cycle: event.cycle, attempt: event.attempt, execution_id: event.execution_id, payload });
    for (const event of scenario.events) {
      if (event.type === 'candidate') candidate = event.payload.candidate_fingerprint;
      if (event.type === 'step' && event.step_id === 'P22' && event.payload.state === 'SUCCEEDED') {
        const ctx = contexts.get(event.cycle);
        if (!ctx || ctx.attempt !== event.attempt) throw new Error(`Missing authored SQE context for ${scenario.id}`);
        const result = { actor: 'mock:sqe', execution_mode: 'bridge_mock', task_id: null, performer_id: 'mock:sqe',
          candidate_fingerprint: ctx.candidate_fingerprint, ...versions, device_id: ctx.device_id, bridge_id: ctx.bridge_id,
          image_hash: ctx.image_hash, observed_device_id: ctx.device_id, observed_image_identity: ctx.expected_image_identity,
          started_at_ms: 1000, finished_at_ms: 2000, execution_status: 'completed', parser_status: 'complete',
          exit_code: scenario.id === 'sqe-failure' ? 1 : 0,
          cases: requiredCases.map((case_id, index) => ({ case_id, outcome: scenario.id === 'sqe-failure' && index === 1 ? 'FAIL' : 'PASS' })),
          stdout_artifact_id: proofId(event, 'stdout'), stderr_artifact_id: proofId(event, 'stderr'),
          result_artifact_id: proofId(event, 'results'), evidence_id: proofId(event, 'result') };
        append(event, 'sqe_result', result);
        collected.set(event.cycle, { evidence_id: result.evidence_id, execution_id: event.execution_id });
      }
      if (event.type === 'step' && event.step_id === 'P23' && event.payload.state === 'SUCCEEDED' && collected.has(event.cycle)) {
        const result = collected.get(event.cycle);
        append(event, 'sqe_report', { actor: 'mock:sqe', candidate_fingerprint: candidate,
          result_evidence_id: result.evidence_id, result_execution_id: result.execution_id,
          profile_ref: versions.profile_ref, profile_version: versions.profile_version,
          report_artifact_id: proofId(event, 'report-artifact'), report_link_id: proofId(event, 'report-link'),
          evidence_id: proofId(event, 'report') });
      }
      events.push(event);
      if (event.type === 'step' && event.step_id === 'P22' && event.payload.state === 'RUNNING') {
        const ctx = { actor: 'mock:sqe', candidate_fingerprint: candidate, ...versions,
          device_id: `mock:${scenario.id}:device`, bridge_id: `mock:${scenario.id}:bridge`,
          image_hash: `mock:${scenario.id}:image:c${event.cycle}`, expected_image_identity: `mock:${scenario.id}:boot:c${event.cycle}`,
          evidence_id: proofId(event, 'context') };
        contexts.set(event.cycle, { ...ctx, attempt: event.attempt }); append(event, 'sqe_context', ctx);
      }
      cursorMap.push(events.length);
    }
    return { ...scenario, events, checkpoints: scenario.checkpoints.map(point => ({ ...point, cursor: cursorMap[point.cursor] })) };
  });
}
