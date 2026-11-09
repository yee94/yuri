import type { ViewStyle } from 'nsh';
import { nativeDensityScale } from './native-density';

/** Geometry mirrors mobile.css's project-shell overrides, in native points. */
export const projectHomeGeometry = {
  pageInset: 18, pageGap: 20, radius: 24, headerHeight: 74, headerInset: 10,
  icon: 38, glyph: 18, headerGap: 7, action: 36,
  groupsInset: 12, groupsTop: 2, groupsBottom: 14, groupGap: 10, groupRadius: 16,
  rowHeight: 40, worktreeHeight: 42,
  title: { fontSize: 14, lineHeight: 18, letterSpacing: -.384 },
  meta: { fontSize: 12, lineHeight: 15 },
  sessionTitle: { fontSize: 12, lineHeight: 16, letterSpacing: -.192 },
  sessionMeta: { fontSize: 10, lineHeight: 12 },
} as const;

export function projectHomeDensityGeometry(padding = 100) {
  const scale = nativeDensityScale(padding), base = projectHomeGeometry;
  return {
    ...base,
    pageGap: base.pageGap * scale,
    headerHeight: Math.max(36, base.headerHeight * scale), headerInset: base.headerInset * scale,
    icon: base.icon * scale, glyph: base.glyph * scale, headerGap: base.headerGap * scale,
    action: Math.max(36, base.action * scale), groupsInset: base.groupsInset * scale,
    groupsTop: base.groupsTop * scale, groupsBottom: base.groupsBottom * scale,
    rowHeight: Math.max(36, base.rowHeight * scale), worktreeHeight: Math.max(36, base.worktreeHeight * scale),
  };
}

export const projectHomeSurface: ViewStyle = {
  glassEffect: 'regular', backgroundColor: 'transparent', borderRadius: projectHomeGeometry.radius,
};

/** NewWorktreeDialog's mobile spacing; typography still comes from canonical appearance. */
export function worktreeFormLayout(scale = 1) {
  return {
    body: { paddingHorizontal: 16 * scale, paddingTop: 8 * scale, paddingBottom: 16 * scale },
    fields: { gap: 24 * scale },
    group: { gap: 6 * scale },
    inline: { gap: 8 * scale },
    modes: { gap: 2 * scale, padding: 2 * scale, marginBottom: 16 * scale },
    mode: { minHeight: 38, paddingHorizontal: 8 * scale, gap: 6 * scale },
    control: { minHeight: 36, paddingHorizontal: 8 * scale, paddingVertical: 0, borderRadius: 6 },
    input: { minHeight: 36, paddingHorizontal: 12 * scale, paddingVertical: 4 * scale, borderRadius: 8 },
    inputHitSlop: { top: 4, bottom: 4, left: 0, right: 0 },
    reset: { minHeight: 36, paddingHorizontal: 6 * scale, paddingVertical: 2 * scale, gap: 4 * scale },
    footer: { flexShrink: 0, paddingHorizontal: 16 * scale, paddingTop: 8 * scale, paddingBottom: 12 * scale, gap: 8 * scale },
  };
}

export function projectHomeDivider(foreground: string, dark: boolean): string {
  const value = foreground.replace(/^#/, '');
  if (!/^(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return foreground;
  const expanded = value.length <= 4 ? [...value].map(char => char + char).join('') : value;
  const alpha = (expanded.length === 8 ? parseInt(expanded.slice(6), 16) / 255 : 1) * (dark ? .03 : .06);
  return `#${expanded.slice(0, 6)}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
}
