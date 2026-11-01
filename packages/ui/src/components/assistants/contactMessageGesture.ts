/**
 * Which contact bubble a touch belongs to for reading. Timing, double-tap and the
 * Android native fallbacks live in `@/lib/touch-gestures`; this only decides
 * eligibility, so links, code, media and cards keep their own behavior.
 */
export function resolveContactReadingBubble(target: EventTarget | null): HTMLElement | null {
  const node = target instanceof Element ? target : null;
  const bubble = node?.closest<HTMLElement>('[data-assistant-contact-text]') ?? null;
  if (!node || !bubble) return null;
  if (bubble.hasAttribute('data-assistant-contact-media')) return null;
  if (node.closest('a[href],button,input,textarea,select,[role="button"],[contenteditable="true"],img,video,code')) return null;
  return bubble;
}
