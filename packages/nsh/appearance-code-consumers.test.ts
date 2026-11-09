import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import ts from 'typescript';
import { beforeEach, expect, it, vi } from 'vitest';
import { appearanceFromSettings } from './appearance-core';
import { voiceTestTranscriptDocument } from './settings-voice-test-presentation';

const boundary = vi.hoisted(() => ({ request: vi.fn(), native: vi.fn(), loadDevice: vi.fn(), effects: vi.fn(), layout: vi.fn(), readmeLink: vi.fn() }));
vi.mock('nsh', () => ({
  signal: <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); },
  colorScheme: () => 'light', effect: boundary.effects,
  computed: <T>(read: () => T) => read,
}));
vi.mock('./state', () => ({ app: {}, captureHostRequest: boundary.request, epoch: () => 1 }));
vi.mock('./runtime', () => ({ native: boundary.native }));
vi.mock('./device-appearance', () => ({ deviceAppearance: () => null, loadDeviceAppearance: boundary.loadDevice }));
vi.mock('./i18n', () => ({ t: (key: string) => key }));
import { nativeAppearance, nativeCodeTextViewStyles, nativeChatTextStyle } from './appearance';
import { nativeTranscriptMarkdownStyles } from './transcript-body-markdown';

const root = path.dirname(fileURLToPath(import.meta.url));
function productionSources(directory = root): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith('.') || ['node_modules', 'tests', 'scripts', 'assets'].includes(entry.name)) return [];
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(file);
    return /\.tsx$/.test(entry.name) && !/(?:\.test|-fixture|-test-app)\.tsx$/.test(entry.name) ? [path.relative(root, file)] : [];
  });
}
function textViews(file: string) {
  const source = ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set(['TextView']);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== 'nsh/base') continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const imported of bindings.elements) {
      if ((imported.propertyName ?? imported.name).text === 'TextView') names.add(imported.name.text);
    }
    if (bindings && ts.isNamespaceImport(bindings)) names.add(`${bindings.name.text}.TextView`);
  }
  const nodes: ts.JsxSelfClosingElement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && names.has(node.tagName.getText(source))) nodes.push(node);
    if (ts.isJsxOpeningElement(node) && names.has(node.tagName.getText(source))) throw new Error(`Paired TextView needs an explicit renderer fixture: ${file}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return nodes.map(node => {
    const code = ts.transpileModule(`(${node.getText(source)})`, { compilerOptions: { jsx: ts.JsxEmit.React, jsxFactory: 'h', target: ts.ScriptTarget.ES2022 } }).outputText;
    // Render the actual production JSX props only. Components, lifecycle, routes,
    // event handlers and transport are never mounted or invoked by this harness.
    return (richMode = false, role: 'user' | 'assistant' = 'assistant') => new Script(code).runInNewContext({
      TextView: 'TextView', h: (_type: unknown, props: Record<string, unknown>) => props,
      nativeCodeTextViewStyles, nativeChatTextStyle, nativeTranscriptMarkdownStyles,
      text: (value: unknown) => String(value ?? ''), record: (value: unknown) => value ?? {}, t: (key: string) => key,
      task: () => ({ execution: { prompt: 'task `inline`\n```ts\nconst task = 1\n```' } }),
      turn: () => ({ answer: 'BTW `inline`\n```ts\nconst btw = 1\n```' }),
      props: { card: { summary: 'summary `inline`', error: {} }, job: { id: 'job-fixture', status: 'failed' },
        part: { key: 'part-fixture', source: { type: 'text', text: 'body `inline`\n```ts\nconst body = 1\n```' } },
        value: 'literal tool `output`', content: 'thought `inline`\n```ts\nconst thought = 1\n```' },
      route: { content: '# README\n```ts\nconst readme = 1\n```' },
      expanded: () => true, failure: () => ({ error: 'error first\nerror second\nerror third' }),
      content: () => file === 'resources.tsx' ? { text: 'resource `inline`\n```ts\nconst resource = 1\n```' } : 'content `inline`\n```ts\nconst content = 1\n```',
      rich: () => richMode, name: () => 'fixture.ts',
      readme: () => ({ readme: '# README\n```ts\nconst readme = 1\n```' }), readmeLink: boundary.readmeLink,
      execution: () => ({ prompt: 'execution `inline`\n```ts\nconst prompt = 1\n```' }),
      value: (_key: string) => 'system `inline`\n```ts\nconst system = 1\n```', key: 'system',
      message: () => ({ role, text: 'archive `inline`\n```ts\nconst archive = 1\n```', reasoning: 'archive thought `inline`' }),
      presentation: () => ({ content: 'reasoning `inline`\n```ts\nconst reasoning = 1\n```' }),
      role: () => role, clamped: () => true, measured: { set: boundary.layout },
      details: () => ({ output: 'tool task `inline`\n```ts\nconst output = 1\n```' }),
      rowStyle: () => ({ fontSize: 12, lineHeight: 18, fontFamily: 'Tool Body Fixture' }),
      state: () => ({ partial: 'literal `inline`\n```ts\nconst literal = 1\n```' }), voiceTestTranscriptDocument,
    }) as Record<string, unknown>;
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  nativeAppearance.current.set({ ...await appearanceFromSettings({ fontSize: 75 }, async () => ({})), codeFontSize: 100,
    uiFontFamily: 'Body Fixture', monoFontFamily: 'Code Fixture', assistantFontFamilies: { light: 'Assistant Fixture', dark: 'Assistant Fixture' }, unsupportedFonts: [] });
});

const codeConsumers = productionSources().map(file => ({ file, renders: textViews(file) }))
  .filter(({ file, renders }) => file !== 'settings-voice-test.tsx' && renders.length > 0);
const stableProps = (props: Record<string, unknown>) => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(props).filter(([key]) => key !== 'styles')),
  (_key, value: unknown) => typeof value === 'function' ? value.toString() : value));

it('discovers every production TextView, including import aliases, and explicitly accounts for all code and literal consumers', () => {
  expect(Object.fromEntries(codeConsumers.map(({ file, renders }) => [file, renders.length]))).toEqual({
    'application.tsx': 3, 'chat-btw.tsx': 1, 'history-import.tsx': 1, 'resources.tsx': 1, 'schedules.tsx': 1, 'settings-archive.tsx': 2,
    'settings-collections.tsx': 1, 'settings-plugin-runtime.tsx': 1, 'settings-skill-files.tsx': 1,
    'setup-tour.tsx': 1, 'transcript-body.tsx': 4, 'transcript-tools.tsx': 2,
  });
  expect(textViews('settings-voice-test.tsx')).toHaveLength(1);
});

it.each([50, 100, 200])('every actual code TextView uses %i%% code size while preserving body, selection/link/action props and all handler bodies', scale => {
  const consumers = codeConsumers.flatMap(({ file, renders }) => {
    return renders.flatMap(render => (file === 'resources.tsx' ? [false, true] : [false]).flatMap(rich => (['user', 'assistant'] as const).map(role => {
      const mountedProps = () => render(rich, role);
      return { file, render: mountedProps, before: mountedProps() };
    })));
  });
  nativeAppearance.current.set({ ...nativeAppearance.current()!, codeFontSize: scale });
  for (const { file, render, before } of consumers) {
      const props = render(), styles = props.styles as ReturnType<typeof nativeCodeTextViewStyles>;
      if (file !== 'transcript-body.tsx' && file !== 'transcript-tools.tsx') {
        expect(Object.keys(styles).sort(), file).toEqual(['code', 'codeBlockCode']);
        expect(props.style, file).toBeUndefined();
      }
      expect(styles.code, file).toEqual({ fontSize: 13 * scale / 100, fontFamily: 'Code Fixture' });
      expect(styles.codeBlockCode, file).toEqual({ fontSize: 13 * scale / 100, fontFamily: 'Code Fixture', lineHeight: 20 * scale / 100 });
      expect(stableProps(props), file).toEqual(stableProps(before));
      const previousStyles = before.styles as Record<string, unknown>;
      expect(Object.fromEntries(Object.entries(styles).filter(([key]) => key !== 'code' && key !== 'codeBlockCode')), file)
        .toEqual(Object.fromEntries(Object.entries(previousStyles).filter(([key]) => key !== 'code' && key !== 'codeBlockCode')));
      expect(props.class, file).toBe(before.class);
      expect(props.selectable, file).toBe(true); expect(props.links, file).toBe(before.links);
      expect(props.markdown, file).toBe(before.markdown);
      expect(JSON.stringify(props.document), file).toBe(JSON.stringify(before.document));
      expect(typeof props.onLinkPress, file).toBe(typeof before.onLinkPress);
      expect(typeof props.renderImage, file).toBe(typeof before.renderImage);
  }
  expect(boundary.request).not.toHaveBeenCalled(); expect(boundary.native).not.toHaveBeenCalled();
  expect(boundary.loadDevice).not.toHaveBeenCalled(); expect(boundary.effects).not.toHaveBeenCalled();
  expect(boundary.layout).not.toHaveBeenCalled(); expect(boundary.readmeLink).not.toHaveBeenCalled();
});

it('retains the actual Tour README link callback and keeps ASR backticks/fences as literal paragraphs', () => {
  for (const scale of [50, 100, 200]) {
    nativeAppearance.current.set({ ...nativeAppearance.current()!, codeFontSize: scale });
    const tour = textViews('setup-tour.tsx')[0]();
    expect(tour.links).toBe('report');
    (tour.onLinkPress as (event: { url: string }) => void)({ url: 'relative/reference.md' });
    expect(boundary.readmeLink).toHaveBeenLastCalledWith('relative/reference.md');
    const asr = textViews('settings-voice-test.tsx')[0]();
    expect(asr.styles).toBeUndefined(); expect(asr.markdown).toBeUndefined();
    expect(asr.document).toEqual(voiceTestTranscriptDocument('literal `inline`\n```ts\nconst literal = 1\n```'));
    expect(asr.selectable).toBe(true); expect(asr.links).toBe('report');
  }
  expect(boundary.readmeLink).toHaveBeenCalledTimes(3);
});

it('Chat shares the same code parts while retaining role-specific body font, leading, colors and list metadata', () => {
  for (const scale of [50, 100, 200]) {
    nativeAppearance.current.set({ ...nativeAppearance.current()!, codeFontSize: scale });
    for (const role of ['user', 'assistant'] as const) {
      const styles = nativeTranscriptMarkdownStyles(role, true), code = nativeCodeTextViewStyles();
      expect(styles.code).toEqual(code.code); expect(styles.codeBlockCode).toEqual(code.codeBlockCode);
      expect(styles.root).toEqual(nativeChatTextStyle(role));
      expect(styles.root).toMatchObject({ fontSize: 11.25, lineHeight: 18.28125, fontFamily: role === 'user' ? 'Body Fixture' : 'Assistant Fixture' });
      expect(styles.paragraph).toEqual({ marginTop: 0, marginBottom: 0 });
      expect(styles.listMarker).toMatchObject({ fontSize: 11.25 * .72, lineHeight: 18.28125, width: 'max-content' });
    }
  }
});
