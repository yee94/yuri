/** Runtime-free canonical command rules. Runtime wrappers supply reloadEnabled explicitly. */
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

export const getLocalChatCommand = (text: string, inputMode: 'normal' | 'shell', options: LocalChatCommandOptions): string | null => {
  if (inputMode !== 'normal') return null;
  const command = text.trimStart().match(SLASH_COMMAND_HEAD)?.[1]?.toLowerCase();
  if (!command || !LOCAL_CHAT_COMMANDS.has(command)) return null;
  if (command === 'reload' && !options.reloadEnabled) return null;
  return command;
};

export const preservesComposerResources = (text: string, inputMode: 'normal' | 'shell', options: LocalChatCommandOptions): boolean => (
  getLocalChatCommand(text, inputMode, options) !== null
);

export const consumesImmediateCommandText = (text: string, inputMode: 'normal' | 'shell', options: LocalChatCommandOptions): boolean => {
  const command = getLocalChatCommand(text, inputMode, options);
  return command !== null && IMMEDIATE_LOCAL_CHAT_COMMANDS.has(command);
};

/** Original Web order, copy keys and availability; not a second Native command catalog. */
const COMMAND_METADATA = [
  { name: 'new', description: 'chat.commandAutocomplete.command.newDescription', availability: 'always', kind: 'builtin' },
  { name: 'init', description: 'chat.commandAutocomplete.command.initDescription', availability: 'empty-session', kind: 'builtin' },
  // Show when session exists, not when hasMessages.
  { name: 'btw', description: 'chat.btw.description', availability: 'session', kind: 'builtin' },
  { name: 'undo', description: 'chat.commandAutocomplete.command.undoDescription', availability: 'session', kind: 'builtin' },
  { name: 'redo', description: 'chat.commandAutocomplete.command.redoDescription', availability: 'session', kind: 'builtin' },
  { name: 'fork', description: 'chat.commandAutocomplete.command.forkDescription', availability: 'session', kind: 'builtin' },
  { name: 'timeline', description: 'chat.commandAutocomplete.command.timelineDescription', availability: 'session', kind: 'builtin' },
  { name: 'model', description: 'chat.commandAutocomplete.command.modelDescription', availability: 'always', kind: 'builtin' },
  { name: 'compact', description: 'chat.commandAutocomplete.command.compactDescription', availability: 'always', kind: 'builtin' },
  { name: 'reload', description: 'chat.commandAutocomplete.command.reloadDescription', availability: 'vscode', kind: 'builtin' },
  { name: 'summary', description: 'chat.commandAutocomplete.command.summaryDescription', availability: 'session', kind: 'magic' },
  { name: 'workspace-review', description: 'chat.commandAutocomplete.command.workspaceReviewDescription', availability: 'session-or-draft', kind: 'magic' },
  { name: 'craft-goal', description: 'chat.commandAutocomplete.command.craftGoalDescription', availability: 'session-or-draft', kind: 'magic' },
  { name: 'catch-up', description: 'chat.commandAutocomplete.command.catchUpDescription', availability: 'session-or-draft', kind: 'magic' },
  { name: 'debug', description: 'chat.commandAutocomplete.command.debugDescription', availability: 'session-or-draft', kind: 'magic' },
  { name: 'weigh', description: 'chat.commandAutocomplete.command.weighDescription', availability: 'session-or-draft', kind: 'magic' },
  { name: 'explore', description: 'chat.commandAutocomplete.command.exploreDescription', availability: 'session-or-draft', kind: 'magic' },
] as const;

export type ComposerLocalCommandDescription = typeof COMMAND_METADATA[number]['description'];
export type ComposerLocalCommandMetadata = {
  id: string; name: string; source: 'yuri'; description: string; isBuiltIn?: boolean; isYuri?: boolean;
};
export function getComposerLocalCommandMetadata(context: {
  hasSession: boolean; hasMessages: boolean; canStartSessionCommand: boolean; reloadEnabled: boolean;
}, t: (key: ComposerLocalCommandDescription) => string): ComposerLocalCommandMetadata[] {
  return COMMAND_METADATA.filter(command => {
    switch (command.availability) {
      case 'always': return true;
      case 'empty-session': return context.hasSession && !context.hasMessages;
      case 'session': return context.hasSession;
      case 'session-or-draft': return context.canStartSessionCommand;
      case 'vscode': return context.reloadEnabled;
    }
  }).map(command => ({ id: `yuri:${command.name}`, name: command.name, source: 'yuri', description: t(command.description),
    ...(command.kind === 'magic' ? { isYuri: true } : { isBuiltIn: true }) }));
}
