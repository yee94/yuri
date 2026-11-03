import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AssistantDTO, AssistantSnapshot } from '@/queries/assistantQueries';

const state = vi.hoisted(() => ({ queryCalls: vi.fn(), avatar: vi.fn() }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({
  t: (key: string, params?: { name: string }) => params ? `${key}:${params.name}` : key,
}) }));
vi.mock('@/queries/assistantQueries', async () => {
  const { useQuery } = await import('@tanstack/react-query');
  return { useAssistantSnapshotQuery: (select: (snapshot: AssistantSnapshot) => unknown) => {
    state.queryCalls();
    return useQuery({
      queryKey: ['schedule-hint-snapshot'],
      queryFn: async () => { throw new Error('offline'); },
      select,
      enabled: false,
      retry: false,
    });
  } };
});
vi.mock('@/components/assistants/ProceduralAssistantAvatar', () => ({
  ProceduralAssistantAvatar: (props: { seed: string; motion: string; followPointer: boolean; blinkOnMount: boolean }) => {
    state.avatar(props);
    return <span data-avatar-seed={props.seed} data-motion={props.motion} />;
  },
}));
vi.mock('@/sync/session-ui-store', async () => {
  const { create } = await import('zustand');
  return { useSessionUIStore: create(() => ({ currentSessionId: null, setCurrentSession: vi.fn() })) };
});

import { MobileScheduleAssistantHint } from './MobileScheduleAssistantHint';
import { useMobileNavigationStore } from '../useMobileNavigationStore';
import { getSelectedAssistantID } from '@/stores/useAssistantUIStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const assistant = (id: string, pinnedAt: number | null = null): AssistantDTO => ({
  id, name: id, avatarSeed: `seed-${id}`, pinnedAt, revision: 1, enabled: true,
  defaultPrompt: '', workspacePath: null, effectiveWorkspacePath: '/workspace', managedWorkspacePath: null,
  providerID: 'provider', modelID: 'model', agent: null, variant: null, mode: 'continuous',
  sessionID: null, sessionGeneration: 0, historySessionIDs: [], historySessionCount: 0,
  assignedSessionIDs: [], working: false, activeContactTurn: null, createdAt: 1, updatedAt: 1, tombstoneAt: null,
});
const setSnapshot = (assistants: AssistantDTO[], enabled = true) => act(async () => {
  client.setQueryData<AssistantSnapshot>(['schedule-hint-snapshot'], { revision: 1, enabled, assistants });
  await new Promise(resolve => setTimeout(resolve, 0));
});
const render = (active = true, revision = 0) => act(async () => {
  root.render(<QueryClientProvider client={client}><div data-revision={revision}><MobileScheduleAssistantHint active={active} /></div></QueryClientProvider>);
});
const button = () => host.querySelector<HTMLButtonElement>('.yuri-mobile-schedule-assistant');
const finishAnimation = (target: Element, animationName = 'yuri-schedule-assistant-clip') => act(async () => {
  target.dispatchEvent(Object.assign(new Event('animationend', { bubbles: true }), { animationName }));
});

beforeEach(() => {
  state.queryCalls.mockClear();
  state.avatar.mockClear();
  useMobileNavigationStore.getState().reset();
  useMobileNavigationStore.getState().setActiveTab('scheduled');
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); client.clear(); useMobileNavigationStore.getState().reset();
});

test.each(['avatar', 'text'])('%s opens the pinned Bot directly, preserving Schedule as the return tab', async target => {
  await setSnapshot([assistant('first'), assistant('pinned', 20)]);
  await render();
  expect(host.querySelector('[data-avatar-seed="seed-pinned"]')).not.toBeNull();
  expect(state.avatar).toHaveBeenLastCalledWith(expect.objectContaining({ motion: 'working', followPointer: false, blinkOnMount: true }));
  await act(async () => host.querySelector<HTMLElement>(target === 'avatar' ? '[data-avatar-seed]' : '.yuri-mobile-schedule-assistant-label')!.click());
  expect(getSelectedAssistantID()).toBe('pinned');
  expect(useMobileNavigationStore.getState()).toMatchObject({ activeTab: 'scheduled', secondary: { kind: 'assistant' } });
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(host.querySelector('textarea,input,form')).toBeNull();
  expect(button()).toBeNull();
  await act(async () => useMobileNavigationStore.getState().closeSecondary());
  expect(button()).not.toBeNull();
});

test('without a pin, uses the first source-catalog Bot, not message recency or a saved selection', async () => {
  const first = assistant('first');
  const recent = { ...assistant('recent'), latestMessagePreview: { createdAt: 999, messageID: 'm', ordinal: 1, role: 'assistant' as const, text: 'latest', fallbackKind: null } };
  await setSnapshot([first, recent]);
  await render();
  expect(host.querySelector('[data-avatar-seed="seed-first"]')).not.toBeNull();
  await act(async () => button()!.click());
  expect(getSelectedAssistantID()).toBe('first');
});

test('legacy multiple pins choose the latest pin and live pin changes update both avatar and destination', async () => {
  await setSnapshot([assistant('first', 10), assistant('newest', 20)]);
  await render();
  expect(host.querySelector('[data-avatar-seed="seed-newest"]')).not.toBeNull();
  await setSnapshot([assistant('first', 30), assistant('newest')]);
  expect(host.querySelector('[data-avatar-seed="seed-first"]')).not.toBeNull();
  await act(async () => button()!.click());
  expect(getSelectedAssistantID()).toBe('first');
});

test('only the capsule completion retracts the hint; blinking child animations never dismiss it', async () => {
  await setSnapshot([assistant('first')]);
  await render();
  expect(button()!.dataset.visiting).toBe('true');
  await finishAnimation(host.querySelector('[data-avatar-seed]')!);
  await finishAnimation(button()!, 'another-animation');
  expect(button()!.dataset.visiting).toBe('true');
  const avatar = host.querySelector('[data-avatar-seed]');
  await finishAnimation(button()!);
  expect(button()!.dataset.visiting).toBe('false');
  expect(host.querySelector('[data-avatar-seed]')).toBe(avatar);
  await act(async () => button()!.click());
  expect(getSelectedAssistantID()).toBe('first');
});

test('empty, disabled and cold snapshots show no fake Bot; failed refresh retains the known target', async () => {
  await render();
  expect(button()).toBeNull();
  await setSnapshot([]);
  expect(button()).toBeNull();
  await setSnapshot([assistant('first')], false);
  expect(button()).toBeNull();
  await setSnapshot([assistant('first')]);
  expect(button()).not.toBeNull();
  await act(async () => {
    await client.fetchQuery({ queryKey: ['schedule-hint-snapshot'], queryFn: async () => { throw new Error('offline'); }, retry: false }).catch(() => undefined);
  });
  expect(host.querySelector('[data-avatar-seed="seed-first"]')).not.toBeNull();
  await setSnapshot([]);
  expect(button()).toBeNull();
});

test('inactive tabs, covered pages and an open task editor mount no hint query or avatar', async () => {
  await setSnapshot([assistant('first')]);
  await render(false);
  expect(state.queryCalls).not.toHaveBeenCalled();
  await act(async () => useMobileNavigationStore.getState().setActiveTab('projects'));
  await render();
  expect(state.queryCalls).not.toHaveBeenCalled();
  await act(async () => {
    useMobileNavigationStore.getState().setActiveTab('scheduled');
    useMobileNavigationStore.getState().openAssistant('first');
  });
  expect(state.queryCalls).not.toHaveBeenCalled();
  expect(state.avatar).not.toHaveBeenCalled();
});

test('50 unrelated parent updates and unrelated snapshot fields do not restart the hint or avatar', async () => {
  await setSnapshot([assistant('first')]);
  await render();
  const initialQueryCalls = state.queryCalls.mock.calls.length;
  const initialAvatarCalls = state.avatar.mock.calls.length;
  for (let i = 1; i <= 50; i++) await render(true, i);
  expect(state.queryCalls).toHaveBeenCalledTimes(initialQueryCalls);
  expect(state.avatar).toHaveBeenCalledTimes(initialAvatarCalls);
  await setSnapshot([{ ...assistant('first'), working: true, unreadCount: 5 }]);
  expect(state.avatar).toHaveBeenCalledTimes(initialAvatarCalls);
  expect(button()!.dataset.visiting).toBe('true');
});

test('the runtime navigation reset drops the prior Host Bot before the next Schedule visit', async () => {
  await setSnapshot([assistant('old-host', 10)]);
  await render();
  expect(host.querySelector('[data-avatar-seed="seed-old-host"]')).not.toBeNull();
  await act(async () => {
    useMobileNavigationStore.getState().reset();
    client.clear();
  });
  expect(button()).toBeNull();
  await setSnapshot([assistant('new-host')]);
  await act(async () => useMobileNavigationStore.getState().setActiveTab('scheduled'));
  expect(host.querySelector('[data-avatar-seed="seed-new-host"]')).not.toBeNull();
  await act(async () => button()!.click());
  expect(getSelectedAssistantID()).toBe('new-host');
});
