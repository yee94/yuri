export type ResourceRetirementOwner = { retire(): Promise<void> };
export type ResourceConnectionExit = { retireForConnection(retry: () => void): Promise<void> };

/** Only connection clears use this registry; ordinary navigation stays synchronous. */
export function createResourceConnectionClear<R>(nav: { routes(): readonly R[]; setRoutes(routes: R[]): void; popToRoot(): void }) {
  const owners = new Map<R, ResourceConnectionExit>();
  let generation = 0;
  return {
    register(route: R, owner: ResourceConnectionExit) {
      owners.set(route, owner);
      return () => { if (owners.get(route) === owner) owners.delete(route); };
    },
    clear() {
      const exitGeneration = ++generation, captured = new Set(nav.routes().slice(1));
      const gates = [...captured].flatMap(route => owners.has(route) ? [owners.get(route)!] : []);
      if (!gates.length) { nav.popToRoot(); return; }
      let flight: Promise<void> | undefined;
      const retry = () => {
        if (generation !== exitGeneration || flight) return;
        flight = Promise.all(gates.map(owner => owner.retireForConnection(retry))).then(() => {
          if (generation === exitGeneration) nav.setRoutes(nav.routes().filter(route => !captured.has(route)));
        }).catch(() => { /* Each captured page owns its visible error and retry. */ })
          .finally(() => { flight = undefined; });
      };
      retry();
    },
  };
}

/** Files routes keep their native page until the captured child has retired. */
export function createResourceRouteExit(input: {
  current(): boolean;
  pop(): void;
  changed(value: Readonly<{ pending: boolean; error: string }>): void;
}) {
  let owner: ResourceRetirementOwner | undefined, flight: Promise<void> | undefined;
  let pending = false, error = '', displayLive = true;
  let connectionRetry: (() => void) | undefined;
  const state = () => Object.freeze({ pending, error });
  const publish = () => { if (displayLive) input.changed(state()); };
  return {
    state,
    attach(value: ResourceRetirementOwner) { owner = value; },
    retireForConnection(retry: () => void): Promise<void> {
      connectionRetry = retry;
      if (flight) return flight;
      pending = true; error = '';
      // Revoke the captured reader synchronously, before yielding to any completion.
      try {
        if (!owner) throw new Error('resource_retirement_owner_required');
        flight = owner.retire();
      } catch (cause) { flight = Promise.reject(cause); }
      flight = flight.catch(cause => { error = String(cause); throw cause; })
        .finally(() => { pending = false; flight = undefined; publish(); });
      publish(); return flight;
    },
    back(): Promise<void> {
      if (connectionRetry) { connectionRetry(); return Promise.resolve(); }
      if (flight) return flight;
      if (!displayLive || !input.current()) return Promise.resolve();
      pending = true; error = '';
      flight = Promise.resolve().then(async () => {
        if (!owner) throw new Error('resource_retirement_owner_required');
        await owner.retire();
        if (displayLive && input.current()) input.pop();
      }).catch(cause => { error = String(cause); throw cause; })
        .finally(() => { pending = false; flight = undefined; publish(); });
      publish(); return flight;
    },
    detachDisplay() {
      displayLive = false;
      // An external app teardown can remove a page without its Back action.
      // Preserve the retirement result in this owner even after its UI is gone.
      if (!flight && owner) flight = owner.retire().catch(cause => { error = String(cause); });
    },
  };
}
