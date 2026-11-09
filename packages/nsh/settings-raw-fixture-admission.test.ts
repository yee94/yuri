import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHost as githubHost } from './tests/settings-github-host.js';
import { createHost as aboutHost } from './tests/settings-about-host.js';
import * as githubCore from './settings-github-core';
import * as gitProtocol from './settings-github-protocol';
import * as credentialsCore from './settings-git-credentials-core';
import * as aboutCore from './settings-about-core';
import * as diagnostics from './settings-about-diagnostics';
import * as protocol from './settings-protocol';

const h = vi.hoisted(() => ({ call: vi.fn(), cleanups: [] as Array<() => void>, stops: [] as Array<() => void>, depth: 0 }));
vi.mock('nsh', () => {
  type Reaction = { run: () => void; deps: Set<Set<Reaction>>; stopped: boolean; dispose?: () => void };
  let current: Reaction | undefined, flushing = false;
  const pending = new Set<Reaction>();
  function flush() {
    if (h.depth || flushing) return; flushing = true;
    try { while (pending.size) { const next = pending.values().next().value!; pending.delete(next); if (!next.stopped) next.run(); } } finally { flushing = false; }
  }
  function signal<T>(value: T) {
    const deps = new Set<Reaction>();
    const get = () => { if (current) { deps.add(current); current.deps.add(deps); } return value; };
    const set = (next: T) => { if (Object.is(value, next)) return; value = next; for (const reaction of deps) pending.add(reaction); flush(); };
    return Object.assign(get, { set, update: (work: (previous: T) => T) => set(work(value)) });
  }
  function untracked<T>(work: () => T) { const before = current; current = undefined; try { return work(); } finally { current = before; } }
  function effect(work: () => unknown) {
    const reaction: Reaction = { deps: new Set(), stopped: false, run() {
      untracked(() => reaction.dispose?.()); reaction.deps.forEach(deps => deps.delete(reaction)); reaction.deps.clear();
      const before = current; current = reaction;
      try { const dispose = work(); reaction.dispose = typeof dispose === 'function' ? dispose as () => void : undefined; } finally { current = before; }
    } };
    h.stops.push(() => { reaction.stopped = true; pending.delete(reaction); reaction.deps.forEach(deps => deps.delete(reaction)); untracked(() => reaction.dispose?.()); }); reaction.run();
  }
  return { signal, effect, untracked, context: (initial: unknown) => () => initial, lifecycle: () => 'active', cleanup: (work: () => void) => h.cleanups.push(work),
    batch: <T>(work: () => T) => { h.depth++; try { return work(); } finally { h.depth--; flush(); } },
    Storage: { getItem: async () => null, setItem: async () => {} }, host: { available: () => true, call: h.call, on: () => () => {} },
    Text: 'Text', View: 'View', Image: 'Image', Scroll: 'Scroll', openUrl: async () => { throw new Error('Real browser forbidden'); } };
});
const root = path.dirname(fileURLToPath(import.meta.url));
const ticks = async () => { for (let index = 0; index < 100; index++) await Promise.resolve(); };
beforeEach(() => { vi.resetModules(); h.cleanups = []; h.stops = []; h.depth = 0; h.call.mockReset(); });
afterEach(() => { h.stops.forEach(stop => stop()); h.cleanups.forEach(cleanup => cleanup()); });
type Node = { type: string; props: Record<string, unknown>; children: unknown[] };

async function pageFixture(kind: 'github' | 'git-credentials' | 'about') {
  const host = kind === 'about' ? aboutHost() : githubHost();
  let finish!: (value: unknown) => void;
  h.call.mockImplementation((name, input) => name === 'connection.list' ? new Promise(resolve => { finish = resolve; }) : host.call(name, input));
  const state = await import('./state'), runtime = await import('./runtime'), nsh = await import('nsh');
  const { admitSettingsFixture } = await import('./settings-raw-fixture-bootstrap');
  const admission = admitSettingsFixture(); await ticks();
  expect(state.captureHostOperation().current()).toBe(false);
  expect(h.call.mock.calls.map(([name]) => name)).toEqual(['connection.list']);
  finish(host.call('connection.list', {})); await admission;
  h.call.mockImplementation(async (name, input) => host.call(name, input));
  expect(state.captureHostOperation().current()).toBe(true);
  const modules: Record<string, unknown> = { nsh, 'nsh/base': { Button: 'Button' }, './state': state, './runtime': runtime,
    './native-select': { NativeSelect: 'Select' },
    './i18n': { t: (key: string) => key }, './Icon': { Icon: 'Icon' }, './settings-protocol': protocol,
    './settings-github-core': githubCore, './settings-github-protocol': gitProtocol, './settings-git-credentials-core': credentialsCore,
    './settings-about-core': aboutCore, './settings-about-diagnostics': diagnostics, './settings-target': { SettingsTarget: 'Target' },
    './settings-search-core': { createSettingsTargetNavigation: () => ({ onScroll() {}, reveal() {} }) },
  };
  const lazy: ts.TransformerFactory<ts.SourceFile> = context => file => {
    const visit: ts.Visitor = node => {
      if (ts.isJsxAttribute(node) && node.name.getText() === 'of' && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression)
        return ts.factory.updateJsxAttribute(node, node.name, ts.factory.createJsxExpression(undefined, ts.factory.createArrowFunction(undefined, undefined, [], undefined, ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), node.initializer.expression)));
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(file, visit) as ts.SourceFile;
  };
  function evaluate<T>(filename: string): T {
    const exports = {};
    const output = ts.transpileModule(readFileSync(path.join(root, filename), 'utf8'), { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' }, transformers: { before: [lazy] } }).outputText;
    vm.runInNewContext(output, { exports, If: 'If', Each: 'Each', setTimeout, clearTimeout,
      jsx(type: string, props: Node['props'] | null, ...children: unknown[]) { const next = { ...props }; if (typeof next.of === 'function') Object.defineProperty(next, 'of', { get: next.of as () => unknown }); return { type, props: next, children }; },
      require(id: string) { if (!(id in modules)) throw new Error('Unexpected module ' + id); return modules[id]; } });
    return exports as T;
  }
  modules['./desktop-settings-content-core'] = evaluate('desktop-settings-content-core.ts');
  modules['./desktop-settings-publisher'] = evaluate('desktop-settings-publisher.tsx');
  modules['./settings-controls'] = evaluate('settings-controls.tsx');
  const github = evaluate<typeof import('./settings-github')>('settings-github.tsx'); modules['./settings-github'] = github;
  const tree = kind === 'github' ? github.SettingsGitHub({ active: true, open: async url => host.call('github.fixture.open', { url }) })
    : kind === 'about' ? evaluate<typeof import('./settings-about')>('settings-about.tsx').SettingsAbout({ active: true })
    : evaluate<typeof import('./settings-git-credentials')>('settings-git-credentials.tsx').SettingsGitCredentials({ active: true, id: () => 'synthetic-import' });
  const nodes = (value: unknown): Node[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'props' in value ? [value as Node, ...(value as Node).children.flatMap(nodes)] : [];
  return { host, state, nsh, nodes: nodes(tree) };
}

for (const kind of ['github', 'git-credentials', 'about'] as const) {
  it(`${kind}: real root loadConnections adopts strict synthetic scope before actual page GETs; old owner stays retired after A-B-A`, async () => {
    const { host, state, nodes } = await pageFixture(kind); await ticks();
    const requests = h.call.mock.calls.filter(([name]) => name === 'runtime.request').map(([, input]) => input);
    expect(requests.length).toBe(kind === 'about' ? 3 : kind === 'github' ? 1 : 2);
    expect(requests.every(input => input.method === 'GET')).toBe(true);
    for (const input of requests) expect(input.expectedHost).toEqual(state.app.runtimeScope());
    const capture = state.captureHostOperation(), before = state.app.runtimeScope();
    const fixtureName = kind === 'about' ? 'about.fixture.scope' : 'github.fixture.scope';
    host.call(fixtureName, { mode: 'renew' }); await state.loadConnections(); await ticks();
    expect(state.app.runtimeScope()?.hostID).toBe(before?.hostID); expect(state.app.runtimeScope()?.lease).not.toBe(before?.lease);
    expect(capture.current()).toBe(false);
    const renewed = state.captureHostOperation();
    host.call(fixtureName, { mode: 'other' }); await state.loadConnections(); await ticks();
    const auditName = kind === 'about' ? 'about.fixture.audit' : 'github.fixture.audit';
    const count = host.call(auditName, {}).scope.admitted;
    host.call(fixtureName, { mode: 'return' }); await state.loadConnections(); await ticks();
    expect(renewed.current()).toBe(false); expect(state.captureHostOperation().current()).toBe(true);
    const refreshID = kind === 'about' ? 'about-refresh' : kind === 'github' ? 'github-refresh' : 'git-credentials-refresh';
    const refresh = nodes.find(node => node.props.testID === refreshID); expect(refresh).toBeTruthy();
    (refresh!.props.onPress as () => void)();
    // Even an explicit event on this original mounted page cannot use returned authority.
    await ticks(); expect(host.call(auditName, {}).scope.admitted).toBe(count);
  });
}

it('actual discovered Each subscribes to its data signal and displays the asynchronous candidate', async () => {
  const { nodes, nsh } = await pageFixture('git-credentials');
  const each = nodes.find(node => node.type === 'Each'); expect(each).toBeTruthy();
  let observed: unknown[] = [], renders = 0;
  nsh.effect(() => { observed = each!.props.of as unknown[]; renders++; });
  await ticks(); expect(observed).toEqual([{ host: 'git.example', username: 'synthetic' }]); expect(renders).toBeGreaterThan(1);
});

for (const create of [githubHost, aboutHost]) {
  it('strict synthetic forwarding rejects missing/malformed/extra/stale/cross-Host expectedHost without admitting a mutation', () => {
    const host = create(), snapshot = host.call('connection.list', {}), expected = snapshot.runtimeScope;
    const request = { path: snapshot.selected === 'synthetic-about-host' ? '/api/system/info' : '/api/github/auth/status', method: 'GET' };
    for (const input of [request, { ...request, expectedHost: null }, { ...request, expectedHost: { hostID: expected.hostID } },
      { ...request, expectedHost: { ...expected, extra: true } }, { ...request, expectedHost: { ...expected, hostID: 'other' } },
      { ...request, expectedHost: { ...expected, lease: 'stale' } }, { ...request, expectedHost: expected, headers: {} }]) expect(() => host.call('runtime.request', input)).toThrow();
    expect(host.call('runtime.request', { ...request, expectedHost: expected }).status).toBe(200);
    const name = snapshot.selected === 'synthetic-about-host' ? 'about.fixture.scope' : 'github.fixture.scope';
    host.call(name, { mode: 'other' }); host.call(name, { mode: 'return' });
    expect(() => host.call('runtime.request', { ...request, expectedHost: expected })).toThrow('Stale synthetic scope forwarding');
    expect(host.call('connection.list', {}).runtimeScope).not.toEqual(expected);
  });
}
