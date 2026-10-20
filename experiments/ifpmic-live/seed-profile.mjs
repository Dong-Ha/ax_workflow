import { validProfile } from '../../tests/helpers/ifpmic-profile-fixtures.mjs';
import { createSnapshot } from '../../runtime/ifpmic/snapshot.mjs';
import { initStore, publishSnapshot } from '../../runtime/ifpmic/store.mjs';

// This is a synthetic local profile. It never authorizes real equipment/release.
let raw = '';
for await (const chunk of process.stdin) raw += chunk.toString('utf8');
const input = JSON.parse(raw);
const profile = structuredClone(validProfile);
profile.project_id = 'ifpmic-local-demo';
profile.mode = 'mock';
await initStore(input.store);
const record = createSnapshot({ profileText: JSON.stringify(profile), profileVersion: 'local-demo-v1' });
await publishSnapshot(input.store, record);
process.stdout.write(JSON.stringify({ snapshot_id: record.snapshot_id }) + '\n');
