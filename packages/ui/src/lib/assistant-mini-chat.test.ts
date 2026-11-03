import { beforeEach, expect, test, vi } from 'vitest';
import { canOpenAssistantMiniChat, openAssistantMiniChat } from './assistant-mini-chat';

const state = vi.hoisted(() => ({ desktop: true, relay: false, invoke: vi.fn() }));
vi.mock('./desktop', () => ({ canUseElectronDesktopIPC: () => state.desktop, invokeDesktop: state.invoke }));
vi.mock('./runtime-switch', () => ({ getRuntimeApiBaseUrl: () => 'https://host.example' }));
vi.mock('./runtime-auth', () => ({ getRuntimeBearerTokenSync: () => 'test-credential' }));
vi.mock('./relay/runtime-tunnel', () => ({ isRelayModeActive: () => state.relay }));
beforeEach(() => { state.desktop = true; state.relay = false; state.invoke.mockReset().mockResolvedValue(null); });

test('opens the explicit Assistant on the active direct runtime', async () => {
  expect(canOpenAssistantMiniChat()).toBe(true);
  await openAssistantMiniChat('bot-a');
  expect(state.invoke).toHaveBeenCalledExactlyOnceWith('desktop_open_assistant_mini_chat_window', {
    assistantID: 'bot-a', apiBaseUrl: 'https://host.example', clientToken: 'test-credential',
  });
});

test.each(['web-or-mobile', 'relay'])('unsupported %s surfaces cannot call native opening', async (surface) => {
  state.desktop = surface !== 'web-or-mobile'; state.relay = surface === 'relay';
  expect(canOpenAssistantMiniChat()).toBe(false);
  await expect(openAssistantMiniChat('bot-a')).rejects.toThrow('direct desktop connection');
  expect(state.invoke).not.toHaveBeenCalled();
});
