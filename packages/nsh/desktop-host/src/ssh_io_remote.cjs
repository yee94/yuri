// Fixed native SSH worker. Only `request` is supplied on stdin by Rust. No user code/paths.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const MAX = 512 * 1024 * 1024, COUNT = 20000;
const config = ['config.json', 'opencode.json', 'opencode.jsonc'];
const single = ['AGENTS.md', 'cursor-models.json'];
const directories = ['agents', 'agent', 'commands', 'command', 'skills', 'skill', 'snippet', 'snippets', 'plugins'];
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const fail = code => { const e = Error(); e.safeCode = code; throw e; };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const excluded = name => name === 'node_modules' || name === '.venv-asc' || name.endsWith('.backup');
const allowed = name => {
  if (typeof name !== 'string' || !name || Buffer.byteLength(name) > 4096 || /[\\:\x00-\x1f\x7f-\x9f]/.test(name)) return false;
  const p = name.replace(/\/$/, '').split('/');
  if (p.length > 64 || p.some(v => !v || v === '.' || v === '..' || excluded(v) || /[ .]$/.test(v) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(v))) return false;
  return p[0] === '@agents' || directories.includes(p[0]) || p.length === 1 && [...config, ...single].includes(p[0]);
};
const home = fs.realpathSync(os.homedir());
const root = path.join(home, '.config', 'opencode');
const store = (identity=request.identity) => path.join(root, '.yuri.sync-runs', identity);
const targetLock = path.join(root, '.yuri.sync-target-lock');
const nativePath = name => {
  if (!allowed(name)) fail('ssh_invalid');
  return name.replace(/\/$/, '') === '@agents' ? path.join(home, '.agents') : name.startsWith('@agents/') ? path.join(home, '.agents', name.slice(8)) : path.join(root, name);
};
const exists = p => { try { fs.lstatSync(p); return true; } catch(e) { if(e.code === 'ENOENT') return false; throw e; } };
const check = p => {
  const rel = path.relative(home, p); if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) fail('ssh_invalid');
  let cur = home;
  const privateRoots=[path.join(root,'.yuri.sync-runs'),path.join(root,'.yuri.sync-backup'),targetLock,path.join(home,'.yuri.sync-backup-agents')];
  for (const part of rel.split(path.sep).filter(Boolean)) { cur = path.join(cur, part); if (!exists(cur)) break; const st = fs.lstatSync(cur); if (st.isSymbolicLink() || st.isFile() && st.nlink !== 1) fail('ssh_invalid');if(st.isDirectory()&&privateRoots.some(p=>cur===p||cur.startsWith(p+path.sep))&&(typeof process.geteuid!=='function'||st.uid!==process.geteuid()||(st.mode&0o077)!==0))fail('ssh_invalid'); }
};
const syncDir = p => { const fd = fs.openSync(p, fs.constants.O_RDONLY); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
const mkdir = p => { check(p); if (exists(p)) { if(!fs.statSync(p).isDirectory()) fail('ssh_invalid'); return; } mkdir(path.dirname(p)); fs.mkdirSync(p, { mode: 0o700 }); syncDir(path.dirname(p)); };
const bytes = p => { check(p); const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { const before = fs.fstatSync(fd, { bigint: true }); if (!before.isFile() || before.size > BigInt(MAX)) fail('ssh_invalid'); const data = fs.readFileSync(fd); const after = fs.fstatSync(fd, { bigint: true }); if (data.length > MAX || before.mtimeNs !== after.mtimeNs || before.size !== after.size || before.ino !== after.ino) fail('ssh_stale'); return { data, st: after }; } finally { fs.closeSync(fd); } };
const stamp = (st, data) => `${st.dev}:${st.ino}|${st.size}|${st.mtimeNs}|${st.mode & 0o777n}|${digest(data)}`;
const snapshot = () => {
  const entries = []; let total = 0;
  const walk = (p, name) => {
    check(p); const st = fs.lstatSync(p, { bigint: true });
    if (st.isDirectory()) { entries.push({ name: `${name}/`, data: '', version: stamp(st, Buffer.alloc(0)), mode: Number(st.mode & 0o777n) }); for(const child of fs.readdirSync(p).sort()) if (!excluded(child)) walk(path.join(p, child), `${name}/${child}`); }
    else if (st.isFile()) { const {data, st} = bytes(p); total += data.length; entries.push({name, data:data.toString('base64'), version:stamp(st,data), mode:Number(st.mode & 0o777n)}); }
    else fail('ssh_invalid');
    if (entries.length > COUNT || total > MAX) fail('ssh_invalid');
  };
  for(const name of [...config,...single,...directories]) { const p = path.join(root,name); if(exists(p)) walk(p,name); }
  if(exists(path.join(home,'.agents'))) walk(path.join(home,'.agents'),'@agents');
  entries.sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0); validate(entries); return entries;
};
const validate = entries => {
  if(!Array.isArray(entries) || entries.length > COUNT) fail('ssh_invalid'); let total = 0; const names = new Set();
  for(const e of entries) { if (!e || Object.keys(e).sort().join() !== 'data,mode,name,version' || !allowed(e.name) || typeof e.data !== 'string' || typeof e.version !== 'string' || !e.version || e.version.length > 256 || !Number.isInteger(e.mode) || e.mode < 0 || e.mode > 0o777) fail('ssh_invalid'); const key = e.name.replace(/\/$/,'').toLowerCase(); if(names.has(key)) fail('ssh_invalid'); names.add(key); const data = Buffer.from(e.data,'base64'); if(data.toString('base64') !== e.data || e.name.endsWith('/') && data.length) fail('ssh_invalid'); total += data.length; if(total > MAX) fail('ssh_invalid'); }
  const files=new Set(entries.filter(e=>!e.name.endsWith('/')).map(e=>e.name.toLowerCase()));
  for(const e of entries) { const p=e.name.replace(/\/$/,'').split('/');if(p.length===1 && (p[0]==='@agents'||directories.includes(p[0]))!==e.name.endsWith('/'))fail('ssh_invalid'); for(let n=1;n<p.length;n++) if(files.has(p.slice(0,n).join('/').toLowerCase())) fail('ssh_invalid'); }
};
const writeNew = (p,data,mode=0o600) => { check(p); mkdir(path.dirname(p)); const fd = fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,mode); try { fs.writeFileSync(fd,data); fs.fchmodSync(fd,mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } syncDir(path.dirname(p)); };
const statePath = (run,identity=request.identity) => path.join(store(identity),run,'receipt.json');
const state = (run,identity=request.identity) => { if(!id(run)||!id(identity)) fail('ssh_invalid'); const p=statePath(run,identity); check(p); if(!exists(p)) return null; const {data}=bytes(p); if(data.length>16384) fail('ssh_invalid'); const envelope=JSON.parse(data); if(Object.keys(envelope).sort().join()!=='record,sha256'||typeof envelope.record!=='string'||digest(Buffer.from(envelope.record))!==envelope.sha256) fail('ssh_invalid'); const v=JSON.parse(envelope.record); const keys=['schema','runID','identity','fingerprint','phase','startedAt','endedAt','files','bytes','applied'].sort().join(); if(Object.keys(v).sort().join()!==keys||v.schema!==1||v.runID!==run||v.identity!==identity||!['prepared','applying','success','failure','unknown'].includes(v.phase)||!/^[a-f0-9]{64}$/.test(v.fingerprint)||!/^\d{20,39}$/.test(v.startedAt)||v.endedAt!==null&&!/^\d{20,39}$/.test(v.endedAt)||!Number.isInteger(v.files)||v.files<0||v.files>COUNT||!Number.isInteger(v.bytes)||v.bytes<0||v.bytes>MAX||!Number.isInteger(v.applied)||v.applied<0||v.applied>COUNT*2) fail('ssh_invalid'); return v; };
const publish = (run,v) => { const p=statePath(run), tmp=p+'.next',record=JSON.stringify(v); writeNew(tmp,Buffer.from(JSON.stringify({record,sha256:digest(Buffer.from(record))}))); check(p); fs.renameSync(tmp,p); syncDir(path.dirname(p)); };
const states = (identity=request.identity) => { check(store(identity)); if(!exists(store(identity))) return []; const values=[]; for(const name of fs.readdirSync(store(identity))) { if(!id(name)) fail('ssh_invalid'); const v=state(name,identity); if(!v) fail('ssh_sync_unknown'); values.push(v); if(values.length>4096) fail('ssh_busy'); } return values.sort((a,b)=>a.startedAt>b.startedAt?-1:a.startedAt<b.startedAt?1:0); };
const targetUnknown = () => { const parent=path.dirname(store());check(parent); for(const identity of fs.readdirSync(parent)){if(identity==='owner.lock')continue;if(!id(identity))fail('ssh_invalid');if(states(identity).some(v=>['applying','unknown'].includes(v.phase)))return true;}return false; };
const backup = (run,agents) => path.join(agents?path.join(home,'.yuri.sync-backup-agents'):path.join(root,'.yuri.sync-backup'),`${request.identity.length}-${request.identity}-${run}`);
const removePrivate = p => { check(p); for(const name of fs.readdirSync(p)) { const child=path.join(p,name); check(child); if(fs.lstatSync(child).isDirectory()) removePrivate(child); else fs.unlinkSync(child); } fs.rmdirSync(p); };
const prune = run => { for(const agents of [false,true]) { const parent=path.dirname(backup(run,agents)); if(!exists(parent)) continue; const candidates=states().filter(v=>v.runID===run||['success','failure'].includes(v.phase)).map(v=>backup(v.runID,agents)).filter(exists); for(const p of candidates.slice(5)) removePrivate(p); syncDir(parent); } };
const same = (a,b) => a.length===b.length && a.every(e=>b.some(v=>v.name===e.name&&v.version===e.version&&v.data===e.data&&v.mode===e.mode));
const equalBody = (a,b) => a.name===b.name&&a.data===b.data&&a.mode===b.mode;
const signature = entries => digest(Buffer.from(JSON.stringify([...entries].sort((a,b)=>a.name<b.name?-1:1))));
const clock = () => (BigInt(Date.now())*1000000n).toString().padStart(20,'0');
let admitted = false;
const apply = () => {
  const run=request.runID, before=request.before, after=request.after; if(!id(run)) fail('ssh_invalid'); validate(before); validate(after);
  mkdir(store()); const lock=targetLock; check(lock); try{fs.mkdirSync(lock,{mode:0o700});}catch(e){if(e.code==='EEXIST')fail('ssh_busy');throw e;}
  try {
    syncDir(root);
    const fingerprint=digest(Buffer.from(signature(before)+':'+signature(after))); const previous=state(run);
    if(previous) { if(previous.fingerprint!==fingerprint) fail('ssh_invalid'); if(previous.phase==='success') return {ok:true,runID:run,phase:'success'}; if(previous.phase==='failure') fail('ssh_stale'); fail('ssh_sync_unknown'); }
    const history=states(); if(history.length>=4096) fail('ssh_busy'); if(targetUnknown()) fail('ssh_sync_unknown');
    admitted=true;mkdir(path.dirname(statePath(run))); const record={schema:1,runID:run,identity:request.identity,fingerprint,phase:'prepared',startedAt:clock(),endedAt:null,files:after.length,bytes:after.reduce((n,e)=>n+Buffer.from(e.data,'base64').length,0),applied:0}; publish(run,record);
    const stage=path.join(store(),run,'stage');
    try {
      if(!same(snapshot(),before)) fail('ssh_stale'); mkdir(backup(run,false)); mkdir(backup(run,true));
      writeNew(path.join(store(),run,'backup-manifest.json'),Buffer.from(JSON.stringify(before.map(e=>({name:e.name,mode:e.mode,version:e.version,sha256:digest(Buffer.from(e.data,'base64'))})))));
      for(const e of before) { if(after.some(v=>equalBody(v,e))) continue; const agents=e.name.replace(/\/$/,'').split('/')[0]==='@agents'; const rel=agents?e.name.replace(/^@agents\/?/,''):e.name; const p=path.join(backup(run,agents),rel||'agents'); if(e.name.endsWith('/')) mkdir(p); else writeNew(p,Buffer.from(e.data,'base64'),e.mode); }
      mkdir(stage); after.forEach((e,n)=>{if(!e.name.endsWith('/')&&!before.some(v=>equalBody(v,e))) writeNew(path.join(stage,String(n)),Buffer.from(e.data,'base64'),e.mode);});
      if(!same(snapshot(),before)) fail('ssh_stale');
    } catch(e) {record.phase='failure';record.endedAt=clock();publish(run,record);throw e;}
    record.phase='applying';publish(run,record);let uncertain=false;
    try {
      for(const e of after.filter(e=>e.name.endsWith('/')).sort((a,b)=>a.name.length-b.name.length)) { const p=nativePath(e.name); if(!exists(p)) uncertain=true; mkdir(p); }
      after.forEach((e,n)=>{if(e.name.endsWith('/')||before.some(v=>equalBody(v,e))) return; const p=nativePath(e.name);check(p);mkdir(path.dirname(p));const prior=before.find(v=>v.name===e.name);if(prior){const {data,st}=bytes(p);if(stamp(st,data)!==prior.version)fail('ssh_stale');}else if(exists(p))fail('ssh_stale');uncertain=true;fs.renameSync(path.join(stage,String(n)),p);record.applied++;syncDir(path.dirname(p));});
      for(const e of before.filter(e=>!after.some(v=>v.name===e.name)).sort((a,b)=>b.name.length-a.name.length)) { const p=nativePath(e.name);check(p);if(e.name.endsWith('/')){uncertain=true;try{fs.rmdirSync(p);}catch(err){if(err.code==='ENOTEMPTY')continue;throw err;}}else{const {data,st}=bytes(p);if(stamp(st,data)!==e.version)fail('ssh_stale');uncertain=true;fs.unlinkSync(p);}record.applied++;syncDir(path.dirname(p)); }
      for(const e of after.filter(e=>e.name.endsWith('/')).sort((a,b)=>b.name.length-a.name.length)){const p=nativePath(e.name);check(p);if((fs.statSync(p).mode&0o777)!==e.mode){uncertain=true;fs.chmodSync(p,e.mode);syncDir(p);}}
      prune(run);record.phase='success';record.endedAt=clock();publish(run,record);return{ok:true,runID:run,phase:'success'};
    }catch(e){record.phase=uncertain?'unknown':'failure';record.endedAt=clock();publish(run,record);throw e;}
  }finally{fs.rmdirSync(lock);syncDir(root);}
};
let response;
try {
  if(!request||request.schema!==1||!id(request.identity)||!['read','apply','status','history'].includes(request.op)) fail('ssh_invalid');
  if(request.op==='read') response={ok:true,entries:snapshot()};
  else if(request.op==='apply') response=apply();
  else if(request.op==='status') { const v=state(request.runID);check(targetLock);response={ok:true,runID:request.runID,phase:v?.phase==='success'?'success':v?.phase==='failure'||v?.phase==='prepared'&&!exists(targetLock)?'failure':'unknown'}; }
  else response={ok:true,runs:states().map(({identity,fingerprint,...v})=>v)};
}catch(e){let phase='denied';if(admitted){try{phase=state(request.runID)?.phase||'unknown';}catch{phase='unknown';}}response={ok:false,error:e.safeCode||'ssh_storage',phase};}
process.stdout.write(JSON.stringify(response));
