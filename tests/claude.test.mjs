import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeStore } from '../server/claude-store.mjs';
function fixture(t) {
  const home=mkdtempSync(join(tmpdir(),'ax-claude-'));
  const dir=join(home,'projects','encoded');mkdirSync(join(dir,'root','subagents'),{recursive:true});
  const write=(path,rows) => writeFileSync(join(dir,path),rows.map(r=>typeof r==='string'?r:JSON.stringify(r)).join('\n'));
  const user=(text,cwd='/project/AX')=>({type:'user',cwd,timestamp:'2026-01-01T00:00:00Z',message:{content:[{type:'text',text}]}});
  const assistant=(content,stop_reason)=>({type:'assistant',timestamp:'2026-01-01T00:00:01Z',message:{model:'claude',content,stop_reason}});
  write('root.jsonl',[user('Build'),assistant([{type:'thinking',thinking:'PRIVATE'},{type:'tool_use',input:{command:'PRIVATE'}}]),{type:'user',message:{content:[{type:'tool_result',content:'PRIVATE'}]}},assistant([{type:'text',text:'Done password=abc'}],'end_turn')]);
  write('root/subagents/agent-child.jsonl',[user('Child task','/different'),assistant([{type:'text',text:'Child done'}],'end_turn')]);
  write('other.jsonl',[user('PRIVATE','/elsewhere')]);
  const store=new ClaudeStore({claudeHome:home,projectRoot:'/project/AX',now:()=>Date.parse('2026-01-01T00:00:02Z')});
  t.after(()=>rmSync(home,{recursive:true,force:true}));return {store,write,user,assistant};
}
test('Claude scopes roots by cwd and links nested subagents; sanitizes display',t=>{
  const {store}=fixture(t);const d=store.dashboard();assert.deepEqual(d.sessions.map(s=>s.id),['root']);assert.equal(d.agents.length,2);
  assert.equal(d.agents[0].status,'completed');assert.equal(d.agents[0].task,'Build');assert.equal(d.agents[0].result,'Done password=[숨김]');
  assert.equal(d.edges[0].parentId,'root');assert.equal(d.agents[1].task,'Child task');
  assert.ok(!JSON.stringify(store.activity('root')).includes('PRIVATE'));
  assert.throws(()=>store.dashboard('other'),e=>e.statusCode===404);assert.throws(()=>store.activity('other'),e=>e.statusCode===404);
});
test('new prompt clears previous completion and result; duration marks actual turn end',t=>{
  const {store,write,user,assistant}=fixture(t);
  write('root.jsonl',[user('Old'),assistant([{type:'text',text:'Old result'}],'end_turn'),user('New'),'partial {']);
  assert.equal(store.dashboard().agents[0].status,'inProgress');assert.equal(store.dashboard().agents[0].result,'');
  store.close();write('root.jsonl',[user('New'),assistant([{type:'text',text:'New result'}]),{type:'system',subtype:'turn_duration',timestamp:'2026-01-01T00:00:02Z'}]);
  assert.equal(store.dashboard().agents[0].result,'New result');assert.equal(store.dashboard().agents[0].status,'completed');
});
test('assistant text alone is not evidence of completion; pagination includes no duplicate events',t=>{
  const {store,write,user,assistant}=fixture(t);write('root.jsonl',[user('Task'),...Array.from({length:60},(_,i)=>assistant([{type:'text',text:`Message ${i}`}]))]);
  assert.equal(store.dashboard().agents[0].status,'inProgress');const a=store.activity('root');const b=store.activity('root',undefined,a.nextCursor);
  assert.equal(a.items.length,50);assert.equal(b.items.length,11);assert.equal(new Set([...a.items,...b.items].map(e=>e.id)).size,61);assert.equal(b.nextCursor,null);
});
test('missing Claude source reports error without creating files',()=>{
  const store=new ClaudeStore({claudeHome:'/missing-ax-claude',projectRoot:'/project/AX'});assert.throws(()=>store.dashboard());
});
