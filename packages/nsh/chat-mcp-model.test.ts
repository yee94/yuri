import { describe, expect, it, vi } from 'vitest';
import { createChatMcpModel } from './chat-mcp-model';
import { dict as en } from '../ui/src/lib/i18n/messages/en';
import { dict as zhCN } from '../ui/src/lib/i18n/messages/zh-CN';
import { dict as zhTW } from '../ui/src/lib/i18n/messages/zh-TW';
import { dict as ja } from '../ui/src/lib/i18n/messages/ja';
import { dict as ko } from '../ui/src/lib/i18n/messages/ko';
import { dict as fr } from '../ui/src/lib/i18n/messages/fr';
import { dict as es } from '../ui/src/lib/i18n/messages/es';
import { dict as pl } from '../ui/src/lib/i18n/messages/pl';
import { dict as ptBR } from '../ui/src/lib/i18n/messages/pt-BR';
import { dict as uk } from '../ui/src/lib/i18n/messages/uk';

const directory = '/workspace/project with space';
const location = '?location%5Bdirectory%5D=%2Fworkspace%2Fproject%20with%20space';
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function harness() {
  let live = true, connected = false, configFailure = false, statusFailure = false, writeFailure = false;
  const request = vi.fn(async (path: string, method = 'GET') => {
    if (method === 'POST') { if (writeFailure) throw new Error('Synthetic write uncertain'); connected = path.includes('/connect?'); return {}; }
    if (path.startsWith('/api/config/mcp')) { if (configFailure) throw new Error('Synthetic configs failure'); return [{ name: 'z-config' }, { name: 'a-server' }]; }
    if (path === `/api/mcp${location}`) { if (statusFailure) throw new Error('Synthetic status failure'); return { data: [{ name: 'a-server', status: { status: connected ? 'connected' : 'disabled' } }, { name: 'b-status', status: { status: 'needs_auth' } }] }; }
    throw new Error('Unexpected MCP test request');
  });
  const changed = vi.fn(), model = createChatMcpModel(directory, changed);
  model.replaceLane({ current: () => live, request });
  return { model, request, changed, retire: () => { live = false; model.replaceLane(null); }, configFailure: () => { configFailure = true; }, statusFailure: (value = true) => { statusFailure = value; }, writeFailure: () => { writeFailure = true; }, connected: () => { connected = true; } };
}

describe('Chat MCP sheet authoritative reads and mutation safety', () => {
  it('explains an unconfirmed connection change in every shipped locale without English placeholders', () => {
    for (const dictionary of [zhCN, zhTW, ja, ko, fr, es, pl, ptBR, uk]) {
      expect(dictionary['mcpDropdown.status.unconfirmed']).toBeTruthy();
      expect(dictionary['mcpDropdown.status.unconfirmed']).not.toBe(en['mcpDropdown.status.unconfirmed']);
    }
  });
  it('does no closed work, loads the union once, and preserves exact captured directory wire', async () => {
    const h = harness(); expect(h.request).not.toHaveBeenCalled();
    await h.model.refresh();
    expect(h.model.snapshot()).toMatchObject({ names: ['a-server', 'b-status', 'z-config'], ready: true, loading: false, errors: [] });
    expect(h.request.mock.calls.map(([path]) => path)).toEqual(['/api/config/mcp?directory=%2Fworkspace%2Fproject%20with%20space', `/api/mcp${location}`]);
    for (let i = 0; i < 50; i++) h.model.snapshot();
    expect(h.request).toHaveBeenCalledTimes(2);
    h.retire(); await h.model.refresh(); await h.model.toggle('a-server', true);
    expect(h.request).toHaveBeenCalledTimes(2);
  });
  it('retains successful domains through a partial refresh failure, never displays authoritative empty', async () => {
    const h = harness(); await h.model.refresh(); const statuses = h.model.snapshot().statuses;
    h.configFailure(); h.statusFailure(); await h.model.refresh();
    expect(h.model.snapshot()).toMatchObject({ names: ['a-server', 'b-status', 'z-config'], errors: ['Synthetic configs failure', 'Synthetic status failure'] });
    expect(h.model.snapshot().statuses).toBe(statuses);
  });
  it('connects then verifies, no optimistic switch and no second POST after confirmation', async () => {
    const h = harness(); await h.model.refresh(); await h.model.toggle('a-server', true); await h.model.toggle('a-server', true);
    expect(h.model.snapshot().statuses['a-server'].status).toBe('connected');
    expect(h.model.snapshot().unconfirmed).toEqual([]);
    expect(h.request.mock.calls.filter(([, method]) => method === 'POST')).toEqual([[`/api/experimental/mcp/a-server/connect${location}`, 'POST']]);
    await h.model.toggle('a-server', false);
    expect(h.model.snapshot().statuses['a-server'].status).toBe('disabled');
  });
  it('preserves unknown writes across refresh and foreground lease replacement; never blindly replays', async () => {
    const h = harness(); await h.model.refresh(); h.writeFailure(); await h.model.toggle('a-server', true);
    expect(h.model.snapshot().unconfirmed).toEqual(['a-server']);
    h.model.replaceLane(null); h.model.replaceLane({ current: () => true, request: h.request });
    await h.model.refresh(); await h.model.toggle('a-server', true);
    expect(h.request.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1);
    h.connected(); await h.model.refresh(); expect(h.model.snapshot().unconfirmed).toEqual([]);
  });
  it('ACK plus failed GET retries only the read, not the connection mutation', async () => {
    const h = harness(); await h.model.refresh(); h.statusFailure(); await h.model.toggle('a-server', true); await h.model.toggle('a-server', true);
    expect(h.model.snapshot().unconfirmed).toEqual(['a-server']);
    h.statusFailure(false); await h.model.refresh();
    expect(h.model.snapshot().statuses['a-server'].status).toBe('connected');
    expect(h.request.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1);
  });
  it('rejects a config-only unknown-status mutation and an unknown entity', async () => {
    const h = harness(); await h.model.refresh(); await h.model.toggle('z-config', true); await h.model.toggle('missing', true);
    expect(h.request.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(0);
  });
  it('one failed config domain does not block a complete authoritative status row', async () => {
    const h = harness(); h.configFailure(); await h.model.refresh();
    expect(h.model.snapshot()).toMatchObject({ ready: false, statusReady: true });
    await h.model.toggle('a-server', true);
    expect(h.model.snapshot().statuses['a-server'].status).toBe('connected');
  });
  it('definitive rejection remains visible and allows an explicit retry, never an automatic POST', async () => {
    let writes = 0;
    const model = createChatMcpModel(directory, () => {});
    model.replaceLane({ current: () => true, request: async (path, method) => {
      if (method === 'POST') { writes++; throw Object.assign(new Error('Synthetic forbidden'), { status: 403 }); }
      return path.startsWith('/api/config') ? [{ name: 'server' }] : { data: [{ name: 'server', status: { status: 'disabled' } }] };
    } });
    await model.refresh(); await model.toggle('server', true); await model.refresh();
    expect(writes).toBe(1); expect(model.snapshot().unconfirmed).toEqual([]);
    expect(model.snapshot().errors).toContain('Synthetic forbidden');
    await model.toggle('server', true); expect(writes).toBe(2);
  });
  it('deduplicates refreshes and fences late responses after suspension', async () => {
    const gate = deferred<unknown>(); let live = true;
    const request = vi.fn(() => gate.promise), model = createChatMcpModel(directory, () => {});
    model.replaceLane({ request, current: () => live });
    const flight = model.refresh(); await model.refresh(); expect(request).toHaveBeenCalledTimes(2);
    live = false; model.replaceLane(null); gate.resolve([]); await flight;
    expect(model.snapshot()).toMatchObject({ names: [], loading: false, ready: false, errors: [] });
  });
  it('rejects malformed successful wire without clearing valid data; accepts authoritative empty', async () => {
    const h = harness(); await h.model.refresh();
    h.model.replaceLane({ current: () => true, request: async () => ({}) }); await h.model.refresh();
    expect(h.model.snapshot().names).toEqual(['a-server', 'b-status', 'z-config']);
    expect(h.model.snapshot().errors).toHaveLength(2);
    h.model.replaceLane({ current: () => true, request: async path => path.startsWith('/api/config') ? [] : { data: [] } }); await h.model.refresh();
    expect(h.model.snapshot()).toMatchObject({ names: [], ready: true, errors: [] });
  });
});
