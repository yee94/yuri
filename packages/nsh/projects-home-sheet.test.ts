import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
type Node = { type: string; props: Record<string, any> };
const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set(next: T) { value = next; } }); };
function mount(kind: 'edit' | 'directory' | 'worktrees' | 'new-worktree') {
  const nodes: Node[] = [];
  const signals: Array<() => unknown> = [];
  let generation = 1;
  const project = { id: 'project', path: '/workspace/repo', name: 'Project' };
  const props = { intent: kind === 'directory' ? { kind } : { kind, project }, active: true, onReplace: vi.fn(), onClosed: vi.fn(), navigation: { onNewSession: vi.fn(), onOpenChat: vi.fn(), onOpenFiles: vi.fn(), onOpenChanges: vi.fn(), onWorktreeCreated: vi.fn() } };
  const source = ts.createSourceFile('projects-home-sheet.tsx', readFileSync(path.join(root, 'projects-home-sheet.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ProjectsHomeSheet')!.getText(source).replace(/^export /, '');
  const context = vm.createContext({ props, signal: <T>(initial: T) => { const value = signal(initial); signals.push(value); return value; }, effect: (work: () => void) => work(), untracked: (work: () => void) => work(), epoch: () => generation, app: { connection: () => ({ id: 'host' }) }, t: (key: string) => key,
    React: { createElement(type: any, values: Record<string, unknown>, ...children: unknown[]) {
      const attributes = { ...values, children: children.length === 1 ? children[0] : children };
      if (typeof type === 'function') return type(attributes);
      const node = { type, props: attributes }; nodes.push(node); return node;
    } },
    Each: ({ of, children }: any) => of.map((value: unknown) => children(() => value)),
    NavStack: ({ children }: any) => children(), createNavStack: vi.fn((routes: unknown[]) => ({ routes })),
    NativeSheet: 'Sheet', Icon: 'Icon', Button: 'Button', Text: 'Text', View: 'View', SettingsProjects: 'Editor', ProjectDirectoryPage: 'Directory', ProjectDetail: 'Worktrees',
    nativeDensity: () => ({ scale: 1 }), nativeChatTextStyle: () => ({ fontSize: 13 }), windowSize: () => ({ width: 402, height: 874 }),
  });
  vm.runInContext(ts.transpileModule(`${declaration}\nProjectsHomeSheet(props);`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2023 } }).outputText, context);
  return { props, nodes, project, retire: () => { generation++; }, isOpen: () => signals[0](), node: (type: string) => nodes.find(node => node.type === type)!, close: () => nodes.find(node => node.props.testID === 'projects-home-options-close')!.props.onPress() };
}

describe('homepage sheet production boundary (presentation completion is simulated, not UIKit evidence)', () => {
  it.each(['header', 'cancel'] as const)('allows local %s dismissal after suspend retires the operation epoch', action => {
    const f = mount('new-worktree');
    f.retire();
    if (action === 'header') f.close(); else f.node('Worktrees').props.onSheetClose();
    expect(f.isOpen()).toBe(false);
    expect(f.props.onClosed).not.toHaveBeenCalled();
    f.node('Sheet').props.onClose();
    expect(f.props.onClosed).toHaveBeenCalledOnce();
  });

  it('never adopts a new navigation continuation from a retired sheet while allowing it to close', () => {
    const f = mount('new-worktree');
    f.retire();
    f.node('Worktrees').props.onWorktreeCreated(f.project, '/workspace/stale');
    expect(f.isOpen()).toBe(false);
    f.node('Sheet').props.onClose();
    expect(f.props.navigation.onWorktreeCreated).not.toHaveBeenCalled();
  });

  it('reuses the real editor and delegates dirty/busy closing to its existing guard', () => {
    const f = mount('edit'), back = vi.fn();
    expect(f.node('Editor').props.entity).toBe('project');
    f.node('Editor').props.onNavigation({ blocked: true, back }); f.close();
    expect(back).toHaveBeenCalledOnce(); expect(f.props.onClosed).not.toHaveBeenCalled();
    expect(f.isOpen()).toBe(true);
    f.node('Editor').props.onNavigation({ blocked: false, back }); f.close();
    expect(f.props.onClosed).not.toHaveBeenCalled(); f.node('Sheet').props.onClose();
    expect(f.props.onClosed).toHaveBeenCalledOnce();
  });

  it('keeps quick-add inside the directory sheet and opens a draft only after actual sheet completion', () => {
    const f = mount('directory'), directory = f.node('Directory').props;
    expect(directory.headerVisible).toBe(false);
    directory.onAdded(f.project, { openDraft: false });
    expect(f.props.navigation.onNewSession).not.toHaveBeenCalled();
    directory.onAdded(f.project, { openDraft: true });
    expect(f.props.navigation.onNewSession).not.toHaveBeenCalled();
    f.node('Sheet').props.onClose();
    expect(f.props.navigation.onNewSession).toHaveBeenCalledExactlyOnceWith(f.project);
  });

  it.each(['worktrees', 'new-worktree'] as const)('renders %s in the sheet rather than pushing the app navigation', kind => {
    const f = mount(kind), detail = f.node('Worktrees').props;
    expect(detail.sheet).toBe(true); expect(detail.initialCreateWorktree).toBe(kind === 'new-worktree');
    expect(f.node('Sheet').props.initialDetent).toBe(kind === 'new-worktree' ? 0 : 1);
    expect(f.node('Sheet').props.viewportDetents).toBe(kind === 'new-worktree');
    detail.onEditProject(f.project);
    expect(f.props.onReplace).toHaveBeenCalledExactlyOnceWith({ kind: 'edit', project: f.project });
    detail.onWorktreeCreated(f.project, '/workspace/topic');
    expect(f.props.navigation.onWorktreeCreated).not.toHaveBeenCalled();
    f.node('Sheet').props.onClose();
    expect(f.props.navigation.onWorktreeCreated).toHaveBeenCalledExactlyOnceWith(f.project, '/workspace/topic');
  });

  it.each(['host', 'hidden'] as const)('rejects an outgoing continuation after %s retirement', reason => {
    const f = mount('directory'); f.node('Directory').props.onAdded(f.project, { openDraft: true });
    if (reason === 'host') f.retire(); else f.props.active = false;
    f.node('Sheet').props.onClose();
    expect(f.props.navigation.onNewSession).not.toHaveBeenCalled();
  });
});
