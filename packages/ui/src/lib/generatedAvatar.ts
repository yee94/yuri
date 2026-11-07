import { DualLimitLru } from './dualLimitLru';
import { assistantAvatarSvg } from './assistant-avatar/engine';
import type { AvatarEyeColor } from './assistant-avatar/recipe';
import type { AvatarColorSet } from './agentAvatarPalette';
import { agentAvatarDataUri } from './agentAvatarDataUri';
export { resolveAgentAvatarColors, type AvatarColorSet } from './agentAvatarPalette';

export type AvatarKind = 'assistant' | 'agent';

const artwork = new DualLimitLru<string, string>({ maxEntries: 128, maxBytes: 1024 * 1024 });

/** Local, version-pinned SVGs. Identity, style, and colors determine the face. */
export function generatedAvatarDataUri(
  kind: AvatarKind,
  seed: string | undefined,
  _animated = false,
  colors?: AvatarColorSet,
  eyeColor?: AvatarEyeColor,
): string {
  if (kind === 'agent') return agentAvatarDataUri(seed, colors);
  const seedValue = seed || 'default';
  const background = '00000000';
  const key = JSON.stringify([kind, seedValue, background, kind === 'assistant' ? eyeColor : null]);
  const cached = artwork.get(key);
  if (cached !== undefined) return cached;
  const uri = `data:image/svg+xml,${encodeURIComponent(assistantAvatarSvg(seedValue, eyeColor))}`;
  artwork.set(key, uri, (key.length + uri.length) * 2);
  return uri;
}
