// Explicitly authored synthetic lifecycle for the new catalog version.
// Historical traces remain unchanged; these are not retroactive runtime facts.
export const childCatalogVersion = 'mock:ifpmic:children:v1';
export function enrichChildCatalog(catalog) {
  return catalog.map(scenario => {
    const events = [], cursors = [0];
    let sequence = 0, candidate = 'mock:candidate:A', requirements = 'mock:requirements:v1';
    const p11 = new Map();
    for (const event of scenario.events) {
      if (event.type === 'candidate') candidate = event.payload.candidate_fingerprint;
      if (event.type === 'spec_resolution' && event.payload.complete === true) requirements = event.payload.resolved_requirements_version;
      if (event.step_id === 'P11' && (event.type === 'step' && event.payload.state === 'SUCCEEDED' || event.type === 'skip')) p11.set(event.cycle, event.execution_id);
      events.push(event);
      if (event.step_id === 'P12' && event.type === 'step' && event.payload.state === 'RUNNING') {
        const id = kind => `mock:${scenario.id}:ch:${kind}:c${event.cycle}:a${event.attempt}`;
        const common = { coordinator_task_id: id('parent-task'), coordinator_execution_id: id('parent-exec'),
          candidate_fingerprint: candidate, requirements_version: requirements };
        const child = { request_id: id('request'), child_task_id: id('task'), child_execution_id: id('exec') };
        const append = (type, payload) => events.push({ ...event, event_id: `mock:${scenario.id}:child-event:${++sequence}`,
          source_id: 'mock:child-catalog', source_seq: sequence, type, payload });
        append('p12_coordinator', { actor: 'mock:system', role: 'code-dev', purpose: 'p12_coordination', ...common,
          p11_execution_id: p11.get(event.cycle), code_artifact_id: id('code'), production_hash: id('production'),
          tc_design_artifact_id: id('design'), workspace_id: id('integration-ws'), write_scope: 'tests_integration_only',
          runtime_profile_ref: 'mock:runtime:code-dev-coordinator:v1', evidence_id: id('coordinator-proof') });
        append('child_request', { actor: 'mock:code-dev', ...common, request_id: child.request_id, child_task_id: child.child_task_id,
          ordinal: 1, child_role: 'tc', workspace_id: id('tc-ws'), write_scope: 'tests_only', runtime_profile_ref: 'mock:runtime:tc:v1',
          output_schema_ref: 'mock:schema:tc-patch:v1', code_artifact_id: id('code'), tc_design_artifact_id: id('design'),
          prior_child_execution_id: null, checkpoint_artifact_id: null, answer_evidence_id: null, answer_artifact_id: null, evidence_id: id('request-proof') });
        append('child_assignment', { actor: 'mock:system', ...common, ...child, workspace_id: id('tc-ws'), evidence_id: id('assignment-proof') });
        append('child_result', { actor: 'mock:tc', ...common, ...child, workspace_id: id('tc-ws'), status: 'completed',
          output_schema_ref: 'mock:schema:tc-patch:v1', patch_artifact_id: id('patch'), changed_path_refs: ['mock:path:tests:unit'],
          production_hash: id('production'), question_id: null, checkpoint_artifact_id: null, failure_class: null,
          started_at_ms: 1000, finished_at_ms: 2000, evidence_id: id('result-proof') });
        append('child_collect', { actor: 'mock:code-dev', ...common, child_execution_id: child.child_execution_id,
          result_evidence_id: id('result-proof'), evidence_id: id('collect-proof') });
        append('child_integrated', { actor: 'mock:code-dev', ...common, child_execution_id: child.child_execution_id,
          result_evidence_id: id('result-proof'), patch_artifact_id: id('patch'), production_hash_before: id('production'),
          production_hash_after: id('production'), changed_path_refs: ['mock:path:tests:unit'], expectations_changed: false,
          outcome: 'integrated', integration_artifact_id: id('integration'), evidence_id: id('integrated-proof') });
      }
      cursors.push(events.length);
    }
    return { ...scenario, catalog_version: childCatalogVersion, events,
      checkpoints: scenario.checkpoints.map(point => ({ ...point, cursor: cursors[point.cursor] })) };
  });
}
