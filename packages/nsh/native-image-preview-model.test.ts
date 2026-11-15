import { expect, test } from 'vitest';
import {
  NATIVE_IMAGE_PREVIEW_DISMISS_PULL,
  NATIVE_IMAGE_PREVIEW_MAX_SCALE,
  nativeImagePreviewClampIndex,
  nativeImagePreviewCloseAnimation,
  nativeImagePreviewDismissPull,
  nativeImagePreviewDismissStyle,
  nativeImagePreviewDoubleTapScale,
  nativeImagePreviewFitFrame,
  nativeImagePreviewFitSize,
  nativeImagePreviewPageIndex,
  nativeImagePreviewShouldDismiss,
  nativeImagePreviewSourceRect,
  nativeImagePreviewTransition,
} from './native-image-preview-model';

const viewport = { width: 390, height: 844 };

test('the contained fit stays inside the viewport and centers like object-fit: contain', () => {
  const size = nativeImagePreviewFitSize({ width: 400, height: 300 }, viewport);
  expect(size).toEqual({ width: 390, height: 292.5 });
  const frame = nativeImagePreviewFitFrame({ width: 400, height: 300 }, viewport);
  expect(frame.rect.x).toBe(0);
  expect(frame.rect.y).toBeCloseTo((844 - 292.5) / 2);
  expect(frame.rect.width).toBe(390);

  // A tall image is limited by height instead.
  expect(nativeImagePreviewFitSize({ width: 300, height: 1200 }, viewport)).toEqual({ width: 211, height: 844 });

  // Unknown sizes never divide by zero.
  expect(nativeImagePreviewFitSize(null, viewport)).toEqual({ width: 1, height: 1 });
  expect(nativeImagePreviewFitSize({ width: 400, height: 300 }, { width: 0, height: 0 })).toEqual({ width: 1, height: 1 });
});

test('the source transition covers the thumbnail frame and maps back to the full frame', () => {
  const from = nativeImagePreviewTransition(
    { width: 400, height: 300 },
    viewport,
    { x: 100, y: 200, width: 200, height: 150 },
  );
  expect(from).not.toBeNull();
  // The thumbnail is 200x150 in a 390x292.5 frame: a uniform 0.5128 cover scale.
  expect(from!.scale).toBeCloseTo(200 / 390);
  expect(from!.x).toBeCloseTo(100 + 100 - 195);
  expect(from!.y).toBeCloseTo(200 + 75 - (275.75 + 146.25));

  // No measurable source (unmounted, recycled) means the viewer fades instead.
  expect(nativeImagePreviewTransition({ width: 400, height: 300 }, viewport, null)).toBeNull();
  expect(nativeImagePreviewTransition({ width: 400, height: 300 }, viewport, { x: 0, y: 0, width: 0, height: 0 })).toBeNull();
  expect(nativeImagePreviewTransition({ width: 400, height: 300 }, viewport, { x: Number.NaN, y: 0, width: 10, height: 10 })).toBeNull();
});

test('pull-to-dismiss follows the finger, clamps its visuals and dismisses at the calibrated pull', () => {
  expect(nativeImagePreviewDismissStyle(0, 844)).toEqual({ scale: 1, opacity: 1 });
  const atLimit = nativeImagePreviewDismissStyle(NATIVE_IMAGE_PREVIEW_DISMISS_PULL, 844);
  expect(atLimit.scale).toBeCloseTo(0.75);
  expect(atLimit.opacity).toBeCloseTo(0.15);
  expect(nativeImagePreviewDismissStyle(1000, 844)).toEqual(atLimit);
  expect(nativeImagePreviewDismissStyle(100, 844).scale).toBeLessThan(1);

  expect(nativeImagePreviewDismissPull(844)).toBe(NATIVE_IMAGE_PREVIEW_DISMISS_PULL);
  expect(nativeImagePreviewDismissPull(500)).toBeCloseTo(45);
  expect(nativeImagePreviewShouldDismiss(63, 844)).toBe(false);
  expect(nativeImagePreviewShouldDismiss(64, 844)).toBe(true);
  expect(nativeImagePreviewShouldDismiss(0, 844)).toBe(false);
  expect(nativeImagePreviewShouldDismiss(Number.NaN, 844)).toBe(false);
});

test('double tap zooms in past the resting scale and returns to it, bounded by the viewer maximum', () => {
  expect(nativeImagePreviewDoubleTapScale(1)).toBe(2);
  expect(nativeImagePreviewDoubleTapScale(1.01)).toBe(2);
  expect(nativeImagePreviewDoubleTapScale(2)).toBe(1);
  expect(NATIVE_IMAGE_PREVIEW_MAX_SCALE).toBe(5);
});

test('the gallery index and paging offset never leave the real items', () => {
  expect(nativeImagePreviewClampIndex(5, 3)).toBe(2);
  expect(nativeImagePreviewClampIndex(-1, 3)).toBe(0);
  expect(nativeImagePreviewClampIndex(1.6, 3)).toBe(2);
  expect(nativeImagePreviewClampIndex(2, 0)).toBe(0);
  expect(nativeImagePreviewClampIndex(Number.NaN, 3)).toBe(0);

  expect(nativeImagePreviewPageIndex(0, 390, 3)).toBe(0);
  expect(nativeImagePreviewPageIndex(400, 390, 3)).toBe(1);
  expect(nativeImagePreviewPageIndex(780, 390, 3)).toBe(2);
  expect(nativeImagePreviewPageIndex(900, 390, 3)).toBe(2);
  expect(nativeImagePreviewPageIndex(-20, 390, 3)).toBe(0);
  expect(nativeImagePreviewPageIndex(100, 0, 3)).toBe(0);
});

test('only a live source frame with motion allowed animates the return', () => {
  const from = nativeImagePreviewTransition({ width: 400, height: 300 }, viewport, { x: 20, y: 120, width: 200, height: 150 });
  expect(nativeImagePreviewCloseAnimation(from, false)).toBe('source');
  expect(nativeImagePreviewCloseAnimation(from, true)).toBe('fade');
  expect(nativeImagePreviewCloseAnimation(null, false)).toBe('fade');
});

test('the source rect is the letterboxed picture in a contain frame and the cropped frame when compact', () => {
  const frame = { x: 10, y: 20, width: 240, height: 160 };
  // 400x300 into a 240x160 box: height-limited, so the picture is centered with side bars.
  const contain = nativeImagePreviewSourceRect(frame, { width: 400, height: 300 }, 'contain');
  expect(contain).not.toBeNull();
  expect(contain!.height).toBeCloseTo(160);
  expect(contain!.width).toBeCloseTo(160 / 300 * 400);
  expect(contain!.x).toBeCloseTo(10 + (240 - (160 / 300 * 400)) / 2);
  expect(contain!.y).toBeCloseTo(20);

  // A compact frame crops (cover): its visible extent is the frame itself.
  expect(nativeImagePreviewSourceRect(frame, { width: 400, height: 300 }, 'cover')).toEqual(frame);

  // Unknown or unusable dimensions fall back to the viewer's fade.
  expect(nativeImagePreviewSourceRect(frame, null, 'contain')).toBeNull();
  expect(nativeImagePreviewSourceRect({ x: 0, y: 0, width: 0, height: 10 }, { width: 40, height: 30 }, 'contain')).toBeNull();
  expect(nativeImagePreviewSourceRect(frame, { width: 0, height: 0 }, 'cover')).toBeNull();
});
