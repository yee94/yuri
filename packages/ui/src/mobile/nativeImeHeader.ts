import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

import { HEADER_COLLAPSE_CSS_VAR } from '@/components/chat/mobileHeaderCollapse';

/**
 * Native keyboard experiment (Android + iOS WebView path): at rest this page paints its own same-layer header
 * (live backdrop blur, collapse animation). A second, natively pinned,
 * transparent WebView keeps a ready mirror and the native IME owner engages it only
 * while the IME moves, so the header never moves with the keyboard. This page
 * stays the only state owner: the mirror receives serialized DOM (rendered
 * expanded), collapse is forwarded as progress/phase/rest and applied natively
 * as translationY/alpha, and taps return as child-index paths. Mirror glass is
 * plain translucency; backdrop-filter cannot sample another WebView.
 */
type HeaderPayload = {
  seq: number;
  visible: boolean;
  height?: number;
  hitBottom?: number;
  collapseDistance?: number;
  html?: string;
  rootClass?: string;
  rootStyle?: string;
  bodyClass?: string;
  css?: string;
  sprite?: string;
};

type NativeHeaderPlugin = {
  update(payload: HeaderPayload): Promise<void>;
  /** iOS only: native keyboard choreography, off while the native composer owns IME. */
  setImeSync(options: { enabled: boolean }): Promise<void>;
  addListener(event: 'shown', handler: (event: { seq: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'tap', handler: (event: { path: string }) => void): Promise<PluginListenerHandle>;
};

type CollapseBridge = { set(progress: number, phase: string, rest: string): void };

const NativeHeader = registerPlugin<NativeHeaderPlugin>('YuriNativeHeader');

const HEADER_SELECTOR = 'header.yuri-mobile-detail-navigation, header.yuri-mobile-header';
const SOURCE_CLASS = 'yuri-native-header-source';
const READY_CLASS = 'yuri-native-header-ready';
const VOLATILE_ROOT_CLASSES = new Set([READY_CLASS, 'yuri-keyboard-open', 'yuri-kb-animating', 'yuri-kb-hide', 'yuri-kb-caret-hold']);
export const NATIVE_VIEWPORT_TOP_VAR = '--yuri-native-viewport-top';
// Fixed-position panels (context metadata, menus) mounted inside the header.
const HEADER_OVERLAY_SELECTOR = '.fixed, [role="dialog"]';
const COLLAPSE_ATTRIBUTES = new Set(['style', 'data-yuri-header-collapse-phase', 'data-yuri-header-collapse-rest']);

const readViewportTop = (): number => (
  parseFloat(document.documentElement.style.getPropertyValue(NATIVE_VIEWPORT_TOP_VAR)) || 0
);

// Live assistant avatars animate their SVG every frame. The mirror keeps a
// static snapshot; those mutations must not re-sync (or keep it unready).
const AVATAR_SELECTOR = '[data-avatar-motion]';
const VISIBILITY_ATTRIBUTES = new Set(['class', 'style', 'inert', 'aria-hidden', 'hidden']);

// The header's own visibility is ours (source hide) or collapse's; parked tab
// underlays and covered secondary pages hide an ancestor instead.
const isCandidate = (element: HTMLElement): boolean => {
  if (element.getClientRects().length === 0 || element.offsetHeight <= 0) return false;
  if (element.closest('[inert],[aria-hidden="true"]')) return false;
  const parent = element.parentElement;
  if (!parent) return false;
  if (typeof parent.checkVisibility === 'function'
    ? !parent.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true, opacityProperty: true })
    : getComputedStyle(parent).visibility === 'hidden') return false;
  // Collapse translates the header itself; its layout box stays at the top.
  const top = element.getBoundingClientRect().top - readViewportTop();
  return element.dataset.yuriCollapsibleHeader === 'true' || Math.abs(top) <= 1;
};

const findHeader = (current: HTMLElement | null, keepCurrent: boolean): HTMLElement | null => {
  const candidates = [...document.querySelectorAll<HTMLElement>(HEADER_SELECTOR)].filter(isCandidate);
  // While engaged the source is hidden on purpose and cannot be hit-tested.
  if (keepCurrent && current && candidates.includes(current)) return current;
  // Chat and assistant conversations can both be mounted (one stacked over
  // the other). The header actually on screen wins the hit test.
  for (const element of candidates) {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.bottom - 4);
    if (hit && element.contains(hit)) return element;
  }
  return candidates.at(-1) ?? null;
};

const collectCss = (): string => {
  const parts: string[] = [];
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) parts.push(rule.cssText);
    } catch {
      // Cross-origin sheets are not part of the app bundle.
    }
  }
  return parts.join('\n');
};

const styleSignature = (): string => {
  let total = 0;
  for (const sheet of document.styleSheets) {
    try { total += sheet.cssRules.length; } catch { /* ignore */ }
  }
  return `${document.styleSheets.length}:${total}`;
};

export const nativeImeHeader = NativeHeader;

// Resolves after the next painted frame so native can drop its compensation.
const afterPaint = (): Promise<number> => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve(1)));
});

export function startNativeImeHeader(): () => void {
  const root = document.documentElement;
  const win = window as typeof window & {
    __yuriImeOffset?: (px: number) => number | Promise<number>;
    YuriHeaderCollapse?: CollapseBridge;
    webkit?: { messageHandlers?: { yuriHeaderCollapse?: { postMessage(body: unknown): void } } };
  };
  let disposed = false;
  let seq = 0;
  let frame = 0;
  let source: HTMLElement | null = null;
  let lastKey = '';
  let lastCss = '';
  let lastSprite = '';
  let lastCollapse = '';
  let nativeVisible = false;
  let engaged = false;
  const handles: Array<Promise<PluginListenerHandle>> = [];

  // Synchronous, per mutation: tracking progress reaches native in the frame
  // the page computed it.
  const publishCollapse = () => {
    if (!source) return;
    const progress = parseFloat(source.style.getPropertyValue(HEADER_COLLAPSE_CSS_VAR)) || 0;
    const phase = source.dataset.yuriHeaderCollapsePhase ?? 'rest';
    const rest = source.dataset.yuriHeaderCollapseRest ?? 'expanded';
    const key = `${progress}|${phase}|${rest}`;
    if (key === lastCollapse) return;
    lastCollapse = key;
    // Synchronous channels: Android JS interface, iOS script message handler.
    if (win.YuriHeaderCollapse) win.YuriHeaderCollapse.set(progress, phase, rest);
    else win.webkit?.messageHandlers?.yuriHeaderCollapse?.postMessage({ progress, phase, rest });
  };

  const hideNative = () => {
    root.classList.remove(READY_CLASS);
    if (!nativeVisible) return;
    nativeVisible = false;
    lastKey = '';
    void NativeHeader.update({ seq: ++seq, visible: false }).catch(() => undefined);
  };

  const sync = () => {
    frame = 0;
    if (disposed) return;
    const header = findHeader(source, engaged);
    if (header !== source) {
      // Page header shows in this frame; the old mirror goes before the new
      // one paints, so two different headers never overlap.
      source?.classList.remove(SOURCE_CLASS);
      hideNative();
      source = header;
      lastCollapse = '';
      if (!header) return;
      header.classList.add(SOURCE_CLASS);
      publishCollapse();
    }
    if (!header) return;
    const dpr = window.devicePixelRatio || 1;
    const headerHeight = header.offsetHeight;
    const fade = parseFloat(getComputedStyle(header, '::after').height) || 0;
    const hitBottom = Math.ceil(headerHeight * dpr);
    // Header panels/menus render in this page below the strip. While one is
    // open the mirror drops its fade so it never washes over the panel.
    const overlayOpen = header.querySelector(HEADER_OVERLAY_SELECTOR) !== null;
    const height = overlayOpen ? hitBottom : Math.ceil(Math.max(headerHeight, fade) * dpr);
    const rem = parseFloat(getComputedStyle(root).fontSize) || 16;
    // Same distance as the CSS collapse transform: -100% - 2rem.
    const collapseDistance = (headerHeight + 2 * rem) * dpr;
    const clone = header.cloneNode(true) as HTMLElement;
    clone.classList.remove(SOURCE_CLASS);
    // Rendered expanded; native owns collapse translation/alpha.
    clone.style.removeProperty(HEADER_COLLAPSE_CSS_VAR);
    delete clone.dataset.yuriHeaderCollapsePhase;
    delete clone.dataset.yuriHeaderCollapseRest;
    // display:none keeps child indexes identical for tap replay.
    for (const overlay of clone.querySelectorAll<HTMLElement>(HEADER_OVERLAY_SELECTOR)) overlay.style.display = 'none';
    const html = clone.outerHTML;
    // Keyboard-state classes flip at every bookend; mirroring them would
    // re-render the mirror exactly when it is engaged.
    const rootClass = [...root.classList].filter((name) => !VOLATILE_ROOT_CLASSES.has(name)).join(' ');
    const rootStyle = (root.getAttribute('style') ?? '')
      .replace(new RegExp(`${NATIVE_VIEWPORT_TOP_VAR}\\s*:[^;]*;?`, 'g'), '');
    const bodyClass = document.body.className;
    const key = `${html}|${rootClass}|${rootStyle}|${bodyClass}|${height}|${collapseDistance}`;
    const signature = styleSignature();
    const sprite = document.getElementById('yuri-icon-sprite-v2')?.outerHTML ?? '';
    if (key === lastKey && signature === lastCss && sprite === lastSprite) return;
    lastKey = key;
    const payload: HeaderPayload = {
      seq: ++seq, visible: true, height, hitBottom, collapseDistance, html, rootClass, rootStyle, bodyClass,
    };
    if (signature !== lastCss) { lastCss = signature; payload.css = collectCss(); }
    if (sprite !== lastSprite) { lastSprite = sprite; payload.sprite = sprite; }
    nativeVisible = true;
    void NativeHeader.update(payload).catch(() => undefined);
  };

  const schedule = () => {
    if (!frame && !disposed) frame = requestAnimationFrame(sync);
  };

  handles.push(NativeHeader.addListener('shown', (event) => {
    // A mid-motion header change: hide the page copy once the mirror painted.
    if (engaged && event.seq === seq && source) root.classList.add(READY_CLASS);
  }));
  handles.push(NativeHeader.addListener('tap', (event) => {
    if (!source || !engaged) return;
    let node: Element | null = source;
    try {
      for (const index of JSON.parse(event.path) as number[]) node = node?.children[index] ?? null;
    } catch {
      return;
    }
    const target = node?.closest<HTMLElement>('button, a, [role="button"]');
    if (!target || !source.contains(target)) return;
    // Outside-dismiss layers listen to pointerdown; replay the full gesture.
    const init = { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true };
    target.dispatchEvent(new PointerEvent('pointerdown', init));
    target.dispatchEvent(new PointerEvent('pointerup', init));
    target.click();
  }));

  const observer = new MutationObserver((records) => {
    if (!source || !source.isConnected) { schedule(); return; }
    let structural = false;
    for (const record of records) {
      if (record.target === source && record.type === 'attributes' && COLLAPSE_ATTRIBUTES.has(record.attributeName ?? '')) {
        publishCollapse();
        continue;
      }
      // Streaming transcript mutations are ignored; header edits, or ancestor
      // state such as inert/aria-hidden/window motion, need a mirror pass.
      const owner = record.target instanceof Element ? record.target : record.target.parentElement;
      if (owner?.closest(AVATAR_SELECTOR) && source.contains(owner)) continue;
      if (source.contains(record.target) || (record.type === 'attributes' && record.target.contains(source))) structural = true;
      // A page switch (chat <-> assistant) may toggle an ancestor of the other
      // header only; re-pick when such a subtree changes visibility.
      else if (record.type === 'attributes' && VISIBILITY_ATTRIBUTES.has(record.attributeName ?? '')
        && record.target instanceof Element && record.target.querySelector(HEADER_SELECTOR)) structural = true;
      else if (record.type === 'childList') {
        for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches(HEADER_SELECTOR) || node.querySelector(HEADER_SELECTOR))) structural = true;
        }
      }
    }
    if (structural) schedule();
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  const rootObserver = new MutationObserver(schedule);
  rootObserver.observe(root, { attributes: true, attributeFilter: ['class', 'style'] });
  const headObserver = new MutationObserver(schedule);
  headObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
  window.addEventListener('resize', schedule);
  schedule();

  // Called by the native IME owner: move the layout into the visible region in
  // one web frame while native translation holds the pixels in place. Android
  // fences with its own visual-state callback; iOS awaits the returned paint.
  // Android only; the iOS keyboard owner never offsets the page (it keeps the
  // shell full height and pins the mirror for the whole keyboard session).
  win.__yuriImeOffset = (px: number) => {
    window.dispatchEvent(new Event('yuri:keyboard-native-layout'));
    root.style.setProperty(NATIVE_VIEWPORT_TOP_VAR, `${Math.max(0, px)}px`);
    return afterPaint();
  };

  // Called by ImeSyncBridge after it pinned (true) or before it drops (false)
  // the mirror. The page header's own panels stay visible either way.
  const headerWin = window as typeof window & { __yuriNativeHeader?: (on: boolean) => Promise<number> };
  headerWin.__yuriNativeHeader = (on: boolean) => {
    engaged = on;
    root.classList.toggle(READY_CLASS, on && source !== null);
    return afterPaint();
  };

  return () => {
    disposed = true;
    delete headerWin.__yuriNativeHeader;
    if (frame) cancelAnimationFrame(frame);
    observer.disconnect();
    rootObserver.disconnect();
    headObserver.disconnect();
    window.removeEventListener('resize', schedule);
    delete win.__yuriImeOffset;
    root.classList.remove(READY_CLASS);
    source?.classList.remove(SOURCE_CLASS);
    source = null;
    for (const handle of handles) void handle.then((h) => h.remove()).catch(() => undefined);
    void NativeHeader.update({ seq: ++seq, visible: false }).catch(() => undefined);
  };
}
