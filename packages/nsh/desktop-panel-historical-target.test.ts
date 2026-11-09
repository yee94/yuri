import { expect, it, vi } from 'vitest';
import { createDesktopPanelTabs, normalizeDesktopPanelIntent, type DesktopPanelIntent, type DesktopPanelScope } from './desktop-panel-model';
import { decodeDesktopPanelMetadata, encodeDesktopPanelMetadata } from './desktop-panel-tabs-persistence';
import { createChangesReader } from './chat-changes-model';

const scope: DesktopPanelScope = { host: { hostID: 'A', lease: 'lease-A' }, authorityKey: 'authority-A', sessionID: 'parent', directory: '/parent' };
const source = (directory = '/other', sessionID = 'child') => ({ kind: 'turn' as const, directory, sessionID, messageID: 'tool-message', path: 'source.ts', files: [{ path: 'source.ts', before: 'FIXED BEFORE', after: 'FIXED AFTER' }] });

it.each(['/parent', '/other'])('read-only historical file tab preserves exact child target under parent owner %s without weakening diff/file scope', async directory => {
  const tabs = createDesktopPanelTabs(), target = source(directory);
  const id = tabs.open(scope, { kind: 'file-diff', source: target });
  const tab = tabs.snapshot(scope).tabs[0]; expect(tab).toMatchObject({ id, kind: 'file-diff', source: { directory, sessionID: 'child', messageID: 'tool-message', path: directory + '/source.ts' } });
  expect(() => tabs.open(scope, { kind: 'diff', source: target })).toThrow();
  if (directory !== scope.directory) expect(() => tabs.open(scope, { kind: 'file', path: directory + '/source.ts' })).toThrow();
  const read = vi.fn(async () => { throw new Error('No Git or fallback'); });
  if (tab.kind !== 'file-diff') throw new Error('wrong tab');
  const reader = createChangesReader(tab.source, read, () => true);
  await reader.select(tab.source.path);
  expect(reader.state().diff).toEqual({ path: directory + '/source.ts', before: 'FIXED BEFORE', after: 'FIXED AFTER' }); expect(read).not.toHaveBeenCalled();
  target.files[0].before = 'MUTATED CALLER'; expect(tab.source.files[0].before).toBe('FIXED BEFORE');
});

it('historical identity includes target directory/session/message/path, reuses an exact snapshot, and isolates distinct snapshots in process', () => {
  const tabs = createDesktopPanelTabs(), first = source(), id = tabs.open(scope, { kind: 'file-diff', source: first });
  expect(tabs.open(scope, { kind: 'file-diff', source: source() })).toBe(id);
  expect(tabs.open(scope, { kind: 'file-diff', source: { ...source(), files: [{ path: 'source.ts', before: 'OLDER', after: 'OTHER SNAPSHOT' }] } })).not.toBe(id);
  expect(tabs.open(scope, { kind: 'file-diff', source: source('/different') })).not.toBe(id);
  expect(tabs.open(scope, { kind: 'file-diff', source: source('/other', 'different') })).not.toBe(id);
  expect(tabs.snapshot(scope).tabs).toHaveLength(4);
  const revision = { ...source(), revision: 'fixed' };
  const fixed = tabs.open(scope, { kind: 'file-diff', source: revision });
  expect(tabs.open(scope, { kind: 'file-diff', source: { ...revision, targetLine: 9 } })).toBe(fixed);
  expect(tabs.open(scope, { kind: 'file-diff', source: { ...revision, files: [{ path: 'source.ts', before: 'DIFFERENT', after: 'DIFFERENT' }] } })).not.toBe(fixed);
});

it.each([
  { ...source(), kind: 'workspace' }, { ...source(), directory: '' }, { ...source(), sessionID: '' }, { ...source(), messageID: '\u0000' },
  { ...source(), path: '../outside.ts' }, { ...source(), files: [] }, { ...source(), files: [{ path: 'source.ts' }] },
  { ...source(), files: [{ path: '/parent/source.ts', before: '', after: '' }] }, { ...source(), files: [{ path: 'source.ts', before: {}, after: 'x' }] },
  { ...source(), targetLine: -1 }, { ...source(), revision: NaN },
  { ...source(), files: [{ path: 'source.ts', before: '', after: '' }, { path: './source.ts', before: 'different', after: 'different' }] },
])('malformed or non-fixed historical target cannot be admitted or change existing tabs %#', invalid => {
  const tabs = createDesktopPanelTabs(); tabs.open(scope, { kind: 'context' }); const prior = tabs.snapshot(scope);
  expect(() => tabs.open(scope, { kind: 'file-diff', source: invalid } as DesktopPanelIntent)).toThrow(); expect(tabs.snapshot(scope)).toBe(prior);
});

it('explicit empty fixed snapshots are valid; no historical bodies or fake restored tabs enter v1 metadata without a durable resolver', () => {
  const tabs = createDesktopPanelTabs(); tabs.open(scope, { kind: 'context' }); tabs.open(scope, { kind: 'file-diff', source: { ...source(), files: [{ path: 'source.ts', before: '', after: '' }] } });
  const raw = encodeDesktopPanelMetadata(tabs.metadata()); expect(raw).not.toContain('before'); expect(raw).not.toContain('file-diff');
  const restored = createDesktopPanelTabs(); restored.restoreMetadata(decodeDesktopPanelMetadata(raw)); expect(restored.snapshot(scope).tabs).toEqual([{ kind: 'context', id: 'context' }]);
  const forged = JSON.parse(raw); forged.scopes[0].tabs = [tabs.snapshot(scope).tabs[1]]; expect(() => decodeDesktopPanelMetadata(JSON.stringify(forged))).toThrow();
  expect(normalizeDesktopPanelIntent(scope, { kind: 'file-diff', source: source() })).toMatchObject({ source: { directory: '/other', sessionID: 'child' } });
});
