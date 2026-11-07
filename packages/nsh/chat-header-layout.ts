/** MobileDetailNavigation: 2.5rem disc, 2.75rem leading column, 3.5rem content,
 * .25rem top/column gap/title inset, 1rem edges. Native keeps the measured 41pt disc.
 */
export const chatHeaderLayout = {
  button: 41,
  edge: 16,
  leadingColumn: 41 * 2.75 / 2.5,
  contentHeight: 41 * 3.5 / 2.5,
  top: 41 * .25 / 2.5,
  columnGap: 41 * .25 / 2.5,
  titleInset: 41 * .25 / 2.5,
  actionGap: 8,
};

/** Testable sizing contract; no fixed title cap, overlap, font shrinking or visual translation. */
export function chatHeaderGeometry(width: number, actions = 2, leftInset = 0, rightInset = 0) {
  const layout = chatHeaderLayout;
  const left = Math.max(layout.edge, leftInset), right = Math.max(layout.edge, rightInset);
  const trailingWidth = actions * layout.button + Math.max(0, actions - 1) * layout.actionGap;
  const titleLeft = left + layout.leadingColumn + layout.columnGap + layout.titleInset;
  const trailingLeft = width - right - trailingWidth;
  const titleRight = trailingLeft - layout.columnGap - layout.titleInset;
  return { left, right, trailingLeft, trailingWidth, titleLeft, titleRight, titleWidth: Math.max(0, titleRight - titleLeft), buttonTop: layout.top + (layout.contentHeight - layout.button) / 2, height: layout.top + layout.contentHeight };
}

/** Popover chrome is included in the 72%-of-content cap, never added above it. */
export function chatMetadataGeometry(width: number, height: number, topInset: number, bottomInset: number) {
  const margin = chatHeaderLayout.button * .75 / 2.5;
  const offset = margin;
  const contentHeight = Math.max(0, height - topInset - bottomInset);
  const top = chatHeaderGeometry(width).buttonTop + chatHeaderLayout.button + offset;
  const maxHeight = Math.max(0, Math.min(contentHeight * .72, contentHeight - top - margin));
  return { margin, offset, width: Math.max(0, width - margin * 2), top, contentHeight, maxHeight, scrollMaxHeight: Math.max(0, maxHeight - 16) };
}
