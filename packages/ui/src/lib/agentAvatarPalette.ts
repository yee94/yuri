import type { Theme } from '../types/theme';

export type AvatarColorSet = {
  /** Avatar plate color. */
  background: string;
};

/** Neutral fallback when theme colors cannot be resolved (SSR, detached DOM). */
export const FALLBACK_AGENT_AVATAR_COLORS: AvatarColorSet = { background: '#c1f2c4' };

export function agentAvatarThemeTokens(colors: Theme['colors'] | undefined): Readonly<Record<string, string>> {
  return colors ? {
    '--status-success': colors.status.success,
    '--status-info': colors.status.info,
    '--status-warning': colors.status.warning,
    '--syntax-keyword': colors.syntax.base.keyword,
    '--syntax-type': colors.syntax.base.type,
    '--syntax-function': colors.syntax.base.function,
    '--syntax-number': colors.syntax.base.number,
    '--syntax-variable': colors.syntax.base.variable,
  } : {};
}

/**
 * Agent artwork palette. Each Agent already owns an accent token computed by
 * `getAgentColor(name)`, so its plate reuses that same token and stays in step
 * with its Build/Explore badge. Bottts Neutral supplies its own facial contrast.
 */
export const resolveAgentAvatarColors = (
  accentVar: string,
  read: (cssVar: string) => string,
): AvatarColorSet => {
  const accent = read(accentVar);
  return {
    background: accent || FALLBACK_AGENT_AVATAR_COLORS.background,
  };
};
