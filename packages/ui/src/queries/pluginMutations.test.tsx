import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const gateway = vi.hoisted(() => ({
  update: vi.fn(),
  list: vi.fn(),
  check: vi.fn(),
  fetch: vi.fn(),
  reload: vi.fn(),
}));

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/ui', async () => {
  const actual = await vi.importActual<typeof import('@/components/ui')>('@/components/ui');
  return { ...actual, toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } };
});
vi.mock('@/lib/opencode/plugins', () => ({
  updatePluginPackage: gateway.update,
  listPluginRuntime: gateway.list,
  checkPluginUpdates: gateway.check,
  pluginOperationErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: gateway.fetch }));
vi.mock('@/stores/useAgentsStore', () => ({ reloadOpenCodeLocations: gateway.reload }));

import { useReloadPlugins, usePluginPackageUpdateState, useUpdatePluginPackage } from './pluginMutations';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('plugin mutations', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    for (const fn of Object.values(gateway)) fn.mockReset();
    gateway.update.mockResolvedValue(undefined);
    gateway.list.mockResolvedValue([]);
    gateway.check.mockResolvedValue([]);
    gateway.reload.mockResolvedValue(undefined);
    const { queryClient } = await import('@/lib/queryRuntime');
    const { useProjectsStore } = await import('@/stores/useProjectsStore');
    queryClient.clear();
    queryClient.getMutationCache().clear();
    useProjectsStore.setState({
      projects: [{ id: 'a', path: '/workspace/a', name: 'a' }],
      activeProjectId: 'a',
    } as never);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
  });

  const mount = async (node: React.ReactNode) => {
    const { queryClient } = await import('@/lib/queryRuntime');
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
    });
  };

  const Probe: React.FC<{ target: string; name: string }> = ({ target, name }) => {
    const update = useUpdatePluginPackage();
    const state = usePluginPackageUpdateState(target);
    return (
      <button data-state={state.kind} data-error={state.kind === 'error' ? state.error : ''} onClick={() => update(target, name)}>
        update
      </button>
    );
  };

  const click = async () => {
    await act(async () => { host.querySelector('button')?.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };

  test('updates one target in place, rereads status, and never writes config', async () => {
    await mount(<Probe target="foo" name="foo" />);
    await click();

    expect(gateway.update.mock.calls.map((call) => call.slice(0, 2))).toEqual([['/workspace/a', 'foo']]);
    expect(gateway.list).toHaveBeenCalled();
    expect(gateway.fetch.mock.calls.filter((call) => String(call[0]).includes('/api/config/plugins'))).toEqual([]);
    expect(host.querySelector('button')?.getAttribute('data-state')).toBe('idle');
  });

  test('a failed update exposes the OpenCode error as mutation state', async () => {
    gateway.update.mockRejectedValueOnce(new Error('registry timeout'));
    await mount(<Probe target="foo" name="foo" />);
    await click();

    const button = host.querySelector('button');
    expect(button?.getAttribute('data-state')).toBe('error');
    expect(button?.getAttribute('data-error')).toBe('registry timeout');
  });

  test('pending state is scoped to its own target', async () => {
    let release: () => void = () => undefined;
    gateway.update.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    await mount(
      <>
        <Probe target="foo" name="foo" />
        <Probe target="bar" name="bar" />
      </>,
    );
    await act(async () => { host.querySelectorAll('button')[0]?.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const [foo, bar] = [...host.querySelectorAll('button')];
    expect(foo?.getAttribute('data-state')).toBe('pending');
    expect(bar?.getAttribute('data-state')).toBe('idle');

    await act(async () => { release(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.querySelectorAll('button')[0]?.getAttribute('data-state')).toBe('idle');
  });

  test('two components cannot start duplicate updates for the same target', async () => {
    let release!: () => void;
    gateway.update.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    await mount(<><Probe target="foo" name="foo" /><Probe target="foo" name="foo" /></>);
    await act(async () => {
      for (const button of host.querySelectorAll('button')) button.click();
    });
    expect(gateway.update).toHaveBeenCalledTimes(1);
    await act(async () => release());
  });

  test('reload rebuilds OpenCode locations and rereads plugin status', async () => {
    const Reload: React.FC = () => {
      const reload = useReloadPlugins();
      return <button onClick={() => reload.mutate()}>reload</button>;
    };
    await mount(<Reload />);
    await click();

    expect(gateway.reload).toHaveBeenCalledTimes(1);
    expect(gateway.list).toHaveBeenCalled();
  });
});
