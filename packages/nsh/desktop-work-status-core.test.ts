import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import type { DesktopWorkStatusChat, DesktopWorkStatusChild, DesktopWorkStatusScope } from './desktop-work-status-core';
import type { PageOperation } from './page-operations';
import type { Part } from '../ui/src/lib/opencode/v2-types';

// Exercise the actual cross-package pure helpers with their owning tsconfig aliases,
// without changing the deliberately alias-free standalone NSH Vitest config.
const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(path.join(parent, 'desktop-work-status-pure-')), outfile = path.join(directory, 'core.cjs');
const bundled = spawnSync('bun', ['build', path.join(root, 'desktop-work-status-core.ts'), '--target=node', '--format=cjs', '--outfile', outfile], { encoding: 'utf8' });
if (bundled.status !== 0) { rmSync(directory, { recursive: true, force: true }); throw new Error(bundled.stdout + bundled.stderr); }
const { createDesktopWorkStatusProjection, createDesktopWorkStatusTaskProjection, createDesktopWorkStatusWindowOwner, desktopWorkStatusAgents, desktopWorkStatusLayout, desktopWorkStatusTodos } = createRequire(import.meta.url)(outfile) as typeof import('./desktop-work-status-core');
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const scope: DesktopWorkStatusScope = { host: { hostID: 'synthetic', lease: 'lease' }, authorityKey: 'authority', sessionID: 'parent', directory: '/synthetic/project' };
const chat: DesktopWorkStatusChat = { tasks: [], activity: 'unknown', taskFaces: [], liveTaskPartIDs: new Set(), backgroundShell: { phase: 'unavailable' } };
const child = (id: string, activity: DesktopWorkStatusChild['activity'] = 'idle'): DesktopWorkStatusChild => ({ id, title: `Child ${id}`, parentID: 'parent', directory: scope.directory!, activity });
const operation = (current = () => true): PageOperation => ({ scope: scope.host, generation: 1, current, request: async () => { throw new Error('unexpected read'); } });
const face = (id: string, sessionID?: string, running = false) => ({ id, sessionID, label: 'Explore', description: `Task ${id}`, running });
const layoutInput = { windowWidth: 1440, desktop: true, active: true, expandedInput: false, hasSession: true, draftConversation: false, previewOpen: false, rightSidebarOpen: false };

describe('Web WorkStatus native narrow contract', () => {
  test('NSH pure helper prebundle is byte-exact generated Web code, not a parallel handwritten algorithm', () => {
    const source = spawnSync('bun', ['build', 'packages/ui/src/components/chat/work-status/workStatusSubagents.ts', '--target=browser', '--format=esm', '--env=disable', '--minify'], { cwd: path.resolve(root, '../..'), encoding: 'utf8' });
    expect(source.status, source.stderr).toBe(0);
    expect(readFileSync(path.join(root, 'desktop-work-status-helpers.generated.ts'), 'utf8').split('\n').slice(2).join('\n').trim()).toBe(source.stdout.trim());
  });
  test('window breakpoint, full-width reserve, manual popup and exact toggle semantics', () => {
    const window = createDesktopWorkStatusWindowOwner();
    expect(desktopWorkStatusLayout(layoutInput, window.state())).toMatchObject({ fits: true, inline: true, overlay: false, reserve: 210, selected: true });
    const narrow = { ...layoutInput, windowWidth: 1439 };
    expect(desktopWorkStatusLayout(narrow, window.state()).inline).toBe(false);
    window.toggle(false); expect(desktopWorkStatusLayout(narrow, window.state())).toMatchObject({ overlay: true, selected: true, reserve: 0 });
    window.toggle(true); expect(window.state()).toEqual({ enabled: false, overlayOpen: false });
    window.toggle(false); expect(window.state()).toEqual({ enabled: true, overlayOpen: true });
    expect(desktopWorkStatusLayout({ ...layoutInput, previewOpen: true }, window.state()).overlay).toBe(true);
    expect(desktopWorkStatusLayout({ ...layoutInput, rightSidebarOpen: true }, window.state()).inline).toBe(false);
    for (const override of [{ active: false }, { expandedInput: true }, { desktop: false }, { hasSession: false }]) expect(desktopWorkStatusLayout({ ...layoutInput, ...override }, window.state()).mountable).toBe(false);
    expect(desktopWorkStatusLayout({ ...layoutInput, hasSession: false, draftConversation: true }, window.state()).mountable).toBe(true);
  });
  test('cancelled and all-finished tasks stay present; live alone drives animation', () => {
    const tasks = ['completed', 'cancelled', 'pending', 'in_progress'].map((status, id) => ({ id: String(id), status, content: status, priority: 'medium' }));
    expect(desktopWorkStatusTodos(tasks, 'idle')).toMatchObject({ completed: 1, total: 4, allDone: false, spinning: false, inProgressIndex: 3 });
    expect(desktopWorkStatusTodos(tasks, 'working').spinning).toBe(true);
    expect(desktopWorkStatusTodos(tasks.slice(0, 2), 'working')).toMatchObject({ completed: 1, total: 2, allDone: true, spinning: false });
    expect(desktopWorkStatusTodos([], 'unknown').total).toBe(0);
  });
  test('shared task projector, dedup/title precedence/seed and historical running fence', () => {
    const project = createDesktopWorkStatusTaskProjection();
    const parts = [{ id: 'part', type: 'tool', tool: 'task', state: { status: 'running', input: { description: 'Task description', subagent_type: 'explore' }, metadata: { sessionId: 'child' } } }] as unknown as Part[];
    const data = { messageOrder: ['m'], partsByMessageID: { m: parts } };
    const projected = project(data); expect(project(data)).toBe(projected);
    const source = { ...chat, taskFaces: [face('a', 'x', true), face('b', 'x'), face('unresolved', undefined, true)] };
    expect(desktopWorkStatusAgents(source, [])).toMatchObject([{ key: 'x', seed: 'x', phase: 'unknown' }, { key: 'unresolved', phase: 'unknown' }]);
    expect(desktopWorkStatusAgents(source, [child('x')])[0]).toMatchObject({ key: 'x', label: 'Child x', phase: 'done' });
    expect(desktopWorkStatusAgents({ ...source, liveTaskPartIDs: new Set(['unresolved']) }, [child('x', 'working')]).map(row => row.phase)).toEqual(['working', 'working']);
  });
  test('reference-stable narrow commits perform no work for 50 unrelated inputs', () => {
    let notices = 0; const owner = createDesktopWorkStatusProjection({ scope, current: () => true, changed: () => notices++ });
    owner.commitChat(chat); const before = owner.state(), count = notices;
    for (let index = 0; index < 50; index++) { const unrelatedDraft = `input ${index}`; expect(unrelatedDraft.length).toBeGreaterThan(0); owner.commitChat({ ...chat }); }
    expect(notices).toBe(count); expect(owner.state().todos).toBe(before.todos); expect(owner.state().agents).toBe(before.agents);
    owner.commitChat({ ...chat, backgroundShell: { phase: 'unknown' } });
    expect(owner.state().todos).toBe(before.todos); expect(owner.state().agents).toBe(before.agents);
    expect(owner.state().chat.backgroundShell).toEqual({ phase: 'unknown' });
  });
  test('Git failed refresh preserves prior; unknown, clean empty and not-repository remain distinct', () => {
    const owner = createDesktopWorkStatusProjection({ scope, current: () => true });
    expect(owner.state().location.git.phase).toBe('unknown');
    const value = { branch: 'main', changedFiles: 0, additions: null, deletions: null };
    owner.commitLocation({ project: null, secondaryWorktree: null, git: { phase: 'ready', value } });
    owner.commitLocation({ project: null, secondaryWorktree: null, git: { phase: 'failed' } });
    expect(owner.state().location.git).toEqual({ phase: 'failed', value });
    owner.commitLocation({ project: null, secondaryWorktree: null, git: { phase: 'not-repository' } });
    expect(owner.state().location.git).toEqual({ phase: 'not-repository' });
  });
  test('explicit read coalesces per PageOperation, failure keeps prior, success empty clears', async () => {
    const owner = createDesktopWorkStatusProjection({ scope, current: () => true });
    expect(owner.state().children).toEqual({ phase: 'unknown' });
    const lane = operation(); let reads = 0;
    let release!: (rows: readonly DesktopWorkStatusChild[]) => void;
    const read = async () => { reads++; return new Promise<readonly DesktopWorkStatusChild[]>(resolve => { release = resolve; }); };
    const first = owner.readChildren(lane, read), second = owner.readChildren(lane, read);
    await Promise.resolve(); expect(reads).toBe(1); release([child('x')]); await Promise.all([first, second]);
    await owner.readChildren(lane, async () => { throw new Error('offline'); });
    expect(owner.state().children).toEqual({ phase: 'failed', value: [child('x')] });
    await owner.readChildren(lane, async () => []); expect(owner.state().children).toEqual({ phase: 'ready', value: [] });
  });
  test('cross-parent/directory/lease reads rejected, lane retirement fences late finally and replacement', async () => {
    const owner = createDesktopWorkStatusProjection({ scope, current: () => true });
    owner.commitChildren({ phase: 'ready', value: [child('prior')] });
    await owner.readChildren(operation(), async () => [{ ...child('wrong'), parentID: 'other' }]);
    expect(owner.state().children).toEqual({ phase: 'failed', value: [child('prior')] });
    await owner.readChildren(operation(), async () => [{ ...child('wrong'), directory: '/other' }]);
    expect(owner.state().children.value).toEqual([child('prior')]);
    expect(() => owner.commitChildren({ phase: 'ready', value: [child('duplicate'), child('duplicate')] })).toThrow('work_status_duplicate_child');
    let called = false;
    await owner.readChildren({ ...operation(), scope: { hostID: 'synthetic', lease: 'other' } }, async () => { called = true; return []; }); expect(called).toBe(false);
    let release!: (rows: readonly DesktopWorkStatusChild[]) => void;
    const stale = owner.readChildren(operation(), () => new Promise(resolve => { release = resolve; })); await Promise.resolve();
    owner.retireLane(); await owner.readChildren(operation(), async () => [child('fresh')]);
    release([child('late')]); await stale;
    expect(owner.state().children).toEqual({ phase: 'ready', value: [child('fresh')] });
  });
  test('display retirement is irreversible, modal is not display retirement', () => {
    let current = true; const owner = createDesktopWorkStatusProjection({ scope, current: () => current });
    owner.commitChat(chat); owner.retireLane(); expect(owner.current()).toBe(true);
    current = false; expect(owner.current()).toBe(false); current = true;
    expect(owner.commitChat({ ...chat, activity: 'working' })).toBe(false); expect(owner.current()).toBe(false);
  });
});
