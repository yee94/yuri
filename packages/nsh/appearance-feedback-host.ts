import { createHost as baseHost } from './appearance-test-host';

export function createHost() {
  const base = baseHost();
  let failed = false;
  return {
    call(name: string, input: { path?: string }) {
      const result = base.call(name, input);
      if (!failed && name === 'runtime.request' && input.path === '/api/config/settings') {
        failed = true;
        return { status: 503, body: { error: 'raw-url-and-settings-sensitive-sentinel' } };
      }
      return result;
    },
  };
}
