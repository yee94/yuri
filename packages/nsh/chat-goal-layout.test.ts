import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, test, vi } from 'vitest';
import * as goalModel from './chat-goal-model';
import { sessionGoalStatusLabelKey } from '../ui/src/lib/sessionGoalPresentation';
import { systemSheetContentStyle } from './sheet-presentation';
import { createHost } from './tests/goal-tasks-chat-host.js';

type Element = { type: unknown; props: Record<string, unknown>; children: unknown[] };
type GoalOwner = { controller: ReturnType<typeof goalModel.createGoalController>; state: () => goalModel.GoalState };
const settle = async () => { for (let index = 0; index < 80; index++) await Promise.resolve(); };

/** Runs the complete production JSX/callbacks; inspects emitted layout props, not native pixels. */
function fixture(geometry = { width: 402, height: 874, top: 59, bottom: 34, keyboard: 0 }) {
  const cleanups: Array<() => void> = [];
  const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); };
  const h = (type: unknown, props: Element['props'] | null, ...children: unknown[]): Element => ({ type, props: props ?? {}, children });
  const imports: Record<string, unknown> = {
    nsh: { cleanup: (work: () => void) => cleanups.push(work), signal, computed: (read: () => unknown) => read, colorScheme: () => 'light', token: (name: string) => name,
      windowSize: () => ({ width: geometry.width, height: geometry.height }), safeArea: () => ({ top: geometry.top, bottom: geometry.bottom, left: 0, right: 0 }), keyboardFrame: () => ({ height: geometry.keyboard }),
      Scroll: 'Scroll', Text: 'Text', View: 'View' },
    'nsh/base': { Button: 'Button' }, './native-sheet': { NativeSheet: 'Sheet' },
    '../ui/src/lib/sessionGoalPresentation': { sessionGoalStatusLabelKey }, './Icon': { Icon: 'Icon' },
    './i18n': { t: (key: string) => key }, './chat-goal-model': goalModel,
    './appearance': { nativeAppearance: { current: () => null }, nativeChatTextStyle: () => ({}) },
  };
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'chat-goal.tsx');
  const javascript = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'h' } }).outputText;
  const exports: {
    createNativeGoalOwner?: (scope: goalModel.GoalScope, transport: goalModel.GoalTransport, current: () => boolean) => GoalOwner;
    NativeGoalPanel?: (props: { owner: GoalOwner; open: boolean; active: boolean; onClose: () => void }) => Element;
    NativeGoalRow?: (props: { owner: GoalOwner; enabled: boolean; active: boolean; open: boolean; onOpenChange: (open: boolean) => void }) => Element;
  } = {};
  vm.runInNewContext(javascript, { exports, require: (name: string) => { if (!(name in imports)) throw new Error('Unbound Goal fixture import: ' + name); return imports[name]; }, h, If: 'If' }, { filename: file });
  const host = createHost(), saved = host.call('connection.list');
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const transport = goalModel.createGoalTransport(async (path, method, body) => {
    requests.push({ path, method, body });
    const response = host.call('runtime.request', { path, method, body, expectedHost: saved.runtimeScope });
    if (response.status >= 400) throw Object.assign(new Error('Synthetic Goal HTTP failure'), { status: response.status });
    return response.body;
  });
  const owner = exports.createNativeGoalOwner!({ sessionID: 'ses_1', directory: '/workspace/project' }, transport, () => true);
  const nodes = (value: unknown): Element[] => {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== 'object' || !('type' in value)) return [];
    const node = value as Element;
    if (node.type === 'If') return nodes(node.props.when ? node.children : node.props.else);
    return [node, ...node.children.flatMap(nodes)];
  };
  const find = (root: Element, id: string) => { const node = nodes(root).find(node => node.props.testID === id); if (!node) throw new Error('Missing production Goal element: ' + id); return node; };
  const audit = () => host.call('runtime.request', { path: '/api/git/status?directory=%2Fworkspace%2Fproject&mode=light', method: 'GET', expectedHost: saved.runtimeScope }).body.current;
  return { owner, requests, nodes, find, audit,
    panel: (onClose = () => {}, open = true, active = true) => exports.NativeGoalPanel!({ owner, open, active, onClose }),
    row: (onOpenChange: (open: boolean) => void) => exports.NativeGoalRow!({ owner, enabled: true, active: true, open: false, onOpenChange }),
    dispose: () => cleanups.reverse().forEach(work => work()),
  };
}

test.each([
  { width: 320, height: 568, top: 0, bottom: 0, keyboard: 0 },
  { width: 375, height: 844, top: 59, bottom: 34, keyboard: 0 },
  { width: 402, height: 874, top: 59, bottom: 34, keyboard: 304 },
  { width: 402, height: 430, top: 0, bottom: 21, keyboard: 0 },
])('production Goal panel bounds its flex Scroll at $width/$height with keyboard $keyboard', async geometry => {
  const f = fixture(geometry);
  try {
    await f.owner.controller.refresh(); const panel = f.panel();
    expect(panel.type).toBe('Sheet'); expect(panel.props.open).toBe(true);
    const style = panel.props.popupStyle as { height?: number; maxHeight?: number; marginBottom: number };
    expect(style.height).toBe(geometry.height - geometry.top - geometry.keyboard - 12);
    expect(style.height).toBeGreaterThan(0); expect(style.height).toBeLessThanOrEqual(geometry.height - geometry.top - geometry.keyboard);
    expect(style.marginBottom).toBe(geometry.keyboard);
    expect(systemSheetContentStyle(style)).toEqual({});
    const scroll = f.find(panel, 'chat-goal-panel'); expect(scroll.props.class).toBe('flex-1');
    expect(f.nodes(scroll).some(node => node.type === 'Text' && node.children.includes('Synthetic existing Goal'))).toBe(true);
    expect(f.nodes(scroll).some(node => node.type === 'Text' && node.children.includes('GOAL_FIXTURE pause=0 resume=0 clear=0 objective=0 prompt=0 selection=0 faults=0'))).toBe(true);
    expect(f.find(panel, 'chat-goal-panel-toggle').props.disabled).toBe(false);
    expect(f.find(panel, 'chat-goal-panel-clear').props.disabled).toBe(false);
  } finally { f.dispose(); }
});

test('production Goal row/details and panel callbacks preserve exact pause/resume/clear audit, without prompt or selection writes', async () => {
  const f = fixture(), close = vi.fn(), opened = vi.fn();
  try {
    await f.owner.controller.refresh();
    (f.find(f.row(opened), 'chat-goal-details').props.onPress as () => void)(); expect(opened).toHaveBeenCalledExactlyOnceWith(true);
    (f.find(f.panel(close), 'chat-goal-panel-toggle').props.onPress as () => void)(); await settle();
    expect(f.owner.state().goal?.status).toBe('paused'); expect(close).toHaveBeenCalledTimes(1);
    expect(f.audit()).toBe('GOAL_FIXTURE pause=1 resume=0 clear=0 objective=0 prompt=0 selection=0 faults=0');
    (f.find(f.panel(close), 'chat-goal-panel-toggle').props.onPress as () => void)(); await settle();
    expect(f.owner.state().goal?.status).toBe('active'); expect(close).toHaveBeenCalledTimes(2);
    (f.find(f.panel(close), 'chat-goal-panel-clear').props.onPress as () => void)(); await settle();
    expect(f.owner.state().goal).toBeNull(); expect(close).toHaveBeenCalledTimes(3);
    expect(f.audit()).toBe('GOAL_FIXTURE pause=1 resume=1 clear=1 objective=0 prompt=0 selection=0 faults=0');
    expect(f.requests.filter(request => request.path.includes('/command?')).map(request => request.body)).toEqual([{ name: 'goal', text: 'pause' }, { name: 'goal', text: 'resume' }, { name: 'goal', text: 'clear' }]);
    expect(f.requests.filter(request => request.path.includes('/opencode.goal/get?'))).toHaveLength(4);
    expect(f.requests.some(request => /\/(prompt|inbox|model|agent)\?/.test(request.path))).toBe(false);
  } finally { f.dispose(); }
});

test('production Goal panel retains typed Goal command audit in Scroll and closed/inactive panels have zero body rows', async () => {
  const f = fixture();
  try {
    await f.owner.controller.refresh();
    const submission = goalModel.planGoalSubmission({ text: '/goal Synthetic busy Goal objective', armed: false, delivery: 'queue' });
    expect(submission.kind).toBe('command'); if (submission.kind !== 'command') throw new Error('Expected native Goal command');
    expect(await f.owner.controller.command(submission.command)).toBe('acknowledged');
    const panel = f.panel(), scroll = f.find(panel, 'chat-goal-panel');
    expect(f.nodes(scroll).some(node => node.type === 'Text' && node.children.includes('Synthetic busy Goal objective'))).toBe(true);
    expect(f.nodes(scroll).some(node => node.type === 'Text' && node.children.includes('GOAL_FIXTURE pause=0 resume=0 clear=0 objective=1 prompt=0 selection=0 faults=0'))).toBe(true);
    expect(f.requests.filter(request => request.path.includes('/command?')).map(request => request.body)).toEqual([{ name: 'goal', text: 'Synthetic busy Goal objective', delivery: 'queue' }]);
    for (const closed of [f.panel(() => {}, false), f.panel(() => {}, true, false)]) {
      expect(closed.props.open).toBe(false); expect(f.nodes(closed).filter(node => node.props.testID === 'chat-goal-panel')).toHaveLength(0);
    }
  } finally { f.dispose(); }
});
