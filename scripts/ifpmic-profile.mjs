import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { ProfileError, validateProfileText, createSnapshot, initStore, publishSnapshot, readSnapshot } from '../runtime/ifpmic/index.mjs'

const fail = code => { throw new ProfileError(code) }
const switches = new Set(['--snapshot', '--read', '--init-store', '--require-real-config'])
const values = new Set(['--profile', '--profile-version', '--project-id', '--store'])
function args(argv) {
  const flags = new Map()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flags.has(flag) || (!switches.has(flag) && !values.has(flag))) fail('CLI_USAGE')
    if (values.has(flag)) {
      const value = argv[++i]
      if (!value || value.startsWith('--')) fail('CLI_USAGE')
      flags.set(flag, value)
    } else flags.set(flag, true)
  }
  const selected = ['--snapshot', '--read', '--init-store'].filter(flag => flags.has(flag))
  if (selected.length > 1) fail('CLI_USAGE')
  const mode = selected[0] ?? 'validate'
  const allowed = {
    validate: ['--profile', '--require-real-config'],
    '--snapshot': ['--snapshot', '--profile', '--profile-version', '--store', '--require-real-config'],
    '--read': ['--read', '--project-id', '--profile-version', '--store'],
    '--init-store': ['--init-store', '--store'],
  }[mode]
  if ([...flags.keys()].some(flag => !allowed.includes(flag))) fail('CLI_USAGE')
  const required = { validate: [], '--snapshot': ['--profile-version', '--store'], '--read': ['--project-id', '--profile-version', '--store'], '--init-store': ['--store'] }[mode]
  if (required.some(flag => !flags.has(flag))) fail('CLI_USAGE')
  return { flags, mode }
}
const hashes = record => ({ snapshot_id: record.snapshot_id, profile_sha256: record.payload.profile_sha256, bundle_sha256: record.payload.workflow.bundle_sha256 })
async function main() {
  const { flags, mode } = args(process.argv.slice(2))
  if (mode === '--init-store') return initStore(flags.get('--store'))
  if (mode === '--read') return hashes(await readSnapshot(flags.get('--store'), { projectId: flags.get('--project-id'), profileVersion: flags.get('--profile-version') }))
  const path = flags.get('--profile') ?? fileURLToPath(new URL('../docs/ifpmic/design-v1/specs/project-profile.example.json', import.meta.url))
  let bytes
  try { bytes = await readFile(path) } catch { fail('PROFILE_IO') }
  if (bytes.length > 1024 * 1024) {
    const result = validateProfileText(' '.repeat(1024 * 1024 + 1)); process.exitCode = 2; return result
  }
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { fail('INPUT_ENCODING') }
  const result = validateProfileText(text)
  const config = result.configuration
  if (!result.schema_valid || (flags.has('--require-real-config') && (!config || config.mode !== 'real' || !config.enabled || !config.complete))) {
    process.exitCode = 2; return result
  }
  if (mode === '--snapshot') return hashes(await publishSnapshot(flags.get('--store'), createSnapshot({ profileText: text, profileVersion: flags.get('--profile-version') })))
  return result
}
try { console.log(JSON.stringify(await main())) }
catch (error) {
  const code = error instanceof ProfileError ? error.code : 'STORE_IO'
  process.exitCode = ['STORE_IO', 'STORE_INVALID', 'PROFILE_IO', 'SNAPSHOT_CORRUPT', 'PUBLICATION_UNCERTAIN'].includes(code) ? 3 : 2
  console.log(JSON.stringify({ error: { code } }))
}
