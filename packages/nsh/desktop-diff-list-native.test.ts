import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('real NSH diff list: visible demand, original reader, scope, prior, native scroll and 50 input edits on both desktop models', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'diff-list-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Diff list fixture', id: 'example.yuri.diff-list', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { clipboard: true, host: ['runtime.request'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-diff-list.fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'List.test.tsx'), `
import { expect, open, test } from 'nsh/test';
const key = (scope, path) => JSON.stringify([scope,path]);
const control = (app, action, path) => app.host.send('diff.list.control', { action, path });
const audit = async app => { await control(app,'audit'); return JSON.parse(app.texts().find(text=>text.startsWith('{"readers"'))); };
async function launch(platform, params={}) {
  const reads=[], rejected=[]; let fail=false, delayed=false, finish, version='';
  const handlers = { 'runtime.request': async value => {
    reads.push(value);
     const url=new URL(value.path,'https://fixture.invalid'), path=url.searchParams.get('path'), staged=url.searchParams.get('staged')==='true';
    if(value.method!=='GET'||value.body!==undefined||value.expectedHost?.hostID!=='synthetic'||value.expectedHost?.lease!=='lease-a'||url.searchParams.get('directory')!=='/workspace'||!(url.pathname==='/api/git/diff'||params.full&&['/api/git/status','/api/git/file-diff'].includes(url.pathname))) { rejected.push(value); throw new Error('forbidden wire'); }
    if(url.pathname==='/api/git/status') return {status:200,body:{isClean:false,files:[{path:'z.ts',index:' ',working_dir:'M'}]}};
     if(url.pathname==='/api/git/file-diff') return {status:200,body:{path,original:'OLD_'+path+'\\nFULL_CONTEXT_END',modified:'WORKING_'+path+'\\nFULL_CONTEXT_END',isBinary:false}};
    const waiting=delayed; if(waiting) await new Promise(done=>{finish=done;});
     if(fail) return {status:503,body:{error:'synthetic read failed'}};
     if(params.long&&path==='z.ts') return {status:200,body:{diff:'@@ -1,12002 +1,12002 @@\\n-Z_TOP_OLD\\n'+'-Z_BODY_OLD\\n'.repeat(12000)+'-Z_END_OLD\\n+Z_TOP_NEW\\n'+'+Z_BODY_NEW\\n'.repeat(12000)+'+Z_END_NEW'+version+'\\n'}};
    return {status:200,body:{diff:'@@ -1 +1 @@\\n-OLD_'+path+'\\n+'+(waiting?'LATE_FORBIDDEN':staged?'STAGED_':'WORKING_')+path+version+'\\n'}};
  }};
  const app=await open('./App.tsx',{platform,width:1400,height:900,host:{params,handlers}}); await app.waitFor('id:native-desktop-diff-list');
  return {app,reads,rejected,fail:value=>{fail=value;},delay:value=>{delayed=value;},waiting:()=>!!finish,finish:()=>finish?.(),version:value=>{version=value;}};
}
for(const platform of ['macos','windows']) {
 test(platform+' recycling a parent document restores selection without replaying its old target hunk into the outer List',async()=>{
  const f=await launch(platform,{history:true,recycle:true,lines:12000}); await f.app.waitFor('text:NEW_RECYCLE_TOP');
  await f.app.scroll('id:desktop-diff-list-files',10000000);
  await f.app.press('id:desktop-diff-list-file-recycle-238.ts');
  await f.app.waitFor('id:desktop-diff-entry-'+key('turn','recycle-238.ts')+' >> id:desktop-native-diff');
  await f.app.scroll('id:desktop-diff-stack',80); await f.app.waitFor('text:AFTER_238');
  expect(f.app.count('id:desktop-diff-entry-'+key('turn','z.ts')+' >> id:desktop-native-diff')).toBe(0);
  for(let i=0;i<30&&!f.app.shows('text:NEW_END');i++) {
   await f.app.scroll('id:desktop-diff-stack',-400);
   expect(f.app.shows('text:NEW_RECYCLE_TOP')).toBe(false);
  }
  await f.app.waitFor('text:NEW_END'); expect(f.app.count('id:desktop-native-diff')).toBe(1);
  expect(f.reads).toEqual([]); expect((await audit(f.app)).readers).toBe(1);
 },60000);
 test(platform+' parent natural document keeps a 12000-line item visible by pixels, outer scrolling reaches its end and refresh never snaps to hunk start',async()=>{
  const f=await launch(platform,{long:true}); await f.app.waitFor('text:Z_TOP_NEW');
  expect(f.app.shows('text:Z_END_NEW')).toBe(false);
  await f.app.press('id:desktop-diff-list-file-file-2.ts'); await f.app.waitFor('text:Z_END_NEW');
  expect(f.app.shows('text:Z_TOP_NEW')).toBe(false);
  const before=f.reads.filter(value=>value.path.includes('path=z.ts')).length;
  f.version('_AT_TAIL'); await control(f.app,'refresh'); await f.app.waitFor('text:Z_END_NEW_AT_TAIL');
  expect(f.reads.filter(value=>value.path.includes('path=z.ts')).length).toBe(before+1);
  expect(f.app.shows('text:Z_TOP_NEW')).toBe(false);
  const reads=f.reads.length; for(let i=0;i<50;i++) await f.app.type('id:diff-list-composer','x');
  expect(f.reads.length).toBe(reads); expect((await audit(f.app)).readers).toBe(1);
  await f.app.setViewport(1350,850); await f.app.waitFor('text:Z_END_NEW_AT_TAIL'); expect(f.reads.length).toBe(reads); expect(f.rejected).toEqual([]);
 });
 test(platform+' keeps source order, folds, original reader, resize and 50 real composer input edits without reads or owner replacement',async()=>{
  const f=await launch(platform); await f.app.waitFor('text:WORKING_z.ts'); await f.app.waitFor('text:WORKING_a.ts');
  expect(f.app.texts().filter(text=>['z.ts','a.ts','file-2.ts'].includes(text)).slice(0,3)).toEqual(['z.ts','a.ts','file-2.ts']);
  const before=f.reads.length, initial=await audit(f.app);
  for(let i=0;i<50;i++) await f.app.type('id:diff-list-composer','x');
  expect(f.reads.length).toBe(before); expect((await audit(f.app)).readers).toBe(initial.readers);
  await f.app.setViewport(1099,900); await f.app.setViewport(1100,900); expect(f.reads.length).toBe(before);
  const zReads=f.reads.filter(value=>value.path.includes('path=z.ts')).length;
  await f.app.press('id:desktop-diff-fold-'+key('working','z.ts')); expect(f.app.shows('text:WORKING_z.ts')).toBe(false);
  await f.app.press('id:desktop-diff-fold-'+key('working','z.ts')); await f.app.waitFor('text:WORKING_z.ts'); expect(f.reads.filter(value=>value.path.includes('path=z.ts')).length).toBe(zReads);
  await f.app.press('id:desktop-diff-list-file-a.ts'); await f.app.waitFor('text:WORKING_a.ts'); expect((await audit(f.app)).readers).toBe(1);
  expect(f.rejected).toEqual([]);
 });
 test(platform+' controlled native scope picker drives real staged original select, turn exact snapshots never Git',async()=>{
  const f=await launch(platform); await f.app.waitFor('text:WORKING_z.ts'); await f.app.waitFor('text:WORKING_a.ts');
  await f.app.press('role:combobox[Select change mode]'); await f.app.press('text:Staged: 2'); await f.app.waitFor('text:STAGED_z.ts'); await f.app.waitFor('text:STAGED_file-2.ts');
  expect(f.reads.some(value=>value.path.includes('staged=true'))).toBe(true); expect((await audit(f.app)).readers).toBe(1);
  const stagedCount=f.reads.length;
  await f.app.press('role:combobox[Select change mode]'); await f.app.press('text:Changed: 3'); await f.app.waitFor('text:WORKING_z.ts'); expect(f.reads.length).toBe(stagedCount);
  await f.app.press('role:combobox[Select change mode]'); await f.app.press('text:Last turn: 3'); await f.app.waitFor('text:NEW_HISTORY');
  const before=f.reads.length; expect((await audit(f.app)).directory).toBe('/historical');
  await f.app.press('id:desktop-diff-list-file-a.ts'); await f.app.waitFor('text:A_AFTER'); expect(f.reads.length).toBe(before);
  await f.app.press('id:desktop-diff-list-file-thin.ts'); await f.app.waitFor('id:desktop-diff-retry-'+key('turn','thin.ts')); expect(f.reads.length).toBe(before); expect(f.rejected).toEqual([]);
 });
 test(platform+' large metadata catalog expand-all only reads native visible files and modal/authority revokes old target receipts',async()=>{
  const f=await launch(platform,{many:true}); await f.app.waitFor('text:WORKING_z.ts');
  expect(f.reads.length<8).toBe(true);
   await f.app.press('id:desktop-diff-toggle-all'); await f.app.press('id:desktop-diff-toggle-all');
    const checkDemand=async()=>{ const observed=(await audit(f.app)).demand; expect(observed.map(value=>value.path)).toEqual(f.reads.map(value=>value.path)); for(const value of observed) { expect(value.visible).toBe(true); expect(value.current).toBe(true); } };
    await checkDemand();
   expect(f.reads.some(value=>value.path.includes('path=file-39.ts'))).toBe(false);
    expect(f.reads.length<40).toBe(true);
    await f.app.press('id:desktop-diff-list-file-file-39.ts'); await f.app.waitFor('text:WORKING_file-39.ts');
    await checkDemand();
    expect(f.app.enabled('id:desktop-diff-entry-'+key('working','file-39.ts')+' >> id:desktop-diff-copy')).toBe(true);
  await control(f.app,'active'); const count=f.reads.length; await f.app.type('id:diff-list-composer','private'); expect(f.reads.length).toBe(count);
  await control(f.app,'active'); expect(f.rejected).toEqual([]);
 });
 test(platform+' authoritative refresh failure keeps prior, input never retries, explicit row retry replaces only that body',async()=>{
  const f=await launch(platform); await f.app.waitFor('text:WORKING_z.ts'); await f.app.waitFor('text:WORKING_a.ts');
  f.fail(true); await control(f.app,'refresh'); await f.app.waitFor('id:desktop-diff-retry-'+key('working','z.ts'));
  expect(f.app.shows('text:WORKING_z.ts')).toBe(true);
  const count=f.reads.length; await f.app.type('id:diff-list-composer','preserve'); expect(f.reads.length).toBe(count);
  f.fail(false); f.version('_RETRIED'); await f.app.press('id:desktop-diff-retry-'+key('working','z.ts')); await f.app.waitFor('text:WORKING_z.ts_RETRIED');
  expect(f.reads.length).toBe(count+1); expect(f.app.shows('id:desktop-diff-retry-'+key('working','a.ts'))).toBe(true); expect(f.rejected).toEqual([]);
 });
 test(platform+' list full-files uses the original formal operation, keeps one native document and reuses complete cached text',async()=>{
  const f=await launch(platform,{full:true,one:true}); await f.app.waitFor('text:WORKING_z.ts'); expect(f.reads.length).toBe(1);
  await f.app.press('id:desktop-diff-list-full-context'); await f.app.waitFor('text:FULL_CONTEXT_END');
  expect(f.app.count('id:desktop-native-diff')).toBe(1); expect(f.reads.length).toBe(4);
  await f.app.press('id:desktop-diff-copy'); await f.app.waitUntil(()=>f.app.clipboard()?.endsWith('FULL_CONTEXT_END'));
  expect(f.app.clipboard()).toBe('OLD_z.ts\\nFULL_CONTEXT_END\\n\\nWORKING_z.ts\\nFULL_CONTEXT_END');
  const count=f.reads.length; await f.app.press('id:desktop-diff-list-full-context'); await f.app.waitFor('text:FULL_CONTEXT_END',{state:'gone'});
  await f.app.press('id:desktop-diff-list-full-context'); await f.app.waitFor('text:FULL_CONTEXT_END'); expect(f.reads.length).toBe(count); expect(f.rejected).toEqual([]);
 });
 test(platform+' delayed patch receipts are rejected after modal, lifecycle, target and exact source retirement',async()=>{
  for(const retire of ['modal','background','target','authority','scope']) {
   const f=await launch(platform); await f.app.waitFor('text:WORKING_z.ts'); await f.app.waitFor('text:WORKING_a.ts');
   f.delay(true); const refreshing=control(f.app,'refresh'); await f.app.waitUntil(f.waiting);
   if(retire==='modal') await control(f.app,'active');
   if(retire==='background') await f.app.setLifecycle('background');
   if(retire==='target') await control(f.app,'target','file-2.ts');
   if(retire==='authority') await control(f.app,'retire');
   if(retire==='scope') await control(f.app,'scope-turn');
   const count=f.reads.length; f.delay(false); f.finish(); await refreshing;
   expect(f.app.texts().some(text=>text.includes('LATE_FORBIDDEN'))).toBe(false);
   if(retire!=='target') expect(f.reads.length).toBe(count);
   expect(f.rejected).toEqual([]);
  }
 });
}
`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'List.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 150_000, maxBuffer: 4 * 1024 * 1024 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 170_000);
