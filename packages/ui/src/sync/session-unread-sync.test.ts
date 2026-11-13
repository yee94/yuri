import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

const state = vi.hoisted(() => ({
  transport: 'host-a', generation: 1, vscode: false,
  client: null as QueryClient | null, fetch: vi.fn(),
  events: new Set<(event: { type: string }) => void>(), switches: new Set<() => void>(),
}));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => state.transport,
  getRuntimeGeneration: () => state.generation,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { state.switches.add(listener); return () => state.switches.delete(listener); },
}));
vi.mock('@/contexts/runtimeAPIRegistry', () => ({ getRegisteredRuntimeAPIs: () => ({ runtime: { isVSCode: state.vscode } }) }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: state.fetch }));
vi.mock('@/lib/queryRuntime', () => ({ get queryClient() { return state.client; } }));
vi.mock('@/lib/yuriEvents', () => ({ subscribeYuriEvents: (listener: (event: { type: string }) => void) => {
  state.events.add(listener); return () => state.events.delete(listener);
} }));

import { mountSessionUnreadSync } from './session-unread-sync';
import { appendNotification, markSessionUnread, markSessionViewed, useNotificationStore, resetSessionUnreadProjection } from './notification-store';
import { sessionUnreadKey, sessionUnreadQueryOptions, saveSessionUnread, type SessionUnreadSnapshot } from '@/queries/sessionUnreadQueries';

const snapshot = (revision = 1, unreadCount = 1, manual = false): SessionUnreadSnapshot => ({
  revision, sessions: { one: { directory: '/project', unreadCount, manual, hasError: false, revision } },
});
const reply = (body: unknown, status = 200) => Response.json(body, { status });
const tip = (type = 'session-unread-changed') => state.events.forEach(listener => listener({ type }));
let stop: (() => void) | undefined;
beforeEach(() => {
  state.transport = 'host-a'; state.generation = 1; state.vscode = false;
  state.client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  state.fetch.mockReset();
  resetSessionUnreadProjection();
});
afterEach(() => {
  stop?.(); stop = undefined; state.client?.clear(); state.events.clear(); state.switches.clear();
  resetSessionUnreadProjection(); vi.restoreAllMocks();
});
const count = () => useNotificationStore.getState().sessionUnseenCount('one');

describe('session unread sync', () => {
  test('bootstraps from GET, catches remote reads and manual marks, and ignores local duplicated terminal counts', async () => {
    let server = snapshot();
    state.fetch.mockImplementation(async () => reply(server));
    stop = mountSessionUnreadSync(() => false);
    await vi.waitFor(() => expect(count()).toBe(1));
    appendNotification({ session: 'one', directory: '/project', type: 'turn-complete', time: Date.now(), viewed: false });
    expect(count()).toBe(1);
    server = snapshot(2, 0);
    tip();
    await vi.waitFor(() => expect(count()).toBe(0));
    server = snapshot(3, 1, true);
    tip();
    await vi.waitFor(() => expect(count()).toBe(1));
    expect(state.fetch.mock.calls.every(([, options]) => options?.method !== 'PUT')).toBe(true);
  });

  test('focused completion becomes globally read; a manual reminder stays unread until explicit opening', async () => {
    let server = snapshot(1, 1, true);
    state.fetch.mockImplementation(async (_path, options) => {
      if (options?.method === 'PUT') server = snapshot(server.revision + 1, JSON.parse(options.body).unread ? 1 : 0, JSON.parse(options.body).unread);
      return reply(server);
    });
    stop = mountSessionUnreadSync(() => true);
    await vi.waitFor(() => expect(count()).toBe(1));
    expect(state.fetch).toHaveBeenCalledTimes(1);
    markSessionViewed('one');
    await vi.waitFor(() => expect(count()).toBe(0));
    expect(JSON.parse(state.fetch.mock.calls[1][1].body)).toEqual({ unread: false, expectedRevision: 1 });
    server = snapshot(3, 1);
    tip();
    await vi.waitFor(() => expect(server.sessions.one.unreadCount).toBe(0));
    await markSessionUnread('one');
    await vi.waitFor(() => expect(count()).toBe(1));
    expect(server.sessions.one.manual).toBe(true);
  });

  test('failed GET and failed mutations preserve the previous authority; reconnect and focus retry', async () => {
    state.fetch.mockImplementation(async () => reply(snapshot(1, 1, true)));
    stop = mountSessionUnreadSync(() => false);
    await vi.waitFor(() => expect(count()).toBe(1));
    state.fetch.mockImplementation(async () => reply({}, 503));
    await expect(saveSessionUnread('one', false, 1)).rejects.toThrow();
    expect(count()).toBe(1);
    tip();
    await vi.waitFor(() => expect(state.fetch.mock.calls.length).toBeGreaterThan(2));
    expect(count()).toBe(1);
    state.fetch.mockImplementation(async () => reply(snapshot(2, 0)));
    tip('event-stream-ready');
    await vi.waitFor(() => expect(count()).toBe(0));
  });

  test('stale snapshots and late writes cannot cross runtime switches, including A → B → A', async () => {
    state.fetch.mockImplementation(async () => reply(snapshot(10, 1, true)));
    stop = mountSessionUnreadSync(() => false);
    await vi.waitFor(() => expect(count()).toBe(1));
    let resolve!: (response: Response) => void;
    state.fetch.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    const mutation = saveSessionUnread('one', true);
    state.transport = 'host-b'; state.generation += 1;
    state.fetch.mockImplementation(async () => reply({ revision: 0, sessions: {} }));
    state.switches.forEach(listener => listener());
    expect(count()).toBe(0);
    resolve(reply(snapshot(11, 1, true)));
    await expect(mutation).rejects.toThrow('Runtime changed');
    await vi.waitFor(() => expect(state.fetch).toHaveBeenCalled());
    expect(count()).toBe(0);
    state.transport = 'host-a'; state.generation += 1;
    state.fetch.mockImplementation(async () => reply(snapshot(12, 0)));
    state.switches.forEach(listener => listener());
    await vi.waitFor(() => expect(state.client!.getQueryData<SessionUnreadSnapshot>(sessionUnreadKey())?.revision).toBe(12));
    expect(count()).toBe(0);
  });

  test('a tip received during the first GET is not lost between snapshot and subscribe', async () => {
    let resolve!: (response: Response) => void;
    state.fetch.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    state.fetch.mockImplementation(async () => reply(snapshot(2, 1, true)));
    stop = mountSessionUnreadSync(() => false);
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    for (let i = 0; i < 50; i++) tip();
    resolve(reply({ revision: 0, sessions: {} }));
    await vi.waitFor(() => expect(count()).toBe(1));
    expect(state.fetch).toHaveBeenCalledTimes(2);
  });

  test('opening before the first snapshot acknowledges a manual unread marker after authority arrives', async () => {
    let resolve!: (response: Response) => void;
    state.fetch.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    state.fetch.mockImplementation(async () => reply(snapshot(2, 0)));
    stop = mountSessionUnreadSync(() => true);
    markSessionViewed('one');
    resolve(reply(snapshot(1, 1, true)));
    await vi.waitFor(() => expect(state.fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(state.fetch.mock.calls[1][1].body)).toEqual({ unread: false, expectedRevision: 1 });
    await vi.waitFor(() => expect(count()).toBe(0));
  });

  test('rejects malformed snapshots and preserves newer revisions', async () => {
    const options = sessionUnreadQueryOptions();
    const signal = new AbortController().signal;
    for (const body of [{ revision: 1, sessions: [] }, { ...snapshot(), revision: 0 }, { revision: 1, sessions: { one: { ...snapshot().sessions.one, unreadCount: -1 } } }]) {
      state.fetch.mockResolvedValueOnce(reply(body));
      await expect(options.queryFn({ signal })).rejects.toThrow('Invalid session unread snapshot');
    }
    expect(options.structuralSharing(snapshot(5), snapshot(4))).toEqual(snapshot(5));
    state.fetch.mockResolvedValueOnce(reply(snapshot()));
    await options.queryFn({ signal });
    expect(state.fetch).toHaveBeenLastCalledWith('/api/yuri/session-unread', { signal });
  });

  test('no-op snapshots preserve badge references across 50 updates; standalone VS Code stays local', async () => {
    state.fetch.mockImplementation(async () => reply(snapshot(1, 1, true)));
    stop = mountSessionUnreadSync(() => false);
    await vi.waitFor(() => expect(count()).toBe(1));
    const index = useNotificationStore.getState().index;
    for (let i = 0; i < 50; i++) {
      await state.client!.fetchQuery(sessionUnreadQueryOptions());
      expect(useNotificationStore.getState().index).toBe(index);
    }
    stop(); stop = undefined;
    state.vscode = true; state.fetch.mockClear();
    stop = mountSessionUnreadSync(() => false);
    await markSessionUnread('one', '/project');
    expect(count()).toBe(1);
    expect(state.fetch).not.toHaveBeenCalled();
    markSessionViewed('one');
    expect(count()).toBe(0);
  });
});
