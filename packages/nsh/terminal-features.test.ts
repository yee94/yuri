import { expect, it } from 'vitest';
import { createTerminalWorkspace, type TerminalSnapshot } from './terminal-core';
import { terminalCatalogFrom, type TerminalCatalog } from './terminal-catalog';
import { terminalActionInput } from './terminal-actions';
import { createTerminalPreviewScanner, terminalPreviewURL } from './terminal-preview';
const scope = { hostID: 'host-a', lease: '10000000-0000-4000-8000-000000000001' };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function setup(catalog?: unknown, extra: Partial<Parameters<typeof createTerminalWorkspace>[0]> = {}) {
  const calls: { name: string; body: Record<string, unknown> }[] = [], saved: TerminalCatalog[] = [];
  let state!: TerminalSnapshot, receive!: (event: unknown) => void;
  const { call: overrideCall, ...extraOptions } = extra;
  const controller = createTerminalWorkspace({ scope, catalog, subscribe: listener => { receive = listener; return () => {}; }, changed: value => { state = value; },
    wait: async () => {},
    persist: async value => { saved.push(JSON.parse(JSON.stringify(value))); },
    call: async (name, body) => { calls.push({ name, body }); if (overrideCall) return overrideCall(name, body); return name === 'terminal.create' ? { sessionId: `pty-${calls.filter(value => value.name === name).length}` } : name === 'terminal.close' || name === 'terminal.forceKill' ? { closed: true } : true; }, ...extraOptions });
  const tab = () => state.tabs.find(value => value.id === state.activeId)!;
  const event = (fields: Record<string, unknown>) => receive({ expectedHost: scope, owner: tab().id, sessionId: tab().sessionId, attachment: calls.filter(value => value.name === 'terminal.attach').at(-1)?.body.attachment, ...fields });
  const start = async () => { controller.setDirectory('/work/tree'); controller.setActive(true); controller.resize({ cols: 80, rows: 24 }); await flush(); event({ type: 'connected' }); await flush(); };
  return { controller, calls, saved, tab, event, start, state: () => state };
}
it('recovers metadata across a new workspace and lease; resumes PTY without storing output/commands/lease', async () => {
  const f = setup(); await f.start(); const first = f.tab().id;
  f.controller.renameTab(first, '开发', 'server'); f.event({ type: 'data', id: 1, cursor: 99, data: 'private-output' }); await f.controller.flushPersistence();
  const encoded = JSON.stringify(f.saved.at(-1)); expect(encoded).not.toContain('private-output'); expect(encoded).not.toContain(scope.lease);
  const recovered = setup(JSON.parse(encoded), { scope: { ...scope, lease: '10000000-0000-4000-8000-000000000002' } });
  recovered.controller.setDirectory('/work/tree'); recovered.controller.setActive(true); recovered.controller.resize({ cols: 100, rows: 30 }); await flush();
  expect(recovered.calls.map(value => value.name)).toEqual(['terminal.restore', 'terminal.attach']);
  expect(recovered.calls.at(-1)?.body).toMatchObject({ sessionId: 'pty-1', cursor: 0 }); expect(recovered.tab().label).toBe('开发'); expect(recovered.tab().chunks).toEqual([]);
  {
    const oldAttach = f.calls.find(value => value.name === 'terminal.attach')!.body;
    const newAttach = recovered.calls.find(value => value.name === 'terminal.attach')!.body;
    f.controller.dispose(); await flush();
    expect(f.calls.at(-1)).toMatchObject({ name: 'terminal.detach', body: { expectedHost: scope, owner: first, attachment: oldAttach.attachment } });
    expect(newAttach.attachment).not.toBe(oldAttach.attachment);
    expect(newAttach.owner).toBe(first);
  }
  expect(terminalCatalogFrom(JSON.parse(encoded), 'host-b')).toBeNull();
});
it('only authoritative missing restored PTY recreates; transient connect failure preserves receipt', async () => {
  const first = setup(); await first.start(); await first.controller.flushPersistence();
  const f = setup(first.saved.at(-1)); await f.start();
  f.event({ type: 'error', code: 'connection_failed' }); f.controller.retry(); await flush();
  expect(f.calls.filter(value => value.name === 'terminal.create')).toHaveLength(0);
  f.event({ type: 'error', code: 'session_not_found' }); await flush();
  expect(f.calls.filter(value => value.name === 'terminal.create')).toHaveLength(1);
});
it('reorders exact stable ids within one directory, persists order, preserves selected PTY and rejects alien ids', async () => {
  const f = setup(); await f.start(); const first = f.tab().id, second = f.controller.createTab()!;
  f.controller.resize({ cols: 80, rows: 24 }); await flush(); const third = f.controller.createTab()!;
  expect(f.controller.reorder(third, first)).toBe(true); expect(f.state().tabs.map(value => value.id)).toEqual([third, first, second]);
  expect(f.state().activeId).toBe(third); expect(f.controller.reorder('alien', first)).toBe(false);
  await f.controller.flushPersistence(); expect(f.saved.at(-1)?.directories[0].tabs.map(value => value.id)).toEqual([third, first, second]);
});
it('runs explicit action once after actual bind, preserves command normalization and keeps stop failures visible', async () => {
  const f = setup(); await f.start();
  const action = { id: 'dev', name: '开发', command: '  cmd\x1b[31m\r\nnext\x00  ', icon: 'server', autoOpenUrl: true };
  expect(f.controller.runAction(action)).toBe(true); expect(f.controller.runAction(action)).toBe(false);
  expect(f.calls.filter(value => value.name === 'terminal.input')).toHaveLength(0);
  f.controller.resize({ cols: 80, rows: 24 }); await flush(); f.event({ type: 'connected' }); await flush();
  expect(f.calls.filter(value => value.name === 'terminal.input').map(value => value.body.data)).toEqual([terminalActionInput(action)]);
  f.event({ type: 'connected' }); await flush(); expect(f.calls.filter(value => value.name === 'terminal.input')).toHaveLength(1);
  expect(f.tab().actionStatus).toBe('waiting-for-preview');
  expect(await f.controller.stopAction(f.tab().id)).toBe(true); expect(f.calls.filter(value => value.name === 'terminal.forceKill')).toHaveLength(1); expect(f.tab().phase).toBe('exited');
});
it('preview uses actual output lines, probes via owner, opens via captured Host and fences late probes', async () => {
  const opened: string[] = [], probes: string[] = [];
  const f = setup(undefined, { probePreview: async url => { probes.push(url); return true; }, openPreview: async (directory, url) => { opened.push(directory + ':' + url); } });
  await f.start(); f.event({ type: 'data', id: 1, data: '\x1b[32mready http://localhost:3000/' }); await flush(); expect(probes).toEqual([]);
  f.event({ type: 'data', id: 2, data: '\n' }); await flush(); expect(probes).toEqual(['http://localhost:3000/']);
  expect(await f.controller.openPreview(f.tab().id)).toBe(true); expect(opened).toEqual(['/work/tree:http://localhost:3000/']);
  let resolve!: (value: boolean) => void;
  const delayed = setup(undefined, { probePreview: () => new Promise(done => { resolve = done; }) }); await delayed.start();
  delayed.event({ type: 'data', id: 1, data: 'ready http://localhost:4000/\n' }); delayed.controller.setActive(false); resolve(true); await flush(); expect(delayed.tab().previewUrl).toBeUndefined();
  const scanner = createTerminalPreviewScanner(); expect(scanner.push('Serving HTTP on 0.0.0.0 port 8000\n')).toBe('http://127.0.0.1:8000/');
  expect(terminalPreviewURL('http://localhost:3000/?token=secret')).toBeNull(); expect(terminalPreviewURL('https://external.invalid')).toBeNull();
});
it('never runs action again after an uncertain input or failed journal write', async () => {
  let failing = false;
  const f = setup(undefined, { call: async name => name === 'terminal.create' ? { sessionId: 'test-pty' } : name === 'terminal.input' ? Promise.reject(new Error('unknown')) : true,
    persist: async () => { if (failing) throw new Error('disk'); } }); await f.start();
  f.controller.runAction({ id: 'test', name: 'test', command: 'configured-command' }); f.controller.resize({ cols: 80, rows: 24 }); await flush(); f.event({ type: 'connected' }); await flush();
  expect(f.tab().actionStatus).toBe('unknown'); expect(f.controller.runAction({ id: 'test', name: 'test', command: 'configured-command' })).toBe(false);
  failing = true; f.controller.createTab(); f.controller.resize({ cols: 80, rows: 24 }); await flush(); expect(f.state().persistenceError).toBe(true); expect(f.tab().createUnknown).toBe(true);
});
it('Action auto-open uses captured external owner once; auto-discover opens the same target in preview', async () => {
  const opened: { directory: string; url: string; mode: string }[] = [];
  const f = setup(undefined, { openPreview: async (directory, url, mode) => { opened.push({ directory, url, mode }); } });
  await f.start(); f.controller.runAction({ id: 'dev', name: 'dev', command: 'configured', autoOpenUrl: true });
  f.controller.resize({ cols: 80, rows: 24 }); await flush(); f.event({ type: 'connected' }); await flush();
  f.event({ type: 'data', id: 1, data: 'Open https://remote.invalid:4000/path' }); f.event({ type: 'data', id: 2, data: 'https://remote.invalid:4000/again' }); await flush();
  expect(opened).toEqual([{ directory: '/work/tree', url: 'https://remote.invalid:4000', mode: 'external' }]);
  f.controller.runAction({ id: '__yuri_auto_discover_preview__', name: 'auto', command: 'configured', autoOpenUrl: true });
  f.controller.resize({ cols: 80, rows: 24 }); await flush(); f.event({ type: 'connected' }); await flush();
  f.event({ type: 'data', id: 1, data: 'ready http://localhost:3000/' }); await flush();
  expect(opened.at(-1)).toEqual({ directory: '/work/tree', url: 'http://localhost:3000', mode: 'preview' });
  f.controller.dispose();
});
it('does not infer a replay gap from skipped native presentation ids when server cursor is contiguous', async () => {
  const f = setup(); await f.start();
  f.event({ type: 'data', id: 1, cursor: 1, data: 'first', replayGap: false });
  f.event({ type: 'data', id: 4, cursor: 2, data: 'replayed', replayGap: false });
  expect(f.tab().error).toBeUndefined(); expect(f.tab().replayCursor).toBe(2);
  f.event({ type: 'data', id: 5, cursor: 8, data: 'gap', replayGap: true }); expect(f.tab().error).toBe('replay_gap');
});
