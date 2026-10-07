import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SnapshotStore } from './snapshot-store.mjs';

function entries(path) { try { return readdirSync(path,{withFileTypes:true}); } catch(e) { if (e.code === 'ENOENT') return []; throw e; } }
function transcript(path,id,parentId) {
  const rows = readFileSync(path,'utf8').split('\n').flatMap(line => { try { const row = JSON.parse(line); return row && typeof row === 'object' && !Array.isArray(row) ? [row] : []; } catch { return []; } });
  const events = []; let model = ''; let cwd;
  for (const [index,row] of rows.entries()) {
    if (!cwd && typeof row.cwd === 'string') cwd = row.cwd;
    const timestamp = Number.isFinite(Date.parse(row.timestamp)) ? Date.parse(row.timestamp) : null;
    const add = (type,label,text='',status) => events.push({id:`${id}:${index}:${events.length}`,type,label,text,timestamp,status});
    if (row.type === 'system' && row.subtype === 'turn_duration') { add('turnComplete','턴 완료','','completed'); continue; }
    if (!['user','assistant'].includes(row.type)) continue;
    const message = row.message;
    if (!message || typeof message !== 'object') continue;
    const content = typeof message.content === 'string' ? [{type:'text',text:message.content}] : Array.isArray(message.content) ? message.content : [];
    const text = content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
    if (row.type === 'user') {
      // Tool results, replayed context, and command output are not user prompts.
      if (text && !row.isMeta && !text.startsWith('<local-command') && !text.startsWith('<command-')) add('userMessage','작업 요청',text,'inProgress');
      continue;
    }
    if (typeof message.model === 'string') model = message.model;
    if (text) add('agentMessage','진행 메시지',text);
    for (const block of content) if (block?.type === 'tool_use') add('tool','도구 호출');
    if (['end_turn','stop_sequence'].includes(message.stop_reason)) add('turnComplete','턴 완료','','completed');
    else if (row.isApiErrorMessage) add('turnError','오류','','failed');
  }
  return {id,parentId,cwd,title:events.find(e => e.type === 'userMessage')?.text || id,nickname:parentId ? id.split(':').at(-1) : 'Claude Code',role:parentId ? 'agent' : 'main',model,events};
}
export class ClaudeStore extends SnapshotStore {
  constructor({claudeHome,...options}) { super(options); this.claudeHome = claudeHome; }
  readSnapshot() {
    const projects = join(this.claudeHome,'projects');
    // Missing source is an error, while an existing projects folder with no matching session is empty.
    const folders = readdirSync(projects,{withFileTypes:true});
    const threads = [];
    for (const folder of folders.filter(e => e.isDirectory())) {
      const dir = join(projects,folder.name);
      for (const file of entries(dir).filter(e => e.isFile() && e.name.endsWith('.jsonl') && !e.name.startsWith('agent-'))) {
        const sessionId = file.name.slice(0,-6);
        const root = transcript(join(dir,file.name),sessionId,null);
        if (!root.cwd || resolve(root.cwd) !== this.projectRoot) continue;
        threads.push(root);
        const subdir = join(dir,sessionId,'subagents');
        for (const child of entries(subdir).filter(e => e.isFile() && e.name.startsWith('agent-') && e.name.endsWith('.jsonl'))) {
          threads.push(transcript(join(subdir,child.name),`${sessionId}:${child.name.slice(0,-6)}`,sessionId));
        }
      }
    }
    return threads;
  }
}
