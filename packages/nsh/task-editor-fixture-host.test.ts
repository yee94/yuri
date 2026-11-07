import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createTaskPromptSearch, type TaskPromptState, taskPromptTrigger } from './task-editor-prompt-core';
import { vi } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
function fakeHost() {
  const source = readFileSync(path.join(directory, 'task-editor-native.fixture-host.js'), 'utf8');
  const context = vm.createContext({ URL: undefined, URLSearchParams: undefined });
  expect(vm.runInContext('typeof URL + ":" + typeof URLSearchParams', context)).toBe('undefined:undefined');
  const make = vm.runInContext(source.replace('export function createHost', 'function createHost') + '\ncreateHost;', context) as () => { call(name: string, input: Record<string, unknown>): { status: number; body: unknown } };
  const host = make();
  return async (path: string, method = 'GET', body?: unknown) => {
    const result = host.call('runtime.request', { path, method, ...(body === undefined ? {} : { body }) });
    if (result.status >= 400) throw new Error('HTTP ' + result.status);
    return result.body;
  };
}
describe('Task isolated fake Host without browser globals (not QuickJS)', () => {
  it('accepts real scoped routes and rejects wrong/duplicate/query/config writes', async () => {
    const send = fakeHost();
    expect(await send('/api/config/commands/metadata?directory=%2Factual%2Fworktree', 'POST', { catalog: true })).toMatchObject({ commands: [{ name: 'check' }] });
    for (const path of ['/api/config/commands/metadata?directory=%2Ffirst', '/api/config/commands/metadata?directory=%2Factual%2Fworktree&directory=%2Fother', '/api/config/commands/metadata?directory=%ZZ', '/api/config/commands/metadata?directory=%2Factual%2Fworktree#fragment', 'https://host.example/api/config/settings']) await expect(send(path, 'POST', { catalog: true })).rejects.toThrow();
    await expect(send('/api/config/settings', 'PUT', {})).rejects.toThrow();
    await expect(send('/api/dictation/tts/speak', 'POST', {})).rejects.toThrow();
  });
  it('production search consumes this exact no-URL fake Host for both command and mixed suggestion paths', async () => {
    vi.useFakeTimers();
    try {
      const states: TaskPromptState[] = [];
      const search = createTaskPromptSearch({ send: fakeHost(), current: () => true, t: key => key, publish: state => states.push(state), delay: 0 });
      const update = (value: string) => search.update({ scope: { host: 'fixture', draft: 'task', directory: '/actual/worktree' }, text: value, cursor: value.length, trigger: taskPromptTrigger(value, value.length)! });
      update('/che'); await vi.advanceTimersByTimeAsync(1);
      expect(states.at(-1)?.rows.some(row => row.command === 'check')).toBe(true);
      update('@gen'); await vi.advanceTimersByTimeAsync(1);
      expect(states.at(-1)?.failed).toBe(false);
      expect(states.at(-1)?.rows.some(row => row.candidate?.value === 'general')).toBe(true);
      expect(states.at(-1)?.rows.some(row => row.candidate?.value === 'generate')).toBe(true);
      update('@src/main'); await vi.advanceTimersByTimeAsync(1);
      expect(states.at(-1)?.rows.some(row => row.candidate?.value === '/actual/worktree/src/main.ts')).toBe(true);
      search.dispose();
    } finally { vi.useRealTimers(); }
  });
});
