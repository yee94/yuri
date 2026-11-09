import type { Bounds, ScrollEvent } from 'nsh';

/** SettingsTarget must be a direct Scroll-content child: bounds are in its
 * parent, not window coordinates. No measurement or scroll writer is needed. */
export function createPreferencePreviewVisibility(changed: (visible: boolean) => void) {
  let field: { top: number; height: number } | null = null;
  let viewportHeight: number | null = null, offset = 0, visible = false;
  const validSize = (height: number) => Number.isFinite(height) && height > 0;
  function publish() {
    const next = !!field && viewportHeight !== null && Number.isFinite(offset)
      && field.top < offset + viewportHeight && field.top + field.height > offset;
    if (next === visible) return;
    visible = next; changed(next);
  }
  return {
    onFieldLayout(event: { bounds: Bounds }) {
      const { origin, size } = event.bounds;
      field = Number.isFinite(origin.y) && validSize(size.height) ? { top: origin.y, height: size.height } : null;
      publish();
    },
    onViewportLayout(event: { bounds: Bounds }) {
      const height = event.bounds.size.height;
      viewportHeight = validSize(height) ? height : null; publish();
    },
    onScroll(event: Pick<ScrollEvent, 'offset' | 'size'>) {
      offset = event.offset.y;
      viewportHeight = validSize(event.size.height) ? event.size.height : null; publish();
    },
  };
}
