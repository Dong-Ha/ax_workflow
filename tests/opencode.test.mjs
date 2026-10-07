import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeStore } from '../server/opencode-store.mjs';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'ax-opencode-test-'));
  const db = new DatabaseSync(join(home, 'opencode.db'));
  db.exec(`CREATE TABLE session(id TEXT,parent_id TEXT,directory TEXT,title TEXT,agent TEXT,model TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    INSERT INTO session VALUES('root',NULL,'/project/AX','AX session','build','{"providerID":"provider","modelID":"model"}',1,500),
      ('child','root','/other/worktree','Worker','worker','{}',2,500),('other',NULL,'/elsewhere','Other','build','{}',3,500);`);
  let ordinal = 1;
  const message = (id, sessionId, data, contentParts = []) => {
    const created = data.time?.created ?? ordinal * 100;
    db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run(id, sessionId, created, data.time?.completed ?? null, JSON.stringify(data));
    for (const part of contentParts) {
      db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run(`part-${ordinal}`, id, sessionId, ordinal++, ordinal, JSON.stringify(part));
    }
  };
  message('u1', 'root', { role:'user', time:{created:100} }, [{type:'text',text:'Build the dashboard'}]);
  message('a1', 'root', { role:'assistant', time:{created:110,completed:120}, finish:'tool-calls' }, [
    {type:'reasoning',text:'PRIVATE REASONING'}, {type:'text',text:'Checking the source'},
    {type:'tool',tool:'read_file',state:{status:'completed',input:{path:'PRIVATE PATH'},output:'PRIVATE TOOL OUTPUT'}}
  ]);
  message('a2', 'root', { role:'assistant', time:{created:130,completed:140}, finish:'stop' }, [
    {type:'text',text:'Done'}, {type:'text',text:'More done'}, {type:'text',text:'PRIVATE SYNTHETIC',synthetic:true}
  ]);
  message('system', 'root', { role:'system', time:{created:125} }, [{type:'text',text:'PRIVATE UNSUPPORTED ROLE'}]);
  message('u2', 'child', { role:'user', time:{created:150} }, [{type:'text',text:'Check a component'}]);
  message('a3', 'child', { role:'assistant', time:{created:160,completed:170}, error:{name:'AbortError'} }, [{type:'text',text:'Stopped'}]);
  const store = new OpenCodeStore({ opencodeHome:home, projectRoot:'/project/AX', now:()=>1000 });
  t.after(() => { store.close(); db.close(); rmSync(home, {recursive:true,force:true}); });
  return {store, db};
}

test('OpenCode snapshot follows project roots and descendants only', t => {
  const {store} = fixture(t);
  const dashboard = store.dashboard();
  assert.deepEqual(dashboard.sessions.map(session => session.id), ['root']);
  assert.deepEqual(dashboard.agents.map(agent => agent.id), ['root','child']);
  assert.equal(dashboard.agents[0].task, 'Build the dashboard');
  assert.equal(dashboard.agents[0].result, 'Done\nMore done');
  assert.equal(dashboard.agents[0].status, 'completed');
  assert.equal(dashboard.agents[0].model, 'provider/model');
  assert.equal(dashboard.agents[1].status, 'interrupted');
  assert.equal(dashboard.agents[1].parentId, 'root');
  assert.throws(() => store.dashboard('other'), error => error.statusCode === 404);
});

test('OpenCode activity exposes text and tool names while omitting reasoning and tool payloads', t => {
  const {store} = fixture(t);
  const activity = store.activity('root');
  const serialized = JSON.stringify(activity);
  assert.ok(serialized.includes('read_file'));
  assert.ok(serialized.includes('Checking the source'));
  assert.ok(!serialized.includes('PRIVATE REASONING'));
  assert.ok(!serialized.includes('PRIVATE TOOL OUTPUT'));
  assert.ok(!serialized.includes('PRIVATE PATH'));
  assert.ok(!serialized.includes('PRIVATE SYNTHETIC'));
  assert.ok(!serialized.includes('PRIVATE UNSUPPORTED ROLE'));
  assert.equal(activity.items.filter(item => item.id === 'a2').length, 1);
  assert.equal(activity.items.find(item => item.id === 'a2')?.text, 'Done\nMore done');
  assert.equal(activity.items.find(item => item.id === 'a2:completion')?.text, '');
});

test('OpenCode user messages reset status and task after a completed turn', t => {
  const {store,db} = fixture(t);
  db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run('u3','root',200,null,JSON.stringify({role:'user',time:{created:200}}));
  db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run('part-u3','u3','root',200,200,JSON.stringify({type:'text',text:'New task'}));
  store.close();
  const agent = store.dashboard().agents[0];
  assert.equal(agent.task,'New task');
  assert.equal(agent.status,'inProgress');
  assert.equal(agent.result,'');
});

test('OpenCode completed tool-call messages remain in progress', t => {
  const {store,db} = fixture(t);
  db.prepare('DELETE FROM message WHERE id=?').run('a2');
  db.prepare('DELETE FROM part WHERE message_id=?').run('a2');
  store.close();
  assert.equal(store.dashboard().agents[0].status, 'inProgress');
});

test('OpenCode adapter tolerates session tables without optional agent and model columns', t => {
  const home = mkdtempSync(join(tmpdir(), 'ax-opencode-minimal-'));
  const db = new DatabaseSync(join(home,'opencode.db'));
  db.exec(`CREATE TABLE session(id TEXT,parent_id TEXT,directory TEXT,title TEXT);
    CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    INSERT INTO session VALUES('root',NULL,'/project/AX','Session');
    INSERT INTO message VALUES('m','root',1,2,'{"role":"assistant","agent":"review","providerID":"p","modelID":"m","time":{"created":1,"completed":2},"finish":"stop"}');
    INSERT INTO part VALUES('p1','m','root',1,1,'{"type":"text","text":"Ready"}');`);
  const store = new OpenCodeStore({opencodeHome:home,projectRoot:'/project/AX',now:()=>1000});
  t.after(()=>{store.close();db.close();rmSync(home,{recursive:true,force:true});});
  const agent = store.dashboard().agents[0];
  assert.equal(agent.nickname,'review');
  assert.equal(agent.model,'p/m');
  assert.equal(agent.result,'Ready');
});

test('missing OpenCode database is reported and can be retried', t => {
  const home = mkdtempSync(join(tmpdir(), 'ax-opencode-missing-'));
  t.after(() => rmSync(home, {recursive:true,force:true}));
  const store = new OpenCodeStore({ opencodeHome:home, projectRoot:'/project/AX' });
  assert.throws(() => store.dashboard());
  assert.doesNotThrow(() => store.close());
});
