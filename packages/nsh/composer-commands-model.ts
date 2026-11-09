import { rankCommandsForQuery } from '../ui/src/lib/composer-autocomplete/slash-rank';
import { buildSlashCommandRows } from '../ui/src/lib/composer-autocomplete/rows';
import { shouldSubmitCommandOnSelection as shouldSubmitWebCommandOnSelection } from '../ui/src/components/chat/commandSelection';
import { text, type Row } from './model';
import { magicCommands } from './composer';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import type { ReferenceScope } from './composer-references';

export type NativeSlashCommand = { id: string; name: string; description?: string; isBuiltIn?: boolean; isYuri?: boolean; scope?: string; agent?: string; source?: 'yuri' | 'opencode' | 'skill'; localAutoRun?: boolean };
export type NativeLocalCommandCatalog = {
  /** Shared Web metadata, resolved only while the slash surface is present. */
  commands: () => readonly NativeSlashCommand[];
  canAutoRun: (command: NativeSlashCommand) => boolean;
};
export type NativeCommandRow = { command: NativeSlashCommand; presentation: ReturnType<typeof buildSlashCommandRows>[number]; scope: ReferenceScope };
export type NativeCommandContext = { hasSession: boolean; hasMessages: boolean; hasNewDraft: boolean };
export type NativeComposerAction = 'new' | 'undo' | 'redo' | 'fork' | 'timeline' | 'compact' | 'btw' | 'model';
export const nativeComposerActions: readonly NativeComposerAction[] = ['new', 'undo', 'redo', 'fork', 'timeline', 'compact', 'btw', 'model'];
// Existing Chat callers migrate to explicit context when their action owner is assembled.
export const existingNativeCommandContext: NativeCommandContext = { hasSession: true, hasMessages: true, hasNewDraft: false };
export function nativeLocalAction(command: NativeSlashCommand): NativeComposerAction | undefined {
  return nativeComposerActions.find(name => command.source === 'yuri' && command.id === `yuri:${name}` && command.name === name);
}
export function nativeCommandAvailable(name: string, context: NativeCommandContext): boolean {
  if (name === 'new' || name === 'model' || name === 'compact') return true;
  if (name === 'init') return context.hasSession && !context.hasMessages;
  if (['btw', 'undo', 'redo', 'fork', 'timeline', 'summary'].includes(name)) return context.hasSession;
  return magicCommands.some(command => command.name === name) && (context.hasSession || context.hasNewDraft);
}
const descriptions: Record<string, I18nKey> = {
  explore: 'chat.commandAutocomplete.command.exploreDescription', summary: 'chat.commandAutocomplete.command.summaryDescription',
  'workspace-review': 'chat.commandAutocomplete.command.workspaceReviewDescription', 'craft-goal': 'chat.commandAutocomplete.command.craftGoalDescription',
  'catch-up': 'chat.commandAutocomplete.command.catchUpDescription', debug: 'chat.commandAutocomplete.command.debugDescription',
  weigh: 'chat.commandAutocomplete.command.weighDescription', model: 'chat.commandAutocomplete.command.modelDescription',
  new: 'chat.commandAutocomplete.command.newDescription', init: 'chat.commandAutocomplete.command.initDescription',
  undo: 'chat.commandAutocomplete.command.undoDescription', redo: 'chat.commandAutocomplete.command.redoDescription',
  fork: 'chat.commandAutocomplete.command.forkDescription', timeline: 'chat.commandAutocomplete.command.timelineDescription',
  compact: 'chat.commandAutocomplete.command.compactDescription', btw: 'chat.btw.description',
};

/** Metadata-only rows; called only inside a mounted slash surface, never ordinary text echo. */
export type NativeCommandRowsOptions = NativeCommandContext | NativeLocalCommandCatalog | undefined;
function commandRowsContext(options: NativeCommandRowsOptions): NativeCommandContext {
  if (options && 'commands' in options) return existingNativeCommandContext;
  return options ?? existingNativeCommandContext;
}
export function nativeCommandRows(commands: readonly Row[], query: string, scope: ReferenceScope, t: (key: I18nKey) => string, options?: NativeCommandRowsOptions): NativeCommandRow[] {
  const context = commandRowsContext(options);
  const names = ['new', 'init', 'btw', 'undo', 'redo', 'fork', 'timeline', 'model', 'compact', 'summary', 'workspace-review', 'craft-goal', 'catch-up', 'debug', 'weigh', 'explore'];
  const catalog = options && 'commands' in options ? options : undefined;
  const catalogRows: NativeSlashCommand[] = catalog ? catalog.commands().map(command => ({ ...command, source: 'yuri', localAutoRun: catalog.canAutoRun(command) })) : [];
  const local: NativeSlashCommand[] = catalog ? catalogRows : names.filter(name => nativeCommandAvailable(name, context)).map(name => ({
    id: `yuri:${name}`, name, source: 'yuri' as const, description: t(descriptions[name]),
    ...(magicCommands.some(command => command.name === name) ? { isYuri: true } : { isBuiltIn: true }),
  }));
  const reserved = new Set(local.map(item => item.name.toLowerCase()));
  const rows = [...local, ...commands.flatMap((command, index): NativeSlashCommand[] => {
    const name = text(command.name);
    if (!name || command.source === 'skill' || reserved.has(name.toLowerCase())) return [];
    return [{ id: `opencode:${text(command.scope)}:${name}:${index}`, name, source: 'opencode', description: text(command.description), isBuiltIn: typeof command.isBuiltIn === 'boolean' ? command.isBuiltIn : undefined, scope: text(command.scope), agent: text(command.agent) }];
  })];
  const ranked = rankCommandsForQuery(rows, query);
  const presentation = buildSlashCommandRows(ranked, { skill: t('chat.commandAutocomplete.badge.skill'), command: t('chat.commandAutocomplete.badge.command'), system: t('chat.commandAutocomplete.badge.system') });
  return ranked.map((command, index) => ({ command, presentation: presentation[index], scope: { ...scope } }));
}
/** Only wired local actions may auto-run; a Host command with a reserved name is still draft text. */
export function shouldSubmitCommandOnSelection(command: NativeSlashCommand, submit: boolean, wired: readonly NativeComposerAction[] = ['model']): boolean {
  if (command.localAutoRun === false) return false;
  if (command.localAutoRun === true) {
    const local = command.source === 'yuri' && command.id === `yuri:${command.name}`;
    return local && shouldSubmitWebCommandOnSelection(command, submit);
  }
  const legacyModel = command.id === 'yuri:model' && command.source === undefined;
  if (legacyModel) return shouldSubmitWebCommandOnSelection(command, submit);
  const action = nativeLocalAction(command);
  return !!action && wired.includes(action) && shouldSubmitWebCommandOnSelection(command, submit);
}
