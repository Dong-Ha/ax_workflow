import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';

// The V1 plugin has no data/action handlers and no execution or network capabilities.
const plugin = definePlugin({
  async setup() {},
  async onHealth() { return { status: 'ok', message: 'Read-only IFPMIC design page; no live job connected.' }; },
});
export default plugin;
runWorker(plugin, import.meta.url);
