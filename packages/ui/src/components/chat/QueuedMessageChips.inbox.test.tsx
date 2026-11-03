import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dict } from '@/lib/i18n/messages/en';
import { dict as zh } from '@/lib/i18n/messages/zh-CN';
import { QueuedMessageChips } from './QueuedMessageChips';
import type { SessionComposerPendingItem, SessionInboxChip } from '@/sync/session-inbox-overlay';

const fixture = vi.hoisted(() => ({ items: [] as unknown[], mode: 'legacy', chinese: false, mobile: false, edit: vi.fn(), focus: vi.fn() }));
vi.mock('@/sync/session-inbox-edit', () => ({ editSessionInboxIntoDraft: fixture.edit }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof dict) => (fixture.chinese ? zh : dict)[key] }) }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: vi.fn() }));
vi.mock('@/sync/message-queue-server-runtime', () => ({ isMessageQueuePendingAdmissionItem: (item: { kind?: string }) => item.kind === 'pending-admission' }));
vi.mock('@/sync/queue-abort-optimistic', () => ({ isQueueItemSendPendingByAbortOptimistic: () => false, subscribeQueueAbortOptimistic: () => () => {}, getQueueAbortOptimisticRevision: () => 0 }));
vi.mock('@/sync/use-message-queue-server', () => ({ useMessageQueueServerScope: () => ({ mode: fixture.mode, items: fixture.items, runtimeCapture: { generation: 1 }, actions: {}, scope: null }) }));
vi.mock('@/hooks/useQueuedMessageAutoSend', () => ({ useQueueScopeDispatchFlight: () => false }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (state: { isMobile: boolean }) => unknown) => select({ isMobile: fixture.mobile }) }));
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
const inbox: SessionInboxChip = { kind: 'session-inbox', requestID: 'inbox', queueItemID: 'inbox', operationID: 'inbox', messageID: 'inbox', content: 'Next task', delivery: 'queue', createdAt: 1, attachmentCount: 0 };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.items = []; fixture.mode = 'legacy'; fixture.chinese = false; fixture.mobile = false;
  fixture.edit.mockReset().mockResolvedValue(true); fixture.focus.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); });
async function render(items: SessionComposerPendingItem[] = [], onSteerClientPending?: (id: string) => Promise<void>, steeringMessageIDs?: ReadonlySet<string>, compactionBarrier = false) {
  const key = { transportIdentity: 'test', owner: { kind: 'session' as const, ownerID: 's' } };
  await act(async () => root.render(<QueryClientProvider client={client}><QueuedMessageChips
    onEditMessage={() => true} onSendMessage={() => {}} draftKey={key} draftTarget={{ key, expectedRevision: () => 1 }} onEditCommitted={fixture.focus}
    scope={{ state: 'bound', transportIdentity: 'test', runtimeGeneration: 1, directory: '/a', sessionID: 's', deliveryTarget: { kind: 'primary' } }}
    clientPendingItems={items}
    onSteerClientPending={onSteerClientPending}
    steeringMessageIDs={steeringMessageIDs}
    compactionBarrier={compactionBarrier}
  /></QueryClientProvider>));
}
it('shows the original Chinese queuing state until admission becomes a queued item', async () => {
  fixture.chinese = true;
  await render([{ ...inbox, kind: 'pending-admission', phase: 'admitting' }]);
  expect(host.textContent).toContain('Next task');
  expect(host.textContent).toContain('正在入队…');
  expect(host.textContent).not.toContain('引导中');
  expect(host.querySelector('button[aria-label="引导"]')).toBeNull();
  await render([inbox]);
  expect(host.textContent?.match(/Next task/g)).toHaveLength(1);
  expect(host.textContent).not.toContain('正在入队…');
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="引导"]')?.disabled).toBe(false);
});
it('keeps queued inbox compact and offers Send without execution configuration hints', async () => {
  await render([inbox]);
  expect(host.textContent).toContain('Next task');
  expect(host.textContent).not.toContain('Inherits');
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="steer"]')?.disabled).toBe(false);
});
it.each([false, true])('uses smaller regular-weight desktop actions without changing mobile typography (mobile=%s)', async (mobile) => {
  fixture.mobile = mobile;
  await render([inbox]);
  expect(host.querySelector('button[aria-label="edit"] use')?.getAttribute('href')).toBe('#yuri-pencil');
  expect(host.querySelector('button[aria-label="steer"] use')?.getAttribute('href')).toBe('#yuri-corner-down-left');
  for (const name of ['pencil', 'corner-down-left', 'delete-bin']) {
    expect(host.querySelector(`use[href="#yuri-${name}"]`)?.parentElement?.getAttribute('stroke-width')).toBe(name === 'pencil' ? '1.5' : '2');
  }
  for (const action of ['edit', 'steer']) {
    const label = host.querySelector(`button[aria-label="${action}"] > span`);
    expect(label?.classList.contains('font-normal')).toBe(!mobile);
    expect(label?.classList.contains('text-[length:calc(var(--text-ui-label)-1px)]')).toBe(!mobile);
    expect(label?.classList.contains('font-medium')).toBe(mobile);
  }
});
it.each([false, true])('preserves spaces between image references and surrounding preview text (mobile=%s)', async (mobile) => {
  fixture.mobile = mobile;
  await render([{ ...inbox, content: '前文 [image-1.png] 这个地方需要间距' }]);
  const image = host.querySelector('[data-message-reference-kind="image"]');
  expect(image).not.toBeNull();
  expect(image?.previousElementSibling?.textContent).toBe('前文 ');
  expect(image?.nextElementSibling?.textContent).toBe(' 这个地方需要间距');
  for (const text of [image?.previousElementSibling, image?.nextElementSibling]) {
    expect(text?.classList.contains('whitespace-pre')).toBe(true);
    expect(text?.classList.contains('truncate')).toBe(true);
  }
});
it.each([false, true])('omits the redundant attachment count from queue previews (mobile=%s)', async (mobile) => {
  fixture.mobile = mobile;
  for (const item of [
    { ...inbox, content: '[image-1.png] review', attachmentCount: 1 },
    { ...inbox, kind: 'pending-admission' as const, phase: 'admitting' as const, content: '[image-1.png] review', attachmentCount: 1 },
  ]) {
    await render([item]);
    expect(host.querySelector('[data-message-reference-kind="image"]')).not.toBeNull();
    expect(host.textContent).toContain('review');
    expect(host.textContent).not.toContain('file(s)');
  }
});
it.each([false, true])('matches pending status typography to sibling actions (mobile=%s)', async (mobile) => {
  fixture.mobile = mobile;
  for (const state of ['queuing', 'steering', 'compaction']) {
    const item: SessionComposerPendingItem = state === 'queuing'
      ? { ...inbox, kind: 'pending-admission', phase: 'admitting' }
      : { ...inbox, delivery: 'steer' };
    await render([item], undefined, undefined, state === 'compaction');
    const status = host.querySelector('[aria-live="polite"]');
    expect(status).not.toBeNull();
    expect(status?.classList.contains('font-normal')).toBe(!mobile);
    expect(status?.classList.contains('text-[length:calc(var(--text-ui-label)-1px)]')).toBe(!mobile);
    expect(status?.classList.contains('font-medium')).toBe(mobile);
    expect(status?.classList.contains('text-[11px]')).toBe(mobile);
  }
});
it.each([false, true])('allows editing a waiting native inbox item (mobile=%s)', async (mobile) => {
  fixture.mobile = mobile;
  await render([inbox]);
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="edit"]')?.disabled).toBe(false);
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="edit"]')!.click());
  expect(fixture.edit).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 's', inboxID: 'inbox', directory: '/a', expectedRevision: 1 }));
  expect(fixture.focus).toHaveBeenCalledOnce();
});
it('keeps the captured edit scope across rerenders and invalidates it on unmount', async () => {
  await render([inbox]);
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="edit"]')!.click());
  const { isCurrent } = fixture.edit.mock.calls[0][0];
  await render([inbox]);
  expect(isCurrent()).toBe(true);
  await act(async () => root.render(null));
  expect(isCurrent()).toBe(false);
});
it('locks conflicting actions during restoration and unlocks after failure', async () => {
  let reject!: (error: Error) => void;
  fixture.edit.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await render([inbox]);
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="edit"]')!.click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="edit"]')?.disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="steer"]')?.disabled).toBe(true);
  await act(async () => { reject(new Error('conflict')); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="edit"]')?.disabled).toBe(false);
  expect(fixture.focus).not.toHaveBeenCalled();
});
it('shows promotion pending immediately and keeps it until authoritative consumption', async () => {
  let finish!: () => void;
  const promote = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  await render([inbox], promote);
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="steer"]')!.click());
  expect(promote).toHaveBeenCalledExactlyOnceWith('inbox');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(host.textContent).toContain(dict['chat.queuedMessage.sending']);
  expect(host.querySelector('button[aria-label="steer"]')).toBeNull();
  await act(async () => { finish(); });
  await render([{ ...inbox, delivery: 'steer' }], promote);
  expect(host.textContent).toContain(dict['chat.queuedMessage.sending']);
  expect(host.textContent).not.toContain('Queue');
  await render([], promote);
  expect(host.querySelector('[data-yuri-queue-card]')).toBeNull();
});
it('restores waiting for compaction before steering and retains the message until consumption', async () => {
  await render([{ ...inbox, delivery: 'steer' }], undefined, undefined, true);
  expect(host.textContent).toContain(dict['chat.queuedMessage.waitingForCompaction']);
  expect(host.textContent).not.toContain(dict['chat.queuedMessage.sending']);
  await render([{ ...inbox, delivery: 'steer' }]);
  expect(host.textContent).toContain(dict['chat.queuedMessage.sending']);
  expect(host.textContent).toContain('Next task');
});
it('restores Send when promotion fails and preserves the queued content', async () => {
  const promote = vi.fn(async () => { throw new Error('offline'); });
  await render([inbox], promote);
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="steer"]')!.click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(host.textContent).toContain('Next task');
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="steer"]')?.disabled).toBe(false);
});
it('shows steering copy while a queued item is being promoted from the composer', async () => {
  await render([inbox], undefined, new Set(['inbox']));
  expect(host.textContent).toContain(dict['chat.queuedMessage.sending']);
  expect(host.querySelector('button[aria-label="steer"]')).toBeNull();
  await render([{ ...inbox, kind: 'pending-admission', phase: 'admitting' }], undefined, new Set(['inbox']));
  expect(host.textContent).toContain(dict['chat.queuedMessage.sending']);
  expect(host.textContent).not.toContain(dict['chat.queuedMessage.queuing']);
});
it('keeps steer and captured Host/Assistant queue copy separate and empty shell collapsed', async () => {
  await render([{ ...inbox, delivery: 'steer' }]); expect(host.textContent).not.toContain('Inherits');
  fixture.mode = 'server';
  fixture.items = [{ queueItemID: 'captured', operationID: 'op', messageID: 'msg', content: 'Captured task', status: 'queued', attemptCount: 0, position: 0, rowVersion: 1, createdAt: 1 }];
  await render(); expect(host.textContent).toContain('Captured task'); expect(host.textContent).not.toContain('Inherits');
  fixture.items = []; await render(); expect(host.querySelector('[data-yuri-queue-card]')).toBeNull();
});
