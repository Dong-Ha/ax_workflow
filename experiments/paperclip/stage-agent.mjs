#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const VALID_STAGES = new Set(['planner', 'builder', 'reviewer']);
const TERMINAL_BLOCKER_STATUS = 'done';
const CODEX_TIMEOUT_MS = 180_000;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    args[key] = value;
    i += 1;
  }
  return args;
}

function apiRoot() {
  const base = process.env.PAPERCLIP_API_URL;
  if (!base) throw new Error('PAPERCLIP_API_URL is required');
  const url = new URL(base);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password) throw new Error('Stage worker requires a loopback HTTP API');
  return base.replace(/\/+$/, '').replace(/\/api$/i, '');
}

async function api(pathname, options = {}) {
  const key = process.env.PAPERCLIP_API_KEY;
  if (!key) throw new Error('PAPERCLIP_API_KEY is required');
  const response = await fetch(`${apiRoot()}/api${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Paperclip API request failed (${response.status})`);
  if (response.status === 204) return null;
  return response.json();
}

function issueIdFromEnvironment() {
  const wakeContext = process.env.PAPERCLIP_WAKE_CONTEXT;
  let wakeIssueId;
  if (wakeContext) {
    try {
      const parsed = JSON.parse(wakeContext);
      wakeIssueId = parsed.issueId ?? parsed.taskId ?? parsed.payload?.issueId;
    } catch {
      // Some adapters provide wake context as text; explicit task IDs remain authoritative.
    }
  }
  return process.env.AX_PAPERCLIP_ISSUE_ID
    || process.env.PAPERCLIP_TASK_ID
    || wakeIssueId;
}

async function getIssue(issueId) {
  return api(`/issues/${encodeURIComponent(issueId)}`);
}

async function checkout(issueId) {
  const agentId = process.env.PAPERCLIP_AGENT_ID;
  const runId = process.env.PAPERCLIP_RUN_ID;
  if (!agentId) throw new Error('PAPERCLIP_AGENT_ID is required');
  if (!runId) throw new Error('PAPERCLIP_RUN_ID is required');
  const result = await api(`/issues/${encodeURIComponent(issueId)}/checkout`, {
    method: 'POST',
    headers: { 'X-Paperclip-Run-Id': runId },
    body: JSON.stringify({
      agentId,
      expectedStatuses: ['todo', 'backlog', 'blocked', 'in_review', 'in_progress'],
    }),
  });
  if (result?.status === 'blocked') throw new Error('Issue checkout reports unresolved blockers');
}

async function assertBlockersDone(issue) {
  const blockers = Array.isArray(issue.blockedBy) ? issue.blockedBy : [];
  const unresolved = blockers.filter((blocker) => blocker.status !== TERMINAL_BLOCKER_STATUS);
  if (unresolved.length) {
    throw new Error(`Issue has ${unresolved.length} blocker(s) not marked done`);
  }
}

function stagePrompt(stage, issueId, issue, workspace) {
  const requirements = [
    'Implement a tiny JavaScript slugify library in this workspace.',
    'The public API is slugify(value): lowercase ASCII words separated by single hyphens; trim leading/trailing hyphens; collapse repeated separators; empty input returns an empty string.',
    'Do not edit or create files outside the supplied workspace. Do not make network requests.',
  ].join('\n');
  const stageInstructions = {
    planner: 'Create requirements.md with a concise, testable specification for this library. Do not implement it.',
    builder: 'Read requirements.md and implement the library as slugify.mjs, exporting the slugify function. Do not write tests or a review report.',
    reviewer: 'Review the implementation against requirements.md. Create test/slugify.test.mjs using node:test, run it with `node --test test/slugify.test.mjs`, fix implementation defects if needed, then write report.md with test outcome and a concise summary. Do not include private reasoning in report.md.',
  };
  return `${requirements}\n\nCurrent stage: ${stage}.\nTask: ${issue.title ?? issueId}\nTask description:\n${issue.description ?? '(none)'}\n\n${stageInstructions[stage]}\n\nWorkspace: ${workspace}\nAt the end, provide only a brief final status and changed file names.`;
}

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const { timeoutMs = CODEX_TIMEOUT_MS, ...spawnOptions } = options;
    const child = spawn(command, args, { ...spawnOptions, shell: false, stdio: 'ignore' });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Worker command failed (${signal ?? `exit ${code}`})`));
    });
  });
}

async function runCodex(stage, issueId, issue, workspace) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ax-stage-agent-'));
  const finalMessagePath = path.join(tmp, 'final-message.txt');
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('PAPERCLIP_') || key.startsWith('AX_PAPERCLIP_')) delete childEnv[key];
  }
  try {
    await runProcess('codex', [
      'exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'workspace-write',
      '-C', workspace, '-o', finalMessagePath, stagePrompt(stage, issueId, issue, workspace),
    ], { cwd: workspace, env: childEnv, timeoutMs: CODEX_TIMEOUT_MS });
    // The CLI streams reasoning and tool events to its output streams, which are ignored.
    // Read only the explicitly requested final message, then discard it without logging.
    await readFile(finalMessagePath, 'utf8').catch(() => '');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function runSmoke(stage, workspace) {
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  if (stage === 'planner') {
    await writeFile(path.join(workspace, 'requirements.md'), [
      '# Slugify requirements', '',
      '- Export `slugify(value)` from `slugify.mjs`.',
      '- Convert input to lowercase ASCII words separated by single hyphens.',
      '- Trim leading and trailing hyphens and collapse repeated separators.',
      '- Return an empty string for empty input.',
      '', '_Generated by smoke simulation._', '',
    ].join('\n'));
  } else if (stage === 'builder') {
    await writeFile(path.join(workspace, 'slugify.mjs'), [
      '// Smoke simulation artifact.',
      'export function slugify(value) {',
      '  return String(value ?? \'\')',
      '    .normalize(\'NFKD\')',
      '    .replace(/[\\u0300-\\u036f]/g, \'\')',
      '    .toLowerCase()',
      '    .replace(/[^a-z0-9]+/g, \'-\')',
      '    .replace(/^-+|-+$/g, \'\');',
      '}', '',
    ].join('\n'));
  } else {
    await mkdir(path.join(workspace, 'test'), { recursive: true });
    await writeFile(path.join(workspace, 'test', 'slugify.test.mjs'), [
      '// Smoke simulation tests.',
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { slugify } from '../slugify.mjs';", '',
      "test('normalizes words and separators', () => assert.equal(slugify(' Hello,  AX! '), 'hello-ax'));",
      "test('returns empty string for empty input', () => assert.equal(slugify(''), ''));", '',
    ].join('\n'));
    await writeFile(path.join(workspace, 'report.md'), '# Review report\n\nSmoke simulation artifact; test outcome is recorded after verification.\n');
  }
}

async function verifyStage(stage, workspace) {
  const expected = {
    planner: ['requirements.md'],
    builder: ['requirements.md', 'slugify.mjs'],
    reviewer: ['requirements.md', 'slugify.mjs', 'test/slugify.test.mjs', 'report.md'],
  }[stage];
  for (const file of expected) {
    if (!(await readFile(path.join(workspace, file), 'utf8')).trim()) throw new Error(`Empty stage output: ${file}`);
  }
  if (stage === 'reviewer') {
    await runProcess(process.execPath, ['--input-type=module', '-e', "import assert from 'node:assert/strict'; import {slugify} from './slugify.mjs'; for (const [input, expected] of [['Hello AX','hello-ax'], [' --Hello__AX!! ', 'hello-ax'], ['', ''], ['123 Foo', '123-foo']]) assert.equal(slugify(input), expected);"], { cwd: workspace, env: process.env, timeoutMs: 30000 });
    await runProcess(process.execPath, ['--test', 'test/slugify.test.mjs'], {
      cwd: workspace, env: process.env, timeoutMs: 30_000,
    });
  }
}

async function markComplete(issueId, stage, mode) {
  await api(`/issues/${encodeURIComponent(issueId)}`, {
    method: 'PATCH',
    headers: { 'X-Paperclip-Run-Id': process.env.PAPERCLIP_RUN_ID },
    body: JSON.stringify({
      status: 'done',
      comment: `Stage ${stage} completed (${mode === 'smoke' ? 'simulation' : 'Codex'}). Expected workspace outputs were verified.`,
    }),
  });
}

async function markBlocked(issueId, stage, error) {
  const safeMessage = error instanceof Error ? error.message : 'Unknown stage failure';
  await api(`/issues/${encodeURIComponent(issueId)}`, {
    method: 'PATCH',
    headers: { 'X-Paperclip-Run-Id': process.env.PAPERCLIP_RUN_ID },
    body: JSON.stringify({
      status: 'blocked',
      comment: `Stage ${stage} failed. ${safeMessage.slice(0, 300)}`,
    }),
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stage = args.stage;
  const mode = args.mode ?? 'smoke';
  const workspace = args.workspace;
  if (!VALID_STAGES.has(stage)) throw new Error('--stage must be planner, builder, or reviewer');
  if (!['smoke', 'codex'].includes(mode)) throw new Error('--mode must be smoke or codex');
  if (!workspace || !path.isAbsolute(workspace)) throw new Error('--workspace must be an absolute path');
  const issueId = issueIdFromEnvironment();
  if (!issueId) throw new Error('No issue ID: set AX_PAPERCLIP_ISSUE_ID or PAPERCLIP_TASK_ID');

  console.log(`[stage-agent] ${stage}: loading issue`);
  const issue = await getIssue(issueId);
  await assertBlockersDone(issue);
  await checkout(issueId);
  console.log(`[stage-agent] ${stage}: running ${mode}`);
  try {
    if (mode === 'smoke') await runSmoke(stage, workspace);
    else await runCodex(stage, issueId, issue, workspace);
    await verifyStage(stage, workspace);
    if (mode === 'smoke' && stage === 'reviewer') await writeFile(path.join(workspace, 'report.md'), '# Review report\n\nSmoke simulation: node:test and independent contract checks passed.\n');
    await markComplete(issueId, stage, mode);
    console.log(`[stage-agent] ${stage}: completed`);
  } catch (error) {
    try {
      await markBlocked(issueId, stage, error);
    } catch {
      // Keep the original failure and never print API response bodies or secrets.
    }
    console.error(`[stage-agent] ${stage}: failed (${error instanceof Error ? error.message : 'unknown error'})`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[stage-agent] failed (${error instanceof Error ? error.message : 'unknown error'})`);
  process.exitCode = 1;
});
