import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantWeixinStatus } from '@/queries/assistantWeixinQueries';

const fixture = vi.hoisted(() => ({
  data: { status: 'disconnected', error: null, qrCode: undefined } as AssistantWeixinStatus,
  transport: 'host-a', mutate: vi.fn(), refetch: vi.fn(), qr: vi.fn(async (..._args: unknown[]) => 'data:image/png;base64,dGVzdA=='),
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => fixture.transport }));
vi.mock('@/queries/assistantWeixinQueries', () => ({ useAssistantWeixin: () => ({
  query: { data: fixture.data, isPending: false, isError: false, refetch: fixture.refetch },
  mutation: { isPending: false, error: null, mutate: fixture.mutate },
}) }));
vi.mock('qrcode', () => ({ default: { toDataURL: (...args: unknown[]) => fixture.qr(...args) } }));
import { AssistantChannelsGroup } from './AssistantChannelsGroup';

let root: Root | undefined;
let host: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => {
  await act(async () => root?.unmount()); host?.remove(); root = undefined;
  fixture.data = { status: 'disconnected', error: null };
  fixture.mutate.mockClear(); fixture.qr.mockClear(); fixture.transport = 'host-a';
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
});
const mount = async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root?.render(<AssistantChannelsGroup assistantID="bot" />));
};
const button = (text: string) => [...host.querySelectorAll('button')].find((node) => node.textContent?.includes(text))!;

describe('per-Bot message channel settings', () => {
  it('owns one labelled group and starts QR configuration from the neutral connect action', async () => {
    await mount();
    expect(host.querySelectorAll('.yuri-settings-group')).toHaveLength(1);
    expect(host.querySelector('.yuri-settings-group-label')?.textContent).toBe('assistants.channels.title');
    await act(async () => button('assistants.weixin.connect').click());
    expect(fixture.mutate).toHaveBeenCalledWith({ type: 'login' });
  });

  it('generates a local QR once across 50 unchanged parent updates and supports cancellation', async () => {
    fixture.data = { status: 'waiting', qrCode: 'https://example.com/scan', error: null };
    await mount();
    expect(host.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png/);
    for (let index = 0; index < 50; index++) {
      await act(async () => root?.render(<AssistantChannelsGroup assistantID="bot" />));
    }
    expect(fixture.qr).toHaveBeenCalledTimes(1);
    await act(async () => button('settings.common.actions.cancel').click());
    expect(fixture.mutate).toHaveBeenCalledWith({ type: 'disconnect' });
  });

  it('shows delivery ambiguity and an explicit retry, not a false successful or empty state', async () => {
    fixture.data = { status: 'connected', error: 'delivery_unknown' };
    await mount();
    expect(host.textContent).toContain('assistants.weixin.error.deliveryUnknown');
    await act(async () => button('assistants.actions.retry').click());
    expect(fixture.mutate).toHaveBeenCalledWith({ type: 'retry' });
  });

  it('clears verification input when changing the runtime, even for the same bot ID', async () => {
    fixture.data = { status: 'verify', qrCode: 'qr', error: null };
    await mount();
    const input = host.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '123456');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    fixture.transport = 'host-b';
    await act(async () => root?.render(<AssistantChannelsGroup assistantID="bot" />));
    expect(host.querySelector('input')?.value).toBe('');
  });

  it('does not offer connect on an unsupported host', async () => {
    fixture.data = { status: 'unsupported', error: null };
    await mount();
    expect(host.textContent).toContain('assistants.weixin.status.unsupported');
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });

  it('requires explicit confirmation to move, supports cancel and sends the selected binding revision', async () => {
    fixture.data = { status: 'disconnected', error: null, transferSources: [{ assistantID: 'old', name: 'Old bot', revision: 'r1' }] };
    await mount();
    await act(async () => button('assistants.weixin.transfer').click());
    expect(fixture.mutate).not.toHaveBeenCalled();
    expect(host.textContent).toContain('assistants.weixin.transferWarning');
    await act(async () => button('settings.common.actions.cancel').click());
    expect(fixture.mutate).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('assistants.weixin.transferWarning');
    await act(async () => button('assistants.weixin.transfer').click());
    await act(async () => button('assistants.weixin.transferConfirm').click());
    expect(fixture.mutate).toHaveBeenCalledWith({ type: 'transfer', sourceAssistantID: 'old', revision: 'r1' }, expect.anything());
    expect(fixture.qr).not.toHaveBeenCalled();
  });

  it('does not silently confirm a different binding revision or carry confirmation to another runtime', async () => {
    fixture.data = { status: 'disconnected', error: null, transferSources: [{ assistantID: 'old', name: 'Old bot', revision: 'r1' }] };
    await mount();
    await act(async () => button('assistants.weixin.transfer').click());
    fixture.data.transferSources![0] = { assistantID: 'old', name: 'Old bot', revision: 'r2' };
    await act(async () => root?.render(<AssistantChannelsGroup assistantID="bot" />));
    expect(button('assistants.weixin.transferConfirm').disabled).toBe(true);
    fixture.transport = 'host-b';
    await act(async () => root?.render(<AssistantChannelsGroup assistantID="bot" />));
    expect(host.textContent).not.toContain('assistants.weixin.transferWarning');
  });
});
