import { createSettingsFixtureScope } from './settings-raw-fixture-scope.mjs';

/** Synthetic forwarding only; never authorizes a real Host or writes outside memory. */
export function settingsEngineFixtureScope(id) {
  const scope = createSettingsFixtureScope(id);
  let issued = false;
  return {
    connection(input) { const snapshot = scope.snapshot(input); issued = true; return snapshot; },
    admit(input) {
      if (!issued) throw new Error('Settings fixture connection snapshot not issued');
      scope.admit(input);
    },
    control(input) { issued = false; return scope.control(input); },
    audit(input = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('Invalid synthetic scope audit payload');
      return scope.audit();
    },
  };
}
