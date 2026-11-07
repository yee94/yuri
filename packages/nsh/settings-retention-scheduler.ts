import type { RetentionController } from './settings-retention-controller';

const owners = new WeakSet<RetentionController>();
/** Explicit root-only lease; the settings section must never create another auto-cleanup loop. */
export function createRetentionScheduler<T>(controller: RetentionController, clock: { now: () => number; set: (delay: number, run: () => void) => T; clear: (timer: T) => void }) {
  if (owners.has(controller)) throw new Error('Retention scheduler already owned');
  owners.add(controller);
  let active = false, disposed = false, timer: T | undefined, key = '', running = false;
  const cancel = () => { if (timer !== undefined) clock.clear(timer); timer = undefined; };
  const schedule = () => {
    const state = controller.snapshot(), preferences = state.preferences;
    const next = JSON.stringify([active, state.ready, state.hostSynced, state.admission, preferences, state.lastRunAt]);
    if (next === key || disposed) return;
    key = next; cancel();
    if (!active || !state.ready || !state.hostSynced || state.admission === 'server-atomic-required' || !preferences.autoDeleteEnabled || running) return;
    const delay = Math.max(8000, state.lastRunAt === null ? 0 : state.lastRunAt + 86_400_000 - clock.now());
    timer = clock.set(delay, () => {
      timer = undefined; running = true;
      void controller.autoRun().finally(() => { running = false; key = ''; if (!controller.snapshot().error) schedule(); });
    });
  };
  const unsubscribe = controller.subscribe(schedule);
  return {
    update(value: boolean) { active = value; schedule(); },
    dispose() { disposed = true; cancel(); unsubscribe(); owners.delete(controller); },
  };
}
