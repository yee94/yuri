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
const descriptions: Record<string, I18nKey> = {
  explore: 'chat.commandAutocomplete.command.exploreDescription', summary: 'chat.commandAutocomplete.command.summaryDescription',
  'workspace-review': 'chat.commandAutocomplete.command.workspaceReviewDescription', 'craft-goal': 'chat.commandAutocomplete.command.craftGoalDescription',
  'catch-up': 'chat.commandAutocomplete.command.catchUpDescription', debug: 'chat.commandAutocomplete.command.debugDescription',
  weigh: 'chat.commandAutocomplete.command.weighDescription', model: 'chat.commandAutocomplete.command.modelDescription',
};

/** Metadata-only rows; called only inside a mounted slash surface, never ordinary text echo. */
export function nativeCommandRows(commands: readonly Row[], query: string, scope: ReferenceScope, t: (key: I18nKey) => string, desktop?: NativeLocalCommandCatalog): NativeCommandRow[] {
  const local: NativeSlashCommand[] = desktop ? desktop.commands().map(command => ({ ...command, source: 'yuri', localAutoRun: desktop.canAutoRun(command) })) : [...magicCommands.map(item => ({ id: `yuri:${item.name}`, name: item.name, isYuri: true, description: t(descriptions[item.name]) })),
    { id: 'yuri:model', name: 'model', isBuiltIn: true, description: t(descriptions.model) }];
  const rows = [...local, ...commands.flatMap((command, index): NativeSlashCommand[] => {
    const name = text(command.name);
    if (!name || command.source === 'skill' || local.some(item => item.name.toLowerCase() === name.toLowerCase())) return [];
    return [{ id: `opencode:${text(command.scope)}:${name}:${index}`, name, source: 'opencode', description: text(command.description), isBuiltIn: typeof command.isBuiltIn === 'boolean' ? command.isBuiltIn : undefined, scope: text(command.scope), agent: text(command.agent) }];
  })];
  const ranked = rankCommandsForQuery(rows, query);
  const presentation = buildSlashCommandRows(ranked, { skill: t('chat.commandAutocomplete.badge.skill'), command: t('chat.commandAutocomplete.badge.command'), system: t('chat.commandAutocomplete.badge.system') });
  return ranked.map((command, index) => ({ command, presentation: presentation[index], scope: { ...scope } }));
}
/** Only wired local actions may auto-run; a Host command with a reserved name is still draft text. */
export function shouldSubmitCommandOnSelection(command: NativeSlashCommand, submit: boolean): boolean {
  const local = command.source === 'yuri' && command.id === `yuri:${command.name}` && command.localAutoRun === true;
  const legacyModel = command.id === 'yuri:model' && command.source === undefined && command.localAutoRun === undefined;
  return (local || legacyModel) && shouldSubmitWebCommandOnSelection(command, submit);
}
