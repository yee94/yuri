import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set(next: T) { value = next; } }); };
const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

/** Executes the actual fixture bootstrap; no fixture UI or production authority is substituted. */
function bootstrap(initial = 'inactive') {
  const file = 'tests/new-session-uikit/fixture.tsx';
  const syntax = ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = syntax.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'Fixture')!;
  const statements = declaration.body!.statements.filter(node => !ts.isReturnStatement(node)).map(node => node.getText(syntax)).join('\n');
  const js = ts.transpileModule(`function bootstrap() { ${statements}; return ready; }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const lifecycle = signal(initial), fixtureError = signal(''), effects: Array<() => void> = [];
  const projects = [{ id: 'fixture-project', name: 'Fixture project', path: '/fixture/project' }];
  const setProjects = vi.fn(), current = vi.fn(() => false), loadConnections = vi.fn(async () => {});
  const ports = { signal, lifecycle, fixtureError, projects, app: { projects: { set: setProjects } }, loadConnections, captureHostOperation: () => ({ current }),
    effect: (work: () => void) => { effects.push(work); work(); }, untracked: (work: () => void) => work(),
  };
  const ready = new Function(...Object.keys(ports), `${js}; return bootstrap();`)(...Object.values(ports)) as ReturnType<typeof signal<boolean>>;
  return { lifecycle, fixtureError, projects, setProjects, current, loadConnections, ready, runEffects: () => effects.forEach(work => work()) };
}

describe('isolated UIKit fixture root adoption (pure, no build/engine/device)', () => {
  it('waits for active lifecycle and a genuinely current adopted operation before exposing the draft route', async () => {
    const f = bootstrap(); expect(f.loadConnections).not.toHaveBeenCalled(); expect(f.ready()).toBe(false);
    const pending = deferred(); f.loadConnections.mockImplementation(() => pending.promise);
    f.lifecycle.set('active'); f.runEffects(); expect(f.loadConnections).toHaveBeenCalledTimes(1); expect(f.ready()).toBe(false);
    pending.resolve(); await flush(); expect(f.ready()).toBe(false); expect(f.setProjects).not.toHaveBeenCalled();
    f.current.mockReturnValue(true); f.runEffects(); await flush();
    expect(f.ready()).toBe(true); expect(f.setProjects).toHaveBeenCalledExactlyOnceWith(f.projects);
  });

  it('keeps root authority unadmitted when lifecycle retires during snapshot load and adopts after the next active load', async () => {
    const f = bootstrap(), pending = deferred(); f.loadConnections.mockImplementation(() => pending.promise);
    f.lifecycle.set('active'); f.runEffects(); f.lifecycle.set('background'); f.current.mockReturnValue(false); pending.resolve(); await flush();
    expect(f.ready()).toBe(false); expect(f.setProjects).not.toHaveBeenCalled();
    f.lifecycle.set('active'); f.current.mockReturnValue(true); f.runEffects(); await flush();
    expect(f.loadConnections).toHaveBeenCalledTimes(2); expect(f.ready()).toBe(true);
  });

  it('shows a real snapshot failure and never treats it as an empty-success admission', async () => {
    const f = bootstrap(); f.loadConnections.mockRejectedValue(new Error('Synthetic snapshot failed'));
    f.lifecycle.set('active'); f.runEffects(); await flush();
    expect(f.ready()).toBe(false); expect(f.setProjects).not.toHaveBeenCalled(); expect(f.fixtureError()).toContain('Synthetic snapshot failed');
  });
});
