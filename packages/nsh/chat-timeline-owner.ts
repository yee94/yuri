export type TimelineAuthority = { current: () => boolean };
export type TimelineAction = 'revert' | 'fork';
export type NativeTimelineState = Readonly<{
  generation: number; phase: 'closed' | 'opening' | 'open' | 'closing';
  pending: 'older' | 'goto' | 'latest' | TimelineAction | null;
  messageID: string | null; error: unknown;
}>;

/** Presentation and action lifetime only. Chat retains all data and write authority. */
export function createNativeTimelineOwner(changed: (state: NativeTimelineState) => void) {
  let state: NativeTimelineState = { generation: 0, phase: 'closed', pending: null, messageID: null, error: null };
  let authority: TimelineAuthority | null = null, queued = false, alive = true;
  let continuation: (() => void) | undefined;
  const publish = (patch: Partial<NativeTimelineState>) => { state = { ...state, ...patch }; changed(state); };
  const current = () => alive && authority?.current() === true;
  const interactive = () => current() && state.phase === 'open';
  function open() {
    if (!current()) return;
    if (state.phase === 'closing') { queued = true; return; }
    if (state.phase !== 'closed') return;
    publish({ generation: state.generation + 1, phase: 'opening', pending: null, messageID: null, error: null });
  }
  function close(force = false) {
    if (state.phase === 'closed' || state.phase === 'closing' || (!force && state.pending)) return false;
    publish({ phase: 'closing' }); return true;
  }
  return {
    snapshot: () => state, interactive,
    replaceAuthority(next: TimelineAuthority | null) {
      if (authority === next) return;
      authority = next; queued = false; continuation = undefined;
      // Revocation is immediate. Keep the old root until UIKit acknowledges dismissal.
      close(true);
    },
    request(value: boolean) { if (value) open(); else { queued = false; close(); } },
    opened(generation: number) { if (generation === state.generation && state.phase === 'opening' && current()) publish({ phase: 'open' }); },
    close,
    closed(generation: number) {
      if (generation !== state.generation || state.phase !== 'closing') return;
      const next = continuation; continuation = undefined;
      publish({ phase: 'closed', pending: null, messageID: null });
      if (current()) next?.();
      if (queued) { queued = false; open(); }
    },
    async run(kind: NonNullable<NativeTimelineState['pending']>, messageID: string | null,
      execute: (valid: () => boolean) => Promise<false | void | (() => void)>, dismiss: () => void) {
      if (!interactive() || state.pending) return false;
      const captured = authority, generation = state.generation;
      const valid = () => current() && authority === captured && state.generation === generation && state.phase === 'open';
      publish({ pending: kind, messageID, error: null });
      try {
        const result = await execute(valid);
        if (!valid()) return false;
        if (result === false) return false;
        if (kind !== 'older') {
          continuation = typeof result === 'function' ? result : undefined;
          publish({ pending: null }); close(); dismiss();
        }
        return true;
      } catch (error) { if (valid()) publish({ error }); return false; }
      finally { if (valid()) publish({ pending: null, messageID: null }); }
    },
    dispose() { alive = false; queued = false; continuation = undefined; authority = null; },
  };
}
