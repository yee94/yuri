import { expect, it, vi } from 'vitest';
import { createDesktopPanelTabs, desktopPanelScopeKey, desktopPanelTabKey, normalizeDesktopPanelIntent, type DesktopPanelScope, type DesktopPanelIntent } from './desktop-panel-model';
import { createDesktopPanelTabsPersistence, decodeDesktopPanelMetadata, encodeDesktopPanelMetadata } from './desktop-panel-tabs-persistence';
const scope: DesktopPanelScope = { host: { hostID: 'A', lease: 'lease-A' }, authorityKey: 'authority-A', sessionID: 'parent', directory: '/parent' };
const chat = (sessionID = 'session', directory = '/other', title = 'Session', messageID = 'message'): DesktopPanelIntent => ({ kind: 'chat', target: { sessionID, directory, title, messageID } });

it('chat identity is exact session+canonical own directory, while title/message updates reuse one tab and retain parent ownership', () => {
  const notify = vi.fn(), tabs = createDesktopPanelTabs(notify), id = tabs.open(scope, chat());
  expect(id).toBe(JSON.stringify(['chat', '/other', 'session']));
  expect(tabs.open(scope, chat('session', '/other/', 'Updated', 'older'))).toBe(id);
  expect(tabs.snapshot(scope).tabs).toEqual([{ kind: 'chat', id, target: { sessionID: 'session', directory: '/other', title: 'Updated', messageID: 'older' } }]);
  const prior = tabs.snapshot(scope); notify.mockClear(); for (let i = 0; i < 50; i++) tabs.open(scope, chat('session', '/other', 'Updated', 'older'));
  expect(tabs.snapshot(scope)).toBe(prior); expect(notify).not.toHaveBeenCalled();
  expect(tabs.open(scope, chat('session', '/different'))).not.toBe(id); expect(tabs.open(scope, chat('different', '/other'))).not.toBe(id);
  expect(tabs.snapshot({ ...scope, directory: '/other' }).tabs).toEqual([]);
  expect(tabs.snapshot({ ...scope, sessionID: 'session' }).tabs).toEqual([]);
  expect(tabs.snapshot({ ...scope, authorityKey: 'different' }).tabs).toEqual([]);
});

it.each([
  {}, { sessionID: '', directory: '/other' }, { sessionID: 's', directory: '' }, { sessionID: 's', directory: 'relative' },
  { sessionID: 's\n', directory: '/other' }, { sessionID: 's', directory: '/other\u0000' }, { sessionID: 's', directory: '/other', messageID: '' },
  { sessionID: 's', directory: '/other', title: '\u0085' }, { sessionID: 's', directory: '/other', kind: 'assistant' },
  { kind: 'assistant', id: 'bot', directory: '/other' }, { sessionID: 's', directory: '/other', token: 'forbidden' },
  { sessionID: 's', directory: '/other', messageID: 'm'.repeat(8193) },
])('invalid/malicious chat target fails core normalization without changing the live tab collection: %#', target => {
  const tabs = createDesktopPanelTabs(); tabs.open(scope, chat()); const before = tabs.snapshot(scope);
  expect(() => tabs.open(scope, { kind: 'chat', target } as unknown as DesktopPanelIntent)).toThrow(); expect(tabs.snapshot(scope)).toBe(before);
});

it('version 1 mixed metadata round trips chat whitelist and omits leases, bodies and runtime state', () => {
  const tabs = createDesktopPanelTabs(); tabs.open(scope, { kind: 'context' }); tabs.open(scope, { kind: 'file', path: 'a.ts' }); const id = tabs.open(scope, chat());
  const raw = encodeDesktopPanelMetadata(tabs.metadata()); expect(raw).not.toContain('lease-A'); expect(raw).not.toContain('messages');
  const restored = createDesktopPanelTabs(); restored.restoreMetadata(decodeDesktopPanelMetadata(raw)); expect(restored.snapshot(scope)).toEqual(tabs.snapshot(scope));
  expect(restored.snapshot(scope).selectedID).toBe(id);
  const legacy = createDesktopPanelTabs(); legacy.open(scope, { kind: 'context' }); expect(decodeDesktopPanelMetadata(encodeDesktopPanelMetadata(legacy.metadata()))[0].tabs[0].kind).toBe('context');
});

it('chat codec rejects top-level/nested secrets, forged identity, assistant payload and duplicated canonical target', () => {
  const tabs = createDesktopPanelTabs(); tabs.open(scope, chat());
  for (const mutate of [
    (tab: Record<string, any>) => { tab.text = 'body'; }, (tab: Record<string, any>) => { tab.target.authorization = 'secret'; },
    (tab: Record<string, any>) => { tab.target.kind = 'assistant'; }, (tab: Record<string, any>) => { tab.target.sessionID = 'different'; },
    (tab: Record<string, any>) => { tab.id += 'forged'; }, (tab: Record<string, any>) => { tab.target.messageID = '\u0001'; },
  ]) {
    const rows = JSON.parse(JSON.stringify(tabs.metadata())); mutate(rows[0].tabs[0]); expect(() => decodeDesktopPanelMetadata(JSON.stringify({ version: 1, scopes: rows }))).toThrow();
  }
  const rows = tabs.metadata(); rows[0].tabs.push({ ...rows[0].tabs[0] }); expect(() => encodeDesktopPanelMetadata(rows)).toThrow();
});

it('late cold chat metadata cannot overwrite live locator updates or protected scopes; chat scopes keep existing LRU contract', async () => {
  const cold = createDesktopPanelTabs(); cold.open(scope, chat());
  let resolve!: (raw: string) => void; const disk = encodeDesktopPanelMetadata(cold.metadata());
  let value = disk; const storage = { getItem: vi.fn(async () => value), setItem: vi.fn(async (_key: string, raw: string) => { value = raw; }), removeItem: async () => {} };
  storage.getItem.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const live = createDesktopPanelTabs(), metadata = createDesktopPanelTabsPersistence(live, storage); const reading = metadata.restore();
  live.open(scope, chat('session', '/other', 'User title', 'user-locator')); resolve(disk); await reading;
  expect(live.snapshot(scope).tabs[0]).toMatchObject({ target: { messageID: 'user-locator', title: 'User title' } });
  const protectedTabs = createDesktopPanelTabs(() => {}, { scopeRestoreProtected: key => key === desktopPanelScopeKey(scope) }); protectedTabs.restoreMetadata(cold.metadata()); expect(protectedTabs.snapshot(scope).tabs).toEqual([]);
  for (let i = 0; i < 21; i++) live.open({ ...scope, sessionID: 'owner-' + i }, chat());
  expect(live.metadata()).toHaveLength(20); expect(live.snapshot(scope).tabs).toEqual([]);
  expect(normalizeDesktopPanelIntent(scope, chat('s', 'c:\\worktree\\'))).toMatchObject({ target: { directory: 'C:/worktree' } });
});
