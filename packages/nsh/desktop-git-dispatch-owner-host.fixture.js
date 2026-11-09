import { createHost as createBaseHost } from './desktop-new-session-host.fixture.js';

export function createHost() {
  const base = createBaseHost();
  let lease = 0, origin = 'https://host.example', authorizationID = 'owner-initial-auth';
  return { call(name, input) {
    if (name === 'connection.list') {
      const saved = base.call(name, input);
      return { ...saved, connections: saved.connections.map(connection => ({ ...connection, url: origin, authorizationID })), runtimeScope: { hostID: saved.selected, lease: `owner-synthetic-lease-${lease}` } };
    }
    if (name === 'runtime.request' && input.path.startsWith('/__fixture/owner/')) {
      if (input.method !== 'GET') throw new Error('Synthetic owner controls are GET only');
      const action = input.path.slice('/__fixture/owner/'.length);
      if (action === 'authorization') authorizationID = 'owner-other-auth';
      else if (action === 'origin') origin = 'https://other.example';
      else if (action === 'restore') { origin = 'https://host.example'; authorizationID = 'owner-initial-auth'; }
      else if (action !== 'lease') throw new Error('Unknown synthetic owner control');
      lease++; return { status: 200, body: {} };
    }
    return base.call(name, input);
  } };
}
