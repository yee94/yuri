import React from 'react';

/**
 * Android Chromium hit-tests `touch-action` on the compositor, where transformed
 * or zoomed layers can expose a stale region and start a native pan that
 * pointercancels our drag/pinch/tap. A non-passive `touchmove` that cancels the
 * default forces the browser to wait for script. Use this on every surface that
 * owns its own touch gestures (viewer canvases, remote desktop); never on
 * scrollable transcripts.
 */
export function lockNativeTouchPan(element: HTMLElement): () => void {
  const prevent = (event: TouchEvent) => {
    if (event.cancelable) event.preventDefault();
  };
  element.addEventListener('touchmove', prevent, { passive: false });
  return () => element.removeEventListener('touchmove', prevent);
}

export function useNativeTouchPanLock(ref: React.RefObject<HTMLElement | null>, enabled = true): void {
  React.useEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    return lockNativeTouchPan(element);
  }, [ref, enabled]);
}
