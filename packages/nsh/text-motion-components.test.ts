import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import * as model from './text-motion-model';

function harness() {
  let listener: (() => void) | undefined;
  const disposals: Array<() => void> = [], states: Array<() => unknown> = [];
  const signal = <T,>(initial: T) => {
    let value = initial;
    const listeners = new Set<() => void>();
    const read = () => { if (listener) listeners.add(listener); return value; };
    states.push(read);
    return Object.assign(read, { set(next: T) { if (Object.is(value, next)) return; value = next; for (const callback of [...listeners]) callback(); } });
  };
  const untracked = <T,>(fn: () => T) => { const saved = listener; listener = undefined; try { return fn(); } finally { listener = saved; } };
  const lifecycle = signal('active'), reduceMotion = signal(false);
  const values: ReturnType<typeof animated>[] = [], motions: ReturnType<typeof motion>[] = [];
  function animated() {
    return { set: vi.fn(), stop: vi.fn(async () => ({ value: 0 })), keyframes: vi.fn(() => new Promise(() => {})) };
  }
  function motion() {
    let resolve: ((result: { finished: boolean }) => void) | undefined;
    return {
      opacity: animated(), translateY: animated(),
      play: vi.fn(() => new Promise<{ finished: boolean }>(done => { resolve = done; })),
      stop: vi.fn(() => { resolve?.({ finished: false }); resolve = undefined; }),
      finish: () => { resolve?.({ finished: true }); resolve = undefined; },
    };
  }
  const exports: Record<string, (props: { text: string; active: boolean; current?: () => boolean }) => unknown> = {};
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'text-motion.tsx'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'jsx', target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, {
    exports, If: 'If', Each: 'Each', jsx: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    require(name: string) {
      if (name === './text-motion-model') return model;
      if (name !== 'nsh') throw new Error(`Unexpected dependency: ${name}`);
      return { signal, untracked, lifecycle, reduceMotion, Text: 'Text', View: 'View', ShaderEffect: 'ShaderEffect', token: (name: string) => name,
        cleanup: (fn: () => void) => disposals.push(fn),
        createAnimatedValue: () => { const value = animated(); values.push(value); return value; },
        createMotion: () => { const value = motion(); motions.push(value); return value; },
        effect: (fn: () => (() => void) | undefined) => {
          let dispose: (() => void) | undefined;
          const run = () => { dispose?.(); const saved = listener; listener = run; try { dispose = fn(); } finally { listener = saved; } };
          run(); disposals.push(() => dispose?.());
        },
      };
    },
  });
  return { exports, signal, values, motions, lifecycle, reduceMotion, dispose: () => disposals.forEach(fn => fn()),
    flip: () => states.map(read => read()).find(value => typeof value === 'object' && value !== null && 'shown' in value) };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

it('a live sweep submits one native loop, ignores text bursts and stops on retirement/reduced motion', () => {
  const h = harness(), text = h.signal('Thinking'), current = h.signal(true);
  h.exports.NativeShimmerText({ get text() { return text(); }, active: true, current });
  for (let index = 0; index < 100; index++) text.set(`Thinking ${index}`);
  expect(h.values[0].keyframes).toHaveBeenCalledTimes(1);
  h.reduceMotion.set(true);
  expect(h.values[0].stop).toHaveBeenCalled();
  h.reduceMotion.set(false);
  expect(h.values[0].keyframes).toHaveBeenCalledTimes(2);
  current.set(false);
  expect(h.values[0].set).toHaveBeenLastCalledWith(0);
  h.dispose();
});

it('moving flip layers stay stable through bursts, then play only the newest pending label', async () => {
  const h = harness(), text = h.signal('1');
  h.exports.NativeFlipUpText({ get text() { return text(); }, active: true });
  text.set('2'); text.set('3'); text.set('4');
  expect(h.motions.map(motion => motion.play.mock.calls.length)).toEqual([1, 1]);
  expect(h.flip()).toEqual({ shown: '2', outgoing: '1' });
  h.motions.forEach(motion => motion.finish()); await flush();
  expect(h.motions.map(motion => motion.play.mock.calls.length)).toEqual([2, 2]);
  expect(h.flip()).toEqual({ shown: '4', outgoing: '2' });
  h.motions.forEach(motion => motion.finish()); await flush();
  expect(h.flip()).toEqual({ shown: '4', outgoing: null });
  h.dispose();
});

it('backgrounding lands even an unchanged target and stale completion cannot resume a flip', async () => {
  const h = harness(), text = h.signal('1');
  h.exports.NativeFlipUpText({ get text() { return text(); }, active: true });
  text.set('2');
  h.lifecycle.set('background'); await flush();
  expect(h.flip()).toEqual({ shown: '2', outgoing: null });
  expect(h.motions.map(motion => motion.play.mock.calls.length)).toEqual([1, 1]);
  h.motions.forEach(motion => motion.finish()); await flush();
  expect(h.flip()).toEqual({ shown: '2', outgoing: null });
  h.dispose();
});
