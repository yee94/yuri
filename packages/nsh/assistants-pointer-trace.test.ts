import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createAssistantSwipe } from './assistants-swipe-core';
import { instrumentPointerRow } from './tests/assistants-pointer/instrument.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(root, 'assistants-swipe.tsx'), 'utf8');
type Pan = Record<string, (...args: unknown[]) => unknown>;
function evaluate(text: string, modules: Record<string, unknown>, extra = {}) {
  const exports: Record<string, (...args: unknown[]) => unknown> = {};
  const output = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' } }).outputText;
  vm.runInNewContext(output, { exports, require: (id: string) => {
    if (!(id in modules)) throw Error('Unexpected dependency ' + id); return modules[id];
  }, ...extra });
  return exports;
}
function harness(instrument: boolean) {
  let tracked = false;
  const signal = <T>(initial: T) => {
    let value = initial;
    return Object.assign(() => { if (tracked) reads++; return value; }, { set(next: T) { value = next; } });
  };
  let reads = 0;
  const untracked = <T>(work: () => T) => { const prior = tracked; tracked = false; try { return work(); } finally { tracked = prior; } };
  const trace = evaluate(readFileSync(path.join(root, 'tests/assistants-pointer/trace.ts'), 'utf8'), { nsh: { signal, untracked } });
  let pan: Pan = {}, effect = () => {};
  const writes: number[] = [], actions: string[] = [];
  const props = { binding: {}, generation: 1, id: 'synthetic', name: 'Synthetic', pinned: false, disabled: false, revealed: null as string | null,
    onReveal: (id: string) => { props.revealed = id; actions.push('reveal'); }, onOpen() {}, onMenu() {}, onEdit() {}, onDelete() {} };
  const mod = evaluate(instrument ? instrumentPointerRow(source) : source, {
    nsh: { signal, cleanup() {}, effect: (work: () => void) => { effect = work; work(); }, Text: 'Text', View: 'View', PanResponder: { create: (handlers: Pan) => { pan = handlers; return { panHandlers: handlers }; } } },
    'nsh/base': { Button: 'Button' }, './Icon': { Icon: 'Icon' }, './i18n': { t: (key: string) => key },
    './tests/assistants-pointer/trace': trace,
    './assistants-swipe-core': { createAssistantSwipe: (options: Parameters<typeof createAssistantSwipe>[0]) => createAssistantSwipe({ ...options, write: value => { writes.push(value); options.write(value); } }) },
  }, { If: 'If', jsx: () => ({}) });
  mod.AssistantSwipeRow(props);
  return { pan, props, writes, actions, trace, reactivity: { signal, untracked }, effect: () => effect(),
    tracked: (work: () => void) => { reads = 0; tracked = true; try { work(); return reads; } finally { tracked = false; } } };
}

describe('staged pointer instrumentation (pure callbacks, no UIKit evidence)', () => {
  it('preserves claim, grant, settle and rebind cancellation results', () => {
    const run = (instrument: boolean) => {
      const h = harness(instrument), returns = [];
      h.trace.resetTrace(); returns.push(h.pan.onStartShouldSetPanResponder());
      returns.push(h.pan.onMoveShouldSetPanResponder(null, { dx: -30, dy: 0, numberActiveTouches: 1 }));
      returns.push(h.pan.onPanResponderGrant(), h.pan.onShouldBlockNativeResponder());
      h.pan.onPanResponderMove(null, { dx: -100, dy: 0, numberActiveTouches: 1 }); h.effect();
      h.pan.onPanResponderRelease();
      h.pan.onStartShouldSetPanResponder(); h.props.binding = {}; h.effect();
      returns.push(h.pan.onMoveShouldSetPanResponder(null, { dx: -50, dy: 0, numberActiveTouches: 1 }));
      h.pan.onPanResponderTerminate();
      return { h, result: { returns, writes: h.writes, actions: h.actions } };
    };
    const plain = run(false), traced = run(true);
    expect(traced.result).toEqual(plain.result);
    expect(traced.h.trace.readTrace()).toEqual(expect.arrayContaining(['start', 'claim-yes', 'grant', 'block-yes', 'move', 'release', 'offset-open', 'retire-binding', 'claim-no', 'terminate']));
  });
  it('bounds events to 64, rejects non-enums, and never subscribes the recording caller', () => {
    const h = harness(true); h.trace.resetTrace();
    expect(h.tracked(() => h.trace.record('start'))).toBe(0);
    for (let i = 0; i < 100; i++) h.trace.record('move');
    expect(h.trace.readTrace()).toHaveLength(64);
    expect(() => h.trace.record('contact body')).toThrow('Unknown pointer event');
    expect(h.trace.readTrace()).toHaveLength(64);
    h.trace.resetTrace(); expect(h.trace.readTrace()).toEqual([]);
  });
  it('fails closed on changed production anchors', () => {
    expect(() => instrumentPointerRow(source.replace('cleanup(swipe.close)', 'cleanup(() => swipe.close())'))).toThrow('anchor changed');
  });
  it('List trace records fixed row roles and page order without subscribing to pinned or trace state', () => {
    const h = harness(true), pinned = h.reactivity.signal(false);
    const trace = evaluate(readFileSync(path.join(root, 'tests/assistants-list-pointer/trace.ts'), 'utf8'), {
      nsh: h.reactivity, '../assistants-pointer/trace': h.trace,
    });
    expect(h.tracked(() => trace.recordRow('start', pinned))).toBe(0);
    trace.recordPage('snapshot-apply'); pinned.set(true); trace.recordRow('retire-binding', pinned);
    expect(trace.readListTrace()).toEqual(['normal/start', 'page/snapshot-apply', 'pinned/retire-binding']);
    for (let i = 0; i < 100; i++) trace.recordPage('viewability');
    expect(trace.readListTrace()).toHaveLength(64);
    expect(() => trace.recordPage('contact content')).toThrow('Unknown List pointer event');
    trace.resetListTrace(); expect(trace.readListTrace()).toEqual([]);
  });
});
