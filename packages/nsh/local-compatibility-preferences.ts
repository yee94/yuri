import { Storage } from 'nsh';
import { createLocalCompatibilityPreferences } from './local-compatibility-preferences-core';

/** Prefs opens/disposes these handles after capturing its operation. No root,
 * polling, Host request or Tab/composer side effect is installed by this adapter. */
export const localCompatibilityPreferences = createLocalCompatibilityPreferences({
  get: key => Storage.getItem(key),
  set: (key, value) => Storage.setItem(key, value),
});
