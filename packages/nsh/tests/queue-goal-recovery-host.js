import { createHost as createBase } from './goal-tasks-chat-host.js';
import { requireInteractionScope } from './chat-interaction-fixture-scope.js';

/** Isolated production-App recovery fixture. No network, model or filesystem operations. */
export function createHost() {
  const base = createBase(), scope = base.call('connection.list').runtimeScope;
  const session = '/api/session/ses_1', query = '?directory=%2Fworkspace%2Fproject';
  const file = { uri: 'attachment://queued-fixture', name: 'queued.txt', mime: 'text/plain' };
  const wireFile = { uri: file.uri, name: file.name };
  let items = [
    { id: 'q-recover', sessionID: 'ses_1', type: 'user', delivery: 'queue', payload: { text: 'Recover queued input', files: [file] } },
    { id: 'q-remove', sessionID: 'ses_1', type: 'user', delivery: 'queue', payload: { text: 'Remove queued input' } },
    { id: 'q-steer', sessionID: 'ses_1', type: 'user', delivery: 'queue', payload: { text: 'Steer queued input' } },
  ];
  let deletes = 0, removals = 0, steers = 0, prompts = 0;
  const ok = body => ({ status: 200, body });
  const receipt = () => `QUEUE_RECOVERY delete=${deletes} remove=${removals} steer=${steers} prompt=${prompts}`;
  return { call(name, input = {}) {
    if (name !== 'runtime.request') return base.call(name, input);
    requireInteractionScope(input, scope);
    const { path, method = 'GET', body } = input;
    if (path === `${session}/inbox${query}` && method === 'GET') return ok({ data: items.map(item => ({ ...item })) });
    if (path === `${session}/message/q-recover${query}` && method === 'GET') return { status: 404, body: {} };
    if (path === `${session}/inbox/q-recover${query}` && method === 'DELETE') {
      deletes++;
      if (!items.some(item => item.id === 'q-recover')) return { status: 404, body: { message: 'Already removed' } };
      items = items.filter(item => item.id !== 'q-recover');
      return { status: 503, body: { message: 'Synthetic lost cancellation acknowledgement' } };
    }
    if (path === `${session}/inbox/q-remove${query}` && method === 'DELETE') {
      removals++;
      if (removals === 1) return { status: 503, body: { message: 'Synthetic cancellation unavailable' } };
      items = items.filter(item => item.id !== 'q-remove'); return { status: 204, body: null };
    }
    if (path === `${session}/inbox/q-steer${query}` && method === 'PATCH') {
      if (JSON.stringify(body) !== JSON.stringify({ delivery: 'steer' })) throw new Error('Unexpected steer payload');
      steers++; items = items.map(item => item.id === 'q-steer' ? { ...item, delivery: 'steer' } : item);
      return { status: 204, body: null };
    }
    if (path === `${session}/prompt${query}` && method === 'POST') {
      if (items.some(item => item.id === 'q-recover') || body?.text !== 'Recover queued input' || body.delivery !== 'queue'
        || typeof body.id !== 'string' || JSON.stringify(body.files) !== JSON.stringify([wireFile])
        || Object.keys(body).sort().join(',') !== 'delivery,files,id,text') throw new Error('Unsafe queue recovery dispatch');
      if (items.some(item => item.id === body.id)) throw new Error('Duplicate queue recovery admission');
      prompts++;
      const item = { id: body.id, sessionID: 'ses_1', type: 'user', delivery: 'queue', payload: { text: body.text, files: body.files } };
      items = [...items, item]; return ok(item);
    }
    const response = base.call(name, input);
    if (method === 'GET' && path.startsWith('/api/git/status?')) return { ...response, body: { ...response.body, current: `${response.body.current} ${receipt()}` } };
    return response;
  } };
}
