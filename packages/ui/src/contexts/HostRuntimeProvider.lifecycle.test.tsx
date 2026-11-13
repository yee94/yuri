import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostRuntimeProvider, useRemoteSessionDemand } from './HostRuntimeProvider';
import { HostRuntimeRegistry, type HostRuntimeDependencies } from '@/lib/remote-projects/registry';

const events = vi.hoisted(() => ({ listeners: new Set<(event: unknown) => void>(), subscribe: vi.fn() }));
vi.mock('@/lib/yuriEvents', () => ({ subscribeYuriEvents: (listener: (event: unknown) => void) => {
  events.subscribe(); events.listeners.add(listener); return () => events.listeners.delete(listener);
} }));

afterEach(() => { events.listeners.clear(); vi.clearAllMocks(); });

describe('mounted Host runtime content demand', () => {
  it('shares observers, refreshes late panes and reconnects through the actual provider hooks', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const location = { hubId: 'hub', hostId: 'host', directory: '/raw/project' };
    let serial = 0;
    const fetch = vi.fn<HostRuntimeDependencies['fetch']>(async (_path, init) => init?.method === 'DELETE'
      ? new Response(null, { status: 204 })
      : Response.json({ id: `lease-${++serial}`, channelId: 'shared-channel', readyGeneration: `ready-${serial}` }));
    const registry = new HostRuntimeRegistry('hub', { transportIdentity: 'transport', isCurrent: () => true, fetch, sdk: () => { throw new Error('Not used'); } });
    registry.applyCatalog({ supported: true, hubId: 'hub', projects: [], hosts: [{ id: 'host', name: 'Host', source: 'direct', state: 'connected', generation: 'wire' }] });
    const a = vi.fn(); const b = vi.fn(); const error = vi.fn();
    function Pane({ refresh }: { refresh: () => void }) {
      useRemoteSessionDemand('same-session', refresh, error);
      return <span>pane</span>;
    }
    function View({ second = false, tick = 0 }: { second?: boolean; tick?: number }) {
      return <div data-tick={tick}><HostRuntimeProvider registry={registry} location={location}>
        <Pane refresh={a} />{second ? <Pane refresh={b} /> : null}
      </HostRuntimeProvider></div>;
    }
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    const emit = (readyGeneration: string) => {
      for (const listener of events.listeners) listener({ type: 'remote-host-event', envelope: {
        type: 'yuri:host-event', properties: { hubId: 'hub', hostId: 'host', generation: 'wire', directory: location.directory,
          payload: { type: 'yuri:content-ready', properties: { id: 'lease-1', sessionId: 'same-session', channelId: 'shared-channel', readyGeneration } } },
      } });
    };
    try {
      await act(async () => root.render(<View />));
      await vi.waitFor(() => expect(a).toHaveBeenCalledTimes(1));
      await act(async () => root.render(<View second />));
      await vi.waitFor(() => expect(b).toHaveBeenCalledTimes(1));
      expect(a).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(events.subscribe).toHaveBeenCalledTimes(1);
      for (let tick = 0; tick < 50; tick += 1) await act(async () => root.render(<View second tick={tick} />));
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(events.subscribe).toHaveBeenCalledTimes(1);
      await act(async () => emit('ready-1'));
      expect(a).toHaveBeenCalledTimes(1);
      await act(async () => emit('reconnected-upstream'));
      expect(a).toHaveBeenCalledTimes(2); expect(b).toHaveBeenCalledTimes(2);
      await act(async () => { for (const listener of events.listeners) listener({ type: 'event-stream-ready' }); });
      await vi.waitFor(() => expect(a).toHaveBeenCalledTimes(3));
      expect(b).toHaveBeenCalledTimes(3);
      expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
      expect(events.subscribe).toHaveBeenCalledTimes(1);
      await act(async () => root.render(<View />));
      expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
      expect(error).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount()); container.remove();
    }
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(2);
    expect(events.listeners.size).toBe(0);
  });
});
