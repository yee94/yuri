import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { INITIAL_ROWS, ProgressiveRows, ROWS_PER_FRAME, useProgressiveCount } from './ProgressiveRows';

let host: HTMLDivElement;
let root: Root;
let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames[id - 1] = () => {}; });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const items = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`);
const renderCounts = new Map<string, number>();
const list = (n: number, initialRows = INITIAL_ROWS) => (
  <ProgressiveRows items={items(n)} initialRows={initialRows} renderItem={(id) => {
    renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);
    return <i key={id} data-r={id} />;
  }} />
);
const step = () => act(async () => { const cb = frames.shift(); cb?.(performance.now()); });
const mounted = () => host.querySelectorAll('[data-r]').length;

describe('ProgressiveRows', () => {
  test('a short list mounts at once and schedules no frame work', async () => {
    await act(async () => root.render(list(10)));
    expect(mounted()).toBe(10);
    expect(frames).toHaveLength(0);
  });

  test('a long list mounts the first chunk, then one fixed-size chunk per frame', async () => {
    await act(async () => root.render(list(100)));
    expect(mounted()).toBe(INITIAL_ROWS);
    await step();
    expect(mounted()).toBe(INITIAL_ROWS + ROWS_PER_FRAME);
    await step();
    await step();
    expect(mounted()).toBe(100);
    expect(frames.filter(Boolean)).toHaveLength(0);
  });

  test('several lists share the frame budget: one list grows per frame', async () => {
    await act(async () => root.render(<><div id="a">{list(100)}</div><div id="b">{list(100)}</div></>));
    await step();
    const a = host.querySelectorAll('#a [data-r]').length;
    const b = host.querySelectorAll('#b [data-r]').length;
    expect(a + b).toBe(2 * INITIAL_ROWS + ROWS_PER_FRAME);
  });

  test('already mounted rows are not remounted when the list grows', async () => {
    await act(async () => root.render(list(100)));
    const first = host.querySelector('[data-r="r0"]');
    await step();
    expect(host.querySelector('[data-r="r0"]')).toBe(first);
  });

  test('unmounting cancels pending chunks', async () => {
    await act(async () => root.render(list(500)));
    await act(async () => root.render(<div />));
    await step();
    expect(mounted()).toBe(0);
  });

  test('a shrinking list never keeps stale rows or schedules extra work', async () => {
    await act(async () => root.render(list(100)));
    await step();
    await act(async () => root.render(list(20)));
    expect(mounted()).toBe(20);
  });

  test('useProgressiveCount restarts from the first chunk when its reset key changes', async () => {
    const Probe = ({ view }: { view: string }) => <i data-count={useProgressiveCount(100, 5, 10, view)} />;
    const count = () => Number(host.querySelector('[data-count]')?.getAttribute('data-count'));
    await act(async () => root.render(<Probe view="a" />));
    for (let i = 0; i < 3 && count() < 15; i += 1) await step();
    expect(count()).toBe(15);
    await act(async () => root.render(<Probe view="b" />));
    expect(count()).toBe(5);
    for (let i = 0; i < 3 && count() < 15; i += 1) await step();
    expect(count()).toBe(15);
  });
});
