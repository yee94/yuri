import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantWeixinStatus } from '@/queries/assistantWeixinQueries';
import type { AssistantChannelStatus } from '@/queries/assistantChannelQueries';

const fixture = vi.hoisted(() => ({
  weixin: { status: 'disconnected', error: null, qrCode: undefined } as AssistantWeixinStatus,
  channel: {
    provider: 'wecom',
    status: 'disconnected',
    error: null,
    configured: false,
    hasSecret: false,
    transport: 'websocket',
  } as AssistantChannelStatus,
  transport: 'host-a',
  generation: 1,
  runtimeListeners: new Set<() => void>(),
  mutate: vi.fn(),
  channelMutate: vi.fn(),
  discover: vi.fn(),
  discoveryReset: vi.fn(),
  discoveryPending: false,
  toastSuccess: vi.fn(),
  refetch: vi.fn(),
  channelRefetch: vi.fn(),
  weixinMounts: 0,
  channelMounts: 0,
  qr: vi.fn(async (..._args: unknown[]) => 'data:image/png;base64,dGVzdA=='),
}));

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui', () => ({ toast: { success: fixture.toastSuccess } }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => fixture.transport,
  getRuntimeGeneration: () => fixture.generation,
  subscribeRuntimeEndpointChanged: (listener: () => void) => {
    fixture.runtimeListeners.add(listener);
    return () => { fixture.runtimeListeners.delete(listener); };
  },
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) => (open ? children : null),
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div data-testid="channel-dialog">{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => children,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => children,
  DialogDescription: ({ children }: { children?: React.ReactNode }) => children,
}));
vi.mock('@/queries/assistantWeixinQueries', () => ({
  useAssistantWeixin: () => {
    fixture.weixinMounts += 1;
    return {
      query: { data: fixture.weixin, isPending: false, isError: false, refetch: fixture.refetch },
      mutation: { isPending: false, error: null, mutate: fixture.mutate },
    };
  },
}));
vi.mock('@/queries/assistantChannelQueries', () => ({
  useAssistantChannel: (_assistantID: string, provider: AssistantChannelStatus['provider']) => {
    fixture.channelMounts += 1;
    return {
      query: {
        data: { ...fixture.channel, provider },
        isPending: false,
        isError: false,
        refetch: fixture.channelRefetch,
      },
      mutation: { isPending: false, error: null, mutate: fixture.channelMutate },
      discovery: { isPending: fixture.discoveryPending, error: null, mutate: fixture.discover, reset: fixture.discoveryReset },
    };
  },
}));
vi.mock('qrcode', () => ({ default: { toDataURL: (...args: unknown[]) => fixture.qr(...args) } }));
import { AssistantChannelsGroup } from './AssistantChannelsGroup';

let root: Root | undefined;
let host: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => {
  await act(async () => root?.unmount()); host?.remove(); root = undefined;
  fixture.weixin = { status: 'disconnected', error: null };
  fixture.channel = { provider: 'wecom', status: 'disconnected', error: null, configured: false, hasSecret: false, transport: 'websocket' };
  fixture.mutate.mockClear();
  fixture.channelMutate.mockClear();
  fixture.discover.mockClear();
  fixture.discoveryReset.mockClear();
  fixture.toastSuccess.mockClear();
  fixture.discoveryPending = false;
  fixture.channelRefetch.mockClear();
  fixture.qr.mockClear();
  fixture.transport = 'host-a';
  fixture.generation = 1;
  fixture.runtimeListeners.clear();
  fixture.weixinMounts = 0;
  fixture.channelMounts = 0;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
});
const mount = async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root?.render(<AssistantChannelsGroup assistantID="bot" />));
};
const button = (text: string) => [...host.querySelectorAll('button')].find((node) => node.textContent?.includes(text))!;
const dialog = () => host.querySelector('[data-testid="channel-dialog"]') as HTMLElement;
const field = (labelKey: string) => {
  const rows = [...host.querySelectorAll('.yuri-settings-group-row')];
  const row = rows.find((node) => node.textContent?.includes(labelKey));
  return row?.querySelector('input') as HTMLInputElement | undefined;
};
const inputValue = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('per-Bot message channel settings', () => {
  it('renders four brand entries and mounts no channel requests until a dialog opens', async () => {
    await mount();
    expect(host.querySelectorAll('.yuri-settings-group')).toHaveLength(1);
    expect(host.querySelector('.yuri-settings-group-label')?.textContent).toBe('assistants.channels.title');
    expect(host.querySelectorAll('[aria-haspopup="dialog"]')).toHaveLength(4);
    expect(host.querySelectorAll('img')).toHaveLength(4);
    expect(fixture.weixinMounts).toBe(0);
    expect(fixture.channelMounts).toBe(0);
    expect(host.querySelectorAll('input')).toHaveLength(0);
  });

  it('opens WeChat configuration in a dialog and starts QR login from the neutral action', async () => {
    await mount();
    expect(fixture.weixinMounts).toBe(0);
    await act(async () => button('assistants.weixin.title').click());
    expect(fixture.weixinMounts).toBe(1);
    await act(async () => button('assistants.weixin.connect').click());
    expect(fixture.mutate).toHaveBeenCalledWith({ type: 'login' });
  });

  it('generates a local QR once across 50 unchanged parent updates and supports cancellation', async () => {
    fixture.weixin = { status: 'waiting', qrCode: 'https://example.com/scan', error: null };
    await mount();
    await act(async () => button('assistants.weixin.title').click());
    expect(host.querySelector('img[src^="data:image/png"]')).toBeTruthy();
    for (let index = 0; index < 50; index++) {
      await act(async () => root?.render(<AssistantChannelsGroup assistantID="bot" />));
    }
    expect(fixture.qr).toHaveBeenCalledTimes(1);
    await act(async () => button('settings.common.actions.cancel').click());
    expect(fixture.mutate).toHaveBeenCalledWith({ type: 'disconnect' });
  });

  it('shows delivery ambiguity and an explicit retry for WeChat, not a false success', async () => {
    fixture.weixin = { status: 'connected', error: 'delivery_unknown' };
    await mount();
    await act(async () => button('assistants.weixin.title').click());
    expect(host.textContent).toContain('assistants.weixin.error.deliveryUnknown');
    await act(async () => button('assistants.actions.retry').click());
    expect(fixture.mutate).toHaveBeenCalledWith({ type: 'retry' });
  });

  it('clears WeChat verification input when changing the runtime, even for the same bot ID', async () => {
    fixture.weixin = { status: 'verify', qrCode: 'qr', error: null };
    await mount();
    await act(async () => button('assistants.weixin.title').click());
    const input = host.querySelector('input')!;
    await act(async () => inputValue(input, '123456'));
    fixture.transport = 'host-b';
    await act(async () => root?.render(<AssistantChannelsGroup assistantID="bot" />));
    expect(host.querySelector('input')?.value).toBe('');
  });

  it('does not offer WeChat connect on an unsupported host', async () => {
    fixture.weixin = { status: 'unsupported', error: null };
    await mount();
    await act(async () => button('assistants.weixin.title').click());
    expect(host.textContent).toContain('assistants.weixin.status.unsupported');
    expect(dialog().querySelectorAll('button')).toHaveLength(0);
  });

  it('shows the disabled WeChat state without connect, disconnect or move controls', async () => {
    fixture.weixin = { status: 'disabled', error: null, transferSources: [{ assistantID: 'old', name: 'Old bot', revision: 'r1' }] };
    await mount();
    await act(async () => button('assistants.weixin.title').click());
    expect(host.textContent).toContain('assistants.weixin.status.disabled');
    expect(dialog().querySelectorAll('button')).toHaveLength(0);
    expect(fixture.mutate).not.toHaveBeenCalled();
    expect(fixture.qr).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation to move WeChat, supports cancel and sends the selected binding revision', async () => {
    fixture.weixin = { status: 'disconnected', error: null, transferSources: [{ assistantID: 'old', name: 'Old bot', revision: 'r1' }] };
    await mount();
    await act(async () => button('assistants.weixin.title').click());
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

  it('does not silently confirm a different WeChat binding revision or carry confirmation to another runtime', async () => {
    fixture.weixin = { status: 'disconnected', error: null, transferSources: [{ assistantID: 'old', name: 'Old bot', revision: 'r1' }] };
    await mount();
    await act(async () => button('assistants.weixin.title').click());
    await act(async () => button('assistants.weixin.transfer').click());
    fixture.weixin.transferSources![0] = { assistantID: 'old', name: 'Old bot', revision: 'r2' };
    await act(async () => root?.render(<AssistantChannelsGroup assistantID="bot" />));
    expect(button('assistants.weixin.transferConfirm').disabled).toBe(true);
    fixture.transport = 'host-b';
    await act(async () => root?.render(<AssistantChannelsGroup assistantID="bot" />));
    expect(host.textContent).not.toContain('assistants.weixin.transferWarning');
  });

  it.each(['wecom', 'feishu', 'dingtalk'] as const)('offers the same confirmed local rebind flow for %s as WeChat', async (provider) => {
    fixture.channel = { ...fixture.channel, provider, error: 'account_in_use',
      transferSources: [{ assistantID: 'old', name: 'Old bot', clientID: 'account', revision: 'r1' }] };
    await mount();
    await act(async () => button(`assistants.channels.${provider}.title`).click());
    expect(host.textContent).not.toContain('assistants.channels.error.accountInUse');
    await act(async () => button('assistants.weixin.transfer').click());
    expect(fixture.channelMutate).not.toHaveBeenCalled();
    expect(host.textContent).toContain('assistants.weixin.transferWarning');
    await act(async () => [...dialog().querySelectorAll('button')].find((node) => node.textContent === 'settings.common.actions.cancel')!.click());
    expect(fixture.channelMutate).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('assistants.weixin.transferWarning');
    await act(async () => button('assistants.weixin.transfer').click());
    fixture.channel.transferSources![0]!.revision = 'r2';
    await act(async () => root?.render(<AssistantChannelsGroup assistantID="bot" />));
    expect(button('assistants.weixin.transferConfirm').disabled).toBe(true);
    fixture.channel.transferSources![0]!.revision = 'r1';
    await act(async () => root?.render(<AssistantChannelsGroup assistantID="bot" />));
    await act(async () => button('assistants.weixin.transferConfirm').click());
    expect(fixture.channelMutate).toHaveBeenCalledWith({ type: 'transfer', sourceAssistantID: 'old', revision: 'r1' }, expect.anything());
  });

  it('mounts only the selected platform channel and sends the confirmed owner and identifiers', async () => {
    fixture.channel = {
      provider: 'feishu',
      status: 'disconnected',
      error: null,
      configured: true,
      clientID: 'cli_saved',
      ownerID: 'ou_owner',
      hasSecret: false,
      transport: 'websocket',
    };
    await mount();
    await act(async () => button('assistants.channels.feishu.title').click());
    expect(fixture.channelMounts).toBeGreaterThan(0);
    expect(fixture.weixinMounts).toBe(0);
    expect(field('assistants.channels.field.feishu.clientID')?.value).toBe('cli_saved');
    expect(field('assistants.channels.field.feishu.ownerID')?.value).toBe('ou_owner');
    expect(field('assistants.channels.field.feishu.clientID')?.getAttribute('aria-label')).toBe('assistants.channels.field.feishu.clientID');
    expect(field('assistants.channels.field.feishu.ownerID')?.getAttribute('aria-label')).toBe('assistants.channels.field.feishu.ownerID');
    expect(host.textContent).not.toContain('assistants.channels.sharedContext');
    expect(host.textContent).not.toContain('assistants.channels.dialog.description');
    expect(host.textContent).not.toContain('assistants.channels.field.clientIDDescription');
    expect(host.textContent).toContain('assistants.channels.field.ownerDescription');
    expect(host.textContent).not.toContain('assistants.channels.saveHint');
    expect(field('assistants.channels.field.feishu.secret')?.type).toBe('password');
    expect(field('assistants.channels.field.feishu.secret')?.getAttribute('aria-label')).toBe('assistants.channels.field.feishu.secret');
    expect(button('assistants.channels.actions.save').disabled).toBe(true);
    await act(async () => inputValue(field('assistants.channels.field.feishu.secret')!, 'app-secret'));
    const form = host.querySelector('form')!;
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(fixture.channelMutate).toHaveBeenCalledWith({
      type: 'save',
      clientID: 'cli_saved',
      ownerID: 'ou_owner',
      clientSecret: 'app-secret',
    }, expect.anything());
  });

  it('keeps the saved secret when the secret field is left empty', async () => {
    fixture.channel = {
      provider: 'dingtalk',
      status: 'connected',
      error: null,
      configured: true,
      clientID: 'ding_client',
      ownerID: 'staff_1',
      hasSecret: true,
      transport: 'websocket',
    };
    await mount();
    await act(async () => button('assistants.channels.dingtalk.title').click());
    expect(host.textContent).toContain('assistants.channels.field.secretKeep');
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(fixture.channelMutate).toHaveBeenCalledWith({
      type: 'save',
      clientID: 'ding_client',
      ownerID: 'staff_1',
    }, expect.anything());
  });

  it('reconnects without replay and confirms before removing a configured platform channel', async () => {
    fixture.channel = {
      provider: 'wecom',
      status: 'error',
      error: 'channel_in_use',
      configured: true,
      clientID: 'bot_1',
      ownerID: 'user_1',
      hasSecret: true,
      transport: 'websocket',
    };
    await mount();
    await act(async () => button('assistants.channels.wecom.title').click());
    expect(host.textContent).toContain('assistants.channels.error.channelInUse');
    await act(async () => button('assistants.channels.actions.retry').click());
    expect(fixture.channelMutate).toHaveBeenCalledWith({ type: 'retry' });
    await act(async () => button('assistants.channels.actions.disconnect').click());
    expect(fixture.channelMutate).not.toHaveBeenCalledWith({ type: 'disconnect' }, expect.anything());
    expect(host.textContent).toContain('assistants.channels.disconnectWarning');
    await act(async () => button('assistants.channels.actions.confirmDisconnect').click());
    expect(fixture.channelMutate).toHaveBeenCalledWith({ type: 'disconnect' }, expect.anything());
  });

  it('shows the authoritative unconfigured status instead of claiming connected', async () => {
    fixture.channel = {
      provider: 'wecom',
      status: 'disconnected',
      error: null,
      configured: false,
      hasSecret: false,
      transport: 'websocket',
    };
    await mount();
    await act(async () => button('assistants.channels.wecom.title').click());
    expect(host.textContent).toContain('assistants.channels.status.disconnected');
    expect(host.textContent).not.toContain('assistants.channels.status.connected');
    expect(host.textContent).not.toContain('assistants.channels.actions.retry');
  });

  it.each(['wecom', 'feishu', 'dingtalk'] as const)('requires a user ID and auto-fills it after %s discovery before save', async (provider) => {
    fixture.channel = {
      provider: 'wecom',
      status: 'disconnected',
      error: null,
      configured: false,
      hasSecret: false,
      transport: 'websocket',
    };
    await mount();
    await act(async () => button(`assistants.channels.${provider}.title`).click());
    await act(async () => {
      inputValue(field(`assistants.channels.field.${provider}.clientID`)!, 'bot_1');
      inputValue(field(`assistants.channels.field.${provider}.secret`)!, 'secret_1');
    });
    expect(button('assistants.channels.actions.save').disabled).toBe(true);
    expect(field(`assistants.channels.field.${provider}.ownerID`)?.required).toBe(true);
    expect(host.textContent).toContain('assistants.channels.field.ownerDescription');
    expect(host.textContent).toContain(`assistants.channels.field.${provider}.ownerHelp`);
    expect(host.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(fixture.channelMutate).not.toHaveBeenCalled();
    await act(async () => button('assistants.channels.discovery.start').click());
    expect(fixture.discover).toHaveBeenCalledWith({ clientID: 'bot_1', clientSecret: 'secret_1', signal: expect.any(AbortSignal) }, expect.anything());
    const [input, callbacks] = fixture.discover.mock.calls[0]!;
    expect(input.signal.aborted).toBe(false);
    await act(async () => callbacks.onSuccess({ ownerID: 'user_1' }));
    expect(field(`assistants.channels.field.${provider}.ownerID`)!.value).toBe('user_1');
    expect(button('assistants.channels.actions.save').disabled).toBe(false);
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(fixture.channelMutate).toHaveBeenCalledWith({
      type: 'save', clientID: 'bot_1', clientSecret: 'secret_1', ownerID: 'user_1',
    }, expect.anything());
    expect(dialog()).not.toBeNull();
    expect(fixture.toastSuccess).not.toHaveBeenCalled();
    await act(async () => fixture.channelMutate.mock.calls[0]![1].onSuccess({ configured: true }));
    expect(dialog()).toBeNull();
    expect(fixture.toastSuccess).toHaveBeenCalledWith('assistants.channels.saved');
    expect(input.signal.aborted).toBe(true);
  });

  it('cancels discovery on credential edits and ignores late user IDs, then aborts on dialog close', async () => {
    await mount();
    await act(async () => button('assistants.channels.wecom.title').click());
    await act(async () => {
      inputValue(field('assistants.channels.field.wecom.clientID')!, 'client');
      inputValue(field('assistants.channels.field.wecom.secret')!, 'secret');
    });
    await act(async () => button('assistants.channels.discovery.start').click());
    const [input, callbacks] = fixture.discover.mock.calls[0]!;
    await act(async () => inputValue(field('assistants.channels.field.wecom.secret')!, 'changed'));
    expect(input.signal.aborted).toBe(true);
    await act(async () => callbacks.onSuccess({ ownerID: 'stale-user' }));
    expect(field('assistants.channels.field.wecom.ownerID')!.value).toBe('');
    await act(async () => button('assistants.channels.discovery.start').click());
    const [next] = fixture.discover.mock.calls[1]!;
    await act(async () => button('settings.common.actions.cancel').click());
    expect(next.signal.aborted).toBe(true);
    expect(fixture.channelMutate).not.toHaveBeenCalled();
  });

  it('keeps Save disabled while waiting, supports cancellation, and does not close for an unconfigured save result', async () => {
    await mount();
    await act(async () => button('assistants.channels.wecom.title').click());
    await act(async () => {
      inputValue(field('assistants.channels.field.wecom.clientID')!, 'client');
      inputValue(field('assistants.channels.field.wecom.secret')!, 'secret');
    });
    await act(async () => button('assistants.channels.discovery.start').click());
    const [input] = fixture.discover.mock.calls[0]!;
    fixture.discoveryPending = true;
    await act(async () => root?.render(<AssistantChannelsGroup assistantID="bot" />));
    expect(host.textContent).toContain('assistants.channels.discovery.waiting');
    expect(button('assistants.channels.actions.save').disabled).toBe(true);
    await act(async () => button('settings.common.actions.cancel').click());
    expect(input.signal.aborted).toBe(true);
    expect(fixture.discoveryReset).toHaveBeenCalled();
    fixture.discoveryPending = false;
    await act(async () => inputValue(field('assistants.channels.field.wecom.ownerID')!, 'manual-user'));
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await act(async () => fixture.channelMutate.mock.calls[0]![1].onSuccess({ configured: false }));
    expect(dialog()).not.toBeNull();
    expect(fixture.toastSuccess).not.toHaveBeenCalled();
  });

  it('aborts discovery on runtime generation change and ignores its late result', async () => {
    await mount();
    await act(async () => button('assistants.channels.wecom.title').click());
    await act(async () => {
      inputValue(field('assistants.channels.field.wecom.clientID')!, 'client');
      inputValue(field('assistants.channels.field.wecom.secret')!, 'secret');
    });
    await act(async () => button('assistants.channels.discovery.start').click());
    const [input, callbacks] = fixture.discover.mock.calls[0]!;
    await act(async () => {
      fixture.generation += 1;
      for (const listener of fixture.runtimeListeners) listener();
    });
    expect(input.signal.aborted).toBe(true);
    await act(async () => callbacks.onSuccess({ ownerID: 'stale-user' }));
    expect(field('assistants.channels.field.wecom.ownerID')!.value).toBe('');
    expect(button('assistants.channels.actions.save').disabled).toBe(true);
  });

  it('requires a new secret when the client ID changes instead of reusing the saved one', async () => {
    fixture.channel = {
      provider: 'dingtalk',
      status: 'connected',
      error: null,
      configured: true,
      clientID: 'ding_client',
      ownerID: 'staff_1',
      hasSecret: true,
      transport: 'websocket',
    };
    await mount();
    await act(async () => button('assistants.channels.dingtalk.title').click());
    expect(host.textContent).toContain('assistants.channels.field.secretKeep');
    await act(async () => inputValue(field('assistants.channels.field.dingtalk.clientID')!, 'ding_client_2'));
    expect(host.textContent).toContain('assistants.channels.field.secretRequired');
    expect(host.textContent).not.toContain('assistants.channels.field.secretKeep');
    expect(button('assistants.channels.actions.save').disabled).toBe(true);
    await act(async () => inputValue(field('assistants.channels.field.dingtalk.secret')!, 'new-secret'));
    await act(async () => inputValue(field('assistants.channels.field.dingtalk.ownerID')!, 'staff_1'));
    expect(button('assistants.channels.actions.save').disabled).toBe(false);
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(fixture.channelMutate).toHaveBeenCalledWith({
      type: 'save',
      clientID: 'ding_client_2',
      ownerID: 'staff_1',
      clientSecret: 'new-secret',
    }, expect.anything());
  });

  it.each([
    ['feishu', 'open.feishu.cn/document/server-docs/contact-v3/user/batch_get_id'],
    ['dingtalk', 'open.dingtalk.com/document/dingstart/robot-receive-message'],
  ] as const)('shows the platform-specific ID guide for %s', async (provider, url) => {
    fixture.channel = {
      provider, status: 'connected', error: null, configured: true,
      clientID: 'saved', ownerID: '', hasSecret: true, transport: 'websocket',
    };
    await mount();
    await act(async () => button(`assistants.channels.${provider}.title`).click());
    expect(host.textContent).toContain(`assistants.channels.field.${provider}.ownerHelp`);
    expect(host.querySelector('a')?.href).toContain(url);
    const owner = field(`assistants.channels.field.${provider}.ownerID`)!;
    expect(owner.required).toBe(true);
    expect(document.getElementById(owner.getAttribute('aria-describedby')!)?.textContent)
      .toContain('assistants.channels.field.ownerDescription');
    expect(button('assistants.channels.actions.save').disabled).toBe(true);
  });

  it('clears an unsaved secret as soon as the runtime changes, before any mutation', async () => {
    fixture.channel = {
      provider: 'feishu',
      status: 'disconnected',
      error: null,
      configured: true,
      clientID: 'cli_saved',
      ownerID: 'ou_owner',
      hasSecret: true,
      transport: 'websocket',
    };
    await mount();
    await act(async () => button('assistants.channels.feishu.title').click());
    await act(async () => inputValue(field('assistants.channels.field.feishu.clientID')!, 'cli_changed'));
    await act(async () => inputValue(field('assistants.channels.field.feishu.secret')!, 'unsaved-secret'));
    expect(field('assistants.channels.field.feishu.secret')?.value).toBe('unsaved-secret');
    await act(async () => {
      fixture.transport = 'host-b';
      fixture.generation += 1;
      for (const listener of [...fixture.runtimeListeners]) listener();
    });
    expect(fixture.channelMutate).not.toHaveBeenCalled();
    expect(field('assistants.channels.field.feishu.secret')?.value).toBe('');
    expect(field('assistants.channels.field.feishu.clientID')?.value).toBe('cli_saved');
  });

  it('maps delivery-unknown, replaced-connection and account-in-use errors without calling them network failures', async () => {
    for (const [code, key] of [
      ['delivery_unknown', 'assistants.channels.error.deliveryUnknown'],
      ['connection_replaced', 'assistants.channels.error.connectionReplaced'],
      ['account_in_use', 'assistants.channels.error.accountInUse'],
    ] as const) {
      fixture.channel = {
        provider: 'feishu',
        status: 'error',
        error: code,
        configured: true,
        clientID: 'cli_saved',
        ownerID: 'ou_owner',
        hasSecret: true,
        transport: 'websocket',
      };
      await mount();
      await act(async () => button('assistants.channels.feishu.title').click());
      expect(host.textContent).toContain(key);
      expect(host.textContent).not.toContain('assistants.channels.error.generic');
      await act(async () => root?.unmount());
      host.remove();
    }
  });

  it('shows a disabled platform channel without a credential form', async () => {
    fixture.channel = {
      provider: 'wecom',
      status: 'disabled',
      error: null,
      configured: false,
      hasSecret: false,
      transport: 'websocket',
    };
    await mount();
    await act(async () => button('assistants.channels.wecom.title').click());
    expect(host.textContent).toContain('assistants.channels.status.disabled');
    expect(host.querySelectorAll('input')).toHaveLength(0);
    expect(fixture.channelMutate).not.toHaveBeenCalled();
  });
});
