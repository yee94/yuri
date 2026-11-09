import type { createResourceConnectionClear } from '../../resource-retirement';

/** Build replaces this fail-closed placeholder with the exact production effect. */
export function installProductionConnectionEffect<R>(_clear: ReturnType<typeof createResourceConnectionClear<R>>): void {
  throw new Error('Build this fixture with build-resource-global-clear-uikit.mjs');
}
