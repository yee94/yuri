import { rankCommandsForQuery } from '../ui/src/lib/composer-autocomplete/slash-rank';
import { buildSlashCommandRows } from '../ui/src/lib/composer-autocomplete/rows';
import { shouldSubmitCommandOnSelection as shouldSubmitWebCommandOnSelection } from '../ui/src/components/chat/commandSelection';
import { text, type Row } from './model';
import { magicCommands } from './composer';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import type { ReferenceScope } from './composer-references';

export type NativeSlashCommand = { id: string; name: string; source?: 'yuri' | 'opencode'; description?: string; isBuiltIn?: boolean; isYuri?: boolean; scope?: string; agent?: string };
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
export function nativeCommandRows(commands: readonly Row[], query: string, scope: ReferenceScope, t: (key: I18nKey) => string, context: NativeCommandContext = existingNativeCommandContext): NativeCommandRow[] {
  const names = ['new', 'init', 'btw', 'undo', 'redo', 'fork', 'timeline', 'model', 'compact', 'summary', 'workspace-review', 'craft-goal', 'catch-up', 'debug', 'weigh', 'explore'];
  const local: NativeSlashCommand[] = names.filter(name => nativeCommandAvailable(name, context)).map(name => ({
    id: `yuri:${name}`, name, source: 'yuri', description: t(descriptions[name]),
    ...(magicCommands.some(command => command.name === name) ? { isYuri: true } : { isBuiltIn: true }),
  }));
  const rows = [...local, ...commands.flatMap((command, index): NativeSlashCommand[] => {
    const name = text(command.name);
    if (!name || command.source === 'skill' || names.includes(name.toLowerCase())) return [];
    return [{ id: `opencode:${text(command.scope)}:${name}:${index}`, name, source: 'opencode', description: text(command.description), isBuiltIn: typeof command.isBuiltIn === 'boolean' ? command.isBuiltIn : undefined, scope: text(command.scope), agent: text(command.agent) }];
  })];
  const ranked = rankCommandsForQuery(rows, query);
  const presentation = buildSlashCommandRows(ranked, { skill: t('chat.commandAutocomplete.badge.skill'), command: t('chat.commandAutocomplete.badge.command'), system: t('chat.commandAutocomplete.badge.system') });
  return ranked.map((command, index) => ({ command, presentation: presentation[index], scope: { ...scope } }));
}
/** Only wired local actions may auto-run; a Host command with a reserved name is still draft text. */
export function shouldSubmitCommandOnSelection(command: NativeSlashCommand, submit: boolean, wired: readonly NativeComposerAction[] = ['model']): boolean {
  const action = nativeLocalAction(command);
  return !!action && wired.includes(action) && shouldSubmitWebCommandOnSelection(command, submit);
}
