import { createNativeHistoryFooter, type NativeHistoryFooterSnapshot } from './history-footer';
import { createNaturalFooterReader, type NativeHistoryNaturalRef } from './history-footer-natural';
import type { NativeHistoryPresentation } from './history-presentation';

type OffsetEvent = { offset: { y: number } };
type LayoutEvent = { bounds: { size: { height: number } } };
export type NativeHistoryFooterControllerSnapshot = NativeHistoryFooterSnapshot & {
  naturalGeneration: number; eventGeneration: number; measuring: boolean; measurementError: string;
};
export type NativeHistoryFooterConfirmation = 'confirmed' | 'stale' | 'unavailable' | 'failed';

/** Presentation/measurement only. All scroll geometry writes remain inside inverted List. */
export function createNativeHistoryFooterController(options: {
  current: () => boolean;
  changed?: (value: NativeHistoryFooterControllerSnapshot) => void;
}) {
  let facts: NativeHistoryPresentation | undefined, enabled = false, contentKey = '', disposed = false;
  let naturalGeneration = 0, eventGeneration = 0, eventCapture = 0, confirmation = 0;
  let measuring = false, measurementError = '', publishing = 0;
  let wasActive = false;
  const footer = createNativeHistoryFooter(() => publish());
  const reader = createNaturalFooterReader((scope, height, key) => footer.onLayout(scope, height, key));
  const snapshot = (): NativeHistoryFooterControllerSnapshot => ({ ...footer.snapshot(), naturalGeneration, eventGeneration, measuring, measurementError });
  function publish() { if (!publishing) options.changed?.(snapshot()); }
  function transaction(work: () => void) { publishing++; try { work(); } finally { publishing--; publish(); } }
  function context() {
    if (!facts) return null;
    const s = facts.scope;
    return { scope: JSON.stringify([s.hostID, s.generation, s.owner, s.historyGeneration, s.targetKind, s.targetID, s.directory]),
      active: !disposed && options.current(), enabled,
      visible: facts.more || !!facts.historyError || facts.boundaryMissing || facts.repairPending || facts.hasGap,
      readError: !!facts.readError,
      contentKey: JSON.stringify([facts.more, facts.historyError, facts.boundaryMissing, facts.repairPending, facts.hasGap, contentKey]) };
  }
  function invalidateNatural() {
    naturalGeneration++; confirmation++; measuring = false; measurementError = '';
    reader.invalidate(); footer.invalidateMeasurement();
  }
  function apply(authority: NativeHistoryPresentation['authority'] = 'presentation') {
    const next = context(); if (!next) return;
    const previous = footer.snapshot();
    const scopeChanged = next.scope !== previous.scope, deactivated = previous.active && !next.active;
    const reset = authority === 'reset';
    const reactivated = !scopeChanged && !previous.active && next.active && wasActive;
    if (scopeChanged || reset) wasActive = false;
    if (scopeChanged || deactivated || reactivated || reset) {
      invalidateNatural(); eventGeneration++; eventCapture++; footer.invalidateScroll();
      if (reset) footer.reset();
    } else if (next.visible !== previous.visible || next.contentKey !== previous.contentKey) {
      // Keep the pre-hide height until successful authority has decided the footprint.
      naturalGeneration++; confirmation++; measuring = false; measurementError = '';
    }
    footer.update(next, authority === 'successful-history' ? authority : 'presentation');
    reader.update(next);
    wasActive ||= next.active;
  }
  function live() {
    if (disposed || !options.current()) {
      if (!disposed && footer.snapshot().active) transaction(() => apply());
      return false;
    }
    return footer.snapshot().active;
  }
  return {
    snapshot,
    beforeHistoryPresentationFlush(next: NativeHistoryPresentation) {
      if (disposed) return;
      transaction(() => { facts = next; apply(next.authority); });
    },
    syncActivity() { if (!disposed) transaction(() => apply()); },
    setEnabled(value: boolean) {
      if (disposed || !value && footer.snapshot().minHeight > 0) return false;
      if (enabled === value) return true;
      transaction(() => { enabled = value; apply(); });
      return true;
    },
    setContentKey(value: string) {
      if (disposed || contentKey === value) return;
      transaction(() => { contentKey = value; apply(); });
    },
    captureNatural() {
      const scope = footer.snapshot().scope, key = footer.snapshot().contentKey ?? '', generation = naturalGeneration;
      const source = reader.captureSource(scope ?? '', key);
      let retired = false;
      transaction(() => { confirmation++; measuring = false; measurementError = ''; footer.invalidateMeasurement(); });
      const matches = () => !disposed && !retired && generation === naturalGeneration && footer.snapshot().scope === scope;
      function retire() {
        if (retired) return;
        const owned = matches() && source.current(); source.retire(); retired = true;
        if (owned) transaction(() => { confirmation++; measuring = false; footer.invalidateMeasurement(); });
      }
      async function confirm(): Promise<NativeHistoryFooterConfirmation> {
        if (!matches() || !live() || !source.current() || !footer.snapshot().visible) return 'unavailable';
        const id = ++confirmation;
        transaction(() => { measuring = true; measurementError = ''; });
        try {
          const admitted = await reader.measure();
          if (!matches() || id !== confirmation || !live() || !source.current()) return 'stale';
          if (admitted || footer.snapshot().measuredHeight > 0) return 'confirmed';
          measurementError = 'unmeasured-natural-height';
          return 'unavailable';
        } catch {
          if (!matches() || id !== confirmation || !live() || !source.current()) return 'stale';
          measurementError = 'natural-measurement-failed';
          return 'failed';
        } finally {
          if (matches() && id === confirmation) transaction(() => { measuring = false; });
        }
      }
      return {
        ref(node: NativeHistoryNaturalRef | null) {
          if (!matches()) return false;
          if (!node) { retire(); return true; }
          const owned = source.current(), admitted = source.ref(node);
          if (owned && !admitted) transaction(() => { confirmation++; measuring = false; footer.invalidateMeasurement(); });
          return admitted;
        },
        onLayout(event: LayoutEvent) {
          if (!matches() || !source.current()) return false;
          if (footer.snapshot().active && !options.current()) { live(); return false; }
          let admitted = false;
          transaction(() => {
            admitted = source.onLayout(event);
            if (admitted && footer.snapshot().measuredHeight > 0) measurementError = '';
          });
          return admitted;
        },
        confirm, retire,
      };
    },
    captureEvents() {
      const generation = eventGeneration, capture = ++eventCapture;
      footer.invalidateScroll();
      let retired = false;
      const admit = () => !retired && capture === eventCapture && generation === eventGeneration && live();
      return {
        onScrollDragStart(event: OffsetEvent) { if (admit()) footer.onScrollDragStart(event.offset.y); },
        onScroll(event: OffsetEvent) { if (admit()) footer.onScroll(event.offset.y); },
        onScrollEnd(event: OffsetEvent) { if (admit()) footer.onScrollEnd(event.offset.y); },
        // Call only from the existing historyScroll loadLatest admission, not another native listener.
        onLatest() { if (admit()) footer.onLatest(); },
        retire() { if (!retired && capture === eventCapture) footer.invalidateScroll(); retired = true; },
      };
    },
    reset() {
      if (disposed) return;
      transaction(() => { facts = undefined; wasActive = false; invalidateNatural(); eventGeneration++; eventCapture++; footer.reset(); });
    },
    dispose() {
      if (disposed) return;
      transaction(() => { disposed = true; facts = undefined; invalidateNatural(); eventGeneration++; eventCapture++; footer.reset(); });
    },
  };
}
