import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import * as model from '../model';
import * as runtimeScope from '../runtime-scope';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const compile = (source: string) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2023 } }).outputText;
const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set(next: T) { value = next; } }); };

/** Only the native transport and reactive scheduler are test ports; scope/request/page fencing is production code. */
export function createProjectsScopeVM(call: (name: string, input: Record<string, unknown>) => unknown, hostID = 'projects-fixture', initialSnapshot?: unknown) {
  const effects: Array<() => void> = [], cleanups: Array<() => void> = [];
  const native = { signal, computed: (work: () => unknown) => work, effect: (work: () => void) => { effects.push(work); work(); }, untracked: (work: () => unknown) => work(), cleanup: (work: () => void) => cleanups.push(work), lifecycle: () => context.active ? 'active' : 'background', host: { available: () => true, call } };
  function load<T>(filename: string, imports: Record<string, unknown>): T {
    const exports = {};
    vm.runInNewContext(compile(readFileSync(path.join(root, filename), 'utf8')), { exports, require: (id: string) => {
      if (!(id in imports)) throw new Error(`Unexpected ${filename} dependency: ${id}`);
      return imports[id];
    }, console, setTimeout, clearTimeout });
    return exports as T;
  }
  const runtime = load<typeof import('../runtime')>('runtime.ts', { nsh: native, './model': model, './runtime-scope': runtimeScope });
  const snapshot = runtime.connectionSnapshotFrom(initialSnapshot ?? { connections: [{ id: hostID, url: 'https://fixture.invalid', authorizationID: 'projects-fixture-authorization' }], selected: hostID, runtimeScope: { hostID, lease: 'projects-fixture-lease' } });
  const app = { connection: signal(snapshot.connections[0]!), runtimeScope: signal(snapshot.runtimeScope), projects: signal<model.Project[]>([]), sessions: signal<model.Session[]>([]) };
  const context = vm.createContext({ exports: {}, generation: 1, switching: false, active: true, runtimeReady: signal(true), app,
    ...runtimeScope, bindRequest: runtime.bindRequest, lifecycle: native.lifecycle,
  });
  const source = ts.createSourceFile('state.ts', readFileSync(path.join(root, 'state.ts'), 'utf8'), ts.ScriptTarget.ES2023, true);
  const names = ['epoch', 'captureHostRequest', 'captureHostOperation'];
  const declarations = names.map(name => {
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) ? node.name?.text === name : ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(source) === name));
    if (!declaration) throw new Error(`Missing production state declaration: ${name}`);
    return declaration.getText(source);
  });
  vm.runInContext(compile(declarations.join('\n')), context);
  const state = { ...context.exports, app } as Pick<typeof import('../state'), 'epoch' | 'captureHostRequest' | 'captureHostOperation'> & { app: typeof app };
  const operations = load<typeof import('../page-operations')>('page-operations.ts', { nsh: native, './state': state });
  return { state, runtime, native, context, effects, cleanups, operations, load,
    flush: () => effects.forEach(work => work()),
    advanceGeneration() { context.generation++; },
    dispose: () => cleanups.forEach(work => work()),
  };
}
