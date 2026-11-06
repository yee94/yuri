import { prepareMobileGuiNetwork } from '@yuriai/ui/lib/gui-plugins/mobile-network-bridge';
import type { RuntimeAPIs } from '@yuriai/ui/lib/api/types';
import '@yuriai/ui/index.css';
import '@yuriai/ui/styles/fonts';

declare global {
  interface Window {
    __YURI_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

void prepareMobileGuiNetwork()
  .then(() => import('./runtimeConfig'))
  .then(async ({ createConfiguredWebAPIs }) => {
    window.__YURI_RUNTIME_APIS__ = createConfiguredWebAPIs();
    const { renderMobileApp } = await import('@yuriai/ui/apps/renderMobileApp');
    renderMobileApp(window.__YURI_RUNTIME_APIS__);
  });
