import type { StyleProp, ViewStyle } from 'nsh';

const isStyleList = (style: StyleProp<ViewStyle>): style is readonly StyleProp<ViewStyle>[] => Array.isArray(style);

/** UIKit owns sheet geometry and keyboard avoidance; content retains its own decoration. */
export function systemSheetContentStyle(style: StyleProp<ViewStyle>): StyleProp<ViewStyle> {
  if (!style) return style;
  if (isStyleList(style)) return style.map(systemSheetContentStyle);
  const { height, minHeight, maxHeight, marginBottom, borderRadius, borderTopLeftRadius, borderTopRightRadius, ...content } = style;
  return content;
}

export type SheetPresentation = Readonly<{ generation: number; phase: 'opening' | 'open' | 'closing' }>;

/** The presented UIKit controller owns completion; intent never recycles a closing root. */
export function createSheetPresentation(publish: (value: SheetPresentation | null) => void) {
  let value: SheetPresentation | null = null, requested = false, generation = 0, disposed = false;
  function update(next: SheetPresentation | null) { value = next; publish(next); }
  function start() { if (requested && !disposed && !value) update({ generation: ++generation, phase: 'opening' }); }
  return {
    request(open: boolean) {
      if (disposed) return;
      requested = open;
      if (!value) start();
      else if (!open && value.phase !== 'closing') update({ ...value, phase: 'closing' });
    },
    opened(id: number) {
      if (value?.generation !== id || value.phase !== 'opening') return false;
      update({ ...value, phase: 'open' }); return true;
    },
    dismissed(id: number, interactive = false) {
      if (value?.generation !== id) return false;
      if (interactive) requested = false;
      update(null); start(); return true;
    },
    dispose() { disposed = true; requested = false; },
  };
}
