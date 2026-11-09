import type { RuntimeScope } from './runtime-scope';
export const desktopTabEventsComponent = 'yuri.desktop.tab-events';
export type DesktopTabHitRect = { x: number; y: number; width: number; height: number };
export type DesktopTabEventBinding = { owner: string; generation: number; revision: number; expectedHost: RuntimeScope; rect: DesktopTabHitRect; active: boolean };
export function desktopTabHitRect(rect: DesktopTabHitRect, viewport: DesktopTabHitRect): DesktopTabHitRect | null {
  const x = Math.max(rect.x, viewport.x), y = Math.max(rect.y, viewport.y);
  const width = Math.min(rect.x + rect.width, viewport.x + viewport.width) - x;
  const height = Math.min(rect.y + rect.height, viewport.y + viewport.height) - y;
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0 ? { x, y, width, height } : null;
}
/** This gate never trusts a native tab id. The caller's captured row closure owns
 * the id, membership, interaction and the real asynchronous dirty decision. */
export function createDesktopTabEventGate(input: {
  binding: () => DesktopTabEventBinding; current: () => boolean; enabled: () => boolean; modal: () => boolean;
  windows: boolean; middle: () => unknown; focus: () => void; blur: () => void;
}) {
  let alive = true, sequence = 0;
  function event(kind: 'middleClose' | 'tabFocus' | 'tabBlur', value: unknown): boolean {
    if (!alive || !input.current() || !value || typeof value !== 'object' || Array.isArray(value)) return false;
    const e = value as Record<string, unknown>, b = input.binding(), host = e.expectedHost as Record<string, unknown> | undefined;
    if (Object.keys(e).length !== 5 || e.owner !== b.owner || e.generation !== b.generation || e.revision !== b.revision
      || !host || Object.keys(host).length !== 2 || host.hostID !== b.expectedHost.hostID || host.lease !== b.expectedHost.lease
      || !Number.isSafeInteger(e.sequence) || (e.sequence as number) <= sequence) return false;
    sequence = e.sequence as number;
    if (kind === 'tabBlur') { if (input.windows) input.blur(); return true; }
    if (!b.active || !input.enabled() || input.modal()) return false;
    if (kind === 'middleClose') input.middle(); else if (input.windows) input.focus();
    return true;
  }
  return { event, dispose() { alive = false; } };
}
