import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getContextPanelState, useUIStore } from './useUIStore';

const runtime = vi.hoisted(() => ({ key: 'runtime-a' }));
vi.mock('@/lib/runtime-switch', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtime-switch')>(),
  getRuntimeKey: () => runtime.key,
}));

beforeEach(() => {
  runtime.key = 'runtime-a';
  useUIStore.setState({
    contextPanelByDirectory: {},
    contextToolDiffByDirectory: {},
    sessionWorkspacePanelById: {},
    isRightSidebarOpen: false,
    isMobile: false,
    activeMainTab: 'chat',
    rightSidebarTab: 'git',
    pendingFileFocusPath: null,
    pendingFileViewerMode: null,
    pendingFileNavigation: null,
    mainTabGuard: null,
  });
});

describe('useUIStore context panel tabs', () => {
  test.each(['file', 'line'] as const)('transcript %s navigation hides the rail only after the guard resumes it', (kind) => {
    const store = useUIStore.getState();
    store.openContextFile('/repo', '/repo/a.ts');
    store.setRightSidebarTab('files');
    store.setRightSidebarWidth(420);
    store.setRightSidebarOpen(true);
    const original = useUIStore.getState().contextPanelByDirectory['/repo'];
    let resume: (() => void) | undefined;
    store.setMainTabGuard((_tab, continueNavigation) => { resume = continueNavigation; return false; });
    if (kind === 'line') {
      store.openContextFileAtLine('/repo', '/repo/report.eficy', 12, 3, { closeFileTree: true });
    } else {
      store.openContextFile('/repo', '/repo/report.eficy', { closeFileTree: true });
    }
    expect(useUIStore.getState().isRightSidebarOpen).toBe(true);
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toBe(original);
    expect(resume).toBeTypeOf('function');
    store.setMainTabGuard(null);
    resume?.();
    const current = useUIStore.getState();
    expect(current).toMatchObject({ isRightSidebarOpen: false, rightSidebarTab: 'files', rightSidebarWidth: 420 });
    expect(current.contextPanelByDirectory['/repo']).toMatchObject({ isOpen: true, activeView: 'preview' });
    expect(current.contextPanelByDirectory['/repo'].tabs.map((tab) => tab.targetPath)).toEqual(['/repo/a.ts', '/repo/report.eficy']);
    if (kind === 'line') {
      expect(current.pendingFileNavigation).toEqual({ path: '/repo/report.eficy', line: 12, column: 3 });
    }
    store.setRightSidebarOpen(true);
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].activeView).toBe('rail');
  });

  test.each(['file', 'line'] as const)('ordinary %s navigation and mobile requests preserve rail visibility', (kind) => {
    const store = useUIStore.getState();
    store.setRightSidebarOpen(true);
    if (kind === 'line') store.openContextFileAtLine('/repo', '/repo/a.ts', 7);
    else store.openContextFile('/repo', '/repo/a.ts');
    expect(useUIStore.getState().isRightSidebarOpen).toBe(true);
    useUIStore.setState({ isMobile: true });
    if (kind === 'line') store.openContextFileAtLine('/repo', '/repo/b.ts', 7, 1, { closeFileTree: true });
    else store.openContextFile('/repo', '/repo/b.ts', { closeFileTree: true });
    expect(useUIStore.getState().isRightSidebarOpen).toBe(true);
  });

  test('invalid transcript file navigation leaves the rail open', () => {
    const store = useUIStore.getState();
    store.setRightSidebarOpen(true);
    const before = useUIStore.getState();
    store.openContextFile('', '/repo/report.eficy', { closeFileTree: true });
    store.openContextFileAtLine('/repo', '', 7, 1, { closeFileTree: true });
    expect(useUIStore.getState()).toBe(before);
  });

  test('commits compact rail/preview navigation synchronously with each action', () => {
    const store = useUIStore.getState();
    store.openContextFile('/repo', '/repo/a.ts');
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toMatchObject({ activeView: 'preview' });
    store.setRightSidebarOpen(true);
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toMatchObject({ activeView: 'rail' });
    const tabId = useUIStore.getState().contextPanelByDirectory['/repo'].activeTabId!;
    store.setActiveContextPanelTab('/repo', tabId);
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toMatchObject({ activeView: 'preview' });
    store.setRightSidebarTab('files');
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toMatchObject({ activeView: 'rail' });
    store.closeContextPanel('/repo');
    store.openContextPanel('/repo');
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toMatchObject({ activeView: 'rail' });
  });

  test.each(['toggleContextPanel', 'closeContextPanel', 'closeActiveContextPanelTab'] as const)('%s closes the initial derived panel before any layout write', (action) => {
    useUIStore.setState({ isRightSidebarOpen: true });
    expect(getContextPanelState(useUIStore.getState(), '/repo')?.isOpen).toBe(true);
    useUIStore.getState()[action]('/repo');
    expect(getContextPanelState(useUIStore.getState(), '/repo')?.isOpen).toBe(false);
  });

  test('retains compact focus across sessions but excludes it from persisted layout', async () => {
    const store = useUIStore.getState();
    store.openContextFile('/repo', '/repo/a.ts');
    store.syncWorkspacePanelsForSessionSwitch({ previousSessionId: 'a', nextSessionId: 'b', previousDirectory: '/repo', nextDirectory: '/repo' });
    store.syncWorkspacePanelsForSessionSwitch({ previousSessionId: 'b', nextSessionId: 'a', previousDirectory: '/repo', nextDirectory: '/repo' });
    expect(getContextPanelState(useUIStore.getState(), '/repo')?.activeView).toBe('preview');
    const options = useUIStore.persist.getOptions();
    const saved = options.partialize!(useUIStore.getState());
    expect(saved).not.toHaveProperty('contextPanelByDirectory./repo.activeView');
    const restored = await options.migrate!(saved, options.version!) as Partial<ReturnType<typeof useUIStore.getState>>;
    useUIStore.setState(restored);
    expect(getContextPanelState(useUIStore.getState(), '/repo')?.activeView).toBeUndefined();
    expect(getContextPanelState(useUIStore.getState(), '/repo')?.tabs[0].targetPath).toBe('/repo/a.ts');
  });

  test('isolates opened tabs between sessions in the same project and restores each selection', () => {
    const store = useUIStore.getState();
    const switchSession = (previousSessionId: string, nextSessionId: string) => store.syncWorkspacePanelsForSessionSwitch({
      previousSessionId, nextSessionId, previousDirectory: '/repo', nextDirectory: '/repo',
    });
    store.openContextFile('/repo', '/repo/a.ts');
    store.openContextPanelTab('/repo', { mode: 'chat', dedupeKey: 'session:child-a' });
    const panelA = useUIStore.getState().contextPanelByDirectory['/repo'];
    switchSession('a', 'b');
    store.openContextFile('/repo', '/repo/b.ts');
    const panelB = useUIStore.getState().contextPanelByDirectory['/repo'];
    expect(panelB.tabs.map((tab) => tab.targetPath)).toEqual(['/repo/b.ts']);
    switchSession('b', 'a');
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toMatchObject({ tabs: panelA.tabs, activeTabId: panelA.activeTabId });
    store.closeActiveContextPanelTab('/repo');
    switchSession('a', 'b');
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toMatchObject({ tabs: panelB.tabs, activeTabId: panelB.activeTabId });
  });

  test('restores closed tabs, their order and geometry without inheriting another session edits', () => {
    const store = useUIStore.getState();
    store.openContextFile('/repo', '/repo/a.ts');
    store.openContextFile('/repo', '/repo/b.ts');
    const [a, b] = useUIStore.getState().contextPanelByDirectory['/repo'].tabs;
    store.reorderContextPanelTabs('/repo', b.id, a.id);
    store.setActiveContextPanelTab('/repo', a.id);
    store.setContextPanelWidth('/repo', 720);
    store.toggleContextPanelExpanded('/repo');
    store.closeContextPanel('/repo');
    const expected = useUIStore.getState().contextPanelByDirectory['/repo'];
    store.syncWorkspacePanelsForSessionSwitch({ previousSessionId: 'a', nextSessionId: 'b', previousDirectory: '/repo/', nextDirectory: '/repo' });
    store.openContextFile('/repo', '/repo/a.ts');
    store.setContextPanelWidth('/repo', 400);
    store.closeActiveContextPanelTab('/repo');
    store.syncWorkspacePanelsForSessionSwitch({ previousSessionId: 'b', nextSessionId: 'a', previousDirectory: '/repo', nextDirectory: '/repo/' });
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toBe(expected);
    store.openContextPanel('/repo');
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].tabs.map((tab) => tab.id)).toEqual([b.id, a.id]);
  });

  test('isolates exact tool diffs and clears pending file navigation on session switches', () => {
    const store = useUIStore.getState();
    const switchSession = (previousSessionId: string, nextSessionId: string) => store.syncWorkspacePanelsForSessionSwitch({
      previousSessionId, nextSessionId, previousDirectory: '/repo', nextDirectory: '/repo',
    });
    store.openContextToolDiff('/repo', 'a.ts', [{ path: 'a.ts', patch: 'patch-a' }], 3, 'turn-a');
    const diffA = useUIStore.getState().contextToolDiffByDirectory['/repo'];
    switchSession('a', 'b');
    expect(useUIStore.getState().contextToolDiffByDirectory['/repo']).toBeUndefined();
    store.openContextToolDiff('/repo', 'a.ts', [{ path: 'a.ts', patch: 'patch-b' }], 9, 'turn-b');
    const diffB = useUIStore.getState().contextToolDiffByDirectory['/repo'];
    store.openContextFileAtLine('/repo', '/repo/b.ts', 7);
    switchSession('b', 'a');
    expect(useUIStore.getState().contextToolDiffByDirectory['/repo']).toBe(diffA);
    expect(useUIStore.getState()).toMatchObject({ pendingFileFocusPath: null, pendingFileViewerMode: null, pendingFileNavigation: null });
    switchSession('a', 'b');
    expect(useUIStore.getState().contextToolDiffByDirectory['/repo']).toBe(diffB);
    const saved = useUIStore.persist.getOptions().partialize!(useUIStore.getState());
    expect(saved).not.toHaveProperty('sessionWorkspacePanelById');
    expect(saved).not.toHaveProperty('contextToolDiffByDirectory');
    store.prepareForRuntimeSwitch();
    switchSession('b', 'a');
    expect(useUIStore.getState().contextToolDiffByDirectory['/repo']).toBeUndefined();
  });

  test('keeps session snapshots isolated between runtimes with matching session ids and paths', () => {
    const store = useUIStore.getState();
    const switchSession = (previousSessionId: string | null, nextSessionId: string | null) => store.syncWorkspacePanelsForSessionSwitch({
      previousSessionId, nextSessionId, previousDirectory: '/repo', nextDirectory: '/repo',
    });
    store.openContextFile('/repo', '/repo/runtime-a.ts');
    switchSession('a', null);
    runtime.key = 'runtime-b';
    switchSession(null, 'a');
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].tabs).toEqual([]);
    store.openContextFile('/repo', '/repo/runtime-b.ts');
    switchSession('a', null);
    runtime.key = 'runtime-a';
    switchSession(null, 'a');
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].tabs.map((tab) => tab.targetPath)).toEqual(['/repo/runtime-a.ts']);
  });

  test('restores session tabs even when their directory projection was evicted and bounds snapshots', () => {
    const store = useUIStore.getState();
    store.openContextFile('/repo', '/repo/a.ts');
    store.syncWorkspacePanelsForSessionSwitch({ previousSessionId: 'a', nextSessionId: 'b', previousDirectory: '/repo', nextDirectory: '/other' });
    useUIStore.setState({ contextPanelByDirectory: {} });
    store.syncWorkspacePanelsForSessionSwitch({ previousSessionId: 'b', nextSessionId: 'a', previousDirectory: '/other', nextDirectory: '/repo' });
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].tabs.map((tab) => tab.targetPath)).toEqual(['/repo/a.ts']);
    for (let index = 0; index < 60; index++) {
      store.syncWorkspacePanelsForSessionSwitch({ previousSessionId: `session-${index}`, nextSessionId: `session-${index + 1}`, previousDirectory: '/repo', nextDirectory: '/repo' });
    }
    expect(Object.keys(useUIStore.getState().sessionWorkspacePanelById)).toHaveLength(40);
    const unchanged = useUIStore.getState();
    for (let index = 0; index < 50; index++) {
      store.syncWorkspacePanelsForSessionSwitch({ previousSessionId: 'session-60', nextSessionId: 'session-60', previousDirectory: '/repo', nextDirectory: '/repo' });
    }
    expect(useUIStore.getState()).toBe(unchanged);
  });

  test('derives the initial Git rail synchronously without writing layout during reads', () => {
    const initial = useUIStore.getInitialState();
    useUIStore.setState({
      isRightSidebarOpen: initial.isRightSidebarOpen,
      rightSidebarTab: initial.rightSidebarTab,
    });
    const store = useUIStore.getState();
    const initialPanel = getContextPanelState(store, '/repo/');
    expect(initialPanel).toMatchObject({ isOpen: true, tabs: [], activeTabId: null });
    store.syncWorkspacePanelsForSessionSwitch({
      previousSessionId: null,
      nextSessionId: 'first-session',
      nextDirectory: '/repo',
    });
    expect(useUIStore.getState()).toMatchObject({
      isRightSidebarOpen: true,
      rightSidebarTab: 'git',
      contextPanelByDirectory: {},
    });
    const unchanged = useUIStore.getState();
    for (let index = 0; index < 50; index++) expect(getContextPanelState(unchanged, '/repo')).toBe(initialPanel);
    expect(useUIStore.getState()).toBe(unchanged);
    store.syncWorkspacePanelsForSessionSwitch({ previousSessionId: 'first-session', previousDirectory: '/repo', nextSessionId: 'other-session', nextDirectory: '/repo' });
    expect(getContextPanelState(useUIStore.getState(), '/repo')?.isOpen).not.toBe(true);
    store.syncWorkspacePanelsForSessionSwitch({ previousSessionId: 'other-session', previousDirectory: '/repo', nextSessionId: 'first-session', nextDirectory: '/repo' });
    expect(getContextPanelState(useUIStore.getState(), '/repo')).toBe(initialPanel);
  });

  test('does not open the preview without a directory or with a saved closed rail', () => {
    const store = useUIStore.getState();
    store.setRightSidebarOpen(true);
    expect(getContextPanelState(useUIStore.getState(), '')).toBeUndefined();
    expect(useUIStore.getState().contextPanelByDirectory).toEqual({});
    store.setRightSidebarOpen(false);
    expect(getContextPanelState(useUIStore.getState(), '/repo')).toBeUndefined();
    store.syncWorkspacePanelsForSessionSwitch({ previousSessionId: null, nextSessionId: 'first-session', nextDirectory: '/repo' });
    expect(useUIStore.getState().contextPanelByDirectory).toEqual({});
    expect(useUIStore.getState().isRightSidebarOpen).toBe(false);
  });

  test.each([false, true])('preserves saved preview visibility (%s) and rail selection on startup', async (isOpen) => {
    const store = useUIStore.getState();
    store.openContextPanel('/repo');
    if (!isOpen) store.closeContextPanel('/repo');
    store.setRightSidebarTab('files');
    const options = useUIStore.persist.getOptions();
    const saved = options.partialize!(useUIStore.getState());
    const restored = await options.migrate!(saved, options.version!);
    useUIStore.setState(restored as Partial<ReturnType<typeof useUIStore.getState>>);
    const unchanged = useUIStore.getState();
    expect(getContextPanelState(useUIStore.getState(), '/repo')?.isOpen).toBe(isOpen);
    store.syncWorkspacePanelsForSessionSwitch({ previousSessionId: null, nextSessionId: 'first-session', nextDirectory: '/repo' });
    expect(useUIStore.getState()).toBe(unchanged);
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].isOpen).toBe(isOpen);
    expect(useUIStore.getState().rightSidebarTab).toBe('files');
  });

  test('allows a 240px inner rail while preserving its 360px default and manually resized width', () => {
    const store = useUIStore.getState();
    useUIStore.setState({ rightSidebarWidth: 360, hasManuallyResizedRightSidebar: false });
    store.setRightSidebarWidth(200);
    expect(useUIStore.getState().rightSidebarWidth).toBe(240);
    store.setRightSidebarWidth(280);
    store.setRightSidebarOpen(true);
    expect(useUIStore.getState().rightSidebarWidth).toBe(280);
    store.setRightSidebarOpen(false);
    store.toggleRightSidebar();
    expect(useUIStore.getState().rightSidebarWidth).toBe(280);
    useUIStore.setState({ isRightSidebarOpen: false, rightSidebarWidth: 240, hasManuallyResizedRightSidebar: false });
    store.setRightSidebarOpen(true);
    expect(useUIStore.getState().rightSidebarWidth).toBe(360);
    useUIStore.setState({ isRightSidebarOpen: false, rightSidebarWidth: 240, hasManuallyResizedRightSidebar: false });
    store.toggleRightSidebar();
    expect(useUIStore.getState().rightSidebarWidth).toBe(360);
  });

  test.each([280, 300, 380, 450])('clamps requested and restored preview width %ipx to at least 300px', async (width) => {
    const store = useUIStore.getState();
    store.openContextPanel('/repo');
    store.setContextPanelWidth('/repo', width);
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].width).toBe(Math.max(300, width));
    const saved = useUIStore.persist.getOptions().partialize!(useUIStore.getState()) as Pick<ReturnType<typeof useUIStore.getState>, 'contextPanelByDirectory'>;
    saved.contextPanelByDirectory = {
      ...saved.contextPanelByDirectory,
      '/repo': { ...saved.contextPanelByDirectory['/repo'], width },
    };
    const restored = await useUIStore.persist.getOptions().migrate!(saved, 7) as typeof saved;
    expect(restored.contextPanelByDirectory['/repo'].width).toBe(Math.max(300, width));
  });

  test('opens an empty preview independently and preserves cached files and unrelated roots when toggling', () => {
    const store = useUIStore.getState();
    store.openContextFile('/other', '/other/a.ts');
    const other = useUIStore.getState().contextPanelByDirectory['/other'];
    store.toggleContextPanel('/repo/');
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toMatchObject({ isOpen: true, tabs: [], activeTabId: null });
    expect(useUIStore.getState().isRightSidebarOpen).toBe(true);
    expect(useUIStore.getState().rightSidebarTab).toBe('git');
    store.openContextFile('/repo', '/repo/a.ts');
    const tabs = useUIStore.getState().contextPanelByDirectory['/repo'].tabs;
    store.toggleContextPanel('/repo');
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].isOpen).toBe(false);
    store.toggleContextPanel('/repo');
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toMatchObject({ isOpen: true, tabs });
    expect(useUIStore.getState().contextPanelByDirectory['/other']).toBe(other);
    const unchanged = useUIStore.getState();
    for (let index = 0; index < 50; index++) store.openContextPanel('/repo');
    expect(useUIStore.getState()).toBe(unchanged);
    store.openContextPanel('');
    expect(useUIStore.getState()).toBe(unchanged);
  });

  test('persists an intentionally empty preview and restores it when revisiting its session', async () => {
    const store = useUIStore.getState();
    store.openContextPanel('/repo');
    const saved = useUIStore.persist.getOptions().partialize!(useUIStore.getState()) as Pick<ReturnType<typeof useUIStore.getState>, 'contextPanelByDirectory'>;
    expect(saved.contextPanelByDirectory['/repo']).toMatchObject({ isOpen: true, tabs: [], activeTabId: null });
    const migrated = await useUIStore.persist.getOptions().migrate!(saved, 7) as typeof saved;
    expect(migrated.contextPanelByDirectory['/repo']).toMatchObject({ isOpen: true, tabs: [], activeTabId: null });
    store.syncWorkspacePanelsForSessionSwitch({ previousSessionId: 'a', previousDirectory: '/repo', nextSessionId: 'b', nextDirectory: '/repo' });
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].isOpen).toBe(false);
    store.syncWorkspacePanelsForSessionSwitch({ previousSessionId: 'b', previousDirectory: '/repo', nextSessionId: 'a', nextDirectory: '/repo' });
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toMatchObject({ isOpen: true, tabs: [], activeTabId: null });
  });

  test('keeps btw live while persisting only durable tabs and a valid active reference', () => {
    const store = useUIStore.getState();
    store.openContextPanelTab('/repo', { mode: 'btw' });
    const persist = () => useUIStore.persist.getOptions().partialize!(useUIStore.getState()) as Pick<ReturnType<typeof useUIStore.getState>, 'contextPanelByDirectory'>;
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].tabs[0].mode).toBe('btw');
    expect(persist().contextPanelByDirectory['/repo']).toMatchObject({ tabs: [], activeTabId: null, isOpen: false });
    store.openContextPanelTab('/repo', { mode: 'context' });
    store.openContextPanelTab('/repo', { mode: 'btw' });
    const persisted = persist().contextPanelByDirectory['/repo'];
    expect(persisted.tabs.map((tab) => tab.mode)).toEqual(['context']);
    expect(persisted.activeTabId).toBe(persisted.tabs[0].id);
    expect(persisted.isOpen).toBe(true);
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].tabs).toHaveLength(2);
  });
  test('runs a synchronous navigation guard once for a file reference', () => {
    let calls = 0;
    useUIStore.getState().setMainTabGuard(() => { calls += 1; return true; });
    useUIStore.getState().openContextFile('/repo', '/repo/B.ts');
    expect(calls).toBe(1);
    expect(useUIStore.getState().pendingFileFocusPath).toBe('/repo/B.ts');
  });

  test('defers a line reference and its pending intent until the existing guard resumes it', () => {
    const store = useUIStore.getState();
    store.openContextFile('/repo', '/repo/A.ts');
    store.setPendingFileFocusPath(null);
    const original = useUIStore.getState().contextPanelByDirectory['/repo'];
    let resume: (() => void) | undefined;
    store.setMainTabGuard((_tab, continueNavigation) => { resume = continueNavigation; return false; });
    store.openContextFileAtLine('/repo', '/repo/B.ts', 7, 2);
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toBe(original);
    expect(useUIStore.getState().pendingFileNavigation).toBeNull();
    expect(useUIStore.getState().pendingFileFocusPath).toBeNull();
    expect(resume).toBeTypeOf('function');
    store.setMainTabGuard(null);
    resume?.();
    const current = useUIStore.getState();
    const panel = current.contextPanelByDirectory['/repo'];
    expect(panel.tabs.find((tab) => tab.id === panel.activeTabId)?.targetPath).toBe('/repo/B.ts');
    expect(current.pendingFileNavigation).toEqual({ path: '/repo/B.ts', line: 7, column: 2 });
  });

  test('opens a turn-scoped file diff at the requested line', () => {
    const directory = '/repo';

    useUIStore.getState().openContextDiff(directory, 'src/app.ts', false, 'turn', 42, ' msg_turn_1 ', ' ses_child ');

    const tab = useUIStore.getState().contextPanelByDirectory[directory]?.tabs[0];
    expect(tab?.mode).toBe('diff');
    expect(tab?.targetPath).toBe('src/app.ts');
    expect(tab?.diffScope).toBe('turn');
    expect(tab?.diffTargetLine).toBe(42);
    expect(tab?.diffTurnMessageId).toBe('msg_turn_1');
    expect(tab?.diffSessionId).toBe('ses_child');

    useUIStore.getState().openContextDiff(directory, 'src/app.ts', false, 'turn', 7, 'msg_turn_2', 'ses_child_2');

    const reopenedTabs = useUIStore.getState().contextPanelByDirectory[directory]?.tabs ?? [];
    expect(reopenedTabs).toHaveLength(1);
    expect(reopenedTabs[0]?.diffTargetLine).toBe(7);
    expect(reopenedTabs[0]?.diffTurnMessageId).toBe('msg_turn_2');
    expect(reopenedTabs[0]?.diffSessionId).toBe('ses_child_2');
  });

  test('opens a file preview with a degraded turn-diff notice', () => {
    const directory = '/repo';

    useUIStore.getState().openContextFile(directory, '/Users/dev/.config/opencode/skills/clonedeps/SKILL.md', {
      fileNotice: 'turn-diff-outside-workspace',
    });

    const tab = useUIStore.getState().contextPanelByDirectory[directory]?.tabs[0];
    expect(tab?.mode).toBe('file');
    expect(tab?.targetPath).toBe('/Users/dev/.config/opencode/skills/clonedeps/SKILL.md');
    expect(tab?.fileNotice).toBe('turn-diff-outside-workspace');

    useUIStore.getState().openContextFile(directory, '/Users/dev/.config/opencode/skills/clonedeps/SKILL.md');

    const cleared = useUIStore.getState().contextPanelByDirectory[directory]?.tabs[0];
    expect(cleared?.fileNotice).toBe(null);
  });

  test('opens an html file with a pending preview viewer mode', () => {
    const directory = '/repo';

    useUIStore.getState().openContextFile(directory, '/repo/ignore/report.html', {
      viewerMode: 'preview',
    });

    expect(useUIStore.getState().pendingFileViewerMode).toBe('preview');
    expect(useUIStore.getState().pendingFileFocusPath).toBe('/repo/ignore/report.html');

    useUIStore.getState().openContextFile(directory, '/repo/src/a.ts');

    expect(useUIStore.getState().pendingFileViewerMode).toBe(null);
    expect(useUIStore.getState().pendingFileFocusPath).toBe('/repo/src/a.ts');
  });

  test('keeps a clicked tool patch transient and clears it for regular diff navigation', () => {
    const directory = '/repo';
    const patch = '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n ';
    const secondPatch = '--- a/src/test.ts\n+++ b/src/test.ts\n@@ -1 +1 @@\n-left\n+right\n ';

    useUIStore.getState().openContextToolDiff(directory, 'src/app.ts', [
      { path: 'src/app.ts', patch },
      { path: 'src/test.ts', patch: secondPatch },
    ], 1, ' msg_tool_turn ');

    const tab = useUIStore.getState().contextPanelByDirectory[directory]?.tabs[0];
    expect(tab?.mode).toBe('diff');
    expect(tab?.targetPath).toBe('src/app.ts');
    expect(tab?.diffScope).toBe('turn');
    expect(tab?.diffTurnMessageId).toBe('msg_tool_turn');
    expect(useUIStore.getState().contextToolDiffByDirectory[directory]).toEqual({
      targetPath: 'src/app.ts',
      patches: [
        { path: 'src/app.ts', patch },
        { path: 'src/test.ts', patch: secondPatch },
      ],
      turnMessageId: 'msg_tool_turn',
    });
    const partialize = useUIStore.persist.getOptions().partialize;
    const persisted = partialize?.(useUIStore.getState()) as Record<string, unknown> | undefined;
    expect(persisted?.contextToolDiffByDirectory).toBe(undefined);

    useUIStore.getState().openContextDiff(directory, 'src/app.ts', false, 'turn', 1, 'msg_turn');

    expect(useUIStore.getState().contextToolDiffByDirectory[directory]).toBe(undefined);
  });

  test('updates readOnly when an existing chat tab is reopened', () => {
    const directory = '/repo';

    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: 'session:ses_1',
      label: 'Session',
      readOnly: true,
    });

    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: 'session:ses_1',
      label: 'Session',
      readOnly: false,
    });

    const tabs = useUIStore.getState().contextPanelByDirectory[directory]?.tabs ?? [];
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.readOnly).toBe(false);
  });

  test('closing the last tab collapses the panel immediately', () => {
    const directory = '/repo';

    useUIStore.getState().openContextPanelTab(directory, { mode: 'context' });
    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'file',
      targetPath: '/repo/install.sh',
    });

    const before = useUIStore.getState().contextPanelByDirectory[directory];
    expect(before?.isOpen).toBe(true);
    expect(before?.tabs).toHaveLength(2);

    const closedFirst = useUIStore.getState().closeActiveContextPanelTab(directory);
    expect(closedFirst).toBe(true);
    expect(useUIStore.getState().contextPanelByDirectory[directory]?.tabs).toHaveLength(1);
    expect(useUIStore.getState().contextPanelByDirectory[directory]?.isOpen).toBe(true);

    const closedLast = useUIStore.getState().closeActiveContextPanelTab(directory);
    expect(closedLast).toBe(true);
    const after = useUIStore.getState().contextPanelByDirectory[directory];
    expect(after?.tabs).toHaveLength(0);
    expect(after?.isOpen).toBe(false);

    expect(useUIStore.getState().closeActiveContextPanelTab(directory)).toBe(false);
  });

  test.each(['context', 'file', 'diff', 'file-diff', 'chat', 'browser', 'preview', 'btw'] as const)('closing the last %s tab collapses only its directory panel and persists it closed', (mode) => {
    const store = useUIStore.getState();
    store.openContextFile('/other', '/other/keep.ts');
    const other = useUIStore.getState().contextPanelByDirectory['/other'];
    store.openContextPanelTab('/repo', { mode, targetPath: '/repo/a.ts' });
    const tab = useUIStore.getState().contextPanelByDirectory['/repo'].tabs[0];
    store.closeContextPanelTab('/repo', 'unknown');
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].isOpen).toBe(true);
    store.closeContextPanelTab('/repo', tab.id);
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toMatchObject({ isOpen: false, tabs: [], activeTabId: null });
    expect(useUIStore.getState().contextPanelByDirectory['/other']).toBe(other);
    const saved = useUIStore.persist.getOptions().partialize!(useUIStore.getState()) as Pick<ReturnType<typeof useUIStore.getState>, 'contextPanelByDirectory'>;
    expect(saved.contextPanelByDirectory['/repo'].isOpen).toBe(false);
  });

  test('the nested file-tree toggle never closes or reopens preview panels', () => {
    const firstDirectory = '/repo-one';
    const secondDirectory = '/repo-two';
    const store = useUIStore.getState();

    store.openContextPanelTab(firstDirectory, { mode: 'context' });
    store.openContextPanelTab(secondDirectory, { mode: 'diff' });
    store.toggleRightSidebar();

    expect(useUIStore.getState().isRightSidebarOpen).toBe(true);
    store.toggleRightSidebar();

    expect(useUIStore.getState().isRightSidebarOpen).toBe(false);
    expect(useUIStore.getState().contextPanelByDirectory[firstDirectory]?.isOpen).toBe(true);
    expect(useUIStore.getState().contextPanelByDirectory[secondDirectory]?.isOpen).toBe(true);

    store.closeContextPanel(firstDirectory);

    store.toggleRightSidebar();

    expect(useUIStore.getState().contextPanelByDirectory[firstDirectory]?.isOpen).toBe(false);
    expect(useUIStore.getState().contextPanelByDirectory[secondDirectory]?.isOpen).toBe(true);
  });

  test('syncWorkspacePanelsForSessionSwitch hides and restores session-scoped panels', () => {
    const directory = '/repo';
    const store = useUIStore.getState();

    store.openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: 'session:ses_child',
      label: 'Subagent',
    });
    store.openContextFile(directory, '/repo/src/a.ts');
    store.setRightSidebarOpen(true);
    store.setRightSidebarTab('git');

    const activeTabId = useUIStore.getState().contextPanelByDirectory[directory]?.activeTabId;
    expect(useUIStore.getState().contextPanelByDirectory[directory]?.isOpen).toBe(true);
    expect(useUIStore.getState().isRightSidebarOpen).toBe(true);

    store.syncWorkspacePanelsForSessionSwitch({
      previousSessionId: 'ses_a',
      previousDirectory: directory,
      nextSessionId: 'ses_b',
      nextDirectory: directory,
    });

    expect(useUIStore.getState().contextPanelByDirectory[directory]?.isOpen).toBe(false);
    expect(useUIStore.getState().isRightSidebarOpen).toBe(false);
    // Tabs stay in the session snapshot, never in the next session's live panel.
    expect(useUIStore.getState().contextPanelByDirectory[directory]?.tabs).toEqual([]);

    store.syncWorkspacePanelsForSessionSwitch({
      previousSessionId: 'ses_b',
      previousDirectory: directory,
      nextSessionId: 'ses_a',
      nextDirectory: directory,
    });

    expect(useUIStore.getState().contextPanelByDirectory[directory]?.isOpen).toBe(true);
    expect(useUIStore.getState().contextPanelByDirectory[directory]?.activeTabId).toBe(activeTabId);
    expect(useUIStore.getState().isRightSidebarOpen).toBe(true);
    expect(useUIStore.getState().rightSidebarTab).toBe('git');
  });

  test('syncWorkspacePanelsForSessionSwitch closes previous directory when roots differ', () => {
    const firstDirectory = '/repo-one';
    const secondDirectory = '/repo-two';
    const store = useUIStore.getState();

    store.openContextPanelTab(firstDirectory, {
      mode: 'chat',
      dedupeKey: 'session:ses_child',
      label: 'Subagent',
    });
    expect(useUIStore.getState().contextPanelByDirectory[firstDirectory]?.isOpen).toBe(true);

    store.syncWorkspacePanelsForSessionSwitch({
      previousSessionId: 'ses_a',
      previousDirectory: firstDirectory,
      nextSessionId: 'ses_b',
      nextDirectory: secondDirectory,
    });

    expect(useUIStore.getState().contextPanelByDirectory[firstDirectory]?.isOpen).toBe(false);
    expect(useUIStore.getState().isRightSidebarOpen).toBe(false);
  });

  test('syncWorkspacePanelsForSessionSwitch hides panels when leaving for a new-session draft', () => {
    const directory = '/repo';
    const store = useUIStore.getState();

    store.openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: 'session:ses_child',
      label: 'Subagent',
    });
    store.setRightSidebarOpen(true);
    store.setRightSidebarTab('files');

    store.syncWorkspacePanelsForSessionSwitch({
      previousSessionId: 'ses_a',
      previousDirectory: directory,
      nextSessionId: null,
      nextDirectory: null,
    });

    expect(useUIStore.getState().contextPanelByDirectory[directory]?.isOpen).toBe(false);
    expect(useUIStore.getState().isRightSidebarOpen).toBe(false);
    expect(useUIStore.getState().contextPanelByDirectory[directory]?.tabs).toEqual([]);

    store.syncWorkspacePanelsForSessionSwitch({
      previousSessionId: null,
      previousDirectory: null,
      nextSessionId: 'ses_a',
      nextDirectory: directory,
    });

    expect(useUIStore.getState().contextPanelByDirectory[directory]?.isOpen).toBe(true);
    expect(useUIStore.getState().isRightSidebarOpen).toBe(true);
    expect(useUIStore.getState().rightSidebarTab).toBe('files');
  });

  test('openContextBrowser reuses desktop-browser tab and updates non-empty targetPath', () => {
    const directory = '/repo';
    const store = useUIStore.getState();

    store.openContextBrowser(directory, 'https://example.com/one');
    const first = useUIStore.getState().contextPanelByDirectory[directory];
    expect(first?.isOpen).toBe(true);
    expect(first?.tabs).toHaveLength(1);
    expect(first?.tabs[0]?.mode).toBe('browser');
    expect(first?.tabs[0]?.dedupeKey).toBe('desktop-browser');
    expect(first?.tabs[0]?.targetPath).toBe('https://example.com/one');
    expect(first?.activeTabId).toBe(first?.tabs[0]?.id);

    store.openContextBrowser(directory, 'https://example.com/two');
    const second = useUIStore.getState().contextPanelByDirectory[directory];
    expect(second?.tabs).toHaveLength(1);
    expect(second?.tabs[0]?.targetPath).toBe('https://example.com/two');
    expect(second?.tabs[0]?.id).toBe(first?.tabs[0]?.id);

    // Empty URL must not wipe an existing targetPath (header "open browser" affordance).
    store.openContextBrowser(directory);
    const third = useUIStore.getState().contextPanelByDirectory[directory];
    expect(third?.tabs).toHaveLength(1);
    expect(third?.tabs[0]?.targetPath).toBe('https://example.com/two');
  });
});
