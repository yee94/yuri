import { getShortcutAction } from '../ui/src/lib/shortcuts-core';
import type { NativeShortcutActions } from './desktop-shortcuts-core';
import { record, text, type Row } from './model';

/** One mounted composer/selection surface. The root owns the only desktop keymap. */
export interface NativeDesktopComposerShortcutOwner {
  current(): boolean;
  composing(): boolean;
  /** Blocking business panels only; autocomplete is admitted by keyboard.onSubmit. */
  overlayOpen(): boolean;
  readonly actions: NativeShortcutActions;
}
export type NativeDesktopComposerShortcutRegistration = {
  type: 'register' | 'retire';
  owner: NativeDesktopComposerShortcutOwner;
};
export type NativeDesktopComposerShortcutPublisher = (registration: NativeDesktopComposerShortcutRegistration) => void;

/** Stable descriptors read only cheap gates; catalog work belongs to action time.
 * Captured descriptors recheck ownership too, including after a late retirement. */
export function createNativeDesktopComposerShortcutOwner(options: NativeDesktopComposerShortcutOwner) {
  let alive = true;
  const current = () => alive && options.current();
  const admitted = () => current() && !options.composing() && !options.overlayOpen();
  const actions: Record<string, NativeShortcutActions[string]> = {};
  for (const [id, action] of Object.entries(options.actions)) {
    if (!action) continue;
    if (!getShortcutAction(id)) throw new Error(`unknown-composer-shortcut:${id}`);
    actions[id] = {
      when: action.when ?? 'always', priority: action.priority ?? 50,
      get enabled() { return admitted() && action.enabled !== false; },
      run(intent) { if (admitted() && action.enabled !== false) return action.run(intent); },
    };
  }
  const owner: NativeDesktopComposerShortcutOwner = {
    current, composing: options.composing, overlayOpen: options.overlayOpen, actions,
  };
  return { owner, retire() { alive = false; } };
}

/** Match Web's surface cycling: Default/unknown -> first, last -> first (not Default).
 * Only the selected model is inspected, and only from an explicit action. */
export function nativeDesktopNextModelVariant(providers: readonly Row[], model: { providerID?: unknown; id?: unknown; variant?: unknown }): string | undefined {
  const providerID = text(model.providerID), modelID = text(model.id);
  if (!providerID || !modelID) return undefined;
  const models = providers.find(provider => provider.id === providerID)?.models;
  const entry = Array.isArray(models) ? models.find(value => record(value).id === modelID) : record(models)[modelID];
  const variants = Object.keys(record(record(entry).variants));
  if (!variants.length) return undefined;
  return variants[(variants.indexOf(text(model.variant)) + 1) % variants.length];
}
