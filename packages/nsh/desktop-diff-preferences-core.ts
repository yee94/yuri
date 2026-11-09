import type { DesktopDiffLayout, DesktopDiffPreferences } from './desktop-diff-model';

export const DESKTOP_DIFF_PREFERENCES_KEY = 'desktop.diff-preferences.v1';
export type DesktopDiffGlobalPreferences = Readonly<{ layoutPreference: 'dynamic' | DesktopDiffLayout; wrapLines: boolean }>;
export type DesktopDiffPreferenceStorage = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<unknown> };
export type DesktopDiffPreferenceState = Readonly<{
  supported: boolean; hydrated: boolean; reading: boolean; writing: boolean; pending: boolean;
  error: '' | 'read' | 'malformed' | 'unknown' | 'conflict' | 'capacity' | 'unsupported';
  value: DesktopDiffGlobalPreferences;
}>;
export type DesktopDiffPreferencesPort = {
  preferences(path?: string): DesktopDiffPreferences | undefined;
  available(): boolean;
  setFileLayout(paths: readonly string[], layout: DesktopDiffLayout): boolean;
  setWrapLines(wrap: boolean): Promise<boolean>;
};
const defaults: DesktopDiffGlobalPreferences = Object.freeze({ layoutPreference: 'inline', wrapLines: false });
export function desktopDiffLayoutPreference(value: unknown): DesktopDiffGlobalPreferences['layoutPreference'] {
  if (value !== 'dynamic' && value !== 'inline' && value !== 'side-by-side') throw new Error('diffLayoutPreference');
  return value;
}
function decode(raw: string | null): DesktopDiffGlobalPreferences {
  if (raw === null) return defaults;
  if (raw.length > 1024) throw new Error('diff_preferences_invalid');
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('diff_preferences_invalid');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'layoutPreference,version,wrapLines' || row.version !== 1 || typeof row.wrapLines !== 'boolean') throw new Error('diff_preferences_invalid');
  return Object.freeze({ layoutPreference: desktopDiffLayoutPreference(row.layoutPreference), wrapLines: row.wrapLines });
}
const encode = (value: DesktopDiffGlobalPreferences) => JSON.stringify({ version: 1, ...value });
const pathValid = (path: unknown): path is string => typeof path === 'string' && !!path.trim() && path.length <= 8192 && !/[\x00-\x1f\x7f-\x9f]/.test(path);
const quotaRejected = (cause: unknown) => !!cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ERR_NSH_QUOTA_EXCEEDED';

/** Device-local, one Engine/one owner. NSH Storage ACK is not fsync or cross-Engine CAS.
 * Like Web partialize, only global layout/wrap persist; exact path overrides stay live.
 * Capacity rejects the whole requested batch, never silently evicts another path. */
export function createDesktopDiffPreferences(storage: DesktopDiffPreferenceStorage, notify: () => void = () => {}, options: {
  coordination?: 'single-engine' | 'multi-engine'; fileLimit?: number; pathUnitsLimit?: number;
} = {}) {
  if (options.coordination !== undefined && options.coordination !== 'single-engine' && options.coordination !== 'multi-engine') throw new Error('diff_preferences_coordination');
  const supported = options.coordination !== 'multi-engine';
  const fileLimit = options.fileLimit ?? 4096, pathUnitsLimit = options.pathUnitsLimit ?? 512 * 1024;
  if (!Number.isSafeInteger(fileLimit) || fileLimit < 1 || !Number.isSafeInteger(pathUnitsLimit) || pathUnitsLimit < 1) throw new Error('diff_preferences_capacity');
  let state: DesktopDiffPreferenceState = { supported, hydrated: false, reading: false, writing: false, pending: false, error: supported ? '' : 'unsupported', value: defaults };
  let alive = true, prior: string | null = null, desired = defaults, revision = 0, savedRevision = 0, used = 0;
  let uncertain: { raw: string; value: DesktopDiffGlobalPreferences; revision: number } | undefined;
  let reading: Promise<boolean> | undefined, writing: Promise<boolean> | undefined;
  const files = new Map<string, DesktopDiffLayout>();
  const update = (patch: Partial<DesktopDiffPreferenceState>) => { state = { ...state, ...patch }; if (alive) notify(); };
  const available = () => alive && supported && state.hydrated && !state.reading && !state.error;
  const canClose = () => alive && (!supported || state.hydrated && !state.reading && !state.writing && !state.pending && !uncertain);
  function load(): Promise<boolean> {
    if (!alive || !supported) return Promise.resolve(false);
    if (state.hydrated) return Promise.resolve(!state.error);
    if (reading) return reading;
    reading = (async () => {
      update({ reading: true, error: '' });
      try {
        const raw = await storage.getItem(DESKTOP_DIFF_PREFERENCES_KEY);
        let value: DesktopDiffGlobalPreferences;
        try { value = decode(raw); } catch { update({ error: 'malformed' }); return false; }
        if (!alive) return false;
        prior = raw; desired = value; update({ hydrated: true, value }); return true;
      } catch { update({ error: 'read' }); return false; }
      finally { update({ reading: false }); }
    })().finally(() => { reading = undefined; });
    return reading;
  }
  async function inspect(): Promise<boolean> {
    const attempt = uncertain;
    if (!alive || !attempt) return false;
    try {
      const raw = await storage.getItem(DESKTOP_DIFF_PREFERENCES_KEY);
      if (!alive || uncertain !== attempt) return false;
      decode(raw);
      // A prior value is not a negative receipt for a lost write. Reconcile only.
      if (raw !== attempt.raw) { update({ error: raw === prior ? 'unknown' : 'conflict' }); return false; }
      prior = raw; savedRevision = attempt.revision; uncertain = undefined;
      update({ value: attempt.value, pending: savedRevision !== revision, error: '' }); return true;
    } catch { update({ error: 'unknown' }); return false; }
  }
  function flush(): Promise<boolean> {
    if (writing) return writing;
    // Unsupported owners never accept changes; there is no close work to flush.
    if (!supported) return Promise.resolve(canClose());
    if (alive && state.hydrated && !state.pending && !uncertain && !reading) return Promise.resolve(true);
    if (!alive || !supported || !state.hydrated || state.error || reading) return Promise.resolve(false);
    writing = (async () => {
      update({ writing: true });
      try {
        while (alive && savedRevision !== revision) {
          const ticket = revision, candidate = desired, raw = encode(candidate);
          if (raw !== prior) {
            let actual: string | null;
            try { actual = await storage.getItem(DESKTOP_DIFF_PREFERENCES_KEY); }
            catch { update({ error: 'read' }); return false; }
            if (!alive) return false;
            if (actual !== prior) { update({ error: 'conflict' }); return false; }
            uncertain = { raw, value: candidate, revision: ticket };
            try { await storage.setItem(DESKTOP_DIFF_PREFERENCES_KEY, raw); }
            catch (cause) {
              // Fixed NSH 0.4 explicitly guarantees this quota error did not set the value.
              if (quotaRejected(cause)) { uncertain = undefined; update({ error: 'capacity' }); return false; }
              update({ error: 'unknown' }); if (!await inspect()) return false;
            }
            if (!alive) return false;
            prior = raw; uncertain = undefined;
          }
          savedRevision = ticket; update({ value: candidate, pending: savedRevision !== revision });
        }
        return alive;
      } finally { update({ writing: false }); }
    })().finally(() => { writing = undefined; });
    return writing;
  }
  function save(patch: Partial<DesktopDiffGlobalPreferences>): Promise<boolean> {
    if (!available() || !patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => key !== 'layoutPreference' && key !== 'wrapLines')) return Promise.resolve(false);
    const next = { ...desired };
    try {
      if (patch.layoutPreference !== undefined) next.layoutPreference = desktopDiffLayoutPreference(patch.layoutPreference);
      if (Object.hasOwn(patch, 'wrapLines')) { if (typeof patch.wrapLines !== 'boolean') return Promise.resolve(false); next.wrapLines = patch.wrapLines; }
    } catch { return Promise.resolve(false); }
    if (next.layoutPreference !== desired.layoutPreference || next.wrapLines !== desired.wrapLines) {
      desired = Object.freeze(next); revision++; update({ pending: true });
    }
    return flush();
  }
  const owner = {
    /** flush/canClose settle this API lane only; never a native disk barrier. */
    durability: 'storage-api' as const,
    state: () => state, available, load, save, flush, canClose,
    async reconcile() {
      if (writing) await writing;
      if (!state.hydrated) return load();
      if (uncertain) return inspect();
      return !state.error;
    },
    async retry() {
      if (!state.hydrated) return load();
      if (uncertain) return owner.reconcile();
      if (!alive || !supported || state.error === 'conflict') return false;
      update({ error: '' }); return flush();
    },
    preferences(path?: string): DesktopDiffPreferences | undefined {
      if (!state.hydrated) return undefined;
      const fileLayout = path === undefined ? undefined : files.get(path);
      return { ...state.value, ...(fileLayout === undefined ? {} : { fileLayout }) };
    },
    setFileLayout(paths: readonly string[], layout: DesktopDiffLayout) {
      if (!available() || !Array.isArray(paths) || !paths.length || paths.some(path => !pathValid(path)) || layout !== 'inline' && layout !== 'side-by-side') return false;
      const unique = [...new Set(paths)], added = unique.filter(path => !files.has(path)), units = added.reduce((total, path) => total + path.length, 0);
      if (files.size + added.length > fileLimit || used + units > pathUnitsLimit) { update({ error: 'capacity' }); return false; }
      const changed = unique.some(path => files.get(path) !== layout);
      for (const path of unique) files.set(path, layout);
      used += units; if (changed) notify(); return true;
    },
    setWrapLines: (wrap: boolean) => save({ wrapLines: wrap }),
    fileCount: () => files.size,
    dispose() { if (!canClose()) return false; alive = false; files.clear(); return true; },
  };
  return owner;
}
