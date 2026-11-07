export type NewSessionModalPhase = 'native-opening' | 'native-opening-cancelled' | 'sheet-opening' | 'sheet-opening-cancelled' | 'open' | 'sheet-closing' | 'native-dismissing';
export type NewSessionModalPresentation<T extends string> = Readonly<{ generation: number; value: T; phase: NewSessionModalPhase }>;

/** One presentation authority. Requests are intent; native callbacks own release. */
export function createNewSessionModalOwner<T extends string>(publish: (presentation: NewSessionModalPresentation<T> | null) => void = () => {}) {
  let presentation: NewSessionModalPresentation<T> | null = null;
  let requested: T | null = null, generation = 0, disposed = false;
  function update(next: NewSessionModalPresentation<T> | null) { presentation = next; publish(next); }
  function start() { if (!disposed && requested !== null) update({ generation: ++generation, value: requested, phase: 'native-opening' }); }
  function matches(id: number) { return presentation?.generation === id; }
  function request(value: T | null) {
    if (disposed) return;
    requested = value;
    if (!presentation) { start(); return; }
    if (presentation.value === value) return;
    if (presentation.phase === 'native-opening') update({ ...presentation, phase: 'native-opening-cancelled' });
    if (presentation.phase === 'sheet-opening') update({ ...presentation, phase: 'sheet-opening-cancelled' });
    if (presentation.phase === 'open') update({ ...presentation, phase: 'sheet-closing' });
  }
  function interactive(id: number) {
    return !disposed && matches(id) && presentation!.value === requested && (presentation!.phase === 'sheet-opening' || presentation!.phase === 'open');
  }
  return {
    current: () => presentation,
    request,
    interactive,
    close(id: number) {
      if (disposed || !matches(id) || presentation!.value !== requested || !['native-opening', 'sheet-opening', 'open'].includes(presentation!.phase)) return false;
      request(null); return true;
    },
    dialogOpened(id: number) {
      if (!matches(id) || !['native-opening', 'native-opening-cancelled'].includes(presentation!.phase) || disposed) return;
      update({ ...presentation!, phase: presentation!.phase === 'native-opening' ? 'sheet-opening' : 'native-dismissing' });
    },
    sheetOpened(id: number) {
      if (!matches(id) || disposed) return;
      if (presentation!.phase === 'sheet-opening') update({ ...presentation!, phase: 'open' });
      else if (presentation!.phase === 'sheet-opening-cancelled') update({ ...presentation!, phase: 'sheet-closing' });
    },
    sheetClosed(id: number) {
      if (matches(id) && presentation!.phase === 'sheet-closing') update({ ...presentation!, phase: 'native-dismissing' });
    },
    dialogClosed(id: number): 'stale' | 'dismissed' | 'interrupted' {
      if (!matches(id)) return 'stale';
      const expected = disposed || ['native-opening-cancelled', 'sheet-opening-cancelled', 'sheet-closing', 'native-dismissing'].includes(presentation!.phase);
      if (!expected) requested = null;
      update(null);
      start();
      return expected ? 'dismissed' : 'interrupted';
    },
    dispose() {
      if (disposed) return;
      disposed = true; requested = null;
      if (presentation) update({ ...presentation, phase: 'native-dismissing' });
    },
  };
}
