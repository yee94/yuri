import { batch, cleanup, effect, lifecycle, signal, untracked } from 'nsh';
import { admitSettingsFixture } from './settings-raw-fixture-bootstrap';
import { captureHostOperation, loadConnections } from './state';

/** Keep mounted editors across suspension; renew only their admitted request lane. */
export function settingsEngineFixtureBoot() {
  const mounted = signal(false), active = signal(false), error = signal('');
  let alive = true, generation = 0;
  effect(() => {
    const foreground = lifecycle() === 'active', current = ++generation;
    untracked(() => {
      active.set(false);
      if (!foreground) return;
      const admission = mounted() ? loadConnections({ forceReconnect: true }) : admitSettingsFixture();
      void admission.then(() => {
        if (!alive || current !== generation) return;
        if (!captureHostOperation().current()) throw new Error('Fixture scope admission failed');
        batch(() => { active.set(true); mounted.set(true); error.set(''); });
      }).catch(() => { if (alive && current === generation) error.set('Fixture scope admission failed'); });
    });
  });
  cleanup(() => { alive = false; generation++; });
  return { mounted, active, error };
}
