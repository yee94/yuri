import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bindContactAttachmentRead, bindResourceRead, bindResourceStat } from './resources-request';
import { createResourceWatcher } from './resources-watcher';
import { resourceWatchable } from './resources-model';
import { resourceCanPreview } from './resources-model';
import type { ContactAttachment } from './model';
import * as scopeModule from './runtime-scope';
import { bindResourceWebPreview, resourceWebPreviewIntent } from './resource-web-preview';
import { createResourceGuiFile } from './resources-gui';

const scope = (hostID = 'A', suffix = '1') => ({ hostID, lease: `00000000-0000-4000-8000-${suffix.padStart(12, '0')}` });
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
test('resource reader retains a copied constructor receipt and never upgrades null authority', async () => {
  const receipt = scope(), call = vi.fn(async () => ({ lease: 'resource-lease' }));
  const read = bindResourceRead(receipt, call);
  receipt.hostID = 'B'; receipt.lease = scope('B', '2').lease;
  await read('/fixture/file', 'read-1'); await read('/fixture/file', 'read-2');
  expect(call.mock.calls.map(([, body]) => body.expectedHost)).toEqual([scope(), scope()]);
  const absentCall = vi.fn();
  await expect(bindResourceRead(null, absentCall)('/fixture/file', 'read-3')).rejects.toThrow('scope_required');
  expect(absentCall).not.toHaveBeenCalled();
});

type Node = { type: string; props: Record<string, unknown>; children: unknown[] };
/** Execute production component constructors/event handlers with declaration-only
 * JSX/signals, not an NSH engine. Native calls are an in-memory spy. */
function fixture(preloaded?: Record<string, unknown>) {
  let receipt: scopeModule.RuntimeScope | null = scope(), generation = 1, activeLifecycle = 'active';
  const cleanups: Array<() => void> = [], effects: Array<() => void> = [];
  let resolve!: (value: unknown) => void, reject!: (cause: Error) => void;
  const call = vi.fn((name: string, _body: Record<string, unknown>): Promise<unknown> => name === 'resources.read'
    ? new Promise((yes, no) => { resolve = yes; reject = no; }) : Promise.resolve(true));
  const request = vi.fn<(path: string) => Promise<unknown>>(async () => ({ isFile: true, size: 100, mtimeMs: 1, isBinary: false }));
  let presentation: Promise<unknown> | undefined;
  call.mockImplementation((name: string) => name === 'resources.read' ? new Promise((yes, no) => { resolve = yes; reject = no; }) : name === 'resources.present' && presentation ? presentation : Promise.resolve(true));
  const bind = vi.fn(() => request);
  let loaded = false;
  const signal = (initial: unknown) => { let value = initial === null && preloaded && !loaded ? (loaded = true, preloaded) : initial; const read = () => value; read.set = (next: unknown) => { value = next; }; return read; };
  const model = {
    resourcePath: (value: string) => value, resourceName: (value: string) => value.split('/').pop(), resourceWithin: () => true,
    resourceCanPreview, resourceWatchable,
    resourceFence: (epoch: () => number) => { let turn = 0; return { cancel: () => { turn++; }, begin: () => { const token = ++turn, at = epoch(); return () => token === turn && at === epoch(); } }; },
  };
  const guiFactory = vi.fn((_input: Record<string, unknown>) => { throw new Error('Canonical GUI appearance is not supplied by this native-resource fixture'); });
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'resources.tsx'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment' } }).outputText;
  const exports: Record<string, (props: Record<string, unknown>) => Node> = {};
  const modules: Record<string, unknown> = {
    nsh: { signal, computed: (fn: () => unknown) => fn, cleanup: (fn: () => void) => cleanups.push(fn), effect: (fn: () => void) => effects.push(fn), untracked: (fn: () => void) => fn(), lifecycle: () => activeLifecycle, colorScheme: () => 'dark', locale: () => 'ja',
      View: 'View', Text: 'Text', Button: 'Button', Scroll: 'Scroll', Image: 'Image', List: 'List', Clipboard: { writeText: vi.fn() } },
    'nsh/base': { Button: 'Button', Input: 'Input', TextView: 'TextView' },
    './runtime': { native: call, bindRequest: bind },
    './state': { app: { runtimeScope: () => receipt, connection: () => ({ id: receipt?.hostID, url: 'https://fixture.invalid' }) }, epoch: () => generation },
    './runtime-scope': scopeModule, './resources-request': { bindResourceRead, bindContactAttachmentRead, bindResourceStat }, './resources-model': model,
    './resources-watcher': { createResourceWatcher },
    './resource-svg': { ResourceSVGImage: 'NativeSVGImage' },
    './Icon': { Icon: 'Icon' },
    './resource-html-viewer': { ResourceHtmlViewer: 'HTMLViewer' },
    './resource-html-native': { ResourceHTMLView: 'HTMLNative', ResourceHTMLPresentationAnchor: 'HTMLPresentationAnchor' },
    './i18n': { t: (key: string) => key, language: () => 'system' }, './appearance': { nativeChatTextStyle: () => ({}), nativeCodeTextViewStyles: () => ({}), nativeAppearance: { current: () => null } },
    './resources-gui': { createResourceGuiFile }, './gui-plugin-native-context-factory': { bindNativeGuiPluginPreview: guiFactory },
    './resource-web-preview': { bindResourceWebPreview, resourceWebPreviewIntent }, './model': { id: () => 'fixture-read-id' },
  };
  const render = (type: string | ((props: Record<string, unknown>) => Node), props: Record<string, unknown> | null, ...children: unknown[]): Node => {
    if (typeof type === 'function') return type({ ...props, children: children.length === 1 ? children[0] : children });
    if (type === 'Each') {
      const values = props?.of as unknown[];
      return { type, props: props ?? {}, children: values.map(value => (children[0] as (accessor: () => unknown) => Node)(() => value)) };
    }
    return { type, props: props ?? {}, children };
  };
  runInNewContext(compiled, { exports, require: (name: string) => { if (!(name in modules)) throw new Error(`Unexpected import ${name}`); return modules[name]; },
    h: render, If: 'If', Each: 'Each', Fragment: 'Fragment', setTimeout, clearTimeout });
  const nodes = (node: unknown): Node[] => !node || typeof node !== 'object' || !('children' in node) ? [] : [node as Node, ...(node as Node).children.flat(Infinity).flatMap(nodes), ...nodes((node as Node).props.else)];
  return {
    mount: (props: Record<string, unknown> = {}) => exports.ResourcePreview({ directory: '/fixture', path: '/fixture/file', ...props }), call, request, bind, effects, cleanups, guiFactory,
    mountContact: (file: ContactAttachment, props: Record<string, unknown> = {}) => exports.ContactAttachmentPreview({ file, expectedHost: scope(), active: true, ...props }),
    mountBrowser: (props: Record<string, unknown> = {}) => exports.ResourcesBrowser({ directory: '/fixture', path: '/fixture/file', ...props }),
    nodes,
    refresh: (node: Node) => { const button = nodes(node).find(value => value.type === 'Button' && JSON.stringify(value.children).includes('mobile.files.refreshAria')); if (!button) throw new Error('Refresh action missing'); return button.props.onPress as () => void; },
    scope: (value: scopeModule.RuntimeScope | null) => { receipt = value; }, epoch: () => { generation++; }, background: () => { activeLifecycle = 'background'; }, foreground: () => { activeLifecycle = 'active'; },
    resolve: (value: unknown) => resolve(value),
    reject: (cause: Error) => reject(cause),
    presentUntil: (pending: Promise<unknown>) => { presentation = pending; },
  };
}
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
test('production ResourcePreview binds at construction; stale A-B-A cannot borrow a new lease', async () => {
  const f = fixture(), node = f.mount(), refresh = f.refresh(node);
  refresh(); expect(f.call.mock.calls[0]).toEqual(['resources.read', { path: '/fixture/file', requestId: 'fixture-read-id', expectedHost: scope() }]);
  f.resolve({ kind: 'text', lease: 'old-resource', text: 'fixture' }); await flush();
  f.scope(scope('B', '2')); f.scope(scope('A', '3'));
  refresh(); await flush();
  expect(f.call.mock.calls.filter(([name]) => name === 'resources.read')).toHaveLength(1);
  f.cleanups.forEach(fn => fn()); await flush();
  expect(f.call.mock.calls).toContainEqual(['resources.close', { lease: 'old-resource' }]);
  expect(f.call.mock.calls).toContainEqual(['resources.release', { lease: 'old-resource' }]);
});
test('production late result releases the old lease; background cancels the old requestId without acquiring a new scope', async () => {
  const f = fixture(), node = f.mount(); f.refresh(node)();
  f.background(); f.effects.forEach(fn => fn());
  expect(f.call.mock.calls).toContainEqual(['resources.cancel', { requestId: 'fixture-read-id' }]);
  f.resolve({ kind: 'text', lease: 'late-old', text: 'late' }); await flush();
  expect(f.call.mock.calls).toContainEqual(['resources.release', { lease: 'late-old' }]);
  expect(f.call.mock.calls.filter(([name]) => name === 'resources.read')).toHaveLength(1);
});
test('production null authority stays failclosed; inherited preview scope is not replaced by current app scope', async () => {
  const f = fixture(); f.scope(null); const missing = f.mount(); f.scope(scope());
  expect(missing.children).toEqual([]); expect(f.call).not.toHaveBeenCalled();
  const inherited = f.mount({ expectedHost: scope('B', '2') }); expect(inherited.children).toEqual([]); expect(f.call).not.toHaveBeenCalled();
});
test('new foreground owner accepts a new receipt while retained old refresh remains rejected', async () => {
  const f = fixture(), previous = f.refresh(f.mount());
  f.background(); f.epoch(); f.scope(null); f.effects.forEach(fn => fn());
  f.foreground(); f.scope(scope('A', '4'));
  previous(); await flush(); expect(f.call).not.toHaveBeenCalled();
  f.refresh(f.mount())();
  expect(f.call.mock.calls).toEqual([['resources.read', { path: '/fixture/file', requestId: 'fixture-read-id', expectedHost: scope('A', '4') }]]);
});
test('late result checks current native scope even before the cleanup effect runs', async () => {
  const f = fixture(); f.refresh(f.mount())();
  f.scope(scope('B', '2'));
  f.resolve({ kind: 'text', lease: 'late-before-effect', text: 'private old Host' }); await flush();
  expect(f.call.mock.calls).toContainEqual(['resources.release', { lease: 'late-before-effect' }]);
});
test('production Browser child keeps its inherited receipt; late Markdown image cannot borrow the current Host', async () => {
  const browser = fixture(), node = browser.mountBrowser();
  browser.refresh(node)();
  expect(browser.call.mock.calls[0][1].expectedHost).toEqual(scope());
  browser.scope(scope('B', '2')); browser.refresh(node)();
  expect(browser.call.mock.calls.filter(([name]) => name === 'resources.read')).toHaveLength(1);
  const markdown = fixture({ kind: 'text', lease: 'markdown-parent', text: '![fixture](image.png)' });
  const parent = markdown.mount({ path: '/fixture/note.md' });
  const text = markdown.nodes(parent).find(value => value.type === 'TextView');
  expect(text).toBeDefined();
  markdown.scope(scope('B', '2'));
  const image = (text!.props.renderImage as (input: { src: string }) => Node)({ src: 'image.png' });
  expect(image.type).toBe('Each'); expect(image.children).toEqual([]);
  expect(markdown.call).not.toHaveBeenCalled();
});
test('production HTML and Markdown loopback use their constructor receipt; background and retained callbacks stay closed', async () => {
  const html = fixture({ kind: 'text', lease: 'html', text: '<p>fixture</p>' });
  const node = html.mount({ path: '/fixture/index.html' });
  const viewer = html.nodes(node).find(value => value.type === 'HTMLViewer')!;
  const renderPreview = viewer.props.renderPreview as (mount: Record<string, unknown>) => Node;
  const mount = { owner: 'exact-html', identity: 'original', presentation: 'inline' };
  expect(renderPreview(mount).props.config).toEqual({ owner: 'exact-html', directory: '/fixture', path: '/fixture/index.html', lease: 'html', expectedHost: scope() });
  html.scope(scope('B', '2')); html.scope(scope('A', '3'));
  expect((renderPreview(mount).props.config as Record<string, unknown>).expectedHost).toEqual(scope());
  expect(html.call.mock.calls.filter(([name]) => name === 'resources.web.present')).toHaveLength(0);
  const markdown = fixture({ kind: 'text', lease: 'markdown', text: '[test](http://localhost:3000/)' });
  const text = markdown.nodes(markdown.mount({ path: '/fixture/note.md' })).find(value => value.type === 'TextView')!;
  const link = text.props.onLinkPress as (input: { url: string }) => void;
  link({ url: 'http://localhost:3000/' }); await flush();
  expect(markdown.call.mock.calls).toContainEqual(['resources.web.present', { kind: 'loopback', url: 'http://localhost:3000/', expectedHost: scope(), owner: 'fixture-read-id' }]);
  markdown.background(); link({ url: 'http://localhost:3000/' }); await flush();
  expect(markdown.call.mock.calls.filter(([name]) => name === 'resources.web.present')).toHaveLength(1);
  markdown.cleanups.forEach(fn => fn()); await flush();
  expect(markdown.call.mock.calls).toContainEqual(['resources.web.close', { expectedHost: scope(), owner: 'fixture-read-id' }]);
});
test('production file effect captures GUI context from its original owner and never borrows a switched Host', async () => {
  const f = fixture(); f.mount({ path: '/fixture/custom.not-eficy', sessionId: 'explicit-source' });
  f.effects.forEach(fn => fn()); await flush();
  expect(f.guiFactory).toHaveBeenCalledWith(expect.objectContaining({ expectedHost: scope(), appearanceScope: { hostID: 'A', generation: 1, url: 'https://fixture.invalid' }, systemMode: 'dark', locale: 'ja' }));
  expect(f.call.mock.calls.filter(([name]) => name === 'resources.read')).toHaveLength(1);
  f.scope(scope('B', '2')); f.effects.forEach(fn => fn()); await flush();
  expect(f.guiFactory).toHaveBeenCalledTimes(1);
  expect(f.call.mock.calls.every(([name]) => !name.startsWith('plugins.preview.'))).toBe(true); // No fake context fallback.
});
test('production explicit targetLine and inline images keep their native/source lane without GUI capture', async () => {
  const f = fixture(); f.mount({ targetLine: 3 }); f.effects.forEach(fn => fn()); await flush();
  expect(f.guiFactory).not.toHaveBeenCalled();
  const inline = fixture(); inline.mount({ guiPreview: false }); inline.effects.forEach(fn => fn()); await flush();
  expect(inline.guiFactory).not.toHaveBeenCalled();
});

const contactFile = (filename = 'note.md', mime = 'text/markdown'): ContactAttachment => ({
  type: 'file', kind: 'contact', hostID: 'A', assistantID: 'assistant-one', attachmentID: 'opaque-attachment',
  sha256: 'a'.repeat(64), size: 100, mime, filename, name: filename,
});
test.each([0, 7, Number.MAX_SAFE_INTEGER])('contact generation %s roundtrips intact with the captured Host and descriptor identity', async generation => {
  const call = vi.fn(async (_name: string, _body: Record<string, unknown>) => true), read = bindContactAttachmentRead(scope(), call), file = { ...contactFile(), generation };
  await read(file, 'generation-read');
  const body = call.mock.calls[0][1] as { source: { descriptor: Record<string, unknown> }; expectedHost: unknown };
  expect(body).toEqual({ source: { kind: 'contact', assistantID: file.assistantID, descriptor: {
    type: 'file', attachmentID: file.attachmentID, sha256: file.sha256, size: file.size, mime: file.mime, filename: file.filename, generation,
  } }, requestId: 'generation-read', expectedHost: scope() });
  file.generation = 9;
  expect(body.source.descriptor.generation).toBe(generation);
});
test('legacy contact descriptor remains absent-generation, without filling in zero or a runtime lease', async () => {
  const call = vi.fn(async (_name: string, _body: Record<string, unknown>) => true);
  await bindContactAttachmentRead(scope(), call)(contactFile(), 'legacy');
  expect(Object.hasOwn((call.mock.calls[0][1] as { source: { descriptor: object } }).source.descriptor, 'generation')).toBe(false);
});
test.each([null, true, false, [], [1], {}, '0', -1, .5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])('invalid contact generation %j is rejected before native admission', async generation => {
  const call = vi.fn();
  const file = { ...contactFile(), generation } as unknown as ContactAttachment;
  await expect(bindContactAttachmentRead(scope(), call)(file, 'invalid-generation')).rejects.toThrow('invalid_contact_attachment_generation');
  expect(call).not.toHaveBeenCalled();
});
test('expired contact receipt exposes a close action without constructing a reader or upgrading scope', () => {
  for (const next of [null, scope('A', '2'), scope('B', '2')]) {
    const f = fixture(), close = vi.fn(); f.scope(next);
    const node = f.mountContact(contactFile(), { onClose: close });
    const branch = f.nodes(node).find(value => value.type === 'If' && value.props.when === true)!;
    expect(branch).toBeDefined();
    const message = (branch.children[0] as () => Node)();
    expect(JSON.stringify(message)).toContain('mobile.files.error.previewExpired');
    const button = f.nodes(message).find(value => value.type === 'Button')!;
    (button.props.onPress as () => void)(); expect(close).toHaveBeenCalledOnce();
    expect(f.call).not.toHaveBeenCalled(); expect(f.effects).toEqual([]);
  }
});
function button(f: ReturnType<typeof fixture>, node: Node, key: string) {
  const result = f.nodes(node).find(value => value.type === 'Button' && JSON.stringify(value.children).includes(key));
  if (!result) throw new Error('Missing resource action ' + key);
  return result.props.onPress as () => void;
}
test('contact preview reads the verified descriptor and never manufactures fs paths or GUI intents', async () => {
  const f = fixture(), file = contactFile(), node = f.mountContact(file);
  f.refresh(node)();
  expect(f.call.mock.calls).toEqual([['resources.read', {
    source: { kind: 'contact', assistantID: 'assistant-one', descriptor: { type: 'file', attachmentID: file.attachmentID, sha256: file.sha256, size: file.size, mime: file.mime, filename: file.filename } },
    requestId: 'fixture-read-id', expectedHost: scope(),
  }]]);
  f.resolve({ kind: 'text', lease: 'contact-content', text: '# Contact markdown' }); await flush();
  expect(f.guiFactory).not.toHaveBeenCalled();
  expect(f.nodes(node).some(value => JSON.stringify(value.children).includes('mobile.files.copyPathAria'))).toBe(false);
  f.cleanups.forEach(fn => fn()); await flush();
  expect(f.call.mock.calls).toContainEqual(['resources.close', { lease: 'contact-content' }]);
  expect(f.call.mock.calls).toContainEqual(['resources.release', { lease: 'contact-content' }]);
  expect(f.call.mock.calls.every(([name]) => ['resources.read', 'resources.cancel', 'resources.close', 'resources.release'].includes(name))).toBe(true);
});
test.each([
  ['markdown', 'note.md', 'text/markdown', { kind: 'text', text: '# Standalone\n![inline](data:image/png;base64,YQ==)' }],
  ['mime markdown', 'opaque-name', 'text/markdown', { kind: 'text', text: '# MIME Markdown' }],
  ['text', 'note.txt', 'text/plain', { kind: 'text', text: 'literal <script>unsafe()</script>' }],
  ['image', 'image.png', 'image/png', { kind: 'image', thumbnail: 'data:image/png;base64,YQ==' }],
  ['pdf', 'document.pdf', 'application/pdf', { kind: 'pdf', preview: 'quicklook' }],
  ['video', 'video.mp4', 'video/mp4', { kind: 'video', preview: 'avkit' }],
] as const)('contact %s reuses ResourceContent rendering and exact native lease save/share/preview actions', async (_kind, filename, mime, body) => {
  const f = fixture({ ...body, lease: 'verified-contact-lease', size: 100 }), node = f.mountContact(contactFile(filename, mime));
  if (body.kind === 'text') {
    const text = f.nodes(node).find(value => value.type === 'TextView')!;
    expect(text).toBeDefined();
    if (mime === 'text/markdown') expect(text.props.markdown).toBe(body.text);
    else expect(text.props.document).toEqual({ blocks: [{ type: 'codeBlock', code: body.text, language: 'txt' }] });
  } else {
    const preview = f.nodes(node).find(value => value.type === 'Button' && (value.props.testID === 'resource-media-preview' || JSON.stringify(value.children).includes('mobile.files.html.fullscreenAria')))!;
    expect(preview).toBeDefined();
    if (body.kind === 'image') expect(f.nodes(node).find(value => value.type === 'Image')?.props.src).toBe(body.thumbnail);
    (preview.props.onPress as () => void)(); await flush();
    expect(f.call.mock.calls).toContainEqual(['resources.present', { lease: 'verified-contact-lease', action: 'preview' }]);
  }
  button(f, node, 'sessions.scheduledTasks.editor.actions.save')(); await flush();
  button(f, node, 'sessions.sidebar.session.menu.share')(); await flush();
  expect(f.call.mock.calls).toContainEqual(['resources.present', { lease: 'verified-contact-lease', action: 'save' }]);
  expect(f.call.mock.calls).toContainEqual(['resources.present', { lease: 'verified-contact-lease', action: 'share' }]);
  expect(f.guiFactory).not.toHaveBeenCalled();
  expect(f.call.mock.calls.every(([name]) => name === 'resources.present')).toBe(true);
});
test('contact Markdown supports inline raster data but cannot read relative/Host images, follow paths, or execute HTML', async () => {
  const f = fixture({ kind: 'text', lease: 'contact-markdown', text: '# self contained' });
  const node = f.mountContact(contactFile()), text = f.nodes(node).find(value => value.type === 'TextView')!;
  const image = text.props.renderImage as (input: { src: string }) => Node;
  expect(image({ src: 'data:image/png;base64,YQ==' })).toMatchObject({ type: 'Image', props: { src: 'data:image/png;base64,YQ==' } });
  for (const src of ['relative.png', '/work/secret.png', 'http://localhost:3000/image.png', 'https://host.invalid/api/fs/serve/work/a.png', 'data:image/svg+xml;base64,YQ==', 'javascript:alert(1)']) expect(image({ src }).type).toBe('Text');
  const link = text.props.onLinkPress as (event: { url: string }) => void;
  for (const url of ['./other.md', '/work/note.md', 'http://localhost:3000/', 'https://host.invalid/api/fs/serve/work/a.html', 'javascript:alert(1)']) link({ url });
  const html = fixture({ kind: 'text', lease: 'contact-html', text: '<script>unsafe()</script>' });
  const htmlNode = html.mountContact(contactFile('page.html', 'text/html'));
  expect(html.nodes(htmlNode).some(value => ['resource-html-preview', 'resource-gui-preview'].includes(String(value.props.testID)))).toBe(false);
  expect(html.nodes(htmlNode).find(value => value.type === 'TextView')?.props.document).toMatchObject({ blocks: [{ type: 'codeBlock', code: '<script>unsafe()</script>' }] });
  await flush(); expect(f.call).not.toHaveBeenCalled(); expect(html.call).not.toHaveBeenCalled();
});
test('contact lifecycle cancels read IDs, releases late leases, and rejects old Host callbacks before effects', async () => {
  const f = fixture(), node = f.mountContact(contactFile()); f.refresh(node)();
  f.background(); f.effects.forEach(fn => fn());
  expect(f.call.mock.calls).toContainEqual(['resources.cancel', { requestId: 'fixture-read-id' }]);
  f.resolve({ kind: 'text', lease: 'contact-late', text: 'late' }); await flush();
  expect(f.call.mock.calls).toContainEqual(['resources.release', { lease: 'contact-late' }]);
  const switched = fixture({ kind: 'pdf', lease: 'old-host-contact', preview: 'quicklook' });
  const retained = switched.mountContact(contactFile('doc.pdf', 'application/pdf'));
  switched.scope(scope('A', '2'));
  button(switched, retained, 'sessions.sidebar.session.menu.share')(); switched.refresh(retained)(); await flush();
  expect(switched.call).not.toHaveBeenCalled();
  switched.cleanups.forEach(fn => fn()); await flush();
  expect(switched.call.mock.calls).toContainEqual(['resources.close', { lease: 'old-host-contact' }]);
  expect(switched.call.mock.calls).toContainEqual(['resources.release', { lease: 'old-host-contact' }]);
});
test('contact failed refresh retains the previous lease; replacement closes and releases it', async () => {
  const f = fixture({ kind: 'pdf', lease: 'retained', preview: 'quicklook' }), node = f.mountContact(contactFile('doc.pdf', 'application/pdf'));
  f.refresh(node)(); f.reject(new Error('read failed')); await flush();
  button(f, node, 'sessions.sidebar.session.menu.share')(); await flush();
  expect(f.call.mock.calls).toContainEqual(['resources.present', { lease: 'retained', action: 'share' }]);
  expect(f.call.mock.calls.filter(([name]) => name === 'resources.release')).toEqual([]);
  f.refresh(node)(); f.resolve({ kind: 'pdf', lease: 'replacement', preview: 'quicklook' }); await flush();
  expect(f.call.mock.calls).toContainEqual(['resources.close', { lease: 'retained' }]);
  expect(f.call.mock.calls).toContainEqual(['resources.release', { lease: 'retained' }]);
  f.cleanups.forEach(fn => fn()); await flush();
  expect(f.call.mock.calls).toContainEqual(['resources.release', { lease: 'replacement' }]);
});
test('inactive, mismatched and missing contact receipt cannot read or present; same-source hide closes without releasing', async () => {
  const hidden = fixture(), node = hidden.mountContact(contactFile('doc.pdf', 'application/pdf'));
  hidden.effects.forEach(fn => fn()); hidden.resolve({ kind: 'pdf', lease: 'hidden', preview: 'quicklook' }); await flush();
  hidden.background(); hidden.effects.forEach(fn => fn()); await flush();
  expect(hidden.call.mock.calls).toContainEqual(['resources.close', { lease: 'hidden' }]);
  expect(hidden.call.mock.calls.some(([name]) => name === 'resources.release')).toBe(false);
  button(hidden, node, 'sessions.sidebar.session.menu.share')(); await flush();
  expect(hidden.call.mock.calls.some(([name]) => name === 'resources.present')).toBe(false);
  for (const props of [{ active: false }, { active: undefined }, { expectedHost: undefined }, { expectedHost: null }, { expectedHost: scope('B', '2') }]) {
    const f = fixture(), next = f.mountContact(contactFile(), props);
    const refresh = f.nodes(next).find(value => value.type === 'Button' && JSON.stringify(value.children).includes('mobile.files.refreshAria'));
    if (refresh) (refresh.props.onPress as () => void)();
    else expect(f.nodes(next).some(value => value.type === 'If' && value.props.when === true)).toBe(true);
    f.effects.forEach(fn => fn()); await flush();
    expect(f.call).not.toHaveBeenCalled(); expect(f.guiFactory).not.toHaveBeenCalled();
  }
});
test('contact source identity change fences pending adoption and old lease actions even before effects', async () => {
  const file = contactFile(), f = fixture(), node = f.mountContact(file);
  f.refresh(node)(); file.attachmentID = 'replacement-attachment';
  f.resolve({ kind: 'pdf', lease: 'late-descriptor', preview: 'quicklook' }); await flush();
  expect(f.call.mock.calls).toContainEqual(['resources.release', { lease: 'late-descriptor' }]);
  const retainedFile = contactFile(), retained = fixture({ kind: 'pdf', lease: 'old-descriptor', preview: 'quicklook' });
  const retainedNode = retained.mountContact(retainedFile); retainedFile.sha256 = 'b'.repeat(64);
  button(retained, retainedNode, 'sessions.sidebar.session.menu.share')(); await flush();
  expect(retained.call).not.toHaveBeenCalled();
});

test('production SVG passes only the original lease and scope to the dedicated WK image mode and keeps exact save/share', async () => {
  for (const contact of [false, true]) {
    const f = fixture({ kind: 'svg', lease: 'original-svg', preview: 'svg-image', size: 6 });
    const node = contact ? f.mountContact(contactFile('drawing.svg', 'image/svg+xml')) : f.mount({ path: '/fixture/drawing.svg' });
    expect(f.nodes(node).find(value => value.props.testID === 'resource-svg-image')?.props.config).toEqual({ lease: 'original-svg', expectedHost: scope(), active: true });
    expect(f.nodes(node).some(value => value.type === 'TextView' || value.type === 'WebView')).toBe(false);
    const preview = f.nodes(node).find(value => value.props.testID === 'resource-svg-preview')!;
    (preview.props.onPress as () => void)(); await flush();
    button(f, node, 'sessions.scheduledTasks.editor.actions.save')(); await flush();
    button(f, node, 'sessions.sidebar.session.menu.share')(); await flush();
    for (const action of ['preview', 'save', 'share']) expect(f.call.mock.calls).toContainEqual(['resources.present', { lease: 'original-svg', action }]);
    expect(f.call.mock.calls.every(([name]) => name === 'resources.present')).toBe(true);
  }
});

test('production file watcher binds constructor scope; late stat cannot launch a read after background, lease switch or dispose', async () => {
  for (const retire of ['background', 'lease', 'dispose']) {
    const f = fixture({ kind: 'text', lease: 'original', text: 'body', stat: { size: 100, mtimeMs: 1, isBinary: false } });
    f.mount({ path: '/fixture/a.svg', guiPreview: false }); f.effects.forEach(fn => fn());
    f.resolve({ kind: 'text', lease: 'downloaded', text: 'body', stat: { size: 100, mtimeMs: 1, isBinary: false } }); await flush();
    let resolve!: (value: unknown) => void;
    f.request.mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.bind).toHaveBeenCalledWith(scope());
    expect(f.request).toHaveBeenCalledWith('/api/fs/stat?path=%2Ffixture%2Fa.svg');
    if (retire === 'background') f.background(); else if (retire === 'lease') f.scope(scope('A', '2')); else f.cleanups.forEach(fn => fn());
    resolve({ isFile: true, size: 101, mtimeMs: 2, isBinary: false }); await flush();
    expect(f.call.mock.calls.filter(([name]) => name === 'resources.read')).toHaveLength(1);
    f.cleanups.forEach(fn => fn()); await vi.advanceTimersByTimeAsync(10_000);
    expect(f.request).toHaveBeenCalledTimes(1);
  }
});

test('production hidden/contact/bitmap previews have no stat timer; read callbacks remain rejected after disposal', async () => {
  for (const kind of ['contact', 'bitmap', 'hidden']) {
    const f = fixture({ kind: 'text', lease: 'retained', text: 'body' });
    if (kind === 'contact') f.mountContact(contactFile());
    else f.mount({ path: kind === 'bitmap' ? '/fixture/image.png' : '/fixture/file.txt', guiPreview: false, active: kind !== 'hidden' });
    f.effects.forEach(fn => fn()); await vi.advanceTimersByTimeAsync(20_000); expect(f.request).not.toHaveBeenCalled();
    f.cleanups.forEach(fn => fn());
  }
  const f = fixture(), node = f.mount({ guiPreview: false }); f.refresh(node)();
  f.cleanups.forEach(fn => fn()); f.resolve({ kind: 'text', lease: 'after-dispose', text: 'late' }); await flush();
  expect(f.call.mock.calls).toContainEqual(['resources.release', { lease: 'after-dispose' }]);
  f.refresh(node)(); await flush(); expect(f.call.mock.calls.filter(([name]) => name === 'resources.read')).toHaveLength(1);
});

test.each(['save', 'share', 'preview'])('pending stat cannot interrupt production system %s presentation', async action => {
  const f = fixture({ kind: 'pdf', lease: 'seed', preview: 'quicklook' });
  const node = f.mount({ path: '/fixture/document.pdf', guiPreview: false });
  f.effects.forEach(fn => fn());
  f.resolve({ kind: 'pdf', lease: 'original', preview: 'quicklook', stat: { size: 100, mtimeMs: 1, isBinary: false } }); await flush();
  let statDone!: (value: unknown) => void, presentationDone!: (value: unknown) => void;
  f.request.mockReturnValueOnce(new Promise(yes => { statDone = yes; }));
  await vi.advanceTimersByTimeAsync(2_000);
  f.presentUntil(new Promise(yes => { presentationDone = yes; }));
  const trigger = action === 'save' ? button(f, node, 'sessions.scheduledTasks.editor.actions.save')
    : action === 'share' ? button(f, node, 'sessions.sidebar.session.menu.share')
    : f.nodes(node).find(value => value.props.testID === 'resource-media-preview')!.props.onPress as () => void;
  // This constructor-only fixture retains the original tree, whose callbacks read
  // current production signals even though JSX itself is not rerendered here.
  trigger(); await flush();
  expect(f.call.mock.calls).toContainEqual(['resources.present', { lease: 'original', action }]);
  const before = f.call.mock.calls.length;
  statDone({ isFile: true, size: 101, mtimeMs: 2, isBinary: false }); await flush();
  f.refresh(node)(); await flush();
  expect(f.call.mock.calls.slice(before)).toEqual([]);
  await vi.advanceTimersByTimeAsync(4_000);
  expect(f.call.mock.calls.slice(before)).toEqual([]);
  presentationDone(true); await flush();
  f.request.mockResolvedValue({ isFile: true, size: 101, mtimeMs: 2, isBinary: false });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(f.call.mock.calls.slice(before).filter(([name]) => name === 'resources.read')).toHaveLength(1);
  expect(f.call.mock.calls.slice(before).some(([name]) => ['resources.close', 'resources.release'].includes(name))).toBe(false);
  f.resolve({ kind: 'pdf', lease: 'replacement', preview: 'quicklook', stat: { size: 101, mtimeMs: 2, isBinary: false } }); await flush();
  expect(f.call.mock.calls).toContainEqual(['resources.close', { lease: 'original' }]);
  expect(f.call.mock.calls).toContainEqual(['resources.release', { lease: 'original' }]);
  f.cleanups.forEach(fn => fn());
});
