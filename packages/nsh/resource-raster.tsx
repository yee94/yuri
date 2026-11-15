import { nativeComponent } from 'nsh';
import type { RuntimeScope } from './runtime-scope';

/**
 * Native decodes the already verified private lease with a bounded sampler and
 * renders it `contain`. No filesystem path or original bytes cross QuickJS; the
 * native surface reports only presentation state plus intrinsic pixel size.
 *
 * `size` precedes `load` for the same successful decode; `error.code` is a stable
 * machine code (`decode` or `expired`), never a path or raw decoder message.
 */
export const ResourceRasterImage = nativeComponent<{
  config: { lease: string; expectedHost: RuntimeScope | null; active: boolean };
}, {
  size: { width: number; height: number };
  load: { width: number; height: number };
  error: { code: string };
}>('yuri.resource.rasterImage', { props: ['config'], events: ['size', 'load', 'error'] });
