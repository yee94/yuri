import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { changesWriteJournal, createChangesActions } from './chat-changes-actions';
import { createChangesDraft, createChangesGeneration } from './chat-changes-generation';
import { changeGroups, changesSnapshot, createChangesReader } from './chat-changes-model';
import * as searchModel from './projects-search-core';
import * as pickerModel from './chat-models-helpers';
import * as draftModel from './new-session-ui-helpers';
import { inboxFrom, record, unwrap } from './model';

const directory = path.dirname(fileURLToPath(import.meta.url));
const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

// Runs the production owner and its actual async callbacks, not an engine or Host.
// Only the final UI return is replaced with observations of the mounted owner.
function owner(file: string, name: string, observations: string, ports: Record<string, unknown>) {
  const source = ts.createSourceFile(file, readFileSync(path.join(directory, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
  const body = declaration.body!.statements.filter(node => !ts.isReturnStatement(node)).map(node => node.getText(source)).join('\n');
  const parameters = declaration.parameters.map(parameter => parameter.getText(source)).join(', ');
  const output = ts.transpileModule(`function ${name}(${parameters}) { ${body}; return { ${observations} }; }`, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText;
  return new Function(...Object.keys(ports), `${output}; return ${name};`)(...Object.values(ports));
}

function productionFunction(file: string, name: string, ports: Record<string, unknown>) {
  const source = ts.createSourceFile(file, readFileSync(path.join(directory, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
  const output = ts.transpileModule(declaration.getText(source).replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function(...Object.keys(ports), `${output}; return ${name};`)(...Object.values(ports));
}

function boundary(staleStatus?: number) {
  let scope = { hostID: 'A', generation: 1 };
  const accepted: Array<{ hostID: string; generation: number; path: string; method: string; body?: unknown }> = [];
  const rejected: Array<{ hostID: string; generation: number; method: string }> = [];
  let respond: (path: string, method: string, body?: unknown) => unknown = () => ({ success: true });
  const captureHostRequest = vi.fn(() => {
    const captured = Object.freeze({ ...scope });
    return async (path: string, method = 'GET', body?: unknown) => {
      if (captured.hostID !== scope.hostID || captured.generation !== scope.generation) {
        rejected.push({ ...captured, method });
        throw Object.assign(new Error('runtime_stale'), staleStatus === undefined ? {} : { status: staleStatus });
      }
      accepted.push({ ...captured, path, method, ...(body === undefined ? {} : { body }) });
      return respond(path, method, body);
    };
  });
  return { captureHostRequest, accepted, rejected, epoch: () => scope.generation, runtimeScope: () => ({ hostID: scope.hostID, lease: `synthetic-lease-${scope.generation}` }),
    switchHost(hostID: string) { scope = { hostID, generation: scope.generation + 1 }; },
    respond(work: typeof respond) { respond = work; } };
}
const base = { signal, computed: (work: () => unknown) => work, cleanup: () => {}, effect: () => {}, untracked: (work: () => unknown) => work(), t: (key: string) => key };

describe('business production request owners: immutable Host lease (pure, no native bridge)', () => {
  it('migrated production surfaces cannot import the unbound runtime sender as a value', () => {
    const files = ['features.tsx', 'new-session.ts', 'new-session-admission.ts', 'new-session-selection.ts', 'new-session-page.tsx', 'new-session-models.tsx', 'projects.tsx', 'projects-directory.tsx', 'projects-search.tsx', 'assistants.tsx', 'assistants-settings.tsx', 'assistants-details.tsx', 'assistants-channels.tsx', 'schedules.tsx', 'schedules-state.ts', 'task-editor-prompt.tsx', 'chat-models.tsx', 'chat-composer-selection.tsx', 'chat-header.tsx', 'chat-changes.tsx', 'chat-changes-workspace.tsx', 'transcript-actions-core.ts', 'transcript-actions.tsx', 'transcript-tools.tsx', 'transcript-tools-turn.tsx', 'context-usage-route.tsx', 'resources.tsx', 'appearance.tsx', 'speech.tsx'];
    for (const file of files) {
      const source = ts.createSourceFile(file, readFileSync(path.join(directory, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== './runtime') continue;
        const clause = statement.importClause, bindings = clause?.namedBindings;
        if (!clause || clause.isTypeOnly || !bindings || !ts.isNamedImports(bindings)) continue;
        expect(bindings.elements.filter(item => !item.isTypeOnly).map(item => (item.propertyName ?? item.name).text), file).not.toContain('request');
      }
    }
  });

  it.each([false, true])('workspace retained callback rejects after A→B%s, while a replacement owner may write', async returnToA => {
    // This boundary rejects writes before dispatch, a definite 400.
    // Unknown server outcomes remain covered by the production journal tests.
    const b = boundary(400), cleanups: Array<() => void> = [], storage = new Map<string, string>();
    const Storage = { getItem: async (key: string) => storage.get(key) ?? null, setItem: async (key: string, value: string) => { storage.set(key, value); }, removeItem: async (key: string) => { storage.delete(key); } };
    const source = { kind: 'workspace' as const, directory: `/neutral/workspace-return-${returnToA}` };
    const snapshot = changesSnapshot({ isClean: false, files: [{ path: 'safe.ts', index: ' ', working_dir: 'M' }] });
    const newOwner = async () => {
      const reader = createChangesReader(source, async () => snapshot);
      await reader.refresh();
      return { reader, state: reader.state, snapshot: () => reader.state().snapshot, draft: createChangesDraft() };
    };
    b.respond((path, method) => method === 'GET' && path.startsWith('/api/git/remotes?') ? [] : { success: true });
    const confirmation = deferred<{ action: string }>();
    const make = owner('chat-changes-workspace.tsx', 'NativeWorkspaceChanges', 'actions, revert', { ...base, cleanup: (work: () => void) => cleanups.push(work), Storage, app: { runtimeScope: b.runtimeScope }, captureHostRequest: b.captureHostRequest, changesWriteJournal, createChangesActions, createChangesGeneration, changeGroups, AlertDialog: { show: () => confirmation.promise } });
    const writes = () => b.accepted.filter(request => request.method !== 'GET');
    try {
      const initial = await newOwner(), old = make({ owner: initial });
      await changesWriteJournal('A', source.directory, Storage).restore;
      const pending = old.revert(['safe.ts']);
      b.switchHost('B'); if (returnToA) b.switchHost('A');
      confirmation.resolve({ action: 'revert' }); await pending;
      expect(b.captureHostRequest).toHaveBeenCalledTimes(1);
      expect(writes()).toEqual([]);
      expect(b.rejected).toEqual([{ hostID: 'A', generation: 1, method: 'POST' }]);
      expect(old.actions.state().unknown).toBe(false);
      expect(storage.size).toBe(0);
      await old.actions.move(['safe.ts'], false);
      expect(writes()).toEqual([]);
      const next = await newOwner(), replacement = make({ owner: next });
      expect(next.reader).not.toBe(initial.reader); expect(next.draft).not.toBe(initial.draft);
      await changesWriteJournal(b.runtimeScope().hostID, source.directory, Storage).restore;
      expect(await replacement.actions.move(['safe.ts'], false)).toBe(true);
      expect(b.captureHostRequest).toHaveBeenCalledTimes(2);
      expect(writes()).toEqual([expect.objectContaining({ hostID: returnToA ? 'A' : 'B', generation: returnToA ? 3 : 2, method: 'POST' })]);
      expect(b.accepted.filter(request => request.method === 'GET')).toEqual([
        expect.objectContaining({ hostID: 'A', generation: 1, path: `/api/git/remotes?directory=${encodeURIComponent(source.directory)}` }),
        expect.objectContaining({ hostID: returnToA ? 'A' : 'B', generation: returnToA ? 3 : 2, path: `/api/git/remotes?directory=${encodeURIComponent(source.directory)}` }),
      ]);
      b.respond((_path, method) => { if (method === 'POST') throw new Error('Synthetic dispatched response lost'); return []; });
      expect(await replacement.actions.move(['safe.ts'], false)).toBe(false);
      expect(replacement.actions.state().unknown).toBe(true);
      expect([...storage.values()]).toEqual(['pending']);
      const unknown = make({ owner: await newOwner() });
      expect(await unknown.actions.move(['safe.ts'], false)).toBe(false);
      expect(unknown.actions.state().unknown).toBe(true);
      expect(writes()).toHaveLength(2);
      expect([...storage.values()]).toEqual(['pending']);
    } finally { cleanups.reverse().forEach(work => work()); }
  });

  it('new-session favorite GET continuation cannot recapture Host for its PUT after A→B→A', async () => {
    const b = boundary(), read = deferred<unknown>();
    b.respond(() => read.promise);
    const catalog = { providers: signal([]), agents: signal([]), preferences: signal({}), resolved: () => true, busy: () => false, error: () => '', load: vi.fn(async () => {}), setPreferences: vi.fn(), dispose: () => {} };
    const catalogFactory = vi.fn(() => catalog);
    const scopeKey = JSON.stringify(b.runtimeScope()), select = vi.fn(), onDone = vi.fn();
    const make = owner('new-session-models.tsx', 'NativeNewSessionModels', 'toggleFavorite, error', { ...base, ...pickerModel, ...draftModel, record, app: { runtimeScope: b.runtimeScope }, captureHostRequest: b.captureHostRequest, createNewSessionCatalog: catalogFactory, newSessionText: (key: string) => key });
    // Deliberately permissive presentation fence: the immutable request is still mandatory.
    const page = make({ owner: { directory: '/neutral', current: () => true, selection: () => ({}), select }, active: () => true, mode: 'model', onDone });
    const pending = page.toggleFavorite({ providerID: 'provider', modelID: 'model' });
    b.switchHost('B'); b.switchHost('A'); read.resolve({ favoriteModels: [] }); await pending;
    expect(b.captureHostRequest).toHaveBeenCalledTimes(1);
    expect(catalogFactory).toHaveBeenCalledExactlyOnceWith('/neutral', expect.any(Function), expect.any(Function), scopeKey);
    expect(b.accepted.map(row => row.method)).toEqual(['GET']);
    expect(b.rejected).toEqual([{ hostID: 'A', generation: 1, method: 'PUT' }]);
    expect(page.error()).toBe('operationFailed');
    expect(select).not.toHaveBeenCalled(); expect(onDone).not.toHaveBeenCalled(); expect(catalog.setPreferences).not.toHaveBeenCalled();
  });

  it('search never refills a retired controller epoch, even when the same Host returns', async () => {
    const b = boundary(); b.respond(() => ({ sessions: [] }));
    const createPageOperations = () => { const generation = b.epoch(), request = b.captureHostRequest(); const current = () => generation === b.epoch(); return { current, capture: () => ({ current, request }), onRetire: () => {} }; };
    const make = owner('projects-search.tsx', 'createProjectsSearchController', 'search, current', { ...base, ...searchModel, createPageOperations });
    const old = make(() => undefined); await old.search('');
    const count = b.accepted.length;
    b.switchHost('B'); await old.search('stale');
    b.switchHost('A'); await old.search('stale');
    expect(old.current()).toBe(false); expect(b.accepted).toHaveLength(count);
    expect(b.captureHostRequest).toHaveBeenCalledTimes(1);
    const replacement = make(() => undefined); await replacement.search('');
    expect(replacement.current()).toBe(true); expect(b.accepted.at(-1)).toMatchObject({ hostID: 'A', generation: 3 });
  });

  it('the read-only context route captures once at construction and shares that sender with its controller', async () => {
    const b = boundary();
    const createContextUsageRoute = vi.fn(() => ({ setActive: () => {}, dispose: () => {} }));
    const lane = { request: b.captureHostRequest(), current: () => true };
    const make = owner('context-usage-route.tsx', 'ContextUsageRoute', 'route', { ...base, effect: (work: () => void) => work(), untracked: (work: () => void) => work(), lifecycle: () => 'active', createPageOperations: () => ({ operation: () => lane }), createContextUsageRoute });
    make({ appearance: null, chat: { messageScope: {} }, current: () => true });
    const read = createContextUsageRoute.mock.calls[0]![0].read;
    b.switchHost('B'); b.switchHost('A');
    await expect(read('/api/config/settings')).rejects.toThrow('runtime_stale');
    expect(b.accepted).toEqual([]); expect(b.captureHostRequest).toHaveBeenCalledTimes(1);
  });

  it('real admission captures source operation before readiness; unknown receipt cannot replay on a returning Host', async () => {
    const b = boundary(), ready = deferred<void>();
    const sendNewSessionHandoff = productionFunction('new-session.ts', 'sendNewSessionHandoff', {
      isCurrentHostScope: (generation: number, hostID: string) => generation === b.epoch() && hostID === b.runtimeScope().hostID,
      draftKey: () => 'draft-key', inboxFrom, record, unwrap,
      query: (directory: string) => `directory=${encodeURIComponent(directory)}`,
      sessionPath: (id: string, suffix: string) => `/api/session/${encodeURIComponent(id)}/${suffix}`,
    });
    const send = vi.fn(sendNewSessionHandoff);
    const make = owner('new-session-admission.ts', 'createNewSessionAdmission', 'run, close', { ...base, sendNewSessionHandoff: send });
    const complete = vi.fn(), release = vi.fn();
    const generation = b.epoch(), scope = b.runtimeScope(), request = b.captureHostRequest();
    const current = () => generation === b.epoch() && scope.hostID === b.runtimeScope().hostID && scope.lease === b.runtimeScope().lease;
    const operation = Object.freeze({ generation, scope, current, request });
    let assigned: typeof operation | null = operation;
    let admission: 'unknown' | 'acknowledged' = 'unknown';
    const source = { hostID: scope.hostID, generation, ready: ready.promise, complete,
      operation: () => assigned,
      replaceOperation: vi.fn((next: typeof operation | null) => { if (next !== null && next !== operation) return false; assigned = next; return next?.current() === true; }),
      captureOperation: vi.fn((_requireActive: boolean) => { if (assigned !== operation || !current()) throw new Error('source_operation_stale'); return operation; }),
      ownedScope: current, admission: () => admission,
      noteAdmission: vi.fn(async (_receipt: unknown, next: typeof admission) => { admission = next; }),
    };
    const unknown = Object.freeze({ id: 'stable-id', text: 'Captured original', delivery: 'steer', uncertain: true, files: [] });
    const recoverPendingSend = vi.fn(async () => false), retrySend = vi.fn();
    const chat = { draftReady: ready.promise, active: () => true, referenceScope: { draft: 'draft-key', directory: '/neutral' },
      messageScope: { hostID: scope.hostID, generation, sessionID: 'session', directory: '/neutral' },
      recoverPendingSend, retrySend, pendingSend: () => unknown };
    const page = make({ chat,
      handoff: { receipt: { hostID: scope.hostID, generation, inputID: 'stable-id', target: { kind: 'session', id: 'session', directory: '/neutral' } }, owner: source, release }, current: () => true, changed: vi.fn() });
    const pending = page.run();
    expect(source.replaceOperation).toHaveBeenCalledExactlyOnceWith(operation);
    expect(source.captureOperation).toHaveBeenCalledExactlyOnceWith(false);
    b.switchHost('B'); b.switchHost('A'); ready.resolve(); await pending;
    await page.run();
    expect(b.captureHostRequest).toHaveBeenCalledTimes(1); expect(b.accepted).toEqual([]);
    expect(operation.current()).toBe(false); expect(b.rejected).toEqual([]);
    expect(send).not.toHaveBeenCalled(); expect(recoverPendingSend).not.toHaveBeenCalled(); expect(retrySend).not.toHaveBeenCalled();
    expect(source.noteAdmission).not.toHaveBeenCalled(); expect(source.admission()).toBe('unknown'); expect(chat.pendingSend()).toBe(unknown);
    expect(complete).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
  });
});
