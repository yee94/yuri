import { Avatar, Style } from '@dicebear/core';
import botttsNeutral from '@dicebear/styles/bottts-neutral.json';
import { DualLimitLru } from './dualLimitLru';
import { FALLBACK_AGENT_AVATAR_COLORS, type AvatarColorSet } from './agentAvatarPalette';

let style: Style | undefined;
const artwork = new DualLimitLru<string, string>({ maxEntries: 128, maxBytes: 1024 * 1024 });

/** Pure SVG generation shared with native; no Assistant renderer or browser runtime. */
export function agentAvatarDataUri(seed: string | undefined, colors?: AvatarColorSet): string {
  const normalized = seed?.trim().toLowerCase() || 'default';
  const background = (colors ?? FALLBACK_AGENT_AVATAR_COLORS).background.replace('#', '');
  const key = JSON.stringify([normalized, background]);
  const cached = artwork.get(key);
  if (cached !== undefined) return cached;
  const uri = new Avatar(style ??= new Style(botttsNeutral), { seed: normalized, size: 128, idRandomization: false, borderRadius: 0, backgroundColor: [background] }).toDataUri();
  artwork.set(key, uri, (key.length + uri.length) * 2);
  return uri;
}
