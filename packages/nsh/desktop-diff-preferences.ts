import { signal, Storage, untracked } from 'nsh';
import { createDesktopDiffPreferences, type DesktopDiffPreferenceStorage } from './desktop-diff-preferences-core';

/** One root-created owner per Engine. No implicit second Settings/panel singleton. */
export function createNativeDesktopDiffPreferences(options: { storage?: DesktopDiffPreferenceStorage; coordination?: 'single-engine' | 'multi-engine'; fileLimit?: number; pathUnitsLimit?: number } = {}) {
  const revision = signal(0);
  const owner = createDesktopDiffPreferences(options.storage ?? Storage, () => untracked(() => revision.set(revision() + 1)), options);
  const reactive = { ...owner,
    state() { revision(); return owner.state(); },
    available() { revision(); return owner.available() && !owner.state().writing; },
    preferences(path?: string) { revision(); return owner.preferences(path); },
  };
  return { ...reactive, ready: owner.load() };
}
export type NativeDesktopDiffPreferences = ReturnType<typeof createNativeDesktopDiffPreferences>;
const registered = signal<NativeDesktopDiffPreferences | null>(null);
export const nativeDesktopDiffPreferences = () => registered();
/** Install once at the root and pass the SAME owner as NativeDesktopPanel.diffPreferences.
 * This is an Engine-local registration, never proof of cross-Engine exclusivity. */
export function bindNativeDesktopDiffPreferences(owner: NativeDesktopDiffPreferences) {
  if (registered()) throw new Error('desktop_diff_preferences_already_bound');
  registered.set(owner);
  return () => { if (registered() === owner) registered.set(null); };
}
