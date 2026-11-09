export type DesktopWriterDepartureGuard = {
  current(): boolean;
  prepare(): Promise<boolean>;
  canClose(): boolean;
  cancel(): void;
  release(): Promise<boolean>;
};

export type DesktopWriterDepartureStatus = Readonly<{
  phase: 'captured' | 'preparing' | 'prepared' | 'releasing' | 'released' | 'blocked' | 'cancelled' | 'finished';
  failure: 'prepare' | 'stale' | 'release' | null;
  owners: number;
  released: number;
  failClosed: boolean;
}>;

const safe = (check: () => boolean) => { try { return check() === true; } catch { return false; } };

/** Mounted business handles only. Native claims and writer permissions stay in their original owners. */
export function createDesktopWriterDeparture<Tag>(options: { scope(): unknown }) {
  type Registration = { tag: Tag; guard: DesktopWriterDepartureGuard };
  const registrations = new Set<Registration>();
  let alive = true, revision = 0;
  let active: { cancel(): boolean } | undefined;

  function capture(selection: { select?(tag: Tag): boolean; release?(tag: Tag): boolean; current?(): boolean } = {}) {
    if (!alive || active) return null;
    const scope = options.scope(), capturedRevision = revision;
    const { select, release: releaseSelected, current: intentCurrent } = selection;
    const owners = [...registrations].filter(row => !select || select(row.tag));
    const removing = owners.filter(row => !releaseSelected || releaseSelected(row.tag));
    let phase: DesktopWriterDepartureStatus['phase'] = 'captured';
    let failure: DesktopWriterDepartureStatus['failure'] = null;
    let preparation: Promise<boolean> | undefined, releasing: Promise<boolean> | undefined;
    let releaseStarted = false, released = 0, cancelled = false, preparing = false;
    const attempted: Registration[] = [];
    const dispatched = new Set<Registration>(), restored = new Set<Registration>();
    const current = () => safe(() => alive && !cancelled && active === ticket && revision === capturedRevision
      && Object.is(scope, options.scope()) && (!intentCurrent || intentCurrent()));
    const ownersCurrent = () => owners.every(row => safe(() => row.guard.current()));
    const canClose = () => phase === 'prepared' && current() && ownersCurrent() && owners.every(row => safe(() => row.guard.canClose()));
    function restoreUndispatched() {
      // Cancel attempted preparations too: a failed/in-flight prepare may already have paused its owner.
      for (const row of attempted) {
        if (dispatched.has(row) || restored.has(row)) continue;
        restored.add(row);
        try { row.guard.cancel(); } catch { /* Other owners must still be restored. */ }
      }
    }
    function blocked(reason: NonNullable<DesktopWriterDepartureStatus['failure']>) {
      failure = reason; phase = 'blocked';
      if (!releaseStarted) cancelled = true;
      restoreUndispatched();
      if (!releaseStarted && active === ticket) active = undefined;
      return false;
    }
    function cancel() {
      if (active !== ticket || phase === 'cancelled' || phase === 'finished') return false;
      if (releaseStarted || phase === 'releasing') {
        cancelled = true; phase = 'blocked'; failure ??= 'stale'; restoreUndispatched();
        return false;
      }
      phase = 'cancelled'; cancelled = true; restoreUndispatched();
      // Do not let a new ticket reuse a still-settling prepare on the same business handle.
      if (!preparing) active = undefined;
      return true;
    }
    function prepare(): Promise<boolean> {
      if (preparation) return preparation;
      if (phase !== 'captured') return Promise.resolve(false);
      if (!current() || !ownersCurrent()) return Promise.resolve(blocked('stale'));
      phase = 'preparing'; preparing = true;
      preparation = Promise.resolve().then(async () => {
        const answers = await Promise.all(owners.map(async row => {
          if (!current() || cancelled || !safe(() => row.guard.current())) return false;
          attempted.push(row);
          try { return await row.guard.prepare() === true; } catch { return false; }
        }));
        if (cancelled) return false;
        if (!current() || !ownersCurrent()) return blocked('stale');
        if (answers.some(answer => !answer)) return blocked('prepare');
        phase = 'prepared';
        return canClose() || blocked('prepare');
      }).finally(() => { preparing = false; if (cancelled && active === ticket) active = undefined; });
      return preparation;
    }
    function release(): Promise<boolean> {
      if (releasing) return releasing;
      if (phase !== 'prepared') return Promise.resolve(false);
      if (!canClose()) return Promise.resolve(blocked('stale'));
      phase = 'releasing';
      releasing = Promise.resolve().then(async () => {
        for (const row of removing) {
          if (!current() || !owners.every(entry => dispatched.has(entry) || safe(() => entry.guard.current()) && safe(() => entry.guard.canClose()))) return blocked('stale');
          dispatched.add(row); releaseStarted = true;
          let accepted = false;
          try { accepted = await row.guard.release() === true; } catch { /* Unconfirmed custody stays fail closed. */ }
          if (accepted) released++;
          if (!accepted) return blocked('release');
          if (!current()) return blocked('stale');
        }
        if (!current() || !owners.every(entry => dispatched.has(entry) || safe(() => entry.guard.current()) && safe(() => entry.guard.canClose()))) return blocked('stale');
        phase = 'released'; return true;
      });
      return releasing;
    }
    const ticket = {
      prepare, canClose, release, cancel, current,
      canCommit: () => phase === 'released' && current(),
      status: (): DesktopWriterDepartureStatus => Object.freeze({ phase, failure, owners: owners.length, released,
        failClosed: releaseStarted && phase !== 'finished' && (phase !== 'released' || !current()) }),
      // Only after route commit or a confirmed final native close. Cleanup owns retirement, not this ticket.
      finish(completion: { closed?: boolean } = {}) {
        if (active !== ticket || (completion.closed ? phase !== 'prepared' : phase !== 'released')) return false;
        if (!completion.closed) restoreUndispatched();
        phase = 'finished'; active = undefined; return true;
      },
    };
    active = ticket;
    return ticket;
  }

  return {
    capture,
    register(tag: Tag, guard: DesktopWriterDepartureGuard) {
      if (!alive) return () => {};
      const row = { tag, guard }; registrations.add(row); revision++;
      return () => { if (registrations.delete(row)) revision++; };
    },
    dispose() {
      if (!alive) return;
      active?.cancel(); alive = false; revision++; registrations.clear();
    },
  };
}
