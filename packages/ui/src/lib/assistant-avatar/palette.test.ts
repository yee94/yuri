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
  test.each(['jade', 'cyan'] as const)('%s keeps the luminous avatar pigment and dark text unchanged', (color) => {
    expect(assistantAvatarMessageColors(color).background).toBe(assistantAvatarPigment(color));
    expect(assistantAvatarMessageColors(color).foreground).toBe('#000000');
  });

  test('orange keeps its hue and avatar pigment while pairing a stronger bubble fill with white text', () => {
    const original = assistantAvatarPigment('orange');
    const { background, foreground } = assistantAvatarMessageColors('orange');
    expect(original).toBe('#f58332');
    expect(foreground).toBe('#ffffff');
    expect(Math.abs(hue(background) - hue(original))).toBeLessThan(2);
    expect(saturation(background)).toBeGreaterThanOrEqual(saturation(original));
  });

  test.each(['mint', 'iris', 'coral', 'sky', 'sand', 'graphite'] as const)('%s maps to a stronger same-family pigment visible on white', (color) => {
    const original = assistantAvatarPigment(color);
    const { background } = assistantAvatarMessageColors(color);
    expect(saturation(background)).toBeGreaterThan(saturation(original));
    const distance = Math.abs(hue(background) - hue(original));
    expect(Math.min(distance, 360 - distance)).toBeLessThan(10);
    expect(1.05 / (luminance(background) + 0.05)).toBeGreaterThanOrEqual(3);
  });

  test.each([
    { color: 'blue', pigment: '#4b8fe8' },
    { color: 'violet', pigment: '#9469e4' },
    { color: 'rose', pigment: '#e76b9f' },
  ] as const)('$color deepens the bubble for white text without changing the avatar pigment or hue family', ({ color, pigment }) => {
    const original = assistantAvatarPigment(color);
    const { background, foreground } = assistantAvatarMessageColors(color);
    expect(original).toBe(pigment);
    expect(foreground).toBe('#ffffff');
    expect(Math.abs(hue(background) - hue(original))).toBeLessThan(2);
    expect(luminance(background)).toBeLessThan(luminance(original));
    for (const [index, channel] of rgb(original).entries()) {
      expect(channel - rgb(background)[index]).toBeGreaterThanOrEqual(0);
      expect(channel - rgb(background)[index]).toBeLessThan(0.16);
    }
  });

  test.each(['mint', 'iris', 'coral', 'sky', 'sand', 'graphite'] as const)('%s uses white text on its dark mapped fill', (color) => {
    expect(assistantAvatarMessageColors(color).foreground).toBe('#ffffff');
  });

  test.each(AVATAR_COLORS)('%s has readable text at normal body size', (color) => {
    const { background, foreground } = assistantAvatarMessageColors(color);
    const values = [luminance(background), luminance(foreground)];
    expect((Math.max(...values) + 0.05) / (Math.min(...values) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});
