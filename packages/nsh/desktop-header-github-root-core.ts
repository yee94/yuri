import { createDesktopHeaderGitHubSource, type DesktopHeaderGitHubGuard, type DesktopHeaderGitHubOperation, type DesktopHeaderGitHubPort, type DesktopHeaderGitHubSource, type DesktopHeaderGitHubState } from './desktop-header-github-core';
import type { GitHubDependencies, GitHubState } from './settings-github-core';
import { sameRuntimeScope, type RuntimeScope } from './runtime-scope';

export type DesktopGitHubCommittedScope = { host: RuntimeScope; authorityKey: string; directory: string };
export type DesktopHeaderGitHubRootOptions = {
  /** Actual committed identity, never a selected menu item or a saved route. */
  committed: () => DesktopGitHubCommittedScope | null;
  current: () => boolean;
  operation: () => DesktopHeaderGitHubOperation | null;
  active: () => boolean;
  interactive: () => boolean;
  changed?: () => void;
};
const empty: DesktopHeaderGitHubState = { projection: null, reading: false, busy: false, stale: false, issue: null, pending: null };
const unavailable = async () => ({ status: 'unavailable' as const });
const settingsLocked = (state: GitHubState | null) => !!state && (state.busy || state.refreshing || state.exchanging || state.needsReadback || !!state.pending || !!state.flow || !!state.removal || state.cancellation === 'stopping' || state.cancellation === 'unknown');
const same = (left: DesktopGitHubCommittedScope, right: DesktopGitHubCommittedScope | null) => !!right && left.authorityKey === right.authorityKey && left.directory === right.directory && sameRuntimeScope(left.host, right.host);

/** One retained source for this window. No parallel Host-global writer on a
 * directory/lease change: a refused disposal retains the old entry and its lock. */
export function createDesktopHeaderGitHubRootController(options: DesktopHeaderGitHubRootOptions) {
  type Entry = { scope: DesktopGitHubCommittedScope; source: DesktopHeaderGitHubSource; header: DesktopHeaderGitHubPort };
  let entry: Entry | null = null, disposed = false;
  let registration: { entry: Entry; bridge: ReturnType<DesktopHeaderGitHubSource['settings']>; state: GitHubState | null; mounted: boolean } | null = null;
  const notify = () => options.changed?.();
  const usable = () => !disposed && options.current() && !!entry && same(entry.scope, options.committed());
  const locked = () => !!entry && (entry.source.state().busy || !!entry.source.state().pending) || !!registration && (!registration.mounted || settingsLocked(registration.state));
  function reconcile() {
    if (disposed || !options.current()) return false;
    const scope = options.committed();
    if (!scope?.host.hostID || !scope.host.lease || !scope.authorityKey || !scope.directory) return false;
    if (entry && same(entry.scope, scope)) return true;
    // Do not use dispose() as a speculative canClose probe. A mounted page owns
    // its original controller even while idle, and cleanup can itself refuse.
    if (registration || locked()) return false;
    if (entry && !entry.source.dispose()) return false;
    const captured = { ...scope, host: { ...scope.host } };
    const identity = () => !disposed && options.current() && captured.authorityKey === options.committed()?.authorityKey && sameRuntimeScope(captured.host, options.committed()?.host ?? null);
    const source = createDesktopHeaderGitHubSource({ scope: captured, current: identity, operation: options.operation, changed: notify });
    const header = source.header({ current: identity, directory: () => options.committed()?.directory ?? '', active: options.active, interactive: options.interactive, operation: options.operation });
    entry = { scope: captured, source, header }; notify(); return true;
  }
  const header: DesktopHeaderGitHubPort = {
    state: () => entry?.source.state() ?? empty,
    visible: () => usable() && entry!.header.visible(),
    interactive: () => usable() && entry!.header.interactive(),
    available: () => usable() && entry!.header.available(),
    ensure: () => reconcile() ? entry!.header.ensure() : unavailable(),
    refresh: () => reconcile() ? entry!.header.refresh() : unavailable(),
    select: key => usable() ? entry!.header.select(key) : unavailable(),
  };
  function settings(guard: DesktopHeaderGitHubGuard, open: GitHubDependencies['open']) {
    if (registration || !reconcile() || !usable() || guard.directory() !== entry!.scope.directory || !guard.current()) return null;
    const owning = entry!, bridge = owning.source.settings(guard, open);
    const record = { entry: owning, bridge, state: null as GitHubState | null, mounted: true };
    registration = record; notify();
    const dependencies: GitHubDependencies = { ...bridge.dependencies, changed(value) {
      record.state = value; bridge.dependencies.changed?.(value); notify();
    } };
    return { dependencies,
      canRelease: () => registration === record && !settingsLocked(record.state) && !owning.source.state().busy && !owning.source.state().pending,
      release() {
        if (registration !== record) return true;
        if (settingsLocked(record.state)) return false;
        if (!bridge.dispose()) return false;
        registration = null; notify(); return true;
      },
      detach() {
        if (registration !== record) return true;
        if (!settingsLocked(record.state) && bridge.dispose()) { registration = null; notify(); return true; }
        // Forced retirement cannot erase an unknown receipt. No remount/new
        // registration is allowed to launder it into an unlocked controller.
        record.mounted = false; notify(); return false;
      },
    };
  }
  return { header, reconcile, settings,
    state: () => entry?.source.state() ?? empty,
    canClose: () => !locked(),
    dispose() {
      if (disposed) return !entry && !registration;
      if (registration || locked() || entry && !entry.source.dispose()) return false;
      disposed = true; entry = null; notify(); return true;
    },
    /** Final root teardown revokes late callbacks but keeps refused disposal
     * represented. It never grants a replacement writer. */
    retire() { disposed = true; entry?.source.retire(); notify(); },
  };
}
