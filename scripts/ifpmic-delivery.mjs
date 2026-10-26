import { spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const planPath = resolve(root, 'docs/ifpmic/delivery-plan.json');

export function selectFlow(plan, id = plan.current_flow) {
  const flow = plan.flows.find(item => item.id === id);
  if (!flow) throw new Error(`Unknown flow: ${id}`);
  return flow;
}

export function selectSlice(flow, id) {
  const slice = flow.slices?.find(item => item.id === id);
  if (!slice) throw new Error(`Unknown slice for ${flow.id}: ${id}`);
  return slice;
}

// Executables and paths belong to code, never plan data or CLI input.
const profiles = {
  'mock-task-dto': { executable: resolve(root, '.ifpmic-venv/bin/python'),
    args: ['-B', '-m', 'pytest', '-p', 'no:cacheprovider', '-q', 'tests/ifpmic_api/test_mock_task_dto.py'] },
  'mock-task-read-state': { executable: process.execPath,
    args: ['--test', 'tests/ifpmic-admission-read.test.mjs', 'tests/ifpmic-mock-task-read.test.mjs'] },
  'mock-task-state': { executable: process.execPath, args: ['--test', 'tests/ifpmic-mock-task.test.mjs'] },
  'execution-owner': { executable: resolve(root, '.ifpmic-venv/bin/python'),
    args: ['-B', '-m', 'pytest', '-p', 'no:cacheprovider', '-q',
      'tests/ifpmic_api/test_local_execution.py', 'tests/ifpmic_api/test_claim_expiry_observer.py'] },
  'admission-context': { executable: process.execPath, args: ['--test', 'tests/ifpmic-context.test.mjs'] },
  'admission-read-state': { executable: process.execPath, args: ['--test', 'tests/ifpmic-admission-read.test.mjs'] },
  'admission-dto': { executable: resolve(root, '.ifpmic-venv/bin/python'),
    args: ['-B', '-m', 'pytest', '-p', 'no:cacheprovider', '-q', 'tests/ifpmic_api/test_admission_dto.py'] },
  'admission-state': { executable: process.execPath, args: ['--test', 'tests/ifpmic-admission.test.mjs'] },
  'delivery-tool': { executable: process.execPath, args: ['--test', 'tests/ifpmic-delivery.test.mjs'] },
  'admission-local': { executable: resolve(root, '.ifpmic-venv/bin/python'),
    args: ['-B', '-m', 'pytest', '-p', 'no:cacheprovider', '-q',
      'tests/ifpmic_api/test_execution_protocol.py', 'tests/ifpmic_api/test_execution_workspace.py'] },
};

export function feedbackCommands(flow, slice, requestedProfiles) {
  const defaults = slice.feedback_profiles;
  const allowed = slice.allowed_feedback_profiles ?? defaults;
  const validNames = names => Array.isArray(names) && names.length > 0
    && new Set(names).size === names.length
    && names.every(name => Object.hasOwn(profiles, name));
  if (!validNames(defaults) || !validNames(allowed)
      || defaults.some(name => !allowed.includes(name))) throw new Error('Invalid feedback profile configuration in plan');
  const selected = requestedProfiles ?? defaults;
  if (!validNames(selected) || selected.some(name => !allowed.includes(name))) {
    throw new Error('Unknown or duplicate feedback profile for slice');
  }
  return selected.map(name => ({ name, ...profiles[name] }));
}

export function parseArgs(args) {
  const options = { level: 'feedback', run: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run') options.run = true;
    else if (['--flow', '--slice', '--level', '--profile'].includes(args[i])) {
      const key = args[i].slice(2);
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing ${args[i]}`);
      const value = args[++i];
      if (key === 'profile') (options.profiles ??= []).push(value);
      else {
        if (seen.has(key)) throw new Error(`Duplicate ${args[i - 1]}`);
        seen.add(key);
        options[key] = value;
      }
    } else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (!['feedback', 'integration', 'acceptance'].includes(options.level)) throw new Error('Unknown validation level');
  if ((options.profiles || options.slice) && options.level !== 'feedback') throw new Error('--slice/--profile require feedback level');
  return options;
}

async function runCheck(command, directory) {
  const log = await open(resolve(directory, `${command.name}.log`), 'wx', 0o600);
  const started = Date.now();
  try {
    return await new Promise(resolveResult => {
      let timedOut = false;
      const child = spawn(command.executable, command.args, {
        cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd],
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });
      const interrupt = () => {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
      };
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
      // These profiles contain only local tests, not DB/Temporal launchers.
      const timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      }, 60000);
      child.once('error', () => {
        clearTimeout(timer);
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
        resolveResult({ name: command.name, status: 'unavailable', elapsed_ms: Date.now() - started });
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
        resolveResult({ name: command.name, status: timedOut ? 'timeout' : code === 0 ? 'passed' : 'failed',
          exit_code: code, signal, elapsed_ms: Date.now() - started });
      });
    });
  } finally {
    await log.close();
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  const flow = selectFlow(plan, options.flow);
  console.log(`${flow.title}\n목표: ${flow.outcome}\n상태: ${flow.status}`);
  if (flow.next_action) console.log(`다음 행동: ${flow.next_action}`);
  console.log('개발 검사 통과는 기능 전달·전체 H2·AT 수용을 뜻하지 않습니다.');
  if (options.level !== 'feedback') {
    const obligations = options.level === 'integration' ? flow.integration : flow.final_acceptance;
    console.log((obligations ?? ['이 흐름의 검증 계획 미정']).map(item => `- ${item}`).join('\n'));
    if (options.run) {
      console.error('이 수준의 자동 실행은 연결되지 않았습니다. 해당 계약의 실행 절차를 따르세요.');
      return 2;
    }
    return 0;
  }
  const defaultSlice = flow.id === plan.current_flow ? plan.current_slice : flow.default_slice;
  const slice = selectSlice(flow, options.slice ?? defaultSlice);
  console.log(`이번 전달: ${slice.title} (${slice.mode})\n행동: ${slice.outcome}`);
  console.log(slice.acceptance.map(item => `- ${item}`).join('\n'));
  console.log(`차단 조건: ${slice.blockers.join('; ') || '없음'}`);
  console.log(`아직 연결할 기능 검사: ${slice.checks_to_add.join('; ') || '없음'}`);
  console.log('선택 검사 통과 뒤 종료합니다. 재검사는 새 변경·실패·미해결 위험이 있을 때만 추가합니다.');
  const commands = feedbackCommands(flow, slice, options.profiles);
  console.log(commands.map(command => `${command.name}: ${command.args.join(' ')}`).join('\n'));
  if (!options.run) return 0;
  const directory = resolve(root, 'workflow-artifacts/delivery', new Date().toISOString().replaceAll(':', '-') + `-${process.pid}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const checks = [];
  const started = Date.now();
  for (const command of commands) {
    const result = await runCheck(command, directory);
    checks.push(result);
    console.log(`${result.name}: ${result.status} (${result.elapsed_ms} ms)`);
    if (result.status !== 'passed') break;
  }
  console.log(`총 검사 시간: ${Date.now() - started} ms`);
  const passed = checks.length === commands.length && checks.every(item => item.status === 'passed');
  await writeFile(resolve(directory, 'result.json'), JSON.stringify({
    schema_version: 'ifpmic.delivery-feedback.v2', flow: flow.id, slice: slice.id, level: 'feedback',
    selected_profiles: commands.map(command => command.name), elapsed_ms: Date.now() - started,
    pending_feature_checks: slice.checks_to_add,
    passed, full_acceptance: false, product_delivered: false, checks,
  }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`검사 기록: ${directory}/result.json`);
  return passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
