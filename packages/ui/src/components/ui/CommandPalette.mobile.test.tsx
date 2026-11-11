import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const searchSessions = vi.hoisted(() => vi.fn(async (_query: string) => [
  { id: 'session-1', title: 'Recent conversation', directory: '/project', time: { updated: 1 } },
]));
const fileSearch = vi.hoisted(() => vi.fn(async (_request: { directory: string; query: string; maxResults?: number }, _options?: { signal?: AbortSignal }): Promise<{ path: string }[]> => []));
const readFile = vi.hoisted(() => vi.fn(async (_path: string) => ({ content: '', exists: true })));
const titleSignal = vi.hoisted(() => vi.fn((_signal: AbortSignal) => {}));
const contentSignal = vi.hoisted(() => vi.fn<(_signal: AbortSignal) => void | Promise<void>>(() => {}));
const iconFetch = vi.hoisted(() => vi.fn(async (_path: string) => new Response(new Blob(['icon'], { type: 'image/png' }))));

vi.mock('@/lib/runtime-fetch', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtime-fetch')>(),
  runtimeFetch: iconFetch,
}));

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
    resolveGlobalSessionDirectory: (session: { directory?: string }) => session.directory ?? null,
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
  getRuntimeApiBaseUrl: () => '',
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
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/project' }] });
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, availableWorktreesByProject: new Map() });
  useDirectoryStore.setState({ currentDirectory: '' });
});

test.each(['page', 'dialog'] as const)('%s filters conversations without an open project, including frozen results after project closure', async (presentation) => {
  const projects = [{ id: 'project', path: '/project' }, { id: 'other', path: '/other' }];
  useProjectsStore.setState({ projects });
  useSessionUIStore.setState({ availableWorktreesByProject: new Map([
    ['/other', [{ path: '/worktree', projectDirectory: '/other', branch: 'feature', label: 'Feature' }]],
  ]) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['search', 'needle'], [
    { id: 'open', title: 'needle open', directory: '/project/src' },
    { id: 'other', title: 'needle other', directory: '/other' },
    { id: 'closed', title: 'needle closed', directory: '/closed' },
    { id: 'unknown', title: 'needle unknown' },
    { id: 'prefix', title: 'needle prefix', directory: '/project-unadded' },
  ]);
  client.setQueryData(['content-search', 'needle'], [
    { sessionID: 'body', messageID: 'body-hit', title: 'needle body', directory: '/project', role: 'user', createdAt: 1, snippet: 'needle' },
    { sessionID: 'worktree', messageID: 'worktree-hit', title: 'needle worktree', directory: '/worktree', role: 'user', createdAt: 1, snippet: 'needle' },
    { sessionID: 'closed-body', messageID: 'closed-hit', title: 'needle closed body', directory: '/closed', role: 'user', createdAt: 1, snippet: 'needle' },
  ]);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  useUIStore.getState().setCommandPaletteOpen(true);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><CommandPalette presentation={presentation} /></QueryClientProvider>));
    const input = document.querySelector<HTMLInputElement>('[data-global-search] input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'needle');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    const rows = () => [...document.querySelectorAll('[data-global-search] .yuri-global-search-session')].map(row => row.getAttribute('data-value')).sort();
    expect(rows()).toEqual(['session:open', 'session:other', 'message:body:body-hit', 'message:worktree:worktree-hit'].sort());
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    await act(async () => useProjectsStore.setState({ projects: [projects[0]] }));
    expect(rows()).toEqual(['session:open', 'message:body:body-hit'].sort());
    const staleRow = document.querySelector<HTMLElement>('[data-value="session:open"]')!;
    const openSession = vi.mocked(useSessionUIStore.getState().setCurrentSession).mockClear();
    await act(async () => {
      useProjectsStore.setState({ projects: [] });
      staleRow.click();
    });
    expect(rows()).toEqual([]);
    expect(openSession).not.toHaveBeenCalled();
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(true);
    await act(async () => useProjectsStore.setState({ projects }));
    expect(rows()).toEqual(['session:open', 'session:other', 'message:body:body-hit', 'message:worktree:worktree-hit'].sort());
  } finally {
    await act(async () => { root.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    useProjectsStore.setState({ projects: [] });
    client.clear(); host.remove();
  }
});

test.each(['page', 'dialog'] as const)('%s excludes unowned recent conversations before applying the preview limit', async (presentation) => {
  const sessions = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `closed-${i}`, title: `Closed ${i}`, directory: '/closed', time: { updated: 100 + i } })),
    { id: 'open-recent', title: 'Open recent', directory: '/project', time: { updated: 1 } },
  ];
  useGlobalSessionsStore.setState({ activeSessions: sessions });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['search', ''], sessions);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  useUIStore.getState().setCommandPaletteOpen(true);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><CommandPalette presentation={presentation} /></QueryClientProvider>));
    const rows = document.querySelectorAll('[data-global-search] .yuri-global-search-session');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-value')).toBe('session:open-recent');
  } finally {
    await act(async () => { root.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    useGlobalSessionsStore.setState({ activeSessions: [] });
    client.clear(); host.remove();
  }
});

test.each(['page', 'dialog'] as const)('%s shows configured project images beside conversation project names', async (presentation) => {
  const projects = [
    { id: `${presentation}-custom`, path: '/project', label: 'Custom project', iconImage: { mime: 'image/png', updatedAt: 1, source: 'custom' as const } },
    { id: `${presentation}-auto`, path: '/project/nested', label: 'Site project', iconImage: { mime: 'image/png', updatedAt: 1, source: 'auto' as const } },
    { id: `${presentation}-plain`, path: '/plain', label: 'Plain project' },
  ];
  useProjectsStore.setState({ projects });
  useSessionUIStore.setState({ availableWorktreesByProject: new Map([
    ['/project', [{ path: '/worktree', projectDirectory: '/project', branch: 'feature', label: 'Feature' }]],
  ]) });
  const sessions = [
    { id: 'custom', title: 'Custom conversation', directory: '/worktree', time: { updated: 3 } },
    { id: 'auto', title: 'Site conversation', directory: '/project/nested/src', time: { updated: 2 } },
    { id: 'plain', title: 'Plain conversation', directory: '/plain', time: { updated: 1 } },
  ];
  useGlobalSessionsStore.setState({ activeSessions: sessions });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['search', ''], sessions);
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:project-icon');
  iconFetch.mockClear();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  useUIStore.getState().setCommandPaletteOpen(true);
  const projectCell = (id: string) => document.querySelector(`[data-value="session:${id}"] .yuri-global-search-session-project`)!;
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><CommandPalette presentation={presentation} /></QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(projectCell('custom').querySelector('img')?.getAttribute('src')).toBe('blob:project-icon');
    expect(projectCell('custom').textContent).toBe('Custom project');
    expect(projectCell('auto').querySelector('img')?.getAttribute('src')).toBe('blob:project-icon');
    expect(projectCell('auto').textContent).toBe('Site project');
    expect(projectCell('plain').querySelector('img')).toBeNull();
    expect(projectCell('plain').textContent).toBe('Plain project');
    expect(iconFetch.mock.calls.map(([path]) => path).sort()).toEqual(projects.slice(0, 2).map(project => `/api/projects/${project.id}/icon`).sort());
    await act(async () => projectCell('custom').querySelector('img')!.dispatchEvent(new Event('error')));
    expect(projectCell('custom').querySelector('img')).toBeNull();
    expect(projectCell('custom').textContent).toBe('Custom project');
    await act(async () => useProjectsStore.setState({ projects: projects.map(project => ({ ...project, iconImage: undefined })) }));
    expect(projectCell('auto').querySelector('img')).toBeNull();
    expect(projectCell('auto').textContent).toBe('Site project');
  } finally {
    await act(async () => { root.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    useGlobalSessionsStore.setState({ activeSessions: [] });
    createUrl.mockRestore();
    client.clear(); host.remove();
  }
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
  client.setQueryData(['search', ''], [{ id: 'session-time', title: 'Timestamp conversation', directory: '/project', time }]);
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
  client.setQueryData(['search', ''], [{ id: 'loop-session', title: 'Loop conversation', directory: '/project', time: { updated: 1 } }]);
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
    id: `session-${i}`, title: `matching conversation ${i}`, directory: '/project', time: { updated: 1000 + i },
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
    expect(host.querySelectorAll('.yuri-global-search-filters .yuri-global-search-group-count').length).toBeGreaterThan(1);
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
    await act(async () => host.querySelector<HTMLButtonElement>('[data-search-category="commands"]')!.click());
    expect(host.textContent).not.toContain('common.loading');
    expect(signal.aborted).toBe(false);
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
  useProjectsStore.setState({ projects: [{ id: 'cold', path: '/cold-project' }, { id: 'project', path: '/project' }] });
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
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    const selectedBeforeFiles = host.querySelector('[cmdk-item][data-selected="true"]')?.getAttribute('data-value');
    await act(async () => {
      finishFiles([{ path: '/cold-project/matching.ts' }]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(host.querySelector('[data-value="file:/cold-project/matching.ts"]')).not.toBeNull());
    expect(host.querySelector('[cmdk-item][data-selected="true"]')?.getAttribute('data-value')).toBe(selectedBeforeFiles);
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

test.each(['page', 'dialog'] as const)('%s mixes individual results and filters categories without changing query, refetching or executing a row', async (presentation) => {
  fileSearch.mockClear().mockResolvedValue([{ path: '/project/login' }]);
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/project', label: 'login project' }] });
  useSessionUIStore.setState({ currentSessionId: 'focused', currentSessionDirectory: '/project' });
  const host = document.createElement('div');
  document.body.append(host);
  const stylesheet = document.createElement('style');
  stylesheet.textContent = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'command-palette.css'), 'utf8');
  document.head.append(stylesheet);
  const surface = presentation === 'page' ? host : document.body;
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['search', 'login'], [{ id: 'partial', title: 'Fix login', directory: '/project', time: { updated: 10 } }]);
  client.setQueryData(['content-search', 'login'], [{ sessionID: 'body', messageID: 'body-hit', title: 'Unrelated work', directory: '/project', role: 'user', createdAt: 2, snippet: 'login' }]);
  const context: React.ContextType<typeof GuiPluginsContext> = {
    host: null, snapshot: { plugins: [], commands: [{ key: 'login', title: 'login-helper', run: vi.fn() }], titlebarItems: [], panels: [], pages: [], settings: [], menuItems: [], activePanel: null },
    inventory: [], error: null, loading: false, requested: true, requestLoad: vi.fn(), setEnabled: vi.fn(), refresh: vi.fn(),
  };
  useUIStore.getState().setCommandPaletteOpen(true);
  const clickCategory = async (category: string) => {
    await act(async () => surface.querySelector<HTMLButtonElement>(`[data-search-category="${category}"]`)!.click());
  };
  const rows = () => [...surface.querySelectorAll('[cmdk-item]')].map((row) => row.getAttribute('data-value'));
  try {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <GuiPluginsContext.Provider value={context}><CommandPalette presentation={presentation} /></GuiPluginsContext.Provider>
    </QueryClientProvider>));
    const input = surface.querySelector<HTMLInputElement>('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'login');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(rows()).toContain('file:/project/login');
    expect(rows()[0]).toBe('file:/project/login');
    expect(rows().indexOf('gui-plugin:login')).toBeLessThan(rows().indexOf('session:partial'));
    expect(rows().indexOf('session:partial')).toBeLessThan(rows().indexOf('message:body:body-hit'));
    const sessionHeadingStyle = getComputedStyle(surface.querySelector('.yuri-global-search-session-heading')!);
    expect(sessionHeadingStyle.display).toBe('flex');
    if (presentation === 'dialog') {
      const filters = surface.querySelector('.yuri-global-search-filters')!;
      expect(getComputedStyle(filters).paddingLeft).toBe('16px');
      expect(filters.querySelector('button')?.className).toContain('h-6');
      expect(filters.querySelector('button')?.className).toContain('px-2');
      const arrowHints = filters.querySelector('[data-search-category-shortcuts]')!;
      expect(arrowHints.querySelectorAll('kbd[data-variant="hint"]')).toHaveLength(2);
      expect(arrowHints.querySelector('kbd[aria-label="ArrowLeft"]')?.textContent).toBe('←');
      expect(arrowHints.querySelector('kbd[aria-label="ArrowRight"]')?.textContent).toBe('→');
      expect(arrowHints.textContent).toContain('commandPalette.filter.switch');
      const resultKeycap = surface.querySelector('[cmdk-item] kbd')!;
      expect(arrowHints.querySelector('kbd')?.className).toBe(resultKeycap.className.replace(/\bjustify-self-end\b/g, '').trim());
      [...surface.querySelectorAll('[cmdk-item]')].forEach((row, index) => {
        expect(row.getAttribute('aria-keyshortcuts')).toMatch(new RegExp(`^(Meta|Control)\\+${index + 1}$`));
        expect(row.querySelector('kbd[data-variant="hint"]')?.textContent).toMatch(new RegExp(`${index + 1}$`));
      });
    } else {
      expect(surface.querySelector('[data-search-category-shortcuts]')).toBeNull();
      expect(surface.querySelector('[cmdk-item][aria-keyshortcuts]')).toBeNull();
    }
    expect(surface.querySelectorAll('[cmdk-group-heading]')).toHaveLength(0);
    const requests = fileSearch.mock.calls.length;
    await clickCategory('sessions');
    expect(rows()).toEqual(['session:partial', 'message:body:body-hit']);
    await clickCategory('files');
    expect(rows()).toEqual(['file:/project/login']);
    await clickCategory('projects');
    expect(rows()).toEqual(['project:project']);
    await clickCategory('commands');
    expect(rows()).toEqual(['gui-plugin:login']);
    await act(async () => surface.querySelector('[data-search-category="settings"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(true);
    await clickCategory('settings');
    expect(rows()).toEqual([]);
    expect(surface.textContent).toContain('commandPalette.empty.noResults');
    expect(surface.querySelector('[data-file-search-pending]')).toBeNull();
    for (let i = 0; i < 50; i++) await clickCategory(i % 2 ? 'files' : 'all');
    expect(input.value).toBe('login');
    expect(document.activeElement).toBe(input);
    const pressArrow = async (key: string, options: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
      await act(async () => input.dispatchEvent(event));
      return event;
    };
    for (const category of ['projects', 'commands', 'settings', 'all', 'sessions', 'files']) {
      expect((await pressArrow('ArrowRight')).defaultPrevented).toBe(true);
      expect(surface.querySelector(`[data-search-category="${category}"]`)?.getAttribute('aria-pressed')).toBe('true');
      expect(document.activeElement).toBe(input);
    }
    for (const category of ['sessions', 'all', 'settings']) {
      await pressArrow('ArrowLeft');
      expect(surface.querySelector(`[data-search-category="${category}"]`)?.getAttribute('aria-pressed')).toBe('true');
    }
    for (const options of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
      expect((await pressArrow('ArrowRight', options)).defaultPrevented).toBe(false);
      expect(surface.querySelector('[data-search-category="settings"]')?.getAttribute('aria-pressed')).toBe('true');
    }
    expect(input.value).toBe('login');
    expect(fileSearch).toHaveBeenCalledTimes(requests);
    expect(context.requestLoad).not.toHaveBeenCalled();
    await clickCategory('projects');
    await act(async () => (surface.querySelector('[data-value="project:project"]') as HTMLElement).click());
    expect(useSessionUIStore.getState().openNewSessionDraft).toHaveBeenCalledWith({ selectedProjectId: 'project', directoryOverride: '/project' });
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(false);
    await act(async () => useUIStore.getState().setCommandPaletteOpen(false));
    await act(async () => useUIStore.getState().setCommandPaletteOpen(true));
    expect(surface.querySelector<HTMLInputElement>('input')!.value).toBe('');
    expect(surface.querySelector('[data-search-category="all"]')?.getAttribute('aria-pressed')).toBe('true');
  } finally {
    await act(async () => { root.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    useProjectsStore.setState({ projects: [] });
    fileSearch.mockReset(); client.clear(); host.remove(); stylesheet.remove();
  }
});

test.each([
  { kind: 'files', category: 'files', index: 0, mac: true },
  { kind: 'projects', category: 'projects', index: 1, mac: true },
  { kind: 'projects', category: 'projects', index: 1, mac: false },
  { kind: 'sessions', category: 'sessions', index: 1, mac: true },
  { kind: 'messages', category: 'sessions', index: 0, mac: true },
  { kind: 'commands', category: 'commands', index: 0, mac: true },
  { kind: 'settings', category: 'settings', index: 0, mac: true },
  { kind: 'plugins', category: 'commands', index: 0, mac: true },
  { kind: 'more', category: 'projects', index: 5, mac: true },
])('$kind uses the displayed numeric shortcut (mac: $mac)', async ({ kind, category, index, mac }) => {
  const userAgent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(mac ? 'Macintosh' : 'Windows');
  const query = kind === 'commands' ? 'commandPalette.item.newSession' : kind === 'settings' ? 'Appearance' : 'login';
  const openDraft = vi.mocked(useSessionUIStore.getState().openNewSessionDraft);
  const openSession = vi.mocked(useSessionUIStore.getState().setCurrentSession);
  openDraft.mockClear(); openSession.mockClear();
  const previousUI = useUIStore.getState();
  const openFile = vi.fn();
  useUIStore.setState({ openContextFile: openFile, isSettingsDialogOpen: false });
  useProjectsStore.setState({ projects: Array.from({ length: 6 }, (_, i) => ({ id: `project-${i}`, path: `/project-${i}`, label: `login ${i}` })) });
  useSessionUIStore.setState({ currentSessionId: 'focused', currentSessionDirectory: '/project-0' });
  fileSearch.mockResolvedValue([{ path: '/project-0/login' }]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['search', query], kind === 'sessions' ? [
    { id: 'session-0', title: 'login 0', directory: '/project-0' }, { id: 'session-1', title: 'login 1', directory: '/project-0' },
  ] : []);
  client.setQueryData(['content-search', query], kind === 'messages' ? [{
    sessionID: 'body', messageID: 'body-hit', title: 'login body', directory: '/project-0', role: 'user', createdAt: 2, snippet: 'login',
  }] : []);
  const context: React.ContextType<typeof GuiPluginsContext> = {
    host: null, snapshot: { plugins: [], commands: kind === 'plugins' ? [{ key: 'login', title: 'login', run: vi.fn() }] : [], titlebarItems: [], panels: [], pages: [], settings: [], menuItems: [], activePanel: null },
    inventory: [], error: null, loading: false, requested: true, requestLoad: vi.fn(), setEnabled: vi.fn(), refresh: vi.fn(),
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  useUIStore.getState().setCommandPaletteOpen(true);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <GuiPluginsContext.Provider value={context}><CommandPalette /></GuiPluginsContext.Provider>
    </QueryClientProvider>));
    const input = document.querySelector<HTMLInputElement>('[data-global-search] input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    await act(async () => document.querySelector<HTMLButtonElement>(`[data-search-category="${category}"]`)!.click());
    const row = document.querySelectorAll('[data-global-search] [cmdk-item]')[index];
    expect(row).toBeDefined();
    expect(row.getAttribute('aria-keyshortcuts')).toBe(`${mac ? 'Meta' : 'Control'}+${index + 1}`);
    expect(row.querySelector('kbd')?.textContent).toBe(`${mac ? '⌘' : 'Ctrl+'}${index + 1}`);
    const press = async (options: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', { key: String(index + 1), bubbles: true, cancelable: true, metaKey: mac, ctrlKey: !mac, ...options });
      await act(async () => input.dispatchEvent(event));
      return event;
    };
    for (const options of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }, { shiftKey: true }, { altKey: true }, { metaKey: !mac, ctrlKey: mac }]) {
      await press(options);
      expect(useUIStore.getState().isCommandPaletteOpen).toBe(true);
      expect(openDraft).not.toHaveBeenCalled();
      expect(openSession).not.toHaveBeenCalled();
      expect(openFile).not.toHaveBeenCalled();
      expect(useUIStore.getState().isSettingsDialogOpen).toBe(false);
    }
    expect((await press()).defaultPrevented).toBe(true);
    if (kind === 'more') {
      expect(useUIStore.getState().isCommandPaletteOpen).toBe(true);
      expect(document.querySelectorAll('[cmdk-item][data-value^="project:"]')).toHaveLength(6);
      expect(document.querySelector('[data-value="more:projects"]')).toBeNull();
    } else {
      expect(useUIStore.getState().isCommandPaletteOpen).toBe(false);
    }
    if (kind === 'files') expect(openFile).toHaveBeenCalledWith('/project-0', '/project-0/login');
    if (kind === 'projects') expect(openDraft).toHaveBeenCalledWith({ selectedProjectId: 'project-1', directoryOverride: '/project-1' });
    if (kind === 'sessions') expect(openSession).toHaveBeenCalledWith('session-1', '/project-0');
    if (kind === 'messages') {
      const { focusChatMessage } = await import('@/components/chat/hooks/useChatTurnNavigation');
      expect(focusChatMessage).toHaveBeenCalledWith('body-hit');
    }
    if (kind === 'commands') expect(openDraft).toHaveBeenCalledWith();
    if (kind === 'settings') expect(useUIStore.getState().settingsPage).toBe('appearance');
  } finally {
    await act(async () => { root.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    useUIStore.setState({ openContextFile: previousUI.openContextFile, isSettingsDialogOpen: previousUI.isSettingsDialogOpen, settingsPage: previousUI.settingsPage });
    useProjectsStore.setState({ projects: [] });
    fileSearch.mockReset(); client.clear(); host.remove(); userAgent.mockRestore();
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
    { id: 'project', path: '/project' },
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
