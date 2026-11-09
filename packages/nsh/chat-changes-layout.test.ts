import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, test, vi } from 'vitest';
import * as layout from './chat-changes-layout';
import * as model from './chat-changes-model';
import { createChangesDraft } from './chat-changes-generation';

type Element = { type: unknown; props: Record<string, unknown>; children: unknown[] };
type Owner = { reader: model.ChangesReader; state: model.ChangesReader['state']; snapshot: () => model.ChangesSnapshot | null; draft: ReturnType<typeof createChangesDraft> };
type DocumentProps = { diff: model.HistoricalChange; wrap: boolean; layout: 'unified' | 'split'; current: () => boolean; targetLine?: number; onReady: (...args: unknown[]) => void; onError: () => void };
const settle = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };

/** Full production Changes JSX; native primitives are observation boundaries, not a renderer. */
function fixture(owner?: Owner, initialWidth = 402) {
  let width = initialWidth;
  const cleanups: Array<() => void> = [], documents: model.HistoricalChange[] = [];
  const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); };
  const h = (type: unknown, props: Element['props'] | null, ...children: unknown[]): Element => ({ type, props: props ?? {}, children });
  const imports: Record<string, unknown> = {
    nsh: { cleanup: (work: () => void) => cleanups.push(work), signal, computed: (read: () => unknown) => read, effect: (work: () => void) => work(), untracked: (work: () => unknown) => work(),
      windowSize: () => ({ width, height: 874 }), safeArea: () => ({ top: 59, bottom: 34, left: 0, right: 0 }), keyboardFrame: () => ({ height: 0 }),
      lifecycle: () => 'active', platform: { os: 'macos' }, host: { on: () => () => {} }, Keyboard: { dismiss: () => {} }, Clipboard: { writeText: vi.fn(async () => {}) },
      Storage: { getItem: async () => null, setItem: async () => {} }, View: 'View', Text: 'Text', Scroll: 'Scroll', List: 'List', Overlay: 'Overlay', Image: 'Image' },
    'nsh/base': { Button: 'Button', DiffView: 'DiffView' }, './native-sheet': { NativeSheet: 'Sheet' },
    '../ui/src/components/chat/changedFiles': { extractGitChangedFiles: () => [], summarizeGitChangedFiles: () => ({ count: 1, insertions: 1, deletions: 1 }) },
    './i18n': { t: (key: string) => key }, './Icon': { Icon: 'Icon' }, './state': { epoch: () => 1 },
    './page-operations': { createPageOperations: () => ({ current: () => true }) }, './model': { runtimeEventFrom: () => null },
    './appearance': { nativeChatTextStyle: () => ({ fontFamily: 'monospace', fontSize: 13 }) },
    './chat-changes-model': model, './chat-changes-layout': layout,
    './chat-changes-owner': { createChangesOwner: () => { if (!owner) throw new Error('Missing test owner'); return owner; } },
    './chat-changes-workspace': { NativeWorkspaceChanges: 'Workspace' }, '../ui/src/lib/toolHelpers': { isImageFile: () => false },
  };
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'chat-changes.tsx');
  const javascript = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'h' } }).outputText;
  const exports: { NativeChangesSheet?: (props: Record<string, unknown>) => Element; NativeComposerChanges?: (props: Record<string, unknown>) => Element; document?: (props: DocumentProps) => Element } = {};
  vm.runInNewContext(javascript + '\nexports.document = NativeDiffDocument;', { exports, require: (name: string) => { if (!(name in imports)) throw new Error('Unbound Changes fixture import: ' + name); return imports[name]; }, h, If: 'If', Each: 'Each', setTimeout, clearTimeout }, { filename: file });
  const nodes = (value: unknown): Element[] => {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== 'object' || !('type' in value)) return [];
    const node = value as Element;
    if (node.type === 'If') return nodes(node.props.when ? node.children : node.props.else);
    if (node.type === 'Each') return (node.props.of as unknown[]).flatMap(value => node.children.flatMap(child => typeof child === 'function' ? nodes(child(() => value)) : nodes(child)));
    if (typeof node.type === 'function') {
      if (node.type.name === 'NativeDiffDocument') documents.push(node.props.diff as model.HistoricalChange);
      return nodes(node.type(node.props));
    }
    return [node, ...node.children.flatMap(nodes)];
  };
  return { documents, width: (next: number) => { width = next; }, nodes,
    document: (props: DocumentProps) => exports.document!(props),
    sheet: (preference: layout.NativeDiffLayoutPreference | null | undefined, preview?: (path: string, line?: number) => void) => {
      if (!owner) throw new Error('Missing test owner');
      return exports.NativeChangesSheet!({ source: owner.reader.source, owner, open: true, active: true, onClose: () => {}, onOpenPreview: preview, diffLayoutPreference: preference });
    },
    render: (entry: 'sheet' | 'composer', preference: layout.NativeDiffLayoutPreference | null | undefined) => {
      if (!owner) throw new Error('Missing test owner');
      const root = entry === 'sheet' ? exports.NativeChangesSheet!({ source: owner.reader.source, owner, open: true, active: true, onClose: () => {}, diffLayoutPreference: preference }) : exports.NativeComposerChanges!({ directory: owner.reader.source.directory, active: true, diffLayoutPreference: preference });
      if (entry === 'composer') {
        // Observe the already selected reader through the Composer's actual Sheet props;
        // opening/closing gestures remain covered by the main-owned engine suite.
        const sheet = root.children.find(child => !!child && typeof child === 'object' && 'type' in child && typeof child.type === 'function' && child.type.name === 'NativeChangesSheet') as Element;
        sheet.props.open = true;
      }
      const diff = nodes(root).find(node => node.type === 'DiffView'); if (!diff) throw new Error('Missing production DiffView'); return diff;
    },
    dispose: () => cleanups.reverse().forEach(work => work()),
  };
}

test('single-file diff actions match the web toolbar: preview, wrap and layout icons, with retry only after failure', async () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'chat-changes.tsx'), 'utf8');
  const previewPress = source.slice(source.indexOf('testID="changes-open-preview"'), source.indexOf('testID="changes-wrap"'));
  expect(previewPress).toContain('onPress={() => props.onOpenPreview?.(state().path)}');
  expect(previewPress).not.toContain('first()');
  expect(source).toContain("diffLayoutOverride = layout() === 'split' ? 'unified' : 'split'");
  const reader = model.createChangesReader({ kind: 'workspace', directory: '/fixture' }, async requestPath => (
    requestPath.startsWith('/api/git/status?') ? { isClean: false, files: [{ path: 'a.ts', index: 'M', working_dir: 'M' }] } : { original: 'old', modified: 'new' }
  ));
  await reader.refresh(); await reader.select('a.ts');
  const f = fixture({ reader, state: reader.state, snapshot: () => reader.state().snapshot, draft: createChangesDraft() }, 402);
  try {
    const buttons = (root: Element) => f.nodes(root).filter(node => node.type === 'Button');
    const ids = (root: Element) => buttons(root).map(node => node.props.testID);
    const open = f.sheet('inline', () => {});
    expect(ids(open)).toEqual(expect.arrayContaining(['changes-open-preview', 'changes-wrap', 'changes-layout']));
    expect(ids(open)).not.toContain('changes-diff-refresh');
    expect(ids(open)).not.toContain('changes-first-change');
    expect(ids(open)).not.toContain('changes-copy-diff');
    expect(buttons(open).filter(node => ['changes-open-preview', 'changes-wrap', 'changes-layout'].includes(String(node.props.testID))).map(node => (node.children[0] as Element).props.name)).toEqual(['eye', 'text-wrap', 'layout-column']);
    expect(buttons(open).every(node => !['changes-open-preview', 'changes-wrap', 'changes-layout'].includes(String(node.props.testID)) || node.children.every(child => !!child && typeof child === 'object' && 'type' in child && child.type === 'Icon'))).toBe(true);
    const diff = f.nodes(open).find(node => node.type === 'DiffView')!;
    expect(diff.props.layout).toBe('unified');
  } finally { f.dispose(); }
});

test('canonical validation preserves unknown/invalid authority instead of manufacturing a saved default', () => {
  for (const value of ['inline', 'side-by-side', 'dynamic']) expect(layout.nativeDiffLayoutPreference(value)).toBe(value);
  for (const value of [undefined, null, '', 'split', 'unified', 'INLINE', true, {}, 0]) {
    expect(layout.nativeDiffLayoutPreference(value)).toBeNull(); expect(layout.nativeDiffLayout(value, 1600, false)).toBe('unified');
  }
});

test.each(['unified', 'split'] as const)('production NativeDiffDocument renders the layout its caller resolved (%s)', mode => {
  const f = fixture(), diff = { path: 'a.ts', before: 'old', after: 'new' };
  try {
    const view = f.document({ diff, wrap: false, layout: mode, current: () => true, onReady: () => {}, onError: () => {} });
    expect(view.props.layout).toBe(mode); expect(view.props.oldValue).toBe(diff.before); expect(view.props.newValue).toBe(diff.after);
    expect(view.props.lineNumbers).toBe(true); expect(view.props.contextLines).toBe(3); expect(view.props.inline).toBe('word');
  } finally { f.dispose(); }
});

test.each(['sheet', 'composer'] as const)('public %s forwards layout preference without changing workspace reader, draft or large diff references', async entry => {
  const requests: string[] = [], before = Array.from({ length: 2000 }, (_, index) => `old ${index}`).join('\n'), after = before.replace('old 1000', 'new 1000');
  const reader = model.createChangesReader({ kind: 'workspace', directory: '/fixture' }, async path => {
    requests.push(path); return path.startsWith('/api/git/status?') ? { isClean: false, files: [{ path: 'a.ts', index: 'M', working_dir: 'M' }] } : { original: before, modified: after };
  });
  await reader.refresh(); await reader.select('a.ts');
  const diff = reader.state().diff, snapshot = reader.state().snapshot, draft = createChangesDraft(); draft.replace('retain commit draft', ['retain highlight']);
  const owner = { reader, state: reader.state, snapshot: () => reader.state().snapshot, draft }, f = fixture(owner, 1100);
  try {
    for (const [preference, expected] of [['side-by-side', 'split'], ['inline', 'unified'], ['dynamic', 'split'], [null, 'unified']] as const) {
      expect(f.render(entry, preference).props.layout).toBe(expected);
      expect(reader.state().diff).toBe(diff); expect(reader.state().snapshot).toBe(snapshot); expect(owner.draft.state()).toEqual({ message: 'retain commit draft', highlights: ['retain highlight'] });
    }
    f.width(1099); expect(f.render(entry, 'dynamic').props.layout).toBe('unified');
    expect(f.documents.every(value => value === diff)).toBe(true); expect(requests).toHaveLength(2);
  } finally { f.dispose(); }
});

test('dynamic new-file rule uses workspace status or owned historical metadata/patch, never an empty-before heuristic or current Git for history', async () => {
  const files = [{ path: 'a.ts', index: '?', working_dir: '?' }], snapshot = { isClean: false, files };
  expect(layout.nativeDiffIsNew({ kind: 'workspace', directory: '/fixture' }, snapshot, 'a.ts', null)).toBe(true);
  const source: model.ChangesSource = { kind: 'turn', directory: '/fixture', sessionID: 's', messageID: 'm', files: [{ path: 'a.ts', status: 'added', before: '', after: 'historical' }] };
  const reader = model.createChangesReader(source, async () => { throw new Error('History must not read current Git'); }); await reader.select('a.ts');
  const f = fixture({ reader, state: reader.state, snapshot: () => snapshot, draft: createChangesDraft() }, 1600);
  try { expect(f.render('sheet', 'dynamic').props.layout).toBe('unified'); expect(f.render('sheet', 'side-by-side').props.layout).toBe('split'); } finally { f.dispose(); }
  source.files = [{ path: 'a.ts', before: '', after: 'existing empty file' }];
  expect(layout.nativeDiffIsNew(source, snapshot, 'a.ts', null)).toBe(false);
  expect(layout.nativeDiffIsNew(source, snapshot, 'a.ts', { path: 'a.ts', patch: '--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+new' })).toBe(true);
  source.files[0].status = 'modified';
  expect(layout.nativeDiffIsNew(source, snapshot, 'a.ts', { path: 'a.ts', patch: '--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+new' })).toBe(false);
});

test('historical on-demand added status remains owned metadata for dynamic layout without current Git reads', async () => {
  const calls: string[] = [];
  const reader = model.createChangesReader({ kind: 'turn', directory: '/fixture', sessionID: 's', messageID: 'm', files: [{ path: 'new.ts' }] }, async path => {
    calls.push(path); return { diff: { file: 'new.ts', before: '', after: 'historical new body', status: 'added' } };
  });
  await reader.select('new.ts'); expect(reader.state().diff?.status).toBe('added');
  const f = fixture({ reader, state: reader.state, snapshot: () => null, draft: createChangesDraft() }, 1600);
  try { expect(f.render('sheet', 'dynamic').props.layout).toBe('unified'); expect(calls).toEqual(['/api/yuri/sessions/s/changes?directory=%2Ffixture&messageID=m&file=new.ts']); } finally { f.dispose(); }
});

test.each(['inline', 'side-by-side'] as const)('production %s diff retains native hunk ref, target navigation and stale-completion fence', async preference => {
  const patch = '@@ -8,2 +8,2 @@\n same\n-old\n+new\n@@ -120 +120 @@\n-old target\n+new target';
  const f = fixture(undefined, 1200), onReady = vi.fn(), onError = vi.fn(), goToHunk = vi.fn(); let current = true;
  try {
    const ref = { hunks: vi.fn(async () => [{ index: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }, { index: 1, oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }]), goToHunk };
    const view = f.document({ diff: { path: 'history.ts', patch }, wrap: true, layout: preference === 'side-by-side' ? 'split' : 'unified', current: () => current, targetLine: 120, onReady, onError });
    (view.props.ref as (ref: unknown) => void)(ref); await settle();
    (view.props.onScroll as () => void)(); expect(goToHunk).toHaveBeenCalledExactlyOnceWith(1);
    expect(onReady).toHaveBeenCalled(); expect(view.props.softWrap).toBe(true); expect(view.props.patch).toBe(patch); expect(view.props.oldValue).toBeUndefined();
    const adopted = onReady.mock.calls.length; current = false; (view.props.onStatsChange as () => void)(); await settle();
    expect(onReady).toHaveBeenCalledTimes(adopted); expect(goToHunk).toHaveBeenCalledTimes(1); expect(onError).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});

test.each([
  ['inline', false, 'unified'], ['inline', true, 'unified'],
  ['side-by-side', false, 'split'], ['side-by-side', true, 'split'],
] as const)('production %s diff (wrap=%s) enables only body text selection and preserves native parts', (preference, wrap, expectedLayout) => {
  const f = fixture(), diff = { path: 'selection.ts', before: 'const value = "old";', after: 'const value = "new";' };
  try {
    const view = f.document({ diff, wrap, layout: expectedLayout, current: () => true, onReady: () => {}, onError: () => {} });
    expect(view.type).toBe('DiffView');
    expect(view.props).toEqual({
      testID: 'changes-native-diff', class: 'flex-1', ref: expect.any(Function),
      patch: undefined, oldValue: diff.before, newValue: diff.after, language: diff.path,
      layout: expectedLayout, inline: 'word', indicators: 'classic', contextLines: 3, softWrap: wrap, lineNumbers: true, background: true,
      fontFamily: 'monospace', fontSize: 13, lineHeight: 20,
      classes: {
        side: 'bg-background text-foreground', content: 'select-text', gutter: 'bg-background', lineNumber: 'text-muted-foreground',
        lineAdded: 'bg-success/10', lineDeleted: 'bg-destructive/10', wordAdded: 'bg-success/20', wordDeleted: 'bg-destructive/20',
        indicatorAdded: 'text-success', indicatorDeleted: 'text-destructive', separator: 'bg-secondary text-muted-foreground',
      },
      onStatsChange: expect.any(Function), onScroll: expect.any(Function),
    });
    expect(view.children).toEqual([]);
  } finally { f.dispose(); }
});
