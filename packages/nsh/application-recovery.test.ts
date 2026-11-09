import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as model from './model';
import * as historyBackup from './transcript-actions-backup';
import { createTranscriptActions, nativeRevertFrom } from './transcript-actions-core';
import { createProjectsDeletes } from './projects-delete';
import { createProjectsAttention } from './projects-attention';
import { createNativeHistoryFooter } from './history-footer';
import { createSpeechController } from './speech-core';
import * as projectsSidebar from './projects-sidebar';
import { createChatChromeState, createNativeChatChrome } from './chat-chrome';
import { desktopGitDraftAuthority } from './desktop-git-dispatch';
import { createNativeDesktopComposerShortcutOwner } from './desktop-composer-actions';
import { createDesktopAttachments } from './desktop-attachments';
import { desktopAttachmentRecovery } from './desktop-attachments-recovery';

const root = path.dirname(fileURLToPath(import.meta.url));
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = <T>() => { let resolve!: (next: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

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
    const make = production('transcript-actions.tsx', 'createNativeTranscriptHistory', { ...h, ...historyBackup, record: model.record, nativeRevertFrom, createTranscriptActions,
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

  it.each([false, true])('actual Chat assembly retains Chat/window/List ref and UI choices while retiring an attachment and dictation continuation, desktop=%s', async desktop => {
    const h = setup(), route = { kind: 'chat', target: { kind: 'session', id: 's', title: 'Retained', directory: '/neutral' } };
    const messages = [{ id: 'retained-row' }], rows = [{ key: 'retained-row', messages }];
    const draft = h.signal('unsent selection'), attachments = h.signal<unknown[]>([]), historyGeneration = h.signal(0);
    const chat = { draft, attachments, draftAuthorityKey: desktop ? desktopGitDraftAuthority(h.app.connection()) : undefined, active: h.signal(false), syncActive: h.signal(false), visibleMessages: () => messages, messages: () => messages,
      more: h.signal(true), historyError: h.signal(''), loading: h.signal(false), olderLoading: h.signal(false), historyBusy: h.signal(false),
      messagesResolved: h.signal(true), historyRepairPending: h.signal(false), historyBoundaryMissing: h.signal(false), hasGap: h.signal(false), revert: h.signal(null),
      busy: () => false, sending: () => false, draftStatus: () => 'ready', streamingMessageIDs: () => new Set(), historyGeneration, referenceScope: { host: 'A', draft: 'draft', directory: '/neutral' },
      load: vi.fn(async () => {}), loadOlder: vi.fn(async () => {}), setDraftText: draft.set, error: h.signal(''),
      goal: { controller: { setArmed: () => {} }, observe: () => () => {}, state: () => ({ armed: false }) } };
    const pick = deferred<unknown>(), recognition = deferred<void>(), available = deferred<boolean>();
    const nativeCalls: string[] = [];
    let attachmentRequestID: string | undefined;
    const native = async (name: string, body?: Record<string, unknown>) => {
      nativeCalls.push(name);
      if (name === 'runtime.pickAttachment') return pick.promise;
      if (desktop && name === 'desktop.attachments.pick') { expect(body?.expectedHost).toEqual({ hostID: 'A', lease: 'lease-a' }); attachmentRequestID = String(body?.requestID); return pick.promise; }
      if (desktop && ['desktop.attachments.cancel', 'desktop.attachments.release'].includes(name)) { expect(body?.requestID).toBe(attachmentRequestID); return { requestID: body?.requestID, state: 'retired', attachments: [], orphaned: 0 }; }
      throw new Error('unexpected_native:' + name);
    };
    const createDesktopChatAttachments = production('desktop-chat-attachments.tsx', 'createDesktopChatAttachments', { ...h, createDesktopAttachments, desktopAttachmentRecovery, native, id: () => 'recovery-fixture-pick', t: (key: string) => key });
    const historyFactory = vi.fn(() => ({ props: () => ({}), Indicator: () => null }));
    const speechFactory = vi.fn(() => ({ state: () => ({ status: 'idle' }) }));
    const auto = { state: () => ({ preferred: false, available: false }), beginRecognition: () => recognition.promise, endRecognition: vi.fn(), toggle: vi.fn() };
    let beforeFlush: ((value: unknown) => void) | undefined;
    const initialFacts = { authority: 'successful-history', scope: { hostID: 'A', generation: 1, owner: 1, historyGeneration: 0, targetKind: 'session', targetID: 's', directory: '/neutral' }, more: true, historyError: '', boundaryMissing: false, repairPending: false, hasGap: false, readError: '', resolved: true };
    const createChat = vi.fn((_target, options) => { expect(options.draftAuthorityKey).toBe(chat.draftAuthorityKey); beforeFlush = options.beforeHistoryPresentationFlush; beforeFlush!(initialFacts); return chat; });
    const nav = { routes: h.signal([route]) };
    const make = production('application.tsx', 'Chat', { ...h, createChat, mountedChats: new WeakMap(), nav, retainedChatRoute: () => route,
      platform: { os: desktop ? 'macos' : 'ios', desktop }, desktopGitDraftAuthority, desktopHostIdentity: () => desktopGitDraftAuthority(h.app.connection()),
      createDesktopChatAttachments, createChatChromeState, createNativeChatChrome, keyboardFrame: () => ({ height: 0 }),
      desktopInteractionBlocked: () => false, desktopChatSubmitters: new Map(), createNativeDesktopComposerShortcutOwner,
      publishDesktopComposerShortcuts: () => {}, desktopChatHeader: h.signal(null),
      nativeAppearance: { current: () => null }, createNativeHistoryFooter,
      createNativeSpeech: speechFactory, createNativeTranscriptHistory: historyFactory,
      createNativeHistoryRows: () => () => rows, createNativeHistoryFocus: () => ({ cancel: () => {}, focus: () => {} }),
      nativeTurnPresentation: () => new Map(), createNativePendingHeaders: () => () => new Set(),
      createNativeHistoryScroll: () => ({ reset: () => {} }), createNativeTurnModelNames: () => () => '', createNativeAutoRead: () => auto,
      createNativeChatStatusPopovers: () => ({ close: () => {} }), createNativeReferenceKeyboard: () => ({ trigger: () => null, dismiss: () => {} }),
      Speech: { available: () => available.promise, start: vi.fn(() => { throw new Error('stale dictation started'); }) },
      native, run: async (work: () => Promise<unknown>) => work(), record: model.record, t: (key: string) => key,
    }, 'chat, operations, current, transcriptRef, bodyRows, inputMode, activityChoices, headerSelection, attach, dictate, footer, footerState, footerExperiment');
    const mounted = make({ route, target: route.target });
    const ref = { marker: 'native-list-owner' }; mounted.transcriptRef.set(ref); mounted.inputMode.set('shell');
    if (desktop) { await mounted.attach('files'); expect(nativeCalls).toEqual([]); mounted.inputMode.set('normal'); }
    const choices = { turn: true }; mounted.activityChoices.set(choices); const selection = { model: { id: 'retained-model' } }; mounted.headerSelection.set(selection);
    expect(mounted.footerExperiment()).toBe(false); expect(mounted.footerState().minHeight).toBe(0);
    expect(mounted.footerState().visible).toBe(true); // callback ran synchronously before chat assignment
    const captures = h.captureHostOperation.mock.calls.length;
    for (let i = 0; i < 50; i++) draft.set(`draft edit ${i}`);
    draft.set('unsent selection');
    expect(h.captureHostOperation).toHaveBeenCalledTimes(captures);
    expect(createChat).toHaveBeenCalledTimes(1);
    const attachment = mounted.attach('files'), dictation = mounted.dictate();
    h.background(); h.foreground();
    expect(mounted.operations.operation()).toBeNull();
    h.confirm(); recognition.resolve(); available.resolve(true); pick.resolve(desktop ? { requestID: attachmentRequestID, state: 'ready', attachments: [{ uri: 'file:///synthetic/old-host-file', name: 'old.txt', mime: 'text/plain' }], orphaned: 0 } : { uri: 'old-host-file' });
    await Promise.all([attachment, dictation]);
    expect(createChat).toHaveBeenCalledTimes(1); expect(mounted.chat).toBe(chat); expect(chat.visibleMessages()).toBe(messages);
    expect(mounted.bodyRows()).toBe(rows); expect(mounted.transcriptRef()).toBe(ref); expect(mounted.inputMode()).toBe(desktop ? 'normal' : 'shell');
    expect(mounted.activityChoices()).toBe(choices); expect(mounted.headerSelection()).toBe(selection); expect(draft()).toBe('unsent selection'); expect(attachments()).toEqual([]);
    if (desktop) { expect(nativeCalls[0]).toBe('desktop.attachments.pick'); expect(nativeCalls).toContain('desktop.attachments.cancel'); expect(nativeCalls).not.toContain('runtime.pickAttachment'); }
    else expect(nativeCalls).toEqual(['runtime.pickAttachment']);
    expect(historyFactory.mock.calls[0][0].operation).toBe(mounted.operations.operation);
    expect(speechFactory.mock.calls[0][0].operation).toBe(mounted.operations.operation);
    beforeFlush!({ ...initialFacts, scope: { ...initialFacts.scope, generation: 2 }, more: false, boundaryMissing: true });
    expect(mounted.footerState().visible).toBe(true); expect(mounted.footerState().minHeight).toBe(0);
    h.switchHost('B'); h.switchHost('A'); expect(mounted.current()).toBe(false);
  });

  it('actual composer changes navigation-cover effect does not subscribe to the reader revision it cancels', () => {
    const h = setup(), active = h.signal(true), cancels = vi.fn(), refreshes = vi.fn();
    const createChangesReader = (_source: unknown, _send: unknown, current: () => boolean, changed: () => void = () => {}) => ({
      source: { kind: 'workspace', directory: '/focused-worktree' }, current,
      state: () => ({ snapshot: null, loading: false, error: '' }),
      cancel() { cancels(); changed(); }, refresh: async () => { refreshes(); changed(); },
    });
    const createOwner = production('chat-changes.tsx', 'createOwner', { ...h, createChangesReader });
    const make = production('chat-changes.tsx', 'NativeComposerChanges', { ...h, createOwner,
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
