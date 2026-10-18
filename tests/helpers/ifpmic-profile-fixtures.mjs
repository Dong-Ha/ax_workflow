// Independent fixed fixtures for B01 tests. These values intentionally do not
// import the product schema, validator, completeness rules, or sample profile.
export const validProfile = Object.freeze({
  schema_version: '1.0.0',
  project_id: 'tc-fixed-project',
  mode: 'real',
  enabled: true,
  source: {
    repository_ref: 'https://example.invalid/repo.git',
    base_ref: 'refs/heads/main',
    driver_paths: ['drivers/ifpmic', 'drivers/shared-pmic'],
    test_paths: ['tests/ifpmic'],
  },
  runtimes: {
    primary: 'claude-code',
    secondary: 'opencode',
    provider_profile_ref: 'provider-profile-fixture-01',
    model_id: 'model-fixture-01',
    versions: { claude_code: '1.2.3', opencode: '4.5.6' },
  },
  build: {
    profile_ref: 'build-profile-fixture-01',
    toolchain_digest: 'sha256:toolchain-fixture',
    kernel_config_digest: 'sha256:kernel-fixture',
    timeout_minutes: 45,
    artifact_patterns: ['out/ifpmic/*.bin'],
  },
  quality: {
    sam: { program_ref: 'sam-fixture', parser_version: '1', rule_version: '2', thresholds_ref: 'sam-thresholds-fixture' },
    tem: { program_ref: 'tem-fixture', parser_version: '3', rule_version: '4', thresholds_ref: 'tem-thresholds-fixture' },
    static: { program_ref: 'static-fixture', parser_version: '5', rule_version: '6', thresholds_ref: 'static-thresholds-fixture' },
  },
  device: {
    bridge_id: 'bridge-fixture',
    device_id: 'device-fixture',
    adb_serial: 'adb-fixture',
    fastboot_serial: 'fastboot-fixture',
    board_id: 'board-fixture',
    flash_profile_ref: 'flash-fixture',
    boot_identity_method: 'fixture-boot-identity',
    sqe_script_ref: 'sqe-fixture',
    sqe_expected_cases: ['boot', 'flash', 'recovery'],
  },
  release: {
    mode: 'team_github_tag',
    repository_ref: 'release-repository-fixture',
    target_ref: 'refs/tags/v1.2.3',
    version: '1.2.3',
    reviewers: ['reviewer-fixture-01'],
  },
  approval: { plan_required: true, release_required: true, require_distinct_approver: false },
  validation: 'synthetic test fixture; no environment or approval claim',
});

export const validProfileText = () => JSON.stringify(validProfile);

export const cloneProfile = () => structuredClone(validProfile);

export const stableProfileText = (profile = validProfile) => JSON.stringify(profile);

export const schemaMutationCases = Object.freeze([
  { id: 'root-schema-version-missing', path: '/schema_version', mutate: p => { delete p.schema_version; } },
  { id: 'project-id-null', path: '/project_id', mutate: p => { p.project_id = null; } },
  { id: 'mode-wrong-enum', path: '/mode', mutate: p => { p.mode = 'sandbox'; } },
  { id: 'enabled-string', path: '/enabled', mutate: p => { p.enabled = 'true'; } },
  { id: 'source-repository-missing', path: '/source/repository_ref', mutate: p => { delete p.source.repository_ref; } },
  { id: 'source-base-null', path: '/source/base_ref', mutate: p => { p.source.base_ref = null; } },
  { id: 'source-driver-paths-object', path: '/source/driver_paths', mutate: p => { p.source.driver_paths = {}; } },
  { id: 'source-driver-paths-duplicate', path: '/source/driver_paths', mutate: p => { p.source.driver_paths = ['drivers/ifpmic', 'drivers/ifpmic']; } },
  { id: 'source-test-paths-extra', path: '', mutate: p => { p.source.extra = 'unknown'; } },
  { id: 'runtime-primary-wrong', path: '/runtimes/primary', mutate: p => { p.runtimes.primary = 'other'; } },
  { id: 'runtime-secondary-missing', path: '/runtimes/secondary', mutate: p => { delete p.runtimes.secondary; } },
  { id: 'runtime-version-null', path: '/runtimes/versions/opencode', mutate: p => { p.runtimes.versions.opencode = null; } },
  { id: 'build-timeout-zero', path: '/build/timeout_minutes', mutate: p => { p.build.timeout_minutes = 0; } },
  { id: 'build-timeout-fraction', path: '/build/timeout_minutes', mutate: p => { p.build.timeout_minutes = 1.5; } },
  { id: 'quality-sam-missing', path: '/quality/sam', mutate: p => { delete p.quality.sam; } },
  { id: 'quality-tem-extra', path: '', mutate: p => { p.quality.tem.unknown = 'no'; } },
  { id: 'device-serial-number', path: '/device/adb_serial', mutate: p => { p.device.adb_serial = 8; } },
  { id: 'device-sqe-cases-null', path: '/device/sqe_expected_cases', mutate: p => { p.device.sqe_expected_cases = null; } },
  { id: 'release-mode-wrong', path: '/release/mode', mutate: p => { p.release.mode = 'unknown_release'; } },
  { id: 'release-reviewers-number', path: '/release/reviewers', mutate: p => { p.release.reviewers = [2]; } },
  { id: 'approval-plan-false', path: '/approval/plan_required', mutate: p => { p.approval.plan_required = false; } },
  { id: 'approval-distinct-null', path: '/approval/require_distinct_approver', mutate: p => { p.approval.require_distinct_approver = null; } },
  { id: 'unknown-root-field', path: '', mutate: p => { p.secret = 'PROFILE_SENTINEL_MUST_NOT_LEAK'; } },
  { id: 'validation-not-string', path: '/validation', mutate: p => { p.validation = 42; } },
]);
