export type NativeHistoryFooterContext = { scope: string | null; active: boolean; enabled: boolean; visible: boolean; readError: boolean; contentKey?: string };
export type NativeHistoryFooterAuthority = 'presentation' | 'successful-history';
export type NativeHistoryFooterSnapshot = NativeHistoryFooterContext & {
  measuredHeight: number; offsetY: number | null; minHeight: number; gesture: boolean;
  holds: number; releases: number; reason: string;
};

/** Footprint only. The inverted List remains the sole scroll/anchor writer. UIKit release is experimental. */
export function createNativeHistoryFooter(changed: (value: NativeHistoryFooterSnapshot) => void = () => {}) {
  let state: NativeHistoryFooterSnapshot = { scope: null, active: false, enabled: false, visible: true, readError: false,
    measuredHeight: 0, offsetY: null, minHeight: 0, gesture: false, holds: 0, releases: 0, reason: 'initial' };
  let layoutAdmission = false;
  const snapshot = () => ({ ...state });
  function publish(before: NativeHistoryFooterSnapshot) {
    // Scroll samples are imperative inputs, not a per-frame UI subscription.
    if (before.scope !== state.scope || before.active !== state.active || before.enabled !== state.enabled || before.visible !== state.visible ||
      before.readError !== state.readError || before.contentKey !== state.contentKey || before.measuredHeight !== state.measuredHeight || before.minHeight !== state.minHeight ||
      before.holds !== state.holds || before.releases !== state.releases || before.reason !== state.reason) changed(snapshot());
  }
  function clear(reason: string) {
    state.measuredHeight = 0; state.offsetY = null; state.minHeight = 0; state.gesture = false; state.reason = reason;
  }
  function offset(value: number) {
    state.offsetY = state.active && state.scope && Number.isFinite(value) ? value : null;
  }
  return {
    snapshot,
    invalidateMeasurement() {
      const before = snapshot(); state.measuredHeight = 0; publish(before);
    },
    invalidateScroll() { state.offsetY = null; state.gesture = false; },
    update(context: NativeHistoryFooterContext, authority: NativeHistoryFooterAuthority = 'presentation') {
      const before = snapshot(), sameScope = context.scope === state.scope;
      state = { ...state, ...context, contentKey: context.contentKey };
      if (!sameScope) {
        clear('scope-reset');
        // A mounted footer can lay out before the first active lifecycle notification.
        layoutAdmission = !!context.scope;
      } else if ((before.active && !context.active) || !context.scope) {
        clear('inactive'); layoutAdmission = false;
      }
      if (context.active && context.scope) layoutAdmission = true;
      if (context.visible && (!before.visible || context.contentKey !== before.contentKey)) state.measuredHeight = 0;
      if (!context.active || !context.scope) { publish(before); return; }
      if (!context.enabled) { state.minHeight = 0; state.reason = 'disabled'; }
      else if (context.visible) { state.minHeight = 0; state.reason = 'visible'; }
      else if (state.minHeight > 0) state.reason = context.readError ? 'read-error-held' : 'held';
      else if (sameScope && before.active && before.enabled && before.visible && !context.readError && authority !== 'successful-history') {
        state.reason = 'no-successful-history-authority';
      } else if (sameScope && before.active && before.enabled && before.visible && !context.readError) {
        if (state.measuredHeight > 0 && state.offsetY !== null && state.offsetY < state.measuredHeight) {
          state.minHeight = state.measuredHeight; state.holds += 1; state.reason = 'held';
        } else state.reason = state.measuredHeight <= 0 ? 'unmeasured-height' : state.offsetY === null ? 'unmeasured-offset' : 'outside-clamp';
      } else state.reason = context.readError ? 'read-error-no-terminal-authority' : 'hidden-no-transition';
      publish(before);
    },
    onLayout(scope: string, height: number, contentKey?: string) {
      if (!layoutAdmission || scope !== state.scope || !state.visible || contentKey !== state.contentKey) return false;
      const before = snapshot();
      state.measuredHeight = Number.isFinite(height) && height > 0 ? height : 0;
      publish(before);
      return true;
    },
    onScroll: offset,
    onScrollDragStart(offsetY: number) { offset(offsetY); state.gesture = state.active && !!state.scope; },
    onScrollEnd(offsetY: number) {
      const before = snapshot(), userGesture = state.gesture;
      offset(offsetY); state.gesture = false;
      if (userGesture && state.minHeight > 0 && state.offsetY !== null && state.offsetY >= state.minHeight) {
        state.minHeight = 0; state.measuredHeight = 0; state.releases += 1; state.reason = 'released-at-user-rest';
      }
      publish(before);
    },
    onLatest() {
      const before = snapshot(), visibleHeight = state.visible ? state.measuredHeight : 0;
      if (state.gesture && state.minHeight > 0) { state.reason = 'latest-await-user-rest'; publish(before); return; }
      clear('latest'); state.measuredHeight = visibleHeight; publish(before);
    },
    reset() { const before = snapshot(); clear('reset'); layoutAdmission = false; state.active = false; state.scope = null; publish(before); },
  };
}
