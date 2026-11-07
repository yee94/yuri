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
  expect(all).toHaveLength(308);
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
test('each surface owns native Liquid Glass with transparent content contract', () => {
  for (const surface of [nativeComposerSurface, nativeAutocompleteSurface]) {
    expect(surface.glassEffect).toBe('regular'); expect(surface.backgroundColor).toBe('transparent');
  }
});
