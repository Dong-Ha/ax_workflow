import Ajv2020 from 'ajv/dist/2020.js'

export class ProfileError extends Error {
  constructor(code) { super(code); this.name = 'ProfileError'; this.code = code }
}

const string = { type: 'string', minLength: 1, pattern: '^[^\\u0000-\\u001f\\u007f]+$' }
const strings = { type: 'array', items: string, uniqueItems: true }
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const quality = object({ program_ref: string, parser_version: string, rule_version: string, thresholds_ref: string })
export const profileSchema = object({
  schema_version: { const: '1.0.0' }, project_id: string,
  mode: { enum: ['mock', 'real'] }, enabled: { type: 'boolean' },
  source: object({ repository_ref: string, base_ref: string, driver_paths: strings, test_paths: strings }),
  runtimes: object({ primary: { const: 'claude-code' }, secondary: { const: 'opencode' }, provider_profile_ref: string, model_id: string,
    versions: object({ claude_code: string, opencode: string }) }),
  build: object({ profile_ref: string, toolchain_digest: string, kernel_config_digest: string,
    timeout_minutes: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, artifact_patterns: strings }),
  quality: object({ sam: quality, tem: quality, static: quality }),
  device: object({ bridge_id: string, device_id: string, adb_serial: string, fastboot_serial: string, board_id: string,
    flash_profile_ref: string, boot_identity_method: string, sqe_script_ref: string, sqe_expected_cases: strings }),
  release: object({ mode: { enum: ['team_github_tag', 'shared_gerrit_change', 'shared_github_pr', 'shared_github_commit'] }, repository_ref: string,
    target_ref: string, version: string, reviewers: strings }),
  approval: object({ plan_required: { const: true }, release_required: { const: true }, require_distinct_approver: { type: 'boolean' } }),
  validation: string,
})
profileSchema.$schema = 'https://json-schema.org/draft/2020-12/schema'
const validator = new Ajv2020({ allErrors: true, strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false,
  messages: false, verbose: false, logger: false }).compile(profileSchema)
const known = new Set([''])
function indexPaths(schema, path = '') {
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const next = `${path}/${key}`; known.add(next); indexPaths(child, next)
  }
}
indexPaths(profileSchema)
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
export const validIdentity = value => typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value)

export function parseProfileText(text) {
  if (typeof text !== 'string') throw new ProfileError('INPUT_TYPE')
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new ProfileError('INPUT_TOO_LARGE')
  let parsed
  try { parsed = JSON.parse(text) } catch { throw new ProfileError('JSON_INVALID') }
  let offset = 0
  const whitespace = () => { while (/\s/u.test(text[offset] ?? '') && offset < text.length) offset++ }
  function tokenString() {
    const start = offset++
    while (offset < text.length) {
      if (text[offset] === '\\') offset += 2
      else if (text[offset++] === '"') break
    }
    return JSON.parse(text.slice(start, offset))
  }
  function scan(depth) {
    whitespace()
    const char = text[offset]
    if (char === '{' || char === '[') {
      if (depth > 64) throw new ProfileError('JSON_DEPTH_EXCEEDED')
      const isObject = char === '{', end = isObject ? '}' : ']'; offset++; whitespace()
      const keys = new Set()
      if (text[offset] === end) { offset++; return }
      while (offset < text.length) {
        if (isObject) {
          whitespace(); const key = tokenString()
          if (keys.has(key)) throw new ProfileError('JSON_DUPLICATE_KEY')
          keys.add(key); whitespace(); offset++
        }
        scan(depth + 1); whitespace()
        if (text[offset++] === end) return
      }
    } else if (char === '"') tokenString()
    else { while (offset < text.length && !/[,\]}\s]/u.test(text[offset])) offset++ }
  }
  scan(1)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ProfileError('PROFILE_ROOT_INVALID')
  return parsed
}

function configuration(profile) {
  const unresolved = new Set()
  const markers = ['CONFIGURE', 'APPROVED_BEDROCK_PROFILE', 'PIN_AFTER_COMPATIBILITY_TEST', 'INTERNAL_EXISTING_RULES']
  function visit(value, path) {
    if (typeof value === 'string' && markers.some(marker => value.includes(marker))) unresolved.add(path)
    else if (Array.isArray(value)) {
      if (!value.length) unresolved.add(path)
      for (const item of value) visit(item, path)
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) visit(child, `${path}/${key}`)
    }
  }
  for (const key of ['source', 'runtimes', 'build', 'quality', 'device', 'release']) visit(profile[key], `/${key}`)
  return { mode: profile.mode, enabled: profile.enabled, complete: unresolved.size === 0, unresolved_paths: [...unresolved].sort(compare) }
}

export function validateProfileText(text) {
  const result = { schema_valid: false, issues: [], configuration: null, operational_validation: 'not_checked', approval: 'not_evaluated' }
  let profile
  try { profile = parseProfileText(text) }
  catch (error) { result.issues.push({ code: error.code, path: '' }); return result }
  if (!validator(profile)) {
    const issues = new Map()
    for (const error of validator.errors) {
      let path = error.instancePath
      if (error.keyword === 'required') path += `/${error.params.missingProperty}`
      while (!known.has(path)) path = path.slice(0, Math.max(0, path.lastIndexOf('/')))
      issues.set(path, { code: 'SCHEMA_INVALID', path })
    }
    result.issues = [...issues.values()].sort((a, b) => compare(a.path, b.path) || compare(a.code, b.code))
    return result
  }
  result.schema_valid = true; result.configuration = configuration(profile)
  return result
}
