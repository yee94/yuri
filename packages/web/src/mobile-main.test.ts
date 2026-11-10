import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ prepare: vi.fn(), configure: vi.fn(() => ({ marker: 'runtime' })), render: vi.fn() }));
vi.mock('@yuriai/ui/lib/gui-plugins/mobile-network-bridge', () => ({ prepareMobileGuiNetwork: fixture.prepare }));
vi.mock('./runtimeConfig', () => ({ createConfiguredWebAPIs: fixture.configure }));
vi.mock('@yuriai/ui/apps/renderMobileApp', () => ({ renderMobileApp: fixture.render }));
vi.mock('@yuriai/ui/index.css', () => ({}));
vi.mock('@yuriai/ui/styles/fonts', () => ({}));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules(); });

it('prepares the native gateway before runtime configuration can open network connections', async () => {
  vi.stubGlobal('window', {});
  let prepared!: () => void;
  fixture.prepare.mockImplementation(() => new Promise<void>(resolve => { prepared = resolve; }));
  await import('./mobile-main');
  expect(fixture.prepare).toHaveBeenCalledOnce();
  expect(fixture.configure).not.toHaveBeenCalled();
  expect(fixture.render).not.toHaveBeenCalled();
  prepared();
  await vi.waitFor(() => expect(fixture.render).toHaveBeenCalledOnce());
  expect(fixture.render).toHaveBeenCalledWith({ marker: 'runtime' });
  expect(fixture.configure).toHaveBeenCalledOnce();
});
