import { Image, token } from 'nsh';
import { iconSpriteData } from '../../../ui/src/components/icon/sprite';

export type IconName = keyof typeof iconSpriteData;

/** Yuri's Lucide sprite drawn as a native image, same paths as Web's icon set. */
export function Icon(props: {
  /** A name, or one read when it changes (`() => session.pinned ? 'unpin' : 'pushpin'`). */
  name: IconName | (() => IconName);
  size?: number;
  /** A color read when it changes (`() => colors.destructive()`). */
  color?: () => string | undefined;
  tone?: 'foreground' | 'muted' | 'background';
}) {
  const size = () => props.size ?? 16;
  const source = () => {
    const tone = props.tone === 'muted' ? 'muted-foreground' : props.tone === 'background' ? 'background' : 'foreground';
    const color = props.color?.() ?? token(tone);
    const name = typeof props.name === 'function' ? props.name() : props.name;
    const paths = iconSpriteData[name].replace(/currentColor/g, color);
    return `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`,
    )}`;
  };
  return <Image src={source()} style={{ width: size(), height: size() }} />;
}
