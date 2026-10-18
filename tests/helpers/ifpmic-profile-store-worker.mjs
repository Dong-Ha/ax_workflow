import * as fs from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { publishSnapshot } from '../../runtime/ifpmic/index.mjs';

const [root, fixturePath, mode = 'publish'] = process.argv.slice(2);
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const signal = event => process.send?.({ event });
const waitFor = event => new Promise(resolve => {
  const onMessage = message => {
    if (message?.event !== event) return;
    process.off('message', onMessage);
    resolve();
  };
  process.on('message', onMessage);
});

let io = fs;
if (mode === 'barrier-publish') {
  signal('ready');
  await waitFor('publish-now');
} else if (['pause-before-link', 'pause-after-link', 'pause-after-dir-sync', 'observe-dir-sync'].includes(mode)) {
  io = {
    ...fs,
    open: async (path, ...args) => {
      const handle = await fs.open(path, ...args);
      if (path === root) {
        const sync = handle.sync.bind(handle);
        handle.sync = async (...syncArgs) => {
          await sync(...syncArgs);
          if (mode === 'pause-after-dir-sync') {
            signal('directory-synced-before-response');
            await waitFor('resume');
          } else if (mode === 'observe-dir-sync') {
            signal('directory-sync-complete');
          }
        };
      }
      return handle;
    },
    link: async (from, to) => {
      if (mode === 'pause-before-link') {
        signal('before-link');
        await waitFor('resume');
      }
      await fs.link(from, to);
      if (mode === 'pause-after-link') {
        signal('linked-before-dir-sync');
        await waitFor('resume');
      }
    },
  };
}

try {
  const record = await publishSnapshot(root, fixture.record, { io });
  process.stdout.write(`${JSON.stringify({ snapshot_id: record.snapshot_id })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: error?.code ?? 'UNKNOWN' })}\n`);
  process.exitCode = 1;
}
