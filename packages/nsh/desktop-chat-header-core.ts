import type { ChatHeaderMetadata } from './chat-header-metadata';

/** Desktop Web Header actions only. Mobile workspace actions keep their original owners. */
export type DesktopChatHeaderAction = 'mini-chat' | 'terminal' | 'browser' | 'context' | 'work-status' | 'toggle-panel' | 'open-app' | 'copy-path' | 'select-app' | 'scan-apps' | 'github-account' | 'refresh-usage' | 'quota-mode';
export type DesktopChatHeaderResult = { status: 'accepted' | 'unsupported' | 'failed' | 'unknown' | 'stale' };
export type DesktopChatHeaderIntent = {
  action: DesktopChatHeaderAction;
  /** Captured exact route/Host/lease identity; not a directory or title heuristic. */
  scope: unknown;
  value?: string;
  /** Consumers must recheck immediately before navigation/write and after awaits. */
  current: () => boolean;
};
export type DesktopChatHeaderPort = {
  available: boolean;
  run: (intent: DesktopChatHeaderIntent) => DesktopChatHeaderResult | Promise<DesktopChatHeaderResult>;
};
export type DesktopChatHeaderActions = Partial<Record<DesktopChatHeaderAction, DesktopChatHeaderPort>>;

/** Presentation constants from Web Header / ContextUsageDisplay, not phone chrome. */
export const desktopChatHeaderLayout = Object.freeze({
  height: 48, gap: 4, menuButton: 32, iconButton: 28, icon: 16,
  contextRing: 16, ringViewBox: 18, ringStroke: 2, splitButton: 48,
  menuWidth: 224, servicesWidth: 432, popupOffset: 6, popupMargin: 12,
});

export function desktopHeaderContext(metadata: ChatHeaderMetadata | undefined) {
  if (!metadata) return null;
  const finite = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const known = !metadata.contextStale && !metadata.pending && finite(metadata.tokens) && finite(metadata.limit) && metadata.limit > 0;
  if (!known && !metadata.pending) return null;
  return { pending: metadata.pending === true, tokens: known ? metadata.tokens! : null,
    limit: finite(metadata.limit) ? metadata.limit! : null,
    percentage: known ? Math.min(999, metadata.tokens! / metadata.limit! * 100) : null,
    progress: known ? Math.min(1, metadata.tokens! / metadata.limit!) : 0 };
}

/** No transport, catalog, Chat or optimistic state. One admitted consumer flight.
 * Retired callbacks cannot execute against a later Host, even after a resume. */
export function createDesktopChatHeaderActions(options: {
  scope: () => unknown; current: () => boolean;
  operation?: () => { current(): boolean } | null | undefined;
  actions: () => DesktopChatHeaderActions | undefined;
  changed?: (pending: boolean) => void;
}) {
  let alive = true, revision = 0, pending = false;
  const capturedScope = options.scope();
  const current = () => alive && options.scope() === capturedScope && options.current() && (!options.operation || options.operation()?.current() === true);
  const available = (action: DesktopChatHeaderAction) => current() && !pending && options.actions()?.[action]?.available === true;
  async function run(action: DesktopChatHeaderAction, value?: string): Promise<DesktopChatHeaderResult> {
    if (!current()) return { status: 'stale' };
    const port = options.actions()?.[action];
    if (pending || !port?.available) return { status: 'unsupported' };
    const operation = options.operation?.();
    const ticket = ++revision;
    const admitted = () => current() && ticket === revision && options.actions()?.[action] === port && port.available
      && (!options.operation || options.operation() === operation && operation?.current() === true);
    pending = true; options.changed?.(true);
    try {
      if (!admitted()) return { status: 'stale' };
      const result = await port.run({ action, scope: capturedScope, value, current: admitted });
      if (!admitted()) return { status: 'stale' };
      if (!result || !['accepted', 'unsupported', 'failed', 'unknown'].includes(result.status)) return { status: 'unknown' };
      return result;
    } catch { return { status: admitted() ? 'unknown' : 'stale' }; }
    finally { if (ticket === revision) { pending = false; options.changed?.(false); } }
  }
  return { current, available, run,
    invalidate() { revision++; pending = false; options.changed?.(false); },
    dispose() { alive = false; revision++; pending = false; },
  };
}
