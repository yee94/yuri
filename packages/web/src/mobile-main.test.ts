import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ prepare: vi.fn(), configure: vi.fn(() => ({ marker: 'runtime' })), render: vi.fn() }));
vi.mock('@yuriai/ui/lib/gui-plugins/mobile-network-bridge', () => ({ prepareMobileGuiNetwork: fixture.prepare }));
vi.mock('./runtimeConfig', () => ({ createConfiguredWebAPIs: fixture.configure }));
vi.mock('@yuriai/ui/apps/renderMobileApp', () => ({ renderMobileApp: fixture.render }));
vi.mock('@yuriai/ui/index.css', () => ({}));
vi.mock('@yuriai/ui/styles/fonts', () => ({}));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules(); });

it('starts the application on its original network path without the plugin gateway', async () => {
  vi.stubGlobal('window', {});
  await import('./mobile-main');
  await vi.waitFor(() => expect(fixture.render).toHaveBeenCalledOnce());
  expect(fixture.render).toHaveBeenCalledWith({ marker: 'runtime' });
  expect(fixture.prepare).not.toHaveBeenCalled();
});
