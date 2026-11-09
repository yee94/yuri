import type { DesktopChatHeaderActions, DesktopChatHeaderIntent, DesktopChatHeaderResult } from './desktop-chat-header-core';
import { runtimeScopeFrom, sameRuntimeScope, type RuntimeScope } from './runtime-scope';

export type DesktopOpenInApp = Readonly<{ id: string; label: string; version?: string }>;
export type DesktopOpenInAppsCapabilities = Readonly<{
  version: 1; platform: 'macos' | 'windows';
  discovery: { supported: true; source: 'workspace' | 'app-paths' };
  selection: { supported: true; persistence: 'process' };
  open: { supported: false; reason: 'local_directory_mapping_unavailable' };
}>;
export type DesktopOpenInAppsSnapshot = Readonly<{
  version: 1; revision: number; apps: readonly DesktopOpenInApp[]; selectedID: string;
  scanning: boolean; stale: boolean; error: null | 'discovery_failed';
}>;
export type DesktopOpenInAppsTarget = Readonly<{ scope: unknown; expectedHost: RuntimeScope; directory: string }>;
export type DesktopOpenInAppsProjection = {
  applicable: boolean; selectedID?: string; apps: { id: string; label: string; icon?: string }[];
  scanning: boolean; stale: boolean;
};
type Call = (method: string, body: Record<string, unknown>) => Promise<unknown>;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('open_in_apps_invalid_response');
  return value as Record<string, unknown>;
};
function exact(value: unknown, keys: string[]) {
  const row = record(value);
  if (Object.keys(row).sort().join(',') !== keys.sort().join(',')) throw new Error('open_in_apps_invalid_response');
  return row;
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
export function desktopOpenInAppsCapabilities(value: unknown): DesktopOpenInAppsCapabilities {
  const row = exact(value, ['version', 'platform', 'discovery', 'selection', 'open']);
  const discovery = exact(row.discovery, ['supported', 'source']);
  const selection = exact(row.selection, ['supported', 'persistence']);
  const open = exact(row.open, ['supported', 'reason']);
  if (row.version !== 1 || !['macos', 'windows'].includes(String(row.platform)) || discovery.supported !== true
    || discovery.source !== (row.platform === 'macos' ? 'workspace' : 'app-paths') || selection.supported !== true
    || selection.persistence !== 'process' || open.supported !== false || open.reason !== 'local_directory_mapping_unavailable') {
    throw new Error('open_in_apps_unsupported_contract');
  }
  // v1 deliberately cannot represent open:true; a real mapping requires a new native contract.
  return { version: 1, platform: row.platform as 'macos' | 'windows',
    discovery: { supported: true, source: discovery.source as 'workspace' | 'app-paths' },
    selection: { supported: true, persistence: 'process' },
    open: { supported: false, reason: 'local_directory_mapping_unavailable' } };
}
export function desktopOpenInAppsSnapshot(value: unknown): DesktopOpenInAppsSnapshot {
  const row = exact(value, ['version', 'revision', 'apps', 'selectedID', 'scanning', 'stale', 'error']);
  if (row.version !== 1 || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 0
    || !Array.isArray(row.apps) || row.apps.length > 25 || !text(row.selectedID, 128)
    || typeof row.scanning !== 'boolean' || typeof row.stale !== 'boolean' || row.error !== null && row.error !== 'discovery_failed') {
    throw new Error('open_in_apps_invalid_response');
  }
  const seen = new Set<string>();
  const apps = row.apps.map(value => {
    const app = record(value);
    exact(app, app.version === undefined ? ['id', 'label'] : ['id', 'label', 'version']);
    if (!text(app.id, 128) || !/^[a-z][a-z0-9-]*$/.test(app.id) || !text(app.label, 512)
      || seen.has(app.id) || app.version !== undefined && !text(app.version, 128)) throw new Error('open_in_apps_invalid_response');
    seen.add(app.id);
    return Object.freeze({ id: app.id, label: app.label, ...(app.version === undefined ? {} : { version: app.version }) });
  });
  return Object.freeze({ version: 1, revision: row.revision, apps: Object.freeze(apps), selectedID: row.selectedID,
    scanning: row.scanning, stale: row.stale, error: row.error });
}

/** One window root owns this producer. No effects, polling, storage, catalog guesses or Host HTTP. */
export function createDesktopOpenInApps(options: {
  call: Call; current(): boolean; target(): DesktopOpenInAppsTarget | null;
  copyPath?(directory: string, current: () => boolean): Promise<DesktopChatHeaderResult>;
  changed?(): void;
}) {
  let alive = true, revision = 0;
  let capabilities: DesktopOpenInAppsCapabilities | null = null;
  let snapshot: DesktopOpenInAppsSnapshot | null = null;
  let error: 'unsupported' | 'read_failed' | 'discovery_failed' | null = null;
  let readFlight: Promise<DesktopChatHeaderResult> | null = null;
  let scanFlight: Promise<DesktopChatHeaderResult> | null = null;
  let projected: DesktopOpenInAppsProjection | null = null;
  let projectedSnapshot: DesktopOpenInAppsSnapshot | null = null;
  const current = () => alive && options.current();
  const notify = () => { if (current()) options.changed?.(); };
  const publish = (next: DesktopOpenInAppsSnapshot) => {
    if (!snapshot || next.revision >= snapshot.revision) { snapshot = next; error = next.error; }
  };
  function capture(intent: DesktopChatHeaderIntent) {
    const target = options.target();
    if (!current() || !intent.current() || !target || target.scope !== intent.scope || !text(target.directory, 32768)) return null;
    const expectedHost = runtimeScopeFrom(target.expectedHost);
    if (!expectedHost) return null;
    const captured = { scope: target.scope, directory: target.directory, expectedHost };
    return { ...captured, current: () => {
      const now = options.target();
      return current() && intent.current() && !!now && now.scope === captured.scope && now.directory === captured.directory
        && sameRuntimeScope(now.expectedHost, captured.expectedHost);
    } };
  }
  function read(): Promise<DesktopChatHeaderResult> {
    if (readFlight) return readFlight;
    if (!current()) return Promise.resolve({ status: 'stale' });
    const ticket = revision;
    readFlight = (async (): Promise<DesktopChatHeaderResult> => {
      try {
        await Promise.resolve();
        if (!current() || revision !== ticket) return { status: 'stale' };
        const caps = desktopOpenInAppsCapabilities(await options.call('desktop.openInApps.capabilities', {}));
        if (!current() || revision !== ticket) return { status: 'stale' };
        const next = desktopOpenInAppsSnapshot(await options.call('desktop.openInApps.read', {}));
        if (!current() || revision !== ticket) return { status: 'stale' };
        capabilities = caps; publish(next); notify();
        return { status: 'accepted' };
      } catch {
        if (!current() || revision !== ticket) return { status: 'stale' };
        error = capabilities ? 'read_failed' : 'unsupported'; notify(); return { status: capabilities ? 'failed' : 'unsupported' };
      } finally { readFlight = null; }
    })();
    return readFlight;
  }
  function scan(intent: DesktopChatHeaderIntent): Promise<DesktopChatHeaderResult> {
    if (scanFlight) return scanFlight;
    const captured = capture(intent);
    if (!captured) return Promise.resolve({ status: 'stale' });
    if (!capabilities) return Promise.resolve({ status: 'unsupported' });
    const ticket = revision;
    scanFlight = (async (): Promise<DesktopChatHeaderResult> => {
      try {
        await Promise.resolve();
        if (!captured.current() || revision !== ticket) return { status: 'stale' };
        const next = desktopOpenInAppsSnapshot(await options.call('desktop.openInApps.scan', {}));
        if (!captured.current() || revision !== ticket) return { status: 'stale' };
        publish(next); notify(); return { status: 'accepted' };
      } catch {
        if (!captured.current() || revision !== ticket) return { status: 'stale' };
        error = 'discovery_failed'; notify(); return { status: 'failed' };
      } finally { scanFlight = null; notify(); }
    })();
    notify();
    return scanFlight;
  }
  async function run(intent: DesktopChatHeaderIntent): Promise<DesktopChatHeaderResult> {
    const captured = capture(intent);
    if (!captured) return { status: 'stale' };
    if (intent.action === 'copy-path') {
      if (!options.copyPath) return { status: 'unsupported' };
      try {
        const result = await options.copyPath(captured.directory, captured.current);
        return captured.current() ? result : { status: 'stale' };
      } catch { return { status: captured.current() ? 'failed' : 'stale' }; }
    }
    if (intent.action === 'scan-apps') return scan(intent);
    if (!capabilities) return { status: 'unsupported' };
    if (intent.action === 'select-app') {
      if (!snapshot?.apps.some(app => app.id === intent.value)) return { status: 'unsupported' };
      try {
        const next = desktopOpenInAppsSnapshot(await options.call('desktop.openInApps.select', { appID: intent.value }));
        if (!captured.current()) return { status: 'stale' };
        if (next.selectedID !== intent.value) return { status: 'unknown' };
        publish(next); notify();
        // Web menu selects then opens. Selection succeeds, but no local-mapping grant exists.
        return { status: 'unsupported' };
      } catch { return { status: captured.current() ? 'unknown' : 'stale' }; }
    }
    return { status: 'unsupported' };
  }
  const available = () => current() && options.target() !== null;
  const actions: DesktopChatHeaderActions = {
    'open-app': { get available() { return false; }, run },
    'copy-path': { get available() { return available() && !!options.copyPath; }, run },
    'select-app': { get available() { return available() && capabilities !== null; }, run },
    'scan-apps': { get available() { return available() && capabilities !== null; }, run },
  };
  return {
    read, run, actions,
    get capabilities() { return capabilities; },
    get snapshot() { return snapshot; },
    get error() { return error; },
    project(): DesktopOpenInAppsProjection {
      const scanning = scanFlight !== null || snapshot?.scanning === true;
      const stale = error !== null || snapshot?.stale !== false;
      if (projected && projectedSnapshot === snapshot && projected.scanning === scanning && projected.stale === stale) return projected;
      const apps = snapshot?.apps ?? [];
      const selectedID = apps.find(app => app.id === snapshot?.selectedID)?.id ?? apps.find(app => app.id === 'finder')?.id ?? apps[0]?.id;
      projectedSnapshot = snapshot;
      projected = {
        // As on Web's remote-without-handoff branch: no extra entry until native mapping exists.
        applicable: false, apps: apps.map(({ id, label }) => ({ id, label })), selectedID,
        scanning, stale,
      };
      return projected;
    },
    dispose() { alive = false; revision++; },
  };
}
