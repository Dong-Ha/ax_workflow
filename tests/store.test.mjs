import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexStore,safeText } from '../server/store.mjs';
function fixture(t) {
 const home=mkdtempSync(join(tmpdir(),'ax-test-')); const state=new DatabaseSync(join(home,'state_5.sqlite'));
 state.exec(`CREATE TABLE threads(id TEXT,title TEXT,name TEXT,cwd TEXT,agent_role TEXT,agent_nickname TEXT,model TEXT,updated_at INTEGER,created_at INTEGER);
 CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT);
 INSERT INTO threads VALUES('root','AX',NULL,'/project/AX',NULL,NULL,'model',100,1),('child','Luna',NULL,'/different','worker_luna','Luna','model',100,1),('other','Other',NULL,'/elsewhere',NULL,NULL,'model',100,1);
 INSERT INTO thread_spawn_edges VALUES('root','child','closed');`);
 const history=new DatabaseSync(join(home,'thread_history_1.sqlite'));
 history.exec(`CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,status TEXT,started_at INTEGER,completed_at INTEGER,first_user_item_id TEXT,final_agent_item_id TEXT);
 CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,started_at_ms INTEGER,completed_at_ms INTEGER,item_json TEXT,item_type TEXT);
 INSERT INTO thread_turns VALUES('root','turn',1,'inProgress',100,NULL,'user',NULL),('child','cturn',1,'completed',100,110,NULL,'result');`);
 const add=(thread,id,n,type,item)=>history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?,?)').run(thread,thread==='child'?'cturn':'turn',id,n,100000,null,null,JSON.stringify(item),type);
 add('root','user',1,'userMessage',{type:'userMessage',content:[{type:'text',text:'Build dashboard'}]});
 add('root','secret',2,'reasoning',{text:'PRIVATE REASONING'});
 add('root','cmd',3,'commandExecution',{command:'PRIVATE COMMAND',aggregatedOutput:'PRIVATE OUTPUT'});
 add('child','result',1,'agentMessage',{type:'agentMessage',phase:'final_answer',text:'Done'});
 const store=new CodexStore({codexHome:home,projectRoot:'/project/AX',now:()=>200000});
 t.after(()=>{store.close();state.close();history.close();rmSync(home,{recursive:true,force:true});});
 return {store,state,history,add};
}
test('AX roots include descendants with another cwd and exclude other projects',t=>{
 const {store}=fixture(t);const d=store.dashboard();assert.deepEqual(d.sessions.map(x=>x.id),['root']);assert.deepEqual(d.agents.map(x=>x.id),['root','child']);
 assert.equal(d.agents[0].task,'Build dashboard');assert.equal(d.agents[0].stale,true);assert.equal(d.agents[1].result,'Done');assert.equal(d.edges[0].closed,true);
 assert.throws(()=>store.dashboard('other'),e=>e.statusCode===404);assert.throws(()=>store.activity('other'),e=>e.statusCode===404);
});
test('closed delegation does not turn in-progress into completion',t=>{
 const {store,history}=fixture(t);history.exec("UPDATE thread_turns SET status='inProgress' WHERE thread_id='child'");assert.equal(store.dashboard().agents[1].status,'inProgress');
});
test('activity omits reasoning and raw command/output and paginates without duplicates',t=>{
 const {store,add}=fixture(t);for(let i=4;i<65;i++) add('root','event'+i,i,'fileChange',{changes:['private']});
 const first=store.activity('root');assert.equal(first.items.length,50);const second=store.activity('root',undefined,first.nextCursor);
 assert.equal(new Set([...first.items,...second.items].map(x=>x.id)).size,64-1);
 const serialized=JSON.stringify([...first.items,...second.items]);assert.ok(!serialized.includes('PRIVATE'));assert.ok(!serialized.includes('reasoning'));assert.equal(second.nextCursor,null);
});
test('failed interrupted unknown and absent turns preserve honest statuses',t=>{
 const {store,history,state}=fixture(t);for(const status of ['failed','interrupted','unrecognized']) {history.prepare("UPDATE thread_turns SET status=? WHERE thread_id='root'").run(status);assert.equal(store.dashboard().agents[0].status,status==='unrecognized'?'unknown':status);}
 history.exec("DELETE FROM thread_turns WHERE thread_id='root'");assert.equal(store.dashboard().agents[0].status,'unknown');
 state.exec('DELETE FROM thread_spawn_edges; DELETE FROM threads');store.cached=null;assert.equal(store.dashboard().agents.length,0);
});
test('malformed items do not break dashboard or activity',t=>{
 const {store,history}=fixture(t);history.exec("UPDATE thread_items SET item_json='{' WHERE item_id='user'");assert.equal(store.dashboard().agents[0].task,'');assert.equal(store.activity('root').items.at(-1).text,'');
});
test('missing stores fail cleanly and allow retry',t=>{
 const home=mkdtempSync(join(tmpdir(),'ax-missing-'));t.after(()=>rmSync(home,{recursive:true,force:true}));const store=new CodexStore({codexHome:home,projectRoot:'/project/AX'});assert.throws(()=>store.dashboard());assert.equal(store.state,null);
});
test('text rendering boundary masks common credentials',()=>assert.equal(safeText('api_key=abcd Bearer abcdefghijklmnop'),'api_key=[숨김] [인증 정보 숨김]'));
test('new turn start is activity even when only prior turn items exist',t=>{
 const {store,history}=fixture(t);
 history.exec("UPDATE thread_turns SET started_at=195 WHERE thread_id='root'");
 const agent=store.dashboard().agents[0];assert.equal(agent.lastActivityAt,195000);assert.equal(agent.stale,false);
});
test('valid JSON with unexpected shapes remains readable',t=>{
 const {store,history}=fixture(t);
 for(const payload of ['null','42','{"type":"userMessage","content":"unexpected"}']) {
  history.prepare("UPDATE thread_items SET item_json=? WHERE item_id='user'").run(payload);
  assert.equal(store.dashboard().agents[0].task,'');assert.equal(store.activity('root').items.at(-1).text,'');
 }
});
