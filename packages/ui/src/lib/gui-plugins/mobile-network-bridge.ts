import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { MobileGuiWireBridge } from './mobile-network-wire';

export type MobileGuiNetworkEvent = { scope: string; type: string; id?: number; hostname?: string; port?: number; data?: string };
export type MobileGuiDirectTarget = { hostname: string; port: number };
type NativeReply = { scope: string; id: number; type: string; data?: string; bytes?: number };
type GuiNetworkPlugin = MobileGuiWireBridge & {
  prepare(): Promise<void>;
  capabilities(): Promise<{ supported: boolean }>;
  /** `direct` lists Yuri's own Relay/runtime endpoints; they never enter plugin egress. */
  start(options: { scope: string; relayUrl: string; direct: MobileGuiDirectTarget[] }): Promise<void>;
  send(options: NativeReply): Promise<void>;
  stop(options: { scope: string }): Promise<void>;
  addListener(event: 'stream', callback: (event: MobileGuiNetworkEvent) => void): Promise<PluginListenerHandle>;
};
export const mobileGuiNetworkBridge = registerPlugin<GuiNetworkPlugin>('YuriGuiNetwork');

/**
 * Binds the loopback gateway for a lease (idempotent while bound). It does not change
 * the WebView proxy; native `start` routes through it and the final `stop` tears it down.
 */
export function prepareMobileGuiNetwork(): Promise<void> {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('YuriGuiNetwork')) return Promise.resolve();
  // Old/unsupported shells keep ordinary application networking; native start
  // rejects GUI activation unless preparation completed successfully.
  return mobileGuiNetworkBridge.prepare().catch(() => {});
}
