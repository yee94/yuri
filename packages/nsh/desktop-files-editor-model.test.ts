import { describe, expect, test, vi } from 'vitest';
import { createDesktopEditors, desktopEditorDirty, type DesktopEditorOperation } from './desktop-files-editor-model';
import { createDesktopPanelTabs, desktopPanelScopeKey, type DesktopPanelScope } from './desktop-panel-model';

const scope: DesktopPanelScope = { host: { hostID: 'host-a', lease: 'lease-a' }, authorityKey: 'authority-a', sessionID: 'session-a', directory: '/workspace' };
function fixture(initial = 'initial\n', options: Parameters<typeof createDesktopEditors>[0] = {}) {
  const model = createDesktopEditors(options), handle = model.acquire(scope, 'source.ts');
  if (!handle) throw new Error('Expected editor');
  let wire = initial, mtime = 1, active = true, binary = false, failRead = false, statStatus = 0;
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  let write: ((body: unknown) => Promise<unknown>) | undefined;
  let pauseRead: (() => Promise<void>) | undefined;
  const operation: DesktopEditorOperation = { scope, current: () => active, request: async (path, method = 'GET', body) => {
    requests.push({ path, method, body });
    if (path.startsWith('/api/fs/stat?')) {
      if (statStatus) throw Object.assign(new Error('stat_rejected'), { status: statStatus });
      return { path: '/workspace/source.ts', isFile: true, size: wire.length, mtimeMs: mtime, isBinary: binary, mimeType: 'text/plain' };
    }
    if (path.startsWith('/api/fs/read?')) { if (pauseRead) await pauseRead(); if (failRead) throw new Error('read_offline'); return wire; }
    if (path === '/api/fs/write?directory=%2Fworkspace' && method === 'POST') {
      if (write) return write(body);
      wire = String((body as { content: string }).content); mtime++;
      return { success: true, path: '/workspace/source.ts' };
    }
    throw new Error('Unexpected file request: ' + path);
  } };
  return { model, document: handle.document, handle, operation, requests,
    wire: () => wire,
    remote(value: string) { wire = value; mtime++; },
    setActive(value: boolean) { active = value; }, setBinary(value: boolean) { binary = value; }, setFailRead(value: boolean) { failRead = value; },
    setWrite(value: typeof write) { write = value; }, setPauseRead(value: typeof pauseRead) { pauseRead = value; },
    setStatStatus(value: number) { statStatus = value; },
  };
}

describe('native desktop editable document authority', () => {
  test('cold protected documents may recover absent tab metadata, while adoption or direct edits veto late metadata without weakening eviction or close', () => {
    const source = createDesktopPanelTabs(); source.open(scope, { kind: 'file', path: '/workspace/source.ts' });
    const metadata = source.metadata(), key = desktopPanelScopeKey(scope);
    for (const action of ['cold', 'adopt', 'edit'] as const) {
      const model = createDesktopEditors();
      const seed = { text: 'Recovered draft', base: 'Host base', wire: 'Host base', eol: '\n' as const, bom: false, pending: null, conflict: false,
        loaded: true, readOnly: false, loading: false, saving: false, discarding: false, error: '' as const, detail: '', durability: 'ready' as const };
      expect(model.restore(scope, '/workspace/source.ts', seed)).toBe(true);
      const document = model.peek(scope, '/workspace/source.ts')!;
      if (action === 'adopt') model.acquire(scope, '/workspace/source.ts')!.release();
      if (action === 'edit') model.edit(document, 'Later live edit');
      const tabs = createDesktopPanelTabs(() => {}, { scopeProtected: model.scopeProtected, scopeRestoreProtected: model.scopeRestoreProtected });
      expect(model.scopeProtected(key)).toBe(true);
      expect(tabs.restoreMetadata(metadata)).toBe(action === 'cold');
      expect(tabs.snapshot(scope).tabs).toHaveLength(action === 'cold' ? 1 : 0);
      expect(document.state().text).toBe(action === 'edit' ? 'Later live edit' : 'Recovered draft');
      expect(model.dispose()).toBe(false);
      if (action === 'cold') expect(tabs.dispose()).toBe(false);
    }
  });
  test('uses real Host stat/read/write wire, preserves BOM/CRLF and deliberate empty edits', async () => {
    const f = fixture('\uFEFFone\r\ntwo\r\n');
    expect(await f.model.load(f.document, f.operation)).toBe(true);
    expect(f.document.state().text).toBe('one\ntwo\n');
    expect(f.model.edit(f.document, 'edited\n')).toBe(true);
    expect(await f.model.save(f.document, f.operation)).toBe(true);
    expect(f.wire()).toBe('\uFEFFedited\r\n');
    const post = f.requests.find(request => request.method === 'POST');
    expect(post).toEqual({ path: '/api/fs/write?directory=%2Fworkspace', method: 'POST', body: { path: '/workspace/source.ts', content: '\uFEFFedited\r\n' } });
    expect(desktopEditorDirty(f.document.state())).toBe(false);
    f.model.edit(f.document, ''); expect(await f.model.save(f.document, f.operation)).toBe(true);
    expect(f.wire()).toBe('\uFEFF');
  });
  test('failed reads preserve prior draft; a refresh cannot replace edits made during its GET', async () => {
    const f = fixture(); await f.model.load(f.document, f.operation); f.model.edit(f.document, 'unsaved');
    f.setFailRead(true); expect(await f.model.load(f.document, f.operation, true)).toBe(false);
    expect(f.document.state()).toMatchObject({ text: 'unsaved', base: 'initial\n', error: 'read' });
    f.setFailRead(false);
    let release!: () => void;
    f.setPauseRead(() => new Promise<void>(resolve => { release = resolve; }));
    const refresh = f.model.load(f.document, f.operation, true);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.model.edit(f.document, 'newer unsaved'); release(); await refresh;
    expect(f.document.state().text).toBe('newer unsaved');
  });
  test('edits continue during save and only the captured saved text becomes the baseline', async () => {
    const f = fixture(); await f.model.load(f.document, f.operation); f.model.edit(f.document, 'first edit');
    let release!: () => void;
    f.setWrite(async body => {
      await new Promise<void>(resolve => { release = resolve; });
      f.remote((body as { content: string }).content);
      return { success: true, path: '/workspace/source.ts' };
    });
    const saving = f.model.save(f.document, f.operation);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(f.document.state().saving).toBe(true);
    f.model.edit(f.document, 'second edit'); release();
    expect(await saving).toBe(false);
    expect(f.document.state()).toMatchObject({ base: 'first edit', text: 'second edit', pending: null });
    expect(f.wire()).toBe('first edit'); expect(f.model.dirty(f.document)).toBe(true);
  });
  test('Host changes in preflight and explicit 409/412 conflicts never overwrite local text', async () => {
    const f = fixture(); await f.model.load(f.document, f.operation); f.model.edit(f.document, 'local'); f.remote('external');
    expect(await f.model.save(f.document, f.operation)).toBe(false);
    expect(f.document.state()).toMatchObject({ text: 'local', error: 'conflict' });
    expect(f.requests.some(request => request.method === 'POST')).toBe(false);
    for (const status of [409, 412]) {
      const rejected = fixture(); await rejected.model.load(rejected.document, rejected.operation); rejected.model.edit(rejected.document, 'local');
      rejected.setWrite(async () => { throw Object.assign(new Error('version_conflict'), { status }); });
      await rejected.model.save(rejected.document, rejected.operation);
      expect(rejected.document.state()).toMatchObject({ text: 'local', error: 'conflict', pending: null });
    }
  });
  test('lost write response is read-reconciled once; an unchanged remote is not a negative receipt or license to replay', async () => {
    for (const applied of [true, false]) {
      const f = fixture(); await f.model.load(f.document, f.operation); f.model.edit(f.document, 'saved target');
      f.setWrite(async body => { if (applied) f.remote((body as { content: string }).content); throw new Error('transport_lost'); });
      expect(await f.model.save(f.document, f.operation)).toBe(false);
      expect(f.document.state().error).toBe('unknown');
      expect(await f.model.discard(f.document)).toBe(false);
      expect(await f.model.save(f.document, f.operation)).toBe(applied);
      if (!applied) expect(await f.model.save(f.document, f.operation)).toBe(false);
      expect(f.requests.filter(request => request.method === 'POST').length).toBe(1);
      expect(f.document.state().pending === null).toBe(applied);
    }
  });
  test('invalid receipt is never success; an authoritative post-write mismatch is a conflict', async () => {
    const f = fixture(); await f.model.load(f.document, f.operation); f.model.edit(f.document, 'local');
    f.setWrite(async () => ({ success: true }));
    expect(await f.model.save(f.document, f.operation)).toBe(false); expect(f.document.state().error).toBe('unknown');
    const changed = fixture(); await changed.model.load(changed.document, changed.operation); changed.model.edit(changed.document, 'local');
    changed.setWrite(async () => { changed.remote('someone else'); return { success: true, path: '/workspace/source.ts' }; });
    expect(await changed.model.save(changed.document, changed.operation)).toBe(false); expect(changed.document.state().error).toBe('conflict');
  });
  test('unknown POST then failed verification GET never releases pending or permits a replay', async () => {
    for (const status of [401, 404, 409, 412]) {
      const f = fixture('base'); await f.model.load(f.document, f.operation); f.model.edit(f.document, 'local');
      f.setWrite(async () => { throw new Error('transport_unknown'); });
      expect(await f.model.save(f.document, f.operation)).toBe(false);
      const pending = f.document.state().pending;
      f.setStatStatus(status);
      expect(await f.model.save(f.document, f.operation)).toBe(false);
      expect(f.document.state()).toMatchObject({ pending, error: 'unknown', text: 'local' });
      expect(await f.model.discard(f.document)).toBe(false);
      f.setStatStatus(0); f.remote('base');
      expect(await f.model.save(f.document, f.operation)).toBe(false);
      expect(f.document.state().pending).toBe(pending);
      // Another session is also fenced by this retained uncertain writer.
      const otherScope = { ...scope, sessionID: 'other' }, other = f.model.acquire(otherScope, 'source.ts')!;
      const otherOperation = { ...f.operation, scope: otherScope };
      await f.model.load(other.document, otherOperation); f.model.edit(other.document, 'other draft');
      expect(await f.model.save(other.document, otherOperation)).toBe(false);
      expect(other.document.state().detail).toBe('desktop_file_write_in_progress');
      expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(1);
      // Only authoritative positive readback may settle the pending write.
      f.remote('local'); expect(await f.model.save(f.document, f.operation)).toBe(true);
      expect(f.document.state().pending).toBeNull();
      expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    }
  });
  test('only POST negative receipts clear pending; verification HTTP failures do not', async () => {
    for (const status of [401, 404]) {
      const f = fixture(); await f.model.load(f.document, f.operation); f.model.edit(f.document, 'local');
      f.setWrite(async () => { throw Object.assign(new Error('post_rejected'), { status }); });
      expect(await f.model.save(f.document, f.operation)).toBe(false);
      expect(f.document.state()).toMatchObject({ error: 'write', pending: null, text: 'local' });
      f.setWrite(undefined); expect(await f.model.save(f.document, f.operation)).toBe(true);
      expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(2);
    }
  });
  test('even an ACK followed by a failed readback retains pending until successful verification', async () => {
    for (const status of [401, 404]) {
      const f = fixture('base'); await f.model.load(f.document, f.operation); f.model.edit(f.document, 'local');
      f.setWrite(async () => {
        f.remote('local'); f.setStatStatus(status);
        return { success: true, path: '/workspace/source.ts' };
      });
      expect(await f.model.save(f.document, f.operation)).toBe(false);
      expect(f.document.state()).toMatchObject({ pending: { text: 'local', wire: 'local' }, error: 'unknown' });
      f.setStatStatus(0); f.remote('base');
      expect(await f.model.save(f.document, f.operation)).toBe(false);
      expect(f.document.state().pending).not.toBeNull();
      f.remote('local'); expect(await f.model.save(f.document, f.operation)).toBe(true);
      expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    }
  });
  test('same-identity lease renewal retains a draft; changed origin or authorization cannot admit the old document', async () => {
    for (const authorityKey of ['changed-origin', 'changed-authorization']) {
      const f = fixture('base'); await f.model.load(f.document, f.operation); f.model.edit(f.document, 'draft-A');
      const renewed = { ...scope, host: { ...scope.host, lease: 'renewed' } };
      expect(f.model.acquire(renewed, 'source.ts')?.document).toBe(f.document);
      expect(f.model.admitted(f.document, { ...f.operation, scope: renewed })).toBe(true);
      const changed = { ...renewed, authorityKey }, operation = { ...f.operation, scope: changed };
      const other = f.model.acquire(changed, 'source.ts')!;
      expect(other.document).not.toBe(f.document);
      expect(f.model.admitted(f.document, operation)).toBe(false);
      const before = f.requests.length;
      expect(await f.model.load(f.document, operation, true)).toBe(false);
      expect(await f.model.save(f.document, operation)).toBe(false);
      expect(f.requests).toHaveLength(before);
      await f.model.load(other.document, operation);
      expect(other.document.state()).toMatchObject({ base: 'base', text: 'base' });
      expect(f.model.peek(scope, 'source.ts')?.state().text).toBe('draft-A');
      expect(f.model.scopeProtected(desktopPanelScopeKey(scope))).toBe(true);
      expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(0);
      // Returning to the original authority, with its renewed lease, can save A.
      expect(await f.model.save(f.document, { ...f.operation, scope: renewed })).toBe(true);
      expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    }
  });
  test('Host retirement before POST cancels writes; an old exact ACK cannot clear another Host/session document', async () => {
    const f = fixture(); await f.model.load(f.document, f.operation); f.model.edit(f.document, 'local');
    let release!: () => void;
    f.setPauseRead(() => new Promise<void>(resolve => { release = resolve; }));
    const saving = f.model.save(f.document, f.operation);
    await vi.waitFor(() => expect(release).toBeTypeOf('function')); f.setActive(false); release();
    await saving; expect(f.requests.some(request => request.method === 'POST')).toBe(false);
    const g = fixture(); await g.model.load(g.document, g.operation); g.model.edit(g.document, 'host-a-edit');
    g.setWrite(async () => { await new Promise<void>(resolve => { release = resolve; }); return { success: true, path: '/workspace/source.ts' }; });
    const old = g.model.save(g.document, g.operation);
    await vi.waitFor(() => expect(g.document.state().pending).not.toBeNull());
    const other = g.model.acquire({ ...scope, host: { hostID: 'host-b', lease: 'lease-b' } }, 'source.ts');
    expect(other?.document.state().base).toBeNull(); g.setActive(false); release(); await old;
    expect(other?.document.state().base).toBeNull(); expect(g.document.state().base).toBe('host-a-edit');
  });
  test('binary, oversized and lossy UTF-8/mixed-newline documents never become editable', async () => {
    const binary = fixture(); binary.setBinary(true); await binary.model.load(binary.document, binary.operation);
    expect(binary.document.state().readOnly).toBe(true); expect(binary.requests.some(request => request.path.startsWith('/api/fs/read?'))).toBe(false);
    for (const wire of ['one\r\ntwo\n', 'bad\0text', 'bad\uFFFDtext', 'bad\uD800text']) {
      const f = fixture(wire); await f.model.load(f.document, f.operation);
      expect(f.document.state().readOnly).toBe(true); expect(f.model.edit(f.document, 'replacement')).toBe(false);
      expect(await f.model.save(f.document, f.operation)).toBe(false);
    }
    const large = fixture('too large', { text: 3 }); await large.model.load(large.document, large.operation);
    expect(large.document.state().readOnly).toBe(true);
  });
  test('50 edits make no network request or protection scan; dirty boundary notifications remain narrow', async () => {
    let boundaries = 0;
    const f = fixture('base', { onProtectionChange: () => boundaries++ }); await f.model.load(f.document, f.operation);
    const calls = f.requests.length;
    for (let i = 0; i < 50; i++) f.model.edit(f.document, 'edit-' + i);
    expect(f.requests.length).toBe(calls); expect(boundaries).toBe(1);
    f.model.edit(f.document, 'base'); expect(boundaries).toBe(2);
  });
  test('the same Host file cannot receive concurrent local writes from two session drafts', async () => {
    const f = fixture(); await f.model.load(f.document, f.operation); f.model.edit(f.document, 'first session');
    const otherScope = { ...scope, sessionID: 'other-session' }, other = f.model.acquire(otherScope, 'source.ts');
    if (!other) throw new Error('Expected editor');
    const otherOperation = { ...f.operation, scope: otherScope };
    await f.model.load(other.document, otherOperation); f.model.edit(other.document, 'second session');
    let release!: () => void;
    f.setWrite(async body => { await new Promise<void>(resolve => { release = resolve; }); f.remote((body as { content: string }).content); return { success: true, path: '/workspace/source.ts' }; });
    const first = f.model.save(f.document, f.operation);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(await f.model.save(other.document, otherOperation)).toBe(false);
    expect(other.document.state().detail).toBe('desktop_file_write_in_progress');
    release(); await first;
    expect(await f.model.save(other.document, otherOperation)).toBe(false);
    expect(other.document.state().error).toBe('conflict');
    expect(f.requests.filter(request => request.method === 'POST').length).toBe(1);
  });
  test('filesystem mutation admission fences saves across sessions while preserving edits made after a mutation POST', async () => {
    const f = fixture('base'); await f.model.load(f.document, f.operation);
    const release = f.model.beginMutation(scope, '/workspace/source.ts'); expect(release).toBeTypeOf('function');
    expect(f.model.edit(f.document, 'edit during rename/delete')).toBe(true);
    expect(await f.model.save(f.document, f.operation)).toBe(false);
    expect(f.document.state().detail).toBe('desktop_file_mutation_in_progress');
    expect(f.requests.some(request => request.method === 'POST')).toBe(false);
    f.model.invalidate(f.document);
    expect(f.document.state()).toMatchObject({ text: 'edit during rename/delete', error: 'conflict' });
    expect(f.model.protected(f.document)).toBe(true); release!();
  });
});

describe('bounded document and tab lifetimes', () => {
  test('clean detached entries evict by access; dirty ones survive scope/lease/Host changes and refuse overflow', async () => {
    const f = fixture('base', { documents: 2 }); await f.model.load(f.document, f.operation); f.model.edit(f.document, 'dirty'); f.handle.release();
    const second = f.model.acquire({ ...scope, sessionID: 'session-b' }, 'source.ts'); second?.release();
    const third = f.model.acquire({ ...scope, host: { hostID: 'other', lease: 'other' } }, 'source.ts');
    expect(third).not.toBeNull();
    expect(f.model.peek(scope, 'source.ts')?.state().text).toBe('dirty');
    expect(f.model.peek({ ...scope, sessionID: 'session-b' }, 'source.ts')).toBeUndefined();
    expect(f.model.acquire({ ...scope, directory: '/other' }, 'source.ts')).toBeNull();
    const renewed = f.model.acquire({ ...scope, host: { ...scope.host, lease: 'renewed' } }, 'source.ts');
    expect(renewed?.document).toBe(f.document); expect(f.model.dispose()).toBe(false);
    expect(f.model.stats().documents).toBe(2);
  });
  test('byte limits reject a new oversized edit without erasing the accepted dirty draft', async () => {
    const f = fixture('base', { bytes: 60 }); await f.model.load(f.document, f.operation);
    expect(f.model.edit(f.document, 'accepted')).toBe(true);
    expect(f.model.edit(f.document, 'x'.repeat(40))).toBe(false);
    expect(f.document.state()).toMatchObject({ text: 'accepted', error: 'capacity' });
    expect(f.model.stats().bytes).toBeLessThanOrEqual(60);
  });
  test('UTF-8 wire limits include multibyte text and never write an unpaired surrogate', async () => {
    for (const text of ['汉字汉字', 'bad\uD800']) {
      const f = fixture('base', { text: 10 }); await f.model.load(f.document, f.operation);
      expect(f.model.edit(f.document, text)).toBe(true);
      expect(await f.model.save(f.document, f.operation)).toBe(false);
      expect(f.document.state()).toMatchObject({ text, error: 'capacity' });
      expect(f.requests.some(request => request.method === 'POST')).toBe(false);
    }
  });
  test('tabs core close/dispose cannot bypass dirty protection, and scope LRU cannot evict 20 pinned scopes', () => {
    const pinned = new Set<string>();
    const tabs = createDesktopPanelTabs(() => {}, { scopeProtected: key => pinned.has(key), canClose: owner => !pinned.has(desktopPanelScopeKey(owner)) });
    for (let i = 0; i < 20; i++) { const owner = { ...scope, sessionID: 'session-' + i }; tabs.open(owner, { kind: 'file', path: 'source.ts' }); pinned.add(desktopPanelScopeKey(owner)); }
    const first = { ...scope, sessionID: 'session-0' }, id = tabs.snapshot(first).selectedID!;
    expect(tabs.close(first, id)).toBe(false); expect(tabs.dispose()).toBe(false);
    expect(() => tabs.open({ ...scope, sessionID: 'overflow' }, { kind: 'context' })).toThrow('desktop_panel_scope_capacity');
    expect(tabs.snapshot(first).selectedID).toBe(id);
    pinned.delete(desktopPanelScopeKey(first)); expect(tabs.close(first, id)).toBe(true);
    tabs.open({ ...scope, sessionID: 'overflow' }, { kind: 'context' });
  });
});
