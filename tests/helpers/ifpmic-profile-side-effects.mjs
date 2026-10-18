import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const calls = [];
const trap = name => (..._args) => {
  calls.push(name);
  throw new Error('B01_FORBIDDEN_EFFECT');
};

globalThis.fetch = trap('fetch');
for (const [id, names] of [
  ['node:child_process', ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
  ['node:http', ['request', 'get']],
  ['node:https', ['request', 'get']],
  ['node:net', ['connect', 'createConnection']],
  ['node:tls', ['connect']],
]) {
  const api = require(id);
  for (const name of names) api[name] = trap(`${id}.${name}`);
}
syncBuiltinESMExports();

process.on('exit', () => {
  const destination = process.env.B01_TEST_EFFECT_LEDGER;
  if (destination) writeFileSync(destination, `${JSON.stringify(calls)}\n`);
});
