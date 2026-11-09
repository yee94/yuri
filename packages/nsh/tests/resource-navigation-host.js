export function createHost() {
  let reads = 0, closes = 0, releases = 0, failNext = false;
  const leases = new Set(), closed = new Set(), pending = [];
  const audit = () => ({ synthetic: true, reads, closes, releases, failNext, pending: pending.length });
  return { async call(name, input) {
    if (name === 'resources.present' && typeof input.fixtureAction === 'string') {
      if (input.fixtureAction === 'fail-next') failNext = true;
      else if (input.fixtureAction === 'release') for (const entry of pending.splice(0)) { closed.add(entry.lease); entry.resolve(true); }
      else if (input.fixtureAction !== 'inspect') throw Error('Unknown synthetic retirement control');
      return audit();
    }
    if (name === 'runtime.request') {
      if (input.path.startsWith('/api/fs/stat?')) return { status: 200, body: { isFile: true, size: 21, mtimeMs: 1, isBinary: false } };
      if (input.path.startsWith('/api/fs/list?')) return { status: 200, body: { entries: [{ path: '/fixture/source.ts', isDirectory: false }] } };
      throw Error('Unexpected synthetic resource route');
    }
    if (name === 'resources.read') {
      if (input.expectedHost?.hostID !== 'resource-route-fixture' || input.expectedHost?.lease !== '00000000-0000-4000-8000-000000000001' || input.path !== '/fixture/source.ts') throw Error('Synthetic resource authority rejected');
      const lease = 'route-source-' + (++reads); leases.add(lease);
      return { kind: 'text', lease, size: 21, text: 'source-parent-fixture', stat: { size: 21, mtimeMs: 1, isBinary: false } };
    }
    if (name === 'resources.close') {
      if (!leases.has(input.lease)) throw Error('Unknown synthetic lease');
      closes++;
      if (closed.has(input.lease)) return true;
      if (failNext) { failNext = false; throw Error('Synthetic exact retirement rejected'); }
      return await new Promise(resolve => pending.push({ lease: input.lease, resolve }));
    }
    if (name === 'resources.release') {
      if (!closed.has(input.lease)) throw Error('Original lease released before exact close ACK');
      releases++; return true;
    }
    if (name === 'resources.cancel') return true;
    throw Error('Unexpected synthetic native call: ' + name);
  } };
}
