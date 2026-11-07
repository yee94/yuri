import { getAgentColor } from '../ui/src/lib/agentColors';
import { resolveAgentAvatarColors } from '../ui/src/lib/agentAvatarPalette';
import { nativeAgentAvatarTemplates, nativeAgentPlateMarker } from './agent-avatar-templates';
import { agentAvatarDataUri } from './agent-avatar-runtime.generated.js';

export function nativeAgentPalette(name: string | undefined, tokens: Readonly<Record<string, string>>) {
  return resolveAgentAvatarColors(getAgentColor(name).var, key => tokens[key] ?? '');
}

// Four known seeds keep their prebuilt fast path; arbitrary identities use the shared bounded SVG cache.
const artwork = new Map<string, { color: string; uri: string }>();
export function nativeAgentAvatarDataUri(name: string | undefined, tokens: Readonly<Record<string, string>>): string | undefined {
  const seed = name?.trim().toLowerCase() || '';
  const palette = nativeAgentPalette(seed, tokens), background = palette.background;
  if (background.trim() !== background || !/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(background)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(nativeAgentAvatarTemplates, seed)) return agentAvatarDataUri(seed, palette);
  const digits = background.slice(1).toLowerCase();
  const color = '#' + (digits.length < 5 ? [...digits].map(char => char + char).join('') : digits);
  const previous = artwork.get(seed);
  if (previous?.color === color) return previous.uri;
  const template = nativeAgentAvatarTemplates[seed as keyof typeof nativeAgentAvatarTemplates];
  const uri = `data:image/svg+xml,${encodeURIComponent(template.replace(nativeAgentPlateMarker, color))}`;
  artwork.set(seed, { color, uri });
  return uri;
}
