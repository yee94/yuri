import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
it('native engine renders real AssistantHome and details without React/DOM; local search issues no HTTP', () => {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(os.tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const fixture = mkdtempSync(path.join(parent, 'nsh-assistants-'));
  const entry = path.join(fixture, 'App.tsx'), host = path.join(fixture, 'host.js');
  writeFileSync(path.join(fixture, 'nsh.json'), JSON.stringify({ capabilities: { host: ['connection.list', 'runtime.*'] } }));
  writeFileSync(entry, `
    import { mount, signal, View, Text } from 'nsh';
    import { createNavStack, NavStack, NavPage } from 'nsh/base';
    import { AssistantHome, AssistantDetails } from ${JSON.stringify(path.join(directory, 'assistants'))};
    import { app, loadConnections } from ${JSON.stringify(path.join(directory, 'state'))};
    import { language } from ${JSON.stringify(path.join(directory, 'i18n'))};
    language.set('en'); app.connection.set({id:'fixture', label:'Fixture', url:'https://host.example', lastUsedAt:1}); app.tab.set(1);
    void loadConnections().then(() => mount(() => { const nav=createNavStack([{kind:'root'}]), opened=signal(''); return <View class="flex-1"><NavStack state={nav} class="flex-1">{route=>route.kind==='root'?<NavPage><AssistantHome onCreate={()=>{}} onEdit={bot=>nav.push({kind:'detail',bot})} onOpenChat={target=>opened.set(target.id)} /><Text testID="opened">{opened()}</Text></NavPage>:<AssistantDetails bot={route.bot} onDone={()=>nav.pop()} />}</NavStack></View>; }));
  `);
  writeFileSync(host, `export function createHost(){
    const bots=[{id:'a',revision:1,name:'Research Bot',defaultPrompt:'Never use personality as preview',providerID:'fixture',modelID:'model',workspacePath:null,effectiveWorkspacePath:'/workspace',pinnedAt:null,unreadCount:2,latestMessagePreview:{text:'Authoritative latest reply',createdAt:Date.now(),fallbackKind:null}},{id:'b',revision:2,name:'Review Bot',pinnedAt:3,unreadCount:0,latestMessagePreview:{text:'Review ready',createdAt:2}}];
    return {call(name,input){if(name==='connection.list')return {selected:'fixture',connections:[{id:'fixture',label:'Fixture',url:'https://host.example',lastUsedAt:1}],runtimeScope:{hostID:'fixture',lease:'synthetic-assistants-mobile'}};if(name!=='runtime.request')return true;const p=input.path;let body;
      if(p==='/api/yuri/assistants/a' && input.method==='DELETE')return {status:500,body:{message:'delete_test_failure'}};
      if(p.endsWith('/capability'))body={supported:true,enabled:true,sharingAvailable:true};
      else if(p.endsWith('/snapshot'))body={enabled:true,revision:3,assistants:bots};
      else if(p.endsWith('/scheduled-tasks'))body={tasks:[],complete:true};
      else if(p.endsWith('/channels/wecom'))body={provider:'wecom',status:'disabled',configured:false,hasSecret:false,error:null,transport:'websocket'};
      else if(p.startsWith('/api/config/catalog/providers'))body={schemaVersion:1,providers:[{id:'fixture',name:'Fixture',models:{model:{id:'model',name:'Model'}}}]};
      else if(p.startsWith('/api/agent?'))body={data:[]};
      else throw new Error('Unexpected request');return {status:200,body};}}
  }`);
  const steps = [
    'await app.waitFor("text:Research Bot");',
    'await app.waitFor("text:Authoritative latest reply");',
    'expect(app.texts().join("\\n")).not.toContain("Never use personality as preview");',
    'await app.press("id:assistant-toggle-search");',
    'const before=app.host.calls().length;',
    'await app.type("id:assistant-search","Research");',
    'expect(app.host.calls().length).toBe(before);',
    'await app.press("id:assistant-open-a");',
    'expect(app.texts().join("\\n")).toContain("a");',
    'await app.drag("id:assistant-open-a",{x:2,y:45});',
    'expect(app.shows("id:assistant-swipe-delete-a")).toBe(false);',
    'await app.drag("id:assistant-open-a",{x:-100,y:2});',
    'await app.waitFor("id:assistant-swipe-delete-a");',
    'app.onDialog(()=>"Cancel");',
    'const beforeCancel=app.host.calls().length;',
    'await app.press("id:assistant-swipe-delete-a");',
    'expect(app.host.calls().length).toBe(beforeCancel);',
    'expect(app.shows("id:assistant-open-a")).toBe(true);',
    'await app.drag("id:assistant-open-a",{x:-100,y:0});',
    'app.onDialog(()=>"Delete");',
    'await app.press("id:assistant-swipe-delete-a");',
    'await app.waitFor("text:HTTP 500: delete_test_failure");',
    'expect(app.shows("id:assistant-open-a")).toBe(true);',
    'await app.drag("id:assistant-open-a",{x:-100,y:0});',
    'await app.press("id:assistant-swipe-edit-a");',
    'await app.waitFor("text:Message channels");',
    'await app.waitFor("text:Generate a random avatar");',
    'await app.press("text:WeCom");',
    'await app.waitFor("text:Message channels are disabled in development builds. Use a release build, or enable channels in the host configuration, then reopen this dialog.");',
    'expect(app.texts().join("\\n")).not.toContain("Bot secret");',
    'expect(app.texts().join("\\n")).not.toMatch(/Unexpected request|runtime_stale/);',
  ].join('\n');
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', entry, '--web-host', host], { cwd: directory, input: steps, encoding: 'utf8', timeout: 60_000 });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 90_000);
