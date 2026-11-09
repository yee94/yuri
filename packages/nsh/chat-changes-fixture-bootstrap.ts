import { signal } from 'nsh';
import { loadConnections } from './state';

/** Mount page-operation owners only after the real root has adopted the mock connection/lease. */
export function prepareChangesFixture() {
  const ready = signal(false), error = signal('');
  void loadConnections().then(() => ready.set(true), cause => error.set(String(cause)));
  return { ready, error };
}
