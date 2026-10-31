import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PluginIcon } from './PluginIcon';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('PluginIcon', () => {
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

  const render = async (node: React.ReactNode) => {
    await act(async () => { root.render(node); });
  };

  test('shows the package picture when there is one', async () => {
    await render(<PluginIcon name="foo" src="https://cdn.example/a.png" />);
    expect(host.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/a.png');
  });

  test('falls back to the first letter without a picture, ignoring a leading @', async () => {
    await render(<PluginIcon name="@tencent/runmark" />);
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toBe('T');
  });

  test('a picture that fails to load falls back to the placeholder', async () => {
    await render(<PluginIcon name="opencode-magpie" src="https://cdn.example/broken.png" />);
    await act(async () => { host.querySelector('img')?.dispatchEvent(new Event('error')); });
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toBe('O');
  });

  test('a new picture is tried again after an earlier one failed', async () => {
    await render(<PluginIcon name="foo" src="https://cdn.example/broken.png" />);
    await act(async () => { host.querySelector('img')?.dispatchEvent(new Event('error')); });
    await render(<PluginIcon name="foo" src="https://cdn.example/fixed.png" />);
    expect(host.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/fixed.png');
  });

  test('a busy plugin keeps its picture and gains a spinner', async () => {
    await render(<PluginIcon name="foo" src="https://cdn.example/a.png" busy />);
    expect(host.querySelector('img')).not.toBeNull();
    expect(host.querySelector('[data-plugin-busy] .animate-spin')).not.toBeNull();
  });

  test('an idle plugin has no spinner', async () => {
    await render(<PluginIcon name="foo" />);
    expect(host.querySelector('.animate-spin')).toBeNull();
  });

  test('the placeholder is a fixed rounded tile, not a bare letter', async () => {
    await render(<PluginIcon name="@scope/plugin" />);
    const frame = host.querySelector<HTMLElement>('[data-plugin-icon]')!;
    expect(frame.style.width).toBe('20px');
    expect(frame.style.height).toBe('20px');
    const tile = frame.firstElementChild as HTMLElement;
    expect(tile.style.display).toBe('grid');
    expect(tile.style.borderRadius).toBe('6px');
    expect(tile.classList.contains('yuri-plugin-icon-placeholder')).toBe(true);
  });
});
