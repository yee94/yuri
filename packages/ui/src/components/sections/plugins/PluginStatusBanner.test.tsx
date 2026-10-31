import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { PluginRuntimeInfo } from '@/lib/opencode/plugins';
import type { PluginRuntimeTarget } from './pluginLoadState';

const gateway = vi.hoisted(() => ({
  update: vi.fn(),
  list: vi.fn(),
  fetch: vi.fn(),
  copy: vi.fn(),
}));

vi.mock('@/lib/i18n', async () => {
  const { dict } = await import('@/lib/i18n/messages/en');
  return {
    useI18n: () => ({
      t: (key: keyof typeof dict, params?: Record<string, string | number>) => {
        let text: string = dict[key];
        if (params) {
          for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value));
        }
        return text;
      },
    }),
  };
});
vi.mock('@/components/ui', async () => {
  const actual = await vi.importActual<typeof import('@/components/ui')>('@/components/ui');
  return {
    ...actual,
    toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  };
});
vi.mock('@/lib/opencode/plugins', () => ({
  updatePluginPackage: gateway.update,
  listPluginRuntime: gateway.list,
  checkPluginUpdates: gateway.list,
  pluginOperationErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: gateway.fetch }));
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: gateway.copy }));

const loaded = (target: string, extra: Partial<{ version: string; outdated: boolean }> = {}): PluginRuntimeInfo => ({
  source: { kind: 'package', target, version: extra.version ?? null, outdated: extra.outdated ?? false, updating: false },
  state: { kind: 'active' },
});
const failed = (target: string, error: string): PluginRuntimeInfo => ({
  source: { kind: 'package', target, version: null, outdated: false, updating: false },
  state: { kind: 'failed', error, ref: 'err_9' },
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('PluginStatusBanner', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    gateway.update.mockReset();
    gateway.list.mockReset();
    gateway.fetch.mockReset();
    gateway.copy.mockReset();
    gateway.copy.mockResolvedValue({ ok: true });
    gateway.update.mockResolvedValue(undefined);
    gateway.list.mockResolvedValue([]);
    const { queryClient } = await import('@/lib/queryRuntime');
    const { useProjectsStore } = await import('@/stores/useProjectsStore');
    queryClient.clear();
    useProjectsStore.setState({
      projects: [{ id: 'a', path: '/workspace/a', name: 'a' }],
      activeProjectId: 'a',
    } as never);
    queryClient.getMutationCache().clear();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    const { queryClient } = await import('@/lib/queryRuntime');
    queryClient.clear();
  });

  const renderBanner = async (target: PluginRuntimeTarget | null, name: string, latestVersion?: string) => {
    const { queryClient } = await import('@/lib/queryRuntime');
    const { PluginStatusBanner } = await import('./PluginStatusBanner');
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PluginStatusBanner target={target} name={name} latestVersion={latestVersion} />
        </QueryClientProvider>,
      );
    });
  };

  const seed = async (inventory: PluginRuntimeInfo[]) => {
    const { queryClient } = await import('@/lib/queryRuntime');
    const { pluginRuntimeQueryOptions } = await import('@/queries/pluginQueries');
    const options = pluginRuntimeQueryOptions('/workspace/a');
    queryClient.setQueryData(options.queryKey, inventory);
    gateway.list.mockResolvedValue(inventory);
  };

  test('a loaded plugin is shown as loaded, and a pin is not offered an in-place update', async () => {
    await seed([loaded('foo@1.2.3', { version: '1.2.3' })]);
    await renderBanner({ kind: 'package', target: 'foo@1.2.3' }, 'foo@1.2.3');
    expect(host.querySelector('[data-plugin-load-state]')).toBeNull();
    expect(host.textContent).not.toContain('Update');
    expect(host.textContent).not.toContain('Failed to load');
  });

  test('a failed plugin shows the error and is not shown as loaded', async () => {
    await seed([failed('bar', 'Plugin entrypoint not found')]);
    await renderBanner({ kind: 'package', target: 'bar' }, 'bar');
    expect(host.textContent).toContain('Plugin entrypoint not found');
    expect(host.textContent).toContain('Log reference: err_9');
    expect(host.querySelector('[data-plugin-load-state="failed"]')).toBeTruthy();
    expect(host.textContent).not.toContain('Loaded');
  });

  test('the restrained error block expands in place and copies the full error', async () => {
    const error = 'Cannot load plugin\nRequire stack:\n- entry.js\n- loader.js';
    await seed([failed('bar', error)]);
    await renderBanner({ kind: 'package', target: 'bar' }, 'bar');
    expect(host.querySelector('pre')?.classList.contains('line-clamp-2')).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.click());
    expect(host.querySelector('pre')?.classList.contains('line-clamp-2')).toBe(false);
    const copy = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Copy')!;
    await act(async () => copy.click());
    expect(gateway.copy).toHaveBeenCalledWith(error);
  });

  test('an unpinned outdated plugin can update without writing config', async () => {
    await seed([loaded('foo', { version: '1.0.0', outdated: true })]);
    await renderBanner({ kind: 'package', target: 'foo' }, 'foo');
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Update');
    expect(button).toBeTruthy();
    await act(async () => { button?.click(); });
    expect(gateway.update.mock.calls[0]?.slice(0, 2)).toEqual(['/workspace/a', 'foo']);
    expect(gateway.fetch).not.toHaveBeenCalled();
  });

  test('a failed in-place update shows the OpenCode error', async () => {
    gateway.update.mockRejectedValueOnce(new Error('registry timeout'));
    await seed([loaded('foo', { version: '1.0.0', outdated: true })]);
    await renderBanner({ kind: 'package', target: 'foo' }, 'foo');
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Update');
    await act(async () => { button?.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain('Update failed');
    expect(host.textContent).toContain('registry timeout');
  });

  test('an update in flight disables a second one', async () => {
    let release: () => void = () => undefined;
    gateway.update.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    await seed([loaded('foo', { version: '1.0.0', outdated: true })]);
    await renderBanner({ kind: 'package', target: 'foo' }, 'foo', '1.2.0');
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Update');
    await act(async () => { button?.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain('Updating to 1.2.0…');
    expect(host.querySelector('.animate-indeterminate-slide')).not.toBeNull();
    const pending = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes('Updating'));
    expect(pending).toBeTruthy();
    expect(pending?.hasAttribute('disabled')).toBe(true);
    await act(async () => { release(); });
  });

  test('a complete inventory that omits the plugin is not loaded', async () => {
    await seed([]);
    await renderBanner({ kind: 'package', target: 'foo' }, 'foo');
    expect(host.textContent).toContain("OpenCode hasn't reported this plugin here.");
    expect(host.textContent).not.toContain('Not loaded');
    const strip = host.querySelector('[data-plugin-load-state="notReported"]');
    expect(strip?.classList.contains('yuri-plugin-update-strip')).toBe(true);
    expect(strip?.querySelector('.animate-spin')).not.toBeNull();
    expect(host.textContent).not.toContain('Loaded');
    expect(host.textContent).not.toContain('Status unknown');
  });

  test('missing OpenCode status is unknown, not loaded', async () => {
    gateway.list.mockRejectedValue(new Error('down'));
    await renderBanner({ kind: 'package', target: 'foo' }, 'foo');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain('Status unknown');
    expect(host.querySelector('[data-plugin-load-state="unknown"]')).toBeTruthy();
    expect(host.textContent).not.toContain('Loaded');
    expect(host.textContent).not.toContain('Failed to load');
  });
});
