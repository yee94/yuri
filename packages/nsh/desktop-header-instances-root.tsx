import { cleanup, effect, signal, untracked } from 'nsh';
import { app } from './state';
import { createDesktopHeaderInstancesRootController, type DesktopHeaderCommittedConnections, type DesktopHeaderInstancesRootOptions } from './desktop-header-instances-root-core';

/** Construct once at the window root. Hidden readers do not even subscribe to app's catalogs. */
export function createDesktopHeaderInstancesRoot(options: Omit<DesktopHeaderInstancesRootOptions, 'committed'>) {
  const observing = signal(0), listeners = new Set<() => void>();
  let previous: DesktopHeaderCommittedConnections | null = null;
  const read = (): DesktopHeaderCommittedConnections => ({ connections: app.connections(), connection: app.connection(), online: app.online() });
  const owner = createDesktopHeaderInstancesRootController({ ...options, committed: {
    read() { const value = read(); previous = value; return value; },
    subscribe(listener) { listeners.add(listener); observing.set(listeners.size); return () => { listeners.delete(listener); observing.set(listeners.size); }; },
  } });
  effect(() => {
    if (!observing()) return;
    const value = read();
    untracked(() => {
      if (previous && previous.connections === value.connections && previous.connection === value.connection && previous.online === value.online) return;
      previous = value;
      for (const listener of listeners) { try { listener(); } catch { /* A retired projection observer cannot affect committed state. */ } }
    });
  });
  cleanup(owner.dispose);
  return owner;
}
