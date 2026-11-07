import { useMemo } from 'react';

import { getAgentColor } from '@/lib/agentColors';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { agentAvatarThemeTokens, resolveAgentAvatarColors, type AvatarColorSet } from '@/lib/agentAvatarPalette';

/**
 * Each Agent owns a computed accent token (see `getAgentColor`). This resolves
 * that token to a background color for its generated artwork, so
 * an Agent's avatar plate always matches its own badge color.
 */
export const useAgentAvatarPalette = (agentName: string | undefined): AvatarColorSet => {
  const accentVar = getAgentColor(agentName).var;
  const colors = useOptionalThemeSystem()?.currentTheme.colors;
  return useMemo(() => {
    const tokens = agentAvatarThemeTokens(colors);
    return resolveAgentAvatarColors(accentVar, (token) => tokens[token] ?? '');
  }, [accentVar, colors]);
};
