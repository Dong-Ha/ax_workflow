// Private subprocess protocol. This is deliberately separate from the public CLI.
import { canonical, getWorkflow, sha256, versionKey } from '../../runtime/ifpmic/snapshot.mjs'
import { readSnapshot } from '../../runtime/ifpmic/store.mjs'
import { validIdentity } from '../../runtime/ifpmic/profile.mjs'

const protocol = 'ifpmic.snapshot-bridge.v1'
const limit = 6 * 1024 * 1024 + 4096
const fail = code => { process.stdout.write(JSON.stringify({ error: { code } }) + '\n'); process.exitCode = 2 }
const allowed = new Set(['STORE_INVALID', 'STORE_IO', 'SNAPSHOT_CORRUPT', 'CONTRACT_MISMATCH', 'PROFILE_VERSION_INVALID', 'PROFILE_INVALID'])

function request(text) {
  const value = JSON.parse(text)
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'operation,profile_version,project_id,protocol' ||
      Object.values(value).some(item => typeof item !== 'string')) throw new Error()
  // All four values are strings. Scan the original object to reject duplicate
  // keys, including escaped spellings; JSON.parse alone keeps the last value.
  let index = 0
  const space = () => { while (/[ \t\r\n]/.test(text[index] ?? '') && index < text.length) index++ }
  const token = () => {
    space(); const start = index
    if (text[index++] !== '"') throw new Error()
    while (index < text.length) {
      if (text[index] === '\\') index += 2
      else if (text[index++] === '"') return JSON.parse(text.slice(start, index))
    }
    throw new Error()
  }
  space(); if (text[index++] !== '{') throw new Error()
  const keys = new Set()
  for (let count = 0; count < 4; count++) {
    const key = token()
    if (keys.has(key)) throw new Error()
    keys.add(key); space(); if (text[index++] !== ':') throw new Error()
    token(); space(); if (text[index++] !== (count === 3 ? '}' : ',')) throw new Error()
  }
  space(); if (index !== text.length) throw new Error()
  if (value.protocol !== protocol || value.operation !== 'read_snapshot' || !validIdentity(value.project_id) ||
      !validIdentity(value.profile_version) || /[\uD800-\uDFFF]/u.test(value.project_id)) throw new Error()
  return value
}

async function main() {
  if (process.argv.length !== 3) return fail('BRIDGE_INVALID_REQUEST')
  const chunks = []; let size = 0
  try {
    for await (const chunk of process.stdin) {
      size += chunk.length
      if (size > limit) { fail('BRIDGE_INVALID_REQUEST'); process.stdin.destroy(); return }
      chunks.push(chunk)
    }
    let input
    try { input = request(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
    catch { return fail('BRIDGE_INVALID_REQUEST') }
    const record = await readSnapshot(process.argv[2], { projectId: input.project_id, profileVersion: input.profile_version })
    // readSnapshot validates the complete immutable B01 bundle and canonical bytes.
    getWorkflow(record.payload.workflow.workflow_id)
    const bytes = Buffer.from(canonical(record) + '\n')
    process.stdout.write(JSON.stringify({ protocol, record_base64: bytes.toString('base64'),
      record_bytes_sha256: sha256(bytes), version_key: versionKey(input.project_id, input.profile_version) }) + '\n')
  } catch (error) { fail(allowed.has(error?.code) ? error.code : 'BRIDGE_UNAVAILABLE') }
}
await main()
