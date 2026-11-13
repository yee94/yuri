import { describe, expect, it, vi } from 'vitest';
import { HostContentDemand } from './content-demand';
import { HostRuntimeRegistry, type HostRuntimeDependencies } from './registry';

const location = { hubId: 'hub-a', hostId: 'host-a', directory: '/project' };
const harness = () => {
  let serial = 0;
  const fetch = vi.fn<HostRuntimeDependencies['fetch']>(async (path, init) => {
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    const id = `lease-${++serial}`;
    const body = JSON.parse(String(init?.body)) as { sessionId: string };
    const hostId = path.split('/')[3];
    queueMicrotask(() => demand.contentReady(hostId, id, body.sessionId));
    return Response.json({ id });
  });
  const registry = new HostRuntimeRegistry('hub-a', {
    transportIdentity: 'transport-a', isCurrent: () => true, fetch,
    sdk: () => { throw new Error('not demanded'); }, service: () => { throw new Error('not demanded'); },
  });
  const demand = new HostContentDemand(registry);
  return { fetch, demand };
};

describe('client Remote Host content demand', () => {
  it('retries a new worktree 404 only when matching topology arrives, retaining raw cwd and existing leases', async () => {
    const { fetch, demand } = harness();
    fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const observer = { refresh: vi.fn(), error: vi.fn() };
    const release = demand.retain({ ...location, directory: '/external checkout' }, 'session', observer);
    await vi.waitFor(() => expect(observer.error).toHaveBeenCalledTimes(1));
    const stable = { refresh: vi.fn(), error: vi.fn() };
    const releaseStable = demand.retain(location, 'stable-session', stable);
    await vi.waitFor(() => expect(stable.refresh).toHaveBeenCalledTimes(1));
    const unrelated = { projectDirectories: { '/project': ['/project', '/other'] }, staleProjectDirectories: [] };
    demand.topologyAvailable('host-b', { projectDirectories: { '/project': ['/external checkout'] }, staleProjectDirectories: [] });
    demand.topologyAvailable(location.hostId, unrelated);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(2);
    const topology = { projectDirectories: { '/project': ['/project', '/external checkout'] }, staleProjectDirectories: [] };
    demand.topologyAvailable(location.hostId, topology);
    await vi.waitFor(() => expect(observer.refresh).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetch.mock.calls[2][1]?.body))).toEqual({ directory: '/external checkout', sessionId: 'session' });
    demand.topologyAvailable(location.hostId, topology);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(stable.refresh).toHaveBeenCalledTimes(1);
    release(); releaseStable(); demand.dispose();
  });

  it('retries after a topology update races an in-flight 404 but not forever for the same rejected mapping', async () => {
    const { fetch, demand } = harness();
    let finish!: (response: Response) => void;
    fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const observer = { refresh: vi.fn(), error: vi.fn() };
    const release = demand.retain({ ...location, directory: '/external checkout' }, 'session', observer);
    const topology = { projectDirectories: { '/project': ['/project', '/external checkout'] }, staleProjectDirectories: [] };
    demand.topologyAvailable(location.hostId, topology);
    finish(new Response(null, { status: 404 }));
    await vi.waitFor(() => expect(observer.error).toHaveBeenCalledTimes(2));
    expect(fetch).toHaveBeenCalledTimes(2);
    for (let update = 0; update < 50; update++) demand.topologyAvailable(location.hostId, topology);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(2);
    release(); demand.dispose();
    demand.topologyAvailable(location.hostId, topology);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('waits for content-ready and refreshes again when the same lease reconnects', async () => {
    const { fetch, demand } = harness();
    fetch.mockResolvedValueOnce(Response.json({ id: 'not-ready' }));
    const observer = { refresh: vi.fn(), error: vi.fn() };
    const release = demand.retain(location, 'session', observer);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(observer.refresh).not.toHaveBeenCalled();
    demand.contentReady('different-host', 'not-ready', 'session');
    expect(observer.refresh).not.toHaveBeenCalled();
    demand.contentReady(location.hostId, 'not-ready', 'session');
    await vi.waitFor(() => expect(observer.refresh).toHaveBeenCalledTimes(1));
    demand.contentReady(location.hostId, 'not-ready', 'session');
    await vi.waitFor(() => expect(observer.refresh).toHaveBeenCalledTimes(2));
    release();
  });
  it('shares one acquisition for multiple consumers and releases only the last observer', async () => {
    const { fetch, demand } = harness();
    const a = { refresh: vi.fn(), error: vi.fn() };
    const b = { refresh: vi.fn(), error: vi.fn() };
    const releaseA = demand.retain(location, 'same-session', a);
    const releaseB = demand.retain(location, 'same-session', b);
    await vi.waitFor(() => expect(a.refresh).toHaveBeenCalledTimes(1));
    expect(b.refresh).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual(['/api/hosts/host-a/subscriptions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: '/project', sessionId: 'same-session' }),
    }]);
    releaseA();
    expect(fetch).toHaveBeenCalledTimes(1);
    releaseB(); releaseB();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls[1][0]).toBe('/api/hosts/host-a/subscriptions/lease-1');
    demand.dispose();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('deduplicates HTTP/event ready snapshots but refreshes each reconnect generation', async () => {
    const { fetch, demand } = harness();
    fetch.mockResolvedValueOnce(Response.json({ id: 'shared', channelId: 'channel', readyGeneration: 'connection-1' }));
    const a = { refresh: vi.fn(), error: vi.fn() };
    const releaseA = demand.retain(location, 'session', a);
    await vi.waitFor(() => expect(a.refresh).toHaveBeenCalledTimes(1));
    demand.contentReady(location.hostId, 'shared', 'session', 'channel', 'connection-1');
    const b = { refresh: vi.fn(), error: vi.fn() };
    const releaseB = demand.retain(location, 'session', b);
    await vi.waitFor(() => expect(b.refresh).toHaveBeenCalledTimes(1));
    expect(a.refresh).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    demand.contentReady(location.hostId, 'shared', 'session', 'wrong-channel', 'connection-2');
    demand.contentReady(location.hostId, 'shared', 'session', 'channel', 'connection-2');
    await vi.waitFor(() => expect(a.refresh).toHaveBeenCalledTimes(2));
    expect(b.refresh).toHaveBeenCalledTimes(2);
    demand.contentReady(location.hostId, 'shared', 'session', 'channel', 'connection-1');
    demand.contentReady(location.hostId, 'shared', 'session', 'channel', 'connection-2');
    await Promise.resolve();
    expect(a.refresh).toHaveBeenCalledTimes(2);
    releaseA(); releaseB();
  });

  it('keeps a trailing refresh when reconnect readiness arrives during an authority read', async () => {
    const { fetch, demand } = harness();
    fetch.mockResolvedValueOnce(Response.json({ id: 'shared', channelId: 'channel' }));
    let finish!: () => void;
    const observer = { refresh: vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; })), error: vi.fn() };
    const release = demand.retain(location, 'session', observer);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await Promise.resolve(); await Promise.resolve();
    demand.contentReady(location.hostId, 'shared', 'session', 'channel', 'connection-1');
    await vi.waitFor(() => expect(observer.refresh).toHaveBeenCalledTimes(1));
    demand.contentReady(location.hostId, 'shared', 'session', 'channel', 'connection-2');
    demand.contentReady(location.hostId, 'shared', 'session', 'channel', 'connection-2');
    finish();
    await vi.waitFor(() => expect(observer.refresh).toHaveBeenCalledTimes(2));
    release();
  });

  it('separates identical session ids on different machines', async () => {
    const { fetch, demand } = harness();
    const observer = { refresh: vi.fn(), error: vi.fn() };
    const releaseA = demand.retain(location, 'same-session', observer);
    const releaseB = demand.retain({ ...location, hostId: 'host-b' }, 'same-session', observer);
    await vi.waitFor(() => expect(observer.refresh).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/hosts/host-a/subscriptions', '/api/hosts/host-b/subscriptions']);
    releaseA(); releaseB();
  });

  it('releases on background, reacquires and refreshes on foreground without polling', async () => {
    const { fetch, demand } = harness();
    const observer = { refresh: vi.fn(), error: vi.fn() };
    const release = demand.retain(location, 'session', observer);
    await vi.waitFor(() => expect(observer.refresh).toHaveBeenCalledTimes(1));
    demand.setForeground(false);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    demand.setForeground(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    demand.setForeground(true);
    await vi.waitFor(() => expect(observer.refresh).toHaveBeenCalledTimes(2));
    release();
  });

  it('releases a late acquisition after the last pane leaves without refreshing it', async () => {
    const { fetch, demand } = harness();
    let finish!: (response: Response) => void;
    fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const observer = { refresh: vi.fn(), error: vi.fn() };
    const release = demand.retain(location, 'session', observer);
    release();
    finish(Response.json({ id: 'late-lease' }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(observer.refresh).not.toHaveBeenCalled();
    expect(fetch.mock.calls[1][0]).toBe('/api/hosts/host-a/subscriptions/late-lease');
  });

  it('never evicts a live observer when the Hub rejects a ninth subscription', async () => {
    const { fetch, demand } = harness();
    let count = 0;
    fetch.mockImplementation(async (_path, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      count += 1;
      if (count > 8) return Response.json({ error: 'content_limit' }, { status: 429 });
      const id = `lease-${count}`;
      const body = JSON.parse(String(init?.body)) as { sessionId: string };
      queueMicrotask(() => demand.contentReady(location.hostId, id, body.sessionId));
      return Response.json({ id });
    });
    const observers = Array.from({ length: 9 }, () => ({ refresh: vi.fn(), error: vi.fn() }));
    const releases = observers.map((observer, index) => demand.retain(location, `session-${index}`, observer));
    await vi.waitFor(() => expect(observers[8].error).toHaveBeenCalledTimes(1));
    expect(observers.slice(0, 8).every((observer) => observer.refresh.mock.calls.length === 1)).toBe(true);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);
    releases.forEach((release) => release());
  });

  it('has no IO when unused or when retaining a local session', () => {
    const { fetch, demand } = harness();
    demand.setForeground(false);
    demand.setForeground(true);
    demand.retain({ hubId: 'hub-a', directory: '/project' }, 'session', { refresh: vi.fn(), error: vi.fn() })();
    demand.dispose();
    expect(fetch).not.toHaveBeenCalled();
  });
});
