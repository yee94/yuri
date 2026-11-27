import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSettledKeys } from './useSettledKeys';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let settled: ReadonlySet<string> = new Set();

const Probe: React.FC<{ keys: string[] }> = ({ keys }) => {
  settled = useSettledKeys(keys, 600, 1500);
  return null;
};

const render = (keys: string[]) => act(async () => {
  root ??= createRoot(document.createElement('div'));
  root.render(<Probe keys={keys} />);
});
const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
});

it('settles keys present on mount at once', async () => {
  await render(['a']);
  expect([...settled]).toEqual(['a']);
});

it('ignores a key that disappears before the appear delay', async () => {
  await render([]);
  await render(['a']);
  await advance(300);
  await render([]);
  await advance(2000);
  expect(settled.size).toBe(0);
});

it('adds after the appear delay and keeps a key through a short gap', async () => {
  await render([]);
  await render(['a']);
  await advance(600);
  expect(settled.has('a')).toBe(true);
  await render([]);
  await advance(1000);
  expect(settled.has('a')).toBe(true);
  await render(['a']);
  await advance(3000);
  expect(settled.has('a')).toBe(true);
  await render([]);
  await advance(1500);
  expect(settled.has('a')).toBe(false);
});
