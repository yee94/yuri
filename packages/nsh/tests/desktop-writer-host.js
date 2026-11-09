/** Synthetic native producer only. No credential discovery, network, disk or production fallback. */
export function createDesktopWriterHost(snapshot, windowID = 'synthetic-writer-window') {
  let sequence = 0;
  const held = new Map(), authorities = new Map(), calls = [];
  const authority = expectedHost => {
    const connection = snapshot().connections.find(row => row.id === expectedHost.hostID);
    if (!connection) throw new Error('Missing synthetic writer authority');
    return JSON.stringify([connection.id, connection.url, connection.authorizationID]);
  };
  const scope = value => {
    const current = snapshot().runtimeScope;
    if (!current || !value || Object.keys(value).sort().join(',') !== 'hostID,lease' || value.hostID !== current.hostID || value.lease !== current.lease) throw new Error('Wrong synthetic writer scope');
    return current;
  };
  const key = (expectedHost, target) => JSON.stringify([expectedHost.hostID, target.kind, target.id]);
  const input = value => {
    scope(value.expectedHost);
    if (typeof value.ownerID !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.ownerID) || !value.target
      || Object.keys(value.target).sort().join(',') !== 'id,kind' || !['session', 'assistant', 'new-session'].includes(value.target.kind)
      || typeof value.target.id !== 'string' || !value.target.id) throw new Error('Wrong synthetic writer target');
  };
  const handlers = {
    'desktop.writer.capabilities': value => {
      if (Object.keys(value ?? {}).length) throw new Error('Nonempty synthetic writer capabilities');
      calls.push({ name: 'capabilities' });
      return { schemaVersion: 1, supported: true, acquire: true, release: true, renew: true, recovery: false, requiresExpectedHost: true, windowID, maxWriters: 64 };
    },
    'desktop.writer.acquire': value => {
      if (Object.keys(value).sort().join(',') !== 'expectedHost,ownerID,target') throw new Error('Wrong synthetic acquire fields');
      input(value); calls.push({ name: 'acquire', value });
      const identity = key(value.expectedHost, value.target), prior = held.get(identity);
      if (prior) {
        if (prior.ownerID !== value.ownerID || prior.expectedHost.lease !== value.expectedHost.lease) throw new Error('writer_conflict');
        return prior;
      }
      if (held.size >= 64) throw new Error('writer_capacity');
      const grant = JSON.parse(JSON.stringify({ ...value, schemaVersion: 1, windowID, grantID: 'synthetic-writer-' + ++sequence }));
      held.set(identity, grant); authorities.set(identity, authority(value.expectedHost)); return grant;
    },
    'desktop.writer.release': value => {
      if (Object.keys(value).sort().join(',') !== 'expectedHost,grantID,ownerID,target') throw new Error('Wrong synthetic release fields');
      input(value); calls.push({ name: 'release', value });
      const identity = key(value.expectedHost, value.target), grant = held.get(identity);
      if (!grant || grant.grantID !== value.grantID || grant.ownerID !== value.ownerID || grant.expectedHost.lease !== value.expectedHost.lease) throw new Error('writer_grant_stale');
      held.delete(identity); authorities.delete(identity); return { released: true, grantID: value.grantID };
    },
    'desktop.writer.renew': value => {
      if (Object.keys(value).sort().join(',') !== 'expectedHost,grantID,ownerID,target') throw new Error('Wrong synthetic renew fields');
      input(value); calls.push({ name: 'renew', value });
      const identity = key(value.expectedHost, value.target), prior = held.get(identity);
      if (!prior || prior.grantID !== value.grantID || prior.ownerID !== value.ownerID || authorities.get(identity) !== authority(value.expectedHost)) throw new Error('writer_grant_stale');
      if (prior.expectedHost.lease === value.expectedHost.lease) return prior;
      const grant = JSON.parse(JSON.stringify({ ...value, schemaVersion: 1, windowID, grantID: 'synthetic-writer-' + ++sequence }));
      held.set(identity, grant); return grant;
    },
  };
  function assertWrite(request, target) {
    scope(request.expectedHost);
    const grant = held.get(key(request.expectedHost, target));
    if (!grant || grant.grantID !== request.writerGrant || grant.expectedHost.lease !== request.expectedHost.lease) throw new Error('writer_grant_required');
  }
  return { handlers, calls, assertWrite, held: () => [...held.values()] };
}
