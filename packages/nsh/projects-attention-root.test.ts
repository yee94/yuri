import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { createProjectsAttention, createProjectsAttentionSource, isProjectsAttentionEvent } from './projects-attention';
import { readProjectsBlocking } from './projects-attention-blocking';
import { runtimeEventFrom } from './model';

const root = path.dirname(fileURLToPath(import.meta.url));
const file = ts.createSourceFile('state.ts', readFileSync(path.join(root, 'state.ts'), 'utf8'), ts.ScriptTarget.ES2023, true);
const declaration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'observeRuntime')!;
const compiled = ts.transpileModule(declaration.getText(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText;
function fixture(onEvent?: (event: ReturnType<typeof runtimeEventFrom>, scope: { hostID: string; generation: number }) => void) {
  const attention = createProjectsAttention();
  let event!: (payload: unknown) => void, active = true;
  const effects: Array<() => void> = [], cleanup: Array<() => void> = [];
  const send = vi.fn(async (path: string): Promise<unknown> => {
    expect(host.on).toHaveBeenCalledTimes(1);
    return path === '/api/debug/location' ? [{ directory: '/repo' }]
      : path.startsWith('/api/form?') ? { data: [{ id: 'pending', sessionID: 'root', metadata: { kind: 'question' } }] } : { data: [] };
  });
  const host = { on: vi.fn((_name: string, listener: typeof event) => { event = listener; return vi.fn(); }) };
  const context = vm.createContext({ exports: {}, generation: 1, switching: false, app: { connection: () => ({ id: 'host' }), sessions: () => [] },
    createProjectsAttentionSource, isProjectsAttentionEvent, projectsAttention: attention, request: send,
    effect: (work: () => void) => { effects.push(work); work(); }, untracked: (work: () => void) => work(), lifecycle: () => active ? 'active' : 'background',
    host, runtimeEventFrom, catalogDomains: () => [], report: (failure: unknown) => { throw failure; }, cleanup: (work: () => void) => cleanup.push(work),
    setTimeout, clearTimeout, dirtyDomains: new Set(), onEvent,
  });
  vm.runInContext(compiled + '\nexports.observeRuntime(() => {}, onEvent);', context);
  return { attention, send, host, context, effects, cleanup, hide: () => { active = false; effects.forEach(work => work()); }, show: () => { active = true; effects.forEach(work => work()); },
    emit: (type: string, data: Record<string, unknown> = {}, key = 'global') => event({ key, data: JSON.stringify({ directory: '/repo', payload: { type, data } }) }) };
}
it('the sole production sink forwards global and Chat events, but not hidden or switching scopes', () => {
  const sink = vi.fn(), f = fixture(sink);
  f.emit('session.updated', { sessionID: 'root' });
  f.emit('message.updated', { sessionID: 'root' }, 'chat');
  expect(sink.mock.calls.map(([event]) => event?.key)).toEqual(['global', 'chat']);
  expect(sink.mock.calls.map(([, scope]) => scope)).toEqual([{ hostID: 'host', generation: 1 }, { hostID: 'host', generation: 1 }]);
  expect(f.host.on).toHaveBeenCalledTimes(1);
  f.hide(); f.emit('message.updated', {}, 'chat'); f.show();
  vm.runInContext('switching = true;', f.context); f.emit('message.updated', {}, 'chat');
  expect(sink).toHaveBeenCalledTimes(2);
  f.cleanup.forEach(work => work());
});
it('production root seam bootstraps once, reuses its sole event listener and preserves a real block after viewing', async () => {
  const f = fixture(), key = JSON.stringify([1, 'host']);
  await vi.waitFor(() => expect(readProjectsBlocking(f.attention.snapshot(key).blockingByDirectory, '/repo', 'root').questionsKnown).toBe(true));
  expect(f.send).toHaveBeenCalledTimes(3); expect(f.host.on).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 1000; i++) f.emit('session.text.delta', { sessionID: 'root', delta: 'x' });
  expect(f.send).toHaveBeenCalledTimes(3);
  f.attention.setViewedSession(key, 'root'); expect(readProjectsBlocking(f.attention.snapshot(key).blockingByDirectory, '/repo', 'root').hasPendingQuestion).toBe(true);
  f.emit('form.replied', { sessionID: 'root', id: 'wrong' });
  expect(readProjectsBlocking(f.attention.snapshot(key).blockingByDirectory, '/repo', 'root').hasPendingQuestion).toBe(true);
  f.emit('form.replied', { sessionID: 'root', id: 'pending' });
  expect(readProjectsBlocking(f.attention.snapshot(key).blockingByDirectory, '/repo', 'root').hasPendingQuestion).toBe(false);
  f.emit('server.connected'); await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(6));
  f.hide(); f.emit('form.created', { id: 'hidden', sessionID: 'other', metadata: { kind: 'question' } });
  expect(readProjectsBlocking(f.attention.snapshot(key).blockingByDirectory, '/repo', 'other').hasPendingQuestion).toBe(false);
  f.show(); await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(9));
  f.cleanup.forEach(work => work()); expect(f.attention.retainedScopeCount()).toBe(0);
});
it('production root current callback rejects a generation change before a reactive scope effect has rerun', async () => {
  const f = fixture(), key = JSON.stringify([1, 'host']);
  // Inventory has been dispatched, but its continuation has not run.
  vm.runInContext('generation = 2;', f.context);
  await Promise.resolve(); await Promise.resolve();
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.attention.snapshot(key).blockingByDirectory).toEqual({});
  f.effects.forEach(work => work());
  const next = JSON.stringify([2, 'host']);
  await vi.waitFor(() => expect(readProjectsBlocking(f.attention.snapshot(next).blockingByDirectory, '/repo', 'root').questionsKnown).toBe(true));
  expect(f.attention.snapshot(key).blockingByDirectory).toEqual({}); f.cleanup.forEach(work => work());
});
