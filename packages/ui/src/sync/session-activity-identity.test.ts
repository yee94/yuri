import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { ChildStoreManager } from './child-store';
import { useGlobalSessionStatusStore } from './global-session-status';
import { getSessionActivityReader } from './session-activity';
import { mountSessionActivityIdentitySync } from './session-activity-identity';
import { getSessionShellActivity } from './session-shell-activity';

vi.hoisted(() => vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [] }))));
let dispose: (() => void) | undefined;
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  useGlobalSessionsStore.setState({ activeSessions: [] });
  useGlobalSessionStatusStore.setState({ statusById: new Map() });
});
afterEach(() => { dispose?.(); client.clear(); });
const session = (id: string, parentID?: string) => ({ id, parentID, directory: '/workspace', time: { created: 1, updated: 1 } }) as Session;

test('busy children without any catalog identity make their idle parent active without opening child messages', async () => {
  const children = new ChildStoreManager();
  const store = children.ensureChild('/workspace', { bootstrap: false });
  store.setState({ session: [session('parent')], session_status: { parent: { type: 'idle' }, child: { type: 'busy' } } });
  const reader = getSessionActivityReader(children);
  expect(reader.read().has('parent')).toBe(false);
  const loadSession = vi.fn(async (id: string) => session(id, 'parent'));
  dispose = mountSessionActivityIdentitySync(children, { client, loadSession });
  await vi.waitFor(() => expect(reader.readBackgroundCount('parent')).toBe(1));
  expect(loadSession).toHaveBeenCalledTimes(1);
  expect(loadSession).toHaveBeenCalledWith('child', expect.any(AbortSignal));
  expect(store.getState().session_status.parent.type).toBe('idle');
  store.setState({ session_status: { parent: { type: 'idle' }, child: { type: 'idle' } } });
  expect(reader.read().has('parent')).toBe(false);
});

test('global-only running IDs recover nested ancestry with bounded concurrency and deduplicated parents', async () => {
  const children = new ChildStoreManager();
  const store = children.ensureChild('/workspace', { bootstrap: false });
  store.setState({ session: [session('root')] });
  useGlobalSessionStatusStore.setState({ statusById: new Map(['a', 'b', 'c'].map(id => [id, { status: 'busy' as const, directory: '' }])) });
  let inFlight = 0;
  let maxFlight = 0;
  const loadSession = vi.fn(async (id: string) => {
    inFlight += 1;
    maxFlight = Math.max(maxFlight, inFlight);
    await Promise.resolve();
    inFlight -= 1;
    return session(id, id === 'middle' ? 'root' : 'middle');
  });
  dispose = mountSessionActivityIdentitySync(children, { client, loadSession });
  const reader = getSessionActivityReader(children);
  await vi.waitFor(() => expect(reader.readBackgroundCount('root')).toBe(3));
  expect(maxFlight).toBeLessThanOrEqual(2);
  expect(loadSession.mock.calls.map(([id]) => id).sort()).toEqual(['a', 'b', 'c', 'middle']);
});

test('one failed identity preserves running status and does not block another child', async () => {
  const children = new ChildStoreManager();
  const store = children.ensureChild('/workspace', { bootstrap: false });
  store.setState({ session: [session('root')], session_status: { broken: { type: 'busy' }, good: { type: 'busy' } } });
  const loadSession = vi.fn(async (id: string) => {
    if (id === 'broken') throw new Error('offline');
    return session(id, 'root');
  });
  dispose = mountSessionActivityIdentitySync(children, { client, loadSession });
  await vi.waitFor(() => expect(getSessionActivityReader(children).readBackgroundCount('root')).toBe(1));
  expect(store.getState().session_status.broken.type).toBe('busy');
  expect(loadSession.mock.calls.filter(([id]) => id === 'broken').length).toBeLessThanOrEqual(2);
});

test('disposing a provider fences an outstanding identity response', async () => {
  const children = new ChildStoreManager();
  useGlobalSessionStatusStore.setState({ statusById: new Map([['child', { status: 'busy', directory: '' }]]) });
  let resolve!: (value: Session) => void;
  const loadSession = vi.fn(() => new Promise<Session>(done => { resolve = done; }));
  dispose = mountSessionActivityIdentitySync(children, { client, loadSession });
  await vi.waitFor(() => expect(loadSession).toHaveBeenCalledTimes(1));
  dispose();
  resolve(session('child', 'root'));
  await client.fetchQuery({ queryKey: client.getQueryCache().getAll()[0].queryKey });
  expect(children.children.size).toBe(0);
});

test('an idle subagent with a live shell recovers its ancestry without loading transcripts', async () => {
  const children = new ChildStoreManager();
  const activity = getSessionShellActivity(children);
  activity.event('/workspace', { type: 'shell.created', properties: {
    info: { id: 'sh_tests', status: 'running', metadata: { sessionID: 'child' } },
  } });
  const loadSession = vi.fn(async (id: string) => session(id, id === 'child' ? 'root' : undefined));
  dispose = mountSessionActivityIdentitySync(children, { client, loadSession });
  const reader = getSessionActivityReader(children);
  await vi.waitFor(() => expect(reader.readBackgroundCount('root')).toBe(1));
  expect(loadSession.mock.calls.map(([id]) => id)).toEqual(['child', 'root']);
  activity.event('/workspace', { type: 'shell.exited', properties: { id: 'sh_tests', status: 'exited' } });
  expect(reader.read().size).toBe(0);
});

test('known shell owners do not rescan the session catalog or issue identity reads on lifecycle events', async () => {
  const children = new ChildStoreManager();
  const store = children.ensureChild('/workspace', { bootstrap: false });
  let visits = 0;
  store.setState({ session: Array.from({ length: 2000 }, (_, i) => ({
    get id() { visits += 1; return `session-${i}`; },
    parentID: i ? 'session-0' : undefined,
  })) as Session[] });
  const loadSession = vi.fn(async (id: string) => session(id));
  dispose = mountSessionActivityIdentitySync(children, { client, loadSession });
  await Promise.resolve();
  visits = 0;
  const activity = getSessionShellActivity(children);
  for (let i = 0; i < 50; i++) {
    activity.event('/workspace', { type: 'shell.created', properties: {
      info: { id: `sh_${i}`, status: 'running', metadata: { sessionID: 'session-1999' } },
    } });
    await Promise.resolve();
  }
  expect(visits).toBe(0);
  expect(loadSession).not.toHaveBeenCalled();
});
