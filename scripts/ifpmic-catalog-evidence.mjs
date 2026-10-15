import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
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
  duplicate_count: value.duplicate_count, conflict_count: value.conflict_count, real_publish_allowed: value.real_publish_allowed });
await mkdir(directory, { recursive: true });
const catalog = createScenarioCatalog(workflow, states);
const manifest = { kind: 'mock_catalog_manifest', mode: 'mock', scenario_count: catalog.length,
  scope: 'Partial V2 catalog and UI; remaining protocols/full V2/real AT are not accepted', scenarios: [] };
const journals = [];
for (const scenario of catalog) {
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
      expected_observation: summary(replayScenario(scenario, workflow, states, point.cursor)) })) });
}
const bytes = JSON.stringify(journals, null, 2) + '\n';
await writeFile(resolve(directory, 'catalog-journal.json'), bytes);
manifest.journal_sha256 = sha256(bytes);
await writeFile(resolve(directory, 'catalog.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`MOCK catalog evidence: ${catalog.length} scenarios; no actual AT or external execution.`);
