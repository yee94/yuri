/**
 * Pure geometry for the NSH image preview.
 *
 * The Web viewer (`packages/ui/src/components/chat/message/imageViewerTransform.ts`) owns the
 * pointer/pinch math because it pans a DOM transform itself. NSH lets the platform scroll view
 * own pinch zoom and two-axis panning, so only the parts that are still ours live here: the
 * contained fit, the source-frame transition, pull-to-dismiss thresholds, double-tap scale and
 * gallery paging. Keep this file free of native imports so it runs in Vitest.
 */

export type NativeImagePreviewSize = { width: number; height: number };

export type NativeImagePreviewRect = { x: number; y: number; width: number; height: number };

/** Maps the full-size frame onto the thumbnail frame: translate from the full frame, then scale. */
export type NativeImagePreviewTransition = { scale: number; x: number; y: number };

export type NativeImagePreviewFrame = {
  /** The contained image size. */
  size: NativeImagePreviewSize;
  /** The contained image's frame inside the viewport (page coordinates). */
  rect: NativeImagePreviewRect;
};

/** Web parity: `IMAGE_VIEWER_MAX_SCALE` and `IMAGE_VIEWER_DOUBLE_TAP_SCALE`. */
export const NATIVE_IMAGE_PREVIEW_MAX_SCALE = 5;
export const NATIVE_IMAGE_PREVIEW_DOUBLE_TAP_SCALE = 2;
/**
 * NSH counts clicks natively (`PressEvent.clickCount`) and documents its second click as
 * arriving within 500ms (headless and the phone surfaces), so a single tap must wait that
 * window before closing; a shorter delay would close the viewer out from under a real double
 * tap. The Web viewer uses Safari's 280ms window because it pairs taps itself.
 */
export const NATIVE_IMAGE_PREVIEW_TAP_DELAY_MS = 500;
export const NATIVE_IMAGE_PREVIEW_OPEN_DURATION_MS = 260;
export const NATIVE_IMAGE_PREVIEW_RETURN_DURATION_MS = 240;
export const NATIVE_IMAGE_PREVIEW_FADE_DURATION_MS = 160;
/**
 * How far `pullValue` must go before release dismisses. NSH's pull reports the scroll view's
 * rubber-banded overscroll, about 46% of finger travel on iOS, so 64pt here is the Web
 * viewer's 140pt release threshold; small screens scale with the viewport.
 */
export const NATIVE_IMAGE_PREVIEW_DISMISS_PULL = 64;
/** Web parity: pull-to-dismiss scales down at most a quarter while the backdrop fades to 15%. */
const DISMISS_SCALE_LOSS = 0.25;
const DISMISS_MIN_OPACITY = 0.15;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const positive = (size: NativeImagePreviewSize | null | undefined): NativeImagePreviewSize | null => (
  size && Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
    ? { width: size.width, height: size.height }
    : null
);

/** `object-fit: contain`, at least one point, as the Web `getFittedImageSize` does. */
export const nativeImagePreviewFitSize = (
  natural: NativeImagePreviewSize | null | undefined,
  viewport: NativeImagePreviewSize | null | undefined,
): NativeImagePreviewSize => {
  const source = positive(natural);
  const area = positive(viewport);
  if (!source || !area) return { width: 1, height: 1 };
  const scale = Math.min(area.width / source.width, area.height / source.height);
  return {
    width: Math.max(1, source.width * scale),
    height: Math.max(1, source.height * scale),
  };
};

/** The contained size centered in the viewport. */
export const nativeImagePreviewFitFrame = (
  natural: NativeImagePreviewSize | null | undefined,
  viewport: NativeImagePreviewSize | null | undefined,
): NativeImagePreviewFrame => {
  const area = positive(viewport) ?? { width: 1, height: 1 };
  const size = nativeImagePreviewFitSize(natural, area);
  return {
    size,
    rect: {
      x: (area.width - size.width) / 2,
      y: (area.height - size.height) / 2,
      width: size.width,
      height: size.height,
    },
  };
};

/**
 * Where the full-size image starts when the viewer opens: scaled and moved so its displayed
 * area covers the thumbnail's page frame (`object-fit: cover`, as the card crops). `null` when
 * a frame is unusable, which makes the viewer fall back to a fade.
 */
export const nativeImagePreviewTransition = (
  natural: NativeImagePreviewSize | null | undefined,
  viewport: NativeImagePreviewSize | null | undefined,
  source: NativeImagePreviewRect | null | undefined,
): NativeImagePreviewTransition | null => {
  if (!source || !Number.isFinite(source.x) || !Number.isFinite(source.y)
    || !Number.isFinite(source.width) || !Number.isFinite(source.height)
    || source.width <= 0 || source.height <= 0) return null;
  const full = nativeImagePreviewFitFrame(natural, viewport).rect;
  if (full.width <= 0 || full.height <= 0) return null;
  const scale = Math.max(source.width / full.width, source.height / full.height);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return {
    scale,
    x: source.x + source.width / 2 - (full.x + full.width / 2),
    y: source.y + source.height / 2 - (full.y + full.height / 2),
  };
};

/** Pull-to-dismiss follow: the viewer shrinks a little and fades as the image is pulled down. */
export const nativeImagePreviewDismissStyle = (
  pull: number,
  viewportHeight: number,
): { scale: number; opacity: number } => {
  const distance = Math.max(0, Number.isFinite(pull) ? pull : 0);
  const height = Math.max(1, Number.isFinite(viewportHeight) ? viewportHeight : 1);
  const progress = clamp(distance / Math.max(1, nativeImagePreviewDismissPull(height)), 0, 1);
  return {
    scale: 1 - DISMISS_SCALE_LOSS * progress,
    opacity: 1 - (1 - DISMISS_MIN_OPACITY) * progress,
  };
};

/**
 * How far `pullValue` must go before release dismisses. NSH's pull reports the scroll view's
 * rubber-banded overscroll, about 46% of finger travel on iOS, so 64pt here is the Web
 * viewer's 140pt release threshold; small screens scale with the viewport.
 */
export const nativeImagePreviewDismissPull = (viewportHeight: number): number => {
  const height = Math.max(1, Number.isFinite(viewportHeight) ? viewportHeight : 1);
  return Math.min(NATIVE_IMAGE_PREVIEW_DISMISS_PULL, height * 0.09);
};

export const nativeImagePreviewShouldDismiss = (pull: number, viewportHeight: number): boolean => {
  const distance = Math.max(0, Number.isFinite(pull) ? pull : 0);
  return distance >= nativeImagePreviewDismissPull(viewportHeight);
};

/** Web parity: a zoomed image returns to 1, otherwise double tap zooms in on the tapped point. */
export const nativeImagePreviewDoubleTapScale = (scale: number): number => (
  Number.isFinite(scale) && scale > 1.01 ? 1 : NATIVE_IMAGE_PREVIEW_DOUBLE_TAP_SCALE
);

/** Clamps a caller index into `0..length-1` (`0` for an empty gallery). */
export const nativeImagePreviewClampIndex = (index: number, length: number): number => {
  if (!Number.isFinite(length) || length <= 0) return 0;
  const last = Math.floor(length) - 1;
  if (!Number.isFinite(index)) return 0;
  return clamp(Math.round(index), 0, last);
};

/** The page a paging offset rests on. */
export const nativeImagePreviewPageIndex = (offsetX: number, pageWidth: number, length: number): number => {
  if (!Number.isFinite(pageWidth) || pageWidth <= 0) return nativeImagePreviewClampIndex(0, length);
  return nativeImagePreviewClampIndex(offsetX / pageWidth, length);
};

/** Only an animated return is worth waiting for when a live source frame exists and motion is allowed. */
export const nativeImagePreviewCloseAnimation = (
  source: NativeImagePreviewTransition | null,
  reducedMotion: boolean,
): 'source' | 'fade' => (source && !reducedMotion ? 'source' : 'fade');

/**
 * The bitmap area actually visible in the thumbnail frame, in page coordinates.
 *
 * A message frame contains the image (letterboxing), so the return must land on the letterboxed
 * picture, not the whole 160pt box, or the image would squash on the way back. A compact frame
 * crops with `cover`, so its visible extent is the frame itself. Unknown source dimensions
 * return `null`, which the viewer renders as a fade instead of guessing a warp.
 */
export const nativeImagePreviewSourceRect = (
  rect: NativeImagePreviewRect | null | undefined,
  natural: NativeImagePreviewSize | null | undefined,
  mode: 'contain' | 'cover',
): NativeImagePreviewRect | null => {
  if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)
    || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)
    || rect.width <= 0 || rect.height <= 0) return null;
  const source = positive(natural);
  if (!source) return null;
  if (mode === 'cover') return { ...rect };
  const scale = Math.min(rect.width / source.width, rect.height / source.height);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const width = Math.max(1, source.width * scale);
  const height = Math.max(1, source.height * scale);
  return {
    x: rect.x + (rect.width - width) / 2,
    y: rect.y + (rect.height - height) / 2,
    width,
    height,
  };
};
