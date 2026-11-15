import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useRunStartTimes } from './taskRunElapsed';

let latest: ReadonlyMap<string, number> = new Map();

function Probe({ ids, enabled }: { ids: ReadonlySet<string>; enabled: boolean }) {
  latest = useRunStartTimes(ids, enabled);
  return null;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const render = async (root: ReturnType<typeof createRoot>, ids: Set<string>, enabled = true) => {
  await act(async () => root.render(<Probe ids={ids} enabled={enabled} />));
};

test('run start times keep one reference while membership is unchanged and keep each first-seen time', async () => {
  const root = createRoot(document.createElement('div'));
  vi.setSystemTime(1_000);
  await render(root, new Set(['a', 'b']));
  const first = latest;
  expect([...first.entries()]).toEqual([['a', 1_000], ['b', 1_000]]);

  vi.setSystemTime(9_000);
  // New Set instance, same members: the map reference must not change.
  await render(root, new Set(['a', 'b']));
  expect(latest).toBe(first);

  // One new runner: only it gets a fresh time; the others keep theirs.
  await render(root, new Set(['a', 'b', 'c']));
  expect(latest).not.toBe(first);
  expect(latest.get('a')).toBe(1_000);
  expect(latest.get('c')).toBe(9_000);

  // A finished runner leaves the map.
  await render(root, new Set(['a', 'c']));
  expect(latest.has('b')).toBe(false);
  expect(latest.get('a')).toBe(1_000);
  await act(async () => root.unmount());
});

test('a hidden sidebar neither resets nor advances the map', async () => {
  const root = createRoot(document.createElement('div'));
  vi.setSystemTime(2_000);
  await render(root, new Set(['a']));
  const seen = latest;
  await render(root, new Set(), false);
  expect(latest).toBe(seen);
  await act(async () => root.unmount());
});
