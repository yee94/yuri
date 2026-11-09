import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { nativeLayoutDensity, nativeSheetSpacing } from './native-density';
import { createSheetPresentation, systemSheetContentStyle } from './sheet-presentation';
import { worktreeFormLayout } from './projects-presentation';
import { nativeTypographyStyle } from './appearance-core';

type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] };
const root = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const jsx = (type: unknown, props: Node['props'], ...children: unknown[]): Node => ({ type, props: props ?? {}, children });
function compile(source: string) {
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' } }).outputText;
}
function opening(file: string, tag: string, match: string) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let result = '';
  const visit = (node: ts.Node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === tag && node.getText(source).includes(match) && !result) {
      result = node.getText(source); if (ts.isJsxOpeningElement(node)) result = result.slice(0, -1) + '/>';
    }
    ts.forEachChild(node, visit);
  };
  visit(source); if (!result) throw new Error(`Missing ${file} ${tag} ${match}`);
  return result;
}
function render(source: string, environment: Record<string, unknown>) {
  const exports: { render?: () => Node } = {};
  vm.runInNewContext(compile(`exports.render = () => (${source});`), { exports, jsx, Scroll: 'Scroll', Input: 'Input', View: 'View', List: 'List', ...environment });
  return exports.render!();
}
function binding(file: string, name: string, environment: Record<string, unknown>) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer = '';
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) initializer = node.initializer.getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!initializer) throw new Error(`Missing ${file} binding ${name}`);
  return vm.runInNewContext(compile(`(${initializer})`), environment) as () => Record<string, unknown>;
}
const settingsPages = ['notification-settings', 'settings-usage', 'settings-quota-credentials', 'settings-projects', 'settings-preferences', 'settings-providers', 'settings-magic-prompts', 'settings-git', 'settings-about', 'settings-archive', 'settings-collections', 'settings-basics'];

describe('real Settings outer Scroll density props', () => {
  it.each([50, 100, 105, 200])('preserves Web custom-variable inset/section gap and original scroll/target callbacks at %s%%', padding => {
    const density = nativeLayoutDensity(padding), navigation = { onScroll: vi.fn() }, previewVisibility = { onScroll: vi.fn(), onViewportLayout: vi.fn() }, scroll = vi.fn();
    for (const file of settingsPages) {
      const node = render(opening(file + '.tsx', 'Scroll', 'contentClass="p-5 gap-5 pb-10"'), { nativeDensity: () => density, scroll, navigation, previewVisibility });
      const entity = file === 'settings-projects' || file === 'settings-providers', scale = Math.sqrt(padding / 100);
      expect(node.props.contentStyle).toEqual({ paddingHorizontal: entity ? 18 + 12 * scale : 18, paddingTop: 12 * scale, paddingBottom: entity ? 12 * scale : 24, gap: 20 });
      if (node.props.onScroll) {
        const event = { contentOffset: { y: 47 } };
        (node.props.onScroll as (event: unknown) => void)(event);
        expect(navigation.onScroll).toHaveBeenLastCalledWith(event);
        if (file === 'settings-preferences') {
          expect(previewVisibility.onScroll).toHaveBeenLastCalledWith(event);
          expect(node.props.onLayout).toBe(previewVisibility.onViewportLayout);
        }
      }
      if (node.props.ref && file !== 'settings-collections') expect(node.props.ref).toBe(scroll);
    }
    const node = render(opening('settings.tsx', 'Scroll', 'contentClass='), { nativeDensity: () => density, props: { bottomInset: 29 } });
    expect((node.props.contentStyle as { paddingTop: number }).paddingTop).toBe(16);
    expect((node.props.contentStyle as { paddingBottom: number }).paddingBottom).toBe(29 + 40);
  });

  it('maps Settings fixed geometry to its real CSS definitions and var consumers', () => {
    const css = read('../ui/src/styles/settings.css'), mobile = read('../ui/src/styles/mobile.css');
    expect(css).toContain('--yuri-settings-section-stack-gap: 1.25rem;');
    expect(css).toContain('gap: var(--yuri-settings-section-stack-gap);');
    expect(mobile).toContain('--yuri-mobile-page-inline-inset: 1.125rem;');
    expect(read('../ui/src/components/views/SettingsView.tsx')).toContain('px-[var(--yuri-mobile-page-inline-inset)]');
    expect(mobile).toContain('padding: 0.75rem 0 calc(var(--yuri-mobile-dock-height) + 1.5rem);');
    expect(read('../ui/src/components/sections/providers/ProvidersPage.tsx')).toContain('yuri-settings-section-stack mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8');
  });
});

describe('real Bot/Task fields and list props', () => {
  it.each([50, 100, 105, 200])('ProjectDetail %s%% keeps its geometry refs/layout callback and exact form edit callback', padding => {
    const density = nativeLayoutDensity(padding), contentRef = {}, onContentLayout = vi.fn();
    const node = render(opening('projects.tsx', 'View', 'class="p-4 gap-4"'), { nativeDensity: () => density, scroll: { contentRef, onContentLayout } });
    expect(node.props.ref).toBe(contentRef); expect(node.props.onLayout).toBe(onContentLayout);
    expect(node.props.style).toEqual({ padding: 16 * density.scale, gap: 16 * density.scale });
    const editBranch = vi.fn(), touched = { set: vi.fn() };
    const formLayout = binding('projects.tsx', 'formLayout', { worktreeFormLayout, nativeDensity: () => density });
    const inputStyle = binding('projects.tsx', 'inputStyle', { formLayout, nativeChatTextStyle: () => nativeTypographyStyle(null, 'markdown') });
    const input = render(opening('projects.tsx', 'Input', 'testID="projects-worktree-branch"'), { inputStyle, formLayout, nativeDensity: () => density, field: 'existing-field', branch: () => 'prior', worktreeEditingDisabled: () => false, form: { editBranch, touched }, t: (key: string) => key });
    expect(input.props.value).toBe('prior'); expect(input.props.autoCorrect).toBe(false);
    (input.props.onChange as (event: unknown) => void)({ value: 'feature/new' });
    expect(editBranch).toHaveBeenCalledExactlyOnceWith('feature/new');
    const editFolder = vi.fn();
    const folder = render(opening('projects.tsx', 'Input', 'testID="projects-worktree-folder"'), { inputStyle, formLayout, selectedFolder: () => 'prior-folder', worktreeEditingDisabled: () => false, form: { editFolder, touched }, t: (key: string) => key });
    expect(folder.props.value).toBe('prior-folder'); expect(folder.props.autoCorrect).toBe(false);
    (folder.props.onChange as (event: { value: string }) => void)({ value: 'new-folder' });
    expect(editFolder).toHaveBeenCalledExactlyOnceWith('new-folder');
    for (const field of [input, folder]) {
      const style = field.props.style as { minHeight: number }, hitSlop = field.props.hitSlop as { top: number; bottom: number; left: number; right: number };
      expect(style.minHeight).toBe(36);
      expect(hitSlop).toEqual({ top: 4, bottom: 4, left: 0, right: 0 });
      expect(style.minHeight + hitSlop.top + hitSlop.bottom).toBeGreaterThanOrEqual(44);
      const layout = worktreeFormLayout(density.scale);
      expect(hitSlop.top).toBeLessThanOrEqual(layout.group.gap);
      expect(hitSlop.top + hitSlop.bottom).toBeLessThanOrEqual(layout.fields.gap);
      (field.props.onBlur as () => void)();
    }
    expect(touched.set).toHaveBeenCalledTimes(2); expect(touched.set).toHaveBeenLastCalledWith(true);
  });

  it.each([50, 100, 105, 200])('keeps fields, exact edit callbacks, list keys/rows/ref and prior reader at %s%%', padding => {
    const density = nativeLayoutDensity(padding);
    for (const [id, signalName] of [['features-bot-name', 'name'], ['features-task-name', 'name'], ['features-timezone', 'timezone'], ['features-cron', 'cron']]) {
      let value = 'original'; const set = vi.fn((next: string) => { value = next; });
      const node = render(opening('features.tsx', 'Input', `testID="${id}"`), { nativeDensity: () => density, field: 'existing-field', [signalName]: Object.assign(() => value, { set }), disabled: () => false, t: (key: string) => key });
      expect(node.props.value).toBe('original'); expect(node.props.testID).toBe(id);
      expect((node.props.style as { minHeight: number }).minHeight).toBeGreaterThanOrEqual(44);
      (node.props.onChange as (event: unknown) => void)({ value: '编辑中' }); expect(set).toHaveBeenCalledExactlyOnceWith('编辑中');
    }
    const rows = [{ id: 'run-b' }, { id: 'run-a' }], load = vi.fn(), reader = { runs: () => rows, loading: () => false, load };
    const node = render(opening('schedules.tsx', 'List', 'testID="scheduled-history"'), { nativeDensity: () => density, history: reader, props: { bottomInset: 29 }, View: 'View', If: 'If', Text: 'Text', Button: 'Button', action: 'action', t: (key: string) => key });
    expect(node.props.each).toBe(rows); expect(rows.map(node.props.keyExtractor as (row: { id: string }) => string)).toEqual(['run-b', 'run-a']);
    expect((node.props.contentStyle as { paddingBottom: number }).paddingBottom).toBeCloseTo(29 + 32 * density.scale);
    (node.props.onRefresh as () => void)(); expect(load).toHaveBeenCalledOnce(); expect(node.props.each).toBe(rows);
  });
});

describe('real NativeSheet decoration and presentation', () => {
  it.each([50, 100, 105, 200])('scales only approved class spacing at %s%% and preserves the system owner/callbacks', padding => {
    const exports = {} as typeof import('./native-sheet');
    const signal = <T>(value: T) => Object.assign(() => value, { set(next: T) { value = next; } });
    vm.runInNewContext(compile(read('native-sheet.tsx')), { exports, jsx, Each: 'Each', require(id: string) {
      if (id === 'nsh') return { View: 'View', platform: { os: 'ios' }, signal, nativeComponent: () => 'Presentation', effect: (work: () => void) => work(), cleanup: () => {}, untracked: (work: () => void) => work(), keymap: { bind: () => () => {} } };
      if (id === 'nsh/base') return { Dialog: 'Dialog', Sheet: 'Sheet' };
      if (id === './sheet-presentation') return { createSheetPresentation, systemSheetContentStyle };
      if (id === './appearance') return { nativeDensity: () => nativeLayoutDensity(padding) };
      if (id === './native-density') return { nativeSheetSpacing };
      throw new Error(id);
    } });
    const onOpen = vi.fn(), onClose = vi.fn(), change = vi.fn(), child = { identity: 'same-input-owner' };
    const tree = exports.NativeSheet({ open: true, popupClass: 'bg-card rounded-t-3xl p-5 gap-3', popupStyle: { height: 480, marginBottom: 79, width: 390, paddingBottom: 'env(safe-area-inset-bottom)' }, children: child as never, detents: [.4, .9], onOpen, onClose, onOpenChange: change }) as Node;
    expect(tree.props.of).toEqual([1]);
    const dialog = (tree.children[0] as (generation: () => number) => Node)(() => 1), registration = dialog.children[0] as Node, content = dialog.children[1] as Node;
    const styles = Object.assign({}, ...(content.props.style as unknown[])) as Record<string, unknown>;
    expect(styles.padding).toBeCloseTo(20 * Math.sqrt(padding / 100)); expect(styles.gap).toBeCloseTo(12 * Math.sqrt(padding / 100));
    expect(styles.paddingTop).toBe(12);
    expect(styles.width).toBe(390); expect(styles.paddingBottom).toBe('env(safe-area-inset-bottom)');
    expect(styles).not.toHaveProperty('height'); expect(styles).not.toHaveProperty('marginBottom'); expect(styles).not.toHaveProperty('borderRadius');
    expect(content.children).toEqual([child]); expect(registration.props.detents).toEqual([.4, .9]); expect(dialog.props.presentation).toBe('pageSheet');
    (registration.props.onOpened as (event: unknown) => void)({ generation: 1 }); expect(onOpen).toHaveBeenCalledOnce();
    (registration.props.onDismissed as (event: unknown) => void)({ generation: 1, interactive: true });
    expect(change).toHaveBeenCalledExactlyOnceWith({ open: false, reason: 'swipe' }); expect(onClose).toHaveBeenCalledOnce();
  });

  it('uses a closed rem utility map and never interprets arbitrary px, var, calc, font, radius or system geometry', () => {
    const density = nativeLayoutDensity(200);
    const styles = nativeSheetSpacing('p-5 gap-3 p-[20px] px-[var(--inset)] pb-[calc(env(safe-area-inset-bottom)+2rem)] rounded-3xl text-lg h-[80%]', density);
    expect(styles).toEqual([{ padding: 20 * Math.sqrt(2) }, { gap: 12 * Math.sqrt(2) }]);
  });
});
