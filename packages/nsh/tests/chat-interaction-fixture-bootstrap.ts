import { signal } from 'nsh';
import { loadConnections } from '../state';

/** Independent fixture App: adopt the real connection/lease before mounting page owners. */
export function prepareInteractionFixture() {
  const ready = signal(false), error = signal('');
  void loadConnections().then(() => ready.set(true), cause => error.set(String(cause)));
  return { ready, error };
}
