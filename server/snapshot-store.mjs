import { resolve } from 'node:path';
import { safeText } from './store.mjs';

const missing = message => Object.assign(new Error(message), { statusCode: 404 });
export class SnapshotStore {
  constructor({ projectRoot, now = Date.now }) { this.projectRoot = resolve(projectRoot); this.now = now; }
  close() { this.cached = null; }
  topology() {
    if (this.cached && this.now() - this.cacheAt < 1500) return this.cached;
    const threads = this.readSnapshot();
    const roots = threads.filter(t => !t.parentId && typeof t.cwd === 'string' && resolve(t.cwd) === this.projectRoot);
    const ids = new Set(roots.map(t => t.id));
    let changed = true;
    while (changed) { changed = false; for (const t of threads) if (ids.has(t.parentId) && !ids.has(t.id)) { ids.add(t.id); changed = true; } }
    const scoped = threads.filter(t => ids.has(t.id));
    for (const t of scoped) t.updatedAt = t.events.reduce((latest,e) => Math.max(latest,e.timestamp || 0),t.updatedAt || 0);
    roots.sort((a,b) => b.updatedAt - a.updatedAt);
    this.cacheAt = this.now(); this.cached = { threads: scoped, roots }; return this.cached;
  }
  selection(sessionId) {
    const { threads, roots } = this.topology();
    const root = sessionId ? roots.find(t => t.id === sessionId) : roots[0];
    if (sessionId && !root) throw missing('프로젝트 대화를 찾을 수 없습니다.');
    const ids = new Set(root ? [root.id] : []);
    let changed = true;
    while (changed) { changed = false; for (const t of threads) if (ids.has(t.parentId) && !ids.has(t.id)) { ids.add(t.id); changed = true; } }
    return { roots, root, threads: threads.filter(t => ids.has(t.id)).sort((a,b) => a.id === root?.id ? -1 : b.id === root?.id ? 1 : 0) };
  }
  dashboard(sessionId) {
    const { roots, root, threads } = this.selection(sessionId);
    const agents = threads.map(t => {
      const events = t.events;
      const userIndex = events.findLastIndex(e => e.type === 'userMessage');
      const turn = events.slice(Math.max(0, userIndex));
      const status = turn.findLast(e => e.status)?.status || 'unknown';
      const lastActivityAt = t.updatedAt || null;
      const answer = turn.findLast(e => e.type === 'agentMessage' && e.text)?.text || '';
      return { id:t.id, parentId:t.parentId || null, role:t.id === root?.id ? 'main' : t.role || 'agent', nickname:safeText(t.nickname || t.title || t.id,120), model:safeText(t.model,120), status, lastActivityAt,
        stale:status === 'inProgress' && (!lastActivityAt || this.now()-lastActivityAt > 60000), task:safeText(events[userIndex]?.text), result:status === 'completed' ? safeText(answer) : '' };
    });
    return { updatedAt:this.now(), source:{status:'ok'}, sessions:roots.map(t => ({id:t.id,title:safeText(t.title || '프로젝트 대화',120),updatedAt:t.updatedAt})), selectedSessionId:root?.id || null, agents,
      edges:agents.filter(t => t.parentId).map(t => ({parentId:t.parentId,childId:t.id,closed:t.status === 'completed'})) };
  }
  activity(agentId,sessionId,before) {
    const thread = this.selection(sessionId).threads.find(t => t.id === agentId);
    if (!thread) throw missing('프로젝트 에이전트를 찾을 수 없습니다.');
    const events = thread.events.map((e,index) => ({...e,ordinal:index})).filter(e => e.ordinal < (before ?? Number.MAX_SAFE_INTEGER)).reverse();
    const page = events.slice(0,50);
    return { items:page.map(e => ({id:e.id,type:e.type,label:safeText(e.label,120),timestamp:e.timestamp || null,text:safeText(e.text,6000)})), nextCursor:events.length > 50 ? page.at(-1).ordinal : null };
  }
}
