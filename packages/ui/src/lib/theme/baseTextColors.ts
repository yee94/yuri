import type { Theme } from '../../types/theme';

const BASE_TEXT_FLOOR = { light: '#212121', dark: '#DEDEDE' } as const;

const parseHex = (color: string): number[] | null => {
  const match = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(color);
  if (!match) return null;
  const hex = match[1].length < 5
    ? [...match[1]].map((digit) => digit + digit).join('')
    : match[1];
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
    .concat(hex.length === 8 ? Number.parseInt(hex.slice(6), 16) / 255 : 1);
};

const luminance = (rgb: number[]): number => {
  const linear = rgb.slice(0, 3).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
};

/** Apply the app's primary-text brightness floor without changing semantic colors. */
export const withBaseTextFloor = (theme: Theme): Theme => {
  const floor = BASE_TEXT_FLOOR[theme.metadata.variant];
  const minimum = luminance(parseHex(floor)!);
  const colors = theme.colors;
  let changed = false;
  const lift = (color: string, background: string): string => {
    const rgba = parseHex(color);
    if (!rgba) return color;
    const backdrop = parseHex(background);
    const rgb = rgba[3] === 1 || !backdrop
      ? rgba
      : rgba.slice(0, 3).map((channel, index) => channel * rgba[3] + backdrop[index] * (1 - rgba[3]));
    if (luminance(rgb) + 1e-9 >= minimum) return color;
    changed = true;
    return floor;
  };

  const surface = {
    ...colors.surface,
    foreground: lift(colors.surface.foreground, colors.surface.background),
    elevatedForeground: lift(colors.surface.elevatedForeground, colors.surface.elevated),
  };
  const chat = colors.chat ? { ...colors.chat } : undefined;
  if (chat?.userMessage) {
    chat.userMessage = lift(chat.userMessage, chat.userMessageBackground || colors.surface.elevated);
  }
  if (chat?.assistantMessage) {
    chat.assistantMessage = lift(chat.assistantMessage, chat.assistantMessageBackground || colors.surface.muted);
  }
  const tools = colors.tools ? { ...colors.tools } : undefined;
  if (tools?.title) tools.title = lift(tools.title, colors.surface.muted);

  const markdown = colors.markdown ? { ...colors.markdown } : undefined;
  if (markdown) {
    for (const key of ['bold', 'italic', 'heading1', 'heading2', 'heading3', 'heading4']) {
      const color = markdown[key];
      if (!color) continue;
      const rgba = parseHex(color);
      const neutral = rgba && rgba[0] === rgba[1] && rgba[1] === rgba[2];
      const base = [colors.surface.foreground, colors.surface.elevatedForeground]
        .some((value) => value.toLowerCase() === color.toLowerCase());
      if (!key.startsWith('heading') || neutral || base) {
        markdown[key] = lift(color, chat?.background || colors.surface.background);
      }
    }
  }

  return changed ? {
    ...theme,
    colors: {
      ...colors,
      surface,
      ...(chat && { chat }),
      ...(tools && { tools }),
      ...(markdown && { markdown }),
    },
  } : theme;
};
