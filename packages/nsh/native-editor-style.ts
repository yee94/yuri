import type { TextStyle } from 'nsh';
import { nativeChatTextStyle } from './appearance';
import { deviceAppearance } from './device-appearance';

/** Skills editable Inputs use device points, independently of displayed code scale. */
export function nativeEditorTextStyle(): TextStyle {
  const fontFamily = nativeChatTextStyle('code').fontFamily;
  const size = deviceAppearance()?.editorFontSize;
  return { fontFamily, ...(size === undefined ? {} : { fontSize: size, lineHeight: size * 1.5 }) };
}
