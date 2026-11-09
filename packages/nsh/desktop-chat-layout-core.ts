/** Web typography.css uses the window breakpoint, not the resized chat pane. */
export function desktopChatGeometry(viewportWidth: number, wide = false, paddingScale = 1) {
  const viewport = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1068;
  const scale = Number.isFinite(paddingScale) && paddingScale > 0 ? paddingScale : 1;
  return {
    columnMax: viewport >= 1600 ? (wide ? 1152 : 960) : (wide ? 1024 : 800),
    columnInset: Math.min(viewport >= 1024 ? 24 : 16, Math.max(viewport >= 1024 ? 16 : 12, viewport * .025)) * scale,
    composerBottom: 16,
    composerRadius: 24,
    editorMinHeight: 52,
    editorMaxHeight: 160,
    editorInset: { horizontal: 12, top: 16, bottom: 8 },
    footerInset: { horizontal: 10, vertical: 6 },
    footerGap: 6,
    controlSize: 24,
  } as const;
}

/** Feed NativeTranscriptBody.contentWidth from its original List's positive
 * onLayout width. Unknown native geometry is not an authoritative zero. */
export function desktopChatContentWidth(paneWidth: number, viewportWidth: number, wide = false, paddingScale = 1, reserveRight = 0): number | undefined {
  if (!Number.isFinite(paneWidth) || paneWidth <= 0) return undefined;
  const geometry = desktopChatGeometry(viewportWidth, wide, paddingScale);
  const reserve = desktopChatReserveRight(reserveRight, paneWidth, geometry.columnInset * 2 + 1);
  return Math.max(1, Math.min(paneWidth - reserve, geometry.columnMax) - geometry.columnInset * 2);
}

/** Only outer rows/composers reserve space. Invalid or oversized reservations
 * become zero rather than consuming the last positive inner content width. */
export function desktopChatReserveRight(reserveRight = 0, paneWidth?: number, minimumColumnWidth = 1): number {
  if (!Number.isFinite(reserveRight) || reserveRight <= 0) return 0;
  if (paneWidth === undefined || !Number.isFinite(paneWidth) || paneWidth <= 0) return 0;
  return reserveRight <= Math.max(0, paneWidth - minimumColumnWidth) ? reserveRight : 0;
}

export type DesktopChatRowSpacing = {
  role: 'user' | 'assistant' | 'notice';
  header?: boolean;
  /** Match Web's isFollowedByAssistant / turnOwnsAssistantHeader projections. */
  continued?: boolean;
  working?: boolean;
};

export function desktopChatRowSpacing(row: DesktopChatRowSpacing) {
  if (row.role === 'notice') return { paddingTop: 6, paddingBottom: 6 };
  return {
    paddingTop: row.role === 'user' || row.header ? 24 : 0,
    paddingBottom: row.role === 'user' || row.continued ? 0 : row.working ? 4 : 32,
  };
}
