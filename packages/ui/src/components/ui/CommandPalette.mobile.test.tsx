import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const searchSessions = vi.hoisted(() => vi.fn(async (_query: string) => [
  { id: 'session-1', title: 'Recent conversation', time: { updated: 1 } },
]));
const fileSearch = vi.hoisted(() => vi.fn(async (_request: { directory: string; query: string; maxResults?: number }, _options?: { signal?: AbortSignal }): Promise<{ path: string }[]> => []));
const readFile = vi.hoisted(() => vi.fn(async (_path: string) => ({ content: '', exists: true })));
const titleSignal = vi.hoisted(() => vi.fn((_signal: AbortSignal) => {}));
const contentSignal = vi.hoisted(() => vi.fn<(_signal: AbortSignal) => void | Promise<void>>(() => {}));

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en-US' }) }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/worktreeSessionCreator', () => ({ createWorktreeSession: vi.fn() }));
vi.mock('@/lib/terminalTabShortcuts', () => ({ openAndCreateTerminalTab: vi.fn() }));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/project' }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ files: { search: fileSearch, readFile } }) }));
vi.mock('@/sync/session-ui-store', async () => {
  const { create } = await import('zustand');
  return { useSessionUIStore: create(() => ({
    openNewSessionDraft: vi.fn(), setCurrentSession: vi.fn(),
    currentSessionId: null, currentSessionDirectory: null,
    worktreeMetadata: new Map(), availableWorktreesByProject: new Map(),
  })) };
});
vi.mock('@/stores/useGlobalSessionsStore', async () => {
  const { create } = await import('zustand');
  return {
    resolveGlobalSessionDirectory: () => '/project',
    useGlobalSessionsStore: create(() => ({ activeSessions: [], status: 'ready' })),
  };
});
vi.mock('@/stores/useDirectoryStore', async () => {
  const { create } = await import('zustand');
  return { useDirectoryStore: create(() => ({ currentDirectory: null })) };
});
vi.mock('@/stores/useProjectsStore', async () => {
  const { create } = await import('zustand');
  return { useProjectsStore: create(() => ({ projects: [], getActiveProject: () => null })) };
});
vi.mock('@/queries/sessionTitleSearchQueries', () => ({
  sessionTitleSearchQueryOptions: (query: string) => ({ queryKey: ['search', query], queryFn: ({ signal }: { signal: AbortSignal }) => {
    titleSignal(signal);
    return searchSessions(query);
  } }),
}));
vi.mock('@/queries/sessionContentSearchQueries', () => ({
  sessionContentIndexStatusOptions: () => ({ queryKey: ['content-status'], queryFn: async () => ({ phase: 'ready', total: 1, completed: 1, messages: 1 }) }),
  sessionContentSearchQueryOptions: (query: string) => ({ queryKey: ['content-search', query], queryFn: async ({ signal }: { signal: AbortSignal }) => {
    await contentSignal(signal);
    if (query !== 'matching') return [];
    return [{
    sessionID: 'session-1', messageID: 'old-message', directory: '/project', role: 'user', createdAt: 0, snippet: 'old matching body',
  }, {
    sessionID: 'session-1', messageID: 'message-1', directory: '/project', role: 'user', createdAt: 1, snippet: 'matching\n\nbody   result',
  }, {
    sessionID: 'session-1', messageID: 'older-message', directory: '/project', role: 'user', createdAt: 0, snippet: 'another old matching body',
  }]; }, enabled: false }),
}));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => 'test',
  getRuntimeGeneration: () => 1,
  getRuntimeKey: () => 'test',
  subscribeRuntimeEndpointChanged: () => () => {},
}));
vi.mock('@/components/chat/hooks/useChatTurnNavigation', () => ({ focusChatMessage: vi.fn() }));

import { CommandPalette } from './CommandPalette';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { GuiPluginsContext } from '@/lib/gui-plugins/react';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, availableWorktreesByProject: new Map() });
  useDirectoryStore.setState({ currentDirectory: '' });
});

test('closed palette performs zero commits for 50 unrelated catalog updates', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const committed = vi.fn();
  useUIStore.getState().setCommandPaletteOpen(false);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <React.Profiler id="palette" onRender={committed}><CommandPalette /></React.Profiler>
    </QueryClientProvider>));
    committed.mockClear();
    for (let i = 0; i < 50; i++) {
      await act(async () => useGlobalSessionsStore.setState({ activeSessions: [] }));
    }
    expect(committed).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    client.clear();
  }
});

test('opening search only consumes startup GUI contributions and never requests plugin loading', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const requestLoad = vi.fn();
  const context: React.ContextType<typeof GuiPluginsContext> = {
    host: null,
    snapshot: { plugins: [], commands: [], titlebarItems: [], panels: [], pages: [], settings: [], menuItems: [], activePanel: null },
    inventory: [], error: null, loading: true, requested: false,
    requestLoad, setEnabled: vi.fn(), refresh: vi.fn(),
  };
  const render = (value = context) => root.render(<QueryClientProvider client={client}>
    <GuiPluginsContext.Provider value={value}><CommandPalette presentation="page" /></GuiPluginsContext.Provider>
  </QueryClientProvider>);
  useUIStore.getState().setCommandPaletteOpen(true);
  try {
    await act(async () => render());
    expect(requestLoad).not.toHaveBeenCalled();
    expect(host.querySelector('[data-value="new-session"]')).not.toBeNull();
    const ready = { ...context, loading: false, requested: true, snapshot: {
      ...context.snapshot, commands: [{ key: 'startup-command', title: 'Startup command', run: vi.fn() }],
    } };
    await act(async () => render(ready));
    expect(host.querySelector('[data-value="gui-plugin:startup-command"]')).not.toBeNull();
    await act(async () => useUIStore.getState().setCommandPaletteOpen(false));
    await act(async () => useUIStore.getState().setCommandPaletteOpen(true));
    expect(host.querySelector('[data-value="gui-plugin:startup-command"]')).not.toBeNull();
    expect(requestLoad).not.toHaveBeenCalled();
  } finally {
    await act(async () => { root.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    client.clear(); host.remove();
  }
});

test('page presentation has a focused search header and results without dialog chrome', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const stylesheet = document.createElement('style');
  stylesheet.textContent = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'command-palette.css'), 'utf8');
  document.head.append(stylesheet);
  const previousFontSize = document.documentElement.style.fontSize;
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onBack = vi.fn();
  useUIStore.getState().setCommandPaletteOpen(true);
  try {
    await act(async () => root.render(
      <QueryClientProvider client={client}><CommandPalette presentation="page" onBack={onBack} /></QueryClientProvider>,
    ));
    const input = host.querySelector<HTMLInputElement>('header input')!;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(input.inputMode).toBe('search');
    expect(input.value).toBe('');
    expect(searchSessions).toHaveBeenCalledWith('');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain('Recent conversation');
    expect(host.textContent).not.toContain('commandPalette.index.');
    expect(client.getQueryCache().find({ queryKey: ['content-status'] })).toBeUndefined();
    const time = host.querySelector('time')!;
    expect(time.dateTime).toBe(new Date(1).toISOString());
    expect(time.textContent).toBe(new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'short' }).format(1));
    expect(time.previousElementSibling?.textContent).toBe('Recent conversation');
    expect(input.closest('[data-slot="command-input-field"]')?.className).toContain('yuri-mobile-glass-control');
    expect(input.closest('[data-slot="command-input-field"]')?.className).not.toContain('ring-');
    const navigation = host.querySelector<HTMLElement>('.yuri-mobile-detail-navigation-content')!;
    expect(getComputedStyle(navigation).gridTemplateColumns).toBe('auto minmax(0, 1fr)');
    expect(getComputedStyle(navigation).columnGap).toBe('0.5rem');
    document.documentElement.style.fontSize = '20px';
    expect(getComputedStyle(input.closest('[data-slot="command-input-field"]')!).height).toBe('50px');
    expect(getComputedStyle(input).height).toBe('50px');
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
    expect(host.querySelector('[data-slot="dialog-close"]')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="header.actions.backAria"]')!.click());
    expect(onBack).toHaveBeenCalledOnce();
  } finally {
    await act(async () => { root.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    client.clear();
    host.remove();
    stylesheet.remove();
    document.documentElement.style.fontSize = previousFontSize;
  }
});

test.each([
  { time: { created: 1234 }, expected: new Date(1234).toISOString() },
  { time: undefined, expected: null },
  { time: { updated: NaN }, expected: null },
])('handles a session timestamp $time without inventing a time', async ({ time, expected }) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['search', ''], [{ id: 'session-time', title: 'Timestamp conversation', time }]);
  useUIStore.getState().setCommandPaletteOpen(true);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><CommandPalette presentation="page" /></QueryClientProvider>));
    const row = host.querySelector('[data-value="session:session-time"]')!;
    expect(row).not.toBeNull();
    expect(row.querySelector('time')?.getAttribute('datetime') ?? null).toBe(expected);
  } finally {
    await act(async () => { root.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    client.clear(); host.remove();
  }
});

test('hardware arrow keys wrap from the first selectable result to the last and back', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['search', ''], [{ id: 'loop-session', title: 'Loop conversation', time: { updated: 1 } }]);
  useUIStore.getState().setCommandPaletteOpen(true);
  const press = async (key: string) => {
    await act(async () => host.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
  };
  const selectedValue = () => host.querySelector('[cmdk-item][data-selected="true"]')?.getAttribute('data-value');
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><CommandPalette presentation="page" /></QueryClientProvider>));
    const rows = [...host.querySelectorAll('[cmdk-item]:not([data-disabled="true"])')];
    expect(rows.length).toBeGreaterThan(1);
    const first = rows[0].getAttribute('data-value');
    const last = rows[rows.length - 1].getAttribute('data-value');
    await press('Home');
    expect(selectedValue()).toBe(first);
    for (let i = 0; i < 3; i++) {
      await press('ArrowUp');
      expect(selectedValue()).toBe(last);
      await press('ArrowDown');
      expect(selectedValue()).toBe(first);
    }
    await press('End');
    expect(selectedValue()).toBe(last);
    await press('ArrowDown');
    expect(selectedValue()).toBe(first);
  } finally {
    await act(async () => { root.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    client.clear(); host.remove();
  }
});

test('combines title and body matches in five unified rows, freezes navigation and resets expansion', async () => {
  searchSessions.mockResolvedValue(Array.from({ length: 30 }, (_, i) => ({
    id: `session-${i}`, title: `matching conversation ${i}`, time: { updated: 1000 + i },
  })));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useUIStore.getState().setCommandPaletteOpen(true);
  const type = async (value: string) => {
    const input = host.querySelector<HTMLInputElement>('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><CommandPalette presentation="page" /></QueryClientProvider>));
    await type('matching');
    expect(host.querySelectorAll('[cmdk-item][data-value^="session:"]')).toHaveLength(4);
    expect(host.querySelectorAll('[cmdk-item][data-value^="message:"]')).toHaveLength(1);
    expect(host.querySelector('[data-value="session:session-1"]')).toBeNull();
    const bodyRow = host.querySelector('[cmdk-item][data-value^="message:"]')!;
    expect(bodyRow.textContent).toContain('matching conversation 1');
    expect(bodyRow.textContent).toContain('matching body result');
    expect(bodyRow.querySelector('time')?.dateTime).toBe(new Date(1).toISOString());
    expect(host.querySelector('[data-value="session:session-0"] time')?.getAttribute('datetime')).toBe(new Date(1000).toISOString());
    expect(host.textContent).not.toContain('old matching body');
    expect(bodyRow.querySelectorAll('mark')).toHaveLength(2);
    expect(bodyRow.querySelector('.yuri-global-search-session-excerpt')).not.toBeNull();
    expect(bodyRow.querySelector('.yuri-global-search-session-excerpt')?.textContent).not.toMatch(/\n| {2}/);
    expect(host.textContent).not.toContain('commandPalette.group.messages');
    expect(host.querySelector('[data-value="more:sessions"]')).not.toBeNull();
    await act(async () => host.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    await act(async () => {
      client.setQueryData(['content-search', 'matching'], [{ sessionID: 'new', messageID: 'new', directory: '/other', role: 'user', createdAt: 2, snippet: 'new background result' }]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('matching body result');
    expect(host.textContent).not.toContain('new background result');
    await act(async () => (host.querySelector('[data-value="more:sessions"]') as HTMLElement).click());
    expect(host.querySelectorAll('[cmdk-item][data-value^="session:"]')).toHaveLength(29);
    expect(host.querySelectorAll('[cmdk-item][data-value^="message:"]')).toHaveLength(1);
    expect(host.querySelector('[data-value="more:sessions"]')).toBeNull();
    await type('conversation');
    expect(host.querySelectorAll('[cmdk-item][data-value^="session:"]')).toHaveLength(5);
    await type('matching');
    expect(host.querySelectorAll('[cmdk-item][data-value^="session:"]')).toHaveLength(4);
    expect(host.querySelectorAll('[cmdk-item][data-value^="message:"]')).toHaveLength(1);
  } finally {
    await act(async () => { root.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    client.clear(); host.remove();
  }
});

test('files only search the focused conversation directory, not other saved projects or worktrees', async () => {
  fileSearch.mockClear();
  fileSearch.mockImplementation(async ({ directory }) => [{ path: `${directory}/CommandPalette.tsx` }]);
  useProjectsStore.setState({ projects: [
    { id: 'a', path: '/project-a', label: 'Project A' },
    ...Array.from({ length: 50 }, (_, index) => ({ id: `other-${index}`, path: `/project-${index}`, label: `Command Project ${index}` })),
  ] });
  useSessionUIStore.setState({ currentSessionId: 'focused', currentSessionDirectory: '/project-a', availableWorktreesByProject: new Map([
    ['/project-a', [{ path: '/other-worktree', projectDirectory: '/project-a', branch: 'feature', label: 'Feature' }]],
  ]) });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const previousOpenFile = useUIStore.getState().openContextFile;
  const openFile = vi.fn();
  useUIStore.setState({ openContextFile: openFile });
  useUIStore.getState().setCommandPaletteOpen(true);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><CommandPalette presentation="page" /></QueryClientProvider>));
    const input = host.querySelector<HTMLInputElement>('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Command');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(fileSearch).toHaveBeenCalledWith({ directory: '/project-a', query: 'Command', maxResults: 10 }, { signal: expect.any(AbortSignal) });
    expect(fileSearch).toHaveBeenCalledTimes(1);
    const files = host.querySelectorAll('[cmdk-item][data-value^="file:"]');
    expect(files).toHaveLength(1);
    expect(host.querySelector('[data-value^="project:"]')).not.toBeNull();
    expect(files[0].querySelector('.yuri-global-search-result-detail')?.textContent).toContain('/project-');
    expect(host.querySelectorAll('[cmdk-group-heading] .yuri-global-search-group-count').length).toBeGreaterThan(1);
    expect(host.textContent).not.toContain('commandPalette.index.');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Changed query');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelectorAll('[cmdk-item][data-value^="file:"]')).toHaveLength(0);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Command');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      const file = host.querySelector('[data-value="file:/project-a/CommandPalette.tsx"]')!;
      file.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      file.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    expect(readFile).toHaveBeenCalledWith('/project-a/CommandPalette.tsx', { optional: true });
    expect(openFile).toHaveBeenCalledWith('/project-a', '/project-a/CommandPalette.tsx');
  } finally {
    await act(async () => { root.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    useProjectsStore.setState({ projects: [] });
    useUIStore.setState({ openContextFile: previousOpenFile });
    fileSearch.mockReset();
    client.clear(); host.remove();
  }
});

test.each([
  { currentSessionId: null, currentSessionDirectory: '/project' },
  { currentSessionId: 'unknown-directory', currentSessionDirectory: null },
  { currentSessionId: 'unknown-project', currentSessionDirectory: '/not-saved' },
])('skips files without a focused conversation and known project: $currentSessionId', async (focus) => {
  fileSearch.mockClear();
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/project', label: 'Matching Project' }] });
  useDirectoryStore.setState({ currentDirectory: '/project' });
  useSessionUIStore.setState(focus);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useUIStore.getState().setCommandPaletteOpen(true);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><CommandPalette presentation="page" /></QueryClientProvider>));
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'matching');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(client.getQueryState(['search', 'matching'])?.status).toBe('success');
    expect(client.getQueryState(['content-search', 'matching'])?.status).toBe('success');
    expect(host.querySelector('[data-value^="project:"]')).not.toBeNull();
    expect(fileSearch).not.toHaveBeenCalled();
    expect(host.querySelector('[data-file-search-pending]')).toBeNull();
    expect(host.querySelector('[data-file-search-notice]')).toBeNull();
  } finally {
    await act(async () => { root.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    useProjectsStore.setState({ projects: [] });
    client.clear(); host.remove();
  }
});

test('focus changes cancel the previous file query; a worktree never searches its main or sibling roots', async () => {
  const worktree = { path: '/worktree', projectDirectory: '/project', branch: 'feature', label: 'Feature' };
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/project' }, { id: 'other', path: '/other' }] });
  useSessionUIStore.setState({ currentSessionId: 'main', currentSessionDirectory: '/project', availableWorktreesByProject: new Map([
    ['/project', [worktree, { ...worktree, path: '/sibling' }]],
  ]) });
  const flights: { directory: string; signal: AbortSignal; resolve: (files: { path: string }[]) => void }[] = [];
  fileSearch.mockClear().mockImplementation(({ directory }, options) => new Promise(resolve => {
    flights.push({ directory, signal: options!.signal!, resolve });
  }));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useUIStore.getState().setCommandPaletteOpen(true);
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><CommandPalette presentation="page" /></QueryClientProvider>));
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'matching');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
    await settle(); await settle();
    expect(flights.map(flight => flight.directory)).toEqual(['/project']);
    await act(async () => useSessionUIStore.setState({ currentSessionId: 'worktree', currentSessionDirectory: '/worktree' }));
    await settle();
    expect(flights[0].signal.aborted).toBe(true);
    expect(flights.map(flight => flight.directory)).toEqual(['/project', '/worktree']);
    await act(async () => useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null }));
    expect(flights[1].signal.aborted).toBe(true);
    await act(async () => {
      flights[0].resolve([{ path: '/project/matching-old.ts' }]);
      flights[1].resolve([{ path: '/worktree/matching-old.ts' }]);
    });
    await settle();
    expect(host.querySelector('[data-value="file:/project/matching-old.ts"]')).toBeNull();
    expect(host.querySelector('[data-value="file:/worktree/matching-old.ts"]')).toBeNull();
    await act(async () => useSessionUIStore.setState({ currentSessionId: 'worktree', currentSessionDirectory: '/worktree' }));
    await settle();
    expect(flights.map(flight => flight.directory)).toEqual(['/project', '/worktree', '/worktree']);
    await act(async () => { flights[2].resolve([{ path: '/worktree/matching.ts' }]); });
    await settle();
    expect(host.querySelector('[data-value="file:/worktree/matching.ts"]')).not.toBeNull();
    await act(async () => useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null }));
    await settle();
    expect(host.querySelector('[data-value^="file:"]')).toBeNull();
    expect(fileSearch).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => { root.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    useProjectsStore.setState({ projects: [] });
    fileSearch.mockReset(); client.clear(); host.remove();
  }
});

test.each([false, true])('session snapshots settle before files start; input and close cancel pending work (failure: %s)', async (failure) => {
  const originalSearch = searchSessions.getMockImplementation()!;
  let finishTitle!: () => void;
  const pendingTitles: AbortSignal[] = [];
  searchSessions.mockImplementation((query) => query === 'priority'
    ? new Promise((resolve, reject) => { finishTitle = () => failure ? reject(new Error('offline')) : resolve([]); })
    : new Promise(() => {}));
  titleSignal.mockImplementation(signal => { pendingTitles.push(signal); });
  const fileSignals: AbortSignal[] = [];
  fileSearch.mockImplementation((_payload, options) => {
    fileSignals.push(options!.signal!);
    return new Promise(() => {});
  });
  useProjectsStore.setState({ projects: Array.from({ length: 51 }, (_, i) => ({ id: String(i), path: `/project-${i}` })) });
  useSessionUIStore.setState({ currentSessionId: 'focused', currentSessionDirectory: '/project-0' });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useUIStore.getState().setCommandPaletteOpen(true);
  const type = async (value: string) => {
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const debounce = async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  };
  try {
    fileSearch.mockClear();
    await act(async () => root.render(<QueryClientProvider client={client}><CommandPalette presentation="page" /></QueryClientProvider>));
    await type('priority');
    await debounce();
    expect(pendingTitles.at(-1)?.aborted).toBe(false);
    expect(fileSearch).not.toHaveBeenCalled();
    await act(async () => { finishTitle(); await new Promise(resolve => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(fileSignals).toHaveLength(1);
    await type('new-query');
    expect(fileSignals.every(signal => signal.aborted)).toBe(true);
    await debounce();
    expect(fileSignals).toHaveLength(1);
    const liveTitle = pendingTitles.at(-1)!;
    expect(liveTitle.aborted).toBe(false);
    await act(async () => useUIStore.getState().setCommandPaletteOpen(false));
    expect(liveTitle.aborted).toBe(true);
    expect(client.getQueryState(['content-search', 'new-query'])?.fetchStatus).toBe('idle');
    await debounce();
    expect(fileSignals).toHaveLength(1);
  } finally {
    await act(async () => { root.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    searchSessions.mockImplementation(originalSearch);
    titleSignal.mockReset();
    fileSearch.mockReset();
    useProjectsStore.setState({ projects: [] });
    client.clear(); host.remove();
  }
});

test.each(['input', 'close'])('pending body snapshot is cancelled on %s before any files start', async (action) => {
  contentSignal.mockClear().mockImplementation(() => new Promise(() => {}));
  fileSearch.mockClear();
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/project' }] });
  useSessionUIStore.setState({ currentSessionId: 'focused', currentSessionDirectory: '/project' });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useUIStore.getState().setCommandPaletteOpen(true);
  const type = async (text: string) => {
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><CommandPalette presentation="page" /></QueryClientProvider>));
    await type('matching');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    const signal = contentSignal.mock.calls.at(-1)![0];
    expect(signal.aborted).toBe(false);
    expect(fileSearch).not.toHaveBeenCalled();
    if (action === 'input') await type('new-query');
    else await act(async () => useUIStore.getState().setCommandPaletteOpen(false));
    expect(signal.aborted).toBe(true);
    expect(fileSearch).not.toHaveBeenCalled();
  } finally {
    await act(async () => { root.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    contentSignal.mockReset();
    useProjectsStore.setState({ projects: [] });
    client.clear(); host.remove();
  }
});

test('indexed conversations appear without waiting for a cold project file search', async () => {
  let finishFiles!: (files: { path: string }[]) => void;
  fileSearch.mockImplementation(() => new Promise((resolve) => { finishFiles = resolve; }));
  useProjectsStore.setState({ projects: [{ id: 'cold', path: '/cold-project' }] });
  useSessionUIStore.setState({ currentSessionId: 'focused', currentSessionDirectory: '/cold-project' });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useUIStore.getState().setCommandPaletteOpen(true);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><CommandPalette presentation="page" /></QueryClientProvider>));
    const input = host.querySelector<HTMLInputElement>('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'matching');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(client.getQueryState(['search', 'matching'])?.status).toBe('success');
    expect(client.getQueryState(['content-search', 'matching'])?.status).toBe('success');
    expect(fileSearch).toHaveBeenCalledWith({ directory: '/cold-project', query: 'matching', maxResults: 10 }, { signal: expect.any(AbortSignal) });
    expect(client.getQueryCache().findAll({ queryKey: ['test', 'session-file-search'] }).some((entry) => entry.state.fetchStatus === 'fetching')).toBe(true);
    expect(host.querySelector('[cmdk-item][data-value^="message:"]')).not.toBeNull();
    expect(host.querySelector('[data-file-search-pending]')).not.toBeNull();
    expect(host.textContent).not.toContain('commandPalette.empty.noResults');
    await act(async () => {
      finishFiles([{ path: '/cold-project/matching.ts' }]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.querySelector('[data-value="file:/cold-project/matching.ts"]')).not.toBeNull();
    expect(host.querySelector('[data-file-search-pending]')).toBeNull();
    const fileRequests = fileSearch.mock.calls.length;
    await act(async () => useUIStore.getState().setCommandPaletteOpen(false));
    await act(async () => useUIStore.getState().setCommandPaletteOpen(true));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'matching');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fileSearch.mock.calls.length).toBe(fileRequests);
    expect(host.querySelector('[cmdk-item][data-value^="message:"]')).not.toBeNull();
    expect(host.querySelector('[data-value="file:/cold-project/matching.ts"]')).not.toBeNull();
  } finally {
    await act(async () => { root.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    useProjectsStore.setState({ projects: [] });
    fileSearch.mockReset();
    client.clear(); host.remove();
  }
});

test('focused file search failure stays quiet and preserves conversation results without searching another project', async () => {
  fileSearch.mockClear();
  fileSearch.mockImplementation(async ({ directory }) => {
    if (directory === '/offline') throw new Error('offline');
    return [{ path: `${directory}/matching.ts` }];
  });
  useProjectsStore.setState({ projects: [
    { id: 'offline', path: '/offline' },
    { id: 'online', path: '/online' },
  ] });
  useSessionUIStore.setState({ currentSessionId: 'focused', currentSessionDirectory: '/offline' });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useUIStore.getState().setCommandPaletteOpen(true);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><CommandPalette presentation="page" /></QueryClientProvider>));
    const input = host.querySelector<HTMLInputElement>('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'matching');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    const notice = host.querySelector('[data-file-search-notice]')!;
    expect(notice).not.toBeNull();
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.className).toContain('text-muted-foreground');
    expect(notice.className).not.toContain('status-error');
    expect(notice.textContent).toBe('commandPalette.error.files');
    expect(fileSearch).toHaveBeenCalledTimes(1);
    expect(fileSearch.mock.calls[0][0].directory).toBe('/offline');
    expect(host.textContent).not.toContain('mobile.files.error.listFailed');
    expect(host.querySelector('[cmdk-item][data-value^="session:"]')).not.toBeNull();
    expect(host.querySelectorAll('[cmdk-item][data-value^="file:"]')).toHaveLength(0);
    expect(host.textContent).not.toContain('commandPalette.empty');
  } finally {
    await act(async () => { root.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    useProjectsStore.setState({ projects: [] });
    fileSearch.mockReset();
    client.clear(); host.remove();
  }
});
