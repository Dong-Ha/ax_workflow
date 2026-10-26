import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEMO_CONTEXT, validateDemoContext } from '../experiments/ifpmic-live/web/context.js';

const legacy = () => ({ ...DEMO_CONTEXT, release_modes: [...DEMO_CONTEXT.release_modes] });

test('accepts the exact legacy demo context with execution disconnected', () => {
  assert.equal(validateDemoContext(legacy()), true);
});

test('accepts v2 context with either boolean process-health state', () => {
  for (const execution_connected of [false, true]) {
    assert.equal(validateDemoContext({
      ...legacy(), schema_version: 'ifpmic.local-context.v2', execution_connected,
    }), true);
  }
});

test('rejects missing, unknown, and unknown-version fields', () => {
  const missing = legacy();
  delete missing.identity;
  const extra = { ...legacy(), receipt: { state: 'QUEUED' } };
  const unknownVersion = { ...legacy(), schema_version: 'ifpmic.local-context.v3' };

  assert.equal(validateDemoContext(missing), false);
  assert.equal(validateDemoContext(extra), false);
  assert.equal(validateDemoContext(unknownVersion), false);
});

test('rejects nonboolean health and untrusted project/profile/storage/identity/release values', () => {
  const invalid = [
    { execution_connected: 1 },
    { execution_connected: 'true' },
    { project_id: 'other-project' },
    { profile_version: 'other-profile' },
    { storage: 'other-storage' },
    { identity: 'other-identity' },
    { release_modes: ['team_github_tag', 'local'] },
  ];
  for (const changes of invalid) {
    assert.equal(validateDemoContext({ ...legacy(), ...changes }), false);
  }
});


test('versioned contract and UI validator agree on the capability boundary', () => {
  const schema = JSON.parse(readFileSync(new URL('../docs/ifpmic/api-extensions/local-context.v2.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020().compile(schema);
  for (const connected of [false, true]) {
    const context = { ...DEMO_CONTEXT, schema_version: 'ifpmic.local-context.v2', execution_connected: connected };
    assert.equal(validate(context), true);
    assert.equal(validateDemoContext(context), true);
    for (const invalid of [{ ...context, execution_connected: 'true' }, { ...context, admitted_run_id: 'invented' }, { ...context, schema_version: 'unknown' }]) {
      assert.equal(validate(invalid), false);
      assert.equal(validateDemoContext(invalid), false);
    }
  }
});
