import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import * as core from './settings-quota-credentials-core';
import * as scopes from './runtime-scope';

const root = path.dirname(fileURLToPath(import.meta.url));
/** Executes the actual production quotaOwner, Settings lifetime and state operation
 * factory with scheduled signals. No NSH engine, JSX renderer or Native authority. */
async function fixture() {
  let observer: (() => void) | null = null;
  const pending = new Set<() => void>(), cleanups: Array<() => void> = [];
  const signal = <T>(initial: T) => {
    let value = initial; const listeners = new Set<() => void>();
    return Object.assign(() => { if (observer) listeners.add(observer); return value; }, { set(next: T) {
      if (Object.is(next, value)) return; value = next;
      for (const listener of listeners) if (!pending.has(listener)) { pending.add(listener); queueMicrotask(() => { pending.delete(listener); listener(); }); }
    } });
  };
  const effect = (work: () => void) => { const run = () => { const previous = observer; observer = run; try { work(); } finally { observer = previous; } }; run(); };
  const untracked = <T>(work: () => T) => { const previous = observer; observer = null; try { return work(); } finally { observer = previous; } };
  const active = signal(true), foreground = signal(true), ready = signal(true), generation = signal(1);
  const connection = signal({ id: 'quota-A', url: 'https://quota.example.invalid', authorizationID: 'synthetic' });
  const runtimeScope = signal<scopes.RuntimeScope | null>({ hostID: 'quota-A', lease: '00000000-0000-4000-8000-000000000001' });
  const calls: Array<{ path: string; method: string; expectedHost?: scopes.RuntimeScope }> = [];
  let configured = false;
  let holdRead: Promise<{ configured: boolean }> | null = null, holdWrite: Promise<{ configured: boolean }> | null = null;
  const native = async (_name: string, input: { path: string; method: string; expectedHost?: scopes.RuntimeScope }) => {
    expect(input.path).toBe('/api/quota/credentials/cursor');
    expect(input.expectedHost).toEqual(runtimeScope()); calls.push(input);
    if (input.method === 'PUT') configured = true;
    return { status: 200, body: await (input.method === 'GET' ? holdRead ?? { configured } : holdWrite ?? { configured }) };
  };
  const ports = { signal, effect, untracked, cleanup: (work: () => void) => cleanups.push(work), lifecycle: () => foreground() ? 'active' : 'background' };
  const modules: Record<string, unknown> = { nsh: { ...ports, host: { available: () => true, call: native } }, 'nsh/base': {}, './model': { record: (value: unknown) => value ?? {} }, './runtime-scope': scopes, './i18n': { t: (key: string) => key }, './settings-protocol': { createSettingsTransaction: () => () => { throw new Error('No Settings transaction expected'); } } };
  // This harness invokes only the Settings operation lifetime, never a Select or its UI.
  modules['./native-select'] = { NativeSelect: () => { throw new Error('Quota recovery must not render a native Select'); } };
  function evaluate<T>(file: string, source = readFileSync(path.join(root, file), 'utf8'), extra = {}): T {
    const output = ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React } }).outputText;
    const exports = {};
    vm.runInNewContext(output, { exports, ...extra, require: (id: string) => { if (!(id in modules)) throw new Error('Unexpected dependency ' + id); return modules[id]; } });
    return exports as T;
  }
  const runtime = evaluate<typeof import('./runtime')>('runtime.ts'); modules['./runtime'] = runtime;
  const stateSyntax = ts.createSourceFile('state.ts', readFileSync(path.join(root, 'state.ts'), 'utf8'), ts.ScriptTarget.ES2023, true);
  const declaration = stateSyntax.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'captureHostOperation')!;
  const stateContext = vm.createContext({ exports: {}, ...scopes, bindRequest: runtime.bindRequest, runtimeReady: ready, switching: false, lifecycle: ports.lifecycle, app: { connection, runtimeScope } });
  Object.defineProperty(stateContext, 'generation', { get: generation });
  vm.runInContext(ts.transpileModule(declaration.getText(stateSyntax), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText, stateContext);
  const captureHostOperation = (stateContext.exports as typeof import('./state')).captureHostOperation;
  modules['./state'] = { app: { connection, runtimeScope }, epoch: generation, captureHostOperation, captureHostRequest: () => runtime.bindRequest(runtimeScope()) };
  const controls = evaluate<typeof import('./settings-controls')>('settings-controls.tsx');
  const quotaSyntax = ts.createSourceFile('settings-quota-credentials.tsx', readFileSync(path.join(root, 'settings-quota-credentials.tsx'), 'utf8'), ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX);
  const owner = quotaSyntax.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'quotaOwner')!;
  type Owner = { controller: ReturnType<typeof core.createQuotaCredentials>; state: () => core.QuotaCredentialsState };
  const quota = evaluate<{ quotaOwner: (props: object, form: boolean) => Owner }>('owner.ts', 'export ' + owner.getText(quotaSyntax), { ...ports, ...core, ...controls, ...runtime, ...(modules['./state'] as object) }).quotaOwner({ providerId: 'cursor', get active() { return active(); } }, true);
  const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
  await flush();
  return { quota, calls, flush,
    read: (value: typeof holdRead) => { holdRead = value; }, write: (value: typeof holdWrite) => { holdWrite = value; },
    cover: async () => { active.set(false); await flush(); }, uncover: async () => { active.set(true); await flush(); },
    suspend: async () => { foreground.set(false); ready.set(false); generation.set(2); runtimeScope.set(null); await flush(); },
    gap: async () => { foreground.set(true); await flush(); },
    resume: async () => { runtimeScope.set({ hostID: 'quota-A', lease: '00000000-0000-4000-8000-000000000002' }); ready.set(true); await flush(); },
    dispose: () => cleanups.forEach(work => work()),
  };
}

it('retained production quota owner reopens only after confirmed same-Host operation recovery, clearing hidden secrets and sending only a fresh-scope GET', async () => {
  const h = await fixture();
  try {
    expect(h.quota.state()).toMatchObject({ open: true, loading: false });
    h.quota.controller.change('accessToken', 'fixture-only-input');
    await h.cover(); await h.uncover();
    expect(h.quota.state()).toMatchObject({ open: true, values: {} });
    await h.suspend(); const before = h.calls.length;
    await h.gap(); expect(h.calls).toHaveLength(before); expect(h.quota.state().open).toBe(false);
    await h.resume();
    expect(h.quota.state()).toMatchObject({ open: true, loading: false, values: {}, status: { configured: false } });
    expect(h.calls.slice(before).map(call => [call.method, call.expectedHost?.lease])).toEqual([['GET', '00000000-0000-4000-8000-000000000002']]);
  } finally { h.dispose(); }
});

it('late old read/finally cannot replace a fresh status or release the replacement read gate', async () => {
  const h = await fixture();
  try {
    let oldResolve!: (value: { configured: boolean }) => void, freshResolve!: (value: { configured: boolean }) => void;
    h.read(new Promise(resolve => { oldResolve = resolve; }));
    const oldRead = h.quota.controller.read(); await h.flush();
    expect(h.quota.state().loading).toBe(true);
    await h.suspend(); await h.gap();
    h.read(new Promise(resolve => { freshResolve = resolve; })); await h.resume();
    const before = h.calls.length;
    oldResolve({ configured: true }); await oldRead; await h.flush();
    expect(h.quota.state()).toMatchObject({ loading: true, status: { configured: false } });
    await h.quota.controller.read(); expect(h.calls).toHaveLength(before);
    freshResolve({ configured: false }); await h.flush();
    expect(h.quota.state()).toMatchObject({ open: true, loading: false, status: { configured: false } });
  } finally { h.dispose(); }
});

it('covering during a status GET cannot strand the public Back destination behind the old pending read', async () => {
  const h = await fixture();
  try {
    let resolve!: (value: { configured: boolean }) => void;
    h.read(new Promise(done => { resolve = done; }));
    const oldRead = h.quota.controller.read(); await h.flush();
    await h.cover(); h.read(null); await h.uncover();
    expect(h.quota.state()).toMatchObject({ open: true, loading: false, values: {}, status: { configured: false } });
    const before = h.calls.length;
    resolve({ configured: true }); await oldRead; await h.flush();
    expect(h.quota.state().status).toEqual({ configured: false });
    expect(h.calls).toHaveLength(before);
  } finally { h.dispose(); }
});

it('in-flight write suspension retains read-required journal; late ACK cannot claim a renewed operation or re-send a credential', async () => {
  const h = await fixture();
  try {
    let resolve!: (value: { configured: boolean }) => void;
    h.write(new Promise(done => { resolve = done; }));
    h.quota.controller.change('accessToken', 'fixture-only-input');
    const oldCurrent = h.quota.controller.captureOperation(), save = h.quota.controller.act('save'); await h.flush();
    await h.suspend(); expect(h.quota.state()).toMatchObject({ recovery: 'read-required', values: {}, open: false });
    await h.gap(); await h.resume();
    expect(h.quota.state()).toMatchObject({ recovery: 'review', status: { configured: true }, values: {}, open: true });
    resolve({ configured: true }); await save; await h.flush();
    expect(oldCurrent()).toBe(false);
    expect(h.quota.state()).toMatchObject({ recovery: 'review', notice: null, status: { configured: true } });
    expect(h.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
  } finally { h.dispose(); }
});

it('operation-only replacement keeps an acknowledged receipt and verified result; explicit visibility retirement alone clears secret drafts', async () => {
  let sends = 0;
  const lane = () => ({ current: () => true, send: async (_path: string, method = 'GET') => { sends++; return method === 'POST' ? { valid: true } : { configured: true }; } });
  const first = lane(), owner = core.createQuotaCredentials({ providerId: 'cursor', ...first });
  owner.setActive(true); await owner.read(); owner.open(); owner.change('accessToken', 'fixture-only-input');
  await owner.act('validate'); owner.replaceOperation(lane());
  expect(owner.state()).toMatchObject({ values: { accessToken: 'fixture-only-input' }, notice: 'validate' });
  owner.setActive(false); owner.replaceOperation(null); owner.replaceOperation(lane()); owner.setActive(true);
  await owner.read(); owner.open();
  expect(owner.state()).toMatchObject({ values: {}, notice: 'validate', status: { configured: true } });
  owner.change('accessToken', 'fixture-only-input'); await owner.act('save');
  const before = sends; owner.replaceOperation(null); owner.replaceOperation(lane());
  expect(owner.state()).toMatchObject({ notice: 'save', open: false, values: {}, status: { configured: true } });
  expect(sends).toBe(before); owner.dispose();
});
