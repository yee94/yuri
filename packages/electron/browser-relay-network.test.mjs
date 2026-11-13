import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { registerBrowserRelayNetwork } from './browser-relay-network.mjs';

function fixture() {
  const app = new EventEmitter();
  const handlers = new Map();
  const sessions = [];
  const session = { fromPartition: vi.fn((partition) => {
    const value = { partition, setProxy: vi.fn(async () => {}), closeAllConnections: vi.fn(async () => {}) };
    sessions.push(value); return value;
  }) };
  const authorize = (event) => { if (event.senderFrame !== event.sender.mainFrame || !event.trusted) throw new Error('denied'); };
  registerBrowserRelayNetwork({ app, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, session, authorize });
  const owner = () => {
    const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send: vi.fn() });
    app.emit('web-contents-created', {}, sender);
    return { sender, senderFrame: sender.mainFrame, trusted: true };
  };
  return { app, sessions, session, owner, call: (action, event, value) => handlers.get(`yuri:browser-relay:${action}`)(event, value) };
}

it('isolates partitions and rejects subframes, untrusted pages and cross-window leases', async () => {
  const f = fixture(), a = f.owner(), b = f.owner();
  try {
    await expect(f.call('start', { ...a, trusted: false })).rejects.toThrow('denied');
    await expect(f.call('start', { ...a, senderFrame: {} })).rejects.toThrow('denied');
    const one = await f.call('start', a), two = await f.call('start', b);
    expect(one.partition).not.toBe(two.partition);
    expect(one.partition.startsWith('persist:')).toBe(false);
    expect(f.sessions[0].setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers', proxyRules: expect.stringMatching(/^socks5:\/\/127\.0\.0\.1:\d+$/), proxyBypassRules: '<-loopback>',
    });
    expect(() => f.call('write', b, { scope: one.scope, data: '{"type":"pong"}' })).toThrow('owner');
    const event = { preventDefault: vi.fn() };
    b.sender.emit('will-attach-webview', event, {}, { partition: one.partition });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    const preferences = { preload: 'unsafe', nodeIntegration: true };
    a.sender.emit('will-attach-webview', {}, preferences, { partition: one.partition });
    expect(preferences).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true });
    expect(preferences.preload).toBeUndefined();
    const guest = Object.assign(new EventEmitter(), { session: f.sessions[0], isDestroyed: () => false, close: vi.fn() });
    a.sender.emit('did-attach-webview', {}, guest);
    a.sender.emit('render-process-gone');
    expect(guest.close).toHaveBeenCalledOnce();
    expect(f.sessions[0].setProxy).toHaveBeenCalledOnce();
    expect(() => f.call('write', b, { scope: two.scope, data: '{"type":"pong"}' })).not.toThrow();
  } finally { f.app.emit('will-quit'); }
});
