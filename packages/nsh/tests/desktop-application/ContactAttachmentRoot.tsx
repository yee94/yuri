import { host, mount } from 'nsh';
import { YuriNativeApp } from '../../application';

// Delay only the delivery of a successful public synthetic native receipt.
const call = host.call.bind(host), waiters: Array<() => void> = [];
let holdStatus = false;
host.call = async function<T>(name: string, data?: unknown, options?: { timeout?: number }): Promise<T> {
  const receipt = await call<T>(name, data, options);
  if (name === 'desktop.files.download.status' && holdStatus) {
    host.post('contact-attachment.test.audit', { phase: 'status-held' });
    await new Promise<void>(resolve => waiters.push(resolve));
    host.post('contact-attachment.test.audit', { phase: 'status-delivered' });
  }
  return receipt;
};
host.on<{ action: string }>('contact-attachment.test.control', event => {
  if (event.action === 'hold-status') holdStatus = true;
  else if (event.action === 'release-status') { holdStatus = false; waiters.splice(0).forEach(resolve => resolve()); }
  else throw new Error('Unknown synthetic attachment control');
});
mount(YuriNativeApp);
