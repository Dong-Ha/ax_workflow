import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VALID_STAGES = new Set([
  'requirements', 'design', 'test-plan', 'implement', 'smoke', 'fix', 'system', 'environment',
  'approval', 'release', 'acceptance', 'delivery-review',
]);
const CODEX_TIMEOUT_MS = 600_000;
const API_TIMEOUT_MS = 20_000;
const EXCLUDED_ROOT_DIRECTORIES = new Set(['dist', '.git']);
const REQUIREMENTS_AMENDMENT_PATH = 'workflow-artifacts/requirements-amendment.md';
const STAGE_OUTPUTS = {
  requirements: ['workflow-artifacts/requirements.md', 'workflow-artifacts/prototype.md'],
  design: ['workflow-artifacts/design.md', 'workflow-artifacts/development-plan.md', 'workflow-artifacts/development-rules.md'],
  'test-plan': ['workflow-artifacts/test-plan.md', 'workflow-artifacts/test-cases.md'],
  implement: ['src/App.tsx', 'src/styles.css', 'tests/agent-filter.test.mjs', 'workflow-artifacts/implementation.md'],
  smoke: ['workflow-artifacts/smoke.json', 'workflow-artifacts/smoke.md'],
  fix: ['workflow-artifacts/fix.md'],
  system: ['workflow-artifacts/system.json', 'workflow-artifacts/system.md'],
  environment: ['workflow-artifacts/test-environment.md', 'workflow-artifacts/deployment-plan.md'],
  approval: ['workflow-artifacts/approval.json', 'workflow-artifacts/release-notes.md'],
  release: ['workflow-artifacts/release-plan.md', 'workflow-artifacts/release-checklist.md'],
  acceptance: ['workflow-artifacts/acceptance.json', 'workflow-artifacts/acceptance.md'],
  'delivery-review': ['workflow-artifacts/delivery-review.json', 'workflow-artifacts/delivery-review.md'],
};
const QA_STAGES = new Set(['smoke', 'system', 'acceptance']);
const LOW_EFFORT_STAGES = new Set(['requirements', 'design', 'test-plan', 'environment', 'release', 'delivery-review']);
const MAX_QA_FINDINGS = 40;
const MAX_QA_FINDING_CHARS = 240;
const ownedChildren = new Set();
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };
let cliShutdownSignal = null;

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error('Unexpected command argument');
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    result[key] = value;
    i += 1;
  }
  return result;
}

function apiRoot() {
  const configured = process.env.PAPERCLIP_API_URL;
  if (!configured) throw new Error('PAPERCLIP_API_URL is required');
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('Paperclip API URL is invalid');
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('Stage worker requires a loopback HTTP API');
  }
  return configured.replace(/\/+$/, '').replace(/\/api$/i, '');
}

async function api(pathname, options = {}) {
  const key = process.env.PAPERCLIP_API_KEY;
  if (!key) throw new Error('PAPERCLIP_API_KEY is required');
  let response;
  try {
    response = await fetch(`${apiRoot()}/api${pathname}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch {
    throw new Error('Paperclip API request could not be completed');
  }
  if (!response.ok) throw new Error(`Paperclip API request failed (${response.status})`);
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    throw new Error('Paperclip API returned an invalid response');
  }
}

async function getIssue(issueId) {
  return api(`/issues/${encodeURIComponent(issueId)}`);
}

async function assertBlockersDone(issue) {
  const blockers = Array.isArray(issue.blockedBy) ? issue.blockedBy : [];
  if (blockers.some((blocker) => blocker.status !== 'done')) {
    throw new Error('Issue has unresolved blockers');
  }
}

async function checkout(issueId) {
  const agentId = process.env.PAPERCLIP_AGENT_ID;
  const runId = process.env.PAPERCLIP_RUN_ID;
  if (!agentId || !runId) throw new Error('Paperclip run identity is unavailable');
  const result = await api(`/issues/${encodeURIComponent(issueId)}/checkout`, {
    method: 'POST',
    headers: { 'X-Paperclip-Run-Id': runId },
    body: JSON.stringify({ agentId, expectedStatuses: ['todo', 'backlog', 'blocked', 'in_review', 'in_progress'] }),
  });
  if (result?.status === 'blocked' || result?.issue?.status === 'blocked') {
    throw new Error('Issue checkout reports unresolved blockers');
  }
}

function sanitizedChildEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:PAPERCLIP_|AX_PAPERCLIP_)/i.test(key)) continue;
    if (key === 'AX_VERIFY_FILTER_GRAPH' || key === 'AX_VERIFY_TOPOLOGY' || key === 'AX_VERIFY_NAVIGATION') continue;
    if (/(?:TOKEN|API_KEY|SECRET|PASSWORD|BEARER|CREDENTIAL)/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

function runProcess(command, args, { cwd, env = sanitizedChildEnv(), timeoutMs = CODEX_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (cliShutdownSignal) {
      reject(new Error(`${path.basename(command)} cancelled`));
      return;
    }
    const detached = process.platform !== 'win32';
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: 'ignore', windowsHide: true, detached });
    } catch {
      reject(new Error(`${path.basename(command)} could not start`));
      return;
    }
    let settled = false;
    let timedOut = false;
    let closed = false;
    let forceTimer;
    let pollTimer;
    let terminationPromise;
    const signalGroup = (signal) => {
      try {
        if (detached && child.pid) process.kill(-child.pid, signal);
        else if (!closed) child.kill(signal);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    const groupAlive = () => {
      if (!detached || !child.pid) return !closed;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return error.code !== 'ESRCH';
      }
    };
    const record = { child, terminate: null, cancelled: false };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearTimeout(pollTimer);
      ownedChildren.delete(record);
      if (error) reject(error);
      else resolve(result);
    };
    const waitForTermination = () => new Promise((done) => {
      const check = () => {
        if (closed && !groupAlive()) {
          done();
          return;
        }
        pollTimer = setTimeout(check, 50);
      };
      check();
    });
    const terminate = () => {
      if (terminationPromise) return terminationPromise;
      terminationPromise = (async () => {
        if (groupAlive()) {
          try { signalGroup('SIGTERM'); } catch { /* Continue to bounded escalation. */ }
        }
        const escalation = new Promise((done) => {
          forceTimer = setTimeout(() => {
            try { signalGroup('SIGKILL'); } catch { /* Group may already be gone. */ }
            done();
          }, 2_000);
        });
        await Promise.race([waitForTermination(), escalation]);
        if (closed && !groupAlive()) {
          clearTimeout(forceTimer);
          return;
        }
        try { signalGroup('SIGKILL'); } catch { /* Group may already be gone. */ }
        await waitForTermination();
      })();
      return terminationPromise;
    };
    record.terminate = terminate;
    ownedChildren.add(record);
    const timer = setTimeout(() => {
      timedOut = true;
      void terminate().then(() => finish(new Error(`${path.basename(command)} timed out`)));
    }, timeoutMs);
    child.once('error', () => finish(new Error(`${path.basename(command)} could not start`)));
    child.once('close', (code, signal) => {
      closed = true;
      if (timedOut || cliShutdownSignal || record.cancelled) {
        void terminate().then(() => finish(new Error(timedOut ? `${path.basename(command)} timed out` : `${path.basename(command)} cancelled`)));
      } else if (groupAlive()) {
        void terminate().then(() => {
          if (record.cancelled || cliShutdownSignal) finish(new Error(`${path.basename(command)} cancelled`));
          else if (code === 0) finish(null, { code: 0 });
          else finish(new Error(`${path.basename(command)} exited unsuccessfully${signal ? ` (${signal})` : ''}`));
        });
      } else if (code === 0) finish(null, { code: 0 });
      else finish(new Error(`${path.basename(command)} exited unsuccessfully${signal ? ` (${signal})` : ''}`));
    });
  });
}

async function shutdownOwnedChildGroups() {
  const active = [...ownedChildren];
  for (const record of active) record.cancelled = true;
  await Promise.all(active.map((record) => record.terminate()));
}

function installCliShutdownHandlers() {
  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
    process.once(signal, () => {
      if (cliShutdownSignal) return;
      cliShutdownSignal = signal;
      void shutdownOwnedChildGroups().then(
        () => process.exit(SIGNAL_EXIT_CODES[signal]),
        () => process.exit(SIGNAL_EXIT_CODES[signal]),
      );
    });
  }
}

function taskPrompt(stage, issue, workspace) {
  const task = [issue.title, issue.description].filter((item) => typeof item === 'string' && item.trim()).join('\n\n');
  const shared = `Build the requested agent monitoring dashboard in this isolated workspace.\nWorkspace: ${workspace}\nPaperclip task:\n${task || '(no additional task description)'}\n\nBefore acting, read existing workflow-artifacts/requirements-amendment.md, requirements.md, prototype.md, design.md, test-plan.md, and improvement-request.md when present; these documents define the product acceptance contract, including the current follow-up scope. Report conflicts instead of silently narrowing scope.\n\nProduct contract:\n- Search agents by name, id, and role, including the original and Korean display role text.\n- Combine search and status filters with AND. Status keys are all, inProgress, completed, failed, interrupted, and unknown. Display the labels exactly as 진행 중, 턴 완료, 실패, 중단, and 상태 미확인. Never infer that unknown means waiting.\n- Keep matching descendants visible with non-matching ancestors as context cards. Show matching and total counts; provide clear and no-match states.\n- Keep the selected agent detail visible when filters hide that agent. When provider or session changes, clear filters, remove the old selection/detail, and show guidance to select an agent from the new session; do not auto-select a default agent. If the selected agent is deleted, show an unavailable-agent message and do not retain stale details. Counts always describe the full snapshot.\n- Generated unit and browser tests must cover every status key and label, provider/session reset clearing stale detail and showing selection guidance, and selected-agent deletion showing the unavailable state.\n- QA report findings must be concise strings or objects containing only nonempty string title and/or summary fields; never include arbitrary fields, raw tool output, or private content. The browser runner result file workflow-artifacts/agent-filter-browser-results.json must use {"verdict":"pass|fail","screenshotSaved":true,"results":[{"name":"scenario name","verdict":"pass|fail","finding":"concise safe summary"}]}; do not put raw output in finding.\n- Do not change server code or adapters. Never write outside the supplied workspace. Do not make network requests.`;
  const instructions = {
    requirements: 'Write workflow-artifacts/requirements.md with measurable product and privacy requirements. Write workflow-artifacts/prototype.md with a concrete interaction prototype description. Do not implement.',
    design: 'Write workflow-artifacts/design.md, workflow-artifacts/development-plan.md, and workflow-artifacts/development-rules.md. Cover component/data flow, scope boundaries, work sequence, and coding rules. Do not implement.',
    'test-plan': 'Write workflow-artifacts/test-plan.md and workflow-artifacts/test-cases.md. Include meaningful contract, failure, and browser scenarios for all product requirements. Do not change tests or implementation.',
    implement: 'Implement the dashboard in src/App.tsx and src/styles.css. You may add src/agent-filter.mjs and src/agent-filter.d.mts for reusable filter logic. Add tests/agent-filter.test.mjs using node:test for the real filtering contract, including provider/session reset clearing the prior detail and selected-agent deletion showing an unavailable state; do not create browser tests in this stage. Do not edit server or adapter files. Run npm test and npm run build; resolve reproducible implementation failures before finishing. Write a concise workflow-artifacts/implementation.md summary.',
    smoke: 'Act as QA. You may modify only tests/agent-filter.test.mjs, tests/agent-filter.browser.mjs, and workflow-artifacts outputs. Never change app implementation, package files, server/adapters, build configuration, or other tests. Existing test files are strictly byte-append-only: add coverage only at EOF (including imports); never insert, rewrite, or edit existing bytes. A new allowed test file may be authored. On retest, prefer leaving test files untouched when coverage already exists. Require both files to exist. Do not change the build output path; npm run build must generate the normal dist directory. Never implement a hidden waiting alias merely to preserve an obsolete test. The node:test and browser suites must cover provider/session reset removing the old selected detail, selected-agent deletion showing an unavailable state, and the other listed product requirements. The browser test must use Playwright, read AX_VERIFY_URL, mock /api/dashboard and relevant /api/.../activity routes, exercise provider/session reset, descendant ancestor context, no match, clear, keyboard use, and a narrow viewport, and save a screenshot under workflow-artifacts. Run npm test, npm run build, and node tests/agent-filter.browser.mjs. Write workflow-artifacts/smoke.json with {"verdict":"pass"|"fail","findings":[...],"unverifiedChecks":[...]}, and workflow-artifacts/smoke.md with a concise summary. Do not weaken expected behavior.',
    fix: 'Read previous workflow-artifacts/* QA JSON reports and this defect task. Fix implementation defects only; never relax test expectations. Run npm test and npm run build and resolve reproducible implementation failures. Both commands must pass in the independent worker before this stage can advance. Write workflow-artifacts/fix.md describing the defect cause and changes.',
    system: 'Act as QA. Do not edit code or tests. Require tests/agent-filter.test.mjs and tests/agent-filter.browser.mjs to exist. AX_VERIFY_URL must be set. Run npm test, npm run build, and node tests/agent-filter.browser.mjs. Write workflow-artifacts/system.json as {"verdict":"pass"|"fail","findings":[...],"unverifiedChecks":[...]} and workflow-artifacts/system.md with a concise summary. Test failures are valid findings, not agent execution errors.',
    environment: 'Act as the operations team. Write workflow-artifacts/test-environment.md and workflow-artifacts/deployment-plan.md covering test-environment preparation, version recording, release observation, and rollback order. The controller starts test servers, packages, and checks health; do not start servers, package, deploy, or modify app code.',
    approval: 'Review the current requirements, design, implementation, test reports, and release notes inputs for completeness and scope. Do not edit code. Write workflow-artifacts/approval.json as {"approved":true|false,"reason":"..."} and workflow-artifacts/release-notes.md. Approve only if all required system checks pass and artifacts are reviewed.',
    release: 'Do not package or deploy; the controller handles packaging. Read the existing workflow-artifacts/deployment-plan.md from the environment stage and do not rewrite it. Write workflow-artifacts/release-plan.md and workflow-artifacts/release-checklist.md covering version recording, release observation, and rollback order. Do not change server or adapter files.',
    acceptance: 'Act as QA. Do not edit implementation or tests. Require tests/agent-filter.test.mjs and tests/agent-filter.browser.mjs to exist. AX_VERIFY_URL must be set. Run npm test, npm run build, and node tests/agent-filter.browser.mjs. Write workflow-artifacts/acceptance.json as {"verdict":"pass"|"fail","findings":[...],"unverifiedChecks":[...]} and workflow-artifacts/acceptance.md with the acceptance result. Test failures are valid findings, not agent execution errors.',
    'delivery-review': 'Review the final native online release and its delivery evidence. Read workflow-artifacts/acceptance.json, approval.json, deployment.json, and release-delivery.json. Do not edit source, tests, or prior artifacts. Write workflow-artifacts/delivery-review.json with exactly {"accepted":true|false,"reason":"concise reason","releaseDigest":"64-character deployment digest","acceptanceRunId":"acceptance run id","acceptanceIssueId":"acceptance issue id"} and delivery-review.md with a concise review. Accept only when online acceptance passed, product approval is granted, the packaged digest matches the delivered release, and every delivery check passed. Copy digest and acceptance provenance from those inputs exactly.',
  };
  const additionalMutableArtifacts = stage === 'implement' || stage === 'fix'
    ? `, ${implementationValidationPath(stage)}`
    : QA_STAGES.has(stage)
      ? `, workflow-artifacts/agent-filter-browser-results.json, workflow-artifacts/agent-filter-smoke.png${process.env.AX_VERIFY_FILTER_GRAPH === '1' ? ', workflow-artifacts/filter-verification.json' : ''}${process.env.AX_VERIFY_TOPOLOGY === '1' ? ', workflow-artifacts/topology-verification.json' : ''}${process.env.AX_VERIFY_NAVIGATION === '1' ? ', workflow-artifacts/navigation-verification.json' : ''}`
      : '';
  const artifactPolicy = `Artifact protection: preserve every existing prior-stage specification, implementation report, QA report, approval, release, operator-review, and verified controller report. Only existing files listed for this stage may be overwritten: ${STAGE_OUTPUTS[stage].join(', ')}${additionalMutableArtifacts}. workflow-artifacts/requirements-amendment.md is always read-only. New debug artifacts are allowed, but use unique/current-stage filenames and never overwrite an existing debug artifact. Release reads workflow-artifacts/deployment-plan.md and writes workflow-artifacts/release-plan.md; never rewrite deployment-plan.md.`;
  const qaProtocol = QA_STAGES.has(stage)
    ? `QA verdict protocol: findings must contain only observed product defects or reproducible test failures, not sandbox/environment restrictions. If Codex sandbox prevents localhost binding, temporary-file access, child execution, or browser launch, put a concise explanation in unverifiedChecks; do not claim that check passed. AX_ISOLATION_BLOCKED and permission-denied diagnostics caused by the sandbox or isolation policy are execution restrictions, not evidence of a product defect. If you cannot distinguish a failed command from such a restriction, record the unresolved check in unverifiedChecks for independent execution rather than inventing a defect. Never suppress a reproducible product failure; the independent runner still requires every command to pass. A pass verdict with no findings and unverifiedChecks is allowed because the worker independently reruns every required command and controls the final gate from those real results. Do not copy command output or arbitrary details. unverifiedChecks must be an array of at most 10 nonempty concise strings.${process.env.AX_VERIFY_FILTER_GRAPH === '1' ? ' AX_VERIFY_FILTER_GRAPH=1 requires the independent synthetic graph verification check; do not edit tests or product source in this follow-up QA run, and do not alter its filter-verification.json artifact.' : ''}${process.env.AX_VERIFY_TOPOLOGY === '1' ? ' AX_VERIFY_TOPOLOGY=1 requires the independent synthetic topology verification check; do not edit tests or product source in this follow-up QA run, and do not alter its topology-verification.json artifact.' : ''}${process.env.AX_VERIFY_NAVIGATION === '1' ? ' AX_VERIFY_NAVIGATION=1 requires the independent synthetic match navigation check; do not edit tests or product source in this follow-up QA run, and do not alter its navigation-verification.json artifact.' : ''}`
    : '';
  const developmentProtocol = ['implement', 'fix'].includes(stage) ? 'Development validation protocol: attempt each required command and report its actual outcome. If the sandbox or isolation policy blocks localhost binding, child execution, temporary access, or browser startup (including AX_ISOLATION_BLOCKED), record the restriction honestly in the current-stage summary and validation artifact without claiming the command passed. Do not repeatedly retry a blocked command, bypass isolation, or weaken tests. The independent worker reruns both required commands and requires real passing results before advancing; an unresolved product test failure still blocks the stage.' : '';
  return `${shared}\n\n${artifactPolicy}\n\n${qaProtocol}\n\nStage: ${stage}.\n${instructions[stage]}\n\n${developmentProtocol}\n\nDo not print private reasoning, environment values, credentials, raw subprocess output, or API responses. At completion provide only a brief status and changed file names.`;
}

async function runCodex(stage, issue, workspace) {
  const reasoningEffort = LOW_EFFORT_STAGES.has(stage) ? 'low' : 'medium';
  await runProcess('codex', [
    'exec', '-c', `model_reasoning_effort=${reasoningEffort}`, '--ephemeral', '--skip-git-repo-check', '--sandbox', 'workspace-write',
    '-C', workspace, taskPrompt(stage, issue, workspace),
  ], { cwd: workspace, timeoutMs: CODEX_TIMEOUT_MS });
}

function artifactPath(workspace, relativePath) {
  const full = path.resolve(workspace, relativePath);
  if (full !== workspace && !full.startsWith(`${workspace}${path.sep}`)) throw new Error('Artifact path escaped workspace');
  return full;
}

async function snapshotWorkspace(workspace) {
  const snapshot = new Map();
  snapshot.appendOnlyTestContents = new Map();
  snapshot.requirementsAmendmentContents = null;
  const addPath = async (relativePath) => {
    const absolutePath = path.join(workspace, relativePath);
    let info;
    try {
      info = await lstat(absolutePath);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw new Error(`Could not inspect protected path: ${relativePath}`);
    }
    if (info.isSymbolicLink()) throw new Error(`Symlink is forbidden in protected workspace path: ${relativePath}`);
    if (info.isFile()) {
      const contents = await readFile(absolutePath);
      snapshot.set(relativePath, `file:${createHash('sha256').update(contents).digest('hex')}`);
      if (['tests/agent-filter.test.mjs', 'tests/agent-filter.browser.mjs'].includes(relativePath)) {
        snapshot.appendOnlyTestContents.set(relativePath, contents.toString('utf8'));
      }
      if (relativePath === REQUIREMENTS_AMENDMENT_PATH) {
        snapshot.requirementsAmendmentContents = contents.toString('utf8');
      }
      return;
    }
    if (!info.isDirectory()) {
      snapshot.set(relativePath, `other:${info.mode}`);
      return;
    }
    snapshot.set(relativePath, 'directory');
    let names;
    try {
      names = (await readdir(absolutePath)).sort();
    } catch {
      throw new Error(`Could not inspect protected directory: ${relativePath}`);
    }
    for (const name of names) await addPath(path.posix.join(relativePath, name));
  };

  let rootEntries;
  try {
    rootEntries = (await readdir(workspace, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    throw new Error('Could not inspect workspace root');
  }
  for (const entry of rootEntries) {
    if (entry.name === 'node_modules') continue;
    if (EXCLUDED_ROOT_DIRECTORIES.has(entry.name) && entry.isDirectory()) continue;
    if (entry.isSymbolicLink()) throw new Error(`Symlink is forbidden in protected workspace path: ${entry.name}`);
    await addPath(entry.name);
  }
  return snapshot;
}

async function snapshotStageOutputStats(stage, workspace) {
  const outputStats = new Map();
  for (const relativePath of STAGE_OUTPUTS[stage]) {
    try {
      const info = await lstat(artifactPath(workspace, relativePath), { bigint: true });
      outputStats.set(relativePath, `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Could not inspect stage output: ${relativePath}`);
      outputStats.set(relativePath, null);
    }
  }
  return outputStats;
}

async function verifyFreshStageOutputs(stage, before, workspace) {
  for (const relativePath of STAGE_OUTPUTS[stage]) {
    let info;
    try {
      info = await lstat(artifactPath(workspace, relativePath), { bigint: true });
    } catch {
      throw new Error(`Stage did not create required output: ${relativePath}`);
    }
    if (!info.isFile()) throw new Error(`Stage output is not a regular file: ${relativePath}`);
    const current = `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`;
    if (current === before.get(relativePath)) throw new Error(`Stage output is stale: ${relativePath}`);
  }
}

function changedWorkspacePaths(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((relativePath) => before.get(relativePath) !== after.get(relativePath)).sort();
}

function prohibitedWorkspaceChanges(stage, changedPaths) {
  const allowedTests = new Set();
  if (stage === 'implement' || stage === 'smoke') allowedTests.add('tests/agent-filter.test.mjs');
  if (stage === 'smoke') allowedTests.add('tests/agent-filter.browser.mjs');
  const readOnlyQaFollowup = (process.env.AX_VERIFY_FILTER_GRAPH === '1' || process.env.AX_VERIFY_TOPOLOGY === '1' || process.env.AX_VERIFY_NAVIGATION === '1') && QA_STAGES.has(stage);

  return changedPaths.filter((relativePath) => {
    if (relativePath === 'src' || relativePath.startsWith('src/')) return stage !== 'implement' && stage !== 'fix';
    if (relativePath === 'tests') return readOnlyQaFollowup || !['implement', 'smoke'].includes(stage);
    if (relativePath.startsWith('tests/')) return readOnlyQaFollowup || !allowedTests.has(relativePath);
    return true;
  });
}

function prohibitedExistingArtifactChanges(stage, before, changedPaths) {
  const allowed = new Set(STAGE_OUTPUTS[stage] ?? []);
  if (stage === 'implement' || stage === 'fix') allowed.add(implementationValidationPath(stage));
  if (QA_STAGES.has(stage)) {
    allowed.add('workflow-artifacts/agent-filter-browser-results.json');
    allowed.add('workflow-artifacts/agent-filter-smoke.png');
    if (process.env.AX_VERIFY_FILTER_GRAPH === '1') allowed.add('workflow-artifacts/filter-verification.json');
    if (process.env.AX_VERIFY_TOPOLOGY === '1') allowed.add('workflow-artifacts/topology-verification.json');
    if (process.env.AX_VERIFY_NAVIGATION === '1') allowed.add('workflow-artifacts/navigation-verification.json');
  }
  return changedPaths.filter((relativePath) => {
    if (relativePath !== 'workflow-artifacts' && !relativePath.startsWith('workflow-artifacts/')) return false;
    if (relativePath === REQUIREMENTS_AMENDMENT_PATH) return true;
    if (!before.has(relativePath)) return false;
    return !allowed.has(relativePath);
  });
}

async function verifyWorkspaceChanges(stage, before, workspace) {
  const after = await snapshotWorkspace(workspace);
  const changedPaths = changedWorkspacePaths(before, after);
  const nonArtifactPaths = changedPaths.filter((relativePath) =>
    relativePath !== 'workflow-artifacts' && !relativePath.startsWith('workflow-artifacts/'));
  const violations = [
    ...prohibitedWorkspaceChanges(stage, nonArtifactPaths),
    ...prohibitedExistingArtifactChanges(stage, before, changedPaths),
  ];
  let correctedLegacyWaitingTest = false;
  if (stage === 'smoke') {
    for (const [relativePath, oldContents] of before.appendOnlyTestContents ?? []) {
      const newContents = after.appendOnlyTestContents.get(relativePath);
      const allowed = typeof newContents === 'string' && newContents.startsWith(oldContents);
      if (!allowed) {
        violations.push(`${relativePath} (smoke may only append tests)`);
      }
    }
  }
  if (violations.length) {
    const visible = violations.slice(0, 5).join(', ');
    throw new Error(`Stage changed protected workspace paths: ${visible}`);
  }
  after.correctedLegacyWaitingTest = correctedLegacyWaitingTest;
  return after;
}

async function nonempty(workspace, relativePath) {
  try {
    return Boolean((await readFile(artifactPath(workspace, relativePath), 'utf8')).trim());
  } catch {
    return false;
  }
}

async function readJson(workspace, relativePath) {
  try {
    return JSON.parse(await readFile(artifactPath(workspace, relativePath), 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(workspace, relativePath, value) {
  const target = artifactPath(workspace, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

function implementationValidationPath(stage) {
  return stage === 'implement'
    ? 'workflow-artifacts/implementation-validation.json'
    : 'workflow-artifacts/fix-validation.json';
}

async function runImplementationValidations(stage, workspace, { runId = null, issueId = null } = {}) {
  if (stage !== 'implement' && stage !== 'fix') throw new Error('Independent implementation validation requires implement or fix stage');
  const checks = [];
  for (const args of [['test'], ['run', 'build']]) {
    const command = `npm ${args.join(' ')}`;
    let status = 'pass';
    try {
      await runProcess('npm', args, { cwd: workspace });
    } catch {
      status = 'fail';
    }
    checks.push({ command, status });
  }
  const report = {
    runId,
    issueId,
    verdict: checks.every((check) => check.status === 'pass') ? 'pass' : 'fail',
    checks,
  };
  await writeJson(workspace, implementationValidationPath(stage), report);
  if (report.verdict !== 'pass') throw new Error(`Independent ${stage} validation failed`);
  return report;
}

function boundedQaText(value) {
  return value.trim().replace(/\s+/g, ' ').slice(0, MAX_QA_FINDING_CHARS);
}

function normalizeQaFindings(value) {
  if (!Array.isArray(value) || value.length > MAX_QA_FINDINGS) {
    return { findings: [], valid: false };
  }
  const findings = [];
  let valid = true;
  for (const item of value) {
    if (typeof item === 'string') {
      const text = boundedQaText(item);
      if (text) findings.push(text);
      else valid = false;
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      valid = false;
      continue;
    }
    const keys = Object.keys(item);
    const allowed = keys.length > 0 && keys.every((key) => key === 'title' || key === 'summary');
    const parts = ['title', 'summary'].flatMap((key) => {
      if (!Object.hasOwn(item, key)) return [];
      if (typeof item[key] !== 'string' || !item[key].trim()) {
        valid = false;
        return [];
      }
      return [boundedQaText(item[key])];
    });
    if (!allowed || parts.length === 0) {
      valid = false;
      continue;
    }
    findings.push(boundedQaText(parts.join(': ')));
  }
  return { findings, valid };
}

function normalizeUnverifiedChecks(value) {
  if (value === undefined) return { checks: [], valid: true };
  if (!Array.isArray(value) || value.length > 10) return { checks: [], valid: false };
  const checks = [];
  for (const item of value) {
    if (typeof item !== 'string') return { checks: [], valid: false };
    const text = boundedQaText(item);
    if (!text) return { checks: [], valid: false };
    checks.push(text);
  }
  return { checks, valid: true };
}

async function fileVersion(workspace, relativePath) {
  try {
    const stat = await lstat(artifactPath(workspace, relativePath), { bigint: true });
    return {
      type: stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other',
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString(),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Could not inspect QA evidence artifact: ${relativePath}`);
  }
}

function fileVersionChanged(before, after) {
  return Boolean(after && (!before || Object.keys(after).some((key) => after[key] !== before[key])));
}

function browserFailureNames(report) {
  const topLevelKeys = ['verdict', 'screenshotSaved', 'results'];
  if (!report || typeof report !== 'object' || Array.isArray(report)
    || Object.keys(report).length !== topLevelKeys.length
    || Object.keys(report).some((key) => !topLevelKeys.includes(key))
    || !['pass', 'fail'].includes(report.verdict)
    || typeof report.screenshotSaved !== 'boolean'
    || !Array.isArray(report.results) || report.results.length > MAX_QA_FINDINGS) {
    return { names: [], valid: false };
  }
  const names = [];
  for (const result of report.results) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return { names: [], valid: false };
    const keys = Object.keys(result);
    if (keys.length < 2 || keys.length > 3
      || keys.some((key) => !['name', 'verdict', 'finding'].includes(key))
      || typeof result.name !== 'string' || !result.name.trim()
      || !['pass', 'fail'].includes(result.verdict)
      || (Object.hasOwn(result, 'finding') && typeof result.finding !== 'string')) {
      return { names: [], valid: false };
    }
    if (result.verdict === 'fail') names.push(boundedQaText(result.name));
  }
  if (report.verdict === 'fail' && names.length === 0) {
    names.push('Browser suite reported failure');
  }
  return { names, valid: true };
}

function validFilterVerificationReport(report) {
  const topKeys = ['seed', 'synthetic', 'chainAllMatch'];
  if (!report || typeof report !== 'object' || Array.isArray(report)
    || Object.keys(report).length !== topKeys.length
    || Object.keys(report).some((key) => !topKeys.includes(key))
    || report.seed !== '0x7a5b3c1d') return false;
  const synthetic = report.synthetic;
  const syntheticKeys = ['cases', 'mismatches', 'duplicateIdCases', 'missingParentEdges', 'explicitCycleGraphs', 'graphEdges'];
  if (!synthetic || typeof synthetic !== 'object' || Array.isArray(synthetic)
    || Object.keys(synthetic).length !== syntheticKeys.length
    || Object.keys(synthetic).some((key) => !syntheticKeys.includes(key))
    || synthetic.cases !== 500 || synthetic.mismatches !== 0
    || syntheticKeys.some((key) => !Number.isSafeInteger(synthetic[key]) || synthetic[key] < 0)
    || !Array.isArray(report.chainAllMatch) || report.chainAllMatch.length !== 3) return false;
  const expectedSizes = [100, 1_000, 3_000];
  return report.chainAllMatch.every((item, index) => item && typeof item === 'object' && !Array.isArray(item)
    && Object.keys(item).length === 3
    && item.size === expectedSizes[index]
    && item.runs === 7
    && typeof item.medianMs === 'number' && Number.isFinite(item.medianMs) && item.medianMs >= 0);
}

function validTopologyVerificationReport(report, workspace) {
  const rootKeys = ['schemaVersion', 'suite', 'verdict', 'buildRoot', 'generatedAt', 'requestPolicy', 'cases'];
  if (!report || typeof report !== 'object' || Array.isArray(report)
    || Object.keys(report).length !== rootKeys.length || Object.keys(report).some(key => !rootKeys.includes(key))
    || report.schemaVersion !== 1 || report.suite !== 'offline synthetic agent topology verifier'
    || report.verdict !== 'pass' || report.buildRoot !== path.resolve(workspace, 'dist')
    || typeof report.generatedAt !== 'string' || !Number.isFinite(Date.parse(report.generatedAt))
    || report.requestPolicy !== 'synthetic API and build assets locally fulfilled; all other requests aborted'
    || !Array.isArray(report.cases) || report.cases.length !== 6) return false;
  const caseKeys = ['shape', 'size', 'verdict', 'failureCodes', 'unexpectedRequestCount', 'pageErrorCount', 'initialRenderMs', 'initialCardCount', 'searchMs', 'matchSummary', 'visibleCardCount', 'contextCardCount', 'selectionGuidance', 'selectionDetail'];
  const expectedCases = [
    ...[100, 1_000, 3_000].map(size => ({ shape: 'chain', size, visible: size, context: size - 1 })),
    ...[100, 1_000, 3_000].map(size => ({ shape: 'star', size, visible: 2, context: 1 })),
  ];
  return report.cases.every((item, index) => {
    const expected = expectedCases[index];
    return item && typeof item === 'object' && !Array.isArray(item)
      && Object.keys(item).length === caseKeys.length && Object.keys(item).every(key => caseKeys.includes(key))
      && item.shape === expected.shape && item.size === expected.size && item.verdict === 'pass'
      && Array.isArray(item.failureCodes) && item.failureCodes.length === 0
      && item.unexpectedRequestCount === 0 && item.pageErrorCount === 0
      && Number.isFinite(item.initialRenderMs) && item.initialRenderMs >= 0 && item.initialRenderMs <= 11_000
      && item.initialCardCount === expected.size
      && Number.isFinite(item.searchMs) && item.searchMs >= 0 && item.searchMs <= 11_000
      && item.matchSummary === `일치 1 / 전체 ${expected.size}`
      && item.visibleCardCount === expected.visible && item.contextCardCount === expected.context
      && item.selectionGuidance === true && item.selectionDetail === true;
  });
}

function validNavigationVerificationReport(report, workspace) {
  const rootKeys = ['schemaVersion', 'suite', 'verdict', 'buildRoot', 'generatedAt', 'requestPolicy', 'cases'];
  const names = ['deep-desktop', 'deep-mobile', 'next-previous-wrap', 'filter-cursor-reset', 'scope-cursor-reset', 'hidden-selection-retained'];
  const caseKeys = ['name', 'verdict', 'failureCodes', 'unexpectedRequestCount', 'pageErrorCount', 'checkCount'];
  if (!report || typeof report !== 'object' || Array.isArray(report)
    || Object.keys(report).length !== rootKeys.length || Object.keys(report).some(key => !rootKeys.includes(key))
    || report.schemaVersion !== 1 || report.suite !== 'offline synthetic match navigation verifier'
    || report.verdict !== 'pass' || report.buildRoot !== path.resolve(workspace, 'dist')
    || typeof report.generatedAt !== 'string' || !Number.isFinite(Date.parse(report.generatedAt))
    || report.requestPolicy !== 'synthetic API and build assets locally fulfilled; all other requests aborted'
    || !Array.isArray(report.cases) || report.cases.length !== names.length) return false;
  return report.cases.every((item, index) => item && typeof item === 'object' && !Array.isArray(item)
    && Object.keys(item).length === caseKeys.length && Object.keys(item).every(key => caseKeys.includes(key))
    && item.name === names[index] && item.verdict === 'pass'
    && Array.isArray(item.failureCodes) && item.failureCodes.length === 0
    && item.unexpectedRequestCount === 0 && item.pageErrorCount === 0
    && Number.isSafeInteger(item.checkCount) && item.checkCount >= 4);
}

async function runQaCommands(stage, workspace, {
  runId = process.env.PAPERCLIP_RUN_ID ?? null,
  issueId = null,
  correctedLegacyWaitingTest = false,
} = {}) {
  const agentReport = await readJson(workspace, `workflow-artifacts/${stage}.json`);
  const normalizedAgentFindings = normalizeQaFindings(agentReport?.findings);
  const normalizedUnverifiedChecks = normalizeUnverifiedChecks(agentReport?.unverifiedChecks);
  const findings = normalizedAgentFindings.findings;
  if (!normalizedAgentFindings.valid) findings.push('QA report findings are malformed or contain unsupported fields');
  if (!normalizedUnverifiedChecks.valid) findings.push('QA report unverifiedChecks are malformed');
  const checks = [];
  const requiredTests = ['tests/agent-filter.test.mjs', 'tests/agent-filter.browser.mjs'];
  for (const testFile of requiredTests) {
    const present = await nonempty(workspace, testFile);
    checks.push({ command: `file ${testFile}`, status: present ? 'pass' : 'fail' });
    if (!present) findings.push(`Required test file is missing: ${testFile}`);
  }
  const graphVerificationEnabled = process.env.AX_VERIFY_FILTER_GRAPH === '1' && QA_STAGES.has(stage);
  const graphEvidencePath = 'workflow-artifacts/filter-verification.json';
  const topologyVerificationEnabled = process.env.AX_VERIFY_TOPOLOGY === '1' && QA_STAGES.has(stage);
  const topologyEvidencePath = 'workflow-artifacts/topology-verification.json';
  const navigationVerificationEnabled = process.env.AX_VERIFY_NAVIGATION === '1' && QA_STAGES.has(stage);
  const navigationEvidencePath = 'workflow-artifacts/navigation-verification.json';
  const commands = [['npm', ['test']], ['npm', ['run', 'build']], [process.execPath, ['tests/agent-filter.browser.mjs'], 60_000]];
  if (graphVerificationEnabled) {
    commands.push([
      process.execPath,
      ['experiments/paperclip/verify-agent-filter.mjs', '--output', artifactPath(workspace, graphEvidencePath)],
      60_000,
      'node experiments/paperclip/verify-agent-filter.mjs',
    ]);
  }
  if (topologyVerificationEnabled) {
    commands.push([
      process.execPath,
      ['experiments/paperclip/verify-agent-topology.mjs', '--build-root', path.resolve(workspace, 'dist'), '--output', artifactPath(workspace, topologyEvidencePath)],
      90_000,
      'node experiments/paperclip/verify-agent-topology.mjs',
    ]);
  }
  if (stage === 'system' || stage === 'acceptance') {
    const hasVerifyUrl = Boolean(process.env.AX_VERIFY_URL?.trim());
    checks.push({ command: 'AX_VERIFY_URL configured', status: hasVerifyUrl ? 'pass' : 'fail' });
    if (!hasVerifyUrl) findings.push('AX_VERIFY_URL is required for browser verification');
  }
  if (navigationVerificationEnabled) {
    commands.push([
      process.execPath,
      ['experiments/paperclip/verify-agent-navigation.mjs', '--build-root', path.resolve(workspace, 'dist'), '--output', artifactPath(workspace, navigationEvidencePath)],
      120_000,
      'node experiments/paperclip/verify-agent-navigation.mjs',
    ]);
  }
  for (const [command, args, timeoutMs = CODEX_TIMEOUT_MS, explicitLabel] of commands) {
    const label = explicitLabel ?? `${path.basename(command)} ${args.join(' ')}`;
    const isBrowserCheck = args[0] === 'tests/agent-filter.browser.mjs';
    const isGraphCheck = graphVerificationEnabled && args[0] === 'experiments/paperclip/verify-agent-filter.mjs';
    const isTopologyCheck = topologyVerificationEnabled && args[0] === 'experiments/paperclip/verify-agent-topology.mjs';
    const isNavigationCheck = navigationVerificationEnabled && args[0] === 'experiments/paperclip/verify-agent-navigation.mjs';
    const evidencePath = 'workflow-artifacts/agent-filter-browser-results.json';
    const evidenceBefore = isBrowserCheck ? await fileVersion(workspace, evidencePath) : null;
    const graphEvidenceBefore = isGraphCheck ? await fileVersion(workspace, graphEvidencePath) : null;
    const topologyEvidenceBefore = isTopologyCheck ? await fileVersion(workspace, topologyEvidencePath) : null;
    const navigationEvidenceBefore = isNavigationCheck ? await fileVersion(workspace, navigationEvidencePath) : null;
    let commandStatus = 'pass';
    try {
      await runProcess(command, args, { cwd: workspace, timeoutMs });
    } catch {
      commandStatus = 'fail';
      findings.push(`${label} failed`);
    }
    if (isBrowserCheck) {
      const evidenceAfter = await fileVersion(workspace, evidencePath);
      if (fileVersionChanged(evidenceBefore, evidenceAfter)) {
        if (evidenceAfter.type !== 'file') {
          findings.push('Browser result artifact is not a regular file');
        } else {
          const browserEvidence = browserFailureNames(await readJson(workspace, evidencePath));
          if (!browserEvidence.valid) findings.push('Browser result artifact is malformed');
          else findings.push(...browserEvidence.names.map((name) => `Browser failure scenario: ${name}`));
        }
      }
    }
    if (isGraphCheck) {
      const graphEvidenceAfter = await fileVersion(workspace, graphEvidencePath);
      if (!fileVersionChanged(graphEvidenceBefore, graphEvidenceAfter)) {
        commandStatus = 'fail';
        findings.push('Filter graph verification report was not freshly written');
      } else if (graphEvidenceAfter.type !== 'file') {
        commandStatus = 'fail';
        findings.push('Filter graph verification report is not a regular file');
      } else if (!validFilterVerificationReport(await readJson(workspace, graphEvidencePath))) {
        commandStatus = 'fail';
        findings.push('Filter graph verification report is malformed or has mismatches');
      }
    }
    if (isTopologyCheck) {
      const evidenceAfter = await fileVersion(workspace, topologyEvidencePath);
      if (!fileVersionChanged(topologyEvidenceBefore, evidenceAfter)) {
        commandStatus = 'fail';
        findings.push('Topology verification report was not freshly written');
      } else if (evidenceAfter.type !== 'file') {
        commandStatus = 'fail';
        findings.push('Topology verification report is not a regular file');
      } else if (!validTopologyVerificationReport(await readJson(workspace, topologyEvidencePath), workspace)) {
        commandStatus = 'fail';
        findings.push('Topology verification report is malformed or has mismatches');
      }
    }
    if (isNavigationCheck) {
      const evidenceAfter = await fileVersion(workspace, navigationEvidencePath);
      if (!fileVersionChanged(navigationEvidenceBefore, evidenceAfter)) {
        commandStatus = 'fail';
        findings.push('Match navigation verification report was not freshly written');
      } else if (evidenceAfter.type !== 'file') {
        commandStatus = 'fail';
        findings.push('Match navigation verification report is not a regular file');
      } else if (!validNavigationVerificationReport(await readJson(workspace, navigationEvidencePath), workspace)) {
        commandStatus = 'fail';
        findings.push('Match navigation verification report is malformed or has mismatches');
      }
    }
    checks.push({ command: label, status: commandStatus });
  }
  const agentVerdict = normalizedAgentFindings.valid && normalizedUnverifiedChecks.valid && ['pass', 'fail'].includes(agentReport?.verdict)
    ? agentReport.verdict
    : 'fail';
  if (!['pass', 'fail'].includes(agentReport?.verdict)) findings.push('QA agent verdict is missing or invalid');
  const summary = {
    verdict: agentVerdict === 'pass' && checks.every((check) => check.status === 'pass') && findings.length === 0 ? 'pass' : 'fail',
    runId,
    issueId,
    agentVerdict,
    findings,
    agentUnverifiedChecks: normalizedUnverifiedChecks.checks,
    checks,
  };
  await writeJson(workspace, `workflow-artifacts/${stage}.json`, summary);
  const unverifiedNote = summary.agentUnverifiedChecks.length
    ? `\n\nUnverified by the Codex sandbox:\n${summary.agentUnverifiedChecks.map((item) => `- ${item}`).join('\n')}`
    : '';
  await writeFile(artifactPath(workspace, `workflow-artifacts/${stage}.md`), `# ${stage} QA\n\nVerdict: ${summary.verdict}\n\n${findings.length ? findings.map((finding) => `- ${finding}`).join('\n') : '- No product findings reported.'}${unverifiedNote}`);
  return summary;
}

async function verifyArtifacts(stage, workspace, { runId = null, issueId = null } = {}) {
  for (const relativePath of STAGE_OUTPUTS[stage]) {
    if (!(await nonempty(workspace, relativePath))) throw new Error(`Required stage artifact is missing or empty: ${relativePath}`);
  }
  if (QA_STAGES.has(stage)) {
    const report = await readJson(workspace, `workflow-artifacts/${stage}.json`);
    if (!report || !['pass', 'fail'].includes(report.verdict) || !Array.isArray(report.findings)) {
      throw new Error(`Invalid QA report: workflow-artifacts/${stage}.json`);
    }
  }
  if (stage === 'approval') {
    const approval = await readJson(workspace, 'workflow-artifacts/approval.json');
    if (!approval || approval.approved !== true || typeof approval.reason !== 'string' || !approval.reason.trim()) {
      throw new Error('Approval was not granted');
    }
    const system = await readJson(workspace, 'workflow-artifacts/system.json');
    const requiredChecks = [
      'file tests/agent-filter.test.mjs',
      'file tests/agent-filter.browser.mjs',
      'npm test',
      'npm run build',
      'node tests/agent-filter.browser.mjs',
    ];
    if (system?.verdict !== 'pass' || !Array.isArray(system.checks)
      || requiredChecks.some((command) => !system.checks.some((check) => check.command === command && check.status === 'pass'))
      || system.checks.some((check) => check.status !== 'pass')) {
      throw new Error('System QA did not pass all independent checks');
    }
  }
  if (stage === 'delivery-review') {
    const review = await readJson(workspace, 'workflow-artifacts/delivery-review.json');
    const acceptance = await readJson(workspace, 'workflow-artifacts/acceptance.json');
    const approval = await readJson(workspace, 'workflow-artifacts/approval.json');
    const deployment = await readJson(workspace, 'workflow-artifacts/deployment.json');
    const delivery = await readJson(workspace, 'workflow-artifacts/release-delivery.json');
    const acceptanceChecks = [
      'file tests/agent-filter.test.mjs',
      'file tests/agent-filter.browser.mjs',
      'npm test',
      'npm run build',
      'node tests/agent-filter.browser.mjs',
    ];
    if (process.env.AX_VERIFY_FILTER_GRAPH === '1') acceptanceChecks.push('node experiments/paperclip/verify-agent-filter.mjs');
    if (process.env.AX_VERIFY_TOPOLOGY === '1') acceptanceChecks.push('node experiments/paperclip/verify-agent-topology.mjs');
    if (process.env.AX_VERIFY_NAVIGATION === '1') acceptanceChecks.push('node experiments/paperclip/verify-agent-navigation.mjs');
    const reviewKeys = ['accepted', 'reason', 'releaseDigest', 'acceptanceRunId', 'acceptanceIssueId'];
    if (!review || typeof review !== 'object' || Array.isArray(review)
      || Object.keys(review).length !== reviewKeys.length || Object.keys(review).some(key => !reviewKeys.includes(key))
      || review.accepted !== true || typeof review.reason !== 'string' || !review.reason.trim() || review.reason.length > 1_000
      || !/^[a-f0-9]{64}$/i.test(review.releaseDigest ?? '')) {
      throw new Error('Delivery review was not accepted with a valid review record');
    }
    if (!acceptance || acceptance.verdict !== 'pass' || acceptance.agentVerdict !== 'pass'
      || !Array.isArray(acceptance.findings) || acceptance.findings.length !== 0
      || !Array.isArray(acceptance.checks)
      || acceptanceChecks.some(command => !acceptance.checks.some(check => check && check.command === command && check.status === 'pass'))
      || acceptance.checks.some(check => !check || check.status !== 'pass')
      || typeof acceptance.runId !== 'string' || !acceptance.runId
      || typeof acceptance.issueId !== 'string' || !acceptance.issueId) {
      throw new Error('Online acceptance evidence is missing or failed');
    }
    if (approval?.approved !== true) throw new Error('Product release approval is missing');
    if (!deployment || !/^[a-f0-9]{64}$/i.test(deployment.digest ?? '') || review.releaseDigest !== deployment.digest) {
      throw new Error('Delivery review digest does not match the packaged release');
    }
    if (review.acceptanceRunId !== acceptance.runId || review.acceptanceIssueId !== acceptance.issueId) {
      throw new Error('Delivery review acceptance provenance does not match');
    }
    if (!delivery || delivery.verdict !== 'pass' || !Array.isArray(delivery.checks) || delivery.checks.length === 0
      || delivery.checks.some(check => !check || check.status !== 'pass' || typeof check.asset !== 'string' || !check.asset || !/^[a-f0-9]{64}$/.test(check.sha256 ?? ''))) {
      throw new Error('Release delivery checks are missing or failed');
    }
    const deliveredHashes = Object.fromEntries([...delivery.checks].sort((a, b) => a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0).map(check => [check.asset, check.sha256]));
    const deliveredDigest = createHash('sha256').update(JSON.stringify(deliveredHashes)).digest('hex');
    if (typeof deployment.workflowId !== 'string' || !deployment.workflowId
      || delivery.workflowId !== deployment.workflowId || delivery.releaseDigest !== deployment.digest
      || delivery.assetDigest !== deliveredDigest || !Number.isFinite(Date.parse(delivery.verifiedAt ?? ''))
      || (deployment.assetDigest
        ? delivery.assetBaseline !== 'packaging-time' || delivery.assetDigest !== deployment.assetDigest
        : delivery.assetBaseline !== 'verification-time')) throw new Error('Release delivery provenance does not match the packaged release');
  }
  if (stage === 'implement' || stage === 'fix') {
    const validation = await readJson(workspace, implementationValidationPath(stage));
    if (validation?.runId !== runId || validation?.issueId !== issueId || validation?.verdict !== 'pass'
      || !Array.isArray(validation.checks)
      || ['npm test', 'npm run build'].some((command) => !validation.checks.some((check) => check.command === command && check.status === 'pass'))
      || validation.checks.some((check) => check.status !== 'pass')) {
      throw new Error(`Independent ${stage} validation report is missing or failed`);
    }
  }
}

async function markComplete(issueId, stage, result = 'completed') {
  await api(`/issues/${encodeURIComponent(issueId)}`, {
    method: 'PATCH',
    headers: { 'X-Paperclip-Run-Id': process.env.PAPERCLIP_RUN_ID },
    body: JSON.stringify({ status: 'done', comment: `Stage ${stage} ${result}. Required artifacts and checks were verified.` }),
  });
}

async function markBlocked(issueId, stage, error) {
  const message = error instanceof Error ? error.message : 'Unknown stage failure';
  await api(`/issues/${encodeURIComponent(issueId)}`, {
    method: 'PATCH',
    headers: { 'X-Paperclip-Run-Id': process.env.PAPERCLIP_RUN_ID },
    body: JSON.stringify({ status: 'blocked', comment: `Stage ${stage} failed. ${message.slice(0, 240)}` }),
  });
}

function validIssueId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value ?? '');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const stage = args.stage;
  if (!args.workspace || !path.isAbsolute(args.workspace)) throw new Error('--workspace must be an absolute path');
  const workspace = path.resolve(args.workspace);
  const issueId = args.issue;
  if (!VALID_STAGES.has(stage)) throw new Error('--stage must name a supported workflow stage');
  if (!validIssueId(issueId)) throw new Error('--issue must be a UUID');

  let checkedOut = false;
  let protectedSnapshot;
  let correctedLegacyWaitingTest = false;
  try {
    const issue = await getIssue(issueId);
    await assertBlockersDone(issue);
    await checkout(issueId);
    checkedOut = true;
    protectedSnapshot = await snapshotWorkspace(workspace);
    const priorOutputStats = await snapshotStageOutputStats(stage, workspace);
    await runCodex(stage, issue, workspace);
    await verifyFreshStageOutputs(stage, priorOutputStats, workspace);
    if (QA_STAGES.has(stage)) {
      const boundary = await verifyWorkspaceChanges(stage, protectedSnapshot, workspace);
      correctedLegacyWaitingTest = boundary.correctedLegacyWaitingTest === true;
      const qa = await runQaCommands(stage, workspace, {
        runId: process.env.PAPERCLIP_RUN_ID ?? null,
        issueId,
        correctedLegacyWaitingTest,
      });
      await verifyArtifacts(stage, workspace);
      await verifyWorkspaceChanges(stage, protectedSnapshot, workspace);
      await markComplete(issueId, stage, `completed with QA verdict ${qa.verdict}`);
      console.log(`[ax-stage-agent] ${stage}: completed; QA verdict ${qa.verdict}`);
      return { stage, issueId, verdict: qa.verdict };
    }
    await verifyWorkspaceChanges(stage, protectedSnapshot, workspace);
    if (stage === 'implement' || stage === 'fix') {
      await runImplementationValidations(stage, workspace, {
        runId: process.env.PAPERCLIP_RUN_ID ?? null,
        issueId,
      });
    }
    await verifyArtifacts(stage, workspace, {
      runId: process.env.PAPERCLIP_RUN_ID ?? null,
      issueId,
    });
    await verifyWorkspaceChanges(stage, protectedSnapshot, workspace);
    await markComplete(issueId, stage);
    console.log(`[ax-stage-agent] ${stage}: completed`);
    return { stage, issueId, verdict: 'pass' };
  } catch (error) {
    let failure = error;
    if (protectedSnapshot) {
      try {
        await verifyWorkspaceChanges(stage, protectedSnapshot, workspace);
      } catch (boundaryError) {
        failure = boundaryError;
      }
    }
    if (checkedOut && !cliShutdownSignal) {
      try {
        await markBlocked(issueId, stage, failure);
      } catch {
        // Keep API response bodies, credentials, and subprocess output out of logs.
      }
    }
    if (cliShutdownSignal) return { stage, issueId, verdict: 'blocked' };
    const safeMessage = failure instanceof Error ? failure.message : 'Unknown worker failure';
    console.error(`[ax-stage-agent] ${stage}: failed (${safeMessage.slice(0, 240)})`);
    process.exitCode = 1;
    return { stage, issueId, verdict: 'blocked' };
  }
}

export {
  VALID_STAGES,
  STAGE_OUTPUTS,
  parseArgs,
  assertBlockersDone,
  sanitizedChildEnv,
  runProcess,
  shutdownOwnedChildGroups,
  taskPrompt,
  snapshotWorkspace,
  snapshotStageOutputStats,
  verifyFreshStageOutputs,
  changedWorkspacePaths,
  prohibitedWorkspaceChanges,
  prohibitedExistingArtifactChanges,
  verifyWorkspaceChanges,
  verifyArtifacts,
  normalizeQaFindings,
  normalizeUnverifiedChecks,
  fileVersion,
  fileVersionChanged,
  browserFailureNames,
  validFilterVerificationReport,
  validTopologyVerificationReport,
  runQaCommands,
  validNavigationVerificationReport,
  implementationValidationPath,
  runImplementationValidations,
  markComplete,
  markBlocked,
  main,
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  installCliShutdownHandlers();
  await main();
}
