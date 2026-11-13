import { beforeEach, expect, it, vi } from 'vitest';
import { locationKey } from '@/lib/remote-projects/location';
import { useFilesViewTabsStore } from './useFilesViewTabsStore';
import { getContextPanelState, useUIStore } from './useUIStore';
import { useTerminalStore } from './useTerminalStore';

const io = vi.hoisted(() => ({ close: vi.fn() }));
vi.mock('@/lib/terminalApi', () => ({ closeTerminal: (...args: unknown[]) => io.close(...args) }));
const a = locationKey({ hubId: 'https://hub.example/a//b', hostId: 'ssh://host-a', directory: 'C:\\workspace\\project' });
const b = locationKey({ hubId: 'https://hub.example/a//b', hostId: 'ssh://host-b', directory: 'C:\\workspace\\project' });
const otherHub = locationKey({ hubId: 'https://other.example/a//b', hostId: 'ssh://host-a', directory: 'C:\\workspace\\project' });

beforeEach(() => {
  vi.clearAllMocks();
  useFilesViewTabsStore.setState({ byRoot: {} });
  useTerminalStore.setState({ sessions: new Map(), projectActionRuns: {} });
  useUIStore.setState({ contextPanelByDirectory: {}, contextToolDiffByDirectory: {}, isRightSidebarOpen: false });
});

it('isolates real file tab writes/selection/expansion and persistence while validating physical paths', () => {
  const store = useFilesViewTabsStore.getState();
  store.setSelectedPath(a, 'C:\\workspace\\project\\one.ts');
  store.expandPath(a, 'C:\\workspace\\project\\src');
  store.setSelectedPath(b, 'C:\\workspace\\project\\two.ts');
  store.setSelectedPath(otherHub, 'C:\\workspace\\project\\three.ts');
  store.addOpenPath(a, 'C:\\outside\\not-allowed.ts');
  store.setSelectedPath('C:/workspace/project', 'C:/workspace/project/local.ts');
  const persisted = useFilesViewTabsStore.persist.getOptions().partialize!(useFilesViewTabsStore.getState()) as Pick<ReturnType<typeof useFilesViewTabsStore.getState>, 'byRoot'>;
  expect(persisted.byRoot[a].selectedPath).toBe('C:/workspace/project/one.ts');
  expect(persisted.byRoot[a].expandedPaths).toEqual(['C:/workspace/project/src']);
  expect(persisted.byRoot[a].openPaths).toEqual(['C:/workspace/project/one.ts']);
  expect(persisted.byRoot[b].selectedPath).toBe('C:/workspace/project/two.ts');
  expect(persisted.byRoot[otherHub].selectedPath).toBe('C:/workspace/project/three.ts');
  expect(persisted.byRoot['C:/workspace/project'].selectedPath).toBe('C:/workspace/project/local.ts');
  expect(Object.keys(persisted.byRoot)).toContain(a);
  const restored = useFilesViewTabsStore.persist.getOptions().merge!({ ...persisted, byRoot: { ...persisted.byRoot, 'yuri-remote-location:bad-json': {} } }, useFilesViewTabsStore.getState());
  expect(restored.byRoot[a].selectedPath).toBe('C:/workspace/project/one.ts');
  expect(restored.byRoot[b].selectedPath).toBe('C:/workspace/project/two.ts');
  expect(restored.byRoot['yuri-remote-location:bad-json']).toBeUndefined();
});

it('keeps legacy local file root bytes and drops malformed persisted remote keys without losing valid roots', async () => {
  useFilesViewTabsStore.getState().setSelectedPath('C:/', 'C:/old.ts');
  const valid = useFilesViewTabsStore.persist.getOptions().partialize!(useFilesViewTabsStore.getState()) as Pick<ReturnType<typeof useFilesViewTabsStore.getState>, 'byRoot'>;
  const migrated = await useFilesViewTabsStore.persist.getOptions().migrate!({ byRoot: { ...valid.byRoot, 'yuri-remote-location:bad-json': {} } }, 1) as typeof valid;
  expect(Object.keys(migrated.byRoot)).toEqual(['C:/']);
  expect(migrated.byRoot['C:/'].selectedPath).toBe('C:/old.ts');
});

it('opens, selects, closes and restores independent real context panels for same-path Host and Hub identities', () => {
  const store = useUIStore.getState();
  store.openContextPreview(a, 'http://localhost:3000/a');
  store.setContextPanelWidth(a, 700);
  store.openContextBrowser(b, 'http://localhost:3000/b');
  store.openContextPanelTab(otherHub, { mode: 'file', targetPath: 'C:/workspace/project/c.ts' });
  store.closeContextPanel(b);
  const state = useUIStore.getState();
  expect(getContextPanelState(state, a)?.tabs[0].targetPath).toBe('http://localhost:3000/a');
  expect(getContextPanelState(state, a)?.width).toBe(700);
  expect(getContextPanelState(state, b)?.isOpen).toBe(false);
  expect(getContextPanelState(state, otherHub)?.isOpen).toBe(true);
  const serialized = JSON.stringify(useUIStore.persist.getOptions().partialize!(state));
  const restored = JSON.parse(serialized);
  expect(getContextPanelState(restored, a)?.tabs[0].targetPath).toBe('http://localhost:3000/a');
});

it('scopes terminal buffers and raw terminal close calls without calling the Hub for a remote ID', async () => {
  const store = useTerminalStore.getState();
  store.ensureDirectory(a); store.ensureDirectory(b); store.ensureDirectory(otherHub); store.ensureDirectory('/workspace');
  const ta = store.getActiveTab(a)!, tb = store.getActiveTab(b)!;
  store.setTabSessionId(a, ta.id, 'same-terminal');
  store.setTabSessionId(b, tb.id, 'same-terminal');
  store.appendToBuffer(a, ta.id, 'host-a output');
  expect(store.getActiveTab(b)?.bufferLength).toBe(0);
  expect(store.getActiveTab(a)?.bufferChunks[0].data).toBe('host-a output');
  const close = vi.fn().mockResolvedValue(undefined);
  await store.closeTab(a, ta.id, close);
  expect(close).toHaveBeenCalledWith('same-terminal');
  expect(io.close).not.toHaveBeenCalled();
  expect(store.getActiveTab(b)?.terminalSessionId).toBe('same-terminal');
  await expect(store.closeTab(b, tb.id)).rejects.toThrow('Host transport');
  expect(store.getActiveTab(b)?.terminalSessionId).toBe('same-terminal');
  await expect(store.closeTab(b, tb.id, async () => { throw new Error('host offline'); })).rejects.toThrow('host offline');
  expect(store.getActiveTab(b)?.terminalSessionId).toBe('same-terminal');
  expect(Array.from(useTerminalStore.getState().sessions.keys())).toEqual([a, b, otherHub, '/workspace']);
  const persisted = useTerminalStore.persist.getOptions().partialize!(useTerminalStore.getState());
  const restored = useTerminalStore.persist.getOptions().merge!(JSON.parse(JSON.stringify(persisted)), useTerminalStore.getState());
  expect(Array.from(restored.sessions.keys())).toEqual([a, b, otherHub, '/workspace']);
  expect(restored.sessions.get(b)?.tabs[0].terminalSessionId).toBe('same-terminal');
  expect(restored.sessions.get(b)?.tabs[0].bufferChunks).toEqual([]);
});
