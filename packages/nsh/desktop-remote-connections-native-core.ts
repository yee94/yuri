import { DesktopSshDenied, DesktopSshNotDispatched, desktopSshInstance, desktopSshSnapshot, type DesktopRemoteConnectionsPort } from './desktop-remote-connections-core';

export type DesktopSshNativeMethod = 'desktop.ssh.capabilities' | 'desktop.ssh.read' | 'desktop.ssh.save' | 'desktop.ssh.remove' | 'desktop.ssh.start' | 'desktop.ssh.cancel';
export type DesktopSshNativeSource = {
  available(): boolean;
  call(name: DesktopSshNativeMethod, input: unknown, options: { timeout: number }): Promise<unknown>;
};
export type NativeDesktopRemoteConnectionsPort = DesktopRemoteConnectionsPort & { readonly syncSupported: false; ready(): boolean; refreshCapabilities(): Promise<void>; dispose(): void };
export const DESKTOP_SSH_NATIVE_TIMEOUTS = Object.freeze({ capabilities: 5000, operation: 30000 });
const maximum = 9_007_199_254_740_000;
const invalid = () => new DesktopSshDenied('ssh_invalid');
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) throw invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw invalid();
  return value;
}
function integer(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid();
  return value;
}
function connectionOnly(value: unknown): boolean {
  const row = exact(value, ['version', 'connections', 'sync']);
  const connections = exact(row.connections, ['supported', 'phase', 'maxPending']), sync = exact(row.sync, ['supported']);
  return row.version === 1 && connections.supported === true && connections.phase === 'ready' && connections.maxPending === 16 && sync.supported === false;
}
function rejection(error: unknown): Error {
  // native_ssh_bridge::settle flattens Outcome. Only codes guaranteed Denied
  // by ssh_service::worker (plus original mailbox Busy) prove non-commit.
  const code = error instanceof Error && 'code' in error && error.code === 'ERR_NSH_HOST_ERROR' ? error.message : '';
  if (code === 'native_host_busy') return new DesktopSshDenied('ssh_busy');
  if (code === 'ssh_invalid' || code === 'ssh_stale' || code === 'ssh_busy' || code === 'ssh_storage' || code === 'ssh_authentication') return new DesktopSshDenied(code);
  return new Error('ssh_unknown');
}

/** No read, SSH attempt or write during discovery. The source is the local Host, not selected runtime authority. */
export async function loadDesktopRemoteConnectionsNative(options: {
  source(): DesktopSshNativeSource | undefined;
  current(): boolean;
  /** Required to enable operations; omission is deliberately fail-closed. */
  runtimeReady?(): boolean;
}): Promise<NativeDesktopRemoteConnectionsPort | undefined> {
  try {
    const source = options.source();
    if (!source) return undefined;
    const available = source.available, call = source.call;
    let alive = true, supported = false, generation = 0, operationEpoch = 0;
    let pending: Promise<void> | null = null;
    const current = () => {
      if (!alive) return false;
      try { alive = options.current() && options.source() === source && source.available === available && source.call === call; }
      catch { alive = false; }
      return alive;
    };
    const runtimeReady = () => {
      let ready = false;
      try { ready = current() && options.runtimeReady?.() === true && available.call(source); } catch { /* Remain live but unavailable until explicit refresh. */ }
      if (!ready) { supported = false; pending = null; ++generation; ++operationEpoch; }
      return ready;
    };
    const ready = () => runtimeReady() && supported;
    async function refreshCapabilities(): Promise<void> {
      if (!runtimeReady()) return;
      if (pending) return pending;
      const turn = ++generation;
      const operation = Promise.resolve().then(async () => {
        if (!runtimeReady() || turn !== generation) return;
        try {
          const caps = await call.call(source!, 'desktop.ssh.capabilities', {}, { timeout: DESKTOP_SSH_NATIVE_TIMEOUTS.capabilities });
          if (runtimeReady() && turn === generation) {
            const next = connectionOnly(caps);
            if (supported && !next) ++operationEpoch;
            supported = next;
          }
        } catch {
          if (turn === generation) { if (supported) ++operationEpoch; supported = false; throw new Error('ssh_unavailable'); }
        } finally { if (turn === generation) pending = null; }
      });
      pending = operation; return operation;
    }
    await refreshCapabilities();
    if (!ready()) return undefined;
    // A per-window JS owner namespace, not a native window ID (the frozen DTO
    // does not issue one). CSPRNG + monotonic counter also avoids restart reuse.
    const namespace = `ssh_${id(crypto.randomUUID())}`;
    let serial = 0;
    const newID = () => {
      if (serial >= Number.MAX_SAFE_INTEGER) throw new DesktopSshDenied('ssh_stale');
      return `${namespace}_${++serial}`;
    };
    async function invoke(name: DesktopSshNativeMethod, input: unknown) {
      if (!current()) throw new DesktopSshDenied('ssh_stale');
      if (!ready()) throw new DesktopSshNotDispatched();
      const capturedEpoch = operationEpoch;
      let result: unknown;
      try { result = await call.call(source!, name, input, { timeout: DESKTOP_SSH_NATIVE_TIMEOUTS.operation }); }
      catch (error) {
        if (!current() || !runtimeReady() || capturedEpoch !== operationEpoch) throw new Error('ssh_unknown');
        throw rejection(error);
      }
      // Late/malformed mutation ACKs are unknown, never definite rejections.
      if (!current() || !runtimeReady() || capturedEpoch !== operationEpoch) throw new Error('ssh_unknown');
      try { return desktopSshSnapshot(result); } catch { throw new Error('ssh_unknown'); }
    }
    return Object.freeze({
      current, ready, refreshCapabilities, newID, syncSupported: false as const,
      read: () => invoke('desktop.ssh.read', {}),
      async save(input) {
        const row = exact(input, ['requestID', 'revision', 'instance']);
        let instance;
        try { instance = desktopSshInstance(row.instance); } catch { throw invalid(); }
        return invoke('desktop.ssh.save', { requestID: id(row.requestID), revision: integer(row.revision, 0), instance });
      },
      async remove(input) {
        const row = exact(input, ['requestID', 'revision', 'id']);
        return invoke('desktop.ssh.remove', { requestID: id(row.requestID), revision: integer(row.revision, 0), id: id(row.id) });
      },
      async start(input) {
        const row = exact(input, ['requestID', 'id', 'intent']);
        if (row.intent !== 'connect' && row.intent !== 'restore' && row.intent !== 'check') throw invalid();
        return invoke('desktop.ssh.start', { requestID: id(row.requestID), id: id(row.id), intent: row.intent });
      },
      async cancel(input) {
        const row = exact(input, ['id', 'attempt']);
        return invoke('desktop.ssh.cancel', { id: id(row.id), attempt: integer(row.attempt, 1) });
      },
      dispose() { alive = false; supported = false; pending = null; ++generation; },
    } satisfies NativeDesktopRemoteConnectionsPort);
  } catch { return undefined; }
}
