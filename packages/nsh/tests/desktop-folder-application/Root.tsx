import { host, mount, Storage } from 'nsh';
import { YuriNativeApp } from '../../application';

// Observe the public durable boundary only; no production routes/actions are injected.
const set = Storage.setItem.bind(Storage);
Storage.setItem = async (key, value) => {
  await set(key, value);
  if (key.startsWith('nsh:new-session:v1:')) {
    const receipt = JSON.parse(value);
    host.post('folder.test.persisted', { key, phase: receipt.phase, folder: receipt.folder ?? null, inputID: receipt.inputID ?? null });
  }
};
mount(YuriNativeApp);
