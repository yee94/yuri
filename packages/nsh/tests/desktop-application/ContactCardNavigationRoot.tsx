import { host, mount, Storage } from 'nsh';
import { YuriNativeApp } from '../../application';

// Synthetic fault/observation boundary only: no product controller or route is replaced.
const params = host.params as Record<string, unknown>;
const call = host.call.bind(host), get = Storage.getItem.bind(Storage), set = Storage.setItem.bind(Storage);
const audit = (phase: string, key = '') => host.post('contact-card-navigation.test.audit', { phase, key });
let holdRelease = params.holdRelease === true, holdSend = params.holdSend === true, holdBetaRead = params.holdBetaRead === true, holdCatalog = false;
const releases: Array<() => void> = [], sends: Array<() => void> = [], catalogs: Array<() => void> = [], betaReads: Array<() => void> = [];
host.call = async function <T>(name: string, data?: unknown, options?: { timeout?: number }): Promise<T> {
  const value = await call<T>(name, data, options);
  const input = data as { path?: string; target?: { kind?: string }; expectedHost?: { hostID?: string } } | undefined;
  if (holdRelease && name === 'desktop.writer.release' && input?.target?.kind === 'assistant') {
    audit('release-ack-held');
    await new Promise<void>(resolve => releases.push(resolve));
    audit('release-ack-delivered');
  }
  if (holdSend && name === 'runtime.request' && input?.path === '/api/yuri/assistants/alpha/messages') {
    audit('send-ack-held');
    await new Promise<void>(resolve => sends.push(resolve));
  }
  if (holdCatalog && name === 'runtime.request' && input?.path === '/api/yuri/assistants/snapshot' && input.expectedHost?.hostID === 'desktop-fixture') {
    audit('catalog-ack-held');
    await new Promise<void>(resolve => catalogs.push(resolve));
    audit('catalog-ack-delivered');
  }
  if (holdBetaRead && name === 'runtime.request' && input?.path === '/api/yuri/assistants/beta/contact/messages?limit=30') {
    audit('beta-read-ack-held');
    await new Promise<void>(resolve => betaReads.push(resolve));
    audit('beta-read-ack-delivered');
  }
  return value;
};
Storage.getItem = async key => {
  if (key.startsWith('nsh:chat-draft:v1:')) audit('draft-read', key);
  return await get(key);
};
Storage.setItem = async (key, value) => {
  await set(key, value);
  if (key.startsWith('nsh:chat-draft:v1:')) audit('draft-written', key);
};
host.on<{ action: string }>('contact-card-navigation.test.control', event => {
  if (event.action === 'release-ack') { holdRelease = false; releases.splice(0).forEach(resolve => resolve()); }
  else if (event.action === 'send-ack') { holdSend = false; sends.splice(0).forEach(resolve => resolve()); }
  else if (event.action === 'hold-catalog') holdCatalog = true;
  else if (event.action === 'catalog-ack') { holdCatalog = false; catalogs.splice(0).forEach(resolve => resolve()); }
  else if (event.action === 'beta-read-ack') { holdBetaRead = false; betaReads.splice(0).forEach(resolve => resolve()); }
  else throw new Error('Unknown synthetic contact-card control');
});
mount(YuriNativeApp);
