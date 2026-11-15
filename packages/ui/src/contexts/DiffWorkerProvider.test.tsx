import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';

const pools = vi.hoisted(() => ({
  created: [] as Array<{ size: number; setRenderOptions: ReturnType<typeof vi.fn> }>,
}));
vi.mock('@pierre/diffs/worker', () => ({
  WorkerPoolManager: class {
    initialize = vi.fn(async () => {});
    setRenderOptions = vi.fn(async () => {});
    constructor(options: { poolSize: number }) {
      pools.created.push({ size: options.poolSize, setRenderOptions: this.setRenderOptions });
    }
  },
}));
vi.mock('@/lib/diff/workerFactory', () => ({ workerFactory: vi.fn() }));
vi.mock('@/lib/shiki/appThemeRegistry', () => ({ ensurePierreThemeRegistered: vi.fn() }));
vi.mock('@/lib/theme/themes', () => ({ getDefaultTheme: (dark: boolean) => ({ metadata: { id: dark ? 'dark' : 'light' } }) }));
vi.mock('./useThemeSystem', () => ({ useOptionalThemeSystem: () => null }));
import { DiffWorkerProvider, useWorkerPool } from './DiffWorkerProvider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement('div');
const root = createRoot(container);
function Diff({ style }: { style: 'unified' | 'split' }) {
  useWorkerPool(style);
  return <div>diff</div>;
}
afterEach(async () => { await act(async () => root.render(null)); });

test('home creates no workers; first visible diff initializes only its layout and reuses it', async () => {
  await act(async () => root.render(<DiffWorkerProvider><div>home</div></DiffWorkerProvider>));
  expect(pools.created).toHaveLength(0);
  await act(async () => root.render(<DiffWorkerProvider><Diff style="unified" /></DiffWorkerProvider>));
  expect(pools.created.map(pool => pool.size)).toEqual([1]);
  for (let i = 0; i < 50; i++) {
    await act(async () => root.render(<DiffWorkerProvider><Diff style="unified" /><span>{i}</span></DiffWorkerProvider>));
  }
  expect(pools.created).toHaveLength(1);
  expect(pools.created[0].setRenderOptions).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<DiffWorkerProvider><Diff style="split" /></DiffWorkerProvider>));
  expect(pools.created.map(pool => pool.size)).toEqual([1, 2]);
});
