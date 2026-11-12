import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const evidence = path.resolve(process.env.REMOTE_PROJECTS_CANDIDATE_EVIDENCE ?? '.scratch/remote-projects/performance/candidate-stable');
const config = JSON.parse(fs.readFileSync(path.join(evidence, 'electron/interactive.json'), 'utf8'));
const remote = JSON.parse(fs.readFileSync(path.join(evidence, 'remote.json'), 'utf8'));
const mode = process.argv[2] ?? 'setup-add';
const strict = process.env.REMOTE_PROJECTS_STRICT_ENTRY === '1';
const result = { mode, strictEntry: strict, startedAt: Date.now(), steps: [] };
const resultFile = path.join(evidence, `electron-${mode}.json`);
if (fs.existsSync(resultFile)) fs.renameSync(resultFile, path.join(evidence, `electron-${mode}-previous-${result.startedAt}-${randomUUID()}.json`));
const save = () => fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
const control = async command => {
  const id = randomUUID();
  fs.writeFileSync(config.controlFile, JSON.stringify({ ...command, id }));
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const replies = fs.existsSync(config.repliesFile) ? fs.readFileSync(config.repliesFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const reply = replies.find(entry => entry.id === id);
    if (reply) {
      result.steps.push(reply); save();
      if (reply.status !== 'completed') throw new Error(reply.error ?? 'Control failed');
      await delay(250); return reply.value;
    }
    await delay(100);
  }
  throw new Error('Real Electron control timeout');
};
const evaluate = expression => control({ action: 'evaluate', expression });
const click = (selector, text) => control({ action: 'click', selector, text });
const must = (value, message) => { if (!value) throw new Error(message); };
const textareaState = () => evaluate(`(()=>{const n=document.querySelector('textarea');return {url:location.href,value:n?.value,start:n?.selectionStart,end:n?.selectionEnd,focused:document.activeElement===n,body:document.body.innerText};})()`);
try {
  must(!strict || ['setup-add', 'open', 'model-diagnostic', 'send', 'send-second', 'isolation', 'isolation-keyboard', 'return'].includes(mode), 'Strict entry forbids inspection, reload and manual synchronization modes');
  if (mode === 'setup-add') {
    must(!strict || process.env.REMOTE_PROJECTS_PREAUTHORIZED === '1', 'Strict entry requires pre-main production authorization');
    if (process.env.REMOTE_PROJECTS_PREAUTHORIZED !== '1') {
    await evaluate(`(async()=>{const base=window.__YURI_API_BASE_URL__;const p=await fetch(base+'/api/client-auth/pairing/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({includeRelay:false,includeDirect:true,allowedClientKinds:['desktop']})});if(!p.ok)throw Error('Pair create '+p.status);const {pairing}=await p.json();const r=await fetch(base+'/api/client-auth/pairing/redeem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pairingId:pairing.id,secret:pairing.secret,clientKind:'desktop',clientLabel:'Isolated stable desktop',dedupeKey:'stable-desktop'})});if(!r.ok)throw Error('Pair redeem '+r.status);const grant=await r.json();const current=await window.__YURI_DESKTOP__.invoke('desktop_hosts_get');await window.__YURI_DESKTOP__.invoke('desktop_hosts_set',{input:{...current,localClientToken:grant.clientToken}});setTimeout(()=>location.reload(),50);return {realPairing:true,reloadBeforeDraft:true};})()`);
    }
    await delay(4000);
    if (!strict) {
      result.initialAdmission = await evaluate(`(async()=>{const r=await fetch(window.__YURI_API_BASE_URL__+'/api/hosts',{headers:{Authorization:'Bearer '+window.__YURI_CLIENT_TOKEN__}});return {status:r.status,credentialPresent:Boolean(window.__YURI_CLIENT_TOKEN__)};})()`);
      must(result.initialAdmission.status === 200, 'Initial desktop authorization admission failed');
    }
    result.localBefore = await textareaState();
    const draft = 'Local preserved draft — same path, different host. Selection must remain local.';
    await click('textarea'); await control({ action: 'type', text: draft });
    result.localDraft = await evaluate(`(()=>{const n=document.querySelector('textarea');n.focus();n.setSelectionRange(6,21);return {url:location.href,value:n.value,start:n.selectionStart,end:n.selectionEnd};})()`);
    fs.writeFileSync(path.join(evidence, 'local-draft-before-remote.json'), JSON.stringify(result.localDraft, null, 2));
    await click('button', '添加项目');
    await click('button', '机器');
    const options = await evaluate(`[...document.querySelectorAll('[role=option]')].filter(n=>n.getBoundingClientRect().height>0).map(n=>n.innerText)`);
    const remoteOption = options.find(text => text.startsWith('Diagnostic Remote'));
    must(remoteOption, 'Remote missing from real machine picker');
    await click('[role=option]', remoteOption);
    await delay(600);
    await evaluate(`(()=>{const n=document.querySelector('input[aria-label="输入路径或从树中选择..."]');if(!n)throw Error('Missing actual remote path input');n.focus();n.select();return {selected:n.value.length};})()`);
    await control({ action: 'type', text: fs.realpathSync(remote.directory) });
    await delay(1000);
    result.remoteDirectory = await control({ action: 'snapshot' });
    await click('[role=dialog] button', '添加项目');
    await delay(3000);
    result.afterAdd = await control({ action: 'snapshot' });
    if (strict) {
      const deadline = Date.now() + 30000;
      const selector = `[data-remote-session="${remote.sessionId}"]`;
      while (!(await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) && Date.now() < deadline) await delay(500);
      result.automaticSessionVisible = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return Boolean(n&&n.getBoundingClientRect().height>0);})()`);
      must(result.automaticSessionVisible, 'Normal add did not automatically expose remote session; no expand/sync/reload allowed');
    }
  } else if (mode === 'inspect') {
    result.snapshot = await control({ action: 'snapshot' });
    result.api = await evaluate(`(async()=>{const base=window.__YURI_API_BASE_URL__,headers={Authorization:'Bearer '+window.__YURI_CLIENT_TOKEN__},out=[];for(const route of ['/api/config/settings/bootstrap','/api/config/settings','/api/hosts/candidate-remote/summaries','/api/hosts/candidate-remote/api/session/active']){const r=await fetch(base+route,{headers});out.push({route,status:r.status,body:await r.json()});}return out;})()`);
  } else if (mode === 'reload-local') {
    await click('textarea');
    const local = JSON.parse(fs.readFileSync(path.join(evidence, 'local-draft-before-remote.json')));
    await click(`[data-session-row="${new URL(local.url).pathname.split('/').at(-1)}"]`);
    await evaluate(`(()=>{setTimeout(()=>location.reload(),50);return {recoveryReloadFromLocal:true};})()`);
    await delay(5000); result.reloaded = await control({ action: 'snapshot' });
  } else if (mode === 'refresh-menu') {
    await evaluate(`(()=>{const n=document.querySelector('[data-sidebar-project-header^="remote-"] button[aria-label="项目菜单"]');if(!n)throw Error('Remote project menu missing');n.focus();return {focused:document.activeElement===n};})()`);
    await control({ action: 'key', key: 'Return' });
    if (!(await evaluate(`Boolean(document.querySelector('[role=menuitem]'))`))) await click('[data-sidebar-project-header^="remote-"] button[aria-label="项目菜单"]');
    result.menu = await control({ action: 'snapshot' });
  } else if (mode === 'refresh') {
    await click('[role=menuitem]', '同步会话');
    await delay(2000);
    result.refreshed = await control({ action: 'snapshot' });
  } else if (mode === 'open') {
    const selector = `[data-remote-session="${remote.sessionId}"]`;
    if (!strict && await evaluate(`(()=>{const n=document.querySelector('[data-remote-project]');return !n||n.hidden;})()`)) {
      await click('[data-sidebar-project-header^="remote-"] > button:first-child');
    }
    const deadline = Date.now() + 30000;
    while (!(await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) && Date.now() < deadline) await delay(1000);
    await click(selector);
    await delay(1500);
    result.opened = await control({ action: 'snapshot' });
    must(result.opened.url.includes(remote.sessionId), 'Normal sidebar click did not open remote session');
    must(result.opened.body.includes('Diagnostic Remote'), 'Remote machine label missing');
    must(result.opened.body.includes('Performance baseline session') && !result.opened.body.includes('Remote session status unavailable'), 'Remote title/status error');
    if (!strict) result.api = await evaluate(`(async()=>{const base=window.__YURI_API_BASE_URL__,headers={Authorization:'Bearer '+window.__YURI_CLIENT_TOKEN__};const out=[];for(const route of ['/api/hosts/candidate-remote/summaries','/api/hosts/candidate-remote/api/session/active']){const r=await fetch(base+route,{headers});out.push({route,status:r.status,body:await r.json()});}return out;})()`);
  } else if (mode === 'model') {
    await click('.model-controls__model-trigger');
    await click('input[placeholder="搜索模型"]');
    await control({ action: 'type', text: 'gpt-4.1' });
    await delay(700);
    result.options = await evaluate(`[...document.querySelectorAll('[role=option]')].filter(n=>n.getBoundingClientRect().height>0).map(n=>({text:n.innerText,position:n.getAttribute('aria-posinset')}))`);
    const option = result.options.find(row => /^(GPT-4.1|Diagnostic Loopback Only)\n/.test(row.text));
    must(option, 'Exact fixture gpt-4.1 option missing; do not pick a different provider');
    await click(`[role=option][aria-posinset="${option.position}"]`, option.text);
    result.selected = await control({ action: 'snapshot' });
  } else if (mode === 'model-diagnostic') {
    if (!(await evaluate(`Boolean(document.querySelector('input[placeholder="搜索模型"]'))`))) await click('.model-controls__model-trigger');
    await evaluate(`(()=>{const n=document.querySelector('input[placeholder="搜索模型"]');if(!n)throw Error('Model search missing');n.focus();n.select();return {selected:n.value.length};})()`);
    await control({ action: 'type', text: 'Diagnostic' });
    await delay(2000);
    result.options = await evaluate(`[...document.querySelectorAll('[role=option]')].filter(n=>n.getBoundingClientRect().height>0&&n.innerText).map(n=>({text:n.innerText,position:n.getAttribute('aria-posinset'),html:n.outerHTML.slice(0,1600)}))`);
    const option = result.options.find(row => row.text.startsWith('Diagnostic Loopback Only'));
    must(option, 'Exact configured fixture model name missing');
    await click(`[role=option][aria-posinset="${option.position}"]`, option.text);
    result.selected = await control({ action: 'snapshot' });
  } else if (mode === 'send' || mode === 'send-second') {
    must(await evaluate(`document.querySelector('.model-controls__model-trigger')?.innerText.includes('Diagnostic Loopback Only')`), 'Fixture model must be visibly selected before sending');
    const prompt = `${mode === 'send-second' ? 'Second ' : ''}Diagnostic stable remote stream check. Reply with the controlled fixture text only.`;
    await click('textarea'); await control({ action: 'type', text: prompt });
    result.beforeSend = await textareaState();
    if (strict) result.viewportBefore = await evaluate(`(()=>{const n=document.querySelector('[data-scrollbar="chat"]');if(!n)throw Error('Actual ChatViewport scroll surface missing');const phrase='Remote fixture streamed reply.';const count=()=>n.innerText.split(phrase).length-1;const before=count();const observation={before,armedAt:Date.now(),sendAt:null,firstNewReplyAt:null};window.__remoteStrictReply=observation;const observer=new MutationObserver(()=>{if(observation.sendAt!==null&&count()>before&&observation.firstNewReplyAt===null)observation.firstNewReplyAt=Date.now();});observer.observe(n,{subtree:true,childList:true,characterData:true});window.__remoteStrictReplyStop=()=>observer.disconnect();return {before};})()`);
    if (strict) await evaluate(`(()=>{const onKey=e=>{if(e.key==='Enter'&&e.metaKey){window.__remoteStrictReply.sendAt=Date.now();document.removeEventListener('keydown',onKey,true);}};document.addEventListener('keydown',onKey,true);return {sendKeyObserverArmed:true};})()`);
    await control({ action: 'key', key: 'Return', modifiers: ['meta'] });
    await delay(5000);
    result.afterSend = await control({ action: 'snapshot' });
    if (strict) {
      result.viewportReply = await evaluate(`(()=>{window.__remoteStrictReplyStop?.();return window.__remoteStrictReply;})()`);
      must(Number.isFinite(result.viewportReply?.firstNewReplyAt) && Number.isFinite(result.viewportReply?.sendAt) && result.viewportReply.firstNewReplyAt - result.viewportReply.sendAt <= 5000, 'No new ChatViewport reply within 5 seconds of actual send key');
    }
    result.provider = fs.existsSync(path.join(evidence, 'remote-provider-metrics.json')) ? JSON.parse(fs.readFileSync(path.join(evidence, 'remote-provider-metrics.json'))) : null;
    must(result.provider?.streaming > 0 && result.provider.models.includes('gpt-4.1'), 'Loopback fixture has not received a streaming gpt-4.1 request');
    result.replyCountBefore = result.beforeSend.body.split('Remote fixture streamed reply.').length - 1;
    result.replyCountAfter = result.afterSend.body.split('Remote fixture streamed reply.').length - 1;
    must(result.replyCountAfter > result.replyCountBefore, 'No new real OpenCode fixture reply in UI');
  } else if (mode === 'isolation' || mode === 'isolation-keyboard') {
    const local = JSON.parse(fs.readFileSync(path.join(evidence, 'local-draft-before-remote.json')));
    const localId = new URL(local.url).pathname.split('/').at(-1);
    await click(`[data-session-row="${localId}"]`); await delay(1000);
    if (mode === 'isolation-keyboard') {
      await click('textarea');
      await control({ action: 'key', key: 'Home' });
      for (let index = 0; index < 6; index++) await control({ action: 'key', key: 'Right' });
      for (let index = 0; index < 15; index++) await control({ action: 'key', key: 'Right', modifiers: ['shift'] });
      result.before = await textareaState();
      must(result.before.start === 6 && result.before.end === 21, 'Real keyboard selection did not establish exact range 6–21');
    } else result.before = await evaluate(`(()=>{const n=document.querySelector('textarea');n.focus();n.setSelectionRange(6,21);return {value:n.value,start:n.selectionStart,end:n.selectionEnd,url:location.href};})()`);
    await click(`[data-remote-session="${remote.sessionId}"]`); await delay(1000); result.remote = await textareaState();
    await click(`[data-session-row="${localId}"]`); await delay(1000); result.after = await textareaState();
    result.draftEqual = result.before.value === result.after.value;
    result.selectionEqual = result.before.start === result.after.start && result.before.end === result.after.end;
    result.noLocalDraftInRemote = result.remote.value !== result.before.value;
    must(result.draftEqual && result.selectionEqual && result.noLocalDraftInRemote, 'Direct sidebar-only draft/selection isolation assertion failed');
  } else if (mode === 'return') {
    const local = JSON.parse(fs.readFileSync(path.join(evidence, 'local-draft-before-remote.json')));
    const localId = new URL(local.url).pathname.split('/').at(-1);
    await click(`[data-session-row="${localId}"]`);
    await delay(1000); result.local = await textareaState();
    result.draftEqual = result.local.value === local.value;
    result.selectionEqual = result.local.start === local.start && result.local.end === local.end;
    await click(`[data-remote-session="${remote.sessionId}"]`);
    await delay(1000); result.remote = await textareaState();
    result.noLocalDraftInRemote = result.remote.value !== local.value;
    must(result.draftEqual && result.selectionEqual && result.noLocalDraftInRemote, 'Draft/selection/session isolation assertion failed');
  } else throw new Error('Unknown smoke mode');
  await control({ action: 'screenshot', name: `stable-${mode}` });
  result.status = 'completed';
} catch (error) { result.status = 'failed'; result.error = error.message; process.exitCode = 2; }
result.completedAt = Date.now(); save();
console.log(JSON.stringify({ mode, status: result.status, error: result.error }));
