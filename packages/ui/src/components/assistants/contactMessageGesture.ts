/** Phone-native reading gestures for one contact bubble. */
export const CONTACT_LONG_PRESS_MS = 500;
/** Two taps inside this window and distance count as a double tap. */
export const CONTACT_DOUBLE_TAP_MS = 280;
export const CONTACT_TAP_SLOP_PX = 10;

type Point = { x: number; y: number; t: number };

export type ContactLongPressToolbar = {
  node: HTMLButtonElement;
  show: () => void;
  hide: () => void;
  destroy: () => void;
};

const style = `
:host{all:initial}
div{position:fixed;display:none;z-index:2147483647;transform:translate(-50%,0);font:500 13px/1 system-ui,-apple-system,sans-serif}
button{appearance:none;border:0;margin:0;padding:11px 18px;border-radius:999px;background:rgba(28,28,30,.94);color:#fff;font:inherit;letter-spacing:.01em;box-shadow:0 6px 20px rgba(0,0,0,.25);user-select:none;-webkit-user-select:none}
@media (prefers-color-scheme:light){button{background:rgba(255,255,255,.97);color:#111}}
`;

/**
 * Native popovers cannot sit above the bubble's own selection handles, so the
 * "select all" affordance is a host-popover shown only while the selection
 * lives in the pressed bubble.
 */
export function createContactLongPressToolbar(doc: Document, label: string, onSelectAll: () => void): ContactLongPressToolbar {
  const host = doc.createElement('div');
  host.setAttribute('data-assistant-contact-select-toolbar', '');
  const shadow = host.attachShadow({ mode: 'open' });
  const sheet = doc.createElement('style');
  sheet.textContent = style;
  const wrap = doc.createElement('div');
  const button = doc.createElement('button');
  button.type = 'button';
  button.textContent = label;
  // Presses inside the toolbar must not move the document selection.
  button.addEventListener('pointerdown', (event) => event.preventDefault());
  button.addEventListener('click', (event) => { event.preventDefault(); onSelectAll(); });
  wrap.style.left = '50%';
  wrap.append(button);
  shadow.append(sheet, wrap);
  doc.body.append(host);
  return {
    node: button,
    show() {
      wrap.style.display = 'block';
    },
    hide() {
      wrap.style.display = 'none';
    },
    destroy() {
      host.remove();
    },
  };
}

/** Place the toolbar just above the current selection, clamped to the viewport. */
export function positionContactLongPressToolbar(toolbar: ContactLongPressToolbar, box: { left: number; right: number; top: number }, viewportWidth: number) {
  const sheet = toolbar.node.parentElement
  if (!sheet) return
  sheet.style.left = `${Math.round(Math.min(Math.max((box.left + box.right) / 2, 72), Math.max(72, viewportWidth - 72)))}px`;
  sheet.style.top = `${Math.round(Math.max(box.top - 52, 8))}px`;
}

/** The pressed bubble owns the range; the consumer decides what text it covers. */
export type ContactSelectionRange = (container: HTMLElement) => Range;

export function selectContactMessage(toolbar: ContactLongPressToolbar, container: HTMLElement, rangeFor: ContactSelectionRange) {
  const selection = container.ownerDocument.getSelection();
  if (!selection) return null;
  const range = rangeFor(container);
  selection.removeAllRanges();
  selection.addRange(range);
  positionContactLongPressToolbar(toolbar, range.getBoundingClientRect(), container.ownerDocument.defaultView?.innerWidth ?? 0);
  toolbar.show();
  return range;
}

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

