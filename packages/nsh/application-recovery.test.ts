import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as model from './model';
import * as historyBackup from './transcript-actions-backup';
import { createTranscriptActions, nativeRevertFrom } from './transcript-actions-core';
import { inNativeSessionActionStorageLane } from './transcript-actions-storage';
import { createProjectsDeletes } from './projects-delete';
import { createProjectsAttention } from './projects-attention';
import { createNativeHistoryFooterController } from './history-footer-controller';
import { createChatChromeState, createNativeChatChrome } from './chat-chrome';
import { resourcePath, resourceWithin } from './resources-model';
import { createNativeHistoryScroll } from './history-scroll';
import { createDeviceChatPreferences } from './settings-preferences-device-core';
import { createSpeechController } from './speech-core';
import * as projectsSidebar from './projects-sidebar';
import { desktopGitDraftAuthority } from './desktop-git-dispatch';
import { createNativeDesktopComposerShortcutOwner } from './desktop-composer-actions';
import { createDesktopAttachments } from './desktop-attachments';
import { desktopAttachmentRecovery } from './desktop-attachments-recovery';
import { createAttachmentPick } from './attachment-pick';
import { attachmentFrom } from './attachments';
import { sameRuntimeScope } from './runtime-scope';
import { projectHomeDensityGeometry } from './projects-presentation';
import { createChatComposerCommands } from './chat-composer-commands';
import { createBtwGenerate, createBtwOwner } from './chat-btw-model';

const root = path.dirname(fileURLToPath(import.meta.url));
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = <T>() => { let resolve!: (next: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

describe('resource navigation retains only the explicit owning session', () => {
  function openFrom(source: unknown, directory = '/project', file = 'report.eficy') {
    const pushed: unknown[] = [];
    const open = production('application.tsx', 'openResourceFile', { nav: { routes: () => [source], push: (route: unknown) => pushed.push(route) }, resourcePath, resourceWithin, t: (key: string) => key });
    open(file, directory, 12);
    return pushed[0];
  }
  it('carries the actual session through a file preview and preserves the source line', () => {
    const first = openFrom({ kind: 'chat', target: { kind: 'session', id: 'session-a', directory: '/project' } });
    expect(first).toMatchObject({ sessionId: 'session-a', directory: '/project', path: '/project/report.eficy', targetLine: 12 });
    expect(openFrom(first)).toMatchObject({ sessionId: 'session-a' });
    expect(openFrom({ kind: 'files', directory: '/project', sessionId: 'session-a' })).toMatchObject({ sessionId: 'session-a' });
  });
  it('does not invent a session for project files, contacts, or another directory', () => {
    for (const source of [{ kind: 'project' }, { kind: 'chat', target: { kind: 'contact', id: 'bot-a', directory: '/project' } },
      { kind: 'chat', target: { kind: 'session', id: 'session-b', directory: '/other' } }, { kind: 'files', directory: '/other', sessionId: 'session-b' }]) {
      expect(openFrom(source)).not.toHaveProperty('sessionId');
    }
  });
  it('rejects a file outside the captured directory before navigating', () => {
    expect(() => openFrom({ kind: 'project' }, '/project', '../other/report.eficy')).toThrow();
  });
});

/** Executes production owner code; only its final JSX return becomes observations. */
function production(file: string, name: string, ports: Record<string, unknown>, observations?: string) {
  const source = ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
  const body = observations ? declaration.body!.statements.filter(node => !ts.isReturnStatement(node)).map(node => node.getText(source)).join('\n') + `; return { ${observations} };` : declaration.body!.statements.map(node => node.getText(source)).join('\n');
  const output = ts.transpileModule(`function ${name}(${declaration.parameters.map(node => node.getText(source)).join(', ')}) { ${body} }`, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText;
  return new Function(...Object.keys(ports), `${output}; return ${name};`)(...Object.values(ports));
}

function signals() {
  type Reaction = { run: () => void; dependencies: Set<Set<Reaction>>; stop?: () => void; disposed: boolean };
  let tracking: Reaction | undefined, depth = 0, flushing = false;
  const queue = new Set<Reaction>(), disposers: Array<() => void> = [], cleanups: Array<() => void> = [];
  const flush = () => { if (depth || flushing) return; flushing = true; let turns = 0; try { while (queue.size) { if (++turns > 1000) throw new Error('reaction loop'); const reaction = queue.values().next().value!; queue.delete(reaction); if (!reaction.disposed) reaction.run(); } } finally { flushing = false; } };
  const untracked = <T>(work: () => T) => { const before = tracking; tracking = undefined; try { return work(); } finally { tracking = before; } };
  function signal<T>(initial: T) {
    let value = initial; const dependencies = new Set<Reaction>();
    const read = () => { if (tracking) { dependencies.add(tracking); tracking.dependencies.add(dependencies); } return value; };
    const set = (next: T) => { if (Object.is(next, value)) return; value = next; for (const reaction of dependencies) queue.add(reaction); flush(); };
    return Object.assign(read, { set, update: (work: (value: T) => T) => set(work(value)) });
  }
  function effect(work: () => unknown) {
    const reaction: Reaction = { dependencies: new Set(), disposed: false, run() {
      untracked(() => reaction.stop?.()); reaction.stop = undefined;
      reaction.dependencies.forEach(dependencies => dependencies.delete(reaction)); reaction.dependencies.clear();
      const before = tracking; tracking = reaction;
      try { const result = work(); if (typeof result === 'function') reaction.stop = result as () => void; } finally { tracking = before; }
    } };
    disposers.push(() => { reaction.disposed = true; reaction.dependencies.forEach(dependencies => dependencies.delete(reaction)); reaction.stop?.(); }); reaction.run();
  }
  const batch = <T>(work: () => T) => { depth++; try { return work(); } finally { depth--; flush(); } };
  const computed = <T>(work: () => T) => { const value = signal<T>(undefined as T); effect(() => value.set(work())); return value; };
  return { signal, computed, effect, untracked, batch, cleanup: (work: () => void) => cleanups.push(work), dispose() { disposers.forEach(work => work()); cleanups.reverse().forEach(work => work()); } };
}

function harness() {
  const reactive = signals(), { signal, batch } = reactive;
  const lifecycle = signal('active'), generation = signal(1), ready = signal(true);
  const connection = signal({ id: 'A', url: 'https://a.example', authorizationID: 'authorized-a' });
  const runtimeScope = signal<{ hostID: string; lease: string } | null>({ hostID: 'A', lease: 'lease-a' });
  const app = { connection, runtimeScope, sessions: signal<model.Session[]>([]), projects: signal<model.Project[]>([]), bots: signal<model.Row[]>([]), tasks: signal<model.Row[]>([]), tab: signal(0) };
  const accepted: Array<{ path: string; method: string; generation: number; lease?: string }> = [];
  const rejected: number[] = [];
  let response: (path: string, method: string, body?: unknown) => unknown = () => ({});
  const captureHostOperation = vi.fn(() => {
    const epoch = generation(), scope = runtimeScope(), host = connection(), admitted = ready() && lifecycle() === 'active';
    const current = () => admitted && ready() && lifecycle() === 'active' && generation() === epoch && scope === runtimeScope() && host === connection();
    return Object.freeze({ scope, generation: epoch, current, request: async (path: string, method = 'GET', body?: unknown) => {
      if (!current() || method !== 'GET' && !scope) { rejected.push(epoch); throw new Error('host_operation_stale'); }
      accepted.push({ path, method, generation: epoch, lease: scope?.lease });
      const result = await response(path, method, body);
      if (!current()) { rejected.push(epoch); throw new Error('host_operation_stale'); }
      return result;
    } });
  });
  const captureHostRequest = () => captureHostOperation().request;
  const ports = { ...reactive, app, lifecycle, epoch: generation, captureHostOperation, captureHostRequest };
  const createPageOperations = production('page-operations.ts', 'createPageOperations', ports);
  return { ...ports, createPageOperations, ready, accepted, rejected,
    respond(work: typeof response) { response = work; },
    background() { batch(() => { ready.set(false); generation.set(generation() + 1); runtimeScope.set(null); lifecycle.set('background'); }); },
    foreground() { lifecycle.set('active'); },
    confirm(legacy = false) { batch(() => { runtimeScope.set(legacy ? null : { hostID: connection().id, lease: 'lease-a' }); ready.set(true); }); },
    switchHost(id: string) { batch(() => { generation.set(generation() + 1); connection.set({ id, url: `https://${id.toLowerCase()}.example`, authorizationID: `authorized-${id.toLowerCase()}` }); runtimeScope.set({ hostID: id, lease: `lease-${id.toLowerCase()}` }); ready.set(true); }); },
  };
}
const disposers: Array<() => void> = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.useRealTimers(); });
function setup() { const h = harness(); disposers.push(h.dispose); return h; }

describe('collection route and native Back assembly', () => {
  it('replaces the explicit directory, including Global, while retaining the route owner', () => {
    const tourOwner = {}, initial = { kind: 'settings', route: { page: 'agents', directory: '/old' }, tourOwner };
    const routes = [initial], replace = vi.fn();
    const navigate = production('application.tsx', 'replaceCollectionDirectory', { nav: { routes: () => routes, replace } });
    navigate(undefined, { page: 'agents', directory: '/old' });
    expect(replace).toHaveBeenLastCalledWith({ ...initial, route: { page: 'agents', directory: undefined } });
    navigate('/explicit', { page: 'agents' });
    expect(replace).toHaveBeenLastCalledWith({ ...initial, route: { page: 'agents', directory: '/explicit' } });
    navigate('/wrong-page', { page: 'commands' });
    expect(replace).toHaveBeenCalledTimes(2);
  });

  it('an old mounted page cannot replace a newer collection directory', () => {
    const h = setup(), route = { kind: 'settings', route: { page: 'agents', directory: '/old' } };
    const routes = h.signal([route]), replace = vi.fn();
    const page = production('application.tsx', 'SettingsOperationPage', {
      createPageOperations: h.createPageOperations, nav: { routes }, settingsCallbacks: {},
      retentionController: () => undefined, replaceCollectionDirectory: replace,
      React: { createElement: (_type: unknown, props: Record<string, unknown>) => props }, SettingsPage: 'SettingsPage',
    })({ route });
    page.onCollectionDirectory(undefined, { page: 'agents' });
    expect(replace).toHaveBeenCalledTimes(1);
    routes.set([{ kind: 'settings', route: { page: 'agents', directory: '/new' } }]);
    page.onCollectionDirectory('/late', { page: 'agents' });
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('forwards the full copy draft and delegates dirty Back to the collection owner', () => {
    const reactive = signals(); disposers.push(reactive.dispose);
    type Element = { type: string; props: Record<string, any>; children: Element[] };
    const leafNames = ['NavPage', 'If', 'SettingsProjectsPage', 'SettingsPreferences', 'SettingsGit', 'SettingsUsage', 'SettingsAbout', 'SettingsArchive', 'SettingsMagicPrompts', 'SettingsCollection', 'SettingsBasics'];
    const component = production('settings.tsx', 'SettingsPage', {
      signal: reactive.signal, SETTINGS_ENTRIES: [{ page: 'commands', title: 'commands-title' }], t: (key: string) => key,
      ...Object.fromEntries(leafNames.map(name => [name, name])),
      React: { createElement: (type: string, props: Record<string, unknown>, ...children: Element[]) => ({ type, props, children }) },
    });
    const collectionDraft = { editor: { name: 'copy' }, config: { template: '// original source', metadata: { keep: true } } };
    const forwarded = vi.fn(), tree: Element = component({ page: 'commands', create: true, collectionDraft, onCollectionNavigation: forwarded });
    const flatten = (node: Element): Element[] => [node, ...node.children.flatMap(flatten)];
    const collection = flatten(tree).find(node => node.type === 'SettingsCollection')!;
    expect(collection.props.collectionDraft).toBe(collectionDraft);
    expect(tree.props.popOnBack).toBe(true); expect(tree.props.popOnSwipe).toBe(true);
    const back = vi.fn(), navigation = { blocked: true, back };
    collection.props.onCollectionNavigation(navigation); tree.props.onBackPress();
    expect(forwarded).toHaveBeenCalledWith(navigation); expect(back).toHaveBeenCalledTimes(1);
    collection.props.onCollectionNavigation({ blocked: false, back }); tree.props.onBackPress();
    expect(back).toHaveBeenCalledTimes(1);
  });
});

describe('device Chat preference root authority', () => {
  it('loads independently of Host state, preserves prior on failure and retries only device Storage', async () => {
    const h = setup();
    let fail = false, raw: string | null = JSON.stringify({ collapsibleUserMessages: false });
    const get = vi.fn(async () => { if (fail) throw new Error('private storage error'); return raw; });
    const changed = vi.fn(), set = vi.fn(async () => undefined);
    const store = createDeviceChatPreferences({ get, set, changed });
    const rootOwner = production('device-chat-preferences-root.tsx', 'NativeDeviceChatPreferences', {
      signal: h.signal, cleanup: h.cleanup, deviceChatPreferenceStore: store,
    }, 'failed, loading, load')();
    await flush();
    expect(get).toHaveBeenCalledTimes(1); expect(store.snapshot()?.collapsibleUserMessages).toBe(false);
    const prior = store.snapshot(); fail = true;
    await rootOwner.load();
    expect(rootOwner.failed()).toBe(true); expect(store.snapshot()).toBe(prior);
    fail = false; raw = JSON.stringify({ collapsibleUserMessages: true });
    await rootOwner.load();
    expect(rootOwner.failed()).toBe(false); expect(rootOwner.loading()).toBe(false);
    expect(store.snapshot()?.collapsibleUserMessages).toBe(true);
    expect(set).not.toHaveBeenCalled();
  });

  it('does not queue duplicate initial reads or retry after root disposal', async () => {
    const h = setup(), read = deferred<void>(), load = vi.fn(() => read.promise);
    const rootOwner = production('device-chat-preferences-root.tsx', 'NativeDeviceChatPreferences', {
      signal: h.signal, cleanup: h.cleanup, deviceChatPreferenceStore: { load },
    }, 'failed, loading, load')();
    await rootOwner.load(); expect(load).toHaveBeenCalledTimes(1);
    h.dispose(); read.resolve(); await flush();
    await rootOwner.load(); expect(load).toHaveBeenCalledTimes(1);
    expect(rootOwner.failed()).toBe(false);
  });
});

describe('application stable display and replaceable operation owners (no engine/network)', () => {
  it.each([false, true])('pageScope preserves display through same-Host readiness gap, legacy=%s; old callbacks stay retired with a repeated lease', async legacy => {
    const h = setup();
    const pageScope = production('application.tsx', 'pageScope', h);
    const displayed = pageScope(), owner = h.createPageOperations(), old = owner.capture();
    h.background(); expect(displayed()).toBe(true); expect(owner.operation()).toBeNull();
    h.foreground(); expect(displayed()).toBe(true); expect(owner.operation()).toBeNull();
    const gap = h.captureHostOperation(); expect(gap.current()).toBe(false);
    h.confirm(legacy); const resumed = owner.capture();
    expect(displayed()).toBe(true); expect(resumed).not.toBe(old); expect(old.current()).toBe(false); expect(gap.current()).toBe(false);
    await expect(old.request('/mutation', 'POST')).rejects.toThrow('stale');
    expect(h.accepted).toEqual([]);
    await resumed.request('/read'); expect(h.accepted.at(-1)?.generation).toBe(2);
    if (legacy) await expect(resumed.request('/mutation', 'POST')).rejects.toThrow('stale');
    h.switchHost('B'); h.switchHost('A'); expect(displayed()).toBe(false); expect(owner.operation()).toBeNull();
  });

  it('an old admitted request cannot clear or overwrite the foreground lane after its await', async () => {
    const h = setup(), owner = h.createPageOperations(), gate = deferred<unknown>(); h.respond(() => gate.promise);
    const old = owner.capture(), flight = old.request('/read');
    h.background(); h.foreground(); h.confirm(); const fresh = owner.capture();
    gate.resolve({ old: true }); await expect(flight).rejects.toThrow('stale');
    expect(owner.operation()).toBe(fresh); expect(fresh.current()).toBe(true);
  });

  it('actual quota route active expression survives foreground epoch changes and keeps its original directory', () => {
    const h = setup(), route = { kind: 'settings-quota', provider: 'openai', providerName: 'Provider', hostID: 'A', generation: 1, directory: '/second/.worktrees/topic' };
    const nav = { routes: h.signal([route]) };
    const pageScope = production('application.tsx', 'pageScope', h);
    const make = production('application.tsx', 'SettingsQuotaOperationPage', { ...h, pageScope }, 'current, route');
    const mounted = make({ route });
    const syntax = ts.createSourceFile('application.tsx', readFileSync(path.join(root, 'application.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declaration = syntax.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'SettingsQuotaOperationPage')!;
    const expression = declaration.body!.statements.find(ts.isReturnStatement)!.expression as ts.JsxSelfClosingElement;
    const attribute = expression.attributes.properties.find((node): node is ts.JsxAttribute => ts.isJsxAttribute(node) && node.name.getText(syntax) === 'active')!;
    const activeSource = (attribute.initializer as ts.JsxExpression).expression!.getText(syntax);
    const active = new Function('current', 'nav', 'app', 'route', `return () => (${activeSource});`)(mounted.current, nav, h.app, route);
    const visibility: boolean[] = []; h.effect(() => { visibility.push(active()); });
    expect(active()).toBe(true); h.background(); h.foreground(); h.confirm();
    expect(h.epoch()).toBe(2); expect(active()).toBe(true); expect(mounted.route).toBe(route); expect(mounted.route.directory).toBe('/second/.worktrees/topic');
    h.switchHost('B'); h.switchHost('A'); expect(active()).toBe(false); expect(visibility.at(-1)).toBe(false);
  });

  it('real Projects controller retains its loaded bucket and rejects rename continuation, then accepts a fresh action', async () => {
    const h = setup();
    const ports: Record<string, unknown> = { nsh: { ...h, host: { on: () => () => {} } }, 'nsh/base': {}, './state': h, './page-operations': h,
      './model': model, './runtime': { query: (directory: string) => `directory=${encodeURIComponent(directory)}`, sessionPath: (id: string, suffix: string) => `/api/session/${id}/${suffix}` },
      './i18n': { t: (key: string) => key }, './projects-delete': { createProjectsDeletes }, './projects-attention': { projectsAttention: createProjectsAttention() }, './projects-sidebar': projectsSidebar };
      './appearance': { nativeAppearance: { current: () => null } }, './projects-presentation': { projectHomeDensityGeometry } };
    const source = ts.transpileModule(readFileSync(path.join(root, 'projects.tsx'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
    const exports: Record<string, unknown> = {};
    vm.runInNewContext(source, { exports, require: (name: string) => ports[name] ?? {}, setTimeout, clearTimeout });
    const controller = (exports.createProjectsController as () => any)();
    const row = { id: 's', directory: '/neutral', title: 'Retained', updated: 1, pinned: false, archived: false };
    const bucket = { sessions: [row], cursor: 'opaque', loaded: true, hasMore: true };
    controller.buckets.set({ '/neutral': bucket });
    const gate = deferred<unknown>(); h.respond(() => gate.promise);
    const old = controller.mutate(row, 'rename', 'old action');
    h.background(); expect(controller.current()).toBe(false); expect(controller.buckets()['/neutral']).toBe(bucket);
    h.foreground(); expect(controller.current()).toBe(false); h.confirm(); expect(controller.current()).toBe(true);
    gate.resolve({ metadata: {} }); await old;
    expect(controller.buckets()['/neutral']).toBe(bucket); expect(controller.pending()).toEqual([]);
    expect(h.accepted.filter(call => call.method === 'PATCH')).toEqual([]);
    h.respond(() => ({})); await controller.mutate(row, 'pin');
    expect(h.accepted.at(-1)).toMatchObject({ generation: 2, method: 'POST', path: '/api/yuri/session-index/session/s/pin' });
  });

  it('transcript history replaces only operation callbacks; an old pending release cannot unlock the resumed Chat gate', async () => {
    const h = setup(), operations = h.createPageOperations(), stored = new Map<string, string>();
    const scope = { generation: 1 };
    const chat = { active: () => true, busy: () => false, sending: () => false, historyBusy: h.signal(false), messageScope: scope, revert: h.signal(null),
      referenceScope: { host: 'A', draft: 'draft', directory: '/neutral' }, draftStatus: () => 'ready', pendingSend: () => null, queueEdit: () => null };
    const make = production('transcript-actions.tsx', 'createNativeTranscriptHistory', { ...h, ...historyBackup, record: model.record, nativeRevertFrom, createTranscriptActions, inNativeSessionActionStorageLane,
      Storage: { getItem: async (key: string) => stored.get(key) ?? null }, t: (key: string) => key });
    const history = make({ chat, target: { kind: 'session', id: 's', directory: '/neutral' }, current: operations.displayCurrent, key: 'stable-chat', storageKey: 'stable-draft', operation: operations.operation, onOpenChat: vi.fn() });
    await flush(); const old = history.props(() => model.messageFrom({ id: 'm', type: 'user', text: 'Retained' }));
    old.onPending(true); expect(chat.historyBusy()).toBe(true);
    h.background(); h.foreground(); scope.generation = 2; h.confirm();
    const fresh = history.props(() => model.messageFrom({ id: 'm', type: 'user', text: 'Retained' }));
    fresh.onPending(true); expect(chat.historyBusy()).toBe(true);
    old.onPending(false); old.onRevert({ messageID: 'm' });
    expect(chat.historyBusy()).toBe(true); expect(chat.revert()).toBeNull();
    fresh.onPending(false); expect(chat.historyBusy()).toBe(false);
  });

  it('audio replaces its controller after confirmed foreground; a retained controller cannot start speech', async () => {
    const h = setup(), operations = h.createPageOperations(), calls: Array<{ name: string; body: Record<string, unknown> }> = [];
    const native = async (name: string, body: Record<string, unknown>) => { calls.push({ name, body }); if (name === 'speech.prepare') return { visible: true, provider: 'browser', mode: 'raw' }; return {}; };
    const make = production('speech.tsx', 'createNativeSpeech', { ...h, createSpeechController, native, owners: 0, host: { on: () => () => {} } });
    const audio = make({ current: operations.displayCurrent, operation: operations.operation }); await flush();
    const old = audio.capture(); expect(old).toBeDefined();
    h.background(); expect(audio.capture()).toBeUndefined(); h.foreground(); expect(audio.capture()).toBeUndefined();
    h.confirm(); await flush(); const fresh = audio.capture(); expect(fresh).not.toBe(old);
    const count = calls.length; expect(await old.play('old', 'Do not dispatch')).toBe('cancelled'); expect(calls).toHaveLength(count);
    expect(calls.filter(call => call.name === 'speech.prepare')).toHaveLength(2);
  });

  it.each(['session', 'assistant'] as const)('actual %s Chat assembly retains Chat/window/List ref and UI choices while retiring an attachment and dictation continuation', async kind => {
    const h = setup(), route = { kind: 'chat', target: { kind, id: kind === 'assistant' ? 'actual-bot' : 's', title: 'Retained', directory: '/neutral' } };
    const messages = [{ id: 'retained-row' }], rows = [{ key: 'retained-row', messages }];
    const draft = h.signal('unsent selection'), attachments = h.signal<unknown[]>([]), historyGeneration = h.signal(0);
    const attachmentSelections: Array<{ expectedHost: ReturnType<typeof h.app.runtimeScope>; target: typeof route.target; adopt: ReturnType<typeof vi.fn>; retire: ReturnType<typeof vi.fn> }> = [];
    const captureAttachment = vi.fn(() => {
      const captured = h.captureHostOperation(); let retired = false, adopted = false;
      const selection = { expectedHost: captured.scope, target: Object.freeze({ ...route.target }),
        adopt: vi.fn((raw: unknown) => { if (retired || adopted || !captured.current()) return false; adopted = true; attachments.set([...attachments(), raw]); return true; }),
        retire: vi.fn(() => { retired = true; }) };
      attachmentSelections.push(selection); return selection;
    });
    const chat = { draft, attachments, active: h.signal(false), syncActive: h.signal(false), visibleMessages: () => messages, messages: () => messages,
      more: h.signal(true), historyError: h.signal(''), loading: h.signal(false), olderLoading: h.signal(false), historyBusy: h.signal(false),
      messagesResolved: h.signal(true), historyRepairPending: h.signal(false), historyBoundaryMissing: h.signal(false), hasGap: h.signal(false), revert: h.signal(null),
      busy: () => false, streamingMessageIDs: () => new Set(), historyGeneration, referenceScope: { host: 'A', draft: 'draft', directory: '/neutral' },
      load: vi.fn(async () => {}), loadOlder: vi.fn(async () => {}), setDraftText: draft.set, error: h.signal(''), captureAttachment,
      goal: { controller: { setArmed: () => {} }, observe: () => () => {}, state: () => ({ armed: false }) } };
    const pick = deferred<unknown>(), recognition = deferred<void>(), available = deferred<boolean>();
    const nativeCalls: Array<{ name: string; body: Record<string, unknown> }> = [];
    const native = async (name: string, body: Record<string, unknown>) => {
      nativeCalls.push({ name, body });
      if (name === 'runtime.pickAttachment') return pick.promise;
      if (name === 'runtime.cancelAttachment' && Object.keys(body).sort().join(',') === 'expectedHost,requestId'
        && body.requestId === nativeCalls[0].body.requestId && JSON.stringify(body.expectedHost) === JSON.stringify(nativeCalls[0].body.expectedHost)) return true;
      throw new Error('unexpected_native:' + name);
    };
    const historyFactory = vi.fn(() => ({ props: () => ({}), Indicator: () => null,
      sessionActions: { undo: vi.fn(async () => {}), redo: vi.fn(async () => {}), fork: vi.fn(async () => {}) } }));
    const speechFactory = vi.fn(() => ({ state: () => ({ status: 'idle' }) }));
    const chromeFactory = vi.fn((publish: Parameters<typeof createNativeChatChrome>[0]) => {
      const owner = createNativeChatChrome(publish);
      return { ...owner, begin: vi.fn(owner.begin), scroll: vi.fn(owner.scroll), release: vi.fn(owner.release), end: vi.fn(owner.end) };
    });
    const auto = { state: () => ({ preferred: false, available: false }), beginRecognition: () => recognition.promise, endRecognition: vi.fn(), toggle: vi.fn() };
    let beforeFlush: ((value: unknown) => void) | undefined;
    const initialFacts = { authority: 'successful-history', scope: { hostID: 'A', generation: 1, owner: 1, historyGeneration: 0, targetKind: kind, targetID: route.target.id, directory: '/neutral' }, more: true, historyError: '', boundaryMissing: false, repairPending: false, hasGap: false, readError: '', resolved: true };
    const createChat = vi.fn((_target, options) => { if (desktop) expect(options.draftAuthorityKey).toBe(chat.draftAuthorityKey); beforeFlush = options.beforeHistoryPresentationFlush; beforeFlush!(initialFacts); return chat; });
    const nativeBtwOwner = production('chat-btw.tsx', 'createNativeBtwOwner', { ...h, createBtwGenerate, createBtwOwner, bindRequest: h.captureHostRequest });
    const nav = { routes: h.signal([route]), push: vi.fn() };
    const make = production('application.tsx', 'Chat', { ...h, createChat, mountedChats: new WeakMap(), nav, retainedChatRoute: () => route,
      nativeAppearance: { current: () => null }, platform: { os: desktop ? 'macos' : 'ios', desktop }, desktopHostIdentity: () => desktopGitDraftAuthority(h.app.connection()), desktopChatHeader: h.signal(null), publishDesktopComposerShortcuts: () => {}, desktopChatSubmitters: new Map(), desktopInteractionBlocked: () => false, createNativeDesktopComposerShortcutOwner, createDesktopChatAttachments, desktopGitDraftAuthority, deviceChatPreferences: () => null, createNativeHistoryFooterController, createChatChromeState, createNativeChatChrome: chromeFactory,
      keyboardFrame: () => ({ height: 0, duration: 0 }),
      language: () => 'en', windowSize: () => ({ width: 402, height: 874 }),
      createNativeSpeech: speechFactory, createNativeTranscriptHistory: historyFactory, createChatComposerCommands, createNativeBtwOwner: nativeBtwOwner,
      createNativeHistoryRows: () => () => rows, createNativeHistoryFocus: () => ({ cancel: () => {}, focus: () => {} }),
      nativeTurnPresentation: () => new Map(), createNativePendingHeaders: () => () => new Set(),
      createNativeHistoryScroll, createNativeTurnModelNames: () => () => '', createNativeAutoRead: () => auto,
      createNativeChatStatusPopovers: () => ({ close: () => {} }), createNativeReferenceKeyboard: () => ({ trigger: () => null, dismiss: () => {} }),
      Speech: { available: () => available.promise, start: vi.fn(() => { throw new Error('stale dictation started'); }) },
      createAttachmentPick, attachmentFrom, sameRuntimeScope, native, run: async (work: () => Promise<unknown>) => work(), record: model.record, t: (key: string) => key,
    }, 'chat, operations, current, transcriptRef, bodyRows, inputMode, activityChoices, headerSelection, attach, previewAttachment, dictate, footer, footerState, footerExperiment, listHistoryEvents');
    const mounted = make({ route, target: route.target });
    const contact = { kind: 'contact', hostID: 'A', assistantID: route.target.id, name: 'note.txt', type: 'file', attachmentID: 'opaque-note', sha256: 'a'.repeat(64), size: 4, mime: 'text/plain', filename: 'note.txt' };
    attachments.set([contact]);
    mounted.previewAttachment(contact);
    if (kind === 'assistant') {
      expect(nav.push).toHaveBeenCalledExactlyOnceWith({ kind: 'contact-attachment-preview', file: contact, expectedHost: { hostID: 'A', lease: 'lease-a' } });
      expect(Object.isFrozen(nav.push.mock.calls[0][0].expectedHost)).toBe(true);
      const previewFile = nav.push.mock.calls[0][0].file;
      expect(previewFile).not.toBe(contact); expect(Object.isFrozen(previewFile)).toBe(true);
      contact.attachmentID = 'edited-after-opening';
      expect(previewFile.attachmentID).toBe('opaque-note');
      contact.attachmentID = 'opaque-note';
    } else expect(nav.push).not.toHaveBeenCalled();
    nav.push.mockClear();
    for (const invalid of [{ ...contact }, { ...contact, hostID: 'B' }, { ...contact, assistantID: 'other' }]) mounted.previewAttachment(invalid);
    expect(nav.push).not.toHaveBeenCalled(); expect(nativeCalls).toEqual([]);
    attachments.set([]); mounted.previewAttachment(contact); expect(nav.push).not.toHaveBeenCalled();
    const ref = { marker: 'native-list-owner' }; mounted.transcriptRef.set(ref); mounted.inputMode.set('shell');
    if (desktop) { await mounted.attach('files'); expect(nativeCalls).toEqual([]); mounted.inputMode.set('normal'); }
    const choices = { turn: true }; mounted.activityChoices.set(choices); const selection = { model: { id: 'retained-model' } }; mounted.headerSelection.set(selection);
    expect(mounted.footerExperiment()).toBe(false); expect(mounted.footerState().minHeight).toBe(0);
    expect(mounted.footerState().visible).toBe(true); // callback ran synchronously before chat assignment
    const previousFooterScope = mounted.footerState().scope, previousListEvents = mounted.listHistoryEvents();
    const captures = h.captureHostOperation.mock.calls.length;
    for (let i = 0; i < 50; i++) draft.set(`draft edit ${i}`);
    draft.set('unsent selection');
    expect(h.captureHostOperation).toHaveBeenCalledTimes(captures);
    expect(createChat).toHaveBeenCalledTimes(1);
    const attachment = mounted.attach('files'), dictation = mounted.dictate();
    expect(captureAttachment).toHaveBeenCalledTimes(1);
    expect(attachmentSelections[0].expectedHost).toEqual(nativeCalls[0].body.expectedHost);
    h.background(); h.foreground();
    expect(attachmentSelections[0].retire).toHaveBeenCalledTimes(1);
    expect(mounted.operations.operation()).toBeNull();
    const rawAttachment = kind === 'assistant'
      ? { type: 'file', attachmentID: 'raw-contact', sha256: 'a'.repeat(64), size: 4, mime: 'text/plain', filename: 'raw.txt' }
      : { uri: 'attachment://old-host-file', name: 'raw.txt', mime: 'text/plain' };
    h.confirm(); recognition.resolve(); available.resolve(true); pick.resolve(rawAttachment);
    await Promise.all([attachment, dictation]);
    expect(mounted.footerState().scope).toBe(previousFooterScope);
    expect(mounted.footerState().active).toBe(true);
    expect(mounted.listHistoryEvents()).not.toBe(previousListEvents);
    const loads = chat.load.mock.calls.length, olderLoads = chat.loadOlder.mock.calls.length;
    const observedChrome = chromeFactory.mock.results[0].value;
    const chromeCalls = [observedChrome.begin, observedChrome.scroll, observedChrome.release, observedChrome.end].map(method => method.mock.calls.length);
    previousListEvents.onScrollDragStart({ offset: { x: 0, y: 150 } });
    previousListEvents.onScroll({ offset: { x: 0, y: 20 }, size: { width: 402, height: 400 }, contentSize: { width: 402, height: 800 } });
    previousListEvents.onLoadMore(); previousListEvents.onLoadMoreAtStart(); previousListEvents.onScrollEnd({ offset: { x: 0, y: 20 } });
    previousListEvents.onScrollDragEnd(); previousListEvents.onMomentumEnd();
    expect(chat.load.mock.calls.length).toBe(loads); expect(chat.loadOlder.mock.calls.length).toBe(olderLoads);
    expect([observedChrome.begin, observedChrome.scroll, observedChrome.release, observedChrome.end].map(method => method.mock.calls.length)).toEqual(chromeCalls);
    mounted.listHistoryEvents().onLoadMoreAtStart();
    expect(chat.load.mock.calls.length).toBe(loads + 1);
    expect(createChat).toHaveBeenCalledTimes(1); expect(mounted.chat).toBe(chat); expect(chat.visibleMessages()).toBe(messages);
    expect(mounted.bodyRows()).toBe(rows); expect(mounted.transcriptRef()).toBe(ref); expect(mounted.inputMode()).toBe(desktop ? 'normal' : 'shell');
    expect(mounted.activityChoices()).toBe(choices); expect(mounted.headerSelection()).toBe(selection); expect(draft()).toBe('unsent selection'); expect(attachments()).toEqual([]);
    expect(nativeCalls.map(call => call.name)).toEqual(['runtime.pickAttachment', 'runtime.cancelAttachment']);
    expect(nativeCalls[0].body).toMatchObject({ kind: 'files', expectedHost: { hostID: 'A', lease: 'lease-a' } });
    expect(Object.keys(nativeCalls[0].body).sort()).toEqual(kind === 'assistant' ? ['assistantID', 'expectedHost', 'kind', 'requestId'] : ['expectedHost', 'kind', 'requestId']);
    if (kind === 'assistant') expect(nativeCalls[0].body.assistantID).toBe('actual-bot');
    expect(nativeCalls[1].body).toEqual({ requestId: nativeCalls[0].body.requestId, expectedHost: { hostID: 'A', lease: 'lease-a' } });
    expect(attachmentSelections[0].adopt).not.toHaveBeenCalled(); expect(attachmentSelections[0].retire).toHaveBeenCalledTimes(1);
    expect(historyFactory.mock.calls[0][0].operation).toBe(mounted.operations.operation);
    expect(speechFactory.mock.calls[0][0].operation).toBe(mounted.operations.operation);
    beforeFlush!({ ...initialFacts, scope: { ...initialFacts.scope, generation: 2 }, more: false, boundaryMissing: true });
    expect(mounted.footerState().visible).toBe(true); expect(mounted.footerState().minHeight).toBe(0);
    await mounted.attach('images');
    expect(captureAttachment).toHaveBeenCalledTimes(2);
    expect(attachmentSelections[1].adopt).toHaveBeenCalledExactlyOnceWith(rawAttachment);
    expect(attachmentSelections[1].retire).toHaveBeenCalledTimes(1);
    expect(attachments()).toEqual([rawAttachment]);
    expect(nativeCalls[2].body.requestId).not.toBe(nativeCalls[0].body.requestId);
    const nativeCount = nativeCalls.length, capture = captureAttachment.getMockImplementation()!;
    captureAttachment.mockImplementationOnce(() => ({ ...capture(), expectedHost: { hostID: 'A', lease: 'different-lease' } }));
    await mounted.attach('files');
    expect(nativeCalls).toHaveLength(nativeCount);
    expect(attachmentSelections[2].adopt).not.toHaveBeenCalled(); expect(attachmentSelections[2].retire).toHaveBeenCalledTimes(1);
    expect(attachments()).toEqual([rawAttachment]);
    if (kind === 'assistant') {
      attachments.set([contact]);
      nav.push.mockImplementation(next => nav.routes.set([...nav.routes(), next]));
      mounted.previewAttachment(contact);
      const preview = nav.routes().at(-1)!;
      expect(preview.kind).toBe('contact-attachment-preview'); expect(chat.active()).toBe(false);
      expect(mounted.operations.operation()).toBeNull(); expect(attachments()).toEqual([contact]);
      const openedCount = nav.push.mock.calls.length;
      expect(() => mounted.previewAttachment(contact)).not.toThrow();
      expect(nav.push.mock.calls.length).toBe(openedCount);
      expect(draft()).toBe('unsent selection'); expect(createChat).toHaveBeenCalledTimes(1);
      nav.routes.set([route]);
      expect(chat.active()).toBe(true); expect(mounted.operations.operation()).not.toBeNull();
      expect(attachments()).toEqual([contact]); expect(draft()).toBe('unsent selection');
      expect((preview as unknown as { expectedHost: unknown }).expectedHost).toEqual(h.app.runtimeScope());
    }
    h.switchHost('B'); h.switchHost('A'); expect(mounted.current()).toBe(false);
  });

  it('actual composer changes navigation-cover effect does not subscribe to the reader revision it cancels', () => {
    const h = setup(), active = h.signal(true), cancels = vi.fn(), refreshes = vi.fn();
    const createChangesReader = (_source: unknown, _send: unknown, current: () => boolean, changed: () => void = () => {}) => ({
      source: { kind: 'workspace', directory: '/focused-worktree' }, current,
      state: () => ({ snapshot: null, loading: false, error: '' }),
      cancel() { cancels(); changed(); }, refresh: async () => { refreshes(); changed(); },
    });
    const createChangesDraft = production('chat-changes-generation.ts', 'createChangesDraft', {});
    const createChangesOwner = production('chat-changes-owner.ts', 'createChangesOwner', { ...h, createChangesReader, createChangesDraft });
    const make = production('chat-changes.tsx', 'NativeComposerChanges', { ...h, createChangesOwner,
      host: { on: () => () => {} }, runtimeEventFrom: () => null,
    }, 'owner, current');
    const props = { directory: '/focused-worktree', get active() { return active(); } };
    const mounted = make(props);
    const initial = cancels.mock.calls.length;
    expect(() => active.set(false)).not.toThrow();
    // One lane retirement plus one visibility cancellation, neither subscribes
    // to the content revision that cancel() publishes.
    expect(mounted.current()).toBe(false); expect(cancels.mock.calls.length - initial).toBe(2);
    const count = refreshes.mock.calls.length;
    expect(() => active.set(true)).not.toThrow(); expect(mounted.current()).toBe(true);
    expect(refreshes.mock.calls.length - count).toBe(1);
    // Repeated keyboard cover/back keeps one mounted owner and bounded work.
    for (let i = 0; i < 50; i++) { active.set(false); active.set(true); }
    expect(refreshes.mock.calls.length - count).toBe(51);
  });
});
