import { host, platform } from 'nsh';
import { loadDesktopWriterClient } from './desktop-writer-core';
export * from './desktop-writer-core';

/** Window-root only; iOS/unsupported surfaces never discover or claim desktop authority. */
export function loadNativeDesktopWriterClient(options: { current(): boolean }) {
  if (!platform.desktop) return Promise.resolve(undefined);
  return loadDesktopWriterClient({ source: () => host, current: options.current });
}
