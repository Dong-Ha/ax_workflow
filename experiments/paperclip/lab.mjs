import { spawn } from 'node:child_process';
import { mkdir, access } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const lab = join(root, '.paperclip-lab');
const cli = join(lab, 'runtime/node_modules/paperclipai/dist/index.js');
const version = '2026.1005.0';
const args = process.argv.slice(2);
const command = args[0] ?? 'start';
function isolatedEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAPERCLIP_') && !['DATABASE_URL', 'DATABASE_MIGRATION_URL', 'HOST', 'PORT'].includes(key)));
}
function child(executable, parameters, env = process.env) {
  return new Promise((ok, fail) => {
    const process = spawn(executable, parameters, { cwd: root, env, stdio: 'inherit' });
    process.on('error', fail);
    process.on('exit', (code) => code === 0 ? ok() : fail(new Error(`${executable} exited with ${code}`)));
  });
}
await mkdir(lab, { recursive: true });
if (command === 'install') {
  await child('npm', ['install', '--prefix', join(lab, 'runtime'), '--no-package-lock', `paperclipai@${version}`]);
} else if (command === 'start') {
  await access(cli);
  let configured = true;
  try { await access(join(lab, 'data/instances/default/config.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; configured = false; }
  const parameters = configured
    ? [cli, 'run', '--data-dir', join(lab, 'data'), '--bind', 'loopback']
    : [cli, 'onboard', '--data-dir', join(lab, 'data'), '--bind', 'loopback', '--yes', '--no-install-service'];
  await child(process.execPath, parameters, isolatedEnv());
} else {
  throw new Error('Use install or start');
}
