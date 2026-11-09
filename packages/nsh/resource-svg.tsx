import { nativeComponent } from 'nsh';
import type { RuntimeScope } from './runtime-scope';

/** Native reads the already verified local lease; SVG bytes never cross QuickJS. */
export const ResourceSVGImage = nativeComponent<{ config: { lease: string; expectedHost: RuntimeScope | null; active: boolean } }>(
  'yuri.resource.svgImage', { props: ['config'] },
);
