import { host } from 'nsh';
import { loadDesktopRemoteConnectionsNative } from './desktop-remote-connections-native-core';

/** Called once by the window root. Missing grant/service readiness keeps the existing unavailable slot. */
export function loadNativeDesktopRemoteConnections(options: { current(): boolean; runtimeReady?(): boolean }) {
  return loadDesktopRemoteConnectionsNative({ source: () => host, current: options.current, runtimeReady: options.runtimeReady });
}
