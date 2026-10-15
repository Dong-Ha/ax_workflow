import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, '.paperclip-lab/runtime/node_modules/paperclipai');
const version = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8')).version;
if (version !== '2026.1005.0') throw new Error('IFPMIC lab requires Paperclip 2026.1005.0');
const data = join(root, '.paperclip-lab/ifpmic-verification-data');
let configured = true;
try { await access(join(data, 'instances/default/config.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; configured = false; }
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAPERCLIP_') && !['DATABASE_URL', 'DATABASE_MIGRATION_URL', 'HOST', 'PORT'].includes(key)));
env.PAPERCLIP_TELEMETRY_DISABLED = '1';
env.PAPERCLIP_UPDATE_CHECK = '0';
const args = configured ? ['run', '--data-dir', data, '--bind', 'loopback'] : ['onboard', '--data-dir', data, '--bind', 'loopback', '--yes', '--no-install-service'];
const child = spawn(process.execPath, [join(runtime, 'dist/index.js'), ...args], { cwd: root, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143); });
