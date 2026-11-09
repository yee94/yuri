import { runtimeScopeFrom, sameRuntimeScope, type RuntimeScope } from './runtime-scope';

export type SidebarBrandPreference = Readonly<{ sidebarBrandName: string }>;
export type IosNativeUiPreference = Readonly<{ iosNativeUiEnabled: boolean }>;
export type LocalPreferenceOwner<T> = {
  snapshot(): Readonly<T> | null;
  load(): Promise<Readonly<T>>;
  save(value: T): Promise<Readonly<T>>;
  dispose(): void;
};
export type SidebarBrandCapture = Readonly<{
  /** Stable, opaque identity of the exact transport, supplied by its owner.
   * Never a hostname, URL, credential, directory, authorization ID or lease. */
  transportID: string;
  expectedHost: RuntimeScope;
  /** Captured page/Host operation, including transport identity and receipt CAS. */
  current(): boolean;
  currentHost(): RuntimeScope | null;
  currentTransportID(): string | null;
}>;
type StoragePort = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
};
const brandPrefix = 'sidebar-brand-transport-v1.';
export const iosNativeUiPreferenceKey = 'ios-native-ui-compat-v1';

function record(raw: string | null, field: string): Record<string, unknown> {
  const parsed: unknown = raw === null ? {} : JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).some(key => key !== field)) throw new Error('local_preference_invalid');
  return parsed as Record<string, unknown>;
}
function brand(value: unknown): SidebarBrandPreference {
  if (typeof value !== 'string') throw new Error('local_preference_invalid');
  // Same UTF-16 slice as useSidebarBrandStore; whitespace is not normalized.
  return Object.freeze({ sidebarBrandName: value.slice(0, 64) });
}
function ios(value: unknown): IosNativeUiPreference {
  if (typeof value !== 'boolean') throw new Error('local_preference_invalid');
  return Object.freeze({ iosNativeUiEnabled: value });
}

/** One coordinator per Storage adapter, not per page. A replaced owner retires
 * its callbacks immediately; its already dispatched disk write cannot be undone. */
export function createLocalCompatibilityPreferences(storage: StoragePort) {
  const flights = new Map<string, Promise<unknown>>();
  const owners = new Map<string, symbol>();
  function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (flights.get(key) ?? Promise.resolve()).then(work, work);
    flights.set(key, next);
    const release = () => { if (flights.get(key) === next) flights.delete(key); };
    void next.then(release, release);
    return next;
  }
  function open<T>(key: string, input: { current(): boolean; changed(value: Readonly<T>): void }, decode: (raw: string | null) => Readonly<T>, normalize: (value: T) => Readonly<T>): LocalPreferenceOwner<T> {
    const admitted = input.current, changed = input.changed;
    if (!admitted()) throw new Error('local_preference_stale');
    const ticket = Symbol();
    owners.set(key, ticket);
    let alive = true, value: Readonly<T> | null = null;
    const current = () => alive && owners.get(key) === ticket && admitted();
    const assertCurrent = () => { if (!current()) throw new Error('local_preference_stale'); };
    async function read() {
      let raw: string | null;
      try { raw = await storage.get(key); }
      catch { assertCurrent(); throw new Error('local_preference_read_failed'); }
      assertCurrent();
      try { return decode(raw); }
      catch { throw new Error('local_preference_invalid'); }
    }
    function publish(next: Readonly<T>) {
      assertCurrent(); value = next; changed(next); return next;
    }
    return {
      snapshot: () => current() ? value : null,
      load: () => serialize(key, async () => { assertCurrent(); return publish(await read()); }),
      save: submitted => {
        // Capture and normalize before queuing, never retain the caller's draft object.
        let next: Readonly<T>;
        try { assertCurrent(); next = normalize(submitted); }
        catch (cause) { return Promise.reject(cause); }
        return serialize(key, async () => {
          assertCurrent();
          // Even a cold save must not overwrite a corrupt or unread old record.
          await read();
          assertCurrent();
          try { await storage.set(key, JSON.stringify(next)); }
          catch { assertCurrent(); throw new Error('local_preference_write_failed'); }
          return publish(next);
        });
      },
      dispose() { alive = false; if (owners.get(key) === ticket) owners.delete(key); },
    };
  }
  return {
    openSidebarBrand(capture: SidebarBrandCapture, changed: (value: SidebarBrandPreference) => void): LocalPreferenceOwner<SidebarBrandPreference> {
      const expectedHost = runtimeScopeFrom(capture.expectedHost), transportID = capture.transportID;
      if (!expectedHost || !/^[A-Za-z0-9_-]{1,128}$/.test(transportID)) throw new Error('local_preference_scope_required');
      // Copy authority at construction. Its current closure must belong to the
      // same captured Host operation; never resolve a newer Host on a retry.
      const admitted = capture.current, currentHost = capture.currentHost, currentTransportID = capture.currentTransportID;
      const current = () => admitted() && sameRuntimeScope(expectedHost, currentHost()) && transportID === currentTransportID();
      return open(brandPrefix + transportID, { current, changed }, raw => {
        const saved = record(raw, 'sidebarBrandName');
        return brand(saved.sidebarBrandName === undefined ? 'Yuri' : saved.sidebarBrandName);
      }, value => brand(value.sidebarBrandName));
    },
    openIosNativeUi(input: { current(): boolean; changed(value: IosNativeUiPreference): void }): LocalPreferenceOwner<IosNativeUiPreference> {
      return open(iosNativeUiPreferenceKey, input, raw => {
        const saved = record(raw, 'iosNativeUiEnabled');
        return ios(saved.iosNativeUiEnabled === undefined ? false : saved.iosNativeUiEnabled);
      }, value => ios(value.iosNativeUiEnabled));
    },
  };
}
