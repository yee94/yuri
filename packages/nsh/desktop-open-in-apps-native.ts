import { createDesktopOpenInApps } from './desktop-open-in-apps';
import { native } from './runtime';

/** Device catalog only; root supplies its existing window-local actual directory and captured lease. */
export function createNativeDesktopOpenInApps(options: Omit<Parameters<typeof createDesktopOpenInApps>[0], 'call'>) {
  return createDesktopOpenInApps({ ...options, call: (method, body) => native(method, body) });
}
