import { createHost as createBase } from './host.js';

/** Queue controls use the production App and state, with isolated server authority. */
export function createHost() {
  const base = createBase();
  let items = [
    { id: 'q-steer', sessionID: 'ses_1', type: 'user', delivery: 'queue', payload: { text: 'Neutral steering input' } },
    { id: 'q-remove', sessionID: 'ses_1', type: 'user', delivery: 'queue', payload: { text: 'Neutral removable input' } },
    { id: 'q-edit', sessionID: 'ses_1', type: 'user', delivery: 'queue', payload: { text: 'Neutral editable input', files: [{ uri: 'file:///fixture/queued.txt', name: 'queued.txt', mime: 'text/plain' }] } },
  ];
  const failures = new Set();
  return { call(name, input) {
    if (name !== 'runtime.request') return base.call(name, input);
    const pathname = input.path.split('?')[0];
    const match = /^\/api\/session\/ses_1\/inbox\/([^/]+)$/.exec(pathname);
    if (pathname === '/api/session/ses_1/inbox') return { status: 200, body: { data: items } };
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (!items.some(item => item.id === id)) return { status: 404, body: {} };
      if (input.method === 'PATCH' && input.body.delivery === 'steer') {
        items = items.map(item => item.id === id ? { ...item, delivery: 'steer' } : item);
        return { status: 204, body: null };
      }
      if (input.method === 'DELETE') {
        if (id !== 'q-steer' && !failures.has(id)) {
          failures.add(id);
          return { status: 503, body: { message: 'Neutral queue retry required' } };
        }
        items = items.filter(item => item.id !== id);
        return { status: 204, body: null };
      }
      throw new Error('Unexpected queue wire');
    }
    if (/\/message\/q-/.test(pathname)) return { status: 404, body: {} };
    if (pathname.endsWith('/prompt')) {
      if (items.some(item => item.id === 'q-edit') || input.body.text !== 'Neutral editable input' || input.body.files?.[0]?.uri !== 'file:///fixture/queued.txt') throw new Error('Unsafe queue resend or attachment loss');
    }
    return base.call(name, input);
  } };
}
