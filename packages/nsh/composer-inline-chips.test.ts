import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { buildInlineChipConfig, buildInlineChips, composerSkillColor, inlineChipColor, inlineChipIcon, referenceChipColors } from './composer-inline-chips';
import { getDefaultTheme } from '../ui/src/lib/theme/themes';
import type { NativeReference } from './composer-references';

const root = path.dirname(fileURLToPath(import.meta.url));

const reference = (kind: NativeReference['kind'], label: string, start: number): NativeReference => ({
  kind, value: kind === 'session' ? 'ses_1' : kind === 'skill' ? 'skill-id' : `value-${kind}`,
  label, display: `@${label}`, start, end: start + label.length + 1,
});

test('projects durable references to trigger and label ranges without touching text', () => {
  const references = [reference('file', 'src/a.ts', 0), reference('skill', 'deploy', 10), reference('session', 'Prior work', 20)];
  const before = references.map(item => ({ ...item }));
  const chips = buildInlineChips({ references, textLength: 60, colors: { primary: '#112233', skill: '#ff8800' } });
  expect(chips).toEqual([
    { start: 0, end: 9, kind: 'file', icon: 'file', color: '#112233' },
    { start: 10, end: 17, kind: 'skill', icon: 'book-open', color: '#ff8800' },
    { start: 20, end: 31, kind: 'session', icon: 'chat-thread', color: '#112233' },
  ]);
  expect(references).toEqual(before);
  expect(inlineChipIcon('directory')).toBe('folder');
  expect(inlineChipIcon('agent')).toBe('ai-agent');
});

test('rejects out-of-range, non-@, overlapping, duplicate and invalid-kind rows without moving others', () => {
  const good = reference('directory', 'src', 5);
  const chips = buildInlineChips({
    references: [
      { ...reference('file', 'bad', 0), display: 'not-a-chip' },
      { ...reference('file', 'negative', -1) },
      { ...reference('file', 'toolong', 40) },
      good,
      reference('file', 'inside', 6),
      { ...good, kind: 'other' as never },
      reference('agent', 'r', 10),
    ],
    textLength: 20,
    colors: { primary: '#000000', skill: '#000000' },
  });
  expect(chips).toEqual([
    { start: 5, end: 9, kind: 'directory', icon: 'folder', color: '#000000' },
    { start: 10, end: 12, kind: 'agent', icon: 'ai-agent', color: '#000000' },
  ]);
});

test('caps decorations at 64 and keeps sorted order', () => {
  const references = Array.from({ length: 80 }, (_, index) => reference('file', `f${index}`, index * 8));
  const chips = buildInlineChips({ references: [...references].reverse(), textLength: 1000, colors: { primary: '#000000', skill: '#000000' } });
  expect(chips).toHaveLength(64);
  expect(chips[0]!.start).toBe(0);
  expect(chips[63]!.start).toBe(63 * 8);
  for (let index = 1; index < chips.length; index++) expect(chips[index]!.start).toBeGreaterThan(chips[index - 1]!.end);
});

test('normalizes CSS colors to the native six-digit hex form', () => {
  expect(inlineChipColor('#abc', '#000000')).toBe('#aabbcc');
  expect(inlineChipColor('#A1B2C3DD', '#000000')).toBe('#a1b2c3');
  expect(inlineChipColor('rgb(1, 2, 255)', '#000000')).toBe('#0102ff');
  expect(inlineChipColor('rgba(1 2 3 / 50%)', '#000000')).toBe('#010203');
  expect(inlineChipColor('var(--primary)', '#123456')).toBe('#123456');
  expect(inlineChipColor(undefined, '#123456')).toBe('#123456');
});

test('skill color follows chat.composerSkill and falls back to Web warning default', () => {
  expect(composerSkillColor({ colors: { chat: { composerSkill: '#abcdef' } } }, false, '#000000')).toBe('#abcdef');
  expect(composerSkillColor({ colors: { status: { warning: '#808080' } } }, false, '#000000')).toBe('#808080');
  expect(composerSkillColor({ colors: { status: { warning: '#808080' } } }, true, '#000000')).toBe('#c0c0c0');
  expect(composerSkillColor(undefined, false, '#123456')).toBe('#123456');
});

test('input and message highlights share the canonical theme even before Host appearance arrives', () => {
  for (const dark of [false, true]) {
    const theme = getDefaultTheme(dark);
    const colors = referenceChipColors(undefined, dark);
    expect(colors.primary).toBe(theme.colors.primary.base);
    expect(colors.skill).toBe(composerSkillColor(theme, dark, colors.primary));
    expect(colors.primary).not.toBe(theme.colors.surface.foreground);
    expect(referenceChipColors({ ...theme, colors: { ...theme.colors, primary: { ...theme.colors.primary, base: '#123456' }, chat: { ...theme.colors.chat, composerSkill: '#bb6600' } } }, dark))
      .toEqual({ primary: '#123456', skill: '#bb6600' });
  }
});

test('config carries the exact owner, input and logical length', () => {
  const config = buildInlineChipConfig({
    ownerID: 'composer-glass', inputID: 'composer', textLength: 12,
    references: [reference('skill', 'review', 0)], colors: { primary: '#111111', skill: '#222222' },
  });
  expect(config).toEqual({
    ownerID: 'composer-glass', inputID: 'composer', textLength: 12,
    chips: [{ start: 0, end: 7, kind: 'skill', icon: 'book-open', color: '#222222' }],
  });
});

test('executes the production Swift plan without UIKit, a device or a Host', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'opencode', 'inline-chips-'));
  try {
    const binary = path.join(directory, 'checks');
    execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library',
      path.join(root, 'ios/ComposerInlineChipPlan.swift'), path.join(root, 'tests/composer-inline-chips/PlanChecks.swift'), '-o', binary], { timeout: 110_000, encoding: 'utf8' });
    expect(execFileSync(binary, { timeout: 10_000, encoding: 'utf8' })).toContain('composer inline chip plan checks passed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 120_000);

test('executes the production Android plan without an Android runtime', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'opencode', 'inline-chips-java-'));
  try {
    execFileSync('javac', ['--release', '17', '-d', directory,
      path.join(root, 'android/src/com/yee94/yuri/nsh/ComposerInlineChipPlan.java'), path.join(root, 'tests/composer-inline-chips/PlanChecks.java')], { timeout: 60_000, encoding: 'utf8' });
    expect(execFileSync('java', ['-cp', directory, 'PlanChecks'], { timeout: 10_000, encoding: 'utf8' })).toContain('composer inline chip Java plan checks passed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 60_000);

test('wires the decoration bridge to both composers and both native hosts', () => {
  for (const [file, ownerID, inputID, references] of [
    ['application.tsx', 'composer-glass', 'composer', 'chat.references()'],
    ['new-session-page.tsx', 'new-session-composer-glass', 'new-session-composer', 'owner.durable.references()'],
  ]) {
    const source = readFileSync(path.join(root, file), 'utf8');
    expect(source).toContain(`<NativeComposerInlineChips ownerID="${ownerID}" inputID="${inputID}"`);
    expect(source).toContain(references);
  }
  expect(readFileSync(path.join(root, 'ios/main.swift'), 'utf8')).toContain('NativeComposerInlineChips.install(on: surface)');
  expect(readFileSync(path.join(root, 'android/src/com/yee94/yuri/nsh/NativeHandlers.java'), 'utf8')).toContain('new ComposerInlineChipBridge(activity, leases, view)');
  expect(readFileSync(path.join(root, 'android/src/com/yee94/yuri/nsh/ComposerInlineChipBridge.java'), 'utf8')).toContain('view.registerComponent("yuri.composer.inlineChips"');
});

test('mounts once but keeps Registration.config live across refs, edits, inactive and active', async () => {
  // NSH function components build once; JSX attribute expressions compile to
  // lazy getters (`get config() { return config() }`). This transformer mirrors
  // that boundary so the test observes the production wrapper, not a snapshot.
  const lazyAttributeExpressions: ts.TransformerFactory<ts.SourceFile> = context => file => {
    const visit: ts.Visitor = node => {
      if (ts.isJsxAttribute(node) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        const lazy = ts.factory.createArrowFunction(undefined, undefined, [], undefined,
          ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), ts.visitNode(node.initializer.expression, visit) as ts.Expression);
        return ts.factory.updateJsxAttribute(node, node.name, ts.factory.createJsxExpression(undefined, lazy));
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(file, visit) as ts.SourceFile;
  };
  const source = readFileSync(path.join(root, 'native-composer-inline-chips.tsx'), 'utf8');
  // A snapshot (`const config = …; config={config}`) freezes the refs present at
  // mount; the wrapper must keep the JSX expression lazy.
  expect(source).toContain('const config = () =>');
  expect(source).toContain('config={config()}');
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'h' },
    transformers: { before: [lazyAttributeExpressions] },
  }).outputText;
  const components: string[] = [];
  const theme = { colors: { primary: { base: '#112233' }, chat: { composerSkill: '#445566' }, status: { warning: '#808080' } } };
  const imports: Record<string, unknown> = {
    nsh: {
      nativeComponent: (name: string) => { components.push(name); return name; },
      token: () => '#112233',
      colorScheme: () => 'light',
    },
    './appearance': { nativeAppearance: { current: () => ({ webTheme: { light: theme, dark: theme } }) } },
  };
  imports['./composer-inline-chips'] = await import('./composer-inline-chips');
  const exports: { NativeComposerInlineChips?: (props: unknown) => { type: string; props: Record<string, unknown> } } = {};
  const h = (type: string, props: Record<string, unknown>) => ({ type, props });
  vm.runInNewContext(js, { exports, h, require: (name: string) => { if (!(name in imports)) throw new Error(`Unmocked import ${name}`); return imports[name]; } }, { filename: 'native-composer-inline-chips.tsx' });
  expect(components).toEqual(['yuri.composer.inlineChips']);

  let textLength = 0;
  let references: NativeReference[] = [];
  let active = true;
  const tree = exports.NativeComposerInlineChips!({
    ownerID: 'composer-glass', inputID: 'composer',
    get textLength() { return textLength; },
    get references() { return references; },
    get active() { return active; },
  });
  expect(tree.type).toBe('yuri.composer.inlineChips');
  const config = () => (tree.props.config as () => ReturnType<typeof buildInlineChipConfig>)();

  expect(config()).toEqual({ ownerID: 'composer-glass', inputID: 'composer', textLength: 0, chips: [] });

  references = [{ kind: 'skill', value: 'skill-id', label: 'review', display: '@review', start: 0, end: 7 }];
  textLength = 7;
  expect(config()).toEqual({
    ownerID: 'composer-glass', inputID: 'composer', textLength: 7,
    chips: [{ start: 0, end: 7, kind: 'skill', icon: 'book-open', color: '#445566' }],
  });

  // Editing the draft after removing the chip must clear decorations while the
  // real input length stays authoritative.
  references = [];
  textLength = 2;
  expect(config()).toEqual({ ownerID: 'composer-glass', inputID: 'composer', textLength: 2, chips: [] });

  // Inactive clears decorations but never fakes an empty text length: the
  // native bridges clear only when the plan matches the real editor length.
  references = [{ kind: 'file', value: 'src/a.ts', label: 'src/a.ts', display: '@src/a.ts', start: 3, end: 12 }];
  textLength = 20;
  active = false;
  expect(config()).toEqual({ ownerID: 'composer-glass', inputID: 'composer', textLength: 20, chips: [] });

  active = true;
  expect(config()).toEqual({
    ownerID: 'composer-glass', inputID: 'composer', textLength: 20,
    chips: [{ start: 3, end: 12, kind: 'file', icon: 'file', color: '#112233' }],
  });
  // The wrapper mounts once; every stage above read the same element's config.
  expect(tree.props.config).toBeTypeOf('function');
});
