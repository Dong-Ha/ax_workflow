import { DatabaseSync } from 'node:sqlite';
import { resolve, join } from 'node:path';

const labels = { agentMessage: '진행 메시지', userMessage: '작업 요청', commandExecution: '명령 실행', fileChange: '파일 변경', subAgentActivity: '에이전트 활동', collabAgentToolCall: '에이전트 위임', plan: '계획 업데이트', mcpToolCall: '도구 호출', webSearch: '자료 검색' };
const parse = value => {
  try { const item = JSON.parse(value); return item && typeof item === 'object' && !Array.isArray(item) ? item : {}; }
  catch { return {}; }
};
export function safeText(value, limit = 12000) {
  if (typeof value !== 'string') return '';
  return value.slice(0, limit).replace(/\b(?:sk-[\w-]{12,}|Bearer\s+[\w.\/-]{12,})/g, '[인증 정보 숨김]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[숨김]');
}
const textOf = item => item.type === 'userMessage'
  ? (Array.isArray(item.content) ? item.content : []).filter(x => x && x.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n')
  : item.text;
const millis = n => n == null ? null : n < 100000000000 ? n * 1000 : n;

export class CodexStore {
  constructor({ codexHome, projectRoot, now = Date.now }) {
    this.codexHome = codexHome; this.projectRoot = resolve(projectRoot); this.now = now;
    this.cached = null; this.cacheAt = 0;
  }
  open() {
    if (this.state && this.history) return;
    try {
      this.state = new DatabaseSync(join(this.codexHome, 'state_5.sqlite'), { readOnly: true });
      this.history = new DatabaseSync(join(this.codexHome, 'thread_history_1.sqlite'), { readOnly: true });
      this.state.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250');
      this.history.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250');
    } catch (e) { this.close(); throw e; }
  }
  close() { this.state?.close(); this.history?.close(); this.state = this.history = null; this.cached = null; }
  topology() {
    this.open();
    if (this.cached && this.now() - this.cacheAt < 1500) return this.cached;
    const threads = this.state.prepare(`WITH RECURSIVE related(id) AS (
      SELECT id FROM threads WHERE cwd = ?
      UNION SELECT e.child_thread_id FROM thread_spawn_edges e JOIN related r ON r.id=e.parent_thread_id
    ) SELECT t.id,t.title,t.name,t.cwd,t.agent_role,t.agent_nickname,t.model,t.updated_at,t.created_at
      FROM threads t JOIN related r ON r.id=t.id`).all(this.projectRoot);
    const ids = new Set(threads.map(t => t.id));
    const edges = this.state.prepare('SELECT parent_thread_id,child_thread_id,status FROM thread_spawn_edges').all()
      .filter(e => ids.has(e.parent_thread_id) && ids.has(e.child_thread_id));
    const children = new Set(edges.map(e => e.child_thread_id));
    const roots = threads.filter(t => !children.has(t.id) && resolve(t.cwd) === this.projectRoot)
      .sort((a,b) => b.updated_at-a.updated_at);
    this.cached = { threads, edges, roots }; this.cacheAt = this.now(); return this.cached;
  }
  selection(sessionId) {
    const topology = this.topology();
    const root = sessionId ? topology.roots.find(r => r.id === sessionId) : topology.roots[0];
    if (sessionId && !root) throw Object.assign(new Error('AX 대화를 찾을 수 없습니다.'), { statusCode: 404 });
    const ids = new Set(root ? [root.id] : []);
    let changed = true;
    while (changed) { changed = false; for (const e of topology.edges) if (ids.has(e.parent_thread_id) && !ids.has(e.child_thread_id)) { ids.add(e.child_thread_id); changed=true; } }
    return { ...topology, root, ids };
  }
  dashboard(sessionId) {
    const { threads, edges, roots, root, ids } = this.selection(sessionId);
    const agents = threads.filter(t => ids.has(t.id)).sort((a,b) => a.id === root?.id ? -1 : b.id === root?.id ? 1 : a.created_at-b.created_at).map(t => {
      const turn = this.history.prepare('SELECT * FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1').get(t.id);
      const last = this.history.prepare('SELECT created_at_ms,started_at_ms,completed_at_ms FROM thread_items WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1').get(t.id);
      const activityAt = Math.max(millis(turn?.started_at) ?? 0, millis(turn?.completed_at) ?? 0,
        last?.created_at_ms ?? 0, last?.started_at_ms ?? 0, last?.completed_at_ms ?? 0);
      const itemById = id => id ? parse(this.history.prepare('SELECT item_json FROM thread_items WHERE thread_id=? AND item_id=? LIMIT 1').get(t.id,id)?.item_json) : {};
      let task = safeText(textOf(itemById(turn?.first_user_item_id)));
      if (!task && turn) {
        const first = this.history.prepare("SELECT item_json FROM thread_items WHERE thread_id=? AND turn_id=? AND item_type='userMessage' ORDER BY rollout_ordinal LIMIT 1").get(t.id,turn.turn_id);
        task = safeText(textOf(parse(first?.item_json)));
      }
      let result = safeText(textOf(itemById(turn?.final_agent_item_id)));
      if (!result && turn?.status === 'completed') {
        for (const row of this.history.prepare("SELECT item_json FROM thread_items WHERE thread_id=? AND turn_id=? AND item_type='agentMessage' ORDER BY rollout_ordinal DESC LIMIT 20").all(t.id,turn.turn_id)) {
          const item = parse(row.item_json);
          if (item.phase === 'final_answer' || item.phase === 'final') { result = safeText(item.text); break; }
        }
      }
      const status = ['inProgress','completed','failed','interrupted'].includes(turn?.status) ? turn.status : 'unknown';
      return { id:t.id, parentId:edges.find(e=>e.child_thread_id===t.id)?.parent_thread_id ?? null,
        role:t.id===root?.id ? 'main' : t.agent_role || 'agent', nickname:safeText(t.agent_nickname || t.name || t.title,120),
        model:t.model ?? '', status, lastActivityAt:activityAt || null,
        stale:status==='inProgress' && (!activityAt || this.now()-activityAt>60000), task, result };
    });
    return { updatedAt:this.now(),source:{status:'ok'},sessions:roots.map(t=>({id:t.id,title:safeText(t.name||t.title||'AX 대화',120),updatedAt:millis(t.updated_at)})),selectedSessionId:root?.id ?? null,agents,
      edges:edges.filter(e=>ids.has(e.parent_thread_id)&&ids.has(e.child_thread_id)).map(e=>({parentId:e.parent_thread_id,childId:e.child_thread_id,closed:e.status==='closed'})) };
  }
  activity(agentId, sessionId, before) {
    const { ids } = this.selection(sessionId);
    if (!ids.has(agentId)) throw Object.assign(new Error('AX 에이전트를 찾을 수 없습니다.'),{statusCode:404});
    const types = Object.keys(labels);
    const rows = this.history.prepare(`SELECT * FROM thread_items WHERE thread_id=? AND rollout_ordinal < ? AND item_type IN (${types.map(()=>'?').join(',')}) ORDER BY rollout_ordinal DESC LIMIT 51`).all(agentId,before ?? Number.MAX_SAFE_INTEGER,...types);
    const page = rows.slice(0,50);
    return { items:page.map(r=>{ const d=parse(r.item_json); return {id:r.item_id,type:r.item_type,label:labels[r.item_type],timestamp:r.created_at_ms ?? r.started_at_ms,
      text:safeText(['agentMessage','userMessage','plan'].includes(r.item_type) ? textOf(d) : '',6000)}; }),nextCursor:rows.length>50 ? page.at(-1).rollout_ordinal : null };
  }
}
