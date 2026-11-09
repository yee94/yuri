import { parseBrowserProviderCatalog, parseBrowserProviderSelection, type BrowserProviderCatalog } from '../ui/src/lib/browser-provider/contract';
import { settingsObject, type SettingsRequest, type SettingsRequestLane } from './settings-protocol';

export type NativePasskeyRegistration = {
  authorizeManagement: () => Promise<void>;
  register: (input: { ceremonyID: string; optionsJSON: Record<string, unknown> }) => Promise<Record<string, unknown>>;
  cancel: (ceremonyID: string) => Promise<void>;
  authReset: () => Promise<void>;
};
export function nativePasskeyResponse(value: unknown): Record<string, unknown> & { id: string } {
  const row = settingsObject(value), response = settingsObject(row.response);
  if (typeof row.id !== 'string' || !row.id || typeof row.rawId !== 'string' || !row.rawId || row.type !== 'public-key' || typeof response.clientDataJSON !== 'string' || !response.clientDataJSON || typeof response.attestationObject !== 'string' || !response.attestationObject || !row.clientExtensionResults || typeof row.clientExtensionResults !== 'object') throw new Error('passkey-response-invalid');
  return { ...row, id: row.id };
}
export type NativeStoredPasskey = { id: string; label: string; createdAt: number; lastUsedAt: number | null };
let nextCeremonyID = 0;
export type SessionsState = { settings: Record<string, unknown> | null; browsers: BrowserProviderCatalog | null; passkeys: NativeStoredPasskey[] | null; enabled: boolean | null; registering: boolean };
export function normalizeCliPath(value: string) {
  const trimmed = value.trim();
  return trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) ? trimmed.slice(1, -1).trim() : trimmed;
}

/** Each resource has its own read/recovery lane; unknown writes are never replayed. */
export function createSettingsSessions(input: { send: SettingsRequest; current: () => boolean; capture?: () => SettingsRequestLane | null; native: NativePasskeyRegistration; changed: (state: SessionsState) => void }) {
  let state: SessionsState = { settings: null, browsers: null, passkeys: null, enabled: null, registering: false };
  let ceremony = 0, registering: string | null = null, pendingCli: { path: string; phase: 'write' | 'reload' | 'reload-unknown' | 'read' } | null = null;
  let pendingSelection: string | null = null, pendingDelete: string | null = null, resetPending = false, resetAcknowledged = false, pendingRegistrationID: string | null = null;
  let pendingNotification: boolean | null = null;
  let lifetime = 0;
  let needsManagementAuth = false;
  const pendingCancellation = new Set<string>();
  const publish = (patch: Partial<SessionsState>) => { if (input.current()) { state = { ...state, ...patch }; input.changed(state); } };
  const capture = () => {
    const ticket = lifetime;
    const lane = input.capture ? input.capture() : { request: input.send, current: input.current };
    if (!input.current() || !lane?.current()) throw new Error('settings_operation_stale');
    return { send: lane.request, check: () => { if (ticket !== lifetime || !input.current() || !lane.current()) throw new Error('settings_operation_stale'); } };
  };
  async function settings() { const { send, check } = capture(); check(); const value = settingsObject(await send('/api/config/settings')); check(); publish({ settings: value }); return value; }
  async function browsers() { const { send, check } = capture(); check(); const value = parseBrowserProviderCatalog(await send('/api/browser-providers')); check(); if (!value) throw new Error('browser-provider-invalid'); publish({ browsers: value }); return value; }
  async function readPasskeys() {
    const { send, check } = capture();
    check(); const status = settingsObject(await send('/auth/passkey/status')); check();
    if (typeof status.enabled !== 'boolean') throw new Error('passkey-status-invalid');
    publish({ enabled: status.enabled });
    if (!status.enabled) { publish({ passkeys: [] }); return []; }
    const result = settingsObject(await send('/api/passkeys')); check();
    if (!Array.isArray(result.passkeys)) throw new Error('passkey-list-invalid');
    const rows = result.passkeys.map(value => {
      const row = settingsObject(value);
      if (typeof row.id !== 'string' || !row.id || typeof row.label !== 'string' || typeof row.createdAt !== 'number' || !(row.lastUsedAt === null || typeof row.lastUsedAt === 'number')) throw new Error('passkey-list-invalid');
      return { id: row.id, label: row.label, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt } as NativeStoredPasskey;
    });
    publish({ passkeys: rows }); return rows;
  }
  async function passkeys() {
    try { const rows = await readPasskeys(); needsManagementAuth = false; return rows; }
    catch (error) { if ((error as { status?: unknown } | null)?.status === 401) needsManagementAuth = true; throw error; }
  }
  async function cancel() {
    const id = registering; ceremony++; registering = null; publish({ registering: false });
    if (id) pendingCancellation.add(id);
    await Promise.all([...pendingCancellation].map(async pending => { await input.native.cancel(pending); pendingCancellation.delete(pending); }));
  }
  return {
    snapshot: () => state, settings, browsers, passkeys, cancel,
    async retryPasskeys() {
      const { check } = capture();
      if (needsManagementAuth) { await input.native.authorizeManagement(); check(); }
      return passkeys();
    },
    invalidate() { lifetime++; return cancel(); },
    async saveCli(value: string) {
      const { send, check } = capture();
      check();
      if (!pendingCli) { pendingCli = { path: normalizeCliPath(value), phase: 'write' }; await send('/api/config/settings', 'PUT', { opencodeBinary: pendingCli.path }); check(); pendingCli.phase = 'reload'; }
      if (pendingCli.phase === 'write') {
        const result = await settings();
        if (result.opencodeBinary !== pendingCli.path) throw new Error('cli-save-unconfirmed');
        pendingCli.phase = 'reload';
      }
      if (pendingCli.phase === 'reload') {
        pendingCli.phase = 'reload-unknown';
        const result = settingsObject(await send('/api/config/reload', 'POST')); check();
        if (result.success !== true) throw new Error('cli-reload-unconfirmed');
        pendingCli.phase = 'read';
      }
      if (pendingCli.phase === 'reload-unknown') { await settings(); throw new Error('cli-reload-unconfirmed'); }
      await settings(); pendingCli = null;
    },
    async notifications(enabled: boolean) {
      const { send, check } = capture(); check();
      if (pendingNotification === null) { pendingNotification = enabled; await send('/api/config/settings', 'PUT', { showOpenCodeUpdateNotifications: enabled }); check(); }
      const result = await settings(); check();
      if (result.showOpenCodeUpdateNotifications !== pendingNotification) throw new Error('notification-save-unconfirmed');
      pendingNotification = null;
    },
    async selectBrowser(id: string) {
      const { send, check } = capture();
      check();
      if (!pendingSelection) {
        if (!state.browsers?.providers.some(row => row.id === id) || state.browsers.selectedId === id) return;
        pendingSelection = id;
        const response = parseBrowserProviderSelection(await send('/api/browser-providers/selection', 'PUT', { id })); check();
        if (!response || response.selectedId !== id) throw new Error('browser-selection-unconfirmed');
      }
      const result = await browsers();
      if (result.selectedId !== pendingSelection) throw new Error('browser-selection-unconfirmed');
      pendingSelection = null;
    },
    async removePasskey(id: string) {
      const { send, check } = capture();
      check();
      if (!pendingDelete) {
        if (!state.passkeys?.some(row => row.id === id)) return;
        pendingDelete = id; await send(`/api/passkeys/${encodeURIComponent(id)}`, 'DELETE'); check();
      }
      if ((await passkeys()).some(row => row.id === pendingDelete)) throw new Error('passkey-delete-unconfirmed');
      pendingDelete = null;
    },
    async register() {
      const { send, check } = capture();
      check();
      if (registering) { await cancel(); return; }
      await cancel(); check();
      if (pendingRegistrationID) {
        const rows = await passkeys(); check();
        if (!rows.some(row => row.id === pendingRegistrationID)) throw new Error('passkey-registration-unconfirmed');
        pendingRegistrationID = null; return;
      }
      if (state.enabled !== true) throw new Error('passkey-password-required');
      const ticket = ++ceremony, id = `nsh-passkey-${++nextCeremonyID}`; registering = id; publish({ registering: true });
      try {
        const options = settingsObject(await send('/auth/passkey/register/options', 'POST', { label: 'Yuri iOS' })); check();
        if (ticket !== ceremony) return;
        if (typeof options.requestId !== 'string' || !options.optionsJSON || typeof options.optionsJSON !== 'object') throw new Error('passkey-options-invalid');
        const raw = await input.native.register({ ceremonyID: id, optionsJSON: settingsObject(options.optionsJSON) }); check();
        if (ticket !== ceremony) return;
        const response = nativePasskeyResponse(raw);
        pendingRegistrationID = response.id;
        const result = settingsObject(await send('/auth/passkey/register/verify', 'POST', { requestId: options.requestId, response })); check();
        if (result.verified !== true) throw new Error('passkey-registration-unconfirmed');
        if (!(await passkeys()).some(row => row.id === pendingRegistrationID)) throw new Error('passkey-registration-unconfirmed');
        check(); pendingRegistrationID = null;
      } finally { if (registering === id) { registering = null; publish({ registering: false }); } }
    },
    async resetAuth() {
      const { send, check } = capture();
      check();
      if (resetPending && !resetAcknowledged) throw new Error('auth-reset-unconfirmed');
      if (!resetPending) {
        resetPending = true;
        const result = settingsObject(await send('/api/auth/reset', 'POST')); check();
        if (result.cleared !== true || result.signedOutEverywhere !== true) throw new Error('auth-reset-unconfirmed');
        resetAcknowledged = true;
      }
      await input.native.authReset();
    },
  };
}
