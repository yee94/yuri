import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, test, vi } from 'vitest';
import { createResourceHtmlViewer, type ResourceHtmlInput, type ResourceHtmlMount, type ResourceHtmlState, type ResourceHtmlViewerController } from './resource-html-viewer-state';

const root = path.dirname(fileURLToPath(import.meta.url));
const initial: ResourceHtmlInput = { identity: 'captured-host/auth/directory/page.html', active: true, htmlFile: true, gui: 'unmatched' };
function deferred() {
  let resolve!: () => void, reject!: (cause: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture() {
  let serial = 0, value: ResourceHtmlState;
  const closePreview = vi.fn<(owner: string) => Promise<void>>().mockResolvedValue(undefined), back = vi.fn();
  const controller = createResourceHtmlViewer({ identifyMount: () => `exact-${++serial}`, closePreview, back, changed: next => { value = next; } });
  return { controller, closePreview, back, state: () => value!, mounts: () => serial };
}

describe('HTML display retirement contract (JS only)', () => {
  test('defaults to inline preview only after authoritative GUI unmatched/bypassed; targetLine always wins', async () => {
    for (const gui of ['preparing', 'matched', 'failed', 'unmatched', 'bypassed'] as const) {
      const f = fixture(); await f.controller.update({ ...initial, gui });
      expect(!!f.state().mount).toBe(gui === 'unmatched' || gui === 'bypassed');
      await f.controller.update({ ...initial, gui, targetLine: 12 });
      expect(f.state().mount).toBeNull(); expect(f.state().mode).toBe('source');
      await f.controller.toggleMode(); expect(f.state().mode).toBe('source');
    }
    const f = fixture(); await f.controller.update({ ...initial, htmlFile: false }); expect(f.mounts()).toBe(0);
  });

  test('50 unrelated content/stat/busy/error adoptions do not remount, reset mode or close WK', async () => {
    const f = fixture(); await f.controller.update(initial); const mounted = f.state().mount;
    for (let index = 0; index < 50; index++) await f.controller.update({ ...initial });
    expect(f.state().mount).toBe(mounted); expect(f.mounts()).toBe(1); expect(f.closePreview).not.toHaveBeenCalled();
    await f.controller.toggleMode();
    for (let index = 0; index < 50; index++) await f.controller.update({ ...initial });
    expect(f.state().mode).toBe('source'); expect(f.mounts()).toBe(1);
  });

  test('fullscreen handoff retires exact old WK before creating the dialog; repeated entry uses one gate', async () => {
    const f = fixture(); await f.controller.update(initial); const old = f.state().mount!;
    const close = deferred(); f.closePreview.mockReturnValueOnce(close.promise);
    const opening = f.controller.setFullscreen(true); const repeat = f.controller.setFullscreen(true);
    expect(repeat).toBe(opening); await settle();
    expect(f.state().mount).toBe(old); expect(f.state().dialog).toBeNull(); expect(f.mounts()).toBe(1);
    close.resolve(); await opening;
    expect(f.closePreview).toHaveBeenCalledExactlyOnceWith(old.owner);
    expect(f.state().mount).toBeNull(); expect(f.state().dialog?.open).toBe(true);
    const generation = f.state().dialog!.generation;
    await f.controller.dialogOpened(generation);
    expect(f.state().mount?.presentation).toBe('fullScreen'); expect(f.mounts()).toBe(2);
    await f.controller.setFullscreen(true); expect(f.mounts()).toBe(2);
  });

  test('source mode survives fullscreen entry and Back exits only fullscreen after true Dialog completion', async () => {
    const f = fixture(); await f.controller.update(initial); await f.controller.toggleMode();
    await f.controller.setFullscreen(true); const generation = f.state().dialog!.generation;
    await f.controller.dialogOpened(generation); expect(f.state().mode).toBe('source'); expect(f.state().mount).toBeNull();
    await f.controller.toggleMode(); const full = f.state().mount!;
    await f.controller.back();
    expect(f.closePreview).toHaveBeenLastCalledWith(full.owner); expect(f.state().dialog?.open).toBe(false);
    expect(f.state().mount).toBeNull(); expect(f.back).not.toHaveBeenCalled();
    await f.controller.dialogClosed(generation + 99); expect(f.state().mount).toBeNull();
    await f.controller.dialogClosed(generation); expect(f.state().mount?.presentation).toBe('inline'); expect(f.state().mode).toBe('preview');
    await f.controller.setFullscreen(true); const next = f.state().dialog!.generation;
    await f.controller.dialogClosed(generation); expect(f.state().dialog?.generation).toBe(next);
    await f.controller.back(generation); expect(f.state().dialog?.open).toBe(true);
    await f.controller.dialogOpened(next); await f.controller.back(); await f.controller.dialogClosed(next);
    await f.controller.back(); expect(f.back).toHaveBeenCalledOnce();
  });

  test('source exits fullscreen as source, then a new path resets to inline preview', async () => {
    const f = fixture(); await f.controller.update(initial); await f.controller.toggleMode();
    await f.controller.setFullscreen(true); const generation = f.state().dialog!.generation;
    await f.controller.dialogOpened(generation); await f.controller.back();
    await f.controller.dialogClosed(generation); expect(f.state().mode).toBe('source'); expect(f.state().mount).toBeNull();
    await f.controller.update({ ...initial, identity: 'captured-host/auth/directory/next.html' });
    expect(f.state().mode).toBe('preview'); expect(f.state().mount?.presentation).toBe('inline');
  });

  test('failed exact close preserves old owner and scope, blocks all fresh mounts until explicit retry', async () => {
    const f = fixture(); await f.controller.update(initial); const old = f.state().mount;
    f.closePreview.mockRejectedValueOnce(new Error('native_close_failed'));
    await f.controller.setFullscreen(true);
    expect(f.state().error).toContain('native_close_failed'); expect(f.state().mount).toBe(old); expect(f.state().dialog).toBeNull();
    await f.controller.update({ ...initial, identity: 'new-host/new-auth/other.html' });
    await f.controller.setFullscreen(true); expect(f.mounts()).toBe(1); expect(f.closePreview).toHaveBeenCalledTimes(1);
    await f.controller.retry(); expect(f.closePreview).toHaveBeenLastCalledWith(old!.owner);
    expect(f.state().mount?.identity).toBe('new-host/new-auth/other.html'); expect(f.state().mode).toBe('preview');
  });

  test('identity and external visibility changes during close adopt only latest intent; background never auto retries failure', async () => {
    const f = fixture(); await f.controller.update(initial); const close = deferred(); f.closePreview.mockReturnValueOnce(close.promise);
    const opening = f.controller.setFullscreen(true); await settle();
    void f.controller.update({ ...initial, identity: 'second.html' }); void f.controller.update({ ...initial, identity: 'third.html', active: false });
    close.resolve(); await opening; expect(f.state().mount).toBeNull(); expect(f.state().dialog).toBeNull();
    await f.controller.update({ ...initial, identity: 'third.html' }); expect(f.state().mount?.identity).toBe('third.html');
    f.closePreview.mockRejectedValueOnce(new Error('retirement_failed'));
    await f.controller.update({ ...initial, identity: 'third.html', active: false });
    await f.controller.update({ ...initial, identity: 'third.html' }); expect(f.mounts()).toBe(2);
    await f.controller.retry(); expect(f.state().mount?.identity).toBe('third.html');
  });

  test('dispose is repeatable, waits WK retirement and dialog completion, and never reopens', async () => {
    const f = fixture(); await f.controller.update(initial); await f.controller.setFullscreen(true);
    const generation = f.state().dialog!.generation; await f.controller.dialogOpened(generation);
    let finished = false; const disposal = f.controller.dispose().then(() => { finished = true; });
    await settle(); expect(finished).toBe(false); expect(f.state().dialog?.open).toBe(false);
    await f.controller.dialogClosed(generation); await disposal; expect(finished).toBe(true);
    await f.controller.update(initial); await f.controller.toggleMode(); expect(f.state().mount).toBeNull();
    const g = fixture(); await g.controller.update(initial); g.closePreview.mockRejectedValueOnce(new Error('cannot_retire'));
    await expect(g.controller.dispose()).rejects.toThrow('cannot_retire'); expect(g.state().mount).not.toBeNull();
    await g.controller.retry(); await g.controller.dispose(); expect(g.state().mount).toBeNull();
  });

  test('native preview failure is explicit and retries only after exact old retirement; late old failures do not touch replacements', async () => {
    const f = fixture(); await f.controller.update(initial); const old = f.state().mount!;
    f.controller.previewFailed(old.owner); expect(f.state().error).toBeTruthy(); expect(f.state().mount).toBe(old);
    await f.controller.update({ ...initial }); expect(f.mounts()).toBe(1);
    await f.controller.retry(); expect(f.closePreview).toHaveBeenLastCalledWith(old.owner); expect(f.mounts()).toBe(2);
    const replacement = f.state().mount; f.controller.previewFailed(old.owner); expect(f.state().mount).toBe(replacement); expect(f.state().error).toBe('');
  });

  test('source fullscreen teardown waits for the pending system presentation and the exact dialog completion', async () => {
    const f = fixture(); await f.controller.update(initial); await f.controller.toggleMode(); await f.controller.setFullscreen(true);
    const generation = f.state().dialog!.generation; await f.controller.dialogOpened(generation);
    await f.controller.setPresentationPending(true); await f.controller.toggleMode(); await f.controller.back(generation);
    expect(f.state().mode).toBe('source'); expect(f.state().dialog?.open).toBe(true);
    await f.controller.update({ ...initial, active: false }); expect(f.state().dialog?.open).toBe(true);
    const retired = f.controller.waitRetired(); let ended = false; void retired.then(() => { ended = true; });
    await f.controller.setPresentationPending(false); expect(f.state().dialog?.open).toBe(false); expect(ended).toBe(false);
    await f.controller.dialogClosed(generation); await retired; expect(ended).toBe(true);
  });
});

type Node = { type: string; props: Record<string, unknown>; children: unknown[] };
/** Evaluate the actual production JSX with lazy properties, not the NSH engine.
 * The renderer exposes real production callback closures; no native ACK is inferred. */
function productionFixture() {
  let serial = 0, controller!: ResourceHtmlViewerController, input = initial;
  const effects: Array<() => void> = [], closePreview = vi.fn<(owner: string) => Promise<void>>().mockResolvedValue(undefined), back = vi.fn();
  const preview = vi.fn((mount: ResourceHtmlMount): Node => ({ type: 'WKPort', props: { ...mount, testID: 'wk-port' }, children: [] }));
  const jsx = (type: string, props: Record<string, unknown> | null, ...children: unknown[]): Node => ({ type, props: props ?? {}, children });
  const lazy: ts.TransformerFactory<ts.SourceFile> = context => file => {
    const visit: ts.Visitor = node => {
      const next = ts.visitEachChild(node, visit, context);
      if (!ts.isCallExpression(next) || !ts.isIdentifier(next.expression) || next.expression.text !== 'jsx') return next;
      const [type, props, ...children] = next.arguments;
      const reactive = props && ts.isObjectLiteralExpression(props) ? ts.factory.updateObjectLiteralExpression(props, props.properties.map(property => ts.isPropertyAssignment(property)
        ? ts.factory.createGetAccessorDeclaration(undefined, property.name, [], undefined, ts.factory.createBlock([ts.factory.createReturnStatement(property.initializer)])) : property)) : props;
      return ts.factory.updateCallExpression(next, next.expression, next.typeArguments, [type, reactive, ...children.map(child => ts.factory.createArrowFunction(undefined, undefined, [], undefined, ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), child))]);
    };
    return ts.visitNode(file, visit) as ts.SourceFile;
  };
  const exports = {} as typeof import('./resource-html-viewer');
  const modules: Record<string, unknown> = {
    nsh: { View: 'View', Text: 'Text', signal: <T>(value: T) => Object.assign(() => value, { set: (next: T) => { value = next; } }), effect: (work: () => void) => { effects.push(work); work(); }, untracked: (work: () => void) => work(), cleanup: () => {} },
    'nsh/base': { Button: 'Button', Dialog: 'Dialog', NavPage: 'NavPage', NavStack: 'NavStack', createNavStack: (routes: string[]) => ({ routes: () => routes }) },
    './i18n': { t: (key: string) => key }, './Icon': { Icon: 'Icon' }, './resource-html-viewer-state': { createResourceHtmlViewer },
  };
  const output = ts.transpileModule(readFileSync(path.join(root, 'resource-html-viewer.tsx'), 'utf8'), { fileName: 'resource-html-viewer.tsx',
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' }, transformers: { after: [lazy] } }).outputText;
  vm.runInNewContext(output, { exports, jsx, If: 'If', Each: 'Each', require: (id: string) => { if (!(id in modules)) throw new Error('Unexpected viewer dependency: ' + id); return modules[id]; } });
  const tree = exports.ResourceHtmlViewer({ get input() { return input; }, title: 'page.html', identifyMount: () => `production-${++serial}`, closePreview,
    renderPreview: preview, renderSource: () => ({ type: 'TextView', props: { testID: 'original-source', selectable: true, links: 'report' }, children: [] }),
    renderStatus: () => null, renderActions: owner => ({ type: 'ActionsPort', props: { owner }, children: [] }), presentationAnchor: owner => ({ type: 'AnchorPort', props: { owner }, children: [] }),
    controllerReady: value => { controller = value; }, onBack: back });
  function nodes(): Node[] {
    const result: Node[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'function') { walk(value()); return; }
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (!value || typeof value !== 'object' || !('type' in value)) return;
      const node = value as Node;
      if (node.type === 'If') { if (node.props.when) node.children.forEach(walk); else walk(node.props.else); return; }
      if (node.type === 'Each') { for (const item of node.props.of as unknown[]) for (const child of node.children) walk((child as () => (value: () => unknown) => unknown)()(() => item)); return; }
      result.push(node);
      for (const key of ['headerLeft', 'headerRight', 'header']) walk(node.props[key]);
      node.children.forEach(walk);
    };
    walk(tree); return result;
  }
  const find = (id: string) => { const value = nodes().find(node => node.props.testID === id); if (!value) throw new Error('Missing production node ' + id); return value; };
  return { controller: () => controller, nodes, find, closePreview, back, preview, update(value: ResourceHtmlInput) { input = value; effects.forEach(work => work()); }, press(id: string) { const node = find(id); if (node.props.disabled) throw new Error('Disabled production action'); (node.props.onPress as () => void)(); } };
}

test('production JSX callbacks switch the original source port, present native fullScreen/header actions, and Back preserves file detail', async () => {
  const f = productionFixture(); await settle(); expect(f.find('wk-port').props.presentation).toBe('inline');
  f.press('resource-html-mode'); await settle(); expect(f.find('original-source').props).toMatchObject({ selectable: true, links: 'report' });
  f.press('resource-html-fullscreen'); await settle();
  let dialog = f.find('resource-html-dialog'); expect(dialog.props.presentation).toBe('fullScreen'); expect(dialog.props.open).toBe(true);
  expect(f.nodes().some(node => node.type === 'NavStack')).toBe(true); expect(f.nodes().some(node => node.type === 'NavPage')).toBe(true);
  (dialog.props.onOpen as () => void)(); await settle(); f.press('resource-html-mode'); await settle();
  expect(f.find('wk-port').props.presentation).toBe('fullScreen');
  f.closePreview.mockRejectedValueOnce(new Error('native_refused')); f.press('resource-html-back'); await settle();
  expect(f.find('resource-html-close-error')).toBeDefined(); expect(f.find('resource-html-dialog').props.open).toBe(true);
  const retained = f.find('wk-port').props.owner; f.press('resource-html-retry'); await settle();
  expect(f.closePreview).toHaveBeenLastCalledWith(retained); dialog = f.find('resource-html-dialog'); expect(dialog.props.open).toBe(true);
  expect(f.controller().state().dialog?.open).toBe(false);
  expect(f.nodes().filter(node => node.type === 'WKPort')).toHaveLength(0); expect(f.back).not.toHaveBeenCalled();
  (dialog.props.onClose as () => void)(); await settle(); expect(f.find('wk-port').props.presentation).toBe('inline');
  const mount = f.controller().state().mount;
  for (let i = 0; i < 50; i++) f.update({ ...initial });
  await settle(); expect(f.controller().state().mount).toBe(mount);
});

test('all reused viewer strings exist in all ten shipped dictionaries', async () => {
  for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'pl', 'pt-BR', 'uk']) {
    const { dict } = await import(`../ui/src/lib/i18n/messages/${locale}.ts`) as { dict: Record<string, string> };
    for (const key of ['mobile.files.html.fullscreenAria', 'mobile.files.html.exitFullscreenAria', 'mobile.files.html.viewSourceAria', 'mobile.files.html.viewPreviewAria', 'header.actions.backAria', 'mobile.files.error.readUnavailable', 'contextPanel.preview.actions.retry']) expect(dict[key], `${locale}: ${key}`).toBeTypeOf('string');
  }
});

test('production rendering keeps targetLine source and never starts HTML for GUI preparing/matched/failed', async () => {
  const f = productionFixture(); await settle();
  f.update({ ...initial, targetLine: 12 }); await settle();
  expect(f.find('original-source')).toBeDefined(); expect(f.nodes().filter(node => node.type === 'WKPort')).toHaveLength(0);
  expect(f.nodes().some(node => node.props.testID === 'resource-html-mode')).toBe(false);
  for (const gui of ['preparing', 'matched', 'failed'] as const) {
    f.update({ ...initial, identity: `next-${gui}.html`, gui }); await settle();
    expect(f.nodes().filter(node => node.type === 'WKPort')).toHaveLength(0);
    expect(f.nodes().some(node => node.props.testID === 'resource-html-fullscreen')).toBe(false);
  }
  f.update({ ...initial, identity: 'next-failed.html', gui: 'unmatched' }); await settle(); expect(f.find('wk-port')).toBeDefined();
});
