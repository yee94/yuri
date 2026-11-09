import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopGitOwnerRegistration } from './desktop-git-dispatch-owner';
import type { NativeNewSessionPageProps } from './new-session-page';

const h = vi.hoisted(() => ({ storage: new Map<string, string>(), get: vi.fn(), set: vi.fn(), call: vi.fn(),
  effects: [] as Array<() => void>, stops: [] as Array<() => void>, cleanups: [] as Array<() => void> }));
const source = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); };
vi.mock('nsh', () => ({
  batch: <T>(work: () => T) => work(), untracked: <T>(work: () => T) => work(),
  signal: <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); },
  Storage: { getItem: h.get, setItem: h.set }, lifecycle: () => 'active',
  effect: (work: () => void | (() => void)) => { h.effects.push(work); const stop = work(); if (stop) h.stops.push(stop); },
  cleanup: (work: () => void) => h.cleanups.push(work), host: { available: () => true, call: h.call, on: () => () => {} },
}));
const connection = { id: 'host', url: 'https://host.example', authorizationID: 'auth-a', label: 'Host', lastUsedAt: 0 };
const directory = path.dirname(fileURLToPath(import.meta.url));
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const runEffects = () => h.effects.slice().forEach(work => work());
type Ownership = ReturnType<(typeof import('./new-session'))['createNativeNewSessionOwnership']>;
let owners: Ownership[];
const requests = () => h.call.mock.calls.filter(([name]) => name === 'runtime.request');
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); h.storage.clear(); h.effects = []; h.stops = []; h.cleanups = []; owners = [];
  h.get.mockReset().mockImplementation(async (key: string) => h.storage.get(key) ?? null);
  h.set.mockReset().mockImplementation(async (key: string, value: string) => { h.storage.set(key, value); });
  h.call.mockReset().mockImplementation(async name => name === 'connection.list' ? { connections: [connection], selected: 'host', runtimeScope: { hostID: 'host', lease: 'lease-a' } } : true);
  await (await import('./state')).loadConnections();
});
afterEach(async () => { h.stops.forEach(stop => stop()); h.cleanups.forEach(stop => stop()); await Promise.allSettled(owners.map(entry => entry.disposePage())); await flush(); vi.useRealTimers(); });

/** Execute the actual page's ownership callbacks, omitting only its JSX/body render. */
async function page(desktop: boolean, overrides: Partial<NativeNewSessionPageProps> = {}) {
  const api = await import('./new-session'), state = await import('./state');
  const sourceFile = ts.createSourceFile('new-session-page.tsx', readFileSync(path.join(directory, 'new-session-page.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = sourceFile.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'NativeNewSessionPage')!;
  const statements: string[] = [];
  for (const statement of declaration.body!.statements) {
    if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === 'content')) break;
    statements.push(statement.getText(sourceFile));
  }
  const slotDeclaration = sourceFile.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'NewSessionOwnershipSlot')!;
  const js = ts.transpileModule(`function component(props) { ${statements.join('\n')}; return { ownership, creation, adoptOwner, retireOwner, current, changeProject, open, switching }; } ${slotDeclaration.getText(sourceFile)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const active = source(true), callbacks: Array<() => void> = [], events: DesktopGitOwnerRegistration[] = [];
  let cleanupTarget = callbacks;
  const publish = vi.fn((event: DesktopGitOwnerRegistration) => events.push(event));
  const props = { directory: '/repo', get active() { return active(); }, onOpenChat: vi.fn(), onDesktopOwner: publish, ...overrides };
  const ports = { signal: source, platform: { desktop }, lifecycle: () => 'active', app: state.app, desktopGitDraftAuthority: api.desktopGitDraftAuthority,
    createNativeNewSessionOwnership: (...args: Parameters<typeof api.createNativeNewSessionOwnership>) => { const entry = api.createNativeNewSessionOwnership(...args); owners.push(entry); return entry; },
    effect: (work: () => void) => { h.effects.push(work); work(); }, untracked: <T>(work: () => T) => work(), cleanup: (work: () => void) => cleanupTarget.push(work),
    t: (key: string) => key, newSessionText: (key: string) => key };
  type Intent = Parameters<typeof api.createNativeNewSessionOwnership>[0];
  const implementation = new Function(...Object.keys(ports), `${js}; return { component, slot: NewSessionOwnershipSlot };`)(...Object.values(ports)) as {
    component: (props: NativeNewSessionPageProps) => { ownership: () => Ownership; creation: () => Intent | null; adoptOwner: (entry: Ownership, intent: Intent) => void; retireOwner: (entry: Ownership) => void; changeProject: (project: undefined, directory: string) => Promise<void>; switching: () => boolean };
    slot: (props: { intent: Intent; onReady: (entry: Ownership) => void; onRetire: (entry: Ownership) => void; onError: () => void; children: () => null }) => null;
  };
  const result = implementation.component(props), slotCleanups: Array<() => void> = [];
  let mounted = true, mountedIntent: Intent | null = null;
  const renderSlot = () => {
    if (!mounted || result.creation() === mountedIntent) return;
    slotCleanups.splice(0).forEach(work => work()); mountedIntent = result.creation();
    if (!mountedIntent) return;
    const intent = mountedIntent;
    cleanupTarget = slotCleanups;
    try { implementation.slot({ intent, onReady: entry => result.adoptOwner(entry, intent), onRetire: result.retireOwner, onError: () => {}, children: () => null }); }
    finally { cleanupTarget = callbacks; }
  };
  h.effects.push(renderSlot); renderSlot(); await result.ownership()?.owner.ready; runEffects();
  return { ...result, active, props, publish, events, unmount: () => { mounted = false; callbacks.splice(0).forEach(work => work()); slotCleanups.splice(0).forEach(work => work()); } };
}

describe('production new-session page desktop Git owner publication', () => {
  it('defaults desktop to stable authority, publishes only active actual owner, retires exact owner and stays quiet while typing', async () => {
    const fixture = await page(true), owner = fixture.ownership().owner;
    const { desktopGitDraftAuthority } = await import('./desktop-git-dispatch');
    expect(owner.draftAuthorityKey).toBe(desktopGitDraftAuthority(connection)); expect(fixture.events).toEqual([{ type: 'register', owner }]);
    for (let i = 0; i < 200; i++) { owner.setDraftText(`edit ${i}`); runEffects(); }
    expect(fixture.events).toHaveLength(1); expect(requests()).toEqual([]);
    fixture.active.set(false); runEffects(); expect(fixture.events.at(-1)).toEqual({ type: 'retire', owner });
    fixture.active.set(true); runEffects(); expect(fixture.events.at(-1)).toEqual({ type: 'register', owner });
    fixture.unmount(); expect(fixture.events.at(-1)).toEqual({ type: 'retire', owner }); runEffects(); expect(fixture.events).toHaveLength(4);
  });
  it('keeps iOS old Host-only draft/receipt keys and never publishes desktop owner', async () => {
    const { openDraft, draftKey } = await import('./drafts'); const target = { kind: 'session' as const, id: 'new-session-draft', directory: '/repo', title: '' };
    const prior = openDraft('host', target); await prior.ready; prior.setDraftText('old iOS draft'); await prior.close();
    const fixture = await page(false), owner = fixture.ownership().owner;
    expect(owner.draftAuthorityKey).toBeUndefined(); expect(owner.durable.key).toBe(draftKey('host', target)); expect(owner.durable.draft()).toBe('old iOS draft'); expect(fixture.events).toEqual([]); fixture.unmount();
  });
  it('forwards captured route context but does not stage/overwrite a restored draft or create/send', async () => {
    const { desktopGitDraftAuthority, desktopGitContextInput } = await import('./desktop-git-dispatch');
    const initialContext = desktopGitContextInput({ scope: { host: { hostID: 'host', lease: 'lease-a' }, authorityKey: desktopGitDraftAuthority(connection), directory: '/repo', sessionID: null }, directory: '/repo', target: 'new', kind: 'conflict', visibleText: 'captured visible', instructionsText: 'hidden instructions', payload: { diff: 'captured diff' } });
    const fixture = await page(true, { initialContext }), owner = fixture.ownership().owner;
    expect(fixture.events).toEqual([{ type: 'register', owner, initialContext }]); expect(owner.durable.draft()).toBe(''); expect(owner.context()).toBeUndefined();
    owner.setDraftText('existing user work'); const result = await owner.stageContext(initialContext);
    expect(result.status).toBe('requires-confirmation'); expect(owner.durable.draft()).toBe('existing user work');
    if (result.status !== 'requires-confirmation') throw new Error('missing confirmation');
    expect(await owner.stageContext(initialContext, result.confirmation)).toEqual({ status: 'staged' }); expect(owner.durable.draft()).toBe('captured visible'); expect(requests()).toEqual([]); fixture.unmount();
  });
  it('inactive mounted pages cannot supersede an active publisher; late retire remains exact-owner CAS', async () => {
    let selected: Ownership['owner'] | null = null;
    const publish = (event: DesktopGitOwnerRegistration) => { if (event.type === 'register' && event.owner.current()) selected = event.owner; else if (event.type === 'retire' && selected === event.owner) selected = null; };
    const first = await page(true, { onDesktopOwner: publish }); const second = await page(true, { active: false, directory: '/repo', onDesktopOwner: publish });
    expect(second.ownership()).toBeNull(); expect(first.ownership().owner.current()).toBe(true);
    expect(selected).toBe(first.ownership().owner); second.unmount(); expect(selected).toBe(first.ownership().owner); first.unmount(); expect(selected).toBeNull();
  });
  it('reactivating a retained root reacquires the same scoped durable draft after an active route owned it', async () => {
    const first = await page(true), prior = first.ownership().owner; prior.setDraftText('root draft'); await prior.durable.flush();
    first.active.set(false); runEffects();
    const route = await page(true), routeOwner = route.ownership().owner; expect(routeOwner.durable.draft()).toBe('root draft');
    routeOwner.setDraftText('route edit'); await routeOwner.durable.flush(); route.unmount();
    first.active.set(true); runEffects(); const restored = first.ownership().owner; await restored.ready; runEffects();
    expect(restored).not.toBe(prior); expect(restored.current()).toBe(true); expect(restored.durable.draft()).toBe('route edit'); expect(first.events.at(-1)).toEqual({ type: 'register', owner: restored }); first.unmount();
  });
  it('directory intent fires synchronously once after admission, before flush await; failed persistence still wins over startup restore', async () => {
    const intent = vi.fn(); const fixture = await page(true, { onUserIntent: intent }), owner = fixture.ownership().owner;
    expect(intent).not.toHaveBeenCalled(); owner.setDraftText('dirty'); expect(intent).not.toHaveBeenCalled();
    h.set.mockRejectedValueOnce(new Error('storage unavailable')); const changing = fixture.changeProject(undefined, '/other');
    expect(intent).toHaveBeenCalledTimes(1); expect(fixture.switching()).toBe(true);
    await fixture.changeProject(undefined, '/third'); expect(intent).toHaveBeenCalledTimes(1);
    await changing; expect(fixture.ownership().owner).toBe(owner); expect(owner.directory).toBe('/repo'); expect(intent).toHaveBeenCalledTimes(1);
    fixture.active.set(false); await fixture.changeProject(undefined, '/other'); expect(intent).toHaveBeenCalledTimes(1); fixture.unmount();
  });
  it('the real Input onChange vetoes delayed startup restore synchronously before any edit work; 200 events do no JSON, Storage or catalog work', async () => {
    const fixture = await page(true), owner = fixture.ownership().owner;
    const parsed = ts.createSourceFile('new-session-page.tsx', readFileSync(path.join(directory, 'new-session-page.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let handler: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) && node.attributes.properties.some(attr => ts.isJsxAttribute(attr) && attr.name.getText(parsed) === 'testID' && attr.initializer && ts.isStringLiteral(attr.initializer) && attr.initializer.text === 'new-session-composer')) {
        const prop = node.attributes.properties.find(attr => ts.isJsxAttribute(attr) && attr.name.getText(parsed) === 'onChange') as ts.JsxAttribute;
        handler = (prop.initializer as ts.JsxExpression).expression;
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed); expect(handler).toBeDefined();
    const js = ts.transpileModule(`const handler = ${handler!.getText(parsed)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    let superseded = false;
    const intent = vi.fn(() => { superseded = true; }), beforeChange = vi.fn(() => { expect(superseded).toBe(true); });
    const keyboard = { beforeChange, refresh: vi.fn() }, mode = source<'normal' | 'shell'>('normal');
    const change = new Function('current', 'userIntent', 'keyboard', 'owner', 'mode', `${js}; return handler;`)(() => fixture.active(), intent, keyboard, owner, mode) as (event: { value: string }) => void;
    h.get.mockClear(); h.set.mockClear(); const json = vi.spyOn(JSON, 'stringify');
    for (let index = 0; index < 200; index++) change({ value: `user ${index}` });
    expect(intent).toHaveBeenCalledTimes(200); expect(beforeChange).toHaveBeenCalledTimes(200); expect(json).not.toHaveBeenCalled(); json.mockRestore();
    expect(owner.durable.draft()).toBe('user 199'); expect(h.get).not.toHaveBeenCalled(); expect(h.set).not.toHaveBeenCalled(); expect(requests()).toEqual([]);
    fixture.active.set(false); change({ value: 'late native event' }); expect(intent).toHaveBeenCalledTimes(200); expect(owner.durable.draft()).toBe('user 199'); fixture.unmount();
  });
});
