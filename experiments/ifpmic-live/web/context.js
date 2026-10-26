export const DEMO_CONTEXT = Object.freeze({
  project_id: 'ifpmic-local-demo',
  profile_version: 'local-demo-v1',
  release_modes: Object.freeze(['team_github_tag']),
  execution_connected: false,
  storage: 'postgresql',
  identity: 'local-demo-oidc',
});

const LEGACY_KEYS = Object.freeze([
  'project_id', 'profile_version', 'release_modes', 'execution_connected',
  'storage', 'identity',
]);
const VERSIONED_KEYS = Object.freeze([...LEGACY_KEYS, 'schema_version']);

function hasExactKeys(value, expected) {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length &&
    keys.every(key => typeof key === 'string' && expected.includes(key));
}

/**
 * Validate the local capability and owned-process health context. This flag
 * does not prove admission, a receipt, or a QUEUED state.
 */
export function validateDemoContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return false;
  const keys = hasExactKeys(context, LEGACY_KEYS)
    ? LEGACY_KEYS
    : hasExactKeys(context, VERSIONED_KEYS) ? VERSIONED_KEYS : null;
  if (!keys) return false;
  if (Object.getPrototypeOf(context) !== Object.prototype &&
      Object.getPrototypeOf(context) !== null) return false;

  if (keys === VERSIONED_KEYS && context.schema_version !== 'ifpmic.local-context.v2') {
    return false;
  }
  return context.project_id === DEMO_CONTEXT.project_id &&
    context.profile_version === DEMO_CONTEXT.profile_version &&
    Array.isArray(context.release_modes) && context.release_modes.length === 1 &&
    context.release_modes[0] === 'team_github_tag' &&
    (keys === LEGACY_KEYS
      ? context.execution_connected === false
      : typeof context.execution_connected === 'boolean') &&
    context.storage === DEMO_CONTEXT.storage &&
    context.identity === DEMO_CONTEXT.identity;
}
