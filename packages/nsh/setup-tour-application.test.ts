import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createSetupTour, type SetupTourStep } from './setup-tour-core';
import { createHistoryImport } from './history-import-core';
import { createSetupTourProgress } from './setup-tour-progress';
import { createResourceConnectionClear } from './resource-retirement';

const root = path.dirname(fileURLToPath(import.meta.url));
/** Actual application's command/navigation closures, with inert uncalled
 * component imports. No NSH engine, Host request or alternate renderer. */
function application() {
  type Route = { kind: string; owner?: Owner; directory?: string; [key: string]: unknown };
  type Owner = { controller: ReturnType<typeof createSetupTour>; directory?: string };
  const source = readFileSync(path.join(root, 'application.tsx'), 'utf8');
  const syntax = ts.createSourceFile('application.tsx', source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX);
  const unexpected = () => { throw new Error('Unexpected application fixture dependency invocation'); };
  const modules: Record<string, Record<string, unknown>> = {};
  for (const statement of syntax.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
    const module: Record<string, unknown> = {};
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) if (!element.isTypeOnly) module[element.propertyName?.text ?? element.name.text] = unexpected;
    modules[statement.moduleSpecifier.text] = module;
  }
  const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set(next: T) { value = next; } }); };
  let routes: Route[] = [], serial = 0, online = true;
  const connection = { id: 'fixture-app', url: 'https://example.invalid', authorizationID: 'synthetic-auth' };
  const storage: Record<string, string> = {}, storageWrites: string[] = [], requests: unknown[] = [];
  const operation = { scope: { hostID: connection.id, lease: 'synthetic-lease' }, generation: 1, current: () => online, request: async (...args: unknown[]) => { requests.push(args); throw new Error('Unexpected Host request'); } };
  const nav = { routes: () => routes, push(route: Route) { routes.push(route); }, pop() { if (routes.length > 1) routes.pop(); }, popToRoot() { routes = routes.slice(0, 1); }, setRoutes(value: Route[]) { routes = [...value]; }, remove(route: Route) { routes = routes.filter(item => item !== route); } };
  const storageAPI = { getItem: async (key: string) => storage[key] ?? null, setItem: async (key: string, value: string) => { storageWrites.push(key); storage[key] = value; } };
  modules.nsh = { ...modules.nsh, signal, computed: <T>(read: () => T) => read, Storage: storageAPI, batch: (work: () => void) => work() };
  modules['./resource-retirement'] = { createResourceConnectionClear };
  modules['nsh/base'].createNavStack = (initial: Route[]) => { routes = [...initial]; return nav; };
  modules['./state'] = { ...modules['./state'], epoch: () => 1, captureHostOperation: () => operation, app: { connection: () => connection, projects: () => [] }, run: async (work: () => Promise<unknown>) => work(), report: unexpected };
  modules['./model'] = { ...modules['./model'], id: () => `synthetic-owner-${++serial}` };
  modules['./i18n'] = { t: (key: string) => key };
  modules['./settings'] = { ...modules['./settings'], SETTINGS_ENTRIES: [] };
  modules['./page-operations'] = { createPageOperations: (active: () => boolean) => ({ operation: () => active() ? operation : null }) };
  modules['./features-bot-defaults'].createBotCreationContext = () => ({ snapshot: () => undefined });
  modules['./setup-tour-progress'] = { createSetupTourProgress };
  modules['./history-import'] = { ...modules['./history-import'], createNativeHistoryImport: (input: { directory?: string; operation: typeof operation }) => createHistoryImport({ ...input, current: input.operation.current, send: input.operation.request }) };
  modules['./setup-tour'] = { ...modules['./setup-tour'], createNativeSetupTour: (input: { step?: SetupTourStep; directory?: string; historyImport: ReturnType<typeof createHistoryImport>; onMove: (step: SetupTourStep) => void; onClose: () => void }) => createSetupTour({ ...input, current: operation.current, send: operation.request }) };
  const exports: Record<string, unknown> = {};
  const compiled = ts.transpileModule(source + '\nexport const applicationTourFixture = { nav, projectSearchCommands, openSetupTour, closeTour, tourOwners, tourHistoryOwners, tourRootOperation, settingsCallbacks, SettingsOperationPage };', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' } }).outputText;
  vm.runInNewContext(compiled, { exports, jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }), require: (name: string) => { if (!(name in modules)) throw new Error('Unlisted application dependency ' + name); return modules[name]; } });
  const fixture = exports.applicationTourFixture as { projectSearchCommands: (directory?: string) => Array<{ id: string; title: string; onSelect: () => void }>; openSetupTour: (directory?: string) => Promise<void>; closeTour: (owner: Owner) => void; tourRootOperation: { set: (value: typeof operation) => void }; tourOwners: Set<Owner>; settingsCallbacks: { onOpen: (route: { page: string }) => void }; SettingsOperationPage: (props: { route: Route }) => { props: Record<string, unknown> } };
  fixture.tourRootOperation.set(operation);
  return { fixture, nav, storage, storageWrites, requests, suspend() { online = false; } };
}

describe('actual application Tour command and exact navigation closures', () => {
  it('actual Chat admission effect runs once, reconciles only a replacement token and never runs for null/hidden/stale authority', () => {
    const source = ts.createSourceFile('application.tsx', readFileSync(path.join(root, 'application.tsx'), 'utf8'), ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX);
    const chat = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'Chat')!;
    const statements = [...chat.body!.statements];
    const index = statements.findIndex(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'admissionAttempted'));
    const text = statements.slice(index, index + 3).map(node => node.getText(source)).join('\n');
    expect(text).toContain('admission.reconcile()');
    let active = true, live = true, runs = 0, reconciles = 0, tick!: () => void;
    type Token = { current: () => boolean };
    let operation: Token | null = null;
    const first: Token = { current: () => live }, second: Token = { current: () => live };
    const replacements: Token[] = [];
    vm.runInNewContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText, {
      effect: (work: () => void) => { tick = work; work(); }, untracked: (work: () => void) => work(),
      operations: { operation: () => operation }, chat: { active: () => active }, lifecycle: () => 'active',
      admission: { replaceOperation: (token: Token) => replacements.push(token), run: () => { runs++; }, reconcile: () => { reconciles++; } },
    });
    expect([runs, reconciles]).toEqual([0, 0]); operation = first; tick(); tick(); expect([runs, reconciles]).toEqual([1, 0]);
    operation = null; tick(); active = false; operation = second; tick(); expect([runs, reconciles]).toEqual([1, 0]);
    active = true; live = false; tick(); expect(reconciles).toBe(0); live = true; tick(); tick(); expect([runs, reconciles]).toEqual([1, 1]);
    expect(replacements).toEqual([first, second]);
  });
  it('ordinary Voice opens the settings route with its captured directory, active lane and no Tour owner', () => {
    const f = application(); f.nav.push({ kind: 'settings-home', directory: '/actual/worktree' });
    f.fixture.settingsCallbacks.onOpen({ page: 'voice' });
    const route = f.nav.routes().at(-1)!;
    expect(route).toMatchObject({ kind: 'settings', route: { page: 'voice', directory: '/actual/worktree' } });
    expect(route.tourOwner).toBeUndefined();
    const page = f.fixture.SettingsOperationPage({ route });
    expect(page.props).toMatchObject({ page: 'voice', directory: '/actual/worktree', active: true });
    expect((page.props.operationToken as { current: () => boolean }).current()).toBe(true);
    f.nav.push({ kind: 'preview' });
    const covered = f.fixture.SettingsOperationPage({ route });
    expect(covered.props.active).toBe(false); expect(covered.props.operationToken).toBeNull();
    expect(f.requests).toEqual([]);
  });
  it('preserves the single runtime observer/notification root and mounts Tour routes without a second NavPage wrapper', () => {
    const source = ts.createSourceFile('application.tsx', readFileSync(path.join(root, 'application.tsx'), 'utf8'), ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX);
    const calls: string[] = [];
    const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(node.expression.text); ts.forEachChild(node, visit); }; visit(source);
    expect(calls.filter(name => name === 'observeRuntime')).toHaveLength(1); expect(calls.filter(name => name === 'createNativeNotificationRoot')).toHaveLength(1);
    for (const name of ['SetupTourRoutePage', 'SetupTourDetailRoutePage']) {
      const component = source.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === name)!;
      expect(component.getText(source)).not.toContain('<NavPage');
    }
  });
  it('module startup never opens a Tour; the real command uses tour.open and carries only the actual focus directory', async () => {
    const f = application(); expect(f.nav.routes().map(route => route.kind)).toEqual(['root']); expect(f.storageWrites).toEqual([]);
    f.nav.push({ kind: 'project-search', directory: '/actual/worktree' });
    const command = f.fixture.projectSearchCommands('/actual/worktree').find(command => command.id === 'setup-tour')!;
    expect(command.title).toBe('tour.open'); command.onSelect();
    for (let index = 0; index < 40 && f.nav.routes().at(-1)?.kind !== 'setup-tour'; index++) await Promise.resolve();
    expect(f.nav.routes().at(-1)?.owner?.directory).toBe('/actual/worktree'); expect(f.requests).toEqual([]);
  });
  it('closing one Tour removes only its own root/detail/settings identities, retaining unrelated routes', async () => {
    const f = application(); await f.fixture.openSetupTour('/one'); const first = f.nav.routes().at(-1)!.owner!;
    const unrelated = { kind: 'preview', title: 'Unrelated' }; f.nav.push(unrelated); await f.fixture.openSetupTour('/two'); const second = f.nav.routes().at(-1)!.owner!;
    f.nav.push({ kind: 'setup-tour-detail', owner: first }); f.nav.push({ kind: 'settings', tourOwner: first });
    f.fixture.closeTour(first);
    expect(f.nav.routes()).toContain(unrelated); expect(f.nav.routes().some(route => route.owner === second)).toBe(true); expect(f.nav.routes().some(route => route.owner === first || route.tourOwner === first)).toBe(false);
  });
  it('explicit reopen uses the retained controller/provider/step and Host progress saves contain no operation or credentials', async () => {
    const f = application(); await f.fixture.openSetupTour('/actual'); const owner = f.nav.routes().at(-1)!.owner!;
    owner.controller.activate(true); owner.controller.selectProvider('other'); owner.controller.move('plugins'); owner.controller.close();
    await f.fixture.openSetupTour('/actual'); expect(f.nav.routes().at(-1)?.owner).toBe(owner); expect(owner.controller.snapshot()).toMatchObject({ provider: 'other', step: 'plugins', closed: false });
    for (let index = 0; index < 20; index++) await Promise.resolve();
    const saved = JSON.parse(f.storage['yuri-nsh-setup-tour']); expect(saved['fixture-app']).toEqual({ step: 'plugins', dismissed: true });
    expect(JSON.stringify(saved)).not.toMatch(/lease|authorization|token|request|secret/); expect(f.requests).toEqual([]);
  });
  it('a stale foreground operation cannot open a route or infer a default project directory', async () => {
    const f = application(); f.suspend(); await f.fixture.openSetupTour(); expect(f.nav.routes().map(route => route.kind)).toEqual(['root']); expect(f.fixture.tourOwners.size).toBe(0);
  });
});
