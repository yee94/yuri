import { host, mount, Storage } from 'nsh';
import { YuriNativeApp } from '../../application';

// The production root is untouched. Faults/gates wrap only the public NSH Storage
// boundary; no test route, controller, callback, button or production Prop is injected.
const key = 'desktop.navigation.v1';
const params = host.params as Record<string, unknown>;
let holdJournalRead = params.holdJournalRead === true;
const journalReads: Array<() => void> = [];
const call = host.call.bind(host);
let holdWriterRenew = params.holdWriterRenew === true;
const renewals: Array<() => void> = [];
let holdNewSessionResolve = params.holdNewSessionResolve === true, holdNewSessionWriter = params.holdNewSessionWriter === true;
const newSessionWaiters: Array<() => void> = [];
host.call = async function <T>(name: string, data?: unknown, options?: { timeout?: number }): Promise<T> {
  const value = await call<T>(name, data, options);
  const input = data as { path?: string; target?: { kind?: string } } | undefined;
  if (name === 'runtime.request' && holdNewSessionResolve && input?.path?.startsWith('/api/fs/list?path=%2Ffixture%2Factual')) {
    host.post('navigation.test.storage', { phase: 'new-session-resolve-held', key: name });
    await new Promise<void>(resolve => newSessionWaiters.push(resolve));
  }
  if (name === 'desktop.writer.acquire' && input?.target?.kind === 'new-session' && holdNewSessionWriter) {
    host.post('navigation.test.storage', { phase: 'new-session-writer-held', key: name });
    await new Promise<void>(resolve => newSessionWaiters.push(resolve));
  }
  if (name === 'desktop.writer.renew' && holdWriterRenew) {
    host.post('navigation.test.storage', { phase: 'writer-renew-held', key: name });
    await new Promise<void>(resolve => renewals.push(resolve));
  }
  if (name === 'desktop.files.journal.snapshot' && holdJournalRead) {
    host.post('navigation.test.storage', { phase: 'journal-read-held', key: name });
    await new Promise<void>(resolve => journalReads.push(resolve));
  }
  return value;
};
const get = Storage.getItem.bind(Storage), set = Storage.setItem.bind(Storage);
let holdRead = params.holdNavigationRead === true, failWrite = false, holdDraftRead = params.holdDraftRead === true;
let holdPanelRead = params.holdPanelMetadataRead === true, failPanelWrite = params.failPanelMetadataWrite === true;
let holdNavigationWrite = params.holdNavigationWrite === true;
const writes: Array<() => void> = [];
const panelReads: Array<() => void> = [];
const draftReads: Array<() => void> = [];
const reads: Array<() => void> = [];
const audit = (phase: string, storageKey: string) => host.post('navigation.test.storage', { phase, key: storageKey });
Storage.getItem = async storageKey => {
  if (params.trackDraftReads === true && storageKey.startsWith('nsh:chat-draft:v1:')) audit('draft-read', storageKey);
  const value = await get(storageKey);
  if (storageKey === key && holdRead) {
    audit('read-held', storageKey);
    await new Promise<void>(resolve => reads.push(resolve));
  }
  if (storageKey === 'desktop.panel-tabs.v1' && holdPanelRead) {
    audit('panel-read-held', storageKey);
    await new Promise<void>(resolve => panelReads.push(resolve));
  }
  if (holdDraftRead && storageKey.startsWith('nsh:chat-draft:v1:')) {
    audit('draft-read-held', storageKey);
    await new Promise<void>(resolve => draftReads.push(resolve));
  }
  return value;
};
Storage.setItem = async (storageKey, value) => {
  if (storageKey === key && holdNavigationWrite) {
    audit('write-held', storageKey);
    await new Promise<void>(resolve => writes.push(resolve));
  }
  if (storageKey === 'desktop.panel-tabs.v1' && failPanelWrite) {
    audit('panel-write-rejected', storageKey);
    throw new Error('Synthetic panel metadata write failure');
  }
  if (storageKey === key && failWrite) {
    audit('write-rejected', storageKey);
    throw Object.assign(new Error('Synthetic navigation Storage failure'), { code: 'ERR_NSH_QUOTA_EXCEEDED' });
  }
  await set(storageKey, value);
  if (storageKey === key) audit('write-confirmed', storageKey);
};
host.on<{ action: string }>('navigation.test.storage.control', event => {
  if (event.action === 'release-read') { holdRead = false; reads.splice(0).forEach(resolve => resolve()); }
  else if (event.action === 'fail-write') failWrite = true;
  else if (event.action === 'recover-write') failWrite = false;
  else if (event.action === 'release-draft-read') { holdDraftRead = false; draftReads.splice(0).forEach(resolve => resolve()); }
  else if (event.action === 'release-panel-read') { holdPanelRead = false; panelReads.splice(0).forEach(resolve => resolve()); }
  else if (event.action === 'recover-panel-write') failPanelWrite = false;
  else if (event.action === 'release-journal-read') { holdJournalRead = false; journalReads.splice(0).forEach(resolve => resolve()); }
  else if (event.action === 'release-write') { holdNavigationWrite = false; writes.splice(0).forEach(resolve => resolve()); }
  else if (event.action === 'release-writer-renew') { holdWriterRenew = false; renewals.splice(0).forEach(resolve => resolve()); }
  else if (event.action === 'release-new-session') { holdNewSessionResolve = false; holdNewSessionWriter = false; newSessionWaiters.splice(0).forEach(resolve => resolve()); }
  else throw new Error('Unknown navigation Storage control');
});
mount(YuriNativeApp);
