import { canUseElectronDesktopIPC, invokeDesktop } from './desktop';
import { getRuntimeApiBaseUrl } from './runtime-switch';
import { getRuntimeBearerTokenSync } from './runtime-auth';
import { isRelayModeActive } from './relay/runtime-tunnel';

export const canOpenAssistantMiniChat = (): boolean => canUseElectronDesktopIPC() && !isRelayModeActive();

export const openAssistantMiniChat = async (assistantID: string): Promise<void> => {
  if (!canOpenAssistantMiniChat()) throw new Error('Assistant Mini Chat requires a direct desktop connection');
  await invokeDesktop('desktop_open_assistant_mini_chat_window', {
    assistantID,
    apiBaseUrl: getRuntimeApiBaseUrl(),
    clientToken: getRuntimeBearerTokenSync(),
  });
};
