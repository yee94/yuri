import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AssistantMiniChatLayout } from './AssistantMiniChatLayout';

const state = vi.hoisted(() => ({
  capability: { data: { supported: true, enabled: true }, isPending: false, isError: false, refetch: vi.fn() },
  snapshot: { data: { enabled: true, assistants: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }, isPending: false, isError: false, refetch: vi.fn() },
  initialize: vi.fn(),
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/queries/assistantQueries', () => ({ useAssistantCapabilityQuery: () => state.capability, useAssistantSnapshotQuery: () => state.snapshot }));
vi.mock('@/stores/useConfigStore', () => ({ useConfigStore: (select: (state: unknown) => unknown) => select({ initializeApp: state.initialize }) }));
vi.mock('./MiniChatWindowHeader', () => ({ MiniChatWindowHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header> }));
vi.mock('@/components/assistants/AssistantConversationSurface', () => ({ AssistantConversationSurface: ({ assistant, warning, active }: { assistant: { id: string }; warning?: string; active: boolean }) => <div data-contact={assistant.id} data-active={active}>{warning}</div> }));
vi.mock('@/components/assistants/AssistantWorkingAvatar', () => ({ AssistantWorkingAvatar: () => null }));
vi.mock('@/components/assistants/AssistantContactStatus', () => ({ AssistantContactStatus: () => null }));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.capability.data = { supported: true, enabled: true }; state.capability.isPending = false; state.capability.isError = false;
  state.snapshot.isPending = false; state.snapshot.isError = false;
  state.snapshot.data = { enabled: true, assistants: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] };
  vi.clearAllMocks();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = (assistantID = 'b') => act(async () => root.render(<AssistantMiniChatLayout assistantID={assistantID} />));

test('renders only the explicit Bot contact and updates its title without opening a coding session', async () => {
  await render();
  expect(host.querySelector('[data-contact="b"][data-active="true"]')).not.toBeNull();
  expect(document.title).toBe('B — Yuri');
  expect(state.initialize).toHaveBeenCalledOnce();
  state.snapshot.data.assistants[1] = { id: 'b', name: 'Renamed' };
  await render();
  expect(document.title).toBe('Renamed — Yuri');
});

test('deleted and disabled contacts never fall back to another Bot', async () => {
  await render('missing');
  expect(host.querySelector('[data-contact]')).toBeNull();
  expect(host.textContent).toContain('assistants.state.unavailable');
  state.capability.data.enabled = false;
  await render('a');
  expect(host.querySelector('[data-contact]')).toBeNull();
});

test('loading is separate from unavailable, refresh failures preserve the existing contact, and initial failures can retry', async () => {
  state.snapshot.isPending = true;
  await render();
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  state.snapshot.isPending = false; state.snapshot.isError = true;
  await render();
  expect(host.querySelector('[data-contact="b"]')?.textContent).toBe('assistants.state.staleSnapshot');
  state.snapshot.data.assistants = [];
  await render();
  await act(async () => host.querySelector('button')!.click());
  expect(state.snapshot.refetch).toHaveBeenCalledOnce(); expect(state.capability.refetch).toHaveBeenCalledOnce();
});
