import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AssistantView } from './AssistantView';

const state = vi.hoisted(() => ({
  mobile: false,
  selected: 'bot-a',
  settings: vi.fn(),
  select: vi.fn(),
  assistants: [
    { id: 'bot-a', name: 'A very long Assistant name', avatarSeed: 'seed-a', working: false, pinnedAt: null },
    { id: 'bot-b', name: 'Second bot', avatarSeed: 'seed-b', working: true, pinnedAt: null },
  ],
}));

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: state.mobile }) }));
vi.mock('@/apps/mobileAppContext', () => ({ useMobileAppActions: () => null }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => 'runtime',
  subscribeRuntimeEndpointChanged: () => () => undefined,
}));
vi.mock('@/queries/assistantQueries', () => ({
  useAssistantCapabilityQuery: () => ({ data: { supported: true, enabled: true }, isPending: false, isError: false }),
  useAssistantSnapshotQuery: () => ({ data: { enabled: true, assistants: state.assistants }, isPending: false, isError: false, isSuccess: true }),
}));
vi.mock('@/stores/useAssistantUIStore', () => ({
  openAssistantSettings: state.settings,
  useAssistantUIStore: (selector: (value: unknown) => unknown) => selector({
    assistantByTransport: { runtime: state.selected }, selectAssistant: state.select, requestCreate: vi.fn(),
  }),
}));
vi.mock('@/stores/useUIStore', () => ({
  useUIStore: (selector: (value: unknown) => unknown) => selector({ activeMainTab: 'assistant', isMobile: state.mobile }),
}));
vi.mock('./assistantWorking', () => ({ useAssistantWorking: () => false }));
vi.mock('./AssistantWorkingAvatar', () => ({
  AssistantWorkingAvatar: ({ name, label, size }: { name: string; label: string; size: number }) => <span data-avatar={name} data-size={size} aria-label={label} />,
}));
vi.mock('./AssistantConversationSurface', () => ({ AssistantConversationSurface: () => <div data-transcript="" /> }));
vi.mock('./AssistantContactMenu', () => ({ AssistantContactMenu: ({ trigger }: { trigger: React.ReactNode }) => trigger }));
vi.mock('./AssistantPinnedContacts', () => ({ AssistantPinnedContacts: () => null }));
vi.mock('./AssistantMarkAllReadButton', () => ({ AssistantMarkAllReadButton: () => null }));
vi.mock('./AssistantUnreadBadge', () => ({ AssistantUnreadBadge: () => null }));
vi.mock('./AssistantDeleteConfirmDialog', () => ({ AssistantDeleteConfirmDialog: () => null }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  state.mobile = false;
  state.selected = 'bot-a';
  state.settings.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

test('desktop identity is the only conversation header action and opens the current Bot settings', async () => {
  await act(async () => root.render(<AssistantView />));
  const header = host.querySelector('.yuri-assistant-conversation-header')!;
  expect(header.querySelectorAll('button')).toHaveLength(1);
  expect(header.querySelector('[data-avatar="bot-a"][data-size="56"]')).not.toBeNull();
  expect(header.textContent).toBe('A very long Assistant name');
  expect(header.querySelector('button')?.getAttribute('aria-label')).toBe('assistants.conversation.openSettings');
  await act(async () => header.querySelector('button')!.click());
  expect(state.settings).toHaveBeenLastCalledWith('bot-a', undefined);
  state.selected = 'bot-b';
  await act(async () => root.render(<AssistantView />));
  await act(async () => header.querySelector('button')!.click());
  expect(header.textContent).toBe('Second bot');
  expect(state.settings).toHaveBeenLastCalledWith('bot-b', undefined);
});

test('phone identity uses its Settings stack while Back remains independently available', async () => {
  state.mobile = true;
  const back = vi.fn();
  const settings = vi.fn();
  await act(async () => root.render(<AssistantView onMobileBack={back} onMobileOpenSettings={settings} />));
  const header = host.querySelector('.yuri-mobile-detail-navigation')!;
  expect(header.querySelectorAll('button')).toHaveLength(2);
  await act(async () => header.querySelector<HTMLButtonElement>('.yuri-assistant-header-identity')!.click());
  expect(settings).toHaveBeenCalledExactlyOnceWith('bot-a');
  expect(state.settings).not.toHaveBeenCalled();
  await act(async () => header.querySelector<HTMLButtonElement>('[aria-label="assistants.actions.backToChat"]')!.click());
  expect(back).toHaveBeenCalledOnce();
});
