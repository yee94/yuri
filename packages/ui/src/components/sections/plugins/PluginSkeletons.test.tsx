import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PluginDetailSkeleton, PluginListSkeleton } from './PluginSkeletons';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('plugin skeletons', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
  });

  test('list placeholder has five busy rows and no text', async () => {
    await act(async () => { root.render(<PluginListSkeleton />); });
    const list = host.querySelector('[data-plugin-skeleton="list"]');
    expect(list?.getAttribute('aria-busy')).toBe('true');
    expect(list?.querySelectorAll('[data-plugin-skeleton-row]')).toHaveLength(5);
    expect(host.textContent).toBe('');
  });

  test('detail placeholder is announced as busy', async () => {
    await act(async () => { root.render(<PluginDetailSkeleton />); });
    expect(host.querySelector('[data-plugin-skeleton="detail"]')?.getAttribute('aria-busy')).toBe('true');
  });
});
