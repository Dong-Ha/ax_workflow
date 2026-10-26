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

// Fixed test paths only: never execute commands supplied through the plan or CLI.
export function feedbackCommands(flow) {
  if (flow.id !== 'admission') throw new Error('이 흐름의 개발 검사가 아직 정의되지 않았습니다.');
  const nodeTests = ['tests/ifpmic-delivery.test.mjs'];
  const pythonTests = [
    'tests/ifpmic_api/test_execution_protocol.py',
    'tests/ifpmic_api/test_execution_workspace.py',
  ];
  if (JSON.stringify(flow.feedback?.node_tests) !== JSON.stringify(nodeTests)
      || JSON.stringify(flow.feedback?.python_tests) !== JSON.stringify(pythonTests)) {
    throw new Error('검사 계획과 실행 목록이 다릅니다. 두 목록을 함께 검토하세요.');
  }
  return [
    { name: 'delivery-tool', executable: process.execPath, args: ['--test', ...nodeTests] },
    { name: 'admission-local', executable: resolve(root, '.ifpmic-venv/bin/python'),
      args: ['-B', '-m', 'pytest', '-p', 'no:cacheprovider', '-q', ...pythonTests] },
  ];
}

export function parseArgs(args) {
  const options = { level: 'feedback', run: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run') options.run = true;
    else if (args[i] === '--flow' || args[i] === '--level') {
      const key = args[i].slice(2);
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing ${args[i]}`);
      options[key] = args[++i];
    } else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (!['feedback', 'integration', 'acceptance'].includes(options.level)) throw new Error('Unknown validation level');
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
  const commands = feedbackCommands(flow);
  console.log(commands.map(command => `${command.name}: ${command.args.join(' ')}`).join('\n'));
  if (!options.run) return 0;
  const directory = resolve(root, 'workflow-artifacts/delivery', new Date().toISOString().replaceAll(':', '-') + `-${process.pid}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const checks = [];
  for (const command of commands) {
    const result = await runCheck(command, directory);
    checks.push(result);
    console.log(`${result.name}: ${result.status}`);
    if (result.status !== 'passed') break;
  }
  const passed = checks.length === commands.length && checks.every(item => item.status === 'passed');
  await writeFile(resolve(directory, 'result.json'), JSON.stringify({
    schema_version: 'ifpmic.delivery-feedback.v1', flow: flow.id, level: 'feedback',
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
