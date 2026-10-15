export default {
  id: 'ax.ifpmic-workflow',
  apiVersion: 1,
  version: '0.1.0',
  displayName: 'IFPMIC AX',
  description: 'IFPMIC v1 workflow, role boundaries, evidence requirements and return routes.',
  author: 'AX',
  categories: ['ui'],
  capabilities: ['ui.page.register'],
  entrypoints: { worker: './dist/worker.js', ui: './dist/ui' },
  ui: { slots: [{ type: 'page', id: 'ifpmic-workflow-page', displayName: 'IFPMIC AX', exportName: 'AxWorkflowPage', routePath: 'ifpmic-ax' }] },
};
