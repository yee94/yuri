import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, test, vi } from 'vitest';
import { settingsPreferenceFields } from './settings-preferences-core';
import type { PreferenceChoiceField } from './settings-preferences-fields';
import { nativeLayoutDensity } from './native-density';

const root = path.dirname(fileURLToPath(import.meta.url));
type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] };
const source = readFileSync(path.join(root, 'settings-preferences-fields.tsx'), 'utf8');
const imports: string[] = [];
let padding = 100;
const jsx = (type: unknown, props: Node['props'], ...children: unknown[]): Node => ({ type, props: props ?? {}, children });
const exports = {} as typeof import('./settings-preferences-fields');
vm.runInNewContext(ts.transpileModule(source, {
  fileName: 'settings-preferences-fields.tsx',
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' },
}).outputText, { exports, jsx, If: 'If', Each: 'Each', require: (id: string) => {
  imports.push(id);
  if (id === 'nsh') return { Text: 'Text', View: 'View', effect: () => {}, lifecycle: () => 'active', reduceMotion: () => false, signal: <T>(value: T) => Object.assign(() => value, { set(next: T) { value = next; } }) };
  if (id === 'nsh/base') return { Button: 'Button', Radio: 'Radio', RadioGroup: 'RadioGroup' };
  if (id === './i18n') return { t: (key: string) => key };
  if (id === './appearance') return { nativeDensity: () => nativeLayoutDensity(padding) };
  throw new Error('Presentation imported side-effect dependency: ' + id);
} });
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as Node;
  if (node.type === 'If') return node.props.when ? nodes(node.children) : [];
  if (node.type === 'Each') return (node.props.of as unknown[]).flatMap((item, index) => node.children.flatMap(child => nodes((child as (item: () => unknown, index: () => number) => unknown)(() => item, () => index))));
  if (typeof node.type === 'function') return nodes(node.type(node.props));
  return [node, ...nodes(node.children)];
}
const fields = settingsPreferenceFields.filter(field => exports.hasPreferenceChoicePresentation(field.key));
function fixture(field: PreferenceChoiceField, value: unknown) {
  const onChange = vi.fn(); let disabled = false;
  const render = () => nodes(exports.SettingsPreferenceChoiceField({ field, value, get disabled() { return disabled; }, onChange }));
  return { render, onChange, disable() { disabled = true; } };
}
const controls = (rendered: Node[]) => rendered.filter(node => node.type === 'Button' || node.type === 'Radio');

test('scope matches exactly four keys and has no persistence/runtime/component-owner dependency', () => {
  expect(fields.map(field => field.key)).toEqual(['fileEditorKeymap', 'chatRenderMode', 'messageStreamTransport', 'diffLayoutPreference']);
  expect(exports.hasPreferenceChoicePresentation('followUpBehavior')).toBe(false);
  expect(imports).toEqual(['nsh', 'nsh/base', './i18n', './appearance']);
});

test.each(fields)('$key renders its real options once and delivers exact raw values only on explicit activation', field => {
  const fixture = fixtureFor(field);
  const rendered = fixture.render();
  expect(rendered.filter(node => node.type === 'Text' && node.children.includes(field.title))).toHaveLength(1);
  expect(controls(rendered)).toHaveLength(field.options!.length);
  expect(fixture.onChange).not.toHaveBeenCalled();
  for (const [index, node] of controls(rendered).entries()) {
    const activate = (node.props.onPress ?? node.props.onChange) as () => void;
    activate(); expect(fixture.onChange.mock.calls.at(-1)).toEqual([field.options![index].value]);
  }
  expect(fixture.onChange).toHaveBeenCalledTimes(field.options!.length);
});
function fixtureFor(field: PreferenceChoiceField) { return fixture(field, field.options?.[0].value); }

test.each([50, 100, 105, 200])('actual preference controls consume %s%% without changing option identities, callbacks or selection', percent => {
  padding = percent;
  try {
    for (const field of fields) {
      const fixture = fixtureFor(field), rendered = fixture.render(), buttons = controls(rendered), scale = Math.sqrt(percent / 100);
      expect(buttons.map(node => node.props.testID)).toEqual(field.options!.map(option => `settings-preference-${field.key}-${option.value}`));
      expect(buttons.filter(node => node.props.selected || node.props.checked)).toHaveLength(1);
      for (const [index, button] of buttons.entries()) {
        const style = button.props.style as { padding?: number; paddingHorizontal?: number; minHeight: number };
        expect(style.minHeight).toBeGreaterThanOrEqual(36);
        if (field.key === 'chatRenderMode') expect(style.padding).toBeCloseTo(12 * scale);
        else expect(style.paddingHorizontal).toBeCloseTo((field.key === 'messageStreamTransport' ? 8 : 14) * scale);
        ((button.props.onPress ?? button.props.onChange) as () => void)();
        expect(fixture.onChange.mock.calls.at(-1)).toEqual([field.options![index].value]);
      }
    }
  } finally { padding = 100; }
});

test.each(fields)('$key shows no selected default for unknown, absent or invalid typed input', field => {
  for (const value of [undefined, null, '', 'future-value', true, 0, { value: field.options![0].value }]) {
    const rendered = fixture(field, value).render();
    expect(controls(rendered).every(node => node.props.selected !== true && node.props.checked !== true)).toBe(true);
    expect(rendered.some(node => node.props.testID === 'settings-preference-messageStreamTransport-description')).toBe(false);
  }
  for (const option of field.options!) {
    expect(controls(fixture(field, option.value).render()).filter(node => node.props.selected === true || node.props.checked === true)).toHaveLength(1);
  }
});

test.each(fields)('$key disabled controls reject even retained callbacks and do not change selection', field => {
  const fixture = fixtureFor(field), previous = controls(fixture.render());
  fixture.disable();
  for (const node of previous) ((node.props.onPress ?? node.props.onChange) as () => void)();
  expect(fixture.onChange).not.toHaveBeenCalled();
  expect(controls(fixture.render()).every(node => node.props.disabled === true)).toBe(true);
  expect(controls(fixture.render()).filter(node => node.props.selected === true || node.props.checked === true)).toHaveLength(1);
});

test.each(fields.filter(field => field.key !== 'diffLayoutPreference' && field.key !== 'fileEditorKeymap'))('$key labelled radio container explicitly leaves option buttons as separate AX elements', field => {
  for (const selected of field.options!) {
    const rendered = fixture(field, selected.value).render();
    const groups = rendered.filter(node => node.props.role === 'radiogroup');
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group.props.accessible).toBe(false);
    expect(group.props.accessibilityLabel).toBe(field.key === 'chatRenderMode'
      ? 'settings.yuri.visual.section.chatRenderModeAria' : field.title);
    for (const node of rendered.filter(node => node.type === 'View')) {
      expect(node.props.accessibilityElementsHidden).not.toBe(true);
      expect(node.props.importantForAccessibility).not.toBe('no-hide-descendants');
      expect(node.props.accessible).not.toBe(true);
    }
    const buttons = controls(nodes(group.children));
    expect(buttons).toHaveLength(field.options!.length);
    expect(buttons.map(node => node.props)).toEqual(field.options!.map(option => expect.objectContaining({
      testID: `settings-preference-${field.key}-${option.value}`,
      role: 'radio', accessibilityLabel: option.title, selected: selected.value === option.value,
    })));
    for (const button of buttons) {
      expect(button.props.accessible).not.toBe(false);
      expect(button.props.accessibilityElementsHidden).not.toBe(true);
    }
  }
});

test('transport copy follows each exact selected option; preview cards contain real dot/line content', () => {
  const transport = fields.find(field => field.key === 'messageStreamTransport')!;
  for (const option of transport.options!) {
    expect(fixture(transport, option.value).render().find(node => node.props.testID === 'settings-preference-messageStreamTransport-description')?.children).toEqual([`settings.yuri.visual.option.messageTransport.${option.value}.description`]);
  }
  const cards = fixture(fields.find(field => field.key === 'chatRenderMode')!, 'sorted').render();
  for (const mode of ['sorted', 'live']) {
    const lines = cards.filter(node => String(node.props.testID).startsWith(`settings-preference-preview-${mode}-line-`));
    expect(lines).toHaveLength(3);
    expect(lines.map(node => (node.props.style as { width: string }).width)).toEqual(mode === 'sorted' ? ['92%', '92%', '92%'] : ['0%', '0%', '0%']);
  }
});

test('mobile keymap uses two real radios in an AX-transparent labelled RadioGroup, with no dropdown or preview', () => {
  const field = settingsPreferenceFields.find(field => field.key === 'fileEditorKeymap')!;
  expect(exports.hasPreferenceChoicePresentation(field.key)).toBe(true);
  for (const value of [undefined, 'future', 'default', 'vim']) {
    const rendered = fixture(field, value).render(), groups = rendered.filter(node => node.props.role === 'radiogroup');
    expect(groups).toHaveLength(1);
    expect(rendered.filter(node => node.type === 'RadioGroup')).toHaveLength(1);
    expect(groups[0].props).toMatchObject({ accessible: false, role: 'radiogroup', accessibilityLabel: field.title });
    const radios = controls(rendered); expect(radios.map(node => node.type)).toEqual(['Radio', 'Radio']);
    expect(radios.map(node => node.props.checked)).toEqual([value === 'default', value === 'vim']);
    expect(radios.map(node => node.props.accessibilityLabel)).toEqual(field.options!.map(option => option.title));
    expect(rendered.some(node => /preview|description/.test(String(node.props.testID)))).toBe(false);
    expect(radios.every(node => node.props.accessible !== false)).toBe(true);
  }
});

test('all reused labels, AX names and protocol descriptions exist in all ten shipped dictionaries', async () => {
  const keys = [...fields.flatMap(field => [field.title, ...field.options!.map(option => option.title)]),
    'settings.yuri.visual.section.chatRenderModeAria', 'settings.yuri.visual.section.diffLayoutAria', 'settings.yuri.visual.field.diffLayoutAria',
    ...['auto', 'ws', 'sse'].map(value => `settings.yuri.visual.option.messageTransport.${value}.description`)];
  for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'pl', 'pt-BR', 'uk']) {
    const { dict } = await import(`../ui/src/lib/i18n/messages/${locale}.ts`) as { dict: Record<string, string> };
    for (const key of keys) expect(dict[key], `${locale}: ${key}`).toBeTypeOf('string');
  }
});

function animatedFixture(key = 'chatRenderMode') {
  let observer: (() => void) | null = null, disposed = false;
  const effects = new Set<() => void>(), finalizers: (() => void)[] = [];
  const signal = <T>(initial: T) => {
    let value = initial;
    const subscribers = new Set<() => void>();
    return Object.assign(() => { if (observer) subscribers.add(observer); return value; }, { set(next: T) {
      if (Object.is(value, next)) return;
      value = next; for (const run of [...subscribers]) run();
    } });
  };
  const active = signal(false), visible = signal(true), reduced = signal(false), lifecycle = signal('active');
  const timers = new Map<number, () => void>(), retained: (() => void)[] = [], periods: number[] = [];
  let timerID = 0, publications = 0;
  const published: unknown[] = [];
  const effect = (work: () => void | (() => void)) => {
    let release: void | (() => void);
    const run = () => {
      if (disposed) return;
      release?.(); const previous = observer; observer = run;
      try { release = work(); } finally { observer = previous; }
    };
    effects.add(run); run(); finalizers.push(() => release?.());
  };
  const reactiveOutput = ts.transpileModule(source, {
    fileName: 'settings-preferences-fields.tsx',
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' },
    transformers: { after: [context => syntax => {
      const visit: ts.Visitor = node => {
        const next = ts.visitEachChild(node, visit, context);
        if (!ts.isCallExpression(next) || !ts.isIdentifier(next.expression) || next.expression.text !== 'jsx') return next;
        const props = next.arguments[1];
        if (!props || !ts.isObjectLiteralExpression(props)) return next;
        const reactive = ts.factory.updateObjectLiteralExpression(props, props.properties.map(property => ts.isPropertyAssignment(property)
          ? ts.factory.createGetAccessorDeclaration(undefined, property.name, [], undefined, ts.factory.createBlock([ts.factory.createReturnStatement(property.initializer)])) : property));
        return ts.factory.updateCallExpression(next, next.expression, next.typeArguments, [next.arguments[0], reactive, ...next.arguments.slice(2)]);
      };
      return ts.visitNode(syntax, visit) as ts.SourceFile;
    }] },
  }).outputText;
  const local = {} as typeof import('./settings-preferences-fields');
  const onChange = vi.fn();
  vm.runInNewContext(reactiveOutput, { exports: local, jsx, If: 'If', Each: 'Each',
    setInterval(work: () => void, period: number) { periods.push(period); retained.push(work); timers.set(++timerID, work); return timerID; },
    clearInterval(id: number) { timers.delete(id); },
    require(id: string) {
      if (id === 'nsh') return { View: 'View', Text: 'Text', signal: <T>(value: T) => {
        const result = signal(value), set = result.set;
        result.set = next => { publications++; published.push(next); set(next); }; return result;
      }, effect, cleanup: (work: () => void) => finalizers.push(work), lifecycle, reduceMotion: reduced };
      if (id === 'nsh/base') return { Button: 'Button', Radio: 'Radio', RadioGroup: 'RadioGroup' };
      if (id === './i18n') return { t: (key: string) => key };
      if (id === './appearance') return { nativeDensity: () => nativeLayoutDensity(100) };
      throw new Error('Unexpected animated presentation import: ' + id);
    },
  });
  const tree = local.SettingsPreferenceChoiceField({ field: fields.find(field => field.key === key)!, value: 'sorted', get active() { return active(); }, get previewVisible() { return visible(); }, onChange });
  return { active, visible, reduced, lifecycle, onChange, periods, retained, timers, published,
    nodes: () => nodes(tree), publications: () => publications,
    tick() { for (const work of [...timers.values()]) work(); },
    dispose() { disposed = true; for (const work of finalizers) work(); effects.clear(); },
  };
}

test('one 420ms owner follows every exact Web phase across a full 24 tick period without changing settings or geometry', () => {
  const fixture = animatedFixture();
  expect(fixture.timers.size).toBe(0);
  fixture.active.set(true);
  expect(fixture.timers.size).toBe(1); expect(fixture.periods).toEqual([420]);
  for (let tick = 0; tick <= 24; tick++) {
    const rendered = fixture.nodes(), phase = tick % 12;
    for (const mode of ['sorted', 'live']) for (let row = 0; row < 3; row++) {
      const progressPhase = phase - row * 3;
      const progress = mode === 'sorted' ? 92 : progressPhase <= 0 ? 0 : progressPhase === 1 ? 42 : progressPhase === 2 ? 68 : 92;
      const visible = mode === 'sorted' ? phase >= (row + 1) * 3 : progress > 0;
      const line = rendered.find(node => node.props.testID === `settings-preference-preview-${mode}-line-${row}`)!;
      const container = rendered.find(node => node.props.testID === `settings-preference-preview-${mode}-row-${row}`)!;
      expect(line.props.style).toMatchObject({ width: `${progress}%`, transitionDuration: 300 });
      expect(container.props.style).toMatchObject({ height: 8, opacity: visible ? 1 : 0, transform: [{ translateY: visible ? 0 : 4 }] });
    }
    expect(rendered.filter(node => /-row-[012]$/.test(String(node.props.testID)))).toHaveLength(6);
    if (tick < 24) fixture.tick();
  }
  expect(fixture.publications()).toBe(24); expect(fixture.periods).toEqual([420]);
  expect(fixture.published).toEqual([...Array.from({ length: 23 }, (_, index) => index + 1), 0]);
  expect(fixture.onChange).not.toHaveBeenCalled(); fixture.dispose();
});

test('hidden, background, system reduced motion and unmount stop and fence old timers; resume preserves phase with one owner', () => {
  const fixture = animatedFixture(); fixture.active.set(true); fixture.tick();
  const toggles = [
    () => { fixture.active.set(false); return () => fixture.active.set(true); },
    () => { fixture.visible.set(false); return () => fixture.visible.set(true); },
    () => { fixture.lifecycle.set('inactive'); return () => fixture.lifecycle.set('active'); },
    () => { fixture.lifecycle.set('background'); return () => fixture.lifecycle.set('active'); },
    () => { fixture.reduced.set(true); return () => fixture.reduced.set(false); },
  ];
  for (const stop of toggles) {
    const resume = stop(), before = fixture.publications();
    expect(fixture.timers.size).toBe(0);
    for (const stale of fixture.retained) stale();
    expect(fixture.publications()).toBe(before);
    if (fixture.reduced()) {
      for (const node of fixture.nodes().filter(node => /-row-[012]$/.test(String(node.props.testID)))) expect(node.props.style).toMatchObject({ opacity: 1, transitionDuration: 0 });
    }
    resume(); expect(fixture.timers.size).toBe(1);
    const beforeOld = fixture.publications();
    for (const stale of fixture.retained.slice(0, -1)) stale();
    expect(fixture.publications()).toBe(beforeOld);
    fixture.tick(); expect(fixture.publications()).toBe(beforeOld + 1);
  }
  fixture.dispose(); const before = fixture.publications();
  expect(fixture.timers.size).toBe(0);
  for (const stale of fixture.retained) stale();
  expect(fixture.publications()).toBe(before); expect(fixture.onChange).not.toHaveBeenCalled();
});

test.each(['messageStreamTransport', 'diffLayoutPreference'])('%s never starts preview work', key => {
  const fixture = animatedFixture(key); fixture.active.set(true); fixture.visible.set(false); fixture.visible.set(true);
  expect(fixture.timers.size).toBe(0); expect(fixture.publications()).toBe(0); expect(fixture.periods).toEqual([]); fixture.dispose();
});
