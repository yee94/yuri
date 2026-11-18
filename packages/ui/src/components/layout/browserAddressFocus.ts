const FOCUS_EVENT = 'yuri:focus-browser-address';
const PENDING_TTL_MS = 3000;

let pendingUntil = 0;

/**
 * Ask the visible browser pane to focus its address bar. The pane may not be
 * mounted or active yet (the shortcut opens the panel in the same tick), so the
 * request stays pending briefly and is consumed by the first active pane.
 */
export const requestBrowserAddressFocus = (): void => {
  pendingUntil = Date.now() + PENDING_TTL_MS;
  window.dispatchEvent(new Event(FOCUS_EVENT));
};

const takePendingBrowserAddressFocus = (): boolean => {
  const pending = Date.now() <= pendingUntil;
  pendingUntil = 0;
  return pending;
};

/**
 * Subscribe an active browser pane to address-bar focus requests, including one
 * raised before the pane became active. Returns the unsubscribe function.
 */
export const subscribeBrowserAddressFocus = (input: () => HTMLInputElement | null): (() => void) => {
  const focusPending = () => {
    const element = input();
    if (!element || !takePendingBrowserAddressFocus()) return;
    element.focus();
    element.select();
  };
  focusPending();
  window.addEventListener(FOCUS_EVENT, focusPending);
  return () => window.removeEventListener(FOCUS_EVENT, focusPending);
};
