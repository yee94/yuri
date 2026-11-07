export type NativeHistoryFocusState = Readonly<{
  status: 'idle' | 'loading' | 'revealed' | 'error' | 'not-found' | 'hidden' | 'cancelled';
  messageID: string | null;
  error: 'history' | 'load' | 'reveal' | 'invalid-target' | null;
  loads: number;
}>;

type HistoryFocusSource = {
  current: () => boolean;
  /** Stable Host/Chat/history-reset identity, not a new object on every read. */
  scope: () => string | number;
  /** Membership in the actual displayed rows, including their grouped messages. */
  hasMessage: (messageID: string) => boolean;
  /** Exact authority membership in the staged-revert hidden range; never ID order. */
  isHidden: (messageID: string) => boolean;
  more: () => boolean;
  olderLoading: () => boolean;
  historyError: () => string;
  /** Must join an existing older flight and resolve after authority/error is applied. */
  loadOlder: () => Promise<void>;
  /** True only when the current List's scrollToIndex command was issued. */
  reveal: (messageID: string) => boolean;
  changed?: (state: NativeHistoryFocusState) => void;
};
type FocusRequest = {
  messageID: string;
  scope: string | number;
  loads: number;
  retryHistoryError: boolean;
  cancelled: Promise<void>;
  cancel: () => void;
  promise?: Promise<NativeHistoryFocusState>;
};

/** Explicit navigation only; NSH List owns geometry and all scroll writes. */
export function createNativeHistoryFocus(source: HistoryFocusSource) {
  let snapshot: NativeHistoryFocusState = { status: 'idle', messageID: null, error: null, loads: 0 };
  let active: FocusRequest | undefined, pageFlight: Promise<void> | undefined;
  const current = (request: FocusRequest) => active === request && source.current() && request.scope === source.scope();
  function publish(state: NativeHistoryFocusState) { snapshot = state; source.changed?.(state); }
  function finish(request: FocusRequest, status: NativeHistoryFocusState['status'], error: NativeHistoryFocusState['error'] = null): NativeHistoryFocusState {
    const state = { status, messageID: request.messageID, error, loads: request.loads };
    if (active === request) {
      if (status === 'cancelled') active = undefined;
      publish(state);
    }
    return state;
  }
  function page(request: FocusRequest): Promise<void> {
    if (pageFlight) return pageFlight;
    const flight = Promise.resolve().then(() => { if (current(request)) return source.loadOlder(); }).finally(() => {
      if (pageFlight === flight) pageFlight = undefined;
    });
    pageFlight = flight;
    return flight;
  }
  async function drive(request: FocusRequest): Promise<NativeHistoryFocusState> {
    if (!request.messageID) return finish(request, 'error', 'invalid-target');
    while (true) {
      if (!current(request)) return finish(request, 'cancelled');
      if (source.isHidden(request.messageID)) return finish(request, 'hidden');
      const waiting = !!pageFlight || source.olderLoading();
      if (!waiting && source.hasMessage(request.messageID)) {
        try {
          if (!current(request)) return finish(request, 'cancelled');
          const revealed = source.reveal(request.messageID);
          if (!current(request)) return finish(request, 'cancelled');
          return revealed === true ? finish(request, 'revealed') : finish(request, 'error', 'reveal');
        } catch {
          return current(request) ? finish(request, 'error', 'reveal') : finish(request, 'cancelled');
        }
      }
      if (!waiting) {
        if (source.historyError() && !request.retryHistoryError) return finish(request, 'error', 'history');
        if (!source.more()) return finish(request, 'not-found');
      }
      request.retryHistoryError = false;
      try { await Promise.race([page(request), request.cancelled]); }
      catch { return current(request) ? finish(request, 'error', 'load') : finish(request, 'cancelled'); }
      if (!current(request)) return finish(request, 'cancelled');
      if (source.historyError()) return finish(request, 'error', 'history');
      if (source.olderLoading()) return finish(request, 'error', 'load');
      request.loads++;
      publish({ status: 'loading', messageID: request.messageID, error: null, loads: request.loads });
    }
  }
  function start(messageID: string, retry = false): Promise<NativeHistoryFocusState> {
    if (!retry && active?.messageID === messageID && active.scope === source.scope() && active.promise) return active.promise;
    active?.cancel();
    let cancel!: () => void;
    const cancelled = new Promise<void>(resolve => { cancel = resolve; });
    const request: FocusRequest = { messageID, scope: source.scope(), loads: 0, retryHistoryError: retry, cancelled, cancel };
    active = request;
    request.promise = Promise.resolve().then(() => drive(request));
    publish({ status: 'loading', messageID, error: null, loads: 0 });
    return request.promise;
  }
  return {
    state: () => snapshot,
    focus: (messageID: string) => start(messageID),
    retry: () => snapshot.messageID && ['error', 'not-found', 'hidden'].includes(snapshot.status) ? start(snapshot.messageID, true) : Promise.resolve(snapshot),
    cancel() {
      active?.cancel(); active = undefined;
      if (snapshot.messageID && snapshot.status !== 'cancelled') publish({ ...snapshot, status: 'cancelled', error: null });
    },
  };
}
