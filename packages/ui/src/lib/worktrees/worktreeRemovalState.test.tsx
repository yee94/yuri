import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { beginWorktreeRemoval, endWorktreeRemoval, useIsWorktreeRemoving } from './worktreeRemovalState';

let root: Root;
let container: HTMLDivElement;

const Probe = ({ directory }: { directory: string }) => (
  <span data-testid={directory}>{String(useIsWorktreeRemoving(directory))}</span>
);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('tracks removal per directory and ignores trailing slashes', () => {
  act(() => root.render(<><Probe directory="/repo/wt-a" /><Probe directory="/repo/wt-b" /></>));
  const text = (dir: string) => container.querySelector(`[data-testid="${dir}"]`)?.textContent;
  expect(text('/repo/wt-a')).toBe('false');

  act(() => beginWorktreeRemoval('/repo/wt-a/'));
  expect(text('/repo/wt-a')).toBe('true');
  expect(text('/repo/wt-b')).toBe('false');

  act(() => endWorktreeRemoval('/repo/wt-a'));
  expect(text('/repo/wt-a')).toBe('false');
});
