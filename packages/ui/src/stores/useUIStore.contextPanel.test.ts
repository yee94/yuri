import { beforeEach, describe, expect, test } from 'vitest';
import { useUIStore } from './useUIStore';

beforeEach(() => {
  useUIStore.setState({
    contextPanelByDirectory: {},
    contextToolDiffByDirectory: {},
    sessionWorkspacePanelById: {},
    isRightSidebarOpen: false,
    activeMainTab: 'chat',
    rightSidebarTab: 'git',
    pendingFileFocusPath: null,
    pendingFileViewerMode: null,
    pendingFileNavigation: null,
    mainTabGuard: null,
  });
});

describe('useUIStore context panel tabs', () => {
  test.each(['before', 'after'])('opens Git Changes with no saved settings when initial session selection happens %s panel initialization', (selectionOrder) => {
    const initial = useUIStore.getInitialState();
    useUIStore.setState({
      isRightSidebarOpen: initial.isRightSidebarOpen,
      rightSidebarTab: initial.rightSidebarTab,
    });
    const store = useUIStore.getState();
    const select = () => store.syncWorkspacePanelsForSessionSwitch({
      previousSessionId: null,
      nextSessionId: 'first-session',
      nextDirectory: '/repo',
    });
    if (selectionOrder === 'before') select();
    store.initializeWorkspacePanels('/repo/');
    if (selectionOrder === 'after') select();
    expect(useUIStore.getState()).toMatchObject({
      isRightSidebarOpen: true,
      rightSidebarTab: 'git',
      contextPanelByDirectory: { '/repo': { isOpen: true, tabs: [], activeTabId: null } },
    });
    const unchanged = useUIStore.getState();
    store.initializeWorkspacePanels('/repo');
    store.initializeWorkspacePanels('/other');
    expect(useUIStore.getState()).toBe(unchanged);
  });

  test('does not open the preview without a directory or with a saved closed rail', () => {
    const store = useUIStore.getState();
    store.setRightSidebarOpen(true);
    store.initializeWorkspacePanels('');
    expect(useUIStore.getState().contextPanelByDirectory).toEqual({});
    store.setRightSidebarOpen(false);
    store.initializeWorkspacePanels('/repo');
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
    store.initializeWorkspacePanels('/repo');
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
    // Tabs stay cached so restore can reopen them.
    expect(useUIStore.getState().contextPanelByDirectory[directory]?.tabs.length).toBeGreaterThan(0);

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
    expect(useUIStore.getState().sessionWorkspacePanelById.ses_a?.isRightSidebarOpen).toBe(true);
    expect(useUIStore.getState().sessionWorkspacePanelById.ses_a?.rightSidebarTab).toBe('files');

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
