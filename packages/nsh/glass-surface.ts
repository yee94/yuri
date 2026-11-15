import { colorScheme, platform, type ViewStyle } from 'nsh';

/** Android has no Liquid Glass: same tokens as ui mobile.css (--yuri-mobile-glass-*), drawn as blur, edge, shadow and top highlight. */
/** Extra style a glass view needs where `glassEffect` is not drawn; empty on iOS/desktop. */
export function glassEdge(): ViewStyle {
  if (platform.os !== 'android') return {};
  const dark = colorScheme() === 'dark';
  const highlight = dark ? 'rgb(255 255 255 / 0.14)' : 'rgb(255 255 255 / 0.6)';
  return {
    backgroundColor: dark ? 'rgb(38 38 44 / 0.66)' : 'rgb(255 255 255 / 0.68)',
    borderWidth: 0.5, borderColor: dark ? 'rgb(255 255 255 / 0.07)' : 'rgb(255 255 255 / 0.25)',
    boxShadow: [
      `0 0 2px rgb(0 0 0 / ${dark ? '0.3' : '0.05'})`,
      `0 0 12px rgb(0 0 0 / ${dark ? '0.28' : '0.06'})`,
      `0 8px 20px -6px rgb(0 0 0 / ${dark ? '0.4' : '0.12'})`,
      `inset 0 1px 0 ${highlight}`,
    ].join(', '),
  };
}
