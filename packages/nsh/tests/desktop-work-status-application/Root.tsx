import { host, mount } from 'nsh';
import { YuriNativeApp } from '../../application';

const call = host.call.bind(host);
let hold = host.params.holdWorkStatusChildren === true;
const waiting: (() => void)[] = [];
host.call = async function <T>(name: string, input?: unknown, options?: { timeout?: number }): Promise<T> {
  const value = await call<T>(name, input, options);
  const request = input as { path?: string; method?: string } | undefined;
  if (hold && name === 'runtime.request' && request?.method === 'GET' && request.path?.startsWith('/api/session?') && request.path.includes('&parentID=')) {
    host.post('work.status.application.gate', { phase: 'held' });
    await new Promise<void>(resolve => waiting.push(resolve));
  }
  return value;
};
host.on<{ action: string }>('work.status.application.control', value => {
  if (value.action !== 'release-children') throw new Error('Unknown WorkStatus response gate');
  hold = false; waiting.splice(0).forEach(resolve => resolve());
});
mount(YuriNativeApp);
