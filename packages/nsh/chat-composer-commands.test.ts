import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, test, vi } from 'vitest';
import { createChatComposerCommands } from './chat-composer-commands';
import { isNativeBtwCommand } from './composer-command-router';
import { createBtwGenerate, createBtwOwner } from './chat-btw-model';
import { createBtwPresentation } from './chat-btw-presentation';
import { editNativeReferences, insertNativeReference, type ScopedReferenceDocument } from './composer-references';
import { sameRuntimeScope, type RuntimeScope } from './runtime-scope';
import type { createNativeBtwOwner } from './chat-btw';
import type { createNativeReferenceKeyboard } from './composer-reference-keyboard-native';
import type { NativeChatTimelineProps } from './chat-timeline';

const root = path.dirname(fileURLToPath(import.meta.url));
const source = ts.createSourceFile('application.tsx', readFileSync(path.join(root, 'application.tsx'), 'utf8'), ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX);
const chatNode = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'Chat')!;
const printer = ts.createPrinter();
const print = (node: ts.Node) => printer.printNode(ts.EmitHint.Unspecified, node, source);
const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); };
const transpile = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'h' } }).outputText;
const flush = async () => { for (let count = 0; count < 30; count++) await Promise.resolve(); };
type Effect = { work: () => void; stops: Array<() => void>; children: Effect[] };
type Element = { type: string; props: Record<string, unknown> };

/** Execute actual Chat declarations, event callbacks and JSX props; no app bootstrap, engine, Host or model. */
function fixture() {
  const scope = { host: 'host', draft: 'session', directory: '/repo' };
  let document: ScopedReferenceDocument = { text: '', references: [], scope }, revision = 0;
  const route = { kind: 'chat' }, routes = signal([route]), active = signal(true), lifecycle = signal('active');
  const runtime = signal<RuntimeScope | null>({ hostID: 'host', lease: 'lease-1' });
  const requests: Array<{ runtime: RuntimeScope; path: string; method: string; body: unknown }> = [];
  let reply: (path: string, method: string, body: unknown) => Promise<unknown> = async () => ({ data: { text: 'Mock answer' } });
  const nativeRequest = (captured: RuntimeScope) => async (requestPath: string, method = 'GET', body?: unknown) => {
    if (!sameRuntimeScope(captured, runtime())) throw new Error('old lease');
    requests.push({ runtime: captured, path: requestPath, method, body }); return reply(requestPath, method, body);
  };
  let operation = { generation: 1, scope: runtime(), current: () => active() && lifecycle() === 'active' && routes().at(-1) === route, request: nativeRequest(runtime()!) };
  const operations = { operation: () => operation, current: () => operation.current() };
  const setText = (text: string) => { document = { ...editNativeReferences(document, text), scope }; revision++; };
  const error = signal(''), sending = signal(false), historyBusy = signal(false), queueEdit = signal<unknown>(null);
  const attachments = [{ uri: 'attachment://keep' }], queue = [{ id: 'q' }], pending = { id: 'main-flight' };
  const chat = {
    draft: () => document.text, draftRevision: () => revision, referenceDocument: () => document, references: () => document.references,
    referenceScope: scope, setDraftText: setText,
    setReferenceDocument: vi.fn((next: ScopedReferenceDocument, expected: ScopedReferenceDocument) => { if (document.text !== expected.text || document.references !== expected.references) return false; document = next; revision++; return true; }),
    active, draftStatus: () => 'ready', error, sending, historyBusy, historyRepairPending: () => false, queueEdit, canSend: () => true,
    busy: () => true, attachments: () => attachments, pendingSend: () => pending,
    messages: () => [], messagesResolved: () => true, more: () => false, olderLoading: () => false, historyError: () => '', loadOlder: vi.fn(async () => {}),
    send: vi.fn(), insertReference: vi.fn(),
    compact: vi.fn(async () => true), compactReceipt: signal<unknown>(null), compactionBarrier: signal(false),
  };
  const globals: Array<() => void> = [], effects: Effect[] = [];
  let currentEffect: Effect | undefined;
  const dispose = (entry: Effect) => { entry.children.splice(0).forEach(dispose); entry.stops.splice(0).forEach(stop => stop()); };
  const run = (entry: Effect) => { dispose(entry); const previous = currentEffect; currentEffect = entry; try { entry.work(); } finally { currentEffect = previous; } };
  const effect = (work: () => void) => { const entry: Effect = { work, children: [], stops: [] }; if (currentEffect) currentEffect.children.push(entry); else effects.push(entry); run(entry); };
  const cleanup = (stop: () => void) => (currentEffect?.stops ?? globals).push(stop);
  const h = (type: string, props: Record<string, unknown>) => ({ type, props });
  const nativeExports: { createNativeBtwOwner?: typeof createNativeBtwOwner } = {};
  const imports: Record<string, unknown> = {
    nsh: { signal, computed: (work: () => unknown) => work, effect, cleanup, untracked: (work: () => unknown) => work(), Scroll: 'Scroll', Text: 'Text', View: 'View' },
    'nsh/base': { Button: 'Button', Input: 'Input', TextView: 'TextView' }, './native-sheet': { NativeSheet: 'NativeSheet' },
    './appearance': { nativeDensity: () => ({}), nativeChatTextStyle: () => ({}) }, './i18n': { t: (key: string) => key },
    './runtime': { bindRequest: nativeRequest }, './chat-btw-model': { createBtwGenerate, createBtwOwner },
    './chat-btw-presentation': { createBtwPresentation },
  };
  vm.runInNewContext(transpile(readFileSync(path.join(root, 'chat-btw.tsx'), 'utf8')), { exports: nativeExports, require: (name: string) => { if (!(name in imports)) throw new Error(`Unexpected BTW import ${name}`); return imports[name]; }, h });
  const createNativeOwner = vi.fn(nativeExports.createNativeBtwOwner!);
  let keyboard: Parameters<typeof createNativeReferenceKeyboard>[0] | undefined;
  const scroll = vi.fn(), expand = vi.fn(), modelDismiss = vi.fn(), openChat = vi.fn(), focus = vi.fn(), historyProps = vi.fn();
  const sessionActions = { undo: vi.fn(async () => {}), redo: vi.fn(async () => {}), fork: vi.fn(async () => {}) };
  const env = {
    Error,
    signal, computed: (work: () => unknown) => work, effect, cleanup, untracked: (work: () => unknown) => work(), lifecycle, operations, current: () => true, chat, props: { route, target: { kind: 'session', id: 's', directory: '/repo', title: 'Session' } },
    app: { runtimeScope: runtime, projects: () => [{ id: 'p', path: '/repo', name: 'Project' }], bots: () => [] },
    nav: { routes, push: vi.fn((next: typeof route) => routes.set([...routes(), next])) }, sameRuntimeScope,
    createChatComposerCommands, createNativeBtwOwner: createNativeOwner,
    createNativeReferenceKeyboard: (options: Parameters<typeof createNativeReferenceKeyboard>[0]) => { keyboard = options; return {}; },
    createNativeChatStatusPopovers: () => ({}), inputMode: signal<'normal' | 'shell'>('normal'), admissionState: signal('complete'), recording: signal(false), attaching: signal(false),
    Keyboard: { dismiss: modelDismiss }, t: (key: string) => key, isNativeBtwCommand,
    compileNativePrompt: vi.fn(), magicCommand: vi.fn(() => false),
    resourceWithin: (directory: string, project: string) => directory.startsWith(project),
    headerSelection: () => ({}), text: (value: unknown) => typeof value === 'string' ? value : '', report: vi.fn(),
    chrome: { expand }, transcriptRef: () => ({ scrollToIndex: scroll }),
    focusState: () => null, messageFocus: { focus }, history: { props: historyProps, sessionActions, sessionReceipt: signal<unknown>(null) },
    NativeChatTimeline: 'NativeChatTimeline', NativeBtwSheet: 'NativeBtwSheet', h, openChat,
  };
  const names = ['modelPicker', 'timelineOpen', 'btw', 'btwOperation', 'commandContext', 'commandRouter', 'referenceKeyboard', 'btwDraft'];
  const functions = ['openSelection', 'openNewSessionDraft', 'sendDraft', 'sendDisabled', 'resumeLatest', 'runLocalCommand'];
  const statements = chatNode.body!.statements;
  const selected = statements.filter((node, index) => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && names.includes(declaration.name.text))
    || ts.isFunctionDeclaration(node) && !!node.name && functions.includes(node.name.text)
    || ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === 'effect' && statements[index - 1]?.getText(source).startsWith('const btwOperation ='));
  expect(selected).toHaveLength(names.length + functions.length + 1);
  const observations = 'commandRouter, modelPicker, timelineOpen, btw, btwDraft, sendDraft, sendDisabled, resumeLatest, openNewSessionDraft, referenceKeyboard';
  const api = vm.runInNewContext(transpile(`(() => { ${selected.map(print).join('\n')} return { ${observations} }; })()`), env) as {
    commandRouter: ReturnType<typeof createChatComposerCommands>; modelPicker: ReturnType<typeof signal<string | null>>; timelineOpen: ReturnType<typeof signal<boolean>>;
    btw: () => ReturnType<typeof createNativeBtwOwner> | null; sendDraft: () => void; sendDisabled: () => boolean; resumeLatest: () => void; openNewSessionDraft: () => void;
  };
  const evaluate = <T>(expression: string) => vm.runInNewContext(transpile(`(() => (${expression}))()`), { ...env, ...api }) as T;
  const elements: ts.JsxSelfClosingElement[] = [];
  const walk = (node: ts.Node) => { if (ts.isJsxSelfClosingElement(node)) elements.push(node); ts.forEachChild(node, walk); }; walk(chatNode);
  const timeline = () => evaluate<Element>(print(elements.find(node => node.tagName.getText(source) === 'NativeChatTimeline')!)).props as NativeChatTimelineProps;
  const btwSheet = () => {
    const element = elements.find(node => node.tagName.getText(source) === 'NativeBtwSheet')!;
    return evaluate<Element>(print(element)).props;
  };
  const candidate = (name: string, submit: boolean, source: 'yuri' | 'opencode' = 'yuri', capturedOwner: object = operation) => keyboard!.chooseCommand?.({ id: `${source}:${name}`, name, source }, submit,
    { owner: capturedOwner, scope, text: document.text, start: 0, end: /^\/[^\s]*/.exec(document.text)![0].length, query: document.text.slice(1).split(/\s/)[0], editing: true });
  const disposeAll = () => { effects.forEach(dispose); globals.forEach(stop => stop()); };
  return { api, chat, attachments, queue, pending, setText, document: () => document, error, requests, candidate, timeline, btwSheet, evaluate, env, elements,
    createNativeOwner, scroll, expand, modelDismiss, historyProps, sessionActions, focus,
    rerunOwner: () => run(effects[0]), setReply: (next: typeof reply) => { reply = next; },
    replaceLease: () => { runtime.set({ hostID: 'host', lease: 'lease-2' }); operation = { ...operation, generation: 2, scope: runtime(), request: nativeRequest(runtime()!) }; },
    operation: () => operation, active, lifecycle, routes, dispose: disposeAll };
}

test('actual Chat /new routes to unsent NavPage without create; model candidate/Tab/send retain text and resources', () => {
  for (const via of ['send', 'enter', 'tab'] as const) {
    const x = fixture(); x.setText(via === 'send' ? '/new tail' : '/n\ntail');
    if (via === 'send') x.api.sendDraft(); else { expect(x.candidate('new', via === 'enter')).toBe(true); if (via === 'tab') { expect(x.routes()).toHaveLength(1); x.api.sendDraft(); } }
    expect(x.routes().at(-1)).toMatchObject({ kind: 'new-session', directory: '/repo' }); expect(x.chat.draft()).toBe('');
    expect(x.attachments).toHaveLength(1); expect(x.chat.send).not.toHaveBeenCalled(); expect(x.requests).toEqual([]); x.dispose();
  }
  for (const via of ['send', 'enter', 'tab'] as const) {
    const x = fixture(); x.setText(via === 'send' ? '/MODEL keep' : '/m\nkeep');
    if (via === 'send') x.api.sendDraft(); else { x.candidate('model', via === 'enter'); if (via === 'tab') { expect(x.api.modelPicker()).toBeNull(); x.api.sendDraft(); } }
    expect(x.api.modelPicker()).toBe('model'); expect(x.chat.draft()).toBe(via === 'send' ? '/MODEL keep' : '/\u2003model ');
    expect(x.chat.send).not.toHaveBeenCalled(); expect(x.requests).toEqual([]); expect(x.attachments).toHaveLength(1); x.dispose();
  }
});
test.each(['undo', 'redo', 'fork', 'compact'] as const)('actual Chat %s candidate Enter/Tab and Send consume only token and delegate to the frozen session owner', async name => {
  for (const via of ['send', 'enter', 'tab'] as const) {
    const x = fixture(), action = name === 'compact' ? x.chat.compact : x.sessionActions[name];
    x.setText(via === 'send' ? `/${name.toUpperCase()} tail` : `/${name[0]}\ntail`);
    if (via === 'send') x.api.sendDraft();
    else {
      expect(x.candidate(name, via === 'enter')).toBe(true);
      if (via === 'tab') { expect(action).not.toHaveBeenCalled(); x.api.sendDraft(); }
    }
    expect(action).toHaveBeenCalledExactlyOnceWith(); expect(x.chat.draft()).toBe(''); expect(x.attachments).toHaveLength(1);
    expect(x.chat.send).not.toHaveBeenCalled(); expect(x.historyProps).not.toHaveBeenCalled(); expect(x.requests).toEqual([]);
    await flush(); x.dispose();
  }
});
test('compact admission stays in its owner; the composer remains free and late failures cannot publish into a new operation', async () => {
  const x = fixture(); let resolve!: (value: boolean) => void;
  x.chat.compact.mockImplementation(() => new Promise(done => { resolve = done; })); x.setText('/compact'); x.api.sendDraft();
  expect(x.chat.draft()).toBe(''); expect(x.chat.sending()).toBe(false); x.setText('follow-up'); expect(x.api.sendDisabled()).toBe(false);
  x.api.sendDraft(); expect(x.chat.send).toHaveBeenCalledTimes(1); expect(x.chat.compact).toHaveBeenCalledTimes(1);
  x.replaceLease(); resolve(false); await flush(); expect(x.error()).toBe(''); expect(x.chat.draft()).toBe('follow-up');
  x.rerunOwner(); x.chat.compact.mockResolvedValue(false); x.setText('/compact'); x.api.sendDraft(); await flush(); expect(x.error()).toBe('chat.chatInput.toast.compactFailed');
  x.dispose();
});
test('history unknown/idle rejections are displayed without fallback Host commands or automatic replay', async () => {
  const x = fixture(); x.sessionActions.redo.mockRejectedValue(new Error('Session history outcome is unknown'));
  x.setText('/redo tail'); x.api.sendDraft(); expect(x.chat.draft()).toBe(''); await flush();
  expect(x.error()).toBe('Session history outcome is unknown'); expect(x.sessionActions.redo).toHaveBeenCalledTimes(1);
  expect(x.requests).toEqual([]); expect(x.chat.send).not.toHaveBeenCalled(); x.dispose();
});
test('actual Chat BTW is accepted before main flight, queue/history/selection and uses only mocked generate', async () => {
  const x = fixture(); x.chat.sending.set(true); x.chat.historyBusy.set(true); x.chat.queueEdit.set({ id: 'edit' }); x.setText('/btw');
  expect(x.api.sendDisabled()).toBe(false); x.api.sendDraft(); expect(x.api.btw()?.state().open).toBe(true); expect(x.requests).toEqual([]); expect(x.chat.draft()).toBe('');
  expect(x.btwSheet()).toMatchObject({ owner: x.api.btw()!.owner, state: x.api.btw()!.state, active: true });
  x.setText('/btw Why this code?'); x.api.sendDraft(); await flush();
  expect(x.requests).toHaveLength(1); expect(x.requests[0]).toMatchObject({ runtime: { hostID: 'host', lease: 'lease-1' }, path: '/api/session/s/generate', method: 'POST' });
  expect(x.api.btw()?.state().turns[0]).toMatchObject({ question: 'Why this code?', answer: 'Mock answer', status: 'complete' });
  expect(x.chat.send).not.toHaveBeenCalled(); expect(x.historyProps).not.toHaveBeenCalled(); expect(x.queue).toEqual([{ id: 'q' }]); expect(x.pending).toEqual({ id: 'main-flight' }); expect(x.attachments).toHaveLength(1);
  expect(x.chat.queueEdit()).toEqual({ id: 'edit' }); x.dispose();
});
test('actual Chat BTW busy/references rejection retains entire draft; accepted revision race preserves newer text', async () => {
  const x = fixture(); let resolve!: (value: unknown) => void;
  x.setReply(() => new Promise(done => { resolve = done; })); x.setText('/btw First'); x.api.sendDraft();
  x.setText('/btw Second'); x.api.sendDraft(); expect(x.chat.draft()).toBe('/btw Second'); expect(x.requests).toHaveLength(1);
  const withReference = insertNativeReference(x.document(), { kind: 'file', value: 'a.ts', label: 'a.ts', scope: x.document().scope });
  x.chat.setReferenceDocument({ ...withReference, scope: x.document().scope }, x.document()); const before = x.document();
  x.api.sendDraft(); expect(x.document()).toBe(before); expect(x.error()).toBe('chat.btw.plainTextRequired'); expect(x.requests).toHaveLength(1);
  resolve({ data: { text: 'First answer' } }); await flush();
  x.api.btw()!.owner.close(); x.setText('/btw Race');
  x.setReply(async () => { x.setText('Newer draft'); return { data: { text: 'Race answer' } }; }); x.api.sendDraft(); await flush();
  expect(x.chat.draft()).toBe('Newer draft'); expect(x.attachments).toHaveLength(1); expect(x.chat.send).not.toHaveBeenCalled(); x.dispose();
});
test('actual BTW candidate Tab only inserts; Enter opens, owner is reused across edits, and lease ABA retires late answers', async () => {
  const x = fixture(); x.setText('/b'); expect(x.candidate('btw', false)).toBe(true); expect(x.api.btw()!.state().open).toBe(false); expect(x.chat.draft()).toBe('/\u2003btw ');
  x.api.sendDraft(); expect(x.api.btw()!.state().open).toBe(true); expect(x.requests).toEqual([]);
  x.api.btw()!.owner.close(); x.setText('/b'); expect(x.candidate('btw', true)).toBe(true); expect(x.api.btw()!.state().open).toBe(true);
  for (let index = 0; index < 50; index++) x.setText(`draft ${index}`); expect(x.createNativeOwner).toHaveBeenCalledTimes(1);
  let resolve!: (value: unknown) => void; x.setReply(() => new Promise(done => { resolve = done; })); x.setText('/btw Old lease'); x.api.sendDraft();
  const old = x.api.btw()!, operation = x.operation(); x.setText('/m'); x.replaceLease();
  expect(x.candidate('model', true, 'yuri', operation)).toBe(false); expect(x.chat.draft()).toBe('/m');
  x.rerunOwner(); expect(x.createNativeOwner).toHaveBeenCalledTimes(2); expect(old.state().open).toBe(false);
  resolve({ data: { text: 'Late answer' } }); await flush(); expect(old.state().turns).toEqual([]); expect(x.api.btw()!.state().turns).toEqual([]);
  expect(x.chat.draft()).toBe('/m'); expect(x.chat.send).not.toHaveBeenCalled(); x.dispose();
});
test('actual candidate replacement clears only body references, and BTW Enter uses the bare preset while Tab preserves the question', async () => {
  for (const name of ['model', 'timeline', 'summary', 'explore'] as const) {
    const x = fixture(); x.setText('/m\n');
    const next = insertNativeReference(x.document(), { kind: 'file', value: 'a.ts', label: 'a.ts', scope: x.document().scope });
    x.chat.setReferenceDocument({ ...next, scope: x.document().scope }, x.document());
    expect(x.candidate(name, false)).toBe(true); expect(x.chat.draft()).toBe(`/\u2003${name} `); expect(x.document().references).toEqual([]);
    expect(x.attachments).toHaveLength(1); expect(x.queue).toEqual([{ id: 'q' }]); expect(x.chat.send).not.toHaveBeenCalled(); x.dispose();
  }
  for (const submit of [true, false]) {
    const x = fixture(); x.setText('/b\nquestion'); x.candidate('btw', submit);
    if (submit) { expect(x.chat.draft()).toBe(''); expect(x.api.btw()!.state().open).toBe(true); expect(x.requests).toEqual([]); }
    else { expect(x.chat.draft()).toBe('/\u2003btw \nquestion'); x.api.sendDraft(); await flush(); expect(x.requests).toHaveLength(1); expect(x.api.btw()!.state().turns[0].question).toBe('question'); }
    x.dispose();
  }
  const model = fixture(); model.setText('/model\n'); const next = insertNativeReference(model.document(), { kind: 'file', value: 'a.ts', label: 'a.ts', scope: model.document().scope });
  model.chat.setReferenceDocument({ ...next, scope: model.document().scope }, model.document()); const before = model.document();
  model.api.sendDraft(); expect(model.document()).toBe(before); expect(model.api.modelPicker()).toBe('model'); expect(model.attachments).toHaveLength(1); model.dispose();
});
test('production timeline JSX uses original history/focus and shared latest callback; command selection only inserts and submit preserves body', async () => {
  const x = fixture(); x.setText('/t\nold tail'); expect(x.candidate('timeline', true)).toBe(true); expect(x.api.timelineOpen()).toBe(false); expect(x.chat.draft()).toBe('/\u2003timeline ');
  x.api.sendDraft(); expect(x.api.timelineOpen()).toBe(true); expect(x.chat.draft()).toBe('/\u2003timeline '); expect(x.attachments).toHaveLength(1);
  const props = x.timeline(); expect(props.messages).toBe(x.chat.messages); expect(props.messageOptions).toBe(x.historyProps); expect(props.focusMessage).toBe(x.focus); expect(props.operation).toBe(x.operation());
  expect(props.loadOlder).toBe(x.chat.loadOlder); expect(props.resumeLatest).toBe(x.api.resumeLatest);
  await props.resumeLatest(); expect(x.scroll).toHaveBeenCalledExactlyOnceWith({ index: 0, animated: true, viewPosition: 1 });
  props.onOpenChange(false); expect(x.api.timelineOpen()).toBe(false); x.api.sendDraft(); expect(x.api.timelineOpen()).toBe(true);
  x.active.set(false); x.rerunOwner(); expect(x.api.timelineOpen()).toBe(false); expect(x.api.btw()!.state().open).toBe(false); expect(x.btwSheet().active).toBe(false); expect(x.chat.draft()).toBe('/\u2003timeline ');
  expect(x.chat.send).not.toHaveBeenCalled(); expect(x.requests).toEqual([]); x.dispose();
});
test('Host identity and Goal remain on their original route, and both real send buttons bypass main flight only for BTW', () => {
  const x = fixture(); x.setText('/m'); x.candidate('model', true, 'opencode'); expect(x.api.modelPicker()).toBeNull();
  x.api.sendDraft(); expect(x.chat.send).toHaveBeenCalledTimes(1); expect(x.api.modelPicker()).toBeNull();
  x.setText('/goal pause'); x.api.sendDraft(); expect(x.chat.send).toHaveBeenCalledTimes(2); expect(x.requests).toEqual([]);
  x.chat.sending.set(true); x.setText('/btw');
  const sends = x.elements.filter(node => node.tagName.getText(source) === 'NativeComposerSend'); expect(sends).toHaveLength(2);
  for (const element of sends) {
    const attribute = element.attributes.properties.find((node): node is ts.JsxAttribute => ts.isJsxAttribute(node) && node.name.getText(source) === 'inFlight')!;
    const expression = (attribute.initializer as ts.JsxExpression).expression!;
    expect(x.evaluate<boolean>(print(expression))).toBe(false);
  }
  expect(x.api.sendDisabled()).toBe(false); x.setText('Main message'); expect(x.api.sendDisabled()).toBe(true); x.dispose();
});
