import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { createNativeTimelineOwner } from './chat-timeline-owner';
import * as timelineModel from './chat-timeline-model';
import { createTranscriptActions } from './transcript-actions-core';
import type { Message } from './model';

type Props = Record<string, unknown>;
type Node = { type: string | ((props: Props) => unknown); props: Props; children: Array<() => unknown> };
const root = path.dirname(fileURLToPath(import.meta.url));
const user = (id: string, text: string): Message => ({ id, role: 'user', text, reasoning: '', tools: [], cards: [], files: [], error: '', time: { created: 1000 } });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }

/** Production lazy JSX/callback seam in Node. Does not claim UIKit geometry or presentation evidence. */
function fixture() {
  const pending = new Set<() => void>(); let tracking: (() => void) | undefined;
  const signal = <T>(initial: T) => {
    let value = initial; const listeners = new Set<() => void>();
    return Object.assign(() => { if (tracking) listeners.add(tracking); return value; }, { set(next: T) { if (Object.is(value, next)) return; value = next; listeners.forEach(work => pending.add(work)); } });
  };
  const effect = (work: () => void) => { const run = () => { const before = tracking; tracking = run; try { work(); } finally { tracking = before; } }; run(); };
  const untracked = <T>(work: () => T) => { const before = tracking; tracking = undefined; try { return work(); } finally { tracking = before; } };
  const computed = <T>(read: () => T) => { const value = signal<T>(undefined as T); effect(() => value.set(read())); return value; };
  const tick = () => { for (let i = 0; pending.size; i++) { if (i > 100) throw Error('Reactive fixture did not settle'); const batch = [...pending]; pending.clear(); batch.forEach(work => work()); } };
  const settle = async () => { for (let i = 0; i < 30; i++) { await Promise.resolve(); tick(); } };
  const jsx = (type: Node['type'], props: Props | null, ...children: Node['children']): Node => ({ type, props: props ?? {}, children });
  const lazy: ts.TransformerFactory<ts.SourceFile> = context => file => {
    const visit: ts.Visitor = node => {
      const next = ts.visitEachChild(node, visit, context);
      if (!ts.isCallExpression(next) || !ts.isIdentifier(next.expression) || next.expression.text !== 'jsx') return next;
      const [type, props, ...children] = next.arguments;
      const getters = props && ts.isObjectLiteralExpression(props) ? ts.factory.updateObjectLiteralExpression(props, props.properties.map(property => ts.isPropertyAssignment(property)
        ? ts.factory.createGetAccessorDeclaration(undefined, property.name, [], undefined, ts.factory.createBlock([ts.factory.createReturnStatement(property.initializer)])) : property)) : props;
      return ts.factory.updateCallExpression(next, next.expression, next.typeArguments, [type, getters, ...children.map(child => ts.factory.createArrowFunction(undefined, undefined, [], undefined, ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), child))]);
    }; return ts.visitNode(file, visit) as ts.SourceFile;
  };
  const open = signal(false), active = signal(true), operation = signal<{ current: () => boolean } | null>({ current: () => active() });
  const messages = signal([user('z-first', 'first'), user('a-last', 'last')]), focused = signal<string | null>('z-first'), historyError = signal('');
  const projections = vi.fn(timelineModel.nativeTimelineEntries), focusMessage = vi.fn(async () => ({ status: 'revealed' })), resumeLatest = vi.fn(), navigation = vi.fn(), onChanged = vi.fn(), onPending = vi.fn();
  let load: () => Promise<void> = async () => {}, write: () => Promise<void> = async () => {};
  const loadOlder = vi.fn(() => load()), writes: string[] = [], confirmations = vi.fn(async () => ({ action: 'revert' })), messageOptionsRead = vi.fn();
  const modules: Record<string, unknown> = {
    nsh: { signal, computed, effect, untracked, cleanup() {}, locale: () => 'en', keymap: { bind: () => () => {} }, List: 'List', View: 'View', Text: 'Text' },
    'nsh/base': { Button: 'Button', AlertDialog: { show: confirmations } },
    './native-sheet': { NativeSheet: 'NativeSheet' }, './sheet-search': { NativeSheetSearch: 'Search' }, './Icon': { Icon: 'Icon' },
    './i18n': { t: (key: string) => key, language: () => 'en' },
    './appearance': { nativeChatTextStyle: () => ({}), nativeDensity: () => ({ select: { content: {}, header: {} }, forms: { quiet: {}, action: {}, session: {} } }) },
    './chat-timeline-owner': { createNativeTimelineOwner }, './chat-timeline-model': { ...timelineModel, nativeTimelineEntries: projections }, './transcript-actions-core': { createTranscriptActions },
  };
  const exports: { NativeChatTimeline?: (props: Props) => Node } = {};
  const output = ts.transpileModule(readFileSync(path.join(root, 'chat-timeline.tsx'), 'utf8'), { fileName: 'chat-timeline.tsx', compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' }, transformers: { after: [lazy] } }).outputText;
  vm.runInNewContext(output, { exports, jsx, If: 'If', Each: 'Each', Error, require: (id: string) => { if (!(id in modules)) throw Error('Unexpected dependency ' + id); return modules[id]; } });
  const shell = exports.NativeChatTimeline!({ get open() { return open(); }, get operation() { return operation(); }, onOpenChange: (value: boolean) => open.set(value), messages, focusedMessageID: focused,
    messagesResolved: () => true, more: () => true, olderLoading: () => false, historyError, loadOlder, focusMessage, resumeLatest,
    messageOptions: (message: () => Message) => {
      messageOptionsRead();
      const captured = operation();
      return { target: { kind: 'session', id: 'session', directory: '/workspace', title: 'fixture' }, scope: { key: 'timeline-test', current: () => captured === operation() && active(), busy: () => false, message },
        onPending, onChanged, onOpenChat: navigation, send: async (resource: string, method = 'GET') => {
          if (method === 'POST') { writes.push(resource); await write(); return resource.includes('/fork?') ? { data: { id: 'forked' } } : { messageID: message().id }; }
          if (resource === '/api/session/active') return {};
          if (resource.includes('/message?')) return { data: messages().slice().reverse().map(item => ({ id: item.id, type: 'user' })) };
          return { id: message().id, type: 'user', content: [{ type: 'text', text: message().text }] };
        } };
    } });
  type Mounted = { read: () => Node[] };
  function mount(value: unknown): Mounted {
    if (!value || typeof value !== 'object' || !('type' in value)) return { read: () => [] };
    const node = value as Node;
    if (typeof node.type === 'function') return mount(untracked(() => (node.type as (props: Props) => unknown)(node.props)));
    if (node.type === 'Each' || node.type === 'List') {
      const mounted = new Map<unknown, Mounted>();
      return { read: () => {
        const values = (node.props.of ?? node.props.each) as unknown[];
        const child = node.children[0]() as (entry: () => unknown) => unknown;
        return [node, ...values.flatMap(value => { if (!mounted.has(value)) mounted.set(value, mount(untracked(() => child(() => value)))); return mounted.get(value)!.read(); })];
      } };
    }
    const children = node.children.map(read => { let mounted: Mounted | undefined; return () => { let value = read(); if (typeof value === 'function') value = value(); return (mounted ??= mount(value)).read(); }; });
    return { read: () => node.type === 'If' && !node.props.when ? [] : [node, ...children.flatMap(read => read())] };
  }
  const tree = mount(shell), nodes = () => { const result = tree.read(); tick(); return result; };
  const find = (id: string) => { const node = nodes().find(item => item.props.testID === id); if (!node) throw Error('Missing node ' + id); return node; };
  const sheet = () => nodes().find(item => item.type === 'NativeSheet')!;
  const press = async (id: string) => { const node = find(id); if (!node.props.disabled) (node.props.onPress as () => unknown)(); await settle(); };
  const present = async () => { open.set(true); tick(); (sheet().props.onOpen as () => void)(); tick(); nodes(); await settle(); };
  return { open, active, operation, messages, projections, find, sheet, nodes, present, press, settle, tick, focusMessage, resumeLatest, navigation, onPending, onChanged, writes, historyError, loadOlder, confirmations, messageOptionsRead,
    older(work: () => Promise<void>) { load = work; }, write(work: () => Promise<void>) { write = work; } };
}

it('production JSX defers history projection until presented, searches full source, focuses selected source and waits for native close', async () => {
  const app = fixture();
  for (let i = 0; i < 50; i++) app.messages.set([user(String(i), 'unrelated')]);
  app.tick(); app.nodes(); expect(app.projections).not.toHaveBeenCalled();
  app.messages.set([user('z-first', 'first'), user('a-last', '全文'.repeat(4000) + 'needle')]); await app.present();
  expect(app.find('chat-timeline-goto-z-first').props.selected).toBe(true);
  (app.find('chat-timeline-search').props.onChange as (event: unknown) => void)({ value: 'NEEDLE' }); app.tick();
  expect(app.find('chat-timeline-list').props.each).toEqual(['a-last']);
  await app.press('chat-timeline-goto-a-last'); expect(app.focusMessage).toHaveBeenCalledWith('a-last');
  expect(app.sheet().props.open).toBe(false); expect(app.nodes().some(node => node.props.testID === 'chat-timeline-list')).toBe(true);
  (app.sheet().props.onClose as () => void)(); app.tick(); expect(app.nodes()).toHaveLength(1);
});

it('production older callback preserves data on failure and supports explicit retry with no duplicate flight', async () => {
  const app = fixture(); await app.present(); const flight = deferred();
  app.older(async () => { await flight.promise; app.historyError.set('older failed'); });
  await app.press('chat-timeline-older'); await app.press('chat-timeline-older'); expect(app.loadOlder).toHaveBeenCalledOnce();
  expect(app.find('chat-timeline-close').props.disabled).toBe(true);
  flight.resolve(); await app.settle(); expect(app.find('chat-timeline-list').props.each).toEqual(['z-first', 'a-last']);
  expect(app.find('chat-timeline-error')).toBeDefined();
  app.older(async () => { app.historyError.set(''); app.messages.set([user('older', 'old'), ...app.messages()]); });
  await app.press('chat-timeline-older'); expect(app.loadOlder).toHaveBeenCalledTimes(2); expect(app.find('chat-timeline-list').props.each).toEqual(['older', 'z-first', 'a-last']);
});

it('production fork uses the original history callbacks and defers navigation; scope retirement fences a deferred revert', async () => {
  const app = fixture(); await app.present(); const flight = deferred(); app.write(() => flight.promise);
  await app.press('chat-timeline-fork-z-first'); await app.press('chat-timeline-revert-a-last');
  expect(app.writes).toHaveLength(1); expect(app.sheet().props.closeOnSwipe).toBe(false);
  flight.resolve(); await app.settle(); expect(app.navigation).not.toHaveBeenCalled(); expect(app.onPending.mock.calls).toEqual([[true], [false]]);
  (app.sheet().props.onClose as () => void)(); app.tick(); expect(app.navigation).toHaveBeenCalledWith(expect.objectContaining({ id: 'forked' }));
  await app.present(); const revert = deferred(); app.write(() => revert.promise);
  await app.press('chat-timeline-revert-z-first'); expect(app.writes).toHaveLength(2);
  app.active.set(false); app.operation.set(null); app.tick(); revert.resolve(); await app.settle();
  expect(app.onChanged).not.toHaveBeenCalled(); expect(app.navigation).toHaveBeenCalledOnce();
});

it('production latest delegates to the existing List owner', async () => {
  const app = fixture(); await app.present(); await app.press('chat-timeline-latest');
  expect(app.resumeLatest).toHaveBeenCalledOnce(); expect(app.sheet().props.open).toBe(false);
});

it('saved first-presentation JSX callbacks cannot acquire a reopened operation even when message IDs match', async () => {
  const app = fixture(); await app.present();
  const callbacks = ['chat-timeline-fork-z-first', 'chat-timeline-revert-z-first', 'chat-timeline-goto-z-first', 'chat-timeline-latest', 'chat-timeline-older', 'chat-timeline-close']
    .map(id => ({ id, press: app.find(id).props.onPress as () => unknown }));
  const oldSheetChange = app.sheet().props.onOpenChange as (event: { open: boolean }) => void;
  const oldCompletion = app.sheet().props.onClose as () => void;
  await app.press('chat-timeline-close'); oldCompletion(); app.tick();
  app.operation.set({ current: () => app.active() }); await app.present();
  // Same message IDs deliberately remain valid in the new domain.
  for (const callback of callbacks) {
    callback.press(); await app.settle();
    expect(app.sheet().props.open, callback.id).toBe(true);
    expect(app.writes, callback.id).toEqual([]);
    expect(app.confirmations, callback.id).not.toHaveBeenCalled();
    expect(app.focusMessage, callback.id).not.toHaveBeenCalled();
    expect(app.resumeLatest, callback.id).not.toHaveBeenCalled();
    expect(app.loadOlder, callback.id).not.toHaveBeenCalled();
    expect(app.onPending, callback.id).not.toHaveBeenCalled();
    expect(app.messageOptionsRead, callback.id).not.toHaveBeenCalled();
  }
  oldSheetChange({ open: false }); oldCompletion(); app.tick();
  expect(app.sheet().props.open).toBe(true);
  await app.press('chat-timeline-older'); expect(app.loadOlder).toHaveBeenCalledOnce();
  await app.press('chat-timeline-fork-z-first'); expect(app.writes).toHaveLength(1);
  expect(app.navigation).not.toHaveBeenCalled();
  (app.sheet().props.onClose as () => void)(); app.tick(); expect(app.navigation).toHaveBeenCalledOnce();
});

it('current-presentation callbacks still admit revert, goto, latest and close after operation replacement', async () => {
  const app = fixture(); await app.present();
  await app.press('chat-timeline-close'); (app.sheet().props.onClose as () => void)(); app.tick();
  app.operation.set({ current: () => app.active() }); await app.present();
  await app.press('chat-timeline-revert-z-first'); expect(app.writes).toHaveLength(1); expect(app.onChanged).toHaveBeenCalledOnce();
  (app.sheet().props.onClose as () => void)(); app.tick(); await app.present();
  await app.press('chat-timeline-goto-z-first'); expect(app.focusMessage).toHaveBeenCalledWith('z-first');
  (app.sheet().props.onClose as () => void)(); app.tick(); await app.present();
  await app.press('chat-timeline-latest'); expect(app.resumeLatest).toHaveBeenCalledOnce();
  (app.sheet().props.onClose as () => void)(); app.tick(); await app.present();
  await app.press('chat-timeline-close'); expect(app.sheet().props.open).toBe(false);
});

it('queued reopen waits for the original fork navigation completion and rejects its saved close callback', async () => {
  const app = fixture(); await app.present();
  const oldClose = app.find('chat-timeline-close').props.onPress as () => void;
  const firstCompletion = app.sheet().props.onClose as () => void;
  await app.press('chat-timeline-fork-z-first');
  app.open.set(true); app.tick();
  expect(app.sheet().props.open).toBe(false); expect(app.navigation).not.toHaveBeenCalled();
  firstCompletion(); app.tick(); expect(app.navigation).toHaveBeenCalledOnce();
  expect(app.sheet().props.open).toBe(true);
  (app.sheet().props.onOpen as () => void)(); app.tick(); app.nodes();
  oldClose(); firstCompletion(); await app.settle();
  expect(app.sheet().props.open).toBe(true);
  await app.press('chat-timeline-latest'); expect(app.resumeLatest).toHaveBeenCalledOnce();
});
