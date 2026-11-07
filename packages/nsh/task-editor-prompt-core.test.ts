import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskPromptSearch, insertTaskPromptChoice, taskCommandRows, taskPromptTrigger, type TaskPromptSnapshot, type TaskPromptState } from './task-editor-prompt-core';
import { insertTokenWithReferenceBoundaries } from '../ui/src/components/chat/insertionBoundaries';
import { resolveComposerAutocompleteTrigger } from '../ui/src/lib/composer-autocomplete/trigger';
import { mixedReferenceRows } from './composer-references';

const scope = { host: 'host-a', draft: 'task-new', directory: '/actual/worktree' };
const snapshot = (value: string, directory = scope.directory): TaskPromptSnapshot => ({ scope: { ...scope, directory }, text: value, cursor: value.length, trigger: taskPromptTrigger(value, value.length)! });
const t = (key: Parameters<typeof taskCommandRows>[2] extends (key: infer K) => string ? K : never) => String(key);
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());
describe('Task prompt uses shared composer semantics without Chat submission', () => {
  it('reuses exact trigger and insertion boundaries including middle-of-text caret and suffix', () => {
    for (const value of ['/comm', '/command args', 'Review @gen', 'email@host', '@', '#tag', '/comm\nrest']) expect(taskPromptTrigger(value, value.length)).toEqual(resolveComposerAutocompleteTrigger({ text: value, cursor: value.length }));
    const value = 'Read @src then keep suffix', cursor = 'Read @src'.length;
    const current = { scope, text: value, cursor, trigger: taskPromptTrigger(value, cursor)! };
    const candidate = { kind: 'file' as const, label: '/actual/worktree/src/main.ts', value: '/actual/worktree/src/main.ts', scope };
    const row = { candidate, presentation: { id: 'file:source', title: 'src/main.ts', iconName: 'file-code' as const } };
    expect(insertTaskPromptChoice(current, current, row)).toEqual(insertTokenWithReferenceBoundaries(value, current.trigger.tokenStart, cursor, '@src/main.ts'));
    expect(insertTaskPromptChoice(current, { ...current, scope: { ...scope, directory: '/other' } }, row)).toBeNull();
    expect(insertTaskPromptChoice(current, { ...current, text: value + ' changed' }, row)).toBeNull();
    const command = snapshot('/cmd\ntext'); command.cursor = 4; command.trigger = taskPromptTrigger(command.text, 4)!;
    expect(insertTaskPromptChoice(command, command, { command: 'build', presentation: { id: 'x', title: '/build', iconName: 'terminal' } })).toEqual({ text: '/build ', caret: 7 });
  });
  it('matches Web command eligibility; skills stay in @, and descriptions use the shared fuzzy rank', () => {
    const catalog = [{ name: 'check', description: 'Validate changes', scope: 'project' }, { name: 'skill-command', source: 'skill' }];
    expect(taskCommandRows(catalog, '', t).map(row => row.command)).toEqual(['compact', 'model', 'new', 'check']);
    const current = taskCommandRows(catalog, '', t, { sessionID: 'captured', hasMessages: true, hasNewDraft: false }).map(row => row.command);
    expect(current).toContain('summary'); expect(current).toContain('undo'); expect(current).toContain('explore'); expect(current).not.toContain('init'); expect(current).not.toContain('skill-command');
    expect(taskCommandRows(catalog, 'Validate', t).map(row => row.command)).toEqual(['check']);
  });
  it('loads only while open, calls compact command metadata once per scope, and closing fences late results', async () => {
    vi.useFakeTimers(); let finish!: (value: unknown) => void;
    const send = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const states: TaskPromptState[] = [];
    const search = createTaskPromptSearch({ send, t, current: () => true, delay: 10, publish: value => states.push(value) });
    expect(send).not.toHaveBeenCalled(); search.update(snapshot('/check')); await vi.advanceTimersByTimeAsync(10);
    expect(send.mock.calls[0]).toEqual(['/api/config/commands/metadata?directory=%2Factual%2Fworktree', 'POST', { catalog: true }]);
    search.close(); finish({ commands: [{ name: 'check' }] }); await drain(); expect(states.at(-1)?.busy).toBe(true);
    search.dispose();
  });
  it('queries only file/directory/Agent/installed Skill in selected scope, shared ranking preserves healthy partial results', async () => {
    vi.useFakeTimers(); const paths: string[] = []; const states: TaskPromptState[] = [];
    const send = async (path: string) => {
      paths.push(path);
      if (path.startsWith('/api/agent')) return { data: [{ name: 'general', mode: 'subagent' }, { name: 'hidden', hidden: true }, { name: 'primary', mode: 'primary' }] };
      if (path.startsWith('/api/config/skills')) return { skills: [{ name: 'generator', description: 'Generate source', scope: 'user' }] };
      if (path.includes('type=directory')) throw new Error('directory offline');
      return { data: [{ type: 'file', path: '/actual/worktree/gen.ts' }] };
    };
    const search = createTaskPromptSearch({ send, t, current: () => true, delay: 0, publish: value => states.push(value) });
    search.update(snapshot('@gen')); await vi.advanceTimersByTimeAsync(1); await drain();
    expect(paths).toHaveLength(4); expect(paths.every(path => !path.startsWith('/api/session'))).toBe(true);
    expect(paths).toContain('/api/config/skills?summary=true&directory=%2Factual%2Fworktree');
    expect(states.at(-1)).toMatchObject({ busy: false, failed: true });
    const rows = states.at(-1)!.rows;
    expect(rows.map(row => row.presentation)).toEqual(mixedReferenceRows(rows.map(row => row.candidate!), 'gen').map(row => row.presentation));
    expect(rows.some(row => row.candidate?.kind === 'agent')).toBe(true); expect(rows.some(row => row.candidate?.kind === 'skill')).toBe(true); expect(rows.some(row => row.candidate?.kind === 'file')).toBe(true);
    search.dispose();
  });
  it('switching projects rejects old suggestions, retries a failed read, and never writes configuration or a task', async () => {
    vi.useFakeTimers(); let current = true, fail = true;
    const calls: Array<{ path: string; method?: string }> = [], states: TaskPromptState[] = [];
    const search = createTaskPromptSearch({ t, current: () => current, delay: 0, publish: value => states.push(value), send: async (path, method) => {
      calls.push({ path, method }); if (fail) throw new Error('offline'); return { commands: [{ name: 'other-command' }] };
    } });
    search.update(snapshot('/other', '/other')); await vi.advanceTimersByTimeAsync(1); expect(states.at(-1)?.failed).toBe(true);
    fail = false; search.update(snapshot('/other', '/other')); await vi.advanceTimersByTimeAsync(1);
    expect(states.at(-1)?.rows.some(row => row.command === 'other-command')).toBe(true);
    expect(calls.every(call => call.path.startsWith('/api/config/commands/metadata?directory=%2Fother') && call.method === 'POST')).toBe(true);
    current = false; const count = calls.length; search.update(snapshot('/new', '/another')); await vi.advanceTimersByTimeAsync(1000); expect(calls).toHaveLength(count); search.dispose();
  });
});
