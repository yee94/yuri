import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'desktop-diff-document.tsx');
const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
let position: ts.FunctionDeclaration | undefined;
const functions = new Map<string, ts.FunctionDeclaration>();
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name) { functions.set(node.name.text, node); if (node.name.text === 'position') position = node; }
  ts.forEachChild(node, visit);
}
visit(source);
if (!position) throw new Error('Owning DesktopDiffDocument.position missing');
const code = ts.transpileModule(position.getText(source), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

/** Execute the owning admission function with an isolated native-ref seam.
 * This proves command admission only, not native geometry or runtime behavior. */
function mount(options: { parent?: boolean; retained?: boolean; targetLine?: number; pending?: () => boolean; complete?: () => void; current?: () => boolean } = {}) {
  const body = { path: 'source.ts', before: 'old', after: 'new' }, selection = { side: 'new', start: 4, end: 5 };
  const hunks: number[] = [], selections: unknown[] = [], reports: unknown[] = [];
  const ref = { goToHunk: (index: number) => hunks.push(index), setSelectedLines: (range: unknown) => selections.push(range) };
  const props = {
    targetLine: options.targetLine, current: options.current ?? (() => true),
    retainedView: options.retained ? { body, requestedLine: options.targetLine, selection, hunk: 7 } : undefined,
    navigation: options.pending ? { pending: options.pending, complete: options.complete ?? (() => {}) } : undefined,
  };
  const run = vm.runInNewContext('let positioned = false;\n' + code + '\nposition', {
    props, ref, parentViewport: options.parent === true, alive: true, laidOut: true, loaded: () => true,
    displayed: () => body, focus: () => ({ hunkIndex: 2, selection }), reportSelection: (view: unknown) => reports.push(view),
  }) as () => void;
  return { run, hunks, selections, reports, selection };
}

it('parent documents entering the visible range never navigate to an implicit first hunk', () => {
  const view = mount({ parent: true }); view.run(); view.run();
  expect(view.hunks).toEqual([]); expect(view.selections).toEqual([]); expect(view.reports).toHaveLength(1);
});

it('parent remount restores retained selection without replaying the old hunk or target into the outer List', () => {
  const view = mount({ parent: true, retained: true, targetLine: 5, pending: () => false }); view.run();
  expect(view.hunks).toEqual([]); expect(view.selections).toEqual([view.selection]);
});

it('one explicit target is admitted once across recycled mounts, including a missing async retained receipt', () => {
  let pending = true, completed = 0;
  const navigation = { parent: true, targetLine: 5, pending: () => pending, complete: () => { pending = false; completed++; } };
  const first = mount(navigation); first.run(); first.run();
  const recycled = mount(navigation); recycled.run();
  expect(first.hunks).toEqual([2]); expect(recycled.hunks).toEqual([]); expect(completed).toBe(1);
  pending = true;
  const nextTarget = mount({ ...navigation, retained: true }); nextTarget.run();
  expect(nextTarget.hunks).toEqual([2]); expect(completed).toBe(2);
});

it('own viewport retains its existing hunk restoration and implicit first-change behavior', () => {
  const retained = mount({ retained: true }); retained.run(); expect(retained.hunks).toEqual([7]); expect(retained.selections).toEqual([retained.selection]);
  const fresh = mount(); fresh.run(); expect(fresh.hunks).toEqual([2]); expect(fresh.selections).toEqual([fresh.selection]);
});

it('inactive authority cannot consume navigation and may position only after admission returns', () => {
  let current = false;
  const view = mount({ parent: true, targetLine: 5, current: () => current }); view.run(); expect(view.hunks).toEqual([]);
  current = true; view.run(); expect(view.hunks).toEqual([2]);
});

it('native adoption acknowledgement restores a selection deferred across transient parent visibility loss', async () => {
  const body = { path: 'source.ts' }, range = { side: 'new', start: 1, end: 1 }, selections: unknown[] = [], navigations: number[] = [];
  let current = false, reads = 0, reports = 0;
  const code = ['restoreSelection', 'readHunks'].map(name => {
    const node = functions.get(name); if (!node) throw new Error('Owning function missing: ' + name);
    return ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  }).join('\n');
  const run = vm.runInNewContext('let reading = false, restoring = { body: value, range, anchorLine: 101, ready: false };\n' + code + '\nreadHunks', {
    value: body, range, alive: true, props: { current: () => current }, body: () => body, displayed: () => body,
    ref: { hunks: async () => { reads++; return []; }, setSelectedLines: (value: unknown) => selections.push(value), goToHunk: (index: number) => navigations.push(index) },
    hunks: Object.assign(() => [], { set() {} }), loaded: { set() {} }, viewError: { set() {} }, nativeSourceHunks: () => [], nativeChangeLocation: () => ({ index: 2 }),
    position() {}, reportSelection() { reports++; },
    requestAnimationFrame(callback: () => void) { callback(); return 1; },
  }) as () => Promise<void>;
  await run(); expect(reads).toBe(0); expect(selections).toEqual([]);
  current = true; await run(); expect(reads).toBe(1); expect(selections).toEqual([range]); expect(navigations).toEqual([2]); expect(reports).toBe(1);
  await run(); expect(selections).toEqual([range]); expect(navigations).toEqual([2]); expect(reports).toBe(1);
});
