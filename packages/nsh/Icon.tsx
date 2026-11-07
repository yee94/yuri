import { Image, token } from 'nsh';
import { iconSpriteData } from '../ui/src/components/icon/sprite';

/** Native SVG image, using the same source paths and foreground token as Yuri UI. */
export function Icon(props: { name: keyof typeof iconSpriteData; size?: number; tone?: 'foreground' | 'background'; color?: string }) {
  const source = () => {
    const color = props.color ?? token(props.tone ?? 'foreground');
    const paths = iconSpriteData[props.name].replace(/currentColor/g, String(color));
    return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`);
  };
  return <Image src={source()} style={{ width: props.size ?? 20, height: props.size ?? 20 }} />;
}
