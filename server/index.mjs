import http from 'node:http';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { CodexStore } from './store.mjs';
import { ClaudeStore } from './claude-store.mjs';
import { OpenCodeStore } from './opencode-store.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 3000);
const projectRoot = process.env.AX_PROJECT_ROOT || root;
const stores = {
  codex: new CodexStore({ codexHome:process.env.AX_CODEX_HOME || join(homedir(),'.codex'), projectRoot }),
  claude: new ClaudeStore({ claudeHome:process.env.AX_CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || join(homedir(),'.claude'), projectRoot }),
  opencode: new OpenCodeStore({ opencodeHome:process.env.AX_OPENCODE_HOME || join(process.env.XDG_DATA_HOME || join(homedir(),'.local','share'),'opencode'), projectRoot }),
};
const defaultProvider = 'codex';
const dev = process.argv.includes('--dev');
const vite = dev ? await (await import('vite')).createServer({ root,server:{middlewareMode:true},appType:'spa' }) : null;
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json'};
const server = http.createServer(async (req,res) => {
  const host = (req.headers.host || '').split(':')[0];
  if (!['127.0.0.1','localhost'].includes(host)) { res.writeHead(403);res.end('Local access only');return; }
  const url = new URL(req.url,'http://127.0.0.1');
  const json = (code,data) => {res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
  if (url.pathname.startsWith('/api/')) {
    if(req.method!=='GET') {json(405,{error:'읽기 전용 API입니다.'});return;}
    const provider = url.searchParams.get('provider') || defaultProvider;
    if (!Object.hasOwn(stores,provider)) { json(400,{error:'지원하지 않는 도구입니다.'});return; }
    const store = stores[provider];
    try {
      if(url.pathname==='/api/dashboard') {json(200,{...store.dashboard(url.searchParams.get('sessionId') || undefined),provider});return;}
      const match=url.pathname.match(/^\/api\/agents\/([^/]+)\/activity$/);
      if(match) {
        const raw=url.searchParams.get('before'); const before=raw===null ? undefined : Number(raw);
        if(before!==undefined && (!Number.isSafeInteger(before)||before<0)) {json(400,{error:'잘못된 페이지 커서입니다.'});return;}
        json(200,store.activity(decodeURIComponent(match[1]),url.searchParams.get('sessionId')||undefined,before));return;
      }
      json(404,{error:'API를 찾을 수 없습니다.'});
    } catch(e) {json(e.statusCode || 503,{source:{status:'error',message:e.statusCode ? e.message : '선택한 도구의 기록을 읽을 수 없습니다. 저장소 경로 또는 형식을 확인하세요.'}});}
    return;
  }
  if(vite) {vite.middlewares(req,res);return;}
  try {
    let path=resolve(root,'dist','.'+decodeURIComponent(url.pathname));
    const base=join(root,'dist');
    if(!path.startsWith(base+'/') && path!==base) {res.writeHead(403);res.end();return;}
    if(!/\.[a-z0-9]+$/i.test(url.pathname)) path=join(base,'index.html');
    const body=await readFile(path);const ext=path.slice(path.lastIndexOf('.'));
    res.writeHead(200,{'Content-Type':mime[ext]||'application/octet-stream','X-Content-Type-Options':'nosniff'});res.end(body);
  } catch {res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('페이지가 없습니다. 먼저 npm run build를 실행하세요.');}
});
server.listen(port,'127.0.0.1',()=>console.log(`AX 관제 페이지: http://127.0.0.1:${port}`));
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{Object.values(stores).forEach(store=>store.close());await vite?.close();server.close(()=>process.exit(0));});
