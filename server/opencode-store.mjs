import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { SnapshotStore } from './snapshot-store.mjs';
import { safeText } from './store.mjs';

const parse = value => {
  try { const item = JSON.parse(value); return item && typeof item === 'object' && !Array.isArray(item) ? item : {}; }
  catch { return {}; }
};
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

function messageStatus(message) {
  if (message.role !== 'assistant') return undefined;
  if (message.error) {
    const kind = `${message.error.name || ''} ${message.error.type || ''} ${message.error.message || ''}`;
    return /abort|cancel|interrupt/i.test(kind) ? 'interrupted' : 'failed';
  }
  if (message.time?.completed == null || message.finish === 'tool-calls') return 'inProgress';
  return 'completed';
}

export class OpenCodeStore extends SnapshotStore {
  constructor({ opencodeHome, projectRoot, now = Date.now }) {
    super({ projectRoot, now });
    this.opencodeHome = opencodeHome;
  }

  readSnapshot() {
    const db = new DatabaseSync(join(this.opencodeHome, 'opencode.db'), { readOnly: true });
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250');
      const sessions = db.prepare('SELECT * FROM session').all();
      const roots = sessions.filter(session => !session.parent_id && typeof session.directory === 'string' && resolve(session.directory) === this.projectRoot);
      const included = new Set(roots.map(session => session.id));
      let changed = true;
      while (changed) {
        changed = false;
        for (const session of sessions) {
          if (session.parent_id && included.has(session.parent_id) && !included.has(session.id)) {
            included.add(session.id);
            changed = true;
          }
        }
      }

      const messagesForSession = db.prepare('SELECT id,session_id,time_created,time_updated,data FROM message WHERE session_id=? ORDER BY time_created,id');
      const parts = db.prepare('SELECT data FROM part WHERE message_id=? AND session_id=? ORDER BY time_created,id');
      const result = [];
      for (const session of sessions) {
        if (!included.has(session.id)) continue;
        const events = [];
        const messages = messagesForSession.all(session.id);
        for (const row of messages) {
          const message = parse(row.data);
          if (!['user','assistant'].includes(message.role)) continue;
          const status = messageStatus(message);
          const statusOnText = message.role === 'user' ? 'inProgress' : status && ((message.time?.completed != null && message.finish !== 'tool-calls') || status === 'failed' || status === 'interrupted') ? status : undefined;
          const timestamp = finite(message.time?.created) ?? finite(row.time_created);
          const partsForMessage = parts.all(row.id, session.id).map(item => parse(item.data));
          const visibleText = [];
          const messageEvents = [];
          for (let index = 0; index < partsForMessage.length; index++) {
            const part = partsForMessage[index];
            if (part.ignored || part.synthetic || part.metadata?.synthetic) continue;
            if (part.type === 'text' && typeof part.text === 'string') {
              const text = safeText(part.text);
              if (text) visibleText.push({ index, text });
            } else if (part.type === 'tool' || part.type === 'tool-invocation') {
              const toolName = part.type === 'tool-invocation' ? part.toolInvocation?.toolName : part.tool;
              const label = typeof toolName === 'string' ? toolName : '도구 호출';
              messageEvents.push({ index, event:{ id:`${row.id}:${index}`, type:'tool', label:safeText(label,120), timestamp, text:'' } });
            }
          }
          if (visibleText.length) {
            messageEvents.push({ index:visibleText[0].index, event:{ id:row.id, type:message.role === 'user' ? 'userMessage' : 'agentMessage', label:message.role === 'user' ? '작업 요청' : '진행 메시지', timestamp, text:visibleText.map(part => part.text).join('\n'), ...(statusOnText ? {status:statusOnText} : {}) } });
          }
          messageEvents.sort((a,b) => a.index-b.index);
          events.push(...messageEvents.map(item => item.event));
          if (status) {
            events.push({ id:`${row.id}:completion`, type:'agentMessage', label:'턴 상태', timestamp:finite(message.time?.completed) ?? finite(row.time_updated) ?? timestamp, text:'', status });
          }
        }
        const assistant = messages.map(row => parse(row.data)).findLast(message => message.role === 'assistant' && (message.modelID || message.providerID || message.model || message.agent)) || {};
        const model = parse(session.model);
        const messageModel = parse(assistant.model);
        const modelName = [assistant.providerID || messageModel.providerID || model.providerID, assistant.modelID || messageModel.modelID || model.modelID].filter(Boolean).join('/');
        const nickname = session.agent || assistant.agent || '';
        result.push({ id:session.id, parentId:session.parent_id || null, cwd:session.directory, title:safeText(session.title,120), nickname:safeText(nickname,120), role:nickname || null,
          updatedAt:finite(session.time_updated),
          model:safeText(modelName,120), events });
      }
      return result;
    } finally {
      db.close();
    }
  }
}
