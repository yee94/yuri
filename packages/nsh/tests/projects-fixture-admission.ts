import { effect, lifecycle, signal, untracked } from 'nsh';
import { captureHostOperation, loadConnections } from '../state';

/** Exercise root-confirmed admission; a fixture must not manufacture readiness by setting app.connection. */
export function projectsFixtureAdmission(initialize: () => void = () => {}) {
  const ready = signal(false), active = signal(false), error = signal('');
  effect(() => {
    if (lifecycle() !== 'active') { active.set(false); return; }
    let alive = true;
    untracked(() => {
      active.set(false);
      void loadConnections({ forceReconnect: true }).then(() => {
        if (!alive || !captureHostOperation().current()) return;
        initialize(); error.set(''); ready.set(true); active.set(true);
      }).catch(failure => { if (alive) { active.set(false); error.set(String(failure)); } });
    });
    return () => { alive = false; };
  });
  return { ready, active, error };
}
