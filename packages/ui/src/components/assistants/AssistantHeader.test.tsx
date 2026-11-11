import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
vi.mock('./AssistantConversationSurface', () => ({ AssistantConversationSurface: ({ overlayComposer }: { overlayComposer?: boolean }) => <div data-transcript="" data-composer-overlay={overlayComposer || undefined} /> }));
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
  expect(host.querySelector('[data-transcript]')?.getAttribute('data-composer-overlay')).toBe('true');
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
  expect(host.querySelector('[data-transcript]')?.hasAttribute('data-composer-overlay')).toBe(false);
  expect(header.querySelectorAll('button')).toHaveLength(2);
  const backButton = header.querySelector<HTMLButtonElement>('[aria-label="assistants.actions.backToChat"]')!;
  expect(backButton.classList.contains('yuri-mobile-floating-action')).toBe(true);
  expect(backButton.classList.contains('size-10')).toBe(true);
  await act(async () => header.querySelector<HTMLButtonElement>('.yuri-assistant-header-identity')!.click());
  expect(settings).toHaveBeenCalledExactlyOnceWith('bot-a');
  expect(state.settings).not.toHaveBeenCalled();
  await act(async () => backButton.click());
  expect(back).toHaveBeenCalledOnce();
});

test('phone header keeps its layout and material when cloned without workspace ancestors for native IME', async () => {
  state.mobile = true;
  await act(async () => root.render(<AssistantView onMobileBack={vi.fn()} />));
  const style = document.createElement('style');
  style.textContent = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'assistant-workspace.css'), 'utf8');
  document.head.append(style);
  const clone = host.querySelector('header')!.cloneNode(true) as HTMLElement;
  document.body.append(clone);
  try {
    expect(clone.classList.contains('yuri-assistant-mobile-header')).toBe(true);
    expect(getComputedStyle(clone.querySelector('.yuri-mobile-detail-navigation-content')!).minHeight).toBe('96px');
    expect(getComputedStyle(clone.querySelector('.yuri-mobile-detail-title')!).overflow).toBe('visible');
    expect(getComputedStyle(clone).getPropertyValue('--assistant-panel-background')).toContain('97%');
    expect(getComputedStyle(clone).getPropertyValue('--assistant-panel-shadow')).toContain('12%');
    expect(getComputedStyle(clone).getPropertyValue('--assistant-tag-shadow')).toContain('10%');
  } finally {
    clone.remove();
    style.remove();
  }
});
