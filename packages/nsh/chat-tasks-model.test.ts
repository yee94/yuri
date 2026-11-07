import { describe, expect, it, vi } from 'vitest';
import { createChatStatusPopovers, createTasksProjection, resolveTaskSources, summarizeTasks, type NativeTask } from './chat-tasks-model';
import { messageFrom, type Row } from './model';

const task = (content: string, status = 'pending'): NativeTask => ({ content, status, priority: 'medium' });
const message = (id: string, parts: Row[]) => messageFrom({ id, type: 'assistant', content: parts })!;
const write = (todos: unknown, status = 'completed', name = 'todowrite'): Row => ({ type: 'tool', name, state: { input: { todos }, status } });

describe('Tasks authoritative source projection', () => {
  it('uses newest usable todowrite in content/record order, not ID/time, including running writes', () => {
    const project = createTasksProjection();
    expect(project([message('z', [write([task('old')])]), message('a', [write([task('earlier')]), write([task('current', 'in_progress')], 'running')])])).toEqual([task('current', 'in_progress')]);
  });
  it('explicit empty clears; failed/aborted/malformed/todoread do not replace the previous write', () => {
    const project = createTasksProjection(), previous = message('before', [write([task('before')])]);
    for (const status of ['error', 'aborted', 'failed', 'cancelled', 'canceled', 'timeout']) expect(project([previous, message('after', [write([], status)])])).toEqual([task('before')]);
    expect(project([previous, message('after', [write(undefined), write([], 'completed', 'todoread')])])).toEqual([task('before')]);
    expect(project([previous, message('after', [write([])])])).toEqual([]);
    expect(project([])).toBeUndefined();
  });
  it('parses native JSON input only when complete and honors the exact revert boundary', () => {
    const project = createTasksProjection();
    const old = message('z', [write([task('visible')])]);
    const newer = message('a', [{ type: 'tool', name: 'todowrite', state: { status: 'running', input: JSON.stringify({ todos: [task('new')] }) } }]);
    expect(project([old, newer])).toEqual([task('new')]);
    expect(project([old, newer], 'a')).toEqual([task('visible')]);
    expect(project([old, newer], 'z')).toBeUndefined();
    expect(project([old, message('broken', [{ type: 'tool', name: 'todowrite', state: { input: '{"todos":[' } }])])).toEqual([task('visible')]);
  });
  it('normalizes fields like Web, preserving status/content/order and default priority', () => {
    expect(createTasksProjection()([message('a', [write([{ id: 't', content: '', status: 'unknown' }, null, { content: 2, status: 'pending' }])])])).toEqual([{ id: 't', content: '', status: 'unknown', priority: 'medium' }]);
  });
  it('keeps task references across repeated text updates without retaining the history array', () => {
    const input = { todos: [task('stable')] }, project = createTasksProjection();
    const source = { type: 'tool', name: 'todowrite', state: { status: 'running', input } };
    const first = project([message('a', [source])]);
    for (let index = 0; index < 50; index++) expect(project([message('a', [source, { type: 'text', text: `delta ${index}` }])])).toBe(first);
    expect(project([message('a', [source, write([])])])).not.toBe(first);
  });
  it('matches Web transcript/live/persisted fallback without confusing persisted content for live work', () => {
    const persisted = [task('persisted', 'in_progress')], live = [task('legacy live')], empty: NativeTask[] = [];
    expect(resolveTaskSources(empty, live, persisted)).toBe(empty);
    expect(resolveTaskSources(undefined, live, persisted)).toBe(live);
    expect(resolveTaskSources(undefined, [], persisted)).toBe(persisted);
    expect(summarizeTasks(persisted, false).spinning).toBe(false);
  });
});

describe('phone Tasks/Changes presentation contract', () => {
  it('hides cancelled, retains source order, counts active/left and hides all-complete entry', () => {
    const summary = summarizeTasks([task('completed', 'completed'), task('cancelled', 'cancelled'), task('pending'), task('running', 'in_progress')], false);
    expect(summary).toMatchObject({ completed: 1, total: 3, active: 1, left: 2, activeIndex: 2, show: true, spinning: false });
    expect(summary.rows().map(row => row.todo.content)).toEqual(['completed', 'pending', 'running']);
    expect(summarizeTasks([task('done', 'completed'), task('skip', 'cancelled')], false).show).toBe(false);
  });
  it('only live authority animates; first pending is display-active only when live working', () => {
    const todos = [task('one'), task('two')];
    expect(summarizeTasks(todos, false).rows().map(row => row.status)).toEqual(['pending', 'pending']);
    expect(summarizeTasks(todos, true).rows().map(row => row.status)).toEqual(['in_progress', 'pending']);
    expect(todos[0].status).toBe('pending');
    expect(summarizeTasks([task('a'), task('b', 'in_progress')], true).rows().map(row => row.status)).toEqual(['pending', 'in_progress']);
  });
  it('is lazy for a 300-item closed popup: summary does not construct row keys/labels', () => {
    const todos = Array.from({ length: 300 }, (_, index) => task(`task ${index}`));
    const ids = vi.fn(() => undefined);
    for (const todo of todos) Object.defineProperty(todo, 'id', { get: ids });
    for (let index = 0; index < 50; index++) expect(summarizeTasks(todos, false).left).toBe(300);
    expect(ids).not.toHaveBeenCalled();
    expect(summarizeTasks(todos, false).rows()).toHaveLength(300); expect(ids).toHaveBeenCalled();
  });
  it('has stable unique row keys even when upstream IDs repeat', () => {
    const summary = summarizeTasks([{ ...task('same'), id: 'x' }, { ...task('same'), id: 'x' }], false);
    expect(new Set(summary.rows().map(row => row.key)).size).toBe(2);
  });
  it('opening either phone popup synchronously closes the other; stale closes cannot dismiss the new one', () => {
    const notify = vi.fn(), owner = createChatStatusPopovers(notify);
    owner.tasks(true); expect(owner.opened()).toBe('tasks');
    owner.changes(true); expect(owner.opened()).toBe('changes');
    owner.tasks(false); expect(owner.opened()).toBe('changes');
    owner.tasks(true); expect(owner.opened()).toBe('tasks');
    owner.changes(false); expect(owner.opened()).toBe('tasks');
    owner.close(); owner.close(); expect(owner.opened()).toBeNull(); expect(notify).toHaveBeenCalledTimes(4);
  });
});
