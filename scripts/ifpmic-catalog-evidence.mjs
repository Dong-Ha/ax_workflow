import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import workflow from '../docs/ifpmic/design-v1/specs/workflow.v1.json' with { type: 'json' };
import states from '../docs/ifpmic/design-v1/specs/state-contract.json' with { type: 'json' };
import { createScenarioCatalog, replayScenario } from '../src/ifpmic/replay.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(root, 'workflow-artifacts/verification/V2/ui');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const summary = value => ({ mode: value.mode, status: value.status, current_step: value.current_step,
  cycle: value.cycle, rework_count: value.rework_count, publication_count: value.release.publication_count,
  duplicate_count: value.duplicate_count, conflict_count: value.conflict_count, real_publish_allowed: value.real_publish_allowed,
  requirements_version: value.requirements_version,
  sqe: { execution_mode: value.steps.P22.sqe_execution_mode, context_evidence_id: value.steps.P22.sqe_context?.evidence_id ?? null,
    result_evidence_id: value.steps.P22.sqe_result?.evidence_id ?? null, report_evidence_id: value.steps.P23.sqe_report?.evidence_id ?? null,
    gate_report_evidence_id: value.steps.P24.gate_sqe_report_evidence_id, manifest_report_evidence_id: value.release.manifest?.sqe_report_evidence_id ?? null },
  route_plan: value.route_plan.context ? { context_cycle: value.route_plan.context.cycle,
    plan_version: value.route_plan.context.plan_version, candidate_fingerprint: value.route_plan.context.candidate_fingerprint,
    approval_evidence_id: value.route_plan.confirmed?.evidence_id ?? null,
    reuse_steps: value.route_plan.confirmed?.reuse_steps.map(entry => entry.step_id) ?? [],
    exempt_steps: value.route_plan.confirmed?.exempt_steps ?? [] } : null,
  no_change: value.no_change ? { evidence_id: value.no_change.evidence_id, actor: value.no_change.actor,
    production_evidence_id: value.no_change.production_evidence_id, tests_evidence_id: value.no_change.tests_evidence_id } : null,
  gate_dispositions: value.release.manifest?.gate_dispositions ?? null,
  spec_review: value.spec_review ? { question_id: value.spec_review.question_id,
    question_attempt: value.spec_review.attempt, question_execution_id: value.spec_review.execution_id,
    resolved: value.spec_review.resolved, resolved_requirements_version: value.spec_review.resolved_requirements_version,
    review_attempt: value.spec_review.review_attempt, review_execution_id: value.spec_review.review_execution_id,
    current_review: value.spec_review.resolved && value.spec_review.reviewed && value.spec_review.cycle === value.cycle
      && value.spec_review.candidate_fingerprint === value.candidate_fingerprint
      && value.spec_review.review_attempt === value.steps.P03.attempt
      && value.spec_review.review_execution_id === value.steps.P03.execution_id
      && value.spec_review.resolved_requirements_version === value.requirements_version } : null,
  remote_reconciliation: value.remote_reconciliation ? { operation_key: value.remote_reconciliation.operation_key,
    query_seq: value.remote_reconciliation.query_seq, outcome: value.remote_reconciliation.outcome } : null });
await mkdir(directory, { recursive: true });
const catalog = createScenarioCatalog(workflow, states);
const manifest = { kind: 'mock_catalog_manifest', mode: 'mock', scenario_count: catalog.length,
  scope: 'Partial V2 catalog and UI; remaining protocols/full V2/real AT are not accepted', scenarios: [] };
const journals = [];
const baseline = JSON.parse(await readFile(resolve(root, 'docs/ifpmic/evidence/v2/sqe-baseline-41.json'), 'utf8'));
const migration = { kind: 'explicit_sqe_proof_catalog_migration', mode: 'mock', source_commit: baseline.source_commit,
  scope: 'New independently authored SQE proof events; original 41 event streams restored by removing only mock:sqe-catalog source', scenarios: [] };
const hashObject = value => sha256(JSON.stringify(value));
for (const scenario of catalog) {
  const original = baseline.scenarios.find(row => row.id === scenario.id);
  const inserted = scenario.events.filter(event => event.source_id === 'mock:sqe-catalog');
  const restored = scenario.events.filter(event => event.source_id !== 'mock:sqe-catalog');
  const restoredPoints = scenario.checkpoints.map(point => ({ ...point, cursor: scenario.events.slice(0, point.cursor).filter(event => event.source_id !== 'mock:sqe-catalog').length }));
  if (original && (hashObject(restored) !== original.events_sha256 || hashObject(restoredPoints) !== original.checkpoints_sha256
    || !inserted.every(event => ['sqe_context', 'sqe_result', 'sqe_report'].includes(event.type)))) throw new Error(`Invalid SQE fixture migration: ${scenario.id}`);
  if (original) migration.scenarios.push({ id: scenario.id, original_events_sha256: original.events_sha256,
    restored_events_sha256: hashObject(restored), current_events_sha256: hashObject(scenario.events),
    original_checkpoints_sha256: original.checkpoints_sha256, restored_checkpoints_sha256: hashObject(restoredPoints),
    current_checkpoints_sha256: hashObject(scenario.checkpoints), inserted_events: inserted.map(event => ({ event_id: event.event_id, source_id: event.source_id, source_seq: event.source_seq, type: event.type, step_id: event.step_id, cycle: event.cycle, attempt: event.attempt, execution_id: event.execution_id })) });
  let previous = replayScenario(scenario, workflow, states, 0);
  const journal = [];
  for (let cursor = 1; cursor <= scenario.events.length; cursor++) {
    const snapshot = replayScenario(scenario, workflow, states, cursor);
    const row = snapshot.timeline[snapshot.timeline.length - 1];
    journal.push({ cursor, event_id: scenario.events[cursor - 1].event_id,
      applied: snapshot.timeline.length > previous.timeline.length && row.applied,
      reason: snapshot.timeline.length === previous.timeline.length ? 'duplicate_event' : row.reason,
      ...summary(snapshot) });
    previous = snapshot;
  }
  journals.push({ id: scenario.id, mode: 'mock', events: scenario.events, journal });
  manifest.scenarios.push({ id: scenario.id, title: scenario.title, requirement_ids: scenario.requirement_ids,
    event_count: scenario.events.length, fixture_sha256: sha256(JSON.stringify(scenario.events)),
    final: summary(previous), checkpoints: scenario.checkpoints.map(point => ({ ...point,
      observed_snapshot: summary(replayScenario(scenario, workflow, states, point.cursor)) })) });
}
await writeFile(resolve(directory, 'sqe-migration.json'), JSON.stringify(migration, null, 2) + '\n');
const bytes = JSON.stringify(journals, null, 2) + '\n';
await writeFile(resolve(directory, 'catalog-journal.json'), bytes);
manifest.journal_sha256 = sha256(bytes);
await writeFile(resolve(directory, 'catalog.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`MOCK catalog evidence: ${catalog.length} scenarios; no actual AT or external execution.`);
