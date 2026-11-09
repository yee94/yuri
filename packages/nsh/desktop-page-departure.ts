export type DesktopPageDepartureOwner = {
  current: () => boolean;
  requestLeave: (commit: () => void) => Promise<void>;
  release: () => void;
  requestClose: () => Promise<boolean>;
  canClose: () => boolean;
};

/** Window-local admission for a retained page editor. A navigation may release
 * its editor; a native close approval never does. Both retain their exact owner
 * and Host identity through asynchronous confirmation. */
export function createDesktopPageDeparture(options: { scope: () => unknown; onIntent: () => void; onError: (error: unknown) => void }) {
  let alive = true, owner: DesktopPageDepartureOwner | undefined;
  let pending: object | undefined;
  const selected = () => owner?.current() ? owner : undefined;
  async function request(commit: () => void, validate: () => boolean = () => true, admission?: (() => Promise<boolean>) | string): Promise<boolean> {
    if (!alive) return false;
    // Root adapters may forward opaque action metadata formerly ignored by this helper.
    const beforeCommit = typeof admission === 'function' ? admission : undefined;
    options.onIntent();
    const captured = selected(), scope = options.scope();
    if (pending) return false;
    if (!captured && !beforeCommit) { if (!validate()) return false; commit(); return true; }
    const ticket = {}; pending = ticket;
    const bound = owner;
    let committed = false, callbackAccepted = false, accepting = true;
    let completion: Promise<boolean> | undefined, completionFailure: { error: unknown } | undefined;
    let admitted = false;
    const current = () => accepting && !committed && alive && pending === ticket && owner === bound
      && (!captured || captured.current()) && Object.is(scope, options.scope()) && validate();
    const publish = () => {
      committed = true;
      // A committed departure may synchronously push a route after releasing
      // this editor. Do not reject that same action as a second confirmation.
      pending = undefined;
      captured?.release();
      commit();
    };
    const admit = () => {
      if (callbackAccepted || !current()) return;
      callbackAccepted = true;
      if (!beforeCommit) { publish(); return; }
      completion = Promise.resolve().then(async () => {
        if (!current() || captured && !captured.canClose()) return false;
        return await beforeCommit() === true;
      }).catch(error => { completionFailure = { error }; return false; });
    };
    try {
      try {
        if (captured) await captured.requestLeave(admit); else admit();
      } finally { admitted = await completion === true; }
      if (completionFailure) throw completionFailure.error;
      if (beforeCommit && admitted && current() && (!captured || captured.canClose())) publish();
      return committed;
    } catch (error) { if (alive && owner === bound && Object.is(scope, options.scope())) options.onError(error); return false; }
    finally { accepting = false; if (pending === ticket) pending = undefined; }
  }
  return {
    request,
    bind(next: DesktopPageDepartureOwner) {
      owner = next; pending = undefined;
      return () => { if (owner === next) { owner = undefined; pending = undefined; } };
    },
    async requestClose() {
      if (!alive) return false;
      const captured = selected(), scope = options.scope();
      if (pending) return false;
      if (!captured) return true;
      const ticket = {}; pending = ticket;
      try {
        const approved = await captured.requestClose();
        return approved && alive && pending === ticket && owner === captured && captured.current() && Object.is(scope, options.scope()) && captured.canClose();
      } catch (error) { if (alive && owner === captured && Object.is(scope, options.scope())) options.onError(error); return false; }
      finally { if (pending === ticket) pending = undefined; }
    },
    canClose: () => alive && !pending && (selected()?.canClose() ?? true),
    dispose() { alive = false; owner = undefined; pending = undefined; },
  };
}
