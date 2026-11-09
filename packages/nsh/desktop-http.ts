import { host } from 'nsh';
import { loadDesktopHttpGrant, type DesktopHttpSource } from './desktop-http-core';
export * from './desktop-http-core';

const nativeSource: DesktopHttpSource = { available: () => host.available(), call: (name, input, options) => host.call(name, input, options) };

/** Main supplies the real captured window/source lifetime. Missing manifest/native support never enables a client. */
export function loadNativeDesktopHttpGrant(options: { current: () => boolean }) {
  return loadDesktopHttpGrant({ source: () => nativeSource, current: options.current });
}
