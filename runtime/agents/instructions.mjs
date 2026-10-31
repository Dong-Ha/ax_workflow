import { createHash } from 'node:crypto';
import { readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INVALID = 'AGENT_INSTRUCTIONS_INVALID';
const MAX_BYTES = 128 * 1024;
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../agents');
const CONTRACT_PATH = path.resolve(DEFAULT_ROOT, '../docs/ifpmic/design-v1/specs/workflow.v1.json');
const EXPECTED_ROLES = ['spec-gen', 'tc', 'code-dev', 'arch-runner', 'sqe', 'report'];

function invalid() {
  return new Error(INVALID);
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function expectedStepMap(workflow) {
  const map = Object.fromEntries(EXPECTED_ROLES.map((role) => [role, []]));
  for (const node of workflow.nodes ?? []) {
    if (Object.hasOwn(map, node.owner)) map[node.owner].push(node.id);
  }
  return map;
}

async function readPinned(base, relative, { maxBytes = MAX_BYTES } = {}) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\')) throw invalid();
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw invalid();
  let cursor = base;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let info;
    try { info = await lstat(cursor); } catch { throw invalid(); }
    if (info.isSymbolicLink()) throw invalid();
  }
  let absolute;
  try { absolute = await realpath(cursor); } catch { throw invalid(); }
  if (absolute !== cursor) throw invalid();
  let info;
  try { info = await lstat(cursor); } catch { throw invalid(); }
  if (!info.isFile() || info.size === 0 || info.size > maxBytes) throw invalid();
  let bytes;
  try { bytes = await readFile(cursor); } catch { throw invalid(); }
  if (!bytes.length || bytes.length > maxBytes) throw invalid();
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { throw invalid(); }
  if (!text.length) throw invalid();
  return { bytes, text };
}

async function assertNoSymlinkComponents(absolutePath) {
  const resolved = path.resolve(absolutePath);
  const parts = resolved.split(path.sep).filter(Boolean);
  let cursor = path.parse(resolved).root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let info;
    try { info = await lstat(cursor); } catch { throw invalid(); }
    if (info.isSymbolicLink()) throw invalid();
  }
}

export async function loadInstructions(role, step, { root = DEFAULT_ROOT } = {}) {
  try {
    if (!EXPECTED_ROLES.includes(role) || typeof step !== 'string' || !/^([PX]\d{2})$/.test(step)) throw invalid();
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw invalid();
    const base = path.resolve(root);
    await assertNoSymlinkComponents(base);
    const registryFile = await readPinned(base, 'registry.json');
    const commonFile = await readPinned(base, 'common.md');
    const workflowFile = await readPinned(path.dirname(CONTRACT_PATH), 'workflow.v1.json');
    let registry;
    let workflow;
    try {
      registry = JSON.parse(registryFile.text);
      workflow = JSON.parse(workflowFile.text);
    } catch { throw invalid(); }

    const expected = expectedStepMap(workflow);
    if (registry.schema_version !== 'ax.agent-registry.v1' || registry.common !== 'common.md') throw invalid();
    if (!registry.roles || Object.keys(registry.roles).length !== EXPECTED_ROLES.length) throw invalid();
    for (const expectedRole of EXPECTED_ROLES) {
      const entry = registry.roles[expectedRole];
      if (!entry || entry.instructions !== `${expectedRole}/AGENTS.md` ||
          !Array.isArray(entry.steps) || JSON.stringify(entry.steps) !== JSON.stringify(expected[expectedRole])) throw invalid();
    }
    const entry = registry.roles[role];
    if (!entry.steps.includes(step)) throw invalid();
    const roleFile = await readPinned(base, `${role}/AGENTS.md`);
    const files = [
      { path: 'registry.json', sha256: sha256(registryFile.bytes) },
      { path: 'common.md', sha256: sha256(commonFile.bytes) },
      { path: `${role}/AGENTS.md`, sha256: sha256(roleFile.bytes) },
    ];
    const bundleHashInput = [
      'registry.json', registryFile.bytes,
      'common.md', commonFile.bytes,
      `${role}/AGENTS.md`, roleFile.bytes,
    ].reduce((hash, item) => {
      if (typeof item === 'string') {
        const bytes = Buffer.from(item, 'utf8');
        const length = Buffer.alloc(4);
        length.writeUInt32BE(bytes.length);
        hash.update(length).update(bytes);
      } else {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(item.length);
        hash.update(length).update(item);
      }
      return hash;
    }, createHash('sha256')).digest('hex');
    return {
      role,
      step,
      files,
      bundle_sha256: bundleHashInput,
      text: `## 공통 지침\n\n${commonFile.text}\n\n## ${role} 역할 지침 (${step})\n\n${roleFile.text}`,
    };
  } catch {
    throw invalid();
  }
}
