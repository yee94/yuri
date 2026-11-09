import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHost as uiHost } from './tests/settings-host.js';
import { createHost as outerHost } from './tests/settings-outer-host.js';
import { createHost as collectionsHost } from './tests/settings-collections-host.js';
import { createHost as providersHost } from './tests/settings-provider-removal-host.js';
import * as protocol from './settings-protocol';
import { createMagicPromptsEditor } from './settings-magic-state';
import { createHost as schedulesHost } from './tests/schedules-host.js';
import { createHost as assistantsHost } from './tests/assistants-host.js';
import { createHost as assistantsSettingsHost } from './tests/assistants-settings-host.js';
import { nativeLayoutDensity } from './native-density';

const h = vi.hoisted(() => ({ call: vi.fn(), stops: [] as Array<() => void>, cleanups: [] as Array<() => void>, depth: 0 }));
vi.mock('nsh', () => {
  type Reaction = { run: () => void; deps: Set<Set<Reaction>>; stopped: boolean; dispose?: () => void };
  let current: Reaction | undefined, flushing = false;
  const pending = new Set<Reaction>();
  function flush() {
    if (h.depth || flushing) return;
    flushing = true;
    try { while (pending.size) { const next = pending.values().next().value!; pending.delete(next); if (!next.stopped) next.run(); } } finally { flushing = false; }
  }
  function signal<T>(value: T) {
    const deps = new Set<Reaction>();
    const get = () => { if (current) { deps.add(current); current.deps.add(deps); } return value; };
    const set = (next: T) => { if (Object.is(value, next)) return; value = next; for (const reaction of deps) pending.add(reaction); flush(); };
    return Object.assign(get, { set, update: (work: (value: T) => T) => set(work(value)) });
  }
  const phase = signal('active');
  function untracked<T>(work: () => T) { const before = current; current = undefined; try { return work(); } finally { current = before; } }
  function effect(work: () => unknown) {
    const reaction: Reaction = { deps: new Set(), stopped: false, run() {
      untracked(() => reaction.dispose?.()); reaction.deps.forEach(deps => deps.delete(reaction)); reaction.deps.clear();
      const before = current; current = reaction;
      try { const dispose = work(); reaction.dispose = typeof dispose === 'function' ? dispose as () => void : undefined; } finally { current = before; }
    } };
    h.stops.push(() => { reaction.stopped = true; pending.delete(reaction); reaction.deps.forEach(deps => deps.delete(reaction)); untracked(() => reaction.dispose?.()); }); reaction.run();
  }
  return { signal, effect, untracked, computed: <T>(work: () => T) => work, List: 'List', Scroll: 'Scroll', lifecycle: Object.assign(() => phase(), { set: phase.set }), cleanup: (work: () => void) => h.cleanups.push(work),
    batch: <T>(work: () => T) => { h.depth++; try { return work(); } finally { h.depth--; flush(); } },
    Storage: { getItem: async () => null, setItem: async () => { throw new Error('Fixture must not persist real Storage'); } },
    host: { available: () => true, call: h.call, on: () => () => {} }, Text: 'Text', View: 'View' };
});
const ticks = async () => { for (let index = 0; index < 100; index++) await Promise.resolve(); };
beforeEach(() => { vi.resetModules(); h.call.mockReset(); h.stops = []; h.cleanups = []; h.depth = 0; });
afterEach(() => { h.stops.forEach(stop => stop()); h.cleanups.forEach(cleanup => cleanup()); });

const scenarios = [
  ['commands', uiHost, '/api/command?location%5Bdirectory%5D=%2Fnative%2Fproject'],
  ['outer', outerHost, '/api/config/settings'],
  ['collections', collectionsHost, '/api/agent?location%5Bdirectory%5D=%2Ffixture%2Fproject'],
  ['providers', providersHost, '/api/config/catalog/providers?directory=%2Ffixture%2Fproject'],
  ['schedules', schedulesHost, '/api/yuri/scheduled-tasks'],
  ['assistants', assistantsHost, '/api/yuri/assistants/capability'],
  ['assistants-settings', assistantsSettingsHost, '/api/yuri/assistants/capability'],
] as const;

for (const [kind, create, resource] of scenarios) {
  it(`${kind}: strict admission rejects unissued/missing/extra/stale/cross-Host authority before dispatch`, () => {
    const host = create(), request = { path: resource, method: 'GET' };
    expect(() => host.call('runtime.request', request)).toThrow('snapshot not issued');
    const snapshot = host.call('connection.list', {}), expectedHost = snapshot.runtimeScope;
    for (const input of [request, { ...request, expectedHost: null }, { ...request, expectedHost: { hostID: expectedHost.hostID } },
      { ...request, expectedHost: { ...expectedHost, extra: true } }, { ...request, expectedHost: { ...expectedHost, hostID: 'other' } },
      { ...request, expectedHost: { ...expectedHost, lease: 'stale' } }, { ...request, expectedHost, headers: {} }]) {
      expect(() => host.call('runtime.request', input)).toThrow();
    }
    expect(host.call('runtime.request', { ...request, expectedHost }).status).toBe(200);
    host.call('settings.fixture.scope', { mode: 'other' }); host.call('connection.list', {});
    host.call('settings.fixture.scope', { mode: 'return' }); host.call('connection.list', {});
    expect(() => host.call('runtime.request', { ...request, expectedHost })).toThrow('Stale synthetic scope forwarding');
    expect(host.call('settings.fixture.scopeAudit', {}).admitted).toBe(1);
  });

  it(`${kind}: actual fixture boot waits for loadConnections; production page lane reads only with adopted authority and resumes retained state`, async () => {
    const host = create();
    let finish!: () => void;
    h.call.mockImplementation((name, input) => name === 'connection.list' ? new Promise(resolve => { finish = () => resolve(host.call(name, input)); }) : host.call(name, input));
    const nsh = await import('nsh'), state = await import('./state');
    (nsh.lifecycle as unknown as { set: (value: string) => void }).set('active');
    const { settingsEngineFixtureBoot } = await import('./settings-engine-fixture-boot');
    const boot = settingsEngineFixtureBoot(); await ticks();
    expect(boot.mounted()).toBe(false); expect(boot.active()).toBe(false);
    expect(state.captureHostOperation().current()).toBe(false);
    expect(h.call.mock.calls.map(([name]) => name)).toEqual(['connection.list']);
    const exports: Record<string, unknown> = {};
    const root = path.dirname(fileURLToPath(import.meta.url));
    const source = ts.transpileModule(readFileSync(path.join(root, 'settings-controls.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React } }).outputText;
    const modules: Record<string, unknown> = { nsh, 'nsh/base': {}, './native-select': {}, './i18n': { t: (key: string) => key }, './state': state, './settings-protocol': protocol,
      './appearance': { nativeDensity: () => nativeLayoutDensity() } };
    vm.runInNewContext(source, { exports, require: (id: string) => { if (!(id in modules)) throw new Error('Unexpected fixture import ' + id); return modules[id]; } });
    let page!: ReturnType<typeof import('./settings-controls').settingsPageLifetime>;
    nsh.effect(() => {
      if (boot.mounted()) nsh.untracked(() => {
        expect(boot.active()).toBe(true);
        page = (exports.settingsPageLifetime as typeof import('./settings-controls').settingsPageLifetime)(boot.active);
        void page.perform(async operation => { expect(await operation.request(resource)).toBeTruthy(); });
      });
    });
    finish(); await ticks();
    expect(boot.mounted()).toBe(true); expect(boot.active()).toBe(true);
    expect(h.call.mock.calls.filter(([name]) => name === 'runtime.request')).toHaveLength(1);
    const first = page.operation(); expect(first?.current()).toBe(true);
    await page.perform(async operation => { expect(await operation.request(resource)).toBeTruthy(); });
    expect(page.error()).toBe('');
    const oldScope = state.app.runtimeScope();
    const controller = kind === 'commands' ? createMagicPromptsEditor(first!.request, first!.current, () => {}) : null;
    if (controller) { await controller.load(); controller.setDraft('git.commit.generate.visible', 'Retained fixture draft'); }
    page.observeOperation(operation => controller?.replaceLane(operation));
    (nsh.lifecycle as unknown as { set: (value: string) => void }).set('background'); await ticks();
    expect(boot.mounted()).toBe(true); expect(boot.active()).toBe(false); expect(first?.current()).toBe(false);
    host.call('settings.fixture.scope', { mode: 'renew' });
    (nsh.lifecycle as unknown as { set: (value: string) => void }).set('active'); await ticks();
    expect(boot.mounted()).toBe(true); expect(boot.active()).toBe(false);
    expect(page.operation()).toBeNull();
    finish(); await ticks();
    expect(boot.active()).toBe(true); expect(page.operation()?.current()).toBe(true);
    expect(page.operation()).not.toBe(first); expect(state.app.runtimeScope()).not.toEqual(oldScope);
    await page.perform(async operation => { expect(await operation.request(resource)).toBeTruthy(); });
    if (controller) { await controller.load(); expect(controller.value('git.commit.generate.visible')).toBe('Retained fixture draft'); }
    expect(page.error()).toBe('');
    expect(h.call.mock.calls.filter(([name]) => name === 'runtime.request').every(([, input]) => input.method === 'GET')).toBe(true);
    expect(host.call('settings.fixture.scopeAudit', {}).rejected).toBe(0);
    const count = host.call('settings.fixture.scopeAudit', {}).admitted;
    await expect(first!.request(resource)).rejects.toThrow();
    expect(host.call('settings.fixture.scopeAudit', {}).admitted).toBe(count);
  });
}

it('actual scheduled catalog/history wait for fixture admission, retain snapshots and capture a new production page operation after foreground confirmation', async () => {
  const host = schedulesHost(); let finish!: () => void;
  h.call.mockImplementation((name, input) => name === 'connection.list' ? new Promise(resolve => { finish = () => resolve(host.call(name, input)); }) : host.call(name, input));
  const nsh = await import('nsh'), state = await import('./state'), model = await import('./model');
  const { settingsEngineFixtureBoot } = await import('./settings-engine-fixture-boot');
  const boot = settingsEngineFixtureBoot(), root = path.dirname(fileURLToPath(import.meta.url));
  const modules: Record<string, unknown> = { nsh, './state': state, './model': model, './i18n': { t: (key: string) => key } };
  function evaluate<T>(filename: string): T {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(readFileSync(path.join(root, filename), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText,
      { exports, require(id: string) { if (!(id in modules)) throw new Error('Unexpected schedule fixture import ' + id); return modules[id]; } });
    return exports as T;
  }
  modules['./page-operations'] = evaluate('page-operations.ts');
  const schedules = evaluate<typeof import('./schedules-state')>('schedules-state.ts');
  let catalog!: ReturnType<typeof schedules.createScheduledCatalog>, history!: ReturnType<typeof schedules.createScheduledHistory>;
  nsh.effect(() => { if (boot.mounted()) nsh.untracked(() => {
    state.app.projects.set([{ id: 'project', name: 'Native workspace', path: '/workspace/project' }]);
    catalog = schedules.createScheduledCatalog(); history = schedules.createScheduledHistory();
    void catalog.load(); void history.load();
  }); });
  await ticks(); expect(h.call.mock.calls.map(([name]) => name)).toEqual(['connection.list']);
  finish(); await ticks();
  expect(state.app.tasks()).toHaveLength(2); expect(history.runs()).toHaveLength(1);
  const first = catalog.capture(), priorTasks = state.app.tasks(), priorRuns = history.runs();
  (nsh.lifecycle as unknown as { set: (value: string) => void }).set('background'); await ticks();
  expect(first.current()).toBe(false); expect(boot.mounted()).toBe(true);
  expect(state.app.tasks()).toBe(priorTasks); expect(history.runs()).toBe(priorRuns);
  host.call('settings.fixture.scope', { mode: 'renew' });
  (nsh.lifecycle as unknown as { set: (value: string) => void }).set('active'); await ticks();
  const count = h.call.mock.calls.filter(([name]) => name === 'runtime.request').length;
  await catalog.load(); await history.load();
  expect(h.call.mock.calls.filter(([name]) => name === 'runtime.request')).toHaveLength(count);
  finish(); await ticks();
  expect(catalog.capture()).not.toBe(first); expect(catalog.current()).toBe(true);
  await catalog.load(); await history.load();
  expect(state.app.tasks()).toHaveLength(2); expect(history.runs()).toHaveLength(1);
  await catalog.mutate(state.app.tasks()[0], 'toggle');
  expect(host.call('settings.fixture.scopeAudit', {}).rejected).toBe(0);
  expect(await state.captureHostOperation().request('/fixture/schedules/audit')).toMatchObject({ toggles: 1, runs: 0, deletes: 0 });
});

it.each(['home', 'settings'] as const)('actual Assistant %s controller starts only after root admission and reads its strict synthetic catalog', async kind => {
  const host = kind === 'home' ? assistantsHost() : assistantsSettingsHost(); let finish!: () => void;
  h.call.mockImplementation((name, input) => name === 'connection.list' ? new Promise(resolve => { finish = () => resolve(host.call(name, input)); }) : host.call(name, input));
  const nsh = await import('nsh'), state = await import('./state'), model = await import('./model'), core = await import('./assistants-core');
  const { settingsEngineFixtureBoot } = await import('./settings-engine-fixture-boot');
  const boot = settingsEngineFixtureBoot(), root = path.dirname(fileURLToPath(import.meta.url));
  type Node = { type: string; props: Record<string, unknown>; children: unknown[] };
  const modules: Record<string, unknown> = { nsh, './state': state, './model': model, './i18n': { t: (key: string) => key }, './assistants-core': core,
    './appearance': { nativeDensity: () => nativeLayoutDensity() },
    'nsh/base': { Button: 'Button', NavPage: 'NavPage', Input: 'Input' }, './Icon': { Icon: 'Icon' },
    './assistants-avatar-live': { AssistantAvatar: 'Avatar' }, './assistants-swipe': { AssistantSwipeRow: 'Swipe' }, './assistants-details': {}, './assistants-settings': {},
  };
  function evaluate<T>(filename: string): T {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(readFileSync(path.join(root, filename), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' } }).outputText,
      { exports, If: 'If', Each: 'Each', setTimeout, clearTimeout, jsx: (type: string, props: Node['props'], ...children: unknown[]) => ({ type, props: props || {}, children }),
        require(id: string) { if (!(id in modules)) throw new Error('Unexpected Assistant fixture import ' + id); return modules[id]; } });
    return exports as T;
  }
  modules['./page-operations'] = evaluate('page-operations.ts');
  const home = kind === 'home' ? evaluate<typeof import('./assistants')>('assistants.tsx') : null;
  const settings = kind === 'settings' ? evaluate<typeof import('./assistants-settings')>('assistants-settings.tsx') : null;
  let tree: unknown;
  nsh.effect(() => { if (boot.mounted()) nsh.untracked(() => {
    state.app.tab.set(kind === 'home' ? 1 : 3);
    const props = { get active() { return boot.active(); }, onCreate() {}, onEdit() {}, onOpenChat() {} };
    tree = home ? home.AssistantHome(props) : settings!.AssistantSettings(props);
  }); });
  await ticks(); expect(h.call.mock.calls.map(([name]) => name)).toEqual(['connection.list']);
  finish(); await ticks();
  const nodes = (value: unknown): Node[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'props' in value ? [value as Node, ...(value as Node).children.flatMap(nodes)] : [];
  if (kind === 'settings') {
    expect(state.app.bots()).toHaveLength(0);
    const list = nodes(tree).find(node => node.props.testID === 'assistant-settings-catalog'); expect(list).toBeTruthy();
    const retry = nodes((list!.props.header as () => unknown)()).find(node => node.props.testID === 'assistant-settings-retry'); expect(retry).toBeTruthy();
    (retry!.props.onPress as () => void)(); await ticks(); expect(state.app.bots()).toHaveLength(1);
  } else {
    expect(state.app.bots()).toHaveLength(2);
    const prior = state.app.bots();
    (nsh.lifecycle as unknown as { set: (value: string) => void }).set('background'); await ticks();
    expect(state.app.bots()).toBe(prior);
    host.call('settings.fixture.scope', { mode: 'renew' });
    (nsh.lifecycle as unknown as { set: (value: string) => void }).set('active'); await ticks();
    const count = h.call.mock.calls.filter(([name]) => name === 'runtime.request').length;
    finish(); await ticks();
    expect(state.app.bots()).toHaveLength(2);
    expect(h.call.mock.calls.filter(([name]) => name === 'runtime.request').length).toBeGreaterThan(count);
  }
  expect(host.call('settings.fixture.scopeAudit', {}).rejected).toBe(0);
  expect(h.call.mock.calls.filter(([name]) => name === 'runtime.request').every(([, input]) => input.method === 'GET')).toBe(true);
});
