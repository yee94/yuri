import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// This runner controls an already isolated production Electron, never starts one.
const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (plan.confirmIsolated !== true || plan.ready !== true || !['local-route-boundary', 'remote-sidebar'].includes(plan.scope)) throw new Error('Explicit isolated ready plan required');
const output = path.resolve(plan.output);
if (fs.existsSync(output)) throw new Error('Refusing evidence overwrite');
fs.mkdirSync(path.dirname(output), { recursive: true });
const config = JSON.parse(fs.readFileSync(plan.interactiveFile, 'utf8'));
const fixture = 'Targeted selection fixture 0123456789';
const result = { classification: 'diagnostic', scope: plan.scope, startedAt: Date.now(), steps: [], status: 'blocked', limitations: ['DOM node identity is not DraftRecord identity.', 'No remote E2E claim for local-route-boundary.', 'No performance or 64-story acceptance verdict.'] };
const save = () => fs.writeFileSync(output, JSON.stringify(result, null, 2));
const must = (ok, message) => { if (!ok) throw new Error(message); };
const control = async command => {
  const id = randomUUID();
  const startedAt = Date.now();
  fs.writeFileSync(config.controlFile, JSON.stringify({ ...command, id }));
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const lines = fs.existsSync(config.repliesFile) ? fs.readFileSync(config.repliesFile, 'utf8').split('\n') : [];
    const reply = lines.filter(Boolean).map(JSON.parse).find(row => row.id === id);
    if (reply) {
      result.steps.push({ action: command.action, key: command.key, modifiers: command.modifiers, selector: command.selector, startedAt, completedAt: Date.now(), status: reply.status });
      save(); must(reply.status === 'completed', 'Electron control failed; inspect private control replies');
      return reply.value;
    }
    await delay(100);
  }
  throw new Error('Electron control timeout');
};
const evaluate = expression => control({ action: 'evaluate', expression });
const click = selector => control({ action: 'click', selector });
const key = (name, modifiers = []) => control({ action: 'key', key: name, modifiers });
const probe = `(()=>{
  if(window.__targetedSelection)throw new Error('Previous targeted probe still installed');
  if(window.__YURI_SELECTION_DIAGNOSTIC__)throw new Error('Owner diagnostic callback already occupied');
  const ids=new WeakMap();let serial=0;const events=[];const cleanups=[];
  const identity=n=>{if(!n)return null;if(!ids.has(n))ids.set(n,++serial);return ids.get(n);};
  const describe=n=>n?{id:identity(n),tag:n.tagName,connected:n.isConnected,length:typeof n.value==='string'?n.value.length:null,start:n.selectionStart,end:n.selectionEnd,direction:n.selectionDirection}:null;
  const add=(type,extra={})=>{events.push({epochMs:Date.now(),time:performance.now(),type,path:location.pathname,active:describe(document.activeElement),...extra});if(events.length>3000)events.shift();};
  for(const type of ['keydown','keyup','select','selectionchange','focus','blur','focusin','focusout','pointerdown','pointerup','beforeinput','input']){
    const listener=e=>add(type,{trusted:e.isTrusted,target:describe(e.target),key:e.key?.length===1?'character':e.key,shift:e.shiftKey,inputType:e.inputType});
    document.addEventListener(type,listener,true);cleanups.push(()=>document.removeEventListener(type,listener,true));
  }
  for(const [proto,name] of [[HTMLTextAreaElement.prototype,'setSelectionRange'],[HTMLElement.prototype,'focus'],[HTMLElement.prototype,'blur']]){
    const original=proto[name];const wrapped=function(...args){if(this.tagName==='TEXTAREA')add('script-'+name,{target:describe(this),range:name==='setSelectionRange'?args:undefined,stack:new Error().stack});return original.apply(this,args);};
    proto[name]=wrapped;cleanups.push(()=>{if(proto[name]===wrapped)proto[name]=original;});
  }
  const descriptor=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value');
  if(descriptor?.set&&descriptor.configurable){const setter=function(value){add('script-value-set',{target:describe(this),nextLength:typeof value==='string'?value.length:null,stack:new Error().stack});return descriptor.set.call(this,value);};Object.defineProperty(HTMLTextAreaElement.prototype,'value',{...descriptor,set:setter});cleanups.push(()=>{if(Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set===setter)Object.defineProperty(HTMLTextAreaElement.prototype,'value',descriptor);});}
  const range=s=>s?{start:s.start,end:s.end,direction:s.direction}:null;
  const owner=e=>add('owner-selection',{phase:e.phase,target:describe(e.node),storeId:identity(e.store),recordId:identity(e.record),boundRecordId:identity(e.boundRecord),revision:e.record?.revision,ownerKind:e.key?.owner?.kind,saved:range(e.saved),pending:e.pending,sameRecord:e.sameRecord,sameOwner:e.sameOwner,sameText:e.sameText,samePendingRecord:e.samePendingRecord,samePendingText:e.samePendingText,start:e.start,end:e.end,length:e.length});
  window.__YURI_SELECTION_DIAGNOSTIC__=owner;cleanups.push(()=>{if(window.__YURI_SELECTION_DIAGNOSTIC__===owner)delete window.__YURI_SELECTION_DIAGNOSTIC__;});
  const internal=e=>{const d=e.detail??{};add('owner-selection',{phase:d.phase,storeId:d.storeId,recordId:d.recordId,ownerId:d.ownerId,reason:d.reason,start:d.start,end:d.end,length:d.length});};
  window.addEventListener('yuri:selection-diagnostic',internal);cleanups.push(()=>window.removeEventListener('yuri:selection-diagnostic',internal));
  window.__targetedSelection={events,describe,add,remove:()=>{cleanups.reverse().forEach(f=>f());delete window.__targetedSelection;}};
  add('probe-installed');return true;
})()`;
const snapshot = label => evaluate(`(()=>{const p=window.__targetedSelection;const n=document.querySelector('textarea');p.add(${JSON.stringify(label)},{target:p.describe(n)});return {path:location.pathname,node:p.describe(n),focused:document.activeElement===n,fixtureEqual:n?.value===${JSON.stringify(fixture)},empty:n?.value==='',events:p.events.slice()};})()`);
let installed = false;
try {
  must(/^[a-f0-9]{64}$/.test(plan.sourceHash), 'Frozen source hash required');
  result.sourceHash = plan.sourceHash;
  result.artifacts = [];
  for (const artifact of plan.artifacts ?? []) {
    const hash = createHash('sha256').update(fs.readFileSync(artifact.path)).digest('hex');
    result.artifacts.push({ role: artifact.role, sha256: hash });
    must(hash === artifact.sha256, 'Frozen input/artifact hash mismatch');
  }
  must(result.artifacts.some(a => a.role === 'electron-web-index'), 'Actual isolated production web index hash required');
  const localPattern = /^\[data-session-row="[a-zA-Z0-9_-]+"\]$/;
  const remotePattern = /^\[data-remote-session="[a-zA-Z0-9_-]+"\]$/;
  must(localPattern.test(plan.localSelector), 'Local normal sidebar selector required');
  must((plan.scope === 'remote-sidebar' ? remotePattern : localPattern).test(plan.otherSelector) && plan.localSelector !== plan.otherSelector, 'Distinct normal sidebar target required');
  await evaluate(probe); installed = true;
  await click(plan.localSelector); await delay(1000);
  const initial = await snapshot('local-initial'); result.initial = initial;
  must(initial.node && (initial.empty || initial.fixtureEqual), 'Refusing to overwrite a nonfixture draft');
  await click('textarea');
  if (initial.empty) await control({ action: 'type', text: fixture });
  await key('Home');
  for (let i = 0; i < 6; i++) await key('Right');
  for (let i = 0; i < 15; i++) await key('Right', ['shift']);
  result.before = await snapshot('pre-navigation'); save();
   must(result.before.fixtureEqual && result.before.focused && result.before.node.start === 6 && result.before.node.end === 21, 'Real Home/Right/Shift precondition 6–21 failed; not a product navigation failure');
   const keys = result.before.events.filter(event => event.type === 'keydown' && event.target?.id === result.before.node.id && ['Home', 'ArrowRight'].includes(event.key));
   result.trustedKeySequence = keys.length === 22 && keys.every(event => event.trusted) && keys[0].key === 'Home'
     && keys.slice(1, 7).every(event => event.key === 'ArrowRight' && !event.shift)
     && keys.slice(7).every(event => event.key === 'ArrowRight' && event.shift);
   must(result.trustedKeySequence, 'Trusted Home/6Right/15ShiftRight sequence not observed');
  result.preconditionEstablished = true;
  await click(plan.otherSelector); await delay(1000);
  result.other = await snapshot('other-route'); save();
  must(result.other.path !== result.before.path && result.other.node && result.other.empty, 'Other route unavailable or not an empty isolated draft');
  await click(plan.localSelector); await delay(1000);
  result.after = await snapshot('returned-local');
  result.timeline = result.after.events;
  result.ownerRecordObservable = result.timeline.some(e => e.type === 'owner-selection' && e.recordId != null);
  result.routeReturned = result.after.path === result.before.path;
  result.selectionRestored = result.after.node?.start === 6 && result.after.node?.end === 21;
   result.nodeReplaced = result.after.node?.id !== result.before.node.id;
   must(result.nodeReplaced, 'Normal sidebar round trip did not replace the composer node');
   if (plan.expectOwnerRecordObservable === false) must(!result.ownerRecordObservable, 'Unexpected production owner probe remains');
  must(result.routeReturned && result.after.fixtureEqual && result.selectionRestored, 'Real sidebar navigation lost draft/selection');
  result.status = 'observed-targeted-behavior';
} catch (error) {
  result.status = result.preconditionEstablished ? 'failed-or-blocked-after-precondition' : 'blocked-precondition';
  result.error = error.message; process.exitCode = 2;
} finally {
  if (installed) {
    try {
      result.timeline = await evaluate('window.__targetedSelection?.events.slice()');
      await evaluate('window.__targetedSelection?.remove(); true');
      result.probeRemoved = true;
    } catch { result.probeRemoved = false; result.cleanupRequired = 'Terminate only this task Electron to remove the process-local probe'; process.exitCode = 2; }
  }
  result.completedAt = Date.now(); save();
}
console.log(JSON.stringify({ status: result.status, scope: result.scope, error: result.error, output }));
