import { isVSCodeRuntime } from '@/lib/desktop';

export const LOCAL_CHAT_COMMANDS = new Set([
  'new', 'fork', 'compact', 'reload', 'undo', 'redo', 'timeline', 'model', 'summary', 'workspace-review', 'craft-goal', 'catch-up', 'debug', 'weigh', 'explore', 'btw',
]);

export const IMMEDIATE_LOCAL_CHAT_COMMANDS = new Set([
  'new', 'compact', 'reload', 'fork', 'undo', 'redo',
]);

/** Optional reserved icon em-space between `/` and the command name. */
const SLASH_COMMAND_HEAD = /^\/\u2003?([^\s]+)/i;

export type LocalChatCommandOptions = {
  /** `/reload` stays a local command only in VS Code. Other runtimes use Settings. */
  reloadEnabled?: boolean;
};

const reloadCommandEnabled = (options?: LocalChatCommandOptions): boolean => (
  options?.reloadEnabled ?? isVSCodeRuntime()
);

export const getLocalChatCommand = (
  text: string,
  inputMode: 'normal' | 'shell',
  options?: LocalChatCommandOptions,
): string | null => {
  if (inputMode !== 'normal') return null;
  const command = text.trimStart().match(SLASH_COMMAND_HEAD)?.[1]?.toLowerCase();
  if (!command || !LOCAL_CHAT_COMMANDS.has(command)) return null;
  if (command === 'reload' && !reloadCommandEnabled(options)) return null;
  return command;
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
