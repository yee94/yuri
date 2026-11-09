import { describe, expect, test } from 'vitest';
import { assistantAvatarMessageColors, assistantAvatarPigment } from './palette';
import { AVATAR_COLORS } from './recipe';

const rgb = (hex: string) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
const luminance = (hex: string) => rgb(hex).reduce((sum, channel, index) => (
  sum + [0.2126, 0.7152, 0.0722][index] * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
), 0);
const saturation = (hex: string) => {
  const channels = rgb(hex);
  return (Math.max(...channels) - Math.min(...channels)) / Math.max(...channels);
};
const hue = (hex: string) => {
  const [r, g, b] = rgb(hex);
  const high = Math.max(r, g, b);
  const delta = high - Math.min(r, g, b);
  return ((high === r ? (g - b) / delta : high === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360;
};

describe('assistant identity message colors', () => {
  test.each(['orange', 'jade', 'blue', 'violet', 'rose', 'cyan'] as const)('%s keeps the vivid avatar pigment unchanged', (color) => {
    expect(assistantAvatarMessageColors(color).background).toBe(assistantAvatarPigment(color));
  });

  test.each(['mint', 'iris', 'coral', 'sky', 'sand', 'graphite'] as const)('%s maps to a stronger same-family pigment visible on white', (color) => {
    const original = assistantAvatarPigment(color);
    const { background } = assistantAvatarMessageColors(color);
    expect(saturation(background)).toBeGreaterThan(saturation(original));
    const distance = Math.abs(hue(background) - hue(original));
    expect(Math.min(distance, 360 - distance)).toBeLessThan(10);
    expect(1.05 / (luminance(background) + 0.05)).toBeGreaterThanOrEqual(3);
  });

  test.each(AVATAR_COLORS)('%s has readable text at normal body size', (color) => {
    const { background, foreground } = assistantAvatarMessageColors(color);
    const values = [luminance(background), luminance(foreground)];
    expect((Math.max(...values) + 0.05) / (Math.min(...values) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});
