import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';

const searchSessions = vi.hoisted(() => vi.fn(async (_query: string) => [
  { id: 'session-1', title: 'Recent conversation', time: { updated: 1 } },
]));
const fileSearch = vi.hoisted(() => vi.fn(async (_request: { directory: string; query: string; maxResults?: number }): Promise<{ path: string }[]> => []));
const readFile = vi.hoisted(() => vi.fn(async (_path: string) => ({ content: '', exists: true })));

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
  sessionTitleSearchQueryOptions: (query: string) => ({ queryKey: ['search', query], queryFn: () => searchSessions(query) }),
}));
vi.mock('@/queries/sessionContentSearchQueries', () => ({
  sessionContentIndexStatusOptions: () => ({ queryKey: ['content-status'], queryFn: async () => ({ phase: 'ready', total: 1, completed: 1, messages: 1 }) }),
  sessionContentSearchQueryOptions: () => ({ queryKey: ['content-search'], queryFn: async () => [{
    sessionID: 'session-1', messageID: 'old-message', directory: '/project', role: 'user', createdAt: 0, snippet: 'old matching body',
  }, {
    sessionID: 'session-1', messageID: 'message-1', directory: '/project', role: 'user', createdAt: 1, snippet: 'matching\n\nbody   result',
  }, {
    sessionID: 'session-1', messageID: 'older-message', directory: '/project', role: 'user', createdAt: 0, snippet: 'another old matching body',
  }], enabled: false }),
}));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => 'test',
  getRuntimeGeneration: () => 1,
  getRuntimeKey: () => 'test',
}));
vi.mock('@/components/chat/hooks/useChatTurnNavigation', () => ({ focusChatMessage: vi.fn() }));

import { CommandPalette } from './CommandPalette';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

test('page presentation has a focused search header and results without dialog chrome', async () => {
  const host = document.createElement('div');
  document.body.append(host);
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
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
    expect(host.querySelector('[data-slot="dialog-close"]')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="header.actions.backAria"]')!.click());
    expect(onBack).toHaveBeenCalledOnce();
  } finally {
    await act(async () => { root.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    client.clear();
    host.remove();
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
      client.setQueryData(['content-search'], [{ sessionID: 'new', messageID: 'new', directory: '/other', role: 'user', createdAt: 2, snippet: 'new background result' }]);
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
    expect(host.querySelectorAll('[cmdk-item][data-value^="session:"]')).toHaveLength(5);
  } finally {
    await act(async () => { root.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    client.clear(); host.remove();
  }
});

test('file results span saved projects and do not need a selected project', async () => {
  fileSearch.mockImplementation(async ({ directory }) => [{ path: `${directory}/CommandPalette.tsx` }]);
  useProjectsStore.setState({ projects: [
    { id: 'a', path: '/project-a', label: 'Project A' },
    { id: 'b', path: '/project-b', label: 'Project B' },
  ] });
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
    expect(fileSearch).toHaveBeenCalledWith({ directory: '/project-a', query: 'Command', maxResults: 10 });
    expect(fileSearch).toHaveBeenCalledWith({ directory: '/project-b', query: 'Command', maxResults: 10 });
    const files = host.querySelectorAll('[cmdk-item][data-value^="file:"]');
    expect(files).toHaveLength(2);
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
      const file = host.querySelector('[data-value="file:/project-b/CommandPalette.tsx"]')!;
      file.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      file.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    expect(readFile).toHaveBeenCalledWith('/project-b/CommandPalette.tsx', { optional: true });
    expect(openFile).toHaveBeenCalledWith('/project', '/project-b/CommandPalette.tsx');
  } finally {
    await act(async () => { root.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    useProjectsStore.setState({ projects: [] });
    useUIStore.setState({ openContextFile: previousOpenFile });
    fileSearch.mockReset();
    client.clear(); host.remove();
  }
});

test.each([false, true])('file search failure stays quiet and preserves other results (partial: %s)', async (partial) => {
  fileSearch.mockImplementation(async ({ directory }) => {
    if (directory === '/offline') throw new Error('offline');
    return [{ path: `${directory}/matching.ts` }];
  });
  useProjectsStore.setState({ projects: [
    { id: 'offline', path: '/offline' },
    ...(partial ? [{ id: 'online', path: '/online' }] : []),
  ] });
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
    const notice = host.querySelector('[data-file-search-notice]')!;
    expect(notice).not.toBeNull();
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.className).toContain('text-muted-foreground');
    expect(notice.className).not.toContain('status-error');
    expect(notice.textContent).toBe(partial ? 'commandPalette.error.filesPartial' : 'commandPalette.error.files');
    expect(host.textContent).not.toContain('mobile.files.error.listFailed');
    expect(host.querySelector('[cmdk-item][data-value^="session:"]')).not.toBeNull();
    expect(host.querySelectorAll('[cmdk-item][data-value^="file:"]')).toHaveLength(partial ? 1 : 0);
    expect(host.textContent).not.toContain('commandPalette.empty');
  } finally {
    await act(async () => { root.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    useProjectsStore.setState({ projects: [] });
    fileSearch.mockReset();
    client.clear(); host.remove();
  }
});
