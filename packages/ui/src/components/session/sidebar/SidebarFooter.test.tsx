import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SidebarFooter } from './SidebarFooter';
import { useUpdateStore } from '@/stores/useUpdateStore';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./DeviceConnections', () => ({ DeviceConnections: () => null }));
vi.mock('./SidebarBackgroundTasks', () => ({ SidebarBackgroundTasks: () => <div data-background-tasks /> }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initialState = useUpdateStore.getState();
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;

function renderFooter(onOpenUpdate: () => void, showRuntimeButtons = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  return { client, render: () => act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <SidebarFooter
          showRuntimeButtons={showRuntimeButtons}
          showUpdateButton
          onOpenSettings={() => {}}
          onOpenShortcuts={() => {}}
          onOpenUpdate={onOpenUpdate}
        />
      </QueryClientProvider>,
    );
  }) };
}

const button = () => host.querySelector('button') as HTMLButtonElement;

beforeEach(() => {
  useUpdateStore.setState(initialState, true);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  host?.remove();
});

describe('SidebarFooter update button', () => {
  test('downloads use the shared background indicator instead of a second update ring', async () => {
    useUpdateStore.setState({ downloading: true, available: true, progress: { downloaded: 20, total: 100 } });
    const { render } = renderFooter(vi.fn(), true); await render();
    expect(host.querySelector('[data-background-tasks]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="updateDialog.status.downloading"]')).toBeNull();
  });
  test('a queued update restarts once through the mutation and stays disabled while pending', async () => {
    let resolveRestart: () => void = () => {};
    const restartToUpdate = vi.fn(() => new Promise<void>((resolve) => { resolveRestart = resolve; }));
    useUpdateStore.setState({ downloaded: true, available: true, restartToUpdate });
    const onOpenUpdate = vi.fn();
    const { render } = renderFooter(onOpenUpdate);
    await render();

    expect(button().textContent).toBe('sessions.sidebar.footer.actions.restartUpdate');
    expect(button().querySelector('use')?.getAttribute('href')).toBe('#yuri-restart');
    expect(button().className).toContain('bg-[var(--surface-muted)]');
    expect(button().className).not.toContain('size-7');
    expect(button().querySelector('span')?.className).toBe('truncate text-[10px] font-normal text-muted-foreground/60');

    await act(async () => button().click());
    await act(async () => button().click());
    await act(async () => button().click());

    expect(restartToUpdate).toHaveBeenCalledTimes(1);
    expect(onOpenUpdate).not.toHaveBeenCalled();
    expect(button().disabled).toBe(true);
    expect(button().getAttribute('aria-busy')).toBe('true');
    expect(button().getAttribute('aria-label')).toBe('updateDialog.status.updating');
    expect(button().textContent).toBe('updateDialog.status.updating');

    resolveRestart();
    await act(async () => {});
    expect(restartToUpdate).toHaveBeenCalledTimes(1);
  });

  test('finishing a background download reveals the labeled restart button without opening details', async () => {
    const restartToUpdate = vi.fn(async () => {});
    const onOpenUpdate = vi.fn();
    useUpdateStore.setState({ downloading: true, downloaded: false, available: true, restartToUpdate });
    const { render } = renderFooter(onOpenUpdate, true); await render();
    expect(host.querySelector('button[aria-label="sessions.sidebar.footer.actions.restartUpdate"]')).toBeNull();
    await act(async () => useUpdateStore.setState({ downloading: false, downloaded: true }));
    const ready = host.querySelector('button[aria-label="sessions.sidebar.footer.actions.restartUpdate"]') as HTMLButtonElement;
    expect(ready.textContent).toBe('sessions.sidebar.footer.actions.restartUpdate');
    expect(ready.querySelector('use')?.getAttribute('href')).toBe('#yuri-restart');
    expect(ready.querySelector('[role="progressbar"]')).toBeNull();
    expect(onOpenUpdate).not.toHaveBeenCalled();
    expect(restartToUpdate).not.toHaveBeenCalled();
    await act(async () => ready.click());
    expect(restartToUpdate).toHaveBeenCalledOnce();
    expect(onOpenUpdate).not.toHaveBeenCalled();
  });

  test('an undownloaded update still opens the update dialog', async () => {
    const restartToUpdate = vi.fn(async () => {});
    useUpdateStore.setState({ downloaded: false, available: true, restartToUpdate });
    const onOpenUpdate = vi.fn();
    const { render } = renderFooter(onOpenUpdate);
    await render();

    await act(async () => button().click());

    expect(onOpenUpdate).toHaveBeenCalledTimes(1);
    expect(restartToUpdate).not.toHaveBeenCalled();
  });
});
