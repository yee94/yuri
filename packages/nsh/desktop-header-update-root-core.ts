import type { PageOperation } from './page-operations';
import type { DesktopHeaderUpdatePort } from './desktop-header-services';
import type { SettingsAboutController } from './settings-about-core';
import { runtimeScopeFrom, sameRuntimeScope, type RuntimeScope } from './runtime-scope';
import type { createNativeDesktopHeaderUpdateOwner } from './desktop-header-update-native';

export type DesktopHeaderUpdateCommitted = { host: RuntimeScope; authorityKey: string };
export type DesktopHeaderUpdateRootOptions = {
  committed(): DesktopHeaderUpdateCommitted | null;
  operation(): PageOperation | null;
  /** Window lifetime only, never foreground/modal readiness. */
  current(): boolean;
};
type Source = ReturnType<typeof createNativeDesktopHeaderUpdateOwner>;
type SourceFactory = (options: Parameters<typeof createNativeDesktopHeaderUpdateOwner>[0]) => Source;
const sameIdentity = (left: DesktopHeaderUpdateCommitted, right: DesktopHeaderUpdateCommitted | null) => !!right && left.host.hostID === right.host.hostID && left.authorityKey === right.authorityKey;

/** One existing About owner, not a registry or another status source. Entirely zero-I/O. */
export function createDesktopHeaderUpdateRootController(options: DesktopHeaderUpdateRootOptions, createSource: SourceFactory, changed: () => void = () => {}) {
  type Entry = { committed: DesktopHeaderUpdateCommitted; operation: PageOperation | null; source: Source; unsubscribe(): void };
  let entry: Entry | null = null, retired = false;
  function committed(): DesktopHeaderUpdateCommitted | null {
    const value = options.committed();
    if (!value || typeof value.authorityKey !== 'string' || !value.authorityKey || value.authorityKey.trim() !== value.authorityKey) return null;
    try { const host = runtimeScopeFrom(value.host); return host ? { host, authorityKey: value.authorityKey } : null; }
    catch { return null; }
  }
  function operation(scope: DesktopHeaderUpdateCommitted): PageOperation | null {
    const value = options.operation();
    return value?.current() && sameRuntimeScope(value.scope, scope.host) ? value : null;
  }
  function usable(owning: Entry): boolean {
    return !retired && options.current() && entry === owning && sameIdentity(owning.committed, committed());
  }
  function admitted(owning: Entry): boolean {
    const scope = committed();
    return usable(owning) && !!scope && sameRuntimeScope(owning.committed.host, scope.host)
      && owning.operation !== null && operation(scope) === owning.operation;
  }
  function reconcile(): boolean {
    if (retired || !options.current()) return false;
    const scope = committed();
    if (!scope) {
      if (entry?.operation) { entry.operation = null; entry.source.updateOperation(null); }
      return false;
    }
    if (entry && !sameIdentity(entry.committed, scope)) {
      // Real disposal only for a real authority transition, never as a canClose probe.
      if (!entry.source.dispose()) return false;
      entry.unsubscribe();
      entry = null;
    }
    const nextOperation = operation(scope);
    if (!entry) {
      const captured = { ...scope, host: { ...scope.host } };
      // The callback cannot be consulted before `owning` is assigned. The source
      // constructor is intentionally inert; no false placeholder identity is called.
      let owning!: Entry;
      const source = createSource({ current: () => !retired && options.current() && entry === owning,
        admitted: () => admitted(owning), operation: nextOperation });
      owning = { committed: captured, operation: nextOperation, source, unsubscribe: source.about.subscribe(changed) };
      entry = owning;
      changed();
      return true;
    }
    entry.committed = scope;
    if (entry.operation !== nextOperation) { entry.operation = nextOperation; entry.source.updateOperation(nextOperation); }
    return true;
  }
  const port: DesktopHeaderUpdatePort = {
    async read(intent) {
      if (!intent.current() || !reconcile() || !entry || !admitted(entry)) throw new Error('about_root_unavailable');
      const owning = entry, captured = owning.operation;
      const current = () => intent.current() && admitted(owning) && owning.operation === captured;
      const result = await owning.source.port.read({ current });
      if (!current()) throw new Error('about_root_stale');
      return result;
    },
    nativeGate: () => false,
    available: () => false,
    run: async intent => ({ status: intent.current() && reconcile() && entry && admitted(entry) ? 'unsupported' : 'stale' }),
  };
  return {
    port, reconcile,
    about(): SettingsAboutController | undefined { return reconcile() && entry && usable(entry) ? entry.source.about : undefined; },
    /** State/actual in-flight guard only: no reads, reconciliation or disposal. */
    canClose: () => !entry || entry.source.canClose(),
    dispose(): boolean {
      if (entry && !entry.source.dispose()) { retired = true; entry.source.retire(); changed(); return false; }
      entry?.unsubscribe(); retired = true; entry = null; changed(); return true;
    },
    retire() { retired = true; entry?.source.retire(); changed(); },
  };
}
