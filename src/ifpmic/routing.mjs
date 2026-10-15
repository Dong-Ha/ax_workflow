// Synthetic routing proof only. No profile loading, approvals or execution service.
const reuseIds = ['P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10', 'P11', 'P12'];
const earlyIds = ['P03', 'P04', 'P05'];
const pairs = { P16: 'P15', P18: 'P17', P20: 'P19', P24: 'P22' };
const policyIds = ['P15', 'P17', 'P19', 'P21', 'P22'];
const contextKeys = ['profile_id', 'profile_hash', 'profile_kind', 'change_type', 'plan_version',
  'candidate_fingerprint', 'requirements_version', 'source_hash', 'test_hash', 'environment_hash',
  'baseline_environment_hash', 'input_hashes', 'policy_rule_id', 'policy_approval_id'];
const reuseKeys = ['step_id', 'baseline_hash', 'baseline_input_hash', 'current_input_hash', 'reason_id'];
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const clone = value => structuredClone(value);
export function createRoutingProtocols({ result, graph, submissions, transitionAllowed, mockId }) {
  const evidenceIds = new Set(), versions = new Set(), versionBindings = new Map(), hashBindings = new Map();
  const state = () => result.route_plan;
  const context = () => state().context?.cycle === result.cycle ? state().context : null;
  const contextCurrent = () => context() && context().candidate_fingerprint === result.candidate_fingerprint
    && context().requirements_version === result.requirements_version;
  const expectedPlanVersion = () => context()?.plan_version ?? 'mock:plan:v1';
  const freshEvidence = id => mockId(id) && !evidenceIds.has(id);
  const addEvidence = (step, id) => { if (!step.evidence_ids.includes(id)) step.evidence_ids.push(id); };
  const forced = id => result.required_revalidation.includes(id);
  const coordinates = step => ({ cycle: result.cycle, attempt: step.attempt, execution_id: step.execution_id });
  const currentProof = (proof, step) => proof && proof.cycle === result.cycle && proof.attempt === step.attempt
    && proof.execution_id === step.execution_id && proof.candidate_fingerprint === result.candidate_fingerprint
    && proof.requirements_version === result.requirements_version && proof.plan_version === expectedPlanVersion();
  function confirmedCurrent(requireSucceeded = true) {
    const plan = state().confirmed, x01 = result.steps.X01;
    return contextCurrent() && plan && plan.cycle === result.cycle
      && plan.plan_version === expectedPlanVersion() && plan.profile_hash === context().profile_hash
      && plan.candidate_fingerprint === result.candidate_fingerprint && plan.requirements_version === result.requirements_version
      && plan.approval_attempt === x01.attempt && plan.approval_execution_id === x01.execution_id
      && (!requireSucceeded || x01.state === 'SUCCEEDED');
  }
  const reuseEntry = id => state().confirmed?.reuse_steps.find(entry => entry.step_id === id);
  function reusableEnvironment(entry) {
    return context().environment_hash === context().baseline_environment_hash
      && entry.baseline_hash === context().environment_hash
      && entry.current_input_hash === entry.baseline_input_hash;
  }
  function eligibleAnalysis(id) {
    const step = result.steps[id], proof = step.unchanged_analysis;
    const hash = id === 'P11' ? context()?.source_hash : context()?.test_hash;
    return currentProof(proof, step) && proof.actor === (id === 'P11' ? 'mock:code-dev' : 'mock:tc')
      && proof.needs_changes === false && proof.requirements_satisfied === true
      && proof.baseline_hash === hash && proof.current_hash === hash;
  }
  function reuseAuthorization(node, step) {
    if (!contextCurrent() || forced(node.id) || node.skip_policy !== 'REUSE') return null;
    if (context().change_type === 'NEW_HW' && node.id !== 'P10') return null;
    if (earlyIds.includes(node.id)) {
      const proof = state().reuse_confirmations[node.id];
      return currentProof(proof, step) ? proof : null;
    }
    if (!confirmedCurrent()) return null;
    const entry = reuseEntry(node.id);
    if (!entry || entry.current_input_hash !== context().input_hashes[node.id]
        || context().change_type === 'NEW_HW' && !reusableEnvironment(entry)
        || ['P11', 'P12'].includes(node.id) && !eligibleAnalysis(node.id)) return null;
    const plan = state().confirmed;
    return { ...clone(entry), ...coordinates(step), actor: plan.actor, task_id: plan.task_id,
      plan_version: plan.plan_version, candidate_fingerprint: plan.candidate_fingerprint,
      requirements_version: plan.requirements_version, evidence_id: plan.evidence_id };
  }
  function policyCurrent(id) {
    return confirmedCurrent() && !forced(id) && context().profile_kind === 'policy_demo'
      && context().change_type !== 'NEW_HW' && context().policy_rule_id === 'mock:policy:exempt:v1'
      && mockId(context().policy_approval_id) && state().confirmed.exempt_steps.includes(id);
  }
  function validExemptionReport() {
    const step = result.steps.P23, proof = step.exemption_report;
    return currentProof(proof, step) && proof.actor === 'mock:sqe' && proof.performed === false
      && proof.exemption_evidence_id === state().confirmed?.evidence_id
      && mockId(proof.report_id) && mockId(proof.evidence_id);
  }
  function consumedPolicy(id) {
    const step = result.steps[id], basis = step.skip_basis;
    return policyCurrent(id) && step.state === 'SKIPPED' && currentProof(basis, step)
      && basis.evidence_id === state().confirmed.evidence_id && basis.policy_rule_id === context().policy_rule_id
      && basis.rule_version === result.rule_version;
  }
  function exemptionCurrent(id) {
    const paired = pairs[id], step = result.steps[id];
    return Boolean(paired && consumedPolicy(id) && consumedPolicy(paired)
      && step.gate_verdict === 'EXEMPT' && step.gate_complete === false
      && step.gate_candidate_fingerprint === result.candidate_fingerprint && step.gate_rule_version === result.rule_version
      && step.gate_evidence_id === state().confirmed.evidence_id
      && (id !== 'P24' || result.steps.P23.state === 'SUCCEEDED' && validExemptionReport()));
  }
  function applySkip(node, step, authorization) {
    step.state = 'SKIPPED';
    step.skip_basis = { ...clone(authorization), kind: node.skip_policy,
      profile_id: context().profile_id, profile_hash: context().profile_hash, rule_version: result.rule_version,
      policy_rule_id: node.skip_policy === 'REUSE' ? null : context().policy_rule_id };
    addEvidence(step, authorization.evidence_id);
    if (node.skip_policy === 'COUPLED') {
      step.gate_verdict = 'EXEMPT'; step.gate_complete = false;
      step.gate_candidate_fingerprint = result.candidate_fingerprint; step.gate_rule_version = result.rule_version;
      step.gate_evidence_id = authorization.evidence_id;
    }
  }
  const types = new Set(['route_context', 'reuse_confirmation', 'plan_confirmation', 'unchanged_analysis',
    'skip', 'exemption_report', 'no_change']);
  function blockingReason(event, node) {
    if (result.status === 'NO_CHANGE') return 'terminal_no_change';
    if (pairs[node.id] && result.steps[pairs[node.id]].state === 'SKIPPED'
        && !['skip', 'agent', 'device'].includes(event.type)) return 'coupled_exemption_required';
    return '';
  }
  function humanGuard(node, payload) {
    return node.id === 'X01' && context() && !contextCurrent() && (payload.decision ?? 'approve') === 'approve'
      ? 'stale_route_context' : '';
  }
  function apply(event, node, step) {
    if (!types.has(event.type)) return null;
    if (result.device?.quarantined) return 'reconciliation_required';
    const p = event.payload;
    if (event.type === 'route_context') {
      if (node.id !== 'P02' || step.state !== 'RUNNING' || context() || !shape(p, contextKeys)
          || !['pilot', 'policy_demo'].includes(p.profile_kind) || !['NEW_HW', 'FEATURE', 'BUGFIX'].includes(p.change_type)
          || !contextKeys.filter(key => !['profile_kind', 'change_type', 'input_hashes', 'policy_rule_id', 'policy_approval_id'].includes(key)).every(key => mockId(p[key]))
          || !shape(p.input_hashes, reuseIds) || !Object.values(p.input_hashes).every(mockId)
          || p.candidate_fingerprint !== result.candidate_fingerprint || p.requirements_version !== result.requirements_version
          || versions.has(p.plan_version)) return 'invalid_route_context';
      if (p.profile_kind === 'pilot' ? p.policy_rule_id !== null || p.policy_approval_id !== null
        : p.policy_rule_id !== 'mock:policy:exempt:v1' || !mockId(p.policy_approval_id)) return 'invalid_policy_profile';
      if (state().context) result.history.push({ kind: 'route_plan', cycle: state().context.cycle, route_plan: clone(state()) });
      versions.add(p.plan_version);
      result.route_plan = { context: { ...clone(p), cycle: result.cycle }, confirmed: null, reuse_confirmations: {} };
      return '';
    }
    if (!contextCurrent()) return 'stale_route_context';
    if (event.type === 'reuse_confirmation') {
      if (!earlyIds.includes(node.id) || step.state !== 'PENDING' || forced(node.id) || context().change_type === 'NEW_HW'
          || p.actor !== 'mock:human' || p.task_id !== `mock:reuse:${node.id}:c${result.cycle}:a${step.attempt}`
          || p.plan_version !== expectedPlanVersion() || p.candidate_fingerprint !== result.candidate_fingerprint
          || p.requirements_version !== result.requirements_version
          || !['baseline_hash', 'baseline_input_hash', 'current_input_hash', 'reason_id'].every(key => mockId(p[key]))
          || p.current_input_hash !== context().input_hashes[node.id] || !freshEvidence(p.evidence_id)
          || state().reuse_confirmations[node.id]) return 'invalid_reuse_confirmation';
      evidenceIds.add(p.evidence_id);
      state().reuse_confirmations[node.id] = { ...clone(p), ...coordinates(step), step_id: node.id };
      addEvidence(step, p.evidence_id); return '';
    }
    if (event.type === 'plan_confirmation') {
      const human = submissions.get('X01');
      if (node.id !== 'X01' || step.state !== 'WAITING_HUMAN' || !human || human.decision !== 'approve'
          || human.execution_id !== step.execution_id || human.cycle !== result.cycle || human.attempt !== step.attempt
          || human.plan_version !== expectedPlanVersion() || human.evidence_id !== p.evidence_id
          || p.actor !== 'mock:human' || p.task_id !== `mock:task:X01:c${result.cycle}${step.attempt === 1 ? '' : `:a${step.attempt}`}`
          || p.plan_version !== expectedPlanVersion() || p.candidate_fingerprint !== result.candidate_fingerprint
          || p.requirements_version !== result.requirements_version || !freshEvidence(p.evidence_id)
          || !mockId(p.plan_hash) || !mockId(p.reason_id)
          || !Array.isArray(p.prior_reuse) || !Array.isArray(p.reuse_steps) || !Array.isArray(p.exempt_steps)) return 'invalid_plan_confirmation';
      const prior = earlyIds.filter(id => result.steps[id].state === 'SKIPPED');
      if (p.prior_reuse.length !== prior.length || !p.prior_reuse.every(item => shape(item, ['step_id', 'evidence_id'])
        && prior.includes(item.step_id) && item.evidence_id === result.steps[item.step_id].skip_basis?.evidence_id)
        || new Set(p.prior_reuse.map(item => item.step_id)).size !== p.prior_reuse.length) return 'invalid_prior_reuse';
      if (p.reuse_steps.length > reuseIds.length || !p.reuse_steps.every(entry => shape(entry, reuseKeys)
          && reuseIds.includes(entry.step_id) && !forced(entry.step_id) && reuseKeys.filter(key => key !== 'step_id').every(key => mockId(entry[key]))
          && entry.current_input_hash === context().input_hashes[entry.step_id]
          && (context().change_type !== 'NEW_HW' || entry.step_id === 'P10' && reusableEnvironment(entry)))
          || new Set(p.reuse_steps.map(entry => entry.step_id)).size !== p.reuse_steps.length) return 'invalid_reuse_scope';
      for (const id of earlyIds) {
        const entry = p.reuse_steps.find(item => item.step_id === id);
        if (prior.includes(id) !== Boolean(entry)) return 'invalid_prior_reuse';
        if (entry && !reuseKeys.every(key => entry[key] === result.steps[id].skip_basis[key])) return 'invalid_prior_reuse';
      }
      if (new Set(p.exempt_steps).size !== p.exempt_steps.length || !p.exempt_steps.every(id => [...policyIds, ...Object.keys(pairs)].includes(id) && !forced(id))
          || Object.entries(pairs).some(([gate, execution]) => p.exempt_steps.includes(gate) !== p.exempt_steps.includes(execution))
          || p.exempt_steps.length > 0 && (context().profile_kind !== 'policy_demo' || context().change_type === 'NEW_HW')) return 'invalid_exemption_scope';
      const scope = { plan_version: p.plan_version, plan_hash: p.plan_hash, cycle: result.cycle,
        profile_hash: context().profile_hash, candidate_fingerprint: p.candidate_fingerprint, requirements_version: p.requirements_version,
        reason_id: p.reason_id, prior_reuse: clone(p.prior_reuse).sort((a, b) => a.step_id.localeCompare(b.step_id)),
        reuse_steps: p.reuse_steps.map(entry => Object.fromEntries(reuseKeys.map(key => [key, entry[key]]))).sort((a, b) => a.step_id.localeCompare(b.step_id)),
        exempt_steps: [...p.exempt_steps].sort() };
      const signature = JSON.stringify(scope);
      if (versionBindings.has(p.plan_version) && versionBindings.get(p.plan_version) !== signature
          || hashBindings.has(p.plan_hash) && hashBindings.get(p.plan_hash) !== signature) return 'plan_binding_conflict';
      if (state().confirmed) result.history.push({ kind: 'route_plan_approval', cycle: result.cycle, route_plan: clone(state()) });
      versionBindings.set(p.plan_version, signature); hashBindings.set(p.plan_hash, signature); evidenceIds.add(p.evidence_id);
      state().confirmed = { ...scope, actor: p.actor, task_id: p.task_id, evidence_id: p.evidence_id,
        approval_attempt: step.attempt, approval_execution_id: step.execution_id };
      return '';
    }
    if (event.type === 'unchanged_analysis') {
      if (!['P11', 'P12'].includes(node.id) || step.state !== 'PENDING' || !confirmedCurrent()
          || p.actor !== (node.id === 'P11' ? 'mock:code-dev' : 'mock:tc')
          || p.plan_version !== expectedPlanVersion() || p.candidate_fingerprint !== result.candidate_fingerprint
          || p.requirements_version !== result.requirements_version || !mockId(p.baseline_hash) || !mockId(p.current_hash)
          || typeof p.needs_changes !== 'boolean' || typeof p.requirements_satisfied !== 'boolean'
          || !freshEvidence(p.evidence_id) || step.unchanged_analysis) return 'invalid_unchanged_analysis';
      evidenceIds.add(p.evidence_id); step.unchanged_analysis = { ...clone(p), ...coordinates(step) };
      addEvidence(step, p.evidence_id); return '';
    }
    if (event.type === 'skip') {
      if (step.state !== 'PENDING' || !transitionAllowed(step.state, 'SKIPPED') || forced(node.id)) return 'invalid_skip';
      let authorization;
      if (node.skip_policy === 'REUSE') authorization = reuseAuthorization(node, step);
      else if (['POLICY', 'COUPLED'].includes(node.skip_policy) && policyCurrent(node.id)) {
        if (pairs[node.id] && !consumedPolicy(pairs[node.id])
            || node.id === 'P24' && (result.steps.P23.state !== 'SUCCEEDED' || !validExemptionReport())) return 'coupled_exemption_required';
        const plan = state().confirmed;
        authorization = { ...coordinates(step), actor: plan.actor, task_id: plan.task_id, plan_version: plan.plan_version,
          candidate_fingerprint: plan.candidate_fingerprint, requirements_version: plan.requirements_version,
          reason_id: plan.reason_id, baseline_hash: context().profile_hash, evidence_id: plan.evidence_id };
      }
      if (!authorization || p.evidence_id !== authorization.evidence_id) return 'skip_authorization_required';
      applySkip(node, step, authorization);
      result.current_step = graph.edges.find(edge => edge.from === node.id && edge.kind === 'pass').to;
      result.status = 'RUNNING'; result.wait_reason = ''; return '';
    }
    if (event.type === 'exemption_report') {
      if (node.id !== 'P23' || step.state !== 'RUNNING' || p.actor !== 'mock:sqe' || p.performed !== false
          || !consumedPolicy('P22') || !policyCurrent('P24') || p.plan_version !== expectedPlanVersion()
          || p.candidate_fingerprint !== result.candidate_fingerprint || p.requirements_version !== result.requirements_version
          || p.exemption_evidence_id !== state().confirmed.evidence_id || !mockId(p.report_id)
          || !freshEvidence(p.evidence_id) || step.exemption_report) return 'invalid_exemption_report';
      evidenceIds.add(p.evidence_id); step.exemption_report = { ...clone(p), ...coordinates(step) };
      addEvidence(step, p.evidence_id); return '';
    }
    if (event.type === 'no_change') {
      const production = result.steps.P11;
      const basis = reuseAuthorization(node, step);
      const later = graph.nodes.filter(entry => !reuseIds.includes(entry.id) && !['P01', 'P02', 'X01'].includes(entry.id));
      if (node.id !== 'P12' || step.state !== 'PENDING' || context().change_type === 'NEW_HW' || forced('P11') || forced('P12')
          || !confirmedCurrent() || !basis || production.state !== 'SKIPPED' || !eligibleAnalysis('P11') || !eligibleAnalysis('P12')
          || !currentProof(production.skip_basis, production) || production.skip_basis.evidence_id !== state().confirmed.evidence_id
          || p.actor !== 'mock:human' || p.task_id !== `mock:no-change:P12:c${result.cycle}:a${step.attempt}`
          || p.plan_version !== expectedPlanVersion() || p.candidate_fingerprint !== result.candidate_fingerprint
          || p.requirements_version !== result.requirements_version || !mockId(p.reason_id) || !freshEvidence(p.evidence_id)
          || p.production_evidence_id !== production.unchanged_analysis.evidence_id || p.tests_evidence_id !== step.unchanged_analysis.evidence_id
          || p.reuse_evidence_id !== basis.evidence_id || !later.every(entry => result.steps[entry.id].state === 'PENDING')
          || result.release.publication_count !== 0 || result.release.manifest || result.release.approved || result.release.receipt_id
          || !transitionAllowed(step.state, 'SKIPPED')) return 'invalid_no_change';
      applySkip(node, step, basis); addEvidence(step, p.evidence_id); evidenceIds.add(p.evidence_id);
      result.no_change = { ...clone(p), ...coordinates(step), source_hash: context().source_hash, test_hash: context().test_hash };
      result.status = 'NO_CHANGE'; result.wait_reason = 'human_confirmed_no_change'; return '';
    }
    return 'unknown_type';
  }
  function successGuard(node) {
    if (node.id === 'X01' && context() && !confirmedCurrent(false)) return 'plan_confirmation_required';
    if (node.id === 'P23' && result.steps.P22.state === 'SKIPPED' && !validExemptionReport()) return 'exemption_report_required';
    return '';
  }
  return { apply, blockingReason, humanGuard, successGuard, expectedPlanVersion, exemptionCurrent };
}
