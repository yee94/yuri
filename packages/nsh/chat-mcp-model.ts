import { createSettingsLaneOwner, scopedSettingsPath, type SettingsRequestLane } from './settings-protocol';

export type ChatMcpStatus = { status: string; error?: string };
export type ChatMcpSnapshot = Readonly<{
  names: readonly string[]; statuses: Readonly<Record<string, ChatMcpStatus>>;
  loading: boolean; ready: boolean; statusReady: boolean; errors: readonly string[]; busy: readonly string[]; unconfirmed: readonly string[];
}>;

/** A sheet-local view of authoritative MCP/config reads, never a second Chat sync owner. */
export function createChatMcpModel(directory: string, changed: (value: ChatMcpSnapshot) => void) {
  const transport = createSettingsLaneOwner(async () => { throw new Error('MCP unavailable'); }, () => false);
  transport.replaceLane(null);
  let configs: string[] = [], statuses: Record<string, ChatMcpStatus> = {}, configReady = false, statusReady = false;
  let errors: string[] = [], actionError = '', loading = false, serial = 0;
  const busy = new Set<string>(), uncertain = new Map<string, { connected: boolean; acknowledged: boolean }>();
  const location = `?location%5Bdirectory%5D=${encodeURIComponent(directory)}`;
  const snapshot = (): ChatMcpSnapshot => ({ names: [...new Set([...configs, ...Object.keys(statuses)])].sort((a, b) => a.localeCompare(b)), statuses, loading, ready: configReady && statusReady, statusReady, errors: actionError ? [...errors, actionError] : errors, busy: [...busy], unconfirmed: [...uncertain.keys()] });
  const publish = () => changed(snapshot());
  const fail = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid MCP response');
    return value as Record<string, unknown>;
  };
  async function refresh() {
    const lane = transport.capture(); if (!lane?.current() || loading) return;
    const version = ++serial; loading = true; errors = []; publish();
    const current = () => version === serial && lane.current();
    await Promise.allSettled([
      (async () => {
        try {
          const value = await lane.request(scopedSettingsPath('/api/config/mcp', directory));
          if (!Array.isArray(value)) throw new Error('Invalid MCP configs response');
          const next = value.map(item => { const row = object(item); if (typeof row.name !== 'string' || !row.name) throw new Error('Invalid MCP config name'); return row.name; });
          if (current()) { configs = next; configReady = true; publish(); }
        } catch (error) { if (current()) { errors = [...errors, fail(error)]; publish(); } }
      })(),
      (async () => {
        try {
          const value = object(await lane.request(`/api/mcp${location}`));
          if (!Array.isArray(value.data)) throw new Error('Invalid MCP list response');
          const next: Record<string, ChatMcpStatus> = Object.create(null);
          for (const item of value.data) {
            const row = object(item), state = object(row.status);
            if (typeof row.name !== 'string' || !row.name || typeof state.status !== 'string') throw new Error('Invalid MCP status');
            next[row.name] = { status: state.status, ...(typeof state.error === 'string' ? { error: state.error } : {}) };
          }
          if (current()) {
            statuses = next; statusReady = true;
            for (const [name, pending] of uncertain) if (next[name] && (pending.acknowledged || (next[name].status === 'connected') === pending.connected)) uncertain.delete(name);
            publish();
          }
        } catch (error) { if (current()) { errors = [...errors, fail(error)]; publish(); } }
      })(),
    ]);
    if (current()) { loading = false; publish(); }
  }
  async function toggle(name: string, connected: boolean) {
    const lane = transport.capture();
    if (!lane?.current() || loading || !statusReady || busy.has(name) || uncertain.has(name) || !snapshot().names.includes(name) || !statuses[name] || (statuses[name].status === 'connected') === connected) return;
    const pending = { connected, acknowledged: false };
    busy.add(name); uncertain.set(name, pending); actionError = ''; publish();
    try {
      await lane.request(`/api/experimental/mcp/${encodeURIComponent(name)}/${connected ? 'connect' : 'disconnect'}${location}`, 'POST');
      pending.acknowledged = true;
    } catch (error) {
      if (lane.current()) {
        actionError = fail(error);
        const status = error instanceof Error ? (error as Error & { status?: number }).status : undefined;
        if (status !== undefined && status >= 400 && status < 500 && status !== 408) uncertain.delete(name);
      }
    }
    finally {
      busy.delete(name);
      if (lane.current()) { publish(); await refresh(); }
    }
  }
  function replaceLane(lane: SettingsRequestLane | null) {
    serial++; loading = false; transport.replaceLane(lane);
    // A retained snapshot is display-only until this foreground lease revalidates it.
    statusReady = false; publish();
  }
  return { snapshot, refresh, toggle, replaceLane, dispose: () => replaceLane(null) };
}
