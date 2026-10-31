import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRequest, runAnalysis } from '../runtime/agents/analysis.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help')) {
  console.log('Usage: npm run ax:analyze -- --input <request.json> [--model <model>]');
  console.log('실제 로컬 Codex 호출 1~2회. P01/P02만 실행하며 결과는 workflow-artifacts/analysis/에 보존합니다.');
} else {
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i];
      if (!['--input', '--model'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--') || options[key]) {
        throw new Error('ANALYSIS_ARGUMENTS_INVALID');
      }
      options[key] = args[i + 1];
    }
    if (!options['--input']) throw new Error('ANALYSIS_ARGUMENTS_INVALID');
    const { directory, run } = await runAnalysis(await readRequest(resolve(options['--input'])), {
      outputRoot: resolve(root, 'workflow-artifacts/analysis'), model: options['--model'] ?? 'gpt-6-luna',
      signal: abort.signal, onProgress: event => console.log(`${event.step}: ${event.status}`),
    });
    console.log(`상태: ${run.status}\n결과: ${directory}/report.md\n기록: ${directory}/run.json`);
    process.exitCode = run.status === 'slice_completed' ? 0 : run.status === 'needs_human' ? 2 : 1;
  } catch (error) {
    console.error(['ANALYSIS_ARGUMENTS_INVALID', 'ANALYSIS_REQUEST_INVALID', 'AGENT_INSTRUCTIONS_INVALID']
      .includes(error.message) ? error.message : 'ANALYSIS_UNAVAILABLE');
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
}
