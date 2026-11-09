import { host, mount, Storage } from 'nsh';
import { YuriNativeApp } from '../../application';

// Only the public persistence boundary is gated; all routes, owners and UI are production.
const set = Storage.setItem.bind(Storage);
let hold = false;
const writes: Array<() => void> = [];
Storage.setItem = async (key, value) => {
  if (hold && key.startsWith('nsh:chat-draft:v1:') && JSON.parse(value).context) {
    host.post('git.test.storage', { phase: 'context-write-held', key });
    await new Promise<void>(resolve => writes.push(resolve));
  }
  await set(key, value);
};
host.on<{ action: string }>('git.test.storage.control', event => {
  if (event.action === 'hold') hold = true;
  else if (event.action === 'release') { hold = false; writes.splice(0).forEach(resolve => resolve()); }
  else throw new Error('Unknown synthetic Storage control');
});
mount(YuriNativeApp);
