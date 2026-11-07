import type { ContextUsagePalette } from './context-usage-palette';

export type UsagePalette = { safe?: string; warning?: string; critical?: string };
/** Only the root's current Host palette is authoritative, including custom themes. */
export function usageSemanticPalette(appearance: { contextUsageTokens: { light: ContextUsagePalette; dark: ContextUsagePalette }; cssVars: { light: Record<string, string>; dark: Record<string, string> } } | null, variant: 'light' | 'dark'): UsagePalette {
  return { safe: appearance?.cssVars[variant].success, warning: appearance?.contextUsageTokens[variant].warning, critical: appearance?.cssVars[variant].destructive };
}
