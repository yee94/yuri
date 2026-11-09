import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import * as core from './assistants-core';
import * as model from './model';

const root = path.dirname(fileURLToPath(import.meta.url));
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = () => { let resolve!: (value: unknown) => void; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function production(file: string, name: string, ports: Record<string, unknown>, observations?: string) {
  const source = ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
  const body = declaration.body!.statements.filter(node => !observations || !ts.isReturnStatement(node)).map(node => node.getText(source)).join('\n');
  const output = ts.transpileModule(`function ${name}(${declaration.parameters.map(node => node.getText(source)).join(', ')}) { ${body}; ${observations ? `return { ${observations} };` : ''} }`, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText;
  return new Function(...Object.keys(ports), `${output}; return ${name};`)(...Object.values(ports));
}
function harness() {
  const effects: Array<() => void> = [], cleanups: Array<() => void> = [];
  const signal = <T>(value: T) => Object.assign(() => value, { set(next: T) { value = next; } });
  const generation = signal(1), lifecycle = signal('active'), visible = signal(true);
  const connection = signal({ id: 'A', url: 'https://a.example', authorizationID: 'auth-a' });
  const app = { connection, runtimeScope: signal({ lease: 'one' }), bots: signal<model.Row[]>([]) };
  const calls: Array<{ path: string; method: string; body: unknown; generation: number }> = [];
  let respond = (path: string, _method: string, _body: unknown): unknown => path.endsWith('capability') ? { supported: true, enabled: true } : path.endsWith('snapshot') ? { revision: 1, enabled: true, assistants: [] } : path.endsWith('scheduled-tasks') ? { tasks: [] } : { provider: 'feishu', status: 'disconnected', configured: true, hasSecret: true, clientID: 'original', ownerID: 'owner' };
  const captureHostOperation = () => {
    const captured = generation(), identity = connection();
    const current = () => captured === generation() && identity === connection() && lifecycle() === 'active';
    return { current, request: async (path: string, method = 'GET', body?: unknown) => { if (!current()) throw Error('stale'); calls.push({ path, method, body, generation: captured }); const result = await respond(path, method, body); if (!current()) throw Error('stale'); return result; } };
  };
  const tick = () => effects.forEach(work => work());
  const ports = { ...model, ...core, signal, lifecycle, app, epoch: generation, captureHostOperation, captureHostRequest: () => captureHostOperation().request,
    cleanup: (work: () => void) => cleanups.push(work), effect: (work: () => void) => { effects.push(work); work(); }, untracked: (work: () => unknown) => work(),
    host: { on: () => () => {} }, t: (key: string) => key, setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(), wireLanguage: () => 'en', assistantQRSvg: () => '',
    AlertDialog: { show: async () => ({ action: 'clear' }) } };
  const createPageOperations = production('page-operations.ts', 'createPageOperations', ports);
  return { ...ports, createPageOperations, calls, visible, tick, respond(work: typeof respond) { respond = work; },
    suspend() { generation.set(generation() + 1); lifecycle.set('background'); tick(); },
    resume() { lifecycle.set('active'); tick(); }, reconnect() { generation.set(generation() + 1); tick(); },
    switchHost(id: string) { connection.set({ id, url: `https://${id}.example`, authorizationID: `auth-${id}` }); generation.set(generation() + 1); tick(); },
    dispose() { cleanups.reverse().forEach(work => work()); } };
}

describe('retained assistant production page callbacks', () => {
  for (const [file, name, observations] of [
    ['assistants-settings.tsx', 'AssistantSettings', 'load, loading, error'],
    ['assistants-details.tsx', 'AssistantDetails', 'load, loading, error'],
    ['assistants-channels.tsx', 'ChannelPanel', 'load, loading, error, clientID, ownerID, secret, save, busy, state'],
  ]) {
    it(`${name} resumes GET on the new lease and permanently retires after Host switch`, async () => {
      const h = harness();
      const owner = production(file, name, h, observations)({ bot: { id: 'bot' }, provider: 'feishu', get active() { return h.visible(); }, onDone() {}, onClose() {} });
      await flush(); const count = h.calls.length;
      h.suspend(); await owner.load(); expect(h.calls).toHaveLength(count);
      h.resume(); await flush(); expect(h.calls.length).toBeGreaterThan(count);
      h.reconnect(); await flush(); const next = h.calls.length;
      await owner.load(); await flush(); expect(h.calls.length).toBeGreaterThan(next);
      h.visible.set(false); h.tick(); const hidden = h.calls.length;
      await owner.load(); expect(h.calls).toHaveLength(hidden);
      h.visible.set(true); h.tick(); await flush(); expect(h.calls.length).toBeGreaterThan(hidden);
      h.switchHost('B'); h.switchHost('A'); const retired = h.calls.length;
      await owner.load(); expect(h.calls).toHaveLength(retired); h.dispose();
    });
    it(`${name} permanently fences full authorization retirement`, async () => {
      const h = harness();
      const owner = production(file, name, h, observations)({ bot: { id: 'bot' }, provider: 'feishu', onDone() {}, onClose() {} });
      await flush(); const original = h.app.connection();
      h.app.connection.set({ ...original, authorizationID: 'new-auth' }); h.tick();
      h.app.connection.set(original); h.tick(); const count = h.calls.length;
      await owner.load(); expect(h.calls).toHaveLength(count); h.dispose();
    });
  }
  it('channel late ACK cannot close or clear the retained draft; recovery only GETs', async () => {
    const h = harness(), close = vi.fn(), gate = deferred();
    const owner = production('assistants-channels.tsx', 'ChannelPanel', h, 'load, clientID, ownerID, secret, save, busy, state, error')({ bot: { id: 'bot' }, provider: 'feishu', onClose: close });
    await flush(); owner.clientID.set('edited'); owner.ownerID.set('edited-owner'); owner.secret.set('sensitive');
    h.respond((path, method) => method === 'PUT' ? gate.promise : path.endsWith('capability') ? { supported: true, enabled: true } : { provider: 'feishu', status: 'connected', configured: true, hasSecret: true, clientID: 'edited', ownerID: 'edited-owner' });
    const saving = owner.save(); await flush(); h.suspend(); h.resume(); await flush();
    gate.resolve({ provider: 'feishu', status: 'connected', configured: true, hasSecret: true }); await saving; await flush();
    expect(close).not.toHaveBeenCalled(); expect(owner.secret()).toBe('sensitive'); expect(owner.clientID()).toBe('edited');
    await owner.load(); expect(h.calls.filter(call => call.method === 'PUT')).toHaveLength(1); h.dispose();
  });
  it('channel ACK followed by failed GET never closes or replays PUT', async () => {
    const h = harness(), close = vi.fn();
    const owner = production('assistants-channels.tsx', 'ChannelPanel', h, 'load, clientID, ownerID, secret, save, busy, state, error')({ bot: { id: 'bot' }, provider: 'feishu', onClose: close });
    await flush(); owner.secret.set('sensitive');
    h.respond((path, method) => method === 'PUT' ? {} : path.endsWith('capability') ? { supported: true, enabled: true } : Promise.reject(Error('offline')));
    await owner.save(); expect(close).not.toHaveBeenCalled(); expect(owner.secret()).toBe('sensitive');
    await owner.save(); expect(h.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
    expect(owner.state().clientID).toBe('original'); h.dispose();
  });
  it('channel foreground read failure preserves fields and prior status', async () => {
    const h = harness();
    const owner = production('assistants-channels.tsx', 'ChannelPanel', h, 'load, clientID, ownerID, secret, state, error')({ bot: { id: 'bot' }, provider: 'feishu', get active() { return h.visible(); }, onClose() {} });
    await flush(); const prior = owner.state(); owner.clientID.set('dirty'); owner.ownerID.set('dirty-owner'); owner.secret.set('sensitive');
    h.suspend(); h.respond(() => Promise.reject(Error('offline'))); h.resume(); await flush();
    expect(owner.state()).toBe(prior); expect(owner.clientID()).toBe('dirty'); expect(owner.ownerID()).toBe('dirty-owner'); expect(owner.secret()).toBe('sensitive');
    h.visible.set(false); h.tick(); const count = h.calls.length; await owner.load(); expect(h.calls).toHaveLength(count); h.dispose();
  });
  it('settings capability continuation cannot borrow the replacement sender', async () => {
    const h = harness(), gate = deferred();
    h.respond(() => gate.promise);
    const owner = production('assistants-settings.tsx', 'AssistantSettings', h, 'load, loading, error')({ onCreate() {}, onEdit() {} });
    h.suspend(); h.resume(); gate.resolve({ supported: true, enabled: true }); await flush();
    const snapshots = h.calls.filter(call => call.path.endsWith('/snapshot'));
    expect(snapshots.every(call => call.generation === 2)).toBe(true); expect(snapshots).toHaveLength(1); h.dispose();
  });
  it('details stale confirmation cannot clear history on a new lease', async () => {
    const h = harness(), gate = deferred(); h.AlertDialog.show = () => gate.promise as Promise<{ action: string }>;
    const owner = production('assistants-details.tsx', 'AssistantDetails', h, 'clearHistory, clearing, historyError')({ bot: { id: 'bot' }, historyActions: { clearLabel: 'clear' }, onDone() {} });
    await flush(); const work = owner.clearHistory(); h.suspend(); h.resume(); gate.resolve({ action: 'clear' }); await work;
    expect(h.calls.filter(call => call.method === 'POST')).toHaveLength(0); expect(owner.clearing()).toBe(false); h.dispose();
  });
  it('details unknown reset only GETs on explicit retry', async () => {
    const h = harness(), gate = deferred();
    const owner = production('assistants-details.tsx', 'AssistantDetails', h, 'clearHistory, clearing, historyError')({ bot: { id: 'bot' }, historyActions: { clearLabel: 'clear' }, onDone() {} });
    await flush(); h.respond((path, method) => method === 'POST' ? gate.promise : path.endsWith('capability') ? { supported: true, enabled: true } : { tasks: [] });
    const work = owner.clearHistory(); await flush(); h.suspend(); h.resume(); gate.resolve({ assistantID: 'bot', reset: true, historyCleared: true, generation: 2 }); await work;
    await owner.clearHistory(); expect(h.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(h.calls.some(call => call.path.endsWith('/contact/messages?limit=1'))).toBe(true); h.dispose();
  });
  it('transfer ACK with no status adopts authoritative fields after GET recovery without replay', async () => {
    const h = harness(), close = vi.fn();
    const owner = production('assistants-channels.tsx', 'ChannelPanel', h, 'load, perform, clientID, ownerID, secret, state, error')({ bot: { id: 'bot' }, provider: 'feishu', onClose: close });
    await flush(); owner.secret.set('draft-secret');
    let offline = true;
    h.respond((path, method) => method === 'POST' ? {} : path.endsWith('capability') ? { supported: true, enabled: true } : offline ? Promise.reject(Error('offline')) : { provider: 'feishu', status: 'connected', configured: true, hasSecret: true, clientID: 'imported-client', ownerID: 'imported-owner' });
    await owner.perform('/transfer', 'POST', { sourceAssistantID: 'source', revision: 'r1' });
    expect(owner.secret()).toBe('draft-secret'); expect(owner.clientID()).toBe('original');
    offline = false; h.reconnect(); await flush();
    expect(owner.clientID()).toBe('imported-client'); expect(owner.ownerID()).toBe('imported-owner'); expect(owner.secret()).toBe(''); expect(owner.error()).toBe('');
    expect(h.calls.filter(call => call.method === 'POST')).toHaveLength(1); expect(close).not.toHaveBeenCalled(); h.dispose();
  });
  it('ordinary reconnect GET updates channel status while preserving the dirty form', async () => {
    const h = harness();
    const owner = production('assistants-channels.tsx', 'ChannelPanel', h, 'clientID, ownerID, secret, state')({ bot: { id: 'bot' }, provider: 'feishu', onClose() {} });
    await flush(); owner.clientID.set('dirty-client'); owner.ownerID.set('dirty-owner'); owner.secret.set('dirty-secret');
    h.respond(() => ({ provider: 'feishu', status: 'connected', configured: true, hasSecret: true, clientID: 'server-client', ownerID: 'server-owner' }));
    h.reconnect(); await flush(); expect(owner.state().clientID).toBe('server-client');
    expect(owner.clientID()).toBe('dirty-client'); expect(owner.ownerID()).toBe('dirty-owner'); expect(owner.secret()).toBe('dirty-secret'); h.dispose();
  });
  it('transfer ACK recovery preserves edits made after the failed GET', async () => {
    const h = harness();
    const owner = production('assistants-channels.tsx', 'ChannelPanel', h, 'load, perform, clientID, ownerID, secret, state')({ bot: { id: 'bot' }, provider: 'feishu', onClose() {} });
    await flush();
    h.respond((path, method) => method === 'POST' ? {} : path.endsWith('capability') ? { supported: true, enabled: true } : Promise.reject(Error('offline')));
    await owner.perform('/transfer', 'POST', { sourceAssistantID: 'source', revision: 'r1' });
    owner.clientID.set('new-draft'); owner.ownerID.set('new-owner'); owner.secret.set('new-secret');
    h.respond(() => ({ provider: 'feishu', status: 'connected', configured: true, hasSecret: true, clientID: 'imported-client', ownerID: 'imported-owner' }));
    await owner.load(); expect(owner.state().clientID).toBe('imported-client'); expect(owner.clientID()).toBe('new-draft'); expect(owner.ownerID()).toBe('new-owner'); expect(owner.secret()).toBe('new-secret');
    expect(h.calls.filter(call => call.method === 'POST')).toHaveLength(1); h.dispose();
  });
  it('late transfer result on a retired operation cannot replace the new draft or close', async () => {
    const h = harness(), close = vi.fn(), gate = deferred();
    const owner = production('assistants-channels.tsx', 'ChannelPanel', h, 'perform, clientID, ownerID, secret, state')({ bot: { id: 'bot' }, provider: 'feishu', onClose: close });
    await flush();
    h.respond((path, method) => method === 'POST' ? gate.promise : path.endsWith('capability') ? { supported: true, enabled: true } : { provider: 'feishu', status: 'connected', configured: true, hasSecret: true, clientID: 'imported-client', ownerID: 'imported-owner' });
    const work = owner.perform('/transfer', 'POST', { sourceAssistantID: 'source', revision: 'r1' }); await flush();
    h.suspend(); h.resume(); await flush(); owner.clientID.set('new-draft'); owner.secret.set('new-secret');
    gate.resolve({ provider: 'feishu', status: 'connected', configured: true, hasSecret: true, clientID: 'imported-client', ownerID: 'imported-owner' }); await work;
    expect(owner.clientID()).toBe('new-draft'); expect(owner.secret()).toBe('new-secret'); expect(close).not.toHaveBeenCalled();
    expect(h.calls.filter(call => call.method === 'POST')).toHaveLength(1); h.dispose();
  });
});
