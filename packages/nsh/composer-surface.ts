import { token, type ViewStyle } from 'nsh';

/** One native material owner; transparent editor/list children must not paint over Liquid Glass. */
export const nativeComposerSurface: ViewStyle = { glassEffect: 'regular', borderRadius: 24, backgroundColor: 'transparent', backdropFilter: 'blur(20px)' };
export const nativeAutocompleteSurface: ViewStyle = { glassEffect: 'regular', borderRadius: 16, backgroundColor: 'transparent', backdropFilter: 'blur(20px)' };

export function desktopComposerSurface(): ViewStyle {
  // Web ChatInput uses 1.5rem on the desktop shell. The 16pt radius is the mobile glass surface.
  return { borderRadius: 24, borderWidth: 1, borderColor: token('border'), backgroundColor: token('card') };
}
