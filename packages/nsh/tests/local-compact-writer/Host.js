import { createCommandsHost, identity, draftKey, draftRecord, attachment } from '../desktop-commands-application/Host.js';
export { identity, draftKey, draftRecord, attachment };

export function createCompactHost() {
  const fixture = createCommandsHost(), compacts = [];
  const original = fixture.handlers['runtime.request']; let mode = 'ack', verified = false;
  fixture.handlers['runtime.request'] = input => {
    const compactPath = '/api/session/' + identity.sessionID + '/compact?directory=' + encodeURIComponent(identity.directory);
    if (input.path === compactPath && input.method === 'POST') {
      fixture.writer.assertWrite(input, { kind: 'session', id: identity.sessionID });
      const body = input.body;
      if (!body || typeof body.id !== 'string' || !body.id || body.delivery !== 'steer' || Object.keys(body).some(key => !['id', 'delivery'].includes(key)) || input.expectedHost?.hostID !== identity.hostID || input.expectedHost?.lease !== identity.lease) throw new Error('Invalid compact wire');
      compacts.push(input);
      if (mode === 'lost') throw new Error('Synthetic lost compact ACK');
      return { status: 200, body: { data: { id: mode === 'coalesced' ? 'other-compaction' : body.id, sessionID: identity.sessionID, type: 'compaction', delivery: 'steer' } } };
    }
    const id = compacts.at(-1)?.body.id;
    if (id && input.path.startsWith('/api/session/' + identity.sessionID + '/message/' + id + '?')) return verified
      ? { status: 200, body: { id, sessionID: identity.sessionID, type: 'compaction', status: 'completed' } }
      : { status: 404, body: { error: 'No exact compact checkpoint yet' } };
    return original(input);
  };
  return { ...fixture, compacts, loseAck() { mode = 'lost'; }, coalesce() { mode = 'coalesced'; }, verify() { verified = true; } };
}
