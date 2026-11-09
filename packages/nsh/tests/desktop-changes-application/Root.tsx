import { host, mount } from 'nsh';
import { YuriNativeApp } from '../../application';

const call = host.call.bind(host);
const pending: Array<() => void> = [];
let hold = host.params.holdChangesCommit === true;

// Gate only the synthetic HTTP acknowledgement, never application navigation.
host.call = async function <T>(name: string, input?: unknown, options?: { timeout?: number }): Promise<T> {
  const result = await call<T>(name, input, options);
  const request = input as { method?: string; path?: string } | undefined;
  if (name === 'runtime.request' && request?.method === 'POST'
    && request.path === '/api/git/commit?directory=%2Ffixture%2Fchosen' && hold) {
    host.post('changes.application.gate', { phase: 'commit-held' });
    await new Promise<void>(resolve => pending.push(resolve));
  }
  return result;
};
host.on<{ action: string }>('changes.application.control', event => {
  if (event.action !== 'release-commit') throw new Error('Unknown synthetic Changes event');
  hold = false;
  pending.splice(0).forEach(resolve => resolve());
});
mount(YuriNativeApp);
