import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import * as scopeCore from './runtime-scope';
import * as protocol from './settings-protocol';
import * as githubCore from './settings-github-core';
import * as gitProtocol from './settings-github-protocol';
import * as credentialsCore from './settings-git-credentials-core';
import * as aboutCore from './settings-about-core';
import * as diagnostics from './settings-about-diagnostics';
import * as model from './model';
import { nativeLayoutDensity } from './native-density';

const root = path.dirname(fileURLToPath(import.meta.url));
const flush = async () => { for (let index = 0; index < 150; index++) await Promise.resolve(); };
type Node = { props: Record<string, unknown>; children: unknown[] };

/** Actual page/lifetime/raw binder/state factory with inert JSX and strict synthetic
 * Native ports. No NSH engine, network, Keychain, UIKit or real OAuth is invoked. */
function fixture(page: 'github' | 'git-credentials' | 'about') {
  let observer: (() => void) | null = null;
  const pending = new Set<() => void>();
  const sources: Array<() => unknown> = [];
  const signal = <T>(initial: T) => {
    let value = initial; const subscribers = new Set<() => void>();
    const source = Object.assign(() => { if (observer) subscribers.add(observer); return value; }, {
      set(next: T) { if (Object.is(next, value)) return; value = next; for (const run of subscribers) { if (pending.has(run)) continue; pending.add(run); queueMicrotask(() => { pending.delete(run); run(); }); } },
    });
    sources.push(source); return source;
  };
  const effect = (work: () => void) => {
    let dispose: (() => void) | undefined;
    const run = () => { dispose?.(); const previous = observer; observer = run; try { dispose = work() as unknown as (() => void) | undefined; } finally { observer = previous; } };
    run();
  };
  const untracked = <T>(work: () => T) => { const previous = observer; observer = null; try { return work(); } finally { observer = previous; } };
  const cleanup: Array<() => void> = [];
  const foreground = signal(true), ready = signal(true), generation = signal(1), active = signal(true);
  const connection = signal({ id: 'synthetic-A', url: 'https://synthetic.invalid', authorizationID: 'synthetic-auth' });
  const scope = signal<scopeCore.RuntimeScope | null>({ hostID: 'synthetic-A', lease: 'synthetic-lease' });
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  let response: ((path: string, method: string) => Promise<unknown>) | null = null;
  let diagnosticEnabled = false, appendWait: Promise<unknown> | null = null;
  const native = async (name: string, input: Record<string, unknown> = {}): Promise<unknown> => {
    calls.push({ name, input });
    if (name === 'runtime.request') {
      expect(Object.keys(input).sort()).toEqual(['expectedHost', 'method', 'path', ...(input.body === undefined ? [] : ['body'])].sort());
      expect(input.expectedHost).toEqual(scope());
      if (response) return response(String(input.path), String(input.method));
      const body = input.path === '/api/github/auth/status' ? { connected: false, accounts: [] }
        : ['/api/git/discover-credentials', '/api/git/identities'].includes(String(input.path)) ? []
        : input.path === '/api/system/info' ? { yuriVersion: '2.3.0' }
        : input.path === '/api/opencode/upgrade-status' ? { serveVersion: '2.3.0' }
        : input.path === '/api/system/update' ? { supported: false, host: 'cli', serverId: 'synthetic-server', currentVersion: '2.3.0', available: false, checkError: null, update: null, operation: null }
        : (() => { throw new Error('Unexpected request ' + input.path); })();
      return { status: 200, body };
    }
    if (name === 'native.clientMetadata') return { schemaVersion: 1, version: '2.3.0', build: '1', updates: { status: 'unsupported' } };
    if (name === 'native.diagnostics.status') return { schemaVersion: 2, mode: 'event-recorder', enabled: diagnosticEnabled, recordingLease: diagnosticEnabled ? 'synthetic-recorder' : null };
    if (name === 'native.diagnostics.setEnabled') {
      expect(Object.keys(input)).toEqual(['enabled']); expect(typeof input.enabled).toBe('boolean'); diagnosticEnabled = input.enabled as boolean;
      return { schemaVersion: 2, mode: 'event-recorder', enabled: diagnosticEnabled, recordingLease: diagnosticEnabled ? 'synthetic-recorder' : null };
    }
    if (name === 'native.diagnostics.append') {
      expect(Object.keys(input).sort()).toEqual(['hostID', 'lease', 'events', 'dropped'].sort());
      expect(input.hostID).toBe('synthetic-A'); expect(input.lease).toBe('synthetic-recorder');
      return appendWait ? await appendWait : { accepted: true };
    }
    if (name === 'native.diagnostics.export') return { outcome: 'shared', eventCount: 1 };
    throw new Error('Unexpected Native ' + name);
  };
  const openUrl = vi.fn(async () => ({ opened: true }));
  const answer = vi.fn(async (): Promise<{ action: string }> => ({ action: 'cancel' }));
  const modules: Record<string, unknown> = {
    './appearance': { nativeDensity: () => nativeLayoutDensity() },
    nsh: { signal, effect, untracked, cleanup: (work: () => void) => cleanup.push(work), lifecycle: () => foreground() ? 'active' : 'inactive', host: { available: () => true, call: native }, openUrl, Scroll: 'Scroll', Text: 'Text', View: 'View', Image: 'Image' },
    'nsh/base': { ...Object.fromEntries(['Button', 'Input', 'Select', 'Switch', 'Progress'].map(key => [key, key])), AlertDialog: { show: answer } },
    './native-select': { NativeSelect: 'NativeSelect' },
    './i18n': { t: (key: string) => key }, './Icon': { Icon: 'Icon' }, './settings-protocol': protocol,
    './runtime-scope': scopeCore, './model': model, './settings-github-core': githubCore, './settings-github-protocol': gitProtocol,
    './settings-git-credentials-core': credentialsCore, './settings-about-core': aboutCore, './settings-about-diagnostics': diagnostics,
    './settings-target': { SettingsTarget: 'SettingsTarget' }, './settings-search-core': { createSettingsTargetNavigation: () => ({ reveal() {}, onScroll() {} }) },
  };
  function evaluate<T>(filename: string): T {
    const exports = {};
    const output = ts.transpileModule(readFileSync(path.join(root, filename), 'utf8'), { fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' } }).outputText;
    vm.runInNewContext(output, { exports, jsx: (_type: unknown, props: Node['props'], ...children: unknown[]) => ({ props: props ?? {}, children }), If: 'If', Each: 'Each',
      setTimeout, clearTimeout, require: (id: string) => { if (!(id in modules)) throw new Error('Unexpected module ' + id); return modules[id]; } });
    return exports as T;
  }
  const runtime = evaluate<typeof import('./runtime')>('runtime.ts'); modules['./runtime'] = runtime;
  const syntax = ts.createSourceFile('state.ts', readFileSync(path.join(root, 'state.ts'), 'utf8'), ts.ScriptTarget.ES2023, true);
  const declaration = syntax.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'captureHostOperation');
  if (!declaration) throw new Error('Missing production captureHostOperation');
  const exports: { captureHostOperation?: typeof import('./state').captureHostOperation } = {};
  const context = vm.createContext({ exports, ...scopeCore, bindRequest: runtime.bindRequest, runtimeReady: ready, switching: false,
    lifecycle: () => foreground() ? 'active' : 'inactive', app: { connection, runtimeScope: scope } });
  Object.defineProperty(context, 'generation', { get: generation });
  vm.runInContext(ts.transpileModule(declaration.getText(syntax), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText, context);
  modules['./state'] = { captureHostOperation: exports.captureHostOperation, captureHostRequest: () => runtime.bindRequest(scope()), epoch: generation, app: { connection, runtimeScope: scope } };
  modules['./settings-controls'] = evaluate('settings-controls.tsx');
  const github = evaluate<typeof import('./settings-github')>('settings-github.tsx'); modules['./settings-github'] = github;
  const props = { get active() { return active(); } };
  const tree = page === 'github' ? github.SettingsGitHub(props)
    : page === 'git-credentials' ? evaluate<typeof import('./settings-git-credentials')>('settings-git-credentials.tsx').SettingsGitCredentials(props)
    : evaluate<typeof import('./settings-about')>('settings-about.tsx').SettingsAbout(props);
  const nodes = (value: unknown): Node[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'props' in value
    ? [value as Node, ...(value as Node).children.flatMap(nodes)] : [];
  const captured = exports.captureHostOperation!();
  const rawRequest = github.gitSettingsNativeRequest(captured.current, captured.scope);
  return { calls, scope, generation, connection, foreground, ready, active, openUrl, rawRequest, answer, native,
    setAppendWait: (next: Promise<unknown>) => { appendWait = next; },
    setResponse: (next: typeof response) => { response = next; },
    press(id: string) { const node = nodes(tree).find(item => item.props.testID === id); if (!node) throw new Error('Missing action ' + id); (node.props.onPress as () => void)(); },
    change(id: string, value: boolean) { const node = nodes(tree).find(item => item.props.testID === id); if (!node) throw new Error('Missing control ' + id); (node.props.onChange as (value: boolean) => void)(value); },
    state: () => sources.map(source => source()).find(value => value && typeof value === 'object' && (page === 'github' ? 'needsReadback' in value : page === 'git-credentials' ? 'credentials' in value : 'hostUpdate' in value)),
    suspend() { foreground.set(false); ready.set(false); generation.set(generation() + 1); scope.set(null); },
    resume() { foreground.set(true); ready.set(true); scope.set({ hostID: 'synthetic-A', lease: 'synthetic-lease' }); },
    dispose() { cleanup.forEach(work => work()); },
  };
}

for (const page of ['github', 'git-credentials', 'about'] as const) {
  it(`${page}: actual mounted page resumes only after confirmed snapshot, including repeated lease; A-B-A remains retired`, async () => {
    const f = fixture(page); await flush(); const state = f.state(); expect(state).toBeTruthy();
    f.calls.length = 0; f.suspend(); await flush(); f.foreground.set(true); await flush(); expect(f.calls).toHaveLength(0);
    f.resume(); await flush(); expect(f.calls.some(call => call.name === 'runtime.request')).toBe(true);
    expect(f.calls.filter(call => call.name === 'runtime.request').every(call => call.input.method === 'GET')).toBe(true);
    const reads = f.calls.length;
    f.connection.set({ id: 'synthetic-B', url: 'https://other.invalid', authorizationID: 'synthetic-B-auth' }); await flush();
    f.connection.set({ id: 'synthetic-A', url: 'https://synthetic.invalid', authorizationID: 'synthetic-auth' }); f.generation.set(f.generation() + 1); await flush();
    f.press(page === 'github' ? 'github-refresh' : page === 'git-credentials' ? 'git-credentials-refresh' : 'about-refresh'); await flush();
    expect(f.calls).toHaveLength(reads); f.dispose();
  });
}

it('actual raw GitHub parser retains an HTTP error body for exact-removal rejection', async () => {
  const f = fixture('github'); await flush();
  f.setResponse(async () => ({ status: 409, body: { code: 'github_account_changed' } }));
  await expect(f.rawRequest('/api/github/auth', 'DELETE', {})).rejects.toMatchObject({ code: 'github_account_changed', status: 409 });
  f.press('github-refresh'); await flush(); expect(f.state()).toMatchObject({ issue: 'read', status: { connected: false } }); f.dispose();
});

it('actual retired raw sender cannot dispatch on a repeated lease', async () => {
  const f = fixture('github'); await flush(); f.suspend(); await flush(); f.resume(); await flush();
  const count = f.calls.length;
  await expect(f.rawRequest('/api/github/auth', 'DELETE', {})).rejects.toThrow();
  expect(f.calls).toHaveLength(count); f.dispose();
});

it('actual page old raw response cannot adopt data or release the foreground read flight', async () => {
  const f = fixture('github'); await flush();
  let oldResolve!: (value: unknown) => void, nextResolve!: (value: unknown) => void;
  f.setResponse(() => new Promise(resolve => { oldResolve = resolve; })); f.press('github-refresh'); await flush();
  f.suspend(); await flush(); f.setResponse(() => new Promise(resolve => { nextResolve = resolve; })); f.resume(); await flush();
  oldResolve({ status: 200, body: { connected: true, accounts: [] } }); await flush();
  expect(f.state()).toMatchObject({ refreshing: true, status: { connected: false } });
  nextResolve({ status: 200, body: { connected: false, accounts: [] } }); await flush();
  expect(f.state()).toMatchObject({ refreshing: false, status: { connected: false } }); f.dispose();
});

it('cover and return with the same Host operation still retire the old controller flight', async () => {
  const f = fixture('github'); await flush();
  let finish!: (value: unknown) => void;
  f.setResponse(() => new Promise(resolve => { finish = resolve; })); f.press('github-refresh'); await flush();
  f.active.set(false); await flush(); f.setResponse(null); f.active.set(true); await flush();
  const adopted = f.state(); finish({ status: 200, body: { connected: true, accounts: [] } }); await flush();
  expect(f.state()).toBe(adopted); expect(f.state()).toMatchObject({ refreshing: false, status: { connected: false } }); f.dispose();
});

it('actual delayed OAuth start cannot open a browser or cancel through the resumed sender', async () => {
  const f = fixture('github'); await flush();
  let finish!: (value: unknown) => void;
  f.setResponse(() => new Promise(resolve => { finish = resolve; })); f.press('github-connect'); await flush();
  expect(f.state()).toMatchObject({ busy: true, pending: { kind: 'connect' } });
  f.suspend(); await flush(); f.setResponse(null); f.resume(); await flush();
  const adopted = f.state(), count = f.calls.length;
  finish({ status: 200, body: { deviceCode: 'synthetic-secret', userCode: 'SYNTHETIC', verificationUri: 'https://github.com/login/device', expiresIn: 60, interval: 10, cancellable: true } }); await flush();
  expect(f.state()).toBe(adopted); expect(f.calls).toHaveLength(count); expect(f.openUrl).not.toHaveBeenCalled();
  expect(f.calls.filter(call => call.input.method === 'POST').map(call => call.input.path)).toEqual(['/api/github/auth/start']); f.dispose();
});

for (const action of ['confirm', 'cancel']) {
  it(`About delayed ${action} dialog answer cannot consume a replacement lane's new confirmation`, async () => {
    const f = fixture('about'); await flush();
    const plan = { version: '2.4.0', kind: 'cli-package', planId: 'synthetic-plan', rollback: false, restartRequired: true };
    const update = { supported: true, host: 'cli', serverId: 'synthetic-server', channel: 'stable', currentVersion: '2.3.0', available: true, checkError: null, update: plan, operation: null };
    f.setResponse(async path => ({ status: 200, body: path === '/api/system/update' ? update : path === '/api/system/info' ? { yuriVersion: '2.3.0' } : { serveVersion: '2.1.7' } }));
    f.press('about-host-check'); await flush();
    let finish!: (value: { action: string }) => void;
    f.answer.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockImplementationOnce(() => new Promise(() => {}));
    f.press('about-host-update'); await flush(); expect(f.answer).toHaveBeenCalledTimes(1);
    f.suspend(); await flush(); f.resume(); await flush(); f.press('about-host-update'); await flush();
    expect(f.answer).toHaveBeenCalledTimes(2); expect(f.state()).toMatchObject({ updateConfirm: { plan } });
    const adopted = f.state(), count = f.calls.length;
    finish({ action }); await flush();
    expect(f.state()).toBe(adopted); expect(f.calls).toHaveLength(count);
    expect(f.calls.filter(call => call.input.method === 'POST')).toEqual([]); f.dispose();
  });
}

it('About export waiting on actual root flush cannot dispatch Native export after lane replacement', async () => {
  const f = fixture('about'); await flush();
  const scope = () => f.scope() ? { hostID: f.scope()!.hostID, generation: f.generation() } : null;
  const root = diagnostics.createAboutDiagnosticsRoot({ call: f.native, scope });
  try {
    await root.refresh(); f.change('about-diagnostics-toggle', true); await flush();
    expect(f.state()).toMatchObject({ diagnostics: { value: { enabled: true } } });
    let finish!: (value: unknown) => void;
    f.setAppendWait(new Promise(resolve => { finish = resolve; }));
    root.onEvent({ key: 'global', type: 'session.status', body: { sessionID: 'synthetic-session' } }, scope()!);
    const flushing = root.flush(); await flush();
    expect(f.calls.filter(call => call.name === 'native.diagnostics.append')).toHaveLength(1);
    f.press('about-export'); await flush(); expect(f.state()).toMatchObject({ exporting: true });
    f.suspend(); await flush(); f.resume(); await flush(); const adopted = f.state();
    expect(adopted).toMatchObject({ exporting: false }); finish({ accepted: true }); await flushing; await flush();
    expect(f.calls.filter(call => call.name === 'native.diagnostics.export')).toEqual([]);
    expect(f.state()).toBe(adopted);
  } finally { root.dispose(); f.dispose(); }
});
