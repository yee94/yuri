import type { ViewStyle } from 'nsh';

/** One native material owner; transparent editor/list children must not paint over Liquid Glass. */
export const nativeComposerSurface: ViewStyle = { glassEffect: 'regular', borderRadius: 24, backgroundColor: 'transparent', backdropFilter: 'blur(20px)' };
export const nativeAutocompleteSurface: ViewStyle = { glassEffect: 'regular', borderRadius: 16, backgroundColor: 'transparent', backdropFilter: 'blur(20px)' };
