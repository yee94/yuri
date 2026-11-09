import { describe, expect, it } from 'vitest';
import {
  DESKTOP_SIDEBAR_INITIAL_COUNT, desktopSidebarProjects, desktopSidebarScope,
  desktopSidebarSelected, desktopSidebarWindow,
} from './desktop-sidebar-model';
import type { ChatTarget, Project } from './model';

const row = (id: string, directory = '/project') => ({ id, directory, title: id, updated: 1 });
const selected: ChatTarget = { kind: 'session', ...row('current') };

describe('desktop sidebar presentation, not a second catalog protocol', () => {
  it('isolates same IDs by Host, authorization and generation', () => {
    const connection = { id: 'host', url: 'https://host.example', authorizationID: 'first' };
    const key = desktopSidebarScope(connection, 1);
    expect(desktopSidebarScope(null, 1)).toBeNull();
    expect(desktopSidebarScope({ ...connection }, 1)).toBe(key);
    for (const changed of [{ ...connection, id: 'other' }, { ...connection, url: 'https://other.example' }, { ...connection, authorizationID: 'next' }]) {
      expect(desktopSidebarScope(changed, 1)).not.toBe(key);
    }
    expect(desktopSidebarScope(connection, 2)).not.toBe(key);
  });
  it('selects only the actual session and directory, not an assistant with a colliding ID', () => {
    expect(desktopSidebarSelected(row('current', '/project/'), selected)).toBe(true);
    expect(desktopSidebarSelected(row('current', '/other'), selected)).toBe(false);
    expect(desktopSidebarSelected(row('current'), { ...selected, kind: 'assistant' })).toBe(false);
    expect(desktopSidebarSelected(row('current'), null)).toBe(false);
    expect(desktopSidebarSelected(row('current', 'c:\\Project\\'), { ...selected, directory: 'C:/Project' })).toBe(true);
  });
  it('retains controller project, worktree and session rank without identity sorting or mutation', () => {
    const projects: Project[] = [{ id: 'z', name: 'Z', path: '/project' }, { id: 'a', name: 'A', path: '/other' }];
    const ranked = [row('z'), row('a')], branch = [row('tree-session', '/tree')];
    const groups = desktopSidebarProjects(projects, new Map([['/project/', ranked], ['/tree', branch]]), project => project.id === 'z' ? [
      { path: '/project/', name: 'duplicate root', branch: 'main' },
      { path: '/tree/', name: 'tree-name', branch: 'feature' },
      { path: '/tree', name: 'duplicate tree', branch: 'feature' },
      { path: '/a-tree', name: 'name fallback', branch: '' },
    ] : []);
    expect(groups.map(group => group.project.id)).toEqual(['z', 'a']);
    expect(groups[0]?.groups.map(group => group.directory)).toEqual(['/project', '/tree/', '/a-tree']);
    expect(groups[0]?.groups[0]?.rows).toBe(ranked);
    expect(groups[0]?.groups[1]?.rows).toBe(branch);
    expect(groups[0]?.groups.map(group => group.label)).toEqual(['Z', 'feature', 'name fallback']);
    expect(groups[1]?.groups[0]?.rows).toEqual([]);
    expect(ranked.map(row => row.id)).toEqual(['z', 'a']);
  });
  it('uses the desktop three-row fold, omits pins and keeps live/current rows beyond it', () => {
    const rows = ['pin', 'z', 'a', 'b', 'hidden', 'running', 'current'].map(id => row(id));
    const result = desktopSidebarWindow(rows, DESKTOP_SIDEBAR_INITIAL_COUNT, new Set(['pin']), new Set(['running']), selected);
    expect(result.rows.map(row => row.id)).toEqual(['z', 'a', 'b', 'running', 'current']);
    expect(result.hidden).toBe(1);
    expect(desktopSidebarWindow(rows, 10, new Set(['pin']), new Set(), null).hidden).toBe(0);
    expect(desktopSidebarWindow(rows, 0, new Set(), new Set(), selected).rows.map(row => row.id)).toEqual(['current']);
  });
  it('does one catalog projection rather than project × directory × session scans', () => {
    const projects = Array.from({ length: 50 }, (_, index) => ({ id: String(index), name: String(index), path: `/project-${index}` }));
    const directories = new Map(projects.map(project => [project.path, Array.from({ length: 40 }, (_, index) => row(`${project.id}-${index}`, project.path))]));
    let catalogReads = 0;
    const result = desktopSidebarProjects(projects, directories, () => { catalogReads++; return []; });
    expect(catalogReads).toBe(50);
    expect(result.flatMap(project => project.groups.flatMap(group => group.rows))).toHaveLength(2000);
    for (const [index, project] of result.entries()) expect(project.groups[0]?.rows).toBe(directories.get(projects[index]!.path));
  });
});
