import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import { NativeSessionInboxChips } from './QueuedMessageChips';
import type { SessionInboxOverlayItem } from '@/sync/session-inbox-overlay';

vi.mock('@/sync/use-message-queue-server', () => ({ useMessageQueueServerScope: () => { throw new Error('Remote native inbox mounted the Hub queue'); } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

test('native queue keeps references without image previews, mature actions and recovery without subscribing to Hub queue', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const item: SessionInboxOverlayItem = { id: 'input-1', requestID: 'request-1', sessionID: 'same', timeCreated: 1, type: 'user', delivery: 'queue', payload: {
    text: 'Continue with these files', files: [{ name: 'photo.png', mime: 'image/png', data: 'aW1hZ2U=' }, { name: 'context.txt', mime: 'text/plain', uri: '/remote/context.txt' }], agents: [{ name: 'build' }], skills: [{ id: 'review' }],
  } };
  const action = vi.fn(async (): Promise<void> => {}).mockRejectedValueOnce(new Error('Disconnected'));
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  const render = (delivery: 'queue' | 'steer') => <QueryClientProvider client={client}><NativeSessionInboxChips items={[{ ...item, delivery }]} onAction={action} /></QueryClientProvider>;
  try {
    await act(async () => root.render(render('queue')));
    expect(node.textContent).toContain('Continue with these files');
    expect(node.textContent).toContain('@build'); expect(node.textContent).toContain('[skill:review]');
    expect(node.querySelector('img')).toBeNull();
    const send = () => node.querySelector<HTMLButtonElement>('[aria-label="chat.queuedMessage.send"]')!;
    await act(async () => send().click());
    await vi.waitFor(() => expect(send().disabled).toBe(false));
    expect(node.querySelector('[data-native-inbox-id="input-1"]')).not.toBeNull();
    let finish!: () => void;
    action.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await act(async () => send().click());
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    expect(action).toHaveBeenLastCalledWith('steer', 'input-1');
    await act(async () => root.render(render('steer')));
    expect(node.querySelector('[aria-label="chat.queuedMessage.title"]')).toBeNull();
    await act(async () => finish());
    await vi.waitFor(() => expect(node.querySelector('[aria-label="chat.queuedMessage.sendingAria"]')).not.toBeNull());
    expect(node.querySelector('[aria-label="chat.queuedMessage.title"]')).toBeNull();
    expect(action).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); client.clear(); node.remove(); }
});
