import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import React, { Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import {
  makeChildrenHarness, baseChildContext, coordinatorPayload, requestPayload,
  assignmentPayload, resultPayload, collectPayload, integratedPayload,
} from './helpers/ifpmic-children.mjs';

test('P12 child evidence from candidate A is rendered as historical after candidate B becomes current', async () => {
  const h = makeChildrenHarness('child-render-stale-candidate');
  h.reachP12();
  const context = baseChildContext(h);
  h.add('p12_coordinator', 'P12', coordinatorPayload(h, context));
  h.add('child_request', 'P12', requestPayload(h, context));
  h.add('child_assignment', 'P12', assignmentPayload(h, context));
  const completed = resultPayload(h, context);
  h.add('child_result', 'P12', completed);
  h.add('child_collect', 'P12', collectPayload(h, context, completed.evidence_id));
  h.add('child_integrated', 'P12', integratedPayload(h, context));
  h.add('step', 'P12', { state: 'SUCCEEDED' });
  h.add('step', 'P13', { state: 'READY' });
  h.add('step', 'P13', { state: 'RUNNING' });
  const oldP12Coordination = structuredClone(h.current().steps.P12.child_coordination);
  const candidateB = h.add('candidate', 'P13', { candidate_fingerprint: 'mock:candidate:B' });
  assert.equal(candidateB.candidate_fingerprint, 'mock:candidate:B');
  assert.equal(candidateB.steps.P12.state, 'SUCCEEDED');
  assert.deepEqual(candidateB.steps.P12.child_coordination, oldP12Coordination, 'candidate change preserves the original child record byte-for-byte');
  assert.equal(candidateB.release.publication_count, 0);
  assert.equal(candidateB.real_publish_allowed, false);

  const outputDir = await mkdtemp(path.join(process.cwd(), 'workflow-artifacts/verification/V2/children/render-'));
  try {
    const entry = path.resolve('src/ifpmic/ChildObservations.tsx');
    const output = path.join(outputDir, 'ChildObservations.mjs');
    await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', external: ['react'], outfile: output });
    const { ChildObservations, StepChildDetails } = await import(`${pathToFileURL(output).href}?candidate=${Date.now()}`);
    const snapshot = h.current();
    const html = renderToStaticMarkup(React.createElement(Fragment, null,
      React.createElement(ChildObservations, { snapshot }),
      React.createElement(StepChildDetails, { step: snapshot.steps.P12, snapshot }),
    ));
    assert.match(html, /data-current-evidence="false"/);
    assert.match(html, /과거 · 현재 권한 아님/);
    assert.match(html, /mock:candidate:A/);
    assert.match(html, /현재 mock:candidate:B/);
    assert.match(html, /data-testid="ifpmic-child-history"/);
    assert.doesNotMatch(html, /data-testid="ifpmic-child-step-detail"/);
    assert.doesNotMatch(html, /현재 P12 근거/);
    assert.match(html, /integrated/);

    const contextOnly = makeChildrenHarness('child-render-context-only');
    contextOnly.reachP12();
    const waitingContext = baseChildContext(contextOnly);
    contextOnly.add('p12_coordinator', 'P12', coordinatorPayload(contextOnly, waitingContext));
    const waitingSnapshot = contextOnly.current();
    const waitingHtml = renderToStaticMarkup(React.createElement(Fragment, null,
      React.createElement(ChildObservations, { snapshot: waitingSnapshot }),
      React.createElement(StepChildDetails, { step: waitingSnapshot.steps.P12, snapshot: waitingSnapshot }),
    ));
    assert.match(waitingHtml, /data-current-evidence="true"/);
    assert.match(waitingHtml, /data-testid="ifpmic-child-step-detail"/);
    assert.match(waitingHtml, /data-child-execution-id=""/);
    assert.match(waitingHtml, /mock:children:child-render-context-only:coord-task:c1:a1/);
    assert.match(waitingHtml, /mock:P11:c1:a1/);
    assert.match(waitingHtml, /mock:artifact:child-render-context-only:tc-design:c1/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
