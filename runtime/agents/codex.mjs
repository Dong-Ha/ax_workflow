import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// The executable is operator configuration, never task content. No shell is used.
export function codexArguments({ workspace, model, schemaPath, outputPath }) {
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(model)) {
    throw new Error('AGENT_RUNTIME_INVALID');
  }
  return ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral',
    '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--json',
    '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'apps',
    '--disable', 'plugins', '--disable', 'multi_agent', '--disable', 'browser_use',
    '--disable', 'computer_use', '-c', 'web_search="disabled"',
    '-c', 'project_doc_max_bytes=0', '-c', 'approval_policy="never"',
    '-c', 'model_reasoning_effort="low"', '-C', workspace, '-m', model,
    '--output-schema', schemaPath, '--output-last-message', outputPath, '-'];
}

export async function invokeCodex({ prompt, schema, workspace, model = 'gpt-6-luna',
  executable = 'codex', timeoutMs = 60000, signal }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || signal?.aborted) {
    throw new Error(signal?.aborted ? 'AGENT_INTERRUPTED' : 'AGENT_RUNTIME_INVALID');
  }
  const schemaPath = join(workspace, 'output-schema.json');
  const outputPath = join(workspace, 'answer.json');
  await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600, flag: 'wx' });
  const args = codexArguments({ workspace, model, schemaPath, outputPath });
  const env = Object.fromEntries(['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'TZ', 'CODEX_HOME',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'].filter(key => process.env[key] !== undefined)
    .map(key => [key, process.env[key]]));
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: workspace, env, detached: true,
      stdio: ['pipe', 'pipe', 'ignore'] });
    let failure;
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    let bytes = 0;
    let completed = false;
    let killTimer;
    const killGroup = signalName => {
      try { process.kill(-child.pid, signalName); } catch { /* already stopped */ }
    };
    const stop = code => {
      if (failure) return;
      failure = code;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 1000);
    };
    const interrupt = () => stop('AGENT_INTERRUPTED');
    signal?.addEventListener('abort', interrupt, { once: true });
    if (signal?.aborted) interrupt();
    const timer = setTimeout(() => stop('AGENT_TIMEOUT'), timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) { stop('AGENT_OUTPUT_INVALID'); return; }
      buffer += decoder.write(chunk);
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { stop('AGENT_OUTPUT_INVALID'); continue; }
        if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
          stop('AGENT_OUTPUT_INVALID'); continue;
        }
        // Never persist transcripts. This pilot permits text generation only.
        if (event.item && !['agent_message', 'reasoning'].includes(event.item.type)) stop('AGENT_TOOL_DENIED');
        if (event.type === 'turn.started') completed = false;
        if (event.type === 'turn.completed') completed = true;
        if (event.type === 'turn.failed' || event.type === 'error') stop('AGENT_EXECUTION_FAILED');
      }
    });
    child.stdin.on('error', () => { /* exit/close determines the final error */ });
    child.stdin.end(prompt);
    const cleanup = () => {
      clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', interrupt);
      // The CLI owns a group; do not leave descendants after it exits.
      killGroup('SIGKILL');
    };
    child.once('error', () => { cleanup(); reject(new Error('AGENT_RUNTIME_UNAVAILABLE')); });
    child.once('close', code => {
      if ((buffer + decoder.end()).trim()) failure ??= 'AGENT_OUTPUT_INVALID';
      cleanup();
      if (failure || code !== 0 || !completed) reject(new Error(failure ?? 'AGENT_EXECUTION_FAILED'));
      else resolve();
    });
  });
  try {
    const raw = await readFile(outputPath);
    if (raw.length > 128 * 1024) throw new Error();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch { throw new Error('AGENT_OUTPUT_INVALID'); }
}
