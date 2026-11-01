/** Phone reading gesture for one contact bubble. Long press stays native. */
export const CONTACT_TAP_MAX_MS = 250;
/** Two taps inside this window and distance count as a double tap. */
export const CONTACT_DOUBLE_TAP_MS = 280;
export const CONTACT_TAP_SLOP_PX = 10;

type Point = { x: number; y: number; t: number };

/**
 * Double tap opens the reading view. A tap only qualifies when it lands on
 * ordinary text (never a link, button, code copy chrome or image).
 */
export function isContactReadingTapTarget(target: EventTarget | null): boolean {
  const node = target instanceof Element ? target : null;
  if (!node?.closest('[data-assistant-contact-text]')) return false;
  if (node.closest('[data-assistant-contact-media]')) return false;
  return !node.closest('a[href],button,input,textarea,select,[role="button"],[contenteditable="true"],img,video,code');
}

export function createContactDoubleTapDetector(onDoubleTap: (bubble: HTMLElement) => void) {
  let previous: Point | null = null;
  return {
    register(point: Point, target: EventTarget | null) {
      const last = previous;
      previous = point;
      if (!last) return false;
      if (point.t - last.t > CONTACT_DOUBLE_TAP_MS) return false;
      if (Math.abs(point.x - last.x) > CONTACT_TAP_SLOP_PX || Math.abs(point.y - last.y) > CONTACT_TAP_SLOP_PX) return false;
      if (!(target instanceof Element) || !isContactReadingTapTarget(target)) return false;
      const bubble = target.closest<HTMLElement>('[data-assistant-contact-text]');
      if (!bubble) return false;
      previous = null;
      onDoubleTap(bubble);
      return true;
    },
    reset() {
      previous = null;
    },
  };
}

