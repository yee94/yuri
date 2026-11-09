import { host, mount } from 'nsh';
import { YuriNativeApp } from '../../application';

// Delay the public bridge dispatch, not its serial synthetic Host handler.
// Product components, routes and writer objects are never injected or replaced.
const call = host.call.bind(host);
let held = (host.params as Record<string, unknown>).holdAssistantRelease === true;
const waiters: Array<() => void> = [];
host.call = async function <T>(name: string, data?: unknown, options?: { timeout?: number }): Promise<T> {
  const input = data as { target?: { kind?: string } } | undefined;
  if (held && name === 'desktop.writer.release' && input?.target?.kind === 'assistant') {
    host.post('assistant.test.release', {});
    await new Promise<void>(resolve => waiters.push(resolve));
  }
  return await call<T>(name, data, options);
};
host.on('assistant.test.release.control', () => { held = false; waiters.splice(0).forEach(resolve => resolve()); });
mount(YuriNativeApp);
