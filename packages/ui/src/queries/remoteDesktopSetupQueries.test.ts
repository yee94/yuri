import { beforeEach, expect, it, vi } from 'vitest';
import { remoteDesktopSetupOptions } from './remoteDesktopSetupQueries';

const mock = vi.hoisted(() => ({ native: vi.fn(), transport: 'local', generation: 1 }));
vi.mock('@/lib/desktop', () => ({ configureDesktopRemoteDesktop: mock.native }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => mock.transport, getRuntimeGeneration: () => mock.generation }));
beforeEach(() => { mock.native.mockReset(); mock.transport = 'local'; mock.generation = 1; });
it('rejects a stale native check before the call and after completion instead of updating another runtime', async () => {
  const options = remoteDesktopSetupOptions('local', 1);
  mock.transport = 'host:other';
  await expect(options.queryFn({ signal: new AbortController().signal })).rejects.toThrow('runtime_changed');
  expect(mock.native).not.toHaveBeenCalled();
  mock.transport = 'local';
  mock.native.mockImplementation(async () => { mock.generation++; return { enabled: false }; });
  await expect(options.queryFn({ signal: new AbortController().signal })).rejects.toThrow('runtime_changed');
});
it('honors cancelled checks and keys native permission state by runtime generation', async () => {
  const options = remoteDesktopSetupOptions('local', 1);
  expect(options.queryKey).not.toEqual(remoteDesktopSetupOptions('local', 2).queryKey);
  const controller = new AbortController(); controller.abort();
  await expect(options.queryFn({ signal: controller.signal })).rejects.toThrow();
  expect(mock.native).not.toHaveBeenCalled();
});
