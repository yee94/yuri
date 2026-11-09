import type { AssistantAvatarRecipe } from './recipe';

type AvatarColor = AssistantAvatarRecipe['color'];

const pigments = {
  mint: '#9ed8bf', orange: '#f58332', iris: '#c4b9ee', jade: '#35bb81',
  coral: '#edb0a0', blue: '#4b8fe8', sky: '#a5cbe7', violet: '#9469e4',
  sand: '#e2c99b', rose: '#e76b9f', cyan: '#32b6ad', graphite: '#555c67',
} as const satisfies Record<AvatarColor, string>;

export const assistantAvatarPigment = (color: AvatarColor): string => pigments[color];

// Vivid pigments remain exact; soft/neutral pigments get a stronger same-hue fill.
// These identity colors are independent of the selected application theme.
const messagePigments = {
  ...pigments,
  mint: '#16865c', iris: '#7853c4', coral: '#c94f36',
  sky: '#2879b5', sand: '#996a18', graphite: '#405b8c',
} satisfies Record<AvatarColor, string>;

export function assistantAvatarMessageColors(color: AvatarColor): { background: string; foreground: string } {
  const background = messagePigments[color];
  const [red, green, blue] = [1, 3, 5].map((offset) => {
    const channel = parseInt(background.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  return { background, foreground: luminance > 0.179 ? '#000000' : '#ffffff' };
}
