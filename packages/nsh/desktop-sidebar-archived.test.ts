import { expect, test } from 'vitest';
import { desktopSidebarReadAllArchived } from './desktop-sidebar-archived';
import type { ProjectsSidebarSnapshot, SidebarSession } from './projects-sidebar';

const row = (id: string, directory = '/workspace'): SidebarSession => ({ id, directory, title: id, updated: 1, pinned: false, archived: true });
const empty = (): ProjectsSidebarSnapshot => ({ children: {}, archived: {}, folders: null, pending: [], errors: {}, unknown: [] });
test('archived delete admission explicitly drains opaque pages in each exact directory, not just folded visible rows', async () => {
  const state = empty(), calls: Array<[string, boolean]> = [];
  const result = await desktopSidebarReadAllArchived({ directories: ['/workspace', '/tree'], current: () => true, snapshot: () => state, load: async (directory, more) => {
    calls.push([directory, more]);
    const rows = more ? [row('first', directory), row('folded', directory)] : [row('first', directory)];
    state.archived[directory] = { rows, cursor: more ? null : 'opaque:+/?', loaded: true };
  } });
  expect(calls).toEqual([['/workspace', false], ['/workspace', true], ['/tree', false], ['/tree', true]]);
  expect(result?.map(value => [value.directory, value.id])).toEqual([['/workspace', 'first'], ['/workspace', 'folded'], ['/tree', 'first'], ['/tree', 'folded']]);
});
test('failed refresh, incomplete/foreign pages, repeated cursors and retired authority never grant empty-success or partial deletion', async () => {
  for (const failure of ['error', 'incomplete', 'foreign', 'cursor', 'retired'] as const) {
    const state = empty(); let current = true, count = 0;
    state.archived['/workspace'] = { rows: [row('retained')], cursor: null, loaded: true };
    const result = await desktopSidebarReadAllArchived({ directories: ['/workspace', '/tree'], current: () => current, snapshot: () => state, load: async directory => {
      count++;
      if (failure === 'error') state.errors[`archived:${directory}`] = 'failed read';
      if (failure === 'incomplete') state.archived[directory] = { rows: [], cursor: null, loaded: false };
      if (failure === 'foreign') state.archived[directory] = { rows: [row('foreign', '/other')], cursor: null, loaded: true };
      if (failure === 'cursor') state.archived[directory] = { rows: [], cursor: 'same', loaded: true };
      if (failure === 'retired') current = false;
    } });
    expect(result, failure).toBeNull(); expect(count).toBeLessThanOrEqual(2);
  }
});
