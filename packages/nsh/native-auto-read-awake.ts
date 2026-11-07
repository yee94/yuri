export type NativeAutoReadAwakeState = 'idle' | 'requesting' | 'held' | 'unsupported' | 'error';

/** Lifecycle coordinator only. The existing speech owner owns the native request and its revision fence. */
export function createNativeAutoReadAwake(input: {
  awake: (enabled: boolean) => Promise<boolean>;
  failed: () => void;
  changed: (state: NativeAutoReadAwakeState) => void;
}) {
  let state: NativeAutoReadAwakeState = 'idle', desired = false, scope = '', generation = 0, disposed = false;
  const set = (next: NativeAutoReadAwakeState) => { state = next; if (!disposed) input.changed(next); };
  function failed(ticket: number) {
    if (disposed || ticket !== generation) return;
    set('error'); input.failed();
  }
  return {
    state: () => state,
    update(enabled: boolean, nextScope: string) {
      if (disposed || (enabled === desired && nextScope === scope)) return;
      const previous = desired, ticket = ++generation;
      scope = nextScope; desired = enabled;
      if (previous) void input.awake(false).catch(() => failed(ticket));
      if (!enabled) { set('idle'); return; }
      set('requesting');
      void input.awake(true).then(held => {
        if (disposed || ticket !== generation) return;
        set(held ? 'held' : 'unsupported');
        if (!held) input.failed();
      }).catch(() => failed(ticket));
    },
    async dispose() {
      if (disposed) return;
      disposed = true; generation++;
      const release = desired; desired = false; state = 'idle';
      if (release) await input.awake(false);
    },
  };
}
