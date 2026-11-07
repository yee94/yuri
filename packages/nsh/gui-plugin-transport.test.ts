import { describe, expect, it, vi } from 'vitest';
import { createGuiPluginFetch, validateGuiPluginWireRequest, type GuiPluginWireRequest } from './gui-plugin-transport';
import { createGuiPluginChannel } from './gui-plugin-channel';
import { captureGuiPluginExports } from './gui-plugin-exports';

const scope = { hostID: 'synthetic', lease: 'original' };
describe('captured GUI HTTP/channel boundary', () => {
  it('releases bodyless response streams instead of consuming a native reader slot indefinitely', async () => {
    const cancel = vi.fn();
    const request = createGuiPluginFetch({ scope, origin: 'https://synthetic.invalid', signal: new AbortController().signal,
      sender: { isCurrent: () => true, send: async () => ({ status: 204, mime: 'application/json', base64: '', stream: new ReadableStream<Uint8Array>({ cancel }) }) } });
    const response = await request('https://synthetic.invalid/api/rpc/contract/read', { method: 'POST', body: '{}' });
    expect(response.status).toBe(204); expect(response.body).toBeNull(); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('pulls more than 32 MiB without a base64 aggregate or truncation, using exact scoped chunk IDs', async () => {
    let chunks = 0;
    const channel = createGuiPluginChannel({ scope, isCurrent: () => true, port: { async postMessage(input) {
      expect(input.expectedHost).toEqual(scope);
      if (input.name === 'request') return { status: 200, mime: 'text/plain; charset=utf-8', stream: true };
      if (input.name === 'cancel') return true;
      expect(input.name).toBe('chunk'); expect(input.id).toBe('1');
      if (chunks++ === 529) return { done: true, base64: '' };
      return { done: false, base64: btoa('x'.repeat(65536)) };
    } } });
    const fetch = createGuiPluginFetch({ scope, origin: 'yuri-plugin://synthetic', sender: channel.sender, signal: new AbortController().signal });
    const response = await fetch('yuri-plugin://synthetic/api/plugin/gui?id=synthetic');
    const reader = response.body?.getReader();
    let total = 0;
    if (!reader) throw Error('No actual response body');
    while (true) { const { value, done } = await reader.read(); if (done) break; total += value.length; expect(value[0]).toBe(120); expect(value.at(-1)).toBe(120); }
    expect(total).toBe(529 * 65536); expect(total).toBeGreaterThan(32 * 1024 * 1024);
    channel.close();
  });
  it('retains original headers/query/JSON RPC bytes and SDK error status', async () => {
    const send = vi.fn(async () => ({ status: 404, mime: 'application/json', base64: btoa('{"error":"synthetic"}') }));
    const request = createGuiPluginFetch({ scope, origin: 'https://synthetic.invalid', sender: { send, isCurrent: () => true }, signal: new AbortController().signal });
    const response = await request('https://synthetic.invalid/api/rpc/contract/read?location=opaque%20value', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-opencode-directory': '/work' }, body: '{"input":{"exact":true}}' });
    expect(response.status).toBe(404); expect(await response.text()).toBe('{"error":"synthetic"}');
    expect(send.mock.calls[0]).toEqual([scope, {
      method: 'POST', route: '/api/rpc/contract/read?location=opaque%20value', headers: { 'content-type': 'application/json', 'x-opencode-directory': '/work' }, body: '{"input":{"exact":true}}',
    }, expect.any(AbortSignal)]);
  });
  it('rejects credentials, arbitrary mutation routes, traversal and redirects before adopting any data', async () => {
    const rejected: GuiPluginWireRequest[] = [
      { method: 'GET', route: '/api/plugin?apiKey=synthetic', headers: {} },
      { method: 'GET', route: '/api/plugin', headers: { Authorization: 'synthetic' } },
      { method: 'POST', route: '/api/plugin/update', headers: {} },
      { method: 'POST', route: '/api/rpc/a/../read', headers: {} },
      { method: 'GET', route: '/api/plugin', headers: {}, body: 'body' },
    ];
    for (const request of rejected) expect(() => validateGuiPluginWireRequest(request)).toThrow();
    const request = createGuiPluginFetch({ scope, origin: 'https://synthetic.invalid', signal: new AbortController().signal,
      sender: { isCurrent: () => true, send: async () => ({ status: 302, mime: 'text/html', base64: '' }) } });
    await expect(request('https://synthetic.invalid/api/plugin')).rejects.toThrow('GUI_PLUGIN_INVALID_RESPONSE');
    await expect(request('https://other.invalid/api/plugin')).rejects.toThrow('GUI_PLUGIN_INVALID_ORIGIN');
  });
  it('rejects a same-Host renewed lease and aborts exact old native request IDs', async () => {
    let current = true, resolve: ((value: unknown) => void) | undefined;
    const calls: Readonly<Record<string, unknown>>[] = [];
    const channel = createGuiPluginChannel({ scope, isCurrent: () => current, port: { postMessage: async input => {
      calls.push(input); if (input.name === 'request') return new Promise(done => { resolve = done; }); return true;
    } } });
    const lifetime = new AbortController();
    const pending = channel.sender.send(scope, { method: 'GET', route: '/api/plugin', headers: {} }, lifetime.signal);
    lifetime.abort();
    expect(calls[1]).toEqual({ name: 'cancel', expectedHost: scope, id: '1' });
    resolve?.({ status: 200, mime: 'application/json', base64: 'e30=' });
    await expect(pending).rejects.toThrow();
    current = false;
    await expect(channel.state('mounted')).rejects.toThrow('runtime_host_scope_stale');
    channel.close(); channel.close();
  });
  it('exports use the genuine injected container capability and reject late results after Host changes', async () => {
    let current = true, resolve: ((value: { status: 'saved' }) => void) | undefined;
    const capture = vi.fn(() => ({
      capabilities: async () => ({ version: 1 as const, exportPDF: true, exportLongImage: false, limits: { maxHTMLBytes: 1000, maxWidth: 100, maxHeight: 100, maxPixels: 10000 } }),
      exportPDF: async () => new Promise<{ status: 'saved' }>(done => { resolve = done; }),
      exportLongImage: async () => { throw Error('EXPORT_UNSUPPORTED'); },
    }));
    const api = captureGuiPluginExports({ scope, signal: new AbortController().signal, isCurrent: () => current, capture });
    expect(capture).toHaveBeenCalledExactlyOnceWith(scope);
    expect(await api?.capabilities()).toMatchObject({ exportPDF: true, exportLongImage: false });
    const pending = api?.exportPDF({ filename: 'synthetic.pdf', snapshot: { html: '<p>synthetic</p>', width: 100, height: 100 } });
    current = false; resolve?.({ status: 'saved' });
    await expect(pending).rejects.toThrow('runtime_host_scope_stale');
    expect(captureGuiPluginExports({ scope, signal: new AbortController().signal, isCurrent: () => true, capture: () => undefined })).toBeUndefined();
  });
});
