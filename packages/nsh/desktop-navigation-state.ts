import { cleanup, effect, signal, Storage, untracked } from 'nsh';
import { createDesktopNavigationPersistence, type DesktopNavigationOptions, type DesktopNavigationState } from './desktop-navigation-state-core';

/** Attach once below the desktop application owner, NOT a route owner. Only authority is
 * subscribed: typing/draft changes do not cause disk or network work. Main explicitly calls
 * userNavigated() at all navigation intents (before async guards), captures captureAuthority(),
 * then save(publicTarget, capturedAuthority) after an authorized navigation. save also vetoes
 * pending restore, but cannot replace the pre-await intent hook. Never save the startup root/default
 * projection before restore, or project old-Host routes under a newly selected authority.
 * requestRestore is main's exact lookup + dirty-guard action; onRestore synchronously uses
 * the returned authority data to construct a route, not a persisted title/private owner.
 * New-session apply mounts/reuses openNativeNewSession; this adapter never opens drafts.
 * Window close-ticket admission must await flush() BEFORE approving; false vetoes while
 * routes/owners remain alive. Do not dispose via close() before native ACK/other guards:
 * close() is final owner teardown only. Cleanup cannot block OS process termination;
 * close() false keeps the owner and pending metadata for retry. */
export function attachDesktopNavigationPersistence(options: Omit<DesktopNavigationOptions, 'storage' | 'onChange'> & {
  storage?: DesktopNavigationOptions['storage'];
}) {
  const state = signal<DesktopNavigationState>({ restore: 'idle', write: 'idle', restoreError: null, writeError: null });
  const controller = createDesktopNavigationPersistence({ ...options, storage: options.storage ?? Storage, onChange: next => state.set(next) });
  effect(() => {
    // Track the producer's signals, not state reads made by controller callbacks.
    options.authority();
    untracked(controller.synchronize);
  });
  cleanup(() => { void controller.dispose(); });
  return { ...controller, state };
}
