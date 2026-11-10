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
let preparation: Promise<void> | undefined;

/** Bootstrap before importing application modules that can create network sessions. */
export function prepareMobileGuiNetwork(): Promise<void> {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('YuriGuiNetwork')) return Promise.resolve();
  // Old/unsupported shells keep ordinary application networking; native start
  // rejects GUI activation unless preparation completed successfully.
  return preparation ??= mobileGuiNetworkBridge.prepare().catch(() => {});
}
