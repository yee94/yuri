import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AssistantDTO } from '@/queries/assistantQueries';
import { AssistantPinnedContacts } from './AssistantPinnedContacts';
import { AssistantContactMenu } from './AssistantContactMenu';

const calls = vi.hoisted(() => ({ update: vi.fn(), error: vi.fn(), miniChat: vi.fn(), miniChatAvailable: false }));
vi.mock('@/lib/assistant-mini-chat', () => ({ canOpenAssistantMiniChat: () => calls.miniChatAvailable, openAssistantMiniChat: calls.miniChat }));
vi.mock('@/queries/assistantQueries', () => ({ updateAssistant: calls.update }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => 'runtime' }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({ toast: { error: calls.error } }));
vi.mock('./AssistantWorkingAvatar', () => ({ AssistantWorkingAvatar: ({ size, working, label }: { size: number; working: boolean; label: string }) => <span data-avatar-size={size} data-working={working} aria-label={label} /> }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const assistant = { id: 'a', name: 'A very long bot name', pinnedAt: 10, unreadCount: 4, working: true, revision: 3 } as AssistantDTO;
beforeEach(() => {
  calls.update.mockReset().mockResolvedValue({ ...assistant, pinnedAt: null });
  calls.error.mockReset();
  calls.miniChatAvailable = false;
  calls.miniChat.mockReset().mockResolvedValue(undefined);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); client.clear();
});
const render = async (node: React.ReactNode) => act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
const openMenu = async () => act(async () => {
  host.querySelector('button')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 40, clientY: 40 }));
});
const menuItems = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));

test('pinned contacts show large faces, names, selection, unread and live work, and navigate normally', async () => {
  const select = vi.fn(); const edit = vi.fn(); const remove = vi.fn();
  await render(<AssistantPinnedContacts contacts={[assistant]} selectedAssistantID="a" onSelect={select} onEdit={edit} onDelete={remove} />);
  expect(host.querySelector('[data-avatar-size="64"][data-working="true"]')).not.toBeNull();
  expect(host.querySelector('[data-assistant-pinned="a"]')?.classList.contains('max-w-28')).toBe(true);
  expect(host.querySelector('[role="group"]')?.classList.contains('yuri-assistant-pinned-contacts')).toBe(true);
  expect(host.querySelector('[aria-selected="true"]')?.getAttribute('title')).toBe(assistant.name);
  expect(host.textContent).toContain(assistant.name);
  expect(host.querySelector('[data-assistant-unread-count]')?.textContent).toBe('4');
  await act(async () => host.querySelector('button')!.click());
  expect(select).toHaveBeenCalledExactlyOnceWith('a');
  await openMenu();
  expect(menuItems()[0].textContent).toBe('assistants.menu.unpin');
  await act(async () => menuItems()[0].click());
  expect(calls.update).toHaveBeenCalledExactlyOnceWith(assistant, { pinned: false });
  expect(edit).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
});

test('ordinary contacts offer pin without selecting or editing the contact', async () => {
  const unpinned = { ...assistant, pinnedAt: null };
  const select = vi.fn(); const edit = vi.fn(); const remove = vi.fn();
  await render(<AssistantContactMenu assistant={unpinned} trigger={<button onClick={select}>A</button>} onEdit={edit} onDelete={remove} />);
  await openMenu();
  expect(menuItems()[0].textContent).toBe('assistants.menu.pin');
  await act(async () => menuItems()[0].click());
  expect(calls.update).toHaveBeenCalledExactlyOnceWith(unpinned, { pinned: true });
  expect(select).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
});

test('failed writes retain the pinned tile, report failure and permit retry', async () => {
  calls.update.mockRejectedValueOnce(new Error('offline'));
  await render(<AssistantPinnedContacts contacts={[assistant]} onSelect={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />);
  await openMenu();
  await act(async () => menuItems()[0].click());
  await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
  expect(calls.error).toHaveBeenCalledExactlyOnceWith('assistants.menu.pinError');
  expect(host.querySelector('[data-assistant-pinned="a"]')).not.toBeNull();
  await openMenu();
  await act(async () => menuItems()[0].click());
  expect(calls.update).toHaveBeenCalledTimes(2);
});

test('legacy Hosts omit pin controls while retaining edit/delete, and empty pins render no group', async () => {
  const edit = vi.fn(); const remove = vi.fn();
  await render(<AssistantContactMenu assistant={{ ...assistant, pinnedAt: undefined }} trigger={<button>A</button>} onEdit={edit} onDelete={remove} />);
  await openMenu();
  expect(menuItems().map(item => item.textContent)).toEqual(['assistants.menu.edit', 'assistants.settings.delete']);
  await act(async () => menuItems()[0].click());
  expect(edit).toHaveBeenCalledOnce();
  await render(<AssistantPinnedContacts contacts={[]} onSelect={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />);
  expect(host.childElementCount).toBe(0);
});

test('desktop opens the exact Bot in Mini Chat without changing contact pin or selection', async () => {
  calls.miniChatAvailable = true;
  const select = vi.fn(); const edit = vi.fn(); const remove = vi.fn();
  await render(<AssistantContactMenu assistant={assistant} trigger={<button onClick={select}>A</button>} onEdit={edit} onDelete={remove} />);
  await openMenu();
  const entry = menuItems().find((item) => item.textContent === 'sessions.sidebar.session.menu.openMiniChatWindow')!;
  await act(async () => entry.click());
  expect(calls.miniChat).toHaveBeenCalledExactlyOnceWith(assistant.id);
  expect(calls.update).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled();
});

test('failed Mini Chat opening reports an error and retains the contact', async () => {
  calls.miniChatAvailable = true;
  calls.miniChat.mockRejectedValueOnce(new Error('unsupported shell'));
  await render(<AssistantContactMenu assistant={assistant} trigger={<button>A</button>} onEdit={vi.fn()} onDelete={vi.fn()} />);
  await openMenu();
  await act(async () => menuItems().find((item) => item.textContent === 'sessions.sidebar.session.menu.openMiniChatWindow')!.click());
  expect(calls.error).toHaveBeenCalledWith('miniChat.actions.failed');
  expect(host.querySelector('button')?.textContent).toBe('A');
});

test('double-click opens the selected contact only when Mini Chat is available', async () => {
  const select = vi.fn();
  await render(<AssistantPinnedContacts contacts={[assistant]} onSelect={select} onEdit={vi.fn()} onDelete={vi.fn()} />);
  const button = host.querySelector('button')!;
  await act(async () => button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  expect(calls.miniChat).not.toHaveBeenCalled();
  calls.miniChatAvailable = true;
  await act(async () => button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  expect(calls.miniChat).toHaveBeenCalledExactlyOnceWith(assistant.id);
});

test('ordinary contact double-click uses the same error handling and delete icon inherits its label color', async () => {
  calls.miniChatAvailable = true;
  calls.miniChat.mockRejectedValueOnce(new Error('failed'));
  await render(<AssistantContactMenu assistant={assistant} doubleClickMiniChat trigger={<button>A</button>} onEdit={vi.fn()} onDelete={vi.fn()} />);
  await act(async () => host.querySelector('button')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  expect(calls.error).toHaveBeenCalledWith('miniChat.actions.failed');
  await openMenu();
  const deletion = menuItems().find(item => item.textContent === 'assistants.settings.delete')!;
  expect(deletion.querySelector('svg')?.classList.contains('text-inherit')).toBe(true);
});
