import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInstructions } from '../runtime/agents/instructions.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceAgents = path.join(repo, 'agents');
const mappings = {
  'spec-gen': ['P01', 'P02', 'P03', 'P04', 'P05'],
  tc: ['P09', 'P12'],
  'code-dev': ['P11', 'P13', 'P14'],
  'arch-runner': ['P15', 'P17', 'P19'],
  sqe: ['P22', 'P23'],
  report: ['X02', 'P25', 'P26'],
};

async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ax-agent-instructions-'));
  const root = path.join(temp, 'agents');
  await mkdir(root);
  await writeFile(path.join(root, 'registry.json'), await readFile(path.join(sourceAgents, 'registry.json')));
  await writeFile(path.join(root, 'common.md'), await readFile(path.join(sourceAgents, 'common.md')));
  for (const role of Object.keys(mappings)) {
    await mkdir(path.join(root, role));
    await writeFile(path.join(root, role, 'AGENTS.md'), await readFile(path.join(sourceAgents, role, 'AGENTS.md')));
  }
  t.after(() => rm(temp, { recursive: true, force: true }));
  return root;
}

test('registry role/step mapping matches workflow contract', async (t) => {
  const root = await fixture(t);
  for (const [role, steps] of Object.entries(mappings)) {
    for (const step of steps) {
      const bundle = await loadInstructions(role, step, { root });
      assert.equal(bundle.role, role);
      assert.equal(bundle.step, step);
      assert.equal(bundle.files.length, 3);
      assert.match(bundle.bundle_sha256, /^[a-f0-9]{64}$/);
      assert.match(bundle.text, new RegExp(`${role} 역할 지침`));
    }
  }
});

test('unknown roles, unassigned steps, and traversal are rejected uniformly', async (t) => {
  const root = await fixture(t);
  for (const [role, step] of [['unknown', 'P01'], ['tc', 'P01'], ['../tc', 'P09'], ['tc', '../P09']]) {
    await assert.rejects(loadInstructions(role, step, { root }), { message: 'AGENT_INSTRUCTIONS_INVALID' });
  }
});

test('role paths cannot be replaced with symlinks', async (t) => {
  const root = await fixture(t);
  await rm(path.join(root, 'tc', 'AGENTS.md'));
  await symlink(path.join(sourceAgents, 'tc', 'AGENTS.md'), path.join(root, 'tc', 'AGENTS.md'));
  await assert.rejects(loadInstructions('tc', 'P09', { root }), { message: 'AGENT_INSTRUCTIONS_INVALID' });
});

test('returned bundle is a snapshot and later edits produce new hashes', async (t) => {
  const root = await fixture(t);
  const oldBundle = await loadInstructions('spec-gen', 'P01', { root });
  await writeFile(path.join(root, 'spec-gen', 'AGENTS.md'), '# changed instruction\n');
  const newBundle = await loadInstructions('spec-gen', 'P01', { root });
  assert.notEqual(oldBundle.bundle_sha256, newBundle.bundle_sha256);
  assert.notEqual(oldBundle.files[2].sha256, newBundle.files[2].sha256);
  assert.match(oldBundle.text, /요구사항 입수/);
  assert.doesNotMatch(oldBundle.text, /changed instruction/);
});

test('empty, oversized, and invalid UTF-8 role files are rejected', async (t) => {
  const root = await fixture(t);
  const rolePath = path.join(root, 'tc', 'AGENTS.md');
  for (const contents of [Buffer.alloc(0), Buffer.alloc(128 * 1024 + 1, 0x61), Buffer.from([0xc3, 0x28])]) {
    await writeFile(rolePath, contents);
    await assert.rejects(loadInstructions('tc', 'P09', { root }), { message: 'AGENT_INSTRUCTIONS_INVALID' });
  }
});

test('registry mapping mismatch is rejected', async (t) => {
  const root = await fixture(t);
  const registryPath = path.join(root, 'registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  registry.roles.report.steps = ['X02', 'P26', 'P25'];
  await writeFile(registryPath, JSON.stringify(registry));
  await assert.rejects(loadInstructions('report', 'X02', { root }), { message: 'AGENT_INSTRUCTIONS_INVALID' });
});
