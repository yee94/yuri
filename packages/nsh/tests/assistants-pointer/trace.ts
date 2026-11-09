import { signal, untracked } from 'nsh';

export const pointerEvents = [
  'start', 'claim-yes', 'claim-no', 'grant', 'grant-rejected', 'move', 'move-rejected',
  'multitouch-cancel', 'release', 'terminate', 'block-yes', 'block-no', 'termination-request',
  'retire-binding', 'retire-generation', 'retire-pinned', 'retire-disabled',
  'close-disabled', 'close-pinned', 'close-unrevealed', 'close-cleanup', 'close-accessibility',
  'offset-zero', 'offset-partial', 'offset-open', 'open', 'menu', 'edit', 'delete', 'cancel',
  'reveal', 'rebind', 'disable', 'pin', 'mode-fixed', 'mode-working', 'refresh',
] as const;
export type PointerEvent = typeof pointerEvents[number];
const events = signal<PointerEvent[]>([]);

export function record(event: PointerEvent) {
  untracked(() => {
    if (!pointerEvents.includes(event)) throw new Error('Unknown pointer event');
    events.set([...events(), event].slice(-64));
  });
}
export function resetTrace() { untracked(() => events.set([])); }
export const readTrace = () => events();
