// Synthetic registry only: not an approved physical-device or production test profile.
export const mockSqeProfile = Object.freeze({
  profile_ref: 'mock:sqe:profile', profile_version: 'mock:sqe:profile:v1',
  script_version: 'mock:sqe:script:v1', parser_version: 'mock:sqe:parser:v1', rule_version: 'mock:rules:v1',
  expected_cases: Object.freeze(['mock:sqe:case:boot', 'mock:sqe:case:function']),
});
