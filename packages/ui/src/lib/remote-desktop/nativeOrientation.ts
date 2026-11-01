import { Capacitor, registerPlugin } from '@capacitor/core';
import type { DesktopOrientation } from './orientation';

const plugin = registerPlugin<{ lock(options: { orientation: DesktopOrientation }): Promise<void> }>('YuriOrientation');

export function nativeOrientationAvailable() {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('YuriOrientation');
}

export function lockNativeOrientation(orientation: DesktopOrientation) {
  return plugin.lock({ orientation });
}
