import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as helpers from './new-session-ui-helpers';
import * as pickerHelpers from './chat-models-helpers';
import * as model from './model';

const directory = path.dirname(fileURLToPath(import.meta.url));
const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); };
const flush = async () => { for (let turn = 0; turn < 30; turn++) await Promise.resolve(); };

// Executes the production event/read/write closures as ordinary JS, not NSH or
// UIKit. Only the final JSX return is replaced with a test observation seam.
function componentClosures(file: string, name: string, observations: string, ports: Record<string, unknown>) {
  const source = ts.createSourceFile(file, readFileSync(path.join(directory, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
  const body = declaration.body!.statements.filter(node => !ts.isReturnStatement(node)).map(node => node.getText(source)).join('\n');
  const output = ts.transpileModule(`function ${name}(props) { ${body}; return { ${observations} }; }`, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText;
  return new Function(...Object.keys(ports), `${output}; return ${name};`)(...Object.values(ports));
}
const basePorts = { ...helpers, ...model, ...pickerHelpers, signal, computed: (work: () => unknown) => work, untracked: (work: () => unknown) => work(), effect: () => {}, cleanup: () => {}, t: (key: string) => key };

function starters() {
  let active = true, sameHost = true, settings: model.Row = { draftStarters: [{ type: 'command', name: 'explore' }, { type: 'command', name: 'weigh' }], keep: true };
  let handler: ((path: string, method: string, body: unknown) => unknown) | undefined;
  const files = new Map<string, string>();
  const location = helpers.projectStarterLocation('/home/user', '/workspace/root');
  const request = vi.fn(async (url: string, method = 'GET', body?: unknown) => {
    if (handler) return handler(url, method, body);
    const parsed = new URL(url, 'https://example.invalid');
    if (parsed.pathname === '/api/config/settings') { if (method === 'PUT') settings = { ...settings, ...model.record(body) }; return settings; }
    if (parsed.pathname === '/api/fs/home') return { home: '/home/user' };
    if (parsed.pathname === '/api/fs/read') return files.get(parsed.searchParams.get('path')!) ?? '';
    if (parsed.pathname === '/api/fs/mkdir') return { success: true };
    if (parsed.pathname === '/api/fs/write') { const input = model.record(body); files.set(model.text(input.path), model.text(input.content)); return { success: true }; }
    if (parsed.pathname === '/api/config/commands/metadata') return { commands: [{ name: 'team', scope: 'project' }] };
    if (parsed.pathname === '/api/config/skills') return { skills: [{ name: 'plan', scope: 'project' }] };
    throw new Error('unexpected fixture request');
  });
  const factory = componentClosures('new-session-page.tsx', 'NativeNewSessionStarters', 'load, loadCatalog, persist, startDrag, moveDrag, finishDrag, cancelDrag, global, project, items, options, refs, drag, error, loading, catalogBusy, saving', { ...basePorts, captureHostRequest: () => request });
  const api = factory({ owner: { project: { id: 'root', path: '/workspace/root' }, directory: '/workspace/root/worktree', current: () => sameHost }, active: () => active, visible: () => true, onSubmit: vi.fn() });
  return { api, request, files, location, settings: () => settings, setActive: (next: boolean) => { active = next; }, switchHost: () => { sameHost = false; }, handle: (next: typeof handler) => { handler = next; } };
}
afterEach(() => vi.useRealTimers());

describe('native picker AX container props contract (source only, not UIKit)', () => {
  function picker(file = 'new-session-models.tsx', name = 'NativeNewSessionModels') {
    const source = ts.createSourceFile(file, readFileSync(path.join(directory, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
    const returned = declaration.body!.statements.find(ts.isReturnStatement)!.expression!;
    const element = ts.isConditionalExpression(returned) ? returned.whenTrue : returned;
    if (!ts.isJsxElement(element)) throw new Error('Expected the production picker root element');
    return { source, declaration, returned, element, root: element.openingElement };
  }
  function propsOf(attributes: ts.JsxAttributes, source: ts.SourceFile, ports: Record<string, unknown>) {
    return Object.fromEntries(attributes.properties.map(attribute => {
      if (!ts.isJsxAttribute(attribute)) throw new Error('Picker contract must inspect spread props explicitly');
      const initializer = attribute.initializer;
      const value = !initializer ? true : ts.isStringLiteral(initializer) ? initializer.text
        : ts.isJsxExpression(initializer) && initializer.expression
          ? new Function(...Object.keys(ports), `return (${initializer.expression.getText(source)});`)(...Object.values(ports)) : undefined;
      return [attribute.name.getText(source), value];
    }));
  }
  it.each(['model', 'agent'] as const)('%s keeps its localized group label without merging or hiding child controls', mode => {
    const { source, root } = picker();
    expect(root.tagName.getText(source)).toBe('View');
    const t = vi.fn((key: string) => key);
    expect(propsOf(root.attributes, source, { props: { mode }, t })).toEqual({
      class: 'flex-1 gap-2', role: 'group', accessible: false,
      accessibilityLabel: mode === 'model' ? 'chat.modelControls.selectModel' : 'chat.modelControls.selectAgent',
    });
    expect(t).toHaveBeenCalledTimes(1);
  });
  it.each(['model', 'agent'] as const)('embedded Chat %s keeps its label and real content without merging child controls', tab => {
    const { source, root, element } = picker('chat-models.tsx', 'ChatModels');
    expect(root.tagName.getText(source)).toBe('View');
    expect(propsOf(root.attributes, source, { tab, t: (key: string) => key })).toEqual({
      class: 'flex-1 bg-background', role: 'group', accessible: false,
      accessibilityLabel: tab === 'model' ? 'chat.modelControls.selectModel' : 'chat.modelControls.selectAgent',
    });
    expect(element.children.filter(ts.isJsxExpression).map(child => child.getText(source))).toEqual(['{content}']);
  });
  it('keeps the standalone Chat picker NavPage title and content unchanged', () => {
    const { source, returned } = picker('chat-models.tsx', 'ChatModels');
    if (!ts.isConditionalExpression(returned) || !ts.isJsxElement(returned.whenFalse)) throw new Error('Expected the standalone picker page');
    expect(returned.condition.getText(source)).toBe('props.embedded');
    expect(returned.whenFalse.openingElement.tagName.getText(source)).toBe('NavPage');
    expect(propsOf(returned.whenFalse.openingElement.attributes, source, { tab: 'agent', t: (key: string) => key })).toEqual({ title: 'chat.modelControls.selectAgent', class: 'flex-1 bg-background' });
    expect(returned.whenFalse.children.filter(ts.isJsxExpression).map(child => child.getText(source))).toEqual(['{content}']);
  });
  it('retains search, Agent, model, favorite and variant testIDs on the real Input/Button controls', () => {
    const { source, declaration } = picker(), controls: Array<[string, string]> = [];
    const ports = { prefix: 'favorite', entry: { providerID: 'fixture', modelID: 'gpt-model' }, variant: () => 'low', agent: () => ({ name: 'build' }), group: () => ({ providerID: 'fixture' }), text: model.text };
    function visit(node: ts.Node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const attribute = node.attributes.properties.find((value): value is ts.JsxAttribute => ts.isJsxAttribute(value) && value.name.getText(source) === 'testID');
        if (attribute) {
          controls.push([node.tagName.getText(source), propsOf(ts.factory.createJsxAttributes([attribute]), source, ports).testID]);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(declaration);
    expect(controls).toEqual([
      ['Button', 'new-session-favorite-model-fixture-gpt-model'],
      ['Button', 'new-session-effort-favorite-fixture-gpt-model'],
      ['Button', 'new-session-favorite-favorite-fixture-gpt-model'],
      ['Input', 'new-session-selection-search'], ['Button', 'new-session-search-clear'], ['Button', 'new-session-catalog-retry'],
      ['Button', 'new-session-selection-default'], ['Button', 'new-session-provider-fixture'],
      ['Button', 'new-session-agent-build'],
    ]);
  });
});

describe('new-session composer selection notification (no native engine)', () => {
  it('forwards the optional callback unchanged at the production Page → Body boundary', () => {
    const source = ts.createSourceFile('new-session-page.tsx', readFileSync(path.join(directory, 'new-session-page.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const callbacks: string[] = [];
    function visit(node: ts.Node) {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'NewSessionBody') {
        for (const attribute of node.attributes.properties) if (ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'onSelection') callbacks.push(attribute.initializer?.getText(source) ?? '');
      }
      ts.forEachChild(node, visit);
    }
    visit(source); expect(callbacks).toEqual(['{props.onSelection}']);
  });

  function notification(directory = '/fixture/project', initial: { model?: { providerID: string; id: string; variant?: string }; agent?: string } = {}) {
    let active = true, currentHost = true, switching = false, selection = initial;
    const effects: Array<() => void> = [], cleanups: Array<() => void> = [];
    const publish = vi.fn(), request = vi.fn(() => { throw new Error('Notification must not request'); });
    const draft = vi.fn(() => { throw new Error('Notification must not read draft'); });
    const readSelection = vi.fn(() => selection);
    const untracked = vi.fn((work: () => void) => work());
    const factory = componentClosures('new-session-page.tsx', 'NewSessionBody', '', {
      ...basePorts, captureHostRequest: () => request, untracked, effect: (work: () => void) => effects.push(work), cleanup: (work: () => void) => cleanups.push(work), createNativeReferenceKeyboard: () => ({}),
    });
    factory({ ownership: { owner: { directory, current: () => currentHost, selection: readSelection, durable: { draft } } }, active: () => active, switching: () => switching, onSelection: publish });
    return { run: effects[0], dispose: cleanups[0], publish, request, draft, readSelection, untracked,
      select: (next: typeof initial) => { selection = next; }, active: (next: boolean) => { active = next; }, switchHost: () => { currentHost = false; }, switching: (next: boolean) => { switching = next; } };
  }

  it('publishes only the real model/variant with its directory; empty model explicitly clears the old choice', () => {
    const fixture = notification(); fixture.run();
    expect(fixture.publish.mock.calls).toEqual([['/fixture/project', undefined, undefined]]);
    fixture.select({ agent: 'plan', model: { providerID: 'fixture', id: 'gpt-model', variant: 'high' } }); fixture.run();
    expect(fixture.publish).toHaveBeenLastCalledWith('/fixture/project', { providerID: 'fixture', modelID: 'gpt-model', variant: 'high' }, 'plan');
    fixture.select({ agent: 'build' }); fixture.run();
    expect(fixture.publish).toHaveBeenLastCalledWith('/fixture/project', undefined, 'build');
    expect(fixture.request).not.toHaveBeenCalled(); expect(fixture.draft).not.toHaveBeenCalled();
    expect(fixture.untracked).toHaveBeenCalledTimes(3);
  });

  it('50 identical/unrelated updates publish nothing; actual Agent/variant changes notify without reading drafts or server data', () => {
    const model = { providerID: 'fixture', id: 'gpt-model', variant: 'low' };
    const fixture = notification('/fixture/project', { model, agent: 'plan' }); fixture.run();
    for (let index = 0; index < 50; index++) { fixture.select({ model: { ...model }, agent: 'plan' }); fixture.run(); }
    expect(fixture.publish).toHaveBeenCalledTimes(1); expect(fixture.draft).not.toHaveBeenCalled(); expect(fixture.request).not.toHaveBeenCalled();
    fixture.select({ model: { ...model, variant: 'high' }, agent: 'plan' }); fixture.run(); expect(fixture.publish).toHaveBeenCalledTimes(2);
    fixture.select({ model: { ...model, variant: 'high' }, agent: 'build' }); fixture.run();
    expect(fixture.publish).toHaveBeenCalledTimes(3);
    expect(fixture.publish).toHaveBeenLastCalledWith('/fixture/project', { providerID: 'fixture', modelID: 'gpt-model', variant: 'high' }, 'build');
  });

  it('new directory publishes an empty choice without inheriting the previous directory model; retired Host/body cannot publish late', () => {
    const previous = notification('/fixture/project', { model: { providerID: 'fixture', id: 'gpt-model' } }); previous.run();
    previous.active(false); previous.run(); previous.select({ model: { providerID: 'stale', id: 'late' } }); previous.run();
    const next = notification('/fixture/other'); next.run(); expect(next.publish).toHaveBeenLastCalledWith('/fixture/other', undefined, undefined);
    previous.active(true); previous.switchHost(); previous.run(); expect(previous.publish).toHaveBeenCalledTimes(1);
    next.dispose(); next.select({ model: { providerID: 'stale', id: 'disposed' } }); next.run(); expect(next.publish).toHaveBeenCalledTimes(1);
  });

  it('hidden/switching owners do not even read selection; activation republishes the actual choice', () => {
    const fixture = notification('/fixture/project', { model: { providerID: 'fixture', id: 'gpt-model' } });
    fixture.active(false); fixture.run(); fixture.active(true); fixture.switching(true); fixture.run();
    expect(fixture.readSelection).not.toHaveBeenCalled(); expect(fixture.publish).not.toHaveBeenCalled();
    fixture.switching(false); fixture.run(); fixture.active(false); fixture.run(); fixture.active(true); fixture.run();
    expect(fixture.publish).toHaveBeenCalledTimes(2);
  });
});

describe('production starter persistence closures (no native engine)', () => {
  it('hydrates global and project pins independently and resolves custom catalogs for persisted refs', async () => {
    const fixture = starters(); fixture.files.set(fixture.location.path, JSON.stringify({ draftStarters: [{ type: 'skill', name: 'plan' }] }));
    await fixture.api.load();
    expect(fixture.api.items().map((item: helpers.StarterItem) => item.submitText)).toEqual(['/explore', '/weigh', '@plan']);
    expect(fixture.request.mock.calls.some(([url]) => url === '/api/config/skills?summary=true&directory=%2Fworkspace%2Froot%2Fworktree')).toBe(true);
    expect(fixture.request.mock.calls.some(([url, method]) => method === 'PUT' || url === '/api/fs/write')).toBe(false);
  });
  it('plus catalog offers scoped existing commands/skills, not synthetic presets', async () => {
    const fixture = starters(); await fixture.api.load(); await fixture.api.loadCatalog();
    expect(fixture.api.options().map((item: helpers.StarterOption) => [item.ref.name, item.group])).toContainEqual(['plan', 'project']);
    expect(fixture.api.options().map((item: helpers.StarterOption) => [item.ref.name, item.group])).toContainEqual(['craft-goal', 'global']);
    expect(fixture.api.options().some((item: helpers.StarterOption) => item.ref.name === 'explore')).toBe(false);
  });
  it('adds user pins by a narrow settings patch, preserving unrelated preferences', async () => {
    const fixture = starters(); await fixture.api.load();
    await fixture.api.persist('global', (refs: helpers.DraftStarterRef[]) => [...refs, { type: 'command', name: 'craft-goal' }]);
    const write = fixture.request.mock.calls.find(([, method]) => method === 'PUT');
    expect(Object.keys(model.record(write?.[2]))).toEqual(['draftStarters']);
    expect(fixture.settings().keep).toBe(true);
    expect(fixture.api.global().at(-1)).toEqual({ type: 'command', name: 'craft-goal' });
  });
  it('persists project pins by project root, not worktree, preserving server-owned and unrelated fields', async () => {
    const fixture = starters(); fixture.files.set(fixture.location.path, JSON.stringify({ projectPath: '/workspace/root', version: 7, scheduledTasks: [{ id: 'retain' }], projectActions: [{ id: 'action' }] }));
    await fixture.api.load();
    await fixture.api.persist('project', () => [{ type: 'skill', name: 'plan' }]);
    expect(JSON.parse(fixture.files.get(fixture.location.path)!)).toEqual({ projectPath: '/workspace/root', version: 7, scheduledTasks: [{ id: 'retain' }], projectActions: [{ id: 'action' }], draftStarters: [{ type: 'skill', name: 'plan' }] });
    expect(fixture.request.mock.calls.some(([, method]) => method === 'PUT')).toBe(false);
  });
  it('reads a legacy project config without mutating on hydration; explicit pinning writes the canonical location', async () => {
    const fixture = starters(); fixture.files.set(fixture.location.legacy, JSON.stringify({ draftStarters: [], 'setup-worktree': ['keep'] }));
    await fixture.api.load(); expect(fixture.files.has(fixture.location.path)).toBe(false);
    await fixture.api.persist('project', () => [{ type: 'command', name: 'weigh' }]);
    expect(JSON.parse(fixture.files.get(fixture.location.path)!)['setup-worktree']).toEqual(['keep']);
    expect(fixture.files.has(fixture.location.legacy)).toBe(true);
  });
  it('does not replace a valid pin snapshot with authoritative empty on refresh failure', async () => {
    const fixture = starters(); await fixture.api.load(); const previous = fixture.api.global();
    fixture.handle(() => { throw new Error('offline'); }); await fixture.api.load();
    expect(fixture.api.global()).toBe(previous); expect(fixture.api.error()).toBeTruthy(); expect(fixture.api.loading()).toBe(false);
  });
  it('keeps the previous snapshot after failed writes, and never overwrites malformed project content', async () => {
    const fixture = starters(); await fixture.api.load(); const previous = fixture.api.global();
    fixture.handle((_url, method) => method === 'GET' ? fixture.settings() : Promise.reject(new Error('write-failed')));
    await fixture.api.persist('global', () => []); expect(fixture.api.global()).toBe(previous); expect(fixture.api.error()).toBeTruthy();
    fixture.handle(undefined); fixture.files.set(fixture.location.path, '{malformed');
    const writes = fixture.request.mock.calls.filter(([url]) => url === '/api/fs/write').length;
    await fixture.api.persist('project', () => []);
    expect(fixture.request.mock.calls.filter(([url]) => url === '/api/fs/write')).toHaveLength(writes);
    expect(fixture.files.get(fixture.location.path)).toBe('{malformed');
  });
  it('fences Host switches between fresh preference read and write', async () => {
    const fixture = starters(); await fixture.api.load();
    let resolve!: (value: unknown) => void;
    fixture.handle(() => new Promise(done => { resolve = done; }));
    const pending = fixture.api.persist('global', () => []); fixture.switchHost(); resolve({ draftStarters: [] }); await pending;
    expect(fixture.request.mock.calls.some(([, method]) => method === 'PUT')).toBe(false);
    expect(fixture.api.saving()).toBe(false);
  });
});

describe('production raw-touch drag closures (geometry fixture only)', () => {
  async function dragFixture() {
    const fixture = starters(); await fixture.api.load();
    const ids = fixture.api.items().map((item: helpers.StarterItem) => item.id);
    for (const [id, x, width] of [[ids[0], 0, 80], [ids[1], 82, 100], [helpers.STARTER_TRASH, 220, 24]] as const) fixture.api.refs.set(id, { measure: async () => ({ pagePosition: { x, y: 0 }, bounds: { size: { width, height: 28 } } }) });
    return fixture;
  }
  it('activates after a real 200ms hold, translates, and removes only the dropped source pin in the plus-slot trash', async () => {
    vi.useFakeTimers(); const fixture = await dragFixture(); const source = fixture.api.items()[0];
    fixture.api.startDrag(source, 40, 14); vi.advanceTimersByTime(199); await flush(); expect(fixture.api.drag()).toBeNull();
    vi.advanceTimersByTime(1); await flush(); expect(fixture.api.drag().id).toBe(source.id);
    fixture.api.moveDrag(232, 14, 1); expect(fixture.api.drag().over).toBe(helpers.STARTER_TRASH);
    fixture.api.finishDrag(); await flush(); expect(fixture.api.global()).toEqual([{ type: 'command', name: 'weigh' }]);
    fixture.api.finishDrag(); await flush(); expect(fixture.request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(1);
  });
  it('reorders on release, never while moving, and uses the latest persisted collection', async () => {
    vi.useFakeTimers(); const fixture = await dragFixture(); fixture.api.startDrag(fixture.api.items()[0], 40, 14); vi.advanceTimersByTime(200); await flush();
    fixture.api.moveDrag(132, 14, 1); expect(fixture.request.mock.calls.some(([, method]) => method === 'PUT')).toBe(false);
    fixture.api.finishDrag(); await flush(); expect(fixture.api.global().map((ref: helpers.DraftStarterRef) => ref.name)).toEqual(['weigh', 'explore']);
  });
  it('reuses sibling shift geometry for 50 moves within the same target; movement never enumerates catalogs', async () => {
    vi.useFakeTimers(); const fixture = await dragFixture(); fixture.api.startDrag(fixture.api.items()[0], 40, 14); vi.advanceTimersByTime(200); await flush();
    fixture.api.moveDrag(132, 14, 1); const shifts = fixture.api.drag().shifts, reads = fixture.request.mock.calls.length;
    for (let index = 0; index < 50; index++) { fixture.api.moveDrag(130 + index % 4, 14, 1); expect(fixture.api.drag().shifts).toBe(shifts); }
    expect(fixture.request).toHaveBeenCalledTimes(reads);
  });
  it('quick swipe, multi-touch and cancellation never mutate pins', async () => {
    vi.useFakeTimers(); const fixture = await dragFixture();
    fixture.api.startDrag(fixture.api.items()[0], 40, 14); fixture.api.moveDrag(47, 14, 1); vi.advanceTimersByTime(200); await flush(); expect(fixture.api.drag()).toBeNull();
    fixture.api.startDrag(fixture.api.items()[0], 40, 14); vi.advanceTimersByTime(200); await flush(); fixture.api.moveDrag(232, 14, 2); fixture.api.finishDrag(); await flush();
    expect(fixture.request.mock.calls.some(([, method]) => method === 'PUT')).toBe(false);
  });
});

describe('production favorite closures (no native engine)', () => {
  function models() {
    let current = true, settings: model.Row = { favoriteModels: [], recentModels: [{ providerID: 'p', modelID: 'other', variant: 'low' }], keep: true };
    let handler: ((method: string, body: unknown) => unknown) | undefined;
    const preferences = signal(settings), load = vi.fn(async () => { preferences.set(settings); });
    const catalog = { load, dispose: () => {}, preferences, agents: signal([]), providers: signal([]), busy: signal(false), error: signal(''), resolved: signal(true) };
    const select = vi.fn(async () => {}), selection = { agent: 'build', model: { providerID: 'p', id: 'current', variant: 'high' } };
    const request = vi.fn(async (_url: string, method = 'GET', body?: unknown) => {
      if (handler) return handler(method, body);
      if (method === 'PUT') settings = { ...settings, ...model.record(body) };
      return settings;
    });
    const factory = componentClosures('new-session-models.tsx', 'NativeNewSessionModels', 'toggleFavorite, choose, retry, saving, error, favorite, resolveVariant, displayVariant', { ...basePorts, createNewSessionCatalog: () => catalog, captureHostRequest: () => request, newSessionText: (key: string) => key });
    const onDone = vi.fn();
    const api = factory({ owner: { directory: '/workspace/root', current: () => current, selection: () => selection, select }, mode: 'model', active: () => true, onDone });
    return { api, request, select, preferences, load, onDone, settings: () => settings, switchHost: () => { current = false; }, handle: (next: typeof handler) => { handler = next; } };
  }
  it('toggles the shared favorite setting without selecting a model, closing the Sheet, or touching recents', async () => {
    const fixture = models(); await flush();
    await fixture.api.toggleFavorite({ providerID: 'p', modelID: 'current' });
    expect(fixture.request.mock.calls.map(([, method, body]) => [method, body])).toEqual([
      [undefined, undefined], ['PUT', { favoriteModels: [{ providerID: 'p', modelID: 'current', variant: 'high' }] }],
    ]);
    expect(fixture.api.favorite({ providerID: 'p', modelID: 'current' })).toBe(true);
    expect(fixture.settings().recentModels).toEqual([{ providerID: 'p', modelID: 'other', variant: 'low' }]);
    expect(fixture.select).not.toHaveBeenCalled();
    await fixture.api.toggleFavorite({ providerID: 'p', modelID: 'current' });
    expect(fixture.settings().favoriteModels).toEqual([]);
  });
  it('keeps the last valid favorite view after failed writes; refresh retries reading rather than replaying the toggle', async () => {
    const fixture = models(); await flush(); const previous = fixture.preferences();
    fixture.handle(method => method === 'GET' ? fixture.settings() : Promise.reject(new Error('unconfirmed-write')));
    await fixture.api.toggleFavorite({ providerID: 'p', modelID: 'current' });
    expect(fixture.preferences()).toBe(previous); expect(fixture.api.error()).toBeTruthy(); expect(fixture.api.saving()).toBe(false);
    await fixture.load('model');
    expect(fixture.request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(1);
  });
  it('rejects malformed settings and fences a Host switch before favorite writes', async () => {
    const fixture = models(); await flush(); fixture.handle(() => null);
    await fixture.api.toggleFavorite({ providerID: 'p', modelID: 'current' }); expect(fixture.request.mock.calls.some(([, method]) => method === 'PUT')).toBe(false);
    let resolve!: (value: unknown) => void;
    fixture.handle(() => new Promise(done => { resolve = done; }));
    const pending = fixture.api.toggleFavorite({ providerID: 'p', modelID: 'current' }); fixture.switchHost(); resolve({ favoriteModels: [] }); await pending;
    expect(fixture.request.mock.calls.some(([, method]) => method === 'PUT')).toBe(false);
  });
  it('saves the local selection once then retries only recents; never creates or configures a session', async () => {
    const fixture = models(); await flush();
    let failed = false;
    fixture.handle((method, body) => {
      if (method === 'PUT' && !failed) { failed = true; throw new Error('recent-failed'); }
      return { ...fixture.settings(), ...model.record(body) };
    });
    await fixture.api.choose({ providerID: 'p', modelID: 'next' }, 'high');
    expect(fixture.select).toHaveBeenCalledExactlyOnceWith({ agent: 'build', model: { providerID: 'p', id: 'next', variant: 'high' } });
    expect(fixture.api.error()).toBeTruthy(); expect(fixture.onDone).not.toHaveBeenCalled();
    await fixture.api.choose({ providerID: 'p', modelID: 'wrong' });
    await fixture.api.toggleFavorite({ providerID: 'p', modelID: 'wrong' });
    expect(fixture.select).toHaveBeenCalledTimes(1);
    await fixture.api.retry();
    expect(fixture.select).toHaveBeenCalledTimes(1); expect(fixture.onDone).toHaveBeenCalledOnce();
    expect(fixture.preferences().recentModels[0]).toEqual({ providerID: 'p', modelID: 'next', variant: 'high' });
    expect(fixture.request.mock.calls.every(([url]) => url === '/api/config/settings')).toBe(true);
  });
  it('uses the default variant for provider rows, remembered only for recent/favorite clicks, and live for current display', async () => {
    const fixture = models(); await flush();
    fixture.preferences.set({ defaultVariant: 'low', recentModels: [{ providerID: 'p', modelID: 'other', variant: 'high' }] });
    const entry = { providerID: 'p', modelID: 'other', provider: {}, model: { variants: { low: {}, high: {} } } };
    expect(fixture.api.resolveVariant(entry)).toBe('low');
    expect(fixture.api.resolveVariant(entry, true)).toBe('high');
    expect(fixture.api.displayVariant({ ...entry, modelID: 'current', variant: 'low' }, 'recent')).toBe('high');
  });
});
