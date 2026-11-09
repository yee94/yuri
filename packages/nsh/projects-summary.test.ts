import { describe, expect, it } from 'vitest';
import { nativeProjectHomeSummaries } from './projects-summary';

describe('Projects header uses project ownership, not the main directory or visible order', () => {
  it('does not let a terminal client page hide a failed directory marker or mark an unrelated project partial', () => {
    const value = nativeProjectHomeSummaries([{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }], [{ id: 'retained', directory: '/a', updated: 20 }], {}, { '/a': { hasMore: false }, '/b': { hasMore: false } }, { failedDirectories: ['/a/'], pendingDirectories: [] });
    expect(value.get('a')).toEqual({ count: 1, latest: 20, partial: true });
    expect(value.get('b')).toEqual({ count: 0, latest: 0, partial: false });
  });
  it('sums all linked worktrees and takes maximum updated time even with saved ranks', () => {
    const projects = [{ id: 'project', path: '/project' }];
    const sessions = [{ id: 'old-first', directory: '/project', updated: 1 }, { id: 'new', directory: '/worktrees/feature', updated: 100 }, { id: 'main', directory: '/project', updated: 30 }];
    const value = nativeProjectHomeSummaries(projects, sessions, { '/project': [{ path: '/worktrees/feature' }, { path: '/worktrees/feature' }] }, {});
    expect(value.get('project')).toEqual({ count: 3, latest: 100, partial: false });
    expect(nativeProjectHomeSummaries(projects, [...sessions].reverse(), { '/project': [{ path: '/worktrees/feature' }] }, {}).get('project')).toEqual(value.get('project'));
  });
  it('uses the same deepest-project/colliding-worktree rules as Web, including subdirectories', () => {
    const value = nativeProjectHomeSummaries([{ id: 'outer', path: '/project' }, { id: 'inner', path: '/project/nested' }], [
      { id: 'root', directory: '/project', updated: 10 },
      { id: 'nested', directory: '/project/nested/src', updated: 30 },
      { id: 'tree', directory: '/trees/feature/src', updated: 20 },
      { id: 'unknown', directory: '/elsewhere', updated: 999 },
    ], { '/project': [{ path: '/project/nested' }, { path: '/trees/feature' }] }, {});
    expect(value.get('outer')).toEqual({ count: 2, latest: 20, partial: false });
    expect(value.get('inner')).toEqual({ count: 1, latest: 30, partial: false });
  });
  it('propagates worktree paging without marking unrelated projects partial; retains prior rows through failed reads', () => {
    const value = nativeProjectHomeSummaries([{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }], [{ id: 'retained', directory: '/tree/a', updated: 20 }], { '/a': [{ path: '/tree/a' }] }, { '/tree/a': { hasMore: true } });
    expect(value.get('a')).toEqual({ count: 1, latest: 20, partial: true });
    expect(value.get('b')).toEqual({ count: 0, latest: 0, partial: false });
  });
  it('normalizes directory identity and ignores non-finite times without inventing an activity label', () => {
    const value = nativeProjectHomeSummaries([{ id: 'windows', path: 'C:/Project/' }], [{ id: 's', directory: 'c:\\Project\\src', updated: NaN }], {}, { 'c:\\Project': { hasMore: true } });
    expect(value.get('windows')).toEqual({ count: 1, latest: 0, partial: true });
    const linked = nativeProjectHomeSummaries([{ id: 'windows', path: 'C:/Project/' }], [{ id: 's', directory: 'c:\\Trees\\Topic\\src', updated: 10 }], { 'c:\\Project': [{ path: 'c:\\Trees\\Topic' }] }, { 'C:/Trees/Topic/': { hasMore: true } });
    expect(linked.get('windows')).toEqual({ count: 1, latest: 10, partial: true });
  });
});
