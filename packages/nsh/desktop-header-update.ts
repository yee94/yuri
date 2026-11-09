import type { DesktopHeaderServiceIntent, DesktopHeaderUpdatePort, DesktopHeaderUpdateProjection } from './desktop-header-services';
import type { SettingsAboutController } from './settings-about-core';

/** The About controller is the sole source. This adapter never owns a reader or updater. */
export function createDesktopHeaderUpdateOwner(options: { about: SettingsAboutController; current(): boolean }) {
  let alive = true, retired = false;
  function current() {
    if (!alive || retired) return false;
    if (!options.current()) retired = true;
    return !retired;
  }
  const projection = (): DesktopHeaderUpdateProjection => {
    const value = options.about.state();
    return { hostUpdate: value.hostUpdate, updateBusy: value.updateBusy, updateFailed: value.updateFailed,
      updateUncertain: value.updateUncertain, updateConfirm: value.updateConfirm, version: value.host.value?.version ?? null };
  };
  const port: DesktopHeaderUpdatePort = {
    async read(intent) {
      if (!current() || !intent.current()) throw new Error('about_projection_stale');
      await options.about.hostUpdate();
      if (!current() || !intent.current()) throw new Error('about_projection_stale');
      return projection();
    },
    // There is no declared native admission + retained confirmation presenter today.
    nativeGate: () => false,
    available: () => false,
    run: async intent => ({ status: current() && intent.current() ? 'unsupported' : 'stale' }),
  };
  return {
    about: options.about, port, projection,
    canClose: options.about.canClose,
    unavailableReason: 'native-update-admission-and-confirmation-unavailable' as const,
    /** Optional push into services.projectUpdate; caller owns visible-only subscription. */
    subscribe(intent: DesktopHeaderServiceIntent, changed: (value: DesktopHeaderUpdateProjection) => void) {
      if (!current() || !intent.current()) return () => {};
      return options.about.subscribe(() => { if (current() && intent.current()) changed(projection()); });
    },
    dispose() {
      if (!options.about.dispose()) return false;
      alive = false;
      return true;
    },
    /** Final callback revocation is not disposal and never clears a receipt. */
    retire() { alive = false; retired = true; },
  };
}
export type DesktopHeaderUpdateOwner = ReturnType<typeof createDesktopHeaderUpdateOwner>;
