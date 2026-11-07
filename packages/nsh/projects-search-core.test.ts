import { describe, expect, it, vi } from 'vitest';
import { scoreByFuzzyQuery } from '../ui/src/lib/search/fuzzySearch';
import { mergeSearchConversations, previewSearchGroup, projectSearchGroups, searchFilesFrom, searchMessagesFrom, searchSessionsFrom, type ProjectSearchCommand, type SearchMessage } from './projects-search-core';

const session = (id: string) => ({ id, title: `needle ${id}`, directory: '/remote', updated: 1 });
const hit = (sessionID: string, messageID: string, createdAt: number): SearchMessage => ({ sessionID, messageID, createdAt, title: `needle ${sessionID}`, directory: '/remote', snippet: `body ${messageID}`, role: 'assistant' });
const commands: ProjectSearchCommand[] = Array.from({ length: 10 }, (_, index) => ({ id: `c${index}`, title: `needle ${index}`, group: 'commands', onSelect: vi.fn() }));
const projects = Array.from({ length: 10 }, (_, index) => ({ id: `p${index}`, name: `needle ${index}`, path: `/project/${index}` }));

describe('native search matches Web grouping contracts', () => {
  it('merges title/body hits once per session, retaining title order and the newest exact message with deterministic ties', () => {
    const sessions = [session('s2'), session('s1'), session('s2')];
    const messages = [hit('s1', 'm1', 10), hit('s3', 'm3', 5), hit('s1', 'm2', 10), hit('s1', 'old', 9), hit('s3', 'm4', 6)];
    const rows = mergeSearchConversations(sessions, messages);
    expect(rows.map(row => [row.session.id, row.hit?.messageID])).toEqual([['s2', undefined], ['s1', 'm2'], ['s3', 'm4']]);
    expect(rows[1].session).toBe(sessions[1]); expect(rows[2].session.directory).toBe('/remote');
    expect(messages.map(row => row.messageID)).toEqual(['m1', 'm3', 'm2', 'old', 'm4']);
  });
  it('reuses Web substring and fuzzy ordering/limits without invoking command actions while deriving rows', () => {
    const files = projects.map(row => ({ path: `src/${row.name}.ts`, directory: '/focus' }));
    const input = { query: 'needle', commands: [...commands, ...commands.map(row => ({ ...row, id: `setting:${row.id}`, group: 'settings' as const }))], projects, sessions: [session('s')], messages: [hit('s', 'm', 1)], files };
    const groups = projectSearchGroups(input);
    expect(groups.commands).toEqual(scoreByFuzzyQuery(commands, 'needle', row => `${row.title} `, { limit: 7, noFuzzy: true }).map(row => row.item));
    expect(groups.commands).toHaveLength(7); expect(groups.settings).toHaveLength(7); expect(groups.projects).toHaveLength(7); expect(groups.files).toHaveLength(10); expect(groups.sessions).toHaveLength(1);
    const typo = projectSearchGroups({ ...input, query: 'nedle' });
    expect(typo.commands).toEqual([]); expect(typo.projects).toEqual(scoreByFuzzyQuery(projects, 'nedle', row => `${row.name} ${row.path}`, { limit: 7, threshold: 0.4 }).map(row => row.item));
    commands.forEach(row => expect(row.onSelect).not.toHaveBeenCalled());
  });
  it('has five independent previews, and the expanded group shows all already-fetched rows without paging or side effects', () => {
    const groups = projectSearchGroups({ query: 'needle', commands: [...commands, ...commands.map(row => ({ ...row, group: 'settings' as const }))], projects, sessions: projects.map(row => session(row.id)), messages: [], files: projects.map(row => ({ path: `needle-${row.id}.ts`, directory: '/focus' })) });
    for (const group of groups.order) {
      const rows = groups[group];
      expect(previewSearchGroup(rows as unknown[], 'needle', false).visible).toHaveLength(5);
      expect(previewSearchGroup(rows as unknown[], 'needle', false).remaining).toBe(rows.length - 5);
      expect(previewSearchGroup(rows as unknown[], 'needle', true)).toEqual({ visible: rows, remaining: 0 });
    }
  });
  it('blank query shows recent sessions before all commands, never settings/projects/files', () => {
    const groups = projectSearchGroups({ query: ' ', commands, projects, sessions: [session('s')], messages: [], files: [{ path: 'needle.ts', directory: '/focus' }] });
    expect(groups.order).toEqual(['sessions', 'commands']); expect(groups.commands).toHaveLength(10);
    expect(groups.settings).toEqual([]); expect(groups.projects).toEqual([]); expect(groups.files).toEqual([]);
    expect(previewSearchGroup(commands, '', false).visible).toBe(commands);
  });
  it('handles a 10k-session title/content overlap in a single output per identity without mutating authority', () => {
    const sessions = Array.from({ length: 10_000 }, (_, i) => session(`s${i}`)), messages = sessions.map((row, i) => hit(row.id, `m${i}`, i));
    const rows = mergeSearchConversations(sessions, messages);
    expect(rows).toHaveLength(10_000); expect(rows[9999].hit?.messageID).toBe('m9999');
    expect(rows.every((row, i) => row.session === sessions[i])).toBe(true);
  });
});

describe('strict search authorities', () => {
  it('rejects malformed responses rather than turning a failed domain into empty success', () => {
    expect(() => searchSessionsFrom({ data: [null] })).toThrow();
    expect(() => searchMessagesFrom({ hits: [{ ...hit('s', 'm', 1), createdAt: '1' }] })).toThrow();
    expect(() => searchMessagesFrom({ hits: [{ ...hit('s', 'm', 1), createdAt: NaN }] })).toThrow();
    expect(() => searchMessagesFrom({ hits: [{ ...hit('s', 'm', 1), messageID: '' }] })).toThrow();
    expect(() => searchFilesFrom({ data: [null] }, '/focus')).toThrow();
    expect(searchSessionsFrom({ data: [] })).toEqual([]); expect(searchMessagesFrom({ hits: [] })).toEqual([]); expect(searchFilesFrom({ data: [] }, '/focus')).toEqual([]);
  });
  it('deduplicates file identities inside one Focus without widening their scope', () => {
    expect(searchFilesFrom({ data: ['src/a.ts', { path: 'src/a.ts' }, { path: 'b.ts' }] }, '/focus')).toEqual([{ path: 'src/a.ts', directory: '/focus' }, { path: 'b.ts', directory: '/focus' }]);
  });
});
