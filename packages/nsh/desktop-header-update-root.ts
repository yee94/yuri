import { createNativeDesktopHeaderUpdateOwner } from './desktop-header-update-native';
import { createDesktopHeaderUpdateRootController, type DesktopHeaderUpdateRootOptions } from './desktop-header-update-root-core';

export type { DesktopHeaderUpdateCommitted, DesktopHeaderUpdateRootOptions } from './desktop-header-update-root-core';

/** Thin window root adapter. Main owns the original operation effect and teardown. */
export function createNativeDesktopHeaderUpdateRoot(options: DesktopHeaderUpdateRootOptions) {
  const revision = signal(0);
  const owner = createDesktopHeaderUpdateRootController(options, createNativeDesktopHeaderUpdateOwner,
    () => untracked(() => revision.set(revision() + 1)));
  return { ...owner,
    about() { revision(); return owner.about(); },
    canClose() { revision(); return owner.canClose(); },
  };
}
import { signal, untracked } from 'nsh';
