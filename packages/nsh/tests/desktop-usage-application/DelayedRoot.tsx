import { host, mount } from 'nsh';
import { YuriNativeApp } from '../../application';

// Like the existing NavigationRoot's journal gate, delay only the public Host
// response boundary. An unresolved nsh/test Host handler itself blocks its driver.
// No page prop, publisher, operation, route, UI control or business owner is injected.
const call = host.call.bind(host);
let armed = false;
const held: Array<() => void> = [];
host.call = async function <T>(name: string, data?: unknown, options?: { timeout?: number }): Promise<T> {
  const value = await call<T>(name, data, options);
  const request = data as { path?: string; method?: string; expectedHost?: unknown } | undefined;
  if (armed && name === 'runtime.request' && request?.path === '/api/quota/google' && request.method === 'GET') {
    armed = false;
    host.post('usage.application.test', { phase: 'held', path: request.path, expectedHost: request.expectedHost });
    await new Promise<void>(resolve => held.push(resolve));
    host.post('usage.application.test', { phase: 'released', path: request.path, expectedHost: request.expectedHost });
  }
  return value;
};
host.on<{ action: string }>('usage.application.control', event => {
  if (event.action === 'arm') armed = true;
  else if (event.action === 'release') held.splice(0).forEach(resolve => resolve());
  else throw new Error('Unknown Usage native response gate action');
});
mount(YuriNativeApp);
