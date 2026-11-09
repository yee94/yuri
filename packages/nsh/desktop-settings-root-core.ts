import { desktopSettingsDestination, desktopSettingsRouteKey } from './desktop-settings-core';
import type { SettingsRoute } from './settings';
import type { DesktopSettingsContentNavigationState } from './desktop-settings-content-core';

export type DesktopSettingsRootSnapshot = Readonly<{ routes: readonly SettingsRoute[]; revision: number; busy: boolean }>;

/** Window-owned routes never pop the application's retained Chat/NavStack. */
export function createDesktopSettingsRootOwner(publish: (state: DesktopSettingsRootSnapshot) => void, failed: (error: unknown) => void) {
  let state: DesktopSettingsRootSnapshot = { routes: [], revision: 0, busy: false };
  let protection: DesktopSettingsContentNavigationState | null = null, alive = true;
  const update = (next: DesktopSettingsRootSnapshot) => { state = next; publish(next); };
  const setRoutes = (routes: readonly SettingsRoute[]) => { protection = null; update({ routes, revision: state.revision + 1, busy: false }); };
  async function leave(commit: () => void): Promise<boolean> {
    if (!alive || state.busy || !state.routes.length || !protection) return false;
    const revision = state.revision, owner = protection;
    update({ ...state, busy: true });
    try {
      if (!await owner.requestLeave() || !alive || state.revision !== revision || protection?.owner !== owner.owner) return false;
      commit();
      return true;
    } catch (error) { if (alive && state.revision === revision) failed(error); return false; }
    finally { if (alive && state.revision === revision && state.busy) update({ ...state, busy: false }); }
  }
  return {
    snapshot: () => state,
    report(revision: number, next: DesktopSettingsContentNavigationState) {
      if (!alive || revision !== state.revision) return;
      if (next.status === 'retired') { if (protection?.owner === next.owner) protection = null; return; }
      protection = next;
    },
    open(route: SettingsRoute) {
      if (!alive) return Promise.resolve(false);
      const current = state.routes.at(-1);
      const destination = current ? desktopSettingsDestination(current, route) : route;
      if (!current) { setRoutes([destination]); return Promise.resolve(true); }
      if (desktopSettingsRouteKey(current) === desktopSettingsRouteKey(destination)) return Promise.resolve(false);
      return leave(() => setRoutes([...state.routes, destination]));
    },
    commitNavigate(route: SettingsRoute) {
      if (!alive || !state.routes.length) return;
      const current = state.routes.at(-1)!;
      setRoutes([...state.routes, desktopSettingsDestination(current, route)]);
    },
    commitClose() { if (alive) setRoutes([]); },
    commitBack() { if (alive) setRoutes(state.routes.slice(0, -1)); },
    close: () => leave(() => setRoutes([])),
    back: () => leave(() => setRoutes(state.routes.slice(0, -1))),
    leave,
    /** Host identity changes retire the window, never carry drafts to a new Host. */
    retire() { if (alive) setRoutes([]); },
    dispose() { alive = false; protection = null; },
  };
}
