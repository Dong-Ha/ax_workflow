import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ProfileError, parseProfileText, validateProfileText, validIdentity } from './profile.mjs'

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  throw new ProfileError('PROFILE_INVALID')
}
export function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}
const sourcePins = {
  'workflow.v1.json': 'bab40a7abb3929896add1ef2cd074893dd2a7de14d200a5d6cea4b7a77eb0e89',
  'state-contract.json': '0248e130017043539319c56af854f5388a95d33e7e687902a3438fdff414244a',
  'agent-contract.json': 'ca6d4bea7abf0fffe7354c482af0d521c3a2e367217a69923a4bfe43fa27ab64',
}

export function getWorkflow(workflowId = 'ifpmic-sw-v1') {
  if (workflowId !== 'ifpmic-sw-v1') throw new ProfileError('WORKFLOW_UNKNOWN')
  try {
    const base = new URL('../../docs/ifpmic/design-v1/', import.meta.url)
    const manifest = JSON.parse(readFileSync(new URL('qa/package-manifest.json', base), 'utf8'))
    const contracts = {}
    for (const [file, digest] of Object.entries(sourcePins)) {
      const raw = readFileSync(new URL(`specs/${file}`, base))
      if (sha256(raw) !== digest || manifest[`specs/${file}`] !== digest) throw new Error()
      contracts[file] = JSON.parse(raw.toString('utf8'))
    }
    const bundle = { workflow_source_sha256: sourcePins['workflow.v1.json'], state_source_sha256: sourcePins['state-contract.json'], agent_source_sha256: sourcePins['agent-contract.json'] }
    return freeze({ reference: { workflow_id: workflowId, schema_version: '1.0.0', source_sha256: bundle.workflow_source_sha256,
      state_source_sha256: bundle.state_source_sha256, agent_source_sha256: bundle.agent_source_sha256, bundle_sha256: sha256(canonical(bundle)) },
    contracts: { workflow: contracts['workflow.v1.json'], state: contracts['state-contract.json'], agent: contracts['agent-contract.json'] } })
  } catch { throw new ProfileError('CONTRACT_MISMATCH') }
}

export function createSnapshot({ profileText, profileVersion, workflowId = 'ifpmic-sw-v1' }) {
  if (!validIdentity(profileVersion)) throw new ProfileError('PROFILE_VERSION_INVALID')
  if (!validateProfileText(profileText).schema_valid) throw new ProfileError('PROFILE_INVALID')
  const profile = parseProfileText(profileText)
  const payload = { format: 'ifpmic.profile-snapshot.v1', canonicalization: 'ifpmic-json-v1', project_id: profile.project_id,
    profile_version: profileVersion, workflow: getWorkflow(workflowId).reference, profile_sha256: sha256(canonical(profile)), profile }
  const record = { snapshot_id: sha256(canonical(payload)), payload }
  if (Buffer.byteLength(canonical(record) + '\n', 'utf8') > 2 * 1024 * 1024) throw new ProfileError('PROFILE_VERSION_INVALID')
  return freeze(record)
}

// Reject accessors, exotic objects and cycles before serializing a caller-owned record.
export function captureRecord(record) {
  const seen = new Set()
  function inspect(value, depth = 1) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return
    if (typeof value === 'number' && Number.isFinite(value)) return
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 64) throw new ProfileError('SNAPSHOT_CORRUPT')
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ProfileError('SNAPSHOT_CORRUPT')
    seen.add(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Array.isArray(value)) {
      if (Object.keys(descriptors).length !== value.length + 1) throw new ProfileError('SNAPSHOT_CORRUPT')
      for (let i = 0; i < value.length; i++) if (!Object.hasOwn(descriptors, String(i))) throw new ProfileError('SNAPSHOT_CORRUPT')
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(value) && key === 'length') continue
      if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new ProfileError('SNAPSHOT_CORRUPT')
      inspect(descriptor.value, depth + 1)
    }
    if (Object.getOwnPropertySymbols(value).length) throw new ProfileError('SNAPSHOT_CORRUPT')
    seen.delete(value)
  }
  let raw, copy
  try { inspect(record); raw = canonical(record); copy = JSON.parse(raw) }
  catch { throw new ProfileError('SNAPSHOT_CORRUPT') }
  if (Buffer.byteLength(raw + '\n') > 2 * 1024 * 1024) throw new ProfileError('SNAPSHOT_CORRUPT')
  let expected
  try {
    expected = createSnapshot({ profileText: canonical(copy.payload.profile), profileVersion: copy.payload.profile_version,
      workflowId: copy.payload.workflow.workflow_id })
  } catch { throw new ProfileError('SNAPSHOT_CORRUPT') }
  if (canonical(expected) !== raw) throw new ProfileError('SNAPSHOT_CORRUPT')
  return expected
}

export function versionKey(projectId, profileVersion) {
  if (!validIdentity(projectId)) throw new ProfileError('PROFILE_INVALID')
  if (!validIdentity(profileVersion)) throw new ProfileError('PROFILE_VERSION_INVALID')
  return sha256(canonical([projectId, profileVersion]))
}
