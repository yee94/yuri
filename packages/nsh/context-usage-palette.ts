import type { Theme } from '../ui/src/types/theme';

/** Missing root authority is intentionally unpainted, never a guessed default theme. */
export type ContextUsagePalette = { primary?: string; warning?: string; success?: string; muted?: string; subtle?: string };

export function contextUsageThemeTokens(theme: Theme): ContextUsagePalette {
  const { primary, status, surface } = theme.colors;
  const tokens = { primary: primary.base, warning: status.warning, success: status.success, muted: surface.mutedForeground, subtle: surface.subtle };
  if (Object.values(tokens).some(value => !/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value))) throw new Error('Invalid context overview theme colors');
  return tokens;
}
