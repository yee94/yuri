import { isVSCodeRuntime } from '@/lib/desktop';
import { getLocalChatCommand as classifyLocalChatCommand, IMMEDIATE_LOCAL_CHAT_COMMANDS, type LocalChatCommandOptions } from '@/lib/composer-local-commands-core';
export { LOCAL_CHAT_COMMANDS, IMMEDIATE_LOCAL_CHAT_COMMANDS, type LocalChatCommandOptions } from '@/lib/composer-local-commands-core';

const reloadCommandEnabled = (options?: LocalChatCommandOptions): boolean => (
  options?.reloadEnabled ?? isVSCodeRuntime()
);

export const getLocalChatCommand = (
  text: string,
  inputMode: 'normal' | 'shell',
  options?: LocalChatCommandOptions,
): string | null => {
  return classifyLocalChatCommand(text, inputMode, { reloadEnabled: reloadCommandEnabled(options) });
};

export const preservesComposerResources = (
  text: string,
  inputMode: 'normal' | 'shell',
  options?: LocalChatCommandOptions,
): boolean => (
  getLocalChatCommand(text, inputMode, options) !== null
);

export const consumesImmediateCommandText = (
  text: string,
  inputMode: 'normal' | 'shell',
  options?: LocalChatCommandOptions,
): boolean => {
  const command = getLocalChatCommand(text, inputMode, options);
  return command !== null && IMMEDIATE_LOCAL_CHAT_COMMANDS.has(command);
};
