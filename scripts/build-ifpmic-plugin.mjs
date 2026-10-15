import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'plugins/ifpmic-ax');
const output = resolve(root, '.paperclip-lab/ifpmic-plugin');
const runtimeModules = resolve(root, '.paperclip-lab/runtime/node_modules');
const sdk = JSON.parse(await readFile(resolve(runtimeModules, '@paperclipai/plugin-sdk/package.json'), 'utf8'));
if (sdk.version !== '2026.1005.0') throw new Error('Expected the lab plugin SDK 2026.1005.0; run npm run paperclip:install first.');
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'package.json'), await readFile(resolve(source, 'package.json')));
const common = { bundle: true, format: 'esm', logLevel: 'warning', sourcemap: false };
await build({ ...common, entryPoints: [resolve(source, 'manifest.mjs')], outfile: resolve(output, 'dist/manifest.js'), platform: 'node', target: 'node24' });
await build({ ...common, entryPoints: [resolve(source, 'worker.mjs')], outfile: resolve(output, 'dist/worker.js'), platform: 'node', target: 'node24', nodePaths: [runtimeModules], external: ['react', 'react-dom'] });
await build({ ...common, entryPoints: [resolve(source, 'ui.tsx')], outfile: resolve(output, 'dist/ui/index.js'), platform: 'browser', target: 'es2022', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime', '@paperclipai/plugin-sdk/ui', '@paperclipai/plugin-sdk/ui/hooks'], plugins: [{
  name: 'inline-scoped-css',
  setup(builder) {
    builder.onResolve({ filter: /\.css\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'ifpmic-css' }));
    builder.onLoad({ filter: /.*/, namespace: 'ifpmic-css' }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }));
  },
}] });
console.log('IFPMIC plugin built: .paperclip-lab/ifpmic-plugin (SDK 2026.1005.0, page-only capability)');
