import { resolveComposerAutocompleteTrigger } from '../ui/src/lib/composer-autocomplete/trigger';
import { rankCommandsForQuery } from '../ui/src/lib/composer-autocomplete/slash-rank';
import { buildSlashCommandRows } from '../ui/src/lib/composer-autocomplete/rows';
import { insertTokenWithReferenceBoundaries } from '../ui/src/components/chat/insertionBoundaries';
import { resolveFileMentionSearchQuery } from '../ui/src/lib/search/fileMentionSearch';
import type { ComposerAutocompleteListRow, ComposerAutocompleteTrigger } from '../ui/src/lib/composer-autocomplete/types';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import { mixedReferenceRows, referenceCandidates, referenceRoute, sameReferenceScope, type ReferenceCandidate, type ReferenceScope } from './composer-references';
import { record, text, type Row } from './model';
import type { TaskCommandContext } from './task-editor-defaults';

export type TaskPromptSnapshot = { scope: ReferenceScope; text: string; cursor: number; trigger: ComposerAutocompleteTrigger };
export type TaskPromptRow = { presentation: ComposerAutocompleteListRow; command?: string; candidate?: ReferenceCandidate };
export type TaskPromptState = { rows: TaskPromptRow[]; busy: boolean; failed: boolean };
type Translate = (key: I18nKey) => string;
export function taskPromptTrigger(value: string, cursor: number) {
  return resolveComposerAutocompleteTrigger({ text: value, cursor });
}
export function insertTaskPromptChoice(snapshot: TaskPromptSnapshot, current: TaskPromptSnapshot, row: TaskPromptRow) {
  if (!sameReferenceScope(snapshot.scope, current.scope) || snapshot.text !== current.text || snapshot.cursor !== current.cursor ||
    JSON.stringify(snapshot.trigger) !== JSON.stringify(current.trigger)) return null;
  if (row.command && current.trigger.kind === 'slash-command') {
    const value = `/${row.command} `;
    return { text: value, caret: value.length };
  }
  if (!row.candidate?.scope || current.trigger.kind !== 'mention' || !sameReferenceScope(row.candidate.scope, current.scope)) return null;
  const candidate = row.candidate;
  if (candidate.kind === 'session') return null;
  const token = candidate.kind === 'file' || candidate.kind === 'directory' ? row.presentation.title.trim() || candidate.value : candidate.label;
  return insertTokenWithReferenceBoundaries(current.text, current.trigger.tokenStart, current.trigger.tokenEnd, `@${token}`);
}

/** Web CommandAutocomplete's native-eligible built-ins; eligibility is explicit, never historical inference. */
export function taskCommandRows(catalog: Row[], query: string, t: Translate, context?: TaskCommandContext): TaskPromptRow[] {
  const hasSession = !!context?.sessionID, canStart = hasSession || context?.hasNewDraft === true;
  const builtins: Array<{ name: string; description: I18nKey; isBuiltIn?: boolean; isYuri?: boolean }> = [
    { name: 'new', description: 'chat.commandAutocomplete.command.newDescription', isBuiltIn: true },
    ...(hasSession && !context?.hasMessages ? [{ name: 'init', description: 'chat.commandAutocomplete.command.initDescription' as const, isBuiltIn: true }] : []),
    ...(hasSession ? [
      { name: 'btw', description: 'chat.btw.description' as const, isBuiltIn: true },
      ...(['undo', 'redo', 'fork', 'timeline'] as const).map(name => ({ name, description: `chat.commandAutocomplete.command.${name}Description` as I18nKey, isBuiltIn: true })),
    ] : []),
    { name: 'model', description: 'chat.commandAutocomplete.command.modelDescription', isBuiltIn: true },
    { name: 'compact', description: 'chat.commandAutocomplete.command.compactDescription', isBuiltIn: true },
    ...(hasSession ? [{ name: 'summary', description: 'chat.commandAutocomplete.command.summaryDescription' as const, isYuri: true }] : []),
    ...(canStart ? (['workspace-review', 'craft-goal', 'catch-up', 'debug', 'weigh', 'explore'] as const).map(name => ({ name,
      description: ({ 'workspace-review': 'chat.commandAutocomplete.command.workspaceReviewDescription', 'craft-goal': 'chat.commandAutocomplete.command.craftGoalDescription', 'catch-up': 'chat.commandAutocomplete.command.catchUpDescription', debug: 'chat.commandAutocomplete.command.debugDescription', weigh: 'chat.commandAutocomplete.command.weighDescription', explore: 'chat.commandAutocomplete.command.exploreDescription' } as const)[name], isYuri: true,
    })) : []),
  ];
  const commands = [
    ...builtins.map(command => ({ ...command, id: `yuri:${command.name}`, description: t(command.description) })),
    ...catalog.flatMap((command, index) => command.source === 'skill' || !text(command.name) ? [] : [{
      id: `opencode:${text(command.scope) || 'global'}:${text(command.name)}:${text(command.agent)}:${text(command.model)}:${index}`,
      name: text(command.name), description: text(command.description), isBuiltIn: command.isBuiltIn === true, scope: text(command.scope), agent: text(command.agent),
    }]),
  ].filter(command => !context?.hasMessages || command.name !== 'init');
  const ranked = rankCommandsForQuery(commands, query);
  const rows = buildSlashCommandRows(ranked, { skill: t('chat.commandAutocomplete.badge.skill'), command: t('chat.commandAutocomplete.badge.command'), system: t('chat.commandAutocomplete.badge.system') });
  return rows.map((presentation, index) => ({ presentation, command: ranked[index].name }));
}

/** One present Task prompt. Existing rankers own ordering; the controller owns scoped read lifetimes only. */
export function createTaskPromptSearch(options: {
  send: (path: string, method?: string, body?: unknown) => Promise<unknown>;
  current: () => boolean; publish: (state: TaskPromptState, snapshot: TaskPromptSnapshot) => void; t: Translate; delay?: number;
}) {
  let generation = 0, disposed = false, scope: ReferenceScope | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let commands: Row[] | undefined, agents: ReferenceCandidate[] | undefined, skills: ReferenceCandidate[] | undefined;
  const cancel = () => { generation++; clearTimeout(timer); timer = undefined; };
  function update(snapshot: TaskPromptSnapshot, context?: TaskCommandContext) {
    cancel();
    if (disposed || !options.current() || !snapshot.scope.host || !snapshot.scope.draft || !snapshot.scope.directory) return;
    if (!scope || !sameReferenceScope(scope, snapshot.scope)) { commands = undefined; agents = undefined; skills = undefined; scope = { ...snapshot.scope }; }
    const ticket = generation, captured = { ...snapshot, scope: { ...snapshot.scope }, trigger: { ...snapshot.trigger } };
    const valid = () => !disposed && options.current() && ticket === generation;
    options.publish({ rows: [], busy: true, failed: false }, captured);
    timer = setTimeout(() => { void (async () => {
      if (!valid()) return;
      const directory = captured.scope.directory, query = captured.trigger.query;
      if (captured.trigger.kind === 'slash-command') {
        let failed = false;
        if (!commands) try {
          const response = record(await options.send(`/api/config/commands/metadata?directory=${encodeURIComponent(directory)}`, 'POST', { catalog: true }));
          if (!valid()) return;
          if (response.ok === false || response.failed === true || !Array.isArray(response.commands)) throw new Error('Invalid command catalog');
          commands = response.commands.map(record).map(row => ({ name: row.name, description: row.description, source: row.source, scope: row.scope, agent: row.agent, model: row.model, isBuiltIn: row.isBuiltIn }));
        } catch { if (valid()) failed = true; }
        if (valid()) options.publish({ rows: taskCommandRows(commands ?? [], query, options.t, context), busy: false, failed }, captured);
        return;
      }
      const buckets: Partial<Record<'agent' | 'skill' | 'file' | 'directory', ReferenceCandidate[]>> = {};
      const pathQuery = resolveFileMentionSearchQuery(query);
      const jobs: Array<{ kind: 'agent' | 'skill' | 'file' | 'directory'; run: () => Promise<ReferenceCandidate[]> }> = [
        { kind: 'agent', run: async () => {
          if (agents) return agents;
          const response = await options.send(referenceRoute('agent', directory, ''));
          if (!valid()) return [];
          const payload = record(response).data ?? response;
          if (!Array.isArray(payload)) throw new Error('Invalid agent catalog');
          agents = referenceCandidates('agent', payload.filter(value => record(record(value).options).hidden !== true), '', directory, payload.length).map(row => ({ ...row, scope: { ...captured.scope } }));
          return agents;
        } },
        { kind: 'skill', run: async () => {
          if (skills) return skills;
          const response = record(await options.send(`/api/config/skills?summary=true&directory=${encodeURIComponent(directory)}`));
          if (!valid()) return [];
          if (response.ok === false || response.failed === true || !Array.isArray(response.skills)) throw new Error('Invalid skill catalog');
          skills = referenceCandidates('skill', response.skills.map(value => ({ ...record(value), id: text(record(value).name) })), '', directory, response.skills.length).map(row => ({ ...row, scope: { ...captured.scope } }));
          return skills;
        } },
        ...(pathQuery ? (['directory', 'file'] as const).map(kind => ({ kind, run: async () => {
          const max = kind === 'file' ? 80 : 40;
          const response = await options.send(referenceRoute(kind, directory, pathQuery, max));
          if (!valid()) return [];
          return referenceCandidates(kind, response, '', directory, max).map(row => ({ ...row, scope: { ...captured.scope } }));
        } })) : []),
      ];
      let pending = jobs.length, failed = false;
      const emit = () => { if (valid()) options.publish({ rows: mixedReferenceRows((['skill', 'agent', 'directory', 'file'] as const).flatMap(kind => buckets[kind] ?? []), query).map(row => ({ presentation: row.presentation, candidate: row.candidate })), busy: pending > 0, failed }, captured); };
      for (const job of jobs) void job.run().then(rows => { if (valid()) buckets[job.kind] = rows; }).catch(() => { if (valid()) failed = true; }).finally(() => { if (valid()) { pending--; emit(); } });
    })(); }, options.delay ?? 180);
  }
  return { update, close: cancel, dispose() { cancel(); disposed = true; commands = undefined; agents = undefined; skills = undefined; } };
}
