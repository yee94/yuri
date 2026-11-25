import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SidebarAnimatedRow, SidebarAnimatedRows, withoutRemovedRows } from './SidebarAnimatedRows';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const ids = (count: number, prefix = 's') => Array.from({ length: count }, (_, index) => `${prefix}${index}`);
const rowsOf = (list: string[]) => (
  <SidebarAnimatedRows>
    {list.map((id) => (
      <SidebarAnimatedRow key={id}><span data-row={id} /></SidebarAnimatedRow>
    ))}
  </SidebarAnimatedRows>
);
const show = (list: string[]) => act(async () => root.render(rowsOf(list)));
const rowEls = () => Array.from(host.querySelectorAll<HTMLElement>('[data-row]'));
const collapsedRows = () => rowEls().filter((el) => el.parentElement?.style.height === '0px');

describe('SidebarAnimatedRows', () => {
  test('mounting a large list does not start any enter animation', async () => {
    await show(ids(300));
    expect(rowEls()).toHaveLength(300);
    expect(collapsedRows()).toHaveLength(0);
  });

  test('a bulk append (paging, refresh) mounts rows without enter animation', async () => {
    await show(ids(20));
    await show(ids(70));
    expect(rowEls()).toHaveLength(70);
    expect(collapsedRows()).toHaveLength(0);
  });

  test('a single added row animates in while existing rows are left alone', async () => {
    await show(ids(20));
    // happy-dom has no layout, so the animation may finish within the act; record the starting style.
    const startHeights: string[] = [];
    const observer = new MutationObserver(() => {
      const wrapper = host.querySelector('[data-row="new"]')?.parentElement;
      if (wrapper) startHeights.push(wrapper.style.height);
    });
    observer.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
    await show(['new', ...ids(20)]);
    observer.disconnect();
    expect(startHeights[0]).toBe('0px');
    expect(collapsedRows().filter((el) => el.dataset.row !== 'new')).toHaveLength(0);
  });

  test('an unrelated re-render keeps the same DOM nodes for every row', async () => {
    await show(ids(50));
    const before = rowEls();
    await show(ids(50));
    const after = rowEls();
    expect(after).toHaveLength(50);
    after.forEach((el, index) => expect(el).toBe(before[index]));
  });

  test('a removed row unmounts once its exit finishes', async () => {
    await show(ids(5));
    await show(ids(5).slice(1));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    expect(host.querySelector('[data-row="s0"]')).toBeNull();
    expect(rowEls()).toHaveLength(4);
  });

  test('a single removed row stays for its exit; a bulk removal (filter, show fewer) leaves at once', async () => {
    const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
    await show(ids(20));
    await show(ids(20).slice(1));
    await wait(60);
    expect(host.querySelector('[data-row="s0"]')).not.toBeNull();
    await wait(600);
    expect(rowEls()).toHaveLength(19);

    await show(ids(20).slice(1, 6));
    await wait(60);
    expect(rowEls().map((el) => el.dataset.row)).toEqual(ids(20).slice(1, 6));
  });

  test('wrapping 300 rows stays within a small multiple of the unwrapped mount cost', async () => {
    const median = async (element: React.ReactNode) => {
      const times: number[] = [];
      for (let run = 0; run < 7; run += 1) {
        const container = document.createElement('div');
        document.body.append(container);
        const local = createRoot(container);
        const start = performance.now();
        await act(async () => local.render(element));
        times.push(performance.now() - start);
        await act(async () => local.unmount());
        container.remove();
      }
      return times.sort((a, b) => a - b)[3];
    };
    const plain = <div>{ids(300).map((id) => <div key={id}><span data-row={id} /></div>)}</div>;
    await median(rowsOf(ids(300)));
    const wrapped = await median(rowsOf(ids(300)));
    const baseline = await median(plain);
    // Generous bound: guards against per-row cost regressions, not absolute speed.
    expect(wrapped).toBeLessThan(Math.max(baseline * 6, 80));
  });
});

test('a row is inert from the commit that removes it until its exit unmounts it', async () => {
  await show(ids(3));
  const leaving = rowEls()[1].parentElement!;
  expect(leaving.hasAttribute('inert')).toBe(false);
  await show(['s0', 's2']);
  expect(rowEls().map((el) => el.dataset.row)).toEqual(['s0', 's1', 's2']);
  expect(leaving.hasAttribute('inert')).toBe(true);
  expect(rowEls()[0].parentElement!.hasAttribute('inert')).toBe(false);
  await vi.waitFor(() => expect(rowEls().map((el) => el.dataset.row)).toEqual(['s0', 's2']), { timeout: 2000 });
});

describe('withoutRemovedRows', () => {
  const list = (names: string[]) => names.map((id) => ({ id }));

  test('drops a row the live list removed before the deferred list catches up', () => {
    const deferred = list(['a', 'b', 'c']);
    expect(withoutRemovedRows(deferred, list(['a', 'c']))).toEqual(list(['a', 'c']));
  });

  test('keeps the deferred reference when nothing was removed, including pending additions', () => {
    const deferred = list(['a', 'b']);
    expect(withoutRemovedRows(deferred, deferred)).toBe(deferred);
    expect(withoutRemovedRows(deferred, list(['new', 'a', 'b']))).toBe(deferred);
  });

  test('leaves bulk removals to the deferred render', () => {
    const deferred = list(['a', 'b', 'c', 'd', 'e']);
    expect(withoutRemovedRows(deferred, list(['e']))).toBe(deferred);
  });
});
