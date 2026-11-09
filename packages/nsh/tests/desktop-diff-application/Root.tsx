import { host, mount, Storage } from 'nsh';
import { YuriNativeApp } from '../../application';

const key = 'desktop.diff-preferences.v1';
const get = Storage.getItem.bind(Storage), set = Storage.setItem.bind(Storage);
let loseAck = false, unknown = false;
Storage.getItem = async name => {
  if (name === key) host.post('diff.application.storage', { operation: 'get' });
  return name === key && unknown ? null : get(name);
};
Storage.setItem = async (name, value) => {
  if (name === key) host.post('diff.application.storage', { operation: 'set' });
  await set(name, value);
  if (name === key && loseAck) { loseAck = false; unknown = true; throw new Error('Synthetic preference ACK lost'); }
};
host.on<{ action: string }>('diff.application.control', value => {
  if (value.action === 'lose-ack') loseAck = true;
  else if (value.action === 'reconcile') unknown = false;
  else throw new Error('Unknown synthetic preference gate');
});
mount(YuriNativeApp);
