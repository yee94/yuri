import { host, mount, Storage } from 'nsh';
import { AlertDialog } from 'nsh/base';
import { YuriNativeApp } from '../../application';

const call = host.call.bind(host);
let hold = host.params.holdMcpStatus === true;
const waiting: (() => void)[] = [];
const show = AlertDialog.show.bind(AlertDialog);
let holdConfirmation = host.params.holdHeaderConfirmation === true;
const confirmations: (() => void)[] = [];
let holdChatWriter = host.params.holdChatWriter === true;
const writers: (() => void)[] = [];
const getItem = Storage.getItem.bind(Storage);
Storage.getItem = async key => {
  if (key.startsWith('nsh:chat-draft:v1:')) host.post('header.application.gate', { phase: 'draft-read', key });
  return getItem(key);
};
AlertDialog.show = async options => {
  const result = await show(options);
  if (holdConfirmation) {
    host.post('header.application.gate', { phase: 'confirmation-held' });
    await new Promise<void>(resolve => confirmations.push(resolve));
  }
  return result;
};
host.call = async function <T>(name: string, input?: unknown, options?: { timeout?: number }): Promise<T> {
  const value = await call<T>(name, input, options);
  const request = input as { path?: string; method?: string } | undefined;
  if (name === 'desktop.writer.acquire' && holdChatWriter) {
    host.post('header.application.gate', { phase: 'writer-held' });
    await new Promise<void>(resolve => writers.push(resolve));
  }
  if (name === 'runtime.request' && request?.method === 'GET' && request.path?.startsWith('/api/mcp?') && hold) {
    host.post('header.application.gate', { phase: 'held' });
    await new Promise<void>(resolve => waiting.push(resolve));
  }
  return value;
};
host.on<{ action: string }>('header.application.control', value => {
  if (value.action === 'release-writer') { holdChatWriter = false; writers.splice(0).forEach(resolve => resolve()); return; }
  if (value.action === 'release-confirmation') { holdConfirmation = false; confirmations.splice(0).forEach(resolve => resolve()); return; }
  if (value.action !== 'release-mcp') throw new Error('Unknown Header response gate');
  hold = false; waiting.splice(0).forEach(resolve => resolve());
});
mount(YuriNativeApp);
