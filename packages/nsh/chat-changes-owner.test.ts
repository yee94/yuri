import { afterEach, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createChangesGeneration } from './chat-changes-generation';
import { changesWriteJournal, createChangesActions } from './chat-changes-actions';
import { changeGroups } from './chat-changes-model';

const reactive = vi.hoisted(() => {
  type Reaction = { run: () => void; dependencies: Set<Set<Reaction>>; stopped: boolean };
  let tracking: Reaction | undefined, flushing = false;
  const queue = new Set<Reaction>(), reactions: Reaction[] = [], cleanups: Array<() => void> = [];
  const untracked = <T>(work: () => T) => { const previous = tracking; tracking = undefined; try { return work(); } finally { tracking = previous; } };
  function signal<T>(initial: T) {
    let value = initial; const observers = new Set<Reaction>();
    const read = () => { if (tracking) { observers.add(tracking); tracking.dependencies.add(observers); } return value; };
    return Object.assign(read, { set(next: T) {
      if (Object.is(value, next)) return;
      value = next; observers.forEach(observer => queue.add(observer));
      if (flushing) return;
      flushing = true; let turns = 0;
      try { while (queue.size) { if (++turns > 100) throw new Error('reaction loop'); const reaction = queue.values().next().value!; queue.delete(reaction); if (!reaction.stopped) reaction.run(); } } finally { flushing = false; }
    } });
  }
  function effect(work: () => void) {
    const reaction: Reaction = { stopped: false, dependencies: new Set(), run() {
      reaction.dependencies.forEach(set => set.delete(reaction)); reaction.dependencies.clear();
      const previous = tracking; tracking = reaction;
      try { work(); } finally { tracking = previous; }
    } };
    reactions.push(reaction); reaction.run();
  }
  return { signal, effect, untracked, computed: <T>(work: () => T) => work,
    lifecycle: signal('active'), cleanups,
    dispose() { reactions.splice(0).forEach(reaction => { reaction.stopped = true; reaction.dependencies.forEach(set => set.delete(reaction)); }); cleanups.splice(0).reverse().forEach(work => work()); queue.clear(); },
  };
});
const root = vi.hoisted(() => {
  const connection = reactive.signal({ id: 'fixture', url: 'https://fixture.example', authorizationID: 'fixture' });
  const scope = reactive.signal({ hostID: 'fixture', lease: 'fixture-lease' });
  const epoch = reactive.signal(1), ready = reactive.signal(true), read = vi.fn();
  function captureHostOperation() {
    const generation = epoch(), captured = scope();
    const current = () => ready() && generation === epoch() && captured === scope();
    return { generation, scope: captured, current, request: async (path: string, method = 'GET', body?: unknown) => {
      if (!current()) throw new Error('host_operation_stale');
      const result = await read(path, method, body);
      if (!current()) throw new Error('host_operation_stale');
      return result;
    } };
  }
  return { connection, scope, epoch, ready, read, captureHostOperation };
});
vi.mock('nsh', () => ({ ...reactive, cleanup: (work: () => void) => reactive.cleanups.push(work) }));
vi.mock('./state', () => ({ app: { connection: root.connection, runtimeScope: root.scope }, epoch: root.epoch,
  captureHostOperation: root.captureHostOperation, captureHostRequest: () => root.captureHostOperation().request }));

import { createChangesOwner } from './chat-changes-owner';
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
afterEach(() => { reactive.dispose(); root.read.mockReset(); root.ready.set(true); root.connection.set({ id: 'fixture', url: 'https://fixture.example', authorizationID: 'fixture' }); root.scope.set({ hostID: 'fixture', lease: 'fixture-lease' }); });

test('closed workspace opens through real page operations and reads branch without another click', async () => {
  root.read.mockResolvedValue({ isClean: false, current: 'fixture-branch', files: [{ path: 'a.ts', index: ' ', working_dir: 'M' }] });
  const opened = reactive.signal(false);
  const owner = createChangesOwner({ kind: 'workspace', directory: '/fixture' }, opened);
  await flush(); expect(root.read).not.toHaveBeenCalled();
  opened.set(true); await flush();
  expect(owner.reader.current()).toBe(true);
  expect(owner.state().snapshot?.current).toBe('fixture-branch');
  expect(root.read.mock.calls.map(([path]) => path)).toEqual(['/api/git/status?directory=%2Ffixture']);
});

test('path-targeted historical owner selects on admitted open and never reads current Git', async () => {
  root.read.mockRejectedValue(new Error('No runtime HTTP allowed for complete history'));
  const opened = reactive.signal(false);
  const owner = createChangesOwner({ kind: 'turn', directory: '/fixture', sessionID: 's', messageID: 'm', path: 'history.ts', files: [{ path: 'history.ts', before: 'old', after: 'HISTORICAL_ONLY' }] }, opened);
  opened.set(true); await flush();
  expect(owner.state()).toMatchObject({ path: 'history.ts', diff: { after: 'HISTORICAL_ONLY' }, diffError: '' });
  expect(root.read).not.toHaveBeenCalled();
});

test('opening before root readiness waits for admission and close fences late status', async () => {
  root.ready.set(false);
  let resolve!: (value: unknown) => void;
  root.read.mockImplementation(() => new Promise(done => { resolve = done; }));
  const opened = reactive.signal(true);
  const owner = createChangesOwner({ kind: 'workspace', directory: '/fixture' }, opened);
  await flush(); expect(root.read).not.toHaveBeenCalled();
  root.ready.set(true); await flush(); expect(root.read).toHaveBeenCalledTimes(1);
  opened.set(false);
  resolve({ isClean: true, current: 'LATE_BRANCH', files: [] }); await flush();
  expect(owner.reader.current()).toBe(false);
  expect(owner.state().snapshot).toBeNull();
});

test('list-only history requires real selection and thin history failure never reads Git', async () => {
  const opened = reactive.signal(false);
  root.read.mockImplementation(async (path: string) => { if (path.startsWith('/api/git/')) throw new Error('Current Git forbidden'); return { diff: { file: 'thin.ts' } }; });
  const owner = createChangesOwner({ kind: 'turn', directory: '/fixture', sessionID: 's', messageID: 'm', files: [{ path: 'history.ts', before: 'old', after: 'HISTORICAL_ONLY' }, { path: 'thin.ts' }] }, opened);
  opened.set(true); await flush();
  expect(owner.state().path).toBe('');
  await owner.reader.select('history.ts'); expect(owner.state().diff?.after).toBe('HISTORICAL_ONLY');
  owner.reader.back(); await owner.reader.select('thin.ts');
  expect(owner.state().diff).toBeNull(); expect(owner.state().diffError).toBe('Historical diff body unavailable');
  expect(root.read.mock.calls.map(([path]) => path)).toEqual(['/api/yuri/sessions/s/changes?directory=%2Ffixture&messageID=m&file=thin.ts']);
});

test('reader identity consumers rebind once per operation, not per status notification; failed refresh keeps prior', async () => {
  root.read.mockResolvedValue({ isClean: false, current: 'fixture-branch', files: [{ path: 'a.ts', index: 'M', working_dir: 'M' }] });
  const opened = reactive.signal(true);
  const owner = createChangesOwner({ kind: 'workspace', directory: '/fixture' }, opened);
  const readers: Array<typeof owner.reader> = [];
  reactive.effect(() => { readers.push(owner.reader); });
  await flush();
  expect(root.read).toHaveBeenCalledTimes(1); expect(readers).toHaveLength(1);
  const prior = owner.state().snapshot;
  root.read.mockRejectedValue(new Error('status offline'));
  await owner.reader.refresh();
  expect(owner.state().snapshot).toBe(prior); expect(owner.state().error).toBe('status offline'); expect(readers).toHaveLength(1);
  const previous = owner.reader;
  opened.set(false); expect(previous.current()).toBe(false);
  root.read.mockResolvedValue({ isClean: true, current: 'fresh-branch', files: [] });
  opened.set(true); await flush();
  expect(owner.reader).not.toBe(previous); expect(readers.at(-1)).toBe(owner.reader);
  expect(owner.state().snapshot?.current).toBe('fresh-branch');
});

// Execute the production Workspace setup/cleanup, replacing only its final JSX return.
// This exercises the real draft binding across the same remount as Each(reader identity).
function mountWorkspace(owner: ReturnType<typeof createChangesOwner>) {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'chat-changes-workspace.tsx');
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'NativeWorkspaceChanges')!;
  const body = declaration.body!.statements.filter(node => !ts.isReturnStatement(node)).map(node => node.getText(source)).join('\n');
  const output = ts.transpileModule(`function mount(props) { ${body}; return generation; }`, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText;
  const cleanups: Array<() => void> = [];
  const ports = { ...reactive, cleanup: (work: () => void) => cleanups.push(work), captureHostRequest: () => root.captureHostOperation().request,
    app: { runtimeScope: root.scope }, Storage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
    changesWriteJournal, createChangesActions, createChangesGeneration, changeGroups };
  const generation = new Function(...Object.keys(ports), `${output}; return mount;`)(...Object.values(ports))({ owner, active: true }) as ReturnType<typeof createChangesGeneration>;
  return { generation, unmount: () => cleanups.reverse().forEach(work => work()) };
}
function generationResponses() {
  root.read.mockImplementation(async (route: string) => {
    if (route.startsWith('/api/git/status?')) return { isClean: false, current: 'fixture-branch', files: [{ path: 'a.ts', index: 'M', working_dir: ' ' }] };
    if (route.startsWith('/api/git/remotes?')) return [];
    if (route === '/api/magic-prompts') return { version: 1, overrides: {} };
    if (route.startsWith('/api/git/diff?')) return { diff: '+material' };
    if (route === '/api/small-model/generate') return { text: '{"subject":"generated subject","highlights":["keep highlight"]}' };
    throw new Error('Unexpected test route: ' + route);
  });
}

test.each(['handwritten', 'generated'])('production Workspace preserves %s commit draft across same Host/directory lease replacement', async kind => {
  generationResponses();
  const owner = createChangesOwner({ kind: 'workspace', directory: '/fixture' }, () => true);
  await flush(); const first = mountWorkspace(owner);
  if (kind === 'handwritten') first.generation.edit('my exact handwritten commit');
  else expect(await first.generation.generate()).toBe(true);
  const before = first.generation.state(), previous = owner.reader;
  root.scope.set({ hostID: 'fixture', lease: 'replacement-lease' });
  first.unmount(); await flush();
  expect(owner.reader).not.toBe(previous); expect(previous.current()).toBe(false);
  const second = mountWorkspace(owner);
  expect(second.generation.state()).toMatchObject({ message: before.message, highlights: before.highlights, pending: false });
  first.generation.edit('retired callback'); first.generation.clear(); first.generation.insertHighlights();
  expect(second.generation.state()).toMatchObject({ message: before.message, highlights: before.highlights });
  if (kind === 'generated') {
    second.generation.insertHighlights();
    expect(second.generation.state()).toMatchObject({ message: 'generated subject\n\nkeep highlight', highlights: [] });
  }
  second.unmount();
});

test('production replacement rejects late old generation and shares edit CAS with the new binding', async () => {
  generationResponses();
  const respond = root.read.getMockImplementation()!;
  const pending: Array<(value: unknown) => void> = [];
  root.read.mockImplementation((route: string, method: string, body: unknown) => route === '/api/small-model/generate' ? new Promise(done => pending.push(done)) : respond(route, method, body));
  const owner = createChangesOwner({ kind: 'workspace', directory: '/fixture' }, () => true);
  await flush(); const first = mountWorkspace(owner);
  first.generation.edit('retain until edited'); const oldFlight = first.generation.generate(); await flush();
  expect(pending).toHaveLength(1);
  root.scope.set({ hostID: 'fixture', lease: 'new-lease' }); first.unmount(); await flush();
  const second = mountWorkspace(owner);
  expect(second.generation.state().message).toBe('retain until edited');
  second.generation.edit('new draft'); const newFlight = second.generation.generate(); await flush();
  expect(pending).toHaveLength(2);
  pending[0]({ text: '{"subject":"STALE","highlights":["STALE"]}' }); expect(await oldFlight).toBe(false);
  expect(second.generation.state()).toMatchObject({ message: 'new draft', highlights: [], pending: true });
  second.generation.edit('edited while generating'); pending[1]({ text: '{"subject":"also stale"}' }); expect(await newFlight).toBe(false);
  expect(second.generation.state()).toMatchObject({ message: 'edited while generating', highlights: [], pending: false });
  second.unmount();
});

test('production draft scopes are isolated across directory and Host changes', async () => {
  generationResponses();
  const firstOwner = createChangesOwner({ kind: 'workspace', directory: '/fixture' }, () => true);
  await flush(); const first = mountWorkspace(firstOwner); await first.generation.generate();
  const otherDirectory = createChangesOwner({ kind: 'workspace', directory: '/other' }, () => true);
  await flush(); const second = mountWorkspace(otherDirectory);
  expect(second.generation.state()).toMatchObject({ message: '', highlights: [] });
  second.generation.edit('other directory draft');
  expect(first.generation.state().message).toBe('generated subject');
  root.connection.set({ id: 'B', url: 'https://b.example', authorizationID: 'b' }); root.scope.set({ hostID: 'B', lease: 'b-lease' });
  first.unmount(); second.unmount();
  const otherHost = createChangesOwner({ kind: 'workspace', directory: '/fixture' }, () => true);
  await flush(); const third = mountWorkspace(otherHost);
  expect(third.generation.state()).toMatchObject({ message: '', highlights: [] }); third.unmount();
});
