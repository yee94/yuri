import { expect, test } from 'vitest';
import { nativeCommandRows, shouldSubmitCommandOnSelection } from './composer-commands-model';
import { rankCommandsForQuery } from '../ui/src/lib/composer-autocomplete/slash-rank';
import { buildSlashCommandRows } from '../ui/src/lib/composer-autocomplete/rows';
import { nativeAutocompleteSurface, nativeComposerSurface } from './composer-surface';

const scope = { host: 'host', draft: 'draft', directory: '/workspace' };
const t = (key: string) => key;
test('300 Host commands retain Web fuzzy ordering, rows, labels and icons without truncation', () => {
  const catalog = Array.from({ length: 300 }, (_, index) => ({ name: `task-${index}`, description: `Describe ${index}`, scope: 'project' }));
  const all = nativeCommandRows(catalog, '', scope, t);
  expect(all).toHaveLength(315);
  for (const query of ['', 'tsk2', 'Describe 29', 'model', 'no-match-ever']) {
    const actual = nativeCommandRows(catalog, query, scope, t);
    const ranked = rankCommandsForQuery(all.map(row => row.command), query);
    expect(actual.map(row => row.command)).toEqual(ranked);
    expect(actual.map(row => row.presentation)).toEqual(buildSlashCommandRows(ranked, { skill: t('chat.commandAutocomplete.badge.skill'), command: t('chat.commandAutocomplete.badge.command'), system: t('chat.commandAutocomplete.badge.system') }));
    expect(actual.every(row => row.scope !== scope && row.scope.host === scope.host)).toBe(true);
  }
});
test('skills are not slash commands, local names win, and unknown Host reserved names never auto-run', () => {
  const rows = nativeCommandRows([{ name: 'skill-only', source: 'skill' }, { name: 'model' }, { name: 'compact', isBuiltIn: true }, { name: 'btw' }], '', scope, t);
  expect(rows.some(row => row.command.name === 'skill-only')).toBe(false);
  expect(rows.filter(row => row.command.name === 'model')).toHaveLength(1);
  for (const row of rows) {
    expect(shouldSubmitCommandOnSelection(row.command, false)).toBe(false);
    expect(shouldSubmitCommandOnSelection(row.command, true)).toBe(row.command.id === 'yuri:model');
  }
});
test('mobile local catalog follows session, message and unsent-draft context without relabeling Host commands', () => {
  const host = ['init', 'new', 'undo', 'redo', 'fork', 'timeline', 'compact', 'btw', 'model', 'summary', 'workspace-review', 'craft-goal', 'catch-up', 'debug', 'weigh', 'explore'].map(name => ({ name: name.toUpperCase(), isBuiltIn: true }));
  const names = (context: Parameters<typeof nativeCommandRows>[4]) => nativeCommandRows([...host, { name: 'goal' }], '', scope, t, context);
  const draft = names({ hasSession: false, hasMessages: false, hasNewDraft: true });
  expect(draft.filter(row => row.command.source === 'yuri').map(row => row.command.name).sort()).toEqual(['new', 'model', 'compact', 'workspace-review', 'craft-goal', 'catch-up', 'debug', 'weigh', 'explore'].sort());
  expect(draft.some(row => row.command.name === 'summary' || row.command.name === 'init')).toBe(false);
  const empty = names({ hasSession: true, hasMessages: false, hasNewDraft: false });
  expect(empty.filter(row => row.command.source === 'yuri')).toHaveLength(16);
  expect(empty.find(row => row.command.name === 'init')?.command.id).toBe('yuri:init');
  const session = names({ hasSession: true, hasMessages: true, hasNewDraft: false });
  expect(session.some(row => row.command.name === 'init')).toBe(false);
  expect(session.find(row => row.command.name === 'goal')?.command.source).toBe('opencode');
  expect(session.some(row => row.command.name === 'reload')).toBe(false);
  const allActions = ['new', 'undo', 'redo', 'fork', 'timeline', 'compact', 'btw', 'model'] as const;
  for (const row of session) {
    expect(shouldSubmitCommandOnSelection(row.command, false, allActions)).toBe(false);
    expect(shouldSubmitCommandOnSelection({ ...row.command, id: `opencode:${row.command.name}`, source: 'opencode' }, true, allActions)).toBe(false);
    expect(shouldSubmitCommandOnSelection(row.command, true, allActions)).toBe(['new', 'undo', 'redo', 'fork', 'compact', 'btw', 'model'].includes(row.command.name));
  }
});
test('each surface owns native Liquid Glass with transparent content contract', () => {
  for (const surface of [nativeComposerSurface, nativeAutocompleteSurface]) {
    expect(surface.glassEffect).toBe('regular'); expect(surface.backgroundColor).toBe('transparent');
  }
});
